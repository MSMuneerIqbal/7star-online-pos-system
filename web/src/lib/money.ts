/**
 * Client-side money arithmetic.
 *
 * The server recomputes every figure from the product table before posting, so
 * these values are for live feedback while the operator types — they are never
 * the authority. Even so they use integer-cent arithmetic rather than floats,
 * because a total that visibly disagrees with the saved invoice by a paisa
 * destroys trust in the whole screen.
 */

const SCALE = 100;

function toCents(value: string | number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(value || '0');
  if (!Number.isFinite(n)) return 0;

  // Round rather than truncate so 0.1 + 0.2 lands on 30 cents, not 29.
  return Math.round(n * SCALE);
}

function fromCents(cents: number): string {
  return (cents / SCALE).toFixed(2);
}

export function addMoney(a: string | number, b: string | number): string {
  return fromCents(toCents(a) + toCents(b));
}

export function subMoney(a: string | number, b: string | number): string {
  return fromCents(toCents(a) - toCents(b));
}

/**
 * Quantity x unit price. Quantity may be fractional, so this multiplies in
 * cents and rounds half-up once — matching the server's ROUND_HALF_UP.
 */
export function mulMoney(qty: string | number, price: string | number): string {
  const q = typeof qty === 'number' ? qty : Number.parseFloat(qty || '0');
  if (!Number.isFinite(q)) return '0.00';

  return fromCents(Math.round(q * toCents(price)));
}

export function toMoney(value: string | number): string {
  return fromCents(toCents(value));
}

/** Display format with thousands separators: 1,234.50 */
export function fmtMoney(value: string | number): string {
  const [whole = '0', frac = '00'] = toMoney(value).split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;

  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
