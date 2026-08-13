/**
 * Remittance and inter-branch dues (Phase 6).
 *
 * The accounting rule is tested pure; the full create→confirm flow is tested
 * against real Postgres and cleans up after itself.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postInterBranchDues, postRemittance } from '../src/accounting/rules/transfer.js';
import { closeDb, db } from '../src/core/db/index.js';
import { createRemittance, confirmRemittance, branchDues } from '../src/modules/remittance/service.js';

const PRINCIPAL = { userId: 0, username: 'super', empId: 0, branchId: 0, roleId: null, isSuperAdmin: true };

const BRANCH_ACC = 1010600;

afterAll(async () => {
  await closeDb();
});

describe('inter-branch dues posting', () => {
  it('balances — Dr warehouse due / Cr branch due', () => {
    const journal = postInterBranchDues({
      invId: 1,
      date: '2026-06-01',
      branchId: 4,
      warehouseAccountId: ACC.INTER_BRANCH_DUE,
      branchAccountId: BRANCH_ACC,
      value: '12000.00',
    });

    expect(totals(journal.legs).imbalance).toBe('0.00');
    expect(journal.legs.find((l) => l.accountId === ACC.INTER_BRANCH_DUE)?.dr).toBe('12000.00');
    expect(journal.legs.find((l) => l.accountId === BRANCH_ACC)?.cr).toBe('12000.00');
  });
});

describe('remittance posting', () => {
  it('posts two balanced vouchers and nets the inter-branch pair', () => {
    const [branchVoucher, warehouseVoucher] = postRemittance({
      invId: 2,
      date: '2026-06-02',
      branchId: 4,
      warehouseBranchId: 1,
      branchAccountId: BRANCH_ACC,
      warehouseAccountId: ACC.INTER_BRANCH_DUE,
      amount: '5000.00',
      method: 'CASH',
    });

    expect(totals(branchVoucher.legs).imbalance).toBe('0.00');
    expect(totals(warehouseVoucher.legs).imbalance).toBe('0.00');

    // Branch side: owes less (Dr branch account), cash out (Cr cash).
    expect(branchVoucher.legs.find((l) => l.accountId === BRANCH_ACC)?.dr).toBe('5000.00');
    expect(branchVoucher.legs.find((l) => l.accountId === ACC.CASH)?.cr).toBe('5000.00');
    // Warehouse side: cash in (Dr cash), owed less (Cr warehouse account).
    expect(warehouseVoucher.legs.find((l) => l.accountId === ACC.CASH)?.dr).toBe('5000.00');
    expect(warehouseVoucher.legs.find((l) => l.accountId === ACC.INTER_BRANCH_DUE)?.cr).toBe('5000.00');
  });
});

describe('remittance flow', () => {
  it('creates and confirms a remittance, moving the balance', async () => {
    const suffix = Date.now();

    const warehouse = await db.selectFrom('branch').select('id').where('type', '=', 'WAREHOUSE').executeTakeFirstOrThrow();

    await db.insertInto('branch').values({ id: 9702, name: `BR ${suffix}`, code: `BR${suffix}`.slice(0, 10), type: 'BRANCH', inter_branch_account: BRANCH_ACC }).execute();

    // The branch's inter-branch account — a real committed account the posting references.
    await db
      .insertInto('account')
      .values({ name: 'Test Branch Due', account_id: BRANCH_ACC, head_id: 1, sub_head_id: 1, head_code: 1, sub_code: 1, third: 5, is_fixed: false, branch_id: 9702 })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();

    let remId: number | null = null;

    try {
      const rem = await createRemittance(
        { ...PRINCIPAL, branchId: 9702, isSuperAdmin: false },
        { date: '2026-06-03', amount: '5000.00', method: 'CASH', toBranchId: warehouse.id },
      );
      remId = rem.id;
      expect(rem.docNumber).toContain('RM');

      await confirmRemittance({ ...PRINCIPAL, branchId: warehouse.id }, rem.id);

      const confirmed = await db.selectFrom('remittance').select('status').where('id', '=', rem.id).executeTakeFirst();
      expect(confirmed?.status).toBe('CONFIRMED');

      // Four legs: branch Dr due / Cr cash, warehouse Dr cash / Cr due.
      const legs = await db.selectFrom('transactions').select(['dr', 'cr']).where('inv_id', '=', rem.id).execute();
      expect(totals(legs.map((l) => ({ dr: l.dr, cr: l.cr }))).imbalance).toBe('0.00');
      expect(legs).toHaveLength(4);

      const dues = await branchDues();
      const row = dues.find((d) => d.branchId === 9702);
      expect(row).toBeDefined();
      expect(Number(row!.remitted)).toBe(5000);
    } finally {
      if (remId !== null) {
        await db.deleteFrom('transactions').where('inv_id', '=', remId).execute();
        await db.deleteFrom('user_log').where('inv_id', '=', remId).execute();
        await db.deleteFrom('remittance').where('id', '=', remId).execute();
      }
      await db.deleteFrom('account').where('account_id', '=', BRANCH_ACC).execute();
      await db.deleteFrom('branch_product').where('branch_id', '=', 9702).execute();
      await db.deleteFrom('document_counter').where('branch_id', '=', 9702).execute();
      await db.deleteFrom('branch').where('id', '=', 9702).execute();
    }
  });
});
