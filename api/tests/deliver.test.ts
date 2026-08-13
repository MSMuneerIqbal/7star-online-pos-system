/**
 * Deliver — approve, dispatch and receive a demand order in one step.
 *
 * The owner's workflow: a branch demands, the warehouse delivers, and the stock
 * lands on the branch's shelves without a separate receive step. This test
 * asserts the full economic effect in one rollback transaction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { deliverOrderInTx } from '../src/modules/demand-order/service.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const SHOP = 9602;
const SHOP_DUE_ACCOUNT = 1010503;

const ACCOUNTS = [ACC.INVENTORY_FINISH, ACC.INTER_BRANCH, ACC.INTER_BRANCH_DUE, SHOP_DUE_ACCOUNT];

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

afterAll(async () => {
  await closeDb();
});

async function warehouseId(tx: Tx): Promise<number> {
  const w = await tx
    .selectFrom('branch')
    .select('id')
    .where('type', '=', 'WAREHOUSE')
    .executeTakeFirst();
  if (!w) throw new Error('no warehouse branch in this database');
  return w.id;
}

async function seedShop(tx: Tx, warehouse: number): Promise<void> {
  // The shop branch, with its own "due to warehouse" account.
  await tx
    .insertInto('branch')
    .values({ id: SHOP, name: 'Test Shop', code: 'SH', type: 'BRANCH', inter_branch_account: SHOP_DUE_ACCOUNT })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  for (const [branchId, docType] of [
    [warehouse, 'DISPATCH'],
    [SHOP, 'RECEIPT'],
  ] as const) {
    await tx
      .insertInto('document_counter')
      .values({ branch_id: branchId, doc_type: docType, next_number: 1 })
      .onConflict((oc) => oc.columns(['branch_id', 'doc_type']).doNothing())
      .execute();
  }
}

async function seedOrder(tx: Tx, warehouse: number): Promise<{ orderId: number; pid: number }> {
  const product = await tx
    .insertInto('product')
    .values({ name: 'Test Battery DLVR', price: '100.00', is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  await tx
    .insertInto('branch_product')
    .values({
      branch_id: SHOP,
      product_id: product.id,
      selling_price: '150.00',
      minimum_price: '0.00',
      wholesale_cost: '0.00',
    })
    .onConflict((oc) => oc.columns(['branch_id', 'product_id']).doNothing())
    .execute();

  const order = await tx
    .insertInto('demand_order')
    .values({
      date: '2026-06-01',
      doc_number: 'WH-DO-1',
      from_branch: warehouse,
      to_branch: SHOP,
      type: 'FINISH',
      status: 'PENDING',
      gross: '500.00',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await tx
    .insertInto('demand_order_detail')
    .values({ inv_id: order.id, pid: product.id, pname: 'Test Battery DLVR', qty: '5', inv_qty: '0', price: '100.00', total: '500.00', status: 'PENDING' })
    .execute();

  return { orderId: order.id, pid: product.id };
}

describe('deliverOrder', () => {
  it('dispatches and receives in one step, landing stock on the branch shelves', async () => {
    await inRollback(async (tx) => {
      const warehouse = await warehouseId(tx);
      await seedLedgerFixtures(tx, { branchId: warehouse, accountIds: ACCOUNTS });
      await seedLedgerFixtures(tx, { branchId: SHOP, accountIds: ACCOUNTS });
      await seedShop(tx, warehouse);
      const { orderId, pid } = await seedOrder(tx, warehouse);

      const result = await deliverOrderInTx(tx, PRINCIPAL, { date: '2026-06-01', kind: 'FINISH', doId: orderId });

      expect(result.receivedId).toBeGreaterThan(0);

      // The branch now holds 5 units.
      const movements = await tx
        .selectFrom('stock_movement')
        .select(['pid', 'branch_id', 'qty', 'source'])
        .where('pid', '=', pid)
        .where('branch_id', '=', SHOP)
        .execute();
      const received = movements.reduce((acc, m) => acc + Number(m.qty), 0);
      expect(received).toBe(5);

      // Weighted-average wholesale cost is now the wholesale (cost) price.
      const bp = await tx
        .selectFrom('branch_product')
        .select('wholesale_cost')
        .where('branch_id', '=', SHOP)
        .where('product_id', '=', pid)
        .executeTakeFirstOrThrow();
      expect(Number(bp.wholesale_cost)).toBe(100);

      // Order and dispatch are both marked received.
      const order = await tx.selectFrom('demand_order').select('status').where('id', '=', orderId).executeTakeFirstOrThrow();
      expect(order.status).toBe('RECEIVED');

      const request = await tx.selectFrom('do_request').select('status').where('do_id', '=', orderId).executeTakeFirstOrThrow();
      expect(request.status).toBe('RECEIVED');

      // The warehouse was notified.
      const shopNote = await tx.selectFrom('notification').select('title').where('branch_id', '=', SHOP).executeTakeFirst();
      expect(shopNote?.title).toContain('delivered');
    });
  });

  it('refuses to deliver a branch-to-branch order (warehouse only)', async () => {
    await expect(
      inRollback(async (tx) => {
        const warehouse = await warehouseId(tx);
        await seedLedgerFixtures(tx, { branchId: warehouse, accountIds: ACCOUNTS });
        await seedLedgerFixtures(tx, { branchId: SHOP, accountIds: ACCOUNTS });
        await seedShop(tx, warehouse);

        const order = await tx
          .insertInto('demand_order')
          .values({
            date: '2026-06-01',
            doc_number: 'SH-DO-9',
            from_branch: SHOP,
            to_branch: warehouse,
            type: 'FINISH',
            status: 'PENDING',
            gross: '100.00',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return deliverOrderInTx(tx, PRINCIPAL, { date: '2026-06-01', kind: 'FINISH', doId: order.id });
      }),
    ).rejects.toThrow(/only the warehouse/i);
  });
});
