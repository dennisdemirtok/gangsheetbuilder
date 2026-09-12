-- Explicit per-copy placements for a design.
--
-- Copies used to be implied by `quantity` and laid out by a grid computed
-- at export time, which ignored every other design on the sheet and could
-- print motifs on top of each other. The editor now decides each copy's
-- position, so store them and print exactly what the customer arranged.
-- NULL keeps the legacy quantity-grid behaviour for existing rows.
ALTER TABLE "gangsheet_gang_sheet_image"
  ADD COLUMN "placements_json" JSONB;
