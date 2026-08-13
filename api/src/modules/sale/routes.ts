/**
 * Sale routes. Legacy form id 12, form code 401.
 *
 * Ports SaleController: Index / Create / Save / Edit / Delete / Print /
 * CheckPhone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import { WALK_IN_CUSTOMER_ID } from '../../accounting/accounts.js';
import { loadPrintDocument } from '../print/service.js';
import * as service from './service.js';

const PERM = formPermissions(12, 401);

/** Money as a decimal string. Kept as a string end to end — never a float. */
const decimalString = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number`);

const lineSchema = z.object({
  pid: z.coerce.number().int().positive(),
  qty: decimalString('Quantity'),
  price: decimalString('Price'),
  discount: decimalString('Discount').default('0'),
});

const saleBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  custId: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().optional(),
  discount: decimalString('Discount').default('0'),
  service: decimalString('Service').default('0'),
  received: decimalString('Received').default('0'),
  notes: z.string().max(1000).nullish(),
  lines: z.array(lineSchema).min(1, 'Add at least one item'),
  walkIn: z
    .object({
      name: z.string().max(150).nullish(),
      phone: z.string().max(50).nullish(),
      address: z.string().max(300).nullish(),
    })
    .optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function saleRoutes(app: FastifyInstance): Promise<void> {
  // ---- list -------------------------------------------------------------
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const dates = z
        .object({ from: z.string().optional(), to: z.string().optional() })
        .parse(req.query);

      let base = db.selectFrom('sale').leftJoin('customer', 'customer.id', 'sale.cust_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('sale.branch_id', '=', req.principal.branchId);
      } else if (q.branchId !== undefined) {
        base = base.where('sale.branch_id', '=', q.branchId);
      }

      if (dates.from) base = base.where('sale.date', '>=', dates.from);
      if (dates.to) base = base.where('sale.date', '<=', dates.to);

      const term = likeTerm(q.search);
      if (term) base = base.where('customer.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'sale.id',
            'sale.doc_number',
            'sale.date',
            'sale.net_total',
            'sale.received',
            'sale.remaining',
            'sale.branch_id',
            'customer.name as customer_name',
          ])
          .orderBy('sale.date', 'desc')
          .orderBy('sale.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  // ---- form data --------------------------------------------------------
  // One request for everything the create screen needs, replacing the legacy
  // Create action that stuffed four lists into a view model.
  app.get('/form-data', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const branchId = req.principal.branchId;
      const isSuper = req.principal.isSuperAdmin;
      // A super admin has no implicit branch, so product pricing (branch-
      // specific since the catalog split) can only be shown once one is
      // picked on the create screen.
      const { branchId: queryBranchId } = z
        .object({ branchId: z.coerce.number().int().positive().optional() })
        .parse(req.query);
      const effectiveBranchId = isSuper ? queryBranchId : branchId;

      let customers = db
        .selectFrom('customer')
        .select(['id', 'name', 'phone', 'account_id'])
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
              'product.unit_of_measure',
              'branch_product.selling_price as sellingPrice',
              'branch_product.minimum_price as minimumPrice',
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

      return {
        customers: customerRows,
        products: productRows,
        branches: branchRows,
        walkInCustomerId: WALK_IN_CUSTOMER_ID,
      };
    },
  });

  // ---- read one ---------------------------------------------------------
  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const sale = await db.selectFrom('sale').selectAll().where('id', '=', id).executeTakeFirst();
      if (!sale) throw notFound('Sale');

      if (!req.principal.isSuperAdmin && sale.branch_id !== req.principal.branchId) {
        throw notFound('Sale');
      }

      const [lines, walkIn] = await Promise.all([
        db
          .selectFrom('sale_detail')
          .selectAll()
          .where('sale_id', '=', id)
          .orderBy('id')
          .execute(),
        sale.sale_cust_id
          ? db
              .selectFrom('sale_customer')
              .select(['id', 'name', 'phone', 'address'])
              .where('id', '=', sale.sale_cust_id)
              .executeTakeFirst()
          : Promise.resolve(undefined),
      ]);

      return { ...sale, lines, walkIn: walkIn ?? null };
    },
  });

  // ---- preview ----------------------------------------------------------
  // Server-side totals without saving, so the UI never has to be the authority
  // on money. The grid uses this to confirm what it computed locally.
  app.post('/preview', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const body = saleBody.parse(req.body);
      const totals = await service.computeTotals(body);

      // COGS is internal margin data; it never leaves the server.
      const { cogs: _cogs, ...safe } = totals;
      return safe;
    },
  });

  // ---- create / update --------------------------------------------------
  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = saleBody.parse(req.body);
      const result = await service.createSale(req.principal, body);
      return reply.status(201).send(result);
    },
  });

  app.put('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = saleBody.parse(req.body);
      return service.updateSale(req.principal, id, body);
    },
  });

  // ---- print ------------------------------------------------------------
  app.get('/:id/print', {
    preHandler: app.requireAction(PERM.formId, PERM.print),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return loadPrintDocument(req.principal, 'sale', id);
    },
  });

  // ---- walk-in lookup ---------------------------------------------------
  app.get('/walk-in', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { phone } = z.object({ phone: z.string().min(3).max(50) }).parse(req.query);

      return db
        .selectFrom('sale_customer')
        .select(['id', 'name', 'phone', 'address'])
        .where('phone', 'like', `%${phone}%`)
        .where('branch_id', '=', req.principal.branchId)
        .limit(10)
        .execute();
    },
  });
}
