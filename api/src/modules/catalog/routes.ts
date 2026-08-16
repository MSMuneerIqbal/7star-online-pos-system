/**
 * Catalog registration — Brand, Category, Raw Item, Finish Product.
 *
 * Legacy forms: 3 Brand (202), 4 Category (203), 5 Raw Item (204),
 * 6 Finish Product (205). Four screens grouped in one router because they are
 * the same shape; each keeps its own legacy form/action codes so existing role
 * grants still apply.
 *
 * This file is the edge: Zod schemas, permission gates and status codes. The
 * work lives in `service.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formPermissions, listQuery } from '../../core/crud.js';
import * as service from './service.js';

const BRAND = formPermissions(3, 202);
const CATEGORY = formPermissions(4, 203);
const RAW = formPermissions(5, 204);
const PRODUCT = formPermissions(6, 205);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);

/** Brand and Category take the same body. */
const taxonomyBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  otherName: z.string().trim().max(150).nullish(),
  isRaw: z.boolean().default(false),
  branchId: z.coerce.number().int().optional(),
});

const rawItemBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  price: decimal.default('0'),
  reorder: decimal.default('0'),
  brandId: z.coerce.number().int().positive().nullish(),
  catId: z.coerce.number().int().positive().nullish(),
  partType: z.enum(service.RAW_PART_TYPES).default('OTHER'),
  model: z.string().trim().max(200).nullish(),
  placement: z.enum(service.PRODUCT_PLACEMENTS).nullish(),
  cellCapacityMah: z.coerce.number().int().positive().nullish(),
  cellVoltage: decimal.nullish(),
  cellSize: z.string().trim().max(50).nullish(),
  cellBrand: z.string().trim().max(100).nullish(),
  isActive: z.boolean().default(true),
});

const productBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  otherName: z.string().trim().max(200).nullish(),
  price: decimal.default('0'),
  brandId: z.coerce.number().int().positive().nullish(),
  categoryId: z.coerce.number().int().positive().nullish(),
  unitOfMeasure: z.string().trim().max(50).nullish(),
  companyBarcode: z.string().trim().max(100).nullish(),
  type: z.enum(service.PRODUCT_TYPES).default('NEW'),
  placement: z.enum(service.PRODUCT_PLACEMENTS).default('INT'),
  cellTypeId: z.coerce.number().int().positive().nullish(),
  cellCount: z.coerce.number().int().positive().nullish(),
  isActive: z.boolean().default(true),
});

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Brand and Category — one implementation, two mount points
  // -------------------------------------------------------------------------

  for (const [kind, perm] of [
    ['brand', BRAND],
    ['category', CATEGORY],
  ] as const) {
    const path = kind === 'brand' ? 'brands' : 'categories';

    app.get(`/${path}`, {
      preHandler: app.requireAction(perm.formId, perm.view),
      handler: (req) => service.listTaxonomy(req.principal, kind, listQuery.parse(req.query)),
    });

    app.post(`/${path}`, {
      preHandler: app.requireAction(perm.formId, perm.create),
      handler: async (req, reply) => {
        const row = await service.createTaxonomy(req.principal, kind, taxonomyBody.parse(req.body));
        return reply.status(201).send(row);
      },
    });

    app.put(`/${path}/:id`, {
      preHandler: app.requireAction(perm.formId, perm.edit),
      handler: (req) => {
        const { id } = idParam.parse(req.params);
        return service.updateTaxonomy(
          req.principal,
          kind,
          id,
          taxonomyBody.omit({ branchId: true }).parse(req.body),
        );
      },
    });
  }

  // Only Brand carries a delete — the legacy menu never granted one on Category.
  app.delete('/brands/:id', {
    preHandler: app.requireAction(BRAND.formId, BRAND.remove),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      await service.deleteBrand(req.principal, id);
      return reply.status(204).send();
    },
  });

  // -------------------------------------------------------------------------
  // Raw Item
  // -------------------------------------------------------------------------

  app.get('/raw-products', {
    preHandler: app.requireAction(RAW.formId, RAW.view),
    handler: (req) => {
      const q = listQuery.parse(req.query);
      const { partType } = z
        .object({ partType: z.enum(service.RAW_PART_TYPES).optional() })
        .parse(req.query);

      return service.listRawItems(q, partType);
    },
  });

  app.post('/raw-products', {
    preHandler: app.requireAction(RAW.formId, RAW.create),
    handler: async (req, reply) => {
      const row = await service.createRawItem(req.principal, rawItemBody.parse(req.body));
      return reply.status(201).send(row);
    },
  });

  app.put('/raw-products/:id', {
    preHandler: app.requireAction(RAW.formId, RAW.edit),
    handler: (req) => {
      const { id } = idParam.parse(req.params);
      return service.updateRawItem(req.principal, id, rawItemBody.parse(req.body));
    },
  });

  // -------------------------------------------------------------------------
  // Finish Product — the master catalog
  // -------------------------------------------------------------------------

  app.get('/products', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.view),
    handler: (req) => service.listProducts(listQuery.parse(req.query)),
  });

  app.get('/catalog-options', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.view),
    handler: (req) => service.catalogOptions(req.principal),
  });

  app.post('/products', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.create),
    handler: async (req, reply) => {
      const row = await service.createProduct(req.principal, productBody.parse(req.body));
      return reply.status(201).send(row);
    },
  });

  app.put('/products/:id', {
    preHandler: app.requireAction(PRODUCT.formId, PRODUCT.edit),
    handler: (req) => {
      const { id } = idParam.parse(req.params);
      return service.updateProduct(req.principal, id, productBody.parse(req.body));
    },
  });
}
