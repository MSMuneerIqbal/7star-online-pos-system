/**
 * Excel import — the preview-before-commit machinery.
 *
 * This is the reusable import engine the old apps had and Phase 3 restores:
 * a spreadsheet is uploaded, parsed, and every row is classified NEW, UPDATE or
 * ERROR before anything is written. Bad rows are reported and skipped, never
 * half-imported. Quantities are added to existing stock, never replaced — that
 * rule matters the moment a quantity-bearing consumer points at this engine
 * (opening stock, Phase 11); raw items carry none yet, so this pass is
 * catalog-only.
 *
 * Raw items are the first consumer. The parse/classify framework here is
 * deliberately not raw-specific: Phase 11 will point products, customers and
 * opening stock at it rather than writing three more importers.
 */
import ExcelJS from 'exceljs';
import { db, withTransaction } from '../../core/db/index.js';
import { badRequest } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import type { Principal } from '../../core/rbac.js';
import type { RawPartType } from '../../core/db/types.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RawImportRow {
  name: string;
  partType: RawPartType;
  model: string | null;
  brand: string | null;
  category: string | null;
  placement: 'INT' | 'EXT' | null;
  cost: string;
  reorder: string;
  cellCapacityMah: number | null;
  cellVoltage: string | null;
  cellSize: string | null;
  cellBrand: string | null;
}

export interface PreviewRow {
  /** 1-based row number in the spreadsheet, for the operator to find the row. */
  rowNumber: number;
  status: 'NEW' | 'UPDATE' | 'ERROR';
  data: RawImportRow | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------

/** Canonical key for each accepted header, matched after normalising. */
const HEADER_MAP: Record<string, keyof RawImportRow | 'brand' | 'category'> = {
  name: 'name',
  parttype: 'partType',
  model: 'model',
  brand: 'brand',
  category: 'category',
  placement: 'placement',
  cost: 'cost',
  costprice: 'cost',
  price: 'cost',
  reorder: 'reorder',
  reorderlevel: 'reorder',
  cellcapacitymah: 'cellCapacityMah',
  cellcapacity: 'cellCapacityMah',
  cellvoltagev: 'cellVoltage',
  cellvoltage: 'cellVoltage',
  cellsize: 'cellSize',
  cellbrand: 'cellBrand',
};

const normalizeHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const obj = v as { text?: unknown; richText?: Array<{ text?: unknown }>; result?: unknown };
    if ('result' in obj) return String(obj.result ?? '');
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return obj.richText.map((r) => String(r.text ?? '')).join('');
    }
    if ('text' in obj) return String(obj.text ?? '');
  }
  return String(v);
}

/** Parse the first worksheet into `{ rowNumber, data }` keyed by canonical key. */
async function parseWorkbook(
  buffer: Buffer,
): Promise<Array<{ rowNumber: number; data: Record<string, string> }>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheet = wb.worksheets[0];
  if (!sheet) throw badRequest('The spreadsheet has no worksheet');

  const grid: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell);
    });
    grid.push(cells);
  });

  if (grid.length < 2) throw badRequest('The spreadsheet has no data rows');

  const keyByCol = grid[0]!.map((h) => HEADER_MAP[normalizeHeader(h)]);

  const out: Array<{ rowNumber: number; data: Record<string, string> }> = [];
  for (let i = 1; i < grid.length; i++) {
    const data: Record<string, string> = {};
    grid[i]!.forEach((cell, ci) => {
      const key = keyByCol[ci];
      if (key) data[key] = cell.trim();
    });
    out.push({ rowNumber: i + 1, data });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Normalisation and validation
// ---------------------------------------------------------------------------

function parsePartType(raw: string | undefined): { value?: RawPartType; error?: string } {
  const s = (raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (s === '' || s === 'other') return { value: 'OTHER' };
  if (s === 'cell' || s === 'cells') return { value: 'CELL' };
  if (s === 'completeset' || s === 'completesets') return { value: 'COMPLETE_SET' };
  return { error: `Unknown part type "${raw}"` };
}

function parsePlacement(raw: string | undefined): { value?: 'INT' | 'EXT' | null; error?: string } {
  const s = (raw ?? '').trim().toUpperCase();
  if (s === '') return { value: null };
  if (s === 'INT' || s === 'INTERNAL') return { value: 'INT' };
  if (s === 'EXT' || s === 'EXTERNAL') return { value: 'EXT' };
  return { error: `Unknown placement "${raw}"` };
}

function parseNonNegative(raw: string | undefined, label: string): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return '0';
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(n);
}

function parsePositiveInt(raw: string | undefined): number | null | 'INVALID' {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return 'INVALID';
  return n;
}

interface ImportContext {
  brandIds: Map<string, number>;
  categoryIds: Map<string, number>;
  rawByName: Map<string, number>;
}

/** Resolve one spreadsheet row into a validated RawImportRow (or a list of errors). */
function normalizeRow(
  data: Record<string, string>,
  ctx: ImportContext,
): { row: RawImportRow | null; errors: string[] } {
  const errors: string[] = [];

  const name = (data.name ?? '').trim();
  if (!name) errors.push('Name is required');

  const part = parsePartType(data.partType);
  if (part.error) errors.push(part.error);

  const placement = parsePlacement(data.placement);
  if (placement.error) errors.push(placement.error);

  const cost = parseNonNegative(data.cost, 'cost');
  if (cost === null) errors.push('Cost must be a non-negative number');

  const reorder = parseNonNegative(data.reorder, 'reorder');
  if (reorder === null) errors.push('Reorder must be a non-negative number');

  const cellCapacityMah = parsePositiveInt(data.cellCapacityMah);
  if (cellCapacityMah === 'INVALID') errors.push('Cell capacity (mAh) must be a positive whole number');

  const voltageRaw = (data.cellVoltage ?? '').trim();
  let cellVoltage: string | null = null;
  if (voltageRaw !== '') {
    const n = Number(voltageRaw);
    if (!Number.isFinite(n) || n < 0) errors.push('Cell voltage (V) must be a non-negative number');
    else cellVoltage = String(n);
  }

  let brand: string | null = null;
  let category: string | null = null;

  const brandName = (data.brand ?? '').trim();
  if (brandName) {
    const id = ctx.brandIds.get(brandName.toLowerCase());
    if (id === undefined) errors.push(`Unknown brand "${brandName}" — register it first`);
    else brand = brandName;
  }

  const categoryName = (data.category ?? '').trim();
  if (categoryName) {
    const id = ctx.categoryIds.get(categoryName.toLowerCase());
    if (id === undefined) errors.push(`Unknown category "${categoryName}" — register it first`);
    else category = categoryName;
  }

  if (errors.length > 0) {
    return { row: null, errors };
  }

  return {
    row: {
      name,
      partType: part.value ?? 'OTHER',
      model: (data.model ?? '').trim() || null,
      brand,
      category,
      placement: placement.value ?? null,
      cost: cost ?? '0',
      reorder: reorder ?? '0',
      cellCapacityMah: cellCapacityMah === 'INVALID' ? null : cellCapacityMah,
      cellVoltage,
      cellSize: (data.cellSize ?? '').trim() || null,
      cellBrand: (data.cellBrand ?? '').trim() || null,
    },
    errors: [],
  };
}

async function loadContext(): Promise<ImportContext> {
  const [raws, brands, categories] = await Promise.all([
    db.selectFrom('raw_product').select(['id', 'name']).execute(),
    db.selectFrom('brand').select(['id', 'name']).execute(),
    db.selectFrom('category').select(['id', 'name']).execute(),
  ]);

  const rawByName = new Map<string, number>();
  for (const r of raws) if (r.name) rawByName.set(r.name.trim().toLowerCase(), r.id);

  const brandIds = new Map<string, number>();
  for (const b of brands) if (b.name) brandIds.set(b.name.trim().toLowerCase(), b.id);

  const categoryIds = new Map<string, number>();
  for (const c of categories) if (c.name) categoryIds.set(c.name.trim().toLowerCase(), c.id);

  return { rawByName, brandIds, categoryIds };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/** Preview an upload: classify every row without writing anything. */
export async function previewRawImport(buffer: Buffer): Promise<{ rows: PreviewRow[] }> {
  const parsed = await parseWorkbook(buffer);
  const ctx = await loadContext();

  const rows: PreviewRow[] = parsed.map(({ rowNumber, data }) => {
    const { row, errors } = normalizeRow(data, ctx);

    if (!row) return { rowNumber, status: 'ERROR', data: null, errors };

    const existing = ctx.rawByName.get(row.name.toLowerCase());
    return {
      rowNumber,
      status: existing === undefined ? 'NEW' : 'UPDATE',
      data: row,
      errors,
    };
  });

  return { rows };
}

/**
 * Apply the accepted rows. The server re-validates and re-matches rather than
 * trusting the client's preview — the client only chooses WHICH rows to send.
 * Rows that fail validation here are skipped and reported, never written.
 */
export async function commitRawImport(
  principal: Principal,
  rows: RawImportRow[],
): Promise<{ created: number; updated: number; skipped: Array<{ name: string; errors: string[] }> }> {
  const ctx = await loadContext();

  let created = 0;
  let updated = 0;
  const skipped: Array<{ name: string; errors: string[] }> = [];

  await withTransaction(async (tx) => {
    for (const row of rows) {
      const { row: checked, errors } = normalizeRow(rowToData(row), ctx);

      if (!checked || errors.length > 0) {
        skipped.push({ name: row.name || '(blank)', errors });
        continue;
      }

      const brandId = checked.brand ? (ctx.brandIds.get(checked.brand.toLowerCase()) ?? null) : null;
      const catId = checked.category
        ? (ctx.categoryIds.get(checked.category.toLowerCase()) ?? null)
        : null;

      const existingId = ctx.rawByName.get(checked.name.toLowerCase());

      if (existingId === undefined) {
        const inserted = await tx
          .insertInto('raw_product')
          .values({
            ...rawColumns(checked, brandId, catId),
            is_active: true,
            created_by: principal.empId,
            updated_by: principal.empId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        // A later row in the same batch with the same name updates this one.
        ctx.rawByName.set(checked.name.toLowerCase(), inserted.id);
        created += 1;
      } else {
        // Updating a row leaves its active flag alone — a deactivated item is
        // not silently reactivated by a re-import.
        await tx
          .updateTable('raw_product')
          .set({
            ...rawColumns(checked, brandId, catId),
            updated_at: new Date(),
            updated_by: principal.empId,
          })
          .where('id', '=', existingId)
          .execute();
        updated += 1;
      }
    }

    if (created + updated > 0) {
      await writeAudit(
        principal,
        {
          form: 'Raw Item',
          action: 'Import',
          detail: `Imported raw items: ${created} new, ${updated} updated`,
          invId: 0,
        },
        tx,
      );
    }
  });

  return { created, updated, skipped };
}

/** A spreadsheet row, rebuilt back into the shape the validator reads. */
function rowToData(row: RawImportRow): Record<string, string> {
  return {
    name: row.name,
    partType: row.partType,
    model: row.model ?? '',
    brand: row.brand ?? '',
    category: row.category ?? '',
    placement: row.placement ?? '',
    cost: row.cost,
    reorder: row.reorder,
    cellCapacityMah: row.cellCapacityMah?.toString() ?? '',
    cellVoltage: row.cellVoltage ?? '',
    cellSize: row.cellSize ?? '',
    cellBrand: row.cellBrand ?? '',
  };
}

/** DB column values, with cell fields dropped for anything that is not a CELL. */
function rawColumns(row: RawImportRow, brandId: number | null, catId: number | null) {
  const isCell = row.partType === 'CELL';
  return {
    name: row.name,
    price: row.cost,
    reorder: row.reorder,
    brand_id: brandId,
    cat_id: catId,
    part_type: row.partType,
    model: row.model,
    placement: row.placement,
    cell_capacity_mah: isCell ? row.cellCapacityMah : null,
    cell_voltage: isCell ? row.cellVoltage : null,
    cell_size: isCell ? row.cellSize : null,
    cell_brand: isCell ? row.cellBrand : null,
  };
}

