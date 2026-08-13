-- Up Migration
--
-- Permission tree for My Prices — a branch's own view onto the master
-- catalog (Phase 1, the catalog split). New work, so it claims head 12
-- upward per PLAN.md ground rule 9, rather than reusing a legacy id.
--
-- Purely additive: form_head / form / forms_action rows only, no schema
-- change. The module has no create or delete route — every branch_product
-- row already exists, made by the catalog-split migration's fan-out
-- triggers — so only View and Edit are seeded.

INSERT INTO form_head (head_id, head_name, code, sr) VALUES
    (12, 'Branch Catalog', 12, 12)
ON CONFLICT (head_id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form_head', 'head_id'),
              GREATEST((SELECT MAX(head_id) FROM form_head), 1));

INSERT INTO form (id, head_id, form_name, sub, sr, ids, form_code)
VALUES (53, 12, 'My Prices', NULL, 1, 53, 1201)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form', 'id'),
              GREATEST((SELECT MAX(id) FROM form), 1));

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT 53, a.name, a.seq, 12010 + a.seq
FROM  (VALUES ('View', 1), ('Edit', 3)) AS a(name, seq)
WHERE NOT EXISTS (
    SELECT 1 FROM forms_action WHERE form_id = 53 AND action_code = 12010 + a.seq
);

-- Down Migration
DELETE FROM role_assign WHERE form_id = 53;
DELETE FROM forms_action WHERE form_id = 53;
DELETE FROM form WHERE id = 53;
DELETE FROM form_head WHERE head_id = 12;
