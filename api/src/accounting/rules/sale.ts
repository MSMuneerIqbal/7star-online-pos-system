/**
 * Sale and sale-return posting rules.
 *
 * The sale rule below is NOT a port. The legacy SINV entry does not balance —
 * it credits Sales at net_total while also posting separate service and
 * discount legs, leaving `Dr - Cr = discount - service` on every sale where
 * those differ. See db/accounts.md §4.1.
 */
import { ACC, VTYPE } from '../accounts.js';
import {
  buildJournal,
  credit,
  creditIf,
  debit,
  debitIf,
  fmt,
  type Journal,
} from '../journal.js';
import { add, gt, sub, type MoneyString } from '../../core/money.js';
import { unprocessable } from '../../core/errors.js';

export interface SaleInput {
  invId: number;
  date: string;
  branchId: number;
  /** The customer's receivable account code. */
  customerAccountId: number;
  /** Display name for the ledger detail line. */
  customerLabel: string;
  /** Sum of line totals before discount, excluding service. */
  grossTotal: MoneyString;
  /** Invoice-level discount plus the sum of line discounts. */
  discount: MoneyString;
  /** Service charge added to the invoice. */
  service: MoneyString;
  /** What the customer owes: gross + service - discount. */
  netTotal: MoneyString;
  /** Cost of goods sold — sum of (product cost x qty). */
  cogs: MoneyString;
  /** Cash taken at the till, if any. */
  received: MoneyString;
}

/**
 * Post a sale.
 *
 * Returns one or two journals: the invoice, plus a separate cash-receipt
 * voucher when money changed hands. The legacy code split these the same way,
 * with its own trans_id, so the receipt shows as a distinct voucher in the
 * customer's ledger.
 *
 *   Dr  customer receivable   net_total
 *   Dr  discount              discount        (if any)
 *       Cr  sales                             gross_total
 *       Cr  service income                    service   (if any)
 *   Dr  COGS                  cogs
 *       Cr  inventory (finish)                cogs
 */
export function postSale(input: SaleInput): Journal[] {
  assertNetTotal(input);

  const ref = `Inv#${input.invId}, ${input.customerLabel}`;

  const invoice = buildJournal({
    vtype: VTYPE.SALE,
    date: input.date,
    invId: input.invId,
    branchId: input.branchId,
    legs: [
      debit(input.customerAccountId, input.netTotal, `Receivable raised – ${ref}`),
      ...debitIf(ACC.SALES_DISCOUNT, input.discount, `Sales discount – ${ref}`),

      credit(ACC.SALES, input.grossTotal, `Sales recorded (Gross) – ${ref}`),
      ...creditIf(ACC.SERVICE_INCOME, input.service, `Service charges – ${ref}`),

      // COGS and its inventory credit are a self-balancing pair: when nothing
      // was costed (a service-only sale, or stock with no cost yet) both legs
      // are omitted together, so the journal still balances.
      ...debitIf(ACC.COGS, input.cogs, `COGS – ${ref}`),
      ...creditIf(ACC.INVENTORY_FINISH, input.cogs, `Inventory issued – ${ref}, Cost:${fmt(input.cogs)}`),
    ],
  });

  const journals = [invoice];

  if (gt(input.received, '0.00')) {
    journals.push(
      buildJournal({
        vtype: VTYPE.CASH_RECEIPT,
        date: input.date,
        invId: input.invId,
        branchId: input.branchId,
        legs: [
          debit(ACC.CASH, input.received, `Cash received – Sale ${ref}`),
          credit(input.customerAccountId, input.received, `Payment received – ${ref}`),
        ],
      }),
    );
  }

  return journals;
}

export interface SaleReturnInput {
  invId: number;
  date: string;
  branchId: number;
  customerAccountId: number;
  customerLabel: string;
  /** Value credited back to the customer. */
  netTotal: MoneyString;
  /** Cost of the goods coming back into stock. */
  cogs: MoneyString;
  /** Cash refunded at the till, if any. */
  paid: MoneyString;
}

/**
 * Post a sale return — the mirror of a sale.
 *
 * The legacy SRINV entry already balanced, so this preserves its rules:
 *
 *   Dr  sales                 net_total
 *       Cr  customer receivable            net_total
 *   Dr  inventory (finish)    cogs
 *       Cr  COGS                           cogs
 */
export function postSaleReturn(input: SaleReturnInput): Journal[] {
  const ref = `Inv#${input.invId}, ${input.customerLabel}`;

  const journals = [
    buildJournal({
      vtype: VTYPE.SALE_RETURN,
      date: input.date,
      invId: input.invId,
      branchId: input.branchId,
      legs: [
        debit(ACC.SALES, input.netTotal, `Sales reversed – ${ref}`),
        credit(input.customerAccountId, input.netTotal, `Receivable reduced – ${ref}`),

        ...debitIf(ACC.INVENTORY_FINISH, input.cogs, `Inventory returned – ${ref}`),
        ...creditIf(ACC.COGS, input.cogs, `COGS reversed – ${ref}`),
      ],
    }),
  ];

  if (gt(input.paid, '0.00')) {
    journals.push(
      buildJournal({
        vtype: VTYPE.CASH_PAYMENT,
        date: input.date,
        invId: input.invId,
        branchId: input.branchId,
        legs: [
          debit(input.customerAccountId, input.paid, `Refund settled – ${ref}`),
          credit(ACC.CASH, input.paid, `Cash refunded – Sale Return ${ref}`),
        ],
      }),
    );
  }

  return journals;
}

/**
 * The invoice arithmetic must hold before anything is posted.
 *
 * Catching it here turns a silent ledger imbalance into a rejected request that
 * names the discrepancy — the legacy system posted whatever it was handed.
 */
function assertNetTotal(input: SaleInput): void {
  const expected = sub(add(input.grossTotal, input.service), input.discount);

  if (expected !== input.netTotal) {
    throw unprocessable(
      `Sale totals do not reconcile: gross ${input.grossTotal} + service ${input.service} ` +
        `- discount ${input.discount} = ${expected}, but net_total is ${input.netTotal}`,
      { expected, actual: input.netTotal },
    );
  }
}
