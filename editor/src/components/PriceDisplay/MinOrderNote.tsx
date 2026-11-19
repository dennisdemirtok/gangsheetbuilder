import { BUSINESS_ACCOUNT_URL } from "../../services/shopSettings";
import { metres, type Shortfall } from "../../services/minOrder";
import { theme } from "../../styles/theme";

/**
 * "Minsta order är 300 kr" where the customer decides: above the add-to-cart
 * button and in the confirm dialog. Without it the cart's locked checkout
 * button was the first the customer heard of the minimum.
 */
export function MinOrderNote({
  shortfall,
  longer,
  onLengthen,
}: {
  shortfall: Shortfall;
  /** A single sheet long enough to reach the minimum, offered as one click. */
  longer?: { heightMm: number; price: number } | null;
  onLengthen?: () => void;
}) {
  const { min, missing, inCart } = shortfall;
  return (
    <div role="status" style={S.box}>
      <div>
        <strong>Minsta order är {min} kr.</strong>{" "}
        {inCart > 0
          ? `Med det du redan har i varukorgen fattas ${missing} kr till kassan.`
          : `Det fattas ${missing} kr till kassan.`}
      </div>
      <div style={S.row}>
        {longer && onLengthen ? (
          <>
            <button type="button" onClick={onLengthen} style={S.button}>
              Gör arket {metres(longer.heightMm)} · {longer.price} kr
            </button>
            <span>eller lägg till fler produkter.</span>
          </>
        ) : (
          <span>Gör arket längre eller lägg till fler produkter i samma order.</span>
        )}
      </div>
      <div style={S.small}>
        Företagskonto har inget minimum.{" "}
        <a href={BUSINESS_ACCOUNT_URL} target="_blank" rel="noopener" style={S.link}>
          Ansök här
        </a>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  box: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "10px 12px",
    borderRadius: theme.radiusSm,
    background: theme.warningBg,
    border: `1px solid ${theme.warning}40`,
    color: theme.text,
    fontSize: theme.fontSize.labelMd,
    lineHeight: 1.4,
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
  button: {
    padding: "5px 10px",
    border: `1px solid ${theme.warning}`,
    borderRadius: theme.radiusSm,
    background: theme.bgCard,
    color: theme.warning,
    fontWeight: theme.fontWeight.semibold,
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.labelMd,
    cursor: "pointer",
  },
  small: { fontSize: theme.fontSize.labelSm, color: theme.textMuted },
  link: { color: theme.textMuted, textDecoration: "underline" },
};
