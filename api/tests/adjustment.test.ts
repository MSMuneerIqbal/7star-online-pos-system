/**
 * Stock adjustment — the manual "increase / decrease" document.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postStockAdjustment } from '../src/accounting/rules/adjustment.js';
import { createAdjustmentInTx } from '../src/modules/adjustment/service.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const BRANCH = 9701;
const ACCOUNTS = [ACC.INVENTORY_FINISH, ACC.INVENTORY_RAW, ACC.STOCK_ADJUSTMENT];

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

describe('postStockAdjustment', () => {
  const base = { invId: 1, date: '2026-06-01', branchId: 2, kind: 'FINISH' as const };

  it('debets inventory for a surplus', () => {
    const j = postStockAdjustment({ ...base, value: '500.00' })!;
    expect(j.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH)?.dr).toBe('500.00');
    expect(j.legs.find((l) => l.accountId === ACC.STOCK_ADJUSTMENT)?.cr).toBe('500.00');
    expect(totals(j.legs).imbalance).toBe('0.00');
  });

  it('credits inventory for shrinkage', () => {
    const j = postStockAdjustment({ ...base, value: '-300.00' })!;
    expect(j.legs.find((l) => l.accountId === ACC.STOCK_ADJUSTMENT)?.dr).toBe('300.00');
    expect(j.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH)?.cr).toBe('300.00');
    expect(totals(j.legs).imbalance).toBe('0.00');
  });

  it('uses the raw inventory account for raw stock', () => {
    const j = postStockAdjustment({ ...base, kind: 'RAW', value: '100.00' })!;
    expect(j.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.dr).toBe('100.00');
  });

  it('returns null for a zero net value', () => {
    expect(postStockAdjustment({ ...base, value: '0.00' })).toBeNull();
  });
});

describe('createAdjustmentInTx', () => {
  async function seed(tx: Tx): Promise<{ pid: number }> {
    await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: ACCOUNTS });

    const product = await tx
      .insertInto('product')
      .values({ name: 'Adjustment Battery', price: '200.00', is_active: true })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('branch_product')
      .values({
        branch_id: BRANCH,
        product_id: product.id,
        selling_price: '300.00',
        minimum_price: '0.00',
        wholesale_cost: '150.00',
      })
      .onConflict((oc) => oc.columns(['branch_id', 'product_id']).doNothing())
      .execute();

    await tx
      .insertInto('document_counter')
      .values({ branch_id: BRANCH, doc_type: 'ADJUSTMENT', next_number: 1 })
      .onConflict((oc) => oc.columns(['branch_id', 'doc_type']).doNothing())
      .execute();

    return { pid: product.id };
  }

  it('increases stock and posts a balanced journal', async () => {
    await inRollback(async (tx) => {
      const { pid } = await seed(tx);

      const result = await createAdjustmentInTx(
        tx,
        PRINCIPAL,
        {
          date: '2026-06-01',
          kind: 'FINISH',
          branchId: BRANCH,
          reason: 'Physical count — found extra',
          lines: [{ pid, qty: '5' }],
        },
        BRANCH,
      );

      expect(result.id).toBeGreaterThan(0);

      const movements = await tx
        .selectFrom('stock_movement')
        .select(['qty', 'source'])
        .where('pid', '=', pid)
        .where('branch_id', '=', BRANCH)
        .execute();
      expect(movements.reduce((a, m) => a + Number(m.qty), 0)).toBe(5);
      expect(movements[0]?.source).toBe('ADJUST');

      // The journal balances.
      const ledger = await tx
        .selectFrom('transactions')
        .selectAll()
        .where('inv_id', '=', result.id)
        .where('vtype', '=', 'ADJINV')
        .execute();
      const legs = ledger.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }));
      expect(totals(legs).imbalance).toBe('0.00');
    });
  });

  it('decreases stock with a negative quantity', async () => {
    await inRollback(async (tx) => {
      const { pid } = await seed(tx);

      await createAdjustmentInTx(
        tx,
        PRINCIPAL,
        {
          date: '2026-06-01',
          kind: 'FINISH',
          branchId: BRANCH,
          reason: 'Physical count — missing',
          lines: [{ pid, qty: '-3' }],
        },
        BRANCH,
      );

      const movements = await tx
        .selectFrom('stock_movement')
        .select(['qty'])
        .where('pid', '=', pid)
        .where('branch_id', '=', BRANCH)
        .execute();
      expect(movements.reduce((a, m) => a + Number(m.qty), 0)).toBe(-3);
    });
  });
});
