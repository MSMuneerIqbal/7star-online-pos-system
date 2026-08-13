-- Up Migration
--
-- Phase 0 groundwork (PLAN.md) — move product.image_path out of the
-- database to file storage: a bytea in every product row drags binary data
-- through every catalog query.
--
-- Minimum scope for this pass: the column becomes a path, not a blob.
-- Nothing currently writes a real value here (catalog/routes.ts has always
-- hardcoded it to null), so USING NULL discards nothing. The upload
-- endpoint and form widget that actually populate a path are separate,
-- later work — there is no multipart/static-file plumbing in this codebase
-- yet to build them on.

ALTER TABLE product ALTER COLUMN image_path TYPE text USING NULL;

-- Down Migration
ALTER TABLE product ALTER COLUMN image_path TYPE bytea USING NULL;
