/**
 * Money handling.
 *
 * RULE: money never touches a JS `number`. Postgres `numeric` arrives as a
 * string (see db/index.ts type parsers), stays a string at the boundary, and is
 * only ever computed on via Decimal. A single implicit float conversion in an
 * accounting system produces silent, unauditable corruption.
 */
// Named import, not default: decimal.js merges a class, a function and a
// namespace under one name, and the default import resolves to the namespace
// under NodeNext resolution.
import { Decimal } from 'decimal.js';

// 28 significant digits is far beyond numeric(18,2); ROUND_HALF_UP matches the
// rounding the legacy SQL Server decimal arithmetic produced.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/** A money value in transit: always a decimal string, e.g. "1234.50". */
export type MoneyString = string;

export const ZERO = '0.00';

/** Parse anything money-ish into a Decimal. Rejects NaN/Infinity loudly. */
export function dec(value: MoneyString | number | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;

  const d = new Decimal(typeof value === 'number' ? value.toString() : value);
  if (!d.isFinite()) {
    throw new TypeError(`Not a finite money value: ${String(value)}`);
  }
  return d;
}

/** Render for storage in a numeric(18,2) column. */
export function money(value: MoneyString | number | Decimal): MoneyString {
  return dec(value).toFixed(2);
}

/** Render for a numeric(18,3) quantity column. */
export function qty(value: MoneyString | number | Decimal): MoneyString {
  return dec(value).toFixed(3);
}

export function add(...values: Array<MoneyString | number | Decimal>): MoneyString {
  return money(values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0)));
}

export function sub(a: MoneyString | number | Decimal, b: MoneyString | number | Decimal): MoneyString {
  return money(dec(a).minus(dec(b)));
}

export function mul(a: MoneyString | number | Decimal, b: MoneyString | number | Decimal): MoneyString {
  return money(dec(a).times(dec(b)));
}

export function isZero(value: MoneyString | number | Decimal): boolean {
  return dec(value).isZero();
}

export function isNegative(value: MoneyString | number | Decimal): boolean {
  return dec(value).isNegative();
}

export function eq(a: MoneyString | number | Decimal, b: MoneyString | number | Decimal): boolean {
  return dec(a).equals(dec(b));
}

export function gt(a: MoneyString | number | Decimal, b: MoneyString | number | Decimal): boolean {
  return dec(a).greaterThan(dec(b));
}

export { Decimal };
