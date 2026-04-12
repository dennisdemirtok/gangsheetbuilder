import { useEditorStore } from "../../store/editorStore";
import { theme } from "../../styles/theme";

const SHEET_SIZES = [
  { key: "58x100", widthMm: 580, heightMm: 1000, label: "1 meter (58×100 cm)", meters: 1 },
  { key: "58x200", widthMm: 580, heightMm: 2000, label: "2 meter (58×200 cm)", meters: 2 },
  { key: "58x300", widthMm: 580, heightMm: 3000, label: "3 meter (58×300 cm)", meters: 3 },
  { key: "58x400", widthMm: 580, heightMm: 4000, label: "4 meter (58×400 cm)", meters: 4 },
  { key: "58x500", widthMm: 580, heightMm: 5000, label: "5 meter (58×500 cm)", meters: 5 },
];

const chevronSvg = (color: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='${encodeURIComponent(color)}' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`;

export function PriceDisplay() {
  const { sheetSize, currentPrice, images, sheets, setSheetSize } =
    useEditorStore();

  const totalQuantity = images.reduce((sum, img) => sum + img.quantity, 0);
  const totalSheets = sheets?.length || 1;
  const totalPrice = totalSheets > 1
    ? sheets.reduce((sum, s) => sum + (currentPrice * s.quantity), 0)
    : currentPrice;

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

      {/* Summary info */}
      <div style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Designs</span>
          <span style={{ fontWeight: theme.fontWeight.semibold, color: theme.text }}>{images.length} st</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Totalt motiv</span>
          <span style={{ fontWeight: theme.fontWeight.semibold, color: theme.text }}>{totalQuantity} st</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Antal ark</span>
          <span style={{ fontWeight: theme.fontWeight.semibold, color: theme.text }}>{totalSheets} st</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Price bar — rendered separately at the bottom of right sidebar
 */
export function PriceBar() {
  const { currentPrice, sheetSize, sheets } = useEditorStore();
  const totalSheets = sheets?.length || 1;
  const totalPrice = totalSheets > 1
    ? sheets.reduce((sum, s) => sum + (currentPrice * s.quantity), 0)
    : currentPrice;

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
        {totalPrice} kr
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
