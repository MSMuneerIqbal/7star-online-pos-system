/**
 * Ledger integrity check.
 *
 *   npx tsx scripts/check-ledger.ts [invId]
 *
 * Two questions, because either one alone can pass on a broken ledger:
 *
 *   1. Does every voucher balance? Debits must net against credits. On legacy
 *      data this is the query that quantifies the damage from the unbalanced
 *      sale posting (see db/accounts.md §4.1).
 *   2. Does every posted document HAVE a voucher? A balanced ledger and an
 *      empty one look identical to question 1 — "no unbalanced vouchers" is
 *      vacuously true with no vouchers at all. That blind spot let a run of the
 *      test suite delete a live sale's legs without this script noticing, so
 *      the orphan check below is not decoration.
 */
import { sql } from 'kysely';
import { db } from '../src/core/db/index.js';

const invId = process.argv[2] ? Number(process.argv[2]) : null;

if (invId !== null) {
  const legs = await db
    .selectFrom('transactions')
    .innerJoin('account', 'account.account_id', 'transactions.account_id')
    .select([
      'transactions.trans_id',
      'transactions.vtype',
      'transactions.account_id',
      'account.name as account_name',
      'transactions.dr',
      'transactions.cr',
      'transactions.detail',
    ])
    .where('transactions.inv_id', '=', invId)
    .orderBy('transactions.trans_id')
    .orderBy('transactions.id')
    .execute();

  if (legs.length === 0) {
    console.log(`No ledger entries for invoice ${invId}.`);
  } else {
    console.log(`Ledger for invoice ${invId}\n`);
    let voucher: number | null = null;

    for (const l of legs) {
      if (l.trans_id !== voucher) {
        voucher = l.trans_id;
        console.log(`  voucher ${l.trans_id} (${l.vtype})`);
      }
      const dr = Number(l.dr) ? Number(l.dr).toFixed(2).padStart(12) : ' '.repeat(12);
      const cr = Number(l.cr) ? Number(l.cr).toFixed(2).padStart(12) : ' '.repeat(12);
      console.log(`    ${String(l.account_id).padEnd(9)} ${(l.account_name ?? '').padEnd(28)} ${dr} ${cr}`);
    }

    const totalDr = legs.reduce((a, l) => a + Number(l.dr), 0);
    const totalCr = legs.reduce((a, l) => a + Number(l.cr), 0);
    console.log(`\n  ${'TOTAL'.padEnd(38)} ${totalDr.toFixed(2).padStart(12)} ${totalCr.toFixed(2).padStart(12)}`);
    console.log(`  imbalance: ${(totalDr - totalCr).toFixed(2)}`);
  }
}

const unbalanced = await sql<{
  vtype: string;
  trans_id: number;
  inv_id: number;
  imbalance: string;
}>`
  SELECT vtype, trans_id, min(inv_id) AS inv_id,
         (sum(dr) - sum(cr))::text AS imbalance
  FROM   transactions
  GROUP  BY vtype, trans_id
  HAVING sum(dr) <> sum(cr)
  ORDER  BY abs(sum(dr) - sum(cr)) DESC
  LIMIT  20
`.execute(db);

const totals = await sql<{ vouchers: string; legs: string }>`
  SELECT count(DISTINCT trans_id)::text AS vouchers, count(*)::text AS legs
  FROM   transactions
`.execute(db);

/**
 * Documents that should have posted but have no legs.
 *
 * `(vtype, inv_id)` is the key — `inv_id` alone is only unique within a voucher
 * type, so a sale and a remittance can and do share one. Anything checking or
 * deleting legs by `inv_id` on its own will hit the wrong document's ledger.
 */
const POSTING_DOCUMENTS: ReadonlyArray<{ table: string; vtype: string; label: string }> = [
  { table: 'sale', vtype: 'SINV', label: 'Sale' },
  { table: 'sale_return', vtype: 'SRINV', label: 'Sale return' },
  { table: 'purchase', vtype: 'PINV', label: 'Purchase' },
  { table: 'purchase_return', vtype: 'PRINV', label: 'Purchase return' },
];

const orphans: Array<{ label: string; id: number }> = [];

for (const doc of POSTING_DOCUMENTS) {
  const rows = await sql<{ id: number }>`
    SELECT d.id
    FROM   ${sql.table(doc.table)} d
    WHERE  NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE  t.vtype = ${doc.vtype} AND t.inv_id = d.id
    )
    ORDER  BY d.id
    LIMIT  20
  `.execute(db);

  for (const r of rows.rows) orphans.push({ label: doc.label, id: r.id });
}

const t = totals.rows[0]!;
console.log(`\n${t.vouchers} voucher(s), ${t.legs} leg(s) in the ledger`);

if (unbalanced.rows.length === 0) {
  console.log('PASS  every voucher balances.');
} else {
  console.log(`FAIL  ${unbalanced.rows.length} unbalanced voucher(s):`);
  for (const r of unbalanced.rows) {
    console.log(`  ${r.vtype} voucher ${r.trans_id} (inv ${r.inv_id}): ${r.imbalance}`);
  }
}

if (orphans.length === 0) {
  console.log('PASS  every posted document has a voucher.');
} else {
  console.log(`FAIL  ${orphans.length} document(s) posted nothing to the ledger:`);
  for (const o of orphans) {
    console.log(`  ${o.label} ${o.id} has no legs — its accounting is missing.`);
  }
}

await db.destroy();
process.exit(unbalanced.rows.length === 0 && orphans.length === 0 ? 0 : 1);
