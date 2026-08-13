import { describe, expect, it } from 'vitest';
import { ACC, VTYPE, headOf, isDebitNormal } from '../src/accounting/accounts.js';
import {
  buildJournal,
  credit,
  debit,
  fmt,
  isBalanced,
  reverse,
  totals,
} from '../src/accounting/journal.js';
import { postSale, postSaleReturn } from '../src/accounting/rules/sale.js';
import { postPurchase, postPurchaseReturn } from '../src/accounting/rules/purchase.js';
import { postVoucher } from '../src/accounting/rules/voucher.js';
import { add, sub } from '../src/core/money.js';

// ---------------------------------------------------------------------------

describe('journal invariants', () => {
  const base = { vtype: VTYPE.JOURNAL, date: '2026-01-15', invId: 1, branchId: 1 } as const;

  it('accepts a balanced journal', () => {
    const j = buildJournal({
      ...base,
      legs: [debit(ACC.CASH, '100.00', 'in'), credit(ACC.SALES, '100.00', 'out')],
    });

    expect(isBalanced(j.legs)).toBe(true);
    expect(totals(j.legs)).toEqual({
      debits: '100.00',
      credits: '100.00',
      imbalance: '0.00',
    });
  });

  it('rejects an unbalanced journal', () => {
    expect(() =>
      buildJournal({
        ...base,
        legs: [debit(ACC.CASH, '100.00', 'in'), credit(ACC.SALES, '99.99', 'out')],
      }),
    ).toThrow(/does not balance/i);
  });

  it('rejects an empty journal', () => {
    expect(() => buildJournal({ ...base, legs: [] })).toThrow(/no legs/i);
  });

  it('rejects a leg that is both a debit and a credit', () => {
    expect(() =>
      buildJournal({
        ...base,
        legs: [
          { accountId: ACC.CASH, dr: '50.00', cr: '50.00', detail: 'both' },
          credit(ACC.SALES, '0.01', 'x'),
        ],
      }),
    ).toThrow(/two-sided/i);
  });

  it('rejects a zero-value leg', () => {
    expect(() =>
      buildJournal({
        ...base,
        legs: [
          { accountId: ACC.CASH, dr: '0.00', cr: '0.00', detail: 'empty' },
          debit(ACC.CASH, '1.00', 'a'),
          credit(ACC.SALES, '1.00', 'b'),
        ],
      }),
    ).toThrow(/empty/i);
  });

  it('rejects negative amounts rather than silently inverting them', () => {
    expect(() =>
      buildJournal({
        ...base,
        legs: [debit(ACC.CASH, '-100.00', 'neg'), credit(ACC.SALES, '-100.00', 'neg')],
      }),
    ).toThrow(/negative/i);
  });

  it('reverses a journal, swapping every side', () => {
    const j = buildJournal({
      ...base,
      legs: [debit(ACC.CASH, '250.00', 'received'), credit(ACC.SALES, '250.00', 'earned')],
    });

    const r = reverse(j);

    expect(r.legs[0]).toMatchObject({ accountId: ACC.CASH, dr: '0.00', cr: '250.00' });
    expect(r.legs[1]).toMatchObject({ accountId: ACC.SALES, dr: '250.00', cr: '0.00' });
    expect(isBalanced(r.legs)).toBe(true);
    expect(r.legs[0]!.detail).toMatch(/^REVERSAL/);
  });
});

// ---------------------------------------------------------------------------

describe('sale posting', () => {
  const sale = {
    invId: 501,
    date: '2026-01-15',
    branchId: 2,
    customerAccountId: 1010205,
    customerLabel: 'Customer: Ali Traders',
    grossTotal: '1030.00',
    discount: '50.00',
    service: '20.00',
    netTotal: '1000.00',
    cogs: '800.00',
    received: '0.00',
  };

  it('balances — the exact case the legacy system got wrong', () => {
    // Legacy: Dr - Cr = discount - service = 50 - 20 = 30.00
    const [invoice] = postSale(sale);

    expect(totals(invoice!.legs).imbalance).toBe('0.00');
  });

  it('credits sales at gross, not net', () => {
    const [invoice] = postSale(sale);
    const salesLeg = invoice!.legs.find((l) => l.accountId === ACC.SALES);

    // The legacy bug was crediting net_total (1000.00) here.
    expect(salesLeg?.cr).toBe('1030.00');
  });

  it('balances across every discount/service combination', () => {
    const cases = [
      { discount: '0.00', service: '0.00' },
      { discount: '50.00', service: '0.00' },
      { discount: '0.00', service: '20.00' },
      { discount: '50.00', service: '20.00' },
      { discount: '999.99', service: '0.01' },
    ];

    for (const { discount, service } of cases) {
      const gross = '1000.00';
      // Decimal arithmetic, not floats — the same rule the engine follows.
      const net = sub(add(gross, service), discount);

      const [invoice] = postSale({ ...sale, grossTotal: gross, discount, service, netTotal: net });

      expect(totals(invoice!.legs).imbalance, `discount ${discount} service ${service}`).toBe(
        '0.00',
      );
    }
  });

  it('omits discount and service legs when zero', () => {
    const [invoice] = postSale({
      ...sale,
      grossTotal: '1000.00',
      discount: '0.00',
      service: '0.00',
      netTotal: '1000.00',
    });

    expect(invoice!.legs.some((l) => l.accountId === ACC.SALES_DISCOUNT)).toBe(false);
    expect(invoice!.legs.some((l) => l.accountId === ACC.SERVICE_INCOME)).toBe(false);
  });

  it('emits a separate balanced cash-receipt voucher when money is taken', () => {
    const journals = postSale({ ...sale, received: '400.00' });

    expect(journals).toHaveLength(2);
    expect(journals[1]!.vtype).toBe(VTYPE.CASH_RECEIPT);
    expect(totals(journals[1]!.legs).imbalance).toBe('0.00');

    const cashLeg = journals[1]!.legs.find((l) => l.accountId === ACC.CASH);
    expect(cashLeg?.dr).toBe('400.00');
  });

  it('emits only the invoice when nothing is received', () => {
    expect(postSale(sale)).toHaveLength(1);
  });

  it('rejects an invoice whose totals do not reconcile', () => {
    expect(() => postSale({ ...sale, netTotal: '999.00' })).toThrow(/do not reconcile/i);
  });

  it('moves inventory and COGS by the same amount', () => {
    const [invoice] = postSale(sale);

    const cogs = invoice!.legs.find((l) => l.accountId === ACC.COGS);
    const inv = invoice!.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH);

    expect(cogs?.dr).toBe('800.00');
    expect(inv?.cr).toBe('800.00');
  });
});

// ---------------------------------------------------------------------------

describe('sale return posting', () => {
  const ret = {
    invId: 77,
    date: '2026-01-16',
    branchId: 2,
    customerAccountId: 1010205,
    customerLabel: 'Customer: Ali Traders',
    netTotal: '500.00',
    cogs: '380.00',
    paid: '0.00',
  };

  it('balances', () => {
    const [j] = postSaleReturn(ret);
    expect(totals(j!.legs).imbalance).toBe('0.00');
  });

  it('mirrors a sale: sales debited, receivable credited', () => {
    const [j] = postSaleReturn(ret);

    expect(j!.legs.find((l) => l.accountId === ACC.SALES)?.dr).toBe('500.00');
    expect(j!.legs.find((l) => l.accountId === ret.customerAccountId)?.cr).toBe('500.00');
  });

  it('adds a balanced cash-payment voucher when refunded', () => {
    const journals = postSaleReturn({ ...ret, paid: '500.00' });

    expect(journals).toHaveLength(2);
    expect(journals[1]!.vtype).toBe(VTYPE.CASH_PAYMENT);
    expect(totals(journals[1]!.legs).imbalance).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------

describe('purchase posting', () => {
  const purchase = {
    invId: 900,
    date: '2026-01-15',
    branchId: 1,
    kind: 'RAW' as const,
    supplierAccountId: 2010105,
    supplierLabel: 'Zenith Batteries',
    subTotal: '5000.00',
    rent: '250.00',
    discount: '150.00',
    netTotal: '5100.00',
    paid: '0.00',
  };

  it('balances', () => {
    const [j] = postPurchase(purchase);
    expect(totals(j!.legs).imbalance).toBe('0.00');
  });

  it('capitalises freight into stock value', () => {
    const [j] = postPurchase(purchase);
    expect(j!.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.dr).toBe('5250.00');
  });

  it('debits finished inventory for a finished-goods purchase', () => {
    const [j] = postPurchase({ ...purchase, kind: 'FINISH' });
    expect(j!.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH)?.dr).toBe('5250.00');
    expect(j!.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)).toBeUndefined();
  });

  it('rejects totals that do not reconcile', () => {
    expect(() => postPurchase({ ...purchase, netTotal: '5000.00' })).toThrow(/do not reconcile/i);
  });

  it('balances a purchase return', () => {
    const [j] = postPurchaseReturn({
      invId: 901,
      date: '2026-01-17',
      branchId: 1,
      supplierAccountId: 2010105,
      supplierLabel: 'Zenith Batteries',
      subTotal: '1000.00',
      rent: '0.00',
      discount: '100.00',
      netTotal: '900.00',
      received: '0.00',
    });

    expect(totals(j!.legs).imbalance).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------

describe('manual vouchers', () => {
  const base = { invId: 10, date: '2026-01-15', branchId: 1 } as const;

  it('accepts a balanced cash receipt', () => {
    const j = postVoucher({
      ...base,
      type: 'CRV',
      lines: [
        { accountId: ACC.CASH, dr: '1000.00', cr: '0.00', detail: 'Cash in' },
        { accountId: 1010205, dr: '0.00', cr: '1000.00', detail: 'From customer' },
      ],
    });

    expect(j.vtype).toBe(VTYPE.CASH_RECEIPT);
    expect(totals(j.legs).imbalance).toBe('0.00');
  });

  it('rejects an unbalanced voucher — the check the legacy UI never had', () => {
    expect(() =>
      postVoucher({
        ...base,
        type: 'JV',
        lines: [
          { accountId: 5020100, dr: '500.00', cr: '0.00', detail: 'Expense' },
          { accountId: ACC.CASH, dr: '0.00', cr: '450.00', detail: 'Cash' },
        ],
      }),
    ).toThrow(/does not balance/i);
  });

  it('rejects a line carrying both a debit and a credit', () => {
    expect(() =>
      postVoucher({
        ...base,
        type: 'JV',
        lines: [{ accountId: ACC.CASH, dr: '10.00', cr: '10.00', detail: 'both' }],
      }),
    ).toThrow(/split it into two lines/i);
  });

  it('rejects an empty voucher', () => {
    expect(() => postVoucher({ ...base, type: 'CPV', lines: [] })).toThrow(/no lines/i);
  });

  it('supports multi-line journal vouchers', () => {
    const j = postVoucher({
      ...base,
      type: 'JV',
      lines: [
        { accountId: 5020100, dr: '300.00', cr: '0.00', detail: 'Salaries' },
        { accountId: 5020201, dr: '200.00', cr: '0.00', detail: 'Freight' },
        { accountId: ACC.CASH, dr: '0.00', cr: '500.00', detail: 'Paid' },
      ],
    });

    expect(j.legs).toHaveLength(3);
    expect(totals(j.legs).imbalance).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------

describe('account metadata', () => {
  it('derives the head from a composed account code', () => {
    expect(headOf(1010402)).toBe(1);
    expect(headOf(4010101)).toBe(4);
    expect(headOf(5010101)).toBe(5);
  });

  it('marks assets and expenses as debit-normal', () => {
    // From LedgerController.cs:50 — drives opening balances and statements.
    expect(isDebitNormal(1)).toBe(true);
    expect(isDebitNormal(5)).toBe(true);
    expect(isDebitNormal(2)).toBe(false);
    expect(isDebitNormal(3)).toBe(false);
    expect(isDebitNormal(4)).toBe(false);
  });
});

describe('detail formatting', () => {
  it('matches the legacy N2 thousands format', () => {
    expect(fmt('1234.5')).toBe('1,234.50');
    expect(fmt('1000000')).toBe('1,000,000.00');
    expect(fmt('999.99')).toBe('999.99');
    expect(fmt('0')).toBe('0.00');
    expect(fmt('-1234.5')).toBe('-1,234.50');
  });
});
