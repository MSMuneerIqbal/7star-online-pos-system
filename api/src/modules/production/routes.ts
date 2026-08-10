/**
 * Production. Legacy form id 47, form code 1001.
 *
 * Converts raw materials plus conversion cost into finished goods. Material
 * cost is derived from the catalog, never from the client — the same rule as
 * COGS on a sale.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db/index.js';
import { add, money, mul, type MoneyString } from '../../core/money.js';
import { badRequest, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId } from '../../core/rbac.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import { postProduction } from '../../accounting/rules/production.js';
import { postJournal } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

const PERM = formPermissions(47, 1001);

const decimalString = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((v) => /^-?\d+(\.\d+)?$/.test(v), `${label} must be a number`);

const body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  branchId: z.coerce.number().int().optional(),
  /** The finished product being made. */
  pid: z.coerce.number().int().positive(),
  qty: z.coerce.number().int().positive('Quantity must be at least 1'),
  labourCost: decimalString('Labour cost').default('0'),
  electricCost: decimalString('Electricity cost').default('0'),
  otherCost: decimalString('Other cost').default('0'),
  conversionPaidInCash: z.boolean().default(true),
  note: z.string().max(1000).nullish(),
  /** Raw materials consumed. */
  lines: z
    .array(
      z.object({
        pid: z.coerce.number().int().positive(),
        qty: decimalString('Quantity'),
      }),
    )
    .min(1, 'Add at least one raw material'),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function productionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('production').leftJoin('product', 'product.id', 'production.pid');

      if (!req.principal.isSuperAdmin) {
        base = base.where('production.branch_id', '=', req.principal.branchId);
      } else if (q.branchId !== undefined) {
        base = base.where('production.branch_id', '=', q.branchId);
      }

      const term = likeTerm(q.search);
      if (term) base = base.where('product.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'production.id',
            'production.date',
            'production.qty',
            'production.material_cost',
            'production.total_cost',
            'production.per_unit',
            'production.branch_id',
            'product.name as product_name',
          ])
          .orderBy('production.date', 'desc')
          .orderBy('production.id', 'desc')
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

      let products = db
        .selectFrom('product')
        .select(['id', 'name', 'price'])
        .where('is_active', '=', true);

      if (!isSuper) products = products.where('branch_id', '=', req.principal.branchId);

      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!isSuper) branches = branches.where('id', '=', req.principal.branchId);

      const [productRows, rawRows, branchRows] = await Promise.all([
        products.orderBy('name').execute(),
        db
          .selectFrom('raw_product')
          .select(['id', 'name', 'price'])
          .where('is_active', '=', true)
          .orderBy('name')
          .execute(),
        branches.orderBy('name').execute(),
      ]);

      return { products: productRows, rawMaterials: rawRows, branches: branchRows };
    },
  });

  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const row = await db
        .selectFrom('production')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!row) throw notFound('Production');

      if (!req.principal.isSuperAdmin && row.branch_id !== req.principal.branchId) {
        throw notFound('Production');
      }

      const lines = await db
        .selectFrom('production_detail')
        .selectAll()
        .where('inv_id', '=', id)
        .orderBy('id')
        .execute();

      return { ...row, lines };
    },
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const input = body.parse(req.body);
      const branchId = resolveBranchId(req.principal, input.branchId);
      assertBranchAccess(req.principal, branchId);

      const result = await withTransaction(async (tx) => {
        // Raw materials are costed from the catalog — never from the request.
        const ids = [...new Set(input.lines.map((l) => l.pid))];

        const raws = await tx
          .selectFrom('raw_product')
          .select(['id', 'name', 'price'])
          .where('id', 'in', ids)
          .execute();

        const byId = new Map(raws.map((r) => [r.id, r]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) throw badRequest(`Unknown raw item id(s): ${missing.join(', ')}`);

        const product = await tx
          .selectFrom('product')
          .select(['id', 'name'])
          .where('id', '=', input.pid)
          .executeTakeFirst();

        if (!product) throw badRequest(`Unknown product id ${input.pid}`);

        let materialCost: MoneyString = '0.00';
        const detail = input.lines.map((l) => {
          const raw = byId.get(l.pid)!;
          const total = mul(l.qty, raw.price);
          materialCost = add(materialCost, total);

          return {
            pid: l.pid,
            pname: raw.name ?? '',
            qty: l.qty,
            price: money(raw.price),
            total,
          };
        });

        const conversion = add(input.labourCost, input.electricCost, input.otherCost);
        const totalCost = add(materialCost, conversion);
        // Unit cost becomes the finished product's carrying value.
        const perUnit = money(String(Number(totalCost) / input.qty));

        const production = await tx
          .insertInto('production')
          .values({
            date: input.date,
            branch_id: branchId,
            pid: input.pid,
            qty: input.qty,
            note: input.note ?? null,
            labor_cost: money(input.labourCost),
            electric_cost: money(input.electricCost),
            other_cost: money(input.otherCost),
            material_cost: materialCost,
            extra: '0',
            extra1: '0',
            per_unit: perUnit,
            total_cost: totalCost,
            gross_total: totalCost,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await tx
          .insertInto('production_detail')
          .values(detail.map((d) => ({ ...d, inv_id: production.id })))
          .execute();

        await postJournal(
          tx,
          postProduction({
            invId: production.id,
            date: input.date,
            branchId,
            productName: product.name ?? '',
            materialCost,
            labourCost: money(input.labourCost),
            electricCost: money(input.electricCost),
            otherCost: money(input.otherCost),
            totalCost,
            conversionPaidInCash: input.conversionPaidInCash,
          }),
        );

        await writeAudit(
          req.principal,
          {
            form: 'Production',
            action: 'New',
            detail:
              `Production:${production.id} | Made ${input.qty} x ${product.name} | ` +
              `Material ${fmt(materialCost)}, Conversion ${fmt(conversion)}, ` +
              `Total ${fmt(totalCost)} @ ${fmt(perUnit)}/unit`,
            invId: production.id,
          },
          tx,
        );

        return { id: production.id, totalCost, perUnit };
      });

      return reply.status(201).send(result);
    },
  });
}
