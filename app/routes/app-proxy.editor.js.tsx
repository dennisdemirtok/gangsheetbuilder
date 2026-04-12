import type { LoaderFunctionArgs } from "@remix-run/node";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Serve the compiled canvas editor JS bundle via app proxy.
 * URL: /apps/gangsheet/editor.js
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    // Try to load the built editor bundle
    const editorPath = resolve(
      process.cwd(),
      "extensions/gang-sheet-editor/assets/editor.iife.js",
    );
    const editorJs = readFileSync(editorPath, "utf-8");

    return new Response(editorJs, {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Failed to load editor bundle:", error);

    // Return a minimal script that shows an error message
    const fallback = `
      (function() {
        var root = document.getElementById('gangsheet-editor-root');
        if (root) {
          root.innerHTML = '<div style="padding: 40px; text-align: center; color: #dc2626;">' +
            '<p style="font-size: 18px; font-weight: bold;">Gang Sheet Builder</p>' +
            '<p>Editorn kunde inte laddas. Försök ladda om sidan.</p>' +
            '</div>';
        }
      })();
    `;

    return new Response(fallback, {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-cache",
      },
    });
  }
};
