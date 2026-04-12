import { useEffect } from "react";
import { GangSheetCanvas } from "./components/Canvas/GangSheetCanvas";
import { LeftSidebar } from "./components/LeftSidebar/LeftSidebar";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { AutoBuildButton } from "./components/Toolbar/AutoBuildButton";
import { PriceDisplay } from "./components/PriceDisplay/PriceDisplay";
import { AddToCartButton } from "./components/PriceDisplay/AddToCartButton";
import { DownloadButton } from "./components/PriceDisplay/DownloadButton";
import { SheetManager } from "./components/SheetManager/SheetManager";
import { useEditorStore } from "./store/editorStore";
import { getPricing, setAppProxyUrl } from "./services/api";
import { theme } from "./styles/theme";

export function App() {
  const { setPrices, isUploading, reset, currentPrice, images, selectedImageId, removeImage, setImageQuantity } =
    useEditorStore();

  useEffect(() => {
    const root =
      document.getElementById("gangsheet-portal") ||
      document.getElementById("gangsheet-editor-root");
    if (root?.dataset.appProxyUrl) {
      setAppProxyUrl(root.dataset.appProxyUrl);
    }

    getPricing()
      .then((data) => {
        if (data.prices) setPrices(data.prices);
      })
      .catch(console.error);
  }, [setPrices]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const { selectedImageId, removeImage, images, setImageQuantity } = useEditorStore.getState();

      // Delete / Backspace — remove selected image
      if ((e.key === "Delete" || e.key === "Backspace") && selectedImageId) {
        e.preventDefault();
        removeImage(selectedImageId);
      }

      // Ctrl+D — increase quantity of selected master
      if ((e.ctrlKey || e.metaKey) && e.key === "d" && selectedImageId) {
        e.preventDefault();
        const img = images.find((i) => i.id === selectedImageId);
        if (img) setImageQuantity(selectedImageId, img.quantity + 1);
      }

      // Escape — close editor
      if (e.key === "Escape") {
        if ((window as any).__gangsheetCloseEditor) {
          (window as any).__gangsheetCloseEditor();
        }
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div
      style={{
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize.bodyMd,
        lineHeight: theme.lineHeight.normal,
        letterSpacing: theme.letterSpacing.normal,
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateRows: "52px 1fr",
        gridTemplateColumns: "260px 1fr 240px",
        background: theme.bg,
        color: theme.text,
        overflow: "hidden",
      }}
      className="gs-editor"
    >
      {/* ── Header bar ────────────────────────────────── */}
      <header
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 16px",
          background: theme.headerBg,
          borderBottom: `1px solid ${theme.border}`,
          backdropFilter: "blur(12px)",
          zIndex: 10,
        }}
      >
        {/* Left: Logo + Title */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 180,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: theme.accentGradient,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              fontWeight: 700,
              color: "#fff",
            }}
          >
            G
          </div>
          <span style={{ fontSize: theme.fontSize.titleLg, fontWeight: theme.fontWeight.semibold, letterSpacing: theme.letterSpacing.tight }}>Gang Sheet Builder</span>
        </div>

        {/* Center: Toolbar */}
        <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          <Toolbar />
        </div>

        {/* Right: Price badge + Reset */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minWidth: 160,
            justifyContent: "flex-end",
          }}
        >
          <div
            style={{
              padding: "4px 14px",
              borderRadius: 20,
              background: theme.accentBg,
              border: `1px solid ${theme.accent}`,
              fontSize: theme.fontSize.bodyMd,
              fontWeight: theme.fontWeight.bold,
              color: theme.accent,
            }}
          >
            {currentPrice} kr
          </div>
          <button
            onClick={reset}
            title="Rensa allt"
            style={{
              padding: "6px 10px",
              fontSize: 12,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              background: "transparent",
              color: theme.textMuted,
              cursor: "pointer",
            }}
          >
            Rensa
          </button>
          <button
            onClick={() => {
              if ((window as any).__gangsheetCloseEditor) {
                (window as any).__gangsheetCloseEditor();
              }
            }}
            title="Stäng och gå tillbaka"
            style={{
              padding: "6px 12px",
              fontSize: 13,
              fontWeight: 600,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              background: theme.bgCard,
              color: theme.text,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            ← Tillbaka
          </button>
        </div>
      </header>

      {/* ── Left sidebar — Tabbed ─────────────────────── */}
      <LeftSidebar />

      {/* ── Center — Canvas ───────────────────────────── */}
      <main
        style={{
          background: theme.bgCanvas,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <GangSheetCanvas />
      </main>

      {/* ── Right sidebar — Config + Actions ──────────── */}
      <aside
        style={{
          background: theme.bgSidebar,
          borderLeft: `1px solid ${theme.border}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
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
          <PriceDisplay />
          <SheetManager />
        </div>

        <div
          style={{
            padding: `${theme.space.md}px ${theme.space.lg}px ${theme.space.lg}px`,
            borderTop: `1px solid ${theme.border}`,
            display: "flex",
            flexDirection: "column",
            gap: theme.space.sm,
          }}
        >
          <AutoBuildButton />
          <DownloadButton />
          <AddToCartButton />
        </div>
      </aside>

      {/* ── Animations + Responsive overrides ─────────── */}
      <style>{`
        @keyframes gs-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes gs-toast-in {
          from { transform: translateY(-10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .gs-editor {
          min-height: 0;
        }
        .gs-editor aside::-webkit-scrollbar {
          width: 6px;
        }
        .gs-editor aside::-webkit-scrollbar-track {
          background: transparent;
        }
        .gs-editor aside::-webkit-scrollbar-thumb {
          background: ${theme.border};
          border-radius: 3px;
        }
        .gs-editor aside > div::-webkit-scrollbar {
          width: 6px;
        }
        .gs-editor aside > div::-webkit-scrollbar-track {
          background: transparent;
        }
        .gs-editor aside > div::-webkit-scrollbar-thumb {
          background: ${theme.border};
          border-radius: 3px;
        }
        @media (max-width: 900px) {
          .gs-editor {
            grid-template-columns: 1fr !important;
            grid-template-rows: 52px auto 1fr auto !important;
            height: auto !important;
            min-height: 100vh;
          }
          .gs-editor > aside {
            border: none !important;
            border-bottom: 1px solid ${theme.border} !important;
          }
          .gs-editor > main {
            min-height: 400px;
          }
        }
        @media (min-width: 901px) and (max-width: 1100px) {
          .gs-editor {
            grid-template-columns: 240px 1fr 220px !important;
          }
        }
      `}</style>
    </div>
  );
}
