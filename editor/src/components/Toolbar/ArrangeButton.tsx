import { useEditorStore } from "../../store/editorStore";
import { theme } from "../../styles/theme";

/**
 * The one "tidy my sheet" control. There used to be two buttons a few
 * centimetres apart — "Auto Build" (server nesting) and "Ordna om tätt"
 * (local packing) — which looked like a choice but wasn't one.
 */
export function ArrangeButton() {
  const { images, isAutoBuilding, lastArrange, arrangeSheet } = useEditorStore();
  const disabled = isAutoBuilding || images.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        onClick={() => void arrangeSheet()}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "10px 14px",
          fontSize: 13,
          fontWeight: 600,
          fontFamily: theme.fontFamily,
          border: `1.5px solid ${disabled ? theme.border : theme.accent}`,
          borderRadius: theme.radius,
          background: isAutoBuilding ? theme.accent : "transparent",
          color: isAutoBuilding ? "#fff" : disabled ? theme.textDim : theme.accent,
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "all 0.2s",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {isAutoBuilding && <Spinner />}
        {isAutoBuilding ? "Ordnar..." : "Ordna om arket"}
      </button>

      {lastArrange && lastArrange.overflow > 0 && (
        <div
          style={{
            padding: "6px 10px",
            borderRadius: theme.radiusSm,
            background: theme.warningBg,
            fontSize: 11,
            color: theme.warning,
          }}
        >
          {lastArrange.overflow} motiv fick inte plats. Välj ett längre ark.
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 14,
        height: 14,
        border: `2px solid rgba(255,255,255,0.3)`,
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "gs-spin 0.8s linear infinite",
      }}
    />
  );
}
