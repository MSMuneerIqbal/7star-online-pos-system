# Chart of Accounts & Posting Rules

Recovered from the legacy ASP.NET controllers. Every code below appears as a
**magic number literal** in C# — none of it was configuration. The Node rewrite
should load these from a single `accounts.config.ts` rather than inlining them.

> Verify all codes against the seeded `Account` rows in the `.mdf` before relying
> on this. The names are inferred from usage context and posting direction, not
> from a documented account list.

---

## 1. Fixed posting accounts

| Code | Inferred name | Used by | Normal side |
|---|---|---|---|
| `1010101` | Cash in hand | Sale (receipt), Purchase (payment), CRV, CPV | Dr on receipt |
| `1010102` | Bank | BRV / BPV (referenced in FinalAccountController) | Dr on receipt |
| `1010401` | Inventory — raw / stock | Purchase, Branch Transfer, DO Received | Dr on inward |
| `1010402` | Inventory — finished goods | Sale, Sale Return | Cr on issue |
| `4010101` | Sales revenue | Sale, Sale Return | Cr |
| `4010102` | Service income | Sale (service charge) | Cr |
| `4020101` | Discount — **overloaded, see §4** | Sale, Purchase | both |
| `5010101` | Cost of goods sold | Sale, Sale Return | Dr |
| `5020201` | Freight / cargo expense inward | DO Received, DO Finish Received | Dr |

## 2. Dynamically allocated account ranges

Party accounts are minted on party creation by taking `MAX(AccountId) + 1`
within a `(HeadId, SubHeadId, Third)` bucket:

| Party | Base | Bucket | Source |
|---|---|---|---|
| Customer | `1010200` | Head 1 / SubHead 1 / Third 2 | `CustomerController.cs:31` |
| Supplier | `2010100` | Head 2 / SubHead 3 / Third 5 | `SupplierController.cs:36` |
| Employee | `5020100` | Head 5 / SubHead 7 / Third 9 | `EmployeeController.cs:33` |

`1010201` — the first customer account — is the reserved **walk-in / cash
customer**. `SaleController.cs:93` special-cases `CustId == 1 && account == 1010201`
to capture ad-hoc name/phone/address into `sale_customer`.

> **Race condition.** `MAX(AccountId)+1` is not atomic. Two parties created
> concurrently receive the same account code, silently merging two ledgers.
> Replace with a PostgreSQL sequence per bucket.

## 3. Voucher types (`vtype`)

`SINV` sale · `SRINV` sale return · `PINV` purchase · `PRINV` purchase return
· `CRV` cash receipt · `CPV` cash payment · `BRV` bank receipt · `BPV` bank
payment · `JV` journal

Note the returns use `SRINV` / `PRINV`, **not** `SRET` / `PRET`.

## 4. Known defects to fix, not port

### 4.1 The Sale posting does not balance — **critical**

`SaleController.cs:206-247` writes:

| Account | Dr | Cr |
|---|---|---|
| `1010402` Inventory | | cgs |
| `4010101` Sales | | net_total |
| `5010101` COGS | cgs | |
| customer receivable | net_total | |
| `4010102` Service (if > 0) | | service |
| `4020101` Discount (if > 0) | discount | |

`cgs` and `net_total` appear once on each side and cancel, leaving

```
Dr − Cr = discount − service
```

so any sale where discount ≠ service writes an unbalanced voucher. The root
cause is crediting Sales at **net_total** instead of **gross_total**.

Correct entry:

```
Dr  customer receivable   net_total
Dr  4020101 discount      discount
    Cr  4010101 sales                 gross_total
    Cr  4010102 service               service
Dr  5010101 COGS          cgs
    Cr  1010402 inventory             cgs
```

**Sale Return, Purchase and Purchase Return all balance correctly** — the defect
is specific to `SINV`. Quantify the exposure before migrating:

```sql
SELECT vtype, trans_id, SUM(dr) - SUM(cr) AS imbalance
FROM   transactions
GROUP  BY vtype, trans_id
HAVING SUM(dr) <> SUM(cr)
ORDER  BY abs(SUM(dr) - SUM(cr)) DESC;
```

### 4.2 `4020101` serves two opposite purposes

Debited as sales discount (contra-revenue) in `SaleController.cs:245`, credited
as purchase discount (other income) in `PurchaseController.cs:127`. The two net
against each other and neither figure is recoverable from the ledger. Split into
separate accounts — e.g. `4020101` sales discount, `4030101` purchase discount.

### 4.3 Non-atomic voucher IDs

`SELECT ISNULL(MAX(TransId),0)+1 FROM Transactions` (`SaleController.cs:199`)
races under concurrent posting; two vouchers can share a `trans_id`, which makes
them indistinguishable in any ledger report. Use the sequences defined in
`schema.sql`.

### 4.4 No transaction boundary

`Sale.Save` performs several `SaveChanges()` calls plus six raw inserts with no
enclosing DB transaction. A failure midway leaves a partially posted invoice —
inventory issued with no revenue recorded, or a header with no legs. Every
posting operation in the rewrite must run inside a single transaction.

### 4.5 Inter-branch transfers post nothing that balances — **critical**

Worse than §4.1, because the imbalance is total rather than partial.

`BranchTransferController.cs:145` posts **one leg**:

| Account | Dr | Cr |
|---|---|---|
| `1010401` Inventory | | value |

`DoReceivedController.cs:98-104` posts **two debits and no credit**:

| Account | Dr | Cr |
|---|---|---|
| `1010401` Inventory | value | |
| `5020201` Freight | cargo | |

So a despatch is short by the full value of the goods, and a receipt is over by
value + cargo. The freight debit has **no counterparty at all** — every receipt
inflates total assets by the cargo cost, permanently.

The two vouchers roughly offset on the inventory line across branches, which is
presumably why it went unnoticed, but neither balances individually and the
freight never nets against anything.

**Fix:** a new inter-branch clearing account, `1010501`. Stock moving between
branches is one economic event split across two vouchers at two locations; the
clearing account carries the in-transit value.

```
Despatching branch:
Dr  1010501 inter-branch clearing   value
    Cr  inventory                              value

Receiving branch:
Dr  inventory                       value
    Cr  1010501 inter-branch clearing          value
Dr  5020201 freight                 cargo
    Cr  1010101 cash                           cargo
```

Both vouchers balance, and `1010501` nets to zero once a transfer is received —
so a non-zero balance on it is a useful report: stock in transit.

Note freight here is **expensed**, not capitalised into stock value as it is on
a purchase (§ purchase rules). An internal movement should not increase the
carrying value of the goods, or the same battery would get more expensive every
time it moved between branches.

### 4.6 Production manufactures assets from nothing — **critical**

`ProductionController.cs:167` posts **one leg**:

| Account | Dr | Cr |
|---|---|---|
| `1010402` Inventory — Finished | total_cost | |

That is the whole entry. No credit anywhere, so:

- raw materials are **never removed** from stock, and
- labour, electricity and other conversion costs are **never funded**.

Every production run therefore inflated total assets by the full cost of the
goods produced, on top of leaving the consumed raw material on the books.

**Fix:**

```
Dr  1010402 inventory (finished)   material + conversion
    Cr  1010401 inventory (raw)                material consumed
    Cr  1010101 cash (or accrual)              conversion cost
```

The rule also asserts `material + labour + electricity + other = total_cost`
before posting, so a miscalculated form is rejected rather than silently
capitalised at the wrong value.

---

## 5. Why the reports were never built

The menu links `TrialBalance`, `BalanceSheet`, `IncomeStatement` and `CashBook`,
but no such controllers exist. Given §4.1, a trial balance would not have tied
out. Fixing the posting rules is a prerequisite for building them — and the
historical `transactions` rows need correcting entries before any statement
covering past periods will balance.
