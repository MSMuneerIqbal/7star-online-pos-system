/**
 * Opening balances (Phase 13) — the day-one starting numbers.
 *
 * Every opening figure posts a balanced journal against Owner Capital. Opening
 * stock is special: it is inventory with a value behind it, so it also writes an
 * `opening_stock` row that the stock-movement view reads as quantity in.
 */
import { db, inTransaction, type Tx } from '../../core/db/index.js';
import { dec, money, qty } from '../../core/money.js';
import { badRequest } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { ACC, VTYPE } from '../../accounting/accounts.js';
import { buildJournal, credit, debit } from '../../accounting/journal.js';
import { postJournal } from '../../accounting/post.js';

export async function recordOpeningStock(
  principal: Principal,
  input: { date: string; branchId: number; kind: 'RAW' | 'FINISH'; pid: number; qty: string; cost: string },
  outerTx?: Tx,
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  if (dec(input.qty).lte(0)) throw badRequest('Opening quantity must be greater than zero');
  if (dec(input.cost).lt(0)) throw badRequest('Opening cost cannot be negative');

  const inventory = input.kind === 'FINISH' ? ACC.INVENTORY_FINISH : ACC.INVENTORY_RAW;

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .insertInto('opening_stock')
      .values({
        branch_id: branchId,
        kind: input.kind,
        pid: input.pid,
        qty: qty(input.qty),
        cost: money(input.cost),
        date: input.date,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const value = money(dec(input.qty).mul(dec(input.cost)));

    await postJournal(
      tx,
      buildJournal({
        vtype: VTYPE.JOURNAL,
        date: input.date,
        invId: row.id,
        branchId,
        legs: [
          debit(inventory, value, `Opening stock – ${input.kind} #${input.pid}`),
          credit(ACC.OWNER_CAPITAL, value, 'Opening capital'),
        ],
      }),
    );

    await writeAudit(
      principal,
      { form: 'Opening Balances', action: 'New', detail: `Opening stock ${input.qty} x item ${input.pid} @ ${input.cost}`, invId: row.id },
      tx,
    );

    return { id: row.id };
  });
}

export async function recordOpeningBalance(
  principal: Principal,
  input: { date: string; branchId: number; accountId: number; amount: string; debit: boolean; detail?: string | null | undefined },
  outerTx?: Tx,
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  if (dec(input.amount).lte(0)) throw badRequest('Opening amount must be greater than zero');

  return inTransaction(outerTx, async (tx) => {
    const amount = money(input.amount);

    await postJournal(
      tx,
      buildJournal({
        vtype: VTYPE.JOURNAL,
        date: input.date,
        invId: 0,
        branchId,
        legs: input.debit
          ? [debit(input.accountId, amount, input.detail ?? 'Opening balance'), credit(ACC.OWNER_CAPITAL, amount, 'Opening capital')]
          : [debit(ACC.OWNER_CAPITAL, amount, 'Opening capital'), credit(input.accountId, amount, input.detail ?? 'Opening balance')],
      }),
    );

    await writeAudit(
      principal,
      { form: 'Opening Balances', action: 'New', detail: `Opening balance account ${input.accountId} ${input.debit ? 'Dr' : 'Cr'} ${amount}` },
      tx,
    );

    return { id: 0 };
  });
}
