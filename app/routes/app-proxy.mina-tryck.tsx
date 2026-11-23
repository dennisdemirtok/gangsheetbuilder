import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { customerPrintOrders, type CustomerPrintOrder } from "../lib/customer-prints.server";

/**
 * /apps/gangsheet/mina-tryck — a signed-in customer's prints, per order.
 *
 * Rendered as Liquid inside the shop's theme. The customer is Shopify's
 * signed logged_in_customer_id, so nobody sees another customer's files.
 * ?order=1252 shows one order (the link from the account's order page).
 */

const PATH = "/apps/gangsheet/mina-tryck";

/** Escape for HTML, and keep Liquid from reading a file name as a tag. */
function h(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/%/g, "&#37;");
}

const STATUS: Record<string, string> = {
  FULFILLED: "Skickad",
  IN_PROGRESS: "Under behandling",
  PARTIALLY_FULFILLED: "Delvis skickad",
  UNFULFILLED: "Under produktion",
  ON_HOLD: "Pausad",
  SCHEDULED: "Planerad",
};

const STYLE = `
<style>
.tc-prints{max-width:1100px;margin:0 auto;padding:40px 20px 80px;font-size:16px}
.tc-prints h1{margin:0 0 6px}
.tc-prints .lead{opacity:.75;margin:0 0 28px}
.tc-prints .order{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:20px;margin:0 0 24px;background:#fff}
.tc-prints .order-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:14px}
.tc-prints .order-head h2{margin:0;font-size:1.3em}
.tc-prints .badge{display:inline-block;padding:3px 10px;border-radius:99px;background:#eef2ff;font-size:.85em}
.tc-prints .job{display:grid;grid-template-columns:minmax(120px,220px) 1fr;gap:20px;padding:16px 0;border-top:1px solid rgba(0,0,0,.08)}
.tc-prints .job:first-of-type{border-top:0}
.tc-prints .sheet{width:100%;max-height:420px;object-fit:contain;object-position:top;background:repeating-conic-gradient(#f1f1f1 0 25%,#fff 0 50%) 0 0/16px 16px;border:1px solid rgba(0,0,0,.08);border-radius:8px}
.tc-prints .job h3{margin:0 0 4px;font-size:1.1em}
.tc-prints .muted{opacity:.7;font-size:.9em}
.tc-prints ul.motifs{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.tc-prints ul.motifs li{display:flex;gap:10px;align-items:center;border:1px solid rgba(0,0,0,.08);border-radius:8px;padding:8px}
.tc-prints ul.motifs img{width:56px;height:56px;object-fit:contain;flex:none;background:repeating-conic-gradient(#f1f1f1 0 25%,#fff 0 50%) 0 0/10px 10px;border-radius:4px}
.tc-prints .mname{font-weight:600;word-break:break-word;font-size:.92em}
.tc-prints a.dl{display:inline-block;margin-top:3px;font-size:.88em}
.tc-prints a.btn{display:inline-block;margin-top:10px;padding:8px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-size:.9em}
@media (max-width:640px){.tc-prints .job{grid-template-columns:1fr}}
</style>`;

function page(body: string): string {
  return `${STYLE}<div class="tc-prints">${body}</div>`;
}

export function renderOrders(orders: CustomerPrintOrder[], single: boolean): string {
  const parts: string[] = [];
  parts.push(`<h1>${single && orders[0] ? `Tryck i order ${h(orders[0].name)}` : "Mina tryck"}</h1>`);
  parts.push(
    `<p class="lead">Här ser du vilka tryck du har beställt och kan ladda ned dina filer. ${
      single ? `<a href="${PATH}">Visa alla beställningar →</a>` : ""
    }</p>`,
  );
  if (orders.length === 0) {
    parts.push(`<p>Vi hittar inga tryck på ${single ? "den här beställningen" : "dina beställningar"} ännu.</p>`);
    return page(parts.join(""));
  }
  for (const order of orders) {
    const date = new Date(order.createdAt).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
    parts.push(`<section class="order" id="order-${h(order.name.replace(/^#/, ""))}">`);
    parts.push(
      `<div class="order-head"><h2>Order ${h(order.name)}</h2><span class="muted">${h(date)} · <span class="badge">${h(
        STATUS[order.fulfillment] || order.fulfillment,
      )}</span></span></div>`,
    );
    for (const job of order.jobs) {
      parts.push(`<div class="job"><div>`);
      if (job.previewUrl) {
        parts.push(`<a href="${h(job.previewUrl)}" target="_blank" rel="noopener"><img class="sheet" src="${h(job.previewUrl)}" alt="${h(job.title)}" loading="lazy"></a>`);
      }
      parts.push(`</div><div><h3>${h(job.title)}</h3>`);
      const meta = [job.size, job.quantity > 1 ? `${job.quantity} st` : null, job.motifs.length > 1 ? `${job.motifs.length} motiv` : null].filter(Boolean);
      if (meta.length) parts.push(`<div class="muted">${h(meta.join(" · "))}</div>`);
      if (job.trackingUrl) parts.push(`<a class="dl" href="${h(job.trackingUrl)}" target="_blank" rel="noopener">Spåra paketet →</a>`);
      if (job.motifs.length) {
        parts.push(`<ul class="motifs">`);
        for (const m of job.motifs) {
          parts.push(
            `<li>${m.thumbUrl ? `<img src="${h(m.thumbUrl)}" alt="" loading="lazy">` : ""}<div><div class="mname">${h(m.name)}</div><div class="muted">${h(
              [m.size, `${m.quantity} st`].filter(Boolean).join(" · "),
            )}</div><a class="dl" href="${h(m.download)}">Ladda ned fil</a></div></li>`,
          );
        }
        parts.push(`</ul>`);
      } else if (job.download) {
        parts.push(`<a class="btn" href="${h(job.download.url)}" target="_blank" rel="noopener">Ladda ned fil</a>`);
      }
      parts.push(`</div></div>`);
    }
    parts.push(`</section>`);
  }
  return page(parts.join(""));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, admin, session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const order = url.searchParams.get("order");
  const headers = { "Cache-Control": "private, no-store" };

  if (!customerId) {
    const back = `${PATH}${order ? `?order=${encodeURIComponent(order)}` : ""}`;
    return liquid(
      page(
        `<h1>Mina tryck</h1><p class="lead">Logga in för att se vilka tryck du har beställt.</p><a class="btn" href="/customer_authentication/login?return_to=${encodeURIComponent(back)}">Logga in</a>`,
      ),
      { headers },
    );
  }
  if (!admin || !session) {
    return liquid(page(`<h1>Mina tryck</h1><p>Sidan är inte tillgänglig just nu. Försök igen om en stund.</p>`), { headers });
  }

  try {
    const orders = await customerPrintOrders(admin, session.shop, customerId, order);
    return liquid(renderOrders(orders, Boolean(order)), { headers });
  } catch (error) {
    console.error("[mina-tryck]", error);
    return liquid(page(`<h1>Mina tryck</h1><p>Något gick fel när dina tryck skulle hämtas. Försök igen om en stund.</p>`), { headers });
  }
};
