# 7 Star Battery POS — Node.js API

Fastify + TypeScript + Kysely + PostgreSQL. Replaces the ASP.NET Core 8 MVC
backend. See [`../PLAN.md`](../PLAN.md) for the full rewrite plan.

## Status — running against Neon; PLAN.md's phased reshape now under way

The table below predates [`../PLAN.md`](../PLAN.md) and describes the initial
port against the reconstructed legacy schema. That port is done, but PLAN.md
found the business model on top of it was wrong (see PRINCIPLES §16) and set
a phased reshape in motion. Three phases have landed since:

- **The catalog split** (PLAN.md Phase 1) — `product` is now one row per
  model, company-wide; branch price/location/threshold live on the new
  `branch_product` table (migration `1700000000010`, plus the code that
  reads and writes it).
- **Groundwork** (PLAN.md Phase 0) — dropped the unused `province`/`city`/
  `department` reference tables, moved `product.image_path` to a file path
  column, renamed `lease_sale` to its real name `hold_sale`, and corrected
  the brand colour (migrations `1700000000011`–`1700000000014`).
- **Identity, users, numbering, the document shell** (PLAN.md Phase 2) —
  branch-prefixed document numbers (`MUL-1`, `MUL-SR-1`) for all nine
  document types, login history, permission-subset enforcement on role and
  login writes, and the reusable print shell with the masthead
  (migrations `1700000000015`–`1700000000016`).

The rest of PLAN.md's phases (3 onward — production, dispatch, selling,
warranty, …) have not started. Treat the table below as
"what the original port covered," not "what PLAN.md considers done."

| Area | State |
|---|---|
| Config, typed env validation | Done |
| Money layer (`decimal.js`, no floats) | Done — 11 tests |
| Kysely + `pg` with numeric-as-string parsers | Done — verified against the live DB |
| Error taxonomy + Postgres error translation | Done |
| JWT auth (argon2id, rotating refresh tokens) | Done — verified end to end in a browser |
| RBAC (`head → form → action`) + branch scoping | Done |
| Audit log | Done |
| Posting engine — rules | Done — 30 tests |
| Posting engine — DB writer | Done — **14 tests against real Postgres** |
| Migrations | **Applied** — through `1700000000016` on Neon |
| Permission tree | **Reconstructed from the legacy UI** — 150/150 ids verified |
| Catalog split — master `product` + `branch_product` | Done — PLAN.md Phase 1 |
| Branch module (form 2) | Done — full CRUD, verified in a browser |
| Sale module (form 12) | Done — posting verified end to end, ledger balances |
| Purchase module (form 10) | Done — freight capitalised, ledger balances |
| Sale Return (13) / Purchase Return (11) | Done — over-credit guard, ledgers balance |
| Hold Sale (form 51) | Done — no ledger impact until converted |
| Print (4 document types) | Done — one normalised shape, one template |
| Chart of accounts (23/24/25) | Done — atomic code allocation, no MAX()+1 race |
| Vouchers CRV/CPV/BRV/BPV/JV | Done — one module for all five, balance enforced |
| Account Ledger (26) + Trial Balance (28) | Done — Trial Balance ties out |
| Demand Order / inter-branch (10 forms) | Done — **one module**, transfer posting fixed |
| Reports — all 9 remaining | Done — balance sheet balances |
| Production (form 47) | Done — posting fixed |
| Lab Receiving (49) / Lab Invoices (50) | Done — **workflow designed**, see PLAN.md §12 |
| Roles, Role Assignment, Logins, Logs, Settings | Done |
| All 8 registration screens | Done — party accounts minted atomically |
| Legacy `.mdf` extract + ETL tooling | **Written, cannot run, not needed** — see "Starting fresh" below |

`npm test` → 153 passing. `npm run typecheck` → clean.

### Four accounting defects found and fixed

None of these were ported; all are corrected in the posting engine. Historical
`.mdf` data carries all four, so correcting entries will be needed at migration.

| # | Defect | Effect |
|---|---|---|
| §4.1 | Sale credits revenue at net, not gross | Voucher out by (discount − service) |
| §4.2 | One discount account for sales and purchases | Neither figure recoverable |
| §4.5 | Inter-branch transfers post one-sided vouchers | Freight had no counterparty at all |
| §4.6 | Production posts a lone debit | Assets created from nothing |

### Inter-branch transfers

The legacy postings did not balance at all — a despatch was a lone credit, a
receipt was two debits with no credit, and the freight debit had no counterparty
so every receipt inflated assets permanently. Account `1010501` Inter-Branch
Clearing is new in this rewrite: it carries in-transit value so both vouchers
balance and net to zero on receipt. A non-zero balance on it is a useful report —
stock currently in transit.

### Two invariants worth remembering

**`inv_id` does not identify a document — `(vtype, inv_id)` does.** Document ids
are per-table, so a sale and a purchase can share one. Filtering the ledger by
`inv_id` alone pulls in unrelated legs; it caused an intermittent test failure
before being scoped by `trans_id`. `loadDocumentJournals` takes both for exactly
this reason.

**Branch 0 is a filter, not a location.** A super admin signs in with
`branch_id = 0` meaning "all branches" for reading. `resolveBranchId` rejects it
as a document owner, so writes require an explicit branch — otherwise invoices
attach to the sentinel row and print "All Branches" as their address.

### Setting up a new installation

The system starts with **no business data**. Migrations provide the schema, the
permission tree and the chart of accounts; setup adds your company, first branch
and login. Everything else you enter through the application.

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and JWT_SECRET
npm run migrate:up
npx tsx scripts/setup.ts "Your Company" "Head Office" admin <password>
npm run dev
```

### Scripts

```bash
npx tsx scripts/setup.ts "Co" "Branch" admin PW  # first-run setup (idempotent)
npx tsx scripts/reset-data.ts --confirm          # wipe ALL business data
npx tsx scripts/db-check.ts                      # connectivity + type parsers
npx tsx scripts/verify-permissions.ts            # permission ids all resolve
npx tsx scripts/check-ledger.ts [inv]            # find unbalanced vouchers
npx tsx scripts/recent-audit.ts                  # recent audit-log entries
```

`scripts/extract-legacy.ps1` and `scripts/etl-legacy.ts` exist for importing the
legacy `.mdf`, but are **not needed** — this installation starts fresh.

### Database

Running on Neon (PostgreSQL 18.4, ap-southeast-1). Connection lives in `.env`,
which is gitignored.

Two properties confirmed on the live connection via `npx tsx scripts/db-check.ts`:

- `numeric` and `int8` arrive as **strings**, not numbers — `9007199254740993`
  round-trips intact, and would not have as a JS number.
- The session timezone is `Asia/Karachi`, so `::date` and `date_trunc` use the
  business day boundary. Neon's pooler does honour the startup option; the
  script warns if that ever stops being true.

### Test isolation

`tests/helpers/rollback.ts` runs every database test inside a transaction that
is **always rolled back**, so the suite leaves no rows behind and is safe to run
against a shared database. Sequences are non-transactional, so those tests
assert that ids are distinct and increasing, never that they equal a fixed value.

## Running

Node 22+ and a PostgreSQL 16+ connection string.

```bash
npm install
cp .env.example .env
```

Fill in `DATABASE_URL`, and generate a `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then:

```bash
npm run migrate:up
npm run dev
```

Create a super-admin login (idempotent — re-run to reset the password):

```bash
npx tsx scripts/setup.ts "Your Company" "Head Office" admin <password>
```

`GET /health` reports `degraded` when the database is unreachable, `ok` otherwise.

## Layout

```
migrations/     SQL migrations — the SOURCE OF TRUTH for the schema
db/accounts.md  Chart of accounts, posting rules, known defects
scripts/        db-check (connectivity + type parsers), setup (first login)
src/core/       config, db, money, errors, auth, rbac, audit, plugins
src/accounting/ posting engine — accounts, journal, rules, writer
src/modules/    one folder per feature (routes + service + schema)
tests/          vitest
```

## Branch 0 is a sentinel

The legacy convention `branch_id = 0` means "all branches" and is what a super
admin logs in with. This rewrite adds real foreign keys, which the legacy schema
lacked entirely, so migration `1700000000002` seeds a branch row with id 0 for
every `DEFAULT 0` column to reference. It is infrastructure, not a location —
filter it out of any branch picker with `WHERE id > 0`.

## Starting fresh — the legacy .mdf is not used

The decision is to start with clean books rather than migrate the legacy data.
That removes the phase 0 blocker entirely, and with it the need to post
correcting entries for the four accounting defects the legacy ledger carries —
none of that history comes across.

The chart of accounts is therefore **structural**, shipped as migration
`1700000000006`: the posting engine references those codes directly, so a
database without them cannot record a sale. Party accounts (customers,
suppliers, employees) are allocated from it automatically as you add them.

The rest of this section is kept for reference only.

## Reference: the legacy .mdf

The legacy project has **no EF migrations for business tables**. `Data/Migrations/`
holds only the ASP.NET Identity schema, and its model snapshot has zero
references to `Sale`, `Purchase`, `Product` or `Transactions`. All ~50 business
tables were created by hand in SSMS, so the authoritative schema exists nowhere
in source control — only in `7StarBatteryPOS/7STARBATTERYPOS.mdf` (165 MB).

`migrations/1700000000000_initial-schema.sql` is reconstructed from the 58 C#
model classes plus the raw SQL in the controllers. It captures columns and
types but **cannot** recover:

- indexes, defaults, check constraints and FKs defined in SSMS
- **seed rows** — the `form_head` / `form` / `forms_action` permission IDs are
  referenced as literals throughout the legacy UI (`HasAction(12, 4011)`), and
  the chart of accounts in `account_head` / `account_sub_head` / `account`.
  Without these exact rows, permissions and posting both break.
- columns present in SQL Server but absent from the C# model
- the production data itself

### Tooling is ready

```bash
powershell -ExecutionPolicy Bypass -File scripts\extract-legacy.ps1
npx tsx scripts/etl-legacy.ts --dry-run
```

`extract-legacy.ps1` finds or names the SQL Server engine to install, attaches
the `.mdf` under a separate name (the original files are never modified),
scripts out schema and data, exports every table to CSV, pulls out the six
critical seed sets, and **reports every unbalanced voucher in the legacy ledger**
so the accounting damage from the four posting defects is quantified up front.

### Unblocking it

On a machine with SQL Server, attach the `.mdf` and script out schema **and**
data — SSMS → *Tasks → Generate Scripts → Advanced → Types of data to script:
Schema and data*, or:

```bash
mssql-scripter -S . -d 7STARBATTERYPOS --schema-and-data -f ./legacy-dump.sql
```

Reconcile the migration against that dump, then run `npm run db:types` to
generate the remaining Kysely table types from the live database.

## Design decisions worth knowing

**Money is never a JS number.** `numeric` and `int8` are parsed as strings by
the `pg` type parsers in `src/core/db/index.ts`; arithmetic goes through
`src/core/money.ts` (decimal.js, ROUND_HALF_UP to match SQL Server). A single
implicit float conversion in an accounting system is silent, unauditable
corruption.

**Permissions are read per request, not baked into the token.** The legacy app
packed the whole assignment list into an auth cookie, so revoking a permission
required the user to log out. Here the token carries identity only; assignments
load from the database with a 60-second cache.

**Every posting runs in one transaction.** `withTransaction()` in
`src/core/db/index.ts`. The legacy `Sale.Save` issued several `SaveChanges()`
calls plus six raw inserts unwrapped, so a mid-flight failure could leave
inventory issued with no revenue recorded.

**Deletes are DELETE.** The legacy app performed deletes over GET
(`/Sale/Delete/5`), which any prefetch or crawler could trigger.
