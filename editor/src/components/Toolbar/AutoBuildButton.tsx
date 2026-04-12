import { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { autoBuild } from "../../services/api";
import { theme } from "../../styles/theme";

export function AutoBuildButton() {
  const {
    gangSheetId,
    sheetSize,
    images,
    isAutoBuilding,
    setAutoBuilding,
    applyAutoBuild,
    setSheetSize,
  } = useEditorStore();

  const [lastResult, setLastResult] = useState<{
    placed: number;
    overflow: number;
    utilization: number;
    suggestedSize?: string;
  } | null>(null);

  const handleAutoBuild = async () => {
    if (images.length === 0) return;

    setAutoBuilding(true);
    setLastResult(null);

    try {
      const result = await autoBuild({
        gangSheetId: gangSheetId || "",
        sheetWidthMm: sheetSize.widthMm,
        sheetHeightMm: sheetSize.heightMm,
        gapMm: 3,
      });

      applyAutoBuild(result.placements);

      setLastResult({
        placed: result.placements.length,
        overflow: result.overflow?.length || 0,
        utilization: Math.round((result.utilization || 0) * 100),
        suggestedSize: result.suggestedSize,
      });

      if (result.overflow?.length > 0 && result.suggestedSize) {
        // Show suggestion but don't auto-switch
      }
    } catch (err) {
      console.error("Auto build failed:", err);
      alert("Auto-arrangemang misslyckades. Försök igen.");
    } finally {
      setAutoBuilding(false);
    }
  };

  const disabled = isAutoBuilding || images.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        onClick={handleAutoBuild}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "10px 14px",
          fontSize: 13,
          fontWeight: 600,
          border: `1.5px solid ${disabled ? theme.border : theme.accent}`,
          borderRadius: theme.radius,
          background: isAutoBuilding ? theme.accent : "transparent",
          color: isAutoBuilding
            ? "#fff"
            : disabled
              ? theme.textDim
              : theme.accent,
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "all 0.2s",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {isAutoBuilding && <Spinner />}
        {isAutoBuilding ? "Arrangerar..." : "Auto Build"}
      </button>

      {/* Result feedback */}
      {lastResult && (
        <div
          style={{
            padding: "6px 10px",
            borderRadius: theme.radiusSm,
            background:
              lastResult.overflow > 0 ? theme.warningBg : theme.successBg,
            fontSize: 11,
            color: lastResult.overflow > 0 ? theme.warning : theme.success,
          }}
        >
          {lastResult.overflow > 0 ? (
            <span>
              {lastResult.placed} placerade, {lastResult.overflow} fick inte plats.
              {lastResult.suggestedSize && (
                <> Prova {lastResult.suggestedSize}.</>
              )}
            </span>
          ) : (
            <span>
              {lastResult.placed} placerade ({lastResult.utilization}% utnyttjat)
            </span>
          )}
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
