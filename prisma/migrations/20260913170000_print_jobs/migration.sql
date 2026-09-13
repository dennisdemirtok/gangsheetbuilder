-- Print jobs that are not app-built gang sheets (DTF Transfers By Size, cut
-- per design) and the print type of every job.
ALTER TABLE "gangsheet_gang_sheet"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'gang_sheet',
  ADD COLUMN "print_type" TEXT,
  ADD COLUMN "product_title" TEXT,
  ADD COLUMN "variant_title" TEXT,
  ADD COLUMN "line_quantity" INTEGER,
  ADD COLUMN "line_properties" JSONB,
  ADD COLUMN "source_file_url" TEXT;

CREATE INDEX "gangsheet_gang_sheet_shop_domain_shopify_line_item_id_idx"
  ON "gangsheet_gang_sheet"("shop_domain", "shopify_line_item_id");
