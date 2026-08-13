# 7 Star Battery POS

Multi-branch POS and manufacturing system for **7 Star Laptop Battery Station** —
one warehouse that manufactures batteries, and branches that sell them.

## Read these first

| File | What it is |
|---|---|
| [PRINCIPLES.md](PRINCIPLES.md) | The business, the decisions, the rules that must never break. **The authority** |
| [SPECS.md](SPECS.md) | Every feature, module by module — screens, fields, rules, build order |
| [DESIGN.md](DESIGN.md) | Visual language, screen patterns, and the validated chart system |
| [PLAN.md](PLAN.md) | The order of work, phase by phase, and the definition of done |

When they disagree, PRINCIPLES wins. When a decision changes, change PRINCIPLES
first, then SPECS, then DESIGN, then the code.

**Work follows PLAN.md's phase order.** Phase 1 — splitting `product` into a
master row plus `branch_product` — is the critical path; production, transfers,
selling, warranty and every stock report sit on it.

## The one thing to know before touching anything

`api/` and `web/` are **not** a rewrite of the owner's three Python apps. They are
a reconstruction of a *different* legacy system — an ASP.NET / SQL Server app
whose schema lived only in `7STARBATTERYPOS.mdf`. Tables came from 58 C# model
classes; menu ids were copied from the old `_Layout.cshtml`.

So the **engine is good and the business model on top of it is wrong**. See
PRINCIPLES §16 for exactly which parts to keep and which to reshape. Do not
assume an existing table means the feature is built correctly — check §16 first.

Highest-impact mismatch: `product.branch_id` gives every branch its own
disconnected product rows. It must split into a master `product` plus
`branch_product` (price, location, threshold). Everything else depends on it.

## Layout

```
api/    Fastify + TypeScript + Kysely + PostgreSQL (Neon)
web/    React 19 + Vite + TanStack Query/Router/Table + Tailwind 4
```

Two **separate npm projects**. No monorepo tooling, no cross-imports, no shared
`node_modules`. `web/` reaches `api/` over HTTP and nothing else.

```
api/src/accounting/   posting rules + the journal writer — the heart
api/src/core/         db, auth, rbac, money, errors, audit
api/src/modules/      one folder per feature: routes.ts + service.ts
api/migrations/       SQL, numbered. THE source of truth for schema
api/scripts/          operational one-offs
web/src/features/     one folder per screen
web/src/lib/nav.ts    navigation + the permission map
```

## Commands

Both projects need `npm install` first. `api/` needs `.env` (copy
`.env.example`).

```bash
npm run dev --prefix api        # API on :3000
npm run dev --prefix web        # SPA on :5173
npm test --prefix api           # vitest — 142 tests
npm run typecheck --prefix api
npm run typecheck --prefix web
npm run migrate:up --prefix api
```

Prefer the Browser pane over `npm run dev` in a shell — `.claude/launch.json`
defines both `api` and `web`.

Useful scripts, all `npx tsx scripts/<name>.ts` from `api/`:

| Script | Does |
|---|---|
| `setup.ts "Company" "Branch" admin <pw>` | First-run setup. Idempotent |
| `db-check.ts` | Connectivity and environment |
| `check-ledger.ts [invId]` | Ledger integrity — every voucher balances |
| `verify-permissions.ts` | Permission tree against the UI's needs |
| `recent-audit.ts [limit]` | Recent audit-log entries |
| `reset-data.ts --confirm` | Wipe business data, keep schema |

`api/README.md` mentions `scripts/bootstrap.ts`; that file does not exist — it is
`setup.ts`.

## Invariants — the build refuses when these break

1. **Every voucher balances.** Debits equal credits or nothing is written.
2. **No floats for money.** `decimal.js` end to end, `numeric(18,2)` in the DB.
3. **Nothing half-recorded.** Document + lines + ledger entries in one
   transaction.
4. **Editing does not erase.** Posted documents change by reversal plus a new
   entry — never in place, never by delete.
5. **Cost is never typed at the till.** Branch cost comes from the receipt line;
   company cost from the production run.
6. **Stock only moves through a document.**
7. **A branch cannot see another branch** — enforced in the query layer, not by
   hiding menu items.

## Conventions

- **Migrations are the schema.** Never hand-edit the database; add a numbered
  migration. Regenerate types with `npm run db:types`.
- **Money** `numeric(18,2)`, **quantities** `numeric(18,3)`, read as strings and
  handled with `decimal.js`.
- `snake_case` in SQL, `camelCase` in TypeScript.
- A module is `routes.ts` (Zod schemas, HTTP) + `service.ts` (the work). Posting
  rules live in `api/src/accounting/rules/`, separate from persistence.
- Permissions are `head → form → action`. `web/src/lib/nav.ts` carries the ids;
  do not renumber them without migrating `role_assign`.
- Every list takes filters, and every export carries **only what the filter
  shows**.
- Document numbers are branch-prefixed: `MUL-1`, `MUL-SR-1`, `WHS-DP-1`.
- **Chart colours are validated, not chosen.** DESIGN.md §6.2 carries the passing
  palette; re-run the dataviz skill's `validate_palette.js` before changing any of
  it. Red and green are status only — never a series colour. Branches are never a
  categorical colour dimension; comparing them is a magnitude job.

## Database

Live PostgreSQL on **Neon** — shared, not a throwaway. Tests must roll back and
never commit. Never run destructive SQL against it without being asked.

**One database, no tenants.** Branches are a `branch_id` column plus row-level
security — never a schema or database per branch. Warehouse-to-branch dispatch,
warranty claims and the inter-branch account are all cross-branch transactions
that must stay atomic, and consolidated reporting is the point of the system.
Never propose splitting branches apart.

## Vocabulary

Use the owner's words, and avoid the ones they rejected.

| Say | Not |
|---|---|
| Credit Customer, Credit Sale, Customer Statement | Khata |
| Complete Set — a kit of *1 casing + 1 PCB + 1 patra*, **no cells** | A complete battery |
| Lab — repairing a customer's own battery for a charge | Anything else |
| Wholesale price — warehouse to branch | Cost, transfer price |
| Production cost — warehouse-only, never shown to a branch | |
| E-Store — a sales channel, never a stock location | |

## Working style

The owner is the business owner, not a developer. Explain in business terms, not
schema terms. When something is ambiguous, say which reading you took and why —
several decisions in PRINCIPLES were made that way and are marked as such in §17.
