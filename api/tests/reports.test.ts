/**
 * Report tests, against real Postgres.
 *
 * These reports never existed in the legacy system, and the financial ones
 * could not have worked there: with unbalanced sale and inter-branch postings a
 * balance sheet would never have balanced. The assertions below are the proof
 * that they do now.
 *
 * Mostly read-only, so most need no rollback wrapper. The rule they follow is
 * that an assertion must hold for ANY database state — empty or not. Anything
 * that needs specific figures seeds them inside `inRollback` and reads them back
 * through the `executor` option, rather than hoping the shared instance happens
 * to contain something.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { add, sub } from '../src/core/money.js';
import { closeDb, db } from '../src/core/db/index.js';
import * as reports from '../src/modules/reports/service.js';
import { getTrialBalance } from '../src/modules/ledger/service.js';
import type { Principal } from '../src/core/rbac.js';
import { ACC } from '../src/accounting/accounts.js';
import { inRollback } from './helpers/rollback.js';

/** A super admin sees every branch, which is what the statements need. */
const admin: Principal = {
  userId: 1,
  username: 'test',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const FROM = '2000-01-01';
const TO = '2099-12-31';
const AS_AT = '2099-12-31';

afterAll(async () => {
  await closeDb();
});

describe('balance sheet', () => {
  it('balances: assets = liabilities + equity + retained profit', async () => {
    const bs = await reports.getBalanceSheet(admin, { asAt: AS_AT });

    // The accounting identity. This is the single most important assertion in
    // the whole suite — it can only hold if every voucher balances.
    expect(bs.totalAssets).toBe(bs.totalEquityAndLiabilities);
    expect(bs.balanced).toBe(true);
  });

  it('derives retained profit, because the legacy chart never closes the books', async () => {
    const [bs, is] = await Promise.all([
      reports.getBalanceSheet(admin, { asAt: AS_AT }),
      reports.getIncomeStatement(admin, { from: FROM, to: TO }),
    ]);

    // Revenue and expense accounts are never zeroed into equity, so the balance
    // sheet has to compute profit rather than read it. Over an all-time range
    // the two must agree.
    expect(bs.retainedProfit).toBe(is.netProfit);
  });

  it('reports assets on the debit side and liabilities on the credit side', async () => {
    // Seeds its own voucher rather than reading whatever happens to be in the
    // database. The assertion here is about SIGN NORMALISATION — assets read
    // positive from a debit balance — and that has nothing to do with how much
    // trading has been done.
    //
    // It used to assert `totalAssets > 0` against ambient data, which passed
    // only because the shared database happened to hold a few vouchers. When
    // the ledger was emptied the test failed, having never actually exercised
    // the behaviour it names. A test that depends on data it did not create is
    // a coin flip.
    await inRollback(async (tx) => {
      await tx
        .insertInto('transactions')
        .values([
          {
            date: '2026-01-01',
            vtype: 'JV',
            inv_id: 990001,
            trans_id: 990001,
            voucher_no: 990001,
            account_id: ACC.CASH,
            dr: '7500.00',
            cr: '0.00',
            detail: 'Balance sheet sign test',
            branch_id: 0,
          },
          {
            date: '2026-01-01',
            vtype: 'JV',
            inv_id: 990001,
            trans_id: 990001,
            voucher_no: 990001,
            account_id: ACC.OWNER_CAPITAL,
            dr: '0.00',
            cr: '7500.00',
            detail: 'Balance sheet sign test',
            branch_id: 0,
          },
        ])
        .execute();

      const bs = await reports.getBalanceSheet(admin, { asAt: AS_AT, executor: tx });

      // A debit balance on an asset account reads positive, not negative.
      expect(Number(bs.totalAssets)).toBeGreaterThan(0);
      expect(bs.assets.some((l) => l.accountId === ACC.CASH)).toBe(true);
      for (const line of bs.assets) expect(line.name).toBeTruthy();

      // And the identity still holds on a set of books we control exactly.
      expect(bs.totalAssets).toBe(bs.totalEquityAndLiabilities);
    });
  });
});

describe('income statement', () => {
  it('computes net profit as revenue less expenses', async () => {
    const is = await reports.getIncomeStatement(admin, { from: FROM, to: TO });

    expect(is.netProfit).toBe(sub(is.totalRevenue, is.totalExpenses));
  });

  it('covers a range, not a position', async () => {
    // A one-day window in the far past must be empty even though the all-time
    // statement is not — profit is a flow.
    const empty = await reports.getIncomeStatement(admin, {
      from: '2001-01-01',
      to: '2001-01-02',
    });

    expect(empty.totalRevenue).toBe('0.00');
    expect(empty.totalExpenses).toBe('0.00');
    expect(empty.netProfit).toBe('0.00');
  });
});

describe('trial balance agrees with the statements', () => {
  it('total debits equal total credits', async () => {
    const tb = await getTrialBalance(admin, { asAt: AS_AT });

    expect(tb.balanced).toBe(true);
    expect(tb.totals.dr).toBe(tb.totals.cr);
  });

  it('ties to the balance sheet through the accounting identity', async () => {
    const [bs, is] = await Promise.all([
      reports.getBalanceSheet(admin, { asAt: AS_AT }),
      reports.getIncomeStatement(admin, { from: FROM, to: TO }),
    ]);

    // assets + expenses = liabilities + equity + revenue.
    //
    // NOT "trial-balance debits = assets + expenses": an asset can carry a
    // credit balance (an overdrawn cash account) and still be an asset, so it
    // lands in the trial balance's credit column. The head-signed identity is
    // the invariant; column totals are a presentation detail.
    expect(add(bs.totalAssets, is.totalExpenses)).toBe(
      add(add(bs.totalLiabilities, bs.totalEquity), is.totalRevenue),
    );
  });
});

describe('cash book', () => {
  it('walks from opening to closing through the movements', async () => {
    const cb = await reports.getCashBook(admin, { from: FROM, to: TO });

    const walked = cb.rows.reduce(
      (bal, r) => add(bal, sub(r.receipt, r.payment)),
      cb.opening,
    );

    expect(walked).toBe(cb.closing);
  });

  it('closing equals receipts less payments when opening is zero', async () => {
    const cb = await reports.getCashBook(admin, { from: FROM, to: TO });

    expect(cb.opening).toBe('0.00');
    expect(cb.closing).toBe(sub(cb.totals.receipts, cb.totals.payments));
  });
});

describe('stock report', () => {
  it('computes closing as opening + in - out', async () => {
    const stock = await reports.getStockReport(admin, { kind: 'RAW', asAt: AS_AT });

    for (const row of stock.rows) {
      expect(row.closing).toBe(sub(add(row.opening, row.inQty), row.outQty));
    }
  });

  it('flags items below their reorder level', async () => {
    const stock = await reports.getStockReport(admin, { kind: 'RAW', asAt: AS_AT });

    for (const row of stock.rows) {
      expect(row.belowReorder).toBe(Number(row.closing) < Number(row.reorderLevel));
    }
  });

  it('splits by branch without changing the company total', async () => {
    // Branches are discovered rather than hard-coded: an earlier version named
    // ids 1 and 3, and broke the moment the database was reset.
    const branches = await db
      .selectFrom('branch')
      .select('id')
      .where('id', '>', 0)
      .execute();

    const all = await reports.getStockReport(admin, { kind: 'RAW', asAt: AS_AT });

    const perBranch = await Promise.all(
      branches.map((b) => reports.getStockReport(admin, { kind: 'RAW', asAt: AS_AT, branchId: b.id })),
    );

    // Seed with '0.00', not '0': reduce over an empty catalog returns the seed
    // untouched, while add() normalises to two decimals.
    const total = (r: { rows: { closing: string }[] }) =>
      r.rows.reduce((acc, row) => add(acc, row.closing), '0.00');

    // A transfer moves stock between branches without changing the company
    // total, so the per-branch figures must sum to the unfiltered one.
    const summed = perBranch.reduce((acc, r) => add(acc, total(r)), '0.00');
    expect(summed).toBe(total(all));
  });
});

describe('item ledger', () => {
  it('walks the running balance from opening to closing', async () => {
    const stock = await reports.getStockReport(admin, { kind: 'RAW', asAt: AS_AT });
    const moved = stock.rows.find((r) => Number(r.inQty) > 0 || Number(r.outQty) > 0);

    if (!moved) return; // nothing has moved yet; nothing to assert

    const ledger = await reports.getItemLedger(admin, {
      kind: 'RAW',
      pid: moved.pid,
      from: FROM,
      to: TO,
    });

    const walked = ledger.rows.reduce((bal, r) => add(bal, r.qty), ledger.opening);
    expect(walked).toBe(ledger.closing);
  });

  it('rejects an unknown item', async () => {
    await expect(
      reports.getItemLedger(admin, { kind: 'RAW', pid: 999_999, from: FROM, to: TO }),
    ).rejects.toThrow(/not found/i);
  });
});
