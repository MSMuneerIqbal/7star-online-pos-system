/**
 * First-run setup for a NEW installation.
 *
 *   npx tsx scripts/setup.ts "Company Name" "Branch Name" admin <password>
 *
 * Creates only what a working system structurally requires and nothing else:
 * no sample products, no fake customers, no demo invoices. You enter your own
 * data through the application.
 *
 * What migrations already provide:
 *   - the schema
 *   - the permission tree (head -> form -> action)
 *   - branch 0, the "All Branches" sentinel
 *   - the chart of accounts
 *
 * What this adds:
 *   - your company profile (appears on every printed document)
 *   - your first real branch
 *   - a super-admin login
 *   - the walk-in customer record that cash sales post against
 *
 * Idempotent: safe to re-run. Re-running with a different password resets it.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { db, withTransaction } from '../src/core/db/index.js';
import { hashPassword } from '../src/core/auth/password.js';
import { WALK_IN_CUSTOMER_ACCOUNT, WALK_IN_CUSTOMER_ID } from '../src/accounting/accounts.js';

const [companyName = '7 Star Battery', branchName = 'Head Office', username = 'admin'] =
  process.argv.slice(2);

const passwordArg = process.argv[5];
const password = passwordArg ?? randomBytes(12).toString('base64url');

if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

// --- preflight: the chart of accounts must be migrated in ------------------

const accounts = await db
  .selectFrom('account')
  .select(({ fn }) => fn.countAll<string>().as('n'))
  .where('is_fixed', '=', true)
  .executeTakeFirstOrThrow();

if (Number(accounts.n) === 0) {
  console.error(
    'The chart of accounts is missing. Run migrations first:\n  npm run migrate:up',
  );
  await db.destroy();
  process.exit(1);
}

console.log(`chart of accounts: ${accounts.n} fixed account(s) present`);

const result = await withTransaction(async (tx) => {
  // --- company profile -----------------------------------------------------
  const existingSetting = await tx.selectFrom('setting').select('id').executeTakeFirst();

  if (existingSetting) {
    await tx
      .updateTable('setting')
      .set({ name: companyName })
      .where('id', '=', existingSetting.id)
      .execute();
  } else {
    await tx
      .insertInto('setting')
      .values({ name: companyName, delivery_charges: '0' })
      .execute();
  }

  // --- first branch --------------------------------------------------------
  // Branch 0 is the sentinel; real branches start at 1.
  let branch = await tx
    .selectFrom('branch')
    .select(['id', 'name'])
    .where('id', '>', 0)
    .orderBy('id')
    .executeTakeFirst();

  if (!branch) {
    // Code prefixes every document this branch issues and is immutable once
    // set (a CHECK constraint since the catalog-split migration requires
    // one for any real branch) — derived here since this script's caller
    // supplies only a name.
    const code = branchName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8) || 'HQ';

    branch = await tx
      .insertInto('branch')
      .values({ name: branchName, code })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
  }

  // --- walk-in customer ----------------------------------------------------
  // Must be id 1 with account 1010201: the sale posting rules key off both when
  // capturing an ad-hoc cash customer's name and phone.
  const walkIn = await tx
    .selectFrom('customer')
    .select('id')
    .where('id', '=', WALK_IN_CUSTOMER_ID)
    .executeTakeFirst();

  if (!walkIn) {
    await tx
      .insertInto('customer')
      .values({
        id: WALK_IN_CUSTOMER_ID,
        name: 'Walk-in Customer',
        branch_id: branch.id,
        account_id: WALK_IN_CUSTOMER_ACCOUNT,
        is_active: true,
      })
      .execute();
  }

  // An explicit id does not advance the identity sequence, so the next
  // customer insert would collide with it.
  await sql`
    SELECT setval(pg_get_serial_sequence('customer', 'id'),
                  GREATEST((SELECT MAX(id) FROM customer), 1))
  `.execute(tx);

  // --- super admin ---------------------------------------------------------
  // emp_id 0 and branch 0 mean "super admin, all branches" — the same
  // convention the legacy system used, and it bypasses every permission check.
  const password_hash = await hashPassword(password);

  const user = await tx
    .insertInto('user_logins')
    .values({
      username,
      password_hash,
      role_id: null,
      emp_id: 0,
      branch_id: 0,
      is_active: true,
    })
    .onConflict((oc) =>
      oc.column('username').doUpdateSet({ password_hash, is_active: true, updated_at: new Date() }),
    )
    .returning(['id', 'username'])
    .executeTakeFirstOrThrow();

  return { branch, user };
});

console.log(`company:  ${companyName}`);
console.log(`branch:   ${result.branch.id} — ${result.branch.name}`);
console.log(`login:    ${result.user.username} (super admin)`);

if (!passwordArg) {
  console.log(`\n  Generated password: ${password}`);
  console.log('  Store it now — it is hashed with argon2id and cannot be recovered.\n');
}

console.log('Ready. The system has no business data — enter yours through the app.');

await db.destroy();
