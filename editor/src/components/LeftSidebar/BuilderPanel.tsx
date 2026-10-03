import { useState } from "react";
import { ImageUploader } from "../ImagePanel/ImageUploader";
import { ImageList } from "../ImagePanel/ImageList";
import { ArrangeButton } from "../Toolbar/ArrangeButton";
import { TextTab } from "./TextTab";
import { NamesModal } from "../../names/NamesModal";
import { groupImages, useEditorStore } from "../../store/editorStore";
import { GAP_PRESETS, GAP_PRESET_LABELS, gapPresetFromMm, type GapPreset } from "../../utils/layout";
import { theme } from "../../styles/theme";

/**
 * The builder's left side, actions first: add designs (the guide, with
 * sizes and counts), text, a whole team's names and numbers — then the
 * designs on the sheet and the layout tools. Replaces a strip of icon tabs
 * where "Inställningar" held one setting and the add button lived in the
 * header.
 */
export function BuilderPanel({ onAddDesigns }: { onAddDesigns: () => void }) {
  const [view, setView] = useState<"designs" | "text">("designs");
  const [namesOpen, setNamesOpen] = useState(false);
  const images = useEditorStore((s) => s.images);
  const designs = groupImages(images).length;

  if (view === "text") {
    return (
      <aside style={P.panel}>
        <button type="button" onClick={() => setView("designs")} style={P.back}>
          ‹ Tillbaka till motiven
        </button>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <TextTab />
        </div>
      </aside>
    );
  }

  return (
    <aside style={P.panel}>
      <div style={P.actions}>
        <button type="button" onClick={onAddDesigns} style={P.primary}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>＋</span> Lägg till motiv
        </button>
        <div style={P.row}>
          <button type="button" onClick={() => setView("text")} style={P.secondary}>
            <span style={P.icon}>T</span> Text
          </button>
          <button type="button" onClick={() => setNamesOpen(true)} style={P.secondary}>
            <span style={{ ...P.icon, fontSize: 10, letterSpacing: "-0.02em" }}>10</span> Namn &amp; nummer
          </button>
        </div>
      </div>

      <div style={P.scroll}>
        <div style={P.sectionHead}>
          <span>Dina motiv</span>
          {designs > 0 && <span style={P.count}>{designs}</span>}
        </div>
        <ImageUploader compact />
        <ImageList />

        <div style={{ ...P.sectionHead, marginTop: 18 }}>
          <span>Smart layout</span>
        </div>
        <ArrangeButton />
        <GapSetting />
      </div>

      {namesOpen && <NamesModal onClose={() => setNamesOpen(false)} />}
    </aside>
  );
}

/** One gap for the whole sheet: the space to cut in between designs. */
function GapSetting() {
  const gapMm = useEditorStore((s) => s.gapMm);
  const setGapMm = useEditorStore((s) => s.setGapMm);
  const active = gapPresetFromMm(gapMm);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, marginBottom: 6 }}>Mellanrum mellan motiv</div>
      <div style={P.segmented}>
        {(Object.keys(GAP_PRESETS) as GapPreset[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setGapMm(GAP_PRESETS[key])}
            aria-pressed={active === key}
            style={{ ...P.segment, ...(active === key ? P.segmentOn : null) }}
          >
            {GAP_PRESET_LABELS[key]}
            <span style={{ display: "block", fontSize: 10, opacity: 0.7 }}>{GAP_PRESETS[key]} mm</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const P: Record<string, React.CSSProperties> = {
  panel: {
    background: theme.bgSidebar,
    borderRight: `1px solid ${theme.border}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minWidth: 0,
  },
  actions: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderBottom: `1px solid ${theme.border}`,
    background: theme.bg,
  },
  primary: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    padding: "13px 14px",
    border: "none",
    borderRadius: 12,
    background: theme.accent,
    color: "#fff",
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.bodyMd,
    fontWeight: theme.fontWeight.bold,
    cursor: "pointer",
    boxShadow: `0 4px 14px ${theme.accent}40`,
  },
  row: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  secondary: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "10px 6px",
    whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 12,
    background: theme.bg,
    color: theme.text,
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
  },
  icon: {
    width: 22,
    height: 22,
    borderRadius: 6,
    background: theme.secondary,
    color: "#fff",
    fontSize: 12,
    fontWeight: 800,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  back: {
    border: "none",
    borderBottom: `1px solid ${theme.border}`,
    background: theme.bg,
    textAlign: "left",
    padding: "12px 16px",
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.accent,
    cursor: "pointer",
  },
  scroll: { flex: 1, minHeight: 0, overflow: "auto", padding: "14px 16px 18px", display: "flex", flexDirection: "column", gap: 8 },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: theme.textMuted,
  },
  count: {
    minWidth: 20,
    height: 20,
    padding: "0 6px",
    borderRadius: 10,
    background: theme.secondary,
    color: "#fff",
    fontSize: 11,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    letterSpacing: 0,
  },
  segmented: { display: "flex", gap: 4, padding: 3, borderRadius: 10, background: theme.bgInput },
  segment: {
    flex: 1,
    border: "none",
    background: "transparent",
    borderRadius: 8,
    padding: "6px 4px",
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.labelMd,
    color: theme.textMuted,
    cursor: "pointer",
  },
  segmentOn: { background: theme.bg, color: theme.text, fontWeight: theme.fontWeight.semibold, boxShadow: theme.shadow },
};
