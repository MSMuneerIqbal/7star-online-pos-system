/**
 * E-Store routes — the website's orders, shipped by a branch (form 58 / 513).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import * as service from './service.js';

const PERM = formPermissions(58, 513);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);

export default async function estoreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('estore_shipment')
        .leftJoin('branch', 'branch.id', 'estore_shipment.branch_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('estore_shipment.branch_id', '=', req.principal.branchId);
      }

      const term = likeTerm(q.search);
      if (term) base = base.where('estore_shipment.order_reference', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'estore_shipment.id',
            'estore_shipment.doc_number',
            'estore_shipment.order_reference',
            'estore_shipment.date',
            'estore_shipment.status',
            'estore_shipment.customer_name',
            'branch.name as branch_name',
          ])
          .orderBy('estore_shipment.date', 'desc')
          .orderBy('estore_shipment.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          orderReference: z.string().trim().min(1, 'Order reference is required').max(100),
          branchId: z.coerce.number().int().positive(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          customerName: z.string().max(150).nullish(),
          shippingAddress: z.string().max(500).nullish(),
          note: z.string().max(1000).nullish(),
          lines: z.array(z.object({ productId: z.coerce.number().int().positive(), qty: decimal })).min(1, 'Add at least one line'),
        })
        .parse(req.body);

      return reply.status(201).send(await service.recordShipment(req.principal, body));
    },
  });

  app.post('/:id/accept', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return service.acceptShipment(req.principal, id);
    },
  });

  app.post('/:id/reject', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
      return service.rejectShipment(req.principal, id, reason);
    },
  });
}
