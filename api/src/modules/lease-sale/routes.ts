/**
 * Hold (lease) sale. Legacy form id 51, form code 403.
 *
 * A parked basket — goods set aside for a customer who has not paid. There is
 * NO ledger posting: nothing has been sold, so nothing is recognised. Value is
 * recorded only when the hold is converted into a real sale, which posts
 * through the normal sale path.
 *
 * Because it carries no money, this module has no service layer: there are no
 * totals to derive and no journal to balance.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db/index.js';
import { conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId } from '../../core/rbac.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';

const PERM = formPermissions(51, 403);

const STATUS = { HELD: 'HELD', CONVERTED: 'CONVERTED', CANCELLED: 'CANCELLED' } as const;

const lineSchema = z.object({
  pid: z.coerce.number().int().positive(),
  qty: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => Number(v) > 0, 'Quantity must be greater than zero'),
});

const holdBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  custId: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().optional(),
  note: z.string().max(1000).nullish(),
  lines: z.array(lineSchema).min(1, 'Add at least one item'),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function leaseSaleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const { status } = z.object({ status: z.string().optional() }).parse(req.query);

      let base = db
        .selectFrom('lease_sale')
        .leftJoin('customer', 'customer.id', 'lease_sale.cust_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('lease_sale.branch_id', '=', req.principal.branchId);
      } else if (q.branchId !== undefined) {
        base = base.where('lease_sale.branch_id', '=', q.branchId);
      }

      if (status) base = base.where('lease_sale.status', '=', status);

      const term = likeTerm(q.search);
      if (term) base = base.where('customer.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'lease_sale.id',
            'lease_sale.date',
            'lease_sale.status',
            'lease_sale.note',
            'customer.name as customer_name',
          ])
          .orderBy('lease_sale.date', 'desc')
          .orderBy('lease_sale.id', 'desc')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/form-data', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const isSuper = req.principal.isSuperAdmin;
      const branchId = req.principal.branchId;

      let customers = db
        .selectFrom('customer')
        .select(['id', 'name', 'phone'])
        .where('is_active', '=', true);

      if (!isSuper) customers = customers.where('branch_id', '=', branchId);

      let products = db
        .selectFrom('product')
        .select(['id', 'name', 'sale_price'])
        .where('is_active', '=', true);

      if (!isSuper) products = products.where('branch_id', '=', branchId);

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', branchId);

      const [customerRows, productRows, branchRows] = await Promise.all([
        customers.orderBy('name').execute(),
        products.orderBy('name').execute(),
        branches.orderBy('name').execute(),
      ]);

      return { customers: customerRows, products: productRows, branches: branchRows };
    },
  });

  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const hold = await db
        .selectFrom('lease_sale')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!hold) throw notFound('Hold Sale');

      if (!req.principal.isSuperAdmin && hold.branch_id !== req.principal.branchId) {
        throw notFound('Hold Sale');
      }

      const lines = await db
        .selectFrom('lease_sale_detail')
        .selectAll()
        .where('sale_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...hold, lines };
    },
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = holdBody.parse(req.body);
      const branchId = resolveBranchId(req.principal, body.branchId);
      assertBranchAccess(req.principal, branchId);

      const result = await withTransaction(async (tx) => {
        // Names are denormalised onto the line, matching the legacy schema, so
        // a later product rename doesn't rewrite history.
        const products = await tx
          .selectFrom('product')
          .select(['id', 'name'])
          .where(
            'id',
            'in',
            body.lines.map((l) => l.pid),
          )
          .execute();

        const names = new Map(products.map((p) => [p.id, p.name]));

        const hold = await tx
          .insertInto('lease_sale')
          .values({
            date: body.date,
            cust_id: body.custId,
            branch_id: branchId,
            status: STATUS.HELD,
            note: body.note ?? null,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('lease_sale_detail')
          .values(
            body.lines.map((l) => ({
              sale_id: hold.id,
              pid: l.pid,
              pname: names.get(l.pid) ?? '',
              qty: l.qty,
              status: STATUS.HELD,
            })),
          )
          .execute();

        await writeAudit(
          req.principal,
          {
            form: 'Hold Sale',
            action: 'New',
            detail:
              `Hold:${hold.id} | New Hold Sale | Customer id ${body.custId} | ` +
              `Items => ${body.lines.map((l) => `[PID:${l.pid}, Qty:${l.qty}]`).join(' | ')}`,
            invId: hold.id,
          },
          tx,
        );

        return { id: hold.id };
      });

      return reply.status(201).send(result);
    },
  });

  /**
   * Release a hold without selling — goods go back on the shelf.
   * Still no ledger impact.
   */
  app.post('/:id/cancel', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const hold = await db
        .selectFrom('lease_sale')
        .select(['id', 'branch_id', 'status'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!hold) throw notFound('Hold Sale');
      assertBranchAccess(req.principal, hold.branch_id);

      if (hold.status === STATUS.CONVERTED) {
        throw conflict('This hold has already been converted into a sale');
      }
      if (hold.status === STATUS.CANCELLED) {
        throw conflict('This hold is already cancelled');
      }

      await withTransaction(async (tx) => {
        await tx
          .updateTable('lease_sale')
          .set({
            status: STATUS.CANCELLED,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .execute();

        await tx
          .updateTable('lease_sale_detail')
          .set({ status: STATUS.CANCELLED })
          .where('sale_id', '=', id)
          .execute();

        await writeAudit(
          req.principal,
          {
            form: 'Hold Sale',
            action: 'Edit',
            detail: `Hold:${id} | Cancelled Hold Sale`,
            invId: id,
          },
          tx,
        );
      });

      return { id, status: STATUS.CANCELLED };
    },
  });

  /**
   * Mark a hold as converted.
   *
   * The sale itself is created through the normal sale endpoint — that is what
   * posts the ledger. This only records that the hold was fulfilled, so the
   * same goods cannot be released twice.
   */
  app.post('/:id/convert', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const { saleId } = z.object({ saleId: z.coerce.number().int().positive() }).parse(req.body);

      const hold = await db
        .selectFrom('lease_sale')
        .select(['id', 'branch_id', 'status'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!hold) throw notFound('Hold Sale');
      assertBranchAccess(req.principal, hold.branch_id);

      if (hold.status !== STATUS.HELD) {
        throw conflict(`This hold is ${hold.status?.toLowerCase()} and cannot be converted`);
      }

      const sale = await db
        .selectFrom('sale')
        .select('id')
        .where('id', '=', saleId)
        .executeTakeFirst();

      if (!sale) throw conflict(`Sale invoice ${saleId} does not exist`);

      await withTransaction(async (tx) => {
        await tx
          .updateTable('lease_sale')
          .set({
            status: STATUS.CONVERTED,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .execute();

        await tx
          .updateTable('lease_sale_detail')
          .set({ status: STATUS.CONVERTED })
          .where('sale_id', '=', id)
          .execute();

        await writeAudit(
          req.principal,
          {
            form: 'Hold Sale',
            action: 'Edit',
            detail: `Hold:${id} | Converted to Sale Invoice ${saleId}`,
            invId: id,
          },
          tx,
        );
      });

      return { id, status: STATUS.CONVERTED, saleId };
    },
  });
}
