/**
 * Lab routes. Legacy forms: 49 Lab Receiving (510), 50 Lab Invoices (520).
 *
 * Lab Invoices was a stub in the legacy system — see the design note at the top
 * of service.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
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

      let customers = db
        .selectFrom('customer')
        .select(['id', 'name', 'phone'])
        .where('is_active', '=', true);

      if (!isSuper) customers = customers.where('branch_id', '=', req.principal.branchId);

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', req.principal.branchId);

      const [customerRows, rawRows, branchRows] = await Promise.all([
        customers.orderBy('name').execute(),
        db
          .selectFrom('raw_product')
          .select(['id', 'name', 'price'])
          .where('is_active', '=', true)
          .orderBy('name')
          .execute(),
        branches.orderBy('name').execute(),
      ]);

      return { customers: customerRows, rawMaterials: rawRows, branches: branchRows };
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
}
