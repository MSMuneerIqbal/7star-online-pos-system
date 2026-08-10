/**
 * Double-entry journal.
 *
 * The central invariant: a journal cannot exist in an unbalanced state. There
 * is no way to construct one except through `buildJournal`, which throws if
 * debits do not equal credits. The legacy system had no such check, which is
 * how every discounted sale wrote a broken voucher for years — see
 * db/accounts.md §4.1.
 */
import { add, dec, isNegative, isZero, money, sub, type MoneyString } from '../core/money.js';
import { unbalancedVoucher, unprocessable } from '../core/errors.js';
import type { Vtype } from './accounts.js';

/**
 * One leg of a journal entry: a debit OR a credit, never both and never
 * neither. Mirrors the `chk_transactions_one_sided` database constraint.
 */
export interface Leg {
  readonly accountId: number;
  readonly dr: MoneyString;
  readonly cr: MoneyString;
  readonly detail: string;
}

export interface Journal {
  readonly vtype: Vtype;
  /** Business date (not the timestamp). */
  readonly date: string;
  /** Source document id — sale id, purchase id, voucher id. */
  readonly invId: number;
  readonly branchId: number;
  readonly legs: readonly Leg[];
}

// ---------------------------------------------------------------------------
// Leg constructors
// ---------------------------------------------------------------------------

export function debit(accountId: number, amount: MoneyString, detail: string): Leg {
  return { accountId, dr: money(amount), cr: '0.00', detail };
}

export function credit(accountId: number, amount: MoneyString, detail: string): Leg {
  return { accountId, dr: '0.00', cr: money(amount), detail };
}

/**
 * A leg that is omitted when the amount is zero.
 *
 * Discount and service legs only exist when non-zero; posting a zero-value leg
 * would violate the one-sided database constraint.
 */
export function debitIf(accountId: number, amount: MoneyString, detail: string): Leg[] {
  return isZero(amount) ? [] : [debit(accountId, amount, detail)];
}

export function creditIf(accountId: number, amount: MoneyString, detail: string): Leg[] {
  return isZero(amount) ? [] : [credit(accountId, amount, detail)];
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export interface Totals {
  debits: MoneyString;
  credits: MoneyString;
  imbalance: MoneyString;
}

export function totals(legs: readonly Leg[]): Totals {
  const debits = add(...legs.map((l) => l.dr));
  const credits = add(...legs.map((l) => l.cr));

  return { debits, credits, imbalance: sub(debits, credits) };
}

export function isBalanced(legs: readonly Leg[]): boolean {
  return isZero(totals(legs).imbalance);
}

/**
 * Build a journal, refusing anything that does not balance.
 *
 * `invId` is 0 for a not-yet-persisted document; the caller re-stamps it after
 * the insert. Every other field must be final.
 */
export function buildJournal(input: Journal): Journal {
  const { legs, vtype } = input;

  if (legs.length === 0) {
    throw unprocessable(`${vtype} journal has no legs`);
  }

  for (const leg of legs) {
    if (isNegative(leg.dr) || isNegative(leg.cr)) {
      throw unprocessable(
        `${vtype} leg on account ${leg.accountId} has a negative amount ` +
          `(dr ${leg.dr}, cr ${leg.cr}). Reverse the leg instead of negating it.`,
      );
    }

    // Exactly one side must carry a value — same rule as the DB constraint.
    const drZero = isZero(leg.dr);
    const crZero = isZero(leg.cr);

    if (drZero === crZero) {
      throw unprocessable(
        drZero
          ? `${vtype} leg on account ${leg.accountId} is empty (both dr and cr are zero)`
          : `${vtype} leg on account ${leg.accountId} is two-sided (dr ${leg.dr}, cr ${leg.cr})`,
      );
    }
  }

  const { imbalance } = totals(legs);

  if (!isZero(imbalance)) {
    // invId is the most useful identifier available pre-insert.
    throw unbalancedVoucher(input.invId, imbalance);
  }

  return input;
}

/**
 * Reverse a journal — every debit becomes a credit and vice versa.
 *
 * Used when editing or deleting a posted document. The legacy system instead
 * ran `DELETE FROM Transactions WHERE Vtype=.. AND InvId=..`, which destroys
 * the audit trail; a reversal keeps history intact.
 */
export function reverse(journal: Journal, detailPrefix = 'REVERSAL'): Journal {
  return buildJournal({
    ...journal,
    legs: journal.legs.map((l) => ({
      accountId: l.accountId,
      dr: l.cr,
      cr: l.dr,
      detail: `${detailPrefix}: ${l.detail}`,
    })),
  });
}

/** Format money the way the legacy detail strings did: 1,234.50 */
export function fmt(amount: MoneyString): string {
  const [whole = '0', frac = '00'] = dec(amount).toFixed(2).split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;

  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
