import { Wordmark } from "./components/Brand/Wordmark";
import { useEffect, useRef, useState } from "react";
import { GangSheetCanvas } from "./components/Canvas/GangSheetCanvas";
import { TextTab } from "./components/LeftSidebar/TextTab";
import { BuilderPanel } from "./components/LeftSidebar/BuilderPanel";
import { MobileRoster } from "./components/ImagePanel/MobileRoster";
import { NamesModal } from "./names/NamesModal";
import { useSheetStats } from "./utils/sheetStats";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { ArrangeButton } from "./components/Toolbar/ArrangeButton";
import { PriceDisplay, PriceBar } from "./components/PriceDisplay/PriceDisplay";
import { AddToCartButton } from "./components/PriceDisplay/AddToCartButton";
import { DownloadButton } from "./components/PriceDisplay/DownloadButton";
import { SheetManager } from "./components/SheetManager/SheetManager";
import { SheetInsight } from "./components/SheetInsight/SheetInsight";
import { StartWizard } from "./components/StartWizard/StartWizard";
import { useEditorStore, getSheetsTotalPrice, groupKey, groupImages, type EditorImage } from "./store/editorStore";
import { redo, undo, useHistory } from "./store/history";
import { getPricing, setAppProxyUrl } from "./services/api";
import { theme } from "./styles/theme";
import { cmText } from "./utils/units";

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

      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault();
        redo();
        return;
      }

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
          {/* Price and "Lägg till motiv" live in the side panels now. */}
          <HeaderButton onClick={onReset} title="Rensa allt">
            Rensa
          </HeaderButton>
          <HeaderButton onClick={closeEditor} title="Stäng och gå tillbaka" strong>
            ← Tillbaka
          </HeaderButton>
        </div>
      </header>

      <BuilderPanel onAddDesigns={onRestartWizard} />

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
        {/* The order first, as the top of a checkout should be. */}
        <div
          style={{
            padding: theme.space.lg,
            borderBottom: `1px solid ${theme.border}`,
            display: "flex",
            flexDirection: "column",
            gap: theme.space.sm,
            background: theme.bg,
          }}
        >
          <PriceBar />
          <AddToCartButton />
        </div>

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
          <DownloadButton />
        </div>
      </aside>

      <GlobalStyles />
    </div>
  );
}

/* ─────────────────────────── Mobile ──────────────────────────── */

const HEADER_ICON = {
  undo: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  ),
  redo: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  ),
};

/** Undo and redo on the phone, where there is no keyboard. */
function MobileHistory() {
  const { canUndo, canRedo } = useHistory();
  const button = (label: string, icon: React.ReactNode, onClick: () => void, enabled: boolean) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={label}
      title={label}
      style={{
        width: 38,
        height: 34,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: theme.radiusSm,
        background: "transparent",
        color: "#ffffff",
        opacity: enabled ? 1 : 0.35,
        cursor: enabled ? "pointer" : "default",
      }}
    >
      {icon}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {button("Ångra", HEADER_ICON.undo, undo, canUndo)}
      {button("Gör om", HEADER_ICON.redo, redo, canRedo)}
    </div>
  );
}

/**
 * Phones got the desktop grid squeezed into 375 px: the layout overflowed
 * to ~900 px wide and 1570 px tall inside a 100vh box with no scrolling,
 * so the price and "Lägg i varukorg" were simply unreachable. This shell
 * is built for the small screen instead — the canvas on top, and below it
 * a sheet that pulls up into the list of designs, with the cart always at
 * the bottom.
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
  /** The designs list, pulled up over the lower part of the canvas. */
  const [open, setOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const { images, sheets, prices, sheetSize, filmType, activeSheetIndex, selectedImageId } = useEditorStore();
  const stats = useSheetStats();
  const designs = groupImages(images).length;
  const total = getSheetsTotalPrice(sheets, prices, sheetSize, filmType, activeSheetIndex, images.length);
  const errors = stats.issues.filter((i) => i.severity === "error").length;
  const metres = (sheetSize.heightMm / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 });
  const selected = images.find((i) => i.id === selectedImageId) ?? null;
  // "Text" is always a new text. With a text picked it used to open that
  // one for editing, and what was typed ran on after its words.
  const newText = () => {
    useEditorStore.getState().selectImage(null);
    setTextOpen(true);
  };

  // Pull the sheet up or push it down by its top edge.
  const dragFrom = useRef<number | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragFrom.current = e.clientY;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragFrom.current === null) return;
    const dy = e.clientY - dragFrom.current;
    dragFrom.current = null;
    if (dy < -24) setOpen(true);
    else if (dy > 24) setOpen(false);
  };

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
        // The canvas colour, so the sheet's rounded top corners show.
        background: theme.bgCanvas,
        color: theme.text,
        overflow: "hidden",
        position: "relative",
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
        <MobileHistory />
        <HeaderButton onClick={closeEditor} title="Stäng" strong>
          ✕
        </HeaderButton>
      </header>

      {/* Canvas — with the list pulled up it is a preview of the sheet, and
          its zoom and view buttons would sit on what little shows of it. */}
      <main style={{ ...canvasStyle, flex: 1, minHeight: 0 }}>
        <GangSheetCanvas hideControls={open} />
      </main>

      {/* The sheet: summary (or the design picked), the list when pulled up, the cart. */}
      <section style={{ ...mob.sheet, ...(open ? mob.sheetOpen : null) }}>
        <div style={mob.sheetTop} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={mob.grabberHit}
            aria-label={open ? "Dölj motiven" : "Visa motiven"}
          >
            <span style={mob.grabber} />
          </button>
          {selected && !open ? (
            <SelectionRow image={selected} onEditText={() => setTextOpen(true)} />
          ) : (
            <button type="button" onClick={() => setOpen(!open)} style={mob.summary} aria-expanded={open}>
              <span style={{ ...mob.chevron, transform: open ? "rotate(180deg)" : "none" }}>{CHEVRON_UP}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <span style={mob.summaryMain}>
                  {designs ? `${designs} motiv · ${images.length} st` : "Inga motiv ännu"}
                </span>
                <span style={mob.summarySub}>
                  {open ? "Tryck för att dölja" : designs ? "Tryck för att se och ändra" : "Lägg till motiv för att börja"}
                </span>
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={mob.summaryMain}>
                  {metres} m · {total !== null ? `${total} kr` : "—"}
                </span>
                {designs > 0 && (
                  <span style={{ fontSize: 12, fontWeight: 600, color: errors ? theme.danger : theme.success }}>
                    {errors ? `${errors} att åtgärda` : "Redo för tryck"}
                  </span>
                )}
              </span>
            </button>
          )}
        </div>

        {open ? (
          <div style={mob.sheetBody}>
            <MobileSheetTabs />
            <div style={mob.listHead}>
              <span style={mob.sectionHead}>Dina motiv</span>
              <span style={{ fontSize: 12, color: theme.textMuted }}>
                58 × {Math.round(sheetSize.heightMm / 10)} cm
              </span>
            </div>
            <MobileRoster />
            <button type="button" onClick={onRestartWizard} style={mob.addButton}>
              ＋ Lägg till motiv
            </button>
            <div style={mob.toolGrid}>
              <button type="button" onClick={newText} style={mob.action}>
                T&nbsp; Text
              </button>
              <button type="button" onClick={() => setNamesOpen(true)} style={mob.action}>
                Namn &amp; nr
              </button>
            </div>
            <ArrangeButton />
            <SheetInsight />
            <PriceDisplay />
            <SheetManager />
            <DownloadButton />
            <button type="button" onClick={onReset} style={mob.resetButton}>
              Rensa arket och börja om
            </button>
          </div>
        ) : (
          <div style={mob.actions}>
            <button type="button" onClick={onRestartWizard} style={{ ...mob.action, ...mob.actionPrimary }}>
              ＋ Motiv
            </button>
            <button type="button" onClick={newText} style={mob.action}>
              T&nbsp; Text
            </button>
            <button type="button" onClick={() => setNamesOpen(true)} style={mob.action}>
              Namn &amp; nr
            </button>
          </div>
        )}

        <div style={mob.cta}>
          <AddToCartButton />
        </div>
      </section>

      {/* The text tool: a form, so it gets a drawer of its own. */}
      {textOpen && (
        <div style={mob.drawerBackdrop} onClick={() => setTextOpen(false)}>
          <div style={mob.drawer} onClick={(e) => e.stopPropagation()}>
            <div style={mob.grabberRow}>
              <div style={mob.grabber} />
              <button onClick={() => setTextOpen(false)} style={mob.drawerClose}>
                Klar
              </button>
            </div>
            <div style={mob.drawerBody}>
              <TextTab onDone={() => setTextOpen(false)} />
            </div>
          </div>
        </div>
      )}
      {namesOpen && <NamesModal onClose={() => setNamesOpen(false)} />}

      {/* The guide gets the whole screen: inside the canvas it had a third
          of it, over a greyed-out cart it could not use yet. */}
      {wizard}

      <GlobalStyles />
    </div>
  );
}

const CHEVRON_UP = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m6 15 6-6 6 6" />
  </svg>
);

/**
 * The design picked on the sheet, with what a phone needs most: turn it,
 * one more, remove it. There was no way to do any of that on a phone
 * except opening the list and finding the design again.
 */
function SelectionRow({ image, onEditText }: { image: EditorImage; onEditText: () => void }) {
  const { images, updateGroup, duplicateImage, removeGroup, selectImage } = useEditorStore();
  const key = groupKey(image);
  const count = images.filter((i) => groupKey(i) === key).length;
  const name = image.text?.text ? `"${image.text.text.replace(/\s+/g, " ").trim()}"` : image.filename;
  const icon = (d: string) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
  return (
    <div style={mob.selRow}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ ...mob.summaryMain, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</p>
        <p style={{ ...mob.summarySub, margin: "2px 0 0" }}>
          {cmText(image.displayWidth)} × {cmText(image.displayHeight)} cm{count > 1 ? ` · ${count} st` : ""}
        </p>
      </div>
      {image.text && (
        <button type="button" onClick={onEditText} style={mob.selButton} aria-label="Ändra texten" title="Ändra texten">
          {icon("M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4")}
        </button>
      )}
      <button
        type="button"
        onClick={() => updateGroup(key, { rotation: (image.rotation + 90) % 360 })}
        style={mob.selButton}
        aria-label="Rotera 90°"
        title="Rotera 90°"
      >
        {icon("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7")}
      </button>
      <button type="button" onClick={() => duplicateImage(image.id)} style={mob.selButton} aria-label="En till" title="En till">
        {icon("M8 8h12v12H8zM4 16V4h12M14 11v6M11 14h6")}
      </button>
      <button
        type="button"
        onClick={() => removeGroup(key)}
        style={{ ...mob.selButton, color: theme.danger }}
        aria-label="Ta bort"
        title="Ta bort motivet och alla kopior"
      >
        {icon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3")}
      </button>
      <button type="button" onClick={() => selectImage(null)} style={mob.selDone}>
        Klar
      </button>
    </div>
  );
}

/** Sheet tabs when there is more than one, as on the order: Ark 1, Ark 2 … */
function MobileSheetTabs() {
  const { sheets, activeSheetIndex, switchSheet, addSheet } = useEditorStore();
  if (sheets.length < 2) return null;
  return (
    <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
      {sheets.map((sheet, idx) => {
        const active = idx === activeSheetIndex;
        return (
          <button
            key={sheet.id}
            type="button"
            onClick={() => switchSheet(idx)}
            style={{
              ...mob.tab,
              background: active ? theme.secondary : theme.bg,
              color: active ? "#ffffff" : theme.text,
              borderColor: active ? theme.secondary : theme.borderStrong,
            }}
          >
            {sheet.name || `Ark ${idx + 1}`}
          </button>
        );
      })}
      <button type="button" onClick={addSheet} style={{ ...mob.tab, borderStyle: "dashed", color: theme.textMuted }}>
        ＋ Ark
      </button>
    </div>
  );
}

const mob: Record<string, React.CSSProperties> = {
  sheet: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: theme.bg,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    boxShadow: "0 -6px 24px rgba(16, 24, 40, 0.10)",
    position: "relative",
    zIndex: 8,
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
  },
  sheetOpen: { height: "70%", maxHeight: "calc(100% - 140px)" },
  sheetTop: { flexShrink: 0, touchAction: "none" },
  grabberHit: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: 16,
    padding: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    background: "rgba(0, 0, 0, 0.18)",
    margin: "0 auto",
  },
  summary: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "2px 16px 12px 12px",
    border: "none",
    background: "transparent",
    fontFamily: theme.fontFamily,
    cursor: "pointer",
    textAlign: "left",
    color: theme.text,
  },
  chevron: {
    width: 28,
    height: 28,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    background: theme.bgInput,
    color: theme.text,
    transition: "transform 0.2s",
  },
  summaryMain: { fontWeight: 700, fontSize: 14.5, color: theme.text },
  summarySub: { fontSize: 12, color: theme.textMuted },
  selRow: { display: "flex", alignItems: "center", gap: 6, padding: "2px 12px 12px 16px" },
  selButton: {
    width: 38,
    height: 38,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 12,
    background: theme.bg,
    color: theme.text,
    cursor: "pointer",
  },
  selDone: {
    height: 38,
    flexShrink: 0,
    padding: "0 14px",
    border: "none",
    borderRadius: 12,
    background: theme.secondary,
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  sheetBody: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "4px 14px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    borderTop: `1px solid ${theme.border}`,
    paddingTop: 12,
  },
  listHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  tab: {
    flexShrink: 0,
    padding: "7px 14px",
    border: "1px solid",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  addButton: {
    width: "100%",
    padding: "13px",
    border: `1.5px dashed ${theme.accent}`,
    borderRadius: theme.radius,
    background: theme.accentBg,
    color: theme.accent,
    fontSize: 14.5,
    fontWeight: 700,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
  toolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  actions: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1fr 1fr",
    gap: 8,
    padding: "0 12px 4px",
  },
  action: {
    padding: "11px 6px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 12,
    background: theme.bg,
    color: theme.text,
    fontFamily: theme.fontFamily,
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  actionPrimary: { background: theme.secondary, borderColor: theme.secondary, color: "#fff" },
  cta: { flexShrink: 0, padding: "10px 12px 12px" },
  sectionHead: {
    fontSize: theme.fontSize.labelMd,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: theme.textMuted,
  },
  resetButton: {
    padding: "10px",
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    background: "transparent",
    color: theme.textMuted,
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    cursor: "pointer",
  },
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
  gridTemplateColumns: "300px minmax(0, 1fr) 280px",
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
      @keyframes gs-nn-spin { to { transform: rotate(360deg); } }
      @keyframes gs-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
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
      /* iOS zooms the whole page into any field with text under 16 px,
         and the editor then no longer fits the screen. */
      @media (max-width: 900px) {
        .gs-editor input, .gs-editor textarea, .gs-editor select { font-size: 16px !important; }
      }
    `}</style>
  );
}
