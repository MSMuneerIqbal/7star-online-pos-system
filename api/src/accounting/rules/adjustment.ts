/**
 * Stock-adjustment posting rule.
 *
 * A manual count correction — increase (surplus found) or decrease (shrinkage).
 * The value is signed: positive means stock was found, negative means it went
 * missing. The balancing side is a single "Stock Adjustment" account (head 5),
 * so shrinkage is an expense and surplus is a negative expense; the two net off
 * in the income statement.
 *
 *   increase:  Dr  inventory            value
 *                  Cr  stock adjustment        value
 *
 *   decrease:  Dr  stock adjustment    |value|
 *                  Cr  inventory               |value|
 */
import { ACC, VTYPE } from '../accounts.js';
import { buildJournal, credit, debit, type Journal } from '../journal.js';
import { gt, isZero, money, type MoneyString } from '../../core/money.js';

export interface StockAdjustmentInput {
  invId: number;
  date: string;
  branchId: number;
  kind: 'RAW' | 'FINISH';
  /** Signed net value: positive = surplus, negative = shrinkage. */
  value: MoneyString;
}

export function inventoryAccount(kind: 'RAW' | 'FINISH'): number {
  return kind === 'RAW' ? ACC.INVENTORY_RAW : ACC.INVENTORY_FINISH;
}

/**
 * Build the journal, or return null when the net value is zero (a pure quantity
 * reshuffle with no value impact — no posting needed).
 */
export function postStockAdjustment(input: StockAdjustmentInput): Journal | null {
  const value = money(input.value);
  if (isZero(value)) return null;

  const inventory = inventoryAccount(input.kind);
  const ref = `Stock adjustment #${input.invId}`;

  if (gt(value, '0')) {
    return buildJournal({
      vtype: VTYPE.STOCK_ADJUSTMENT,
      date: input.date,
      invId: input.invId,
      branchId: input.branchId,
      legs: [
        debit(inventory, value, `Surplus found – ${ref}`),
        credit(ACC.STOCK_ADJUSTMENT, value, `Surplus found – ${ref}`),
      ],
    });
  }

  const magnitude = value.startsWith('-') ? value.slice(1) : value;

  return buildJournal({
    vtype: VTYPE.STOCK_ADJUSTMENT,
    date: input.date,
    invId: input.invId,
    branchId: input.branchId,
    legs: [
      debit(ACC.STOCK_ADJUSTMENT, magnitude, `Shrinkage – ${ref}`),
      credit(inventory, magnitude, `Shrinkage – ${ref}`),
    ],
  });
}
