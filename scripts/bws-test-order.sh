#!/usr/bin/env bash
# Creates and completes a TEST order on viwrsi-jk: one DTF 2 m sheet linked to
# an existing gang sheet + one heat press (not DTF). Completing it fires
# orders/paid, so the order shows up in the app admin with the BWS card and
# the "only DTF ships from Poland" warning.
#
#   bash scripts/bws-test-order.sh [gang_sheet_id]
set -euo pipefail

STORE=viwrsi-jk.myshopify.com
SHEET_ID="${1:-cmtyn9vdg0005ob3kvo4actvx}"
DTF_2M=gid://shopify/ProductVariant/57666583593334
HEAT_PRESS=gid://shopify/ProductVariant/58696113062262
TMP=$(mktemp -d)

cat > "$TMP/vars.json" <<EOF
{"input": {
  "email": "dennis@transfercraft.com",
  "note": "TEST BWS flow (DTF + heat press)",
  "tags": ["test", "bws-test"],
  "shippingAddress": {"firstName": "Dennis", "lastName": "Demirtok (TEST)", "address1": "Förrådsgatan 8", "zip": "85633", "city": "Sundsvall", "countryCode": "SE", "phone": "+46704411710"},
  "lineItems": [
    {"variantId": "$DTF_2M", "quantity": 1, "customAttributes": [{"key": "_gang_sheet_id", "value": "$SHEET_ID"}]},
    {"variantId": "$HEAT_PRESS", "quantity": 1}
  ]
}}
EOF

shopify store execute -s "$STORE" --allow-mutations -j --output-file "$TMP/draft.json" \
  --variable-file "$TMP/vars.json" \
  -q 'mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } } }' >/dev/null

DRAFT_ID=$(python3 -c "import json;d=json.load(open('$TMP/draft.json'));d=d.get('data',d);e=d['draftOrderCreate']['userErrors'];assert not e,e;print(d['draftOrderCreate']['draftOrder']['id'])")
echo "Draft: $DRAFT_ID"

shopify store execute -s "$STORE" --allow-mutations -j --output-file "$TMP/order.json" \
  -v "{\"id\": \"$DRAFT_ID\"}" \
  -q 'mutation($id: ID!) { draftOrderComplete(id: $id, paymentPending: false) { draftOrder { order { id name } } userErrors { field message } } }' >/dev/null

python3 -c "import json;d=json.load(open('$TMP/order.json'));d=d.get('data',d);p=d['draftOrderComplete'];assert not p['userErrors'],p['userErrors'];o=p['draftOrder']['order'];print('Order:',o['name'],o['id'])"
