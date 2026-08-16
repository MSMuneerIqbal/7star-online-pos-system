/**
 * Opening balances routes (Phase 13). The figures are the owner's — these are
 * the screens. Opening stock posts Dr inventory / Cr owner capital plus a stock
 * movement; every other figure posts against the owner capital.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { formPermissions } from '../../core/crud.js';
import * as service from './service.js';

// Form 60 / code 714. It used to share form 25 / 703 with Account Registration,
// so creating a ledger account and setting the company's whole starting position
// were one grant (migration 1700000000031) — and the first attempt at a fix
// landed on 709, which is Cash Receipt's (migration 1700000000032).
const PERM = formPermissions(60, 714);
const decimal = z.union([z.string(), z.number()]).transform(String);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default async function openingRoutes(app: FastifyInstance): Promise<void> {
  /** List the opening balances already entered, for the screen. */
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async () => {
      const [stock, openings] = await Promise.all([
        db
          .selectFrom('opening_stock')
          .leftJoin('product', 'product.id', 'opening_stock.pid')
          .leftJoin('raw_product', 'raw_product.id', 'opening_stock.pid')
          .select([
            'opening_stock.id',
            'opening_stock.branch_id',
            'opening_stock.kind',
            'opening_stock.pid',
            'opening_stock.qty',
            'opening_stock.cost',
            'opening_stock.date',
            'product.name as product_name',
            'raw_product.name as raw_name',
          ])
          .orderBy('opening_stock.date', 'desc')
          .execute(),
        db.selectFrom('account_opening').selectAll().orderBy('date', 'desc').execute(),
      ]);

      return { stock, openings };
    },
  });

  app.post('/stock', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          branchId: z.coerce.number().int().positive(),
          kind: z.enum(['RAW', 'FINISH']),
          pid: z.coerce.number().int().positive(),
          qty: decimal,
          cost: decimal,
        })
        .parse(req.body);

      return reply.status(201).send(await service.recordOpeningStock(req.principal, body));
    },
  });

  app.post('/balance', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          branchId: z.coerce.number().int().positive(),
          accountId: z.coerce.number().int().positive(),
          amount: decimal,
          debit: z.boolean().default(true),
          detail: z.string().max(500).nullish(),
        })
        .parse(req.body);

      return reply.status(201).send(await service.recordOpeningBalance(req.principal, body));
    },
  });
}
