/**
 * E-Store (Phase 10) — the branch ships, the warehouse accepts, and the branch's
 * dues fall by the wholesale value with nothing landing in branch sales.
 *
 * Runs inside `inRollback`. Nothing reaches the shared database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { closeDb } from '../src/core/db/index.js';
import { recordShipment, acceptShipment } from '../src/modules/estore/service.js';
import { inRollback } from './helpers/rollback.js';

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const BRANCH = 9802;
const BRANCH_ACC = 1010601;

afterAll(async () => {
  await closeDb();
});

/** The branch, its inter-branch account, and a product priced at wholesale. */
async function seedBranchWithStock(tx: Parameters<Parameters<typeof inRollback>[0]>[0]) {
  await tx
    .insertInto('branch')
    .values({
      id: BRANCH,
      name: 'E-Store Test Branch',
      code: 'ESTEST',
      type: 'BRANCH',
      inter_branch_account: BRANCH_ACC,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await tx
    .insertInto('account')
    .values({
      name: 'Test Estore Due',
      account_id: BRANCH_ACC,
      head_id: 1,
      sub_head_id: 1,
      head_code: 1,
      sub_code: 1,
      third: 5,
      is_fixed: false,
      branch_id: BRANCH,
    })
    .onConflict((oc) => oc.column('account_id').doNothing())
    .execute();

  const product = await tx
    .insertInto('product')
    .values({ name: 'E-Store Test Battery', price: '8000.00', type: 'NEW', placement: 'INT' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await tx
    .updateTable('branch_product')
    .set({ wholesale_cost: '10000.00' })
    .where('branch_id', '=', BRANCH)
    .where('product_id', '=', product.id)
    .execute();

  return product;
}

describe('E-Store', () => {
  it('a recorded and accepted shipment reduces stock and dues, not sales', async () => {
    await inRollback(async (tx) => {
      const product = await seedBranchWithStock(tx);

      const ship = await recordShipment(
        PRINCIPAL,
        {
          orderReference: 'WS-TEST-1',
          branchId: BRANCH,
          date: '2026-08-13',
          lines: [{ productId: product.id, qty: '1' }],
        },
        tx,
      );
      expect(ship.docNumber).toContain('ES');

      await acceptShipment(PRINCIPAL, ship.id, tx);

      const confirmed = await tx
        .selectFrom('estore_shipment')
        .select('status')
        .where('id', '=', ship.id)
        .executeTakeFirst();
      expect(confirmed?.status).toBe('ACCEPTED');

      const legs = await tx
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('inv_id', '=', ship.id)
        .execute();

      expect(
        totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance,
      ).toBe('0.00');

      // Dues fall by wholesale (Dr branch account 10000), inventory falls by
      // production cost (Cr 8000).
      expect(legs.find((l) => l.account_id === BRANCH_ACC)?.dr).toBe('10000.00');
      expect(legs.find((l) => l.account_id === ACC.INVENTORY_FINISH)?.cr).toBe('8000.00');
      expect(legs.find((l) => l.account_id === ACC.COGS)?.dr).toBe('8000.00');

      // It is not a branch sale — nothing lands in the day book (PRINCIPLES §7).
      const sales = await tx
        .selectFrom('sale')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('branch_id', '=', BRANCH)
        .executeTakeFirstOrThrow();
      expect(Number(sales.n)).toBe(0);
    });
  });

  it('refuses a second shipment against the same order reference', async () => {
    await inRollback(async (tx) => {
      const product = await seedBranchWithStock(tx);

      const input = {
        orderReference: 'WS-TEST-DUP',
        branchId: BRANCH,
        date: '2026-08-13',
        lines: [{ productId: product.id, qty: '1' }],
      };

      await recordShipment(PRINCIPAL, input, tx);

      // SPECS §11: the order reference is unique — a second shipment against it
      // is refused, or one website order ships twice.
      await expect(recordShipment(PRINCIPAL, input, tx)).rejects.toThrow();
    });
  });
});
