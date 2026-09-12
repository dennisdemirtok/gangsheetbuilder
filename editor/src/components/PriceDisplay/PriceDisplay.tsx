import { useEditorStore, getSheetsTotalPrice, groupImages } from "../../store/editorStore";
import { theme } from "../../styles/theme";
import { SHEET_SIZES } from "../../config/sheets";



const chevronSvg = (color: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='${encodeURIComponent(color)}' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`;

export function PriceDisplay() {
  const { sheetSize, images, sheets, setSheetSize } = useEditorStore();

  const groups = groupImages(images);
  const totalCopies = images.length;
  const totalSheets = sheets?.length || 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: theme.space.lg }}>
      {/* Sheet size — dropdown */}
      <div>
        <SectionLabel>Arkstorlek</SectionLabel>
        <select
          value={sheetSize.key}
          onChange={(e) => {
            const size = SHEET_SIZES.find((s) => s.key === e.target.value);
            if (size) setSheetSize(size);
          }}
          style={{
            width: "100%",
            padding: `${theme.space.md}px ${theme.space.lg}px`,
            border: `1px solid ${theme.borderStrong}`,
            borderRadius: theme.radiusSm,
            fontSize: theme.fontSize.bodyMd,
            fontFamily: theme.fontFamily,
            fontWeight: theme.fontWeight.medium,
            background: theme.bgCard,
            color: theme.text,
            outline: "none",
            cursor: "pointer",
            appearance: "none",
            backgroundImage: chevronSvg(theme.textDim as string),
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 12px center",
          }}
        >
          {SHEET_SIZES.map((size) => (
            <option key={size.key} value={size.key}>
              {size.label}
            </option>
          ))}
        </select>
      </div>

    </div>
  );
}

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
        {totalPrice !== null ? `${totalPrice} kr` : "—"}
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
