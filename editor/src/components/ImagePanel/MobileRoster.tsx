import { useEffect, useMemo, useRef, useState } from "react";
import {
  useEditorStore,
  groupImages,
  type EditorImage,
  type ImageGroup,
} from "../../store/editorStore";
import {
  calculateDisplayDpi,
  getDpiColor,
  getDpiLevel,
  DPI_LEVEL_LABELS,
  cmText,
} from "../../utils/units";
import { freeCapacityFor, imageBbox } from "../../utils/layout";
import { useSheetStats } from "../../utils/sheetStats";
import { showToast } from "../../utils/toast";
import { theme } from "../../styles/theme";
import { WhiteBackgroundBar, cropGroup, removeGroupBackground } from "./ImageList";

/**
 * The phone's list of designs: one card per design with how many, how big
 * and how sharp, each changed right there. The old list hid count and size
 * until a row was opened.
 */
export function MobileRoster() {
  const images = useEditorStore((s) => s.images);
  const selectedImageId = useEditorStore((s) => s.selectedImageId);
  const groups = useMemo(() => groupImages(images), [images]);
  const stats = useSheetStats();
  /** The design whose size fields are open. */
  const [editing, setEditing] = useState<string | null>(null);

  if (groups.length === 0) {
    return <p style={R.empty}>Inga motiv på arket ännu.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <WhiteBackgroundBar groups={groups} />
      {groups.map((group) => (
        <RosterCard
          key={group.groupId}
          group={group}
          selected={group.members.some((m) => m.id === selectedImageId)}
          problem={
            group.members.some((m) => stats.overlappingIds.has(m.id))
              ? "Ligger på ett annat motiv. Tryck på Ordna arket."
              : group.members.some((m) => stats.outsideIds.has(m.id))
                ? "Ligger utanför tryckytan. Tryck på Ordna arket."
                : null
          }
          editing={editing === group.groupId}
          onEditing={(on) => setEditing(on ? group.groupId : null)}
        />
      ))}
    </div>
  );
}

function designName(image: EditorImage): string {
  if (image.text?.text) return `"${image.text.text.replace(/\s+/g, " ").trim()}"`;
  return image.filename;
}

function RosterCard({
  group,
  selected,
  problem,
  editing,
  onEditing,
}: {
  group: ImageGroup;
  selected: boolean;
  problem: string | null;
  editing: boolean;
  onEditing: (on: boolean) => void;
}) {
  const selectImage = useEditorStore((s) => s.selectImage);
  const setGroupCount = useEditorStore((s) => s.setGroupCount);
  const removeGroup = useEditorStore((s) => s.removeGroup);

  const image = group.master;
  const dpi = calculateDisplayDpi(image.widthPx, image.displayWidth);
  const level = getDpiLevel(dpi);
  const weak = level === "bad" || level === "low";

  return (
    <div
      onClick={() => selectImage(image.id)}
      style={{
        ...R.card,
        borderColor: problem ? theme.danger : selected ? theme.accent : theme.border,
        background: selected ? "rgba(220, 47, 60, 0.035)" : theme.bgCard,
        boxShadow: selected ? `0 0 0 1px ${theme.accent}` : "none",
      }}
    >
      <div style={R.top}>
        <Thumb image={image} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={R.name}>{designName(image)}</p>
          <div style={R.meta}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                selectImage(image.id);
                onEditing(!editing);
              }}
              style={R.sizeChip}
              aria-expanded={editing}
              title="Ändra storlek"
            >
              {cmText(image.displayWidth)} × {cmText(image.displayHeight)} cm
              <span style={{ color: theme.textDim, display: "flex" }}>{ICON.pencil}</span>
            </button>
            <span
              style={{ ...R.dpi, color: getDpiColor(dpi) }}
              title={`${DPI_LEVEL_LABELS[level]} upplösning för DTF-tryck`}
            >
              {dpi} DPI{weak ? ` · ${DPI_LEVEL_LABELS[level]}` : ""}
            </span>
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Stepper value={group.count} onChange={(n) => setGroupCount(group.groupId, n)} />
          <button
            type="button"
            onClick={() => removeGroup(group.groupId)}
            style={R.trash}
            aria-label="Ta bort motivet"
            title="Ta bort motivet och alla kopior"
          >
            {ICON.trash}
          </button>
        </div>
      </div>

      {editing && <SizeFields image={image} onDone={() => onEditing(false)} />}

      {problem && <p style={R.problem}>{problem}</p>}

      {selected && (
        <div style={R.bottom} onClick={(e) => e.stopPropagation()}>
          <MoreActions group={group} />
        </div>
      )}
    </div>
  );
}

/** Rotate, fill the sheet, take off a white background, trim: for the design picked. */
function MoreActions({ group }: { group: ImageGroup }) {
  const images = useEditorStore((s) => s.images);
  const sheetSize = useEditorStore((s) => s.sheetSize);
  const gapMm = useEditorStore((s) => s.gapMm);
  const updateGroup = useEditorStore((s) => s.updateGroup);
  const autoFillGroup = useEditorStore((s) => s.autoFillGroup);
  const [busy, setBusy] = useState<"bg" | "crop" | null>(null);
  const image = group.master;

  // How many more copies fit in the space left on the sheet.
  const roomLeft = useMemo(() => {
    const bbox = imageBbox({ ...image, positionX: 0, positionY: 0 });
    const blockers = images
      .filter((i) => i.placed && !group.members.some((m) => m.id === i.id))
      .map(imageBbox);
    return Math.max(0, freeCapacityFor(bbox.w, bbox.h, sheetSize, gapMm, blockers) - group.count);
  }, [image, images, group, sheetSize, gapMm]);

  const run = async (kind: "bg" | "crop") => {
    setBusy(kind);
    try {
      await (kind === "bg" ? removeGroupBackground(group, updateGroup) : cropGroup(group, updateGroup));
    } catch {
      showToast(kind === "bg" ? "Bakgrunden kunde inte tas bort." : "Motivet kunde inte beskäras.", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => updateGroup(group.groupId, { rotation: (image.rotation + 90) % 360 })}
        style={R.chipButton}
      >
        {ICON.rotate} Rotera
      </button>
      {roomLeft > 0 && (
        <button type="button" onClick={() => autoFillGroup(group.groupId)} style={R.chipButton}>
          Fyll arket (+{roomLeft})
        </button>
      )}
      {!image.bgRemovedUrl && !image.text && (
        <button type="button" onClick={() => void run("bg")} disabled={busy !== null} style={R.chipButton}>
          {busy === "bg" ? "Tar bort…" : "Ta bort bakgrund"}
        </button>
      )}
      {!image.text && (
        <button type="button" onClick={() => void run("crop")} disabled={busy !== null} style={R.chipButton}>
          {busy === "crop" ? "Beskär…" : "Beskär"}
        </button>
      )}
    </>
  );
}

/** − 12 + : big enough for a thumb, and the number can be typed. */
function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    focused.current = false;
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1 && n !== value) onChange(Math.min(5000, n));
    else setDraft(String(value));
  };

  return (
    <div style={R.stepper}>
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= 1}
        style={{ ...R.stepButton, opacity: value <= 1 ? 0.35 : 1 }}
        aria-label="En färre"
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        aria-label="Antal"
        value={draft}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={R.stepInput}
      />
      <button type="button" onClick={() => onChange(value + 1)} style={R.stepButton} aria-label="En till">
        +
      </button>
    </div>
  );
}

/** Width and height in cm, kept in proportion; applied on leaving the field. */
function SizeFields({ image, onDone }: { image: EditorImage; onDone: () => void }) {
  const resizeImage = useEditorStore((s) => s.resizeImage);
  const fmt = (mm: number) => (mm / 10).toFixed(1).replace(".", ",");
  const [w, setW] = useState(fmt(image.displayWidth));
  const [h, setH] = useState(fmt(image.displayHeight));
  useEffect(() => {
    setW(fmt(image.displayWidth));
    setH(fmt(image.displayHeight));
  }, [image.displayWidth, image.displayHeight]);

  const ratio = image.displayWidth / Math.max(0.1, image.displayHeight);
  const commit = (which: "w" | "h") => {
    const cm = parseFloat((which === "w" ? w : h).replace(",", "."));
    if (!(cm > 0)) {
      setW(fmt(image.displayWidth));
      setH(fmt(image.displayHeight));
      return;
    }
    // Never wider than the film.
    let wMm = which === "w" ? cm * 10 : cm * 10 * ratio;
    wMm = Math.min(580, Math.max(5, wMm));
    if (Math.abs(wMm - image.displayWidth) < 0.5) return;
    resizeImage(image.id, wMm, wMm / ratio, true);
  };
  const field = (label: string, value: string, set: (v: string) => void, which: "w" | "h") => (
    <label style={R.field}>
      <span style={R.fieldLabel}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => commit(which)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={R.fieldInput}
      />
    </label>
  );

  return (
    <div style={R.sizeFields} onClick={(e) => e.stopPropagation()}>
      {field("Bredd (cm)", w, setW, "w")}
      <span style={{ color: theme.textDim, paddingBottom: 10 }}>×</span>
      {field("Höjd (cm)", h, setH, "h")}
      <button type="button" onClick={onDone} style={R.done}>
        Klar
      </button>
    </div>
  );
}

function Thumb({ image }: { image: EditorImage }) {
  const [failed, setFailed] = useState(false);
  return (
    <div style={R.thumb}>
      {failed ? (
        <span style={{ fontSize: 9, fontWeight: 700, color: theme.textDim }}>
          {image.filename.split(".").pop()?.toUpperCase()}
        </span>
      ) : (
        <img
          src={image.bgRemovedUrl || image.thumbnailUrl}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
    </div>
  );
}

const ICON = {
  pencil: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
    </svg>
  ),
  trash: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  ),
  rotate: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </svg>
  ),
};

const R: Record<string, React.CSSProperties> = {
  empty: { margin: 0, padding: "16px 0", textAlign: "center", fontSize: 13, color: theme.textDim },
  card: {
    padding: 12,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    cursor: "pointer",
    transition: "border-color 0.15s, background 0.15s",
  },
  top: { display: "flex", alignItems: "center", gap: 10 },
  thumb: {
    width: 52,
    height: 52,
    flexShrink: 0,
    borderRadius: 10,
    overflow: "hidden",
    // Checks show what is transparent, as on the sheet.
    background: "repeating-conic-gradient(#e2e4e8 0% 25%, #ffffff 0% 50%) 50% / 10px 10px",
    border: `1px solid ${theme.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: theme.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: { display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" },
  sizeChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: 0,
    border: "none",
    background: "transparent",
    color: theme.text,
    fontSize: 12.5,
    fontFamily: theme.fontFamily,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  dpi: { fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  stepper: {
    display: "flex",
    alignItems: "center",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 999,
    background: theme.bg,
    overflow: "hidden",
  },
  stepButton: {
    width: 30,
    height: 34,
    border: "none",
    background: "transparent",
    color: theme.text,
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    fontFamily: theme.fontFamily,
    padding: 0,
  },
  stepInput: {
    width: 36,
    height: 34,
    border: "none",
    borderLeft: `1px solid ${theme.border}`,
    borderRight: `1px solid ${theme.border}`,
    background: theme.bgInput,
    textAlign: "center",
    fontSize: 15,
    fontWeight: 700,
    fontFamily: theme.fontFamily,
    color: theme.text,
    padding: 0,
    borderRadius: 0,
  },
  trash: {
    width: 32,
    height: 34,
    border: "none",
    borderRadius: 10,
    background: "transparent",
    color: theme.textMuted,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },
  bottom: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 },
  chipButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 12px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 999,
    background: theme.bg,
    color: theme.text,
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  problem: {
    margin: 0,
    padding: "6px 10px",
    borderRadius: 8,
    background: theme.dangerBg,
    color: theme.danger,
    fontSize: 12,
  },
  sizeFields: { display: "flex", alignItems: "flex-end", gap: 8 },
  field: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 11, color: theme.textMuted },
  fieldInput: {
    width: "100%",
    padding: "8px 10px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 10,
    background: theme.bgInput,
    fontFamily: theme.fontFamily,
    color: theme.text,
  },
  done: {
    padding: "9px 14px",
    border: "none",
    borderRadius: 10,
    background: theme.secondary,
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
};
