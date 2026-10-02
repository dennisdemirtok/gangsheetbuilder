import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

/**
 * The local preview has no Shopify CDN: serve the extension's assets (the
 * text tool's fonts) from /ext-assets/, where src/config/fonts.ts looks
 * when there is no editor bundle to sit next to.
 */
const extensionAssets = {
  name: "extension-assets",
  apply: "serve" as const,
  configureServer(server: { middlewares: { use: (path: string, fn: (req: any, res: any, next: () => void) => void) => void } }) {
    const dir = path.resolve(__dirname, "../extensions/gang-sheet-editor/assets");
    server.middlewares.use("/ext-assets", (req, res, next) => {
      const name = decodeURIComponent((req.url || "").split("?")[0]!.replace(/^\/+/, ""));
      if (!/^[\w.-]+$/.test(name)) return next();
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return next();
      res.setHeader("Content-Type", name.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
      fs.createReadStream(file).pipe(res);
    });
  },
};

export default defineConfig({
  plugins: [react(), extensionAssets],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    // Build as a single JS bundle for the storefront
    lib: {
      entry: path.resolve(__dirname, "src/main.tsx"),
      name: "GangSheetEditor",
      fileName: "editor",
      formats: ["iife"],
    },
    outDir: "../extensions/gang-sheet-editor/assets",
    emptyOutDir: false,
    // public/ holds local-preview test files (customer logos among them);
    // they must never ship with the storefront extension.
    copyPublicDir: false,
    rollupOptions: {
      // Don't externalize React — bundle it (storefront doesn't have React)
      output: {
        // Single file output
        inlineDynamicImports: true,
        assetFileNames: "editor.[ext]",
      },
    },
  },
});
