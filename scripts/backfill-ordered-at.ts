/**
 * Fill in ordered_at (Shopify's processedAt) on print jobs linked to an order
 * before the order intake stored it. Safe to run again: it only touches rows
 * where ordered_at is still empty. Dry run unless --apply.
 *
 *   npx tsx scripts/backfill-ordered-at.ts [--apply]
 */
import prisma from "../app/db.server";

const APPLY = process.argv.includes("--apply");

const missing = await prisma.$queryRaw<{ shop_domain: string; order_id: string }[]>`
  SELECT DISTINCT shop_domain, shopify_order_id AS order_id
  FROM gangsheet_gang_sheet
  WHERE shopify_order_id IS NOT NULL AND ordered_at IS NULL`;
console.log(`${missing.length} orders without ordered_at`);

const byShop = new Map<string, string[]>();
for (const r of missing) byShop.set(r.shop_domain, [...(byShop.get(r.shop_domain) ?? []), r.order_id]);

let updatedRows = 0;
const notFound: string[] = [];
for (const [shop, orderIds] of byShop) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) {
    console.log(`${shop}: no offline session, skipped ${orderIds.length} orders`);
    continue;
  }
  for (let i = 0; i < orderIds.length; i += 100) {
    const batch = orderIds.slice(i, i + 100);
    const res = await fetch(`https://${shop}/admin/api/2025-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({
        query: `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name createdAt processedAt } } }`,
        variables: { ids: batch.map((id) => `gid://shopify/Order/${id}`) },
      }),
    });
    const body = (await res.json()) as {
      data?: { nodes: ({ id: string; name: string; createdAt: string; processedAt: string | null } | null)[] };
      errors?: unknown;
    };
    if (!body.data) throw new Error(`Shopify: ${JSON.stringify(body.errors ?? body)}`);
    const found = new Map(
      body.data.nodes.filter((n) => n?.id).map((n) => [n!.id.split("/").pop()!, n!]),
    );
    for (const orderId of batch) {
      const order = found.get(orderId);
      if (!order) {
        notFound.push(orderId);
        continue;
      }
      const orderedAt = new Date(order.processedAt || order.createdAt);
      if (APPLY) {
        const { count } = await prisma.gangSheet.updateMany({
          where: { shopDomain: shop, shopifyOrderId: orderId, orderedAt: null },
          data: { orderedAt },
        });
        updatedRows += count;
      }
      if (i === 0 && batch.indexOf(orderId) < 5) console.log(`  ${order.name} ${orderId} -> ${orderedAt.toISOString()}`);
    }
  }
}

if (notFound.length) console.log(`Not found in Shopify (left empty, the list uses the sheet's date): ${notFound.join(", ")}`);
console.log(APPLY ? `Updated ${updatedRows} rows.` : "Dry run. Run with --apply.");
await prisma.$disconnect();
