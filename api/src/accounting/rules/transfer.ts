/**
 * Inter-branch stock transfer posting rules.
 *
 * These are NOT ports. The legacy postings do not balance at all:
 *
 *   BranchTransferController  — `Cr Inventory` only, no debit
 *   DoReceivedController      — `Dr Inventory` + `Dr Freight`, no credit
 *
 * The freight debit in particular has no counterparty whatsoever, so every
 * receipt inflated total assets by the cargo cost. See db/accounts.md §4.5.
 *
 * Fixed here with an inter-branch clearing account. Stock leaving one branch
 * and arriving at another is one economic event split across two vouchers at
 * two branches; the clearing account carries the in-transit value so each
 * voucher balances on its own and the pair nets to zero company-wide.
 */
import { ACC, VTYPE } from '../accounts.js';
import { buildJournal, credit, debit, debitIf, creditIf, type Journal } from '../journal.js';
import { gt, type MoneyString } from '../../core/money.js';

export type StockKind = 'RAW' | 'FINISH';

/** Which inventory account a transfer moves, by stock kind. */
export function inventoryAccount(kind: StockKind): number {
  return kind === 'RAW' ? ACC.INVENTORY_RAW : ACC.INVENTORY_FINISH;
}

export interface TransferOutInput {
  invId: number;
  date: string;
  /** The branch the stock leaves. The voucher belongs to it. */
  fromBranchId: number;
  toBranchId: number;
  fromBranchName: string;
  toBranchName: string;
  kind: StockKind;
  /** Value of the goods at cost. */
  value: MoneyString;
}

/**
 * Stock despatched from a branch.
 *
 *   Dr  inter-branch clearing   value
 *       Cr  inventory                       value
 *
 * The legacy version posted only the credit, leaving the voucher short by the
 * full value of the goods.
 */
export function postTransferOut(input: TransferOutInput): Journal {
  const ref =
    `STOCK TRANSFERRED FROM ${input.fromBranchName} TO ${input.toBranchName} ` +
    `BT Inv#${input.invId}`;

  return buildJournal({
    vtype: VTYPE.BRANCH_TRANSFER,
    date: input.date,
    invId: input.invId,
    branchId: input.fromBranchId,
    legs: [
      debit(ACC.INTER_BRANCH, input.value, `In transit to ${input.toBranchName} – ${ref}`),
      credit(inventoryAccount(input.kind), input.value, ref),
    ],
  });
}

export interface TransferInInput {
  invId: number;
  date: string;
  fromBranchId: number;
  /** The branch receiving the stock. The voucher belongs to it. */
  toBranchId: number;
  fromBranchName: string;
  toBranchName: string;
  kind: StockKind;
  /** Value of the goods at cost, as despatched. */
  value: MoneyString;
  /** Cargo/freight paid on arrival. Expensed, not capitalised. */
  freight: MoneyString;
  /**
   * True when freight was paid in cash on receipt; false when it is owed.
   * Determines the credit side of the freight leg.
   */
  freightPaidInCash: boolean;
}

/**
 * Stock received at a branch.
 *
 *   Dr  inventory              value
 *       Cr  inter-branch clearing         value
 *   Dr  freight expense        freight     (if any)
 *       Cr  cash                           freight
 *
 * The legacy version posted both debits and no credits at all.
 */
export function postTransferIn(input: TransferInInput): Journal {
  const ref =
    `STOCK RECEIVED FROM ${input.fromBranchName} TO ${input.toBranchName} ` +
    `BT Inv#${input.invId}`;

  const freightRef = `CARGO EXPENSE FOR ${ref}`;

  return buildJournal({
    vtype: VTYPE.DO_RECEIVED,
    date: input.date,
    invId: input.invId,
    branchId: input.toBranchId,
    legs: [
      debit(inventoryAccount(input.kind), input.value, ref),
      credit(ACC.INTER_BRANCH, input.value, `Cleared from ${input.fromBranchName} – ${ref}`),

      // Freight is a period expense of the receiving branch. It is deliberately
      // NOT capitalised into stock value: unlike purchase freight, this is an
      // internal movement and adding it to cost would inflate the value of the
      // same goods every time they move between branches.
      ...debitIf(ACC.FREIGHT_IN, input.freight, freightRef),
      ...creditIf(
        input.freightPaidInCash ? ACC.CASH : ACC.INTER_BRANCH,
        input.freight,
        input.freightPaidInCash ? `Cash paid – ${freightRef}` : `Payable – ${freightRef}`,
      ),
    ],
  });
}

/** True when a transfer carries any value worth posting. */
export function isPostable(value: MoneyString): boolean {
  return gt(value, '0.00');
}
