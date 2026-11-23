import "@shopify/ui-extensions/preact";
import { render } from "preact";

/**
 * Order page in the customer account: the customer's own prints.
 *
 * The order's lines say only "Gang sheet per meter", so customers could not
 * see which prints an order holds while it was on its way. This shows each
 * sheet's picture and links to /apps/gangsheet/mina-tryck, where the signed-in
 * customer sees every motif and can download the files.
 */
export default async () => {
  render(<OrderPrints />, document.body);
};

const PRINT_KEYS = ["_gang_sheet_id", "_preview_url", "Motiv", "_sheet_size", "Längd"];
const PRINT_TITLE = /gang ?sheet|dtf|tryck|ark|by size|sheet/i;

function OrderPrints() {
  const order = shopify.order.value;
  const lines = shopify.lines.value || [];
  const printLines = lines.filter(
    (line) =>
      line.attributes.some((a) => PRINT_KEYS.includes(a.key)) ||
      PRINT_TITLE.test(line.merchandise.title || ""),
  );
  if (!order || order.cancelledAt || printLines.length === 0) return null;

  const pictures = printLines
    .map((line) => line.attributes.find((a) => a.key === "_preview_url" || a.key === "Motiv")?.value)
    .filter((url): url is string => Boolean(url && /^https:\/\//.test(url)))
    .slice(0, 6);

  const base = (shopify.shop.storefrontUrl || "https://transfercraft.com").replace(/\/$/, "");
  const orderNo = order.name.replace(/^#/, "");
  const href = `${base}/apps/gangsheet/mina-tryck?order=${encodeURIComponent(orderNo)}`;

  return (
    <s-section heading="Dina tryck">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Se vilka tryck som ingår i beställningen och ladda ned dina filer.
        </s-paragraph>
        {pictures.length > 0 && (
          <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
            {pictures.map((src) => (
              <s-box border="base" borderRadius="base" padding="small-200">
                <s-image src={src} alt="Ditt tryck" aspectRatio="1" objectFit="contain" loading="lazy" />
              </s-box>
            ))}
          </s-grid>
        )}
        <s-button href={href} target="_blank" variant="primary">
          Visa och ladda ned dina tryck
        </s-button>
      </s-stack>
    </s-section>
  );
}
