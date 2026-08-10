/**
 * Purchase return routes. Legacy form id 11, form code 302.
 *
 * Ports PurchaseReturnController: Index / Create / Save / Edit / Print.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import { loadPrintDocument } from '../print/service.js';
import * as service from './service.js';

const PERM = formPermissions(11, 302);

const decimalString = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number`);

const body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  supId: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().optional(),
  discount: decimalString('Discount').default('0'),
  rent: decimalString('Freight').default('0'),
  received: decimalString('Refund').default('0'),
  notes: z.string().max(1000).nullish(),
  lines: z
    .array(
      z.object({
        pid: z.coerce.number().int().positive(),
        qty: decimalString('Quantity'),
        price: decimalString('Price'),
        discount: decimalString('Discount').default('0'),
      }),
    )
    .min(1, 'Add at least one item'),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function purchaseReturnRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('purchase_return')
        .leftJoin('supplier', 'supplier.id', 'purchase_return.sup_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('purchase_return.branch_id', '=', req.principal.branchId);
      } else if (q.branchId !== undefined) {
        base = base.where('purchase_return.branch_id', '=', q.branchId);
      }

      const term = likeTerm(q.search);
      if (term) base = base.where('supplier.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'purchase_return.id',
            'purchase_return.date',
            'purchase_return.net_total',
            'purchase_return.received',
            'purchase_return.remaining',
            'supplier.name as supplier_name',
          ])
          .orderBy('purchase_return.date', 'desc')
          .orderBy('purchase_return.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/form-data', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const isSuper = req.principal.isSuperAdmin;
      const branchId = req.principal.branchId;

      let suppliers = db
        .selectFrom('supplier')
        .select(['id', 'name', 'phone'])
        .where('is_active', '=', true);

      if (!isSuper) suppliers = suppliers.where('branch_id', '=', branchId);

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', branchId);

      const [supplierRows, productRows, branchRows] = await Promise.all([
        suppliers.orderBy('name').execute(),
        db
          .selectFrom('raw_product')
          .select(['id', 'name', 'price as sale_price'])
          .where('is_active', '=', true)
          .orderBy('name')
          .execute(),
        branches.orderBy('name').execute(),
      ]);

      return { suppliers: supplierRows, products: productRows, branches: branchRows };
    },
  });

  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const row = await db
        .selectFrom('purchase_return')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!row) throw notFound('Purchase Return');

      if (!req.principal.isSuperAdmin && row.branch_id !== req.principal.branchId) {
        throw notFound('Purchase Return');
      }

      const lines = await db
        .selectFrom('purchase_return_detail')
        .selectAll()
        .where('purchase_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...row, lines };
    },
  });

  app.post('/preview', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => service.computeTotals(body.parse(req.body)),
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const result = await service.createPurchaseReturn(req.principal, body.parse(req.body));
      return reply.status(201).send(result);
    },
  });

  app.put('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return service.updatePurchaseReturn(req.principal, id, body.parse(req.body));
    },
  });

  app.get('/:id/print', {
    preHandler: app.requireAction(PERM.formId, PERM.print),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return loadPrintDocument(req.principal, 'purchase-return', id);
    },
  });
}
