/**
 * Manual vouchers — CRV, CPV, BRV, BPV, JV.
 *
 * All five are the same operation with a different counter-account, so this is
 * one module rather than the five near-identical controllers the legacy system
 * had. The posting rules live in accounting/rules/voucher.ts and are already
 * tested; this layer persists the document and its ledger legs together.
 *
 * The important difference from the legacy behaviour: a voucher that does not
 * balance is REJECTED. The legacy UI relied on the operator to balance the
 * form and nothing checked it server-side.
 */
import { db, inTransaction, type Tx } from '../../core/db/index.js';
import { add, gt, money, type MoneyString } from '../../core/money.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { COUNTER_ACCOUNT, postVoucher, type VoucherInput } from '../../accounting/rules/voucher.js';
import { postJournal, repostDocument } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';
import { VTYPE } from '../../accounting/accounts.js';

export type VoucherType = VoucherInput['type'];

export const VOUCHER_TYPES: Record<
  VoucherType,
  { label: string; formId: number; formCode: number; vtype: string }
> = {
  CRV: { label: 'Cash Receipt', formId: 42, formCode: 709, vtype: VTYPE.CASH_RECEIPT },
  CPV: { label: 'Cash Payment', formId: 43, formCode: 710, vtype: VTYPE.CASH_PAYMENT },
  BRV: { label: 'Bank Receipt', formId: 44, formCode: 711, vtype: VTYPE.BANK_RECEIPT },
  BPV: { label: 'Bank Payment', formId: 45, formCode: 712, vtype: VTYPE.BANK_PAYMENT },
  JV: { label: 'Journal Voucher', formId: 46, formCode: 713, vtype: VTYPE.JOURNAL },
};

export interface VoucherLineInput {
  accountId: number;
  dr: string;
  cr: string;
  detail?: string | null | undefined;
  chequeNo?: string | null | undefined;
  chequeDate?: string | null | undefined;
}

export interface SaveVoucherInput {
  type: VoucherType;
  date: string;
  branchId?: number | undefined;
  narration?: string | null | undefined;
  lines: VoucherLineInput[];
}

/**
 * Validate the accounts referenced by a voucher.
 *
 * A leg pointing at a non-existent account would fail on the foreign key with
 * a constraint name; naming the account here produces a message an operator can
 * act on.
 */
async function assertAccountsExist(tx: Tx, lines: readonly VoucherLineInput[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.accountId))];

  const found = await tx
    .selectFrom('account')
    .select('account_id')
    .where('account_id', 'in', ids)
    .execute();

  const known = new Set(found.map((f) => f.account_id));
  const missing = ids.filter((id) => !known.has(id));

  if (missing.length > 0) {
    throw badRequest(`Unknown account code(s): ${missing.join(', ')}`);
  }
}

function summarise(input: SaveVoucherInput): { total: MoneyString; count: number } {
  // Debits and credits are equal in a balanced voucher, so either side is the
  // voucher's value.
  return {
    total: add(...input.lines.map((l) => l.dr)),
    count: input.lines.length,
  };
}

export async function createVoucher(
  principal: Principal,
  input: SaveVoucherInput,
  outerTx?: Tx,
): Promise<{ id: number; transId: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  const meta = VOUCHER_TYPES[input.type];
  if (!meta) throw badRequest(`Unknown voucher type ${input.type}`);

  return inTransaction(outerTx, async (tx) => {
    await assertAccountsExist(tx, input.lines);

    // Reserve the document id first so the journal can reference it.
    const master = await tx
      .insertInto('voucher_master')
      .values({
        date: input.date,
        tran_id: 0, // set below, once the journal is posted
        branch_id: branchId,
        inv_id: 0,
        account_id: COUNTER_ACCOUNT[input.type] ?? 0,
        amount: '0',
        amount1: '0',
        type: input.type,
        detail: input.narration ?? null,
        vno: null,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Throws if the legs do not balance — nothing is committed.
    const journal = postVoucher({
      invId: master.id,
      date: input.date,
      branchId,
      type: input.type,
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        dr: money(l.dr),
        cr: money(l.cr),
        detail: l.detail ?? input.narration ?? meta.label,
      })),
    });

    const posted = await postJournal(tx, journal);
    const { total, count } = summarise(input);

    await tx
      .updateTable('voucher_master')
      .set({
        tran_id: posted.transId,
        inv_id: master.id,
        amount: total,
        vno: `${input.type}-${posted.voucherNo}`,
      })
      .where('id', '=', master.id)
      .execute();

    // voucher_detail mirrors the legs with the cheque fields the ledger has no
    // room for.
    await tx
      .insertInto('voucher_detail')
      .values(
        input.lines.map((l) => ({
          trans_id: posted.transId,
          inv_id: master.id,
          account_id: l.accountId,
          detail: l.detail ?? input.narration ?? null,
          vtype: input.type,
          cheque_no: l.chequeNo ?? null,
          cheque_date: l.chequeDate ?? null,
          cheque_status: l.chequeNo ? 'PENDING' : null,
          dr: money(l.dr),
          cr: money(l.cr),
        })),
      )
      .execute();

    await writeAudit(
      principal,
      {
        form: meta.label,
        action: 'New',
        detail:
          `Voucher:${master.id} | New ${meta.label} | ${count} line(s), ` +
          `total ${fmt(total)}${input.narration ? ` | ${input.narration}` : ''}`,
        invId: master.id,
      },
      tx,
    );

    return { id: master.id, transId: posted.transId };
  });
}

export async function updateVoucher(
  principal: Principal,
  voucherId: number,
  input: SaveVoucherInput,
  outerTx?: Tx,
): Promise<{ id: number }> {
  const existing = await (outerTx ?? db)
    .selectFrom('voucher_master')
    .select(['id', 'branch_id', 'type'])
    .where('id', '=', voucherId)
    .executeTakeFirst();

  if (!existing) throw notFound('Voucher');
  assertBranchAccess(principal, existing.branch_id);

  if (existing.type !== input.type) {
    throw unprocessable(
      `A ${existing.type} voucher cannot be changed into a ${input.type}. ` +
        `Cancel it and raise a new one.`,
    );
  }

  const meta = VOUCHER_TYPES[input.type];
  const branchId = resolveBranchId(principal, input.branchId ?? existing.branch_id);

  return inTransaction(outerTx, async (tx) => {
    await assertAccountsExist(tx, input.lines);

    const journal = postVoucher({
      invId: voucherId,
      date: input.date,
      branchId,
      type: input.type,
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        dr: money(l.dr),
        cr: money(l.cr),
        detail: l.detail ?? input.narration ?? meta.label,
      })),
    });

    // Reversal rather than delete — the original entries stay visible.
    const { posted } = await repostDocument(tx, meta.vtype as never, voucherId, [journal]);
    const transId = posted[0]?.transId ?? 0;
    const { total, count } = summarise(input);

    await tx
      .updateTable('voucher_master')
      .set({
        date: input.date,
        tran_id: transId,
        branch_id: branchId,
        amount: total,
        detail: input.narration ?? null,
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', voucherId)
      .execute();

    await tx.deleteFrom('voucher_detail').where('inv_id', '=', voucherId).execute();

    await tx
      .insertInto('voucher_detail')
      .values(
        input.lines.map((l) => ({
          trans_id: transId,
          inv_id: voucherId,
          account_id: l.accountId,
          detail: l.detail ?? input.narration ?? null,
          vtype: input.type,
          cheque_no: l.chequeNo ?? null,
          cheque_date: l.chequeDate ?? null,
          cheque_status: l.chequeNo ? 'PENDING' : null,
          dr: money(l.dr),
          cr: money(l.cr),
        })),
      )
      .execute();

    await writeAudit(
      principal,
      {
        form: meta.label,
        action: 'Edit',
        detail: `Voucher:${voucherId} | Edited ${meta.label} | ${count} line(s), total ${fmt(total)}`,
        invId: voucherId,
      },
      tx,
    );

    return { id: voucherId };
  });
}

/** Opening balances. Recorded outside the ledger, added in by the ledger view. */
export async function saveOpeningBalance(
  principal: Principal,
  input: { accountId: number; date: string; dr: string; cr: string; detail?: string | null | undefined; branchId?: number | undefined },
  outerTx?: Tx,
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);

  if (gt(input.dr, '0') && gt(input.cr, '0')) {
    throw badRequest('An opening balance is either a debit or a credit, not both');
  }

  return inTransaction(outerTx, async (tx) => {
    await assertAccountsExist(tx, [{ accountId: input.accountId, dr: input.dr, cr: input.cr }]);

    const row = await tx
      .insertInto('account_opening')
      .values({
        account_id: input.accountId,
        branch_id: branchId,
        user_id: principal.empId,
        date: input.date,
        dr: money(input.dr),
        cr: money(input.cr),
        detail: input.detail ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Account Opening',
        action: 'New',
        detail:
          `Opening balance for account ${input.accountId}: ` +
          `Dr ${fmt(input.dr)} Cr ${fmt(input.cr)}`,
        invId: row.id,
      },
      tx,
    );

    return { id: row.id };
  });
}
