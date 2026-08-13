/**
 * Production routes. Legacy form id 47, form code 1001.
 *
 * Reshaped in Phase 4: issue a cart of raw parts to a worker, record the output
 * (ready batteries + damage), and read the worker's piece count. Production is
 * a warehouse function — no branch sees another's, and only the super admin or
 * a warehouse-granted role drives it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import * as service from './service.js';

const PERM = formPermissions(47, 1001);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const decimal = z.union([z.string(), z.number()]).transform(String);

const workerBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  phone: z.string().trim().max(50).nullish(),
  isActive: z.boolean().default(true),
});

export default async function productionRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------

  app.get('/workers', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('worker');
      const term = likeTerm(q.search);
      if (term) base = base.where('name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'name', 'phone', 'is_active'])
          .orderBy('name')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/workers', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = workerBody.parse(req.body);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('worker')
          .values({
            name: body.name,
            phone: body.phone ?? null,
            is_active: body.isActive,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          { form: 'Production', action: 'New', detail: `Created worker: ${created.name}`, invId: created.id },
          tx,
        );
        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.put('/workers/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = workerBody.parse(req.body);

      const existing = await db.selectFrom('worker').select('id').where('id', '=', id).executeTakeFirst();
      if (!existing) throw notFound('Worker');

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('worker')
          .set({
            name: body.name,
            phone: body.phone ?? null,
            is_active: body.isActive,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          { form: 'Production', action: 'Edit', detail: `Updated worker: ${row.name}`, invId: id },
          tx,
        );
        return row;
      });
    },
  });

  // -------------------------------------------------------------------------
  // Shared form data
  // -------------------------------------------------------------------------

  app.get('/form-data', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => {
      const [workers, rawMaterials, products] = await Promise.all([
        db.selectFrom('worker').select(['id', 'name']).where('is_active', '=', true).orderBy('name').execute(),
        db
          .selectFrom('raw_product')
          .select(['id', 'name', 'price'])
          .where('is_active', '=', true)
          .orderBy('name')
          .execute(),
        db.selectFrom('product').select(['id', 'name']).where('is_active', '=', true).orderBy('name').execute(),
      ]);

      return { workers, rawMaterials, products };
    },
  });

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  app.get('/issues', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const { status } = z.object({ status: z.string().optional() }).parse(req.query);

      let base = db.selectFrom('production_issue').leftJoin('worker', 'worker.id', 'production_issue.worker_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('production_issue.branch_id', '=', req.principal.branchId);
      }
      if (status) base = base.where('production_issue.status', '=', status);

      const term = likeTerm(q.search);
      if (term) base = base.where('worker.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'production_issue.id',
            'production_issue.doc_number',
            'production_issue.date',
            'production_issue.status',
            'production_issue.note',
            'worker.name as worker_name',
          ])
          .orderBy('production_issue.date', 'desc')
          .orderBy('production_issue.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/issues/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const issue = await db
        .selectFrom('production_issue')
        .leftJoin('worker', 'worker.id', 'production_issue.worker_id')
        .select([
          'production_issue.id',
          'production_issue.doc_number',
          'production_issue.date',
          'production_issue.status',
          'production_issue.note',
          'worker.name as worker_name',
        ])
        .where('production_issue.id', '=', id)
        .executeTakeFirst();

      if (!issue) throw notFound('Production issue');

      const lines = await db
        .selectFrom('production_issue_detail')
        .selectAll()
        .where('issue_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...issue, lines };
    },
  });

  app.post('/issues', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          workerId: z.coerce.number().int().positive(),
          branchId: z.coerce.number().int().optional(),
          note: z.string().max(1000).nullish(),
          lines: z
            .array(
              z.object({
                pid: z.coerce.number().int().positive(),
                qty: decimal,
              }),
            )
            .min(1, 'Add at least one part'),
        })
        .parse(req.body);

      return reply.status(201).send(await service.createIssue(req.principal, body));
    },
  });

  app.post('/issues/:id/output', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          date: dateString,
          productId: z.coerce.number().int().positive(),
          qty: decimal,
          damaged: z
            .array(
              z.object({
                pid: z.coerce.number().int().positive(),
                qty: decimal,
                reason: z.string().max(500).nullish(),
              }),
            )
            .optional(),
        })
        .parse(req.body);

      return service.recordOutput(req.principal, { ...body, issueId: id });
    },
  });

  // -------------------------------------------------------------------------
  // Damaged batteries and rework
  // -------------------------------------------------------------------------

  app.get('/damaged-stock', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('damaged_stock')
        .leftJoin('worker', 'worker.id', 'damaged_stock.worker_id')
        .leftJoin('product', 'product.id', 'damaged_stock.product_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('damaged_stock.branch_id', '=', req.principal.branchId);
      }

      const [rows, count] = await Promise.all([
        base
          .select([
            'damaged_stock.id',
            'damaged_stock.date',
            'damaged_stock.kind',
            'damaged_stock.pname',
            'damaged_stock.qty',
            'damaged_stock.value',
            'damaged_stock.reason',
            'damaged_stock.status',
            'worker.name as worker_name',
          ])
          .orderBy('damaged_stock.date', 'desc')
          .orderBy('damaged_stock.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/damaged-batteries', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          productId: z.coerce.number().int().positive(),
          qty: decimal,
          workerId: z.coerce.number().int().positive().nullish(),
          reason: z.string().max(500).nullish(),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      return reply.status(201).send(await service.damageBattery(req.principal, body));
    },
  });

  app.get('/rework', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('rework')
        .leftJoin('worker', 'worker.id', 'rework.worker_id')
        .leftJoin('product', 'product.id', 'rework.product_id');

      const [rows, count] = await Promise.all([
        base
          .select([
            'rework.id',
            'rework.date',
            'rework.qty',
            'rework.note',
            'rework.status',
            'worker.name as worker_name',
            'product.name as product_name',
          ])
          .orderBy('rework.date', 'desc')
          .orderBy('rework.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/rework', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          productId: z.coerce.number().int().positive(),
          workerId: z.coerce.number().int().positive(),
          qty: decimal,
          note: z.string().max(1000).nullish(),
        })
        .parse(req.body);

      return reply.status(201).send(await service.reworkBattery(req.principal, body));
    },
  });

  // -------------------------------------------------------------------------
  // Worker report — pieces and damage side by side
  // -------------------------------------------------------------------------

  app.get('/worker-report', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => {
      const workers = await db
        .selectFrom('worker')
        .select(['id', 'name', 'is_active'])
        .orderBy('name')
        .execute();

      const [pieces, damage] = await Promise.all([
        db
          .selectFrom('production_output')
          .select(['worker_id', (qb) => qb.fn.sum<string>('qty').as('pieces')])
          .groupBy('worker_id')
          .execute(),
        db
          .selectFrom('damaged_stock')
          .select(['worker_id', (qb) => qb.fn.sum<string>('qty').as('qty'), (qb) => qb.fn.sum<string>('value').as('value')])
          .where('worker_id', 'is not', null)
          .groupBy('worker_id')
          .execute(),
      ]);

      const piecesByWorker = new Map(pieces.map((p) => [p.worker_id, p.pieces ?? '0']));
      const damageByWorker = new Map(damage.map((d) => [d.worker_id!, { qty: d.qty ?? '0', value: d.value ?? '0.00' }]));

      return workers.map((w) => ({
        id: w.id,
        name: w.name,
        active: w.is_active,
        pieces: piecesByWorker.get(w.id) ?? '0',
        damagedQty: damageByWorker.get(w.id)?.qty ?? '0',
        damagedValue: damageByWorker.get(w.id)?.value ?? '0.00',
      }));
    },
  });
}
