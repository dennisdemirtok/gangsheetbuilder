-- Missed delivery: tell the customer the morning after the carrier failed to deliver.
ALTER TABLE "gangsheet_gang_sheet" ADD COLUMN "delivered_at" TIMESTAMP(3),
ADD COLUMN "missed_delivery_mail_sent_at" TIMESTAMP(3);
