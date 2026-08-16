/**
 * Catalog — the work behind Brand, Category, Raw Item and Finish Product.
 *
 * `routes.ts` owns Zod schemas and HTTP; everything below is the business, so it
 * can be exercised without a request. The master-catalog identity rule in
 * particular is the kind of thing that should be testable directly:
 * `idx_product_identity` is what stops one model becoming two rows, and it is
 * far too important to only be reachable through a POST.
 *
 * Every write takes an optional trailing `tx` (PLAN ground rule 4a) so a test
 * can drive it inside a rollback.
 */
import { db, inTransaction, type Tx } from '../../core/db/index.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { resolveBranchId, type Principal } from '../../core/rbac.js';
import { likeTerm, offset, paged, type ListQuery } from '../../core/crud.js';
import type { ProductPlacement, ProductType, RawPartType } from '../../core/db/types.js';

export const PRODUCT_TYPES = ['NEW', 'BRANDED', 'CHARGER', 'STORAGE', 'OTHER'] as const;
export const PRODUCT_PLACEMENTS = ['INT', 'EXT'] as const;
export const RAW_PART_TYPES = ['CELL', 'COMPLETE_SET', 'OTHER'] as const;

// ---------------------------------------------------------------------------
// Brand and Category
//
// Two screens, one shape. They differ only in the table they sit on and the
// word in the error message, so they share an implementation rather than
// carrying two copies that can drift apart.
// ---------------------------------------------------------------------------

export type TaxonomyKind = 'brand' | 'category';

const TAXONOMY_LABEL: Record<TaxonomyKind, string> = {
  brand: 'Brand',
  category: 'Category',
};

export interface TaxonomyInput {
  name: string;
  otherName?: string | null | undefined;
  isRaw: boolean;
  branchId?: number | undefined;
}

export async function listTaxonomy(principal: Principal, kind: TaxonomyKind, q: ListQuery) {
  let base = db.selectFrom(kind);

  if (!principal.isSuperAdmin) base = base.where('branch_id', '=', principal.branchId);

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
}

export async function createTaxonomy(
  principal: Principal,
  kind: TaxonomyKind,
  input: TaxonomyInput,
  outerTx?: Tx,
) {
  const branchId = resolveBranchId(principal, input.branchId);
  const label = TAXONOMY_LABEL[kind];

  const clash = await (outerTx ?? db)
    .selectFrom(kind)
    .select('id')
    .where('name', 'ilike', input.name)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();

  if (clash) throw conflict(`A ${label.toLowerCase()} named "${input.name}" already exists`);

  return inTransaction(outerTx, async (tx) => {
    const created = await tx
      .insertInto(kind)
      .values({
        name: input.name,
        other_name: input.otherName ?? null,
        is_raw: input.isRaw,
        branch_id: branchId,
        company_id: 0,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: label,
        action: 'New',
        detail: `Created ${label.toLowerCase()}: ${created.name}`,
        invId: created.id,
      },
      tx,
    );

    return created;
  });
}

export async function updateTaxonomy(
  principal: Principal,
  kind: TaxonomyKind,
  id: number,
  input: Omit<TaxonomyInput, 'branchId'>,
  outerTx?: Tx,
) {
  const label = TAXONOMY_LABEL[kind];

  const existing = await (outerTx ?? db)
    .selectFrom(kind)
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound(label);

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .updateTable(kind)
      .set({
        name: input.name,
        other_name: input.otherName ?? null,
        is_raw: input.isRaw,
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: label,
        action: 'Edit',
        detail: `Updated ${label.toLowerCase()}: ${row.name}`,
        invId: id,
      },
      tx,
    );

    return row;
  });
}

export async function deleteBrand(principal: Principal, id: number, outerTx?: Tx): Promise<void> {
  const executor = outerTx ?? db;

  const existing = await executor
    .selectFrom('brand')
    .select(['id', 'name'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound('Brand');

  // Products and raw items reference brands. Postgres would raise a constraint
  // name; this says which table is holding it (invariant: deleting is refused
  // when something depends on it).
  const [products, raws] = await Promise.all([
    executor
      .selectFrom('product')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('brand_id', '=', id)
      .executeTakeFirstOrThrow(),
    executor
      .selectFrom('raw_product')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('brand_id', '=', id)
      .executeTakeFirstOrThrow(),
  ]);

  const used = Number(products.n) + Number(raws.n);
  if (used > 0) throw conflict(`${used} item(s) still use this brand`);

  await inTransaction(outerTx, async (tx) => {
    await tx.deleteFrom('brand').where('id', '=', id).execute();
    await writeAudit(
      principal,
      { form: 'Brand', action: 'Delete', detail: `Deleted brand: ${existing.name}`, invId: id },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Raw items — cells, complete sets and loose parts
// ---------------------------------------------------------------------------

export interface RawItemInput {
  name: string;
  price: string;
  reorder: string;
  brandId?: number | null | undefined;
  catId?: number | null | undefined;
  partType: RawPartType;
  model?: string | null | undefined;
  placement?: ProductPlacement | null | undefined;
  cellCapacityMah?: number | null | undefined;
  cellVoltage?: string | null | undefined;
  cellSize?: string | null | undefined;
  cellBrand?: string | null | undefined;
  isActive: boolean;
}

/**
 * Cell fields belong to cells only — the DB CHECK enforces it, so a complete set
 * or a loose part never carries a cell specification and they are dropped here
 * rather than rejected. Editing an item from CELL to OTHER clears them.
 */
function rawProductValues(input: RawItemInput) {
  const isCell = input.partType === 'CELL';

  return {
    name: input.name,
    price: input.price,
    reorder: input.reorder,
    brand_id: input.brandId ?? null,
    cat_id: input.catId ?? null,
    part_type: input.partType,
    model: input.model ?? null,
    placement: input.placement ?? null,
    cell_capacity_mah: isCell ? (input.cellCapacityMah ?? null) : null,
    cell_voltage: isCell ? (input.cellVoltage ?? null) : null,
    cell_size: isCell ? (input.cellSize ?? null) : null,
    cell_brand: isCell ? (input.cellBrand ?? null) : null,
    is_active: input.isActive,
  };
}

export async function listRawItems(q: ListQuery, partType?: RawPartType) {
  let base = db
    .selectFrom('raw_product')
    .leftJoin('brand', 'brand.id', 'raw_product.brand_id')
    .leftJoin('category', 'category.id', 'raw_product.cat_id');

  if (partType) base = base.where('raw_product.part_type', '=', partType);

  const term = likeTerm(q.search);
  if (term) {
    // A cell is found by its specification, not only its name.
    base = base.where((eb) =>
      eb.or([
        eb('raw_product.name', 'ilike', term),
        eb('raw_product.model', 'ilike', term),
        eb('raw_product.cell_brand', 'ilike', term),
      ]),
    );
  }

  const [rows, count] = await Promise.all([
    base
      .select([
        'raw_product.id',
        'raw_product.name',
        'raw_product.part_type',
        'raw_product.model',
        'raw_product.placement',
        'raw_product.cell_capacity_mah',
        'raw_product.cell_voltage',
        'raw_product.cell_size',
        'raw_product.cell_brand',
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
}

export async function createRawItem(principal: Principal, input: RawItemInput, outerTx?: Tx) {
  // Raw items are master catalog (SPECS §3.3): a branch never registers one,
  // even though it holds raw stock for the Lab.
  if (!principal.isSuperAdmin) throw forbidden('Only the super admin can register a raw item');

  const clash = await (outerTx ?? db)
    .selectFrom('raw_product')
    .select('id')
    .where('name', 'ilike', input.name)
    .executeTakeFirst();

  if (clash) throw conflict(`A raw item named "${input.name}" already exists`);

  return inTransaction(outerTx, async (tx) => {
    const created = await tx
      .insertInto('raw_product')
      .values({
        ...rawProductValues(input),
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
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
}

export async function updateRawItem(
  principal: Principal,
  id: number,
  input: RawItemInput,
  outerTx?: Tx,
) {
  if (!principal.isSuperAdmin) throw forbidden('Only the super admin can edit a raw item');

  const existing = await (outerTx ?? db)
    .selectFrom('raw_product')
    .select(['id', 'price'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound('Raw item');

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .updateTable('raw_product')
      .set({
        ...rawProductValues(input),
        updated_at: new Date(),
        updated_by: principal.empId,
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

    await writeAudit(principal, { form: 'Raw Item', action: 'Edit', detail, invId: id }, tx);

    return row;
  });
}

// ---------------------------------------------------------------------------
// Finish Product — the master catalog
//
// One row per model, company-wide (Phase 1, the catalog split). Branch price,
// location and threshold live on `branch_product`. Writes are super-admin only:
// a branch does not own the model, only its own price row.
// ---------------------------------------------------------------------------

export interface ProductInput {
  name: string;
  otherName?: string | null | undefined;
  /** Company cost — production cost, or purchase cost for bought-in goods. */
  price: string;
  brandId?: number | null | undefined;
  categoryId?: number | null | undefined;
  unitOfMeasure?: string | null | undefined;
  companyBarcode?: string | null | undefined;
  type: ProductType;
  placement: ProductPlacement;
  cellTypeId?: number | null | undefined;
  cellCount?: number | null | undefined;
  isActive: boolean;
}

export async function listProducts(q: ListQuery) {
  let base = db
    .selectFrom('product')
    .leftJoin('brand', 'brand.id', 'product.brand_id')
    .leftJoin('category', 'category.id', 'product.category_id');

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
        'product.type',
        'product.placement',
        'product.cell_type_id',
        'product.cell_count',
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
}

/** Brand, category, type, placement and cell-recipe options for the product form. */
export async function catalogOptions(principal: Principal) {
  const isSuper = principal.isSuperAdmin;

  let brands = db.selectFrom('brand').select(['id', 'name', 'is_raw']);
  let categories = db.selectFrom('category').select(['id', 'name', 'is_raw']);
  let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);

  if (!isSuper) {
    brands = brands.where('branch_id', '=', principal.branchId);
    categories = categories.where('branch_id', '=', principal.branchId);
    branches = branches.where('id', '=', principal.branchId);
  }

  // Cells are the suggested recipe for a finished product — only cells, never
  // complete sets or other parts.
  const cellTypes = db
    .selectFrom('raw_product')
    .select(['id', 'name'])
    .where('is_active', '=', true)
    .where('part_type', '=', 'CELL')
    .orderBy('name');

  const [brandRows, categoryRows, branchRows, cellTypeRows] = await Promise.all([
    brands.orderBy('name').execute(),
    categories.orderBy('name').execute(),
    branches.orderBy('name').execute(),
    cellTypes.execute(),
  ]);

  return {
    brands: brandRows,
    categories: categoryRows,
    branches: branchRows,
    types: PRODUCT_TYPES.map((id) => ({ id, name: id.charAt(0) + id.slice(1).toLowerCase() })),
    placements: [
      { id: 'INT', name: 'Internal' },
      { id: 'EXT', name: 'External' },
    ],
    partTypes: [
      { id: 'CELL', name: 'Cell' },
      { id: 'COMPLETE_SET', name: 'Complete Set' },
      { id: 'OTHER', name: 'Other part' },
    ],
    settlementCycles: [
      { id: 'WEEKLY', name: 'Weekly' },
      { id: 'MONTHLY', name: 'Monthly' },
    ],
    cellTypes: cellTypeRows,
  };
}

/**
 * `idx_product_identity` — model + brand + type + placement, matched
 * case-insensitively (SPECS §3.4 rule 4).
 *
 * Mirrors the unique index the catalog-split migration put on the table, so a
 * clash surfaces as a readable message instead of a raw constraint violation.
 * The index is the guarantee; this is the courtesy.
 */
export async function findIdentityClash(
  name: string,
  brandId: number | null,
  type: ProductType,
  placement: ProductPlacement,
  excludeId?: number,
  executor = db,
) {
  let q = executor
    .selectFrom('product')
    .select('id')
    .where('name', 'ilike', name)
    .where('type', '=', type)
    .where('placement', '=', placement);

  q = brandId === null ? q.where('brand_id', 'is', null) : q.where('brand_id', '=', brandId);
  if (excludeId !== undefined) q = q.where('id', '!=', excludeId);

  return q.executeTakeFirst();
}

const IDENTITY_CLASH = (name: string) =>
  `A product matching "${name}" (same brand, type and placement) already exists`;

export async function createProduct(principal: Principal, input: ProductInput, outerTx?: Tx) {
  if (!principal.isSuperAdmin) throw forbidden('Only the super admin can edit the master catalog');

  const clash = await findIdentityClash(
    input.name,
    input.brandId ?? null,
    input.type,
    input.placement,
    undefined,
    outerTx ?? db,
  );
  if (clash) throw conflict(IDENTITY_CLASH(input.name));

  return inTransaction(outerTx, async (tx) => {
    const created = await tx
      .insertInto('product')
      .values({
        name: input.name,
        other_name: input.otherName ?? null,
        price: input.price,
        open_qty: '0',
        company_id: 0,
        brand_id: input.brandId ?? null,
        category_id: input.categoryId ?? null,
        unit_of_measure: input.unitOfMeasure ?? null,
        company_barcode: input.companyBarcode ?? null,
        brand_discount: '0',
        image_path: null,
        type: input.type,
        placement: input.placement,
        cell_type_id: input.cellTypeId ?? null,
        cell_count: input.cellCount ?? null,
        is_active: input.isActive,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Finish Product',
        action: 'New',
        detail: `Created product: ${created.name}, cost ${created.price}`,
        invId: created.id,
      },
      tx,
    );

    return created;
  });
}

export async function updateProduct(
  principal: Principal,
  id: number,
  input: ProductInput,
  outerTx?: Tx,
) {
  if (!principal.isSuperAdmin) throw forbidden('Only the super admin can edit the master catalog');

  const executor = outerTx ?? db;

  const existing = await executor
    .selectFrom('product')
    .select(['id', 'name', 'price'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound('Product');

  const clash = await findIdentityClash(
    input.name,
    input.brandId ?? null,
    input.type,
    input.placement,
    id,
    executor,
  );
  if (clash) throw conflict(IDENTITY_CLASH(input.name));

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .updateTable('product')
      .set({
        name: input.name,
        other_name: input.otherName ?? null,
        price: input.price,
        brand_id: input.brandId ?? null,
        category_id: input.categoryId ?? null,
        unit_of_measure: input.unitOfMeasure ?? null,
        company_barcode: input.companyBarcode ?? null,
        type: input.type,
        placement: input.placement,
        cell_type_id: input.cellTypeId ?? null,
        cell_count: input.cellCount ?? null,
        is_active: input.isActive,
        updated_at: new Date(),
        updated_by: principal.empId,
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

    await writeAudit(principal, { form: 'Finish Product', action: 'Edit', detail, invId: id }, tx);

    return row;
  });
}
