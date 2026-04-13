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
        padding: 10,
        borderRadius: theme.radiusSm,
        border: `1px solid ${isSelected ? theme.accent : theme.border}`,
        background: isSelected ? "rgba(230,57,70,0.03)" : theme.bgCard,
        cursor: "pointer",
        transition: "all 0.15s",
        boxShadow: isSelected ? `0 0 0 1px ${theme.accent}` : "none",
      }}
    >
      {/* Top row: thumbnail + info + actions */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {/* Thumbnail */}
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
              // Show file type icon instead of broken image
              const el = e.target as HTMLImageElement;
              el.style.display = "none";
              const ext = image.filename.split(".").pop()?.toUpperCase() || "?";
              const parent = el.parentElement;
              if (parent && !parent.querySelector(".gs-file-icon")) {
                const icon = document.createElement("div");
                icon.className = "gs-file-icon";
                icon.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:2px;";
                icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${theme.textDim}" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg><span style="font-size:8px;font-weight:600;color:${theme.textDim}">${ext}</span>`;
                parent.appendChild(icon);
              }
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
        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: theme.fontFamily,
              color: theme.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {image.filename}
          </p>
          <div style={{ display: "flex", gap: 6, marginTop: 3, alignItems: "center" }}>
            <span
              style={{
                fontSize: 10,
                padding: "2px 5px",
                borderRadius: 4,
                background: dpiColor + "15",
                color: dpiColor,
                fontWeight: 600,
              }}
            >
              {dpi} DPI
            </span>
            <span style={{ fontSize: 10, color: theme.textDim }}>
              {(image.displayWidth / 10).toFixed(1)}×{(image.displayHeight / 10).toFixed(1)} cm
            </span>
            {image.quantity > 1 && (
              <span style={{ fontSize: 10, fontWeight: 600, color: theme.accent }}>
                ×{image.quantity}
              </span>
            )}
          </div>
        </div>

        {/* Quick actions */}
        <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
          <button
            onClick={(e) => { e.stopPropagation(); duplicateImage(image.id); }}
            title="Öka antal (+1)"
            style={{
              width: 26, height: 26,
              border: `1px solid ${theme.border}`, borderRadius: 6,
              background: theme.bgCard, color: theme.accent,
              cursor: "pointer", fontSize: 16, fontWeight: 600,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >+</button>
          <button
            onClick={(e) => { e.stopPropagation(); removeImage(image.id); }}
            title="Ta bort"
            style={{
              width: 26, height: 26,
              border: "none", borderRadius: 6,
              background: theme.dangerBg, color: theme.danger,
              cursor: "pointer", fontSize: 14,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >×</button>
        </div>
      </div>

      {/* Expanded controls when selected */}
      {isSelected && (
        <div
          style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Size row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 10, color: theme.textDim, display: "block", marginBottom: 2 }}>Bredd (cm)</label>
              <input
                type="number"
                step="0.1"
                value={(image.displayWidth / 10).toFixed(1)}
                onChange={(e) => handleWidthChange(e.target.value)}
                style={{
                  width: "100%", padding: "6px 8px", border: `1px solid ${theme.border}`,
                  borderRadius: 6, fontSize: 13, fontFamily: theme.fontFamily,
                  background: theme.bgInput, color: theme.text,
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, color: theme.textDim, display: "block", marginBottom: 2 }}>Höjd (cm)</label>
              <input
                type="number"
                step="0.1"
                value={(image.displayHeight / 10).toFixed(1)}
                onChange={(e) => handleHeightChange(e.target.value)}
                style={{
                  width: "100%", padding: "6px 8px", border: `1px solid ${theme.border}`,
                  borderRadius: 6, fontSize: 13, fontFamily: theme.fontFamily,
                  background: theme.bgInput, color: theme.text,
                }}
              />
            </div>
            <button
              onClick={() => setAspectLocked(!aspectLocked)}
              title={aspectLocked ? "Lås upp proportioner" : "Lås proportioner"}
              style={{
                width: 32, height: 32, border: `1px solid ${theme.border}`,
                borderRadius: 6, background: aspectLocked ? theme.accentBg : "transparent",
                color: aspectLocked ? theme.accent : theme.textDim,
                cursor: "pointer", fontSize: 14, display: "flex",
                alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {aspectLocked ? (
                  <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>
                ) : (
                  <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>
                )}
              </svg>
            </button>
          </div>

          {/* Quantity + Margin row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <div>
              <label style={{ fontSize: 10, color: theme.textDim, display: "block", marginBottom: 2 }}>Antal</label>
              <input
                type="number"
                min="1"
                max="100"
                value={image.quantity}
                onChange={(e) => setImageQuantity(image.id, parseInt(e.target.value) || 1)}
                style={{
                  width: "100%", padding: "6px 8px", border: `1px solid ${theme.border}`,
                  borderRadius: 6, fontSize: 13, fontFamily: theme.fontFamily,
                  background: theme.bgInput, color: theme.text,
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, color: theme.textDim, display: "block", marginBottom: 2 }}>Marginal (cm)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={((image.marginMm || 5) / 10).toFixed(1)}
                onChange={(e) => {
                  const mm = parseFloat(e.target.value) * 10;
                  updateImage(image.id, { marginMm: Math.max(0, mm) });
                }}
                style={{
                  width: "100%", padding: "6px 8px", border: `1px solid ${theme.border}`,
                  borderRadius: 6, fontSize: 13, fontFamily: theme.fontFamily,
                  background: theme.bgInput, color: theme.text,
                }}
              />
            </div>
          </div>

          {/* Actions — 2x3 grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            <ActionButton label="Autofyll" onClick={() => autoFillSheet(image.id)} />
            <ActionButton label="Duplicera" onClick={() => duplicateImage(image.id)} />
            <ActionButton
              label={image.rotation === 0 ? "Rotera" : `${image.rotation}°`}
              onClick={() => updateImage(image.id, { rotation: (image.rotation + 90) % 360 })}
            />
            <ActionButton
              label={isRemovingBg ? "..." : "Remove BG"}
              onClick={handleRemoveBg}
              disabled={isRemovingBg || image.bgRemoved}
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
        padding: "6px 4px",
        fontSize: 11,
        fontWeight: 500,
        fontFamily: theme.fontFamily,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        background: theme.bgCard,
        color: disabled ? theme.textDim : theme.text,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
