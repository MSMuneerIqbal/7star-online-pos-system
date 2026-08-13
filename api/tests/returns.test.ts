/**
 * Sale return and purchase return tests, against real Postgres.
 * Every test runs inside a rolled-back transaction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC, VTYPE } from '../src/accounting/accounts.js';
import { totals as journalTotals } from '../src/accounting/journal.js';
import { postSaleReturn } from '../src/accounting/rules/sale.js';
import { postPurchaseReturn } from '../src/accounting/rules/purchase.js';
import { postJournals } from '../src/accounting/post.js';
import { computeTotals as saleReturnTotals } from '../src/modules/sale-return/service.js';
import { computeTotals as purchaseReturnTotals } from '../src/modules/purchase-return/service.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const BRANCH = 9300;
const CUSTOMER_ACC = 1010277;
const SUPPLIER_ACC = 2010177;

const ACCOUNTS = [
  ACC.CASH,
  ACC.SALES,
  ACC.COGS,
  ACC.INVENTORY_FINISH,
  ACC.INVENTORY_RAW,
  ACC.SALES_DISCOUNT,
  ACC.PURCHASE_DISCOUNT,
  CUSTOMER_ACC,
  SUPPLIER_ACC,
];

async function seed(tx: Tx) {
  await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: ACCOUNTS });

  // Return totals only read product.price (company cost) — sale price is a
  // branch_product concern the caller supplies per line.
  const product = await tx
    .insertInto('product')
    .values({ name: 'Battery 12V 100Ah', price: '11500.00' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const raw = await tx
    .insertInto('raw_product')
    .values({ name: 'Lead Plate', price: '850.00', is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  const customer = await tx
    .insertInto('customer')
    .values({ name: 'Ali Traders', branch_id: BRANCH, account_id: CUSTOMER_ACC, is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  const supplier = await tx
    .insertInto('supplier')
    .values({ name: 'Zenith Metals', branch_id: BRANCH, account_no: SUPPLIER_ACC, is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { pid: product.id, rawId: raw.id, custId: customer.id, supId: supplier.id };
}

afterAll(async () => {
  await closeDb();
});

describe('sale return totals', () => {
  it('credits gross less discount, with no service charge', async () => {
    const result = await inRollback(async (tx) => {
      const { pid, custId } = await seed(tx);

      return saleReturnTotals(
        {
          date: '2026-03-10',
          custId,
          discount: '500.00',
          paid: '0',
          lines: [{ pid, qty: '2', price: '14500.00', discount: '0' }],
        },
        tx,
      );
    });

    expect(result.grossTotal).toBe('29000.00');
    expect(result.netTotal).toBe('28500.00');
    // Goods come back into stock at cost, not at the price they sold for.
    expect(result.cogs).toBe('23000.00');
  });

  it('rejects a refund larger than the credit', async () => {
    await expect(
      inRollback(async (tx) => {
        const { pid, custId } = await seed(tx);
        return saleReturnTotals(
          {
            date: '2026-03-10',
            custId,
            discount: '0',
            paid: '99999.00',
            lines: [{ pid, qty: '1', price: '100.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/more than the return total/i);
  });
});

describe('sale return posting', () => {
  it('balances and mirrors the original sale', async () => {
    const ledger = await inRollback(async (tx) => {
      const { pid, custId } = await seed(tx);

      const t = await saleReturnTotals(
        {
          date: '2026-03-10',
          custId,
          discount: '0',
          paid: '5000.00',
          lines: [{ pid, qty: '1', price: '14500.00', discount: '0' }],
        },
        tx,
      );

      const created = await tx
        .insertInto('sale_return')
        .values({
          date: '2026-03-10',
          doc_number: 'T9300-SR-1',
          cust_id: custId,
          branch_id: BRANCH,
          gross_total: t.grossTotal,
          sub_total: t.grossTotal,
          discount: t.totalDiscount,
          service: '0',
          net_total: t.netTotal,
          paid: t.paid,
          remaining: t.remaining,
          inv_type: VTYPE.SALE_RETURN,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const posted = await postJournals(
        tx,
        postSaleReturn({
          invId: created.id,
          date: '2026-03-10',
          branchId: BRANCH,
          customerAccountId: CUSTOMER_ACC,
          customerLabel: 'Customer: Ali Traders',
          netTotal: t.netTotal,
          cogs: t.cogs,
          paid: t.paid,
        }),
      );

      // Scope by trans_id: inv_id is not unique across document types.
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

    // Sales is DEBITED on a return — the reverse of a sale.
    expect(ledger.find((r) => r.account_id === ACC.SALES && r.vtype === 'SRINV')?.dr).toBe(
      '14500.00',
    );
    // Stock comes back in at cost.
    expect(
      ledger.find((r) => r.account_id === ACC.INVENTORY_FINISH && r.vtype === 'SRINV')?.dr,
    ).toBe('11500.00');
    // The refund is its own voucher.
    expect(new Set(ledger.map((r) => r.vtype))).toEqual(new Set(['SRINV', 'CPV']));
  });
});

describe('purchase return', () => {
  it('derives credit as stock value less discount', async () => {
    const result = await inRollback(async (tx) => {
      const { rawId, supId } = await seed(tx);

      return purchaseReturnTotals(
        {
          date: '2026-03-11',
          supId,
          discount: '300.00',
          rent: '200.00',
          received: '0',
          lines: [{ pid: rawId, qty: '10', price: '850.00', discount: '0' }],
        },
        tx,
      );
    });

    expect(result.subTotal).toBe('8500.00');
    expect(result.stockValue).toBe('8700.00');
    expect(result.netTotal).toBe('8400.00');
  });

  it('posts a balanced entry with no COGS leg', async () => {
    const ledger = await inRollback(async (tx) => {
      const { rawId, supId } = await seed(tx);

      const t = await purchaseReturnTotals(
        {
          date: '2026-03-11',
          supId,
          discount: '300.00',
          rent: '0',
          received: '2000.00',
          lines: [{ pid: rawId, qty: '10', price: '850.00', discount: '0' }],
        },
        tx,
      );

      const created = await tx
        .insertInto('purchase_return')
        .values({
          date: '2026-03-11',
          doc_number: 'T9300-PR-1',
          sup_id: supId,
          branch_id: BRANCH,
          gross_total: t.subTotal,
          sub_total: t.subTotal,
          discount: t.totalDiscount,
          rent: t.rent,
          net_total: t.netTotal,
          received: t.received,
          remaining: t.remaining,
          inv_type: VTYPE.PURCHASE_RETURN,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const posted = await postJournals(
        tx,
        postPurchaseReturn({
          invId: created.id,
          date: '2026-03-11',
          branchId: BRANCH,
          supplierAccountId: SUPPLIER_ACC,
          supplierLabel: 'Zenith Metals',
          subTotal: t.subTotal,
          rent: t.rent,
          discount: t.totalDiscount,
          netTotal: t.netTotal,
          received: t.received,
        }),
      );

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

    // Stock leaves; nothing was expensed, so nothing is un-expensed.
    expect(ledger.find((r) => r.account_id === ACC.INVENTORY_RAW && r.vtype === 'PRINV')?.cr).toBe(
      '8500.00',
    );
    expect(ledger.some((r) => r.account_id === ACC.COGS)).toBe(false);
    expect(new Set(ledger.map((r) => r.vtype))).toEqual(new Set(['PRINV', 'CRV']));
  });
});

describe('hold sale', () => {
  it('writes no ledger entries — nothing is sold until it is converted', async () => {
    const ledgerCount = await inRollback(async (tx) => {
      const { pid, custId } = await seed(tx);

      const hold = await tx
        .insertInto('hold_sale')
        .values({
          date: '2026-03-12',
          doc_number: 'T9300-H-1',
          cust_id: custId,
          branch_id: BRANCH,
          status: 'HELD',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('hold_sale_detail')
        .values({ sale_id: hold.id, pid, pname: 'Battery 12V 100Ah', qty: '3', status: 'HELD' })
        .execute();

      return tx
        .selectFrom('transactions')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('branch_id', '=', BRANCH)
        .executeTakeFirstOrThrow();
    });

    expect(Number(ledgerCount.n)).toBe(0);
  });
});
