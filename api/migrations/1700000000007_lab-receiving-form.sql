-- Up Migration
--
-- Give Lab Receiving its own form id.
--
-- The legacy menu gated BOTH "DO Received (Finish Item)" and "Lab Receiving" on
-- `HasAction(49, 5101)`. Granting either silently granted the other — a store
-- keeper allowed to receive inter-branch stock could also open the lab intake
-- screen, and vice versa. The reconstruction preserved that collision
-- deliberately so existing grants behaved identically (migration
-- 1700000000003); this separates them.
--
-- Lab (head 11) already keeps its form codes in the 52x range because it was
-- split out of Demand Order historically, so Lab Receiving takes 521 —
-- alongside Lab Invoices on 520.

INSERT INTO form (id, head_id, form_name, sub, sr, ids, form_code)
VALUES (52, 11, 'Lab Receiving', NULL, 1, 52, 521)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form', 'id'),
              GREATEST((SELECT MAX(id) FROM form), 1));

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT 52, a.name, a.seq, 5210 + a.seq
FROM  (VALUES ('View', 1), ('New', 2), ('Edit', 3), ('Delete', 4), ('Print', 5)) AS a(name, seq)
WHERE NOT EXISTS (
    SELECT 1 FROM forms_action WHERE form_id = 52 AND action_code = 5210 + a.seq
);

-- Carry existing grants across: anyone who could reach Lab Receiving through
-- form 49 keeps that access under its own id rather than losing it silently.
INSERT INTO role_assign (role_id, head_id, form_id, action_id, branch_id, created_by, updated_by)
SELECT ra.role_id, 11, 52, 5210 + (ra.action_id - 5100), ra.branch_id, 0, 0
FROM   role_assign ra
WHERE  ra.form_id = 49
  AND  ra.action_id BETWEEN 5101 AND 5105
  AND  NOT EXISTS (
      SELECT 1 FROM role_assign x
      WHERE  x.role_id = ra.role_id
        AND  x.form_id = 52
        AND  x.action_id = 5210 + (ra.action_id - 5100)
  );

-- Down Migration
DELETE FROM role_assign WHERE form_id = 52;
DELETE FROM forms_action WHERE form_id = 52;
DELETE FROM form WHERE id = 52;
