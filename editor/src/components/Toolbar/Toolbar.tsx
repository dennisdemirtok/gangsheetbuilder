import { useEditorStore, groupKey } from "../../store/editorStore";
import { theme } from "../../styles/theme";

export function Toolbar() {
  const {
    selectedImageId,
    images,
    updateGroup,
    duplicateImage,
    removeGroup,
    zoom,
    setZoom,
  } = useEditorStore();

  const selectedImage = selectedImageId
    ? images.find((img) => img.id === selectedImageId)
    : null;

  /*
   * Transforms apply to every copy of the design, like the sidebar does.
   * Rotating a single copy changes its footprint and drops it on top of
   * its neighbours — and nobody wants 1 of 24 shirts printed sideways.
   */
  const transformGroup = (updates: Parameters<typeof updateGroup>[1]) => {
    if (!selectedImage) return;
    updateGroup(groupKey(selectedImage), updates);
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        alignItems: "center",
        padding: "4px 8px",
        background: theme.bgCard,
        borderRadius: 8,
        border: `1px solid ${theme.border}`,
      }}
    >
      {/* Zoom controls */}
      <ToolButton
        icon="−"
        title="Zooma ut"
        onClick={() => setZoom(zoom - 0.1)}
        disabled={zoom <= 0.2}
      />
      <span
        style={{
          fontSize: 11,
          minWidth: 36,
          textAlign: "center",
          color: theme.textMuted,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Math.round(zoom * 100)}%
      </span>
      <ToolButton
        icon="+"
        title="Zooma in"
        onClick={() => setZoom(zoom + 0.1)}
        disabled={zoom >= 5}
      />

      <Divider />

      {/* Image manipulation */}
      <ToolButton
        icon="↻"
        title="Rotera 90°"
        onClick={() =>
          transformGroup({ rotation: ((selectedImage?.rotation ?? 0) + 90) % 360 })
        }
        disabled={!selectedImage}
      />
      <ToolButton
        icon="⇔"
        title="Flippa horisontellt"
        onClick={() => transformGroup({ flipX: !selectedImage?.flipX })}
        disabled={!selectedImage}
      />
      <ToolButton
        icon="⇕"
        title="Flippa vertikalt"
        onClick={() => transformGroup({ flipY: !selectedImage?.flipY })}
        disabled={!selectedImage}
      />

      <Divider />

      <ToolButton
        icon="⧉"
        title="Duplicera"
        onClick={() => selectedImageId && duplicateImage(selectedImageId)}
        disabled={!selectedImage}
      />
      <ToolButton
        icon="✕"
        title="Ta bort"
        onClick={() => selectedImage && removeGroup(groupKey(selectedImage))}
        disabled={!selectedImage}
        danger
      />

      {selectedImage && (
        <>
          <Divider />
          <span
            style={{
              fontSize: 11,
              color: theme.textMuted,
              whiteSpace: "nowrap",
            }}
          >
            {selectedImage.displayWidth.toFixed(0)} ×{" "}
            {selectedImage.displayHeight.toFixed(0)} mm
          </span>
        </>
      )}
    </div>
  );
}

function ToolButton({
  icon,
  title,
  onClick,
  disabled,
  danger,
}: {
  icon: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 30,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
        border: "none",
        borderRadius: theme.radiusSm,
        background: "transparent",
        color: disabled
          ? theme.textDim
          : danger
            ? theme.danger
            : theme.text,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s, color 0.15s",
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          (e.target as HTMLElement).style.background = danger
            ? theme.dangerBg
            : theme.bgInput;
        }
      }}
      onMouseLeave={(e) => {
        (e.target as HTMLElement).style.background = "transparent";
      }}
    >
      {icon}
    </button>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 18,
        background: theme.border,
        margin: "0 4px",
      }}
    />
  );
}
