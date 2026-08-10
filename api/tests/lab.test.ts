/**
 * Lab posting.
 *
 * These rules were DESIGNED rather than ported — `LabController` had no Save
 * action, so there was nothing to port. The assertions below pin down the two
 * design decisions that matter, so a future change has to be deliberate.
 */
import { describe, expect, it } from 'vitest';
import { ACC, VTYPE } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import { postLabInvoice, postLabMaterials } from '../src/accounting/rules/lab.js';

const CUSTOMER_ACC = 1010299;

describe('lab materials', () => {
  const input = { invId: 5, date: '2026-07-01', branchId: 1, materialCost: '2400.00' };

  it('balances', () => {
    expect(totals(postLabMaterials(input).legs).imbalance).toBe('0.00');
  });

  it('takes material out of raw stock and expenses it', () => {
    const journal = postLabMaterials(input);

    expect(journal.legs.find((l) => l.accountId === ACC.COGS)?.dr).toBe('2400.00');
    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.cr).toBe('2400.00');
  });
});

describe('lab invoice', () => {
  const input = {
    invId: 9,
    date: '2026-07-02',
    branchId: 1,
    customerAccountId: CUSTOMER_ACC,
    customerLabel: 'Customer: Ali Traders',
    serviceCharge: '3500.00',
    received: '0.00',
  };

  it('balances', () => {
    const [invoice] = postLabInvoice(input);
    expect(totals(invoice!.legs).imbalance).toBe('0.00');
  });

  it('books repair income as SERVICE, not product sales', () => {
    // Design decision: lab work is a service, so the income statement keeps it
    // separate from battery sales.
    const [invoice] = postLabInvoice(input);

    expect(invoice!.legs.find((l) => l.accountId === ACC.SERVICE_INCOME)?.cr).toBe('3500.00');
    expect(invoice!.legs.some((l) => l.accountId === ACC.SALES)).toBe(false);
  });

  it("never touches inventory — the battery is the customer's, not ours", () => {
    const [invoice] = postLabInvoice(input);

    expect(invoice!.legs.some((l) => l.accountId === ACC.INVENTORY_FINISH)).toBe(false);
    expect(invoice!.legs.some((l) => l.accountId === ACC.INVENTORY_RAW)).toBe(false);
  });

  it('raises a receivable against the customer', () => {
    const [invoice] = postLabInvoice(input);
    expect(invoice!.legs.find((l) => l.accountId === CUSTOMER_ACC)?.dr).toBe('3500.00');
  });

  it('emits a separate balanced cash receipt when money is taken', () => {
    const journals = postLabInvoice({ ...input, received: '1500.00' });

    expect(journals).toHaveLength(2);
    expect(journals[1]!.vtype).toBe(VTYPE.CASH_RECEIPT);
    expect(totals(journals[1]!.legs).imbalance).toBe('0.00');
    expect(journals[1]!.legs.find((l) => l.accountId === ACC.CASH)?.dr).toBe('1500.00');
  });

  it('emits only the invoice when nothing is paid', () => {
    expect(postLabInvoice(input)).toHaveLength(1);
  });
});
