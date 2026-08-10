/**
 * Production posting.
 *
 * A FIX, not a port: the legacy version posted a lone debit to finished goods
 * with no credit anywhere, so raw material was never consumed and conversion
 * cost was never funded (db/accounts.md §4.6).
 */
import { describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postProduction } from '../src/accounting/rules/production.js';

const base = {
  invId: 1,
  date: '2026-06-01',
  branchId: 1,
  productName: 'Battery 12V 150Ah',
  materialCost: '12000.00',
  labourCost: '2000.00',
  electricCost: '800.00',
  otherCost: '200.00',
  totalCost: '15000.00',
  conversionPaidInCash: true,
};

describe('production posting', () => {
  it('balances — the legacy version posted a single debit', () => {
    const journal = postProduction(base);
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('consumes raw material and capitalises finished goods', () => {
    const journal = postProduction(base);

    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH)?.dr).toBe('15000.00');
    // The legacy version never credited this, so raw stock was never consumed.
    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.cr).toBe('12000.00');
  });

  it('funds the conversion cost, which the legacy version left dangling', () => {
    const journal = postProduction(base);

    // labour 2000 + electricity 800 + other 200
    expect(journal.legs.find((l) => l.accountId === ACC.CASH)?.cr).toBe('3000.00');
  });

  it('accrues conversion cost instead of paying it when told to', () => {
    const journal = postProduction({ ...base, conversionPaidInCash: false });

    expect(journal.legs.some((l) => l.accountId === ACC.CASH)).toBe(false);
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('handles production with no conversion cost at all', () => {
    const journal = postProduction({
      ...base,
      labourCost: '0.00',
      electricCost: '0.00',
      otherCost: '0.00',
      totalCost: '12000.00',
    });

    expect(journal.legs).toHaveLength(2);
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('rejects a total that does not reconcile with its parts', () => {
    // Catches a miscalculated form before it capitalises stock at the wrong
    // value — the legacy system posted whatever total it was handed.
    expect(() => postProduction({ ...base, totalCost: '99999.00' })).toThrow(
      /does not reconcile/i,
    );
  });

  it('reproduces the legacy imbalance for comparison', () => {
    const legacy = [
      { accountId: ACC.INVENTORY_FINISH, dr: '15000.00', cr: '0.00', detail: '' },
    ];

    // Every production run inflated assets by the full cost of the goods.
    expect(totals(legacy).imbalance).toBe('15000.00');
  });
});
