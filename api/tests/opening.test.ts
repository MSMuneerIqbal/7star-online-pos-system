/**
 * Opening balances (Phase 13) — opening stock posts Dr inventory / Cr owner
 * capital and a stock movement, so the stock report agrees with the shelves.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { closeDb, db } from '../src/core/db/index.js';
import { recordOpeningStock } from '../src/modules/opening/service.js';

const PRINCIPAL = { userId: 0, username: 'super', empId: 0, branchId: 0, roleId: null, isSuperAdmin: true };

afterAll(async () => {
  await closeDb();
});

describe('opening balances', () => {
  it('opening stock posts a balanced voucher and lands in the movement view', async () => {
    const suffix = Date.now();

    await db.insertInto('branch').values({ id: 9803, name: `OB ${suffix}`, code: `OB${suffix}`.slice(0, 10), type: 'BRANCH' }).execute();
    const product = await db
      .insertInto('product')
      .values({ name: `Battery ${suffix}`, price: '8000.00', type: 'NEW', placement: 'INT' })
      .returning('id')
      .executeTakeFirstOrThrow();

    let stockId: number | null = null;
    try {
      const s = await recordOpeningStock(PRINCIPAL, {
        date: '2026-01-01',
        branchId: 9803,
        kind: 'FINISH',
        pid: product.id,
        qty: '10',
        cost: '9000.00',
      });
      stockId = s.id;

      const legs = await db
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('inv_id', '=', s.id)
        .execute();
      expect(totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance).toBe('0.00');
      expect(legs.find((l) => l.account_id === ACC.INVENTORY_FINISH)?.dr).toBe('90000.00');
      expect(legs.find((l) => l.account_id === ACC.OWNER_CAPITAL)?.cr).toBe('90000.00');

      // The stock report sees 10 units.
      const mv = await sql<{ qty: string }>`
        SELECT SUM(qty)::text AS qty FROM stock_movement WHERE source = 'OPEN' AND pid = ${product.id}
      `.execute(db);
      expect(mv.rows[0]?.qty).toBe('10.000');
    } finally {
      if (stockId !== null) {
        await db.deleteFrom('transactions').where('inv_id', '=', stockId).execute();
        await db.deleteFrom('user_log').where('inv_id', '=', stockId).execute();
        await db.deleteFrom('opening_stock').where('id', '=', stockId).execute();
      }
      await db.deleteFrom('product').where('id', '=', product.id).execute();
      await db.deleteFrom('branch_product').where('branch_id', '=', 9803).execute();
      await db.deleteFrom('document_counter').where('branch_id', '=', 9803).execute();
      await db.deleteFrom('branch').where('id', '=', 9803).execute();
    }
  });
});
