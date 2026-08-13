-- Up Migration
--
-- PHASE 9 — the document-counter fan-out trigger also needs the WARRANTY type
-- (migration 1700000000024 added the type to existing branches but not to the
-- trigger, so a branch created afterwards would miss its WARRANTY counter).

DROP TRIGGER IF EXISTS trg_document_counter_from_branch ON branch;
DROP FUNCTION IF EXISTS document_counter_fanout_from_branch();

CREATE FUNCTION document_counter_fanout_from_branch() RETURNS trigger
LANGUAGE plpgsql AS $fanout_branch$
BEGIN
    IF NEW.id = 0 OR NOT NEW.is_active THEN
        RETURN NEW;
    END IF;

    INSERT INTO document_counter (branch_id, doc_type)
    SELECT NEW.id, t.doc_type
    FROM (VALUES
        ('SALE_WALKIN'), ('SALE_CREDIT'), ('SALE_RETURN'),
        ('PURCHASE'), ('PURCHASE_RETURN'), ('HOLD_SALE'),
        ('PRODUCTION'), ('DEMAND_ORDER'), ('LAB'), ('LAB_RECEIVED'),
        ('DISPATCH'), ('RECEIPT'), ('REMITTANCE'), ('WARRANTY')
    ) AS t(doc_type)
    ON CONFLICT (branch_id, doc_type) DO NOTHING;

    RETURN NEW;
END;
$fanout_branch$;

CREATE TRIGGER trg_document_counter_from_branch
    AFTER INSERT OR UPDATE OF is_active ON branch
    FOR EACH ROW EXECUTE FUNCTION document_counter_fanout_from_branch();

-- Down Migration
DROP TRIGGER IF EXISTS trg_document_counter_from_branch ON branch;
DROP FUNCTION IF EXISTS document_counter_fanout_from_branch();

CREATE FUNCTION document_counter_fanout_from_branch() RETURNS trigger
LANGUAGE plpgsql AS $fanout_branch$
BEGIN
    IF NEW.id = 0 OR NOT NEW.is_active THEN
        RETURN NEW;
    END IF;

    INSERT INTO document_counter (branch_id, doc_type)
    SELECT NEW.id, t.doc_type
    FROM (VALUES
        ('SALE_WALKIN'), ('SALE_CREDIT'), ('SALE_RETURN'),
        ('PURCHASE'), ('PURCHASE_RETURN'), ('HOLD_SALE'),
        ('PRODUCTION'), ('DEMAND_ORDER'), ('LAB'), ('LAB_RECEIVED'),
        ('DISPATCH'), ('RECEIPT'), ('REMITTANCE')
    ) AS t(doc_type)
    ON CONFLICT (branch_id, doc_type) DO NOTHING;

    RETURN NEW;
END;
$fanout_branch$;

CREATE TRIGGER trg_document_counter_from_branch
    AFTER INSERT OR UPDATE OF is_active ON branch
    FOR EACH ROW EXECUTE FUNCTION document_counter_fanout_from_branch();
