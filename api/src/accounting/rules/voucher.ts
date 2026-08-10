/**
 * Manual voucher posting — CRV, CPV, BRV, BPV, JV.
 *
 * Unlike invoices, these legs are entered by the user rather than derived, so
 * the balance check is the only thing standing between a typo and a broken
 * ledger. The legacy UI relied on the operator to balance the form; nothing
 * validated it server-side.
 */
import { ACC, VTYPE, type Vtype } from '../accounts.js';
import { buildJournal, credit, debit, type Journal, type Leg } from '../journal.js';
import { unprocessable } from '../../core/errors.js';
import { isZero, type MoneyString } from '../../core/money.js';

/** One line as entered on the voucher form. */
export interface VoucherLine {
  accountId: number;
  dr: MoneyString;
  cr: MoneyString;
  detail: string;
  /** Bank vouchers only. */
  chequeNo?: string;
  chequeDate?: string;
}

export interface VoucherInput {
  invId: number;
  date: string;
  branchId: number;
  type: 'CRV' | 'CPV' | 'BRV' | 'BPV' | 'JV';
  lines: readonly VoucherLine[];
}

const VTYPE_BY_TYPE: Record<VoucherInput['type'], Vtype> = {
  CRV: VTYPE.CASH_RECEIPT,
  CPV: VTYPE.CASH_PAYMENT,
  BRV: VTYPE.BANK_RECEIPT,
  BPV: VTYPE.BANK_PAYMENT,
  JV: VTYPE.JOURNAL,
};

/**
 * The counter-account each voucher type posts against.
 *
 * `null` for JV: a journal voucher has no implied side, every leg is entered.
 */
export const COUNTER_ACCOUNT: Record<VoucherInput['type'], number | null> = {
  CRV: ACC.CASH,
  CPV: ACC.CASH,
  BRV: ACC.BANK,
  BPV: ACC.BANK,
  JV: null,
};

export function postVoucher(input: VoucherInput): Journal {
  if (input.lines.length === 0) {
    throw unprocessable(`${input.type} has no lines`);
  }

  const legs: Leg[] = [];

  for (const [i, line] of input.lines.entries()) {
    const drZero = isZero(line.dr);
    const crZero = isZero(line.cr);

    if (drZero && crZero) {
      throw unprocessable(`${input.type} line ${i + 1} has no amount`);
    }
    if (!drZero && !crZero) {
      throw unprocessable(
        `${input.type} line ${i + 1} has both a debit and a credit — split it into two lines`,
      );
    }

    legs.push(
      drZero
        ? credit(line.accountId, line.cr, line.detail)
        : debit(line.accountId, line.dr, line.detail),
    );
  }

  // buildJournal rejects anything that doesn't balance.
  return buildJournal({
    vtype: VTYPE_BY_TYPE[input.type],
    date: input.date,
    invId: input.invId,
    branchId: input.branchId,
    legs,
  });
}
