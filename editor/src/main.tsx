import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { ReadySheetModal } from "./components/ReadySheet/ReadySheetModal";
import { setAppProxyUrl } from "./services/api";
import { NamesNumbers } from "./names/NamesNumbers";
import { readPrices } from "./names/pricing";

let activeRoot: Root | null = null;
let uploadRoot: Root | null = null;

/**
 * While the editor is open the page must not zoom. iOS zooms in on any
 * field with text under 16 px and pinches the whole page along with the
 * sheet; either left the editor larger than the screen, with the cart
 * button and the "Ark" tab cut off. The theme's viewport is put back on
 * close.
 */
let savedViewport: string | null = null;
const blockPageZoom = (e: Event) => e.preventDefault();

function lockPageZoom() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta && savedViewport === null) {
    savedViewport = meta.getAttribute("content") ?? "";
    meta.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
  }
  document.addEventListener("gesturestart", blockPageZoom, { passive: false });
  document.addEventListener("gesturechange", blockPageZoom, { passive: false });
}

function unlockPageZoom() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta && savedViewport !== null) meta.setAttribute("content", savedViewport);
  savedViewport = null;
  document.removeEventListener("gesturestart", blockPageZoom);
  document.removeEventListener("gesturechange", blockPageZoom);
}

function mount() {
  // Clean up previous mount if it exists
  cleanup();

  const editorRoot = document.getElementById("gangsheet-editor-root");
  if (!editorRoot) {
    console.error("Gang Sheet Editor: #gangsheet-editor-root not found");
    return;
  }

  const appProxyUrl = editorRoot.dataset.appProxyUrl || "/apps/gangsheet";
  const shop = editorRoot.dataset.shop || "";
  const currency = editorRoot.dataset.currency || "SEK";

  // Create portal container on body
  const portalDiv = document.createElement("div");
  portalDiv.id = "gangsheet-portal";
  portalDiv.dataset.appProxyUrl = appProxyUrl;
  portalDiv.dataset.shop = shop;
  portalDiv.dataset.currency = currency;

  // Inject styles (remove old first)
  let style = document.getElementById("gangsheet-portal-styles") as HTMLStyleElement;
  if (!style) {
    style = document.createElement("style");
    style.id = "gangsheet-portal-styles";
    document.head.appendChild(style);
  }
  style.textContent = `
    #gangsheet-portal {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      /* The visible height on phones: with 100vh the bottom bar, and the
         cart button in it, sat under Safari's toolbar. */
      height: 100dvh !important;
      z-index: 2147483647 !important;
      margin: 0 !important;
      padding: 0 !important;
      max-width: none !important;
      overflow: hidden !important;
      background: #ffffff !important;
      touch-action: manipulation;
      -webkit-text-size-adjust: 100%;
    }
    body.gangsheet-open > *:not(#gangsheet-portal):not(script):not(style):not(link):not(dialog):not([role="dialog"]) {
      visibility: hidden !important;
      position: absolute !important;
      width: 0 !important;
      height: 0 !important;
      overflow: hidden !important;
    }
    body.gangsheet-open {
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
    }
  `;

  document.body.appendChild(portalDiv);
  lockPageZoom();
  document.body.classList.add("gangsheet-open");
  document.body.style.overflow = "hidden";

  // Hide loading spinner
  const loading = document.getElementById("gangsheet-loading");
  if (loading) loading.style.display = "none";
  const overlay = document.getElementById("gangsheet-overlay");
  if (overlay) overlay.style.display = "none";

  // Mount React
  activeRoot = createRoot(portalDiv);
  activeRoot.render(<App />);
}

function cleanup() {
  // Unmount React properly
  if (activeRoot) {
    try {
      activeRoot.unmount();
    } catch {
      // ignore
    }
    activeRoot = null;
  }

  // Remove portal div
  const portal = document.getElementById("gangsheet-portal");
  if (portal) portal.remove();
}

// Expose globally
(window as any).__gangsheetMount = mount;

(window as any).__gangsheetCloseEditor = function () {
  cleanup();
  unlockPageZoom();

  const styles = document.getElementById("gangsheet-portal-styles");
  if (styles) styles.remove();

  document.body.classList.remove("gangsheet-open");
  document.body.style.overflow = "";
};


/* ─────────────── Ready-made sheet flow ───────────────
 * Mounted on its own so a customer who already has a finished sheet never
 * loads the builder. It lives in this bundle rather than in the theme
 * because it shares the same upload, pricing and cart code — keeping a
 * second copy in Liquid is what let a hardcoded price survive there.
 */

function readProxyUrl(): void {
  const root = document.getElementById("gangsheet-editor-root");
  if (root?.dataset.appProxyUrl) setAppProxyUrl(root.dataset.appProxyUrl);
}

function closeUpload(): void {
  if (uploadRoot) {
    try {
      uploadRoot.unmount();
    } catch {
      // ignore
    }
    uploadRoot = null;
  }
  document.getElementById("gangsheet-upload-portal")?.remove();
  document.body.style.overflow = "";
}

function openUpload(): void {
  closeUpload();
  readProxyUrl();

  const portal = document.createElement("div");
  portal.id = "gangsheet-upload-portal";
  document.body.appendChild(portal);
  document.body.style.overflow = "hidden";

  uploadRoot = createRoot(portal);
  uploadRoot.render(<ReadySheetModal onClose={closeUpload} />);
}

(window as any).__gangsheetOpenUpload = function () {
  // Leaving the builder open behind a fullscreen modal traps the customer.
  if (activeRoot) (window as any).__gangsheetCloseEditor?.();
  openUpload();
};

(window as any).__gangsheetCloseUpload = closeUpload;


/* ─────────────── Namn och Siffror ───────────────
 * The team names and numbers product mounts inline on its product page
 * (app block "names-numbers"), not as an overlay. Same bundle: it shares
 * the fonts, the text renderer, uploads and the gang sheet API.
 */

(window as any).__gangsheetMountNames = function (el: HTMLElement) {
  if (el.dataset.mounted) return;
  el.dataset.mounted = "1";
  if (el.dataset.appProxyUrl) setAppProxyUrl(el.dataset.appProxyUrl);
  if (!document.getElementById("gs-nn-styles")) {
    const style = document.createElement("style");
    style.id = "gs-nn-styles";
    style.textContent = "@keyframes gs-nn-spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  }
  let variants: unknown = [];
  try {
    variants = JSON.parse(el.querySelector("script[data-nn-variants]")?.textContent || "[]");
  } catch {
    variants = [];
  }
  createRoot(el).render(<NamesNumbers prices={readPrices(variants)} />);
};
