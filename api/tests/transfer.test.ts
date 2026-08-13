/**
 * Inter-branch transfer posting.
 *
 * These rules are a FIX, not a port: the legacy postings were entirely
 * one-sided (see db/accounts.md §4.5). The tests below assert the corrected
 * behaviour and document what the old system did.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC } from '../src/accounting/accounts.js';
import { totals } from '../src/accounting/journal.js';
import {
  inventoryAccount,
  postTransferIn,
  postTransferOut,
} from '../src/accounting/rules/transfer.js';
import { postJournal } from '../src/accounting/post.js';
import { priceLines } from '../src/modules/demand-order/service.js';
import { add, sub } from '../src/core/money.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const FROM_BRANCH = 9501;
const TO_BRANCH = 9502;

const ACCOUNTS = [
  ACC.INVENTORY_RAW,
  ACC.INVENTORY_FINISH,
  ACC.INTER_BRANCH,
  ACC.FREIGHT_IN,
  ACC.CASH,
];

const base = {
  invId: 1,
  date: '2026-05-01',
  fromBranchId: FROM_BRANCH,
  toBranchId: TO_BRANCH,
  fromBranchName: 'Head Office',
  toBranchName: 'Lahore Depot',
  kind: 'RAW' as const,
};

afterAll(async () => {
  await closeDb();
});

describe('transfer out (despatch)', () => {
  it('balances — the legacy version posted only the credit', () => {
    const journal = postTransferOut({ ...base, value: '25000.00' });

    expect(totals(journal.legs).imbalance).toBe('0.00');
    expect(journal.legs).toHaveLength(2);
  });

  it('moves value into inter-branch clearing, out of inventory', () => {
    const journal = postTransferOut({ ...base, value: '25000.00' });

    expect(journal.legs.find((l) => l.accountId === ACC.INTER_BRANCH)?.dr).toBe('25000.00');
    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.cr).toBe('25000.00');
  });

  it('belongs to the despatching branch', () => {
    const journal = postTransferOut({ ...base, value: '100.00' });
    expect(journal.branchId).toBe(FROM_BRANCH);
  });

  it('uses the finished-goods account for a finish transfer', () => {
    const journal = postTransferOut({ ...base, kind: 'FINISH', value: '500.00' });

    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_FINISH)?.cr).toBe('500.00');
    expect(inventoryAccount('FINISH')).toBe(ACC.INVENTORY_FINISH);
    expect(inventoryAccount('RAW')).toBe(ACC.INVENTORY_RAW);
  });
});

describe('transfer in (receipt)', () => {
  const receipt = {
    ...base,
    value: '25000.00',
    receivedValue: '25000.00',
    freight: '1500.00',
    freightPaidInCash: true,
  };

  it('balances — the legacy version posted two debits and no credit at all', () => {
    const journal = postTransferIn(receipt);
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('clears the in-transit value and brings stock in', () => {
    const journal = postTransferIn(receipt);

    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.dr).toBe('25000.00');
    expect(journal.legs.find((l) => l.accountId === ACC.INTER_BRANCH)?.cr).toBe('25000.00');
  });

  it('expenses the short/damaged value as stock loss, never as branch debt', () => {
    const journal = postTransferIn({ ...receipt, receivedValue: '20000.00' });

    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.dr).toBe('20000.00');
    expect(journal.legs.find((l) => l.accountId === ACC.STOCK_LOSS)?.dr).toBe('5000.00');
    expect(journal.legs.find((l) => l.accountId === ACC.INTER_BRANCH)?.cr).toBe('25000.00');
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('expenses freight rather than capitalising it into stock', () => {
    const journal = postTransferIn(receipt);

    // Stock comes in at despatch value only — an internal move must not make
    // the same goods more expensive each time they travel.
    expect(journal.legs.find((l) => l.accountId === ACC.INVENTORY_RAW)?.dr).toBe('25000.00');
    expect(journal.legs.find((l) => l.accountId === ACC.FREIGHT_IN)?.dr).toBe('1500.00');
    expect(journal.legs.find((l) => l.accountId === ACC.CASH)?.cr).toBe('1500.00');
  });

  it('credits inter-branch instead of cash when freight is owed', () => {
    const journal = postTransferIn({ ...receipt, freightPaidInCash: false });

    expect(journal.legs.some((l) => l.accountId === ACC.CASH)).toBe(false);
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('omits the freight legs entirely when there is none', () => {
    const journal = postTransferIn({ ...receipt, freight: '0.00' });

    expect(journal.legs).toHaveLength(2);
    expect(journal.legs.some((l) => l.accountId === ACC.FREIGHT_IN)).toBe(false);
    expect(totals(journal.legs).imbalance).toBe('0.00');
  });

  it('belongs to the receiving branch', () => {
    expect(postTransferIn(receipt).branchId).toBe(TO_BRANCH);
  });
});

describe('the transfer pair, end to end', () => {
  it('leaves inter-branch clearing at zero once received', async () => {
    const legs = await inRollback(async (tx) => {
      await seedLedgerFixtures(tx, { branchId: FROM_BRANCH, accountIds: ACCOUNTS });
      await seedLedgerFixtures(tx, { branchId: TO_BRANCH, accountIds: ACCOUNTS });

      const out = await postJournal(tx, postTransferOut({ ...base, value: '25000.00' }));
      const inn = await postJournal(
        tx,
        postTransferIn({
          ...base,
          invId: 2,
          value: '25000.00',
          receivedValue: '25000.00',
          freight: '1500.00',
          freightPaidInCash: true,
        }),
      );

      return tx
        .selectFrom('transactions')
        .selectAll()
        .where('trans_id', 'in', [out.transId, inn.transId])
        .execute();
    });

    const mapped = legs.map((l) => ({ accountId: l.account_id, dr: l.dr, cr: l.cr, detail: '' }));

    // Both vouchers together still balance.
    expect(totals(mapped).imbalance).toBe('0.00');

    // The clearing account nets to zero — a non-zero balance means stock is
    // still in transit, which is a genuinely useful report.
    const clearing = legs.filter((l) => l.account_id === ACC.INTER_BRANCH);
    const net = clearing.reduce((acc, l) => sub(add(acc, l.dr), l.cr), '0.00');
    expect(net).toBe('0.00');
  });

  it('reproduces the legacy imbalance for comparison', () => {
    // Legacy despatch: Cr inventory only.
    const legacyOut = [{ accountId: ACC.INVENTORY_RAW, dr: '0.00', cr: '25000.00', detail: '' }];
    // Legacy receipt: Dr inventory + Dr freight, no credit.
    const legacyIn = [
      { accountId: ACC.INVENTORY_RAW, dr: '25000.00', cr: '0.00', detail: '' },
      { accountId: ACC.FREIGHT_IN, dr: '1500.00', cr: '0.00', detail: '' },
    ];

    expect(totals(legacyOut).imbalance).toBe('-25000.00');
    expect(totals(legacyIn).imbalance).toBe('26500.00');

    // Even taken together the pair is out by the freight, which never had a
    // counterparty — so every receipt inflated assets permanently.
    expect(totals([...legacyOut, ...legacyIn]).imbalance).toBe('1500.00');
  });
});

describe('transfer valuation', () => {
  async function seedCatalog(tx: Tx) {
    await seedLedgerFixtures(tx, { branchId: FROM_BRANCH, accountIds: ACCOUNTS });

    const raw = await tx
      .insertInto('raw_product')
      .values({ name: 'Lead Plate XFER', price: '850.00', is_active: true })
      .returning('id')
      .executeTakeFirstOrThrow();

    return raw.id;
  }

  it('values a transfer at cost, ignoring any price the client sends', async () => {
    const result = await inRollback(async (tx) => {
      const pid = await seedCatalog(tx);
      // A wildly wrong price is supplied and must be ignored.
      return priceLines(tx, 'RAW', [{ pid, qty: '10', price: '999999.00' }]);
    });

    expect(result.total).toBe('8500.00');
    expect(result.lines[0]!.price).toBe('850.00');
  });

  it('rejects a zero quantity', async () => {
    await expect(
      inRollback(async (tx) => {
        const pid = await seedCatalog(tx);
        return priceLines(tx, 'RAW', [{ pid, qty: '0' }]);
      }),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('rejects an unknown item', async () => {
    await expect(
      inRollback(async (tx) => {
        await seedCatalog(tx);
        return priceLines(tx, 'RAW', [{ pid: 999_999, qty: '1' }]);
      }),
    ).rejects.toThrow(/unknown raw item/i);
  });
});
