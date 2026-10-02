-- Waiting on the customer: an order on hold while they fix their files.
ALTER TABLE "gangsheet_gang_sheet" ADD COLUMN "awaiting_customer_since" TIMESTAMP(3),
ADD COLUMN "awaiting_customer_note" TEXT;
