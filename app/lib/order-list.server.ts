import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { DisplayStatus, OrderStatus } from "./order-status";

/**
 * The print shop works per Shopify order, not per print job.
 *
 * Every printed line is its own job (an order with four cut motifs is four
 * rows in the database), and the lists used to show exactly that: #1011
 * four times in a row. These queries group the jobs by order. An order is
 * as far along as its least advanced job — it is not "printed" until every
 * job is.
 */

const RANK: Record<OrderStatus, number> = {
  draft: 0,
  pending: 1,
  exported: 2,
  downloaded: 3,
  printed: 4,
  shipped: 5,
};
const STATUS_BY_RANK = Object.fromEntries(
  Object.entries(RANK).map(([s, r]) => [r, s as OrderStatus]),
) as Record<number, OrderStatus>;

const RANK_SQL = Prisma.sql`min(CASE status
  WHEN 'pending' THEN 1 WHEN 'exported' THEN 2 WHEN 'downloaded' THEN 3
  WHEN 'printed' THEN 4 WHEN 'shipped' THEN 5 ELSE 0 END)`;

function ordersCte(shopDomain: string) {
  return Prisma.sql`
    WITH o AS (
      SELECT shopify_order_id AS order_id,
             min(created_at) AS created_at,
             max(order_name) AS order_name,
             max(customer_name) AS customer_name,
             count(*)::int AS jobs,
             ${RANK_SQL}::int AS rank,
             bool_or(awaiting_customer_since IS NOT NULL) AS awaiting,
             (array_agg(id ORDER BY created_at))[1] AS first_id
      FROM gangsheet_gang_sheet
      WHERE shop_domain = ${shopDomain} AND shopify_order_id IS NOT NULL
      GROUP BY shopify_order_id
    )`;
}

export interface OrderRow {
  orderId: string;
  firstId: string;
  createdAt: Date;
  orderName: string | null;
  customerName: string | null;
  jobs: number;
  status: DisplayStatus;
}

/**
 * "all"; "open" = anything not shipped; "awaiting" = on hold for the
 * customer; or one production status. An order on hold is listed under
 * "awaiting" only, so it does not show up as ready to print meanwhile.
 */
function statusFilter(status: string) {
  if (status === "all") return Prisma.sql`TRUE`;
  if (status === "open") return Prisma.sql`rank BETWEEN 1 AND 4`;
  if (status === "awaiting") return Prisma.sql`awaiting AND rank BETWEEN 1 AND 4`;
  const rank = RANK[status as OrderStatus];
  if (rank === undefined) return Prisma.sql`TRUE`;
  return rank === RANK.shipped
    ? Prisma.sql`rank = ${rank}`
    : Prisma.sql`rank = ${rank} AND NOT awaiting`;
}

export async function listOrders(options: {
  shopDomain: string;
  status: string;
  query?: string;
  page?: number;
  pageSize?: number;
  oldestFirst?: boolean;
}): Promise<{ rows: OrderRow[]; total: number }> {
  const { shopDomain, status, query = "", page = 1, pageSize = 20 } = options;
  const q = query.trim();
  const digits = q.replace(/^#/, "");
  const search = q
    ? Prisma.sql`AND (order_name ILIKE ${`%${digits}%`} OR customer_name ILIKE ${`%${q}%`} OR order_id = ${digits})`
    : Prisma.empty;
  const where = Prisma.sql`WHERE ${statusFilter(status)} ${search}`;
  const order = options.oldestFirst ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const [rows, total] = await Promise.all([
    prisma.$queryRaw<
      { order_id: string; first_id: string; created_at: Date; order_name: string | null; customer_name: string | null; jobs: number; rank: number; awaiting: boolean }[]
    >`${ordersCte(shopDomain)}
      SELECT * FROM o ${where}
      ORDER BY created_at ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw<{ n: number }[]>`${ordersCte(shopDomain)}
      SELECT count(*)::int AS n FROM o ${where}`,
  ]);

  return {
    rows: rows.map((r) => ({
      orderId: r.order_id,
      firstId: r.first_id,
      createdAt: r.created_at,
      orderName: r.order_name,
      customerName: r.customer_name,
      jobs: r.jobs,
      status: r.awaiting && r.rank < RANK.shipped ? "awaiting" : STATUS_BY_RANK[r.rank] ?? "pending",
    })),
    total: total[0]?.n ?? 0,
  };
}

/** Orders per tab (see statusFilter), plus "open" and "all". */
export async function orderStatusCounts(shopDomain: string): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ rank: number; awaiting: boolean; n: number }[]>`${ordersCte(shopDomain)}
    SELECT rank, awaiting, count(*)::int AS n FROM o GROUP BY rank, awaiting`;
  const counts: Record<string, number> = { all: 0, open: 0, awaiting: 0 };
  for (const { rank, awaiting, n } of rows) {
    const status = STATUS_BY_RANK[rank];
    const onHold = awaiting && rank >= 1 && rank <= 4;
    const key = onHold ? "awaiting" : status;
    if (key) counts[key] = (counts[key] ?? 0) + n;
    counts.all += n;
    if (rank >= 1 && rank <= 4) counts.open += n;
  }
  return counts;
}

/** The status of one order, from its jobs. */
export function orderStatusOf(jobs: { status: string }[]): OrderStatus {
  const rank = Math.min(...jobs.map((j) => RANK[j.status as OrderStatus] ?? 0));
  return STATUS_BY_RANK[Number.isFinite(rank) ? rank : 1] ?? "pending";
}

/** All jobs of the given orders, for summaries. */
export function jobsOfOrders(shopDomain: string, orderIds: string[]) {
  return prisma.gangSheet.findMany({
    where: { shopDomain, shopifyOrderId: { in: orderIds } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      shopifyOrderId: true,
      orderName: true,
      customerName: true,
      shippingAddress: true,
      kind: true,
      printType: true,
      filmType: true,
      widthMm: true,
      heightMm: true,
      lineQuantity: true,
      status: true,
      createdAt: true,
    },
  });
}
