# Working principles

Decisions already made, and the rules the system enforces. This is the shared
reference for the discussion about your organisation's real structure — when we
change something, we change it here first.

---

## 1. The chart of accounts — what the three levels are for

Every amount the system records lands in exactly one **account**. The three
levels are how those accounts are organised, and the level decides how a figure
is grouped and reported.

### Level 1 — Head (5 of them)

The five classifications every set of books has. These answer *"what kind of
thing is this?"*

| Code | Head | Meaning | Normal balance |
|---|---|---|---|
| 1 | Assets | What the business owns or is owed | Debit |
| 2 | Liabilities | What the business owes | Credit |
| 3 | Equity | The owner's stake | Credit |
| 4 | Revenue | What the business earns | Credit |
| 5 | Expenses | What the business spends | Debit |

The head drives the financial statements:

- **Balance Sheet** = heads 1, 2, 3
- **Income Statement** = heads 4, 5
- **Normal balance** decides which way a balance is displayed. Assets and
  expenses are debit-normal; the rest are credit-normal.

You will rarely add a head. Almost every chart in the world uses these five.

### Level 2 — Sub-head

Divides a head into meaningful sections. This answers *"whereabouts in that
category?"*

```
1 Assets
  ├── 101 Current Assets        cash, stock, money customers owe you
  └── 102 Fixed Assets          machinery, vehicles, furniture
5 Expenses
  ├── 501 Cost of Sales         costs that move with sales volume
  └── 502 Operating Expenses    costs you pay regardless
```

The split matters because it changes what your statements tell you. Separating
Cost of Sales from Operating Expenses is what lets you see **gross margin** —
profit before overheads — instead of only the final number.

### Level 3 — Account (the postable one)

The actual account a transaction hits. **Only level 3 can be posted to.**

There is a grouping tier inside level 3, called the **third code**, which exists
so accounts that will grow in number stay separated:

```
1 / 101 Current Assets
  ├── group 01  Cash & bank        1010101 Cash in Hand, 1010102 Bank
  ├── group 02  Receivables        1010201 Walk-in, then every customer
  ├── group 03  Advances           1010301 Advances to Suppliers
  ├── group 04  Inventory          1010401 Raw, 1010402 Finished
  └── group 05  Inter-branch       1010501 Inter-Branch Clearing
```

### How a code is built

```
account_id = head × 1,000,000  +  sub-head × 10,000  +  group × 100  +  sequence

1010402  =  head 1 (Asset) / sub-head 01 (Current) / group 04 (Inventory) / #02
            → Inventory — Finished Goods
```

Codes are **allocated by the system, never typed in**. Each group holds 99
accounts; when one fills, the system refuses with a clear message rather than
spilling into the next group and silently mis-classifying an account.

### Why customers, vendors and employees get their own accounts

Each party needs its own running balance — what this customer owes, what you owe
that supplier. So creating one mints an account in the right group:

| Party | Range | Meaning |
|---|---|---|
| Customer | 1010202 onward | Asset — they owe you |
| Vendor | 2010102 onward | Liability — you owe them |
| Employee | 5020102 onward | Expense — salary cost |

You never create these by hand. Add the customer, and the account appears.

### Accounts marked **System**

Roughly 40 accounts are marked *System* in the Final Account screen. The
software references those codes directly — a sale always credits `4010101`
Sales Revenue. You can **rename** them to suit your language, but they cannot be
renumbered or deleted, because every historical entry points at the number.

---

## 2. Accounting rules the system enforces

These are not preferences; the software refuses to proceed when they are broken.

1. **Every voucher balances.** Debits must equal credits, or it is rejected
   before anything is written. There is no way to save an unbalanced entry.
2. **Money is never a floating-point number.** All amounts are exact decimals
   end to end, so nothing drifts by a paisa.
3. **Nothing is half-recorded.** An invoice, its line items and its ledger
   entries commit together or not at all.
4. **Editing does not erase.** Changing a posted document writes a reversal and
   a new entry, so the original stays visible for audit.
5. **Costs come from the catalog, never the browser.** Cost of sales, transfer
   values and production material costs are always read from the item record.
6. **Deleting is refused when something depends on it.** You cannot remove a
   branch with sales against it, or a brand still used by products.

---

## 3. Decisions already made

| Decision | Consequence |
|---|---|
| Start with fresh books | No legacy data, no historical corrections needed |
| PostgreSQL (Neon) | Live database; migrations are the source of truth for schema |
| REST API + React SPA | `api/` and `web/` stay fully separate projects |
| Branch-scoped data | Users see their own branch; super admins see all |
| Permissions per screen and per button | Head → screen → action, granted per role |
| Internal system only | No storefront, cart, checkout or online payments |

---

## 4. What is built

All modules are complete and working: registration (branch, brand, category, raw
item, product, customer, vendor, employee), sales and purchases with returns and
hold sales, inter-branch transfers, production, lab, the full chart of accounts,
five voucher types, ledger, ten reports including Trial Balance and Balance
Sheet, user management, and printing.

**142 automated tests pass.** Every voucher in the database balances.

---

## 5. Open — to settle in our discussion

These need your input, not a technical decision:

1. **Branches** — how many, where, and what each one does (sells? manufactures?
   stores stock? all three?).
2. **Chart of accounts** — the 40 shipped accounts are a sensible default. Which
   do you actually use, what should they be called, and what is missing? Real
   examples: separate accounts per bank, per expense type, per vehicle.
3. **Products and raw materials** — the real catalog, with cost and sale prices.
4. **Roles** — who does what. Which staff should see costs and margins, and
   which should only be able to record a sale?
5. **Opening balances** — starting cash, bank balances, stock on hand, and any
   amounts customers already owe you or you owe suppliers.
6. **Numbering** — do invoices need to continue from your existing numbers?
7. **Lab workflow** — the current design was inferred, not specified. Walk me
   through how a repair actually moves through your shop.
8. **Production** — what a run looks like in practice: which raw materials, what
   labour cost, how output is measured.

---

*Updated as decisions are made. If something here is wrong, say so — it is
easier to change a line in this file than a system built on it.*
