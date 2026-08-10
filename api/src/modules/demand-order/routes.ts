/**
 * Demand order routes — one router for both stock kinds.
 *
 * The kind is a path segment (`/demand-orders/raw/...`, `/demand-orders/finish/...`)
 * and permissions resolve per kind and stage from DO_FORMS, so each of the ten
 * legacy screens keeps its own form/action codes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { badRequest, notFound } from '../../core/errors.js';
import { ACTION, actionCode, listQuery, offset, paged } from '../../core/crud.js';
import type { StockKind } from '../../accounting/rules/transfer.js';
import * as service from './service.js';
import { DO_FORMS, type Stage } from './service.js';

const kindParam = z.object({ kind: z.enum(['raw', 'finish']) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

const toKind = (k: 'raw' | 'finish'): StockKind => (k === 'raw' ? 'RAW' : 'FINISH');

const lineSchema = z.object({
  pid: z.coerce.number().int().positive(),
  qty: z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((v) => Number(v) > 0, 'Quantity must be greater than zero'),
});

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export default async function demandOrderRoutes(app: FastifyInstance): Promise<void> {
  /** Permission guard for a given stage, resolving the kind from the URL. */
  const guard =
    (stage: Stage, seq: number) => async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = kindParam.safeParse(req.params);
      if (!parsed.success) throw badRequest('Unknown stock kind');

      const form = DO_FORMS[stage][toKind(parsed.data.kind)];
      await app.requireAction(form.formId, actionCode(form.formCode, seq))(req, reply);
    };

  // ---- shared form data -------------------------------------------------
  app.get('/:kind/form-data', {
    preHandler: guard('ORDER', ACTION.VIEW),
    handler: async (req) => {
      const { kind } = kindParam.parse(req.params);
      const stockKind = toKind(kind);

      const products =
        stockKind === 'RAW'
          ? await db
              .selectFrom('raw_product')
              .select(['id', 'name', 'price as sale_price'])
              .where('is_active', '=', true)
              .orderBy('name')
              .execute()
          : await db
              .selectFrom('product')
              .select(['id', 'name', 'price as sale_price'])
              .where('is_active', '=', true)
              .orderBy('name')
              .execute();

      const branches = await db
        .selectFrom('branch')
        .select(['id', 'name'])
        .where('id', '>', 0)
        .orderBy('name')
        .execute();

      return { products, branches, kind: stockKind };
    },
  });

  // ---- stage 1: orders --------------------------------------------------
  app.get('/:kind/orders', {
    preHandler: guard('ORDER', ACTION.VIEW),
    handler: async (req) => {
      const { kind } = kindParam.parse(req.params);
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('demand_order').where('type', '=', toKind(kind));

      if (!req.principal.isSuperAdmin) {
        const b = req.principal.branchId;
        base = base.where((eb) => eb.or([eb('from_branch', '=', b), eb('to_branch', '=', b)]));
      }

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'date', 'from_branch', 'to_branch', 'status', 'gross', 'note'])
          .orderBy('date', 'desc')
          .orderBy('id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/:kind/orders', {
    preHandler: guard('ORDER', ACTION.NEW),
    handler: async (req, reply) => {
      const { kind } = kindParam.parse(req.params);
      const body = z
        .object({
          date: dateString,
          fromBranchId: z.coerce.number().int().positive(),
          toBranchId: z.coerce.number().int().positive(),
          note: z.string().max(1000).nullish(),
          lines: z.array(lineSchema).min(1, 'Add at least one item'),
        })
        .parse(req.body);

      const result = await service.createOrder(req.principal, { ...body, kind: toKind(kind) });
      return reply.status(201).send(result);
    },
  });

  // ---- stage 2: requests ------------------------------------------------
  app.get('/:kind/requests', {
    preHandler: guard('REQUEST', ACTION.VIEW),
    handler: async (req) => {
      const { kind } = kindParam.parse(req.params);
      const q = listQuery.parse(req.query);
      const { status } = z.object({ status: z.string().optional() }).parse(req.query);

      let base = db.selectFrom('do_request').where('type', '=', toKind(kind));

      if (!req.principal.isSuperAdmin) {
        const b = req.principal.branchId;
        base = base.where((eb) => eb.or([eb('from_branch', '=', b), eb('to_branch', '=', b)]));
      }

      if (status) base = base.where('status', '=', status);

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'do_id', 'date', 'from_branch', 'to_branch', 'status', 'gross', 'note'])
          .orderBy('date', 'desc')
          .orderBy('id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/:kind/requests', {
    preHandler: guard('REQUEST', ACTION.NEW),
    handler: async (req, reply) => {
      const { kind } = kindParam.parse(req.params);
      const body = z
        .object({
          date: dateString,
          doId: z.coerce.number().int().positive().nullish(),
          fromBranchId: z.coerce.number().int().positive(),
          toBranchId: z.coerce.number().int().positive(),
          note: z.string().max(1000).nullish(),
          lines: z.array(lineSchema).min(1, 'Add at least one item'),
        })
        .parse(req.body);

      const result = await service.createRequest(req.principal, { ...body, kind: toKind(kind) });
      return reply.status(201).send(result);
    },
  });

  app.get('/:kind/requests/:id', {
    preHandler: guard('REQUEST', ACTION.VIEW),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const request = await db
        .selectFrom('do_request')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!request) throw notFound('Transfer request');

      const lines = await db
        .selectFrom('do_request_detail')
        .selectAll()
        .where('inv_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...request, lines };
    },
  });

  /** Stage 3 — despatch. First ledger impact. */
  app.post('/:kind/requests/:id/despatch', {
    preHandler: guard('REQUEST', ACTION.EDIT),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return service.despatchRequest(req.principal, id);
    },
  });

  // ---- stage 4: receipts ------------------------------------------------
  app.get('/:kind/received', {
    preHandler: guard('RECEIVE', ACTION.VIEW),
    handler: async (req) => {
      const { kind } = kindParam.parse(req.params);
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('do_received').where('type', '=', toKind(kind));

      if (!req.principal.isSuperAdmin) {
        base = base.where('to_branch', '=', req.principal.branchId);
      }

      const [rows, count] = await Promise.all([
        base
          .select([
            'id',
            'do_req_id',
            'date',
            'from_branch',
            'to_branch',
            'gross',
            'cargo_expense',
            'net',
            'received_by',
          ])
          .orderBy('date', 'desc')
          .orderBy('id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/:kind/received', {
    preHandler: guard('RECEIVE', ACTION.NEW),
    handler: async (req, reply) => {
      const body = z
        .object({
          date: dateString,
          requestId: z.coerce.number().int().positive(),
          freight: z.union([z.string(), z.number()]).transform(String).default('0'),
          freightPaidInCash: z.boolean().default(true),
          note: z.string().max(1000).nullish(),
          receivedBy: z.string().max(150).nullish(),
          lines: z.array(lineSchema).optional(),
        })
        .parse(req.body);

      const result = await service.receiveTransfer(req.principal, body);
      return reply.status(201).send(result);
    },
  });

  app.post('/:kind/received/:id/reverse', {
    preHandler: guard('RECEIVE', ACTION.DELETE),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      return service.reverseReceipt(req.principal, id);
    },
  });
}
