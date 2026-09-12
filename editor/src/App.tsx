import { useEffect, useState } from "react";
import { GangSheetCanvas } from "./components/Canvas/GangSheetCanvas";
import { LeftSidebar, TabContent, TABS, type TabKey } from "./components/LeftSidebar/LeftSidebar";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { ArrangeButton } from "./components/Toolbar/ArrangeButton";
import { PriceDisplay, PriceBar } from "./components/PriceDisplay/PriceDisplay";
import { AddToCartButton } from "./components/PriceDisplay/AddToCartButton";
import { DownloadButton } from "./components/PriceDisplay/DownloadButton";
import { SheetManager } from "./components/SheetManager/SheetManager";
import { SheetInsight } from "./components/SheetInsight/SheetInsight";
import { StartWizard } from "./components/StartWizard/StartWizard";
import { useEditorStore, getSheetsTotalPrice, groupKey } from "./store/editorStore";
import { getPricing, setAppProxyUrl } from "./services/api";
import { theme } from "./styles/theme";

const MOBILE_QUERY = "(max-width: 900px)";

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

function closeEditor() {
  const close = (window as any).__gangsheetCloseEditor;
  if (typeof close === "function") close();
}

export function App() {
  const { setPrices, reset, images } = useEditorStore();
  const isMobile = useIsMobile();

  // The wizard is the front door for a fresh session; returning to an
  // editor that already has designs should not put a modal in the way.
  const [showWizard, setShowWizard] = useState(() => images.length === 0);

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
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const { selectedImageId, removeGroup, images, duplicateImage } =
        useEditorStore.getState();
      const selected = images.find((i) => i.id === selectedImageId);

      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        // Removes the design and all its copies, matching the toolbar and
        // the sidebar — deleting one of 24 identical copies just leaves a
        // hole the next re-tile fills back in.
        removeGroup(groupKey(selected));
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "d" && selectedImageId) {
        e.preventDefault();
        if (images.some((i) => i.id === selectedImageId)) {
          duplicateImage(selectedImageId);
        }
      }

      if (e.key === "Escape") closeEditor();
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const handleReset = () => {
    if (images.length > 0 && !confirm("Rensa arket och börja om?")) return;
    reset();
    setShowWizard(true);
  };

  const wizard = showWizard ? (
    <StartWizard onClose={() => setShowWizard(false)} />
  ) : null;

  return isMobile ? (
    <MobileShell
      wizard={wizard}
      onReset={handleReset}
      onRestartWizard={() => setShowWizard(true)}
    />
  ) : (
    <DesktopShell
      wizard={wizard}
      onReset={handleReset}
      onRestartWizard={() => setShowWizard(true)}
    />
  );
}

/* ─────────────────────────── Desktop ─────────────────────────── */

function DesktopShell({
  wizard,
  onReset,
  onRestartWizard,
}: {
  wizard: React.ReactNode;
  onReset: () => void;
  onRestartWizard: () => void;
}) {
  return (
    <div style={shellBase} className="gs-editor gs-editor-desktop">
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180 }}>
          <Wordmark />
        </div>

        <div style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
          <Toolbar />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 200,
            justifyContent: "flex-end",
          }}
        >
          <PriceBadge />
          <HeaderButton onClick={onRestartWizard} title="Öppna guiden igen">
            Guide
          </HeaderButton>
          <HeaderButton onClick={onReset} title="Rensa allt">
            Rensa
          </HeaderButton>
          <HeaderButton onClick={closeEditor} title="Stäng och gå tillbaka" strong>
            ← Tillbaka
          </HeaderButton>
        </div>
      </header>

      <LeftSidebar />

      <main style={canvasStyle}>
        <GangSheetCanvas />
        {wizard}
      </main>

      <aside
        style={{
          background: theme.bgSidebar,
          borderLeft: `1px solid ${theme.border}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
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
            minHeight: 0,
          }}
        >
          <PriceDisplay />
          <SheetInsight />
          <SheetManager />
        </div>

        <div
          style={{
            padding: `${theme.space.sm}px ${theme.space.lg}px ${theme.space.lg}px`,
            borderTop: `1px solid ${theme.border}`,
            display: "flex",
            flexDirection: "column",
            gap: theme.space.sm,
          }}
        >
          <PriceBar />
          <ArrangeButton />
          <DownloadButton />
          <AddToCartButton />
        </div>
      </aside>

      <GlobalStyles />
    </div>
  );
}

/* ─────────────────────────── Mobile ──────────────────────────── */

/**
 * Phones got the desktop grid squeezed into 375 px: the layout overflowed
 * to ~900 px wide and 1570 px tall inside a 100vh box with no scrolling,
 * so the price and "Lägg i varukorg" were simply unreachable. This shell
 * is built for the small screen instead — canvas front and centre, the
 * panels in a drawer, and checkout always visible at the bottom.
 */
function MobileShell({
  wizard,
  onReset,
  onRestartWizard,
}: {
  wizard: React.ReactNode;
  onReset: () => void;
  onRestartWizard: () => void;
}) {
  const [drawer, setDrawer] = useState<TabKey | "sheet" | null>(null);
  const { images } = useEditorStore();

  return (
    <div
      className="gs-editor gs-editor-mobile"
      style={{
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize.bodyMd,
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: theme.bg,
        color: theme.text,
        overflow: "hidden",
      }}
    >
      {/* Compact header */}
      <header
        style={{
          flexShrink: 0,
          height: 52,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          background: theme.headerBg,
        }}
      >
        <Wordmark />
        <div style={{ flex: 1 }} />
        <HeaderButton onClick={onRestartWizard} title="Guide">
          Guide
        </HeaderButton>
        <HeaderButton onClick={onReset} title="Rensa allt">
          Rensa
        </HeaderButton>
        <HeaderButton onClick={closeEditor} title="Stäng" strong>
          ✕
        </HeaderButton>
      </header>

      {/* Canvas */}
      <main style={{ ...canvasStyle, flex: 1, minHeight: 0 }}>
        <GangSheetCanvas />
        {wizard}
      </main>

      {/* Drawer */}
      {drawer && (
        <div style={mob.drawerBackdrop} onClick={() => setDrawer(null)}>
          <div style={mob.drawer} onClick={(e) => e.stopPropagation()}>
            <div style={mob.grabberRow}>
              <div style={mob.grabber} />
              <button onClick={() => setDrawer(null)} style={mob.drawerClose}>
                Klar
              </button>
            </div>
            <div style={mob.drawerBody}>
              {drawer === "sheet" ? (
                <div style={{ padding: theme.space.lg, display: "flex", flexDirection: "column", gap: theme.space.lg }}>
                  <PriceDisplay />
                  <SheetInsight />
                  <ArrangeButton />
                  <SheetManager />
                  <DownloadButton />
                </div>
              ) : (
                <TabContent tab={drawer} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar — checkout is always one tap away */}
      <nav style={mob.bar}>
        <div style={mob.tabRow}>
          {TABS.filter((t) => t.key !== "settings").map((tab) => (
            <MobileTab
              key={tab.key}
              icon={tab.icon}
              label={tab.label}
              active={drawer === tab.key}
              onClick={() => setDrawer(drawer === tab.key ? null : tab.key)}
            />
          ))}
          <MobileTab
            icon={sheetIcon}
            label="Ark"
            active={drawer === "sheet"}
            badge={images.length || undefined}
            onClick={() => setDrawer(drawer === "sheet" ? null : "sheet")}
          />
        </div>
        <div style={{ padding: "8px 12px 12px" }}>
          <AddToCartButton />
        </div>
      </nav>

      <GlobalStyles />
    </div>
  );
}

const sheetIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 7h6M9 12h6M9 17h3"/></svg>`;

function MobileTab({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 2px 6px",
        border: "none",
        background: active ? theme.accentBg : "transparent",
        color: active ? theme.accent : theme.textMuted,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        cursor: "pointer",
        position: "relative",
        fontFamily: theme.fontFamily,
      }}
    >
      <span dangerouslySetInnerHTML={{ __html: icon }} />
      <span style={{ fontSize: 10, fontWeight: active ? 600 : 400 }}>{label}</span>
      {badge !== undefined && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: "50%",
            marginRight: -22,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 8,
            background: theme.accent,
            color: "#fff",
            fontSize: 9,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

const mob: Record<string, React.CSSProperties> = {
  drawerBackdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(20,20,22,0.4)",
    display: "flex",
    alignItems: "flex-end",
    zIndex: 30,
  },
  drawer: {
    width: "100%",
    maxHeight: "72%",
    background: theme.bgSidebar,
    borderTopLeftRadius: theme.radiusLg,
    borderTopRightRadius: theme.radiusLg,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: theme.shadowLg,
  },
  grabberRow: {
    display: "flex",
    alignItems: "center",
    padding: "8px 12px 4px",
    position: "relative",
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    background: theme.borderStrong,
    margin: "0 auto",
  },
  drawerClose: {
    position: "absolute",
    right: 12,
    top: 6,
    padding: "4px 10px",
    border: "none",
    background: "transparent",
    color: theme.accent,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  drawerBody: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", minHeight: 0 },
  bar: {
    flexShrink: 0,
    background: theme.bg,
    borderTop: `1px solid ${theme.border}`,
    boxShadow: "0 -2px 12px rgba(0,0,0,0.06)",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
  },
  tabRow: { display: "flex", borderBottom: `1px solid ${theme.border}` },
};

/* ───────────────────────── Shared bits ───────────────────────── */

const shellBase: React.CSSProperties = {
  fontFamily: theme.fontFamily,
  fontSize: theme.fontSize.bodyMd,
  lineHeight: theme.lineHeight.normal,
  letterSpacing: theme.letterSpacing.normal,
  width: "100%",
  height: "100%",
  display: "grid",
  gridTemplateRows: "52px minmax(0, 1fr)",
  gridTemplateColumns: "320px minmax(0, 1fr) 260px",
  background: theme.bg,
  color: theme.text,
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "0 20px",
  background: theme.headerBg,
  zIndex: 10,
};

const canvasStyle: React.CSSProperties = {
  background: theme.bgCanvas,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  position: "relative",
  minWidth: 0,
  minHeight: 0,
};

function Wordmark() {
  return (
    <span
      style={{
        fontSize: theme.fontSize.titleLg,
        fontWeight: theme.fontWeight.bold,
        color: theme.textWhite,
        letterSpacing: theme.letterSpacing.tight,
        whiteSpace: "nowrap",
      }}
    >
      Transfer<span style={{ color: theme.accent }}>craft</span>
    </span>
  );
}

function PriceBadge() {
  const { sheets, prices, sheetSize, filmType, activeSheetIndex, images } =
    useEditorStore();
  const total = getSheetsTotalPrice(
    sheets,
    prices,
    sheetSize,
    filmType,
    activeSheetIndex,
    images.length,
  );
  return (
    <div
      style={{
        padding: "6px 16px",
        borderRadius: 20,
        background: theme.accent,
        fontSize: theme.fontSize.bodyMd,
        fontWeight: theme.fontWeight.bold,
        color: "#fff",
        whiteSpace: "nowrap",
      }}
    >
      {total !== null ? `${total} kr` : "—"}
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  title,
  strong,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  strong?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: strong ? "6px 14px" : "6px 12px",
        fontSize: strong ? 13 : 12,
        fontWeight: strong ? 600 : 400,
        fontFamily: theme.fontFamily,
        border: `1px solid rgba(255,255,255,${strong ? 0.2 : 0.15})`,
        borderRadius: theme.radiusSm,
        background: strong ? "rgba(255,255,255,0.1)" : "transparent",
        color: strong ? "#fff" : "rgba(255,255,255,0.7)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function GlobalStyles() {
  return (
    <style>{`
      @keyframes gs-spin { to { transform: rotate(360deg); } }
      @keyframes gs-toast-in {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .gs-editor { min-height: 0; }
      .gs-editor *, .gs-editor *::before, .gs-editor *::after { box-sizing: border-box; }
      .gs-editor input[type="number"]::-webkit-outer-spin-button,
      .gs-editor input[type="number"]::-webkit-inner-spin-button {
        -webkit-appearance: none; margin: 0;
      }
      .gs-editor input[type="number"] { -moz-appearance: textfield; }
      .gs-editor ::-webkit-scrollbar { width: 6px; height: 6px; }
      .gs-editor ::-webkit-scrollbar-track { background: transparent; }
      .gs-editor ::-webkit-scrollbar-thumb {
        background: rgba(0,0,0,0.14); border-radius: 3px;
      }
      /* Narrower desktops: trim the rails, never the canvas. */
      @media (min-width: 901px) and (max-width: 1200px) {
        .gs-editor-desktop {
          grid-template-columns: 280px minmax(0, 1fr) 230px !important;
        }
      }
      @media (max-width: 480px) {
        .gs-wizard { max-height: 100%; }
      }
    `}</style>
  );
}
