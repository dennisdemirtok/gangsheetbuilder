-- When a parcel without a carrier scan was looked into; ends its daily reminder.
ALTER TABLE "gangsheet_gang_sheet" ADD COLUMN "shipment_checked_at" TIMESTAMP(3);
