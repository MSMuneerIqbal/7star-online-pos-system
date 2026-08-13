/**
 * Expenses (Phase 8) — one branch, one date, one category, one description,
 * posting Dr expense / Cr cash.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { totals } from '../src/accounting/journal.js';
import { closeDb, db } from '../src/core/db/index.js';
import { createExpense, expenseReport } from '../src/modules/expense/service.js';

const PRINCIPAL = { userId: 0, username: 'super', empId: 0, branchId: 0, roleId: null, isSuperAdmin: true };

afterAll(async () => {
  await closeDb();
});

describe('expenses', () => {
  it('posts a balanced voucher and lands in the month report', async () => {
    const suffix = Date.now();
    const category = await db.selectFrom('expense_category').select(['id', 'account_id']).executeTakeFirstOrThrow();

    await db.insertInto('branch').values({ id: 9800, name: `EXP ${suffix}`, code: `EX${suffix}`.slice(0, 10), type: 'BRANCH' }).execute();

    let expId: number | null = null;
    try {
      const exp = await createExpense(
        { ...PRINCIPAL, branchId: 9800, isSuperAdmin: false },
        { date: '2026-08-01', categoryId: category.id, amount: '1500.00', method: 'CASH', description: 'Shop rent' },
      );
      expId = exp.id;

      const legs = await db.selectFrom('transactions').select(['account_id', 'dr', 'cr']).where('inv_id', '=', exp.id).execute();
      expect(totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance).toBe('0.00');
      expect(legs.find((l) => l.account_id === category.account_id)?.dr).toBe('1500.00');

      const report = await expenseReport();
      expect(report.byCategory.length).toBeGreaterThan(0);
      expect(report.monthTotal).toBeDefined();
    } finally {
      if (expId !== null) {
        await db.deleteFrom('transactions').where('inv_id', '=', expId).execute();
        await db.deleteFrom('user_log').where('inv_id', '=', expId).execute();
        await db.deleteFrom('expense').where('id', '=', expId).execute();
      }
      await db.deleteFrom('branch_product').where('branch_id', '=', 9800).execute();
      await db.deleteFrom('document_counter').where('branch_id', '=', 9800).execute();
      await db.deleteFrom('branch').where('id', '=', 9800).execute();
    }
  });
});
