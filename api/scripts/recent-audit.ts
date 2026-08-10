/**
 * Show recent audit-log entries.
 *
 *   npx tsx scripts/recent-audit.ts [limit]
 *
 * Ports the legacy User Logs screen as a diagnostic. Every create, edit and
 * delete should appear here; a gap means a write path skipped writeAudit().
 */
import { db } from '../src/core/db/index.js';

const limit = Number(process.argv[2] ?? 15);

const rows = await db
  .selectFrom('user_log')
  .select(['id', 'datetime', 'username', 'form', 'action', 'detail', 'inv_id'])
  .orderBy('id', 'desc')
  .limit(limit)
  .execute();

if (rows.length === 0) {
  console.log('No audit entries yet.');
} else {
  for (const r of rows.reverse()) {
    const when = new Date(r.datetime).toISOString().slice(0, 19).replace('T', ' ');
    console.log(`${when}  ${(r.username ?? '?').padEnd(10)} ${(r.form ?? '').padEnd(8)} ${(r.action ?? '').padEnd(7)} ${r.detail ?? ''}`);
  }
}

await db.destroy();
