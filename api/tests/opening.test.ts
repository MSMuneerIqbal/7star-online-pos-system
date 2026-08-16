/**
 * Opening balances (Phase 13) — opening stock posts Dr inventory / Cr owner
 * capital and a stock movement, so the stock report agrees with the shelves.
 *
 * Runs inside `inRollback`. Nothing reaches the shared database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { closeDb } from '../src/core/db/index.js';
import { recordOpeningStock } from '../src/modules/opening/service.js';
import { inRollback } from './helpers/rollback.js';

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const BRANCH = 9803;

afterAll(async () => {
  await closeDb();
});

describe('opening balances', () => {
  it('opening stock posts a balanced voucher and lands in the movement view', async () => {
    await inRollback(async (tx) => {
      await tx
        .insertInto('branch')
        .values({ id: BRANCH, name: 'Opening Test Branch', code: 'OBTEST', type: 'BRANCH' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const product = await tx
        .insertInto('product')
        .values({ name: 'Opening Test Battery', price: '8000.00', type: 'NEW', placement: 'INT' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const s = await recordOpeningStock(
        PRINCIPAL,
        {
          date: '2026-01-01',
          branchId: BRANCH,
          kind: 'FINISH',
          pid: product.id,
          qty: '10',
          cost: '9000.00',
        },
        tx,
      );

      const legs = await tx
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('vtype', '=', 'JV')
        .where('inv_id', '=', s.id)
        .execute();

      expect(
        totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance,
      ).toBe('0.00');
      expect(legs.find((l) => l.account_id === ACC.INVENTORY_FINISH)?.dr).toBe('90000.00');
      expect(legs.find((l) => l.account_id === ACC.OWNER_CAPITAL)?.cr).toBe('90000.00');

      // The stock report sees 10 units.
      const mv = await sql<{ qty: string }>`
        SELECT SUM(qty)::text AS qty FROM stock_movement WHERE source = 'OPEN' AND pid = ${product.id}
      `.execute(tx);
      expect(mv.rows[0]?.qty).toBe('10.000');
    });
  });
});
