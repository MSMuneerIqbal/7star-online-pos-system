/**
 * Chart-of-accounts codes.
 *
 * In the legacy system every one of these was an inline magic number repeated
 * across 42 controllers. Centralised here so a code change is one edit and a
 * typo is a compile error.
 *
 * Full derivation and caveats: db/accounts.md
 */

/** Fixed posting accounts. */
export const ACC = {
  /** Cash in hand — Dr on receipt, Cr on payment. */
  CASH: 1010101,
  /** Bank — used by BRV / BPV. */
  BANK: 1010102,
  /** Inventory, raw / stock. Purchase and branch transfer move this. */
  INVENTORY_RAW: 1010401,
  /** Inventory, finished goods. Sale issues from this. */
  INVENTORY_FINISH: 1010402,
  /** Sales revenue. */
  SALES: 4010101,
  /** Service income (sale service charge). */
  SERVICE_INCOME: 4010102,
  /**
   * Discount allowed to customers — contra-revenue, always debited.
   *
   * The legacy system used ONE code for this and for purchase discount, so the
   * two netted off and neither figure was recoverable (db/accounts.md §4.2).
   * They are separate accounts here. Safe to split because this installation
   * starts with fresh books; there is no migrated history to reconcile.
   */
  SALES_DISCOUNT: 4020101,
  /** Discount received from suppliers — other income, always credited. */
  PURCHASE_DISCOUNT: 4020102,
  /** Cost of goods sold. */
  COGS: 5010101,
  /** Production Wages — present in the legacy chart; unused (no pay system). */
  PRODUCTION_WAGES: 5010102,
  /** Short/damaged stock found on arrival at a branch — a company expense. */
  STOCK_LOSS: 5010103,
  /** Inward freight / cargo on DO receiving. */
  FREIGHT_IN: 5020201,
  /**
   * Inter-branch clearing. NEW — the legacy system had no such account.
   *
   * A stock transfer credits inventory at the sending branch and debits it at
   * the receiving one, on separate vouchers. Without a clearing account neither
   * voucher balances (see db/accounts.md §4.5). This account carries the
   * in-transit value and nets to zero company-wide once a transfer is received.
   */
  INTER_BRANCH: 1010501,
} as const;

/**
 * Base codes for dynamically allocated party accounts.
 *
 * The legacy system minted these with `MAX(AccountId) + 1` inside a
 * (HeadId, SubHeadId, Third) bucket — a race that can hand two parties the same
 * account and silently merge their ledgers. Replace with a sequence per bucket.
 */
export const ACCOUNT_RANGE = {
  CUSTOMER: { base: 1010200, headId: 1, subHeadId: 1, third: 2 },
  SUPPLIER: { base: 2010100, headId: 2, subHeadId: 3, third: 5 },
  EMPLOYEE: { base: 5020100, headId: 5, subHeadId: 7, third: 9 },
} as const;

/** The reserved walk-in / cash customer receivable (customer id 1). */
export const WALK_IN_CUSTOMER_ACCOUNT = 1010201;
export const WALK_IN_CUSTOMER_ID = 1;

/**
 * Voucher types.
 *
 * Note the returns are SRINV / PRINV, not SRET / PRET — the legacy strings are
 * kept verbatim so migrated rows and new rows are queryable together.
 */
export const VTYPE = {
  SALE: 'SINV',
  SALE_RETURN: 'SRINV',
  PURCHASE: 'PINV',
  PURCHASE_RETURN: 'PRINV',
  CASH_RECEIPT: 'CRV',
  CASH_PAYMENT: 'CPV',
  BANK_RECEIPT: 'BRV',
  BANK_PAYMENT: 'BPV',
  JOURNAL: 'JV',
  /** Stock leaving a branch on an inter-branch transfer. */
  BRANCH_TRANSFER: 'BTINV',
  /** Stock arriving at a branch against a transfer. */
  DO_RECEIVED: 'DORINV',
  /** Raw material converted into finished goods. */
  PRODUCTION: 'PFINV',
  /** Battery repair / servicing. */
  LAB: 'LABINV',
} as const;

export type Vtype = (typeof VTYPE)[keyof typeof VTYPE];

/**
 * Account-head normal balance.
 *
 * From LedgerController.cs:50 — heads 1 (assets) and 5 (expenses) are
 * debit-normal; everything else is credit-normal. This drives opening balances,
 * ledger running totals, and every financial statement.
 */
export const DEBIT_NORMAL_HEADS: readonly number[] = [1, 5];

export function isDebitNormal(headId: number): boolean {
  return DEBIT_NORMAL_HEADS.includes(headId);
}

/** The head id is the leading digit of a composed account code. */
export function headOf(accountId: number): number {
  return Number(String(accountId).charAt(0));
}
