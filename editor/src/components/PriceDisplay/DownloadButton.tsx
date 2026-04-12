import { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { getAppProxyUrl } from "../../services/api";
import { theme } from "../../styles/theme";

/**
 * Export the gang sheet as a 300 DPI PNG via the backend.
 * The backend uses Sharp to composite images at full resolution,
 * NOT a canvas screenshot which is only screen resolution.
 */
export function DownloadButton() {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState("");
  const { images, sheetSize, sessionId, gangSheetId } = useEditorStore();

  const handleDownload = async () => {
    if (images.length === 0) return;
    setIsExporting(true);
    setProgress("Förbereder export...");

    try {
      const base = getAppProxyUrl();

      // Step 1: Save current state to backend
      setProgress("Sparar layout...");
      if (gangSheetId) {
        await fetch(`${base}/api/gang-sheet/${gangSheetId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            widthMm: sheetSize.widthMm,
            heightMm: sheetSize.heightMm,
            images: images.map((img) => ({
              id: img.dbId || img.id,
              positionX: img.positionX,
              positionY: img.positionY,
              displayWidth: img.displayWidth,
              displayHeight: img.displayHeight,
              rotation: img.rotation,
              flipX: img.flipX,
              flipY: img.flipY,
              quantity: img.quantity,
            })),
          }),
        });
      }

      // Step 2: Request 300 DPI export from backend
      setProgress("Exporterar 300 DPI PNG...");
      const exportRes = await fetch(`${base}/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gangSheetId,
          sessionId,
          images: images.map((img) => ({
            dbId: img.dbId || img.id,
            originalUrl: img.originalUrl,
            bgRemovedUrl: img.bgRemovedUrl,
            positionX: img.positionX,
            positionY: img.positionY,
            displayWidth: img.displayWidth,
            displayHeight: img.displayHeight,
            rotation: img.rotation,
            flipX: img.flipX,
            flipY: img.flipY,
            quantity: img.quantity,
          })),
          sheetWidthMm: sheetSize.widthMm,
          sheetHeightMm: sheetSize.heightMm,
        }),
      });

      if (!exportRes.ok) {
        const err = await exportRes.json().catch(() => ({}));
        throw new Error(err.error || "Export misslyckades");
      }

      // Step 3: Download the exported PNG
      setProgress("Laddar ned...");
      const blob = await exportRes.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `gangsheet-${sheetSize.key}-300dpi-${Date.now()}.png`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setProgress("Klar!");
      setTimeout(() => setProgress(""), 2000);
    } catch (err) {
      console.error("Export failed:", err);
      alert(`Export misslyckades: ${(err as Error).message}`);
      setProgress("");
    } finally {
      setIsExporting(false);
    }
  };

  const disabled = isExporting || images.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <button
        onClick={handleDownload}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "10px 16px",
          fontSize: 13,
          fontWeight: 600,
          border: `1.5px solid ${disabled ? theme.border : theme.success}`,
          borderRadius: theme.radius,
          background: disabled ? "transparent" : theme.successBg,
          color: disabled ? theme.textDim : theme.success,
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "all 0.2s",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        {isExporting ? progress : "↓ Ladda ned 300 DPI PNG"}
      </button>
    </div>
  );
}
