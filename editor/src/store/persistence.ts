import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { EditorImage, EditorState } from "./editorStore";
import { getEditTargets } from "../services/cart";

/**
 * Where the builder keeps a customer's sheets between visits.
 *
 * It used to be sessionStorage, which goes with the tab. On 2026-11-04 a
 * customer uploaded 98 files over 107 minutes and closed the tab; four days
 * later they uploaded 77 of them again before ordering #1190. Now it is
 * localStorage, in three places:
 *
 *  - the draft: what the builder opens with.
 *  - the cart copies: every sheet as it was put in the cart, by the gang
 *    sheet ids on its cart lines. "Redigera arket" in the cart opens the
 *    builder with ?edit=<id>, and that copy is what it shows. A sheet in the
 *    cart is no longer the draft: a later visit starts clean, so a second
 *    "Lägg i varukorg" cannot re-save or replace the sheet in the cart.
 *  - the edit: changes made after "Redigera arket", until they go back in
 *    the cart. Apart from the draft, so editing a cart line never costs the
 *    customer the sheet they were building.
 *
 * Everything expires after 30 days without a change. Each value carries
 * STATE_VERSION; a value from another version of the builder is left out,
 * never half read, and what is read is checked before the editor gets it.
 */

/**
 * Bump when a change to EditorImage, SheetEntry or the persisted fields
 * would break the editor on an older value. Prefer optional fields: a bump
 * throws away every customer's work in progress.
 */
export const STATE_VERSION = 1;

const DRAFT_KEY = "gangsheet-editor-state";
const EDIT_KEY = "gangsheet-editor-edit";
const CART_KEY = "gangsheet-editor-cart";
/** The draft before 2026-11, in sessionStorage. Taken over once, then removed. */
const LEGACY_SESSION_KEY = "gangsheet-editor-state";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Cart copies kept: enough for one cart, small enough for the quota. */
const MAX_CART_COPIES = 5;

/** The part of the editor that is saved: the sheets and how they are set up. */
export type PersistedState = Pick<
  EditorState,
  | "sessionId"
  | "gangSheetId"
  | "sheetSize"
  | "filmType"
  | "images"
  | "sheets"
  | "activeSheetIndex"
  | "gapMm"
  | "canvasBg"
>;

export function persistedPart(state: EditorState): PersistedState {
  return {
    sessionId: state.sessionId,
    gangSheetId: state.gangSheetId,
    sheetSize: state.sheetSize,
    filmType: state.filmType,
    images: state.images,
    sheets: state.sheets,
    activeSheetIndex: state.activeSheetIndex,
    gapMm: state.gapMm,
    canvasBg: state.canvasBg,
  };
}

interface Packed {
  state: PersistedState;
  /** data: URLs, each once; images point at them with BLOB_REF + index. */
  blobs?: string[];
}

interface Saved {
  v: number;
  savedAt: number;
  /** Edit and cart copies: the gang sheet ids of the cart lines. */
  ids?: string[];
  p: Packed;
}

type Mode = { slot: "draft" } | { slot: "edit"; ids: string[] };

/** Decided on the first read, from ?edit= on the page. */
let mode: Mode | null = null;
/** The last value this tab wrote or read in its slot, to skip same writes. */
let lastBody: string | null = null;
let warned = false;

const keyOf = (m: Mode) => (m.slot === "edit" ? EDIT_KEY : DRAFT_KEY);

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked cookies or a sandboxed frame
  }
}

function readSaved(key: string): Saved | null {
  try {
    const raw = local()?.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    return current(saved) ? saved : null;
  } catch {
    return null;
  }
}

function current(saved: Saved | null | undefined): saved is Saved {
  return (
    !!saved &&
    saved.v === STATE_VERSION &&
    typeof saved.savedAt === "number" &&
    Date.now() - saved.savedAt < MAX_AGE_MS &&
    !!saved.p &&
    usable(unpack(saved.p))
  );
}

function remove(key: string) {
  try {
    local()?.removeItem(key);
  } catch {
    // nothing to do
  }
}

/** Write, making room by dropping cart copies when the storage is full. */
function write(key: string, raw: string, keepIds: string[] = []): boolean {
  const ls = local();
  if (!ls) return false;
  try {
    ls.setItem(key, raw);
    return true;
  } catch {
    // Full: the cart copies go first, never the customer's draft or edit.
  }
  try {
    if (key !== CART_KEY) {
      const keep = cartCopies().filter((c) => overlaps(c.ids, keepIds));
      if (keep.length > 0) ls.setItem(CART_KEY, JSON.stringify({ v: STATE_VERSION, copies: keep }));
      else ls.removeItem(CART_KEY);
    }
    ls.setItem(key, raw);
    return true;
  } catch (error) {
    if (!warned) console.warn("Gang sheet editor: could not save the sheet in this browser:", error);
    warned = true;
    return false;
  }
}

const overlaps = (a: string[] | undefined, b: string[]) => !!a && a.some((id) => b.includes(id));

/* ───────────── Images: small and still loading next time ───────────── */

const BLOB_REF = "gs-blob:";
/**
 * The upload route stores a design under uploads/<session>/<image>/ as
 * original.<ext> (or converted.png) next to thumbnail.webp, and serves both
 * through the app proxy for good. Its answer carries the thumbnail as a
 * data: URL of up to 800 px, which the editor keeps on every copy: 300
 * copies of one logo were megabytes, past what a browser lets a page keep.
 * Saved, a thumbnail is the address of that same file instead.
 */
const SERVER_ORIGINAL = /^(.*\/api\/image\/uploads\/[^/?#]+\/[^/?#]+\/)(?:original|converted)\.[a-z0-9]+$/i;

export function serverThumbnail(originalUrl: string | undefined): string | null {
  const match = originalUrl ? SERVER_ORIGINAL.exec(originalUrl) : null;
  return match ? `${match[1]}thumbnail.webp` : null;
}

const isLocalUrl = (url: unknown): url is string =>
  typeof url === "string" && (url.startsWith("data:") || url.startsWith("blob:"));

function pack(state: PersistedState): Packed {
  const blobs: string[] = [];
  const index = new Map<string, number>();
  const intern = (url: string) => {
    let i = index.get(url);
    if (i === undefined) {
      i = blobs.length;
      blobs.push(url);
      index.set(url, i);
    }
    return BLOB_REF + i;
  };
  const packUrl = (url: string | undefined) => (url && url.startsWith("data:") ? intern(url) : url);
  const packImage = (img: EditorImage): EditorImage => {
    // A blob: URL is gone with the page; the server's thumbnail is not.
    const thumbnailUrl = isLocalUrl(img.thumbnailUrl)
      ? (serverThumbnail(img.originalUrl) ?? img.thumbnailUrl)
      : img.thumbnailUrl;
    return {
      ...img,
      thumbnailUrl: packUrl(thumbnailUrl)!,
      originalUrl: packUrl(img.originalUrl)!,
      ...(img.bgRemovedUrl ? { bgRemovedUrl: packUrl(img.bgRemovedUrl) } : {}),
    };
  };
  return {
    state: {
      ...state,
      images: state.images.map(packImage),
      sheets: state.sheets.map((sheet) => ({ ...sheet, savedImages: (sheet.savedImages ?? []).map(packImage) })),
    },
    ...(blobs.length > 0 ? { blobs } : {}),
  };
}

function unpack(packed: Packed): PersistedState {
  const blobs = packed.blobs ?? [];
  const url = (value: unknown) =>
    typeof value === "string" && value.startsWith(BLOB_REF) ? blobs[Number(value.slice(BLOB_REF.length))] : value;
  const unpackImage = (img: any) =>
    img && typeof img === "object"
      ? {
          ...img,
          thumbnailUrl: url(img.thumbnailUrl),
          originalUrl: url(img.originalUrl),
          ...(img.bgRemovedUrl ? { bgRemovedUrl: url(img.bgRemovedUrl) } : {}),
        }
      : img;
  const state = packed.state as any;
  if (!state || typeof state !== "object") return state;
  return {
    ...state,
    images: Array.isArray(state.images) ? state.images.map(unpackImage) : state.images,
    sheets: Array.isArray(state.sheets)
      ? state.sheets.map((sheet: any) =>
          sheet && typeof sheet === "object" && Array.isArray(sheet.savedImages)
            ? { ...sheet, savedImages: sheet.savedImages.map(unpackImage) }
            : sheet,
        )
      : state.sheets,
  };
}

/* ───────────── Checks: what the editor gets must be whole ───────────── */

const NUMBERS = ["positionX", "positionY", "displayWidth", "displayHeight", "widthPx", "heightPx"] as const;

function isImage(img: any): boolean {
  return (
    !!img &&
    typeof img.id === "string" &&
    typeof img.thumbnailUrl === "string" &&
    typeof img.originalUrl === "string" &&
    NUMBERS.every((k) => Number.isFinite(img[k]))
  );
}

function isSize(size: any): boolean {
  return (
    !!size &&
    typeof size.key === "string" &&
    typeof size.label === "string" &&
    Number.isFinite(size.widthMm) &&
    Number.isFinite(size.heightMm)
  );
}

function usable(state: any): state is PersistedState {
  return (
    !!state &&
    typeof state.sessionId === "string" &&
    isSize(state.sheetSize) &&
    typeof state.filmType === "string" &&
    Array.isArray(state.images) &&
    state.images.every(isImage) &&
    Array.isArray(state.sheets) &&
    state.sheets.length > 0 &&
    state.sheets.every(
      (sheet: any) =>
        !!sheet &&
        typeof sheet.id === "string" &&
        Array.isArray(sheet.savedImages) &&
        sheet.savedImages.every(isImage) &&
        (sheet.sheetSize === undefined || isSize(sheet.sheetSize)),
    ) &&
    Number.isInteger(state.activeSheetIndex) &&
    state.activeSheetIndex >= 0 &&
    state.activeSheetIndex < state.sheets.length
  );
}

/** Designs anywhere: on the sheet on screen, or saved on another. */
function hasDesigns(state: PersistedState): boolean {
  return (
    state.images.length > 0 ||
    state.sheets.some((sheet, i) => i !== state.activeSheetIndex && (sheet.savedImages?.length ?? 0) > 0)
  );
}

/* ───────────── Cart copies ───────────── */

function cartCopies(): Saved[] {
  try {
    const raw = local()?.getItem(CART_KEY);
    if (!raw) return [];
    const file = JSON.parse(raw) as { v?: number; copies?: Saved[] };
    if (file?.v !== STATE_VERSION || !Array.isArray(file.copies)) return [];
    return file.copies.filter((copy) => Array.isArray(copy?.ids) && copy.ids.length > 0 && current(copy));
  } catch {
    return [];
  }
}

function writeCart(copies: Saved[]) {
  if (copies.length === 0) {
    remove(CART_KEY);
    return;
  }
  // The oldest go first until it fits; the newest is last.
  for (let n = copies.length; n > 0; n--) {
    try {
      local()?.setItem(CART_KEY, JSON.stringify({ v: STATE_VERSION, copies: copies.slice(copies.length - n) }));
      return;
    } catch {
      // too big, try with one fewer
    }
  }
  remove(CART_KEY);
}

/* ───────────── Opening ───────────── */

/** The draft a tab from before 2026-11 left in sessionStorage, if any. */
function adoptLegacy(): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
    const old = JSON.parse(raw) as { state?: any };
    const state = old?.state;
    if (!usable(state) || !hasDesigns(state)) return null;
    const saved: Saved = { v: STATE_VERSION, savedAt: Date.now(), p: pack(persistedFields(state)) };
    if (!current(saved)) return null;
    // Stored now: the old copy is gone, and a reload must not lose it.
    write(DRAFT_KEY, JSON.stringify(saved));
    return saved;
  } catch {
    return null;
  }
}

/** Only the saved fields of an old, whole state (it kept prices, flags, zoom). */
function persistedFields(state: any): PersistedState {
  return {
    sessionId: state.sessionId,
    gangSheetId: state.gangSheetId ?? null,
    sheetSize: state.sheetSize,
    filmType: state.filmType,
    images: state.images,
    sheets: state.sheets,
    activeSheetIndex: state.activeSheetIndex,
    gapMm: state.gapMm,
    canvasBg: state.canvasBg,
  };
}

function open(): { mode: Mode; saved: Saved | null } {
  const targets = getEditTargets();
  if (targets.length > 0) {
    // Back to an edit that did not reach the cart yet, else the copy in the cart.
    const edit = readSaved(EDIT_KEY);
    if (edit && overlaps(edit.ids, targets)) return { mode: { slot: "edit", ids: edit.ids! }, saved: edit };
    const copy = cartCopies().find((c) => overlaps(c.ids, targets));
    if (copy) return { mode: { slot: "edit", ids: copy.ids! }, saved: copy };
    // No copy here (another browser, or cleared): build anew, as before;
    // the cart line is still replaced on "Lägg i varukorg".
  }
  return { mode: { slot: "draft" }, saved: readSaved(DRAFT_KEY) ?? adoptLegacy() };
}

function read(): Saved | null {
  if (!mode) {
    const opened = open();
    mode = opened.mode;
    return opened.saved;
  }
  const saved = readSaved(keyOf(mode));
  if (saved && mode.slot === "edit" && !overlaps(saved.ids, mode.ids)) return null;
  return saved;
}

export const editorStorage: PersistStorage<PersistedState> = {
  getItem: () => {
    const saved = read();
    if (!saved) {
      lastBody = null;
      return null;
    }
    lastBody = JSON.stringify(saved.p);
    return { state: unpack(saved.p), version: STATE_VERSION };
  },

  setItem: (_name, value: StorageValue<PersistedState>) => {
    if (!mode) mode = open().mode;
    const key = keyOf(mode);
    const state = value.state;
    if (!usable(state) || !hasDesigns(state)) {
      // Nothing on any sheet ("Rensa", or every design deleted): nothing to
      // come back to. An empty edit falls back to the copy in the cart.
      if (lastBody !== null) remove(key);
      lastBody = null;
      return;
    }
    const body = JSON.stringify(pack(state));
    if (body === lastBody) return;
    const ids = mode.slot === "edit" ? mode.ids : undefined;
    const raw = `{"v":${STATE_VERSION},"savedAt":${Date.now()}${ids ? `,"ids":${JSON.stringify(ids)}` : ""},"p":${body}}`;
    if (write(key, raw, ids)) lastBody = body;
  },

  removeItem: () => {
    if (mode) remove(keyOf(mode));
    lastBody = null;
  },
};

/* ───────────── After "Lägg i varukorg" ───────────── */

/**
 * The sheets went in the cart as lines `lineIds` (their gang sheet ids),
 * replacing the lines of `replacedIds`. Keep them as a cart copy for
 * "Redigera arket", and take them out of the draft or the edit.
 *
 * Returns the state the builder should show now: the draft left waiting
 * when this was an edit, or null to start clean.
 */
export function moveToCart(state: PersistedState, lineIds: string[], replacedIds: string[]): PersistedState | null {
  const ids = [...new Set(lineIds.filter(Boolean))];
  const gone = [...ids, ...replacedIds.filter(Boolean)];
  const copies = cartCopies().filter((copy) => !overlaps(copy.ids, gone));
  if (ids.length > 0 && usable(state)) {
    copies.push({ v: STATE_VERSION, savedAt: Date.now(), ids, p: pack(state) });
  }
  writeCart(copies.slice(-MAX_CART_COPIES));

  remove(keyOf(mode ?? { slot: "draft" }));
  mode = { slot: "draft" };
  const draft = readSaved(DRAFT_KEY);
  lastBody = draft ? JSON.stringify(draft.p) : null;
  return draft ? unpack(draft.p) : null;
}

/**
 * The cart lines this visit is editing (opened from "Redigera arket" with a
 * copy of the sheet), or an empty list for a draft.
 */
export function editingCartLines(): string[] {
  return mode?.slot === "edit" ? [...mode.ids] : [];
}

/**
 * Keep tabs of the builder in step: a change in one shows in the others,
 * and a sheet put in the cart (or cleared) in one is gone from the others,
 * so two tabs never save different sheets under one gang sheet id.
 */
export function followOtherTabs(apply: (state: PersistedState | null) => void) {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (!mode || event.storageArea !== local()) return;
    const key = keyOf(mode);
    if (event.key === null) {
      // Everything cleared, by the site or the customer: this tab still has
      // the sheet, and its next change saves it again.
      lastBody = null;
      return;
    }
    if (event.key !== key) return;
    const saved = event.newValue === null ? null : readSaved(key);
    // Unreadable (another version of the builder) or another line's edit: not ours to show.
    if (event.newValue !== null && !saved) return;
    if (saved && mode.slot === "edit" && !overlaps(saved.ids, mode.ids)) return;
    const body = saved ? JSON.stringify(saved.p) : null;
    if (body === lastBody) return;
    lastBody = body;
    apply(saved ? unpack(saved.p) : null);
  });
}
