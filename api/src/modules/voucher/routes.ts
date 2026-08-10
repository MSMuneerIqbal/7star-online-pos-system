/**
 * Voucher routes — one module serving CRV, CPV, BRV, BPV and JV.
 *
 * The voucher type is a path segment, and permissions resolve per type from
 * VOUCHER_TYPES, so each keeps its own legacy form/action codes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../core/db/index.js';
import { badRequest, notFound } from '../../core/errors.js';
import { actionCode, ACTION, listQuery, offset, paged } from '../../core/crud.js';
import { COUNTER_ACCOUNT } from '../../accounting/rules/voucher.js';
import * as service from './service.js';
import { VOUCHER_TYPES, type VoucherType } from './service.js';

const decimalString = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number`);

const typeParam = z.object({
  type: z.enum(['CRV', 'CPV', 'BRV', 'BPV', 'JV']),
});

const voucherBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  branchId: z.coerce.number().int().optional(),
  narration: z.string().max(1000).nullish(),
  lines: z
    .array(
      z.object({
        accountId: z.coerce.number().int().positive(),
        dr: decimalString('Debit').default('0'),
        cr: decimalString('Credit').default('0'),
        detail: z.string().max(500).nullish(),
        chequeNo: z.string().max(50).nullish(),
        chequeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
    )
    .min(2, 'A voucher needs at least two lines'),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function voucherRoutes(app: FastifyInstance): Promise<void> {
  /** Resolve the permission codes for the voucher type in the URL. */
  const permsFor = (type: VoucherType, seq: number) => {
    const meta = VOUCHER_TYPES[type];
    return { formId: meta.formId, action: actionCode(meta.formCode, seq) };
  };

  const guard =
    (seq: number) =>
    async (req: Parameters<typeof app.authenticate>[0], reply: Parameters<typeof app.authenticate>[1]) => {
      const parsed = typeParam.safeParse(req.params);
      if (!parsed.success) throw badRequest('Unknown voucher type');

      const { formId, action } = permsFor(parsed.data.type, seq);
      await app.requireAction(formId, action)(req, reply);
    };

  app.get('/:type', {
    preHandler: guard(ACTION.VIEW),
    handler: async (req) => {
      const { type } = typeParam.parse(req.params);
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('voucher_master').where('type', '=', type);

      if (!req.principal.isSuperAdmin) {
        base = base.where('branch_id', '=', req.principal.branchId);
      } else if (q.branchId !== undefined) {
        base = base.where('branch_id', '=', q.branchId);
      }

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'date', 'vno', 'amount', 'detail', 'tran_id', 'branch_id'])
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

  app.get('/:type/form-data', {
    preHandler: guard(ACTION.VIEW),
    handler: async (req) => {
      const { type } = typeParam.parse(req.params);
      const isSuper = req.principal.isSuperAdmin;

      let accounts = db
        .selectFrom('account')
        .select(['account_id', 'name', 'head_id', 'is_fixed', 'branch_id']);

      if (!isSuper) {
        const branchId = req.principal.branchId;
        accounts = accounts.where((eb) =>
          eb.or([eb('is_fixed', '=', true), eb('branch_id', '=', branchId)]),
        );
      }

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', req.principal.branchId);

      const [accountRows, branchRows] = await Promise.all([
        accounts.orderBy('account_id').execute(),
        branches.orderBy('name').execute(),
      ]);

      return {
        accounts: accountRows,
        branches: branchRows,
        // The side this voucher type posts against; null for a journal voucher.
        counterAccount: COUNTER_ACCOUNT[type],
        label: VOUCHER_TYPES[type].label,
        requiresCheque: type === 'BRV' || type === 'BPV',
      };
    },
  });

  app.get('/:type/:id', {
    preHandler: guard(ACTION.VIEW),
    handler: async (req) => {
      const { type } = typeParam.parse(req.params);
      const { id } = idParam.parse(req.params);

      const master = await db
        .selectFrom('voucher_master')
        .selectAll()
        .where('id', '=', id)
        .where('type', '=', type)
        .executeTakeFirst();

      if (!master) throw notFound('Voucher');

      if (!req.principal.isSuperAdmin && master.branch_id !== req.principal.branchId) {
        throw notFound('Voucher');
      }

      const lines = await db
        .selectFrom('voucher_detail')
        .leftJoin('account', 'account.account_id', 'voucher_detail.account_id')
        .select([
          'voucher_detail.id',
          'voucher_detail.account_id',
          'voucher_detail.dr',
          'voucher_detail.cr',
          'voucher_detail.detail',
          'voucher_detail.cheque_no',
          'voucher_detail.cheque_date',
          'voucher_detail.cheque_status',
          'account.name as account_name',
        ])
        .where('voucher_detail.inv_id', '=', id)
        .orderBy('voucher_detail.id')
        .execute();

      return { ...master, lines };
    },
  });

  app.post('/:type', {
    preHandler: guard(ACTION.NEW),
    handler: async (req, reply) => {
      const { type } = typeParam.parse(req.params);
      const body = voucherBody.parse(req.body);

      const result = await service.createVoucher(req.principal, { type, ...body });
      return reply.status(201).send(result);
    },
  });

  app.put('/:type/:id', {
    preHandler: guard(ACTION.EDIT),
    handler: async (req) => {
      const { type } = typeParam.parse(req.params);
      const { id } = idParam.parse(req.params);
      const body = voucherBody.parse(req.body);

      return service.updateVoucher(req.principal, id, { type, ...body });
    },
  });
}
