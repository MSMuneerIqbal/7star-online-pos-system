/**
 * Chart of accounts.
 *
 * Three levels — head → sub-head → account — with an optional "third" grouping
 * between the last two. The posting code is composed from the *codes* at each
 * level, not the row ids:
 *
 *   account_id = head_code x 1_000_000
 *              + sub_code  x    10_000
 *              + third_code x      100
 *              + sequence
 *
 * Verified against the legacy allocation bases:
 *   1010200 customer  → head 1, sub 01, third 02
 *   2010100 supplier  → head 2, sub 01, third 01
 *   5020100 employee  → head 5, sub 02, third 01
 *
 * ATOMICITY: the legacy system allocated with
 * `SELECT ISNULL(MAX(AccountId), <base>) + 1 ... WHERE HeadId=.. AND SubHeadId=.. AND Third=..`
 * which races — two parties created at the same moment receive the same code
 * and their ledgers silently merge. Allocation here takes a transaction-scoped
 * advisory lock on the bucket, so concurrent callers queue instead of colliding.
 */
import { sql } from 'kysely';
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import type { Principal } from '../../core/rbac.js';

export interface AccountBucket {
  headCode: number;
  subCode: number;
  thirdCode: number;
}

/** The first code in a bucket — the legacy "base" value. */
export function bucketBase(b: AccountBucket): number {
  return b.headCode * 1_000_000 + b.subCode * 10_000 + b.thirdCode * 100;
}

/** The last code a bucket can hold: 99 accounts per bucket. */
export function bucketCeiling(b: AccountBucket): number {
  return bucketBase(b) + 99;
}

/**
 * Reserve the next free account code in a bucket.
 *
 * Must run inside a transaction — the advisory lock is released at commit.
 */
export async function allocateAccountCode(tx: Tx, bucket: AccountBucket): Promise<number> {
  const base = bucketBase(bucket);

  // One lock per bucket. Transaction-scoped, so it unlocks on commit/rollback
  // without any cleanup path to forget.
  await sql`SELECT pg_advisory_xact_lock(${base})`.execute(tx);

  const highest = await tx
    .selectFrom('account')
    .select(({ fn }) => fn.max('account_id').as('max'))
    .where('account_id', '>', base)
    .where('account_id', '<=', bucketCeiling(bucket))
    .executeTakeFirst();

  const next = Number(highest?.max ?? base) + 1;

  if (next > bucketCeiling(bucket)) {
    throw conflict(
      `Account range ${base + 1}–${bucketCeiling(bucket)} is full. ` +
        `Add a new sub-head or third-level group to continue.`,
      { bucket, base },
    );
  }

  return next;
}

/**
 * Allocate a receivable/payable code for a party (customer, supplier, employee).
 * Creates the `account` row as well, so the code is never dangling.
 */
export async function createPartyAccount(
  tx: Tx,
  opts: {
    name: string;
    bucket: AccountBucket;
    headId: number;
    subHeadId: number;
    third?: number;
    branchId: number;
    createdBy: number;
  },
): Promise<number> {
  const accountId = await allocateAccountCode(tx, opts.bucket);

  await tx
    .insertInto('account')
    .values({
      name: opts.name,
      account_id: accountId,
      head_id: opts.headId,
      sub_head_id: opts.subHeadId,
      head_code: opts.bucket.headCode,
      sub_code: opts.bucket.subCode,
      third: opts.third ?? 0,
      third_code: opts.bucket.thirdCode,
      branch_id: opts.branchId,
      is_fixed: false,
      created_by: opts.createdBy,
      updated_by: opts.createdBy,
    })
    .execute();

  return accountId;
}

// ---------------------------------------------------------------------------
// Level 1 — heads
//
// Read-only. The five heads are seeded by migration 1700000000006 and are the
// standard classifications every set of books uses; adding a sixth is almost
// always a modelling mistake that belongs a level down.
// ---------------------------------------------------------------------------

export async function listHeads() {
  return db.selectFrom('account_head').selectAll().orderBy('code').execute();
}

// ---------------------------------------------------------------------------
// Level 2 — sub-heads
//
// Also read-only. Sub-heads shape the financial statements — the split between
// Cost of Sales and Operating Expenses is what makes gross margin meaningful —
// so changing them is a migration, and therefore reviewed and reversible.
// ---------------------------------------------------------------------------

export async function listSubHeads(headId?: number) {
  let q = db
    .selectFrom('account_sub_head')
    .innerJoin('account_head', 'account_head.id', 'account_sub_head.head_id')
    .select([
      'account_sub_head.id',
      'account_sub_head.name',
      'account_sub_head.code',
      'account_sub_head.head_code',
      'account_sub_head.head_id',
      'account_sub_head.is_fixed',
      'account_head.name as head_name',
    ]);

  if (headId !== undefined) q = q.where('account_sub_head.head_id', '=', headId);

  return q.orderBy('account_sub_head.head_code').orderBy('account_sub_head.code').execute();
}

// ---------------------------------------------------------------------------
// Level 3 — final accounts
// ---------------------------------------------------------------------------

export interface AccountFilter {
  headId?: number | undefined;
  subHeadId?: number | undefined;
  search?: string | undefined;
  branchId?: number | null;
}

export async function listAccounts(filter: AccountFilter) {
  let q = db
    .selectFrom('account')
    .leftJoin('account_head', 'account_head.id', 'account.head_id')
    .leftJoin('account_sub_head', 'account_sub_head.id', 'account.sub_head_id')
    .select([
      'account.id',
      'account.account_id',
      'account.name',
      'account.head_id',
      'account.sub_head_id',
      'account.is_fixed',
      'account.branch_id',
      'account_head.name as head_name',
      'account_sub_head.name as sub_head_name',
    ]);

  if (filter.headId !== undefined) q = q.where('account.head_id', '=', filter.headId);
  if (filter.subHeadId !== undefined) q = q.where('account.sub_head_id', '=', filter.subHeadId);

  if (filter.search) {
    const term = `%${filter.search}%`;
    q = q.where((eb) =>
      eb.or([
        eb('account.name', 'ilike', term),
        eb(sql<string>`account.account_id::text`, 'like', term),
      ]),
    );
  }

  // Non-super-admins see fixed accounts plus their own branch's, matching
  // LedgerController.cs:32.
  if (filter.branchId !== null && filter.branchId !== undefined) {
    const branchId = filter.branchId;
    q = q.where((eb) =>
      eb.or([eb('account.is_fixed', '=', true), eb('account.branch_id', '=', branchId)]),
    );
  }

  return q
    .orderBy('account.head_code')
    .orderBy('account.sub_code')
    .orderBy('account.third_code')
    .orderBy('account.name')
    .execute();
}

export async function createAccount(
  principal: Principal,
  input: { name: string; subHeadId: number; thirdCode?: number; branchId: number },
) {
  const subHead = await db
    .selectFrom('account_sub_head')
    .select(['id', 'code', 'head_id', 'head_code', 'name'])
    .where('id', '=', input.subHeadId)
    .executeTakeFirst();

  if (!subHead) throw badRequest(`Unknown sub-head ${input.subHeadId}`);

  return withTransaction(async (tx) => {
    const bucket: AccountBucket = {
      headCode: subHead.head_code,
      subCode: subHead.code,
      thirdCode: input.thirdCode ?? 1,
    };

    const accountId = await allocateAccountCode(tx, bucket);

    const row = await tx
      .insertInto('account')
      .values({
        name: input.name,
        account_id: accountId,
        head_id: subHead.head_id,
        sub_head_id: subHead.id,
        head_code: subHead.head_code,
        sub_code: subHead.code,
        third: 0,
        third_code: bucket.thirdCode,
        branch_id: input.branchId,
        is_fixed: false,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Final Account',
        action: 'New',
        detail: `Created account ${accountId} — ${row.name}`,
        invId: row.id,
      },
      tx,
    );

    return row;
  });
}

export async function renameAccount(
  principal: Principal,
  accountId: number,
  name: string,
) {
  const existing = await db
    .selectFrom('account')
    .select(['id', 'account_id', 'name', 'is_fixed'])
    .where('account_id', '=', accountId)
    .executeTakeFirst();

  if (!existing) throw notFound('Account');

  // Fixed accounts are referenced by code in the posting rules; renaming is
  // harmless but deleting or renumbering is not, so only the label may change.
  return withTransaction(async (tx) => {
    const row = await tx
      .updateTable('account')
      .set({ name, updated_at: new Date(), updated_by: principal.empId })
      .where('account_id', '=', accountId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Final Account',
        action: 'Edit',
        detail: `Renamed account ${accountId}: ${existing.name} -> ${name}`,
        invId: row.id,
      },
      tx,
    );

    return row;
  });
}
