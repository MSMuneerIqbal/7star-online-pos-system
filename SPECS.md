# 7 Star Battery POS — functional specification

**What this file is.** Every feature the system must have, module by module, with
the screens, fields, rules and documents that make each one real.

**How it relates to [PRINCIPLES.md](PRINCIPLES.md).** Principles is the *why* —
the business, the decisions, the rules that must never break. This is the *what*.
Where the two ever disagree, Principles wins and this file is wrong.

**Status tags.** Every module carries one, from the audit in Principles §16:

| Tag | Meaning |
|---|---|
| `EXISTS` | Built and working. Keep it |
| `RESHAPE` | Built, but for a different business. Substantial change |
| `NEW` | Nothing exists. Build from scratch |

---

## 1. System shape

```
  api/                          web/
  ────                          ────
  Fastify + TypeScript          React 19 + Vite
  Kysely over PostgreSQL        TanStack Query + Router
  Zod schemas at the edge       Tailwind 4
  argon2id + rotating JWT       react-hook-form
  decimal.js — no floats        TanStack Table

         └──────── REST ────────┘

  PostgreSQL (Neon) — one database for the whole company
```

Two separate npm projects. No monorepo tooling, no cross-imports, no shared
`node_modules`. `web/` talks to `api/` over HTTP and nothing else.

**Online only.** Every branch has reliable internet (Principles §15). There is no
offline mode, no local database and no sync engine.

---

## 2. Roles and permissions `EXISTS` — needs new roles

### The permission model

Three levels, already built and already enforced in the data layer:

```
  head   →   form   →   action
  (menu      (screen)   (button: view, add, edit, delete, print, approve)
   group)
```

A role is a set of granted `(form, action)` pairs. A user has one role and one
branch. Every query is scoped to that branch unless the role is branch-blind.

### The roles

| Role | Branch scope | What it can reach |
|---|---|---|
| **Super admin** | All | Everything. Every screen, every branch, both cost figures, all profit. Creates branches and users |
| **Warehouse admin** | Warehouse | Whatever the super admin ticks, feature by feature. Accepts E-Store shipments |
| **Warehouse stock** | Warehouse | Raw and ready stock, demand orders, dispatch, warranty claims |
| **Production** | Warehouse | Workers, issues, output, damage, rework. No branch prices |
| **E-Store manager** | All branches, branch-blind | Website orders — **writes only there**, to assign each order to a branch. Reads stock across branches to pick a near one. Nothing else |
| **Branch admin** | Own branch | Own stock, sales, expenses, cash and bank, credit customers. Raises E-Store shipments. Creates salesmen |
| **Branch salesman** | Own branch | Sells; sees stock at selling price. No cost, no profit. Plus whatever the branch admin allows |

### Rules

1. **Production cost and profit are hidden by default.** A branch admin sees
   sales, stock at its own selling prices, and its finances — never the factory
   cost, never profit. It *does* see the wholesale price it was charged (§6.4).
2. **The super admin can grant profit visibility** to a named branch admin, for
   that branch only. The grant also reveals **that branch's remaining stock
   valued at cost**. Never another branch's.
3. **A branch cannot see another branch.** Enforced in the query layer, not by
   hiding menu items.
4. **Users cascade.** Super admin creates warehouse and branch admins. A branch
   admin creates salesmen inside its own branch and grants them a subset of its
   own permissions — never more.
5. **The super admin controls every account**: reset any password, deactivate,
   reassign, revoke a feature. A branch admin has the same powers over the users
   it created, inside its branch only.

### Screens

| Screen | Who | Does |
|---|---|---|
| Roles | Super admin | Create a role, tick its `(form, action)` grants |
| Users | Super admin / branch admin | Create, deactivate, reset password, assign role and branch |
| Login history | Super admin | Who signed in, when, from where |
| Activity log | Super admin | Every create, edit and delete, with before and after |

**One screen, one grant.** Every screen owns its own `(form, action)` ids and
shares them with nothing. Two screens behind one grant means ticking a box opens
a door nobody meant to open — and it is not hypothetical: Stock Adjustment once
shared E-Store's, and Opening Balances shared Account Registration's, so anyone
allowed to add a ledger account could also set the company's whole starting
position. Both now stand alone.

---

## 3. Registration and the master catalog `RESHAPE`

### 3.1 Branch

Created by the super admin only.

| Field | Notes |
|---|---|
| Name | `Multan`, `Hall Road Lahore` |
| **Code** | `MUL`, `HR` — prefixes every document this branch produces. Immutable once used |
| Type | Branch or **Warehouse**. Exactly one warehouse |
| Address, city, phone | |
| Opening hours, weekly closing day | From the website; used on printed documents |
| Active | Deactivating hides it without deleting history |

Seeded: `WHS` Warehouse · `HR` Hall Road · `HC` Hafeez Center · `MUL` Multan ·
`FSD` Faisalabad · `GUJ` Gujranwala · `RWP` Rawalpindi.

**Rules.**

1. A branch with any document against it can never be deleted, only deactivated.
2. **Seeded access.** Until go-live every seeded branch and user holds full
   permissions, so the system can be exercised end to end. The §2 role grants are
   applied before real trading begins (Principles §2).
3. **Creating or reactivating a branch creates a `branch_product` row for every
   active product**, price zero until the branch sets it (§3.4).

### 3.2 Brand, Category

Flat lists owned by the super admin. Category covers non-battery lines too
(chargers, accessories, storage). Both apply to raw and finished items.

**Rule.** A brand or category still referenced by an item cannot be deleted.

### 3.3 Raw items

Three shapes share one table, discriminated by `part_type`:

| Part type | Fields beyond the common ones |
|---|---|
| **Cell** | Capacity (mAh), voltage (V), physical size (`18650`), cell brand, placement (Internal / External) |
| **Complete Set** | A kit of *1 casing + 1 PCB + 1 patra*. Model, brand |
| **Other part** | Casing, PCB, patra, or anything else bought loose |

Common to all: name, model, brand, category, placement, cost price, reorder
level, active.

**Rules.**

1. A Complete Set does **not** contain cells. Cells are issued separately (§5).
2. **Raw items are master catalog.** Only the super admin — or the warehouse,
   where granted — creates or renames one. A branch never registers a raw item,
   even though it holds raw stock for the Lab (Principles §3).

### 3.4 Product — the master catalog

**This is the change that everything else rests on.** Today `product` carries a
`branch_id`, so every branch has its own disconnected rows. It splits in two:

**`product`** — one row per model, company-wide, owned by the super admin:

| Field | Notes |
|---|---|
| Model | `Dell 5547`. The identity |
| Brand, category | |
| Type | New / Branded / Charger / Storage / Other |
| Placement | Internal (INT) / External (EXT) |
| Cell type and count | The **suggested** recipe. Pre-fills production; never enforced |
| Barcode | |
| Active | |

**`branch_product`** — one row per product per branch, owned by that branch:

| Field | Notes |
|---|---|
| Selling price | The branch's own retail price |
| Minimum price | Floor a salesman cannot discount below |
| Location | Shelf, box, counter — that shop's own layout |
| Low stock threshold | |
| Wholesale cost | Weighted average of what this branch has been charged (§6.3) |

**Grade is not a product field.** *New* and *Repaired* describe a **unit**, not a
model — a `Dell 5547` is one product whether the particular battery came off the
line or came back from repair. So grade travels on the **stock movement and the
dispatch line**, never on the master row. Putting it on `product` would force a
repaired unit either to mutate the master row — flipping every branch's stock to
Repaired — or to spawn a duplicate row that rule 4 would collapse back into the
original. Cross-referenced from §5.5 and §10.

**Rules.**

1. Only the super admin creates or renames a `product`. Branches never do.
2. A branch sets only its own `branch_product` row.
3. Creating a product creates a `branch_product` row for every active branch, and
   **creating or reactivating a branch creates a row for every active product** —
   price zero until the branch sets it. The fan-out runs both ways, or a branch
   opened later can price nothing.
4. Identity is `model + brand + type + placement`, matched case-insensitively —
   the same rule the old shop app used for Excel import.

### 3.5 Parties

**A credit customer is another shopkeeper** holding a trade account with the
branch — not a friendly running tab. They take batteries on account and settle at
the end of the week or the month, so the record carries **shop name, settlement
cycle (weekly / monthly)** and an optional **credit limit**. The settlement cycle
drives the aging buckets on the receivables report (§16).

| Party | Belongs to | Gets an account? |
|---|---|---|
| **Credit customer** | The branch that granted the credit | Yes — asset, receivable |
| **Walk-in customer** | Captured inline on the sale | No |
| **Supplier** | Warehouse | Yes — liability, payable |
| **Worker** | Warehouse | No — piece count only (§5) |
| **Employee** | Branch or warehouse | Yes — expense |

Creating a credit customer or supplier **mints its ledger account atomically**.
Never by hand.

### 3.6 Repair price list

Lab work needs a price, and that price is the branch's own (Principles §9).

- The **job types** are a central list owned by the super admin — recell,
  cell replacement, PCB repair, casing swap, diagnostic.
- Each branch sets **its own price** per job type, exactly as it sets selling
  prices.
- At the till the price defaults from that list and is editable only within the
  branch's own floor.

### 3.7 Expense category

Central list so branches compare on the same rows: Rent, Electricity, Food,
Transport, Salaries, Repairs, Miscellaneous.

---

## 4. Purchasing `EXISTS`

Warehouse only. Branches buy nothing (Principles §3).

| Screen | Does |
|---|---|
| Purchase | Supplier, date, lines of **raw items or finished products**, with cost and quantity, discount, freight, paid and remaining |
| Purchase Return | Same shape, reversed, with an over-credit guard |
| Supplier advance | Money paid before goods arrive, held against the supplier until a purchase consumes it |

**Finished goods can be purchased, not only produced.** Chargers, adapters and
the other non-battery categories are bought in by the warehouse and dispatched to
branches exactly like batteries (Principles §3). For those items the **purchase
cost stands in for production cost** as the company-cost figure.

**Rules.** Freight is capitalised into stock value. Every purchase posts a
balanced voucher. Paying a supplier later is a cash or bank payment voucher
against their account.

---

## 5. Production `RESHAPE` — mostly new

Its own section, its own users. No branch sees it.

### 5.1 Workers

Name, phone, active. Nothing else — **there is no pay system** (Principles §4).

### 5.2 Issue to production

A cart, exactly like the old app: pick a worker, add Complete Sets and cells and
loose parts, transfer the lot in one action.

- Parts leave raw stock and sit in **work in progress** against that worker.
- If the product's recipe is known, the cart pre-fills the cell type and count.
  The operator can change it and the system does not object.

### 5.3 Record output

Against a worker's WIP, in three buckets:

| Bucket | Effect |
|---|---|
| **Ready** | A finished battery enters ready stock, tagged with worker and date. The worker's **piece count** goes up |
| **Used** | Parts consumed. Leaves WIP into the battery's cost |
| **Damaged** | Parts spoiled. Leaves WIP into damaged stock, tagged with worker and reason |

### 5.4 Production cost

```
production cost per battery = complete set cost + cells cost + other parts cost
```

No labour term: there is no pay system, so no rate exists to read (§5.1).

Stored on the finished battery. **Warehouse-only** — no branch ever sees it.

### 5.5 Damaged stock

Parts and finished batteries, tracked separately.

- **No ledger entry.** Quantity, value and who is answerable — that is all.
- Damaged parts can be **restocked** to raw stock or **returned to production**.
- A damaged **finished battery** can be **repaired back into sellable stock**.
  When it is: grade becomes **Repaired**, and it goes **straight out to a branch**
  rather than into warehouse ready stock. The unit keeps a reference to the
  damage record it came from, readable on the item ledger.

### 5.6 Rework

A finished battery goes back to a worker and re-enters WIP.

### 5.7 One quantity, two screens

A battery marked Ready shows in **production's ready output** and in **warehouse
ready stock** at the same moment. One quantity, two views. Dispatch deducts from
warehouse ready stock; the production log is history and never moves.

### 5.8 Screens

Issue to Production · Work in Progress (by worker) · Record Output · Damaged
Stock · Used Stock · Rework · Worker Report (pieces and damage side by side).

---

## 6. Warehouse to branch `RESHAPE`

Three steps, three documents, no shortcuts.

```
  Branch                    Warehouse                   Branch
  ──────                    ─────────                   ──────
  Demand Order   ────▶   Approve & Dispatch   ────▶   Confirm Received
  MUL-DO-1               WHS-DP-1                     MUL-RC-1
  "send me 20"           approve 15                   "15 came, 1 broken"
                         set wholesale price
                              │                             │
                              ▼                             ▼
                        leaves ready stock           enters branch stock
                                                     dues go up (§7)
```

### 6.1 Demand Order — raised by the branch

Lines of products and quantities. Status: Raised → Approved → Dispatched →
Received, or Rejected. Raw items can be demanded the same way, for Lab work.

### 6.2 Dispatch — the warehouse

- May approve **less** than asked, per line.
- Sets the **wholesale price** per line — what the branch will be charged.
- Records the **production cost** per line, warehouse-only.
- Stock leaves warehouse ready stock on dispatch.

### 6.3 Receipt — the branch confirms

Nothing enters branch stock until the branch says it arrived. Short and damaged
quantities are recorded here, per line, not silently absorbed.

On confirmation:
- branch stock goes up by the received quantity
- the branch's **wholesale cost** for that product is recalculated as a
  **weighted average** (Principles §17.9)
- the branch's dues go up by the received value at wholesale (§7)

### 6.4 Rules

1. Every dispatch line carries **two prices** — wholesale, and production cost.
2. A branch never sees **production cost**.
3. **A branch does see the wholesale price**, on every dispatch and receipt line.
   It is what the branch is charged and what its dues are built from. "Cost is
   hidden" means the factory cost, never the price the branch itself pays.
4. **Dues arise on confirmed receipt, not dispatch.** Stock in transit is nobody's
   debt. Shortages and transit damage recorded at receipt (§6.3) never become one.
5. **Branch-to-branch transfer is refused.** Stock returns to the warehouse
   first.

### 6.5 The two profit figures

Both are correct, and they answer different questions:

```
branch profit   = selling price − wholesale price − branch expenses
company profit  = selling price − production cost
```

The branch admin is measured on the first and normally sees only that, and only
where granted (§2). The super admin sees both, side by side (§17).

---

## 7. What a branch owes `NEW`

One **inter-branch account** per branch. It answers five questions at any moment:

| Question | Answer |
|---|---|
| Stock received | Total confirmed receipts, at wholesale |
| In transit | Dispatched, not yet confirmed — nobody's debt yet |
| Paid | Total remitted to the warehouse |
| Shipped for the E-Store | Total accepted shipments, at wholesale (§11) |
| Still owed | Received − paid − E-Store shipped |
| Stock on the shelf | Valued at wholesale **and** at that branch's selling price |

Moving stock inside one company **creates no revenue**. Revenue happens once,
when a branch sells to an outside customer. The two sides of every inter-branch
entry cancel on consolidation, so the combined balance sheet is never inflated.

**Remittance screen.** The branch records cash or bank sent to the warehouse; the
warehouse confirms receipt. Both sides post, and the balance falls.

---

## 8. Selling `RESHAPE`

### 8.1 One sale document

Walk-in and credit are the **same document** with a different customer — not two
tables as in the old shop app. Every sale, cash or credit, lands in one day book,
one stock history and one ledger.

| Field | Notes |
|---|---|
| Number | `MUL-1` walk-in, `MUL-C-1` credit — branch code, then that branch's own counter per series. **The number says which it is**, as the old `W-Bill` / `K-Bill` split did, while the document itself stays one shape |
| Date | Selectable; defaults today |
| Customer | Walk-in (name and phone inline) or a credit customer |
| Salesman | The signed-in user |
| Lines | Product, quantity, price, line total |
| Custom lines | Free-text **service or charge** lines only — fitting, delivery, labour. Revenue with no stock movement. **Never a physical item**: a branch cannot sell goods that are not in the master catalog (§3.4) |
| Discount | Recorded as a discount — never as a changed cost |
| Payment | Cash / Card / Online, or On Account |

### 8.2 Rules

1. Price defaults to the branch's selling price and **cannot go below its minimum
   price**.
2. Quantity cannot exceed branch stock.
3. Cost of sale is the branch's **weighted-average wholesale cost** — read from
   the record, never typed.
4. A credit sale raises that customer's balance; it never touches cash.
5. Every sale posts a balanced voucher (§14).

### 8.3 Hold sale

Park an unfinished sale and resume it. **No stock movement and no ledger impact
until it is converted.**

This one already exists, under the wrong name — the `lease_sale` module is a
parked basket that posts nothing and converts through the normal sale path. It is
renamed to `hold_sale` and pointed at the new sale document, not rebuilt.

### 8.4 Sale return

Restocks the branch and either refunds a walk-in or reduces a credit customer's
balance. Writes a reversal — never edits the original (§15.4).

### 8.5 Credit customers

| Feature | Detail |
|---|---|
| Ledger | Bills raise the balance; payments and advances lower it |
| Advances | Applied automatically to the next bill |
| Statement | PDF for any date range, with logo |
| Simple slip | Total billed, total paid, pending — nothing else |
| Status | Due / Partial / Paid, shown per invoice |
| Bulk | Print or report on several invoices at once |

The word *khata* appears nowhere. On screen: **Credit Customer**, **Credit
Sale**, **Customer Statement**.

---

## 9. Lab — repair `RESHAPE`

Repairing a **customer's own battery**, at a branch, for a charge. A branch does
not buy old batteries to refurbish and resell.

| Step | Detail |
|---|---|
| Receive | Customer, battery description, fault, promised date |
| Repair | Consumes raw parts from that branch's raw stock |
| Charge | Defaults from that branch's own repair price for the job type (§3.6); editable only within the branch's floor |
| Record | **Description of the work done** — required |
| Invoice | `MUL-LB-1`, revenue to that branch, in the same day book |
| **Hand back** | **The customer collects his own battery.** Job closed |

**A Lab repair never creates stock.** The battery belongs to the customer
throughout — the branch is selling labour and parts, not a battery. So the job
posts parts out and revenue in, and **no finished-goods movement of any kind**.
A developer who writes a stock-in on repair completion has built it wrong.

Repair charges are branch revenue. The parts consumed are its cost.

### The two repairs are not the same flow

| | **Lab (§9)** | **Warranty (§10)** |
|---|---|---|
| Whose battery | The customer's | The company's |
| Where | Branch | Warehouse |
| Who pays | Customer pays the branch | Nobody; warehouse absorbs |
| Destination | **Back to its owner** | **Back to the claiming branch** |
| Stock effect | Parts out only | Branch stock restored |

---

## 10. Warranty `NEW`

The customer never waits.

```
  Faulty battery comes back to a branch
              ↓
  Branch hands over a replacement from its own stock   ── immediately
              ↓
  Faulty unit → the branch's Warranty Hold   (not sellable, not in stock value)
              ↓
  Branch raises a Claim Order  MUL-WC-1  and ships the faulty units
              ↓
  Warehouse receives into Warranty Received  (separate from raw and ready)
              ↓
              ↓
  Warehouse ASSESSES the unit — repairable or not?
              ↓
  ├─▶ REPAIRABLE      → repaired with raw parts, the SAME unit goes back,
  │                     graded Repaired.        Cost: the parts consumed
  └─▶ NOT REPAIRABLE  → a NEW battery issued from ready stock,
                        graded New.             Cost: a whole battery
              ↓
  Either way it returns to the branch that claimed it
  ── branch stock restored · claim closed
```

**Rules.**

1. Warranty stock is counted **per branch, separately from sellable stock**. A
   unit in Warranty Hold is not on sale and not in inventory value.
2. **The branch is never charged.** The damaged battery it sent back *is* the
   payment. Its dues do not move.
3. **The warehouse carries the cost** — an allotted replacement posts a warranty
   expense at the warehouse, so inventory still reconciles against the ledger.
4. **The warehouse assesses every claimed unit**, and the outcome is a recorded
   field, not a note:

   | Assessment | Action | Returns | Cost posted |
   |---|---|---|---|
   | Repairable | Repair with raw parts | The same unit, grade **Repaired** | Parts consumed |
   | Not repairable | Issue from ready stock | A different unit, grade **New** | A whole battery at production cost |

5. **Either outcome returns to the branch that claimed it** — never into general
   warehouse stock. That closes the claim and restores what the branch handed
   over. The grade travels with the unit, so the branch knows which it got.
6. **Repair and replacement are reported separately.** A rising replacement rate
   on a model is a manufacturing signal; a blended warranty figure hides it.

**Claim statuses:** Raised → Shipped → Received → Assessed (Repairable / Not
repairable) → Returned or Replaced → Closed.

---

## 11. E-Store `NEW`

The website takes the order. The **E-Store manager** picks a branch near the
customer. That branch ships and records it here.

| Field | Notes |
|---|---|
| Number | `MUL-ES-1` |
| Order reference | From the website. Must be unique — a second shipment against it is refused |
| Customer, shipping address | From the order |
| Assigned branch | Set by the E-Store manager |
| Lines | Product, quantity, **wholesale value** |
| Status | Raised → Accepted, or Rejected |
| Recorded by / at | The branch user who shipped it, and when |
| Accepted by / at | The warehouse admin who accepted it, and when |
| Rejection reason | Required when rejected |

**Rules.**

1. **The E-Store is a channel, not a place.** Nothing is ever held in E-Store
   stock.
2. **It is not a branch sale.** No branch revenue, no branch profit, nothing in
   the branch day book. For the branch it is one less battery on the shelf.
3. **It moves at wholesale** — what the warehouse charged that branch. The
   branch's selling price and the website price are both irrelevant here.
4. Stock leaves the branch **when the shipment is recorded**, because the battery
   physically leaves.
5. The **warehouse admin accepts it**; only then does the branch's balance move.
6. Accepted shipments **reduce the branch's dues** by the wholesale value (§7).
7. Rejected shipments return the stock. A customer return restocks the branch and
   reverses the adjustment.
8. Revenue is head office's. Company profit = website price − production cost.

---

## 12. Expenses `NEW`

Per branch, per date, per category, with a description.

**The screen is built around the month:**

- one month at a time by default
- totals per category for that month
- the previous month beside it
- a full year, month by month, in one table
- the total flows into branch profit: `selling − wholesale − expenses`

---

## 13. Cash and bank `EXISTS`

Each branch holds its own cash and bank accounts. Receipts and payments are
recorded as vouchers (§14). Remittance to the warehouse is §7.

---

## 14. Accounting `EXISTS`

### The chart of accounts

Three levels: **head** (5) → **sub-head** → **account** (the only postable
level), with a grouping tier inside level 3.

Seeded sub-heads: `101` Current Assets · `102` Fixed Assets · `501` Cost of Sales
· `502` Operating Expenses. **The 501/502 split is what produces gross margin** —
profit before rent and electricity — so it is not optional decoration.

```
account_id = head × 1,000,000 + sub-head × 10,000 + group × 100 + sequence
1010402    = Asset / Current / Inventory / #02  →  Inventory — Finished Goods
```

Codes are allocated by the system, atomically, never typed. Each group holds 99;
when one fills, the system refuses rather than misclassifying. About 40 accounts
are marked *System* — renameable, but **never renumberable and never deletable**,
because the software references those codes directly and every historical entry
points at the number.

Groups that matter here: `01` cash and bank per branch · `02` receivables per
branch · `03` advances to suppliers · `04` inventory (raw, WIP, ready, branch) ·
`05` **inter-branch, one per branch**.

### Vouchers

Five types, one module: **CRV** cash receipt · **CPV** cash payment · **BRV**
bank receipt · **BPV** bank payment · **JV** journal.

### Automatic postings

| Event | Posts |
|---|---|
| Purchase — raw | Raw stock up, supplier payable up, freight capitalised |
| Purchase — finished goods | Ready stock up at purchase cost, supplier payable up |
| Production | Raw stock down, finished goods up at production cost |
| Dispatch and receipt | Inventory moves branch to branch via inter-branch clearing |
| Sale | Revenue at gross, discount separately, COGS at branch weighted average |
| Sale return | Reversal |
| Lab invoice | Repair revenue up, parts consumed. **No finished-goods movement** — the battery is the customer's |
| Warranty — repaired | Warranty expense at the warehouse for the **parts consumed**; branch inventory restored |
| Warranty — replaced | Warranty expense at the warehouse for a **whole battery at production cost**; ready stock down; branch inventory restored |
| E-Store shipment | Branch inventory down, inter-branch down, at wholesale |
| Expense | Expense up, cash or bank down |

**Not posted:** damaged stock, and worker piece counts.

---

## 15. Rules the system enforces

1. **Every voucher balances**, or it is rejected before anything is written.
2. **Money is never a float.** Exact decimals end to end.
3. **Nothing is half-recorded.** A document, its lines and its ledger entries
   commit together or not at all.
4. **Editing does not erase.** A posted document is changed by reversal plus a
   new entry. *A deliberate break from the old shop app, which deleted bills and
   quietly restored stock.*
5. **Cost is never typed at the till.** Branch cost comes from the receipt line;
   company cost from the production run.
6. **Stock only moves through a document.** Nothing enters or leaves without a
   purchase, production, dispatch, receipt, sale, return, claim or shipment.
7. **Deleting is refused when something depends on it.**
8. **A branch cannot see another branch** — enforced in the query layer.

---

## 16. Reports

| Report | Scope |
|---|---|
| Stock — raw, ready, branch | Quantity and value, at wholesale and at selling price |
| Item ledger | Running balance per item, from the movement view |
| Low stock | Below threshold, with restock suggestions |
| Dead stock | No movement in ninety days, per branch |
| Day book | Every sale and repair, with cost and profit for those allowed |
| Sale, purchase, return | By date, branch, customer, supplier |
| Production | Output, per worker pieces, damage |
| Damaged and used stock | Per worker, per model |
| Warranty | Claims by status, branch, model, and **assessment — repaired vs replaced**, so a model failing beyond repair is visible |
| E-Store | Shipments by branch, model, status |
| Expenses | By month, category, branch |
| Branch dues | Received, paid, E-Store shipped, outstanding |
| Credit customers | Aged receivables |
| Trial balance, income statement, balance sheet | Per branch and consolidated. The income statement shows **gross margin** as its own line, from the 501/502 split (§14) |

**Every report exports to Excel with the filter applied**, a summary block at the
top, the logo, and coloured headers — the shape the old apps already produce.

---

## 17. Dashboards `RESHAPE` — no charting library exists yet

### Super admin — charts **and** figures

Sales · **Profit** — company (`selling − production cost`) and per branch
(`selling − wholesale − expenses`) side by side, per §6.5 · Stock value per branch
· Branch dues · Receivables aged · Production output and damage · Warranty by
model · Lab revenue · E-Store · Best sellers · **Dead stock — anything with no
movement in ninety days**.

The super admin can also **open any single branch's dashboard in that branch's
own context**, seeing exactly what that branch sees. A branch selector sits in the
filter row.

### Branch — figures only

Its sales, its stock at its own prices, this month's expenses, its cash and bank,
its credit customers, what it owes the warehouse. Profit only where granted.

### Rules

1. Every figure clicks through to the list behind it.
2. Every panel obeys the page's date filter.
3. Nothing on a branch dashboard reveals another branch.
4. Cost-derived figures stay hidden unless the viewer is allowed cost.

---

## 18. Cross-cutting

### Filters

Every list filters; **every export carries only what the filter shows**. Date
range and month appear almost everywhere, with quick picks — Today, Yesterday,
This Week, This Month, Last Month, Custom.

### Document numbering

Branch code, document code, then that branch's own counter:

```
MUL-1      sale, walk-in    MUL-ES-1   E-Store shipment
MUL-C-1    sale, credit     MUL-WC-1   warranty claim
MUL-SR-1   sale return      MUL-DO-1   demand order
MUL-LB-1   lab invoice      WHS-PI-1   purchase
MUL-RC-1   receipt          WHS-PR-1   production run
WHS-DP-1   dispatch
```

### Excel import and export

Import with **preview before commit**, colour-coded NEW versus UPDATE, row-level
validation that skips bad rows and reports them, and quantities **added** to
existing stock rather than replacing it. Available for products, raw items,
customers and opening stock.

**Preview is the point, so it is a screen, not an endpoint.** Registration →
*Import Raw Items* uploads the spreadsheet, shows every row classified with its
row number, and writes nothing until the operator presses Import. Rows that fail
validation are listed with the reason and skipped; the rest still import. The
row classes reuse the reserved status colours — NEW reads *good*, UPDATE reads
*warning*, ERROR reads *critical* — rather than inventing a fourth palette.

Raw items are the first consumer. Products, customers and opening stock point at
the same engine rather than growing three more importers.

### Printing

A5 PDF invoices with logo, branch details and a bordered table; plus statements,
slips, dispatch notes and claim orders. One normalised document shape, one
template.

### Audit

Every create, edit and delete is logged with user, timestamp, before and after.

---

## 19. Build order

Each phase leaves the system working. **All thirteen have landed** — the table
below is now history rather than a plan. What a phase is *not* finished by is
green tests: Warranty, E-Store and Excel import each passed their service tests
while no user could reach them, because no screen existed. A phase is finished
when someone can drive it in the browser (PLAN's definition of done).

| # | Phase | Why here |
|---|---|---|
| 1 | **Split `product` into master + `branch_product`** | Everything else sits on it |
| 2 | Branch codes, document numbering, roles and users, the print shell | Needed before any document exists |
| 3 | Raw items — cells with specs, Complete Sets | Production needs them |
| 4 | Production — workers, WIP, output, damage, rework | Fills ready stock |
| 5 | Demand order, dispatch, receipt with two prices | Fills branch stock |
| 6 | Inter-branch account and remittance | Makes dues real |
| 7 | Selling — one document, credit customers, returns | The branch's daily work |
| 8 | Lab, expenses | Branch completeness |
| 9 | Warranty and claims | Depends on branch stock existing |
| 10 | E-Store shipments | Depends on wholesale cost per branch |
| 11 | Reports and Excel | Over finished data |
| 12 | Dashboards | Reads everything else |
| 13 | Opening balances | Last, because the books start here and nothing trades until they do |

### Removed on the way

`province`, `city`, `department`. `product.image_path` moves out of the database
into file storage.

**Not `lease_sale`** — despite its name it is Hold Sale (§8.3), built correctly
and posting nothing to the ledger. It is renamed to `hold_sale`, not dropped.

---

*Derived from [PRINCIPLES.md](PRINCIPLES.md). When a decision changes, change it
there first, then here.*
