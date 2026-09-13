-- BWS courier booking per order: pickup in Poland, label and tracking
-- returned by the ShippingOrders API.
ALTER TABLE "gangsheet_gang_sheet"
  ADD COLUMN "shipping_status" TEXT,
  ADD COLUMN "bws_booking_id" TEXT,
  ADD COLUMN "tracking_url" TEXT,
  ADD COLUMN "shipping_label_key" TEXT,
  ADD COLUMN "pickup_date" TEXT,
  ADD COLUMN "shipping_error" TEXT,
  ADD COLUMN "shipping_booked_at" TIMESTAMP(3),
  ADD COLUMN "shopify_fulfillment_id" TEXT,
  ADD COLUMN "fulfillment_error" TEXT,
  -- Presses/blanks on the same order: not shipped from Poland, not in the booking.
  ADD COLUMN "other_line_items" JSONB;
