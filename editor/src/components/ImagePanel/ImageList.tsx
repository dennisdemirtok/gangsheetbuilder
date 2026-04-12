import { useState } from "react";
import { useEditorStore, type EditorImage } from "../../store/editorStore";
import {
  calculateDisplayDpi,
  getDpiColor,
} from "../../utils/units";
import { removeBg, getAppProxyUrl } from "../../services/api";
import { theme } from "../../styles/theme";

export function ImageList() {
  const { images, selectedImageId, selectImage } = useEditorStore();

  if (images.length === 0) {
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
      {images.map((img) => (
        <ImageItem
          key={img.id}
          image={img}
          isSelected={selectedImageId === img.id}
        />
      ))}
    </div>
  );
}

function ImageItem({
  image,
  isSelected,
}: {
  image: EditorImage;
  isSelected: boolean;
}) {
  const {
    selectImage,
    removeImage,
    updateImage,
    duplicateImage,
    resizeImage,
    autoFillSheet,
    setImageQuantity,
  } = useEditorStore();

  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [aspectLocked, setAspectLocked] = useState(true);

  const dpi = calculateDisplayDpi(image.widthPx, image.displayWidth);
  const dpiColor = getDpiColor(dpi);
  const ratio = image.widthPx / image.heightPx;

  const handleRemoveBg = async () => {
    setIsRemovingBg(true);
    try {
      const result = await removeBg(image.dbId || image.id);
      const base = getAppProxyUrl();
      const bgUrl = result.bgRemovedUrl.startsWith("/")
        ? base + result.bgRemovedUrl
        : result.bgRemovedUrl;
      updateImage(image.id, {
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
    const w = parseFloat(val);
    if (isNaN(w) || w <= 0) return;
    resizeImage(image.id, w, aspectLocked ? w / ratio : image.displayHeight, aspectLocked);
  };

  const handleHeightChange = (val: string) => {
    const h = parseFloat(val);
    if (isNaN(h) || h <= 0) return;
    resizeImage(image.id, aspectLocked ? h * ratio : image.displayWidth, h, aspectLocked);
  };

  return (
    <div
      onClick={() => {
        selectImage(image.id);
        setShowControls(true);
      }}
      style={{
        padding: 8,
        borderRadius: theme.radiusSm,
        border: `1.5px solid ${isSelected ? theme.accent : theme.border}`,
        background: isSelected ? theme.accentBg : theme.bgCard,
        cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      {/* Top row: thumbnail + info */}
      <div style={{ display: "flex", gap: 8 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 4,
            overflow: "hidden",
            flexShrink: 0,
            background: theme.bgInput,
            position: "relative",
          }}
        >
          <img
            src={image.bgRemovedUrl || image.thumbnailUrl}
            alt={image.filename}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          {image.hasWhiteBackground && !image.bgRemoved && (
            <div
              title="Vit bakgrund"
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: theme.warning,
                fontSize: 8,
                fontWeight: 700,
                color: "#000",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              !
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 500,
              color: theme.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {image.filename}
          </p>
          <div style={{ display: "flex", gap: 4, marginTop: 2, alignItems: "center" }}>
            <span
              style={{
                fontSize: 9,
                padding: "1px 4px",
                borderRadius: 3,
                background: dpiColor + "20",
                color: dpiColor,
                fontWeight: 600,
              }}
            >
              {dpi} DPI
            </span>
            <span style={{ fontSize: 9, color: theme.textDim }}>
              {(image.displayWidth / 10).toFixed(1)}×{(image.displayHeight / 10).toFixed(1)} cm
            </span>
          </div>
        </div>
        {/* Quick duplicate + delete */}
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              duplicateImage(image.id);
            }}
            title="Snabb-duplicera"
            style={{
              width: 22,
              height: 22,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              background: theme.bgInput,
              color: theme.accent,
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 700,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            +
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeImage(image.id);
            }}
            title="Ta bort"
            style={{
              width: 22,
              height: 22,
              border: "none",
              borderRadius: 4,
              background: theme.dangerBg,
              color: theme.danger,
              cursor: "pointer",
              fontSize: 12,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Expanded controls when selected */}
      {isSelected && (
        <div
          style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Size controls */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <SizeInput
              label="B"
              value={(image.displayWidth / 10).toFixed(2)}
              suffix="cm"
              onChange={handleWidthChange}
            />
            <SizeInput
              label="H"
              value={(image.displayHeight / 10).toFixed(2)}
              suffix="cm"
              onChange={handleHeightChange}
            />
            <button
              onClick={() => setAspectLocked(!aspectLocked)}
              title={aspectLocked ? "Lås upp proportioner" : "Lås proportioner"}
              style={{
                width: 24,
                height: 24,
                border: `1px solid ${theme.border}`,
                borderRadius: 4,
                background: aspectLocked ? theme.accentBg : "transparent",
                color: aspectLocked ? theme.accent : theme.textDim,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {aspectLocked ? "🔒" : "🔓"}
            </button>
          </div>

          {/* Quantity + Margin */}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <SizeInput
              label="Antal"
              value={String(image.quantity)}
              onChange={(v) => setImageQuantity(image.id, parseInt(v) || 1)}
              type="number"
            />
            <SizeInput
              label="Marginal"
              value={String((image.marginMm || 5) / 10)}
              suffix="cm"
              onChange={(v) => {
                const mm = parseFloat(v) * 10;
                updateImage(image.id, { marginMm: Math.max(0, mm) });
              }}
            />
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <ActionButton
              label="Autofyll ark"
              onClick={() => autoFillSheet(image.id)}
            />
            <ActionButton
              label="Duplicera"
              onClick={() => duplicateImage(image.id)}
            />
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <ActionButton
              label={isRemovingBg ? "Tar bort..." : "Remove BG"}
              onClick={handleRemoveBg}
              disabled={isRemovingBg || image.bgRemoved}
            />
            <ActionButton
              label={image.rotation === 0 ? "Rotera 90°" : `${image.rotation}°`}
              onClick={() =>
                updateImage(image.id, {
                  rotation: (image.rotation + 90) % 360,
                })
              }
            />
            <ActionButton
              label="Crop"
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
                    const url = data.croppedUrl.startsWith("/") ? base + data.croppedUrl : data.croppedUrl;
                    updateImage(image.id, {
                      thumbnailUrl: url,
                      originalUrl: url,
                      widthPx: data.width,
                      heightPx: data.height,
                      displayWidth: data.displayWidthMm || image.displayWidth,
                      displayHeight: data.displayHeightMm || image.displayHeight,
                    });
                  }
                } catch { alert("Crop misslyckades"); }
              }}
            />
          </div>

          {/* BG warning */}
          {image.hasWhiteBackground && !image.bgRemoved && (
            <div
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                background: theme.warningBg,
                fontSize: 10,
                color: theme.warning,
              }}
            >
              ⚠ Vit bakgrund detekterad — klicka "Remove BG"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SizeInput({
  label,
  value,
  suffix,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  suffix?: string;
  onChange: (val: string) => void;
  type?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, flex: 1 }}>
      <span style={{ fontSize: 9, color: theme.textDim, width: 30, flexShrink: 0 }}>
        {label}:
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "3px 4px",
          border: `1px solid ${theme.border}`,
          borderRadius: 3,
          fontSize: 11,
          background: theme.bgInput,
          color: theme.text,
          textAlign: "center",
        }}
      />
      {suffix && (
        <span style={{ fontSize: 9, color: theme.textDim }}>{suffix}</span>
      )}
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
        flex: 1,
        padding: "5px 6px",
        fontSize: 10,
        fontWeight: 600,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        background: theme.bgInput,
        color: disabled ? theme.textDim : theme.text,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );
}
