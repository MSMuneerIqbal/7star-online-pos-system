/**
 * Production tests (Phase 4 — reshape).
 *
 * The posting rule is material-only now (no conversion cost), and the module is
 * the issue-to-worker → output flow. The rule is tested pure; the flow runs
 * inside `inRollback`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postProduction } from '../src/accounting/rules/production.js';
import { closeDb } from '../src/core/db/index.js';
import { createIssue, recordOutput } from '../src/modules/production/service.js';
import { inRollback } from './helpers/rollback.js';

const PRINCIPAL = {
  userId: 0,
  username: 'super',
  empId: 0,
  branchId: 0,
  roleId: null,
  isSuperAdmin: true,
};

const BRANCH = 9600;

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
    await inRollback(async (tx) => {
      // The branch's fan-out trigger creates the document counters the issue
      // number draws from. The posting accounts are fixed chart-of-accounts rows
      // that already exist.
      await tx
        .insertInto('branch')
        .values({ id: BRANCH, name: 'Production Test Branch', code: 'PRTEST' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const worker = await tx
        .insertInto('worker')
        .values({ name: 'Production Test Worker' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const cell = await tx
        .insertInto('raw_product')
        .values({ name: 'Production Test Cell', price: '1000.00' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const product = await tx
        .insertInto('product')
        .values({ name: 'Production Test Battery', price: '0.00', type: 'NEW', placement: 'INT' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const issue = await createIssue(
        PRINCIPAL,
        {
          date: '2026-06-01',
          workerId: worker.id,
          branchId: BRANCH,
          lines: [{ pid: cell.id, qty: '10' }],
        },
        tx,
      );
      expect(issue.docNumber).toMatch(/-\d+$/);

      const out = await recordOutput(
        PRINCIPAL,
        {
          issueId: issue.id,
          date: '2026-06-02',
          productId: product.id,
          qty: '8',
          damaged: [{ pid: cell.id, qty: '2', reason: 'broken tab' }],
        },
        tx,
      );

      // 10 cells at 1000 each = 10000 material, absorbed into 8 batteries.
      expect(out.perUnit).toBe('1250.00');
      expect(out.totalCost).toBe('10000.00');

      const updated = await tx
        .selectFrom('product')
        .select('price')
        .where('id', '=', product.id)
        .executeTakeFirst();
      expect(updated?.price).toBe('1250.00');

      const used = await tx
        .selectFrom('used_stock')
        .select('qty')
        .where('issue_id', '=', issue.id)
        .executeTakeFirst();
      expect(used?.qty).toBe('8.000');

      const damaged = await tx
        .selectFrom('damaged_stock')
        .select('qty')
        .where('issue_id', '=', issue.id)
        .executeTakeFirst();
      expect(damaged?.qty).toBe('2.000');

      // Damaged stock is a record, not an accounting entry (PRINCIPLES §4).
      const damageLegs = await tx
        .selectFrom('transactions')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('vtype', '=', 'PFINV')
        .where('inv_id', '=', issue.id)
        .executeTakeFirstOrThrow();
      expect(Number(damageLegs.n)).toBe(0);

      const legs = await tx
        .selectFrom('transactions')
        .select(['dr', 'cr'])
        .where('vtype', '=', 'PFINV')
        .where('inv_id', '=', out.id)
        .execute();
      expect(totals(legs.map((l) => ({ dr: l.dr, cr: l.cr }))).imbalance).toBe('0.00');
    });
  });
});
