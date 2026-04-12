-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "gangsheet_session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "access_token" TEXT NOT NULL,
    "user_id" BIGINT,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "account_owner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "email_verified" BOOLEAN DEFAULT false,
    "refresh_token" TEXT,
    "refresh_token_expires" TIMESTAMP(3),

    CONSTRAINT "gangsheet_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gangsheet_gang_sheet" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shopify_order_id" TEXT,
    "shopify_line_item_id" TEXT,
    "width_mm" INTEGER NOT NULL,
    "height_mm" INTEGER NOT NULL,
    "film_type" TEXT NOT NULL DEFAULT 'standard',
    "canvas_state_json" JSONB,
    "preview_url" TEXT,
    "export_url" TEXT,
    "export_pdf_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total_area_used" DOUBLE PRECISION,
    "images_count" INTEGER NOT NULL DEFAULT 0,
    "price_sek" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gangsheet_gang_sheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gangsheet_gang_sheet_image" (
    "id" TEXT NOT NULL,
    "gang_sheet_id" TEXT NOT NULL,
    "original_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "width_px" INTEGER NOT NULL,
    "height_px" INTEGER NOT NULL,
    "dpi_x" INTEGER,
    "dpi_y" INTEGER,
    "position_x" DOUBLE PRECISION,
    "position_y" DOUBLE PRECISION,
    "display_width" DOUBLE PRECISION,
    "display_height" DOUBLE PRECISION,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "flip_x" BOOLEAN NOT NULL DEFAULT false,
    "flip_y" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "bg_removed" BOOLEAN NOT NULL DEFAULT false,
    "bg_removed_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gangsheet_gang_sheet_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gangsheet_gang_sheet_export" (
    "id" TEXT NOT NULL,
    "gang_sheet_id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "file_size_bytes" INTEGER,
    "dpi" INTEGER NOT NULL DEFAULT 300,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gangsheet_gang_sheet_export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gangsheet_app_config" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "price_config" JSONB NOT NULL DEFAULT '{"60x60":199,"60x120":349,"60x150":449,"60x300":799,"60x600":1399}',
    "film_modifiers" JSONB NOT NULL DEFAULT '{"standard":1.0,"glitter":1.5,"glow":1.3,"gold_foil":1.8,"silver_foil":1.8}',
    "gap_size_mm" INTEGER NOT NULL DEFAULT 3,
    "min_dpi" INTEGER NOT NULL DEFAULT 150,
    "max_file_size_mb" INTEGER NOT NULL DEFAULT 50,
    "allowed_formats" JSONB NOT NULL DEFAULT '["png","jpg","jpeg","svg","pdf","tiff","tif"]',
    "auto_delete_days" INTEGER NOT NULL DEFAULT 90,
    "export_delete_days" INTEGER NOT NULL DEFAULT 30,
    "variant_mapping" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gangsheet_app_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gangsheet_gang_sheet_shopify_order_id_idx" ON "gangsheet_gang_sheet"("shopify_order_id");

-- CreateIndex
CREATE INDEX "gangsheet_gang_sheet_shop_domain_idx" ON "gangsheet_gang_sheet"("shop_domain");

-- CreateIndex
CREATE INDEX "gangsheet_gang_sheet_status_idx" ON "gangsheet_gang_sheet"("status");

-- CreateIndex
CREATE INDEX "gangsheet_gang_sheet_session_id_idx" ON "gangsheet_gang_sheet"("session_id");

-- CreateIndex
CREATE INDEX "gangsheet_gang_sheet_image_gang_sheet_id_idx" ON "gangsheet_gang_sheet_image"("gang_sheet_id");

-- CreateIndex
CREATE INDEX "gangsheet_gang_sheet_export_gang_sheet_id_idx" ON "gangsheet_gang_sheet_export"("gang_sheet_id");

-- CreateIndex
CREATE UNIQUE INDEX "gangsheet_app_config_shop_domain_key" ON "gangsheet_app_config"("shop_domain");

-- AddForeignKey
ALTER TABLE "gangsheet_gang_sheet_image" ADD CONSTRAINT "gangsheet_gang_sheet_image_gang_sheet_id_fkey" FOREIGN KEY ("gang_sheet_id") REFERENCES "gangsheet_gang_sheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gangsheet_gang_sheet_export" ADD CONSTRAINT "gangsheet_gang_sheet_export_gang_sheet_id_fkey" FOREIGN KEY ("gang_sheet_id") REFERENCES "gangsheet_gang_sheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

