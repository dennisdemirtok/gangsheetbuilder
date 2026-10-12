-- Combine an order's cut jobs into one gang sheet from the order page.
ALTER TABLE "gangsheet_gang_sheet" ADD COLUMN "merged_into_id" TEXT;

CREATE INDEX "gangsheet_gang_sheet_merged_into_id_idx" ON "gangsheet_gang_sheet"("merged_into_id");
