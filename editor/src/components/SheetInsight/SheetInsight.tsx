import { useMemo } from "react";
import { useEditorStore, groupImages } from "../../store/editorStore";
import { useSheetStats } from "../../utils/sheetStats";
import { freeCapacityFor, imageBbox } from "../../utils/layout";
import { theme } from "../../styles/theme";

/**
 * The sheet is priced by its length, not by how much of it you use.
 * That is the whole point of a gang sheet and it was nowhere in the UI —
 * customers paid for a metre and shipped it half empty. This panel shows
 * how full the film is and offers to fill the rest in one click.
 */
export function SheetInsight() {
  const {
    images,
    sheetSize,
    gapMm,
    selectedImageId,
    autoFillGroup,
    lastFillShortfall,
    clearFillShortfall,
  } = useEditorStore();
  const stats = useSheetStats();

  // Which design would we offer to multiply? The selected one, else the
  // first — and only when copies actually fit in what's left.
  const fillTarget = useMemo(() => {
    const groups = groupImages(images);
    if (groups.length === 0) return null;
    const selected = images.find((i) => i.id === selectedImageId);
    const group =
      groups.find((g) => g.members.some((m) => m.id === selected?.id)) ??
      groups[0]!;
    const bbox = imageBbox({ ...group.master, positionX: 0, positionY: 0 });
    const blockers = images
      .filter((i) => i.placed && !group.members.some((m) => m.id === i.id))
      .map(imageBbox);
    const fits = freeCapacityFor(bbox.w, bbox.h, sheetSize, gapMm, blockers);
    if (fits <= group.count) return null;
    return { group, extra: fits - group.count };
  }, [images, sheetSize, gapMm, selectedImageId]);

  if (images.length === 0) return null;

  const pct = Math.round(stats.used * 100);
  const freeCm = Math.round(stats.freeTailMm / 10);

  return (
    <div style={S.wrap}>
      <div style={S.headRow}>
        <span style={S.label}>Arket är {pct}% fyllt</span>
        <span style={S.freeText}>{freeCm} cm kvar</span>
      </div>

      <div style={S.track}>
        <div
          style={{
            ...S.fill,
            width: `${Math.min(100, Math.max(2, pct))}%`,
            background: pct >= 60 ? theme.success : theme.accent,
          }}
        />
      </div>

      <p style={S.pitch}>
        Du betalar för arkets längd — inte per motiv. Fyll det och du får fler
        tryck för samma pengar.
      </p>

      {lastFillShortfall && (
        <p style={{ ...S.issue, background: theme.warningBg, color: theme.warning }}>
          ⓘ {lastFillShortfall.missing} till av "{trim(lastFillShortfall.filename)}"
          fick inte plats. Välj ett längre ark om du vill ha fler.{" "}
          <button onClick={clearFillShortfall} style={S.dismiss}>
            Okej
          </button>
        </p>
      )}

      {fillTarget && (
        <button
          onClick={() => autoFillGroup(fillTarget.group.groupId)}
          style={S.fillBtn}
        >
          + Fyll med {fillTarget.extra} till av "{trim(fillTarget.group.master.filename)}"
        </button>
      )}

      {stats.issues.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {stats.issues.map((issue, i) => (
            <p
              key={i}
              style={{
                ...S.issue,
                background:
                  issue.severity === "error" ? theme.dangerBg : theme.warningBg,
                color: issue.severity === "error" ? theme.danger : theme.warning,
              }}
            >
              {issue.severity === "error" ? "⚠" : "ⓘ"} {issue.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function trim(name: string, max = 16): string {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    borderRadius: theme.radius,
    background: theme.bgCard,
    border: `1px solid ${theme.border}`,
  },
  headRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  label: {
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    color: theme.text,
  },
  freeText: { fontSize: theme.fontSize.labelMd, color: theme.textMuted },
  track: {
    height: 6,
    borderRadius: 3,
    background: theme.bgInput,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 3, transition: "width 0.25s ease" },
  pitch: {
    margin: 0,
    fontSize: theme.fontSize.labelMd,
    color: theme.textMuted,
    lineHeight: theme.lineHeight.normal,
  },
  fillBtn: {
    padding: "9px 12px",
    border: "none",
    borderRadius: theme.radiusSm,
    background: theme.accent,
    color: "#fff",
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  dismiss: {
    border: "none",
    background: "transparent",
    color: "inherit",
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize.labelMd,
    padding: 0,
  },
  issue: {
    margin: 0,
    padding: "6px 8px",
    borderRadius: theme.radiusSm,
    fontSize: theme.fontSize.labelMd,
    lineHeight: theme.lineHeight.normal,
  },
};
