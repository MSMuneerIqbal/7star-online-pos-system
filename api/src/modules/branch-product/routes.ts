/**
 * My Prices — a branch's own view onto the master catalog. Legacy-style form
 * id 53, form code 1201 (new work, PLAN.md ground rule 9: head 12 upward).
 *
 * Every row already exists — the catalog-split migration's fan-out triggers
 * create a `branch_product` row for every active product at every active
 * branch, and vice versa. This module never creates or deletes a row, only
 * reads and edits the price/location/threshold a branch owns.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db/index.js';
import { badRequest, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId } from '../../core/rbac.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';

const PERM = formPermissions(53, 1201);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);

export default async function branchProductRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      // Same sentinel guard `resolveBranchId` uses for writes, applied to a
      // read: a super admin must name a branch before seeing its prices.
      const branchId = resolveBranchId(req.principal, q.branchId);

      let base = db
        .selectFrom('branch_product')
        .innerJoin('product', 'product.id', 'branch_product.product_id')
        .leftJoin('brand', 'brand.id', 'product.brand_id')
        .where('branch_product.branch_id', '=', branchId);

      const term = likeTerm(q.search);
      if (term) base = base.where('product.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'branch_product.id',
            'product.id as product_id',
            'product.name as product_name',
            'product.type',
            'product.placement',
            'brand.name as brand_name',
            'branch_product.selling_price',
            'branch_product.minimum_price',
            'branch_product.wholesale_cost',
            'branch_product.location',
            'branch_product.low_stock_threshold',
            'branch_product.is_active',
          ])
          .orderBy('product.name')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.put('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          sellingPrice: decimal,
          minimumPrice: decimal,
          location: z.string().trim().max(100).nullish(),
          lowStockThreshold: decimal.default('0'),
          isActive: z.boolean().default(true),
        })
        .parse(req.body);

      if (Number(body.minimumPrice) > Number(body.sellingPrice)) {
        throw badRequest('Minimum price cannot be higher than the selling price');
      }

      const existing = await db
        .selectFrom('branch_product')
        .innerJoin('product', 'product.id', 'branch_product.product_id')
        .select([
          'branch_product.id',
          'branch_product.branch_id',
          'branch_product.selling_price',
          'product.name as product_name',
        ])
        .where('branch_product.id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Branch price');
      assertBranchAccess(req.principal, existing.branch_id);

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('branch_product')
          .set({
            selling_price: body.sellingPrice,
            minimum_price: body.minimumPrice,
            location: body.location ?? null,
            low_stock_threshold: body.lowStockThreshold,
            is_active: body.isActive,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        const detail =
          existing.selling_price === row.selling_price
            ? `Updated price row: ${existing.product_name}`
            : `Updated price row: ${existing.product_name}, selling price ${existing.selling_price} -> ${row.selling_price}`;

        await writeAudit(
          req.principal,
          { form: 'My Prices', action: 'Edit', detail, invId: id },
          tx,
        );

        return row;
      });
    },
  });
}
