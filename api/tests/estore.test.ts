/**
 * E-Store (Phase 10) — the branch ships, the warehouse accepts, and the branch's
 * dues fall by the wholesale value with nothing landing in branch sales.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { closeDb, db } from '../src/core/db/index.js';
import { recordShipment, acceptShipment } from '../src/modules/estore/service.js';

const PRINCIPAL = { userId: 0, username: 'super', empId: 0, branchId: 0, roleId: null, isSuperAdmin: true };

afterAll(async () => {
  await closeDb();
});

describe('E-Store', () => {
  it('a recorded and accepted shipment reduces stock and dues, not sales', async () => {
    const suffix = Date.now();

    await db.insertInto('branch').values({ id: 9802, name: `EB ${suffix}`, code: `EB${suffix}`.slice(0, 10), type: 'BRANCH', inter_branch_account: 1010601 }).execute();
    await db
      .insertInto('account')
      .values({ name: 'Test Estore Due', account_id: 1010601, head_id: 1, sub_head_id: 1, head_code: 1, sub_code: 1, third: 5, is_fixed: false, branch_id: 9802 })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();

    const product = await db
      .insertInto('product')
      .values({ name: `Battery ${suffix}`, price: '8000.00', type: 'NEW', placement: 'INT' })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .updateTable('branch_product')
      .set({ wholesale_cost: '10000.00' })
      .where('branch_id', '=', 9802)
      .where('product_id', '=', product.id)
      .execute();

    let shipmentId: number | null = null;
    try {
      const ship = await recordShipment(PRINCIPAL, {
        orderReference: `WS-${suffix}`,
        branchId: 9802,
        date: '2026-08-13',
        lines: [{ productId: product.id, qty: '1' }],
      });
      shipmentId = ship.id;
      expect(ship.docNumber).toContain('ES');

      await acceptShipment(PRINCIPAL, ship.id);

      const confirmed = await db.selectFrom('estore_shipment').select('status').where('id', '=', ship.id).executeTakeFirst();
      expect(confirmed?.status).toBe('ACCEPTED');

      const legs = await db
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('inv_id', '=', ship.id)
        .execute();
      expect(totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance).toBe('0.00');

      // Dues fall by wholesale (Dr branch account 10000), inventory falls by production cost (Cr 8000).
      expect(legs.find((l) => l.account_id === 1010601)?.dr).toBe('10000.00');
      expect(legs.find((l) => l.account_id === ACC.INVENTORY_FINISH)?.cr).toBe('8000.00');
      expect(legs.find((l) => l.account_id === ACC.COGS)?.dr).toBe('8000.00');
    } finally {
      if (shipmentId !== null) {
        await db.deleteFrom('transactions').where('inv_id', '=', shipmentId).execute();
        await db.deleteFrom('user_log').where('inv_id', '=', shipmentId).execute();
        await db.deleteFrom('estore_shipment_detail').where('shipment_id', '=', shipmentId).execute();
        await db.deleteFrom('estore_shipment').where('id', '=', shipmentId).execute();
      }
      await db.deleteFrom('account').where('account_id', '=', 1010601).execute();
      await db.deleteFrom('product').where('id', '=', product.id).execute();
      await db.deleteFrom('branch_product').where('branch_id', '=', 9802).execute();
      await db.deleteFrom('document_counter').where('branch_id', '=', 9802).execute();
      await db.deleteFrom('branch').where('id', '=', 9802).execute();
    }
  });
});
