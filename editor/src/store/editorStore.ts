import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface EditorImage {
  id: string;
  dbId?: string;
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
  currentPrice: number | null;
  selectedImageId: string | null;
  isUploading: boolean;
  isAutoBuilding: boolean;
  isSaving: boolean;
  zoom: number;
  showDpiOverlay: boolean;

  // Multi-sheet
  sheets: SheetEntry[];
  activeSheetIndex: number;

  // Actions
  setSheetSize: (size: SheetSize) => void;
  setFilmType: (type: string) => void;
  addImage: (image: EditorImage) => void;
  removeImage: (id: string) => void;
  updateImage: (id: string, updates: Partial<EditorImage>) => void;
  duplicateImage: (id: string) => void;
  setImageQuantity: (id: string, quantity: number) => void;
  resizeImage: (id: string, widthMm: number, heightMm: number, keepRatio: boolean) => void;
  selectImage: (id: string | null) => void;
  setUploading: (val: boolean) => void;
  setAutoBuilding: (val: boolean) => void;
  setSaving: (val: boolean) => void;
  setZoom: (zoom: number) => void;
  setShowDpiOverlay: (val: boolean) => void;
  setPrices: (prices: Record<string, Record<string, number>>) => void;
  updatePrice: () => void;
  setGangSheetId: (id: string) => void;
  setSheetGangSheetId: (index: number, id: string) => void;
  applyAutoBuild: (placements: any[]) => void;
  autoFillSheet: (id: string) => void;
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
  label: "58 × 100 cm",
};

function generateSessionId(): string {
  return "gs_" + Math.random().toString(36).substring(2, 15);
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
  const price = prices?.[sizeKey]?.[film];
  return typeof price === "number" ? price : null;
}

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
      currentPrice: null,
      selectedImageId: null,
      isUploading: false,
      isAutoBuilding: false,
      isSaving: false,
      zoom: 1,
      showDpiOverlay: false,

      setSheetSize: (size) => {
        set((state) => ({
          sheetSize: size,
          // Keep the active sheet's entry in sync so per-sheet pricing is correct
          sheets: state.sheets.map((s, i) =>
            i === state.activeSheetIndex
              ? { ...s, size: size.label, sheetSize: size }
              : s,
          ),
        }));
        get().updatePrice();
      },

      setFilmType: (type) => {
        set((state) => ({
          filmType: type,
          sheets: state.sheets.map((s, i) =>
            i === state.activeSheetIndex ? { ...s, filmType: type } : s,
          ),
        }));
        get().updatePrice();
      },

      addImage: (image) =>
        set((state) => ({ images: [...state.images, image] })),

      removeImage: (id) =>
        set((state) => ({
          images: state.images.filter((img) => img.id !== id),
          selectedImageId:
            state.selectedImageId === id ? null : state.selectedImageId,
        })),

      updateImage: (id, updates) =>
        set((state) => ({
          images: state.images.map((img) =>
            img.id === id ? { ...img, ...updates } : img,
          ),
        })),

      duplicateImage: (id) =>
        set((state) => ({
          // Master concept: increase quantity instead of creating new layer
          images: state.images.map((img) =>
            img.id === id ? { ...img, quantity: img.quantity + 1 } : img,
          ),
        })),

      setImageQuantity: (id, quantity) =>
        set((state) => ({
          images: state.images.map((img) =>
            img.id === id ? { ...img, quantity: Math.max(1, quantity) } : img,
          ),
        })),

      resizeImage: (id, widthMm, heightMm, keepRatio) => {
        set((state) => ({
          images: state.images.map((img) => {
            if (img.id !== id) return img;
            if (keepRatio) {
              const ratio = img.widthPx / img.heightPx;
              if (widthMm !== img.displayWidth) {
                return { ...img, displayWidth: widthMm, displayHeight: widthMm / ratio };
              } else {
                return { ...img, displayWidth: heightMm * ratio, displayHeight: heightMm };
              }
            }
            return { ...img, displayWidth: widthMm, displayHeight: heightMm };
          }),
        }));
      },

      selectImage: (id) => set({ selectedImageId: id }),

      setUploading: (val) => set({ isUploading: val }),
      setAutoBuilding: (val) => set({ isAutoBuilding: val }),
      setSaving: (val) => set({ isSaving: val }),
      setZoom: (zoom) => set({ zoom: Math.max(0.1, Math.min(5, zoom)) }),
      setShowDpiOverlay: (val) => set({ showDpiOverlay: val }),

      setPrices: (prices) => {
        set({ prices });
        get().updatePrice();
      },

      updatePrice: () => {
        const { prices, sheetSize, filmType } = get();
        const sizeKey = sheetSize.key;
        const price = prices[sizeKey]?.[filmType];
        set({ currentPrice: typeof price === "number" ? price : null });
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
            const placement = placements.find(
              (p: any) => p.id === img.dbId || p.id === img.id,
            );
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

      autoFillSheet: (id) =>
        set((state) => {
          const source = state.images.find((img) => img.id === id);
          if (!source) return state;

          const { sheetSize } = state;
          const gap = source.marginMm ?? 5;
          const imgW = source.displayWidth + gap;
          const imgH = source.displayHeight + gap;

          const cols = Math.floor((sheetSize.widthMm - gap) / imgW);
          const rows = Math.floor((sheetSize.heightMm - gap) / imgH);
          const totalFit = cols * rows;

          if (totalFit <= 1) return state;

          // Remove existing duplicates of this image
          const otherImages = state.images.filter(
            (img) => img.id !== id,
          );

          const filledImages: EditorImage[] = [];
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const isFirst = row === 0 && col === 0;
              filledImages.push({
                ...source,
                id: isFirst
                  ? source.id
                  : "img_" + Math.random().toString(36).substring(2, 10),
                positionX: gap + col * imgW,
                positionY: gap + row * imgH,
                placed: true,
              });
            }
          }

          return {
            images: [...otherImages, ...filledImages],
            selectedImageId: source.id,
          };
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
        get().updatePrice();
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
        get().updatePrice();
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
        get().updatePrice();
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
          currentPrice: null,
          sheets: [{ id: "sheet_1", name: "Ark 1", gangSheetId: null, imageCount: 0, size: "58 × 100 cm", quantity: 1, savedImages: [], sheetSize: DEFAULT_SHEET, filmType: "standard" }],
          activeSheetIndex: 0,
        }),
    }),
    {
      name: "gangsheet-editor-state",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
