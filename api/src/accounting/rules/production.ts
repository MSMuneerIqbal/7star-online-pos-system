/**
 * Production posting.
 *
 * NOT a port. `ProductionController.cs:167` posts a single leg —
 * `Dr 1010402 Inventory Finished = TotalCost` — with no credit at all. So raw
 * materials were never removed from stock, the labour and overhead were never
 * funded, and every production run manufactured assets out of nothing.
 * See db/accounts.md §4.6.
 *
 * Correct treatment: production converts raw material plus conversion cost into
 * finished goods.
 *
 *   Dr  inventory (finished)    material + conversion
 *       Cr  inventory (raw)                  material consumed
 *       Cr  cash / accrued                   conversion cost
 */
import { ACC, VTYPE } from '../accounts.js';
import { buildJournal, credit, creditIf, debit, type Journal } from '../journal.js';
import { add, type MoneyString } from '../../core/money.js';
import { unprocessable } from '../../core/errors.js';

export interface ProductionInput {
  invId: number;
  date: string;
  branchId: number;
  productName: string;
  /** Cost of the raw materials consumed, at their catalog cost. */
  materialCost: MoneyString;
  /** Labour, electricity and other conversion costs. */
  labourCost: MoneyString;
  electricCost: MoneyString;
  otherCost: MoneyString;
  /** What the finished goods are capitalised at: material + conversion. */
  totalCost: MoneyString;
  /**
   * True when conversion costs are settled in cash now; false when accrued.
   * Either way they must be credited somewhere — the legacy version credited
   * nothing.
   */
  conversionPaidInCash: boolean;
}

export function postProduction(input: ProductionInput): Journal {
  const conversion = add(input.labourCost, input.electricCost, input.otherCost);
  const expected = add(input.materialCost, conversion);

  if (expected !== input.totalCost) {
    throw unprocessable(
      `Production cost does not reconcile: material ${input.materialCost} + ` +
        `conversion ${conversion} = ${expected}, but total_cost is ${input.totalCost}`,
      { expected, actual: input.totalCost },
    );
  }

  const ref = `Production Inv#${input.invId} – ${input.productName}`;

  return buildJournal({
    vtype: VTYPE.PRODUCTION,
    date: input.date,
    invId: input.invId,
    branchId: input.branchId,
    legs: [
      debit(ACC.INVENTORY_FINISH, input.totalCost, `Finished goods produced – ${ref}`),
      credit(ACC.INVENTORY_RAW, input.materialCost, `Raw material consumed – ${ref}`),

      // Conversion cost has to come from somewhere. Cash when paid on the day,
      // otherwise it sits as an accrual against the inter-branch/clearing side
      // until settled by a voucher.
      ...creditIf(
        input.conversionPaidInCash ? ACC.CASH : ACC.INTER_BRANCH,
        conversion,
        input.conversionPaidInCash
          ? `Conversion cost paid – ${ref}`
          : `Conversion cost accrued – ${ref}`,
      ),
    ],
  });
}
