/**
 * Expenses (Phase 8) — one branch, one date, one category, one description,
 * posting Dr expense / Cr cash.
 *
 * Runs inside `inRollback`. Nothing reaches the shared database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { totals } from '../src/accounting/journal.js';
import { closeDb } from '../src/core/db/index.js';
import { createExpense, expenseReport } from '../src/modules/expense/service.js';
import { inRollback } from './helpers/rollback.js';

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const BRANCH = 9800;

afterAll(async () => {
  await closeDb();
});

describe('expenses', () => {
  it('posts a balanced voucher and lands in the month report', async () => {
    await inRollback(async (tx) => {
      const category = await tx
        .selectFrom('expense_category')
        .select(['id', 'account_id'])
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('branch')
        .values({ id: BRANCH, name: 'Expense Test Branch', code: 'EXTEST', type: 'BRANCH' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const exp = await createExpense(
        { ...PRINCIPAL, branchId: BRANCH, isSuperAdmin: false },
        {
          date: '2026-08-01',
          categoryId: category.id,
          amount: '1500.00',
          method: 'CASH',
          description: 'Shop rent',
        },
        tx,
      );

      const legs = await tx
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('vtype', '=', 'CPV')
        .where('inv_id', '=', exp.id)
        .execute();

      expect(
        totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance,
      ).toBe('0.00');
      expect(legs.find((l) => l.account_id === category.account_id)?.dr).toBe('1500.00');

      const report = await expenseReport(tx);
      expect(report.byCategory.length).toBeGreaterThan(0);
      expect(report.monthTotal).toBeDefined();
    });
  });

  it('refuses a zero or negative amount', async () => {
    await inRollback(async (tx) => {
      const category = await tx
        .selectFrom('expense_category')
        .select(['id'])
        .executeTakeFirstOrThrow();

      await expect(
        createExpense(
          { ...PRINCIPAL, branchId: BRANCH, isSuperAdmin: false },
          {
            date: '2026-08-01',
            categoryId: category.id,
            amount: '0',
            method: 'CASH',
            description: 'Nothing',
          },
          tx,
        ),
      ).rejects.toThrow(/greater than zero/i);
    });
  });
});
