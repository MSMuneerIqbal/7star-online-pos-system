# 7 Star Battery POS — implementation plan

**What this file is.** The order the work gets done in, what each phase changes,
and how you know it is finished.

| File | Role |
|---|---|
| [PRINCIPLES.md](PRINCIPLES.md) | The business and the rules. **The authority** |
| [SPECS.md](SPECS.md) | Every feature, module by module |
| [DESIGN.md](DESIGN.md) | How it looks, and the chart system |
| **PLAN.md** | **The order of work, and the definition of done** |

---

## 1. Ground rules

These hold for every phase. They are what keep a half-finished system usable.

1. **Every phase leaves the system working.** Migrations up, tests green,
   typecheck clean, app runs. No phase ends with a broken build "to be fixed in
   the next one". **And no phase removes a working feature that a later phase
   puts back** — if something needs reshaping, reshape it in the phase that owns
   it rather than deleting it early.
2. **Migrations are numbered, and a migration that has run is never edited.**
   The existing series ends at `1700000000009`; new work continues from
   `1700000000010`. Never hand-edit the database. Every migration carries a
   working `-- Down Migration` section — the ones already written all do.
2a. **A migration must reach BOTH Neon branches.** `npm run migrate:up` uses
   `DATABASE_URL`, which is `production`. The `test` branch needs the same
   migration or the suite runs against a stale schema and fails for reasons that
   have nothing to do with the code:

   ```bash
   DATABASE_URL="$TEST_DATABASE_URL" npm run migrate:up --prefix api
   ```
3. **No test is deleted without a stated reason.** The suite began at 142 and
   stands at 178. Some of the originals encoded the old business and failed
   deliberately; when one does, say in the phase why it changed. What is
   forbidden is deleting a test to go green. Every new posting rule arrives with
   a test that proves its voucher balances.
4. **Ledger integrity is checked after every phase that posts.**
   `npx tsx scripts/check-ledger.ts` must come back clean. It asks two
   questions, not one: does every voucher balance, **and does every posted
   document have a voucher?** The second exists because "no unbalanced vouchers"
   is vacuously true of an empty ledger — a guard that cannot tell *clean* from
   *empty* is not a guard.
4a. **Tests roll back. They never commit.** Every write service takes an
   optional trailing `tx` (`inTransaction` in `core/db`) so it can be driven
   from `tests/helpers/rollback.ts`. A service that calls `withTransaction`
   directly cannot be wrapped, and a test that cannot roll back will commit to
   the shared database instead.
   *This is not theoretical.* Services written without that seam had tests that
   committed and unwound themselves in a `finally`, and one of those cleanups ran
   `DELETE FROM transactions WHERE inv_id = <id>` with no `vtype`.
   **`(vtype, inv_id)` is the key** — `inv_id` alone is only unique within a
   voucher type — so once a test document's id reached a live sale's id, the
   delete took that sale's ledger legs with it. A real sale was left with no
   accounting behind it. The only sanctioned exception is a test that needs two
   transactions to see each other (concurrency); it must scope every cleanup by
   `vtype` and say why.
4b. **An assertion must hold for any database state.** A test that passes only
   because the shared database happens to contain something is a coin flip, not
   a test. `reports.test.ts` asserted `totalAssets > 0` and passed for months on
   ambient data; the moment the ledger was emptied it failed, having never once
   exercised the sign normalisation it claimed to check. It now seeds its own
   voucher inside a rollback and reads it back through an `executor` option.
   Either assert a *relationship* that holds on empty books
   (`assets = liabilities + equity`), or seed the figures you assert on.
5. **One database, no tenants.** Branch isolation is a `branch_id` column,
   enforced in the query layer today and in the database itself once Phase 13
   lands. Never a schema or database per branch.
6. **Nothing is deleted that has history.** Deactivate instead.
7. **Business rules live in `api/src/accounting/rules/`**, separate from
   persistence, so they can be tested without a database.
7a. **A module is `routes.ts` + `service.ts`.** Routes own Zod schemas and HTTP;
   the service owns the work. Three modules still break this and hold everything
   in `routes.ts` — `catalog` (818 lines, and it carries the master-catalog
   identity rules), `admin` (721) and `parties` (616). `hold-sale` is a genuine
   exception and says why in its header: it carries no money, so there is nothing
   to derive and no journal to balance. **Extracting those three is the first
   refactor to do now that features have stopped landing** — deliberately not
   done mid-flight, because an 800-line move while other work is in progress
   trades a real risk for a tidiness win. The same applies on the web side to
   `ProductionPage` (1078 lines) and `DemandOrderPage` (939).
8. **A phase that adds a document type ships that document's print template and
   its Excel export in the same phase.** A document nobody can hand to a customer
   is not finished (SPECS §18, DESIGN §8).
9. **Every new screen gets its OWN permission id before it gets a route.** The
   tree was reconstructed from the dead ASP.NET menu and is **not renumberable**.
   New work claims **head 12 upward**, keeping the scheme
   `form_code = head_code × 100 + sequence` and `action = form_code × 10 + n`,
   seeded in the same migration as the feature it belongs to.
   **Never reuse another screen's id**, and never let `ON CONFLICT DO NOTHING`
   hide the fact that you have: it silently leaves the *other* screen's row in
   place while your routes authorise against it. That happened twice — Stock
   Adjustment ended up sharing E-Store's grant, and Opening Balances shared
   Account Registration's, so anyone who could add a ledger account could also
   set the company's entire starting position. Both are fixed; the rule is here
   so it does not happen a third time. Check `SELECT form_code FROM form` before
   claiming one.
10. **The repository stays production-shaped throughout.** One folder per
    feature, no stray scripts at the root, no commented-out code left behind, no
    dead module kept "just in case", nothing generated committed. A one-off
    investigation script either earns a place in `api/scripts/` with a header
    saying what it is for, or it does not survive the phase that created it.

### Definition of done, applied to every phase

- [ ] Migrations run clean, up **and** down
- [ ] `npm test --prefix api` green, with new tests for the new behaviour
- [ ] `npm run typecheck` clean in both projects
- [ ] `check-ledger.ts` clean, if the phase posts anything
- [ ] `verify-permissions.ts` clean, if the phase added a screen
- [ ] Every new document type prints, and every new list exports
- [ ] **Every new API endpoint is reachable from a screen** — a nav entry, a
      route, and the feature driven by hand once in the browser. Green service
      tests cannot see a missing screen: Warranty, E-Store and Excel import were
      each marked complete on passing tests while no user could reach them
- [ ] Nothing left behind — no dead code, no stray files, no TODOs standing in
      for work the phase claimed to finish
- [ ] SPECS.md updated if reality diverged from the spec

---

## 2. Where we started, and where we are

> **All thirteen phases have landed.** §3 below is kept as the record of what
> each phase was for and how it was judged finished — read it as history, not as
> a queue. What remains is in §6, and none of it is feature work.

From the audit in PRINCIPLES §16. This was not a greenfield build and not a
port either — it was a **reshaping**.

**Solid, and staying:** the posting engine and its balanced-voucher guarantee,
money as exact decimals, auth and RBAC, the chart of accounts with atomic code
allocation, the `stock_movement` view, reports, printing, Excel export, 142
tests.

**Solid, and mis-named.** `lease_sale` is not a legacy leftover — it is **Hold
Sale**, already built the way SPECS §8.3 wants it: a parked basket, no ledger
posting, converted through the normal sale path. Both PRINCIPLES §16 and SPECS
§19 once listed it for removal; both have been corrected, and it is renamed
rather than dropped (Phase 0).

**Wrong, and being replaced:** the business model those parts sit under. It came
from a different company's ASP.NET system, not from 7 Star.

**The critical path ran through Phase 1.** Production, transfers, selling,
warranty, the E-Store and every stock report all sit on product identity, so
nothing real could be built until `product` split. It did, and they were.

**What the build got right, and what it taught.** The accounting core held
throughout — every voucher balances, posting rules stayed isolated, money never
became a float. The three things it got wrong are now ground rules rather than
prose, because each was found the expensive way: a feature can pass every test
and still be unreachable (rule: definition of done), a service without a
transaction seam forces its test to commit against the live database (rule 4a),
and a permission id claimed twice silently hands one screen another's grant
(rule 9).

---

## 3. The phases

### Phase 0 — Groundwork

*No user-visible change apart from the brand colour. Clears the ground.*

**Remove what does not belong**

- Drop `province`, `city`, `department` — legacy reference tables this business
  never uses. `department` is referenced by `employee.department_id`; drop that
  column in the same migration rather than relying on `CASCADE` to remove it
  silently. The plain `province` and `city` **text** columns on `supplier`,
  `employee` and `customer` are harmless and stay.
- Move `product.image_path` (`bytea`) out of the database to `UPLOAD_DIR` file
  storage, keeping a path column. Images in a row make every product query drag
  binary data around.

**Rename, do not drop**

- `lease_sale` → `hold_sale`, `lease_sale_detail` → `hold_sale_detail`, the
  module folder `lease-sale` → `hold-sale`, the route `/lease-sales` →
  `/hold-sales`. The nav entry already reads "Hold Sale" and stays where it is.
  Phase 7 reshapes it onto the new sale document; **nothing is removed here.**

**Correct the brand colour**

DESIGN §2 sets the brand hue at oklch **261.5**, read off the website's own
accent `#3d78e6`. `web/src/index.css` sits at 250. Correct it here rather than in
Phase 12 — it repaints every button, every active nav item and every link in the
app, and doing that once at the start is far less alarming than doing it after
twelve phases of screens have been signed off.

**Housekeeping**

- `api/README.md` references `scripts/bootstrap.ts`, which does not exist — it is
  `setup.ts`. Fix, and re-check the rest of that file's claims.
- `api/README.md` links to this file. It now exists.

**Done when:** the app runs with three fewer tables, Hold Sale still works under
its right name, and the interface is the website's blue.

---

### Phase 1 — The catalog split ⚠️ critical path

*The largest single change. Everything downstream depends on it.*

**Schema**

```
branch          + code (unique, immutable once used)
                + type ('BRANCH' | 'WAREHOUSE', exactly one warehouse)
                + is_active, address, phone, opening_hours, closing_day

product         − branch_id                    ← the whole point
                + type, placement, barcode
                + cell_type_id, cell_count     ← the suggested recipe
                unique (model, brand, type, placement) case-insensitive

branch_product  NEW — one row per product per branch
                branch_id, product_id
                selling_price, minimum_price, location, low_stock_threshold
                wholesale_cost      ← weighted average, maintained by Phase 5
                unique (branch_id, product_id)
```

`branch.address` and `branch.phone` are needed here because every printed
document carries the issuing branch's own address beneath the masthead
(DESIGN §8), and the print shell lands in Phase 2.

**Grade is deliberately absent from `product`.** *New* and *Repaired* describe a
unit, not a model. It travels on the stock movement (Phase 4) and the dispatch
line (Phase 5) — SPECS §3.4. Putting it here would force a repaired unit either
to mutate the master row or to spawn a duplicate the identity rule collapses.

**Fan-out, both directions** — a trigger or service that creates
`branch_product` rows when a product is created *and* when a branch is created or
reactivated. One direction only means a branch opened later can price nothing.

**API** — product service reads master plus the caller's `branch_product`; new
routes for a branch to maintain its own prices and locations; super-admin-only
guard on master writes.

**Web** — the product screen splits in two: **Master catalog** (super admin,
model/brand/type/placement) and **My prices** (branch, price/location/threshold).

**Seed** the seven branches with their codes: `WHS` `HR` `HC` `MUL` `FSD` `GUJ`
`RWP`, each with its address and phone from PRINCIPLES §2.

**What happens to the rows already there.** The database currently holds a
smoke-test set — one product, one sale, three branches — so in practice nothing
of value moves. The migration must still *state* the rule rather than assume an
empty table: collapse existing `product` rows by the identity key
(`model + brand + type + placement`, case-insensitively) into one master row
each, and turn every original row into the `branch_product` row for its old
`branch_id`, carrying its price across. Written that way it is correct whether it
meets one row or ten thousand.

**Risk.** Every module that reads `product.branch_id` breaks at once — sale,
purchase, transfer, all stock reports. Expect this phase to touch more files than
any other. Do it in one pass rather than leaving a compatibility shim; a shim
here will outlive the project.

**Done when:** one model exists once company-wide, two branches can hold
different selling prices for it, and every existing test still passes.

---

### Phase 2 — Identity, users, numbering, the document shell

**Roles** — add **Warehouse admin**, **E-Store manager**, **Branch salesman** to
the existing `head → form → action` tree. E-Store manager is branch-blind for
reads but writes only on E-Store orders.

**User cascade** — super admin creates warehouse and branch admins; a branch
admin creates salesmen **inside its own branch** and can grant only a subset of
its own permissions. Enforce the subset rule server-side; a UI that merely hides
the checkbox is not enough.

**Account control** — reset password, deactivate, reassign role and branch.
Super admin over everyone; branch admin over its own creations only.

**Login history** (SPECS §2) — who signed in, when, from where. The Activity log
already exists on top of `writeAudit`; this is its sibling screen.

**Document numbering**

```
document_counter (branch_id, doc_type, next_number)   -- row-locked on issue
```

Format `{BRANCH}-{DOC}-{n}`, and `{BRANCH}-{n}` for a walk-in sale:

```
MUL-1  walk-in sale     MUL-C-1   credit sale      MUL-SR-1  sale return
MUL-LB-1 lab invoice    MUL-DO-1  demand order     MUL-RC-1  receipt
MUL-WC-1 warranty claim MUL-ES-1  E-Store shipment
WHS-DP-1 dispatch       WHS-PI-1  purchase         WHS-PR-1  production run
```

Issue numbers inside the document's own transaction, with `SELECT … FOR UPDATE`.
Two salesmen billing simultaneously must never collide.

**Every phase from 4 onward issues numbers**, so this phase is a hard
prerequisite for Production and for Dispatch — not a parallel side-track.

**The print shell** — the one-time half of SPECS §18 and DESIGN §8, built here
because a printed document needs its number and its branch address, and both now
exist:

- `web/public/logo.png` from the site's `logo-mark.png`, and the **Jost** font
  loaded only where the masthead renders.
- One `DocumentHeader` component: the mark, the four masthead lines exactly as
  DESIGN §2 words them, then the issuing branch's own address and phone.
- The A5 page shell — number and date top right, bordered table, totals block
  bottom right, `.no-print` on everything interactive.

Each later phase then supplies only its own document body, under ground rule 8.

**Seeded access** — until go-live every seeded branch and user holds full
permissions so the system can be exercised end to end.

**Done when:** a branch admin can create a salesman who can sell and cannot see
cost; two concurrent sales get consecutive numbers with no gap and no duplicate;
and a sale prints on A5 under the masthead with Multan's own address on it.

---

### Phase 3 — Raw items: cells and complete sets

```
raw_product  + part_type ('CELL' | 'COMPLETE_SET' | 'OTHER')
             + model, brand, placement
             + cell_capacity_mah, cell_voltage, cell_size, cell_brand   -- cells only
```

A **Complete Set** is a kit of *1 casing + 1 PCB + 1 patra*, and explicitly **not
cells**. Cells are issued separately.

**Excel import lands here, and it is built as a reusable thing** — the
preview-before-commit behaviour from the old apps: colour-coded NEW vs UPDATE,
row-level validation that skips bad rows and reports them, quantities **added**
to existing stock rather than replacing. Raw items are its first consumer;
Phase 11 points products, customers and opening stock at the same machinery
rather than writing it three more times.

**Done when:** a cell can be registered with its full specification and found by
it, and a hundred-row spreadsheet imports with two bad rows reported and skipped.

---

### Phase 4 — Production

*The module with the least existing code worth keeping.*

```
worker                 name, phone, is_active
production_issue       + _detail   raw items -> a named worker (the cart)
production_output      per issue: READY / USED / DAMAGED
damaged_stock          parts AND finished batteries, worker, reason, value
used_stock             parts consumed
rework                 a finished battery back to a worker
```

The existing `production` table — one header with `labor_cost`, `electric_cost`,
`other_cost` — does not model issue-to-worker, WIP, damage or rework. Replace it.

**Cost:**

```
production cost = complete set cost + cells cost + other parts cost
```

No labour term — there is no pay system, so no rate exists to read.

**Company cost for goods that are bought, not made.** SPECS §4 says chargers,
adapters and the other non-battery lines are purchased by the warehouse and
dispatched like batteries, and that for those items **the purchase cost stands in
for production cost**. Phase 5 needs a company-cost figure on every dispatch line
and Phase 9 needs one to value a warranty replacement, so the figure has to exist
for a bought-in charger too. Store it the same way and from the same field, fed
by the purchase line instead of the production run — one column, two sources,
never null. Recorded as a decision in PRINCIPLES §17.16.

**Grade enters the system here.** Extend `stock_movement` with issue, output,
damage and rework, and add `grade ('NEW' | 'REPAIRED')` to the movement row.
Everything the warehouse produces is New.

**A damaged finished battery can be repaired back into sellable stock**
(PRINCIPLES §4, SPECS §5.5). When it is, it is graded **Repaired**, keeps a
reference to the damage record it came from, and goes **straight out to a branch**
rather than back into warehouse ready stock. That dispatch is a Phase 5 document
raised from a Phase 4 screen — build the record here, wire the dispatch there.

**Worker piece account is derived, never stored.** Sum the READY output. Damage
never reduces it. Storing a running total invites it to drift from its source.

**Damaged stock posts nothing to the ledger.** It records quantity, value and who
is answerable. Resist the instinct to journal it.

**Done when:** a cart of sets and cells goes to a worker, comes back as batteries
plus damage, warehouse ready stock rises by the right number, the worker's piece
count is right, a purchased charger carries a company cost, and the ledger
balances.

---

### Phase 5 — Demand, dispatch, receipt

⚠️ **Gated by PRINCIPLES §17.6 — *When does a branch's debt actually start?***
The plan assumes a branch owes for stock it *holds*, from the moment it confirms
receipt. If it really only owes for what it has *sold*, that is consignment:
unsold branch stock stays warehouse inventory, and **this phase's receipt posting
changes shape, not only Phase 6's**. Settle it before starting this phase.

Reshape the existing `demand_order → do_request → do_received` chain, which is
the closest thing in the old schema to what this business does.

```
demand_order    branch asks. status Raised → Approved → Dispatched → Received
dispatch        + wholesale_price     ← the branch's cost, branch sees it
                + production_cost     ← warehouse only, branch never sees it
                + grade               ← NEW or REPAIRED, travels with the unit
receipt         + received_qty, short_qty, damaged_qty   per line
```

**On confirmed receipt** — not dispatch — `branch_product.wholesale_cost` is
recalculated as a **weighted average**, and the branch's dues rise (Phase 6).
Stock in transit is nobody's debt.

**Rules to enforce:** the warehouse may approve less than asked, per line; a
branch never sees `production_cost`; **branch-to-branch transfer is refused**; a
repaired unit from Phase 4 dispatches straight out, graded Repaired.

**Done when:** a demand raised at Multan, part-approved and dispatched at
wholesale, then confirmed short by one unit, leaves Multan's stock, dues and
weighted-average cost all correct — and the dispatch note prints.

---

### Phase 6 — Inter-branch account and remittance

One account per branch in chart group `05`, plus a remittance document.

| Event | Effect on the branch's balance |
|---|---|
| Confirmed receipt | **up** by wholesale value received |
| Remittance to the warehouse | **down** |
| Accepted E-Store shipment (Phase 10) | **down** by wholesale value shipped |

Both sides of every entry cancel on consolidation — internal movement must never
inflate the combined balance sheet.

The branch dues report answers all five questions in SPECS §7, including **in
transit**, which belongs to nobody yet.

The dues question gating this phase is settled before Phase 5, not before this
one — see the ⚠️ above.

**Done when:** dispatch, receipt and remittance move the balance correctly, and a
consolidated trial balance still ties out with inter-branch netting to zero.

---

### Phase 7 — Selling

**One sale document** for walk-in and credit, with the number carrying the
distinction (`MUL-1` vs `MUL-C-1`).

- Price defaults to the branch's selling price and **cannot go below its minimum
  price**; the error names the floor.
- Quantity validates against branch stock as you type.
- COGS is the branch's weighted-average `wholesale_cost` — read, never typed.
- **Custom lines are service charges only** — fitting, delivery, labour. Revenue,
  no stock movement, never a physical item.
- **Hold sale is a reshape, not a build.** The module renamed in Phase 0 already
  parks a basket with no stock and no ledger impact; point it at the new sale
  document and at `branch_product` pricing.
- Sale return: restocks, refunds a walk-in or reduces a credit balance, and
  writes a **reversal** — never edits the original.

**Credit customers** get shop name, settlement cycle (weekly / monthly) and an
optional credit limit; the cycle drives the aging buckets. Ledger, advances,
statements, simple slip, per-invoice status.

**Done when:** a walk-in cash sale and a credit sale both post balanced vouchers,
land in one day book, print on A5, and a credit customer's statement reconciles
to their account balance.

---

### Phase 8 — Lab and expenses

**Lab.** Repair job types are a central list; each branch sets **its own price**.
A job records the customer, the fault, the parts consumed, a **required
description**, and the charge.

> **A Lab repair creates no stock.** The battery is the customer's and goes back
> to him. Parts out, money in, and **no finished-goods movement**. A stock-in on
> completion is the bug to watch for here.

**Expenses.** One branch, one date, one category, a description. Seed the central
category list — Rent, Electricity, Food, Transport, Salaries, Repairs,
Miscellaneous (SPECS §3.7) — so branches compare on the same rows. The screen is
built around the month: one month by default, per-category totals, previous month
beside it, a full year in one table.

**Done when:** a repair consumes branch raw stock and produces branch revenue
with zero finished-goods movement, and a branch's monthly expense total flows
into its profit figure.

---

### Phase 9 — Warranty

```
warranty_hold     faulty units at a branch — NOT sellable, NOT in stock value
warranty_claim    + _detail   branch -> warehouse
                  assessment: REPAIRABLE | NOT_REPAIRABLE
                  outcome:    RETURNED_REPAIRED | REPLACED_NEW
```

Statuses: Raised → Shipped → Received → Assessed → Returned or Replaced → Closed.

| Assessment | Action | Returns | Cost posted |
|---|---|---|---|
| Repairable | Repaired at the warehouse with raw parts | The **same unit**, grade Repaired | The parts consumed |
| Not repairable | A **new** battery from ready stock | A different unit, grade New | A whole battery at production cost |

The grade column added in Phases 4 and 5 is what carries the outcome back to the
branch; "a whole battery at production cost" reads the company-cost figure that
Phase 4 guarantees is never null, including for bought-in goods.

**Either outcome goes back to the branch that claimed it** — never into general
warehouse stock. **The branch is never charged**; its dues do not move. The two
outcomes post **separately**, because a rising replacement rate on a model is a
manufacturing signal a blended figure would hide.

⚠️ **Gated by PRINCIPLES §17.4 — *Does the warranty customer wait?*** — whether the
customer is served instantly from branch stock or waits for the warehouse's
decision, and what happens when the branch has none of that model on the shelf.

**Done when:** a claim raised at Multan, assessed not-repairable and replaced,
restores Multan's stock, leaves its dues untouched, and posts a warranty expense
at the warehouse that reconciles against inventory.

---

### Phase 10 — E-Store

```
estore_shipment  + _detail
                 order_reference (unique — a second shipment is refused)
                 assigned_branch, status Raised → Accepted | Rejected
                 recorded_by/at, accepted_by/at, rejection_reason
                 lines valued at WHOLESALE
```

**Not a branch sale.** No branch revenue, no branch profit, nothing in the branch
day book — for the branch it is one less battery on the shelf. Stock leaves when
the shipment is **recorded**; the branch's dues fall when the warehouse
**accepts**. Rejection returns the stock.

The E-Store manager's screen assigns each website order to a nearby branch and
can read stock across all branches to choose.

**Done when:** a shipment recorded at Multan and accepted at the warehouse
reduces Multan's stock and dues by the same wholesale value, with nothing landing
in Multan's sales.

---

### Phase 11 — Reports, and the rest of Excel

Every report in SPECS §16, over data that now exists. Each one filters, and
**every export carries only what the filter shows** — with the summary block at
the top, the logo and coloured headers the old apps already produce.

Two that are new and easy to get wrong: **dead stock** is *no movement in ninety
days*, not bottom-N by sales; the **income statement** shows **gross margin** as
its own line, from the 501/502 sub-head split.

**Excel import** reaches the rest of SPECS §18 here — products, customers and
opening stock — reusing the preview-before-commit machinery built in Phase 3.

---

### Phase 12 — Dashboards

Last of the build, because it reads everything else.

- Install **Recharts** and wrap it once in a `Chart` component that applies the
  DESIGN.md tokens. No feature imports Recharts directly — its defaults break
  half the mark specs.
- Add the remaining design tokens from DESIGN.md §11 — series, status,
  sequential and the dashboard type scale. The brand hue was corrected in
  Phase 0.
- **Super admin:** charts and figures, one hero figure, the nine panels, and a
  branch selector that opens any branch's dashboard in that branch's own context.
- **Branch:** figures only.
- Every figure clicks through. Every panel obeys one filter row. Nothing on a
  branch dashboard reveals another branch.

---

### Phase 13 — Opening balances, and go-live

The books cannot start from zero when the business does not. This is build work,
not setup — **there is no such screen today** (PRINCIPLES §17.5).

Half of it already exists, which makes the phase smaller than it looks:
`POST /ledger/opening` and `saveOpeningBalance` can already set an opening
balance on a single account. What is missing is the screens on top, and the stock
side — opening quantities are not an account entry, they are inventory with a
value behind them.

One screen per figure, each posting an opening journal against the right account:

| Opening figure | Per | Posts to |
|---|---|---|
| Cash in hand, money in the bank | Branch | Group `01`, cash and bank |
| Stock on the shelves, at wholesale | Branch × product | Group `04`, branch inventory |
| Raw and ready stock | Warehouse | Group `04` |
| What credit customers already owe | Customer | Group `02`, receivables |
| What is owed to suppliers | Supplier | Payables |
| Branch dues already outstanding | Branch | Group `05`, inter-branch |

Opening stock arrives by Excel import (Phase 11), because nobody types a
warehouse in by hand. The balancing side of the whole exercise is Equity —
opening capital — and the trial balance is the proof it was entered right.

**Done when:** every opening figure is entered, the trial balance balances
without a suspense account, and each branch's stock report agrees with what is
physically on its shelves.

---

### Deferred — row-level security in the database

*Not scheduled. It needs a decision from you first, and it is far larger than it
looks.*

PRINCIPLES §14.8 says branch isolation is "enforced in the data layer". Today it
is enforced one layer above, in `api/src/core/rbac.ts` — which is what CLAUDE.md
calls the query layer, and which works, but where a single forgotten `.where()`
would leak another branch. Postgres row-level security would make the stronger
sentence literally true. Two things stand in the way, and both were missing from
the original plan:

1. **RLS does not apply to the table's owner.** `ENABLE ROW LEVEL SECURITY`
   leaves the owning role unrestricted, and on Neon the application role usually
   owns its own tables — so every policy would silently pass everything, and a
   test asserting "another branch returns zero rows" would go green while proving
   nothing. It needs `FORCE ROW LEVEL SECURITY`, or a separate non-owning role
   for the application to connect as.
2. **There is no per-request database connection to set the branch on.**
   `api/src/core/db/index.ts` exports one shared `pg.Pool`, and read paths use the
   global `db`, so two queries in the same request can land on different pooled
   connections. Setting `app.branch_id` "on the connection" therefore means
   either wrapping *every request* in a transaction and using `SET LOCAL`, or
   checking out a client per request and threading it through every service
   signature — a change that touches essentially all of `api/src/modules/`.

**My recommendation: leave it deferred.** The query-layer enforcement satisfies
what the code is asked to do today, the seven branches all belong to one owner
rather than to competing tenants, and the same effort spent on Phases 5 to 10
delivers business the shop can feel. If you want the database-level guarantee,
say so and it becomes a phase of its own between 12 and 13 — not a bullet inside
Phase 0.

Either way, worth doing cheaply now: a test per branch-scoped module that proves
the existing `rbac.ts` filter actually holds.

---

## 4. Sequencing

```
Phase 0   Groundwork
   │
Phase 1   Catalog split                         ⚠️ critical path
   │
Phase 2   Users, roles, numbering, print shell
   │
Phase 3   Raw items
   │
Phase 4   Production
   │
Phase 5   Demand, dispatch, receipt             ⚠️ the dues question
   │
Phase 6   Inter-branch account
   │
Phase 7   Selling
   │
   ├── Phase 8   Lab & expenses
   ├── Phase 9   Warranty                       ⚠️ the warranty question
   └── Phase 10  E-Store
          │
       Phase 11  Reports & the rest of Excel
          │
       Phase 12  Dashboards
          │
       Phase 13  Opening balances  ──▶  go-live
```

**What can run in parallel:** Phases 8, 9 and 10 are independent of each other
once Phase 7 is in. Report screens can be started against any data that already
exists.

**What cannot:**

- Anything before Phase 1.
- **Phases 4 and 5 before Phase 2** — production runs and dispatches both issue
  branch-prefixed document numbers, so numbering is a prerequisite, not a
  sibling. This was drawn wrong in the earlier version of this plan.
- Phase 5 before the dues question is settled.
- Phase 12 before the data it charts exists.
- Phase 13 before the accounts those balances post to exist — which means after
  Phase 6 at the earliest, and realistically last.

---

## 5. Risks

| Risk | Why it bites | What to do |
|---|---|---|
| **Phase 1 touches everything** | Every module reads `product.branch_id` | One pass, no compatibility shim. A shim here outlives the project |
| **The dues question is still open** | It changes Phase 5 *and* Phase 6, not just Phase 6 | Settle before Phase 5 starts, not during |
| **Weighted-average cost drifts** | Recomputed on every receipt; a wrong recompute silently corrupts COGS forever | A test per receipt scenario, and a periodic recompute-and-compare check |
| **Numbering collisions** | Two salesmen billing at once | Row-lock the counter inside the document transaction. Test concurrently |
| **Company cost missing on bought-in goods** | Dispatch and warranty both read a production cost a purchased charger never had | Phase 4 fills the column from the purchase line. Test a charger through dispatch and through a warranty replacement |
| **Lab writing stock in** | It reads like production and is not | Explicit test asserting zero finished-goods movement on a repair |
| **Damaged stock reaching the ledger** | It looks like it should post | Explicit test asserting no voucher |
| **Print templates drifting apart** | Thirteen layouts already exist; new document types tempt new one-off templates | One `DocumentHeader` and one A5 shell in Phase 2, and ground rule 8 |
| **RLS that silently does nothing** | Policies do not restrict the table owner, and there is no per-request connection | Deferred, and written up above. If it is scheduled, `FORCE ROW LEVEL SECURITY` and a non-owning role, or the test proves nothing |
| **The old 142 tests encode the old business** | Some assert behaviour we are deliberately changing | Read each failure. A failing test is sometimes the correct outcome — update it deliberately, never delete it to go green |
| **Neon is shared and live** | Test data committed to it pollutes real reporting — and it did: a test cleanup deleted a live sale's ledger legs | Ground rule 4a. Every write service takes an optional `tx`; tests roll back. Set `TEST_DATABASE_URL` to a throwaway database as well — belt and braces. Never run `reset-data.ts` against it casually |
| **A green test is not a delivered feature** | Service tests pass without a screen; three features shipped "complete" and unreachable | The definition of done requires a nav entry, a route, and one hand-driven pass in the browser |
| **Permission ids get reused** | `ON CONFLICT DO NOTHING` hides the collision and the other screen's row wins | Ground rule 9. Check `SELECT form_code FROM form` before claiming one |

---

## 6. What blocks go-live

All thirteen phases have landed. What is left is not development.

**Yours to answer:**

1. **FCC** — still open? Real name? It is in the old apps, not on the website.
2. **Gujranwala** — on the website, absent from the old apps. Confirm it is live.
3. **Opening balances** — cash, bank, stock on hand, what credit customers owe,
   what you owe suppliers. The screen is built; the **figures** are yours, and
   nothing should trade until they are in.
4. **Dashboard priorities** — which three panels go at the top.

**Settled by what was built** — recorded here because the plan once listed them
as open, and the code has since answered them:

5. **The dues question** was built the first way: a branch owes for stock it
   *holds*, from confirmed receipt. Say so if that is wrong; it is a real change
   to dispatch, receipt and the dues report, not a setting.
6. **The warranty question** was built as *the customer never waits* — the branch
   replaces from its own shelf on the day and claims after.

**Two housekeeping items before real data arrives:**

7. ~~Set `TEST_DATABASE_URL`~~ — **done.** The suite was running against the Neon
   branch literally named `production`. There is now a sibling branch, `test`,
   forked from it with data and schema (the tests read seeded reference data —
   the chart of accounts, the WAREHOUSE branch, expense categories — so a
   schema-only branch would fail), auto-delete **Never**, and `.env` points
   `TEST_DATABASE_URL` at it. `.env.example` documents the setup for the next
   person. Branches are copy-on-write: `production` was not touched, and the
   project sits at 2 of 10 branches on the free plan.

   Related, and fixed in the same pass: the pool now sets `keepAlive`. Neon is
   serverless and reaps connections it thinks are idle; without keepalives the
   client only finds out on its next query, which is what failed three files on
   `Connection terminated unexpectedly` partway through a five-minute run. Those
   were never test failures, but they are indistinguishable from one at a glance.
8. **Sale 17 has no ledger legs** — a smoke-test document orphaned when an older
   test's cleanup deleted its voucher. `check-ledger.ts` reports it. Delete the
   document or re-post it; either is fine, but the guard stays red until one of
   them happens.

---

*Derived from [PRINCIPLES.md](PRINCIPLES.md), [SPECS.md](SPECS.md) and
[DESIGN.md](DESIGN.md). When a decision changes, change PRINCIPLES first.*
