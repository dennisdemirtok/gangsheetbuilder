-- Clothes (Stanley/Stella, B&C) dropshipped from Printgood: their own list, email and pickup.
CREATE TABLE "gangsheet_garment_order" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "order_name" TEXT,
    "customer_name" TEXT,
    "shipping_address" JSONB,
    "items" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "sent_to_supplier_at" TIMESTAMP(3),
    "sent_to_supplier_to" TEXT,
    "shipping_status" TEXT,
    "bws_booking_id" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "shipping_label_key" TEXT,
    "pickup_date" TEXT,
    "shipping_service" TEXT,
    "shipping_price" DOUBLE PRECISION,
    "shipping_currency" TEXT,
    "shipping_booked_at" TIMESTAMP(3),
    "shipping_error" TEXT,
    "shopify_fulfillment_id" TEXT,
    "fulfillment_error" TEXT,
    "shipped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gangsheet_garment_order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gangsheet_garment_order_shop_domain_shopify_order_id_key" ON "gangsheet_garment_order"("shop_domain", "shopify_order_id");

CREATE INDEX "gangsheet_garment_order_shop_domain_status_idx" ON "gangsheet_garment_order"("shop_domain", "status");
