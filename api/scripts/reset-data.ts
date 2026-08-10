/**
 * Wipe all business data, keeping the schema and structural reference data.
 *
 *   npx tsx scripts/reset-data.ts --confirm
 *
 * DESTRUCTIVE. Requires --confirm, and refuses to run when NODE_ENV=production.
 *
 * Removes: every invoice, voucher, ledger entry, transfer, lab job, product,
 * customer, supplier, employee, role and audit row.
 *
 * Keeps: the schema, the permission tree, the chart of accounts, branch 0, and
 * any super-admin logins — so the system stays usable immediately afterwards.
 * Re-run `scripts/setup.ts` to restore the walk-in customer and first branch.
 */
import { sql } from 'kysely';
import { db, withTransaction } from '../src/core/db/index.js';
import { config } from '../src/core/config.js';

if (config.NODE_ENV === 'production') {
  console.error('Refusing to wipe a production database.');
  process.exit(1);
}

if (!process.argv.includes('--confirm')) {
  console.error('This deletes ALL business data. Re-run with --confirm if that is what you want.');
  process.exit(1);
}

/**
 * Delete order: children before parents, ledger before the accounts it
 * references. `account` itself is filtered to keep the fixed posting accounts.
 */
const TABLES = [
  // ledger and vouchers
  'transactions',
  'voucher_detail',
  'voucher_master',
  'account_opening',
  // sales
  'sale_return_detail',
  'sale_return',
  'sale_detail',
  'sale',
  'lease_sale_detail',
  'lease_sale',
  'sale_customer',
  // purchases
  'purchase_return_detail',
  'purchase_return',
  'purchase_detail',
  'purchase',
  // transfers
  'do_received_detail',
  'do_received',
  'do_request_detail',
  'do_request',
  'demand_order_detail',
  'demand_order',
  // production and lab
  'production_detail',
  'production',
  'lab_used',
  'lab_detail',
  'lab',
  'lab_received_detail',
  'lab_received',
  // catalog and parties
  'product',
  'raw_product',
  'brand',
  'category',
  'customer',
  'supplier',
  // access
  'refresh_token',
  'role_assign',
  'role',
  'user_log',
] as const;

console.log(`Wiping ${TABLES.length} table(s)…\n`);

const counts: Array<[string, number]> = [];

await withTransaction(async (tx) => {
  for (const table of TABLES) {
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.table(table)}
    `.execute(tx);

    const n = Number(before.rows[0]?.n ?? 0);
    if (n > 0) counts.push([table, n]);

    await sql`DELETE FROM ${sql.table(table)}`.execute(tx);
  }

  // Employees are removed only where no login depends on them, so a super
  // admin cannot orphan itself.
  await sql`
    DELETE FROM employee
    WHERE id NOT IN (SELECT emp_id FROM user_logins WHERE emp_id > 0)
  `.execute(tx);

  // Non-super-admin logins go; super admins stay so you are not locked out.
  await sql`DELETE FROM user_logins WHERE emp_id <> 0`.execute(tx);

  // Party accounts are data; the fixed posting accounts are structure.
  await sql`DELETE FROM account WHERE is_fixed = false`.execute(tx);

  // Real branches go; branch 0 stays as the sentinel every DEFAULT 0 needs.
  await sql`DELETE FROM branch WHERE id > 0`.execute(tx);

  // Restart the voucher sequences so a fresh system numbers from 1.
  await sql`ALTER SEQUENCE transactions_trans_id_seq RESTART WITH 1`.execute(tx);
  await sql`ALTER SEQUENCE transactions_voucher_no_seq RESTART WITH 1`.execute(tx);
});

if (counts.length === 0) {
  console.log('Nothing to delete — already clean.');
} else {
  for (const [table, n] of counts) {
    console.log(`  ${table.padEnd(26)} ${String(n).padStart(7)}`);
  }
}

const remaining = await sql<{ accounts: string; heads: string; forms: string }>`
  SELECT (SELECT count(*)::text FROM account)      AS accounts,
         (SELECT count(*)::text FROM form_head)    AS heads,
         (SELECT count(*)::text FROM forms_action) AS forms
`.execute(db);

const r = remaining.rows[0]!;
console.log(
  `\nKept: ${r.accounts} chart accounts, ${r.heads} permission heads, ${r.forms} actions.`,
);
console.log('Next: npx tsx scripts/setup.ts "Company" "Branch" admin <password>');

await db.destroy();
