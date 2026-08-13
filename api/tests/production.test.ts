/**
 * Production tests (Phase 4 — reshape).
 *
 * The posting rule is material-only now (no conversion cost), and the module is
 * the issue-to-worker → output flow. The rule is tested pure; the flow is tested
 * against real Postgres and cleans up after itself.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postProduction } from '../src/accounting/rules/production.js';
import { closeDb, db } from '../src/core/db/index.js';
import { createIssue, recordOutput } from '../src/modules/production/service.js';

const PRINCIPAL = { userId: 0, username: 'super', empId: 0, branchId: 0, roleId: null, isSuperAdmin: true };

afterAll(async () => {
  await closeDb();
});

describe('production posting', () => {
  it('capitalises finished goods at material cost only — no conversion leg', () => {
    const journal = postProduction({
      invId: 1,
      date: '2026-06-01',
      branchId: 1,
      productName: 'Battery 12V 150Ah',
      materialCost: '12000.00',
    });

    expect(totals(journal.legs).imbalance).toBe('0.00');
    expect(journal.legs).toHaveLength(2);
    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH)?.dr).toBe('12000.00');
    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.cr).toBe('12000.00');
  });
});

describe('issue → output flow', () => {
  it('issues a cart, records output, absorbs damage, and prices the product', async () => {
    const suffix = Date.now();
    const branchId = 9600;

    // A real branch, committed — its fan-out trigger creates the document
    // counters the issue number draws from. The posting accounts are fixed
    // chart-of-accounts rows that already exist.
    await db
      .insertInto('branch')
      .values({ id: branchId, name: `Production Branch ${suffix}`, code: `T${branchId}` })
      .execute();

    const worker = await db
      .insertInto('worker')
      .values({ name: `Worker ${suffix}` })
      .returning('id')
      .executeTakeFirstOrThrow();

    const cell = await db
      .insertInto('raw_product')
      .values({ name: `Cell ${suffix}`, price: '1000.00' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const product = await db
      .insertInto('product')
      .values({ name: `Battery ${suffix}`, price: '0.00', type: 'NEW', placement: 'INT' })
      .returning('id')
      .executeTakeFirstOrThrow();

    let issueId: number | null = null;
    let outputId: number | null = null;

    try {
      const issue = await createIssue(PRINCIPAL, {
        date: '2026-06-01',
        workerId: worker.id,
        branchId,
        lines: [{ pid: cell.id, qty: '10' }],
      });
      issueId = issue.id;
      expect(issue.docNumber).toMatch(/-\d+$/);

      const out = await recordOutput(PRINCIPAL, {
        issueId: issue.id,
        date: '2026-06-02',
        productId: product.id,
        qty: '8',
        damaged: [{ pid: cell.id, qty: '2', reason: 'broken tab' }],
      });
      outputId = out.id;

      // 10 cells at 1000 each = 10000 material, absorbed into 8 batteries.
      expect(out.perUnit).toBe('1250.00');
      expect(out.totalCost).toBe('10000.00');

      const updated = await db
        .selectFrom('product')
        .select('price')
        .where('id', '=', product.id)
        .executeTakeFirst();
      expect(updated?.price).toBe('1250.00');

      const used = await db
        .selectFrom('used_stock')
        .select('qty')
        .where('issue_id', '=', issue.id)
        .executeTakeFirst();
      expect(used?.qty).toBe('8.000');

      const damaged = await db
        .selectFrom('damaged_stock')
        .select('qty')
        .where('issue_id', '=', issue.id)
        .executeTakeFirst();
      expect(damaged?.qty).toBe('2.000');

      const legs = await db
        .selectFrom('transactions')
        .select(['dr', 'cr'])
        .where('inv_id', '=', out.id)
        .execute();
      expect(totals(legs.map((l) => ({ dr: l.dr, cr: l.cr }))).imbalance).toBe('0.00');
    } finally {
      // Scope by the production voucher type — document ids are not unique
      // across tables, so a bare inv_id match could hit a stale test row.
      if (outputId !== null) {
        await db
          .deleteFrom('transactions')
          .where('vtype', '=', 'PFINV')
          .where('inv_id', '=', outputId)
          .execute();
      }
      if (issueId !== null) {
        await db.deleteFrom('damaged_stock').where('issue_id', '=', issueId).execute();
        await db.deleteFrom('used_stock').where('issue_id', '=', issueId).execute();
        await db.deleteFrom('production_output').where('issue_id', '=', issueId).execute();
        await db.deleteFrom('production_issue_detail').where('issue_id', '=', issueId).execute();
        await db.deleteFrom('production_issue').where('id', '=', issueId).execute();
        await db.deleteFrom('user_log').where('inv_id', '=', issueId).execute();
      }
      if (outputId !== null) await db.deleteFrom('user_log').where('inv_id', '=', outputId).execute();
      await db.deleteFrom('product').where('id', '=', product.id).execute();
      await db.deleteFrom('raw_product').where('id', '=', cell.id).execute();
      await db.deleteFrom('worker').where('id', '=', worker.id).execute();
      await db.deleteFrom('branch_product').where('branch_id', '=', branchId).execute();
      await db.deleteFrom('document_counter').where('branch_id', '=', branchId).execute();
      await db.deleteFrom('branch').where('id', '=', branchId).execute();
    }
  });
});
