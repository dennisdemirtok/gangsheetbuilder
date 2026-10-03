import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useEditorStore,
  groupImages,
  groupKey,
  type EditorImage,
} from "../../store/editorStore";
import { uploadImage, getAppProxyUrl, ensureGangSheet, removeBg } from "../../services/api";
import { getSheetPrice } from "../../services/storefrontPrices";
import { calculateDisplayDpi, cmText, getDpiColor, dpiWarning, DPI_THRESHOLDS } from "../../utils/units";
import { capacity, imageBbox, EDGE_MARGIN_MM } from "../../utils/layout";
import { packSheet } from "../../utils/packing";
import { SheetPreview, type PreviewPiece } from "./SheetPreview";
import { useIsMobile } from "../../utils/useIsMobile";
import { MAX_SHEET_MM, SHEET_SIZES, SHEET_WIDTH_MM, sheetForHeight, smallestSheetFor } from "../../config/sheets";
import { theme } from "../../styles/theme";
import { showToast } from "../../utils/toast";

/**
 * Quantity-first start flow — and the way to add many designs later.
 *
 * People don't think in metres — they think "50 of my logo at 10 cm". So:
 * upload, say how big and how many, and the builder picks the film length,
 * nests everything and prices it.
 *
 * Files upload the moment they are picked, three at a time, while the
 * customer sets sizes; they used to go one by one only after "Bygg", which
 * with 50 logos meant minutes of waiting on a spinner. A white background
 * is taken off (and can be put back), sizes can be set for all designs in
 * one go, and designs already on the sheet are counted in, so reopening the
 * guide adds to the sheet instead of squeezing what is there.
 */

/**
 * Common placements as the space they must fit in, not a width. A width
 * alone made a tall logo enormous: "Vänsterbröst 8 cm" on a 1:3 badge was
 * 24 cm tall. The design is scaled to fit inside the box.
 */
const SIZE_PRESETS = [
  { label: "Vänsterbröst", w: 9, h: 9 },
  { label: "Mitt bröst", w: 20, h: 10 },
  { label: "Framsida", w: 28, h: 28 },
  { label: "Rygg", w: 30, h: 36 },
  { label: "Ärm", w: 7, h: 7 },
  { label: "Nacke", w: 7, h: 4 },
];
type SizePreset = (typeof SIZE_PRESETS)[number];

/** The size a fresh design gets: fits in 10 × 10 cm. */
const DEFAULT_BOX = { w: 10, h: 10 };

/** Width (cm, to a millimetre) that fits a w×h px design inside the box. */
function fitWidthCm(box: { w: number; h: number }, widthPx: number, heightPx: number): number {
  const ratio = widthPx / Math.max(1, heightPx);
  return Math.round(Math.min(box.w, box.h * ratio, 58) * 10) / 10;
}

/** Uploads at a time: fast, without starving a slow connection. */
const PARALLEL_UPLOADS = 3;

const VECTOR_EXT = /\.(svg|pdf|eps|ai)$/i;

interface Uploaded {
  id: string;
  imageId: string;
  thumbnailUrl: string;
  originalUrl: string;
  width: number;
  height: number;
  dpiX: number;
  dpiY: number;
  hasAlpha?: boolean;
  hasWhiteBackground?: boolean;
  filename: string;
}

interface Draft {
  id: string;
  file: File;
  /** What the row shows: the local file, then the server's thumbnail. */
  previewUrl: string;
  /** Local blob to revoke when the draft goes away. */
  blobUrl: string;
  widthPx: number;
  heightPx: number;
  /** Target printed width in cm. */
  widthCm: number;
  /** The placement chosen, if any; the width follows it when the shape is known. */
  preset?: string;
  count: number;
  vector: boolean;
  status: "uploading" | "ready" | "failed";
  /** While uploading: share of the bytes sent (0-1), then the server's turn. */
  sent?: number;
  processing?: boolean;
  error?: string;
  uploaded?: Uploaded;
  /** The background-free version, when the file had a white background. */
  bgRemovedUrl?: string;
  /** Use the background-free version (on by default when there is one). */
  useBgRemoved: boolean;
  bgBusy?: boolean;
  /** Only the white around the design, or every white pixel. */
  bgMode?: BgMode;
  /** Results already fetched, per mode, so switching back is instant. */
  bgUrls?: Partial<Record<BgMode, string>>;
}

type BgMode = "background" | "all";

/** The theme block exposes this when the upload modal is on the page. */
function openUploadFlow() {
  const open = (window as any).__gangsheetOpenUpload;
  if (typeof open === "function") open();
}

const hasUploadFlow =
  typeof window !== "undefined" &&
  typeof (window as any).__gangsheetOpenUpload === "function";

const absolute = (url: string | undefined) =>
  url && url.startsWith("/") ? getAppProxyUrl() + url : url || "";

/** Pixel size of a picked file, when the browser can draw it. */
function readPixels(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve({ w: 0, h: 0 });
    im.src = url;
  });
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
    images,
    setGangSheetId,
    addDesigns,
  } = useEditorStore();

  const draftsRef = useRef<Draft[]>([]);
  draftsRef.current = drafts;

  // Designs already on the sheet: the guide adds to them.
  const existing = useMemo(() => images.filter((img) => img.placed), [images]);
  const adding = existing.length > 0;

  const update = useCallback(
    (id: string, patch: Partial<Draft>) =>
      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d))),
    [],
  );

  /* ── Uploads: a small queue, started as soon as files are picked ── */

  const queueRef = useRef<Draft[]>([]);
  const runningRef = useRef(0);
  const sheetIdRef = useRef<Promise<string> | null>(null);

  const sheetId = useCallback(() => {
    if (!sheetIdRef.current) {
      sheetIdRef.current = ensureGangSheet(
        sessionId,
        sheetSize.widthMm,
        sheetSize.heightMm,
        filmType,
        gangSheetId,
      ).then((id) => {
        if (id !== gangSheetId) setGangSheetId(id);
        return id;
      });
    }
    return sheetIdRef.current;
  }, [sessionId, sheetSize, filmType, gangSheetId, setGangSheetId]);

  const takeOffBackground = useCallback(
    async (draftId: string, dbId: string, mode: BgMode = "background") => {
      const known = draftsRef.current.find((d) => d.id === draftId)?.bgUrls?.[mode];
      if (known) {
        update(draftId, { bgRemovedUrl: known, bgMode: mode, useBgRemoved: true });
        return;
      }
      update(draftId, { bgBusy: true });
      try {
        const result = await removeBg(dbId, mode);
        if (!result?.bgRemovedUrl) throw new Error("no result");
        const url = absolute(result.bgRemovedUrl);
        setDrafts((prev) =>
          prev.map((d) =>
            d.id === draftId
              ? {
                  ...d,
                  bgRemovedUrl: url,
                  bgMode: mode,
                  bgUrls: { ...d.bgUrls, [mode]: url },
                  useBgRemoved: true,
                  bgBusy: false,
                }
              : d,
          ),
        );
      } catch {
        update(draftId, { bgBusy: false, ...(mode === "background" ? { useBgRemoved: false } : {}) });
        if (mode === "all") showToast("Det gick inte att ta bort det vita. Försök igen.", "error");
      }
    },
    [update],
  );

  const pump = useCallback(() => {
    while (runningRef.current < PARALLEL_UPLOADS && queueRef.current.length > 0) {
      const draft = queueRef.current.shift()!;
      runningRef.current++;
      (async () => {
        try {
          const gsId = await sheetId();
          const result = await uploadImage(draft.file, sessionId, gsId, (p) =>
            update(draft.id, { sent: p.sent, processing: p.phase === "processing" }),
          );
          const uploaded: Uploaded = {
            ...result,
            id: result.id,
            imageId: result.imageId || result.id,
            thumbnailUrl: absolute(result.thumbnailUrl),
            originalUrl: absolute(result.originalUrl),
            filename: result.filename || draft.file.name,
          };
          // The server's check already looks past transparency: an EPS has
          // a transparent margin around its white box.
          const white = Boolean(result.hasWhiteBackground);
          setDrafts((prev) =>
            prev.map((d) =>
              d.id === draft.id
                ? {
                    ...d,
                    status: "ready",
                    uploaded,
                    // The server's pixels are the truth — EPS and PDF can't
                    // be measured in the browser, and SVGs come back drawn.
                    widthPx: result.width || d.widthPx,
                    heightPx: result.height || d.heightPx,
                    // The real shape is known now (EPS can't be measured in
                    // the browser): fit it to the chosen box again.
                    widthCm: fitWidthCm(
                      SIZE_PRESETS.find((p) => p.label === d.preset) ?? DEFAULT_BOX,
                      result.width || d.widthPx,
                      result.height || d.heightPx,
                    ),
                    previewUrl: d.previewUrl || uploaded.thumbnailUrl,
                    useBgRemoved: white,
                  }
                : d,
            ),
          );
          for (const w of result.warnings ?? []) showToast(w, "warning");
          if (white) void takeOffBackground(draft.id, result.id);
        } catch (err) {
          update(draft.id, { status: "failed", error: (err as Error).message });
        } finally {
          runningRef.current--;
          pump();
        }
      })();
    }
  }, [sessionId, sheetId, takeOffBackground, update]);

  const readFiles = useCallback(
    async (files: FileList) => {
      const next: Draft[] = [];
      for (const file of Array.from(files)) {
        const blobUrl = URL.createObjectURL(file);
        // Read pixels locally so sizing advice appears before the upload is done.
        const dims = await readPixels(blobUrl);
        next.push({
          id: "draft_" + Math.random().toString(36).slice(2, 10),
          file,
          blobUrl,
          previewUrl: dims.w ? blobUrl : "",
          widthPx: dims.w || 1000,
          heightPx: dims.h || 1000,
          widthCm: fitWidthCm(DEFAULT_BOX, dims.w || 1000, dims.h || 1000),
          count: 1,
          vector: VECTOR_EXT.test(file.name),
          status: "uploading",
          useBgRemoved: false,
        });
      }
      setDrafts((prev) => [...prev, ...next]);
      queueRef.current.push(...next);
      pump();
    },
    [pump],
  );

  /* ── Plan: film for what is on the sheet plus what is being added ── */

  const plan = useMemo(() => {
    // The same nesting the build runs: a fresh sheet nests everything; on a
    // sheet in progress the designs already there stay put.
    const newItems: { id: string; w: number; h: number }[] = [];
    const urlOf = new Map<string, string>();
    let total = 0;
    for (const d of drafts) {
      if (d.status === "failed") continue;
      const w = d.widthCm * 10;
      const h = (d.heightPx / d.widthPx) * w;
      const url = (d.useBgRemoved && d.bgRemovedUrl) || d.previewUrl || d.uploaded?.thumbnailUrl || "";
      for (let i = 0; i < d.count; i++) {
        newItems.push({ id: `${d.id}_${i}`, w, h });
        urlOf.set(`${d.id}_${i}`, url);
      }
      total += d.count;
    }
    if (total === 0) return null;

    const tall = sheetForHeight(MAX_SHEET_MM);
    const existingItems = existing.map((img) => {
      const b = imageBbox(img);
      return { id: img.id, w: b.w, h: b.h };
    });
    const result = adding
      ? packSheet(newItems, tall, gapMm, existing.map(imageBbox))
      : packSheet([...existingItems, ...newItems], tall, gapMm);
    const tooBig = result.overflow.length > 0;
    const neededMm = result.bottomMm + EDGE_MARGIN_MM;
    let sheet = smallestSheetFor(neededMm);
    // Never shorter than the sheet designs already sit on.
    if (adding && sheet.heightMm < sheetSize.heightMm) {
      sheet = sheetForHeight(sheetSize.heightMm);
    }

    const pieces: PreviewPiece[] = [];
    for (const img of existing) {
      const b = imageBbox(img);
      pieces.push({
        fixed: { ...b, rotation: img.rotation, unrotatedW: img.displayWidth, unrotatedH: img.displayHeight },
        url: img.bgRemovedUrl || img.thumbnailUrl,
      });
    }
    for (const [id, placement] of result.placements) {
      if (urlOf.has(id)) pieces.push({ placement, url: urlOf.get(id)! });
    }
    return { neededMm, sheet, tooBig, total, price: getSheetPrice(sheet.key), pieces };
  }, [drafts, existing, adding, gapMm, sheetSize]);

  const isMobile = useIsMobile();
  const showPreview = Boolean(plan) && !isMobile;

  const uploading = drafts.filter((d) => d.status === "uploading").length;
  const ready = drafts.filter((d) => d.status === "ready");
  const failed = drafts.filter((d) => d.status === "failed");

  const handleBuild = async () => {
    if (ready.length === 0 || !plan || uploading > 0) return;
    setBusy("Placerar motiven...");
    try {
      const entries = ready.map((d) => {
        const u = d.uploaded!;
        const widthMm = d.widthCm * 10;
        const ratio = (u.height || d.heightPx) / (u.width || d.widthPx);
        const bgOff = d.useBgRemoved && Boolean(d.bgRemovedUrl);
        const image: EditorImage = {
          id: u.imageId,
          dbId: u.id,
          groupId: "grp_" + Math.random().toString(36).slice(2, 10),
          filename: u.filename,
          thumbnailUrl: u.thumbnailUrl,
          originalUrl: u.originalUrl,
          widthPx: u.width,
          heightPx: u.height,
          dpiX: u.dpiX || 72,
          dpiY: u.dpiY || 72,
          positionX: EDGE_MARGIN_MM,
          positionY: EDGE_MARGIN_MM,
          displayWidth: widthMm,
          displayHeight: widthMm * ratio,
          rotation: 0,
          flipX: false,
          flipY: false,
          quantity: 1,
          marginMm: gapMm,
          bgRemoved: bgOff || Boolean(u.hasAlpha),
          bgRemovedUrl: bgOff ? d.bgRemovedUrl : undefined,
          hasWhiteBackground: Boolean(u.hasWhiteBackground) && !bgOff,
          placed: true,
        };
        return { image, count: d.count };
      });

      // One nesting for everything: a fresh sheet gets the shortest film
      // that holds it all; designs already on a sheet stay where they are
      // and the new ones fill the space around them.
      const result = addDesigns(entries, {
        floor: adding ? sheetSize : SHEET_SIZES[0]!,
        keepExisting: adding,
      });

      if (result.overflow > 0) {
        showToast(`${result.overflow} kopior fick inte plats ens på 5 meter — lägg dem på ett nytt ark.`, "warning");
      } else if (result.turned > 0) {
        showToast(
          `${result.turned === 1 ? "Ett motiv" : `${result.turned} motiv`} vändes 90° för att spara film — de trycks likadant.`,
          "info",
        );
      }
      if (failed.length > 0) {
        showToast(`${failed.length} fil${failed.length > 1 ? "er" : ""} kunde inte laddas upp och lades inte till.`, "error");
      }
      onClose();
    } catch (err) {
      showToast(`Något gick fel: ${(err as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  // Every local preview holds a blob alive until it is revoked.
  useEffect(
    () => () => {
      for (const d of draftsRef.current) URL.revokeObjectURL(d.blobUrl);
    },
    [],
  );

  const applyToAll = (patch: Partial<Pick<Draft, "widthCm" | "count">> & { preset?: SizePreset }) =>
    setDrafts((prev) =>
      prev.map((d) => {
        const { preset, ...rest } = patch;
        if (preset) {
          return { ...d, ...rest, preset: preset.label, widthCm: fitWidthCm(preset, d.widthPx, d.heightPx) };
        }
        return { ...d, ...rest, ...(rest.widthCm !== undefined ? { preset: undefined } : {}) };
      }),
    );

  const buildLabel = busy
    ? busy
    : uploading > 0
      ? `Laddar upp ${drafts.length - uploading}/${drafts.length}...`
      : adding
        ? "Lägg till på arket"
        : "Bygg mitt ark";
  const canBuild = Boolean(plan) && ready.length > 0 && uploading === 0 && !busy;

  return (
    <div style={S.backdrop}>
      <div style={{ ...S.modal, maxWidth: showPreview ? 900 : 640 }} className="gs-wizard">
        <div style={S.head}>
          <div>
            <h2 style={S.title}>{adding ? "Lägg till motiv" : "Bygg ditt gang sheet"}</h2>
            <p style={S.sub}>
              {adding
                ? "Välj filerna, säg hur stora och hur många — vi lägger dem på arket och gör det längre om det behövs."
                : "Ladda upp, säg hur stort och hur många — vi räknar ut hur mycket film du behöver."}
            </p>
          </div>
          <button onClick={onClose} style={S.skip} title={adding ? "Stäng" : "Hoppa över och placera själv"}>
            {adding ? "Stäng" : "Placera själv →"}
          </button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={S.body}>
          {/* Step 1 — upload */}
          <Step n={1} title="Ladda upp dina motiv — välj gärna alla på en gång" done={drafts.length > 0} />
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) void readFiles(e.dataTransfer.files);
            }}
            style={S.drop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/svg+xml,image/tiff,image/webp,application/pdf,.eps,.ai"
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files?.length) void readFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div style={S.dropPlus}>+</div>
            <p style={S.dropTitle}>Dra filer hit eller klicka</p>
            <p style={S.dropHint}>PNG, JPG, SVG, TIFF, PDF, EPS — markera flera filer samtidigt</p>
          </div>

          {/* A finished 58 cm sheet does not need building — hand them to
              the upload flow instead of making them lay it out again. */}
          {hasUploadFlow && !adding && (
            <p style={S.readyHint}>
              Har du redan ett färdigt ark på 58 cm bredd?{" "}
              <button onClick={openUploadFlow} style={S.readyLink}>
                Ladda upp det i stället →
              </button>
            </p>
          )}

          {/* Step 2 — size and count, for all at once or one by one */}
          {drafts.length > 0 && (
            <>
              <Step n={2} title="Hur stora och hur många?" done={false} />
              {drafts.length > 1 && <BulkBar onApply={applyToAll} />}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {drafts.map((d) => (
                  <DraftRow
                    key={d.id}
                    draft={d}
                    gapMm={gapMm}
                    onBgMode={(mode) => d.uploaded && void takeOffBackground(d.id, d.uploaded.id, mode)}
                    onChange={(patch) => update(d.id, patch)}
                    onRemove={() => {
                      URL.revokeObjectURL(d.blobUrl);
                      queueRef.current = queueRef.current.filter((q) => q.id !== d.id);
                      setDrafts((prev) => prev.filter((x) => x.id !== d.id));
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        {showPreview && plan && (
          <aside style={S.previewCol}>
            <SheetPreview
              pieces={plan.pieces}
              sheetWidthMm={SHEET_WIDTH_MM}
              sheetHeightMm={plan.sheet.heightMm}
              label={plan.sheet.label.replace(/ \(.*\)$/, "")}
            />
          </aside>
        )}
        </div>

        {/* Footer — the plan */}
        <div style={S.foot}>
          {plan ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={S.planMain}>
                {adding ? `${existing.length} + ${plan.total}` : plan.total} motiv →{" "}
                <strong>{plan.sheet.label.replace(/ \(.*\)$/, "")}</strong>
                {plan.price !== null && <span style={{ color: theme.textMuted }}> · {plan.price} kr</span>}
              </p>
              <p style={S.planSub}>
                {plan.tooBig
                  ? "Mer än 10 meter — dela upp på flera ark efter att du byggt."
                  : `Behöver ca ${(plan.neededMm / 10).toFixed(0)} cm film.`}
              </p>
            </div>
          ) : (
            <p style={{ ...S.planSub, flex: 1 }}>
              Ladda upp minst ett motiv för att komma igång.
            </p>
          )}
          <button
            onClick={() => void handleBuild()}
            disabled={!canBuild}
            style={{
              ...S.cta,
              background: canBuild ? theme.accent : theme.bgInput,
              color: canBuild ? "#fff" : theme.textDim,
              cursor: canBuild ? "pointer" : "not-allowed",
            }}
          >
            {buildLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One width and count for every design — the "50 logos at 8 cm" case. */
function BulkBar({
  onApply,
}: {
  onApply: (patch: { widthCm?: number; count?: number; preset?: SizePreset }) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [width, setWidth] = useState("");
  const [count, setCount] = useState("");
  const apply = () => {
    const w = parseFloat(width.replace(",", "."));
    const c = parseInt(count, 10);
    if (Number.isFinite(w) && w > 0) setActive(null);
    onApply({
      ...(Number.isFinite(w) && w > 0 ? { widthCm: Math.min(58, Math.max(1, w)) } : {}),
      ...(Number.isFinite(c) && c > 0 ? { count: Math.min(5000, c) } : {}),
    });
  };
  return (
    <div style={S.bulk}>
      <span style={S.bulkTitle}>Samma för alla</span>
      <div style={S.presets}>
        {SIZE_PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              setActive(p.label);
              setWidth("");
              onApply({ preset: p });
            }}
            title={`Varje motiv anpassas så att det ryms i ${p.w} × ${p.h} cm`}
            style={{
              ...S.preset,
              borderColor: active === p.label ? theme.accent : theme.border,
              background: active === p.label ? theme.accentBg : theme.bgCard,
              color: active === p.label ? theme.accent : theme.textMuted,
            }}
          >
            {p.label} <span style={{ opacity: 0.7 }}>{p.w}×{p.h}</span>
          </button>
        ))}
      </div>
      <div style={S.fields}>
        <Field label="Bredd (cm)">
          <input
            type="number"
            min={1}
            max={58}
            step={0.5}
            value={width}
            placeholder="t.ex. 8"
            onChange={(e) => setWidth(e.target.value)}
            style={S.input}
          />
        </Field>
        <Field label="Antal av varje">
          <input
            type="number"
            min={1}
            value={count}
            placeholder="t.ex. 20"
            onChange={(e) => setCount(e.target.value)}
            style={S.input}
          />
        </Field>
        <button onClick={apply} style={S.bulkApply}>
          Använd på alla
        </button>
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  gapMm,
  onChange,
  onBgMode,
  onRemove,
}: {
  draft: Draft;
  gapMm: number;
  onChange: (patch: Partial<Draft>) => void;
  onBgMode: (mode: BgMode) => void;
  onRemove: () => void;
}) {
  const widthMm = draft.widthCm * 10;
  const heightMm = (draft.heightPx / draft.widthPx) * widthMm;
  const dpi = calculateDisplayDpi(draft.widthPx, widthMm);
  const warning = draft.vector || draft.status !== "ready" ? null : dpiWarning(dpi);
  // Largest width that still prints sharp, for a one-click fix.
  const sharpCm = Math.floor((draft.widthPx / DPI_THRESHOLDS.good) * 2.54 * 2) / 2;

  // How many of this design alone would fill one metre — the answer to
  // "how many do I get for the minimum order?"
  const perMetre = capacity(
    widthMm,
    heightMm,
    { widthMm: SHEET_WIDTH_MM, heightMm: 1000 },
    gapMm,
  ).total;

  const bgOff = draft.useBgRemoved && draft.bgRemovedUrl;
  const thumb = bgOff ? draft.bgRemovedUrl! : draft.previewUrl || draft.uploaded?.thumbnailUrl || "";

  return (
    <div style={{ ...S.row, borderColor: draft.status === "failed" ? theme.danger : theme.border }}>
      <div style={S.thumbWrap}>
        {thumb ? <img src={thumb} alt="" style={S.thumb} /> : <span style={S.thumbEmpty}>{draft.file.name.split(".").pop()?.toUpperCase()}</span>}
        {draft.status === "uploading" && <span style={S.thumbBusy}><Spinner /></span>}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.rowHead}>
          <span style={S.rowName}>{draft.file.name}</span>
          <span style={{ ...S.status, color: draft.status === "failed" ? theme.danger : draft.status === "ready" ? theme.success : theme.textDim }}>
            {draft.status === "uploading"
              ? draft.processing
                ? "Bearbetar…"
                : `Laddar upp ${Math.round((draft.sent ?? 0) * 100)} %`
              : draft.status === "ready"
                ? "✓"
                : "Misslyckades"}
          </span>
          <button onClick={onRemove} style={S.rowRemove} title="Ta bort">
            ×
          </button>
        </div>

        {draft.status === "uploading" && (
          <div style={S.uploadTrack} aria-hidden>
            <div
              style={{
                ...S.uploadFill,
                width: `${Math.max(4, Math.round((draft.processing ? 1 : draft.sent ?? 0) * 100))}%`,
                ...(draft.processing ? S.uploadProcessing : null),
              }}
            />
          </div>
        )}
        {draft.status === "failed" ? (
          <p style={S.warn}>Filen kunde inte laddas upp. Prova att spara den som PNG och ladda upp igen.</p>
        ) : (
          <>
            <div style={S.presets}>
              {SIZE_PRESETS.map((p) => {
                const active = draft.preset === p.label;
                return (
                  <button
                    key={p.label}
                    title={`Ryms i ${p.w} × ${p.h} cm`}
                    onClick={() =>
                      onChange({ preset: p.label, widthCm: fitWidthCm(p, draft.widthPx, draft.heightPx) })
                    }
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
                      preset: undefined,
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
                  max={5000}
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
                  {cmText(widthMm)} × {cmText(heightMm)} cm
                  {draft.status === "ready" &&
                    (draft.vector ? (
                      <span style={{ color: theme.success, fontWeight: 600, marginLeft: 6 }}>Vektor</span>
                    ) : (
                      <span style={{ color: getDpiColor(dpi), fontWeight: 600, marginLeft: 6 }}>
                        {dpi} DPI
                      </span>
                    ))}
                </p>
              </div>
            </div>

            <p style={S.hint}>
              {perMetre > 0
                ? `Ca ${perMetre} st ryms på 1 meter film.`
                : "Motivet är för stort för arkets bredd."}
            </p>
            {warning && (
              <p style={S.warn}>
                ⚠ {warning}
                {sharpCm >= 1 && sharpCm < draft.widthCm && (
                  <>
                    {" "}
                    <button onClick={() => onChange({ widthCm: sharpCm, preset: undefined })} style={S.inlineLink}>
                      Använd {String(sharpCm).replace(".", ",")} cm
                    </button>
                  </>
                )}
              </p>
            )}
            {draft.bgBusy && <p style={S.note}>Tar bort vitt…</p>}
            {draft.bgRemovedUrl && !draft.bgBusy && (
              <p style={S.note}>
                {!draft.useBgRemoved
                  ? "Den vita bakgrunden behålls och trycks som vitt."
                  : draft.bgMode === "all"
                    ? "Allt vitt borttaget, även inuti motivet."
                    : "Vit bakgrund borttagen — annars trycks den som en vit ruta. Vitt inuti motivet trycks vitt."}{" "}
                <button
                  onClick={() => onChange({ useBgRemoved: !draft.useBgRemoved })}
                  style={S.inlineLink}
                >
                  {draft.useBgRemoved ? "Behåll bakgrunden" : "Ta bort den"}
                </button>
                {draft.useBgRemoved && (
                  <>
                    {" · "}
                    <button
                      onClick={() => onBgMode(draft.bgMode === "all" ? "background" : "all")}
                      style={S.inlineLink}
                    >
                      {draft.bgMode === "all" ? "Bara bakgrunden" : "Ta bort även vitt inuti"}
                    </button>
                  </>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        border: `2px solid ${theme.accent}40`,
        borderTopColor: theme.accent,
        borderRadius: "50%",
        animation: "gs-spin 0.8s linear infinite",
        display: "inline-block",
      }}
    />
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
    <div style={{ width: 96 }}>
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
  body: { flex: 1, minWidth: 0, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12 },
  previewCol: {
    width: 230,
    flexShrink: 0,
    borderLeft: `1px solid ${theme.border}`,
    background: theme.bgSidebar,
    padding: 20,
    overflow: "auto",
    display: "flex",
    justifyContent: "center",
  },
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
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  thumbWrap: {
    position: "relative",
    width: 56,
    height: 56,
    flexShrink: 0,
    borderRadius: theme.radiusSm,
    // Checks show what is transparent — the point of removing a background.
    background: "repeating-conic-gradient(#e5e5e5 0% 25%, #fff 0% 50%) 50%/10px 10px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbEmpty: { fontSize: 10, fontWeight: 700, color: theme.textDim },
  thumbBusy: {
    position: "absolute",
    inset: 0,
    background: "rgba(255,255,255,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  status: { fontSize: theme.fontSize.labelMd, flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  uploadTrack: { height: 4, borderRadius: 2, background: "#eceef1", overflow: "hidden", margin: "6px 0 2px" },
  uploadFill: { height: "100%", background: theme.accent, borderRadius: 2, transition: "width 0.25s ease" },
  // The server's part has no byte count: a moving stripe says it is working.
  uploadProcessing: {
    backgroundImage: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)",
    backgroundSize: "200% 100%",
    animation: "gs-shimmer 1.1s linear infinite",
  },
  bulk: {
    padding: 12,
    border: `1px dashed ${theme.accent}`,
    borderRadius: theme.radius,
    background: theme.accentBg,
  },
  bulkTitle: {
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.text,
  },
  bulkApply: {
    alignSelf: "flex-end",
    padding: "8px 12px",
    border: "none",
    borderRadius: 6,
    background: theme.accent,
    color: "#fff",
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
  },
  note: { margin: "4px 0 0", fontSize: theme.fontSize.labelMd, color: theme.textMuted },
  inlineLink: {
    border: "none",
    background: "transparent",
    padding: 0,
    color: theme.accent,
    fontSize: theme.fontSize.labelMd,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
    textDecoration: "underline",
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
  readyHint: {
    margin: 0,
    textAlign: "center",
    fontSize: theme.fontSize.labelMd,
    color: theme.textMuted,
  },
  readyLink: {
    border: "none",
    background: "transparent",
    padding: 0,
    color: theme.accent,
    fontSize: theme.fontSize.labelMd,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
    textDecoration: "underline",
  },
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
