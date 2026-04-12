import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
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
