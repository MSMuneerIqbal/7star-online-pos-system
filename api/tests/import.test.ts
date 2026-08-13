/**
 * Import tests (Phase 3) — the preview-before-commit machinery.
 *
 * The preview path is read-only and asserted directly. The commit path really
 * commits (it runs its own transaction), so it cleans up after itself in a
 * finally block, matching catalog.test.ts's own convention.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/core/auth/tokens.js';
import { closeDb, db } from '../src/core/db/index.js';
import { commitRawImport, previewRawImport, type RawImportRow } from '../src/modules/import/service.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

const SUPER: Parameters<typeof commitRawImport>[0] = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

async function buildWorkbook(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellRow(name: string, cost: string): RawImportRow {
  return {
    name,
    partType: 'CELL',
    model: null,
    brand: null,
    category: null,
    placement: 'INT',
    cost,
    reorder: '0',
    cellCapacityMah: 2000,
    cellVoltage: '3.7',
    cellSize: '18650',
    cellBrand: 'LG',
  };
}

describe('previewRawImport', () => {
  it('classifies NEW, UPDATE and ERROR rows without writing anything', async () => {
    const existing = await db
      .insertInto('raw_product')
      .values({ name: 'Existing Cell', price: '10' })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const buf = await buildWorkbook([
        ['Name', 'Part Type', 'Model', 'Cost', 'Cell Capacity (mAh)', 'Cell Voltage (V)', 'Cell Size', 'Cell Brand'],
        ['New Cell', 'Cell', 'NC1', '250', '2200', '3.7', '18650', 'Samsung'],
        ['Existing Cell', 'Cell', '', '12', '', '', '', ''],
        ['Bad Cost', 'Cell', '', '-5', '', '', '', ''],
        ['', '', '', '1', '', '', '', ''],
      ]);

      const { rows } = await previewRawImport(buf);

      expect(rows).toHaveLength(4);
      expect(rows[0]!.status).toBe('NEW');
      expect(rows[0]!.data?.partType).toBe('CELL');
      expect(rows[0]!.data?.cellCapacityMah).toBe(2200);
      expect(rows[1]!.status).toBe('UPDATE');
      expect(rows[2]!.status).toBe('ERROR');
      expect(rows[2]!.errors).toContain('Cost must be a non-negative number');
      expect(rows[3]!.status).toBe('ERROR');
      expect(rows[3]!.errors).toContain('Name is required');
    } finally {
      await db.deleteFrom('raw_product').where('id', '=', existing.id).execute();
    }
  });
});

describe('commitRawImport', () => {
  it('inserts new rows, updates matches and skips invalid rows', async () => {
    const suffix = Date.now();
    const existingName = `Commit Existing ${suffix}`;

    const existing = await db
      .insertInto('raw_product')
      .values({ name: existingName, price: '5' })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const res = await commitRawImport(SUPER, [
        cellRow(`Commit New ${suffix}`, '100'),
        { ...cellRow(existingName, '9'), partType: 'OTHER' },
        cellRow(`Commit Bad ${suffix}`, '-1'),
      ]);

      expect(res.created).toBe(1);
      expect(res.updated).toBe(1);
      expect(res.skipped).toHaveLength(1);
      expect(res.skipped[0]!.errors).toContain('Cost must be a non-negative number');

      const created = await db
        .selectFrom('raw_product')
        .selectAll()
        .where('name', '=', `Commit New ${suffix}`)
        .executeTakeFirst();
      expect(created?.part_type).toBe('CELL');
      expect(created?.cell_capacity_mah).toBe(2000);
      expect(created?.cell_brand).toBe('LG');

      const updated = await db
        .selectFrom('raw_product')
        .selectAll()
        .where('name', '=', existingName)
        .executeTakeFirst();
      expect(updated?.price).toBe('9.00');
      expect(updated?.part_type).toBe('OTHER');
      // Cell fields dropped on the non-CELL update.
      expect(updated?.cell_brand).toBeNull();
    } finally {
      await db.deleteFrom('raw_product').where('name', 'like', `Commit %${suffix}`).execute();
      await db.deleteFrom('raw_product').where('id', '=', existing.id).execute();
      await db.deleteFrom('user_log').where('action', '=', 'Import').execute();
    }
  });
});

describe('import route guard', () => {
  it('rejects a non-super-admin on both endpoints', async () => {
    const token = await signAccessToken({
      sub: '999999',
      username: 'branch-user',
      empId: 999999,
      branchId: 1,
      roleId: null,
      isSuperAdmin: false,
    });

    const commit = await app.inject({
      method: 'POST',
      url: '/api/v1/import/raw-products/commit',
      headers: { authorization: `Bearer ${token}` },
      payload: { rows: [{ name: 'X', partType: 'OTHER' }] },
    });
    expect(commit.statusCode).toBe(403);

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/import/raw-products/preview',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(preview.statusCode).toBe(403);
  });
});

describe('template route', () => {
  it('serves an xlsx sample to a super admin', async () => {
    const token = await signAccessToken({
      sub: '0',
      username: 'super',
      empId: 0,
      branchId: 0,
      roleId: null,
      isSuperAdmin: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/import/template/raw-item',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.rawPayload.length).toBeGreaterThan(100);
  });

  it('rejects a request without the view grant', async () => {
    const token = await signAccessToken({
      sub: '999999',
      username: 'branch-user',
      empId: 999999,
      branchId: 1,
      roleId: null,
      isSuperAdmin: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/import/template/raw-item',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
  });
});
