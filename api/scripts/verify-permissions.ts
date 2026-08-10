/**
 * Verify the permission tree against the legacy UI's requirements.
 *
 *   npx tsx scripts/verify-permissions.ts
 *
 * Every id the legacy ASP.NET UI checked must resolve to a seeded row, or a
 * real user would hit an invisible menu item or an un-grantable button.
 *
 * The legacy source has been removed, so the ids are read from
 * `src/core/legacy-permissions.json` — a frozen snapshot scraped from all 112
 * Razor views before deletion. That file is the historical record; do not edit
 * it to make this check pass.
 */
import { db } from '../src/core/db/index.js';
import legacy from '../src/core/legacy-permissions.json' with { type: 'json' };

/**
 * Pairs the legacy UI referenced that are DELIBERATELY absent.
 *
 * Three cross-form typos in _Layout.cshtml gated a screen on an action code
 * belonging to a different form. Migration 1700000000008 removed them: this
 * installation starts with fresh books and no imported grants, so there is
 * nothing to preserve, and leaving them would offer an administrator a
 * permission that grants nothing.
 *
 *   19:5071  form 19 is Receiving Request (Raw); 5071 belongs to form 39
 *   22:5024  form 22 is Receiving Request (Finish); 502x belongs to form 18
 *   22:5025
 */
const INTENTIONALLY_DROPPED = new Set(['19:5071', '22:5024', '22:5025']);

const heads = new Set(legacy.heads);
const forms = new Set(legacy.forms);
const actions = new Set(legacy.actions);

console.log(
  `Legacy UI referenced ${heads.size} heads, ${forms.size} forms, ${actions.size} form/action pairs\n`,
);

const dbHeads = new Set(
  (await db.selectFrom('form_head').select('head_id').execute()).map((r) => r.head_id),
);
const dbForms = new Set((await db.selectFrom('form').select('id').execute()).map((r) => r.id));
const dbActions = new Set(
  (await db.selectFrom('forms_action').select(['form_id', 'action_code']).execute()).map(
    (r) => `${r.form_id}:${r.action_code}`,
  ),
);

const missingHeads = [...heads].filter((h) => !dbHeads.has(h)).sort((a, b) => a - b);
const missingForms = [...forms].filter((f) => !dbForms.has(f)).sort((a, b) => a - b);

const dropped = [...actions].filter((a) => INTENTIONALLY_DROPPED.has(a));
const missingActions = [...actions]
  .filter((a) => !dbActions.has(a) && !INTENTIONALLY_DROPPED.has(a))
  .sort();

const report = (label: string, missing: readonly (string | number)[], total: number) => {
  const ok = missing.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${total - missing.length}/${total} resolved`);
  if (!ok) console.log(`      missing: ${missing.join(', ')}`);
  return ok;
};

const allOk =
  report('heads', missingHeads, heads.size) &&
  report('forms', missingForms, forms.size) &&
  report('actions', missingActions, actions.size - dropped.length);

if (dropped.length > 0) {
  console.log(`      ${dropped.length} legacy typo(s) intentionally dropped: ${dropped.join(', ')}`);
}

const counts = await db
  .selectFrom('forms_action')
  .select(({ fn }) => fn.countAll().as('n'))
  .executeTakeFirstOrThrow();

console.log(`\nSeeded: ${dbHeads.size} heads, ${dbForms.size} forms, ${counts.n} actions`);

await db.destroy();

if (!allOk) {
  console.error('\nReconstruction is incomplete — real users would hit missing permissions.');
  process.exit(1);
}

console.log('\nEvery permission id the legacy UI checked exists in the database.');
