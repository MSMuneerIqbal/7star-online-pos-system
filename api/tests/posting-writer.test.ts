/**
 * Database-backed tests for the journal writer.
 *
 * These cover what the pure-rule tests cannot: sequence allocation, multi-leg
 * inserts, the one-sided CHECK constraint, and the reversal flow that replaces
 * the legacy `DELETE FROM Transactions`.
 *
 * Every test runs inside a rolled-back transaction — nothing is committed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC, VTYPE } from '../src/accounting/accounts.js';
import { buildJournal, credit, debit, totals } from '../src/accounting/journal.js';
import {
  loadDocumentJournals,
  postJournal,
  postJournals,
  repostDocument,
} from '../src/accounting/post.js';
import { postSale } from '../src/accounting/rules/sale.js';
import { closeDb, withTransaction, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const BRANCH = 9001;
const CUSTOMER_ACC = 1010299;

const ACCOUNTS = [
  ACC.CASH,
  ACC.SALES,
  ACC.SERVICE_INCOME,
  ACC.SALES_DISCOUNT,
  ACC.PURCHASE_DISCOUNT,
  ACC.COGS,
  ACC.INVENTORY_FINISH,
  CUSTOMER_ACC,
];

async function seed(tx: Tx): Promise<void> {
  await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: ACCOUNTS });
}

function simpleJournal(invId: number, amount = '100.00') {
  return buildJournal({
    vtype: VTYPE.SALE,
    date: '2026-02-01',
    invId,
    branchId: BRANCH,
    legs: [
      debit(CUSTOMER_ACC, amount, 'Receivable'),
      credit(ACC.SALES, amount, 'Revenue'),
    ],
  });
}

afterAll(async () => {
  await closeDb();
});

describe('postJournal', () => {
  it('writes one row per leg with a shared trans_id and voucher_no', async () => {
    const rows = await inRollback(async (tx) => {
      await seed(tx);
      const posted = await postJournal(tx, simpleJournal(1001, '250.00'));

      expect(posted.legCount).toBe(2);

      return tx
        .selectFrom('transactions')
        .selectAll()
        .where('trans_id', '=', posted.transId)
        .orderBy('id')
        .execute();
    });

    expect(rows).toHaveLength(2);

    // Both legs share one voucher grouping.
    expect(new Set(rows.map((r) => r.trans_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.voucher_no)).size).toBe(1);

    expect(rows[0]).toMatchObject({
      account_id: CUSTOMER_ACC,
      dr: '250.00',
      cr: '0.00',
      vtype: 'SINV',
      inv_id: 1001,
      branch_id: BRANCH,
    });
    expect(rows[1]).toMatchObject({ account_id: ACC.SALES, dr: '0.00', cr: '250.00' });
  });

  it('returns money as strings, preserving full numeric(18,2) precision', async () => {
    const rows = await inRollback(async (tx) => {
      await seed(tx);
      const big = '9999999999999999.99';

      const { transId } = await postJournal(tx, simpleJournal(1002, big));

      return tx
        .selectFrom('transactions')
        .select(['dr', 'cr'])
        .where('trans_id', '=', transId)
        .orderBy('id')
        .execute();
    });

    expect(typeof rows[0]!.dr).toBe('string');
    expect(rows[0]!.dr).toBe('9999999999999999.99');
  });

  it('allocates a distinct trans_id per journal — no MAX()+1 race', async () => {
    const ids = await inRollback(async (tx) => {
      await seed(tx);

      const posted = await postJournals(tx, [
        simpleJournal(1003, '10.00'),
        simpleJournal(1003, '20.00'),
        simpleJournal(1003, '30.00'),
      ]);

      return posted.map((p) => p.transId);
    });

    expect(new Set(ids).size).toBe(3);
    // Strictly increasing — the sequence hands out ordered values.
    expect(ids[1]!).toBeGreaterThan(ids[0]!);
    expect(ids[2]!).toBeGreaterThan(ids[1]!);
  });

  it('stamps a late-assigned invoice id onto every leg', async () => {
    const rows = await inRollback(async (tx) => {
      await seed(tx);

      // invId 0 is the pre-insert placeholder; the real id arrives after the
      // document row is written.
      const { transId } = await postJournal(tx, simpleJournal(0), { invId: 7777 });

      return tx
        .selectFrom('transactions')
        .select('inv_id')
        .where('trans_id', '=', transId)
        .execute();
    });

    expect(rows.every((r) => r.inv_id === 7777)).toBe(true);
  });

  it('persists a full sale — invoice and cash receipt as separate vouchers', async () => {
    const { rows, posted } = await inRollback(async (tx) => {
      await seed(tx);

      const journals = postSale({
        invId: 2001,
        date: '2026-02-01',
        branchId: BRANCH,
        customerAccountId: CUSTOMER_ACC,
        customerLabel: 'Customer: Test',
        grossTotal: '1030.00',
        discount: '50.00',
        service: '20.00',
        netTotal: '1000.00',
        cogs: '800.00',
        received: '400.00',
      });

      const posted = await postJournals(tx, journals);

      const rows = await tx
        .selectFrom('transactions')
        .selectAll()
        .where('inv_id', '=', 2001)
        .orderBy('id')
        .execute();

      return { rows, posted };
    });

    expect(posted).toHaveLength(2);

    // Two distinct vouchers: SINV and CRV.
    expect(new Set(rows.map((r) => r.vtype))).toEqual(new Set(['SINV', 'CRV']));

    // The whole document nets to zero — the legacy version was off by
    // (discount - service) = 30.00.
    const legs = rows.map((r) => ({ accountId: r.account_id, dr: r.dr, cr: r.cr, detail: '' }));
    expect(totals(legs).imbalance).toBe('0.00');

    // Sales credited at gross, not net.
    const sales = rows.find((r) => r.account_id === ACC.SALES);
    expect(sales?.cr).toBe('1030.00');
  });
});

describe('database constraints', () => {
  it('rejects a two-sided leg via chk_transactions_one_sided', async () => {
    // The application blocks this in buildJournal; this proves the database
    // independently refuses it, so a raw insert cannot corrupt the ledger.
    await expect(
      inRollback(async (tx) => {
        await seed(tx);

        await tx
          .insertInto('transactions')
          .values({
            date: '2026-02-01',
            inv_id: 1,
            vtype: 'SINV',
            dr: '50.00',
            cr: '50.00', // both sides — illegal
            account_id: ACC.CASH,
            detail: 'illegal',
            voucher_no: 1,
            trans_id: 1,
            branch_id: BRANCH,
          })
          .execute();
      }),
    ).rejects.toThrow();
  });

  it('rejects a leg with no amount', async () => {
    await expect(
      inRollback(async (tx) => {
        await seed(tx);

        await tx
          .insertInto('transactions')
          .values({
            date: '2026-02-01',
            inv_id: 1,
            vtype: 'SINV',
            dr: '0.00',
            cr: '0.00',
            account_id: ACC.CASH,
            detail: 'empty',
            voucher_no: 1,
            trans_id: 1,
            branch_id: BRANCH,
          })
          .execute();
      }),
    ).rejects.toThrow();
  });

  it('rejects a posting to an unknown account', async () => {
    await expect(
      inRollback(async (tx) => {
        await seed(tx);

        await postJournal(
          tx,
          buildJournal({
            vtype: VTYPE.SALE,
            date: '2026-02-01',
            invId: 1,
            branchId: BRANCH,
            legs: [
              debit(9999999, '10.00', 'nonexistent account'),
              credit(ACC.SALES, '10.00', 'revenue'),
            ],
          }),
        );
      }),
    ).rejects.toThrow();
  });
});

describe('loadDocumentJournals', () => {
  it('reassembles posted legs back into balanced journals', async () => {
    const loaded = await inRollback(async (tx) => {
      await seed(tx);
      await postJournal(tx, simpleJournal(3001, '175.50'));

      return loadDocumentJournals(tx, VTYPE.SALE, 3001);
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.legs).toHaveLength(2);
    expect(totals(loaded[0]!.legs).imbalance).toBe('0.00');
    expect(loaded[0]!.branchId).toBe(BRANCH);
  });

  it('groups multiple vouchers for one document separately', async () => {
    const loaded = await inRollback(async (tx) => {
      await seed(tx);

      await postJournals(tx, [simpleJournal(3002, '10.00'), simpleJournal(3002, '20.00')]);

      return loadDocumentJournals(tx, VTYPE.SALE, 3002);
    });

    expect(loaded).toHaveLength(2);
  });
});

describe('repostDocument', () => {
  it('reverses the old entries and posts the new, leaving history intact', async () => {
    const rows = await inRollback(async (tx) => {
      await seed(tx);

      // Original invoice: 100.00
      await postJournal(tx, simpleJournal(4001, '100.00'));

      // Corrected to 150.00
      await repostDocument(tx, VTYPE.SALE, 4001, [simpleJournal(4001, '150.00')]);

      return tx
        .selectFrom('transactions')
        .selectAll()
        .where('inv_id', '=', 4001)
        .orderBy('id')
        .execute();
    });

    // 2 original + 2 reversal + 2 new — the legacy DELETE would have left 2.
    expect(rows).toHaveLength(6);

    // The original entries survive for audit.
    expect(rows.filter((r) => r.detail?.startsWith('REVERSAL'))).toHaveLength(2);

    // Net position equals the corrected amount, not the sum of both.
    const receivable = rows.filter((r) => r.account_id === CUSTOMER_ACC);
    const net = receivable.reduce(
      (acc, r) => acc + Number(r.dr) - Number(r.cr),
      0,
    );
    expect(net).toBe(150);

    // And the document as a whole still balances.
    const legs = rows.map((r) => ({ accountId: r.account_id, dr: r.dr, cr: r.cr, detail: '' }));
    expect(totals(legs).imbalance).toBe('0.00');
  });

  it('can date the reversal separately, for a closed period', async () => {
    const rows = await inRollback(async (tx) => {
      await seed(tx);

      await postJournal(tx, simpleJournal(4002, '100.00'));
      await repostDocument(tx, VTYPE.SALE, 4002, [simpleJournal(4002, '120.00')], '2026-03-31');

      return tx
        .selectFrom('transactions')
        .select(['date', 'detail'])
        .where('inv_id', '=', 4002)
        .orderBy('id')
        .execute();
    });

    const reversals = rows.filter((r) => r.detail?.startsWith('REVERSAL'));
    expect(reversals).toHaveLength(2);
    expect(reversals.every((r) => r.date === '2026-03-31')).toBe(true);
  });

  it('handles a document with nothing previously posted', async () => {
    const result = await inRollback(async (tx) => {
      await seed(tx);
      return repostDocument(tx, VTYPE.SALE, 4003, [simpleJournal(4003, '50.00')]);
    });

    expect(result.reversed).toHaveLength(0);
    expect(result.posted).toHaveLength(1);
  });
});

describe('transaction atomicity', () => {
  it('rolls back every leg when a later leg fails', async () => {
    // The legacy Sale.Save had no transaction boundary, so a failure midway
    // left inventory issued with no revenue recorded.
    //
    // This runs a REAL transaction rather than a nested one (Kysely has no
    // nested transactions). Nothing is committed: the transaction is expected
    // to fail, and a failed transaction rolls back by definition — which is
    // precisely the property under test.
    await expect(
      withTransaction(async (tx) => {
        await seed(tx);
        await postJournal(tx, simpleJournal(5001, '100.00'));

        // Same document, but an account that does not exist. The FK fails and
        // must take the first journal down with it.
        await postJournal(
          tx,
          buildJournal({
            vtype: VTYPE.SALE,
            date: '2026-02-01',
            invId: 5001,
            branchId: BRANCH,
            legs: [
              debit(8888888, '5.00', 'bad account'),
              credit(ACC.SALES, '5.00', 'revenue'),
            ],
          }),
        );
      }),
    ).rejects.toThrow();

    // Nothing from the failed transaction survived.
    const remaining = await inRollback((tx) =>
      tx.selectFrom('transactions').select('id').where('inv_id', '=', 5001).execute(),
    );

    expect(remaining).toHaveLength(0);
  });
});
