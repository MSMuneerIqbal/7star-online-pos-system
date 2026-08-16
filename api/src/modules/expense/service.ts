/**
 * Expenses — one branch, one date, one category, one description.
 *
 * Each category maps to its chart-of-accounts expense code, so recording an
 * expense posts Dr expense / Cr cash (or bank). The total flows into branch
 * profit: selling − wholesale − expenses.
 */
import { db, inTransaction, type Executor, type Tx } from '../../core/db/index.js';
import { sql } from 'kysely';
import { badRequest, notFound } from '../../core/errors.js';
import { dec, money } from '../../core/money.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { ACC, VTYPE } from '../../accounting/accounts.js';
import { buildJournal, credit, debit } from '../../accounting/journal.js';
import { postJournal } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface ExpenseInput {
  date: string;
  categoryId: number;
  amount: string;
  method: 'CASH' | 'BANK';
  description: string;
  branchId?: number | undefined;
}

export async function createExpense(
  principal: Principal,
  input: ExpenseInput,
  outerTx?: Tx,
): Promise<{ id: number }> {
  const amount = dec(input.amount);
  if (amount.lte(0)) throw badRequest('Expense amount must be greater than zero');
  if (!input.description.trim()) throw badRequest('Describe the expense');

  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  const category = await (outerTx ?? db)
    .selectFrom('expense_category')
    .select(['id', 'name', 'account_id'])
    .where('id', '=', input.categoryId)
    .executeTakeFirst();
  if (!category) throw badRequest(`Unknown expense category id ${input.categoryId}`);

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .insertInto('expense')
      .values({
        branch_id: branchId,
        date: input.date,
        category_id: input.categoryId,
        amount: money(amount),
        method: input.method,
        description: input.description.trim(),
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const cash = input.method === 'BANK' ? ACC.BANK : ACC.CASH;
    await postJournal(
      tx,
      buildJournal({
        vtype: VTYPE.CASH_PAYMENT,
        date: input.date,
        invId: row.id,
        branchId,
        legs: [
          debit(category.account_id, money(amount), `Expense – ${category.name}`),
          credit(cash, money(amount), `Expense paid – ${input.description}`),
        ],
      }),
    );

    await writeAudit(
      principal,
      { form: 'Expenses', action: 'New', detail: `Expense ${fmt(money(amount))} – ${category.name}`, invId: row.id },
      tx,
    );

    return { id: row.id };
  });
}

/**
 * The month-based report: per-category totals for the given month, the previous
 * month beside it, and a full twelve-month table.
 */
export async function expenseReport(executor: Executor = db): Promise<{
  categories: Array<{ categoryId: number; name: string }>;
  month: string;
  monthTotal: string;
  previousMonth: string;
  previousMonthTotal: string;
  byCategory: Array<{ name: string; thisMonth: string; lastMonth: string }>;
  year: Array<{ month: string; total: string }>;
}> {
  const now = new Date();
  const month = now.toISOString().slice(0, 7); // YYYY-MM
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonth = prevDate.toISOString().slice(0, 7);

  const categories = await executor
    .selectFrom('expense_category')
    .select(['id', 'name'])
    .where('is_active', '=', true)
    .orderBy('name')
    .execute();

  const byCategory = await sql<{ name: string; thisMonth: string; lastMonth: string }>`
    SELECT c.name,
           COALESCE(SUM(e.amount) FILTER (WHERE to_char(e.date, 'YYYY-MM') = ${month}), 0)::text AS thisMonth,
           COALESCE(SUM(e.amount) FILTER (WHERE to_char(e.date, 'YYYY-MM') = ${previousMonth}), 0)::text AS lastMonth
    FROM   expense_category c
    LEFT   JOIN expense e ON e.category_id = c.id
    GROUP  BY c.name
    ORDER  BY c.name
  `.execute(executor);

  const year = await sql<{ month: string; total: string }>`
    SELECT to_char(d.m, 'YYYY-MM') AS month, COALESCE(SUM(e.amount), 0)::text AS total
    FROM   generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS d(m)
    LEFT   JOIN expense e ON to_char(e.date, 'YYYY-MM') = to_char(d.m, 'YYYY-MM')
    GROUP  BY d.m
    ORDER  BY d.m
  `.execute(executor);

  const monthTotal = byCategory.rows.reduce((acc, r) => acc.add(dec(r.thisMonth)), dec(0));
  const previousMonthTotal = byCategory.rows.reduce((acc, r) => acc.add(dec(r.lastMonth)), dec(0));

  return {
    categories: categories.map((c) => ({ categoryId: c.id, name: c.name })),
    month,
    monthTotal: money(monthTotal),
    previousMonth,
    previousMonthTotal: money(previousMonthTotal),
    byCategory: byCategory.rows.map((r) => ({
      name: r.name,
      thisMonth: money(r.thisMonth),
      lastMonth: money(r.lastMonth),
    })),
    year: year.rows.map((r) => ({ month: r.month, total: money(r.total) })),
  };
}
