import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  DEFAULT_GAP_MM,
  EDGE_MARGIN_MM,
  freeCapacityFor,
  findFreeSpot,
  imageBbox,
  isOutsidePrintable,
  isRealOverlap,
  nearestFreeSpot,
  packAll,
  placeGroup,
  rectsOverlap,
  type Rect,
} from "../utils/layout";
import { MAX_SHEET_MM, sheetForHeight, sheetLabel } from "../config/sheets";
import { showToast } from "../utils/toast";
import { packSheet, type Placement } from "../utils/packing";
import { getSheetPrice, hasStorefrontPrices } from "../services/storefrontPrices";
import type { TextDesign } from "../utils/textRender";


export interface EditorImage {
  id: string;
  dbId?: string;
  /**
   * Copies of the same uploaded design share a groupId. The design list
   * shows one row per group, so filling a sheet with 45 logos stays one
   * entry instead of 45. Older persisted state has no groupId — treat
   * such an image as its own group via `groupKey`.
   */
  groupId?: string;
  filename: string;
  thumbnailUrl: string;
  originalUrl: string;
  widthPx: number;
  heightPx: number;
  dpiX: number;
  dpiY: number;
  positionX: number; // mm on sheet
  positionY: number;
  displayWidth: number; // mm
  displayHeight: number;
  rotation: number; // 0, 90, 180, 270
  flipX: boolean;
  flipY: boolean;
  quantity: number;
  marginMm: number; // margin around image
  bgRemoved: boolean;
  bgRemovedUrl?: string;
  hasWhiteBackground?: boolean;
  placed: boolean;
  locked?: boolean; // aspect ratio lock
  /** Made with the text tool: what it says and how, so it can be edited. */
  text?: TextDesign;
}

export interface SheetSize {
  key: string;
  widthMm: number;
  heightMm: number;
  label: string;
}

export interface SheetEntry {
  id: string;
  name: string;
  gangSheetId: string | null;
  imageCount: number;
  size: string;
  quantity: number;
  savedImages: EditorImage[]; // images stored when switching away
  sheetSize?: SheetSize; // per-sheet size (optional for old persisted state)
  filmType?: string; // per-sheet film type
}

export interface EditorState {
  sessionId: string;
  gangSheetId: string | null;
  sheetSize: SheetSize;
  filmType: string;
  images: EditorImage[];
  prices: Record<string, Record<string, number>>;
  selectedImageId: string | null;
  isUploading: boolean;
  isAutoBuilding: boolean;
  isSaving: boolean;
  zoom: number;
  showDpiOverlay: boolean;
  /** Gap between neighbouring designs (mm) — one setting for the whole sheet. */
  gapMm: number;
  /**
   * Outcome of the last arrange. Cleared by any edit, so the sidebar can't
   * keep claiming "1 placerade" after the sheet has been filled with 312.
   * Utilization is deliberately absent — SheetInsight already shows it.
   */
  lastArrange: { placed: number; overflow: number; grewTo?: string } | null;

  // Multi-sheet
  sheets: SheetEntry[];
  activeSheetIndex: number;

  // Actions
  setSheetSize: (size: SheetSize) => void;
  setFilmType: (type: string) => void;
  setGapMm: (mm: number) => void;
  addImage: (image: EditorImage) => void;
  removeImage: (id: string) => void;
  removeGroup: (groupId: string) => void;
  updateImage: (id: string, updates: Partial<EditorImage>) => void;
  /** Apply updates to every copy in a group, then re-tile it. */
  updateGroup: (groupId: string, updates: Partial<EditorImage>) => void;
  /**
   * Grow or shrink a group, laid out collision-free. Fewer copies than
   * asked for means the sheet ran out of room; `lastFillShortfall` says
   * how many did not fit so the UI can say so.
   */
  setGroupCount: (groupId: string, count: number) => void;
  /** Copies that did not fit on the last count change, or null. */
  lastFillShortfall: { filename: string; missing: number } | null;
  clearFillShortfall: () => void;
  /** Fill every free cell on the sheet with copies of this group. */
  autoFillGroup: (groupId: string) => void;
  /** Re-pack everything on the sheet locally, tallest first. */
  arrangeAll: (options?: { from?: SheetSize }) => void;
  /**
   * The single "tidy up my sheet" action every button calls. Uses the
   * server's nesting (better packing = less film) and falls back to the
   * local packer when the backend is unreachable.
   */
  arrangeSheet: () => Promise<void>;
  /**
   * Put many new designs on the sheet in one go — the guide. Each entry is
   * one design and how many copies. With `keepExisting`, what is already on
   * the sheet stays where it is and the new copies are nested around it;
   * otherwise everything is nested together. The sheet ends up as short as
   * possible but never shorter than `floor`. Copies that fit nowhere, not
   * even on the longest sheet, are left out and counted.
   */
  addDesigns: (
    entries: { image: EditorImage; count: number }[],
    options: { floor: SheetSize; keepExisting: boolean },
  ) => { overflow: number; turned: number; size: SheetSize };
  duplicateImage: (id: string) => void;
  resizeImage: (id: string, widthMm: number, heightMm: number, keepRatio: boolean) => void;
  /**
   * Move a design to a free spot when it now sits on another design or off
   * the film — after it was made bigger or rotated. Grows the sheet if the
   * free spot is only on a longer one.
   */
  keepClear: (id: string) => void;
  /**
   * New artwork for every copy of a design — an edited text. Copies keep
   * their place; any that now reach a neighbour move somewhere free.
   */
  replaceArtwork: (groupId: string, patch: Partial<EditorImage>) => void;
  /** Put the designs and sheet length back as they were — undo and redo. */
  restoreSnapshot: (images: EditorImage[], sheetSize: SheetSize) => void;
  /**
   * After a drag: a design dropped on another (more than a corner) or off
   * the film moves to the nearest free spot, or back where it came from.
   * Finding out at checkout was too late; this is where it happens.
   */
  settleAfterMove: (id: string, from: { x: number; y: number }) => void;
  /** Colour behind the sheet: "checks" or a garment colour (#hex). */
  canvasBg: string;
  setCanvasBg: (bg: string) => void;
  selectImage: (id: string | null) => void;
  setUploading: (val: boolean) => void;
  setAutoBuilding: (val: boolean) => void;
  setSaving: (val: boolean) => void;
  setZoom: (zoom: number) => void;
  setShowDpiOverlay: (val: boolean) => void;
  setPrices: (prices: Record<string, Record<string, number>>) => void;
  setGangSheetId: (id: string) => void;
  setSheetGangSheetId: (index: number, id: string) => void;
  applyAutoBuild: (placements: any[]) => void;
  addSheet: () => void;
  removeSheet: (index: number) => void;
  switchSheet: (index: number) => void;
  duplicateSheet: (index: number) => void;
  setSheetQuantity: (index: number, qty: number) => void;
  reset: () => void;
}

const DEFAULT_SHEET: SheetSize = {
  key: "58x100",
  widthMm: 580,
  heightMm: 1000,
  label: sheetLabel(1000),
};

function generateSessionId(): string {
  return "gs_" + Math.random().toString(36).substring(2, 15);
}

function generateImageId(): string {
  return "img_" + Math.random().toString(36).substring(2, 10);
}

/**
 * The group an image belongs to.
 *
 * `dbId` comes first on purpose: copies sharing a database row MUST stay
 * one group. The save route writes one row per dbId, so two groups on the
 * same row would collapse at export — every copy printed at whichever
 * size happened to be serialized first, at spacing meant for the other.
 * Uploading the same file twice yields two rows, which is how a customer
 * gets one artwork in two sizes.
 */
export function groupKey(img: EditorImage): string {
  return img.dbId ?? img.groupId ?? img.id;
}

export interface ImageGroup {
  groupId: string;
  /** The copy that carries the group's settings and canvas selection. */
  master: EditorImage;
  members: EditorImage[];
  count: number;
}

/** Collapse the flat image list into one entry per uploaded design. */
export function groupImages(images: EditorImage[]): ImageGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, EditorImage[]>();
  for (const img of images) {
    const key = groupKey(img);
    if (!byGroup.has(key)) {
      byGroup.set(key, []);
      order.push(key);
    }
    byGroup.get(key)!.push(img);
  }
  return order.map((key) => {
    const members = byGroup.get(key)!;
    return { groupId: key, master: members[0]!, members, count: members.length };
  });
}

/** The active sheet set to `size`, in the top-level state and its entry. */
function withSheetSize(
  state: Pick<EditorState, "sheets" | "activeSheetIndex">,
  size: SheetSize,
): Pick<EditorState, "sheetSize" | "sheets"> {
  return {
    sheetSize: size,
    sheets: state.sheets.map((s, i) =>
      i === state.activeSheetIndex ? { ...s, size: size.label, sheetSize: size } : s,
    ),
  };
}

/**
 * The first free spot for a w×h design, on a longer sheet if the current
 * one is full. Null only when even the longest sheet has no room.
 */
function freeSpotGrowing(
  w: number,
  h: number,
  start: SheetSize,
  gap: number,
  blockers: Rect[],
): { size: SheetSize; spot: { x: number; y: number } | null } {
  const spot = findFreeSpot(w, h, start, gap, blockers);
  if (spot) return { size: start, spot };
  // No room: below everything there is, on a sheet just long enough —
  // then the best free spot on that sheet (it may be higher up).
  const bottom = blockers.reduce((max, b) => Math.max(max, b.y + b.h + gap), EDGE_MARGIN_MM);
  const needed = bottom + h + EDGE_MARGIN_MM;
  if (needed > MAX_SHEET_MM) return { size: start, spot: null };
  const size = sheetForHeight(Math.max(start.heightMm, needed));
  return { size, spot: findFreeSpot(w, h, size, gap, blockers) ?? { x: EDGE_MARGIN_MM, y: bottom } };
}

/** A design turned a quarter, never upside down relative to `deg`. */
function quarterTurn(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r % 180 === 0 ? (r + 90) % 360 : (r + 270) % 360;
}

const toItem = (img: EditorImage) => {
  const b = imageBbox(img);
  return { id: img.id, w: b.w, h: b.h };
};

/**
 * Nest designs, moving to a longer sheet until nothing is left over —
 * starting from `start`, which may be shorter than the sheet in use (the
 * guide picks the length itself). `obstacles` stay where they are.
 *
 * Packing on a fixed sheet used to leave whatever did not fit where it was,
 * on top of the designs packed around it. That is how #1024 reached the
 * print shop with 2 m of logos piled onto 1 m of film.
 */
function packGrowing(
  images: EditorImage[],
  start: SheetSize,
  gap: number,
  obstacles: Rect[] = [],
): { size: SheetSize; placements: Map<string, Placement>; overflow: string[] } {
  const items = images.map(toItem);
  const first = packSheet(items, start, gap, obstacles);
  if (first.overflow.length === 0) {
    return { size: start, placements: first.placements, overflow: [] };
  }
  // Too long for `start`: nest on the longest sheet, then cut the film to
  // the decimetre the designs need.
  const tall = packSheet(items, sheetForHeight(MAX_SHEET_MM), gap, obstacles);
  const size = sheetForHeight(Math.max(start.heightMm, tall.bottomMm + EDGE_MARGIN_MM));
  return { size, placements: tall.placements, overflow: tall.overflow };
}

/** Move (and where the packer says so, turn) every design it placed. */
function applyPlacements(
  images: EditorImage[],
  placements: Map<string, Placement>,
): { images: EditorImage[]; turned: number } {
  let turned = 0;
  const next = images.map((img) => {
    const p = placements.get(img.id);
    if (!p) return img;
    if (p.rotated) turned++;
    return {
      ...img,
      positionX: p.x,
      positionY: p.y,
      rotation: p.rotated ? quarterTurn(img.rotation) : img.rotation,
      placed: true,
    };
  });
  return { images: next, turned };
}

const shortLabel = (size: SheetSize) => size.label.replace(/ \(.*\)$/, "");

/** One message for what an arrange did to the sheet. */
function arrangeMessage(before: SheetSize, after: SheetSize, turned: number): string | null {
  const parts: string[] = [];
  if (after.heightMm > before.heightMm) parts.push(`Arket blev ${shortLabel(after)} så att allt får plats.`);
  else if (after.heightMm < before.heightMm) parts.push(`Allt fick plats på ${shortLabel(after)}.`);
  if (turned > 0) {
    parts.push(
      `${turned === 1 ? "Ett motiv" : `${turned} motiv`} vändes 90° för att spara film — de trycks likadant.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}

const grewMessage = (size: SheetSize, what = "allt") =>
  `Arket blev ${size.label.replace(/ \(.*\)$/, "")} så att ${what} får plats.`;

/** Bounding boxes of every placed image except those in `exceptGroup`. */
function blockersExcept(
  images: EditorImage[],
  exceptGroup: string | null,
): Rect[] {
  return images
    .filter((img) => img.placed && (!exceptGroup || groupKey(img) !== exceptGroup))
    .map(imageBbox);
}

/**
 * Price for a single sheet entry (kr) — null if the price table
 * has no entry for the sheet's size/film combination.
 */
export function getSheetUnitPrice(
  prices: Record<string, Record<string, number>>,
  sheet: SheetEntry,
  fallbackSize: SheetSize,
  fallbackFilmType: string,
): number | null {
  const sizeKey = sheet.sheetSize?.key ?? fallbackSize.key;
  const film = sheet.filmType ?? fallbackFilmType;

  // What Shopify will actually charge, straight from the theme. Only the
  // standard film reads from it — the specialty films are modifiers the
  // app still owns, and quoting a plain-film price for glitter would be
  // worse than falling back.
  if (film === "standard") {
    const storefront = getSheetPrice(sizeKey);
    if (storefront !== null) return storefront;
  }

  const price = prices?.[sizeKey]?.[film];
  return typeof price === "number" ? price : null;
}

/** True when prices come from Shopify rather than the app's own table. */
export { hasStorefrontPrices };

/**
 * Total price across all sheets (each sheet's own size/film × quantity).
 * Returns null if any sheet's price is missing or prices haven't loaded.
 */
export function getSheetsTotalPrice(
  sheets: SheetEntry[],
  prices: Record<string, Record<string, number>>,
  fallbackSize: SheetSize,
  fallbackFilmType: string,
  activeSheetIndex?: number,
  activeImageCount?: number,
): number | null {
  if (!sheets || sheets.length === 0) return null;
  let total = 0;
  let pricedSheets = 0;
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    // Empty sheets are never added to the cart, so exclude them from the total
    const imageCount =
      activeSheetIndex !== undefined && i === activeSheetIndex
        ? (activeImageCount ?? 0)
        : sheet.savedImages.length;
    if (activeSheetIndex !== undefined && imageCount === 0) continue;
    const unit = getSheetUnitPrice(prices, sheet, fallbackSize, fallbackFilmType);
    if (unit === null) return null;
    total += unit * Math.max(1, sheet.quantity || 1);
    pricedSheets++;
  }
  return pricedSheets > 0 ? total : null;
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
      sessionId: generateSessionId(),
      gangSheetId: null,
      sheetSize: DEFAULT_SHEET,
      filmType: "standard",
      images: [],
      sheets: [{ id: "sheet_1", name: "Ark 1", gangSheetId: null, imageCount: 0, size: "58 × 100 cm", quantity: 1, savedImages: [], sheetSize: DEFAULT_SHEET, filmType: "standard" }],
      activeSheetIndex: 0,
      prices: {},
      selectedImageId: null,
      isUploading: false,
      isAutoBuilding: false,
      isSaving: false,
      zoom: 1,
      showDpiOverlay: false,
      gapMm: DEFAULT_GAP_MM,
      lastArrange: null,
      lastFillShortfall: null,
      canvasBg: "checks",

      setCanvasBg: (bg) => set({ canvasBg: bg }),

      setSheetSize: (size) => {
        const state = get();
        const placed = state.images.filter((img) => img.placed);
        const shrinking = size.heightMm < state.sheetSize.heightMm;

        // A shorter sheet must still hold everything. Re-packing onto one
        // that is too short used to leave the rest piled on top.
        const allInside = placed.every((img) => !isOutsidePrintable(img, size));
        if (shrinking && placed.length > 0 && !allInside) {
          if (packSheet(placed.map(toItem), size, state.gapMm).overflow.length > 0) {
            showToast(
              `Motiven får inte plats på ${size.label.replace(/ \(.*\)$/, "")}. Ta bort eller förminska några först.`,
              "warning",
            );
            return;
          }
        }

        // Keep the active sheet's entry in sync so per-sheet pricing is correct
        set(withSheetSize(state, size));
        // Designs below the new end would fall off the film: re-pack them.
        if (shrinking && placed.some((img) => isOutsidePrintable(img, size))) {
          get().arrangeAll();
        }
      },

      setFilmType: (type) => {
        set((state) => ({
          filmType: type,
          sheets: state.sheets.map((s, i) =>
            i === state.activeSheetIndex ? { ...s, filmType: type } : s,
          ),
        }));
      },

      setGapMm: (mm) => {
        set({ gapMm: Math.max(0, mm) });
        // Every design carries the gap too, because the export reads
        // marginMm per image — keep both in step or print won't match.
        set((state) => ({
          images: state.images.map((img) => ({ ...img, marginMm: Math.max(0, mm) })),
        }));
        get().arrangeAll();
      },

      /**
       * Drop a newly uploaded design onto the first spot where it touches
       * nothing. Uploads used to land on a fixed 10,10 and pile up, so a
       * customer with three logos saw one blob.
       */
      addImage: (image) =>
        set((state) => {
          const { sheetSize, gapMm } = state;
          const bbox = imageBbox({ ...image, positionX: 0, positionY: 0 });
          const blockers = blockersExcept(state.images, null);

          // Sheet full? Grow it rather than silently stacking designs.
          const { size, spot } = freeSpotGrowing(bbox.w, bbox.h, sheetSize, gapMm, blockers);

          const placed: EditorImage = {
            ...image,
            groupId: image.groupId ?? image.id,
            marginMm: gapMm,
            quantity: 1,
            positionX: spot?.x ?? EDGE_MARGIN_MM,
            positionY: spot?.y ?? EDGE_MARGIN_MM,
            placed: true,
          };

          const grew = size.key !== sheetSize.key;
          return {
            images: [...state.images, placed],
            selectedImageId: placed.id,
            lastArrange: null,
            sheetSize: grew ? size : state.sheetSize,
            sheets: grew
              ? state.sheets.map((s, i) =>
                  i === state.activeSheetIndex
                    ? { ...s, size: size.label, sheetSize: size }
                    : s,
                )
              : state.sheets,
          };
        }),

      removeImage: (id) =>
        set((state) => ({
          images: state.images.filter((img) => img.id !== id),
          selectedImageId:
            state.selectedImageId === id ? null : state.selectedImageId,
        })),

      removeGroup: (groupId) =>
        set((state) => {
          const remaining = state.images.filter(
            (img) => groupKey(img) !== groupId,
          );
          const stillSelected = remaining.some(
            (img) => img.id === state.selectedImageId,
          );
          return {
            images: remaining,
            selectedImageId: stillSelected ? state.selectedImageId : null,
          };
        }),

      updateImage: (id, updates) =>
        set((state) => ({
          images: state.images.map((img) =>
            img.id === id ? { ...img, ...updates } : img,
          ),
        })),

      updateGroup: (groupId, updates) => {
        set((state) => ({
          images: state.images.map((img) =>
            groupKey(img) === groupId ? { ...img, ...updates } : img,
          ),
        }));
        // A resize or rotation changes the footprint, so re-tile the group
        // to keep it clear of everything else.
        const state = get();
        const group = groupImages(state.images).find((g) => g.groupId === groupId);
        if (group && group.count > 1) get().setGroupCount(groupId, group.count);
        else if (group) get().keepClear(group.master.id);
      },

      setGroupCount: (groupId, count) =>
        set((state) => {
          const groups = groupImages(state.images);
          const group = groups.find((g) => g.groupId === groupId);
          if (!group) return state;

          const wanted = Math.max(1, Math.floor(count));
          const source = group.master;
          const bbox = imageBbox({ ...source, positionX: 0, positionY: 0 });
          const blockers = blockersExcept(state.images, groupId);

          // Nest the copies into the free space around the other designs,
          // turning them where that saves film. Not enough room? Lengthen
          // the sheet before dropping copies the customer asked for — a
          // short count is a wrong order.
          const ids = Array.from({ length: wanted }, (_, i) => group.members[i]?.id ?? generateImageId());
          let size = state.sheetSize;
          const pack = (at: SheetSize) =>
            packSheet(ids.map((id) => ({ id, w: bbox.w, h: bbox.h })), at, state.gapMm, blockers);
          let result = pack(size);
          if (result.overflow.length > 0) {
            const tall = pack(sheetForHeight(MAX_SHEET_MM));
            size = sheetForHeight(Math.max(state.sheetSize.heightMm, tall.bottomMm + EDGE_MARGIN_MM));
            result = tall;
          }
          const spots = ids
            .map((id) => ({ id, p: result.placements.get(id) }))
            .filter((s): s is { id: string; p: Placement } => Boolean(s.p));
          const grew = size.key !== state.sheetSize.key;
          if (grew) {
            const n = Math.min(wanted, spots.length);
            queueMicrotask(() => showToast(grewMessage(size, `alla ${n}`), "info"));
          }

          // Existing copies keep their ids (and their dbId links).
          const copies: EditorImage[] = spots.map(({ id, p }) => ({
            ...source,
            id,
            groupId,
            quantity: 1,
            marginMm: state.gapMm,
            positionX: p.x,
            positionY: p.y,
            rotation: p.rotated ? quarterTurn(source.rotation) : source.rotation,
            placed: true,
          }));

          const others = state.images.filter(
            (img) => groupKey(img) !== groupId,
          );
          const selected = copies.some((c) => c.id === state.selectedImageId)
            ? state.selectedImageId
            : (copies[0]?.id ?? null);

          const missing = wanted - copies.length;

          return {
            images: [...others, ...copies],
            selectedImageId: selected,
            lastArrange: null,
            lastFillShortfall:
              missing > 0
                ? { filename: source.filename, missing }
                : null,
            ...(grew ? withSheetSize(state, size) : {}),
          };
        }),

      clearFillShortfall: () => set({ lastFillShortfall: null }),

      autoFillGroup: (groupId) => {
        const state = get();
        const group = groupImages(state.images).find((g) => g.groupId === groupId);
        if (!group) return;
        const bbox = imageBbox({
          ...group.master,
          positionX: 0,
          positionY: 0,
        });
        const blockers = blockersExcept(state.images, groupId);
        const fits = freeCapacityFor(
          bbox.w,
          bbox.h,
          state.sheetSize,
          state.gapMm,
          blockers,
        );
        // Only ever add: a full sheet reports fewer free cells than the
        // group already owns, and "fill" must never delete the customer's
        // copies.
        if (fits > group.count) get().setGroupCount(groupId, fits);
      },

      arrangeAll: (options) => {
        const state = get();
        const placed = state.images.filter((img) => img.placed);
        const start = options?.from ?? state.sheetSize;
        const { size, placements, overflow } = packGrowing(placed, start, state.gapMm);
        const { images, turned } = applyPlacements(state.images, placements);
        set({
          images,
          lastArrange: {
            placed: placements.size,
            overflow: overflow.length,
            grewTo: size.heightMm > state.sheetSize.heightMm ? size.label : undefined,
          },
          ...(size.key !== state.sheetSize.key ? withSheetSize(state, size) : {}),
        });
        const message = arrangeMessage(state.sheetSize, size, turned);
        if (message) showToast(message, "info");
      },

      arrangeSheet: async () => {
        if (get().images.length === 0) return;
        // Nested in the browser now — the same algorithm the guide uses to
        // pick the film length, so the two can no longer disagree. The
        // server round trip it replaces packed per copy without telling the
        // export, which printed turned copies upright.
        set({ isAutoBuilding: true, lastArrange: null });
        try {
          get().arrangeAll();
        } finally {
          set({ isAutoBuilding: false });
        }
      },

      addDesigns: (entries, { floor, keepExisting }) => {
        const state = get();
        const gap = state.gapMm;
        const copies: EditorImage[] = [];
        for (const { image, count } of entries) {
          const n = Math.max(1, Math.floor(count));
          for (let i = 0; i < n; i++) {
            copies.push({
              ...image,
              id: i === 0 ? image.id : generateImageId(),
              groupId: image.groupId ?? image.id,
              quantity: 1,
              marginMm: gap,
              placed: true,
            });
          }
        }

        const existing = state.images.filter((img) => img.placed);
        const start = keepExisting && floor.heightMm < state.sheetSize.heightMm ? state.sheetSize : floor;
        const { size, placements, overflow } =
          keepExisting && existing.length > 0
            ? packGrowing(copies, start, gap, existing.map(imageBbox))
            : packGrowing([...existing, ...copies], start, gap);

        const left = new Set(overflow);
        const { images, turned } = applyPlacements(
          [...state.images, ...copies].filter((img) => !left.has(img.id)),
          placements,
        );
        set({
          images,
          selectedImageId: null,
          lastArrange: null,
          lastFillShortfall: null,
          ...withSheetSize(state, size),
        });
        return { overflow: overflow.length, turned, size };
      },

      duplicateImage: (id) => {
        const state = get();
        const img = state.images.find((i) => i.id === id);
        if (!img) return;
        const key = groupKey(img);
        const group = groupImages(state.images).find((g) => g.groupId === key);
        get().setGroupCount(key, (group?.count ?? 1) + 1);
      },

      /**
       * Resize a design. Every copy of it changes too — they are the same
       * artwork, and letting them drift apart is never what a customer means.
       */
      resizeImage: (id, widthMm, heightMm, keepRatio) => {
        const target = get().images.find((img) => img.id === id);
        if (!target) return;
        const key = groupKey(target);
        const ratio = target.widthPx / target.heightPx;

        let nextW = widthMm;
        let nextH = heightMm;
        if (keepRatio) {
          if (widthMm !== target.displayWidth) {
            nextH = widthMm / ratio;
          } else {
            nextW = heightMm * ratio;
          }
        }

        set((state) => ({
          images: state.images.map((img) =>
            groupKey(img) === key
              ? { ...img, displayWidth: nextW, displayHeight: nextH }
              : img,
          ),
        }));

        const group = groupImages(get().images).find((g) => g.groupId === key);
        if (group && group.count > 1) get().setGroupCount(key, group.count);
        else get().keepClear(id);
      },

      keepClear: (id) => {
        const state = get();
        const img = state.images.find((i) => i.id === id);
        if (!img?.placed) return;
        const box = imageBbox(img);
        const others = state.images
          .filter((o) => o.placed && o.id !== id)
          .map(imageBbox);
        const clashes =
          others.some((o) => rectsOverlap(box, o)) ||
          isOutsidePrintable(img, state.sheetSize);
        if (!clashes) return;

        // Beside where it is, when there is room; it used to jump to the
        // first free spot from the top, often far from where it was made.
        const near = nearestFreeSpot(box.w, box.h, { x: box.x, y: box.y }, state.sheetSize, state.gapMm, others);
        const { size, spot } = near
          ? { size: state.sheetSize, spot: near }
          : freeSpotGrowing(box.w, box.h, state.sheetSize, state.gapMm, others);
        if (!spot) return; // not even the longest sheet has room — the checks will say so
        const grew = size.key !== state.sheetSize.key;
        set({
          images: state.images.map((i) =>
            i.id === id ? { ...i, positionX: spot.x, positionY: spot.y } : i,
          ),
          lastArrange: null,
          ...(grew ? withSheetSize(state, size) : {}),
        });
        showToast(
          grew
            ? `Motivet flyttades till en ledig plats. ${grewMessage(size, "det")}`
            : "Motivet flyttades till en ledig plats så att det inte ligger på något annat.",
          "info",
        );
      },

      restoreSnapshot: (images, sheetSize) =>
        set((state) => ({
          images,
          ...withSheetSize(state, sheetSize),
          selectedImageId: images.some((i) => i.id === state.selectedImageId)
            ? state.selectedImageId
            : null,
          lastArrange: null,
          lastFillShortfall: null,
        })),

      replaceArtwork: (groupId, patch) => {
        const ids = get()
          .images.filter((img) => groupKey(img) === groupId)
          .map((img) => img.id);
        if (ids.length === 0) return;
        set((state) => ({
          images: state.images.map((img) => (ids.includes(img.id) ? { ...img, ...patch } : img)),
          lastArrange: null,
        }));
        for (const id of ids) get().keepClear(id);
      },

      settleAfterMove: (id, from) => {
        const state = get();
        const img = state.images.find((i) => i.id === id);
        if (!img?.placed) return;
        const box = imageBbox(img);
        const others = state.images.filter((o) => o.placed && o.id !== id).map(imageBbox);
        const onTop = others.some((o) => isRealOverlap(box, o));
        if (!onTop && !isOutsidePrintable(img, state.sheetSize)) return;

        const spot = nearestFreeSpot(box.w, box.h, { x: box.x, y: box.y }, state.sheetSize, state.gapMm, others);
        const to = spot ?? from;
        set({
          images: state.images.map((i) =>
            i.id === id ? { ...i, positionX: to.x, positionY: to.y } : i,
          ),
          lastArrange: null,
        });
        // Pulled back inside the edge explains itself; the rest needs a word.
        if (!spot) {
          showToast("Det fanns ingen ledig plats där — motivet flyttades tillbaka.", "info");
        } else if (onTop) {
          showToast("Motiv kan inte ligga på varandra — det lades på närmaste lediga plats.", "info");
        }
      },

      selectImage: (id) => set({ selectedImageId: id }),

      setUploading: (val) => set({ isUploading: val }),
      setAutoBuilding: (val) => set({ isAutoBuilding: val }),
      setSaving: (val) => set({ isSaving: val }),
      setZoom: (zoom) => set({ zoom: Math.max(0.1, Math.min(5, zoom)) }),
      setShowDpiOverlay: (val) => set({ showDpiOverlay: val }),

      setPrices: (prices) => {
        set({ prices });
      },

      setGangSheetId: (id) => set({ gangSheetId: id }),

      setSheetGangSheetId: (index, id) =>
        set((state) => ({
          sheets: state.sheets.map((s, i) =>
            i === index ? { ...s, gangSheetId: id } : s,
          ),
          // Keep the top-level id in sync when it's the active sheet
          gangSheetId: index === state.activeSheetIndex ? id : state.gangSheetId,
        })),

      applyAutoBuild: (placements) =>
        set((state) => {
          const updatedImages = state.images.map((img) => {
            // Match on the editor id first: copies of one design share a
            // dbId, so a dbId match would hand them all the same position.
            const placement =
              placements.find((p: any) => p.id === img.id) ??
              placements.find((p: any) => p.id === img.dbId);
            if (!placement) return img;
            // NOTE: displayWidth/displayHeight are intentionally NOT overwritten —
            // placement width/height are bbox dims; overwriting would double-transform
            // rotated items and undo customer resizes.
            return {
              ...img,
              positionX: placement.x,
              positionY: placement.y,
              rotation: placement.rotated ? 90 : 0,
              placed: true,
            };
          });
          return { images: updatedImages };
        }),

      addSheet: () => {
        set((state) => {
          // Save current images + size/film to current sheet
          const updatedSheets = state.sheets.map((s, i) =>
            i === state.activeSheetIndex
              ? {
                  ...s,
                  savedImages: state.images,
                  imageCount: state.images.length,
                  gangSheetId: state.gangSheetId,
                  size: state.sheetSize.label,
                  sheetSize: state.sheetSize,
                  filmType: state.filmType,
                }
              : s,
          );
          const idx = updatedSheets.length + 1;
          const newSheet: SheetEntry = {
            id: "sheet_" + Math.random().toString(36).substring(2, 8),
            name: `Ark ${idx}`,
            gangSheetId: null,
            imageCount: 0,
            size: state.sheetSize.label,
            quantity: 1,
            savedImages: [] as EditorImage[],
            sheetSize: state.sheetSize,
            filmType: state.filmType,
          };
          return {
            sheets: [...updatedSheets, newSheet],
            activeSheetIndex: updatedSheets.length,
            images: [],
            gangSheetId: null,
            selectedImageId: null,
          };
        });
      },

      removeSheet: (index) => {
        set((state) => {
          if (state.sheets.length <= 1) return state;
          // Sync the active sheet's live images before anything reads savedImages
          const syncedSheets = state.sheets.map((s, i) =>
            i === state.activeSheetIndex
              ? {
                  ...s,
                  savedImages: state.images,
                  imageCount: state.images.length,
                  gangSheetId: state.gangSheetId,
                  size: state.sheetSize.label,
                  sheetSize: state.sheetSize,
                  filmType: state.filmType,
                }
              : s,
          );
          const newSheets = syncedSheets.filter((_, i) => i !== index);

          if (index !== state.activeSheetIndex) {
            // Removing an inactive sheet must not touch the active images
            const newActiveIdx =
              index < state.activeSheetIndex
                ? state.activeSheetIndex - 1
                : state.activeSheetIndex;
            return { sheets: newSheets, activeSheetIndex: newActiveIdx };
          }

          // Removing the active sheet — restore another sheet's state
          const newActiveIdx = Math.min(index, newSheets.length - 1);
          const target = newSheets[newActiveIdx];
          return {
            sheets: newSheets,
            activeSheetIndex: newActiveIdx,
            images: target?.savedImages || [],
            gangSheetId: target?.gangSheetId || null,
            selectedImageId: null,
            sheetSize: target?.sheetSize ?? state.sheetSize,
            filmType: target?.filmType ?? state.filmType,
          };
        });
      },

      switchSheet: (index) => {
        set((state) => {
          if (index === state.activeSheetIndex) return state;
          // Save current images + size/film to current sheet
          const updatedSheets = state.sheets.map((s, i) =>
            i === state.activeSheetIndex
              ? {
                  ...s,
                  savedImages: state.images,
                  imageCount: state.images.length,
                  gangSheetId: state.gangSheetId,
                  size: state.sheetSize.label,
                  sheetSize: state.sheetSize,
                  filmType: state.filmType,
                }
              : s,
          );
          const target = updatedSheets[index];
          return {
            sheets: updatedSheets,
            activeSheetIndex: index,
            images: target?.savedImages || [],
            gangSheetId: target?.gangSheetId || null,
            selectedImageId: null,
            sheetSize: target?.sheetSize ?? state.sheetSize,
            filmType: target?.filmType ?? state.filmType,
          };
        });
      },

      duplicateSheet: (index) =>
        set((state) => {
          const source = state.sheets[index];
          if (!source) return state;
          // If duplicating current sheet, use current images + size/film
          const isActive = index === state.activeSheetIndex;
          const imgs = isActive ? state.images : source.savedImages;
          return {
            sheets: [
              ...state.sheets,
              {
                ...source,
                id: "sheet_" + Math.random().toString(36).substring(2, 8),
                name: source.name + " (kopia)",
                gangSheetId: null, // new sheet needs own gangSheetId
                savedImages: imgs.map(img => ({
                  ...img,
                  id: "img_" + Math.random().toString(36).substring(2, 10),
                })),
                imageCount: imgs.length,
                size: isActive ? state.sheetSize.label : source.size,
                sheetSize: isActive ? state.sheetSize : source.sheetSize,
                filmType: isActive ? state.filmType : source.filmType,
              },
            ],
          };
        }),

      setSheetQuantity: (index, qty) =>
        set((state) => ({
          sheets: state.sheets.map((s, i) =>
            i === index ? { ...s, quantity: Math.max(1, qty) } : s,
          ),
        })),

      reset: () =>
        set({
          sessionId: generateSessionId(),
          gangSheetId: null,
          images: [],
          selectedImageId: null,
          sheetSize: DEFAULT_SHEET,
          filmType: "standard",
              sheets: [{ id: "sheet_1", name: "Ark 1", gangSheetId: null, imageCount: 0, size: "58 × 100 cm", quantity: 1, savedImages: [], sheetSize: DEFAULT_SHEET, filmType: "standard" }],
          activeSheetIndex: 0,
          lastArrange: null,
          lastFillShortfall: null,
          gapMm: DEFAULT_GAP_MM,
          zoom: 1,
        }),
    }),
    {
      name: "gangsheet-editor-state",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
