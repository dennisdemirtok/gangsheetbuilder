import { useEditorStore } from "../../store/editorStore";
import { theme } from "../../styles/theme";

const SHEET_SIZES = [
  { key: "58x100", widthMm: 580, heightMm: 1000, label: "58 × 100 cm" },
  { key: "58x200", widthMm: 580, heightMm: 2000, label: "58 × 200 cm" },
  { key: "58x300", widthMm: 580, heightMm: 3000, label: "58 × 300 cm" },
  { key: "58x400", widthMm: 580, heightMm: 4000, label: "58 × 400 cm" },
  { key: "58x500", widthMm: 580, heightMm: 5000, label: "58 × 500 cm" },
];

const FILM_TYPES = [
  { key: "standard", label: "Standard" },
  { key: "glitter", label: "Glitter" },
  { key: "glow", label: "Glow-in-the-Dark" },
  { key: "gold_foil", label: "Gold Foil" },
  { key: "silver_foil", label: "Silver Foil" },
];

const chevronSvg = (color: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='${encodeURIComponent(color)}' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`;

export function PriceDisplay() {
  const { sheetSize, filmType, currentPrice, images, setSheetSize, setFilmType } =
    useEditorStore();

  const totalQuantity = images.reduce((sum, img) => sum + img.quantity, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: theme.space.lg }}>
      {/* Sheet size */}
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
            border: `1.5px solid ${theme.accent}`,
            borderRadius: theme.radiusSm,
            fontSize: theme.fontSize.bodySm,
            fontFamily: theme.fontFamily,
            fontWeight: theme.fontWeight.semibold,
            background: theme.accentBg,
            color: theme.accent,
            outline: "none",
            cursor: "pointer",
            appearance: "none",
            backgroundImage: chevronSvg(theme.accent),
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

      {/* Film type */}
      <div>
        <SectionLabel>Filmtyp</SectionLabel>
        <select
          value={filmType}
          onChange={(e) => setFilmType(e.target.value)}
          style={{
            width: "100%",
            padding: `${theme.space.md}px ${theme.space.lg}px`,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            fontSize: theme.fontSize.bodySm,
            fontFamily: theme.fontFamily,
            fontWeight: theme.fontWeight.medium,
            background: theme.bgInput,
            color: theme.text,
            outline: "none",
            cursor: "pointer",
            appearance: "none",
            backgroundImage: chevronSvg(theme.textDim),
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 12px center",
          }}
        >
          {FILM_TYPES.map((film) => (
            <option key={film.key} value={film.key}>
              {film.label}
            </option>
          ))}
        </select>
      </div>

      {/* Price card */}
      <div
        style={{
          padding: `${theme.space.xl}px ${theme.space.lg}px`,
          background: theme.accentBg,
          borderRadius: theme.radius,
          textAlign: "center",
        }}
      >
        <p style={{ margin: 0, fontSize: theme.fontSize.labelMd, fontWeight: theme.fontWeight.medium, color: theme.textMuted }}>
          Totalpris
        </p>
        <p
          style={{
            margin: `${theme.space.xs}px 0 0`,
            fontSize: theme.fontSize.headlineMd,
            fontWeight: theme.fontWeight.bold,
            letterSpacing: theme.letterSpacing.tight,
            color: theme.accent,
          }}
        >
          {currentPrice} kr
        </p>
        <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.labelSm, color: theme.textMuted }}>
          {images.length} design{images.length !== 1 ? "er" : ""} ({totalQuantity} st) | {sheetSize.label}
        </p>
      </div>
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
