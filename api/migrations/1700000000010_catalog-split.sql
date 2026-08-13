-- Up Migration
--
-- PHASE 1 — the catalog split.  (PLAN.md Phase 1, SPECS §3.4, PRINCIPLES §3)
--
-- WHY THIS EXISTS
-- `product.branch_id` gave every branch its own disconnected product rows, so
-- "Dell 5547" at Multan and "Dell 5547" at Faisalabad were different items with
-- no shared identity and no shared history. Nothing company-wide could be
-- reported, and every downstream feature — production, dispatch, warranty, the
-- E-Store — would inherit the same fracture.
--
-- It splits in two:
--
--   product         one row per model, company-wide, owned by the super admin.
--                   Identity is model + brand + type + placement, matched
--                   case-insensitively — the rule the old shop app already used
--                   for its Excel import.
--
--   branch_product  one row per product per branch, owned by that branch:
--                   selling price, minimum price, location, threshold, and the
--                   weighted-average wholesale cost Phase 5 will maintain.
--
-- GRADE IS DELIBERATELY ABSENT. New and Repaired describe a *unit*, not a
-- model. Grade travels on the stock movement and the dispatch line (Phase 4 and
-- Phase 5). Putting it here would force a repaired unit either to mutate the
-- master row — flipping every branch's stock to Repaired — or to spawn a
-- duplicate row the identity rule below would collapse straight back.

-- =============================================================================
-- 1. BRANCH — a code, a type, and the fields a printed document needs
-- =============================================================================

ALTER TABLE branch
    ADD COLUMN code          text,
    ADD COLUMN type          text        NOT NULL DEFAULT 'BRANCH',
    ADD COLUMN phone         text,
    ADD COLUMN opening_hours text,
    ADD COLUMN closing_day   text,
    ADD COLUMN is_active     boolean     NOT NULL DEFAULT true;

ALTER TABLE branch
    ADD CONSTRAINT branch_type_check CHECK (type IN ('BRANCH', 'WAREHOUSE'));

-- A branch that is already one of the seven real ones — by name — gets its real
-- code, not a placeholder. This is also what makes a down-then-up cycle safe:
-- after a rollback the seeded branches still exist, and this recognises them
-- instead of re-coding them and seeding a second set.
UPDATE branch b
SET    code = v.code,
       type = v.type
FROM  (VALUES
          ('Warehouse (Main)',  'WHS', 'WAREHOUSE'),
          ('Hall Road, Lahore', 'HR',  'BRANCH'),
          ('Hafeez Center',     'HC',  'BRANCH'),
          ('Multan',            'MUL', 'BRANCH'),
          ('Faisalabad',        'FSD', 'BRANCH'),
          ('Gujranwala',        'GUJ', 'BRANCH'),
          ('Rawalpindi',        'RWP', 'BRANCH')
      ) AS v(name, code, type)
WHERE  lower(b.name) = lower(v.name)
  AND  b.id > 0
  AND  b.code IS NULL;

-- Anything else real predates codes and gets a placeholder rather than a guess
-- at the owner's intent: a code prefixes every document a branch issues and is
-- immutable once used, so it is not something to invent on someone's behalf.
-- Branch 0 is the "All Branches" sentinel and never issues a document, so it
-- stays without a code.
UPDATE branch SET code = 'B' || id WHERE id > 0 AND code IS NULL;

-- Unique among real branches; the sentinel is exempt because it has no code.
CREATE UNIQUE INDEX idx_branch_code ON branch (upper(code)) WHERE id > 0;

ALTER TABLE branch
    ADD CONSTRAINT branch_code_required CHECK (id = 0 OR code IS NOT NULL);

-- "Exactly one warehouse" (SPECS §3.1) enforced where it cannot be forgotten.
CREATE UNIQUE INDEX idx_branch_one_warehouse ON branch ((type)) WHERE type = 'WAREHOUSE';

-- =============================================================================
-- 2. PRODUCT — the master row gains what identity needs
-- =============================================================================

ALTER TABLE product
    ADD COLUMN type         text    NOT NULL DEFAULT 'NEW',
    ADD COLUMN placement    text    NOT NULL DEFAULT 'INT',
    ADD COLUMN cell_type_id integer REFERENCES raw_product(id),
    ADD COLUMN cell_count   integer;

ALTER TABLE product
    ADD CONSTRAINT product_type_check
        CHECK (type IN ('NEW', 'BRANDED', 'CHARGER', 'STORAGE', 'OTHER')),
    ADD CONSTRAINT product_placement_check
        CHECK (placement IN ('INT', 'EXT')),
    ADD CONSTRAINT product_cell_count_check
        CHECK (cell_count IS NULL OR cell_count > 0);

COMMENT ON COLUMN product.name IS 'The model. "Dell 5547" — this is the identity.';
COMMENT ON COLUMN product.price IS
    'Company cost. Production cost for what the warehouse makes (Phase 4), '
    'purchase cost for what it buys in (PRINCIPLES §17.16). Never shown to a branch.';
COMMENT ON COLUMN product.cell_type_id IS
    'The SUGGESTED recipe. Pre-fills the production cart; never enforced (PRINCIPLES §4).';

-- =============================================================================
-- 3. BRANCH_PRODUCT — one row per product per branch
-- =============================================================================

CREATE TABLE branch_product (
    id                   integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    branch_id            integer NOT NULL REFERENCES branch(id),
    product_id           integer NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    selling_price        numeric(18,2) NOT NULL DEFAULT 0,
    minimum_price        numeric(18,2) NOT NULL DEFAULT 0,
    wholesale_cost       numeric(18,2) NOT NULL DEFAULT 0,
    location             text,
    low_stock_threshold  numeric(18,3) NOT NULL DEFAULT 0,
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    created_by           integer NOT NULL DEFAULT 0,
    updated_by           integer NOT NULL DEFAULT 0,
    CONSTRAINT branch_product_unique UNIQUE (branch_id, product_id),
    CONSTRAINT branch_product_real_branch CHECK (branch_id > 0)
);

CREATE INDEX idx_branch_product_branch  ON branch_product(branch_id);
CREATE INDEX idx_branch_product_product ON branch_product(product_id);

COMMENT ON COLUMN branch_product.wholesale_cost IS
    'Weighted average of what this branch has been charged. Written by confirmed '
    'receipt in Phase 5 — never typed at the till (PRINCIPLES §14.5).';
COMMENT ON COLUMN branch_product.minimum_price IS
    'The floor a salesman cannot discount below (PRINCIPLES §17.13).';

-- =============================================================================
-- 4. Carry the existing rows across
--
-- The identity rule collapses what used to be one row per branch into one
-- master row, keeping the lowest id as the survivor. Written to be correct for
-- any number of rows, not just the handful in the database today.
-- =============================================================================

CREATE TEMP TABLE product_merge ON COMMIT DROP AS
SELECT id AS old_id,
       min(id) OVER (
           PARTITION BY lower(coalesce(name, '')),
                        coalesce(brand_id, 0),
                        upper(type),
                        upper(placement)
       ) AS keep_id
FROM   product;

CREATE INDEX ON product_merge (old_id);

-- Each old per-branch row becomes that branch's price row. Where a branch
-- somehow held two rows of the same identity, the lower id wins — the same row
-- that survives as the master.
INSERT INTO branch_product (
    branch_id, product_id, selling_price, minimum_price, wholesale_cost,
    location, low_stock_threshold, is_active, created_by, updated_by
)
SELECT DISTINCT ON (p.branch_id, m.keep_id)
       p.branch_id,
       m.keep_id,
       p.sale_price,
       p.least_price,
       p.price,                              -- the branch's old cost figure
       nullif(p.shelf_number, 0)::text,
       p.reorder_level,
       p.is_active,
       p.created_by,
       p.updated_by
FROM   product p
JOIN   product_merge m ON m.old_id = p.id
WHERE  p.branch_id > 0                       -- branch 0 is the sentinel
ORDER  BY p.branch_id, m.keep_id, p.id;

-- Every row that pointed at a losing product id now points at the survivor.
UPDATE sale_detail d        SET pid = m.keep_id FROM product_merge m WHERE m.old_id = d.pid AND m.keep_id <> d.pid;
UPDATE sale_return_detail d SET pid = m.keep_id FROM product_merge m WHERE m.old_id = d.pid AND m.keep_id <> d.pid;
UPDATE lease_sale_detail d  SET pid = m.keep_id FROM product_merge m WHERE m.old_id = d.pid AND m.keep_id <> d.pid;
UPDATE production d         SET pid = m.keep_id FROM product_merge m WHERE m.old_id = d.pid AND m.keep_id <> d.pid;

-- The demand-order chain carries `pid` with no foreign key, because a line may
-- be a raw item or a finished product. Only the finished ones are remapped.
UPDATE demand_order_detail d SET pid = m.keep_id
FROM   product_merge m, demand_order h
WHERE  h.id = d.inv_id AND coalesce(h.type, 'RAW') = 'FINISH'
  AND  m.old_id = d.pid AND m.keep_id <> d.pid;

UPDATE do_request_detail d SET pid = m.keep_id
FROM   product_merge m, do_request h
WHERE  h.id = d.inv_id AND coalesce(h.type, 'RAW') = 'FINISH'
  AND  m.old_id = d.pid AND m.keep_id <> d.pid;

UPDATE do_received_detail d SET pid = m.keep_id
FROM   product_merge m, do_received h
WHERE  h.id = d.inv_id AND coalesce(h.type, 'RAW') = 'FINISH'
  AND  m.old_id = d.pid AND m.keep_id <> d.pid;

DELETE FROM product p USING product_merge m WHERE m.old_id = p.id AND m.keep_id <> p.id;

-- =============================================================================
-- 5. Drop what has moved, and lock in the identity
-- =============================================================================

DROP INDEX IF EXISTS idx_product_branch;

ALTER TABLE product
    DROP COLUMN branch_id,
    DROP COLUMN sale_price,
    DROP COLUMN least_price,
    DROP COLUMN reorder_level,
    DROP COLUMN shelf_number;

-- Identity: model + brand + type + placement, case-insensitive (SPECS §3.4).
CREATE UNIQUE INDEX idx_product_identity
    ON product (lower(coalesce(name, '')), coalesce(brand_id, 0), upper(type), upper(placement));

-- =============================================================================
-- 6. Fan-out, in BOTH directions
--
-- A new product reaches every branch, and a new branch reaches every product.
-- One direction only and a branch opened later can price nothing (SPECS §3.4
-- rule 3). Price stays zero until that branch sets it.
--
-- This lives in the database rather than a service because stock and catalog
-- rows also arrive by Excel import and by script, and a fan-out that only runs
-- on one code path is a fan-out that will be missed.
-- =============================================================================

CREATE FUNCTION branch_product_fanout_from_product() RETURNS trigger
LANGUAGE plpgsql AS $fanout_product$
BEGIN
    INSERT INTO branch_product (branch_id, product_id, created_by, updated_by)
    SELECT b.id, NEW.id, NEW.created_by, NEW.created_by
    FROM   branch b
    WHERE  b.id > 0 AND b.is_active
    ON CONFLICT (branch_id, product_id) DO NOTHING;

    RETURN NEW;
END;
$fanout_product$;

CREATE FUNCTION branch_product_fanout_from_branch() RETURNS trigger
LANGUAGE plpgsql AS $fanout_branch$
BEGIN
    IF NEW.id = 0 OR NOT NEW.is_active THEN
        RETURN NEW;
    END IF;

    INSERT INTO branch_product (branch_id, product_id, created_by, updated_by)
    SELECT NEW.id, p.id, NEW.created_by, NEW.created_by
    FROM   product p
    WHERE  p.is_active
    ON CONFLICT (branch_id, product_id) DO NOTHING;

    RETURN NEW;
END;
$fanout_branch$;

CREATE TRIGGER trg_branch_product_from_product
    AFTER INSERT ON product
    FOR EACH ROW EXECUTE FUNCTION branch_product_fanout_from_product();

-- Fires on creation and on reactivation — a branch switched back on gets its
-- price rows back.
CREATE TRIGGER trg_branch_product_from_branch
    AFTER INSERT OR UPDATE OF is_active ON branch
    FOR EACH ROW EXECUTE FUNCTION branch_product_fanout_from_branch();

-- =============================================================================
-- 7. Seed the real branches (PRINCIPLES §2)
--
-- Matched on NAME, so a database that already holds them — including one that
-- has been rolled back and re-migrated — is left alone rather than given a
-- second set. The placeholder-coded rows from step 1 are not touched either:
-- renaming or merging someone's existing branch is the owner's call, not a
-- migration's.
-- =============================================================================

INSERT INTO branch (name, code, type, address, is_active)
SELECT v.name, v.code, v.type, v.address, true
FROM  (VALUES
          ('Warehouse (Main)',   'WHS', 'WAREHOUSE', 'The manufacturing hub'),
          ('Hall Road, Lahore',  'HR',  'BRANCH',    'Near Waqas Biryani, Kacha Hall Road'),
          ('Hafeez Center',      'HC',  'BRANCH',    '3rd Floor, Hafeez Center, Lahore'),
          ('Multan',             'MUL', 'BRANCH',    'Khan Plaza, Multan'),
          ('Faisalabad',         'FSD', 'BRANCH',    '2nd Gallery, G/F, Rex City, Faisalabad'),
          ('Gujranwala',         'GUJ', 'BRANCH',    'Civil Computer Market, near Gondal Hospital'),
          ('Rawalpindi',         'RWP', 'BRANCH',    '6th Road, B-1st, Techno City 2, Rawalpindi')
      ) AS v(name, code, type, address)
WHERE NOT EXISTS (
    SELECT 1 FROM branch b WHERE lower(b.name) = lower(v.name) OR upper(b.code) = upper(v.code)
);

SELECT setval(
    pg_get_serial_sequence('branch', 'id'),
    GREATEST((SELECT MAX(id) FROM branch), 1)
);

-- Branches that existed before the trigger did have no rows yet. This is the
-- same statement the trigger runs, applied to every pair at once.
INSERT INTO branch_product (branch_id, product_id)
SELECT b.id, p.id
FROM   branch b
CROSS  JOIN product p
WHERE  b.id > 0 AND b.is_active AND p.is_active
ON CONFLICT (branch_id, product_id) DO NOTHING;

-- Down Migration
--
-- NOT a faithful inverse, and deliberately so: step 4 merged rows that the old
-- schema kept apart, and no down migration can un-merge them. Prices, location
-- and threshold ARE carried back to the surviving row for the branch that had
-- them, so nothing a branch typed is lost. What cannot come back is the
-- duplicate product rows other branches used to own.

DROP TRIGGER IF EXISTS trg_branch_product_from_branch  ON branch;
DROP TRIGGER IF EXISTS trg_branch_product_from_product ON product;
DROP FUNCTION IF EXISTS branch_product_fanout_from_branch();
DROP FUNCTION IF EXISTS branch_product_fanout_from_product();

DROP INDEX IF EXISTS idx_product_identity;

ALTER TABLE product
    ADD COLUMN branch_id     integer NOT NULL DEFAULT 0 REFERENCES branch(id),
    ADD COLUMN sale_price    numeric(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN least_price   numeric(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN reorder_level integer NOT NULL DEFAULT 0,
    ADD COLUMN shelf_number  integer NOT NULL DEFAULT 0;

-- Carry back the prices of whichever branch priced the product first.
UPDATE product p
SET    branch_id     = bp.branch_id,
       sale_price    = bp.selling_price,
       least_price   = bp.minimum_price,
       price         = bp.wholesale_cost,
       reorder_level = bp.low_stock_threshold::integer,
       shelf_number  = coalesce(nullif(regexp_replace(coalesce(bp.location, ''), '\D', '', 'g'), '')::integer, 0)
FROM  (SELECT DISTINCT ON (product_id) * FROM branch_product ORDER BY product_id, branch_id) bp
WHERE bp.product_id = p.id;

CREATE INDEX idx_product_branch ON product(branch_id);

DROP TABLE IF EXISTS branch_product;

ALTER TABLE product
    DROP CONSTRAINT IF EXISTS product_type_check,
    DROP CONSTRAINT IF EXISTS product_placement_check,
    DROP CONSTRAINT IF EXISTS product_cell_count_check,
    DROP COLUMN IF EXISTS type,
    DROP COLUMN IF EXISTS placement,
    DROP COLUMN IF EXISTS cell_type_id,
    DROP COLUMN IF EXISTS cell_count;

DROP INDEX IF EXISTS idx_branch_one_warehouse;
DROP INDEX IF EXISTS idx_branch_code;

ALTER TABLE branch
    DROP CONSTRAINT IF EXISTS branch_code_required,
    DROP CONSTRAINT IF EXISTS branch_type_check,
    DROP COLUMN IF EXISTS code,
    DROP COLUMN IF EXISTS type,
    DROP COLUMN IF EXISTS phone,
    DROP COLUMN IF EXISTS opening_hours,
    DROP COLUMN IF EXISTS closing_day,
    DROP COLUMN IF EXISTS is_active;
