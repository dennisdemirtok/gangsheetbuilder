import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeReadySheet,
  presignReadySheet,
  uploadReadySheetToStorage,
  type ReadySheetAnalysis,
} from "../../services/api";
import { getPerDecimeterVariant } from "../../services/storefrontPrices";
import { getDpiColor } from "../../utils/units";
import { theme } from "../../styles/theme";

/**
 * Upload a sheet that is already laid out.
 *
 * This used to be ~400 lines of vanilla JS inside the theme block, with its
 * own copy of pricing and cart logic. That is why a hardcoded 20 kr/dm
 * survived here long after the builder started reading Shopify's prices.
 * It now shares the editor's services, so there is one place to change a
 * price or a cart rule.
 */

/** One metre is the smallest order — film is cut from a roll. */
const MIN_DECIMETERS = 10;

interface Sheet {
  key: string;
  filename: string;
  thumbnail: string | null;
  analysis: ReadySheetAnalysis;
  meters: number;
  qty: number;
}

/**
 * Price per decimetre, taken from the very variant the cart will bill.
 *
 * Deriving it from the metre variant instead looked equivalent and was not:
 * the cart then billed a different variant, and a sheet shown at 200 kr was
 * charged at 2000. Price and line item come from one object now, so they
 * cannot disagree — and when that object is missing the flow refuses to
 * quote rather than guessing.
 */
function pricePerDm(): number | null {
  return getPerDecimeterVariant()?.priceSek ?? null;
}

function billedDecimeters(meters: number): number {
  return Math.max(MIN_DECIMETERS, Math.ceil(meters * 10));
}

function sheetPrice(meters: number): number | null {
  const rate = pricePerDm();
  return rate === null ? null : billedDecimeters(meters) * rate;
}

/** Scale the chosen file down rather than holding a 500 MB decode in memory. */
function makeThumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 460 / img.naturalWidth);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export function ReadySheetModal({ onClose }: { onClose: () => void }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [rejected, setRejected] = useState<{
    filename: string;
    thumbnail: string | null;
    analysis: ReadySheetAnalysis;
  } | null>(null);
  const [busy, setBusy] = useState<{ name: string; percent: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !adding) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, adding, onClose]);

  /** Files upload one after another — they share the progress bar. */
  const handleFiles = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    for (const file of Array.from(list)) {
      setBusy({ name: file.name, percent: 0 });
      try {
        const presign = await presignReadySheet(file);
        await uploadReadySheetToStorage(presign.uploadUrl, file, (p) =>
          setBusy({ name: file.name, percent: p }),
        );
        const [analysis, thumbnail] = await Promise.all([
          analyzeReadySheet(presign, file),
          makeThumbnail(file),
        ]);

        if (analysis.error) throw new Error(analysis.error);

        if (analysis.approved) {
          setRejected(null);
          setSheets((prev) => [
            ...prev,
            {
              key: analysis.sheetId,
              filename: file.name,
              thumbnail,
              analysis,
              meters: Math.round((analysis.heightMm || 0) / 100) / 10,
              qty: 1,
            },
          ]);
        } else {
          setRejected({ filename: file.name, thumbnail, analysis });
        }
      } catch (err) {
        alert(`${file.name} kunde inte laddas upp: ${(err as Error).message}`);
      }
    }
    setBusy(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const perDm = getPerDecimeterVariant();
  const total = sheets.reduce(
    (sum, s) => sum + (sheetPrice(s.meters) ?? 0) * s.qty,
    0,
  );

  const handleAddToCart = async () => {
    if (sheets.length === 0) return;
    setAdding(true);
    try {
      const variant = getPerDecimeterVariant();
      if (!variant) {
        throw new Error(
          "Priset kunde inte hämtas från butiken. Kontakta oss så lägger vi ordern åt dig.",
        );
      }

      const items = sheets.map((s) => {
        const dm = billedDecimeters(s.meters);
        return {
          id: variant.variantId,
          quantity: dm * s.qty,
          properties: {
            Fil: s.filename,
            Format: `${s.analysis.widthCm} × ${s.analysis.heightCm} cm (${s.meters.toFixed(1)} m)`,
            "Antal ark": String(s.qty),
            _gang_sheet_type: "pre-made",
            _gang_sheet_id: s.analysis.gangSheetId || "",
            _sheet_id: s.analysis.sheetId,
            _r2_key: s.analysis.r2Key,
            _dpi: String(s.analysis.dpi),
            _meters: s.meters.toFixed(1),
            _decimeters: String(dm),
          },
        };
      });

      const root = (window as any).Shopify?.routes?.root || "/";
      const res = await fetch(`${root}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error("Kunde inte lägga till i varukorgen");
      window.location.href = `${root}cart`;
    } catch (err) {
      alert(`Fel: ${(err as Error).message}`);
      setAdding(false);
    }
  };

  return (
    <div style={S.shell}>
      <header style={S.header}>
        <span style={S.wordmark}>
          Transfer<span style={{ color: theme.accent }}>craft</span>
        </span>
        <span style={S.headerSub}>Färdigt ark</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={S.headerBtn}>
          ← Tillbaka
        </button>
      </header>

      <div style={S.body}>
        <div style={S.column}>
          <h2 style={S.title}>Ladda upp ditt färdiga ark</h2>
          <p style={S.lead}>
            Arket skrivs ut i 58 cm bredd och så långt som din fil är. För att
            det ska bli skarpt behöver filen vara{" "}
            <strong>minst 6850 px bred</strong> — det är 58 cm i 300 DPI.
            Transparent PNG ger bäst resultat. Minsta order är 1 meter.
          </p>

          {busy ? (
            <div style={S.progressCard}>
              <p style={S.progressName}>{busy.name}</p>
              <div style={S.track}>
                <div style={{ ...S.fill, width: `${busy.percent}%` }} />
              </div>
              <p style={S.progressPct}>{busy.percent}%</p>
            </div>
          ) : (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFiles(e.dataTransfer.files);
              }}
              style={S.dropzone}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/tiff"
                style={{ display: "none" }}
                onChange={(e) => void handleFiles(e.target.files)}
              />
              <div style={S.dropPlus}>+</div>
              <p style={S.dropTitle}>Dra dina filer hit eller klicka</p>
              <p style={S.dropHint}>
                PNG, JPG, TIFF — flera filer går bra, max 500 MB per fil
              </p>
            </div>
          )}

          {rejected && (
            <div style={S.card}>
              {rejected.thumbnail && (
                <img src={rejected.thumbnail} alt="" style={S.preview} />
              )}
              <FileChips
                filename={rejected.filename}
                analysis={rejected.analysis}
              />
              {rejected.analysis.warnings.map((w, i) => (
                <p key={i} style={S.warning}>
                  ⚠ {w}
                </p>
              ))}
              <button onClick={() => setRejected(null)} style={S.secondary}>
                Välj en annan fil
              </button>
            </div>
          )}

          {sheets.length > 0 && (
            <>
              <p style={S.listLabel}>Dina ark</p>
              {sheets.map((s, idx) => (
                <div key={s.key} style={S.row}>
                  {s.thumbnail && <img src={s.thumbnail} alt="" style={S.rowThumb} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={S.rowName}>{s.filename}</p>
                    <p style={S.rowMeta}>
                      {s.analysis.widthCm}×{s.analysis.heightCm} cm ·{" "}
                      {s.analysis.dpi} DPI · {s.meters.toFixed(1)} m
                      {s.meters < 1 && (
                        <span style={{ color: theme.warning }}>
                          {" "}
                          · debiteras som 1 m
                        </span>
                      )}
                    </p>
                  </div>
                  <div style={S.stepper}>
                    <button
                      style={S.stepBtn}
                      onClick={() =>
                        setSheets((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, qty: Math.max(1, x.qty - 1) } : x,
                          ),
                        )
                      }
                    >
                      −
                    </button>
                    <span style={S.qty}>{s.qty}</span>
                    <button
                      style={S.stepBtn}
                      onClick={() =>
                        setSheets((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, qty: x.qty + 1 } : x,
                          ),
                        )
                      }
                    >
                      +
                    </button>
                  </div>
                  <span style={S.rowPrice}>
                    {sheetPrice(s.meters) === null
                      ? "—"
                      : `${sheetPrice(s.meters)! * s.qty} kr`}
                  </span>
                  <button
                    style={S.rowRemove}
                    title="Ta bort"
                    onClick={() =>
                      setSheets((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}

              <div style={S.totalBar}>
                <span style={S.totalLabel}>
                  Totalt ({sheets.reduce((n, s) => n + s.qty, 0)} ark)
                </span>
                <span style={S.totalValue}>{total} kr</span>
              </div>
            </>
          )}

          {sheets.length > 0 && (
            <div style={S.actions}>
              <button onClick={onClose} style={S.secondary}>
                Avbryt
              </button>
              <button
                onClick={() => void handleAddToCart()}
                disabled={adding || !perDm}
                style={{ ...S.primary, opacity: adding || !perDm ? 0.6 : 1 }}
              >
                {adding
                  ? "Lägger i varukorg..."
                  : perDm
                    ? `Lägg i varukorg — ${total} kr`
                    : "Pris saknas — kontakta oss"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileChips({
  filename,
  analysis,
}: {
  filename: string;
  analysis: ReadySheetAnalysis;
}) {
  const dpiColor = getDpiColor(analysis.dpi);
  return (
    <>
      <div style={S.fileRow}>
        <span style={S.fileName}>{filename}</span>
        <span style={S.fileSize}>
          {(analysis.fileSizeBytes / 1024 / 1024).toFixed(1)} MB
        </span>
      </div>
      <div style={S.chips}>
        <span style={S.chip}>
          {analysis.widthCm} × {analysis.heightCm} cm
        </span>
        <span
          style={{ ...S.chip, color: dpiColor, background: dpiColor + "1a", fontWeight: 600 }}
        >
          {analysis.dpi} DPI
        </span>
        <span style={S.chip}>
          {analysis.widthPx}×{analysis.heightPx} px
        </span>
      </div>
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  shell: {
    position: "fixed",
    inset: 0,
    zIndex: 2147483647,
    background: theme.bgCanvas,
    fontFamily: theme.fontFamily,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    flexShrink: 0,
    height: 52,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 20px",
    background: theme.headerBg,
  },
  wordmark: {
    fontSize: theme.fontSize.titleLg,
    fontWeight: theme.fontWeight.bold,
    color: "#fff",
    letterSpacing: theme.letterSpacing.tight,
  },
  headerSub: { fontSize: theme.fontSize.bodySm, color: "rgba(255,255,255,0.55)" },
  headerBtn: {
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: theme.radiusSm,
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    cursor: "pointer",
  },
  body: { flex: 1, overflow: "auto", display: "flex", justifyContent: "center", padding: "32px 20px 48px" },
  column: { width: "100%", maxWidth: 520, display: "flex", flexDirection: "column", gap: 12 },
  title: {
    margin: 0,
    fontSize: theme.fontSize.titleLg,
    fontWeight: theme.fontWeight.bold,
    color: theme.text,
    letterSpacing: theme.letterSpacing.tight,
  },
  lead: {
    margin: "0 0 8px",
    fontSize: theme.fontSize.bodySm,
    color: theme.textMuted,
    lineHeight: theme.lineHeight.normal,
  },
  dropzone: {
    border: `2px dashed ${theme.border}`,
    borderRadius: theme.radius,
    padding: "36px 16px",
    textAlign: "center",
    cursor: "pointer",
    background: theme.bgCard,
  },
  dropPlus: {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: theme.bgInput,
    color: theme.accent,
    fontSize: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 10px",
  },
  dropTitle: { margin: 0, fontSize: 14, fontWeight: 500, color: theme.text },
  dropHint: { margin: "6px 0 0", fontSize: 12, color: theme.textDim },
  progressCard: {
    padding: 20,
    background: theme.bgCard,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
  },
  progressName: { margin: "0 0 10px", fontSize: 13, fontWeight: 500, color: theme.text, textAlign: "center" },
  track: { width: "100%", height: 6, background: theme.bgInput, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", background: theme.accentGradient, borderRadius: 3, transition: "width 0.3s ease" },
  progressPct: { margin: "8px 0 0", fontSize: 12, color: theme.textDim, textAlign: "center" },
  card: {
    padding: 14,
    background: theme.bgCard,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  preview: {
    display: "block",
    width: "100%",
    borderRadius: theme.radiusSm,
    background: "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50%/16px 16px",
  },
  fileRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  fileName: {
    fontSize: 13,
    fontWeight: 600,
    color: theme.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileSize: { fontSize: 11, color: theme.textDim, flexShrink: 0 },
  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 4,
    background: theme.bgInput,
    color: theme.textMuted,
  },
  warning: {
    margin: 0,
    padding: "8px 10px",
    borderRadius: theme.radiusSm,
    background: theme.warningBg,
    border: `1px solid rgba(230,81,0,0.16)`,
    fontSize: 12,
    color: theme.warning,
    lineHeight: theme.lineHeight.normal,
  },
  listLabel: {
    margin: "8px 0 0",
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: theme.letterSpacing.wide,
    color: theme.textMuted,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: 10,
    background: theme.bgCard,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
  },
  rowThumb: {
    width: 44,
    height: 44,
    objectFit: "contain",
    borderRadius: 6,
    background: theme.bgInput,
    flexShrink: 0,
  },
  rowName: {
    margin: 0,
    fontSize: 13,
    fontWeight: 500,
    color: theme.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowMeta: { margin: "2px 0 0", fontSize: 11, color: theme.textDim },
  stepper: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 },
  stepBtn: {
    width: 28,
    height: 28,
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
    color: theme.textMuted,
  },
  qty: { width: 24, textAlign: "center", fontSize: 14, fontWeight: 600, color: theme.text },
  rowPrice: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.accent,
    whiteSpace: "nowrap",
    minWidth: 60,
    textAlign: "right",
  },
  rowRemove: {
    width: 24,
    height: 24,
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 14,
    color: theme.textDim,
    flexShrink: 0,
  },
  totalBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 14px",
    background: theme.bgDark,
    borderRadius: theme.radius,
  },
  totalLabel: { fontSize: theme.fontSize.labelMd, color: "rgba(255,255,255,0.6)" },
  totalValue: { fontSize: theme.fontSize.titleLg, fontWeight: theme.fontWeight.bold, color: "#fff" },
  actions: { display: "flex", gap: 8, marginTop: 4 },
  secondary: {
    flex: 1,
    padding: 12,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    background: "#fff",
    color: theme.text,
    cursor: "pointer",
  },
  primary: {
    flex: 1,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 700,
    fontFamily: theme.fontFamily,
    border: "none",
    borderRadius: theme.radius,
    background: theme.accentGradient,
    color: "#fff",
    cursor: "pointer",
    boxShadow: `0 2px 12px ${theme.accent}50`,
  },
};
