/**
 * Expense routes — per-branch daily expenses, with a central category list
 * (form 56 / code 806, head 13).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { forbidden, notFound } from '../../core/errors.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import * as service from './service.js';

const PERM = formPermissions(56, 806);

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function expenseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/categories', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => {
      return db
        .selectFrom('expense_category')
        .select(['id', 'name', 'account_id', 'is_active'])
        .orderBy('name')
        .execute();
    },
  });

  app.post('/categories', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      if (!req.principal.isSuperAdmin) throw forbidden('Only the super admin can add a category');
      const body = z
        .object({
          name: z.string().trim().min(1).max(100),
          accountId: z.coerce.number().int().positive(),
        })
        .parse(req.body);

      const created = await db
        .insertInto('expense_category')
        .values({ name: body.name, account_id: body.accountId, created_by: req.principal.empId, updated_by: req.principal.empId })
        .returningAll()
        .executeTakeFirstOrThrow();

      return reply.status(201).send(created);
    },
  });

  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const { month } = z.object({ month: z.string().optional() }).parse(req.query);

      let base = db.selectFrom('expense').leftJoin('expense_category', 'expense_category.id', 'expense.category_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('expense.branch_id', '=', req.principal.branchId);
      }
      if (month) base = base.where('expense.date', '>=', `${month}-01`).where('expense.date', '<', nextMonth(month));

      const term = likeTerm(q.search);
      if (term) base = base.where('expense.description', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'expense.id',
            'expense.date',
            'expense.amount',
            'expense.method',
            'expense.description',
            'expense.branch_id',
            'expense_category.name as category_name',
          ])
          .orderBy('expense.date', 'desc')
          .orderBy('expense.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/report', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => service.expenseReport(),
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          categoryId: z.coerce.number().int().positive(),
          amount: z.union([z.string(), z.number()]).transform(String),
          method: z.enum(['CASH', 'BANK']).default('CASH'),
          description: z.string().trim().min(1).max(500),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      return reply.status(201).send(await service.createExpense(req.principal, body));
    },
  });

  app.delete('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const row = await db.selectFrom('expense').select(['id', 'branch_id']).where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Expense');
      if (!req.principal.isSuperAdmin && row.branch_id !== req.principal.branchId) throw notFound('Expense');

      await db.deleteFrom('expense').where('id', '=', id).execute();
      return reply.status(204).send();
    },
  });
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y!, m!, 1);
  return d.toISOString().slice(0, 10);
}
