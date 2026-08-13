/**
 * Sale return routes. Legacy form id 13, form code 402.
 *
 * Ports SaleReturnController: Index / Create / Save / Edit / Print /
 * GetSaleDataById.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import { WALK_IN_CUSTOMER_ID } from '../../accounting/accounts.js';
import { loadPrintDocument } from '../print/service.js';
import * as service from './service.js';

const PERM = formPermissions(13, 402);

const decimalString = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number`);

const body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  custId: z.coerce.number().int().positive(),
  saleId: z.coerce.number().int().positive().nullish(),
  branchId: z.coerce.number().int().optional(),
  discount: decimalString('Discount').default('0'),
  paid: decimalString('Refund').default('0'),
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

export default async function saleReturnRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('sale_return')
        .leftJoin('customer', 'customer.id', 'sale_return.cust_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('sale_return.branch_id', '=', req.principal.branchId);
      } else if (q.branchId !== undefined) {
        base = base.where('sale_return.branch_id', '=', q.branchId);
      }

      const term = likeTerm(q.search);
      if (term) base = base.where('customer.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'sale_return.id',
            'sale_return.doc_number',
            'sale_return.date',
            'sale_return.sale_id',
            'sale_return.net_total',
            'sale_return.paid',
            'sale_return.remaining',
            'customer.name as customer_name',
          ])
          .orderBy('sale_return.date', 'desc')
          .orderBy('sale_return.id', 'desc')
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
      // A super admin has no implicit branch, so product pricing (branch-
      // specific since the catalog split) can only be shown once one is
      // picked on the return screen.
      const { branchId: queryBranchId } = z
        .object({ branchId: z.coerce.number().int().positive().optional() })
        .parse(req.query);
      const effectiveBranchId = isSuper ? queryBranchId : branchId;

      let customers = db
        .selectFrom('customer')
        .select(['id', 'name', 'phone'])
        .where('is_active', '=', true);

      customers = isSuper
        ? customers
        : customers.where((eb) =>
            eb.or([eb('branch_id', '=', branchId), eb('id', '=', WALK_IN_CUSTOMER_ID)]),
          );

      const products = effectiveBranchId
        ? db
            .selectFrom('product')
            .innerJoin('branch_product', 'branch_product.product_id', 'product.id')
            .select([
              'product.id',
              'product.name',
              'branch_product.selling_price as sellingPrice',
            ])
            .where('product.is_active', '=', true)
            .where('branch_product.is_active', '=', true)
            .where('branch_product.branch_id', '=', effectiveBranchId)
            .orderBy('product.name')
            .execute()
        : Promise.resolve([]);

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', branchId);

      const [customerRows, productRows, branchRows] = await Promise.all([
        customers.orderBy('name').execute(),
        products,
        branches.orderBy('name').execute(),
      ]);

      return { customers: customerRows, products: productRows, branches: branchRows };
    },
  });

  /**
   * Load an original invoice to return against — the legacy GetSaleDataById.
   * Reports how much has already been returned so the operator cannot
   * over-credit; the server enforces the limit regardless.
   */
  app.get('/from-sale/:saleId', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { saleId } = z
        .object({ saleId: z.coerce.number().int().positive() })
        .parse(req.params);

      const sale = await db
        .selectFrom('sale')
        .selectAll()
        .where('id', '=', saleId)
        .executeTakeFirst();

      if (!sale) throw notFound('Sale');

      if (!req.principal.isSuperAdmin && sale.branch_id !== req.principal.branchId) {
        throw notFound('Sale');
      }

      const [lines, returned] = await Promise.all([
        db
          .selectFrom('sale_detail')
          .selectAll()
          .where('sale_id', '=', saleId)
          .orderBy('id')
          .execute(),
        db
          .selectFrom('sale_return')
          .select(({ fn }) => fn.sum<string>('net_total').as('total'))
          .where('sale_id', '=', saleId)
          .executeTakeFirst(),
      ]);

      return {
        sale,
        lines,
        alreadyReturned: returned?.total ?? '0.00',
      };
    },
  });

  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const row = await db
        .selectFrom('sale_return')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!row) throw notFound('Sale Return');

      if (!req.principal.isSuperAdmin && row.branch_id !== req.principal.branchId) {
        throw notFound('Sale Return');
      }

      const lines = await db
        .selectFrom('sale_return_detail')
        .selectAll()
        .where('sale_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...row, lines };
    },
  });

  app.post('/preview', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { cogs: _cogs, ...safe } = await service.computeTotals(body.parse(req.body));
      return safe;
    },
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const result = await service.createSaleReturn(req.principal, body.parse(req.body));
      return reply.status(201).send(result);
    },
  });

  app.put('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return service.updateSaleReturn(req.principal, id, body.parse(req.body));
    },
  });

  app.get('/:id/print', {
    preHandler: app.requireAction(PERM.formId, PERM.print),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return loadPrintDocument(req.principal, 'sale-return', id);
    },
  });
}
