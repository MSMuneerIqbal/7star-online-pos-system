/**
 * Journal writer.
 *
 * Everything here runs inside a caller-supplied transaction. Three legacy
 * defects are fixed at this layer:
 *
 *   1. Atomicity — `Sale.Save` issued several SaveChanges() plus six raw
 *      inserts with no enclosing transaction, so a mid-flight failure could
 *      leave inventory issued with no revenue recorded.
 *   2. Voucher ids — `SELECT ISNULL(MAX(TransId),0)+1` raced, letting two
 *      concurrent vouchers share an id and become indistinguishable in the
 *      ledger. Now a sequence.
 *   3. Destructive edits — editing a document ran
 *      `DELETE FROM Transactions WHERE Vtype=.. AND InvId=..`, erasing history.
 *      `repostDocument` writes a reversal instead.
 */
import { sql } from 'kysely';
import type { Tx } from '../core/db/index.js';
import type { Journal } from './journal.js';
import { buildJournal, reverse } from './journal.js';
import type { Vtype } from './accounts.js';

export interface PostedJournal {
  transId: number;
  voucherNo: number;
  legCount: number;
}

/** Next voucher grouping id. Atomic — replaces MAX(trans_id)+1. */
async function nextTransId(tx: Tx): Promise<number> {
  const { rows } = await sql<{
    v: string;
  }>`SELECT nextval('transactions_trans_id_seq') AS v`.execute(tx);

  return Number(rows[0]!.v);
}

async function nextVoucherNo(tx: Tx): Promise<number> {
  const { rows } = await sql<{
    v: string;
  }>`SELECT nextval('transactions_voucher_no_seq') AS v`.execute(tx);

  return Number(rows[0]!.v);
}

/**
 * Write one journal.
 *
 * `journal` is already balanced — `buildJournal` is the only way to make one —
 * but it is re-validated here so a hand-assembled object cannot slip through.
 */
export async function postJournal(
  tx: Tx,
  journal: Journal,
  overrides?: { invId?: number },
): Promise<PostedJournal> {
  const final = buildJournal(
    overrides?.invId === undefined ? journal : { ...journal, invId: overrides.invId },
  );

  const [transId, voucherNo] = await Promise.all([nextTransId(tx), nextVoucherNo(tx)]);

  await tx
    .insertInto('transactions')
    .values(
      final.legs.map((leg) => ({
        date: final.date,
        inv_id: final.invId,
        vtype: final.vtype,
        dr: leg.dr,
        cr: leg.cr,
        account_id: leg.accountId,
        detail: leg.detail,
        voucher_no: voucherNo,
        trans_id: transId,
        branch_id: final.branchId,
      })),
    )
    .execute();

  return { transId, voucherNo, legCount: final.legs.length };
}

/** Write several journals for one document — e.g. an invoice plus its receipt. */
export async function postJournals(
  tx: Tx,
  journals: readonly Journal[],
  overrides?: { invId?: number },
): Promise<PostedJournal[]> {
  const posted: PostedJournal[] = [];

  // Sequential, not Promise.all: each needs its own sequence values and the
  // ledger reads better when a document's vouchers are numbered in order.
  for (const journal of journals) {
    posted.push(await postJournal(tx, journal, overrides));
  }

  return posted;
}

/**
 * Load every leg previously posted for a document, grouped by voucher.
 * Used to build reversals.
 */
export async function loadDocumentJournals(
  tx: Tx,
  vtype: Vtype,
  invId: number,
): Promise<Journal[]> {
  const rows = await tx
    .selectFrom('transactions')
    .select(['trans_id', 'date', 'branch_id', 'vtype', 'account_id', 'dr', 'cr', 'detail'])
    .where('vtype', '=', vtype)
    .where('inv_id', '=', invId)
    .orderBy('trans_id')
    .orderBy('id')
    .execute();

  const byVoucher = new Map<number, typeof rows>();

  for (const row of rows) {
    const group = byVoucher.get(row.trans_id);
    if (group) group.push(row);
    else byVoucher.set(row.trans_id, [row]);
  }

  return [...byVoucher.values()].map((group) => {
    const first = group[0]!;

    return buildJournal({
      vtype: first.vtype as Vtype,
      date: first.date,
      invId,
      branchId: first.branch_id,
      legs: group.map((r) => ({
        accountId: r.account_id,
        dr: r.dr,
        cr: r.cr,
        detail: r.detail ?? '',
      })),
    });
  });
}

/**
 * Re-post a document that has changed.
 *
 * Writes a reversal of everything previously posted, then the new journals.
 * The ledger nets to the correct position and the original entries remain
 * visible — which is what an auditor expects and what deleting the rows
 * destroyed.
 *
 * `reversalDate` defaults to the new journals' date so a correction lands in
 * the period being corrected. Pass today's date instead when the original
 * period is closed.
 */
export async function repostDocument(
  tx: Tx,
  vtype: Vtype,
  invId: number,
  journals: readonly Journal[],
  reversalDate?: string,
): Promise<{ reversed: PostedJournal[]; posted: PostedJournal[] }> {
  const existing = await loadDocumentJournals(tx, vtype, invId);

  const reversed = await postJournals(
    tx,
    existing.map((j) => {
      const r = reverse(j, `REVERSAL Inv#${invId}`);
      return reversalDate ? { ...r, date: reversalDate } : r;
    }),
  );

  const posted = await postJournals(tx, journals, { invId });

  return { reversed, posted };
}
