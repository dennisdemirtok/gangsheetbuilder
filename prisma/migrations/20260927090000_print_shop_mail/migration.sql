-- Emailing an order to the print shop, and telling the customer production
-- has started.
ALTER TABLE "gangsheet_gang_sheet"
  ADD COLUMN "sent_to_print_shop_at" TIMESTAMP(3),
  ADD COLUMN "sent_to_print_shop_to" TEXT,
  ADD COLUMN "production_mail_sent_at" TIMESTAMP(3);
