-- Up Migration
--
-- PHASE 5 — demand, dispatch, receipt. (PLAN.md Phase 5, SPECS §6, PRINCIPLES §5)
--
-- The `demand_order → do_request → do_received` chain is the old schema's
-- approximation of the real three-step handshake. This migration gives dispatch
-- its two prices and grade, and receipt its per-line short/damaged quantities,
-- plus the document numbers and the stock-loss account the reshaped flow needs.
--
--   dispatch line: wholesale_price (the branch's charge) + production_cost
--                  (warehouse-only) + grade (NEW/REPAIRED)
--   receipt line:  received_qty / short_qty / damaged_qty — the branch confirms
--                  what actually arrived; nothing enters branch stock until then
--
-- Debt is on confirmed receipt (PRINCIPLES §17.6, decided in Phase 5): the
-- branch owes the wholesale value of what arrived, never the short or damaged
-- units — their production cost becomes a company expense (stock loss).

-- =============================================================================
-- 1. Stock-loss account — where short/damaged transit value lands
-- =============================================================================

INSERT INTO account (name, account_id, head_id, sub_head_id, head_code, sub_code, third, is_fixed)
SELECT 'Stock Loss / Transit Damage', 5010103, 5, 8, 5, 1, 3, true
WHERE NOT EXISTS (SELECT 1 FROM account WHERE account_id = 5010103);

-- =============================================================================
-- 2. Dispatch — two prices and a grade on every line
-- =============================================================================

ALTER TABLE do_request
    ADD COLUMN doc_number text;

ALTER TABLE do_request_detail
    ADD COLUMN wholesale_price numeric(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN production_cost numeric(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN grade           text NOT NULL DEFAULT 'NEW';

ALTER TABLE do_request_detail
    ADD CONSTRAINT do_request_detail_grade_check CHECK (grade IN ('NEW', 'REPAIRED'));

-- =============================================================================
-- 3. Receipt — per-line received / short / damaged
-- =============================================================================

ALTER TABLE do_received
    ADD COLUMN doc_number text;

ALTER TABLE do_received_detail
    ADD COLUMN received_qty numeric(18,3) NOT NULL DEFAULT 0,
    ADD COLUMN short_qty    numeric(18,3) NOT NULL DEFAULT 0,
    ADD COLUMN damaged_qty  numeric(18,3) NOT NULL DEFAULT 0;

-- =============================================================================
-- 4. Number the rows that already exist (pre-Phase-5 placeholder data)
-- =============================================================================

UPDATE do_request d
SET doc_number = b.code || '-DP-' || v.rn::text
FROM (
    SELECT id, from_branch,
           row_number() OVER (PARTITION BY from_branch ORDER BY id) AS rn
    FROM do_request
) v
JOIN branch b ON b.id = v.from_branch
WHERE d.id = v.id;

UPDATE do_received r
SET doc_number = b.code || '-RC-' || v.rn::text
FROM (
    SELECT id, to_branch,
           row_number() OVER (PARTITION BY to_branch ORDER BY id) AS rn
    FROM do_received
) v
JOIN branch b ON b.id = v.to_branch
WHERE r.id = v.id;

ALTER TABLE do_request  ALTER COLUMN doc_number SET NOT NULL;
ALTER TABLE do_received ALTER COLUMN doc_number SET NOT NULL;

CREATE UNIQUE INDEX idx_do_request_doc_number  ON do_request(from_branch, doc_number);
CREATE UNIQUE INDEX idx_do_received_doc_number ON do_received(to_branch, doc_number);

-- =============================================================================
-- 5. Two new document counter types: DISPATCH (DP) and RECEIPT (RC)
-- =============================================================================

INSERT INTO document_counter (branch_id, doc_type)
SELECT b.id, t.doc_type
FROM branch b
CROSS JOIN (VALUES ('DISPATCH'), ('RECEIPT')) AS t(doc_type)
WHERE b.id > 0
ON CONFLICT (branch_id, doc_type) DO NOTHING;

-- Recreate the fan-out trigger so a branch created later gets all twelve types.
DROP TRIGGER IF EXISTS trg_document_counter_from_branch ON branch;
DROP FUNCTION IF EXISTS document_counter_fanout_from_branch();

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
        ('PRODUCTION'), ('DEMAND_ORDER'), ('LAB'), ('LAB_RECEIVED'),
        ('DISPATCH'), ('RECEIPT')
    ) AS t(doc_type)
    ON CONFLICT (branch_id, doc_type) DO NOTHING;

    RETURN NEW;
END;
$fanout_branch$;

CREATE TRIGGER trg_document_counter_from_branch
    AFTER INSERT OR UPDATE OF is_active ON branch
    FOR EACH ROW EXECUTE FUNCTION document_counter_fanout_from_branch();

-- Down Migration
DROP TRIGGER IF EXISTS trg_document_counter_from_branch ON branch;
DROP FUNCTION IF EXISTS document_counter_fanout_from_branch();

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

DELETE FROM document_counter WHERE doc_type IN ('DISPATCH', 'RECEIPT');
DELETE FROM account WHERE account_id = 5010103;

ALTER TABLE do_received_detail
    DROP COLUMN IF EXISTS damaged_qty,
    DROP COLUMN IF EXISTS short_qty,
    DROP COLUMN IF EXISTS received_qty;
ALTER TABLE do_received DROP COLUMN IF EXISTS doc_number;
ALTER TABLE do_request_detail
    DROP CONSTRAINT IF EXISTS do_request_detail_grade_check,
    DROP COLUMN IF EXISTS grade,
    DROP COLUMN IF EXISTS production_cost,
    DROP COLUMN IF EXISTS wholesale_price;
ALTER TABLE do_request DROP COLUMN IF EXISTS doc_number;
