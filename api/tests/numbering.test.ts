/**
 * Document numbering tests (Phase 2).
 *
 * The counter primitive that every later phase depends on: correct format per
 * doc type, sequential-and-distinct behaviour, and — the hard one — that two
 * concurrent issuers cannot get the same number.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/core/db/index.js';
import { issueDocumentNumber, type DocType } from '../src/core/numbering.js';
import { inRollback } from './helpers/rollback.js';

const ALL_TYPES: DocType[] = [
  'SALE_WALKIN',
  'SALE_CREDIT',
  'SALE_RETURN',
  'PURCHASE',
  'PURCHASE_RETURN',
  'HOLD_SALE',
  'PRODUCTION',
  'DEMAND_ORDER',
  'LAB',
  'LAB_RECEIVED',
];

afterAll(async () => {
  await closeDb();
});

/** Insert a real branch; its fan-out trigger creates all ten counters. */
async function seedBranch(tx: import('../src/core/db/index.js').Tx, id: number, code: string) {
  await tx
    .insertInto('branch')
    .values({ id, name: `Numbering Branch ${id}`, code })
    .execute();
}

describe('issueDocumentNumber — format', () => {
  it('prefixes each doc type with the branch code and its own letter', async () => {
    const branchId = 9500;

    const result = await inRollback(async (tx) => {
      await seedBranch(tx, branchId, 'FMT');

      const out: Record<string, string> = {};
      for (const t of ALL_TYPES) {
        out[t] = (await issueDocumentNumber(tx, branchId, t)).docNumber;
      }
      return out;
    });

    expect(result.SALE_WALKIN).toBe('FMT-1');
    expect(result.SALE_CREDIT).toBe('FMT-C-1');
    expect(result.SALE_RETURN).toBe('FMT-SR-1');
    expect(result.PURCHASE).toBe('FMT-PI-1');
    expect(result.PURCHASE_RETURN).toBe('FMT-PR-1');
    expect(result.HOLD_SALE).toBe('FMT-H-1');
    expect(result.PRODUCTION).toBe('FMT-PRD-1');
    expect(result.DEMAND_ORDER).toBe('FMT-DO-1');
    expect(result.LAB).toBe('FMT-LB-1');
    expect(result.LAB_RECEIVED).toBe('FMT-LR-1');
  });
});

describe('issueDocumentNumber — sequence', () => {
  it('issues consecutive numbers within one doc type', async () => {
    const branchId = 9501;

    const seqs = await inRollback(async (tx) => {
      await seedBranch(tx, branchId, 'SEQ');

      const a = await issueDocumentNumber(tx, branchId, 'SALE_WALKIN');
      const b = await issueDocumentNumber(tx, branchId, 'SALE_WALKIN');
      return [a.seq, a.docNumber, b.seq, b.docNumber];
    });

    expect(seqs).toEqual([1, 'SEQ-1', 2, 'SEQ-2']);
  });

  it('keeps walk-in and credit sale series independent', async () => {
    const branchId = 9502;

    const seqs = await inRollback(async (tx) => {
      await seedBranch(tx, branchId, 'WIC');

      const walkin = await issueDocumentNumber(tx, branchId, 'SALE_WALKIN');
      const credit = await issueDocumentNumber(tx, branchId, 'SALE_CREDIT');
      return [walkin.docNumber, credit.docNumber];
    });

    expect(seqs).toEqual(['WIC-1', 'WIC-C-1']);
  });
});

describe('issueDocumentNumber — concurrency', () => {
  it('serialises two concurrent issuers with no gap and no duplicate', async () => {
    const branchId = 9503;

    // A real, committed branch so two separate pool connections can both see
    // it. The fan-out trigger creates the counters on insert.
    await db
      .insertInto('branch')
      .values({ id: branchId, name: `Concurrency Branch ${branchId}`, code: `T${branchId}` })
      .execute();

    try {
      // Two separate connections, each its own transaction. FOR UPDATE makes
      // the second wait for the first, so the sequences must be {1, 2}.
      const [r1, r2] = await Promise.all([
        db.transaction().execute((tx) => issueDocumentNumber(tx, branchId, 'SALE_WALKIN')),
        db.transaction().execute((tx) => issueDocumentNumber(tx, branchId, 'SALE_WALKIN')),
      ]);

      const seqs = [r1.seq, r2.seq].sort((a, b) => a - b);
      expect(seqs).toEqual([1, 2]);
      expect(new Set([r1.docNumber, r2.docNumber]).size).toBe(2);
    } finally {
      // Clean up in FK order — counters reference the branch.
      await db.deleteFrom('document_counter').where('branch_id', '=', branchId).execute();
      await db.deleteFrom('branch_product').where('branch_id', '=', branchId).execute();
      await db.deleteFrom('branch').where('id', '=', branchId).execute();
    }
  });
});
