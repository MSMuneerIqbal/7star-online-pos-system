/**
 * Reports.
 *
 * Every one of these was linked in the legacy sidebar and none of them existed —
 * the controllers were never written, so the menu items returned 404 for years.
 *
 * The financial statements could not have worked in the legacy system anyway:
 * with unbalanced sale and inter-branch postings (db/accounts.md §4.1, §4.5) a
 * balance sheet would never have balanced. They work now because the posting
 * engine is correct.
 *
 * Stock reports read `stock_movement`, the view that unifies all eight document
 * types that move inventory.
 */
import { sql } from 'kysely';
import { db } from '../../core/db/index.js';
import { add, sub, type MoneyString } from '../../core/money.js';
import { notFound } from '../../core/errors.js';
import { ACC } from '../../accounting/accounts.js';
import type { Principal } from '../../core/rbac.js';
import type { StockKind } from '../../accounting/rules/transfer.js';

export interface DateRange {
  from: string;
  to: string;
  branchId?: number | undefined;
}

/** Resolve the branch a report is scoped to: null means all branches. */
function scope(principal: Principal, requested?: number): number | null {
  return principal.isSuperAdmin ? (requested ?? null) : principal.branchId;
}

// ---------------------------------------------------------------------------
// Stock report — closing quantity per item
// ---------------------------------------------------------------------------

export interface StockRow {
  pid: number;
  name: string;
  opening: string;
  inQty: string;
  outQty: string;
  closing: string;
  reorderLevel: string;
  belowReorder: boolean;
  value: MoneyString;
}

export async function getStockReport(
  principal: Principal,
  opts: { kind: StockKind; asAt: string; branchId?: number | undefined },
): Promise<{ asAt: string; kind: StockKind; rows: StockRow[]; totalValue: MoneyString }> {
  const branchId = scope(principal, opts.branchId);

  // Catalogue differs by kind: raw_product has no branch column, product does.
  const rows = await sql<{
    pid: number;
    name: string | null;
    open_qty: string;
    in_qty: string;
    out_qty: string;
    cost: string;
    reorder_level: string;
  }>`
    WITH moves AS (
      SELECT pid,
             SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)  AS in_qty,
             SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS out_qty
      FROM   stock_movement
      WHERE  kind = ${opts.kind}
        AND  date <= ${opts.asAt}
        ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`}
      GROUP  BY pid
    )
    ${
      opts.kind === 'RAW'
        ? sql`
    SELECT rp.id           AS pid,
           rp.name         AS name,
           '0'::text       AS open_qty,
           COALESCE(m.in_qty, 0)::text  AS in_qty,
           COALESCE(m.out_qty, 0)::text AS out_qty,
           rp.price::text  AS cost,
           rp.reorder::text AS reorder_level
    FROM   raw_product rp
    LEFT   JOIN moves m ON m.pid = rp.id
    WHERE  rp.is_active
    ORDER  BY rp.name`
        : // Reorder threshold now lives on branch_product (Phase 1, the
          // catalog split) — one per branch, not one per model. At a single
          // branch it joins straight through; across all branches there is
          // no single threshold to show, so it reads 0 / never-below rather
          // than guessing an aggregate.
          sql`
    SELECT p.id            AS pid,
           p.name          AS name,
           p.open_qty::text AS open_qty,
           COALESCE(m.in_qty, 0)::text  AS in_qty,
           COALESCE(m.out_qty, 0)::text AS out_qty,
           p.price::text   AS cost,
           COALESCE(bp.low_stock_threshold, 0)::text AS reorder_level
    FROM   product p
    LEFT   JOIN moves m ON m.pid = p.id
    ${
      branchId === null
        ? sql`LEFT JOIN branch_product bp ON false`
        : sql`LEFT JOIN branch_product bp ON bp.product_id = p.id AND bp.branch_id = ${branchId}`
    }
    WHERE  p.is_active
    ORDER  BY p.name`
    }
  `.execute(db);

  let totalValue = '0.00';

  const mapped: StockRow[] = rows.rows.map((r) => {
    const closing = add(sub(add(r.open_qty, r.in_qty), r.out_qty), '0');
    // Value at cost — the same basis the ledger carries inventory on.
    const value = String((Number(closing) * Number(r.cost)).toFixed(2));
    totalValue = add(totalValue, value);

    return {
      pid: r.pid,
      name: r.name ?? '',
      opening: r.open_qty,
      inQty: r.in_qty,
      outQty: r.out_qty,
      closing,
      reorderLevel: r.reorder_level,
      belowReorder: Number(closing) < Number(r.reorder_level),
      value,
    };
  });

  return { asAt: opts.asAt, kind: opts.kind, rows: mapped, totalValue };
}

// ---------------------------------------------------------------------------
// Item ledger — every movement of one item, with a running quantity
// ---------------------------------------------------------------------------

export interface ItemLedgerRow {
  date: string;
  source: string;
  docId: number;
  branchId: number;
  qty: string;
  price: string;
  balance: string;
}

export async function getItemLedger(
  principal: Principal,
  opts: { kind: StockKind; pid: number } & DateRange,
): Promise<{
  item: { pid: number; name: string; kind: StockKind };
  from: string;
  to: string;
  opening: string;
  rows: ItemLedgerRow[];
  closing: string;
}> {
  const branchId = scope(principal, opts.branchId);

  const item =
    opts.kind === 'RAW'
      ? await db.selectFrom('raw_product').select(['id', 'name']).where('id', '=', opts.pid).executeTakeFirst()
      : await db.selectFrom('product').select(['id', 'name']).where('id', '=', opts.pid).executeTakeFirst();

  if (!item) throw notFound('Item');

  const prior = await sql<{ qty: string }>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty
    FROM   stock_movement
    WHERE  kind = ${opts.kind} AND pid = ${opts.pid} AND date < ${opts.from}
    ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`}
  `.execute(db);

  const movements = await sql<{
    date: string;
    source: string;
    doc_id: number;
    branch_id: number;
    qty: string;
    price: string;
  }>`
    SELECT date, source, doc_id, branch_id, qty::text, price::text
    FROM   stock_movement
    WHERE  kind = ${opts.kind} AND pid = ${opts.pid}
      AND  date >= ${opts.from} AND date <= ${opts.to}
    ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`}
    ORDER  BY date, doc_id
  `.execute(db);

  let balance = prior.rows[0]?.qty ?? '0';

  const rows: ItemLedgerRow[] = movements.rows.map((m) => {
    balance = add(balance, m.qty);
    return {
      date: m.date,
      source: m.source,
      docId: m.doc_id,
      branchId: m.branch_id,
      qty: m.qty,
      price: m.price,
      balance,
    };
  });

  return {
    item: { pid: item.id, name: item.name ?? '', kind: opts.kind },
    from: opts.from,
    to: opts.to,
    opening: prior.rows[0]?.qty ?? '0',
    rows,
    closing: balance,
  };
}

// ---------------------------------------------------------------------------
// Sale and purchase reports
// ---------------------------------------------------------------------------

export async function getSaleReport(principal: Principal, opts: DateRange) {
  const branchId = scope(principal, opts.branchId);

  const rows = await sql<{
    id: number;
    date: string;
    party: string | null;
    gross_total: string;
    discount: string;
    service: string;
    net_total: string;
    received: string;
    remaining: string;
  }>`
    SELECT s.id, s.date, c.name AS party, s.gross_total::text, s.discount::text,
           s.service::text, s.net_total::text, s.received::text, s.remaining::text
    FROM   sale s
    LEFT   JOIN customer c ON c.id = s.cust_id
    WHERE  s.date >= ${opts.from} AND s.date <= ${opts.to}
    ${branchId === null ? sql`` : sql`AND s.branch_id = ${branchId}`}
    ORDER  BY s.date, s.id
  `.execute(db);

  const totals = rows.rows.reduce(
    (acc, r) => ({
      gross: add(acc.gross, r.gross_total),
      discount: add(acc.discount, r.discount),
      service: add(acc.service, r.service),
      net: add(acc.net, r.net_total),
      received: add(acc.received, r.received),
      remaining: add(acc.remaining, r.remaining),
    }),
    { gross: '0.00', discount: '0.00', service: '0.00', net: '0.00', received: '0.00', remaining: '0.00' },
  );

  return { from: opts.from, to: opts.to, rows: rows.rows, totals, count: rows.rows.length };
}

export async function getPurchaseReport(principal: Principal, opts: DateRange) {
  const branchId = scope(principal, opts.branchId);

  const rows = await sql<{
    id: number;
    date: string;
    party: string | null;
    sub_total: string;
    discount: string;
    rent: string;
    net_total: string;
    paid: string;
    remaining: string;
  }>`
    SELECT p.id, p.date, s.name AS party, p.sub_total::text, p.discount::text,
           p.rent::text, p.net_total::text, p.paid::text, p.remaining::text
    FROM   purchase p
    LEFT   JOIN supplier s ON s.id = p.sup_id
    WHERE  p.date >= ${opts.from} AND p.date <= ${opts.to}
    ${branchId === null ? sql`` : sql`AND p.branch_id = ${branchId}`}
    ORDER  BY p.date, p.id
  `.execute(db);

  const totals = rows.rows.reduce(
    (acc, r) => ({
      sub: add(acc.sub, r.sub_total),
      discount: add(acc.discount, r.discount),
      freight: add(acc.freight, r.rent),
      net: add(acc.net, r.net_total),
      paid: add(acc.paid, r.paid),
      remaining: add(acc.remaining, r.remaining),
    }),
    { sub: '0.00', discount: '0.00', freight: '0.00', net: '0.00', paid: '0.00', remaining: '0.00' },
  );

  return { from: opts.from, to: opts.to, rows: rows.rows, totals, count: rows.rows.length };
}

// ---------------------------------------------------------------------------
// Cash book — the cash account with a running balance
// ---------------------------------------------------------------------------

export async function getCashBook(
  principal: Principal,
  opts: DateRange & { account?: number | undefined },
) {
  const branchId = scope(principal, opts.branchId);
  const accountId = opts.account ?? ACC.CASH;

  const prior = await sql<{ dr: string; cr: string }>`
    SELECT COALESCE(SUM(dr), 0)::text AS dr, COALESCE(SUM(cr), 0)::text AS cr
    FROM   transactions
    WHERE  account_id = ${accountId} AND date < ${opts.from}
    ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`}
  `.execute(db);

  const movements = await sql<{
    date: string;
    vtype: string;
    trans_id: number;
    detail: string | null;
    dr: string;
    cr: string;
  }>`
    SELECT date, vtype, trans_id, detail, dr::text, cr::text
    FROM   transactions
    WHERE  account_id = ${accountId}
      AND  date >= ${opts.from} AND date <= ${opts.to}
    ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`}
    ORDER  BY date, trans_id, id
  `.execute(db);

  // Cash is an asset: debit-normal.
  let balance = sub(prior.rows[0]?.dr ?? '0', prior.rows[0]?.cr ?? '0');
  const opening = balance;

  let totalIn = '0.00';
  let totalOut = '0.00';

  const rows = movements.rows.map((m) => {
    balance = add(balance, sub(m.dr, m.cr));
    totalIn = add(totalIn, m.dr);
    totalOut = add(totalOut, m.cr);

    return {
      date: m.date,
      vtype: m.vtype,
      transId: m.trans_id,
      detail: m.detail ?? '',
      receipt: m.dr,
      payment: m.cr,
      balance,
    };
  });

  return {
    accountId,
    from: opts.from,
    to: opts.to,
    opening,
    rows,
    totals: { receipts: totalIn, payments: totalOut },
    closing: balance,
  };
}

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

interface StatementLine {
  accountId: number;
  name: string;
  amount: MoneyString;
}

/**
 * Account balances for a set of heads over a period.
 * `signed` returns the balance in the head's normal direction.
 */
async function balancesByHead(
  heads: readonly number[],
  opts: { from?: string | undefined; to: string; branchId: number | null; debitNormal: boolean },
): Promise<StatementLine[]> {
  const rows = await sql<{ account_id: number; name: string | null; dr: string; cr: string }>`
    SELECT a.account_id, a.name,
           COALESCE(SUM(t.dr), 0)::text AS dr,
           COALESCE(SUM(t.cr), 0)::text AS cr
    FROM   account a
    JOIN   transactions t ON t.account_id = a.account_id
    WHERE  a.head_id = ANY(${[...heads]})
      AND  t.date <= ${opts.to}
    ${opts.from === undefined ? sql`` : sql`AND t.date >= ${opts.from}`}
    ${opts.branchId === null ? sql`` : sql`AND t.branch_id = ${opts.branchId}`}
    GROUP  BY a.account_id, a.name
    ORDER  BY a.account_id
  `.execute(db);

  return rows.rows
    .map((r) => ({
      accountId: r.account_id,
      name: r.name ?? '',
      amount: opts.debitNormal ? sub(r.dr, r.cr) : sub(r.cr, r.dr),
    }))
    .filter((l) => Number(l.amount) !== 0);
}

/**
 * Income statement for a period.
 *
 * Revenue is head 4 (credit-normal), expenses head 5 (debit-normal). Unlike the
 * balance sheet this covers a RANGE, because profit is a flow not a position.
 */
export async function getIncomeStatement(principal: Principal, opts: DateRange) {
  const branchId = scope(principal, opts.branchId);

  const [revenue, expenses] = await Promise.all([
    balancesByHead([4], { from: opts.from, to: opts.to, branchId, debitNormal: false }),
    balancesByHead([5], { from: opts.from, to: opts.to, branchId, debitNormal: true }),
  ]);

  const totalRevenue = revenue.reduce((a, l) => add(a, l.amount), '0.00');
  const totalExpenses = expenses.reduce((a, l) => add(a, l.amount), '0.00');

  return {
    from: opts.from,
    to: opts.to,
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netProfit: sub(totalRevenue, totalExpenses),
  };
}

/**
 * Balance sheet as at a date.
 *
 * Assets (head 1) = Liabilities (2) + Equity (3) + retained profit. Profit is
 * folded in because the legacy chart has no closing process — revenue and
 * expense accounts are never zeroed into equity, so the statement has to derive
 * it rather than read it.
 */
export async function getBalanceSheet(
  principal: Principal,
  opts: { asAt: string; branchId?: number | undefined },
) {
  const branchId = scope(principal, opts.branchId);

  const [assets, liabilities, equity, revenue, expenses] = await Promise.all([
    balancesByHead([1], { to: opts.asAt, branchId, debitNormal: true }),
    balancesByHead([2], { to: opts.asAt, branchId, debitNormal: false }),
    balancesByHead([3], { to: opts.asAt, branchId, debitNormal: false }),
    balancesByHead([4], { to: opts.asAt, branchId, debitNormal: false }),
    balancesByHead([5], { to: opts.asAt, branchId, debitNormal: true }),
  ]);

  const totalAssets = assets.reduce((a, l) => add(a, l.amount), '0.00');
  const totalLiabilities = liabilities.reduce((a, l) => add(a, l.amount), '0.00');
  const totalEquity = equity.reduce((a, l) => add(a, l.amount), '0.00');

  const retainedProfit = sub(
    revenue.reduce((a, l) => add(a, l.amount), '0.00'),
    expenses.reduce((a, l) => add(a, l.amount), '0.00'),
  );

  const totalEquityAndLiabilities = add(add(totalLiabilities, totalEquity), retainedProfit);

  return {
    asAt: opts.asAt,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    retainedProfit,
    totalEquityAndLiabilities,
    balanced: totalAssets === totalEquityAndLiabilities,
  };
}
