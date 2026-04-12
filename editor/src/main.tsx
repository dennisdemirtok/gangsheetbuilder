import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";

let activeRoot: Root | null = null;

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
      z-index: 2147483647 !important;
      margin: 0 !important;
      padding: 0 !important;
      max-width: none !important;
      overflow: hidden !important;
      background: #f7f9fb !important;
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

  const styles = document.getElementById("gangsheet-portal-styles");
  if (styles) styles.remove();

  document.body.classList.remove("gangsheet-open");
  document.body.style.overflow = "";
};
