/**
 * Catalog registration — Brand, Category, Raw Item, Finish Product.
 *
 * Legacy forms: 3 Brand (202), 4 Category (203), 5 Raw Item (204),
 * 6 Finish Product (205).
 *
 * Four small CRUD screens over four tables. Grouped in one router because they
 * are the same shape; each keeps its own legacy form/action codes so existing
 * role grants still apply.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db/index.js';
import { conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { resolveBranchId } from '../../core/rbac.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';

const BRAND = formPermissions(3, 202);
const CATEGORY = formPermissions(4, 203);
const RAW = formPermissions(5, 204);
const PRODUCT = formPermissions(6, 205);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Brand
  // -------------------------------------------------------------------------

  app.get('/brands', {
    preHandler: app.requireAction(BRAND.formId, BRAND.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      let base = db.selectFrom('brand');

      if (!req.principal.isSuperAdmin) base = base.where('branch_id', '=', req.principal.branchId);

      const term = likeTerm(q.search);
      if (term) base = base.where('name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'name', 'other_name', 'is_raw', 'branch_id'])
          .orderBy('name')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/brands', {
    preHandler: app.requireAction(BRAND.formId, BRAND.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          otherName: z.string().trim().max(150).nullish(),
          isRaw: z.boolean().default(false),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);

      const clash = await db
        .selectFrom('brand')
        .select('id')
        .where('name', 'ilike', body.name)
        .where('branch_id', '=', branchId)
        .executeTakeFirst();

      if (clash) throw conflict(`A brand named "${body.name}" already exists`);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('brand')
          .values({
            name: body.name,
            other_name: body.otherName ?? null,
            is_raw: body.isRaw,
            branch_id: branchId,
            company_id: 0,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          { form: 'Brand', action: 'New', detail: `Created brand: ${created.name}`, invId: created.id },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.put('/brands/:id', {
    preHandler: app.requireAction(BRAND.formId, BRAND.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(150),
          otherName: z.string().trim().max(150).nullish(),
          isRaw: z.boolean().default(false),
        })
        .parse(req.body);

      const existing = await db
        .selectFrom('brand')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Brand');

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('brand')
          .set({
            name: body.name,
            other_name: body.otherName ?? null,
            is_raw: body.isRaw,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          { form: 'Brand', action: 'Edit', detail: `Updated brand: ${row.name}`, invId: id },
          tx,
        );

        return row;
      });
    },
  });

  app.delete('/brands/:id', {
    preHandler: app.requireAction(BRAND.formId, BRAND.remove),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);

      const existing = await db
        .selectFrom('brand')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Brand');

      // Products and raw items reference brands; Postgres would raise a
      // constraint name, this says which table is holding it.
      const [products, raws] = await Promise.all([
        db
          .selectFrom('product')
          .select(({ fn }) => fn.countAll<string>().as('n'))
          .where('brand_id', '=', id)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('raw_product')
          .select(({ fn }) => fn.countAll<string>().as('n'))
          .where('brand_id', '=', id)
          .executeTakeFirstOrThrow(),
      ]);

      const used = Number(products.n) + Number(raws.n);
      if (used > 0) throw conflict(`${used} item(s) still use this brand`);

      await withTransaction(async (tx) => {
        await tx.deleteFrom('brand').where('id', '=', id).execute();
        await writeAudit(
          req.principal,
          { form: 'Brand', action: 'Delete', detail: `Deleted brand: ${existing.name}`, invId: id },
          tx,
        );
      });

      return reply.status(204).send();
    },
  });

  // -------------------------------------------------------------------------
  // Category
  // -------------------------------------------------------------------------

  app.get('/categories', {
    preHandler: app.requireAction(CATEGORY.formId, CATEGORY.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      let base = db.selectFrom('category');

      if (!req.principal.isSuperAdmin) base = base.where('branch_id', '=', req.principal.branchId);

      const term = likeTerm(q.search);
      if (term) base = base.where('name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'name', 'other_name', 'is_raw', 'branch_id'])
          .orderBy('name')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/categories', {
    preHandler: app.requireAction(CATEGORY.formId, CATEGORY.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          otherName: z.string().trim().max(150).nullish(),
          isRaw: z.boolean().default(false),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);

      const clash = await db
        .selectFrom('category')
        .select('id')
        .where('name', 'ilike', body.name)
        .where('branch_id', '=', branchId)
        .executeTakeFirst();

      if (clash) throw conflict(`A category named "${body.name}" already exists`);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('category')
          .values({
            name: body.name,
            other_name: body.otherName ?? null,
            is_raw: body.isRaw,
            branch_id: branchId,
            company_id: 0,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'Category',
            action: 'New',
            detail: `Created category: ${created.name}`,
            invId: created.id,
          },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.put('/categories/:id', {
    preHandler: app.requireAction(CATEGORY.formId, CATEGORY.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(150),
          otherName: z.string().trim().max(150).nullish(),
          isRaw: z.boolean().default(false),
        })
        .parse(req.body);

      if (!(await db.selectFrom('category').select('id').where('id', '=', id).executeTakeFirst())) {
        throw notFound('Category');
      }

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('category')
          .set({
            name: body.name,
            other_name: body.otherName ?? null,
            is_raw: body.isRaw,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          { form: 'Category', action: 'Edit', detail: `Updated category: ${row.name}`, invId: id },
          tx,
        );

        return row;
      });
    },
  });

  // -------------------------------------------------------------------------
  // Raw Item
  // -------------------------------------------------------------------------

  app.get('/raw-products', {
    preHandler: app.requireAction(RAW.formId, RAW.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('raw_product')
        .leftJoin('brand', 'brand.id', 'raw_product.brand_id')
        .leftJoin('category', 'category.id', 'raw_product.cat_id');

      const term = likeTerm(q.search);
      if (term) base = base.where('raw_product.name', 'ilike', term);

      const [rows, count] = await Promise.all([
        base
          .select([
            'raw_product.id',
            'raw_product.name',
            'raw_product.price',
            'raw_product.reorder',
            'raw_product.is_active',
            'brand.name as brand_name',
            'category.name as category_name',
          ])
          .orderBy('raw_product.name')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/raw-products', {
    preHandler: app.requireAction(RAW.formId, RAW.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(200),
          price: decimal.default('0'),
          reorder: decimal.default('0'),
          brandId: z.coerce.number().int().positive().nullish(),
          catId: z.coerce.number().int().positive().nullish(),
          isActive: z.boolean().default(true),
        })
        .parse(req.body);

      const clash = await db
        .selectFrom('raw_product')
        .select('id')
        .where('name', 'ilike', body.name)
        .executeTakeFirst();

      if (clash) throw conflict(`A raw item named "${body.name}" already exists`);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('raw_product')
          .values({
            name: body.name,
            price: body.price,
            reorder: body.reorder,
            brand_id: body.brandId ?? null,
            cat_id: body.catId ?? null,
            is_active: body.isActive,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'Raw Item',
            action: 'New',
            detail: `Created raw item: ${created.name} @ ${created.price}`,
            invId: created.id,
          },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.put('/raw-products/:id', {
    preHandler: app.requireAction(RAW.formId, RAW.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(200),
          price: decimal,
          reorder: decimal.default('0'),
          brandId: z.coerce.number().int().positive().nullish(),
          catId: z.coerce.number().int().positive().nullish(),
          isActive: z.boolean().default(true),
        })
        .parse(req.body);

      const existing = await db
        .selectFrom('raw_product')
        .select(['id', 'price'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Raw item');

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('raw_product')
          .set({
            name: body.name,
            price: body.price,
            reorder: body.reorder,
            brand_id: body.brandId ?? null,
            cat_id: body.catId ?? null,
            is_active: body.isActive,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Cost changes matter: they feed every future purchase valuation and
        // production run, so the old value goes in the audit trail.
        const detail =
          existing.price === row.price
            ? `Updated raw item: ${row.name}`
            : `Updated raw item: ${row.name}, cost ${existing.price} -> ${row.price}`;

        await writeAudit(
          req.principal,
          { form: 'Raw Item', action: 'Edit', detail, invId: id },
          tx,
        );

        return row;
      });
    },
  });

  // -------------------------------------------------------------------------
  // Finish Product
  // -------------------------------------------------------------------------

  app.get('/products', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('product')
        .leftJoin('brand', 'brand.id', 'product.brand_id')
        .leftJoin('category', 'category.id', 'product.category_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('product.branch_id', '=', req.principal.branchId);
      }

      const term = likeTerm(q.search);
      if (term) {
        base = base.where((eb) =>
          eb.or([eb('product.name', 'ilike', term), eb('product.company_barcode', 'ilike', term)]),
        );
      }

      const [rows, count] = await Promise.all([
        base
          .select([
            'product.id',
            'product.name',
            'product.price',
            'product.sale_price',
            'product.least_price',
            'product.reorder_level',
            'product.unit_of_measure',
            'product.company_barcode',
            'product.is_active',
            'brand.name as brand_name',
            'category.name as category_name',
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

  /** Brand and category options for the product and raw-item forms. */
  app.get('/catalog-options', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.view),
    handler: async (req) => {
      const isSuper = req.principal.isSuperAdmin;

      let brands = db.selectFrom('brand').select(['id', 'name', 'is_raw']);
      let categories = db.selectFrom('category').select(['id', 'name', 'is_raw']);
      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);

      if (!isSuper) {
        brands = brands.where('branch_id', '=', req.principal.branchId);
        categories = categories.where('branch_id', '=', req.principal.branchId);
        branches = branches.where('id', '=', req.principal.branchId);
      }

      const [brandRows, categoryRows, branchRows] = await Promise.all([
        brands.orderBy('name').execute(),
        categories.orderBy('name').execute(),
        branches.orderBy('name').execute(),
      ]);

      return { brands: brandRows, categories: categoryRows, branches: branchRows };
    },
  });

  app.post('/products', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(200),
          otherName: z.string().trim().max(200).nullish(),
          /** Cost price — drives COGS on every sale. */
          price: decimal.default('0'),
          salePrice: decimal.default('0'),
          leastPrice: decimal.default('0'),
          brandId: z.coerce.number().int().positive().nullish(),
          categoryId: z.coerce.number().int().positive().nullish(),
          unitOfMeasure: z.string().trim().max(50).nullish(),
          companyBarcode: z.string().trim().max(100).nullish(),
          reorderLevel: z.coerce.number().int().min(0).default(0),
          isActive: z.boolean().default(true),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);

      const clash = await db
        .selectFrom('product')
        .select('id')
        .where('name', 'ilike', body.name)
        .where('branch_id', '=', branchId)
        .executeTakeFirst();

      if (clash) throw conflict(`A product named "${body.name}" already exists`);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('product')
          .values({
            name: body.name,
            other_name: body.otherName ?? null,
            price: body.price,
            sale_price: body.salePrice,
            least_price: body.leastPrice,
            open_qty: '0',
            company_id: 0,
            brand_id: body.brandId ?? null,
            category_id: body.categoryId ?? null,
            unit_of_measure: body.unitOfMeasure ?? null,
            company_barcode: body.companyBarcode ?? null,
            reorder_level: body.reorderLevel,
            brand_discount: '0',
            shelf_number: 0,
            image_path: null,
            branch_id: branchId,
            is_active: body.isActive,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'Finish Product',
            action: 'New',
            detail: `Created product: ${created.name}, cost ${created.price}, sale ${created.sale_price}`,
            invId: created.id,
          },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.put('/products/:id', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(200),
          otherName: z.string().trim().max(200).nullish(),
          price: decimal,
          salePrice: decimal,
          leastPrice: decimal.default('0'),
          brandId: z.coerce.number().int().positive().nullish(),
          categoryId: z.coerce.number().int().positive().nullish(),
          unitOfMeasure: z.string().trim().max(50).nullish(),
          companyBarcode: z.string().trim().max(100).nullish(),
          reorderLevel: z.coerce.number().int().min(0).default(0),
          isActive: z.boolean().default(true),
        })
        .parse(req.body);

      const existing = await db
        .selectFrom('product')
        .select(['id', 'name', 'price'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Product');

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('product')
          .set({
            name: body.name,
            other_name: body.otherName ?? null,
            price: body.price,
            sale_price: body.salePrice,
            least_price: body.leastPrice,
            brand_id: body.brandId ?? null,
            category_id: body.categoryId ?? null,
            unit_of_measure: body.unitOfMeasure ?? null,
            company_barcode: body.companyBarcode ?? null,
            reorder_level: body.reorderLevel,
            is_active: body.isActive,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        // A cost change alters COGS on every future sale, so it is called out
        // explicitly rather than buried in a generic "updated" line.
        const detail =
          existing.price === row.price
            ? `Updated product: ${row.name}`
            : `Updated product: ${row.name}, COST ${existing.price} -> ${row.price}`;

        await writeAudit(
          req.principal,
          { form: 'Finish Product', action: 'Edit', detail, invId: id },
          tx,
        );

        return row;
      });
    },
  });
}
