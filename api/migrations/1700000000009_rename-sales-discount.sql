-- Up Migration
--
-- Name 4020101 for what it now is.
--
-- It was called plain "Discount" while it carried BOTH sales and purchase
-- discount — the legacy behaviour where the two netted off and neither figure
-- was recoverable (db/accounts.md §4.2). Purchase discount now has its own
-- account (4020102), so leaving this one ambiguously named would invite
-- someone to post purchase discount back into it and undo the split.

UPDATE account
SET    name = 'Sales Discount'
WHERE  account_id = 4020101
  AND  name = 'Discount';

-- Down Migration
UPDATE account
SET    name = 'Discount'
WHERE  account_id = 4020101
  AND  name = 'Sales Discount';
