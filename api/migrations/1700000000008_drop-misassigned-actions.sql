-- Up Migration
--
-- Remove action codes assigned to the wrong form.
--
-- The legacy _Layout.cshtml contained three cross-form typos, where a screen
-- was gated on an action code belonging to a different form:
--
--   (19, 5071)  form 19 is Receiving Request (Raw, code 503);
--               5071 belongs to form 39, Branch Transfer (code 507)
--   (22, 5024)  form 22 is Receiving Request (Finish, code 506);
--   (22, 5025)  502x belongs to form 18, DO Request (Raw)
--
-- Migration 1700000000003 seeded them deliberately, so that grants migrated
-- from the legacy database would keep behaving identically. This installation
-- starts with fresh books and no imported grants, so there is nothing to
-- preserve — and the rewrite's own screens never check these pairs.
--
-- Left in place they would appear in the Role Assignment matrix as extra
-- actions under the wrong screen, so an administrator could tick a permission
-- that grants nothing. Removing them makes the matrix mean what it says.

DELETE FROM role_assign
WHERE (form_id, action_id) IN ((19, 5071), (22, 5024), (22, 5025));

DELETE FROM forms_action
WHERE (form_id, action_code) IN ((19, 5071), (22, 5024), (22, 5025));

-- Down Migration
INSERT INTO forms_action (form_id, action_name, sr, action_code) VALUES
    (19, 'Extra', 1, 5071),
    (22, 'Delete', 4, 5024),
    (22, 'Print', 5, 5025)
ON CONFLICT DO NOTHING;
