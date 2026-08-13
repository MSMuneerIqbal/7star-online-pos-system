-- Up Migration
--
-- PHASE 2 — document numbering. (PLAN.md Phase 2, SPECS §2.x)
--
-- WHY THIS EXISTS
-- Every document in the legacy system was identified by its raw database id,
-- so "invoice 4" could be Multan's fourth sale OR Faisalabad's fourth sale and
-- nobody could tell which. A branch-prefixed number (`MUL-1`, `MUL-C-1`,
-- `MUL-SR-1`) makes each document self-describing and gives the owner what a
-- customer sees on a printed docket.
--
-- The number is a real column on each document table, generated inside the same
-- transaction that creates the document, under a `SELECT ... FOR UPDATE` row
-- lock on `document_counter` — so two concurrent sales at one branch get
-- consecutive numbers with no gap and no duplicate (PLAN.md).
--
-- Doc-type -> code map (production takes `PRD`, not `PR`, so it does not
-- collide with Purchase Return's `PR`):
--
--   SALE_WALKIN     {BRANCH}-{n}       MUL-1
--   SALE_CREDIT     {BRANCH}-C-{n}     MUL-C-1
--   SALE_RETURN     {BRANCH}-SR-{n}    MUL-SR-1
--   PURCHASE        {BRANCH}-PI-{n}    MUL-PI-1
--   PURCHASE_RETURN {BRANCH}-PR-{n}    MUL-PR-1
--   HOLD_SALE       {BRANCH}-H-{n}     MUL-H-1
--   PRODUCTION      {BRANCH}-PRD-{n}   MUL-PRD-1
--   DEMAND_ORDER    {BRANCH}-DO-{n}    MUL-DO-1
--   LAB             {BRANCH}-LB-{n}    MUL-LB-1
--   LAB_RECEIVED    {BRANCH}-LR-{n}    MUL-LR-1
--
-- NOT numbered here: do_request / do_received (the demand-order despatch and
-- receipt legs). Those are the pre-Phase-5 placeholder for dispatch, which
-- Phase 5 will likely rework; numbering them now risks a throwaway scheme.

-- =============================================================================
-- 1. The counter — one row per real branch x doc type
-- =============================================================================

CREATE TABLE document_counter (
    branch_id    integer NOT NULL REFERENCES branch(id),
    doc_type     text    NOT NULL,
    next_number  integer NOT NULL DEFAULT 1,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (branch_id, doc_type)
);

-- =============================================================================
-- 2. A number column on every document table
-- =============================================================================

ALTER TABLE sale            ADD COLUMN doc_number text;
ALTER TABLE sale_return     ADD COLUMN doc_number text;
ALTER TABLE purchase        ADD COLUMN doc_number text;
ALTER TABLE purchase_return ADD COLUMN doc_number text;
ALTER TABLE hold_sale       ADD COLUMN doc_number text;
ALTER TABLE production      ADD COLUMN doc_number text;
ALTER TABLE demand_order    ADD COLUMN doc_number text;
ALTER TABLE lab             ADD COLUMN doc_number text;
ALTER TABLE lab_received    ADD COLUMN doc_number text;

-- =============================================================================
-- 3. Backfill the rows that already exist
--
-- row_number() over the same partition the counter advances on, ordered by id,
-- so the oldest document gets the lowest number. Correct for any row count,
-- not just empty tables. sale splits its series on cust_id = 1 (walk-in vs
-- credit share one column but are two independent sequences).
-- =============================================================================

UPDATE sale s
SET doc_number = b.code || CASE WHEN v.cust_id = 1 THEN '' ELSE '-C' END || '-' || v.rn::text
FROM (
    SELECT id, branch_id, cust_id,
           row_number() OVER (PARTITION BY branch_id, (cust_id = 1) ORDER BY id) AS rn
    FROM sale
) v
JOIN branch b ON b.id = v.branch_id
WHERE s.id = v.id;

UPDATE sale_return sr
SET doc_number = b.code || '-SR-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM sale_return
) v
JOIN branch b ON b.id = v.branch_id
WHERE sr.id = v.id;

UPDATE purchase p
SET doc_number = b.code || '-PI-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM purchase
) v
JOIN branch b ON b.id = v.branch_id
WHERE p.id = v.id;

UPDATE purchase_return pr
SET doc_number = b.code || '-PR-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM purchase_return
) v
JOIN branch b ON b.id = v.branch_id
WHERE pr.id = v.id;

UPDATE hold_sale h
SET doc_number = b.code || '-H-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM hold_sale
) v
JOIN branch b ON b.id = v.branch_id
WHERE h.id = v.id;

UPDATE production prd
SET doc_number = b.code || '-PRD-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM production
) v
JOIN branch b ON b.id = v.branch_id
WHERE prd.id = v.id;

-- A demand order is numbered against the REQUESTING branch (to_branch).
UPDATE demand_order d
SET doc_number = b.code || '-DO-' || v.rn::text
FROM (
    SELECT id, to_branch,
           row_number() OVER (PARTITION BY to_branch ORDER BY id) AS rn
    FROM demand_order
) v
JOIN branch b ON b.id = v.to_branch
WHERE d.id = v.id;

UPDATE lab l
SET doc_number = b.code || '-LB-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM lab
) v
JOIN branch b ON b.id = v.branch_id
WHERE l.id = v.id;

UPDATE lab_received lr
SET doc_number = b.code || '-LR-' || v.rn::text
FROM (
    SELECT id, branch_id,
           row_number() OVER (PARTITION BY branch_id ORDER BY id) AS rn
    FROM lab_received
) v
JOIN branch b ON b.id = v.branch_id
WHERE lr.id = v.id;

-- =============================================================================
-- 4. Seed the counters, one row per real branch x doc type
-- =============================================================================

INSERT INTO document_counter (branch_id, doc_type)
SELECT b.id, t.doc_type
FROM branch b
CROSS JOIN (VALUES
    ('SALE_WALKIN'), ('SALE_CREDIT'), ('SALE_RETURN'),
    ('PURCHASE'), ('PURCHASE_RETURN'), ('HOLD_SALE'),
    ('PRODUCTION'), ('DEMAND_ORDER'), ('LAB'), ('LAB_RECEIVED')
) AS t(doc_type)
WHERE b.id > 0
ON CONFLICT (branch_id, doc_type) DO NOTHING;

-- =============================================================================
-- 5. Advance each counter past the backfilled rows
--
-- Its own explicit step because it is easy to forget, and forgetting it means
-- the first live document after migration collides with a backfilled one.
-- =============================================================================

UPDATE document_counter dc
SET next_number = v.next
FROM (
    SELECT branch_id, count(*) + 1 AS next
    FROM sale WHERE cust_id = 1 GROUP BY branch_id
) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'SALE_WALKIN';

UPDATE document_counter dc
SET next_number = v.next
FROM (
    SELECT branch_id, count(*) + 1 AS next
    FROM sale WHERE cust_id <> 1 GROUP BY branch_id
) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'SALE_CREDIT';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM sale_return     GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'SALE_RETURN';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM purchase        GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'PURCHASE';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM purchase_return GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'PURCHASE_RETURN';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM hold_sale       GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'HOLD_SALE';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM production      GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'PRODUCTION';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT to_branch AS branch_id, count(*) + 1 AS next FROM demand_order GROUP BY to_branch) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'DEMAND_ORDER';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM lab             GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'LAB';

UPDATE document_counter dc
SET next_number = v.next
FROM (SELECT branch_id, count(*) + 1 AS next FROM lab_received    GROUP BY branch_id) v
WHERE dc.branch_id = v.branch_id AND dc.doc_type = 'LAB_RECEIVED';

-- =============================================================================
-- 6. Lock the number in — a numbering bug should fail loudly at insert time
--    rather than linger as an unnumbered row.
-- =============================================================================

ALTER TABLE sale            ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE sale_return     ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE purchase        ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE purchase_return ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE hold_sale       ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE production      ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE demand_order    ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE lab             ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE lab_received    ALTER COLUMN doc_number SET NOT NULL;

CREATE UNIQUE INDEX idx_sale_doc_number            ON sale(branch_id, doc_number);
CREATE UNIQUE INDEX idx_sale_return_doc_number     ON sale_return(branch_id, doc_number);
CREATE UNIQUE INDEX idx_purchase_doc_number        ON purchase(branch_id, doc_number);
CREATE UNIQUE INDEX idx_purchase_return_doc_number ON purchase_return(branch_id, doc_number);
CREATE UNIQUE INDEX idx_hold_sale_doc_number       ON hold_sale(branch_id, doc_number);
CREATE UNIQUE INDEX idx_production_doc_number      ON production(branch_id, doc_number);
CREATE UNIQUE INDEX idx_demand_order_doc_number    ON demand_order(to_branch, doc_number);
CREATE UNIQUE INDEX idx_lab_doc_number             ON lab(branch_id, doc_number);
CREATE UNIQUE INDEX idx_lab_received_doc_number    ON lab_received(branch_id, doc_number);

-- =============================================================================
-- 7. Fan-out — a branch created later still gets all ten counters.
--    Same shape as the catalog split's branch_product fan-out.
-- =============================================================================

CREATE FUNCTION document_counter_fanout_from_branch() RETURNS trigger
LANGUAGE plpgsql AS $fanout_branch$
BEGIN
    IF NEW.id = 0 OR NOT NEW.is_active THEN
        RETURN NEW;
    END IF;

    INSERT INTO document_counter (branch_id, doc_type)
    SELECT NEW.id, t.doc_type
    FROM (VALUES
        ('SALE_WALKIN'), ('SALE_CREDIT'), ('SALE_RETURN'),
        ('PURCHASE'), ('PURCHASE_RETURN'), ('HOLD_SALE'),
        ('PRODUCTION'), ('DEMAND_ORDER'), ('LAB'), ('LAB_RECEIVED')
    ) AS t(doc_type)
    ON CONFLICT (branch_id, doc_type) DO NOTHING;

    RETURN NEW;
END;
$fanout_branch$;

CREATE TRIGGER trg_document_counter_from_branch
    AFTER INSERT OR UPDATE OF is_active ON branch
    FOR EACH ROW EXECUTE FUNCTION document_counter_fanout_from_branch();

-- Down Migration
--
-- NOT a faithful inverse of the backfill, deliberately: the backfilled numbers
-- cannot be un-derive from the ids, so they are simply dropped along with the
-- column. The document rows themselves are untouched.

DROP TRIGGER IF EXISTS trg_document_counter_from_branch ON branch;
DROP FUNCTION IF EXISTS document_counter_fanout_from_branch();

ALTER TABLE sale            DROP COLUMN doc_number;
ALTER TABLE sale_return     DROP COLUMN doc_number;
ALTER TABLE purchase        DROP COLUMN doc_number;
ALTER TABLE purchase_return DROP COLUMN doc_number;
ALTER TABLE hold_sale       DROP COLUMN doc_number;
ALTER TABLE production      DROP COLUMN doc_number;
ALTER TABLE demand_order    DROP COLUMN doc_number;
ALTER TABLE lab             DROP COLUMN doc_number;
ALTER TABLE lab_received    DROP COLUMN doc_number;

DROP TABLE IF EXISTS document_counter;
