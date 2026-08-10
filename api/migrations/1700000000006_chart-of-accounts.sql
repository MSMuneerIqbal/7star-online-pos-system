-- Up Migration
--
-- Chart of accounts.
--
-- This is STRUCTURAL, not sample data. The posting engine references these
-- codes directly (src/accounting/accounts.ts), so a database without them
-- cannot record a sale, a purchase, a transfer or a production run. It ships as
-- a migration for that reason — `npm run migrate:up` yields a system that can
-- actually post.
--
-- CODE COMPOSITION
--   account_id = head_code x 1_000_000
--              + sub_code  x    10_000
--              + third_code x      100
--              + sequence
--
-- so 1010402 = head 1 / sub 01 / third 04 / seq 02.
--
-- The "third" level groups accounts within a sub-head, and party accounts are
-- allocated sequentially inside their group:
--   customers 1010200+   suppliers 2010100+   employees 5020100+
--
-- Leaving room matters: each group holds 99 accounts before allocation fails
-- with a clear error, so groups likely to grow (customers, suppliers) get their
-- own third level rather than sharing one.

-- ---------------------------------------------------------------------------
-- Level 1 — heads
-- ---------------------------------------------------------------------------
INSERT INTO account_head (id, name, code) VALUES
    (1, 'Assets',      1),
    (2, 'Liabilities', 2),
    (3, 'Equity',      3),
    (4, 'Revenue',     4),
    (5, 'Expenses',    5)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('account_head', 'id'),
              GREATEST((SELECT MAX(id) FROM account_head), 1));

-- ---------------------------------------------------------------------------
-- Level 2 — sub-heads
-- ---------------------------------------------------------------------------
INSERT INTO account_sub_head (id, name, code, head_code, head_id, is_fixed) VALUES
    (1, 'Current Assets',       1, 1, 1, true),
    (2, 'Fixed Assets',         2, 1, 1, true),
    (3, 'Current Liabilities',  1, 2, 2, true),
    (4, 'Long Term Liabilities',2, 2, 2, true),
    (5, 'Capital',              1, 3, 3, true),
    (6, 'Operating Revenue',    1, 4, 4, true),
    (7, 'Other Revenue',        2, 4, 4, true),
    (8, 'Cost of Sales',        1, 5, 5, true),
    (9, 'Operating Expenses',   2, 5, 5, true)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('account_sub_head', 'id'),
              GREATEST((SELECT MAX(id) FROM account_sub_head), 1));

-- ---------------------------------------------------------------------------
-- Level 3 — accounts
--
-- `is_fixed = true` marks an account the posting engine depends on. Those are
-- visible to every branch and must never be renumbered or deleted.
-- ---------------------------------------------------------------------------
INSERT INTO account (name, account_id, head_id, sub_head_id, head_code, sub_code, third_code, is_fixed) VALUES

    -- ASSETS / Current / Cash & bank (third 01)
    ('Cash in Hand',                1010101, 1, 1, 1, 1,  1, true),
    ('Bank Account',                1010102, 1, 1, 1, 1,  1, true),

    -- ASSETS / Current / Receivables (third 02) — customers allocate from here
    ('Walk-in Customer',            1010201, 1, 1, 1, 1,  2, true),

    -- ASSETS / Current / Advances & prepayments (third 03)
    ('Advances to Suppliers',       1010301, 1, 1, 1, 1,  3, true),
    ('Prepaid Expenses',            1010302, 1, 1, 1, 1,  3, true),

    -- ASSETS / Current / Inventory (third 04)
    ('Inventory — Raw Material',    1010401, 1, 1, 1, 1,  4, true),
    ('Inventory — Finished Goods',  1010402, 1, 1, 1, 1,  4, true),

    -- ASSETS / Current / Inter-branch (third 05)
    -- Carries stock in transit between branches. Nets to zero once received;
    -- a non-zero balance means goods are on the road.
    ('Inter-Branch Clearing',       1010501, 1, 1, 1, 1,  5, true),

    -- ASSETS / Fixed (sub 02)
    ('Plant & Machinery',           1020101, 1, 2, 1, 2,  1, true),
    ('Furniture & Fixtures',        1020102, 1, 2, 1, 2,  1, true),
    ('Vehicles',                    1020103, 1, 2, 1, 2,  1, true),
    ('Accumulated Depreciation',    1020201, 1, 2, 1, 2,  2, true),

    -- LIABILITIES / Current / Payables (third 01) — suppliers allocate from here
    ('Sundry Creditors',            2010101, 2, 3, 2, 1,  1, true),

    -- LIABILITIES / Current / Accruals (third 02)
    ('Accrued Expenses',            2010201, 2, 3, 2, 1,  2, true),
    ('Salaries Payable',            2010202, 2, 3, 2, 1,  2, true),
    ('Taxes Payable',               2010203, 2, 3, 2, 1,  2, true),

    -- LIABILITIES / Long term (sub 02)
    ('Long Term Loan',              2020101, 2, 4, 2, 2,  1, true),

    -- EQUITY (head 3)
    ('Owner Capital',               3010101, 3, 5, 3, 1,  1, true),
    ('Owner Drawings',              3010102, 3, 5, 3, 1,  1, true),
    ('Retained Earnings',           3010201, 3, 5, 3, 1,  2, true),

    -- REVENUE / Operating (sub 01)
    ('Sales Revenue',               4010101, 4, 6, 4, 1,  1, true),
    ('Service Income',              4010102, 4, 6, 4, 1,  1, true),

    -- REVENUE / Other (sub 02)
    -- NOTE: 4020101 is the discount account the posting engine uses. The legacy
    -- system overloaded ONE code for both sales and purchase discount so the
    -- two netted off; separate codes are provided here, and accounts.ts should
    -- be split onto them before go-live (db/accounts.md §4.2).
    ('Discount',                    4020101, 4, 7, 4, 2,  1, true),
    ('Purchase Discount Received',  4020102, 4, 7, 4, 2,  1, true),
    ('Other Income',                4020201, 4, 7, 4, 2,  2, true),

    -- EXPENSES / Cost of sales (sub 01)
    ('Cost of Goods Sold',          5010101, 5, 8, 5, 1,  1, true),
    ('Production Wages',            5010102, 5, 8, 5, 1,  1, true),
    ('Factory Overheads',           5010201, 5, 8, 5, 1,  2, true),

    -- EXPENSES / Operating / Salaries (third 01) — employees allocate from here
    ('Salaries & Wages',            5020101, 5, 9, 5, 2,  1, true),

    -- EXPENSES / Operating / Freight & carriage (third 02)
    ('Freight Inward',              5020201, 5, 9, 5, 2,  2, true),
    ('Freight Outward',             5020202, 5, 9, 5, 2,  2, true),

    -- EXPENSES / Operating / Premises & admin (third 03)
    ('Rent',                        5020301, 5, 9, 5, 2,  3, true),
    ('Electricity',                 5020302, 5, 9, 5, 2,  3, true),
    ('Telephone & Internet',        5020303, 5, 9, 5, 2,  3, true),
    ('Repairs & Maintenance',       5020304, 5, 9, 5, 2,  3, true),
    ('Office Supplies',             5020305, 5, 9, 5, 2,  3, true),
    ('Vehicle Running',             5020306, 5, 9, 5, 2,  3, true),
    ('Bank Charges',                5020307, 5, 9, 5, 2,  3, true),
    ('Depreciation',                5020308, 5, 9, 5, 2,  3, true),
    ('Miscellaneous Expenses',      5020309, 5, 9, 5, 2,  3, true)

ON CONFLICT (account_id) DO NOTHING;

-- Down Migration
DELETE FROM account WHERE is_fixed = true;
DELETE FROM account_sub_head WHERE is_fixed = true;
DELETE FROM account_head WHERE id BETWEEN 1 AND 5;
