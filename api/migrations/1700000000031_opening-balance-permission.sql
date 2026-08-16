-- Up Migration
--
-- Opening Balances gets its own permission. It was sharing Account Registration's.
--
-- WHY
-- `api/src/modules/opening/routes.ts` authorised against form 25 / code 703 —
-- the "Final Account" screen that creates ledger accounts. So anyone allowed to
-- add an account could also post opening balances, and anyone allowed to post
-- opening balances could create accounts.
--
-- These are not the same job. Creating an account is routine setup. Opening
-- balances set the company's entire starting position — cash, bank, stock on
-- hand, what customers owe, what is owed to suppliers — in one irreversible
-- stroke, and every report for the first month is wrong if they are wrong. A
-- grant that broad should be deliberate.
--
-- Form 60 / code 709 under head 7 (Accounts), following the house scheme:
-- form_code = head_code * 100 + sequence. Head 7 holds 701-708.

INSERT INTO form (id, head_id, form_name, sub, sr, ids, form_code)
VALUES (60, 7, 'Opening Balances', NULL, 9, 60, 709)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('form', 'id'), GREATEST((SELECT MAX(id) FROM form), 1));

INSERT INTO forms_action (form_id, action_name, sr, action_code)
SELECT 60, a.name, a.seq, 7090 + a.seq
FROM   (VALUES ('View', 1), ('New', 2)) AS a(name, seq)
WHERE  NOT EXISTS (
    SELECT 1 FROM forms_action WHERE form_id = 60 AND action_code = 7090 + a.seq
);

-- Anyone who already holds Final Account keeps working: the same grant is
-- mirrored onto the new form rather than being silently revoked. Narrowing it
-- is a deliberate act for the super admin on the Role Assignment screen, not
-- something a migration does behind their back.
INSERT INTO role_assign (role_id, head_id, form_id, action_id, branch_id, created_by, updated_by)
SELECT ra.role_id, 7, 60, 7090 + (CASE WHEN ra.action_id = 7031 THEN 1 ELSE 2 END),
       ra.branch_id, ra.created_by, ra.updated_by
FROM   role_assign ra
WHERE  ra.form_id = 25
  AND  ra.action_id IN (7031, 7032)
  AND  NOT EXISTS (
    SELECT 1 FROM role_assign x
    WHERE  x.role_id = ra.role_id
      AND  x.form_id = 60
      AND  x.action_id = 7090 + (CASE WHEN ra.action_id = 7031 THEN 1 ELSE 2 END)
  );

-- Down Migration

DELETE FROM role_assign WHERE form_id = 60;
DELETE FROM forms_action WHERE form_id = 60;
DELETE FROM form WHERE id = 60;
