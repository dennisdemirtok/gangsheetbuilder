import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { useEditorStore, type ImageGroup } from "../../store/editorStore";
import { copyDesign } from "../../services/api";
import { printableArea } from "../../utils/layout";
import {
  calculateDisplayDpi,
  cmText,
  DPI_LEVEL_COLORS,
  DPI_LEVEL_LABELS,
  getDpiLevel,
  isVectorDesign,
} from "../../utils/units";
import { showToast } from "../../utils/toast";
import { theme } from "../../styles/theme";

export const ADD_SIZE_LABEL = "Lägg till i en annan storlek";

const MIN_WIDTH_MM = 5;
const MAX_COUNT = 500;

/**
 * "Lägg till i en annan storlek": the design once more, at a width the
 * customer types, as a design of its own beside the one already placed.
 * Changing a design's size changes every copy of it, so customers uploaded
 * the same file again for each size: 38 of 314 builder sheets in 30 days
 * held one file at two or more sizes, #1168 uploaded two 14.7 MB PNGs 16
 * times for six. `touch` sizes the fields for the phone's list.
 */
export function AddSizeForm({
  group,
  onClose,
  touch = false,
}: {
  group: ImageGroup;
  onClose: () => void;
  touch?: boolean;
}) {
  const sheetSize = useEditorStore((s) => s.sheetSize);
  const addGroupAtSize = useEditorStore((s) => s.addGroupAtSize);
  const [width, setWidth] = useState("");
  const [count, setCount] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const image = group.master;
  const ratio = image.displayHeight / Math.max(0.01, image.displayWidth);
  const cm = parseFloat(width.replace(",", "."));
  const widthMm = cm > 0 ? cm * 10 : 0;
  const heightMm = widthMm * ratio;
  const filmMm = printableArea(sheetSize).w;

  // The picked width at a glance: how tall it gets and how sharp it prints.
  const vector = isVectorDesign(image);
  const dpi = widthMm > 0 ? calculateDisplayDpi(image.widthPx, widthMm) : 0;
  const level = getDpiLevel(dpi);

  const submit = async () => {
    if (busy) return;
    if (!(widthMm >= MIN_WIDTH_MM)) {
      setError("Skriv bredden i cm, minst 0,5.");
      return;
    }
    // The packer may turn it, so it fits if its short side does.
    if (Math.min(widthMm, heightMm) > filmMm) {
      setError(`Så stort får inte plats: filmen är ${cmText(filmMm)} cm bred.`);
      return;
    }
    const n = Math.min(MAX_COUNT, Math.max(1, parseInt(count, 10) || 1));
    setError(null);
    setBusy(true);
    try {
      const dbId = await copyDesign(image.dbId || image.id);
      const result = addGroupAtSize(group.groupId, { dbId, widthMm, count: n });
      if (!result) return;
      if (result.added === 0) {
        showToast("Motivet fick inte plats ens på det längsta arket. Gör det mindre.", "warning");
        return;
      }
      const parts = [
        `Tillagt i ${cmText(widthMm)} × ${cmText(heightMm)} cm${result.added > 1 ? `, ${result.added} st` : ""}.`,
      ];
      if (result.grewTo) parts.push(`Arket blev ${result.grewTo.label.replace(/ \(.*\)$/, "")} så att det får plats.`);
      if (result.overflow > 0) parts.push(`${result.overflow} fick inte plats.`);
      if (result.turned > 0) parts.push("Det vändes 90° för att spara film och trycks likadant.");
      showToast(parts.join(" "), result.overflow > 0 ? "warning" : "success");
      onClose();
    } catch {
      showToast("Det gick inte att lägga till storleken just nu. Försök igen.", "error");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") onClose();
  };
  const input: CSSProperties = {
    ...F.input,
    fontSize: touch ? 16 : 13,
    padding: touch ? "9px 10px" : "7px 8px",
  };

  return (
    <div style={F.box} onClick={(e) => e.stopPropagation()}>
      <p style={F.title}>{ADD_SIZE_LABEL}</p>
      <div style={F.row}>
        <label style={{ ...F.field, flex: 2 }}>
          <span style={F.label}>Bredd (cm)</span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            value={width}
            placeholder={cmText(image.displayWidth)}
            aria-label="Bredd i cm för den nya storleken"
            onChange={(e) => {
              setWidth(e.target.value);
              setError(null);
            }}
            onKeyDown={onKey}
            style={input}
          />
        </label>
        <label style={{ ...F.field, flex: 1 }}>
          <span style={F.label}>Antal</span>
          <input
            type="text"
            inputMode="numeric"
            value={count}
            aria-label="Antal i den nya storleken"
            onFocus={(e) => e.target.select()}
            onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={() => setCount(String(Math.min(MAX_COUNT, Math.max(1, parseInt(count, 10) || 1))))}
            onKeyDown={onKey}
            style={{ ...input, textAlign: "center" }}
          />
        </label>
      </div>
      <p style={{ ...F.note, color: error ? theme.danger : theme.textMuted }}>
        {error ??
          (widthMm > 0 ? (
            <>
              Höjd {cmText(heightMm)} cm ·{" "}
              {vector ? (
                <span style={{ color: DPI_LEVEL_COLORS.optimal, fontWeight: 600 }}>Vektor</span>
              ) : (
                <span style={{ color: DPI_LEVEL_COLORS[level], fontWeight: 600 }}>
                  {dpi} DPI{level === "bad" || level === "low" ? ` · ${DPI_LEVEL_LABELS[level]}` : ""}
                </span>
              )}
            </>
          ) : (
            "Samma fil som ett eget motiv. Det som redan ligger på arket ändras inte."
          ))}
      </p>
      <div style={F.buttons}>
        <button type="button" onClick={onClose} style={{ ...F.cancel, padding: touch ? "9px 14px" : "7px 12px" }}>
          Avbryt
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          style={{ ...F.add, padding: touch ? "9px 16px" : "7px 14px", cursor: busy ? "wait" : "pointer" }}
        >
          {busy ? "Lägger till…" : "Lägg till"}
        </button>
      </div>
    </div>
  );
}

const F: Record<string, CSSProperties> = {
  box: {
    padding: 10,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusSm,
    background: theme.bgSidebar,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    cursor: "default",
    width: "100%",
    boxSizing: "border-box",
  },
  title: { margin: 0, fontSize: 12, fontWeight: 600, color: theme.text },
  row: { display: "flex", gap: 6 },
  field: { minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
  label: { fontSize: 11, color: theme.textDim },
  input: {
    width: "100%",
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    fontFamily: theme.fontFamily,
    background: theme.bgInput,
    color: theme.text,
    boxSizing: "border-box",
  },
  note: { margin: 0, fontSize: 11, lineHeight: 1.4 },
  buttons: { display: "flex", justifyContent: "flex-end", gap: 6 },
  cancel: {
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    background: "transparent",
    color: theme.text,
    fontSize: 12,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  add: {
    border: "none",
    borderRadius: 6,
    background: theme.accent,
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
  },
};
