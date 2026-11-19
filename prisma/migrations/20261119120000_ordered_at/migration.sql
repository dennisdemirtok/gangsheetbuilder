-- When the customer placed the order. created_at is when the sheet was started in the builder.
ALTER TABLE "gangsheet_gang_sheet" ADD COLUMN "ordered_at" TIMESTAMP(3);
