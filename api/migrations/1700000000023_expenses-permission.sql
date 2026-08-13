-- Up Migration
--
-- PHASE 8 — the Expenses screen permission. A branch-level daily operation, so
-- it gets its own head (13) with one form (56 / 806).

INSERT INTO form_head (head_id, head_name, code, sr) VALUES
    (13, 'Expenses', 13, 13)
ON CONFLICT (head_id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form_head', 'head_id'), GREATEST((SELECT MAX(head_id) FROM form_head), 1));

INSERT INTO form (id, head_id, form_name, sub, sr, ids, form_code)
VALUES (56, 13, 'Expenses', NULL, 1, 56, 806)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form', 'id'), GREATEST((SELECT MAX(id) FROM form), 1));

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT 56, a.name, a.seq, 8060 + a.seq
FROM (VALUES ('View', 1), ('New', 2), ('Edit', 3)) AS a(name, seq)
WHERE NOT EXISTS (SELECT 1 FROM forms_action WHERE form_id = 56 AND action_code = 8060 + a.seq);

-- Down Migration
DELETE FROM role_assign WHERE form_id = 56;
DELETE FROM forms_action WHERE form_id = 56;
DELETE FROM form WHERE id = 56;
DELETE FROM form_head WHERE head_id = 13;
