import { Kysely, PostgresDialect, type Transaction as KyselyTransaction } from 'kysely';
import pg from 'pg';
import { config } from '../config.js';
import type { Database } from './types.js';

const { Pool, types } = pg;

// ---------------------------------------------------------------------------
// Type parsers — these run BEFORE any application code sees a value.
//
// node-postgres parses numeric/int8 into JS numbers by default, which silently
// loses precision. We force them to stay strings; money.ts owns the arithmetic.
// ---------------------------------------------------------------------------

const PG_NUMERIC = 1700;
const PG_INT8 = 20;
const PG_DATE = 1082;

types.setTypeParser(PG_NUMERIC, (v) => v); // numeric -> string
types.setTypeParser(PG_INT8, (v) => v); // bigint  -> string
types.setTypeParser(PG_DATE, (v) => v); // date    -> 'YYYY-MM-DD', no TZ shifting

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Every session runs in the business timezone so date_trunc and ::date
  // behave the way the accountants expect.
  options: `-c timezone=${config.TIMEZONE}`,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle Postgres client', err);
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export type Db = typeof db;
export type Tx = KyselyTransaction<Database>;

/** Anything that can run a query: the pool or an open transaction. */
export type Executor = Db | Tx;

/**
 * Run `fn` inside a single database transaction.
 *
 * Every write path that touches more than one row must use this. The legacy
 * system's posting code did not, which is how it could leave an invoice with
 * inventory issued but no revenue recorded.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}

export async function healthCheck(): Promise<boolean> {
  try {
    await db.selectNoFrom((eb) => eb.lit(1).as('ok')).executeTakeFirst();
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}

export * from './types.js';
