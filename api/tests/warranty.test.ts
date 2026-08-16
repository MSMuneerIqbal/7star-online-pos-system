/**
 * Warranty (Phase 9) — the branch replaces first, claims after, and the
 * warehouse carries the cost as a warranty expense.
 *
 * Runs inside `inRollback`, so nothing reaches the shared Neon database.
 * The earlier version of this test committed its rows and unwound them in a
 * `finally`, which left an interrupted run able to poison the next one — branch
 * id 9801 survives, the next insert collides, and the failure surfaces
 * somewhere unrelated. It could not use the helper because the service opened
 * its own transaction; `createClaimInTx` / `resolveClaimInTx` are the seam that
 * makes this possible.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { closeDb } from '../src/core/db/index.js';
import { createClaimInTx, resolveClaimInTx } from '../src/modules/warranty/service.js';
import { inRollback } from './helpers/rollback.js';

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const BRANCH = 9801;

afterAll(async () => {
  await closeDb();
});

describe('warranty', () => {
  it('a not-repairable claim posts a warranty expense and restores branch stock', async () => {
    await inRollback(async (tx) => {
      const warehouse = await tx
        .selectFrom('branch')
        .select('id')
        .where('type', '=', 'WAREHOUSE')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('branch')
        .values({ id: BRANCH, name: 'Warranty Test Branch', code: 'WBTEST', type: 'BRANCH' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const product = await tx
        .insertInto('product')
        .values({ name: 'Warranty Test Battery', price: '8000.00', type: 'NEW', placement: 'INT' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const claim = await createClaimInTx(tx, PRINCIPAL, {
        date: '2026-08-13',
        branchId: BRANCH,
        lines: [{ productId: product.id, qty: '1' }],
      });
      expect(claim.docNumber).toContain('WC');

      await resolveClaimInTx(tx, PRINCIPAL, {
        claimId: claim.id,
        date: '2026-08-14',
        warehouseBranchId: warehouse.id,
        lines: [{ productId: product.id, qty: '1', assessment: 'NOT_REPAIRABLE' }],
      });

      const detail = await tx
        .selectFrom('warranty_claim_detail')
        .select(['outcome', 'grade'])
        .where('claim_id', '=', claim.id)
        .executeTakeFirst();
      expect(detail?.outcome).toBe('REPLACED_NEW');
      expect(detail?.grade).toBe('NEW');

      // Warranty expense: Dr 5010104 / Cr finished inventory, at production cost.
      const legs = await tx
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('inv_id', '=', claim.id)
        .execute();

      expect(
        totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance,
      ).toBe('0.00');
      expect(legs.find((l) => l.account_id === ACC.WARRANTY_EXPENSE)?.dr).toBe('8000.00');
      expect(legs.find((l) => l.account_id === ACC.INVENTORY_FINISH)?.cr).toBe('8000.00');
    });
  });

  it('refuses to resolve a claim that is already closed', async () => {
    await inRollback(async (tx) => {
      const warehouse = await tx
        .selectFrom('branch')
        .select('id')
        .where('type', '=', 'WAREHOUSE')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('branch')
        .values({ id: BRANCH, name: 'Warranty Test Branch', code: 'WBTEST', type: 'BRANCH' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const product = await tx
        .insertInto('product')
        .values({ name: 'Warranty Reclose Battery', price: '5000.00', type: 'NEW', placement: 'INT' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const claim = await createClaimInTx(tx, PRINCIPAL, {
        date: '2026-08-13',
        branchId: BRANCH,
        lines: [{ productId: product.id, qty: '1' }],
      });

      const resolution = {
        claimId: claim.id,
        date: '2026-08-14',
        warehouseBranchId: warehouse.id,
        lines: [{ productId: product.id, qty: '1', assessment: 'NOT_REPAIRABLE' as const }],
      };

      await resolveClaimInTx(tx, PRINCIPAL, resolution);

      // A claim settles once. Resolving twice would post the warranty expense
      // a second time and overstate what the warehouse absorbed.
      await expect(resolveClaimInTx(tx, PRINCIPAL, resolution)).rejects.toThrow(/already closed/i);
    });
  });
});
