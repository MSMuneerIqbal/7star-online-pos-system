# Working principles

Decisions already made, and the rules the system enforces. This is the shared
reference for 7 Star Laptop Battery Station — when we change something, we
change it here first.

---

## 1. The business, in one page

**One company.** One warehouse that manufactures, and any number of branches
that sell. Branches do not buy from anyone else — all their battery stock comes
from the warehouse.

```
   PURCHASE            PRODUCTION             DISTRIBUTION           RETAIL
   ────────            ──────────             ────────────           ──────

   Suppliers ──▶  RAW STOCK  ──▶ worker ──▶ READY STOCK ──▶ BRANCH ──▶ Customer
                  (warehouse)                (warehouse)     stock       │
                     │                                         │        ├─ walk-in (cash)
                     │                                         │        ├─ credit account
                     │                                         │        └─ E-Store order
                     │                                         │           shipped by a branch
                     └──────────── raw parts also ─────────────┘
                                   go to branches
                                   (for Lab repairs)
```

The warehouse and the raw-parts store are **the same physical place**, holding
two kinds of stock:

| Stock kind | What it is | Where it goes |
|---|---|---|
| **Raw stock** | Cells, casings, PCBs, patras — bought in | Production, or a branch (for Lab) |
| **Ready stock** | Finished batteries | Branches |

---

## 2. Places, and what each one does

### The warehouse — the main hub

The warehouse is where batteries are manufactured and where every branch's stock
comes from. It is the super admin's own place, not a peer of the branches.

- Buys raw parts from suppliers
- Runs production: issues parts to workers, receives finished batteries
- Holds the finished-goods store
- Approves branch demand orders and dispatches stock
- Owns the **master catalog** — model names, brands, types, categories
- Handles warranty claims coming back from branches
- Sees everything, everywhere

### A branch

- Registered inside this software, by the super admin — not hard-coded
- Holds its own stock, received only from the warehouse
- Sets **its own selling prices** on that stock
- Sells to walk-in customers (cash) and credit customers (on account)
- Runs a **Lab** — repairs old batteries for a charge
- Pays its own rent, electricity, food and other expenses
- Holds its own cash and bank, and remits to the warehouse
- Sees only itself

Branches are **data, not code.** The super admin creates every one of them, and
adding a branch is a screen, not a deployment.

**Each branch has a code**, entered when the branch is created. That code
prefixes every document that branch produces (§7).

The system starts seeded with the real branches, so there is something true to
test against:

| Code | Branch | Where |
|---|---|---|
| `WHS` | Warehouse (Main) | The manufacturing hub |
| `HR` | Hall Road, Lahore | Near Waqas Biryani, Kacha Hall Road |
| `HC` | Hafeez Center, Lahore | 3rd Floor, Hafeez Center |
| `MUL` | Multan | Khan Plaza |
| `FSD` | Faisalabad | 2nd Gallery, G/F, Rex City |
| `GUJ` | Gujranwala | Civil Computer Market, near Gondal Hospital |
| `RWP` | Rawalpindi | 6th Road, B-1st, Techno City 2 |

All of them get full access to begin with, so the software can be tested end to
end. Access is narrowed to §11 before real trading starts.

---

## 3. The master catalog — one list, many price lists

This is the rule that makes multi-branch reporting possible.

**The super admin owns the item.** Model name, brand, type, placement, category
and part type are created once at the warehouse and are visible to every branch.
Nobody at a branch renames a model.

**The branch owns the price and the place.** After stock arrives, the branch
manager sets:

- its **selling price** (the branch's own retail price)
- its **location** in that shop (shelf, box, counter)
- its low-stock threshold

So `Dell 5547 / INT / New` is one item across the whole company, with one
identity and one history — but Multan may sell it at Rs 4,800 and Faisalabad at
Rs 5,000, and both are correct.

**Categories exist because you sell more than batteries.** Non-battery products
are bought by the **warehouse** and dispatched to branches exactly like
batteries. Category is part of the master catalog, created by the super admin,
and applies to warehouse and branch stock alike.

**Branches cannot create items, and branches cannot buy locally.** Every product
a branch sells — battery or not — comes from the warehouse and already exists in
the master catalog. There is no branch purchase screen and no branch supplier.
What a branch sets is its own selling price, its own location in that shop, and
its own low-stock threshold.

---

## 4. Production — raw stock becomes a battery

Production is its own section with its own users. Nobody in a branch sees it.

### What a Complete Set actually is

A **Complete Set** is a kit of the scattered parts of one battery — **1 casing +
1 PCB + 1 patra**. It does **not** include cells.

Cells stay in raw stock as their own items, with their own types, and are
counted separately at the moment they are issued to production. So one battery
consumes:

```
1 Complete Set  (casing + PCB + patra)
+ N cells       of the cell type that model takes
```

### Cells are a catalog of their own

Cells are registered like any other raw item, but carry their own
**specifications**:

| Field | Example |
|---|---|
| Capacity | 2200 mAh |
| Voltage | 3.7 V |
| Physical size | 18650 |
| Cell brand | Samsung, LG, BAK |
| Placement | Internal or External — which kind of battery it goes into |

There will be many of them, and the master catalog holds them all.

Cells are issued to production **with a complete set, or on their own** as loose
parts.

**A recipe suggests; it does not refuse.** A model may carry a default cell type
and count, so the issue cart pre-fills and nobody has to remember that a given
model takes six. But what is actually issued and actually consumed is what the
system records and what the battery costs. The software never blocks a run
because the count came out different — real production varies, and the record
should show what happened, not what was planned.

### The flow

1. **Issue** — a cart of complete sets and cells is transferred to a named
   **worker**. The parts leave raw stock and sit in Production (work in
   progress) against that worker.
2. **Assemble** — the worker builds batteries.
3. **Receive** — the output is recorded in three buckets:

| Bucket | Meaning | Effect |
|---|---|---|
| **Ready** | A finished battery | Enters ready stock, tagged with worker and date |
| **Used** | Parts consumed into that battery | Leaves WIP, becomes part of the battery's cost |
| **Damaged** | Parts the worker spoiled | Leaves WIP into damaged stock, tagged with the worker and a reason |

4. **Rework** — a finished battery can be sent back to a worker and re-enter
   production.

### One quantity, shown in two places

When output is marked **Ready** it appears in **production's ready stock** and in
**warehouse ready stock** at the same moment. These are not two piles. It is one
quantity on two screens — production wants to see what it made, the warehouse
wants to see what it can ship.

Dispatching to a branch **deducts from warehouse ready stock**. Production's
output log is history, and history never moves.

### A finished battery can be marked damaged — and can come back

Separately from damaged parts, a **finished battery** can be moved out of ready
stock into damaged batteries — one that failed testing, came back dead, or was
spoiled in handling. Like damaged parts it is a record, not a ledger entry: how
many, what they were worth, and who is answerable.

**A damaged battery can be repaired back into sellable stock.** When it is, it
does not return as new — it is graded **Repaired**, and it goes **straight out to a
branch** rather than sitting in the warehouse. The grade travels with it, so a
repaired unit is never sold as new and is always traceable back to the damage
record it came from.

### Damaged stock is a record, not an accounting entry

Damaged stock **does not post to the ledger.** It exists to answer three
questions: how much was damaged, what was it worth, and which worker damaged it.
It is a conversation with the worker, not a charge against them.

Damaged parts can be **restocked to the warehouse** if they turn out to be
usable, or **sent back to production**.

### Each worker has a running piece account

The moment output is marked **Ready**, those pieces are added to that worker's
account.

**There is no pay system in the software.** It counts pieces — that is the whole
job. No rates, no wage calculation, no payroll, no payment posting. What a worker
is paid is settled outside the system, from the count it gives you.

Damage never reduces the count. A worker's piece account and their damage record
are reported side by side, so the two can be read together.

### What a battery costs to make

```
production cost = complete set cost + cells cost + other parts cost
```

This is the company's true cost, and it is stored on the finished battery. It is
warehouse information — a branch never sees it.

---

## 5. Warehouse to branch — demand, dispatch, receive

Stock never simply appears at a branch. It moves through a three-step handshake,
and every step is recorded.

```
   BRANCH                    WAREHOUSE                  BRANCH
   ──────                    ─────────                  ──────

   Demand Order  ────▶   Approve & Dispatch   ────▶   Confirm Received
   "send me 20"          approve 15, set             "15 arrived, 1 broken"
                         wholesale price
                              │                             │
                              ▼                             ▼
                       leaves ready stock            enters branch stock
                                                     branch now owes for it
```

1. **The branch raises a demand order.** What it wants, and how many.
2. **The warehouse approves it.** It may approve less than asked. The warehouse
   sets the **wholesale price** on each line — the price the branch is charged.
3. **The branch confirms receipt.** Nothing enters branch stock until the branch
   says it arrived. Shortages and damage in transit are recorded here, not
   silently absorbed.

Raw parts move to branches the same way, for Lab repairs.

### Two prices on every line

Each dispatched line carries two numbers:

| Number | Who sets it | Who sees it | What it is used for |
|---|---|---|---|
| **Wholesale price** | Warehouse | Warehouse + branch | The branch's cost, and what the branch owes |
| **Production cost** | System, from the run | Warehouse only | The company's true cost |

The branch then sets its **selling price** on top of the wholesale price.

This is why there are two correct profit figures, and both are real:

```
branch profit    = selling price − wholesale price − branch expenses
company profit   = selling price − production cost
```

The branch manager is measured on the first. The super admin sees both.

---

## 6. What the branch owes the warehouse

Because it is one company, moving stock from the warehouse to Multan is **not a
sale and does not create revenue.** Revenue happens once — when a branch sells
to an outside customer.

But the branch still has to answer for the stock it took. That is held in an
**inter-branch account**:

- On **confirmed receipt**, the branch's inter-branch balance **increases** by
  the wholesale value of what actually arrived. Not on dispatch — a branch
  answers for what it has, and shortages found on arrival (§5) never become a
  debt.
- When the branch remits cash to the warehouse — weekly, or whenever it chooses
  — the balance **decreases**.
- When the branch ships an E-Store order and the warehouse admin accepts it, the
  balance **decreases** by the wholesale value of what went out (§7). The branch
  was charged for that battery on arrival and no longer has it.

So at any moment, for every branch, the system answers:

| Question | Answer |
|---|---|
| How much stock has it received? | Total confirmed received, at wholesale |
| What is still in transit? | Dispatched but not yet confirmed — nobody's debt yet |
| How much has it paid? | Total remitted |
| How much has it shipped for the E-Store? | Total accepted, at wholesale |
| How much does it still owe? | The difference |
| How much stock is still on its shelves? | Branch stock, valued two ways — |
| | at wholesale (what it owes against) |
| | at its own selling price (what it expects to earn) |

The two sides of the inter-branch account always cancel across the company, so
the combined balance sheet is never inflated by internal movement.

---

## 7. Selling at a branch

### Walk-in

Cash, card or online. Recorded and settled immediately.

### Credit customer

**A credit customer is another shopkeeper** who takes batteries on account and
settles at the end of the week or the month. That is the important distinction —
this is a trade account, not a friendly tab.

The word *khata* does not appear anywhere in this software. On screen it is
**Credit Customer**, **Credit Sale**, and **Customer Statement**.

Each credit customer has a running ledger:

- bills raise the balance
- payments and advances lower it
- advances applied automatically to the next bill
- statements printable for any date range
- a simple slip — total billed, total paid, pending — for long-running accounts

Credit receivables belong to **the branch that granted the credit**. Multan
carries Multan's risk.

### One sale document

Walk-in and credit are the **same sale document** with a different customer, not
two separate systems as in the old shop app. The invoice number still shows
which it is, and every sale — cash or credit — lands in one day book, one stock
movement history, and one ledger.

### Invoice numbering

Every branch runs **its own series, prefixed with its branch code**: `MUL-1`,
`MUL-2`, then `HR-1` at Hall Road. The prefix is set when the branch is created,
and the counter belongs to that branch alone.

### Non-battery items and repair charges

Other categories are sold the same way. Repair charges are sold through the Lab
(§9) and appear in the same day book.

### The E-Store — an online order shipped by a branch

7 Star sells online too. The website takes the order; the **E-Store manager**
picks a branch near the customer and tells it to ship. That branch ships the
battery and records it here.

```
   Order arrives on the website
              │
              ▼
   E-Store manager tells the nearest branch to ship it
              │
              ▼
   Branch admin records an E-Store Shipment
   ── order reference, what went out
              │
              ▼
   Branch stock is deducted at WHOLESALE      ── the battery is gone
              │
              ▼
   Warehouse admin accepts it
              │
              ▼
   The branch's dues fall by that wholesale value (§6)
```

Rules this encodes:

1. **The E-Store is a channel, not a place.** Nothing is ever held in E-Store
   stock — the battery goes from the branch's shelf to the customer.
2. **It is not a branch sale.** No branch revenue, no branch profit, nothing in
   the branch's day book. For that branch it is simply **one less battery on the
   shelf**.
3. **It moves at the wholesale price** — what the warehouse charged that branch
   when it sent the stock. The branch's own selling price is irrelevant here,
   and so is what the customer paid on the website.
4. **Stock leaves when the shipment is recorded**, because the battery
   physically leaves. A branch cannot sell what it has already boxed.
5. **The warehouse admin accepts it.** Nothing settles on the branch's word
   alone — the same handshake as a demand order (§5), running the other way.
6. **The branch's dues fall by the wholesale value** (§6). It was charged
   wholesale for that battery when it arrived; it no longer has it and never
   sold it, so the charge comes back off. The branch ends up neither better nor
   worse off, which is the point.
7. **The revenue is head office's**, because head office took the customer's
   money. Company profit on an E-Store order is the website price less the
   production cost.
8. **Every shipment is a record** — order reference, customer, what shipped, the
   wholesale value, which branch, who recorded it, who accepted it, and when.

Rejected shipments return the stock to the branch. A customer return against an
E-Store order restocks the branch that shipped it and reverses the adjustment.

---

## 8. Warranty — the branch replaces first, claims after

The customer is never made to wait. This flow is built around that.

```
  Customer returns a faulty battery
              │
              ▼
  Branch hands over a replacement from its own stock  ── immediately
              │
              ▼
  Faulty unit sits in the branch's Warranty Hold  (not sellable stock)
              │
              ▼
  Branch raises a Claim Order to the warehouse and ships the faulty units
              │
              ▼
  Warehouse receives them into Warranty Received  (separate from raw & ready)
              │
              ▼
  Warehouse ASSESSES each unit — is this battery repairable?
              │
      ┌───────┴────────┐
      │                │
   REPAIRABLE      NOT REPAIRABLE
      │                │
      ▼                ▼
  Repaired at the   A NEW battery is issued
  warehouse using   from ready stock
  raw parts         │
      │             │
      └───────┬─────┘
              ▼
  Returned to the branch that claimed it  ── stock restored, claim closed
```

Rules this encodes:

1. **Warranty stock is counted per branch, separately from sellable stock.** A
   battery in Warranty Hold is not on sale and is not part of branch inventory
   value.
2. **A claim is settled in batteries, and the branch is never charged.** Nothing
   is added to what the branch owes. The branch already sent the faulty battery
   back; that *is* the payment. Its inter-branch balance does not move.
3. **The warehouse decides, and the battery's condition decides for it.** Every
   claimed unit is assessed, and the assessment is recorded — it is the only
   place anyone learns *why* a model keeps failing.

   | Assessment | What happens | What goes back | What it costs |
   |---|---|---|---|
   | **Repairable** | Repaired at the warehouse with raw parts | The **same unit**, graded Repaired | The parts consumed |
   | **Not repairable** | A **new** battery issued from ready stock | A different unit, graded New | A whole battery at production cost |

4. **Either way it goes back to the branch that claimed it**, never into general
   warehouse stock. That closes the claim and restores the stock the branch
   handed to its customer. The branch can always see which it received, because
   the grade travels with the unit.
5. **The warehouse carries the warranty cost**, because it is the manufacturer.
   Both outcomes post a warranty expense at the warehouse — parts on a repair, a
   whole battery on a replacement — never charged onward, so inventory still
   reconciles against the ledger. The two are reported separately: a rising
   *replacement* rate means a model is failing beyond repair, which is worth far
   more to know than a single blended warranty number.

---

## 9. Lab — repairing a customer's battery

**Lab means repairing an old battery a customer brought in.** That is all it is.
A branch does **not** buy old batteries to refurbish and resell.

- A customer brings in an old battery.
- The branch repairs it using **raw parts from its own raw stock** — cells,
  patras — received from the warehouse the same way finished batteries are.
- The branch charges a **repair price** and records the job with a
  **description** of the work done.
- **The customer gets his own battery back.** That is the whole point of a
  repair, and it is what separates the Lab from everything else in this system.
- Every job lands in the branch's **Repairing** section, and the charge is
  **branch revenue** — it appears in the branch's sales and day book alongside
  battery sales.
- The parts consumed leave branch raw stock and are the cost of that revenue.

**A repaired battery never enters stock.** It was never the company's to begin
with — it belongs to the customer, who is only paying for the work. So a Lab job
moves parts out and money in, and no finished battery is created anywhere. This
is why the Lab looks nothing like production even though both consume parts.

Each branch sets its own repair prices, exactly as it sets its own selling
prices.

### The two repairs, side by side

The word *repair* covers two entirely different journeys, and confusing them
would corrupt stock:

| | **Lab repair** | **Warranty repair** |
|---|---|---|
| Whose battery | The customer's | The company's |
| Where | At the branch | At the warehouse |
| Who pays | The customer pays the branch | Nobody — the warehouse absorbs it |
| Where it goes after | **Back to its owner** | **Back to the branch that claimed it** (§8) |
| Stock effect | Parts out. No battery in or out | Branch stock restored |

---

## 10. Expenses, and the monthly view

Each branch pays its own rent, electricity, food and everything else it runs on.
Those costs belong to **that branch's** profit — never the warehouse's, never
another branch's.

Every expense is recorded against **one branch, on one date, in one category,
with a description**.

The expense screen is built around the month, because that is how rent and
electricity actually arrive:

- one month at a time is the default view
- totals per category for that month
- the previous month beside it, so a jump is obvious
- a full year, month by month, in one table
- the month's total drops straight into that branch's profit:
  `selling − wholesale − expenses`

**Expense categories are set up centrally** — Rent, Electricity, Food,
Transport, Salaries, Repairs, Miscellaneous — so that Multan's rent and
Faisalabad's rent land in the same row when you compare the two branches.

### Filters everywhere

Every list carries filters, and **every export carries only what the filter is
showing** — never the whole table.

| List | Filters |
|---|---|
| Stock — branch and warehouse | brand, category, type, placement, model search, low stock only |
| Sales / day book | date range, month, branch, customer, payment method, walk-in or credit |
| Credit customers | status (due / partial / paid), customer, date range |
| Demand orders | status (raised / approved / dispatched / received), branch, date range |
| Production | worker, model, part type, cell type, date range |
| Damaged and used stock | worker, model, part type, date range |
| Warranty claims | status, branch, model, date range |
| E-Store shipments | status (raised / accepted / rejected), branch, model, order reference, date range, month |
| Repairing (Lab) | date range, month, branch, customer |
| Expenses | month, year, category, branch, date range |
| Workers | worker, date range, pieces, damage |

Date range and month appear on nearly every screen, with the quick picks your
current apps already use — Today, Yesterday, This Week, This Month, Last Month,
Custom.

---

## 11. Who sees what

This is a permission model, not a wall. The default is narrow; the super admin
opens it up.

| Role | Sees |
|---|---|
| **Super admin** | Everything. Every branch's own dashboard as that branch sees it, plus production, both cost figures, and all profit. Creates the branches and dispatches their stock |
| **Warehouse admin** | Whatever the super admin ticks. Created by the super admin to run the hub day to day, feature by feature. Accepts E-Store shipments (§7) |
| **Warehouse stock** | Raw and ready stock, demand orders, dispatch, claims |
| **E-Store manager** | Website orders, and which branch ships each one. Sees stock across all branches so they can pick a near one — nothing else |
| **Production** | Workers, issues, output, damage, rework. No branch prices |
| **Branch admin** | Own branch only — own stock, own sales, own expenses, own cash and bank, own credit customers. Raises E-Store shipments (§7). Creates and controls the salesmen under them |
| **Branch salesman** | Sells, and sees stock at selling price. No cost, no profit. Whatever else their branch admin allows |

### Who creates whom

```
  Super admin
      │
      ├──▶ Warehouse admin   — ticks the features they get
      │
      └──▶ Branch admin      — one per branch
                 │
                 └──▶ Branch salesman  — created by the branch admin,
                                         given only what that admin allows
```

**The super admin controls every account in the company.** Reset any branch
admin's password, deactivate an account, reassign it, or take a feature back —
without needing anyone's cooperation. A branch admin has that same power, but
only over the users they created and only inside their own branch.

**Cost and profit are hidden by default.** A branch admin sees their sales,
their stock at their own selling prices, and their finances — but not the
**production cost**, and not their profit.

A branch does see the **wholesale price** on every dispatch and receipt. It has
to: that is what it is charged and what its dues are built from. "Cost is
hidden" means the factory cost, never the price the branch itself pays.

**The super admin can grant it.** If the super admin allows a branch admin to
see profit, that branch admin can then see their own branch's profit and their
remaining stock valued at cost. Never another branch's.

Permissions are already granted **per screen and per button**, so this is a
setting, not a code change.

---

## 12. The dashboards

Two dashboards, the second a scoped version of the first.

### The super admin dashboard — the whole company

This is the first screen of the day, and it is an **organisation intelligence
dashboard** — **charts and figures together**, every branch on one page, built so
that looking at it tells you how the business is doing rather than how many rows
are in a table. The charts carry the shape; the figures carry the precision.
Neither alone is enough.

| Panel | What it answers |
|---|---|
| **Sales** | Today, this month, this month against last, each branch against the others, and a twelve-month trend |
| **Profit** | Company profit (`selling − production cost`) and each branch's profit (`selling − wholesale − expenses`), side by side |
| **Stock** | Value per branch at wholesale and at that branch's selling price; warehouse raw and ready; what is running low |
| **Branch dues** | What each branch owes, what it has remitted, how old the balance is — money sitting out on the network |
| **Receivables** | Credit customers per branch, aged, worst first |
| **Production** | Output by day and month, pieces per worker, damage rate, what is sitting in WIP |
| **Warranty** | Claims open, by branch and by model — a model spiking here is a manufacturing problem |
| **Repairs** | Lab revenue per branch |
| **E-Store** | Online orders shipped, by branch and by model; what is waiting to be accepted |
| **Movers** | What sells and what has not moved in ninety days |

### The branch dashboard — one branch

**Figures only — no charts.** A branch needs to know where it stands today, not
to analyse itself: its sales, its stock at its own selling prices, its expenses
this month, its cash and bank, its credit customers, and what it owes the
warehouse. Profit appears only where the super admin has granted it (§11).

Visualisation is a head-office tool, because only head office can see enough to
compare.

### Rules for both

1. **Every figure is clickable** through to the list behind it. A number you
   cannot open is a number you cannot trust.
2. **Every panel obeys the page's date filter** (§10).
3. **Nothing on a branch dashboard reveals another branch** — not in a total, not
   in a comparison, not in a chart axis.
4. **Cost-derived figures stay hidden** unless the viewer is allowed cost (§11).

---

## 13. The chart of accounts

Every amount lands in exactly one **account**. Three levels decide how it is
grouped and reported.

### Level 1 — Head

| Code | Head | Meaning | Normal balance |
|---|---|---|---|
| 1 | Assets | What the business owns or is owed | Debit |
| 2 | Liabilities | What the business owes | Credit |
| 3 | Equity | The owner's stake | Credit |
| 4 | Revenue | What the business earns | Credit |
| 5 | Expenses | What the business spends | Debit |

Balance Sheet = heads 1, 2, 3. Income Statement = heads 4, 5.

### Level 2 — Sub-head

```
1 Assets
  ├── 101 Current Assets        cash, stock, money owed to you
  └── 102 Fixed Assets          machinery, vehicles, furniture
5 Expenses
  ├── 501 Cost of Sales         costs that move with sales volume
  └── 502 Operating Expenses    costs you pay regardless
```

Separating Cost of Sales from Operating Expenses is what lets you see **gross
margin** — profit before the rent and the electricity — instead of only the
final number.

### Level 3 — Account (the only postable level)

A grouping tier called the **third code** keeps accounts that will grow in number
apart from each other:

```
1 / 101 Current Assets
  ├── group 01  Cash & bank        cash in hand and bank, per branch
  ├── group 02  Receivables        credit customers, per branch
  ├── group 03  Advances           advances to suppliers
  ├── group 04  Inventory          raw, work in progress, ready, branch stock
  └── group 05  Inter-branch       one account per branch (§6)
```

### How a code is built

```
account_id = head × 1,000,000 + sub-head × 10,000 + group × 100 + sequence

1010402 = head 1 (Asset) / sub-head 01 (Current) / group 04 (Inventory) / #02
          → Inventory — Finished Goods
```

Codes are **allocated by the system, never typed in.** Each group holds 99
accounts; when one fills, the system refuses with a clear message rather than
spilling into the next group and silently misclassifying an account.

### Parties get their own accounts

Each party needs its own running balance, so creating one mints an account:

| Party | Head | Meaning |
|---|---|---|
| Credit customer | Asset — receivable | They owe the branch |
| Production worker | — | A piece count, not an account. There is no pay system (§4) |
| Supplier | Liability — payable | The warehouse owes them |
| Employee | Expense — wages | Salary cost |
| Branch | Asset / inter-branch | What the branch owes the warehouse |

You never create these by hand. Add the customer, and the account appears.

### System accounts

Around 40 accounts are marked *System*. The software references those codes
directly — a sale always credits Sales Revenue. You can **rename** them to your
own language, but they cannot be renumbered or deleted, because every historical
entry points at the number.

---

## 14. Rules the system enforces

These are not preferences. The software refuses to proceed when they are broken.

1. **Every voucher balances.** Debits must equal credits, or it is rejected
   before anything is written.
2. **Money is never a floating-point number.** All amounts are exact decimals
   end to end, so nothing drifts by a paisa.
3. **Nothing is half-recorded.** An invoice, its lines and its ledger entries
   commit together or not at all.
4. **Editing does not erase.** Changing a posted document writes a reversal and
   a new entry, so the original stays visible. *This is a deliberate change from
   the old shop app, which deleted bills and quietly restored stock.*
5. **Cost is never typed at the till.** Every cost is read from the record that
   set it — branch cost from the dispatch line's wholesale price, company cost
   from the production run. The **selling price** is the branch's to set, and
   discounts are recorded as discounts, never as a changed cost.
6. **Stock only moves through a documented movement.** Nothing enters or leaves
   a branch without a dispatch, a receipt, a sale, a return or a claim behind
   it.
7. **Deleting is refused when something depends on it.** You cannot remove a
   branch with sales against it, or a brand still used by products.
8. **A branch cannot see another branch.** Enforced in the data layer, not by
   hiding a menu.

---

## 15. Decisions already made

| Decision | Consequence |
|---|---|
| Start with fresh books | No legacy data; the old `.mdf` is not migrated |
| PostgreSQL (Neon) | One live database for the whole company; migrations are the source of truth |
| REST API + React SPA | `api/` and `web/` stay fully separate projects |
| **Online only** | Every shop has reliable internet — no offline mode, no sync engine |
| **One company, many branches** | Internal transfers create no revenue |
| **Master catalog central** | Super admin owns model names; branches own prices and locations |
| **Branches create nothing, buy nothing locally** | Every product, battery or not, is dispatched by the warehouse |
| **A recipe suggests, it does not refuse** | Cell counts pre-fill; actual issue and consumption is what is costed |
| **No pay system, for now** | The software counts worker pieces; what they are paid is settled outside it |
| **Invoice numbers are branch-prefixed** | `MUL-1`, `MUL-2` — each branch runs its own counter |
| **The word "khata" is not used** | On screen it is Credit Customer, Credit Sale, Customer Statement |
| **Charts are head-office only** | Super admin gets charts and figures; branches get figures (§12) |
| **The product table splits** | One master `product`, plus a `branch_product` row per branch for price, location and threshold (§3) |
| **The warehouse is a branch row, flagged** | So transfers, stock and reports reuse everything already built |
| **Warranty is free to the branch** | The damaged battery it sent back is the payment (§8) |
| **A Lab repair creates no stock** | The battery is the customer's and goes back to him; parts out, money in (§9) |
| **A claimed battery returns to the branch that claimed it** | Repaired where possible; a new battery when it cannot be (§8) |
| **The warehouse assesses every claim** | Repairable or not is a recorded outcome, reported separately (§8) |
| **A repaired battery is graded Repaired** | A grade separate from Type; never resold as new, and dispatched straight to a branch (§4) |
| **Users cascade** | Super admin creates warehouse and branch admins; a branch admin creates its own salesmen (§11) |
| **The E-Store is a channel, not a place** | Nothing is held in E-Store stock; the E-Store manager routes each order to a nearby branch (§7) |
| **An E-Store shipment is not a branch sale** | It moves at wholesale and only reduces that branch's stock and dues (§7) |
| **Expenses are per branch, per month** | Branch profit is after its own rent, electricity and food |
| **Every list filters, every export follows the filter** | Date range and month on nearly every screen |
| **Two prices per dispatch** | Wholesale to the branch, production cost for the company |
| Branch-scoped data | A branch sees itself; the super admin sees all |
| Permissions per screen and per button | Profit visibility is a grant, not a rebuild |
| **Excel import and export stays** | It is how stock and customers get loaded — keep it everywhere |
| Internal system only | No storefront, cart, checkout or online payments |

---

## 16. What is already built — and what it is not

`api/` and `web/` are **not** a rewrite of the three Python apps. They are a
careful reconstruction of a *different* legacy system — an ASP.NET / SQL Server
application whose schema lived only inside `7STARBATTERYPOS.mdf`. Its tables came
from 58 C# model classes; its menu ids were lifted verbatim from the old
`_Layout.cshtml`.

That matters, because the engineering underneath is good and the business model
sitting on top of it is somebody else's.

### Keep — solid, and nothing in this document changes it

| Part | Why it stays |
|---|---|
| Posting engine, balanced vouchers | Enforces §14.1. Four real accounting defects already found and fixed |
| Money as exact decimals | §14.2, tested |
| Auth, RBAC — head → form → action, branch scoping | §11 is configuration on top of this, not a rebuild |
| Chart of accounts, atomic code allocation | §13 as written |
| `stock_movement` view — one signed row per movement | Exactly the right shape; every new document type extends it |
| Reports, printing, Excel export | Working, and §15 keeps Excel |
| Hold Sale — the `lease_sale` module | A parked basket that posts nothing to the ledger and converts through the normal sale path. Right in every respect except its name; rename it to `hold_sale` |
| 142 passing tests | The safety net for everything below |

### Change — the business model on top must be reshaped

| This document says | The code today |
|---|---|
| One master catalog; branch sets price and location (§3) | `product.branch_id` — every branch gets its own product rows. No shared model identity |
| Wholesale price per dispatch, plus production cost (§5) | `product.price` — one cost per row, driving COGS everywhere |
| Issue to a named worker, WIP, Used / Damaged / Ready, rework (§4) | `production` is a single header with labour and material cost. No worker, no WIP, no damage, no rework |
| Complete Sets, and cells with type and specifications (§4) | `raw_product` is a flat name-and-price list |
| Warranty hold, claim order, repair, return to the claiming branch (§8) | Nothing. No warranty tables exist |
| E-Store shipment, raised by a branch and accepted by the warehouse (§7) | Nothing. No online channel of any kind |
| Branch expenses by month, by category (§10) | No expense table — expenses exist only as journal vouchers |
| Worker piece account (§4) | No worker table |
| Branch-prefixed invoice numbers, `MUL-1` (§7) | A plain integer id per document |
| Intelligence dashboard (§12) | Four count tiles and a setup checklist. No charting library in `web/` at all |
| Demand order → approve → dispatch → confirm (§5) | `demand_order → do_request → do_received` — a genuine match. Needs wholesale pricing and the inter-branch balance |
| Walk-in and credit customers (§7) | `customer` + `sale_customer` — a genuine match |
| Lab repair, per-branch price and description (§9) | `lab_received / lab / lab_used` — the closest existing match, needs reshaping |

### Remove

The legacy leftovers `province`, `city` and `department` — none of them appear in
this business. `product.image_path` stores image bytes inside the database and
should move to file storage.

**Not `lease_sale`.** An earlier reading of this audit had it removed as a
leftover. It is not one — it is Hold Sale, listed in Keep above.

---

## 17. Still open

### Waiting on you

1. **FCC.** The old apps listed a branch called FCC, and it is not on the
   website. Is it still open, and what is its real name?
2. **Gujranwala** is on the website but was not in the old apps. Confirm it is
   live and takes stock like the others.
3. **Dashboard priorities.** §12 lists nine panels. Which three belong at the
   top of the super admin screen?
4. **Does the warranty customer wait?** §8 has the branch handing over a
   replacement from its own stock *immediately*, which is what you said first —
   so the unit coming back from the warehouse restores branch stock rather than
   going to that particular customer. Your latest wording ("branch will give to
   customer") could instead mean the customer waits for the warehouse to decide.
   Both are buildable; they differ in whether branch stock moves on the day of
   the claim. Which is it — and if it is "instantly", what happens when the
   branch has none of that model on the shelf?
5. **Opening balances** — the starting numbers on day one, before a single sale
   is entered: cash in the drawer, money in the bank, stock already on the
   shelves, what credit customers already owe you, what you owe suppliers.
   Without them the first reports are wrong, because the books would start from
   zero when the business does not. **There is no screen for entering them yet** —
   an earlier draft of this file said there was. Building it is the last phase of
   work before go-live; what is needed from you is the figures, and whether you
   want them all at once or branch by branch as each one goes live.

### The one assumption carrying real risk

6. **When does a branch's debt actually start?** §6 says the moment stock is
   dispatched, at wholesale value. You said the branch "will give money as they
   sell", which can also mean the stock stays the warehouse's until it is sold
   and the branch owes nothing for what is still on the shelf.

   The difference is not small. On dispatch-time debt, branch stock is the
   branch's asset and its dues are large and visible. On sell-time debt, unsold
   branch stock is still warehouse inventory and a branch owes only for what it
   has actually sold.

   **Decided (Phase 5): debt starts on confirmed receipt, at wholesale value.**
   A branch answers for what it holds, not for what it has sold. Stock in transit
   is nobody's debt; shortages and transit damage recorded at receipt never
   become one. §6 already reads this way and it matches the Ready Stock app's
   invoice-with-dues shape.

### About the E-Store (§7)

7. **Does `7starbattery.pk` push its orders into this system, or does the branch
   type the order reference by hand?** §7 works either way — a branch recording
   a shipment needs nothing from the website. But if the site can send orders in,
   the E-Store manager's screen becomes a live order list instead of data entry,
   which is considerably better. What is the website built on?
8. **Can the same order be shipped twice?** If two branches record a shipment
   against one order reference, the second should be refused. That needs the
   order reference to be unique and known — straightforward if orders are fed
   in, and worth a duplicate warning if they are typed.

### Gaps found reading this as a build specification

These have sensible defaults, noted after each, so none of them blocks a start.

9. **Which cost, when a model arrives twice at different prices?** Multan
   receives a model at Rs 3,000 in January and Rs 3,200 in March, then sells one
   in April. Default: **weighted average** per branch per model — simple to
   explain, stable, and it does not require tracking which physical unit sold.
10. **Are batteries tracked by serial number?** §8 assumes a specific faulty unit
    can be identified and traced. Default: **no serials**, warranty claims by
    model and quantity. If you do track serials, say so now — retrofitting it
    later is expensive.
11. **Sales tax.** Your supplier records carry NTN and STRN, which suggests tax
    registration. Default: **no tax on invoices** until you say otherwise.
12. **An ordinary return, not a warranty.** A customer simply brings a battery
    back. §8 covers warranty only. Default: a sale return that restocks the
    branch, refunds a walk-in, or reduces a credit customer's balance — the
    behaviour the old shop app already had.
13. **Is there a price floor?** A branch sets its selling price, and a salesman
    may discount at the till. Default: **a minimum price per branch per item**,
    below which the sale is refused.
14. **Grade and type are not the same field.** Type is *New / Branded / Charger
    / Storage*; grade is *New / Repaired*. §4 introduced a repaired unit as
    "graded Other", which muddles the two. Default: **keep them separate**, so a
    repaired branded battery is still Branded, and still shows as Repaired.
15. **Branch to branch directly.** §1 says all branch stock comes from the
    warehouse. Default: **direct branch-to-branch transfer is refused** — if
    Multan has spare stock Faisalabad needs, it returns to the warehouse first,
    so the inter-branch accounts stay simple.
16. **Company cost for goods the warehouse buys rather than makes.** §3 has the
    warehouse buying chargers and accessories in and dispatching them like
    batteries, but §4's production cost has no meaning for them. Default: **the
    purchase cost stands in for production cost** on a bought-in item, so every
    dispatch line and every warranty replacement has a company cost to read.

---

*Updated as decisions are made. If something here is wrong, say so — it is
easier to change a line in this file than a system built on it.*
