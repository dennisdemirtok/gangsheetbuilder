import { useCallback, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { uploadImage, getAppProxyUrl, ensureGangSheet } from "../../services/api";
import { pxToMm } from "../../utils/units";
import { theme } from "../../styles/theme";
import { showToast } from "../../utils/toast";

export function ImageUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const { sessionId, gangSheetId, sheetSize, filmType, gapMm, addImage, setUploading, setGangSheetId } = useEditorStore();

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

      // Three at a time: 40 logos one by one used to take minutes.
      const queue = Array.from(files);
      let done = 0;
      setUploadProgress(`0/${total}`);
      const uploadOne = async (file: File) => {
        console.log("[GS] Uploading:", file.name, file.size, "bytes");
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
          // Cap both width and height (keep aspect ratio) so an image
          // can never be created taller than the sheet
          const maxHeightMm = Math.max(1, sheetSize.heightMm - 20);
          const scale = Math.min(
            1,
            maxDisplayMm / naturalWidthMm,
            maxHeightMm / naturalHeightMm,
          );

          // Prepend appProxyUrl to relative image paths
          const base = getAppProxyUrl();
          const thumbUrl = result.thumbnailUrl.startsWith("/")
            ? base + result.thumbnailUrl
            : result.thumbnailUrl;
          const origUrl = result.originalUrl.startsWith("/")
            ? base + result.originalUrl
            : result.originalUrl;

          // positionX/Y are placeholders — addImage finds a free spot so
          // designs never land on top of each other.
          addImage({
            id: result.imageId || result.id,
            dbId: result.id,
            groupId: "grp_" + Math.random().toString(36).slice(2, 10),
            filename: result.filename,
            thumbnailUrl: thumbUrl,
            originalUrl: origUrl,
            widthPx: result.width,
            heightPx: result.height,
            dpiX: result.dpiX || 72,
            dpiY: result.dpiY || 72,
            positionX: 0,
            positionY: 0,
            displayWidth: naturalWidthMm * scale,
            displayHeight: naturalHeightMm * scale,
            rotation: 0,
            flipX: false,
            flipY: false,
            quantity: 1,
            marginMm: gapMm,
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
            `${file.name}: uppladdningen misslyckades (${(err as Error).message})`,
            "error",
          );
        } finally {
          done++;
          setUploadProgress(`${done}/${total}`);
        }
      };
      const worker = async () => {
        while (queue.length > 0) await uploadOne(queue.shift()!);
      };
      await Promise.all(Array.from({ length: Math.min(3, total) }, worker));

      setUploadProgress(null);
      setUploading(false);
    },
    [sessionId, gangSheetId, sheetSize, filmType, gapMm, addImage, setUploading, setGangSheetId],
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
          PNG, JPG, SVG, TIFF, PDF, EPS, WebP — Max 500 MB
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
          <span>Laddar upp {uploadProgress}</span>
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

export { showToast };
