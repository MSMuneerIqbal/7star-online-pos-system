/**
 * Purchase and purchase-return posting rules.
 *
 * Both legacy entries already balanced, so these preserve the original rules.
 * The one change is that purchase discount no longer shares account 4020101
 * with sales discount by accident — the code is still the same constant, but
 * it is now named at the call site so the split in db/accounts.md §4.2 is a
 * one-line change here.
 */
import { ACC, VTYPE } from '../accounts.js';
import { buildJournal, credit, creditIf, debit, debitIf, type Journal } from '../journal.js';
import { add, gt, sub, type MoneyString } from '../../core/money.js';
import { unprocessable } from '../../core/errors.js';

export interface PurchaseInput {
  invId: number;
  date: string;
  branchId: number;
  /** RAW debits raw inventory, FINISH debits finished inventory. */
  kind: 'RAW' | 'FINISH';
  /** The supplier's payable account code. */
  supplierAccountId: number;
  supplierLabel: string;
  /** Sum of line totals before discount. */
  subTotal: MoneyString;
  /** Inward freight capitalised into stock value. */
  rent: MoneyString;
  discount: MoneyString;
  /** What is owed to the supplier: subTotal + rent - discount. */
  netTotal: MoneyString;
  /** Cash paid at the time of purchase, if any. */
  paid: MoneyString;
}

/**
 * Post a purchase.
 *
 *   Dr  inventory (raw or finished)   sub_total + rent
 *       Cr  supplier payable              net_total
 *       Cr  discount                      discount   (if any)
 */
export function postPurchase(input: PurchaseInput): Journal[] {
  const stockValue = add(input.subTotal, input.rent);
  assertPurchaseTotals(input, stockValue);

  const inventoryAccount = input.kind === 'FINISH' ? ACC.INVENTORY_FINISH : ACC.INVENTORY_RAW;

  const ref = `Purchase Invoice ${input.invId}`;

  const journals = [
    buildJournal({
      vtype: VTYPE.PURCHASE,
      date: input.date,
      invId: input.invId,
      branchId: input.branchId,
      legs: [
        debit(inventoryAccount, stockValue, `Stock received – ${ref}`),
        credit(
          input.supplierAccountId,
          input.netTotal,
          `Payable to supplier ${input.supplierLabel} for ${ref}`,
        ),
        ...creditIf(ACC.PURCHASE_DISCOUNT, input.discount, `Purchase discount received – ${ref}`),
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
          debit(
            input.supplierAccountId,
            input.paid,
            `Paid to supplier ${input.supplierLabel} for ${ref}`,
          ),
          credit(ACC.CASH, input.paid, `Cash paid – ${ref}`),
        ],
      }),
    );
  }

  return journals;
}

export interface PurchaseReturnInput {
  invId: number;
  date: string;
  branchId: number;
  supplierAccountId: number;
  supplierLabel: string;
  subTotal: MoneyString;
  rent: MoneyString;
  discount: MoneyString;
  netTotal: MoneyString;
  /** Cash refunded by the supplier, if any. */
  received: MoneyString;
}

/**
 * Post a purchase return — the mirror of a purchase.
 *
 *   Dr  supplier payable      net_total
 *   Dr  discount              discount   (if any)
 *       Cr  inventory (raw)               sub_total + rent
 */
export function postPurchaseReturn(input: PurchaseReturnInput): Journal[] {
  const stockValue = add(input.subTotal, input.rent);
  assertPurchaseTotals(input, stockValue);

  const ref = `Purchase Return Invoice ${input.invId}`;

  const journals = [
    buildJournal({
      vtype: VTYPE.PURCHASE_RETURN,
      date: input.date,
      invId: input.invId,
      branchId: input.branchId,
      legs: [
        debit(
          input.supplierAccountId,
          input.netTotal,
          `Receivable from supplier ${input.supplierLabel} for ${ref}`,
        ),
        // A purchase return reverses discount previously received, so it debits
        // the purchase-discount account rather than the sales one.
        ...debitIf(ACC.PURCHASE_DISCOUNT, input.discount, `Purchase return discount – ${ref}`),
        credit(ACC.INVENTORY_RAW, stockValue, `Stock returned – ${ref}`),
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
          debit(ACC.CASH, input.received, `Cash received – ${ref}`),
          credit(
            input.supplierAccountId,
            input.received,
            `Received from supplier ${input.supplierLabel} for ${ref}`,
          ),
        ],
      }),
    );
  }

  return journals;
}

/** stock value must equal net + discount, or the ledger cannot balance. */
function assertPurchaseTotals(
  input: { netTotal: MoneyString; discount: MoneyString },
  stockValue: MoneyString,
): void {
  const expected = sub(stockValue, input.discount);

  if (expected !== input.netTotal) {
    throw unprocessable(
      `Purchase totals do not reconcile: stock value ${stockValue} - discount ` +
        `${input.discount} = ${expected}, but net_total is ${input.netTotal}`,
      { expected, actual: input.netTotal },
    );
  }
}
