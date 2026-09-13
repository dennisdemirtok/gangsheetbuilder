import { useMemo, useState } from "react";
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
} from "../../utils/units";
import { freeCapacityFor, imageBbox } from "../../utils/layout";
import { removeBg, getAppProxyUrl } from "../../services/api";
import { theme } from "../../styles/theme";
import { useSheetStats } from "../../utils/sheetStats";

export function ImageList() {
  const { images, selectedImageId } = useEditorStore();

  const groups = useMemo(() => groupImages(images), [images]);
  const stats = useSheetStats();

  if (groups.length === 0) {
    return (
      <p
        style={{
          color: theme.textDim,
          fontSize: 13,
          textAlign: "center",
          padding: 20,
        }}
      >
        Inga designs uppladdade.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {groups.map((group) => (
        <GroupItem
          key={group.groupId}
          group={group}
          isSelected={group.members.some((m) => m.id === selectedImageId)}
          hasOverlap={group.members.some((m) => stats.overlappingIds.has(m.id))}
          isOutside={group.members.some((m) => stats.outsideIds.has(m.id))}
        />
      ))}
    </div>
  );
}

function GroupItem({
  group,
  isSelected,
  hasOverlap,
  isOutside,
}: {
  group: ImageGroup;
  isSelected: boolean;
  hasOverlap: boolean;
  isOutside: boolean;
}) {
  const {
    images,
    sheetSize,
    gapMm,
    selectImage,
    removeGroup,
    updateGroup,
    setGroupCount,
    autoFillGroup,
    resizeImage,
  } = useEditorStore();

  const image = group.master;
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [aspectLocked, setAspectLocked] = useState(true);

  const dpi = calculateDisplayDpi(image.widthPx, image.displayWidth);
  const dpiColor = getDpiColor(dpi);
  const dpiLevel = getDpiLevel(dpi);
  const ratio = image.widthPx / image.heightPx;

  // How many more copies would fit in the space left over.
  const roomLeft = useMemo(() => {
    if (!isSelected) return 0;
    const bbox = imageBbox({ ...image, positionX: 0, positionY: 0 });
    const blockers = images
      .filter((i) => i.placed && !group.members.some((m) => m.id === i.id))
      .map(imageBbox);
    return Math.max(
      0,
      freeCapacityFor(bbox.w, bbox.h, sheetSize, gapMm, blockers) - group.count,
    );
  }, [isSelected, image, images, group, sheetSize, gapMm]);

  const handleRemoveBg = async () => {
    setIsRemovingBg(true);
    try {
      const result = await removeBg(image.dbId || image.id);
      const base = getAppProxyUrl();
      const bgUrl = result.bgRemovedUrl.startsWith("/")
        ? base + result.bgRemovedUrl
        : result.bgRemovedUrl;
      updateGroup(group.groupId, {
        bgRemoved: true,
        bgRemovedUrl: bgUrl,
        hasWhiteBackground: false,
      });
    } catch {
      alert("Bakgrundsbortagning misslyckades");
    } finally {
      setIsRemovingBg(false);
    }
  };

  const handleWidthChange = (val: string) => {
    const w = parseFloat(val.replace(",", ".")) * 10;
    if (isNaN(w) || w <= 0) return;
    resizeImage(image.id, w, aspectLocked ? w / ratio : image.displayHeight, aspectLocked);
  };

  const handleHeightChange = (val: string) => {
    const h = parseFloat(val.replace(",", ".")) * 10;
    if (isNaN(h) || h <= 0) return;
    resizeImage(image.id, aspectLocked ? h * ratio : image.displayWidth, h, aspectLocked);
  };

  const borderColor = hasOverlap || isOutside
    ? theme.danger
    : isSelected
      ? theme.accent
      : theme.border;

  return (
    <div
      onClick={() => selectImage(image.id)}
      style={{
        padding: 10,
        borderRadius: theme.radiusSm,
        border: `1px solid ${borderColor}`,
        background: isSelected ? "rgba(220,47,60,0.03)" : theme.bgCard,
        cursor: "pointer",
        transition: "all 0.15s",
        boxShadow: isSelected ? `0 0 0 1px ${theme.accent}` : "none",
      }}
    >
      {/* Top row: thumbnail + info + actions */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Thumbnail image={image} count={group.count} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: theme.fontFamily,
                color: theme.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {image.filename}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setGroupCount(group.groupId, group.count + 1);
              }}
              title="Lägg till en kopia"
              style={S.iconBtn}
            >
              +
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeGroup(group.groupId);
              }}
              title="Ta bort designen och alla dess kopior"
              style={S.removeBtn}
            >
              ×
            </button>
          </div>

          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 4,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                background: dpiColor + "15",
                color: dpiColor,
                fontWeight: 600,
              }}
              title={`${DPI_LEVEL_LABELS[dpiLevel]} upplösning för DTF-tryck`}
            >
              {dpi} DPI
            </span>
            <span style={{ fontSize: 11, color: theme.textDim }}>
              {(image.displayWidth / 10).toFixed(1)} ×{" "}
              {(image.displayHeight / 10).toFixed(1)} cm
            </span>
            {(dpiLevel === "bad" || dpiLevel === "low") && (
              <span style={{ fontSize: 11, color: dpiColor, fontWeight: 600 }}>
                {DPI_LEVEL_LABELS[dpiLevel]}
              </span>
            )}
            {group.count > 1 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: theme.accent }}>
                ×{group.count}
              </span>
            )}
          </div>
        </div>
      </div>

      {(hasOverlap || isOutside) && (
        <p style={S.rowAlert}>
          {hasOverlap
            ? "⚠ Ligger ovanpå ett annat motiv"
            : "⚠ Ligger utanför tryckytan"}{" "}
          — klicka "Ordna om tätt".
        </p>
      )}

      {/* Expanded controls when selected */}
      {isSelected && (
        <div
          style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Size row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto",
              gap: 6,
              alignItems: "end",
            }}
          >
            <NumberField
              label="Bredd (cm)"
              value={(image.displayWidth / 10).toFixed(1)}
              onChange={handleWidthChange}
            />
            <NumberField
              label="Höjd (cm)"
              value={(image.displayHeight / 10).toFixed(1)}
              onChange={handleHeightChange}
            />
            <button
              onClick={() => setAspectLocked(!aspectLocked)}
              title={aspectLocked ? "Lås upp proportioner" : "Lås proportioner"}
              style={{
                width: 34,
                height: 34,
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                background: aspectLocked ? theme.accentBg : "transparent",
                color: aspectLocked ? theme.accent : theme.textDim,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                {aspectLocked ? (
                  <>
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </>
                ) : (
                  <>
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                  </>
                )}
              </svg>
            </button>
          </div>

          {/* Count */}
          <div>
            <label style={S.label}>Antal på arket</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                onClick={() => setGroupCount(group.groupId, group.count - 1)}
                disabled={group.count <= 1}
                style={{
                  ...S.stepBtn,
                  opacity: group.count <= 1 ? 0.4 : 1,
                  cursor: group.count <= 1 ? "not-allowed" : "pointer",
                }}
              >
                −
              </button>
              <input
                type="number"
                min="1"
                max="500"
                value={group.count}
                onChange={(e) => {
                  const n = parseInt(e.target.value);
                  if (isNaN(n)) return;
                  setGroupCount(group.groupId, n);
                }}
                style={{ ...S.input, textAlign: "center", flex: 1 }}
              />
              <button
                onClick={() => setGroupCount(group.groupId, group.count + 1)}
                style={S.stepBtn}
              >
                +
              </button>
            </div>
            {roomLeft > 0 && (
              <p style={S.roomHint}>
                {roomLeft} till ryms på arket utan att det kostar mer.
              </p>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <ActionButton
              label={roomLeft > 0 ? `Fyll (+${roomLeft})` : "Fyll arket"}
              onClick={() => autoFillGroup(group.groupId)}
              disabled={roomLeft <= 0}
            />
            <ActionButton
              label={image.rotation === 0 ? "Rotera" : `${image.rotation}°`}
              onClick={() =>
                updateGroup(group.groupId, {
                  rotation: (image.rotation + 90) % 360,
                })
              }
            />
            <ActionButton
              label={isRemovingBg ? "Tar bort…" : "Ta bort BG"}
              onClick={handleRemoveBg}
              disabled={isRemovingBg || image.bgRemoved}
            />
            <ActionButton
              label="Beskär"
              onClick={async () => {
                try {
                  const base = getAppProxyUrl();
                  const res = await fetch(`${base}/api/crop`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ imageId: image.dbId || image.id }),
                  });
                  const data = await res.json();
                  if (data.croppedUrl) {
                    const url = data.croppedUrl.startsWith("/")
                      ? base + data.croppedUrl
                      : data.croppedUrl;
                    updateGroup(group.groupId, {
                      thumbnailUrl: url,
                      originalUrl: url,
                      widthPx: data.width,
                      heightPx: data.height,
                      displayWidth: data.displayWidthMm || image.displayWidth,
                      displayHeight: data.displayHeightMm || image.displayHeight,
                    });
                  }
                } catch {
                  alert("Beskärning misslyckades");
                }
              }}
            />
          </div>

          {image.hasWhiteBackground && !image.bgRemoved && (
            <div
              style={{
                padding: "5px 8px",
                borderRadius: 4,
                background: theme.warningBg,
                fontSize: 11,
                color: theme.warning,
              }}
            >
              ⚠ Vit bakgrund detekterad — den skrivs ut som vit film. Klicka "Ta
              bort bakgrund".
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Thumbnail({ image, count }: { image: EditorImage; count: number }) {
  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: 6,
        overflow: "hidden",
        flexShrink: 0,
        background: theme.bgInput,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <img
        src={image.bgRemovedUrl || image.thumbnailUrl}
        alt={image.filename}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
        onError={(e) => {
          const el = e.target as HTMLImageElement;
          el.style.display = "none";
          const ext = image.filename.split(".").pop()?.toUpperCase() || "?";
          const parent = el.parentElement;
          if (parent && !parent.querySelector(".gs-file-icon")) {
            const icon = document.createElement("div");
            icon.className = "gs-file-icon";
            icon.style.cssText =
              "width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:2px;";
            icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${theme.textDim}" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span style="font-size:8px;font-weight:600;color:${theme.textDim}">${ext}</span>`;
            parent.appendChild(icon);
          }
        }}
      />
      {count > 1 && (
        <span
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            padding: "0 4px",
            borderTopLeftRadius: 4,
            background: theme.accent,
            color: "#fff",
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <label style={S.label}>{label}</label>
      {/* inputMode=decimal keeps the native spinners away — they used to
          overlap the value and render "10,0" as "10,C" in the sidebar. */}
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={S.input}
      />
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "7px 6px",
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        background: theme.bgCard,
        color: disabled ? theme.textDim : theme.text,
        fontSize: 11.5,
        fontFamily: theme.fontFamily,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </button>
  );
}

const S: Record<string, React.CSSProperties> = {
  label: {
    fontSize: 11,
    color: theme.textDim,
    display: "block",
    marginBottom: 2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  input: {
    width: "100%",
    padding: "7px 8px",
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: theme.fontFamily,
    background: theme.bgInput,
    color: theme.text,
    boxSizing: "border-box",
  },
  iconBtn: {
    width: 24,
    height: 24,
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    background: theme.bgCard,
    color: theme.accent,
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  removeBtn: {
    width: 24,
    height: 24,
    border: "none",
    borderRadius: 6,
    background: theme.dangerBg,
    color: theme.danger,
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepBtn: {
    width: 34,
    height: 34,
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    background: theme.bgCard,
    color: theme.text,
    fontSize: 16,
    lineHeight: 1,
    flexShrink: 0,
  },
  roomHint: {
    margin: "4px 0 0",
    fontSize: 11,
    color: theme.success,
  },
  rowAlert: {
    margin: "6px 0 0",
    padding: "5px 8px",
    borderRadius: 4,
    background: theme.dangerBg,
    color: theme.danger,
    fontSize: 11,
  },
};
