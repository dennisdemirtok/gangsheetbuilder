import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useEditorStore,
  groupImages,
  groupKey,
  type EditorImage,
} from "../../store/editorStore";
import { uploadImage, getAppProxyUrl, ensureGangSheet } from "../../services/api";
import { calculateDisplayDpi, getDpiColor, dpiWarning } from "../../utils/units";
import { capacity, requiredHeightMm, EDGE_MARGIN_MM } from "../../utils/layout";
import { SHEET_SIZES, SHEET_WIDTH_MM, smallestSheetFor } from "../../config/sheets";
import { theme } from "../../styles/theme";
import { showToast } from "../ImagePanel/ImageUploader";

/**
 * Quantity-first start flow.
 *
 * The editor used to open on an empty metre of film and leave the customer
 * to work out how to fill it. People don't think in metres — they think
 * "50 of my logo at 10 cm". So: upload, say how big and how many, and the
 * builder picks the film length, nests everything and prices it.
 */

/** Common placements, so nobody has to guess what "10 cm" looks like. */
const SIZE_PRESETS = [
  { label: "Vänsterbröst", cm: 8 },
  { label: "Bröst", cm: 10 },
  { label: "A4-bred", cm: 21 },
  { label: "Rygg", cm: 28 },
  { label: "A3-bred", cm: 29.7 },
];

interface Draft {
  id: string;
  file: File;
  previewUrl: string;
  widthPx: number;
  heightPx: number;
  /** Target printed width in cm. */
  widthCm: number;
  count: number;
  uploaded?: {
    id: string;
    imageId: string;
    thumbnailUrl: string;
    originalUrl: string;
    width: number;
    height: number;
    dpiX: number;
    hasAlpha?: boolean;
    hasWhiteBackground?: boolean;
    filename: string;
  };
}

export function StartWizard({ onClose }: { onClose: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    sessionId,
    gangSheetId,
    filmType,
    gapMm,
    sheetSize,
    setGangSheetId,
    setSheetSize,
    addImage,
    setGroupCount,
    arrangeAll,
  } = useEditorStore();

  const readFiles = useCallback(async (files: FileList) => {
    const next: Draft[] = [];
    for (const file of Array.from(files)) {
      const previewUrl = URL.createObjectURL(file);
      // Read intrinsic pixels locally so sizing advice appears instantly,
      // before the (possibly large) upload finishes.
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => resolve({ w: 0, h: 0 });
        im.src = previewUrl;
      });
      const widthPx = dims.w || 1000;
      const heightPx = dims.h || 1000;
      next.push({
        id: "draft_" + Math.random().toString(36).slice(2, 10),
        file,
        previewUrl,
        widthPx,
        heightPx,
        widthCm: 10,
        count: 1,
      });
    }
    setDrafts((prev) => [...prev, ...next]);
  }, []);

  /** Film length these designs need at the chosen sizes and counts. */
  const plan = useMemo(() => {
    const items: { id: string; w: number; h: number }[] = [];
    for (const d of drafts) {
      const w = d.widthCm * 10;
      const h = (d.heightPx / d.widthPx) * w;
      for (let i = 0; i < d.count; i++) {
        items.push({ id: `${d.id}_${i}`, w, h });
      }
    }
    if (items.length === 0) return null;
    const neededMm = requiredHeightMm(items, SHEET_WIDTH_MM, gapMm);
    const sheet = smallestSheetFor(neededMm);
    const tooBig = neededMm > SHEET_SIZES[SHEET_SIZES.length - 1]!.heightMm;
    return { neededMm, sheet, tooBig, total: items.length };
  }, [drafts, gapMm]);

  const handleBuild = async () => {
    if (drafts.length === 0 || !plan) return;
    setBusy("Laddar upp...");

    try {
      let gsId = gangSheetId;
      gsId = await ensureGangSheet(
        sessionId,
        plan.sheet.widthMm,
        plan.sheet.heightMm,
        filmType,
        gangSheetId,
      );
      if (gsId !== gangSheetId) setGangSheetId(gsId);

      // Pick the film length first — placement depends on it.
      setSheetSize(plan.sheet);

      const base = getAppProxyUrl();
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i]!;
        setBusy(`Laddar upp ${i + 1}/${drafts.length}: ${d.file.name}`);
        const result = await uploadImage(d.file, sessionId, gsId || "");

        const thumbUrl = result.thumbnailUrl?.startsWith("/")
          ? base + result.thumbnailUrl
          : result.thumbnailUrl;
        const origUrl = result.originalUrl?.startsWith("/")
          ? base + result.originalUrl
          : result.originalUrl;

        const widthMm = d.widthCm * 10;
        const ratio = (result.height || d.heightPx) / (result.width || d.widthPx);

        const image: EditorImage = {
          id: result.imageId || result.id,
          dbId: result.id,
          groupId: "grp_" + Math.random().toString(36).slice(2, 10),
          filename: result.filename || d.file.name,
          thumbnailUrl: thumbUrl,
          originalUrl: origUrl,
          widthPx: result.width,
          heightPx: result.height,
          dpiX: result.dpiX || 72,
          dpiY: result.dpiY || 72,
          positionX: EDGE_MARGIN_MM,
          positionY: EDGE_MARGIN_MM,
          displayWidth: widthMm,
          displayHeight: widthMm * ratio,
          rotation: 0,
          flipX: false,
          flipY: false,
          quantity: 1,
          marginMm: gapMm,
          bgRemoved: result.hasAlpha || false,
          hasWhiteBackground: result.hasWhiteBackground || false,
          placed: true,
        };
        addImage(image);

        if (d.count > 1) {
          setBusy(`Placerar ${d.count} kopior...`);
          // Ask groupKey for the key rather than assuming it — copies are
          // grouped by database row, not by the id generated here.
          setGroupCount(groupKey(image), d.count);
        }
      }

      setBusy("Ordnar arket...");
      arrangeAll();

      const after = groupImages(useEditorStore.getState().images);
      const placedCount = after.reduce((n, g) => n + g.count, 0);
      if (placedCount < plan.total) {
        showToast(
          `${plan.total - placedCount} kopior fick inte plats — välj ett längre ark.`,
          "warning",
        );
      }
      onClose();
    } catch (err) {
      showToast(`Något gick fel: ${(err as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  // Every preview holds a blob alive until it is revoked.
  const draftsRef = useRef<Draft[]>([]);
  draftsRef.current = drafts;
  useEffect(
    () => () => {
      for (const d of draftsRef.current) URL.revokeObjectURL(d.previewUrl);
    },
    [],
  );

  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  return (
    <div style={S.backdrop}>
      <div style={S.modal} className="gs-wizard">
        <div style={S.head}>
          <div>
            <h2 style={S.title}>Bygg ditt gang sheet</h2>
            <p style={S.sub}>
              Ladda upp, säg hur stort och hur många — vi räknar ut hur mycket
              film du behöver.
            </p>
          </div>
          <button onClick={onClose} style={S.skip} title="Hoppa över och placera själv">
            Placera själv →
          </button>
        </div>

        <div style={S.body}>
          {/* Step 1 — upload */}
          <Step n={1} title="Ladda upp dina designs" done={drafts.length > 0} />
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files);
            }}
            style={S.drop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/svg+xml,image/tiff,image/webp,application/pdf,.eps,.ai"
              style={{ display: "none" }}
              onChange={(e) => e.target.files && readFiles(e.target.files)}
            />
            <div style={S.dropPlus}>+</div>
            <p style={S.dropTitle}>Dra filer hit eller klicka</p>
            <p style={S.dropHint}>PNG, JPG, SVG, TIFF, PDF, EPS — max 500 MB</p>
          </div>

          {/* Step 2 + 3 — size and count per design */}
          {drafts.length > 0 && (
            <>
              <Step n={2} title="Hur stort och hur många?" done={false} />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {drafts.map((d) => (
                  <DraftRow
                    key={d.id}
                    draft={d}
                    gapMm={gapMm}
                    onChange={(patch) => update(d.id, patch)}
                    onRemove={() => {
                      URL.revokeObjectURL(d.previewUrl);
                      setDrafts((prev) => prev.filter((x) => x.id !== d.id));
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer — the plan */}
        <div style={S.foot}>
          {plan ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={S.planMain}>
                {plan.total} motiv → <strong>{plan.sheet.label}</strong>
              </p>
              <p style={S.planSub}>
                {plan.tooBig
                  ? "Mer än 5 meter — dela upp på flera ark efter att du byggt."
                  : `Behöver ca ${(plan.neededMm / 10).toFixed(0)} cm film.`}
              </p>
            </div>
          ) : (
            <p style={{ ...S.planSub, flex: 1 }}>
              Ladda upp minst en design för att komma igång.
            </p>
          )}
          <button
            onClick={handleBuild}
            disabled={!plan || busy !== null}
            style={{
              ...S.cta,
              background: plan && !busy ? theme.accent : theme.bgInput,
              color: plan && !busy ? "#fff" : theme.textDim,
              cursor: plan && !busy ? "pointer" : "not-allowed",
            }}
          >
            {busy ?? "Bygg mitt ark"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  gapMm,
  onChange,
  onRemove,
}: {
  draft: Draft;
  gapMm: number;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const widthMm = draft.widthCm * 10;
  const heightMm = (draft.heightPx / draft.widthPx) * widthMm;
  const dpi = calculateDisplayDpi(draft.widthPx, widthMm);
  const warning = dpiWarning(dpi);

  // How many of this design alone would fill one metre — the answer to
  // "how many do I get for the minimum order?"
  const perMetre = capacity(
    widthMm,
    heightMm,
    { widthMm: SHEET_WIDTH_MM, heightMm: 1000 },
    gapMm,
  ).total;

  return (
    <div style={S.row}>
      <img src={draft.previewUrl} alt="" style={S.thumb} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.rowHead}>
          <span style={S.rowName}>{draft.file.name}</span>
          <button onClick={onRemove} style={S.rowRemove} title="Ta bort">
            ×
          </button>
        </div>

        <div style={S.presets}>
          {SIZE_PRESETS.map((p) => {
            const active = Math.abs(p.cm - draft.widthCm) < 0.05;
            return (
              <button
                key={p.label}
                onClick={() => onChange({ widthCm: p.cm })}
                style={{
                  ...S.preset,
                  borderColor: active ? theme.accent : theme.border,
                  background: active ? theme.accentBg : theme.bgCard,
                  color: active ? theme.accent : theme.textMuted,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div style={S.fields}>
          <Field label="Bredd (cm)">
            <input
              type="number"
              min={1}
              max={58}
              step={0.5}
              value={draft.widthCm}
              onChange={(e) =>
                onChange({
                  widthCm: Math.min(58, Math.max(1, parseFloat(e.target.value) || 1)),
                })
              }
              style={S.input}
            />
          </Field>
          <Field label="Antal">
            <input
              type="number"
              min={1}
              max={500}
              value={draft.count}
              onChange={(e) =>
                onChange({ count: Math.max(1, parseInt(e.target.value) || 1) })
              }
              style={S.input}
            />
          </Field>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={S.fieldLabel}>Blir</span>
            <p style={S.computed}>
              {draft.widthCm.toFixed(1)} × {(heightMm / 10).toFixed(1)} cm
              <span style={{ color: getDpiColor(dpi), fontWeight: 600, marginLeft: 6 }}>
                {dpi} DPI
              </span>
            </p>
          </div>
        </div>

        <p style={S.hint}>
          {perMetre > 0
            ? `Ca ${perMetre} st ryms på 1 meter film.`
            : "Motivet är för stort för arkets bredd."}
        </p>
        {warning && <p style={S.warn}>⚠ {warning}</p>}
      </div>
    </div>
  );
}

function Step({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div style={S.step}>
      <span
        style={{
          ...S.stepNum,
          background: done ? theme.success : theme.bgDark,
        }}
      >
        {done ? "✓" : n}
      </span>
      <span style={S.stepTitle}>{title}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ width: 88 }}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(20,20,22,0.55)",
    backdropFilter: "blur(3px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 40,
  },
  modal: {
    width: "100%",
    maxWidth: 640,
    maxHeight: "100%",
    background: theme.bg,
    borderRadius: theme.radiusLg,
    boxShadow: theme.shadowLg,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: theme.fontFamily,
  },
  head: {
    padding: "20px 20px 14px",
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    borderBottom: `1px solid ${theme.border}`,
  },
  title: {
    margin: 0,
    fontSize: theme.fontSize.titleLg,
    fontWeight: theme.fontWeight.bold,
    letterSpacing: theme.letterSpacing.tight,
    color: theme.text,
  },
  sub: {
    margin: "4px 0 0",
    fontSize: theme.fontSize.bodySm,
    color: theme.textMuted,
    lineHeight: theme.lineHeight.normal,
  },
  skip: {
    flexShrink: 0,
    padding: "7px 12px",
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    background: "transparent",
    color: theme.textMuted,
    fontSize: theme.fontSize.labelMd,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  body: { flex: 1, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12 },
  step: { display: "flex", alignItems: "center", gap: 8 },
  stepNum: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepTitle: {
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.text,
  },
  drop: {
    border: `2px dashed ${theme.border}`,
    borderRadius: theme.radius,
    padding: "22px 16px",
    textAlign: "center",
    cursor: "pointer",
    background: theme.bgCard,
  },
  dropPlus: {
    width: 40,
    height: 40,
    margin: "0 auto 8px",
    borderRadius: 10,
    background: theme.bgInput,
    color: theme.accent,
    fontSize: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dropTitle: { margin: 0, fontSize: theme.fontSize.bodyMd, color: theme.text },
  dropHint: { margin: "4px 0 0", fontSize: theme.fontSize.labelMd, color: theme.textDim },
  row: {
    display: "flex",
    gap: 12,
    padding: 12,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    background: theme.bgCard,
  },
  thumb: {
    width: 56,
    height: 56,
    objectFit: "contain",
    borderRadius: theme.radiusSm,
    background: theme.bgInput,
    flexShrink: 0,
  },
  rowHead: { display: "flex", alignItems: "center", gap: 8 },
  rowName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowRemove: {
    width: 22,
    height: 22,
    border: "none",
    borderRadius: 6,
    background: theme.dangerBg,
    color: theme.danger,
    cursor: "pointer",
    fontSize: 13,
    flexShrink: 0,
  },
  presets: { display: "flex", gap: 4, flexWrap: "wrap", margin: "8px 0" },
  preset: {
    padding: "4px 9px",
    border: "1px solid",
    borderRadius: 999,
    fontSize: theme.fontSize.labelMd,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  fields: { display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" },
  fieldLabel: {
    display: "block",
    fontSize: theme.fontSize.labelXs,
    color: theme.textDim,
    marginBottom: 2,
  },
  input: {
    width: "100%",
    padding: "7px 8px",
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    background: theme.bgInput,
    color: theme.text,
  },
  computed: {
    margin: "2px 0 0",
    fontSize: theme.fontSize.bodySm,
    color: theme.text,
    fontWeight: theme.fontWeight.medium,
  },
  hint: { margin: "8px 0 0", fontSize: theme.fontSize.labelMd, color: theme.textMuted },
  warn: { margin: "4px 0 0", fontSize: theme.fontSize.labelMd, color: theme.warning },
  foot: {
    padding: 16,
    borderTop: `1px solid ${theme.border}`,
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: theme.bgSidebar,
  },
  planMain: { margin: 0, fontSize: theme.fontSize.bodyMd, color: theme.text },
  planSub: { margin: "2px 0 0", fontSize: theme.fontSize.labelMd, color: theme.textMuted },
  cta: {
    flexShrink: 0,
    padding: "12px 22px",
    border: "none",
    borderRadius: theme.radius,
    fontSize: theme.fontSize.bodyMd,
    fontWeight: theme.fontWeight.semibold,
    fontFamily: theme.fontFamily,
  },
};
