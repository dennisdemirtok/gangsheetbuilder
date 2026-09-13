/**
 * The life of a gang sheet order, from the print shop's point of view.
 *
 * Status labels used to be defined separately on the dashboard, the order
 * list and the order page — three copies that drifted, so "Skickad" existed
 * on two of them and not the third. They live here once.
 *
 * Labels are English: the print shop is in Poland, and the rest of the
 * Shopify admin they work in is English too.
 */

export type OrderStatus =
  | "draft"
  | "pending"
  | "exported"
  | "downloaded"
  | "printed"
  | "shipped";

type Tone = "info" | "success" | "warning" | "attention" | "critical" | undefined;

interface StatusInfo {
  label: string;
  tone: Tone;
  /** What the shop should do next, shown where it helps them act. */
  hint: string;
}

export const ORDER_STATUS: Record<OrderStatus, StatusInfo> = {
  draft: {
    label: "Draft",
    tone: undefined,
    hint: "Not ordered yet.",
  },
  pending: {
    label: "Preparing file",
    tone: "attention",
    hint: "Paid. The print file is being generated.",
  },
  exported: {
    label: "Ready to print",
    tone: "success",
    hint: "Download the print file and print it.",
  },
  downloaded: {
    label: "Downloaded",
    tone: "info",
    hint: "File downloaded. Mark as printed when done.",
  },
  printed: {
    label: "Printed",
    tone: "warning",
    hint: "Printed. Add a tracking number and mark as shipped.",
  },
  shipped: {
    label: "Shipped",
    tone: undefined,
    hint: "On its way to the customer.",
  },
};

export function statusInfo(status: string): StatusInfo {
  return (
    ORDER_STATUS[status as OrderStatus] ?? {
      label: status,
      tone: undefined,
      hint: "",
    }
  );
}

/** Statuses that still need the print shop to do something. */
export const OPEN_STATUSES: OrderStatus[] = [
  "pending",
  "exported",
  "downloaded",
  "printed",
];

/** Filter options for the order list, in workflow order. */
export const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: "To do", value: "open" },
  { label: "All", value: "all" },
  { label: "Preparing file", value: "pending" },
  { label: "Ready to print", value: "exported" },
  { label: "Downloaded", value: "downloaded" },
  { label: "Printed", value: "printed" },
  { label: "Shipped", value: "shipped" },
];

/** "1 order", "3 orders". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 days ago". Computed in the loader
 * and sent as text, so server and browser render the same string.
 */
export function timeAgo(date: Date | string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(date).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** Sheet size as the shop talks about it: "58 × 50 cm". */
export function sheetSize(sheet: { widthMm: number; heightMm: number }): string {
  return `${sheet.widthMm / 10} × ${sheet.heightMm / 10} cm`;
}

/** "#1002" when we have it, else the raw Shopify id for older records. */
export function orderLabel(sheet: {
  orderName?: string | null;
  shopifyOrderId?: string | null;
}): string {
  if (sheet.orderName) return sheet.orderName;
  if (sheet.shopifyOrderId) return `#${sheet.shopifyOrderId}`;
  return "—";
}

/** "1002_58x50cm.png" — what the print shop sees in their downloads folder. */
export function printFileName(
  sheet: { orderName?: string | null; shopifyOrderId?: string | null; id: string; widthMm: number; heightMm: number },
  ext: string,
): string {
  const order = (sheet.orderName || sheet.shopifyOrderId || sheet.id.slice(0, 8))
    .replace(/^#/, "")
    .replace(/[^\w.\-]+/g, "_");
  return `${order}_${sheet.widthMm / 10}x${sheet.heightMm / 10}cm.${ext}`;
}
