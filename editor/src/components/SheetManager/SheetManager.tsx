import { useEditorStore } from "../../store/editorStore";
import { theme } from "../../styles/theme";

/**
 * Multi-sheet manager — shows active sheets, allows adding/removing.
 * Each sheet can have its own set of designs, size, and quantity.
 */
export function SheetManager() {
  const {
    sheets,
    activeSheetIndex,
    images,
    switchSheet,
    addSheet,
    removeSheet,
    duplicateSheet,
    setSheetQuantity,
  } = useEditorStore();

  if (!sheets || sheets.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: theme.space.sm }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: theme.fontSize.labelSm,
            fontWeight: theme.fontWeight.semibold,
            textTransform: "uppercase",
            letterSpacing: theme.letterSpacing.wide,
            color: theme.textMuted,
          }}
        >
          Ark ({sheets.length})
        </span>
      </div>

      {sheets.map((sheet, idx) => {
        const active = idx === activeSheetIndex;
        return (
          <div
            key={sheet.id}
            onClick={() => switchSheet(idx)}
            style={{
              padding: `${theme.space.md}px`,
              background: active ? theme.bgCard : theme.bgInput,
              borderRadius: theme.radius,
              cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: active ? theme.shadow : "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.fontSize.bodySm,
                    fontWeight: theme.fontWeight.semibold,
                    color: active ? theme.text : theme.textMuted,
                  }}
                >
                  {sheet.name || `Ark ${idx + 1}`}
                </p>
                <p
                  style={{
                    margin: `2px 0 0`,
                    fontSize: theme.fontSize.labelMd,
                    color: theme.textDim,
                  }}
                >
                  {idx === activeSheetIndex ? images.length : sheet.imageCount} designs | {sheet.size}
                </p>
              </div>
              {active && (
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: theme.accent,
                    flexShrink: 0,
                  }}
                />
              )}
            </div>

            {/* Quantity + actions */}
            <div
              style={{
                marginTop: theme.space.sm,
                display: "flex",
                alignItems: "center",
                gap: theme.space.sm,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <span style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted }}>Antal:</span>
              <input
                type="number"
                min={1}
                max={50}
                value={sheet.quantity}
                onChange={(e) => setSheetQuantity(idx, parseInt(e.target.value) || 1)}
                style={{
                  width: 44,
                  padding: "3px 4px",
                  border: `1px solid ${theme.border}`,
                  borderRadius: theme.radiusSm,
                  fontSize: theme.fontSize.labelMd,
                  fontFamily: theme.fontFamily,
                  textAlign: "center",
                  background: theme.bgInput,
                  color: theme.text,
                }}
              />
              <button
                onClick={() => duplicateSheet(idx)}
                style={{
                  fontSize: theme.fontSize.labelXs,
                  padding: "3px 8px",
                  border: `1px solid ${theme.border}`,
                  borderRadius: theme.radiusSm,
                  background: "transparent",
                  color: theme.textMuted,
                  cursor: "pointer",
                  fontFamily: theme.fontFamily,
                }}
              >
                Kopiera
              </button>
              {sheets.length > 1 && (
                <button
                  onClick={() => removeSheet(idx)}
                  style={{
                    fontSize: theme.fontSize.labelXs,
                    padding: "3px 8px",
                    border: `1px solid ${theme.border}`,
                    borderRadius: theme.radiusSm,
                    background: "transparent",
                    color: theme.danger,
                    cursor: "pointer",
                    fontFamily: theme.fontFamily,
                  }}
                >
                  Ta bort
                </button>
              )}
            </div>
          </div>
        );
      })}

      <button
        onClick={addSheet}
        style={{
          width: "100%",
          padding: `${theme.space.md}px`,
          fontSize: theme.fontSize.labelMd,
          fontWeight: theme.fontWeight.semibold,
          fontFamily: theme.fontFamily,
          border: `1px dashed ${theme.border}`,
          borderRadius: theme.radius,
          background: "transparent",
          color: theme.textMuted,
          cursor: "pointer",
          transition: "all 0.15s",
        }}
      >
        + Lägg till nytt ark
      </button>
    </div>
  );
}
