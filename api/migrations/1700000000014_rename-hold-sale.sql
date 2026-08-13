-- Up Migration
--
-- Phase 0 groundwork (PLAN.md) — lease_sale -> hold_sale.
--
-- Not a legacy leftover: this is Hold Sale, a parked basket with no ledger
-- impact (SPECS §8.3), already built the way the spec wants it. Both
-- PRINCIPLES §16 and SPECS §19 once listed it for removal; both were
-- corrected, and it is renamed rather than dropped. Nothing here changes
-- behaviour — same columns, same rows, same rules — only the name.
--
-- RENAME TO does not rename the table's own constraints, so each is renamed
-- explicitly to match (verified against the live database's actual names
-- before writing this).

ALTER TABLE lease_sale RENAME TO hold_sale;
ALTER TABLE hold_sale RENAME CONSTRAINT lease_sale_pkey TO hold_sale_pkey;
ALTER TABLE hold_sale RENAME CONSTRAINT lease_sale_branch_id_fkey TO hold_sale_branch_id_fkey;
ALTER TABLE hold_sale RENAME CONSTRAINT lease_sale_cust_id_fkey TO hold_sale_cust_id_fkey;

ALTER TABLE lease_sale_detail RENAME TO hold_sale_detail;
ALTER TABLE hold_sale_detail RENAME CONSTRAINT lease_sale_detail_pkey TO hold_sale_detail_pkey;
ALTER TABLE hold_sale_detail
    RENAME CONSTRAINT lease_sale_detail_sale_id_fkey TO hold_sale_detail_sale_id_fkey;
ALTER TABLE hold_sale_detail
    RENAME CONSTRAINT lease_sale_detail_pid_fkey TO hold_sale_detail_pid_fkey;

-- Down Migration
ALTER TABLE hold_sale_detail
    RENAME CONSTRAINT hold_sale_detail_pid_fkey TO lease_sale_detail_pid_fkey;
ALTER TABLE hold_sale_detail
    RENAME CONSTRAINT hold_sale_detail_sale_id_fkey TO lease_sale_detail_sale_id_fkey;
ALTER TABLE hold_sale_detail RENAME CONSTRAINT hold_sale_detail_pkey TO lease_sale_detail_pkey;
ALTER TABLE hold_sale_detail RENAME TO lease_sale_detail;

ALTER TABLE hold_sale RENAME CONSTRAINT hold_sale_cust_id_fkey TO lease_sale_cust_id_fkey;
ALTER TABLE hold_sale RENAME CONSTRAINT hold_sale_branch_id_fkey TO lease_sale_branch_id_fkey;
ALTER TABLE hold_sale RENAME CONSTRAINT hold_sale_pkey TO lease_sale_pkey;
ALTER TABLE hold_sale RENAME TO lease_sale;
