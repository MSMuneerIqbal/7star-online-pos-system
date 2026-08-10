/**
 * Connectivity and environment check.
 *
 *   npx tsx scripts/db-check.ts
 *
 * Verifies the pool connects, reports server settings that affect money and
 * date handling, and lists what has been migrated so far.
 */
import { sql } from 'kysely';
import { db, healthCheck } from '../src/core/db/index.js';
import { config } from '../src/core/config.js';

const host = new URL(config.DATABASE_URL).host;
console.log(`Connecting to ${host}\n`);

if (!(await healthCheck())) {
  console.error('Health check failed — could not reach the database.');
  process.exit(1);
}

const info = await sql<{
  version: string;
  db: string;
  tz: string;
  user: string;
}>`
  SELECT version()                        AS version,
         current_database()               AS db,
         current_setting('TimeZone')      AS tz,
         current_user                     AS user
`.execute(db);

const row = info.rows[0]!;
console.log(`server   ${row.version.split(',')[0]}`);
console.log(`database ${row.db}  user ${row.user}`);
console.log(`timezone ${row.tz}  (expected ${config.TIMEZONE})`);

if (row.tz !== config.TIMEZONE) {
  console.warn(
    `\n  WARNING: session timezone is ${row.tz}, not ${config.TIMEZONE}.\n` +
      `  Pooled connections (PgBouncer) may ignore startup options.\n` +
      `  date_trunc and ::date will use the wrong day boundary.`,
  );
}

// numeric must arrive as a string, or money silently loses precision.
const numericProbe = await sql<{ n: unknown; big: unknown }>`
  SELECT 9999999999999999.99::numeric(18,2) AS n, 9007199254740993::int8 AS big
`.execute(db);

const probe = numericProbe.rows[0]!;
console.log(`\nnumeric -> ${typeof probe.n} ${JSON.stringify(probe.n)}`);
console.log(`int8    -> ${typeof probe.big} ${JSON.stringify(probe.big)}`);

if (typeof probe.n !== 'string' || typeof probe.big !== 'string') {
  console.error('\n  FAIL: numeric/int8 are not strings. Money precision is at risk.');
  process.exit(1);
}

const tables = await sql<{ table_name: string }>`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name
`.execute(db);

console.log(`\n${tables.rows.length} tables in public:`);
console.log(
  tables.rows.length
    ? tables.rows.map((t) => `  ${t.table_name}`).join('\n')
    : '  (none — run `npm run migrate:up`)',
);

await db.destroy();
