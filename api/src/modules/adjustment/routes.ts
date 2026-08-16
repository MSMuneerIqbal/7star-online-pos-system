/**
 * Stock adjustment routes — the super-admin "increase / decrease" screen.
 * Form 59 / code 1002, under head 10 (Production).
 *
 * It used to claim form 58 / code 513, which is E-Store's — one permission
 * behind two unrelated screens. See migration 1700000000030.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import { formPermissions } from '../../core/crud.js';
import * as service from './service.js';

const PERM = formPermissions(59, 1002);

const decimalString = z.union([z.string(), z.number()]).transform(String);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export default async function adjustmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/form-data', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => {
      const [branches, products, rawProducts] = await Promise.all([
        db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0).orderBy('name').execute(),
        db.selectFrom('product').select(['id', 'name']).where('is_active', '=', true).orderBy('name').execute(),
        db.selectFrom('raw_product').select(['id', 'name']).where('is_active', '=', true).orderBy('name').execute(),
      ]);
      return { branches, products, rawProducts };
    },
  });

  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = z
        .object({
          kind: z.enum(['RAW', 'FINISH']).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);

      return service.listAdjustments(req.principal, q);
    },
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          kind: z.enum(['RAW', 'FINISH']),
          branchId: z.coerce.number().int().positive(),
          reason: z.string().trim().min(1, 'A reason is required').max(500),
          note: z.string().max(1000).nullish(),
          lines: z
            .array(
              z.object({
                pid: z.coerce.number().int().positive(),
                qty: decimalString.refine((v) => Number(v) !== 0, 'Quantity cannot be zero'),
              }),
            )
            .min(1, 'Add at least one line'),
        })
        .parse(req.body);

      const result = await service.createAdjustment(req.principal, body);
      return reply.status(201).send(result);
    },
  });

  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);

      const adj = await db
        .selectFrom('stock_adjustment')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!adj) throw notFound('Stock adjustment');

      const lines = await db
        .selectFrom('stock_adjustment_detail')
        .selectAll()
        .where('adj_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...adj, lines };
    },
  });

  app.post('/:id/reverse', {
    preHandler: app.requireAction(PERM.formId, PERM.remove),
    handler: async (req) => {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
      return service.reverseAdjustment(req.principal, id);
    },
  });
}
