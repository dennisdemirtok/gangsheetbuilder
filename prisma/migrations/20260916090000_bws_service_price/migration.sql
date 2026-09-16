-- Which BWS service the shop booked and what BWS charged for it. Their rate
-- API is not on our production subscription, so the price is only known from
-- the booking response.
ALTER TABLE "gangsheet_gang_sheet"
  ADD COLUMN "shipping_service" TEXT,
  ADD COLUMN "shipping_price" DOUBLE PRECISION,
  ADD COLUMN "shipping_currency" TEXT;
