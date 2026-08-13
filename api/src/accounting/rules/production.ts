/**
 * Production output posting (Phase 4 — reshape).
 *
 * Production cost is material only: complete set + cells + other parts
 * (PRINCIPLES §4, SPECS §5.4). There is no labour term — no pay system exists,
 * so no rate exists to read. The old conversion-cost legs (cash/accrual) are
 * gone with it.
 *
 * The issue-to-worker step is a stock movement only and posts nothing. The
 * ledger moves once, at output: finished goods are capitalised at the material
 * they absorbed, and raw stock is credited the same amount. Damaged material is
 * absorbed into the surviving batteries (decision, PRINCIPLES §17.16 style), so
 * no damage leg exists and the voucher always balances.
 */
import { ACC, VTYPE } from '../accounts.js';
import { buildJournal, credit, debit, type Journal } from '../journal.js';
import type { MoneyString } from '../../core/money.js';

export interface ProductionOutputInput {
  invId: number;
  date: string;
  branchId: number;
  productName: string;
  /** The material cost the finished batteries absorb (issued raw, total). */
  materialCost: MoneyString;
}

export function postProduction(input: ProductionOutputInput): Journal {
  const ref = `Production #${input.invId} – ${input.productName}`;

  return buildJournal({
    vtype: VTYPE.PRODUCTION,
    date: input.date,
    invId: input.invId,
    branchId: input.branchId,
    legs: [
      debit(ACC.INVENTORY_FINISH, input.materialCost, `Finished goods produced – ${ref}`),
      credit(ACC.INVENTORY_RAW, input.materialCost, `Raw material consumed – ${ref}`),
    ],
  });
}
