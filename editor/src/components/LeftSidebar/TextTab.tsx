import { useEffect, useMemo, useRef, useState } from "react";
import { groupKey, useEditorStore } from "../../store/editorStore";
import { ensureGangSheet, getAppProxyUrl, uploadImage } from "../../services/api";
import {
  DEFAULT_FONT_ID,
  FONT_CATEGORIES,
  TEXT_FONTS,
  fontById,
  fontFamily,
  loadFont,
  type FontCategory,
} from "../../config/fonts";
import { renderTextForPrint, renderTextPreview, type TextSpec } from "../../utils/textRender";
import { showToast } from "../../utils/toast";
import { theme } from "../../styles/theme";
import { useIsMobile } from "../../utils/useIsMobile";
import { NamesModal } from "../../names/NamesModal";

/**
 * Text for the sheet: pick a font with your own words as the sample, a
 * colour, an outline and how wide it prints, and see it on the garment
 * colour first. A text on the sheet can be selected and changed later — a
 * typo used to mean deleting it and starting over.
 */

const COLORS: { value: string; label: string }[] = [
  { value: "#000000", label: "Svart" },
  { value: "#ffffff", label: "Vit" },
  { value: "#d1202f", label: "Röd" },
  { value: "#1d2742", label: "Marinblå" },
  { value: "#2f5fc4", label: "Blå" },
  { value: "#1f7a3a", label: "Grön" },
  { value: "#f5c400", label: "Gul" },
  { value: "#f08a24", label: "Orange" },
  { value: "#e85d9e", label: "Rosa" },
  { value: "#6b3fa0", label: "Lila" },
  { value: "#8a8d91", label: "Grå" },
  { value: "#c9a227", label: "Guld" },
];

const OUTLINES: { value: number; label: string }[] = [
  { value: 0, label: "Ingen" },
  { value: 0.03, label: "Tunn" },
  { value: 0.06, label: "Mellan" },
  { value: 0.1, label: "Tjock" },
];

const WIDTHS: { cm: number; label: string }[] = [
  { cm: 7, label: "Ärm" },
  { cm: 9, label: "Bröst" },
  { cm: 25, label: "Framsida" },
  { cm: 30, label: "Rygg" },
];

const DEFAULT_SPEC: TextSpec = {
  text: "",
  fontId: DEFAULT_FONT_ID,
  color: "#000000",
  outline: 0,
  outlineColor: "#ffffff",
  align: "center",
};

/** Widest that prints: the film is 58 cm with 5 mm kept free each side. */
const MAX_WIDTH_CM = 57;

/**
 * `onDone`: called once a text is on the sheet. The phone closes its
 * drawer there, so the customer sees the text land instead of the same
 * form still filled in, inviting a second tap and a duplicate.
 */
export function TextTab({ onDone }: { onDone?: () => void } = {}) {
  const images = useEditorStore((s) => s.images);
  const selectedImageId = useEditorStore((s) => s.selectedImageId);
  const canvasBg = useEditorStore((s) => s.canvasBg);
  const isMobile = useIsMobile();

  /**
   * A text just added is selected on the sheet but not "being edited":
   * otherwise the next text typed would replace it instead of joining it.
   * Selecting it again later does edit it.
   */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  useEffect(() => {
    if (justAdded && selectedImageId !== justAdded) setJustAdded(null);
  }, [selectedImageId, justAdded]);

  const editing = useMemo(() => {
    const img = images.find((i) => i.id === selectedImageId);
    return img?.text && img.id !== justAdded ? img : null;
  }, [images, selectedImageId, justAdded]);
  const editingCopies = editing
    ? images.filter((i) => groupKey(i) === groupKey(editing)).length
    : 0;

  const [spec, setSpec] = useState<TextSpec>(DEFAULT_SPEC);
  const [widthCm, setWidthCm] = useState(20);
  const [category, setCategory] = useState<FontCategory | "all">("all");
  const [busy, setBusy] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const [, setFontsLoaded] = useState(0);
  const update = (patch: Partial<TextSpec>) => setSpec((s) => ({ ...s, ...patch }));

  // Selecting a text on the sheet brings its settings here.
  const editingKey = editing ? `${editing.id}:${editing.dbId}` : null;
  useEffect(() => {
    if (!editing?.text) return;
    const { widthMm: _w, ...rest } = editing.text;
    setSpec({ ...DEFAULT_SPEC, ...rest });
    setWidthCm(Math.round(editing.displayWidth) / 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingKey]);

  // Every font, so each button shows itself. ~700 KB, only once.
  useEffect(() => {
    for (const f of TEXT_FONTS) {
      void loadFont(f).then(() => setFontsLoaded((n) => n + 1));
    }
  }, []);

  const firstLine = spec.text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const sample = firstLine ? firstLine.slice(0, 16) : "Abc Åäö";
  const multiline = spec.text.trim().includes("\n");
  const fonts = category === "all" ? TEXT_FONTS : TEXT_FONTS.filter((f) => f.category === category);
  const width = Math.min(MAX_WIDTH_CM, Math.max(1, widthCm || 0));
  const ready = firstLine.length > 0 && !busy;

  const submit = async (mode: "add" | "replace") => {
    if (!ready) return;
    const state = useEditorStore.getState();
    setBusy(true);
    state.setUploading(true);
    try {
      const rendered = await renderTextForPrint(spec, width * 10);
      if (!rendered) throw new Error("Det finns ingen text att lägga till");
      const blob: Blob | null = await new Promise((resolve) =>
        rendered.canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("Texten är för stor för webbläsaren — prova en mindre bredd");
      const slug = firstLine.toLowerCase().replace(/[^a-z0-9åäö]+/gi, "-").slice(0, 24) || "text";
      const file = new File([blob], `text-${slug}.png`, { type: "image/png" });

      const gsId = await ensureGangSheet(
        state.sessionId,
        state.sheetSize.widthMm,
        state.sheetSize.heightMm,
        state.filmType,
        state.gangSheetId,
      );
      if (gsId !== state.gangSheetId) state.setGangSheetId(gsId);
      const result = await uploadImage(file, state.sessionId, gsId || "");

      const base = getAppProxyUrl();
      const abs = (url: string) => (url?.startsWith("/") ? base + url : url);
      const mm = rendered.mmPerPx;
      const dpi = Math.round(25.4 / mm);
      const art = {
        dbId: result.id,
        filename: `Text: ${firstLine.slice(0, 24)}`,
        thumbnailUrl: abs(result.thumbnailUrl),
        originalUrl: abs(result.originalUrl),
        widthPx: result.width,
        heightPx: result.height,
        dpiX: dpi,
        dpiY: dpi,
        displayWidth: result.width * mm,
        displayHeight: result.height * mm,
        bgRemoved: true,
        bgRemovedUrl: undefined,
        hasWhiteBackground: false,
        text: { ...spec, widthMm: width * 10 },
      };

      if (mode === "replace" && editing) {
        state.replaceArtwork(groupKey(editing), art);
        showToast("Texten är uppdaterad.", "success");
      } else {
        // Position is a placeholder: addImage finds a free spot.
        const id = result.imageId || result.id;
        setJustAdded(id);
        state.addImage({
          ...art,
          id,
          groupId: "grp_" + Math.random().toString(36).slice(2, 10),
          positionX: 0,
          positionY: 0,
          rotation: 0,
          flipX: false,
          flipY: false,
          quantity: 1,
          marginMm: state.gapMm,
          placed: true,
        });
        showToast("Texten ligger på arket.", "success");
      }
      onDone?.();
    } catch (err) {
      showToast(`Kunde inte lägga till texten: ${(err as Error).message}`, "error");
    } finally {
      state.setUploading(false);
      setBusy(false);
    }
  };

  return (
    <>
      <div style={T.header}>{editing ? "Ändra text" : "Lägg till text"}</div>
      <div style={T.body}>
        {/* A whole team at once: much quicker than one text at a time. */}
        <button type="button" onClick={() => setNamesOpen(true)} style={T.namesCard}>
          <span style={T.namesIcon}>
            <span style={{ fontSize: 10, fontWeight: 800, lineHeight: 1 }}>NAMN</span>
            <span style={{ fontSize: 17, fontWeight: 800, lineHeight: 1 }}>10</span>
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, textAlign: "left" }}>
            <span style={{ fontWeight: 700, color: theme.text }}>Namn och nummer</span>
            <span style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted }}>Hela laget på en gång, från lista, Excel eller CSV</span>
          </span>
          <span style={{ marginLeft: "auto", color: theme.accent, fontSize: 18 }}>›</span>
        </button>
        {namesOpen && <NamesModal onClose={() => setNamesOpen(false)} />}
        {editing && (
          <div style={T.editingNote}>
            Du ändrar den markerade texten
            {editingCopies > 1 ? ` (alla ${editingCopies} kopior)` : ""}.{" "}
            <button
              type="button"
              onClick={() => useEditorStore.getState().selectImage(null)}
              style={T.linkButton}
            >
              Skriv en ny text i stället
            </button>
          </div>
        )}

        <textarea
          value={spec.text}
          onChange={(e) => update({ text: e.target.value })}
          placeholder="Skriv din text… (Enter ger ny rad)"
          rows={2}
          aria-label="Text"
          style={T.textarea}
        />

        <Preview spec={spec} widthCm={width} backdrop={canvasBg} />

        <Section label="Typsnitt">
          <div style={T.chips}>
            {[{ id: "all" as const, label: "Alla" }, ...FONT_CATEGORIES].map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                style={{ ...T.chip, ...(category === c.id ? T.chipActive : null) }}
              >
                {c.label}
              </button>
            ))}
          </div>
          {/* Its own scroll on desktop; in the phone drawer, scroll in scroll fights the thumb. */}
          <div style={isMobile ? { ...T.fontGrid, maxHeight: "none", overflowY: "visible" } : T.fontGrid}>
            {fonts.map((f) => {
              const active = spec.fontId === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => update({ fontId: f.id })}
                  aria-pressed={active}
                  title={f.name}
                  style={{ ...T.fontButton, ...(active ? T.fontButtonActive : null) }}
                >
                  <span
                    style={{
                      fontFamily: `"${fontFamily(f)}", ${theme.fontFamily}`,
                      fontSize: 19,
                      lineHeight: 1.25,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: "100%",
                      color: theme.text,
                    }}
                  >
                    {sample}
                  </span>
                  <span style={T.fontName}>{f.name}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section label="Färg">
          <Swatches value={spec.color} onChange={(color) => update({ color })} />
        </Section>

        <Section label="Kontur">
          <Segmented
            options={OUTLINES.map((o) => ({ value: String(o.value), label: o.label }))}
            value={String(spec.outline)}
            onChange={(v) => update({ outline: Number(v) })}
          />
          {spec.outline > 0 && (
            <div style={{ marginTop: 8 }}>
              <Swatches value={spec.outlineColor} onChange={(outlineColor) => update({ outlineColor })} />
            </div>
          )}
        </Section>

        {multiline && (
          <Section label="Radernas placering">
            <Segmented
              options={[
                { value: "left", label: "Vänster" },
                { value: "center", label: "Mitten" },
                { value: "right", label: "Höger" },
              ]}
              value={spec.align}
              onChange={(v) => update({ align: v as TextSpec["align"] })}
            />
          </Section>
        )}

        <Section label="Bredd på plagget">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={MAX_WIDTH_CM}
              step={0.5}
              value={widthCm}
              onChange={(e) => setWidthCm(parseFloat(e.target.value.replace(",", ".")) || 0)}
              aria-label="Bredd i centimeter"
              style={T.widthInput}
            />
            <span style={{ fontSize: theme.fontSize.bodySm, color: theme.textMuted }}>cm</span>
          </div>
          <div style={{ ...T.chips, marginTop: 8 }}>
            {WIDTHS.map((w) => (
              <button
                key={w.cm}
                type="button"
                onClick={() => setWidthCm(w.cm)}
                style={{ ...T.chip, ...(widthCm === w.cm ? T.chipActive : null) }}
              >
                {w.label} {w.cm} cm
              </button>
            ))}
          </div>
        </Section>
      </div>

      {/* Always in view: below 34 fonts it was easy to never find. */}
      <div style={T.footer}>
        <button
          type="button"
          onClick={() => void submit(editing ? "replace" : "add")}
          disabled={!ready}
          style={{ ...T.primary, ...(ready ? null : T.primaryDisabled) }}
        >
          {busy ? "Lägger till…" : editing ? "Uppdatera texten" : "Lägg till på arket"}
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => void submit("add")}
            disabled={!ready}
            style={T.secondary}
          >
            Lägg till som ny text
          </button>
        )}
      </div>
    </>
  );
}

function Preview({ spec, widthCm, backdrop }: { spec: TextSpec; widthCm: number; backdrop: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<{ url: string; aspect: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const box = boxRef.current;
    const w = Math.max(120, (box?.clientWidth ?? 260) - 24);
    const dpr = window.devicePixelRatio || 1;
    const t = window.setTimeout(() => {
      void renderTextPreview(spec, w * dpr, 110 * dpr).then((r) => {
        if (cancelled) return;
        setImg(r ? { url: r.canvas.toDataURL("image/png"), aspect: r.aspect } : null);
      });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [spec]);

  const plain = backdrop === "checks" || !/^#[0-9a-f]{6}$/i.test(backdrop);
  const dark = !plain && luminance(backdrop) < 0.4;
  const heightCm = img ? Math.round(widthCm * img.aspect * 10) / 10 : null;
  return (
    <div>
      <div
        ref={boxRef}
        style={{
          ...T.preview,
          ...(plain
            ? {
                backgroundImage:
                  "linear-gradient(45deg, #b4b4b4 25%, transparent 25%), linear-gradient(-45deg, #b4b4b4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #b4b4b4 75%), linear-gradient(-45deg, transparent 75%, #b4b4b4 75%)",
                backgroundSize: "16px 16px",
                backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
                backgroundColor: "#cdcdcd",
              }
            : { background: backdrop }),
        }}
      >
        {img && spec.text.trim() ? (
          <img src={img.url} alt="" style={{ maxWidth: "100%", maxHeight: 110, display: "block" }} />
        ) : (
          <span style={{ color: dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.5)", fontSize: theme.fontSize.bodySm }}>
            Skriv något så syns det här
          </span>
        )}
      </div>
      {heightCm !== null && spec.text.trim() && (
        <div style={T.previewSize}>
          Trycks {fmt(widthCm)} × {fmt(heightCm)} cm · {fontById(spec.fontId).name}
        </div>
      )}
    </div>
  );
}

/** 0 (black) to 1 (white), for picking a readable hint colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function fmt(n: number): string {
  return n.toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={T.label}>{label}</div>
      {children}
    </div>
  );
}

function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const custom = !COLORS.some((c) => c.value === value);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          title={c.label}
          aria-label={c.label}
          aria-pressed={value === c.value}
          onClick={() => onChange(c.value)}
          style={{
            ...T.swatch,
            background: c.value,
            boxShadow: value === c.value ? `0 0 0 2px #fff, 0 0 0 4px ${theme.accent}` : "none",
          }}
        />
      ))}
      <label
        title="Egen färg"
        style={{
          ...T.swatch,
          position: "relative",
          background: custom ? value : "conic-gradient(#e53935, #fdd835, #43a047, #1e88e5, #8e24aa, #e53935)",
          boxShadow: custom ? `0 0 0 2px #fff, 0 0 0 4px ${theme.accent}` : "none",
        }}
      >
        <input
          type="color"
          aria-label="Egen färg"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
        />
      </label>
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={T.segmented}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          style={{ ...T.segment, ...(value === o.value ? T.segmentActive : null) }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const T: Record<string, React.CSSProperties> = {
  header: {
    padding: `${theme.space.lg}px ${theme.space.lg}px ${theme.space.sm}px`,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: theme.letterSpacing.wide,
    color: theme.textMuted,
  },
  // A grid, not a flex column: in the phone drawer a column squeezed the
  // text field down to half a line.
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: `${theme.space.sm}px ${theme.space.lg}px ${theme.space.lg}px`,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    gap: theme.space.lg,
  },
  editingNote: {
    padding: "8px 10px",
    borderRadius: theme.radiusSm,
    background: theme.accentBg,
    color: theme.text,
    fontSize: theme.fontSize.labelMd,
  },
  namesCard: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    width: "100%",
    padding: "12px 14px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 14,
    background: "linear-gradient(135deg, #ffffff 0%, #fff5f5 100%)",
    cursor: "pointer",
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.bodySm,
  },
  namesIcon: {
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: 10,
    background: theme.secondary,
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  linkButton: {
    padding: 0,
    border: "none",
    background: "none",
    color: theme.accent,
    font: "inherit",
    fontWeight: theme.fontWeight.semibold,
    textDecoration: "underline",
    cursor: "pointer",
  },
  textarea: {
    width: "100%",
    // Two lines. `rows` alone gave way to the layout around it.
    minHeight: 68,
    lineHeight: 1.4,
    padding: theme.space.md,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusSm,
    fontSize: theme.fontSize.bodyMd,
    fontFamily: theme.fontFamily,
    background: theme.bg,
    color: theme.text,
    resize: "vertical",
    boxSizing: "border-box",
  },
  preview: {
    minHeight: 110,
    borderRadius: theme.radiusSm,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
    border: `1px solid ${theme.border}`,
  },
  previewSize: {
    marginTop: 6,
    fontSize: theme.fontSize.labelMd,
    color: theme.textMuted,
  },
  label: {
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    color: theme.text,
    marginBottom: 6,
  },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    padding: "4px 10px",
    borderRadius: 999,
    border: `1px solid ${theme.borderStrong}`,
    background: theme.bg,
    color: theme.text,
    fontSize: theme.fontSize.labelMd,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  // Whole `border`, not borderColor: React drops a longhand when it goes
  // away and the border turns black instead of back to the shorthand's.
  chipActive: {
    background: theme.secondary,
    border: `1px solid ${theme.secondary}`,
    color: "#fff",
  },
  fontGrid: {
    marginTop: 8,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
    maxHeight: 236,
    overflowY: "auto",
    padding: 2,
    margin: "6px -2px 0",
  },
  fontButton: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    padding: "8px 10px",
    minWidth: 0,
    borderRadius: theme.radiusSm,
    border: `1px solid ${theme.border}`,
    background: theme.bg,
    cursor: "pointer",
    textAlign: "left",
  },
  fontButtonActive: {
    border: `1px solid ${theme.accent}`,
    boxShadow: `0 0 0 1px ${theme.accent}`,
    background: theme.accentBg,
  },
  fontName: {
    fontSize: theme.fontSize.labelXs,
    color: theme.textMuted,
    fontFamily: theme.fontFamily,
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: "50%",
    border: "1px solid rgba(0,0,0,0.15)",
    padding: 0,
    cursor: "pointer",
    flexShrink: 0,
  },
  segmented: {
    display: "flex",
    padding: 3,
    gap: 3,
    borderRadius: theme.radiusSm,
    background: theme.bgInput,
  },
  segment: {
    flex: 1,
    padding: "6px 4px",
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: theme.textMuted,
    fontSize: theme.fontSize.labelMd,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  segmentActive: {
    background: theme.bg,
    color: theme.text,
    fontWeight: theme.fontWeight.semibold,
    boxShadow: theme.shadow,
  },
  widthInput: {
    width: 90,
    padding: "8px 10px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusSm,
    fontSize: theme.fontSize.bodyMd,
    fontFamily: theme.fontFamily,
    background: theme.bg,
    color: theme.text,
  },
  primary: {
    width: "100%",
    padding: `${theme.space.md}px`,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    fontFamily: theme.fontFamily,
    border: "none",
    borderRadius: theme.radius,
    background: theme.accentGradient,
    color: "#fff",
    cursor: "pointer",
  },
  primaryDisabled: {
    background: theme.bgInput,
    color: theme.textDim,
    cursor: "not-allowed",
  },
  footer: {
    flexShrink: 0,
    padding: `${theme.space.md}px ${theme.space.lg}px`,
    borderTop: `1px solid ${theme.border}`,
    background: theme.bgSidebar,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  secondary: {
    width: "100%",
    padding: `${theme.space.sm}px`,
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radius,
    background: theme.bg,
    color: theme.text,
    cursor: "pointer",
  },
};
