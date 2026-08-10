import { db, type Tx } from '../../src/core/db/index.js';

/**
 * Run a test body inside a transaction that is ALWAYS rolled back.
 *
 * These tests run against a real (shared, cloud-hosted) database, so they must
 * never leave rows behind. Throwing a sentinel forces Kysely to roll back; the
 * sentinel is swallowed and the body's return value handed back.
 *
 * Caveat: sequences are non-transactional by design, so `nextval` values are
 * consumed even on rollback. Tests must therefore assert that ids are
 * *distinct and increasing*, never that they equal a specific number.
 */
class Rollback extends Error {
  constructor() {
    super('intentional test rollback');
  }
}

export async function inRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let captured: T;
  let ran = false;

  try {
    await db.transaction().execute(async (tx) => {
      captured = await fn(tx);
      ran = true;
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  if (!ran) throw new Error('transaction body did not complete');

  return captured!;
}

/**
 * Minimal reference data the ledger's foreign keys require: a branch, an
 * account head, and the accounts used by the posting rules.
 */
export async function seedLedgerFixtures(
  tx: Tx,
  opts: { branchId: number; accountIds: readonly number[] },
): Promise<void> {
  await tx
    .insertInto('branch')
    .values({ id: opts.branchId, name: `Test Branch ${opts.branchId}` })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // One head per leading digit used by the accounts under test.
  const heads = [...new Set(opts.accountIds.map((a) => Number(String(a).charAt(0))))];

  for (const head of heads) {
    await tx
      .insertInto('account_head')
      .values({ id: head, name: `Head ${head}`, code: head })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  await tx
    .insertInto('account_sub_head')
    .values({ id: 1, name: 'Test SubHead', code: 1, head_code: 1, head_id: heads[0]! })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  for (const accountId of new Set(opts.accountIds)) {
    const head = Number(String(accountId).charAt(0));

    await tx
      .insertInto('account')
      .values({
        name: `Account ${accountId}`,
        account_id: accountId,
        head_id: head,
        sub_head_id: 1,
        head_code: head,
        sub_code: 1,
      })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();
  }
}
