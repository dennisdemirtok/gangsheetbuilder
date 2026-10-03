import { useCallback, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { uploadImage, getAppProxyUrl, ensureGangSheet } from "../../services/api";
import { pxToMm } from "../../utils/units";
import { theme } from "../../styles/theme";
import { showToast } from "../../utils/toast";

/** One file on its way up, as listed under the drop zone. */
interface QueueItem {
  key: string;
  name: string;
  sent: number;
  processing: boolean;
  status: "uploading" | "done" | "failed";
}

/** `compact`: one slim line under the panel's "Lägg till motiv" button. */
export function ImageUploader({ compact = false }: { compact?: boolean } = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const patch = (key: string, p: Partial<QueueItem>) =>
    setQueueItems((items) => items.map((i) => (i.key === key ? { ...i, ...p } : i)));
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
      const queue = Array.from(files).map((file) => ({
        file,
        key: `${file.name}_${Math.random().toString(36).slice(2, 8)}`,
      }));
      setQueueItems((items) => [
        ...items.filter((i) => i.status === "uploading"),
        ...queue.map(({ file, key }) => ({ key, name: file.name, sent: 0, processing: false, status: "uploading" as const })),
      ]);
      const uploadOne = async ({ file, key }: { file: File; key: string }) => {
        console.log("[GS] Uploading:", file.name, file.size, "bytes");
        try {
          const result = await uploadImage(file, sessionId, gsId || "", (p) =>
            patch(key, { sent: p.sent, processing: p.phase === "processing" }),
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
          patch(key, { status: "done", processing: false, sent: 1 });
        } catch (err) {
          console.error("Upload failed:", err);
          patch(key, { status: "failed", processing: false });
          showToast(
            `${file.name}: uppladdningen misslyckades (${(err as Error).message})`,
            "error",
          );
        }
      };
      const worker = async () => {
        while (queue.length > 0) await uploadOne(queue.shift()!);
      };
      await Promise.all(Array.from({ length: Math.min(3, total) }, worker));

      setUploading(false);
      // Finished rows stay a moment so the customer sees them complete.
      window.setTimeout(() => setQueueItems((items) => items.filter((i) => i.status === "uploading")), 2500);
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
          border: `${compact ? 1.5 : 2}px dashed ${isDragOver ? theme.accent : theme.borderStrong}`,
          borderRadius: compact ? 12 : theme.radius,
          padding: compact ? "10px 12px" : "16px 12px",
          textAlign: "center",
          cursor: "pointer",
          background: isDragOver ? theme.accentBg : theme.bgCard,
          transition: "all 0.2s",
          ...(compact ? { display: "flex", alignItems: "center", justifyContent: "center", gap: 8 } : null),
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
        {compact ? (
          <span style={{ fontSize: 12.5, color: theme.textMuted }}>
            <span style={{ color: theme.accent, fontWeight: 700 }}>+</span> Släpp filer här för att lägga dem direkt på arket
          </span>
        ) : (
          <>
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
              PNG, JPG, SVG, TIFF, PDF, EPS, WebP. Max 500 MB
            </p>
          </>
        )}
      </div>

      {queueItems.length > 0 && (
        <div style={Q.list} aria-live="polite">
          {queueItems.map((item) => (
            <div key={item.key} style={Q.item}>
              <div style={Q.head}>
                {item.status === "uploading" ? <Spinner /> : <span style={{ color: item.status === "done" ? theme.success : theme.danger, fontWeight: 700 }}>{item.status === "done" ? "✓" : "!"}</span>}
                <span style={Q.name}>{item.name}</span>
                <span style={Q.state}>
                  {item.status === "failed"
                    ? "Misslyckades"
                    : item.status === "done"
                      ? "Klar"
                      : item.processing
                        ? "Bearbetar…"
                        : `${Math.round(item.sent * 100)} %`}
                </span>
              </div>
              {item.status === "uploading" && (
                <div style={Q.track}>
                  <div style={{ ...Q.fill, width: `${Math.max(4, Math.round((item.processing ? 1 : item.sent) * 100))}%`, ...(item.processing ? Q.shimmer : null) }} />
                </div>
              )}
            </div>
          ))}
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

const Q: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", gap: 6 },
  item: { padding: "8px 10px", background: theme.bgCard, border: `1px solid ${theme.border}`, borderRadius: 10 },
  head: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 },
  name: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: theme.text },
  state: { color: theme.textMuted, fontVariantNumeric: "tabular-nums", flexShrink: 0 },
  track: { height: 4, borderRadius: 2, background: "#eceef1", overflow: "hidden", marginTop: 6 },
  fill: { height: "100%", background: theme.accent, borderRadius: 2, transition: "width 0.25s ease" },
  shimmer: {
    backgroundImage: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)",
    backgroundSize: "200% 100%",
    animation: "gs-shimmer 1.1s linear infinite",
  },
};

export { showToast };
