/**
 * Purchase service tests, against real Postgres.
 * Every test runs inside a rolled-back transaction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC, VTYPE } from '../src/accounting/accounts.js';
import { totals as journalTotals } from '../src/accounting/journal.js';
import { postPurchase } from '../src/accounting/rules/purchase.js';
import { postJournals } from '../src/accounting/post.js';
import { computeTotals } from '../src/modules/purchase/service.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const BRANCH = 9200;
const SUPPLIER_ACC = 2010199;

const ACCOUNTS = [ACC.CASH, ACC.INVENTORY_RAW, ACC.PURCHASE_DISCOUNT, SUPPLIER_ACC];

async function seedCatalog(tx: Tx): Promise<{ lead: number; acid: number; supId: number }> {
  await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: ACCOUNTS });

  const lead = await tx
    .insertInto('raw_product')
    .values({ name: 'Lead Plate', price: '850.00', is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  const acid = await tx
    .insertInto('raw_product')
    .values({ name: 'Sulphuric Acid 1L', price: '120.00', is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  const supplier = await tx
    .insertInto('supplier')
    .values({
      name: 'Zenith Metals',
      branch_id: BRANCH,
      account_no: SUPPLIER_ACC,
      is_active: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { lead: lead.id, acid: acid.id, supId: supplier.id };
}

afterAll(async () => {
  await closeDb();
});

describe('purchase totals', () => {
  it('capitalises freight into stock value', async () => {
    const result = await inRollback(async (tx) => {
      const { lead, supId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-05',
          supId,
          discount: '0',
          rent: '500.00',
          paid: '0',
          lines: [{ pid: lead, qty: '10', price: '850.00', discount: '0' }],
        },
        tx,
      );
    });

    expect(result.subTotal).toBe('8500.00');
    expect(result.rent).toBe('500.00');
    // Freight lands in inventory, not in an expense account.
    expect(result.stockValue).toBe('9000.00');
    expect(result.netTotal).toBe('9000.00');
  });

  it('derives net as stock value minus total discount', async () => {
    const result = await inRollback(async (tx) => {
      const { lead, acid, supId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-05',
          supId,
          discount: '200.00',
          rent: '300.00',
          paid: '0',
          lines: [
            { pid: lead, qty: '4', price: '850.00', discount: '100.00' },
            { pid: acid, qty: '20', price: '120.00', discount: '0' },
          ],
        },
        tx,
      );
    });

    expect(result.subTotal).toBe('5800.00'); // 3400 + 2400
    expect(result.totalDiscount).toBe('300.00'); // 100 line + 200 invoice
    expect(result.stockValue).toBe('6100.00'); // 5800 + 300 freight
    expect(result.netTotal).toBe('5800.00'); // 6100 - 300
  });

  it('names the raw item, not a finished product', async () => {
    const result = await inRollback(async (tx) => {
      const { lead, supId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-05',
          supId,
          discount: '0',
          rent: '0',
          paid: '0',
          lines: [{ pid: lead, qty: '1', price: '850.00', discount: '0' }],
        },
        tx,
      );
    });

    expect(result.lines[0]!.pname).toBe('Lead Plate');
  });

  it('rejects an unknown raw item', async () => {
    await expect(
      inRollback(async (tx) => {
        const { supId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-05',
            supId,
            discount: '0',
            rent: '0',
            paid: '0',
            lines: [{ pid: 999_999, qty: '1', price: '10.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/unknown raw item/i);
  });

  it('rejects paying more than the invoice', async () => {
    await expect(
      inRollback(async (tx) => {
        const { lead, supId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-05',
            supId,
            discount: '0',
            rent: '0',
            paid: '99999.00',
            lines: [{ pid: lead, qty: '1', price: '850.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/more than the invoice total/i);
  });

  it('rejects a discount larger than the purchase value', async () => {
    await expect(
      inRollback(async (tx) => {
        const { lead, supId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-05',
            supId,
            discount: '99999.00',
            rent: '0',
            paid: '0',
            lines: [{ pid: lead, qty: '1', price: '850.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/exceeds the purchase value/i);
  });
});

describe('purchase posting', () => {
  it('posts a balanced entry with freight and part payment', async () => {
    const ledger = await inRollback(async (tx) => {
      const { lead, supId } = await seedCatalog(tx);

      const t = await computeTotals(
        {
          date: '2026-03-05',
          supId,
          discount: '200.00',
          rent: '300.00',
          paid: '2000.00',
          lines: [{ pid: lead, qty: '10', price: '850.00', discount: '0' }],
        },
        tx,
      );

      const purchase = await tx
        .insertInto('purchase')
        .values({
          date: '2026-03-05',
          sup_id: supId,
          branch_id: BRANCH,
          gross_total: t.subTotal,
          sub_total: t.subTotal,
          discount: t.totalDiscount,
          rent: t.rent,
          net_total: t.netTotal,
          paid: t.paid,
          remaining: t.remaining,
          inv_type: VTYPE.PURCHASE,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const posted = await postJournals(
        tx,
        postPurchase({
          invId: purchase.id,
          date: '2026-03-05',
          branchId: BRANCH,
          supplierAccountId: SUPPLIER_ACC,
          supplierLabel: 'Zenith Metals',
          subTotal: t.subTotal,
          rent: t.rent,
          discount: t.totalDiscount,
          netTotal: t.netTotal,
          paid: t.paid,
        }),
      );

      // Scope by trans_id, NOT inv_id. Document ids are per-table, so a sale
      // and a purchase can share one — filtering on inv_id alone pulled in an
      // unrelated sale's legs and made this test fail intermittently.
      return tx
        .selectFrom('transactions')
        .selectAll()
        .where(
          'trans_id',
          'in',
          posted.map((p) => p.transId),
        )
        .execute();
    });

    const legs = ledger.map((r) => ({ accountId: r.account_id, dr: r.dr, cr: r.cr, detail: '' }));
    expect(journalTotals(legs).imbalance).toBe('0.00');

    // Inventory debited with freight included: 8500 + 300.
    expect(ledger.find((r) => r.account_id === ACC.INVENTORY_RAW && r.vtype === 'PINV')?.dr).toBe(
      '8800.00',
    );

    // No COGS on a purchase — nothing is expensed until the goods are sold.
    expect(ledger.some((r) => r.account_id === ACC.COGS)).toBe(false);

    // Payment is its own voucher.
    expect(new Set(ledger.map((r) => r.vtype))).toEqual(new Set(['PINV', 'CPV']));
  });
});
