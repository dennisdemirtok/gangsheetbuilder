/**
 * Fonts for the text tool.
 *
 * The old list named fonts the page never loaded — Bebas Neue, Montserrat,
 * Lobster and the rest all drew in the browser's fallback, so the text a
 * customer picked was not the text that printed. These ship with the editor
 * on Shopify's CDN and are loaded before anything is drawn. One face each,
 * Latin with åäö, all free for commercial use: SIL OFL 1.1 or Apache 2.0,
 * from Google Fonts via Fontsource.
 *
 * Theme app extensions only take .js/.json/.css/images/.wasm as assets, so
 * each font is font-<id>.json next to editor.iife.js:
 * { family, copyright, license, woff2: <base64 of the .woff2 file> }.
 */

export type FontCategory = "bold" | "sport" | "script" | "fun" | "retro";

export const FONT_CATEGORIES: { id: FontCategory; label: string }[] = [
  { id: "bold", label: "Kraftiga" },
  { id: "sport", label: "Sport" },
  { id: "script", label: "Skrivstil" },
  { id: "fun", label: "Lekfulla" },
  { id: "retro", label: "Retro" },
];

export interface TextFont {
  /** File is font-<id>.woff2. */
  id: string;
  name: string;
  category: FontCategory;
  /** Baseline to baseline for text on several lines, in em. */
  lineHeight?: number;
}

export const TEXT_FONTS: TextFont[] = [
  { id: "anton", name: "Anton", category: "bold" },
  { id: "bebas-neue", name: "Bebas Neue", category: "bold", lineHeight: 1.05 },
  { id: "archivo-black", name: "Archivo Black", category: "bold" },
  { id: "montserrat", name: "Montserrat", category: "bold" },
  { id: "poppins", name: "Poppins", category: "bold" },
  { id: "oswald", name: "Oswald", category: "bold" },
  { id: "alfa-slab-one", name: "Alfa Slab", category: "bold" },
  { id: "graduate", name: "Graduate", category: "sport" },
  { id: "teko", name: "Teko", category: "sport", lineHeight: 1.0 },
  { id: "racing-sans-one", name: "Racing Sans", category: "sport" },
  { id: "black-ops-one", name: "Black Ops", category: "sport" },
  { id: "bungee", name: "Bungee", category: "sport" },
  { id: "staatliches", name: "Staatliches", category: "sport", lineHeight: 1.05 },
  { id: "damion", name: "Damion", category: "script", lineHeight: 1.3 },
  { id: "pacifico", name: "Pacifico", category: "script", lineHeight: 1.45 },
  { id: "lobster", name: "Lobster", category: "script", lineHeight: 1.25 },
  { id: "dancing-script", name: "Dancing Script", category: "script", lineHeight: 1.25 },
  { id: "great-vibes", name: "Great Vibes", category: "script", lineHeight: 1.3 },
  { id: "kaushan-script", name: "Kaushan", category: "script", lineHeight: 1.3 },
  { id: "satisfy", name: "Satisfy", category: "script", lineHeight: 1.3 },
  { id: "permanent-marker", name: "Marker", category: "script", lineHeight: 1.25 },
  { id: "bangers", name: "Bangers", category: "fun" },
  { id: "luckiest-guy", name: "Luckiest Guy", category: "fun" },
  { id: "fredoka", name: "Fredoka", category: "fun" },
  { id: "chewy", name: "Chewy", category: "fun", lineHeight: 1.2 },
  { id: "press-start-2p", name: "Press Start", category: "fun", lineHeight: 1.4 },
  { id: "creepster", name: "Creepster", category: "fun", lineHeight: 1.2 },
  { id: "abril-fatface", name: "Abril Fatface", category: "retro" },
  { id: "playfair-display", name: "Playfair", category: "retro" },
  { id: "righteous", name: "Righteous", category: "retro" },
  { id: "shrikhand", name: "Shrikhand", category: "retro", lineHeight: 1.3 },
  { id: "rye", name: "Rye", category: "retro", lineHeight: 1.2 },
  { id: "pirata-one", name: "Pirata One", category: "retro" },
  { id: "unifrakturmaguntia", name: "Fraktur", category: "retro" },
];

export const DEFAULT_FONT_ID = "anton";

export function fontById(id: string): TextFont {
  return TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0]!;
}

/** Family name as registered — prefixed so a theme's own Montserrat can't stand in. */
export function fontFamily(font: TextFont): string {
  return `gs-${font.id}`;
}

/**
 * The editor bundle's own URL, read while it runs: document.currentScript
 * is gone afterwards. The fonts sit next to it. The local preview (no
 * bundle) gets them from /ext-assets/, see vite.config.ts.
 */
const BUNDLE_URL: string | null = (() => {
  if (typeof document === "undefined") return null;
  const current = document.currentScript as HTMLScriptElement | null;
  if (current?.src) return current.src;
  return document.querySelector<HTMLScriptElement>('script[src*="editor.iife.js"]')?.src ?? null;
})();

function fontUrl(font: TextFont): string {
  const file = `font-${font.id}.json`;
  return BUNDLE_URL ? new URL(file, BUNDLE_URL).href : `/ext-assets/${file}`;
}

async function fetchFontData(font: TextFont): Promise<ArrayBuffer> {
  const res = await fetch(fontUrl(font));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { woff2 } = (await res.json()) as { woff2: string };
  const raw = atob(woff2);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

const loads = new Map<string, Promise<boolean>>();

/** Load a font once. True when it is ready to draw with. */
export function loadFont(font: TextFont): Promise<boolean> {
  let pending = loads.get(font.id);
  if (!pending) {
    pending = fetchFontData(font)
      .then((data) => new FontFace(fontFamily(font), data).load())
      .then(
        (loaded) => {
          document.fonts.add(loaded);
          return true;
        },
        (err) => {
          console.warn("[GS] Font failed to load:", font.id, err);
          // Let the next attempt try again rather than remember the failure.
          loads.delete(font.id);
          return false;
        },
      );
    loads.set(font.id, pending);
  }
  return pending;
}
