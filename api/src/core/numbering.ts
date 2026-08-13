/**
 * Document numbering.
 *
 * Every document carries a branch-prefixed number (`MUL-1`, `MUL-C-1`,
 * `MUL-SR-1`) instead of a bare database id, so a customer reading a docket
 * knows where it came from and two branches cannot produce the same number.
 *
 * The counter lives in `document_counter` (one row per real branch × doc type,
 * seeded by migration 1700000000015 and fanned out to new branches by a
 * trigger). A number is issued inside the caller's transaction under a
 * `SELECT ... FOR UPDATE` row lock, so two concurrent sales at one branch get
 * consecutive numbers with no gap and no duplicate.
 */
import type { Tx } from './db/index.js';
import { unprocessable } from './errors.js';

export type DocType =
  | 'SALE_WALKIN'
  | 'SALE_CREDIT'
  | 'SALE_RETURN'
  | 'PURCHASE'
  | 'PURCHASE_RETURN'
  | 'HOLD_SALE'
  | 'PRODUCTION'
  | 'DEMAND_ORDER'
  | 'DISPATCH'
  | 'RECEIPT'
  | 'REMITTANCE'
  | 'WARRANTY'
  | 'LAB'
  | 'LAB_RECEIVED';

const DOC_CODE: Record<DocType, string | null> = {
  SALE_WALKIN: null,
  SALE_CREDIT: 'C',
  SALE_RETURN: 'SR',
  PURCHASE: 'PI',
  PURCHASE_RETURN: 'PR',
  HOLD_SALE: 'H',
  PRODUCTION: 'PRD',
  DEMAND_ORDER: 'DO',
  DISPATCH: 'DP',
  RECEIPT: 'RC',
  REMITTANCE: 'RM',
  WARRANTY: 'WC',
  LAB: 'LB',
  LAB_RECEIVED: 'LR',
};

export interface DocumentNumber {
  /** The sequence number this document holds (per branch × doc type). */
  seq: number;
  /** The full, human-facing number, e.g. `MUL-SR-1`. */
  docNumber: string;
}

/**
 * Issue the next number for a branch and document type.
 *
 * Must be called inside an open transaction (the caller's `withTransaction`),
 * before the document header is inserted. Editing a document never calls this
 * again — a posted number is never reissued.
 */
export async function issueDocumentNumber(
  tx: Tx,
  branchId: number,
  docType: DocType,
): Promise<DocumentNumber> {
  const row = await tx
    .selectFrom('document_counter')
    .innerJoin('branch', 'branch.id', 'document_counter.branch_id')
    .select(['document_counter.next_number', 'branch.code'])
    .where('document_counter.branch_id', '=', branchId)
    .where('document_counter.doc_type', '=', docType)
    .forUpdate()
    .executeTakeFirst();

  if (!row) {
    throw unprocessable(`No document counter for branch ${branchId}/${docType}`);
  }

  await tx
    .updateTable('document_counter')
    .set({ next_number: row.next_number + 1, updated_at: new Date() })
    .where('branch_id', '=', branchId)
    .where('doc_type', '=', docType)
    .execute();

  const code = DOC_CODE[docType];
  const docNumber = code
    ? `${row.code}-${code}-${row.next_number}`
    : `${row.code}-${row.next_number}`;

  return { seq: row.next_number, docNumber };
}
