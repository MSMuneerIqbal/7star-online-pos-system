/**
 * Ledger and trial balance routes.
 *
 * Legacy form 26 Account Ledger (704). Trial Balance is form 28 (706) — one of
 * the ten controllers the legacy system linked but never built.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { formPermissions } from '../../core/crud.js';
import { saveOpeningBalance } from '../voucher/service.js';
import * as service from './service.js';

const LEDGER = formPermissions(26, 704);
const TRIAL_BALANCE = formPermissions(28, 706);
const OPENING = formPermissions(25, 703);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export default async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', {
    preHandler: app.requireAction(LEDGER.formId, LEDGER.view),
    handler: async (req) => {
      const isSuper = req.principal.isSuperAdmin;

      let q = db
        .selectFrom('account')
        .select(['account_id', 'name', 'head_id'])
        .orderBy('head_code')
        .orderBy('sub_code')
        .orderBy('third_code')
        .orderBy('name');

      if (!isSuper) {
        const branchId = req.principal.branchId;
        q = q.where((eb) =>
          eb.or([eb('is_fixed', '=', true), eb('branch_id', '=', branchId)]),
        );
      }

      return q.execute();
    },
  });

  app.get('/', {
    preHandler: app.requireAction(LEDGER.formId, LEDGER.view),
    handler: async (req) => {
      const q = z
        .object({
          accountId: z.coerce.number().int().positive(),
          from: dateString,
          to: dateString,
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.query);

      return service.getLedger(req.principal, {
        accountId: q.accountId,
        from: q.from,
        to: q.to,
        branchId: q.branchId,
      });
    },
  });

  app.get('/trial-balance', {
    preHandler: app.requireAction(TRIAL_BALANCE.formId, TRIAL_BALANCE.view),
    handler: async (req) => {
      const q = z
        .object({ asAt: dateString, branchId: z.coerce.number().int().optional() })
        .parse(req.query);

      return service.getTrialBalance(req.principal, {
        asAt: q.asAt,
        branchId: q.branchId,
      });
    },
  });

  app.post('/opening', {
    preHandler: app.requireAction(OPENING.formId, OPENING.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          accountId: z.coerce.number().int().positive(),
          date: dateString,
          dr: z.union([z.string(), z.number()]).transform(String).default('0'),
          cr: z.union([z.string(), z.number()]).transform(String).default('0'),
          detail: z.string().max(500).nullish(),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      return reply.status(201).send(await saveOpeningBalance(req.principal, body));
    },
  });
}
