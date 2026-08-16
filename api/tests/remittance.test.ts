/**
 * Remittance and inter-branch dues (Phase 6).
 *
 * The accounting rule is tested pure; the full create→confirm flow runs inside
 * `inRollback`.
 *
 * The earlier version of this file committed its rows and unwound them in a
 * `finally` that ran `DELETE FROM transactions WHERE inv_id = <id>` with no
 * `vtype`. `(vtype, inv_id)` is the real key — `inv_id` alone is only unique
 * within a voucher type — so once a test remittance's id reached a live sale's
 * id, that delete took the sale's ledger legs with it. It did: a sale was left
 * with no accounting behind it. Nothing here writes outside the transaction now.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postInterBranchDues, postRemittance } from '../src/accounting/rules/transfer.js';
import { closeDb } from '../src/core/db/index.js';
import { createRemittance, confirmRemittance, branchDues } from '../src/modules/remittance/service.js';
import { inRollback } from './helpers/rollback.js';

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const BRANCH_ACC = 1010600;
const BRANCH = 9702;

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
    await inRollback(async (tx) => {
      const warehouse = await tx
        .selectFrom('branch')
        .select('id')
        .where('type', '=', 'WAREHOUSE')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('branch')
        .values({
          id: BRANCH,
          name: 'Remittance Test Branch',
          code: 'RMTEST',
          type: 'BRANCH',
          inter_branch_account: BRANCH_ACC,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      await tx
        .insertInto('account')
        .values({
          name: 'Test Branch Due',
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

      const rem = await createRemittance(
        { ...PRINCIPAL, branchId: BRANCH, isSuperAdmin: false },
        { date: '2026-06-03', amount: '5000.00', method: 'CASH', toBranchId: warehouse.id },
        tx,
      );
      expect(rem.docNumber).toContain('RM');

      await confirmRemittance({ ...PRINCIPAL, branchId: warehouse.id }, rem.id, tx);

      const confirmed = await tx
        .selectFrom('remittance')
        .select('status')
        .where('id', '=', rem.id)
        .executeTakeFirst();
      expect(confirmed?.status).toBe('CONFIRMED');

      // Four legs: branch Dr due / Cr cash, warehouse Dr cash / Cr due.
      // Scoped by vtype as well as inv_id — the two together are the key.
      const legs = await tx
        .selectFrom('transactions')
        .select(['dr', 'cr'])
        .where('vtype', '=', 'IBDUE')
        .where('inv_id', '=', rem.id)
        .execute();
      expect(totals(legs.map((l) => ({ dr: l.dr, cr: l.cr }))).imbalance).toBe('0.00');
      expect(legs).toHaveLength(4);

      const dues = await branchDues(tx);
      const row = dues.find((d) => d.branchId === BRANCH);
      expect(row).toBeDefined();
      expect(Number(row!.remitted)).toBe(5000);
    });
  });

  it('refuses to confirm the same remittance twice', async () => {
    await inRollback(async (tx) => {
      const warehouse = await tx
        .selectFrom('branch')
        .select('id')
        .where('type', '=', 'WAREHOUSE')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('branch')
        .values({
          id: BRANCH,
          name: 'Remittance Test Branch',
          code: 'RMTEST',
          type: 'BRANCH',
          inter_branch_account: BRANCH_ACC,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      await tx
        .insertInto('account')
        .values({
          name: 'Test Branch Due',
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

      const rem = await createRemittance(
        { ...PRINCIPAL, branchId: BRANCH, isSuperAdmin: false },
        { date: '2026-06-03', amount: '5000.00', method: 'CASH', toBranchId: warehouse.id },
        tx,
      );

      await confirmRemittance({ ...PRINCIPAL, branchId: warehouse.id }, rem.id, tx);

      // Confirming twice would post the pair again and understate what the
      // branch still owes.
      await expect(
        confirmRemittance({ ...PRINCIPAL, branchId: warehouse.id }, rem.id, tx),
      ).rejects.toThrow(/already confirmed/i);
    });
  });
});
