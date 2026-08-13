-- Up Migration
--
-- PHASE 3 — raw items: cells and complete sets. (PLAN.md Phase 3, SPECS §3.3,
-- PRINCIPLES §3)
--
-- `raw_product` has always been one flat table for every loose part. That was
-- fine when "raw" meant "a box of anything", but cells are a catalog of their
-- own: many of them, each with a specification (capacity, voltage, physical
-- size, cell brand) that production and the Excel import both need to read.
--
-- Three shapes share the one table, discriminated by `part_type`:
--
--   CELL           + capacity (mAh), voltage (V), size, cell brand
--   COMPLETE_SET   a kit of 1 casing + 1 PCB + 1 patra — explicitly NOT cells
--   OTHER          casing, PCB, patra, or anything else bought loose
--
-- Cell fields are constrained to CELL rows only, so a complete set cannot
-- silently carry a cell specification.

ALTER TABLE raw_product
    ADD COLUMN part_type         text NOT NULL DEFAULT 'OTHER',
    ADD COLUMN model             text,
    ADD COLUMN placement         text,
    ADD COLUMN cell_capacity_mah integer,
    ADD COLUMN cell_voltage      numeric(5,2),
    ADD COLUMN cell_size         text,
    ADD COLUMN cell_brand        text;

ALTER TABLE raw_product
    ADD CONSTRAINT raw_product_part_type_check
        CHECK (part_type IN ('CELL', 'COMPLETE_SET', 'OTHER')),
    ADD CONSTRAINT raw_product_placement_check
        CHECK (placement IS NULL OR placement IN ('INT', 'EXT')),
    ADD CONSTRAINT raw_product_cell_fields_check
        CHECK (
            part_type = 'CELL'
            OR (cell_capacity_mah IS NULL
                AND cell_voltage IS NULL
                AND cell_size IS NULL
                AND cell_brand IS NULL)
        );

COMMENT ON COLUMN raw_product.part_type IS
    'CELL | COMPLETE_SET | OTHER — three shapes sharing one table (SPECS §3.3).';
COMMENT ON COLUMN raw_product.cell_brand IS
    'The cell manufacturer (Samsung, LG, BAK) — free text, distinct from the app Brand list.';

-- Down Migration
ALTER TABLE raw_product
    DROP CONSTRAINT IF EXISTS raw_product_cell_fields_check,
    DROP CONSTRAINT IF EXISTS raw_product_placement_check,
    DROP CONSTRAINT IF EXISTS raw_product_part_type_check,
    DROP COLUMN IF EXISTS cell_brand,
    DROP COLUMN IF EXISTS cell_size,
    DROP COLUMN IF EXISTS cell_voltage,
    DROP COLUMN IF EXISTS cell_capacity_mah,
    DROP COLUMN IF EXISTS placement,
    DROP COLUMN IF EXISTS model,
    DROP COLUMN IF EXISTS part_type;
