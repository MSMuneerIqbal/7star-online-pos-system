/**
 * Lab routes. Legacy forms: 49 Lab Receiving (510), 50 Lab Invoices (520).
 *
 * Lab Invoices was a stub in the legacy system — see the design note at the top
 * of service.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { forbidden, notFound } from '../../core/errors.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import * as service from './service.js';

// Lab Receiving has its own form id (52/521) as of migration 1700000000007.
// It previously shared 49/510 with DO Finish Received, so granting either
// silently granted the other.
const RECEIVING = formPermissions(52, 521);
const INVOICES = formPermissions(50, 520);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const decimal = z.union([z.string(), z.number()]).transform(String);
const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function labRoutes(app: FastifyInstance): Promise<void> {
  // ---- intake -----------------------------------------------------------
  app.get('/jobs', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const { status } = z.object({ status: z.string().optional() }).parse(req.query);

      let base = db
        .selectFrom('lab_received')
        .leftJoin('customer', 'customer.id', 'lab_received.cust_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('lab_received.branch_id', '=', req.principal.branchId);
      }

      if (status) base = base.where('lab_received.status', '=', status);

      const term = likeTerm(q.search);
      if (term) base = base.where('customer.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'lab_received.id',
            'lab_received.doc_number',
            'lab_received.date',
            'lab_received.status',
            'lab_received.gross',
            'lab_received.note',
            'customer.name as customer_name',
            'customer.phone as customer_phone',
          ])
          .orderBy('lab_received.date', 'desc')
          .orderBy('lab_received.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/form-data', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.view),
    handler: async (req) => {
      const isSuper = req.principal.isSuperAdmin;
      const branchId = isSuper ? 0 : req.principal.branchId;

      let customers = db
        .selectFrom('customer')
        .select(['id', 'name', 'phone'])
        .where('is_active', '=', true);

      if (!isSuper) customers = customers.where('branch_id', '=', req.principal.branchId);

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', req.principal.branchId);

      const repairPrices = db
        .selectFrom('branch_repair_price')
        .select(['repair_type_id', 'price'])
        .where('is_active', '=', true)
        .$if(!isSuper, (q) => q.where('branch_id', '=', req.principal.branchId));

      const [customerRows, rawRows, branchRows, repairTypeRows, repairPriceRows] = await Promise.all([
        customers.orderBy('name').execute(),
        db
          .selectFrom('raw_product')
          .select(['id', 'name', 'price'])
          .where('is_active', '=', true)
          .orderBy('name')
          .execute(),
        branches.orderBy('name').execute(),
        db
          .selectFrom('repair_type')
          .select(['id', 'name'])
          .where('is_active', '=', true)
          .orderBy('name')
          .execute(),
        repairPrices.execute(),
      ]);

      return {
        customers: customerRows,
        rawMaterials: rawRows,
        branches: branchRows,
        repairTypes: repairTypeRows,
        repairPrices: repairPriceRows,
      };
    },
  });

  app.get('/jobs/:id', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const job = await db
        .selectFrom('lab_received')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!job) throw notFound('Lab job');

      if (!req.principal.isSuperAdmin && job.branch_id !== req.principal.branchId) {
        throw notFound('Lab job');
      }

      const [lines, used] = await Promise.all([
        db
          .selectFrom('lab_received_detail')
          .selectAll()
          .where('inv_id', '=', id)
          .orderBy('id')
          .execute(),
        db.selectFrom('lab_used').selectAll().where('inv_id', '=', id).orderBy('id').execute(),
      ]);

      return { ...job, lines, materialsUsed: used };
    },
  });

  app.post('/jobs', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          custId: z.coerce.number().int().positive(),
          branchId: z.coerce.number().int().optional(),
          note: z.string().max(1000).nullish(),
          repairTypeId: z.coerce.number().int().positive().nullish(),
          fault: z.string().max(500).nullish(),
          lines: z
            .array(
              z.object({
                pname: z.string().trim().min(1, 'Describe the item').max(200),
                qty: decimal.default('1'),
                price: decimal.optional(),
                detail: z.string().max(500).nullish(),
                ready: dateString.nullish(),
              }),
            )
            .min(1, 'Record at least one item'),
        })
        .parse(req.body);

      return reply.status(201).send(await service.createIntake(req.principal, body));
    },
  });

  /** Consume raw materials against a job. */
  app.post('/jobs/:id/materials', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          date: dateString,
          lines: z
            .array(z.object({ pid: z.coerce.number().int().positive(), qty: decimal }))
            .min(1, 'Add at least one material'),
        })
        .parse(req.body);

      return service.consumeMaterials(req.principal, { labReceivedId: id, ...body });
    },
  });

  app.post('/jobs/:id/ready', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      await service.markReady(req.principal, id);
      return { id, status: 'READY' };
    },
  });

  // ---- invoices ---------------------------------------------------------
  app.get('/invoices', {
    preHandler: app.requireAction(INVOICES.formId, INVOICES.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('lab').leftJoin('customer', 'customer.id', 'lab.cust_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('lab.branch_id', '=', req.principal.branchId);
      }

      const [rows, count] = await Promise.all([
        base
          .select([
            'lab.id',
            'lab.doc_number',
            'lab.date',
            'lab.lab_id',
            'lab.gross',
            'lab.received',
            'lab.remaining',
            'customer.name as customer_name',
          ])
          .orderBy('lab.date', 'desc')
          .orderBy('lab.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/invoices', {
    preHandler: app.requireAction(INVOICES.formId, INVOICES.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          labReceivedId: z.coerce.number().int().positive(),
          date: dateString,
          received: decimal.default('0'),
          /** The work actually done — required, per SPECS §9. */
          description: z.string().trim().min(1, 'Describe the work done').max(2000),
          lines: z
            .array(
              z.object({
                pname: z.string().trim().min(1).max(200),
                qty: decimal,
                price: decimal,
              }),
            )
            .optional(),
        })
        .parse(req.body);

      return reply.status(201).send(await service.createLabInvoice(req.principal, body));
    },
  });

  // ---- repair job types and branch repair prices --------------------------

  app.get('/repair-types', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.view),
    handler: async () => {
      return db
        .selectFrom('repair_type')
        .select(['id', 'name', 'is_active'])
        .orderBy('name')
        .execute();
    },
  });

  app.post('/repair-types', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.create),
    handler: async (req, reply) => {
      if (!req.principal.isSuperAdmin) {
        throw forbidden('Only the super admin can add a repair job type');
      }
      const body = z.object({ name: z.string().trim().min(1).max(150) }).parse(req.body);
      const created = await db
        .insertInto('repair_type')
        .values({ name: body.name, created_by: req.principal.empId, updated_by: req.principal.empId })
        .returningAll()
        .executeTakeFirstOrThrow();
      return reply.status(201).send(created);
    },
  });

  /** The branch's own repair prices, joined to the central job types. */
  app.get('/repair-prices', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.view),
    handler: async (req) => {
      let q = db
        .selectFrom('branch_repair_price')
        .innerJoin('repair_type', 'repair_type.id', 'branch_repair_price.repair_type_id')
        .innerJoin('branch', 'branch.id', 'branch_repair_price.branch_id')
        .select([
          'branch_repair_price.id',
          'branch_repair_price.price',
          'branch_repair_price.minimum_price',
          'branch_repair_price.branch_id',
          'repair_type.name as repair_type_name',
          'branch.name as branch_name',
        ]);

      if (!req.principal.isSuperAdmin) {
        q = q.where('branch_repair_price.branch_id', '=', req.principal.branchId);
      }

      return q.orderBy('repair_type.name').execute();
    },
  });

  app.put('/repair-prices/:id', {
    preHandler: app.requireAction(RECEIVING.formId, RECEIVING.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          price: decimal,
          minimumPrice: decimal.default('0'),
          isActive: z.boolean().optional(),
        })
        .parse(req.body);

      const existing = await db
        .selectFrom('branch_repair_price')
        .select(['id', 'branch_id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!existing) throw notFound('Repair price');
      if (!req.principal.isSuperAdmin && existing.branch_id !== req.principal.branchId) {
        throw notFound('Repair price');
      }

      return db
        .updateTable('branch_repair_price')
        .set({
          price: body.price,
          minimum_price: body.minimumPrice,
          ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
          updated_at: new Date(),
          updated_by: req.principal.empId,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  });
}
