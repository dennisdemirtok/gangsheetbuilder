import { useCallback, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { uploadImage, getAppProxyUrl, ensureGangSheet } from "../../services/api";
import { pxToMm } from "../../utils/units";
import { theme } from "../../styles/theme";

export function ImageUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const { sessionId, gangSheetId, sheetSize, filmType, addImage, setUploading, setGangSheetId } = useEditorStore();

  const handleFiles = useCallback(
    async (files: FileList) => {
      console.log("[GS] handleFiles called, files:", files.length);
      setUploading(true);
      const total = files.length;

      // Ensure gangSheet exists before uploading
      let gsId = gangSheetId;
      try {
        gsId = await ensureGangSheet(sessionId, sheetSize.widthMm, sheetSize.heightMm, filmType, gangSheetId);
        if (gsId !== gangSheetId) setGangSheetId(gsId);
      } catch (err) {
        console.error("Failed to create gang sheet:", err);
      }

      for (let i = 0; i < total; i++) {
        const file = files[i]!;
        console.log("[GS] Uploading:", file.name, file.size, "bytes");
        setUploadProgress(`${i + 1}/${total}: ${file.name}`);

        try {
          const result = await uploadImage(
            file,
            sessionId,
            gsId || "",
          );
          console.log("[GS] Upload result:", result);

          const dpi = result.dpiX || 72;
          const naturalWidthMm = pxToMm(result.width, dpi);
          const naturalHeightMm = pxToMm(result.height, dpi);
          const maxDisplayMm = 100;
          const scale = Math.min(1, maxDisplayMm / naturalWidthMm);

          // Prepend appProxyUrl to relative image paths
          const base = getAppProxyUrl();
          const thumbUrl = result.thumbnailUrl.startsWith("/")
            ? base + result.thumbnailUrl
            : result.thumbnailUrl;
          const origUrl = result.originalUrl.startsWith("/")
            ? base + result.originalUrl
            : result.originalUrl;

          addImage({
            id: result.imageId || result.id,
            dbId: result.id,
            filename: result.filename,
            thumbnailUrl: thumbUrl,
            originalUrl: origUrl,
            widthPx: result.width,
            heightPx: result.height,
            dpiX: result.dpiX || 72,
            dpiY: result.dpiY || 72,
            positionX: 10,
            positionY: 10,
            displayWidth: naturalWidthMm * scale,
            displayHeight: naturalHeightMm * scale,
            rotation: 0,
            flipX: false,
            flipY: false,
            quantity: 1,
            marginMm: 5,
            bgRemoved: result.hasAlpha || false,
            hasWhiteBackground: result.hasWhiteBackground || false,
            placed: true,
          });

          // Show warnings from server
          if (result.warnings && result.warnings.length > 0) {
            for (const warning of result.warnings) {
              showToast(warning, "warning");
            }
          }
        } catch (err) {
          console.error("Upload failed:", err);
          showToast(
            `Uppladdning misslyckades: ${(err as Error).message}`,
            "error",
          );
        }
      }

      setUploadProgress(null);
      setUploading(false);
    },
    [sessionId, gangSheetId, addImage, setUploading],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${isDragOver ? theme.accent : theme.border}`,
          borderRadius: theme.radius,
          padding: "16px 12px",
          textAlign: "center",
          cursor: "pointer",
          background: isDragOver ? theme.accentBg : theme.bgCard,
          transition: "all 0.2s",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/svg+xml,image/tiff,image/webp,application/pdf,.eps,.ai"
          style={{ display: "none" }}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
        <div
          style={{
            width: 36,
            height: 36,
            margin: "0 auto 8px",
            borderRadius: 8,
            background: theme.bgInput,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            color: theme.accent,
          }}
        >
          +
        </div>
        <p style={{ margin: 0, fontSize: 13, color: theme.text }}>
          Dra bilder hit eller klicka
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 11, color: theme.textDim }}>
          PNG, JPG, SVG, TIFF, PDF, EPS, WebP — Max 50 MB
        </p>
      </div>

      {uploadProgress && (
        <div
          style={{
            padding: "8px 12px",
            background: theme.accentBg,
            borderRadius: theme.radiusSm,
            fontSize: 12,
            color: theme.accent,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Spinner />
          <span>{uploadProgress}</span>
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
        border: `2px solid ${theme.accent}40`,
        borderTopColor: theme.accent,
        borderRadius: "50%",
        animation: "gs-spin 0.8s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

/**
 * Simple toast notification — appends to body and auto-removes.
 */
function showToast(message: string, type: "warning" | "error" | "info") {
  const colors = {
    warning: { bg: "#fef3c7", border: "#fbbf24", text: "#92400e" },
    error: { bg: "#fef2f2", border: "#f87171", text: "#991b1b" },
    info: { bg: "#eff6ff", border: "#60a5fa", text: "#1e40af" },
  };
  const c = colors[type];

  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; top: 16px; right: 16px; z-index: 9999;
    padding: 12px 16px; max-width: 360px;
    background: ${c.bg}; border: 1px solid ${c.border}; color: ${c.text};
    border-radius: 8px; font-size: 13px; font-family: system-ui;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: gs-toast-in 0.3s ease-out;
  `;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}
