import { useState } from "react";
import { ImageUploader } from "../ImagePanel/ImageUploader";
import type { EditorImage } from "../../store/editorStore";
import { ImageList } from "../ImagePanel/ImageList";
import { useEditorStore } from "../../store/editorStore";
import { theme } from "../../styles/theme";

type TabKey = "designs" | "uploads" | "text" | "settings";

// SVG icon components for clean look
const Icons = {
  designs: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  uploads: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  text: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  settings: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "designs", label: "Designs", icon: Icons.designs },
  { key: "uploads", label: "Galleri", icon: Icons.uploads },
  { key: "text", label: "Text", icon: Icons.text },
  { key: "settings", label: "Inställningar", icon: Icons.settings },
];

export function LeftSidebar() {
  const [activeTab, setActiveTab] = useState<TabKey>("designs");
  const { isUploading } = useEditorStore();

  return (
    <aside
      style={{
        background: theme.bg,
        display: "flex",
        overflow: "hidden",
      }}
    >
      {/* Icon tab bar — dark strip */}
      <div
        style={{
          width: 64,
          background: theme.bgDark,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: theme.space.md,
          gap: 4,
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              title={tab.label}
              style={{
                width: 54,
                padding: "10px 0 6px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                border: "none",
                borderRadius: theme.radiusSm,
                background: active ? "rgba(255,255,255,0.12)" : "transparent",
                color: active ? "#fff" : "rgba(255,255,255,0.5)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: tab.icon }} />
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: active ? theme.fontWeight.semibold : theme.fontWeight.regular,
                  fontFamily: theme.fontFamily,
                  letterSpacing: "0.01em",
                }}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: theme.bgSidebar,
        }}
      >
        {activeTab === "designs" && <DesignsTab isUploading={isUploading} />}
        {activeTab === "uploads" && <UploadsTab />}
        {activeTab === "text" && <TextTab />}
        {activeTab === "settings" && <SettingsTab />}
      </div>
    </aside>
  );
}

function DesignsTab({ isUploading }: { isUploading: boolean }) {
  return (
    <>
      <TabHeader title="Designs" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: `0 ${theme.space.lg}px ${theme.space.lg}px`,
          display: "flex",
          flexDirection: "column",
          gap: theme.space.sm,
        }}
      >
        <ImageUploader />
        {isUploading && (
          <div
            style={{
              padding: theme.space.md,
              textAlign: "center",
              background: theme.accentBg,
              borderRadius: theme.radiusSm,
              fontSize: theme.fontSize.bodySm,
              color: theme.accent,
            }}
          >
            Laddar upp...
          </div>
        )}
        <ImageList />
      </div>
    </>
  );
}

function UploadsTab() {
  const { images, addImage } = useEditorStore();
  // Show all uploaded images as a reusable gallery
  const allUploads = images.filter((img) => img.originalUrl);

  return (
    <>
      <TabHeader title="Galleri" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: theme.space.md,
          display: "flex",
          flexDirection: "column",
          gap: theme.space.md,
        }}
      >
        {allUploads.length === 0 ? (
          <div style={{ textAlign: "center", padding: theme.space.xl }}>
            <p style={{ color: theme.textDim, fontSize: theme.fontSize.bodySm }}>
              Uppladdade designs visas här.
            </p>
            <p style={{ color: theme.textDim, fontSize: theme.fontSize.labelMd, marginTop: theme.space.sm }}>
              Ladda upp via Designs-tabben.
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: theme.space.sm,
            }}
          >
            {allUploads.map((img) => (
              <div
                key={img.id}
                style={{
                  aspectRatio: "1",
                  borderRadius: theme.radius,
                  overflow: "hidden",
                  background: theme.bgCard,
                  cursor: "pointer",
                  position: "relative",
                  boxShadow: theme.shadow,
                }}
                onClick={() => {
                  // Add another copy of this image to the canvas
                  addImage({
                    ...img,
                    id: "img_" + Math.random().toString(36).substring(2, 10),
                    positionX: 20 + Math.random() * 100,
                    positionY: 20 + Math.random() * 100,
                    placed: true,
                  });
                }}
                title="Klicka för att lägga till på arket"
              >
                <img
                  src={img.thumbnailUrl}
                  alt={img.filename}
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    padding: "4px 6px",
                    background: "rgba(25,28,30,0.7)",
                    fontSize: theme.fontSize.labelXs,
                    color: "#fff",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {img.filename}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TextTab() {
  const [text, setText] = useState("Din text här");
  const [fontSize, setFontSize] = useState(48);
  const [fontFamily, setFontFamily] = useState("Arial Black");
  const [textColor, setTextColor] = useState("#000000");
  const { addImage } = useEditorStore();

  const fonts = [
    "Arial Black", "Impact", "Bebas Neue", "Oswald",
    "Roboto", "Open Sans", "Montserrat", "Poppins",
    "Bangers", "Permanent Marker", "Lobster", "Pacifico",
  ];

  const handleAddText = () => {
    if (!text.trim()) return;

    // Create text as an image via canvas
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `bold ${fontSize}px "${fontFamily}", sans-serif`;
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + 20;
    const h = fontSize * 1.4 + 20;
    canvas.width = w;
    canvas.height = h;
    ctx.font = `bold ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.fillStyle = textColor;
    ctx.textBaseline = "top";
    ctx.fillText(text, 10, 10);

    const dataUrl = canvas.toDataURL("image/png");

    addImage({
      id: "txt_" + Math.random().toString(36).substring(2, 10),
      filename: `Text: ${text.substring(0, 20)}`,
      thumbnailUrl: dataUrl,
      originalUrl: dataUrl,
      widthPx: w,
      heightPx: h,
      dpiX: 300,
      dpiY: 300,
      positionX: 20,
      positionY: 20,
      displayWidth: (w / 300) * 25.4,
      displayHeight: (h / 300) * 25.4,
      rotation: 0,
      flipX: false,
      flipY: false,
      quantity: 1,
      marginMm: 5,
      bgRemoved: true,
      placed: true,
    });
  };

  return (
    <>
      <TabHeader title="Lägg till text" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: theme.space.lg,
          display: "flex",
          flexDirection: "column",
          gap: theme.space.md,
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Skriv din text..."
          rows={2}
          style={{
            width: "100%",
            padding: theme.space.md,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            fontSize: theme.fontSize.bodyMd,
            fontFamily: theme.fontFamily,
            background: theme.bgInput,
            color: theme.text,
            resize: "vertical",
          }}
        />

        <div style={{ display: "flex", gap: theme.space.sm }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: theme.fontSize.labelXs, color: theme.textDim }}>Typsnitt</label>
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 8px",
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                fontSize: theme.fontSize.labelMd,
                fontFamily: theme.fontFamily,
                background: theme.bgInput,
                color: theme.text,
              }}
            >
              {fonts.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
              ))}
            </select>
          </div>
          <div style={{ width: 60 }}>
            <label style={{ fontSize: theme.fontSize.labelXs, color: theme.textDim }}>Storlek</label>
            <input
              type="number"
              value={fontSize}
              onChange={(e) => setFontSize(parseInt(e.target.value) || 24)}
              min={12}
              max={300}
              style={{
                width: "100%",
                padding: "6px 4px",
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                fontSize: theme.fontSize.labelMd,
                fontFamily: theme.fontFamily,
                textAlign: "center",
                background: theme.bgInput,
                color: theme.text,
              }}
            />
          </div>
        </div>

        <div>
          <label style={{ fontSize: theme.fontSize.labelXs, color: theme.textDim }}>Färg</label>
          <div style={{ display: "flex", gap: theme.space.xs, marginTop: 4, flexWrap: "wrap" }}>
            {["#000000", "#ffffff", "#bb0018", "#1a5276", "#27ae60", "#f39c12", "#8e44ad", "#2c3e50"].map((c) => (
              <button
                key={c}
                onClick={() => setTextColor(c)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: theme.radiusSm,
                  border: textColor === c ? `2px solid ${theme.accent}` : `1px solid ${theme.border}`,
                  background: c,
                  cursor: "pointer",
                }}
              />
            ))}
            <input
              type="color"
              value={textColor}
              onChange={(e) => setTextColor(e.target.value)}
              style={{ width: 28, height: 28, border: "none", padding: 0, cursor: "pointer" }}
            />
          </div>
        </div>

        {/* Preview */}
        <div
          style={{
            padding: theme.space.lg,
            background: theme.bgCard,
            borderRadius: theme.radius,
            textAlign: "center",
            minHeight: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: `"${fontFamily}", sans-serif`,
              fontSize: Math.min(fontSize, 36),
              fontWeight: 700,
              color: textColor,
            }}
          >
            {text || "Förhandsvisning"}
          </span>
        </div>

        <button
          onClick={handleAddText}
          disabled={!text.trim()}
          style={{
            width: "100%",
            padding: `${theme.space.md}px`,
            fontSize: theme.fontSize.bodySm,
            fontWeight: theme.fontWeight.semibold,
            fontFamily: theme.fontFamily,
            border: "none",
            borderRadius: theme.radius,
            background: text.trim() ? theme.accentGradient : theme.bgInput,
            color: text.trim() ? "#fff" : theme.textDim,
            cursor: text.trim() ? "pointer" : "not-allowed",
          }}
        >
          Lägg till på arket
        </button>
      </div>
    </>
  );
}

function SettingsTab() {
  const { sheetSize } = useEditorStore();

  return (
    <>
      <TabHeader title="Inställningar" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: theme.space.lg,
          display: "flex",
          flexDirection: "column",
          gap: theme.space.lg,
        }}
      >
        <div>
          <label style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, fontWeight: theme.fontWeight.semibold }}>
            Aktuellt ark
          </label>
          <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.bodyMd, fontWeight: theme.fontWeight.semibold }}>
            {sheetSize.label}
          </p>
          <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.labelMd, color: theme.textDim }}>
            Bredd: 58 cm | Export: 300 DPI PNG
          </p>
        </div>

        <div>
          <label style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, fontWeight: theme.fontWeight.semibold }}>
            Tangentbordsgenvägar
          </label>
          <div style={{ marginTop: theme.space.sm, fontSize: theme.fontSize.labelMd, color: theme.textDim, display: "flex", flexDirection: "column", gap: 4 }}>
            <Shortcut keys="Ctrl+Z" label="Ångra" />
            <Shortcut keys="Delete" label="Ta bort markerad" />
            <Shortcut keys="Ctrl+D" label="Duplicera" />
            <Shortcut keys="Ctrl+A" label="Markera alla" />
            <Shortcut keys="Esc" label="Stäng editor" />
          </div>
        </div>
      </div>
    </>
  );
}

function TabHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        padding: `${theme.space.lg}px ${theme.space.lg}px ${theme.space.sm}px`,
        fontSize: theme.fontSize.bodySm,
        fontWeight: theme.fontWeight.semibold,
        textTransform: "uppercase" as const,
        letterSpacing: theme.letterSpacing.wide,
        color: theme.textMuted,
      }}
    >
      {title}
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span>{label}</span>
      <code
        style={{
          fontSize: theme.fontSize.labelXs,
          padding: "1px 6px",
          background: theme.bgInput,
          borderRadius: theme.radiusSm,
          color: theme.textMuted,
        }}
      >
        {keys}
      </code>
    </div>
  );
}
