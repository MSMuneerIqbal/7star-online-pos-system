/**
 * Warranty (Phase 9) — the branch replaces first, claims after, and the
 * warehouse carries the cost as a warranty expense.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { closeDb, db } from '../src/core/db/index.js';
import { createClaim, resolveClaim } from '../src/modules/warranty/service.js';

const PRINCIPAL = { userId: 0, username: 'super', empId: 0, branchId: 0, roleId: null, isSuperAdmin: true };

afterAll(async () => {
  await closeDb();
});

describe('warranty', () => {
  it('a not-repairable claim posts a warranty expense and restores branch stock', async () => {
    const suffix = Date.now();
    const warehouse = await db.selectFrom('branch').select('id').where('type', '=', 'WAREHOUSE').executeTakeFirstOrThrow();

    await db.insertInto('branch').values({ id: 9801, name: `WBR ${suffix}`, code: `WB${suffix}`.slice(0, 10), type: 'BRANCH' }).execute();

    const product = await db
      .insertInto('product')
      .values({ name: `Battery ${suffix}`, price: '8000.00', type: 'NEW', placement: 'INT' })
      .returning('id')
      .executeTakeFirstOrThrow();

    let claimId: number | null = null;
    try {
      const claim = await createClaim(PRINCIPAL, {
        date: '2026-08-13',
        branchId: 9801,
        lines: [{ productId: product.id, qty: '1' }],
      });
      claimId = claim.id;
      expect(claim.docNumber).toContain('WC');

      await resolveClaim(PRINCIPAL, {
        claimId: claim.id,
        date: '2026-08-14',
        warehouseBranchId: warehouse.id,
        lines: [{ productId: product.id, qty: '1', assessment: 'NOT_REPAIRABLE' }],
      });

      const detail = await db
        .selectFrom('warranty_claim_detail')
        .select(['outcome', 'grade'])
        .where('claim_id', '=', claim.id)
        .executeTakeFirst();
      expect(detail?.outcome).toBe('REPLACED_NEW');
      expect(detail?.grade).toBe('NEW');

      // Warranty expense: Dr 5010104 / Cr finished inventory, at production cost.
      const legs = await db
        .selectFrom('transactions')
        .select(['account_id', 'dr', 'cr'])
        .where('inv_id', '=', claim.id)
        .execute();
      expect(totals(legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }))).imbalance).toBe('0.00');
      expect(legs.find((l) => l.account_id === ACC.WARRANTY_EXPENSE)?.dr).toBe('8000.00');
      expect(legs.find((l) => l.account_id === ACC.INVENTORY_FINISH)?.cr).toBe('8000.00');
    } finally {
      if (claimId !== null) {
        await db.deleteFrom('transactions').where('inv_id', '=', claimId).execute();
        await db.deleteFrom('user_log').where('inv_id', '=', claimId).execute();
        await db.deleteFrom('warranty_part').where('claim_id', '=', claimId).execute();
        await db.deleteFrom('warranty_claim_detail').where('claim_id', '=', claimId).execute();
        await db.deleteFrom('warranty_claim').where('id', '=', claimId).execute();
      }
      await db.deleteFrom('product').where('id', '=', product.id).execute();
      await db.deleteFrom('branch_product').where('branch_id', '=', 9801).execute();
      await db.deleteFrom('document_counter').where('branch_id', '=', 9801).execute();
      await db.deleteFrom('branch').where('id', '=', 9801).execute();
    }
  });
});
