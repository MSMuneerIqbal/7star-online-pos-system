/**
 * Remittance routes — a branch sends money to the warehouse (Phase 6).
 * Form 55 / code 511, under the Demand Order head.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import * as service from './service.js';

const PERM = formPermissions(55, 511);

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function remittanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('remittance')
        .leftJoin('branch as fb', 'fb.id', 'remittance.from_branch')
        .leftJoin('branch as tb', 'tb.id', 'remittance.to_branch');

      if (!req.principal.isSuperAdmin) {
        base = base.where('remittance.from_branch', '=', req.principal.branchId);
      }

      const [rows, count] = await Promise.all([
        base
          .select([
            'remittance.id',
            'remittance.doc_number',
            'remittance.date',
            'remittance.amount',
            'remittance.method',
            'remittance.status',
            'remittance.note',
            'fb.name as from_name',
            'tb.name as to_name',
          ])
          .orderBy('remittance.date', 'desc')
          .orderBy('remittance.id', 'desc')
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
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
          amount: z.union([z.string(), z.number()]).transform(String),
          method: z.enum(['CASH', 'BANK']).default('CASH'),
          note: z.string().max(1000).nullish(),
          fromBranchId: z.coerce.number().int().positive().optional(),
          toBranchId: z.coerce.number().int().positive().optional(),
        })
        .parse(req.body);

      return reply.status(201).send(await service.createRemittance(req.principal, body));
    },
  });

  app.post('/:id/confirm', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return service.confirmRemittance(req.principal, id);
    },
  });

  /** The branch dues report (SPECS §7). */
  app.get('/dues', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => service.branchDues(),
  });
}
