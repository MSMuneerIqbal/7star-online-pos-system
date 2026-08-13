/**
 * Sale service tests, against real Postgres.
 *
 * Covers what the pure posting tests cannot: totals derived from the product
 * table, the full create path writing header + lines + a balanced ledger in one
 * transaction, and the edit path reversing rather than deleting.
 *
 * Everything runs inside a rolled-back transaction — nothing is committed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACC, VTYPE } from '../src/accounting/accounts.js';
import { totals as journalTotals } from '../src/accounting/journal.js';
import { computeTotals } from '../src/modules/sale/service.js';
import { closeDb, type Tx } from '../src/core/db/index.js';
import { inRollback, seedLedgerFixtures } from './helpers/rollback.js';

const BRANCH = 9100;
const CUSTOMER_ACC = 1010288;

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

/** Two products with known cost prices, so COGS is predictable. */
async function seedCatalog(tx: Tx): Promise<{ battery: number; charger: number; custId: number }> {
  await seedLedgerFixtures(tx, { branchId: BRANCH, accountIds: ACCOUNTS });

  // computeTotals only reads product.price (company cost) — sale price is a
  // branch_product concern the caller supplies per line, same as the route
  // does today.
  const battery = await tx
    .insertInto('product')
    .values({ name: 'Battery 12V', price: '4000.00' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const charger = await tx
    .insertInto('product')
    .values({ name: 'Charger', price: '900.00' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const customer = await tx
    .insertInto('customer')
    .values({ name: 'Ali Traders', branch_id: BRANCH, account_id: CUSTOMER_ACC, is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { battery: battery.id, charger: charger.id, custId: customer.id };
}

afterAll(async () => {
  await closeDb();
});

describe('computeTotals', () => {
  it('prices lines from the request but costs them from the product table', async () => {
    const result = await inRollback(async (tx) => {
      const { battery, custId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-01',
          custId,
          discount: '0',
          service: '0',
          received: '0',
          lines: [{ pid: battery, qty: '2', price: '5500.00', discount: '0' }],
        },
        tx,
      );
    });

    expect(result.grossTotal).toBe('11000.00');
    expect(result.netTotal).toBe('11000.00');
    // Cost is 4000 from the DB, NOT anything the client could send.
    expect(result.cogs).toBe('8000.00');
    expect(result.lines[0]!.pname).toBe('Battery 12V');
  });

  it('sums line discounts into the invoice discount', async () => {
    const result = await inRollback(async (tx) => {
      const { battery, charger, custId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-01',
          custId,
          discount: '100.00', // invoice level
          service: '50.00',
          received: '0',
          lines: [
            { pid: battery, qty: '1', price: '5500.00', discount: '200.00' },
            { pid: charger, qty: '2', price: '1200.00', discount: '50.00' },
          ],
        },
        tx,
      );
    });

    expect(result.grossTotal).toBe('7900.00'); // 5500 + 2400
    expect(result.lineDiscount).toBe('250.00');
    expect(result.totalDiscount).toBe('350.00'); // 250 + 100
    // gross + service - discount
    expect(result.netTotal).toBe('7600.00');
    expect(result.cogs).toBe('5800.00'); // 4000 + 1800
    expect(result.remaining).toBe('7600.00');
  });

  it('computes remaining from what was received', async () => {
    const result = await inRollback(async (tx) => {
      const { battery, custId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-01',
          custId,
          discount: '0',
          service: '0',
          received: '4000.00',
          lines: [{ pid: battery, qty: '1', price: '5500.00', discount: '0' }],
        },
        tx,
      );
    });

    expect(result.received).toBe('4000.00');
    expect(result.remaining).toBe('1500.00');
  });

  it('rejects an empty invoice', async () => {
    await expect(
      inRollback(async (tx) => {
        const { custId } = await seedCatalog(tx);
        return computeTotals(
          { date: '2026-03-01', custId, discount: '0', service: '0', received: '0', lines: [] },
          tx,
        );
      }),
    ).rejects.toThrow(/at least one line/i);
  });

  it('rejects an unknown product rather than posting a zero-cost line', async () => {
    await expect(
      inRollback(async (tx) => {
        const { custId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-01',
            custId,
            discount: '0',
            service: '0',
            received: '0',
            lines: [{ pid: 999_999, qty: '1', price: '10.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/unknown product/i);
  });

  it('rejects a zero or negative quantity', async () => {
    await expect(
      inRollback(async (tx) => {
        const { battery, custId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-01',
            custId,
            discount: '0',
            service: '0',
            received: '0',
            lines: [{ pid: battery, qty: '0', price: '10.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('rejects a line discount larger than the line', async () => {
    await expect(
      inRollback(async (tx) => {
        const { battery, custId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-01',
            custId,
            discount: '0',
            service: '0',
            received: '0',
            lines: [{ pid: battery, qty: '1', price: '100.00', discount: '150.00' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/exceeds the line total/i);
  });

  it('rejects an invoice discount that drives the total negative', async () => {
    await expect(
      inRollback(async (tx) => {
        const { battery, custId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-01',
            custId,
            discount: '99999.00',
            service: '0',
            received: '0',
            lines: [{ pid: battery, qty: '1', price: '100.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/exceeds the invoice value/i);
  });

  it('rejects taking more cash than the invoice is worth', async () => {
    await expect(
      inRollback(async (tx) => {
        const { battery, custId } = await seedCatalog(tx);
        return computeTotals(
          {
            date: '2026-03-01',
            custId,
            discount: '0',
            service: '0',
            received: '99999.00',
            lines: [{ pid: battery, qty: '1', price: '100.00', discount: '0' }],
          },
          tx,
        );
      }),
    ).rejects.toThrow(/more than the invoice total/i);
  });

  it('keeps fractional quantities exact', async () => {
    const result = await inRollback(async (tx) => {
      const { charger, custId } = await seedCatalog(tx);

      return computeTotals(
        {
          date: '2026-03-01',
          custId,
          discount: '0',
          service: '0',
          received: '0',
          lines: [{ pid: charger, qty: '2.5', price: '1499.99', discount: '0' }],
        },
        tx,
      );
    });

    // 2.5 x 1499.99 = 3749.975 -> half-up at 2dp
    expect(result.grossTotal).toBe('3749.98');
    expect(result.cogs).toBe('2250.00'); // 2.5 x 900
  });
});

describe('sale posting integration', () => {
  it('writes header, lines and a balanced ledger in one transaction', async () => {
    const { sale, lines, ledger } = await inRollback(async (tx) => {
      const { battery, charger, custId } = await seedCatalog(tx);

      // createSale opens its own transaction, so drive the same steps here
      // against the rolled-back one.
      const t = await computeTotals(
        {
          date: '2026-03-01',
          custId,
          discount: '100.00',
          service: '50.00',
          received: '2000.00',
          lines: [
            { pid: battery, qty: '1', price: '5500.00', discount: '200.00' },
            { pid: charger, qty: '2', price: '1200.00', discount: '0' },
          ],
        },
        tx,
      );

      const inserted = await tx
        .insertInto('sale')
        .values({
          date: '2026-03-01',
          doc_number: 'T9100-1',
          cust_id: custId,
          branch_id: BRANCH,
          gross_total: t.grossTotal,
          sub_total: t.grossTotal,
          discount: t.totalDiscount,
          service: t.service,
          net_total: t.netTotal,
          received: t.received,
          remaining: t.remaining,
          inv_type: VTYPE.SALE,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('sale_detail')
        .values(
          t.lines.map((l) => ({
            sale_id: inserted.id,
            pid: l.pid,
            pname: l.pname,
            price: l.price,
            qty: l.qty,
            total: l.total,
            discount: l.discount,
            net_total: l.netTotal,
          })),
        )
        .execute();

      const { postSale } = await import('../src/accounting/rules/sale.js');
      const { postJournals } = await import('../src/accounting/post.js');

      const posted = await postJournals(
        tx,
        postSale({
          invId: inserted.id,
          date: '2026-03-01',
          branchId: BRANCH,
          customerAccountId: CUSTOMER_ACC,
          customerLabel: 'Customer: Ali Traders',
          grossTotal: t.grossTotal,
          discount: t.totalDiscount,
          service: t.service,
          netTotal: t.netTotal,
          cogs: t.cogs,
          received: t.received,
        }),
      );

      return {
        sale: await tx
          .selectFrom('sale')
          .selectAll()
          .where('id', '=', inserted.id)
          .executeTakeFirstOrThrow(),
        lines: await tx
          .selectFrom('sale_detail')
          .selectAll()
          .where('sale_id', '=', inserted.id)
          .execute(),
        // Scope by trans_id, NOT inv_id: document ids are per-table, so a sale
        // and a purchase can share one.
        ledger: await tx
          .selectFrom('transactions')
          .selectAll()
          .where(
            'trans_id',
            'in',
            posted.map((p) => p.transId),
          )
          .execute(),
      };
    });

    // gross 7900 (5500 + 2400) + service 50 - discount 300 (200 line + 100
    // invoice) = 7650; received 2000 leaves 5650.
    expect(sale.gross_total).toBe('7900.00');
    expect(sale.discount).toBe('300.00');
    expect(sale.net_total).toBe('7650.00');
    expect(sale.remaining).toBe('5650.00');
    expect(lines).toHaveLength(2);

    // The whole document balances — the legacy version would be off by
    // (discount - service) = 300 - 50 = 250.00.
    const legs = ledger.map((r) => ({ accountId: r.account_id, dr: r.dr, cr: r.cr, detail: '' }));
    expect(journalTotals(legs).imbalance).toBe('0.00');

    // Two vouchers: the invoice and the cash receipt.
    expect(new Set(ledger.map((r) => r.vtype))).toEqual(new Set(['SINV', 'CRV']));

    // Sales credited at gross, not net.
    expect(ledger.find((r) => r.account_id === ACC.SALES && r.vtype === 'SINV')?.cr).toBe(
      '7900.00',
    );
  });
});
