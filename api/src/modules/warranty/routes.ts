/**
 * Warranty routes — the branch replaces first and claims after (form 57 / 512).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import * as service from './service.js';

const PERM = formPermissions(57, 512);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);

export default async function warrantyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/claims', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('warranty_claim')
        .leftJoin('branch', 'branch.id', 'warranty_claim.branch_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('warranty_claim.branch_id', '=', req.principal.branchId);
      }

      const [rows, count] = await Promise.all([
        base
          .select(['warranty_claim.id', 'warranty_claim.doc_number', 'warranty_claim.date', 'warranty_claim.status', 'branch.name as branch_name'])
          .orderBy('warranty_claim.date', 'desc')
          .orderBy('warranty_claim.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/claims/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const claim = await db.selectFrom('warranty_claim').selectAll().where('id', '=', id).executeTakeFirst();
      if (!claim) throw notFound('Warranty claim');

      const lines = await db.selectFrom('warranty_claim_detail').selectAll().where('claim_id', '=', id).orderBy('id').execute();
      return { ...claim, lines };
    },
  });

  app.post('/claims', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          branchId: z.coerce.number().int().positive(),
          note: z.string().max(1000).nullish(),
          lines: z
            .array(z.object({ productId: z.coerce.number().int().positive(), qty: decimal }))
            .min(1, 'Add at least one unit'),
        })
        .parse(req.body);

      return reply.status(201).send(await service.createClaim(req.principal, body));
    },
  });

  app.post('/claims/:id/resolve', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          warehouseBranchId: z.coerce.number().int().positive(),
          lines: z
            .array(
              z.object({
                productId: z.coerce.number().int().positive(),
                qty: decimal,
                assessment: z.enum(['REPAIRABLE', 'NOT_REPAIRABLE']),
                parts: z.array(z.object({ pid: z.coerce.number().int().positive(), qty: decimal })).optional(),
              }),
            )
            .min(1, 'Assess at least one unit'),
        })
        .parse(req.body);

      return service.resolveClaim(req.principal, { ...body, claimId: id });
    },
  });

  /** Record a faulty unit into warranty hold (the branch takes it from the customer). */
  app.post('/holds', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          branchId: z.coerce.number().int().positive(),
          productId: z.coerce.number().int().positive(),
          qty: decimal,
          note: z.string().max(500).nullish(),
        })
        .parse(req.body);

      const created = await db
        .insertInto('warranty_hold')
        .values({
          branch_id: body.branchId,
          product_id: body.productId,
          qty: body.qty,
          date: body.date,
          note: body.note ?? null,
          status: 'HELD',
          created_by: req.principal.empId,
          updated_by: req.principal.empId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return reply.status(201).send(created);
    },
  });
}
