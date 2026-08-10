/**
 * Lab posting rules.
 *
 * DESIGNED, not ported: `LabController` had no Save action, so there was never
 * any lab invoice posting to port. See modules/lab/service.ts for the workflow
 * these rules serve.
 *
 * Two principles drive the entries:
 *
 *   1. The customer's battery is NOT the business's inventory. Accepting it for
 *      repair creates a custody obligation, not an asset, so intake posts
 *      nothing. There is no COGS on the battery itself.
 *   2. Lab work is a SERVICE. Revenue goes to Service Income (4010102), not
 *      Sales (4010101), so the income statement separates repair income from
 *      product sales.
 */
import { ACC, VTYPE } from '../accounts.js';
import { buildJournal, credit, debit, type Journal } from '../journal.js';
import { gt, type MoneyString } from '../../core/money.js';

export interface LabMaterialsInput {
  invId: number;
  date: string;
  branchId: number;
  /** Cost of raw materials consumed on the job, at catalog cost. */
  materialCost: MoneyString;
}

/**
 * Materials consumed repairing a customer's battery.
 *
 *   Dr  COGS                material cost
 *       Cr  inventory (raw)              material cost
 *
 * Expensed immediately rather than held as work-in-progress: lab jobs turn
 * around in days, and a WIP account nobody clears is worse than none.
 */
export function postLabMaterials(input: LabMaterialsInput): Journal {
  const ref = `Lab job #${input.invId}`;

  return buildJournal({
    vtype: VTYPE.LAB,
    date: input.date,
    invId: input.invId,
    branchId: input.branchId,
    legs: [
      debit(ACC.COGS, input.materialCost, `Materials consumed – ${ref}`),
      credit(ACC.INVENTORY_RAW, input.materialCost, `Raw material issued – ${ref}`),
    ],
  });
}

export interface LabInvoiceInput {
  invId: number;
  date: string;
  branchId: number;
  customerAccountId: number;
  customerLabel: string;
  /** What the customer is charged for the repair. */
  serviceCharge: MoneyString;
  received: MoneyString;
}

/**
 * Invoice a completed lab job.
 *
 *   Dr  customer receivable   charge
 *       Cr  service income                charge
 *
 * plus a separate cash-receipt voucher when money is taken, matching how sales
 * split their receipt.
 */
export function postLabInvoice(input: LabInvoiceInput): Journal[] {
  const ref = `Lab Inv#${input.invId}, ${input.customerLabel}`;

  const journals = [
    buildJournal({
      vtype: VTYPE.LAB,
      date: input.date,
      invId: input.invId,
      branchId: input.branchId,
      legs: [
        debit(input.customerAccountId, input.serviceCharge, `Receivable raised – ${ref}`),
        credit(ACC.SERVICE_INCOME, input.serviceCharge, `Lab service income – ${ref}`),
      ],
    }),
  ];

  if (gt(input.received, '0.00')) {
    journals.push(
      buildJournal({
        vtype: VTYPE.CASH_RECEIPT,
        date: input.date,
        invId: input.invId,
        branchId: input.branchId,
        legs: [
          debit(ACC.CASH, input.received, `Cash received – Lab ${ref}`),
          credit(input.customerAccountId, input.received, `Payment received – ${ref}`),
        ],
      }),
    );
  }

  return journals;
}
