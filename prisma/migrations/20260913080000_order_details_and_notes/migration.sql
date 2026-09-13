-- Details the print shop needs to actually complete a job.
--
-- The order list showed the numeric Shopify id because the human order
-- number was never stored, and the detail page had no recipient at all, so
-- a sheet could be printed but not posted. Notes give the shop and the
-- store somewhere to talk about a job.
ALTER TABLE "gangsheet_gang_sheet"
  ADD COLUMN "order_name" TEXT,
  ADD COLUMN "customer_name" TEXT,
  ADD COLUMN "shipping_address" JSONB,
  ADD COLUMN "tracking_number" TEXT,
  ADD COLUMN "shipped_at" TIMESTAMP(3);

CREATE TABLE "gangsheet_gang_sheet_note" (
  "id" TEXT NOT NULL,
  "gang_sheet_id" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gangsheet_gang_sheet_note_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gangsheet_gang_sheet_note_gang_sheet_id_idx"
  ON "gangsheet_gang_sheet_note"("gang_sheet_id");

ALTER TABLE "gangsheet_gang_sheet_note"
  ADD CONSTRAINT "gangsheet_gang_sheet_note_gang_sheet_id_fkey"
  FOREIGN KEY ("gang_sheet_id") REFERENCES "gangsheet_gang_sheet"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
