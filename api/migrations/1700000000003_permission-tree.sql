-- Up Migration
--
-- The permission tree: form_head -> form -> forms_action.
--
-- WHY THIS EXISTS
-- These rows live only inside the legacy 7STARBATTERYPOS.mdf, and their ids are
-- hardcoded as literals throughout the legacy UI (`HasAction(12, 4011)`), so
-- they cannot be renumbered. Without them, only super admins (emp_id = 0, who
-- bypass every check) can sign in.
--
-- RECONSTRUCTION
-- Rather than wait for the .mdf, this is derived from the legacy UI itself,
-- which is the authoritative *consumer* of these ids. Every literal was
-- extracted from Views/Shared/_Layout.cshtml (menu visibility) and from all 112
-- Razor views (button-level checks).
--
-- Form codes follow a scheme:
--   form_code = head_code * 100 + form_sequence      (e.g. 301 = Purchase)
--
-- Action codes are form_code * 10 + a per-form sequence, but that sequence is
-- NOT a uniform 1-5 -- see the note above the actions block. Only the exact
-- referenced pairs are seeded.
--
-- LIMITS -- read before trusting this for a data migration
--   * Form and head NAMES come from the menu labels; the .mdf may spell them
--     differently. Display only, so harmless.
--   * ACTION names are inferred from the sequence digit and are provisional.
--     The codes are exact; the labels are not. See the actions block.
--   * Only actions the UI actually references are seeded. If the .mdf grants an
--     action no code checks, it is inert and its absence here changes nothing.
--   * Existing role_assign rows migrated from the legacy database reference
--     these ids. Reconcile against the .mdf before importing them, or grants
--     may not line up.
--
-- Run `npx tsx scripts/verify-permissions.ts` to prove every id the legacy UI
-- checks resolves to a seeded row.
--
-- Lab (head 11) deliberately keeps form codes in the 52x range: Lab was split
-- out of Demand Order (head 5) later and never renumbered. Form 49 is shared by
-- DO Finish Received and Lab Receiving -- a genuine defect in the legacy menu,
-- preserved here so existing grants behave identically. Give Lab Receiving its
-- own form id before go-live.

-- ---------------------------------------------------------------------------
-- Heads
-- ---------------------------------------------------------------------------
INSERT INTO form_head (head_id, head_name, code, sr) VALUES
    (1,  'Main Menu',       1,  1),
    (2,  'Registration',    2,  2),
    (3,  'Purchase',        3,  3),
    (4,  'Sale',            4,  4),
    (5,  'Demand Order',    5,  5),
    (6,  'Reports',         6,  8),
    (7,  'Accounts',        7,  9),
    (8,  'User Management', 8,  10),
    (9,  'General Setting', 9,  11),
    (10, 'Production',      10, 6),
    (11, 'Lab',             11, 7)
ON CONFLICT (head_id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form_head', 'head_id'),
              GREATEST((SELECT MAX(head_id) FROM form_head), 1));

-- ---------------------------------------------------------------------------
-- Forms. `ids` mirrors the legacy column of the same name (menu ordering).
-- ---------------------------------------------------------------------------
INSERT INTO form (id, head_id, form_name, sub, sr, ids, form_code) VALUES
    -- Head 1 — Main Menu
    (1,  1,  'Dashboard',              NULL,          1,  1,  101),

    -- Head 2 — Registration
    (2,  2,  'Branch',                 NULL,          1,  2,  201),
    (3,  2,  'Brand',                  NULL,          2,  3,  202),
    (4,  2,  'Category',               NULL,          3,  4,  203),
    (5,  2,  'Raw Item',               NULL,          4,  5,  204),
    (6,  2,  'Finish Product',         NULL,          5,  6,  205),
    (7,  2,  'Customer',               NULL,          6,  7,  206),
    (8,  2,  'Vendor',                 NULL,          7,  8,  207),
    (9,  2,  'Employee',               NULL,          8,  9,  208),

    -- Head 3 — Purchase
    (10, 3,  'Purchase',               NULL,          1,  10, 301),
    (11, 3,  'Purchase Return',        NULL,          2,  11, 302),

    -- Head 4 — Sale
    (12, 4,  'Sale',                   NULL,          1,  12, 401),
    (13, 4,  'Sale Return',            NULL,          2,  13, 402),
    (51, 4,  'Hold Sale',              NULL,          3,  51, 403),

    -- Head 5 — Demand Order (raw)
    (17, 5,  'Demand Order',           'Raw Item',    1,  17, 501),
    (18, 5,  'DO Request',             'Raw Item',    2,  18, 502),
    (19, 5,  'Receiving Request',      'Raw Item',    3,  19, 503),
    (39, 5,  'Branch Transfer',        'Raw Item',    7,  39, 507),
    (41, 5,  'DO Received',            'Raw Item',    9,  41, 509),

    -- Head 5 — Demand Order (finish)
    (20, 5,  'Demand Order',           'Finish Item', 4,  20, 504),
    (21, 5,  'DO Request',             'Finish Item', 5,  21, 505),
    (22, 5,  'Receiving Request',      'Finish Item', 6,  22, 506),
    (40, 5,  'Branch Transfer',        'Finish Item', 8,  40, 508),
    (49, 5,  'DO Received',            'Finish Item', 10, 49, 510),

    -- Head 11 — Lab. Codes stay in the 52x range; see the note above.
    (50, 11, 'Lab Invoices',           NULL,          2,  50, 520),

    -- Head 6 — Reports (none of these controllers ever existed)
    (31, 6,  'Stock Report Raw',       'Raw',         1,  31, 601),
    (32, 6,  'Item Ledger Raw',        'Raw',         2,  32, 602),
    (33, 6,  'Stock Report Finish',    'Finish',      3,  33, 603),
    (34, 6,  'Item Ledger Finish',     'Finish',      4,  34, 604),
    (35, 6,  'Sale Report',            NULL,          5,  35, 605),
    (36, 6,  'Purchase Report',        NULL,          6,  36, 606),

    -- Head 7 — Accounts
    (23, 7,  'First Level Account',    'Chart',       1,  23, 701),
    (24, 7,  'Second Level Account',   'Chart',       2,  24, 702),
    (25, 7,  'Final Account',          'Chart',       3,  25, 703),
    (26, 7,  'Account Ledger',         'Ledger',      4,  26, 704),
    (27, 7,  'Cash Book',              'Ledger',      5,  27, 705),
    (28, 7,  'Trial Balance',          'Financial',   6,  28, 706),
    (29, 7,  'Income Statement',       'Financial',   7,  29, 707),
    (30, 7,  'Balance Sheet',          'Financial',   8,  30, 708),
    (42, 7,  'Cash Receipt (CRV)',     'Voucher',     9,  42, 709),
    (43, 7,  'Cash Payment (CPV)',     'Voucher',     10, 43, 710),
    (44, 7,  'Bank Receipt (BRV)',     'Voucher',     11, 44, 711),
    (45, 7,  'Bank Payment (BPV)',     'Voucher',     12, 45, 712),
    (46, 7,  'Journal Voucher (JV)',   'Voucher',     13, 46, 713),

    -- Head 8 — User Management
    (14, 8,  'User Roles',             NULL,          1,  14, 801),
    (15, 8,  'Role Assignment',        NULL,          2,  15, 802),
    (16, 8,  'User Logins',            NULL,          3,  16, 803),
    (38, 8,  'User Logs',              NULL,          4,  38, 804),

    -- Head 9 — General Setting
    (37, 9,  'Setting',                NULL,          1,  37, 901),

    -- Head 10 — Production
    (47, 10, 'Production',             NULL,          1,  47, 1001)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form', 'id'),
              GREATEST((SELECT MAX(id) FROM form), 1));

-- ---------------------------------------------------------------------------
-- Actions.
--
-- These are the EXACT 150 (form, action_code) pairs the legacy UI checks,
-- extracted from all 112 Razor views. Seeding the exact set rather than a
-- generated one matters: the action sequence is NOT a uniform 1-5. Forms with
-- extra operations shift the later codes along -- Product's Delete is 2056, not
-- 2054, because Bulk Create sits in between, and DO Request's Print is 5026
-- because Approve precedes it. A generated 1-5 grid missed 8 real codes.
--
-- Two pairs cross form boundaries and are seeded as referenced, because that is
-- what the UI checks and the button stays hidden otherwise:
--   (19, 5071) -- code belongs to form 39's range; a typo in _Layout.cshtml
--   (22, 5024), (22, 5025) -- codes belong to form 18's range
--
-- ACTION NAMES ARE PROVISIONAL. Codes are exact and functional; the labels are
-- inferred from the sequence digit, with (6,2056)=Delete and (18,5026)=Print
-- verified by reading the markup. Labels appear in the Role Assignment screen,
-- so reconcile them against the .mdf before letting an admin grant permissions
-- by name. Regenerate with scripts/verify-permissions.ts to confirm coverage.

INSERT INTO forms_action (form_id, action_name, sr, action_code) VALUES
    (2, 'New', 2, 2012),
    (2, 'Edit', 3, 2013),
    (3, 'New', 2, 2022),
    (3, 'Edit', 3, 2023),
    (3, 'Delete', 4, 2024),
    (4, 'New', 2, 2032),
    (4, 'Edit', 3, 2033),
    (4, 'Delete', 4, 2034),
    (5, 'New', 2, 2042),
    (5, 'Edit', 3, 2043),
    (5, 'Delete', 4, 2044),
    (6, 'New', 2, 2052),
    (6, 'Edit', 3, 2053),
    (6, 'Delete', 4, 2054),
    (6, 'Print', 5, 2055),
    (6, 'Delete', 6, 2056),
    (7, 'New', 2, 2062),
    (7, 'Edit', 3, 2063),
    (7, 'Delete', 4, 2064),
    (8, 'New', 2, 2072),
    (8, 'Edit', 3, 2073),
    (8, 'Delete', 4, 2074),
    (9, 'New', 2, 2082),
    (9, 'Edit', 3, 2083),
    (9, 'Delete', 4, 2084),
    (10, 'View', 1, 3011),
    (10, 'New', 2, 3012),
    (10, 'Edit', 3, 3013),
    (10, 'Delete', 4, 3014),
    (10, 'Print', 5, 3015),
    (11, 'View', 1, 3021),
    (11, 'New', 2, 3022),
    (11, 'Edit', 3, 3023),
    (11, 'Delete', 4, 3024),
    (11, 'Print', 5, 3025),
    (12, 'View', 1, 4011),
    (12, 'New', 2, 4012),
    (12, 'Edit', 3, 4013),
    (12, 'Delete', 4, 4014),
    (12, 'Print', 5, 4015),
    (13, 'View', 1, 4021),
    (13, 'New', 2, 4022),
    (13, 'Edit', 3, 4023),
    (13, 'Delete', 4, 4024),
    (13, 'Print', 5, 4025),
    (14, 'View', 1, 8011),
    (15, 'View', 1, 8021),
    (16, 'View', 1, 8031),
    (17, 'View', 1, 5011),
    (17, 'New', 2, 5012),
    (17, 'Edit', 3, 5013),
    (17, 'Delete', 4, 5014),
    (18, 'View', 1, 5021),
    (18, 'New', 2, 5022),
    (18, 'Edit', 3, 5023),
    (18, 'Delete', 4, 5024),
    (18, 'Print', 5, 5025),
    (18, 'Print', 6, 5026),
    (19, 'View', 1, 5031),
    (19, 'Edit', 3, 5033),
    (19, 'Print', 5, 5035),
    (19, 'View', 1, 5071),
    (20, 'View', 1, 5041),
    (20, 'New', 2, 5042),
    (20, 'Edit', 3, 5043),
    (20, 'Delete', 4, 5044),
    (21, 'View', 1, 5051),
    (21, 'Print', 5, 5055),
    (21, 'Extra', 6, 5056),
    (22, 'Delete', 4, 5024),
    (22, 'Print', 5, 5025),
    (22, 'View', 1, 5061),
    (22, 'Edit', 3, 5063),
    (22, 'Print', 5, 5065),
    (23, 'View', 1, 7011),
    (23, 'New', 2, 7012),
    (23, 'Edit', 3, 7013),
    (24, 'View', 1, 7021),
    (24, 'New', 2, 7022),
    (24, 'Edit', 3, 7023),
    (25, 'View', 1, 7031),
    (25, 'New', 2, 7032),
    (25, 'Edit', 3, 7033),
    (26, 'View', 1, 7041),
    (27, 'View', 1, 7051),
    (28, 'View', 1, 7061),
    (29, 'View', 1, 7071),
    (30, 'View', 1, 7081),
    (31, 'View', 1, 6011),
    (32, 'View', 1, 6021),
    (33, 'View', 1, 6031),
    (34, 'View', 1, 6041),
    (35, 'View', 1, 6051),
    (36, 'View', 1, 6061),
    (37, 'View', 1, 9011),
    (38, 'View', 1, 8041),
    (39, 'View', 1, 5071),
    (39, 'Edit', 3, 5073),
    (39, 'Delete', 4, 5074),
    (39, 'Print', 5, 5075),
    (40, 'View', 1, 5081),
    (40, 'New', 2, 5082),
    (40, 'Edit', 3, 5083),
    (40, 'Delete', 4, 5084),
    (40, 'Print', 5, 5085),
    (41, 'View', 1, 5091),
    (41, 'Edit', 3, 5093),
    (41, 'Delete', 4, 5094),
    (41, 'Print', 5, 5095),
    (42, 'View', 1, 7091),
    (42, 'New', 2, 7092),
    (42, 'Edit', 3, 7093),
    (42, 'Delete', 4, 7094),
    (42, 'Print', 5, 7095),
    (43, 'View', 1, 7101),
    (43, 'New', 2, 7102),
    (43, 'Edit', 3, 7103),
    (43, 'Delete', 4, 7104),
    (43, 'Print', 5, 7105),
    (44, 'View', 1, 7111),
    (44, 'New', 2, 7112),
    (44, 'Edit', 3, 7113),
    (44, 'Delete', 4, 7114),
    (44, 'Print', 5, 7115),
    (45, 'View', 1, 7121),
    (45, 'New', 2, 7122),
    (45, 'Edit', 3, 7123),
    (45, 'Delete', 4, 7124),
    (45, 'Print', 5, 7125),
    (46, 'View', 1, 7131),
    (46, 'Edit', 3, 7133),
    (46, 'Delete', 4, 7134),
    (46, 'Print', 5, 7135),
    (47, 'View', 1, 10011),
    (49, 'View', 1, 5101),
    (49, 'New', 2, 5102),
    (49, 'Edit', 3, 5103),
    (49, 'Delete', 4, 5104),
    (49, 'Print', 5, 5105),
    (49, 'Extra', 6, 5106),
    (49, 'Extra', 7, 5107),
    (50, 'View', 1, 5201),
    (50, 'Edit', 3, 5203),
    (50, 'Delete', 4, 5204),
    (50, 'Print', 5, 5205),
    (51, 'View', 1, 4031),
    (51, 'New', 2, 4032),
    (51, 'Edit', 3, 4033),
    (51, 'Delete', 4, 4034),
    (51, 'Print', 5, 4035)
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM forms_action;
DELETE FROM form;
DELETE FROM form_head;
