/**
 * Account ledger.
 *
 * Balance direction follows LedgerController.cs:50 — heads 1 (assets) and
 * 5 (expenses) are debit-normal, everything else credit-normal. That single
 * rule drives opening balances, running totals and every financial statement.
 *
 * Two things differ from the legacy implementation:
 *
 *   1. Invoice detail was expanded with one query PER ledger row (an N+1 that
 *      made a busy account's ledger unusable). Here every document's lines are
 *      fetched in one grouped query and joined in memory.
 *   2. Running balance is computed, so the reader can see the account walk from
 *      opening to closing rather than only the individual movements.
 */
import { sql } from 'kysely';
import { db } from '../../core/db/index.js';
import { add, sub, type MoneyString } from '../../core/money.js';
import { notFound } from '../../core/errors.js';
import { isDebitNormal } from '../../accounting/accounts.js';
import type { Principal } from '../../core/rbac.js';

export interface LedgerRow {
  transId: number;
  date: string;
  vtype: string;
  invId: number;
  detail: string;
  dr: MoneyString;
  cr: MoneyString;
  /** Account balance after this entry, in the account's normal direction. */
  balance: MoneyString;
}

export interface LedgerResult {
  account: { accountId: number; name: string; headId: number; debitNormal: boolean };
  from: string;
  to: string;
  opening: MoneyString;
  rows: LedgerRow[];
  totals: { dr: MoneyString; cr: MoneyString };
  closing: MoneyString;
}

/** Document types whose lines can be expanded into the ledger detail column. */
const LINE_SOURCES = {
  SINV: { table: 'sale_detail', fk: 'sale_id' },
  SRINV: { table: 'sale_return_detail', fk: 'sale_id' },
  PINV: { table: 'purchase_detail', fk: 'purchase_id' },
  PRINV: { table: 'purchase_return_detail', fk: 'purchase_id' },
} as const;

type LineVtype = keyof typeof LINE_SOURCES;

/**
 * Fetch item summaries for every referenced document in ONE query per type.
 * Returns a `${vtype}:${invId}` → text map.
 */
async function loadInvoiceDetails(
  refs: ReadonlyArray<{ vtype: string; invId: number }>,
): Promise<Map<string, string>> {
  const byType = new Map<LineVtype, number[]>();

  for (const ref of refs) {
    if (!(ref.vtype in LINE_SOURCES)) continue;
    const vtype = ref.vtype as LineVtype;
    const ids = byType.get(vtype);
    if (ids) ids.push(ref.invId);
    else byType.set(vtype, [ref.invId]);
  }

  const out = new Map<string, string>();

  await Promise.all(
    [...byType.entries()].map(async ([vtype, ids]) => {
      const { table, fk } = LINE_SOURCES[vtype];
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;

      // One aggregated row per document, rather than one query per ledger row.
      const rows = await sql<{ inv_id: number; summary: string }>`
        SELECT ${sql.ref(fk)} AS inv_id,
               string_agg(
                 -- FM drops trailing zeros but leaves the decimal separator, so
                 -- a whole quantity renders as "2." without the rtrim.
                 pname || ' | ' || rtrim(trim(to_char(qty, 'FM999999990.999')), '.') ||
                 ' x ' || trim(to_char(price, 'FM999999990.00')) ||
                 ' = ' || trim(to_char(total, 'FM999999990.00')) ||
                 CASE WHEN discount > 0
                      THEN ' (Disc: ' || trim(to_char(discount, 'FM999999990.00')) ||
                           ') -> Net: ' || trim(to_char(net_total, 'FM999999990.00'))
                      ELSE '' END,
                 ', ' ORDER BY id
               ) AS summary
        FROM   ${sql.table(table)}
        WHERE  ${sql.ref(fk)} = ANY(${unique})
        GROUP  BY ${sql.ref(fk)}
      `.execute(db);

      for (const r of rows.rows) out.set(`${vtype}:${r.inv_id}`, r.summary);
    }),
  );

  return out;
}

export async function getLedger(
  principal: Principal,
  opts: { accountId: number; from: string; to: string; branchId?: number | undefined },
): Promise<LedgerResult> {
  const account = await db
    .selectFrom('account')
    .select(['account_id', 'name', 'head_id', 'branch_id', 'is_fixed'])
    .where('account_id', '=', opts.accountId)
    .executeTakeFirst();

  if (!account) throw notFound('Account');

  // Branch users may only read fixed accounts and their own branch's.
  if (!principal.isSuperAdmin && !account.is_fixed && account.branch_id !== principal.branchId) {
    throw notFound('Account');
  }

  const debitNormal = isDebitNormal(account.head_id);

  // Super admins may filter to a branch; everyone else is pinned to their own.
  const branchFilter = principal.isSuperAdmin ? opts.branchId : principal.branchId;

  // ---- opening balance ---------------------------------------------------
  // Prior-period movement plus any account_opening rows, both taken in the
  // account's normal direction.
  let priorQuery = db
    .selectFrom('transactions')
    .select(({ fn }) => [
      fn.coalesce(fn.sum<string>('dr'), sql<string>`0`).as('dr'),
      fn.coalesce(fn.sum<string>('cr'), sql<string>`0`).as('cr'),
    ])
    .where('account_id', '=', opts.accountId)
    .where('date', '<', opts.from);

  if (branchFilter !== undefined) priorQuery = priorQuery.where('branch_id', '=', branchFilter);

  const [prior, openingRow] = await Promise.all([
    priorQuery.executeTakeFirstOrThrow(),
    db
      .selectFrom('account_opening')
      .select(({ fn }) => [
        fn.coalesce(fn.sum<string>('dr'), sql<string>`0`).as('dr'),
        fn.coalesce(fn.sum<string>('cr'), sql<string>`0`).as('cr'),
      ])
      .where('account_id', '=', opts.accountId)
      .executeTakeFirstOrThrow(),
  ]);

  const opening = debitNormal
    ? add(sub(prior.dr, prior.cr), sub(openingRow.dr, openingRow.cr))
    : add(sub(prior.cr, prior.dr), sub(openingRow.cr, openingRow.dr));

  // ---- movements in range ------------------------------------------------
  let movementQuery = db
    .selectFrom('transactions')
    .select(['trans_id', 'date', 'vtype', 'inv_id', 'detail', 'dr', 'cr'])
    .where('account_id', '=', opts.accountId)
    .where('date', '>=', opts.from)
    .where('date', '<=', opts.to)
    .orderBy('date')
    .orderBy('trans_id')
    .orderBy('id');

  if (branchFilter !== undefined) {
    movementQuery = movementQuery.where('branch_id', '=', branchFilter);
  }

  const movements = await movementQuery.execute();

  const details = await loadInvoiceDetails(
    movements.map((m) => ({ vtype: m.vtype, invId: m.inv_id })),
  );

  let balance = opening;
  let totalDr = '0.00';
  let totalCr = '0.00';

  const rows: LedgerRow[] = movements.map((m) => {
    balance = debitNormal ? add(balance, sub(m.dr, m.cr)) : add(balance, sub(m.cr, m.dr));
    totalDr = add(totalDr, m.dr);
    totalCr = add(totalCr, m.cr);

    return {
      transId: m.trans_id,
      date: m.date,
      vtype: m.vtype,
      invId: m.inv_id,
      // Invoice rows show their line items; vouchers keep their own narration.
      detail: details.get(`${m.vtype}:${m.inv_id}`) ?? m.detail ?? '',
      dr: m.dr,
      cr: m.cr,
      balance,
    };
  });

  return {
    account: {
      accountId: account.account_id,
      name: account.name ?? '',
      headId: account.head_id,
      debitNormal,
    },
    from: opts.from,
    to: opts.to,
    opening,
    rows,
    totals: { dr: totalDr, cr: totalCr },
    closing: balance,
  };
}

/**
 * Trial balance — every account's closing position as at a date.
 *
 * This is the report the legacy system never built, and could not have: with
 * unbalanced sale vouchers it would never have tied out. It does now.
 */
export async function getTrialBalance(
  principal: Principal,
  opts: { asAt: string; branchId?: number | undefined },
): Promise<{
  asAt: string;
  rows: Array<{ accountId: number; name: string; headId: number; dr: MoneyString; cr: MoneyString }>;
  totals: { dr: MoneyString; cr: MoneyString };
  balanced: boolean;
}> {
  const branchFilter = principal.isSuperAdmin ? opts.branchId : principal.branchId;

  const rows = await sql<{
    account_id: number;
    name: string | null;
    head_id: number;
    dr: string;
    cr: string;
  }>`
    SELECT a.account_id,
           a.name,
           a.head_id,
           COALESCE(SUM(t.dr), 0)::text AS dr,
           COALESCE(SUM(t.cr), 0)::text AS cr
    FROM   account a
    JOIN   transactions t ON t.account_id = a.account_id
    WHERE  t.date <= ${opts.asAt}
    ${branchFilter === undefined ? sql`` : sql`AND t.branch_id = ${branchFilter}`}
    GROUP  BY a.account_id, a.name, a.head_id
    HAVING COALESCE(SUM(t.dr), 0) <> 0 OR COALESCE(SUM(t.cr), 0) <> 0
    ORDER  BY a.account_id
  `.execute(db);

  let totalDr = '0.00';
  let totalCr = '0.00';

  const mapped = rows.rows.map((r) => {
    const net = sub(r.dr, r.cr);
    // Present each account on its natural side.
    const dr = Number(net) >= 0 ? net : '0.00';
    const cr = Number(net) < 0 ? sub('0', net) : '0.00';

    totalDr = add(totalDr, dr);
    totalCr = add(totalCr, cr);

    return {
      accountId: r.account_id,
      name: r.name ?? '',
      headId: r.head_id,
      dr,
      cr,
    };
  });

  return {
    asAt: opts.asAt,
    rows: mapped,
    totals: { dr: totalDr, cr: totalCr },
    balanced: totalDr === totalCr,
  };
}
