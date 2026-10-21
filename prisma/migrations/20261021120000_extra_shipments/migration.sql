-- A second BWS pickup on an order, e.g. a reprint after a complaint: no customer or print shop email.
-- CreateTable
CREATE TABLE "gangsheet_extra_shipment" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "reason" TEXT,
    "recipient" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'booking',
    "bws_booking_id" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "shipping_label_key" TEXT,
    "pickup_date" TEXT NOT NULL,
    "shipping_service" TEXT,
    "weight_kg" DOUBLE PRECISION NOT NULL,
    "shipping_price" DOUBLE PRECISION,
    "shipping_currency" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gangsheet_extra_shipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gangsheet_extra_shipment_shop_domain_shopify_order_id_idx" ON "gangsheet_extra_shipment"("shop_domain", "shopify_order_id");

