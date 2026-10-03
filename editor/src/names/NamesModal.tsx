import { useEffect } from "react";
import { NamesNumbers } from "./NamesNumbers";
import { addGraphicsToSheet } from "./addToSheet";
import type { PriceList } from "./pricing";
import { useIsMobile } from "../utils/useIsMobile";
import { theme } from "../styles/theme";

const NO_PRICES: PriceList = new Map();

/** "Namn & nummer" in the builder: the team list, straight onto the sheet. */
export function NamesModal({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div style={M.overlay} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Namn och nummer"
        style={isMobile ? M.panelMobile : M.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={M.head}>
          <div>
            <h2 style={M.title}>Namn och nummer</h2>
            <p style={M.lead}>Hela laget på en gång. Skriv listan, klistra in från Excel eller ladda upp en CSV.</p>
          </div>
          <button type="button" onClick={onClose} style={M.close} aria-label="Stäng">
            ×
          </button>
        </header>
        <NamesNumbers mode="builder" prices={NO_PRICES} onAddToSheet={addGraphicsToSheet} onDone={onClose} />
      </div>
    </div>
  );
}

const M: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 70,
    background: "rgba(17,17,20,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  panel: {
    width: "100%",
    maxWidth: 1120,
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
    background: "#fff",
    borderRadius: 20,
    padding: "22px 24px 26px",
    boxShadow: "0 30px 90px rgba(0,0,0,0.3)",
    fontFamily: theme.fontFamily,
  },
  panelMobile: {
    position: "fixed",
    inset: 0,
    overflowY: "auto",
    background: "#fff",
    padding: "16px 14px 24px",
    fontFamily: theme.fontFamily,
  },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18 },
  title: { margin: 0, fontSize: "1.25rem", fontWeight: 700, color: theme.text },
  lead: { margin: "4px 0 0", fontSize: 14, color: theme.textMuted },
  close: { border: "none", background: "transparent", fontSize: 28, lineHeight: 1, color: theme.textMuted, cursor: "pointer", padding: 0 },
};
