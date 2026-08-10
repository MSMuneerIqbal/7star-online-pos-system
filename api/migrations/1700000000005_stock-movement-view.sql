-- Up Migration
--
-- Unified stock movement view.
--
-- Stock in this system moves through eight different document types across two
-- catalogs, and the legacy system had no single place that knew about all of
-- them — which is a large part of why the four stock reports were never built.
-- This view is that single place: every row is one movement of one item, with a
-- sign (+ in, - out), so both the Stock Report (sum) and the Item Ledger
-- (running balance) are simple queries over it.
--
-- `kind` distinguishes the two catalogs, because ids are NOT unique across
-- them: raw_product 15 and product 15 are different items.

CREATE VIEW stock_movement AS

-- ---------------------------------------------------------------------------
-- RAW materials
-- ---------------------------------------------------------------------------

-- Purchases bring raw stock in.
SELECT 'RAW'::text        AS kind,
       pd.pid             AS pid,
       pd.pname           AS pname,
       p.branch_id        AS branch_id,
       p.date             AS date,
       'PINV'::text       AS source,
       p.id               AS doc_id,
       pd.qty             AS qty,
       pd.price           AS price
FROM   purchase_detail pd
JOIN   purchase p ON p.id = pd.purchase_id

UNION ALL

-- Purchase returns send it back.
SELECT 'RAW', prd.pid, prd.pname, pr.branch_id, pr.date, 'PRINV', pr.id,
       -prd.qty, prd.price
FROM   purchase_return_detail prd
JOIN   purchase_return pr ON pr.id = prd.purchase_id

UNION ALL

-- Production consumes raw materials.
SELECT 'RAW', pdd.pid, pdd.pname, pr.branch_id, pr.date, 'PROD', pr.id,
       -pdd.qty, pdd.price
FROM   production_detail pdd
JOIN   production pr ON pr.id = pdd.inv_id

UNION ALL

-- Lab work consumes raw materials.
SELECT 'RAW', lu.pid, lu.pname, lu.bid, lu.date, 'LAB', lu.inv_id,
       -lu.qty, lu.price
FROM   lab_used lu

-- ---------------------------------------------------------------------------
-- FINISHED goods
-- ---------------------------------------------------------------------------

UNION ALL

-- Production creates finished goods.
SELECT 'FINISH', pr.pid, NULL, pr.branch_id, pr.date, 'PROD', pr.id,
       pr.qty::numeric, pr.per_unit
FROM   production pr

UNION ALL

-- Sales issue finished goods.
SELECT 'FINISH', sd.pid, sd.pname, s.branch_id, s.date, 'SINV', s.id,
       -sd.qty, sd.price
FROM   sale_detail sd
JOIN   sale s ON s.id = sd.sale_id

UNION ALL

-- Sale returns bring them back.
SELECT 'FINISH', srd.pid, srd.pname, sr.branch_id, sr.date, 'SRINV', sr.id,
       srd.qty, srd.price
FROM   sale_return_detail srd
JOIN   sale_return sr ON sr.id = srd.sale_id

-- ---------------------------------------------------------------------------
-- Inter-branch transfers move EITHER kind, so these two take it from the
-- document's `type` column rather than hard-coding it.
-- ---------------------------------------------------------------------------

UNION ALL

-- Despatch: stock leaves the sending branch. Only once actually despatched —
-- a pending request has not moved anything.
SELECT COALESCE(dr.type, 'RAW'), drd.pid, drd.pname, dr.from_branch, dr.date,
       'BTINV', dr.id, -drd.qty, drd.price
FROM   do_request_detail drd
JOIN   do_request dr ON dr.id = drd.inv_id
WHERE  dr.status IN ('DESPATCHED', 'RECEIVED')

UNION ALL

-- Receipt: stock arrives at the destination branch.
SELECT COALESCE(rc.type, 'RAW'), rcd.pid, rcd.pname, rc.to_branch, rc.date,
       'DORINV', rc.id, rcd.qty, rcd.price
FROM   do_received_detail rcd
JOIN   do_received rc ON rc.id = rcd.inv_id;

COMMENT ON VIEW stock_movement IS
  'Every stock movement across all document types. qty is signed: positive in, negative out. Use (kind, pid) as the item identity — ids are not unique across the two catalogs.';

-- Down Migration
DROP VIEW IF EXISTS stock_movement;
