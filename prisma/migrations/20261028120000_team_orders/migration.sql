-- Team orders (lagpaket): shirts from New Wave, digits from stock, logos printed in Poland.
CREATE TABLE "gangsheet_team_order" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "order_name" TEXT,
    "customer_name" TEXT,
    "team" TEXT,
    "shipping_address" JSONB,
    "shirts" JSONB NOT NULL,
    "digits" JSONB NOT NULL,
    "logos" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "new_wave_ordered_at" TIMESTAMP(3),
    "new_wave_reference" TEXT,
    "digits_packed_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "tracking_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gangsheet_team_order_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gangsheet_team_order_shop_domain_shopify_order_id_key" ON "gangsheet_team_order"("shop_domain", "shopify_order_id");

CREATE INDEX "gangsheet_team_order_shop_domain_status_idx" ON "gangsheet_team_order"("shop_domain", "status");

-- Where the print shop sends a team order's logos.
ALTER TABLE "gangsheet_app_config" ADD COLUMN "team_ship_to" JSONB;
