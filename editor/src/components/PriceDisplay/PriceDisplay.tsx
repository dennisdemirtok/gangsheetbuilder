import { useEditorStore, getSheetsTotalPrice, totalText, groupImages } from "../../store/editorStore";
import { theme } from "../../styles/theme";
import { MAX_SHEET_MM, MIN_SHEET_MM, SHEET_STEP_MM, sheetForHeight } from "../../config/sheets";
import { getSheetPrice } from "../../services/storefrontPrices";




/**
 * Sheet length. It follows the designs by itself — longer when they need
 * room, a shorter one offered when they fit — and the customer can add or
 * take away film in 10 cm steps. A dropdown of whole metres used to make
 * 1,3 m of designs cost 2 m.
 */
export function PriceDisplay() {
  const { sheetSize, setSheetSize } = useEditorStore();
  const step = (deltaMm: number) => {
    const next = sheetForHeight(sheetSize.heightMm + deltaMm);
    if (next.heightMm !== sheetSize.heightMm) setSheetSize(next);
  };
  const price = getSheetPrice(sheetSize.key);
  const atMin = sheetSize.heightMm <= MIN_SHEET_MM;
  const atMax = sheetSize.heightMm >= MAX_SHEET_MM;
  const meters = (sheetSize.heightMm / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: theme.space.sm }}>
      <SectionLabel>Arklängd</SectionLabel>
      <div style={L.row}>
        <button
          onClick={() => step(-SHEET_STEP_MM)}
          disabled={atMin}
          style={{ ...L.stepBtn, opacity: atMin ? 0.35 : 1 }}
          title="10 cm kortare"
          aria-label="10 cm kortare"
        >
          −
        </button>
        <div style={L.value}>
          <span style={L.meters}>{meters} m</span>
          <span style={L.sub}>58 × {Math.round(sheetSize.heightMm / 10)} cm{price !== null ? ` · ${price} kr` : ""}</span>
        </div>
        <button
          onClick={() => step(SHEET_STEP_MM)}
          disabled={atMax}
          style={{ ...L.stepBtn, opacity: atMax ? 0.35 : 1 }}
          title="10 cm längre"
          aria-label="10 cm längre"
        >
          +
        </button>
      </div>
      <p style={L.hint}>Längden följer motiven. Du betalar per påbörjad decimeter, minst 1 meter.</p>
    </div>
  );
}

const L: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "stretch",
    gap: 6,
  },
  stepBtn: {
    width: 40,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusSm,
    background: theme.bgCard,
    color: theme.text,
    fontSize: 18,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
    flexShrink: 0,
  },
  value: {
    flex: 1,
    minWidth: 0,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusSm,
    background: theme.bgCard,
    padding: "6px 10px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  meters: {
    fontSize: theme.fontSize.bodyMd,
    fontWeight: theme.fontWeight.bold,
    color: theme.text,
  },
  sub: {
    fontSize: theme.fontSize.labelSm,
    color: theme.textMuted,
  },
  hint: {
    margin: 0,
    fontSize: theme.fontSize.labelSm,
    color: theme.textDim,
    lineHeight: 1.4,
  },
};

/**
 * Price bar — rendered separately at the bottom of right sidebar
 */
export function PriceBar() {
  const { sheetSize, filmType, sheets, prices, images, activeSheetIndex } = useEditorStore();
  // Each sheet is priced with its OWN size/film — × its quantity; empty sheets excluded
  const totalPrice = getSheetsTotalPrice(sheets, prices, sheetSize, filmType, activeSheetIndex, images.length);

  return (
    <div
      style={{
        padding: `${theme.space.md}px ${theme.space.lg}px`,
        background: theme.bgDark,
        borderRadius: theme.radiusSm,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <span style={{ fontSize: theme.fontSize.labelMd, color: "rgba(255,255,255,0.6)" }}>Totalt</span>
        <p style={{ margin: "2px 0 0", fontSize: theme.fontSize.labelSm, color: "rgba(255,255,255,0.4)" }}>
          {sheetSize.label}
        </p>
      </div>
      <span
        style={{
          fontSize: theme.fontSize.headlineMd,
          fontWeight: theme.fontWeight.bold,
          color: "#fff",
          letterSpacing: theme.letterSpacing.tight,
        }}
      >
        {totalText(totalPrice, sheets, activeSheetIndex, images.length)}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: theme.fontSize.labelSm,
        fontWeight: theme.fontWeight.semibold,
        textTransform: "uppercase",
        letterSpacing: theme.letterSpacing.wide,
        marginBottom: theme.space.sm,
        color: theme.textMuted,
      }}
    >
      {children}
    </label>
  );
}
