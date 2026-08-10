import { describe, expect, it } from 'vitest';
import { add, dec, eq, gt, isNegative, isZero, money, mul, qty, sub } from '../src/core/money.js';

describe('money', () => {
  it('formats to 2 decimal places for numeric(18,2)', () => {
    expect(money('1234.5')).toBe('1234.50');
    expect(money(0)).toBe('0.00');
    expect(money('-99.999')).toBe('-100.00');
  });

  it('formats quantities to 3 decimal places', () => {
    expect(qty('2.5')).toBe('2.500');
    expect(qty(1)).toBe('1.000');
  });

  it('avoids binary floating point error', () => {
    // The canonical float trap: 0.1 + 0.2 === 0.30000000000000004
    expect(add('0.1', '0.2')).toBe('0.30');

    // Accumulating a third repeatedly — drifts badly with floats
    const hundredth = Array.from({ length: 100 }, () => '0.01');
    expect(add(...hundredth)).toBe('1.00');
  });

  it('rounds half up, matching the legacy SQL Server decimal behaviour', () => {
    expect(money('2.345')).toBe('2.35');
    expect(money('2.344')).toBe('2.34');
    // Banker's rounding would give 2.34 here; we must not.
    expect(money('2.355')).toBe('2.36');
  });

  it('handles the full numeric(18,2) range without precision loss', () => {
    const big = '9999999999999999.99';
    expect(money(big)).toBe(big);
    // Number(big) would lose digits entirely
    expect(add(big, '0.01')).toBe('10000000000000000.00');
  });

  it('treats null and undefined as zero', () => {
    expect(dec(null).toString()).toBe('0');
    expect(dec(undefined).toString()).toBe('0');
  });

  it('rejects non-finite values loudly rather than producing NaN', () => {
    expect(() => dec('not a number')).toThrow();
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => dec(Number.NaN)).toThrow(TypeError);
  });

  it('subtracts and multiplies exactly', () => {
    expect(sub('100.00', '33.33')).toBe('66.67');
    expect(mul('19.99', '3')).toBe('59.97');
    // Quantity x unit price, the invoice line case. 2.5 x 1499.99 = 3749.975,
    // which rounds half-up to the stored 2dp value.
    expect(mul('2.5', '1499.99')).toBe('3749.98');
  });

  it('compares without coercion', () => {
    expect(isZero('0.00')).toBe(true);
    expect(isZero('0.001')).toBe(false);
    expect(isNegative('-0.01')).toBe(true);
    expect(eq('1.50', '1.5')).toBe(true);
    expect(gt('1.51', '1.50')).toBe(true);
    expect(gt('1.50', '1.50')).toBe(false);
  });
});

describe('voucher balance arithmetic', () => {
  /**
   * The defect this whole rewrite exists to fix: the legacy sale posting.
   * See db/accounts.md §4.1.
   */
  it('reproduces the legacy sale imbalance of (discount - service)', () => {
    const cgs = '800.00';
    const netTotal = '1000.00';
    const discount = '50.00';
    const service = '20.00';

    // Legacy legs
    const debits = add(cgs, netTotal, discount);
    const credits = add(cgs, netTotal, service);

    expect(sub(debits, credits)).toBe('30.00'); // == discount - service
    expect(eq(debits, credits)).toBe(false);
  });

  it('balances with the corrected posting rules', () => {
    const cgs = '800.00';
    const grossTotal = '1030.00';
    const discount = '50.00';
    const service = '20.00';
    const netTotal = sub(add(grossTotal, service), discount); // 1000.00

    expect(netTotal).toBe('1000.00');

    const debits = add(netTotal, discount, cgs);
    const credits = add(grossTotal, service, cgs);

    expect(eq(debits, credits)).toBe(true);
    expect(sub(debits, credits)).toBe('0.00');
  });
});
