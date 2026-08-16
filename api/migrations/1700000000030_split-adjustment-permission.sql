-- Up Migration
--
-- Stock Adjustment gets its own permission. It was sharing E-Store's.
--
-- WHAT WENT WRONG
-- Migration 1700000000026 seeded form 58 as E-Store (head 5, code 513).
-- Migration 1700000000029 then tried to seed form 58 as Stock Adjustment
-- (head 10, code 513) and its `ON CONFLICT (id) DO NOTHING` swallowed the
-- attempt, so the row stayed E-Store while
-- `api/src/modules/adjustment/routes.ts` went on authorising against it.
--
-- The result was one permission behind two unrelated screens: granting a
-- warehouse clerk the right to correct a stock count also granted the right to
-- accept E-Store shipments, which moves a branch's dues. That is the same
-- defect migration 1700000000007 exists to fix for Lab Receiving, which shared
-- form 49 with DO Finish Received.
--
-- Its action loop also used `WHERE NOT EXISTS` per action rather than per form,
-- so it added a fourth action — Delete (5134) — onto E-Store, which was defined
-- with View/New/Edit only. That is removed here too.
--
-- SAFE TO RENUMBER, TODAY
-- `role_assign` holds no rows against form 58, so nothing is being taken away
-- from anyone. That window closes as soon as real grants are made, which is why
-- this is worth doing now rather than later.

-- Stock Adjustment moves to form 59 under head 10 (Production), following the
-- house scheme: form_code = head_code * 100 + sequence, and Production already
-- holds 1001.
INSERT INTO form (id, head_id, form_name, sub, sr, ids, form_code)
VALUES (59, 10, 'Stock Adjustment', NULL, 2, 59, 1002)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form', 'id'), GREATEST((SELECT MAX(id) FROM form), 1));

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT 59, a.name, a.seq, 10020 + a.seq
FROM   (VALUES ('View', 1), ('New', 2), ('Edit', 3), ('Delete', 4)) AS a(name, seq)
WHERE  NOT EXISTS (
    SELECT 1 FROM forms_action WHERE form_id = 59 AND action_code = 10020 + a.seq
);

-- Give E-Store back the three actions it was defined with.
DELETE FROM forms_action WHERE form_id = 58 AND action_code = 5134;

-- Down Migration
--
-- Scoped to form 59 alone. Migration 1700000000029's down deleted every action
-- on form 58 and then the form itself, which would have taken E-Store with it —
-- the same confusion this migration exists to undo.

DELETE FROM forms_action WHERE form_id = 59;
DELETE FROM form WHERE id = 59;

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT 58, 'Delete', 4, 5134
WHERE NOT EXISTS (SELECT 1 FROM forms_action WHERE form_id = 58 AND action_code = 5134);
