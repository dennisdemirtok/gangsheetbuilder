-- The original database was created by hand and only baselined as 0_init,
-- so these parts of schema.prisma never made it into a migration. A database
-- built from the migrations alone (Railway, 2026-09-13) lacked them — most
-- visibly, an uploaded image could not exist before it was placed on a sheet.
-- IF NOT EXISTS keeps this harmless on the hand-built database.

ALTER TABLE "gangsheet_app_config" ALTER COLUMN "price_config" SET DEFAULT '{"58x100":349,"58x200":599,"58x300":849,"58x400":1099,"58x500":1299}';

ALTER TABLE "gangsheet_gang_sheet_image" ALTER COLUMN "gang_sheet_id" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "gangsheet_gang_sheet_shop_domain_status_idx" ON "gangsheet_gang_sheet"("shop_domain", "status");

CREATE INDEX IF NOT EXISTS "gangsheet_gang_sheet_shop_domain_created_at_idx" ON "gangsheet_gang_sheet"("shop_domain", "created_at");

CREATE INDEX IF NOT EXISTS "gangsheet_gang_sheet_export_created_at_idx" ON "gangsheet_gang_sheet_export"("created_at");

CREATE INDEX IF NOT EXISTS "gangsheet_gang_sheet_image_created_at_idx" ON "gangsheet_gang_sheet_image"("created_at");

CREATE INDEX IF NOT EXISTS "gangsheet_gang_sheet_image_bg_removed_idx" ON "gangsheet_gang_sheet_image"("bg_removed");
