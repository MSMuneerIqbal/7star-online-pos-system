-- Up Migration
--
-- Opening Balances moves off form_code 709, which belongs to Cash Receipt.
--
-- WHAT WENT WRONG
-- Migration 1700000000031 gave Opening Balances form 60 with code 709 under
-- head 7, reasoning that head 7 "holds 701-708". It holds 701-713: the five
-- voucher screens sit under Accounts too, and Cash Receipt (CRV) is form 42 at
-- code 709. So Opening Balances and Cash Receipt shared a code, and their View
-- and New actions collided on 7091 and 7092 — granting one silently granted the
-- other.
--
-- This is the third instance of the same defect (Lab Receiving vs DO Finish
-- Received in migration 7; Stock Adjustment vs E-Store in migration 30), and it
-- was introduced by the migration that was fixing the second one. Reading the
-- range by eye is evidently not good enough.
--
-- `tests/screens.test.ts` now asserts that every form_code and every action_code
-- is unique, so a fourth instance fails the suite rather than reaching the
-- database. That test is the durable fix; this migration is the cleanup.
--
-- 714 is the first genuinely free code under head 7.

UPDATE form SET form_code = 714 WHERE id = 60 AND form_code = 709;

UPDATE forms_action SET action_code = 7141 WHERE form_id = 60 AND action_code = 7091;
UPDATE forms_action SET action_code = 7142 WHERE form_id = 60 AND action_code = 7092;

-- Grants mirrored by migration 31 point at the old codes.
UPDATE role_assign SET action_id = 7141 WHERE form_id = 60 AND action_id = 7091;
UPDATE role_assign SET action_id = 7142 WHERE form_id = 60 AND action_id = 7092;

-- Down Migration

UPDATE role_assign SET action_id = 7092 WHERE form_id = 60 AND action_id = 7142;
UPDATE role_assign SET action_id = 7091 WHERE form_id = 60 AND action_id = 7141;

UPDATE forms_action SET action_code = 7092 WHERE form_id = 60 AND action_code = 7142;
UPDATE forms_action SET action_code = 7091 WHERE form_id = 60 AND action_code = 7141;

UPDATE form SET form_code = 709 WHERE id = 60 AND form_code = 714;
