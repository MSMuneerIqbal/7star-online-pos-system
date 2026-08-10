/**
 * Chart of accounts routes.
 *
 * Legacy forms: 23 First Level (701), 24 Second Level (702), 25 Final (703).
 * All three live under one prefix because they are one hierarchy.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formPermissions } from '../../core/crud.js';
import { branchFilter, resolveBranchId } from '../../core/rbac.js';
import * as service from './service.js';

const HEAD = formPermissions(23, 701);
const SUB_HEAD = formPermissions(24, 702);
const ACCOUNT = formPermissions(25, 703);

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  // ---- level 1: heads ---------------------------------------------------
  app.get('/heads', {
    preHandler: app.requireAction(HEAD.formId, HEAD.view),
    handler: async () => service.listHeads(),
  });

  // No POST /heads.
  //
  // The five heads — Assets, Liabilities, Equity, Revenue, Expenses — are the
  // standard classifications every set of books uses, and they are seeded by
  // migration. Adding a sixth is almost always a modelling mistake that belongs
  // at the sub-head or account level instead. Reintroduce this only if the
  // organisation genuinely needs a classification outside the five.

  // ---- level 2: sub-heads -----------------------------------------------
  app.get('/sub-heads', {
    preHandler: app.requireAction(SUB_HEAD.formId, SUB_HEAD.view),
    handler: async (req) => {
      const { headId } = z
        .object({ headId: z.coerce.number().int().positive().optional() })
        .parse(req.query);

      return service.listSubHeads(headId);
    },
  });

  // No POST /sub-heads.
  //
  // Sub-heads shape the financial statements — the split between Cost of Sales
  // and Operating Expenses is what makes gross margin meaningful — so they are
  // a deliberate design decision, not something to add mid-flow. The nine
  // shipped sub-heads come from migration 1700000000006; changing them is a
  // migration, so the change is reviewed and reversible.

  // ---- level 3: accounts ------------------------------------------------
  app.get('/', {
    preHandler: app.requireAction(ACCOUNT.formId, ACCOUNT.view),
    handler: async (req) => {
      const q = z
        .object({
          headId: z.coerce.number().int().positive().optional(),
          subHeadId: z.coerce.number().int().positive().optional(),
          search: z.string().trim().max(200).optional(),
        })
        .parse(req.query);

      return service.listAccounts({
        headId: q.headId,
        subHeadId: q.subHeadId,
        search: q.search,
        branchId: branchFilter(req.principal),
      });
    },
  });

  app.post('/', {
    preHandler: app.requireAction(ACCOUNT.formId, ACCOUNT.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          subHeadId: z.coerce.number().int().positive(),
          thirdCode: z.coerce.number().int().min(1).max(99).optional(),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const result = await service.createAccount(req.principal, {
        name: body.name,
        subHeadId: body.subHeadId,
        ...(body.thirdCode !== undefined ? { thirdCode: body.thirdCode } : {}),
        branchId: resolveBranchId(req.principal, body.branchId),
      });

      return reply.status(201).send(result);
    },
  });

  /**
   * Only the label may change. Account CODES are referenced by the posting
   * rules and by every historical ledger row, so renumbering is not offered.
   */
  app.put('/:id', {
    preHandler: app.requireAction(ACCOUNT.formId, ACCOUNT.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const { name } = z
        .object({ name: z.string().trim().min(1, 'Name is required').max(150) })
        .parse(req.body);

      return service.renameAccount(req.principal, id, name);
    },
  });
}
