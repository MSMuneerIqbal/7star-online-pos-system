-- Up Migration
--
-- Top up each form with the standard View/New/Edit/Delete actions it is
-- missing.
--
-- The previous migration seeds the EXACT codes the legacy UI checks, which is
-- what makes existing grants work. But the legacy UI gated inconsistently --
-- Branch has New (2012) and Edit (2013) but no Delete code at all, so its
-- delete button was ungated and anyone who could see the screen could use it.
--
-- The rewrite gates every mutating operation, so the missing codes need to
-- exist to be grantable. These are additive: they occupy free sequence slots
-- and cannot collide with a legacy code, because the insert skips any
-- action_code already present for that form.
--
-- Marked `sr = 0` to distinguish them from legacy-derived rows.

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT f.id, a.name, 0, f.form_code * 10 + a.seq
FROM   form f
CROSS  JOIN (VALUES ('View', 1), ('New', 2), ('Edit', 3), ('Delete', 4)) AS a(name, seq)
WHERE  -- read-only screens never get New/Edit/Delete
       (a.seq = 1 OR f.head_id NOT IN (6) AND f.id NOT IN (26, 27, 28, 29, 30, 38, 1))
       -- never duplicate a code this form already has
       AND NOT EXISTS (
           SELECT 1 FROM forms_action x
           WHERE  x.form_id = f.id
             AND  x.action_code = f.form_code * 10 + a.seq
       );

-- Down Migration
DELETE FROM forms_action WHERE sr = 0;
