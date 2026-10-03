import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, Control, FabricImage, FabricObject, Rect, FabricText, ActiveSelection, config, util } from "fabric";
import { useEditorStore } from "../../store/editorStore";
import {
  mmToCanvasPx,
  canvasPxToMm,
  calculateScaleFactor,
  calculateDisplayDpi,
  getDpiColor,
  DPI_LEVEL_COLORS,
  DPI_LEVEL_LABELS,
  DPI_THRESHOLDS,
} from "../../utils/units";
import { printableArea } from "../../utils/layout";
import { useSheetStats } from "../../utils/sheetStats";
import { useIsMobile } from "../../utils/useIsMobile";
import { theme } from "../../styles/theme";

/** Custom data attached to Fabric objects (not part of Fabric's typings). */
function getObjData(obj: FabricObject | undefined | null): any {
  return (obj as any)?.data;
}

/**
 * Axis-aligned bounding box (mm) of an unrotated w×h (mm) image
 * rotated by `angleDeg` degrees — shared placement contract.
 */
function rotatedBboxMm(wMm: number, hMm: number, angleDeg: number): { bboxW: number; bboxH: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    bboxW: wMm * cos + hMm * sin,
    bboxH: wMm * sin + hMm * cos,
  };
}

/**
 * Handles. Big enough for a thumb, and no side handles: they stretched a
 * logo out of shape. Zoom is Fabric's own, so these stay the same size on
 * screen at any zoom — under the old CSS zoom they grew with the sheet
 * until they hid the design they belonged to.
 */
function styleControls(obj: FabricObject) {
  obj.set({ cornerSize: 12, touchCornerSize: 34, borderScaleFactor: 1.5 } as any);
  const mtr = obj.controls?.mtr;
  if (mtr) obj.controls = { ...obj.controls, mtr: new Control({ ...mtr, offsetY: -28 }) };
  obj.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
}

/** Most bitmap pixels per canvas: iOS drops canvases above ~16.7 million. */
const PIXEL_BUDGET = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 8e6 : 24e6;

/**
 * Size the canvas for `zoom` and draw at that scale. The sheet was zoomed
 * with a CSS transform: blurry, and since it scaled around the middle, the
 * top of a zoomed sheet sat where scrolling could not reach — on a phone
 * only the middle of the sheet could be seen. Now the canvas really grows
 * and the page scrolls over it; its bitmap is kept within budget.
 */
function applyZoom(canvas: Canvas, base: { w: number; h: number }, zoom: number) {
  const w = Math.max(1, Math.round(base.w * zoom));
  const h = Math.max(1, Math.round(base.h * zoom));
  const device = window.devicePixelRatio || 1;
  config.configure({ devicePixelRatio: Math.max(0.5, Math.min(device, Math.sqrt(PIXEL_BUDGET / (w * h)))) });
  canvas.setDimensions({ width: w, height: h });
  canvas.setZoom(zoom);
  canvas.requestRenderAll();
}

/** One design's transform as written to the store, for tidying after. */
interface Change {
  imageId: string;
  from: { x: number; y: number };
  reshaped: boolean;
}

/**
 * What the sheet is shown on. Checks show what is transparent; a garment
 * colour shows how the print will look on the shirt — white logos on
 * black, dark text on navy. Purely a preview: nothing of it is printed.
 */
const BACKDROPS: { id: string; label: string; color: string }[] = [
  { id: "checks", label: "Rutor (genomskinligt)", color: "" },
  { id: "#ffffff", label: "Vit", color: "#ffffff" },
  { id: "#111111", label: "Svart", color: "#111111" },
  { id: "#9a9b9d", label: "Gråmelerad", color: "#9a9b9d" },
  { id: "#1d2742", label: "Marinblå", color: "#1d2742" },
  { id: "#b3202a", label: "Röd", color: "#b3202a" },
  { id: "#2f4a8f", label: "Kungsblå", color: "#2f4a8f" },
  { id: "#3d4a33", label: "Mörkgrön", color: "#3d4a33" },
  { id: "#d9c9a8", label: "Sand", color: "#d9c9a8" },
];

const CHECKS: React.CSSProperties = {
  // Light checks read as film rather than as a grey box. The squares are
  // small so a white logo still shows its edge against the grey ones;
  // "Plaggfärg" puts it on a dark shirt to check it properly.
  backgroundImage:
    "linear-gradient(45deg, #e2e4e8 25%, transparent 25%), " +
    "linear-gradient(-45deg, #e2e4e8 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, #e2e4e8 75%), " +
    "linear-gradient(-45deg, transparent 75%, #e2e4e8 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
  backgroundColor: "#ffffff",
};

/**
 * Room kept free around the sheet when it is fitted to the view: the
 * rulers along the top and left and, on a phone, the controls along the
 * bottom. The sheet used to fill the whole height there, so "Plaggfärg",
 * "DPI-kvalitet" and the zoom sat on top of its last 10 cm.
 */
function viewInsets(mobile: boolean) {
  return mobile
    ? { top: 32, right: 14, bottom: 76, left: 30 }
    : { top: 40, right: 40, bottom: 40, left: 40 };
}

/** One zoom step: the same feel at 30 % as at 300 %. */
const ZOOM_STEP = 1.25;

/**
 * The checks once there is white on the sheet: on the light ones a white
 * name or logo all but disappears, and DTF prints white as often as any
 * colour. Still lighter than the mid-grey the sheet used to have always.
 */
const CHECKS_FOR_WHITE: React.CSSProperties = {
  ...CHECKS,
  backgroundImage:
    "linear-gradient(45deg, #c3c8cf 25%, transparent 25%), " +
    "linear-gradient(-45deg, #c3c8cf 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, #c3c8cf 75%), " +
    "linear-gradient(-45deg, transparent 75%, #c3c8cf 75%)",
  backgroundColor: "#d5d9de",
};

function backdropStyle(bg: string, whiteArt: boolean): React.CSSProperties {
  if (bg === "checks" || !/^#[0-9a-f]{6}$/i.test(bg)) return whiteArt ? CHECKS_FOR_WHITE : CHECKS;
  return { backgroundImage: "none", backgroundColor: bg };
}

function isLightColor(hex: string | undefined): boolean {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.85;
}

/** Artwork URL → mostly white (or a white box)? Measured once per file. */
const MOSTLY_WHITE = new Map<string, boolean>();

/** Most of the inked pixels near white. Null when the image can't be read (no CORS). */
function measureMostlyWhite(el: CanvasImageSource): boolean | null {
  try {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let inked = 0;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 128) continue;
      inked++;
      if ((0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255 > 0.85) white++;
    }
    return inked > 0 && white / inked > 0.5;
  } catch {
    return null;
  }
}

export function GangSheetCanvas({ hideControls = false }: { hideControls?: boolean } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<number>(1);
  const syncGenRef = useRef<number>(0);
  /**
   * True while the canvas is being rebuilt. Removing objects fires
   * selection:cleared, which used to wipe the store selection — so after
   * every drag the handles and the sidebar controls vanished.
   */
  const rebuildingRef = useRef<boolean>(false);
  /** Selection to restore once the rebuild finishes. */
  const selectedIdRef = useRef<string | null>(null);
  /** The canvas size at zoom 1 (the whole sheet fits), and the zoom drawn. */
  const baseSizeRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const drawnZoomRef = useRef<number>(1);
  /** Where a zoom should stay put (screen point), set by pinch and wheel. */
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  /** A zoom the canvas set up itself and already drew, until the store has it. */
  const startZoomRef = useRef<number | null>(null);
  /** baseSizeRef as state, for what renders from it (the rulers). */
  const [base, setBase] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [overflowCount, setOverflowCount] = useState(0);
  /** Bumped when an artwork has been measured for white. */
  const [whiteMeasured, setWhiteMeasured] = useState(0);

  const {
    sheetSize,
    images,
    selectedImageId,
    zoom,
    showDpiOverlay,
    selectImage,
    updateImage,
    setShowDpiOverlay,
    setZoom,
    arrangeSheet,
    canvasBg,
    setCanvasBg,
  } = useEditorStore();

  // White on the sheet: texts and names know their colour, artwork is measured.
  const whiteArt = useMemo(
    () =>
      images.some((img) => {
        if (!img.placed) return false;
        if (img.text) {
          const darkEdge = img.text.outline > 0 && !isLightColor(img.text.outlineColor);
          return isLightColor(img.text.color) && !darkEdge;
        }
        return MOSTLY_WHITE.get(img.bgRemovedUrl || img.thumbnailUrl) === true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, whiteMeasured],
  );

  // Collision + out-of-bounds state, recomputed whenever anything moves.
  const stats = useSheetStats();
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const insets = viewInsets(isMobile);

  /**
   * Zooms that fit the view as it is now: the whole sheet, or its width
   * (designs at a readable size, scrolling down the length). Measured on
   * demand — the view shrinks when the phone's design list is open.
   */
  const fitZooms = () => {
    const box = containerRef.current;
    const b = baseSizeRef.current;
    if (!box) return { whole: 1, width: 1 };
    const ins = viewInsets(isMobileRef.current);
    const w = Math.max(1, box.clientWidth - ins.left - ins.right);
    const h = Math.max(1, box.clientHeight - ins.top - ins.bottom);
    return { whole: Math.min(w / b.w, h / b.h), width: w / b.w };
  };

  // Initialize canvas
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const mobile = isMobileRef.current;
    const ins = viewInsets(mobile);
    // A phone measures from the width alone: 100 % is the sheet's width
    // filling the screen, at any length and whether or not the design list
    // is pulled up over the view while the sheet is set up.
    const scaleFactor = mobile
      ? Math.max(1, container.clientWidth - ins.left - ins.right) / sheetSize.widthMm
      : calculateScaleFactor(
          sheetSize.widthMm,
          sheetSize.heightMm,
          container.clientWidth,
          container.clientHeight,
        );
    scaleRef.current = scaleFactor;

    const canvasWidth = mmToCanvasPx(sheetSize.widthMm, scaleFactor);
    const canvasHeight = mmToCanvasPx(sheetSize.heightMm, scaleFactor);

    const canvas = new Canvas(canvasRef.current, {
      width: canvasWidth,
      height: canvasHeight,
      backgroundColor: "transparent",
      selection: true, // Enable drag-select (rubber band)
    });

    fabricRef.current = canvas;
    baseSizeRef.current = { w: canvasWidth, h: canvasHeight };
    setBase({ w: canvasWidth, h: canvasHeight });
    if (mobile) {
      // The whole sheet when it shows at a size you can work with (a
      // metre), else its width (2 m and up would be a narrow strip):
      // logos you can see, scrolling down the length. The width stays put
      // when the sheet grows, instead of the sheet shrinking under you.
      const viewH = Math.max(1, container.clientHeight - ins.top - ins.bottom);
      const whole = Math.min(1, viewH / canvasHeight);
      const start = whole >= 0.7 ? whole : 1;
      drawnZoomRef.current = start;
      applyZoom(canvas, baseSizeRef.current, start);
      container.scrollTop = 0;
      container.scrollLeft = 0;
      if (Math.abs(useEditorStore.getState().zoom - start) > 1e-3) {
        // The zoom effect below would first redraw at the zoom from before.
        startZoomRef.current = start;
        setZoom(start);
      }
    } else {
      drawnZoomRef.current = useEditorStore.getState().zoom;
      applyZoom(canvas, baseSizeRef.current, drawnZoomRef.current);
    }

    // Events
    canvas.on("selection:created", (e) => {
      const obj = e.selected?.[0];
      const imageId = getObjData(obj)?.imageId;
      if (imageId) selectImage(imageId);
    });
    canvas.on("selection:updated", (e) => {
      const obj = e.selected?.[0];
      const imageId = getObjData(obj)?.imageId;
      if (imageId) selectImage(imageId);
    });
    canvas.on("selection:cleared", () => {
      if (rebuildingRef.current) return;
      selectImage(null);
    });

    /**
     * Persist one object's absolute transform to the store per the shared
     * placement contract: displayWidth/Height = unrotated dims (mm),
     * rotation = angle (deg), positionX/Y = top-left of the rotated bbox.
     * `centerX/centerY` are the object's absolute center in canvas px,
     * `angle` in degrees, `scaleX/scaleY` absolute scale. Returns what
     * changed, so a selection is tidied once all of it has been written.
     */
    const persistTransform = (
      imageId: string,
      widthPx: number,
      heightPx: number,
      centerX: number,
      centerY: number,
      angle: number,
      scaleX: number,
      scaleY: number,
    ): Change | null => {
      const displayWidth = canvasPxToMm(widthPx * Math.abs(scaleX), scaleFactor);
      const displayHeight = canvasPxToMm(heightPx * Math.abs(scaleY), scaleFactor);
      const rotation = angle;
      const { bboxW, bboxH } = rotatedBboxMm(displayWidth, displayHeight, rotation);
      const before = useEditorStore.getState().images.find((i) => i.id === imageId);
      updateImage(imageId, {
        positionX: canvasPxToMm(centerX, scaleFactor) - bboxW / 2,
        positionY: canvasPxToMm(centerY, scaleFactor) - bboxH / 2,
        displayWidth,
        displayHeight,
        rotation,
      });
      if (!before) return null;
      return {
        imageId,
        from: { x: before.positionX, y: before.positionY },
        reshaped:
          Math.abs(before.displayWidth - displayWidth) > 0.5 ||
          Math.abs(before.displayHeight - displayHeight) > 0.5 ||
          before.rotation !== rotation,
      };
    };

    /**
     * Made bigger or turned onto a neighbour: it moves somewhere free.
     * Dropped on another design or past the film edge: it slides to the
     * nearest free spot. Designs on top of each other used to show up only
     * as a red warning at checkout.
     */
    const settle = (changes: (Change | null)[]) => {
      const store = useEditorStore.getState();
      for (const c of changes) {
        if (!c) continue;
        if (c.reshaped) store.keepClear(c.imageId);
        else store.settleAfterMove(c.imageId, c.from);
      }
    };

    canvas.on("object:modified", (e) => {
      const target = e.target;
      if (!target) return;

      if (target instanceof ActiveSelection) {
        // Multi-select: children's left/top are relative to the group.
        // Compose each child's transform with the group matrix to get
        // absolute (center-based) coordinates. All of them are written
        // before any is tidied: designs moved together are checked against
        // where their neighbours ended up, not where they started.
        const changes: (Change | null)[] = [];
        for (const child of target.getObjects()) {
          const imageId = getObjData(child)?.imageId;
          if (!imageId) continue;
          const decomposed = util.qrDecompose(child.calcTransformMatrix());
          changes.push(
            persistTransform(
              imageId,
              child.width || 0,
              child.height || 0,
              decomposed.translateX,
              decomposed.translateY,
              decomposed.angle,
              decomposed.scaleX,
              decomposed.scaleY,
            ),
          );
        }
        settle(changes);
        return;
      }

      const imageId = getObjData(target)?.imageId;
      if (!imageId) return;
      // Objects are created with originX/originY "center", so left/top IS the center
      settle([
        persistTransform(
          imageId,
          target.width || 0,
          target.height || 0,
          target.left || 0,
          target.top || 0,
          target.angle || 0,
          target.scaleX || 1,
          target.scaleY || 1,
        ),
      ]);
    });

    return () => {
      canvas.dispose();
      fabricRef.current = null;
    };
  }, [sheetSize]);

  // Sync images onto canvas — master-motiv renders copies based on quantity
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || !containerRef.current) return;

    // Generation counter — guards against stale async fromURL/clone
    // resolutions adding objects after a re-render replaced them.
    const gen = ++syncGenRef.current;
    const isStale = () => syncGenRef.current !== gen || fabricRef.current !== canvas;
    rebuildingRef.current = true;
    selectedIdRef.current = useEditorStore.getState().selectedImageId;

    const scaleFactor = scaleRef.current;
    const sheetW = sheetSize.widthMm;
    const sheetH = sheetSize.heightMm;

    // Remove existing image objects, DPI overlays and guides
    const toRemove = canvas
      .getObjects()
      .filter(
        (obj) =>
          getObjData(obj)?.imageId ||
          getObjData(obj)?.dpiOverlay ||
          getObjData(obj)?.guide,
      );
    toRemove.forEach((obj) => canvas.remove(obj));

    // Safety margin to the film edge — designs nested into the outer
    // centimetre are unreliable to print, so show customers the line.
    const area = printableArea(sheetSize);
    canvas.add(
      new Rect({
        left: mmToCanvasPx(area.x, scaleFactor),
        top: mmToCanvasPx(area.y, scaleFactor),
        width: mmToCanvasPx(area.w, scaleFactor),
        height: mmToCanvasPx(area.h, scaleFactor),
        fill: "transparent",
        stroke: "rgba(0,0,0,0.22)",
        strokeWidth: 1,
        strokeUniform: true,
        strokeDashArray: [6, 5],
        selectable: false,
        evented: false,
        excludeFromExport: true,
        data: { guide: true },
      } as any),
    );

    let overflow = 0;
    const pending: Promise<unknown>[] = [];

    /**
     * Decode each distinct artwork once per rebuild and clone it for the
     * rest. Copies are separate images now, so a filled sheet meant 300+
     * decodes of the same file and locked the main thread for ~0.7 s on
     * every change.
     */
    const decoded = new Map<string, Promise<FabricImage>>();
    const loadImage = (url: string): Promise<FabricImage> => {
      let base = decoded.get(url);
      if (!base) {
        base = FabricImage.fromURL(url, { crossOrigin: "anonymous" });
        decoded.set(url, base);
        return base;
      }
      return base.then((img) => img.clone());
    };

    for (const img of images) {
      if (!img.placed) continue;
      const url = img.bgRemovedUrl || img.thumbnailUrl;
      const gap = img.marginMm ?? 5;
      const qty = img.quantity || 1;

      // Grid is laid out with the ROTATED bounding box (shared contract)
      const { bboxW, bboxH } = rotatedBboxMm(
        img.displayWidth,
        img.displayHeight,
        img.rotation,
      );
      const cols = Math.max(1, Math.floor((sheetW - gap) / (bboxW + gap)));

      const positions: { x: number; y: number }[] = [];
      for (let q = 0; q < qty; q++) {
        positions.push({
          x: gap + (q % cols) * (bboxW + gap),
          y: gap + Math.floor(q / cols) * (bboxH + gap),
        });
      }

      // If only 1 copy, use the stored position
      if (qty === 1) {
        positions[0] = { x: img.positionX, y: img.positionY };
      }

      overflow += positions.filter((p) => p.y + bboxH > sheetH).length;

      pending.push(
      loadImage(url).then(
        async (fabricImg) => {
          if (isStale()) return;
          if (!img.text && !MOSTLY_WHITE.has(url)) {
            MOSTLY_WHITE.set(url, measureMostlyWhite(fabricImg.getElement()) ?? false);
            setWhiteMeasured((n) => n + 1);
          }
          const displayW = mmToCanvasPx(img.displayWidth, scaleFactor);
          const displayH = mmToCanvasPx(img.displayHeight, scaleFactor);

          const applySettings = (obj: FabricImage, i: number) => {
            const pos = positions[i]!;
            // Center-origin placement: left/top = center of the rotated bbox
            const centerX = mmToCanvasPx(pos.x + bboxW / 2, scaleFactor);
            const centerY = mmToCanvasPx(pos.y + bboxH / 2, scaleFactor);
            const doesNotFit = pos.y + bboxH > sheetH;
            const isClashing =
              stats.overlappingIds.has(img.id) || stats.outsideIds.has(img.id);
            obj.set({
              originX: "center",
              originY: "center",
              left: centerX,
              top: centerY,
              scaleX: displayW / (obj.width || 1),
              scaleY: displayH / (obj.height || 1),
              angle: img.rotation,
              flipX: img.flipX,
              flipY: img.flipY,
              data: { imageId: img.id, copyIndex: i },
              cornerColor: theme.accent,
              cornerStyle: "circle",
              transparentCorners: false,
              borderColor: theme.accent,
              lockUniScaling: true,
              // Only first copy is the "master" — copies are non-selectable
              selectable: i === 0,
              evented: i === 0,
              // Copies that cross the bottom edge won't print — mark them
              opacity: doesNotFit ? 0.5 : i === 0 ? 1 : 0.95,
            } as any);
            if (i === 0) styleControls(obj);
            canvas.add(obj);

            if (doesNotFit || isClashing) {
              canvas.add(
                new Rect({
                  left: mmToCanvasPx(pos.x, scaleFactor),
                  top: mmToCanvasPx(pos.y, scaleFactor),
                  width: mmToCanvasPx(bboxW, scaleFactor),
                  height: mmToCanvasPx(bboxH, scaleFactor),
                  fill: doesNotFit ? "rgba(239,68,68,0.25)" : "transparent",
                  stroke: "#ef4444",
                  strokeWidth: 2,
                  strokeUniform: true,
                  strokeDashArray: isClashing && !doesNotFit ? [5, 4] : undefined,
                  selectable: false,
                  evented: false,
                  data: { dpiOverlay: true },
                } as any),
              );
            }

            // DPI overlay on first copy only
            if (showDpiOverlay && i === 0) {
              const dpi = calculateDisplayDpi(img.widthPx, img.displayWidth);
              const color = getDpiColor(dpi);
              const bboxLeft = mmToCanvasPx(pos.x, scaleFactor);
              const bboxTop = mmToCanvasPx(pos.y, scaleFactor);
              canvas.add(
                new Rect({
                  left: bboxLeft - 2, top: bboxTop - 2,
                  width: mmToCanvasPx(bboxW, scaleFactor) + 4,
                  height: mmToCanvasPx(bboxH, scaleFactor) + 4,
                  fill: "transparent", stroke: color, strokeWidth: 3, strokeUniform: true,
                  selectable: false, evented: false,
                  data: { dpiOverlay: true },
                } as any),
              );
              canvas.add(
                new FabricText(`${dpi}`, {
                  left: bboxLeft + 4, top: bboxTop + 4,
                  fontSize: 11, fontFamily: "system-ui", fontWeight: "bold",
                  fill: "#fff", backgroundColor: color, padding: 2,
                  selectable: false, evented: false,
                  data: { dpiOverlay: true },
                } as any),
              );
            }
          };

          applySettings(fabricImg, 0);
          for (let i = 1; i < positions.length; i++) {
            const cloned = await fabricImg.clone();
            if (isStale()) return;
            applySettings(cloned, i);
          }
          // Draw what has arrived so far: a filled sheet takes a moment to
          // rebuild and a customer should see it fill in, not go blank.
          if (!isStale()) canvas.renderAll();
        },
      ));
    }

    // Put the customer's selection back once every object exists again.
    Promise.allSettled(pending).then(() => {
      if (isStale()) return;
      const wanted = selectedIdRef.current;
      if (wanted) {
        const obj = canvas
          .getObjects()
          .find((o) => getObjData(o)?.imageId === wanted && o.selectable);
        if (obj) canvas.setActiveObject(obj);
      }
      rebuildingRef.current = false;
      canvas.renderAll();
    });

    setOverflowCount(overflow);
  }, [images, sheetSize, showDpiOverlay, stats]);

  /**
   * Pinch to zoom.
   *
   * Zoom lived only in the desktop toolbar, which the phone shell does not
   * render — so on a phone a 58 cm sheet was ~300 px wide and an 8 cm chest
   * motif came out about 4 mm. Customers could not actually look at what
   * they were buying. Listens on the container so Fabric keeps handling
   * single-finger drags of the artwork itself.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const points = new Map<number, { x: number; y: number }>();
    let startSpread = 0;
    let startZoom = 1;
    let pending = 1;
    const wrapper = () => container.querySelector(".gs-canvas-wrapper") as HTMLElement | null;

    const spread = () => {
      const [a, b] = [...points.values()];
      if (!a || !b) return 0;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const middle = () => {
      const [a, b] = [...points.values()];
      return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size === 2) {
        startSpread = spread();
        startZoom = useEditorStore.getState().zoom;
        pending = startZoom;
        // Fingers on the sheet zoom it; they must not also drag a design.
        fabricRef.current?.discardActiveObject();
        const w = wrapper();
        const m = middle();
        if (w && m) {
          const r = w.getBoundingClientRect();
          w.style.transformOrigin = `${m.x - r.left}px ${m.y - r.top}px`;
        }
      }
    };

    // While the fingers move, a cheap CSS scale; the real redraw on release.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size !== 2 || startSpread <= 0) return;
      e.preventDefault();
      pending = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, startZoom * (spread() / startSpread)));
      const w = wrapper();
      if (w) w.style.transform = `scale(${pending / startZoom})`;
    };

    const onUp = (e: PointerEvent) => {
      const wasPinching = points.size === 2 && startSpread > 0;
      const m = middle();
      points.delete(e.pointerId);
      if (!wasPinching) return;
      startSpread = 0;
      const w = wrapper();
      if (w) w.style.transform = "";
      if (m) zoomAnchorRef.current = m;
      setZoom(pending);
    };

    // Trackpad pinch and Ctrl/⌘ + wheel on a computer: zoom at the pointer.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAnchorRef.current = { x: e.clientX, y: e.clientY };
      const z = useEditorStore.getState().zoom;
      // A wheel notch (~100) is about 25 %; a trackpad pinch sends small steps.
      setZoom(z * Math.exp(-e.deltaY * 0.0025));
    };

    container.addEventListener("pointerdown", onDown);
    container.addEventListener("pointermove", onMove, { passive: false });
    container.addEventListener("pointerup", onUp);
    container.addEventListener("pointercancel", onUp);
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onUp);
      container.removeEventListener("pointercancel", onUp);
      container.removeEventListener("wheel", onWheel);
    };
  }, [setZoom]);

  // Redraw at the new zoom, keeping the spot under the fingers (or the
  // middle of the view) where it was.
  useEffect(() => {
    const canvas = fabricRef.current;
    const container = containerRef.current;
    const wrapper = container?.querySelector(".gs-canvas-wrapper") as HTMLElement | null;
    if (!canvas || !container || !wrapper) return;
    if (startZoomRef.current !== null) {
      // Already drawn by the set-up; ignore the zoom from before it.
      if (Math.abs(zoom - startZoomRef.current) < 1e-3) startZoomRef.current = null;
      return;
    }
    const prev = drawnZoomRef.current;
    if (Math.abs(prev - zoom) < 1e-3) return;

    const box = container.getBoundingClientRect();
    const anchor = zoomAnchorRef.current ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    zoomAnchorRef.current = null;
    const before = wrapper.getBoundingClientRect();
    // The anchor in sheet coordinates at the old zoom.
    const sx = (anchor.x - before.left) / prev;
    const sy = (anchor.y - before.top) / prev;

    applyZoom(canvas, baseSizeRef.current, zoom);
    drawnZoomRef.current = zoom;

    const after = wrapper.getBoundingClientRect();
    container.scrollLeft += after.left + sx * zoom - anchor.x;
    container.scrollTop += after.top + sy * zoom - anchor.y;
  }, [zoom]);

  // Picked in a list, or let go with "Klar": show it on the sheet too. The
  // handles used to follow only taps on the canvas itself.
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas || rebuildingRef.current) return;
    const active = canvas.getActiveObject();
    if (active instanceof ActiveSelection) {
      if (active.getObjects().some((o) => getObjData(o)?.imageId === selectedImageId)) return;
    } else if ((getObjData(active)?.imageId ?? null) === selectedImageId) {
      return;
    }
    if (!selectedImageId) {
      canvas.discardActiveObject();
    } else {
      const obj = canvas.getObjects().find((o) => getObjData(o)?.imageId === selectedImageId && o.selectable);
      if (!obj) return;
      canvas.setActiveObject(obj);
    }
    canvas.requestRenderAll();
  }, [selectedImageId]);

  // A design picked in the phone's list may be off screen — the view is
  // small there, and smaller still with the list open. Bring it into view.
  useEffect(() => {
    if (!isMobile || !selectedImageId) return;
    const container = containerRef.current;
    const wrapper = container?.querySelector(".gs-canvas-wrapper") as HTMLElement | null;
    const img = useEditorStore.getState().images.find((i) => i.id === selectedImageId);
    if (!container || !wrapper || !img) return;
    const pxPerMm = (baseSizeRef.current.w * drawnZoomRef.current) / sheetSize.widthMm;
    const { bboxW, bboxH } = rotatedBboxMm(img.displayWidth, img.displayHeight, img.rotation);
    const left = wrapper.offsetLeft + img.positionX * pxPerMm;
    const top = wrapper.offsetTop + img.positionY * pxPerMm;
    const ins = viewInsets(true);
    const visible =
      top >= container.scrollTop &&
      top + bboxH * pxPerMm <= container.scrollTop + container.clientHeight - ins.bottom &&
      left >= container.scrollLeft &&
      left + bboxW * pxPerMm <= container.scrollLeft + container.clientWidth;
    if (visible) return;
    container.scrollTo({
      top: Math.max(0, top - ins.top),
      left: Math.max(0, left - ins.left),
      behavior: "smooth",
    });
  }, [isMobile, selectedImageId, sheetSize]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: theme.bgCanvas }}>
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        background: theme.bgCanvas,
        overflow: "auto",
        overflowAnchor: "none",
        padding: isMobile ? `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px` : 24,
        // Pinching zooms the sheet (handled above), never the page.
        touchAction: "pan-x pan-y",
      }}
    >
      {/* margin: auto centres the sheet while it is small and, unlike flex
          centring, never pushes a zoomed sheet past where scrolling reaches. */}
      <div
        className="gs-canvas-wrapper"
        style={{
          position: "relative",
          margin: "auto",
          flexShrink: 0,
          boxShadow: SHEET_FRAME,
          borderRadius: 0,
          lineHeight: 0,
          ...backdropStyle(canvasBg, whiteArt),
        }}
      >
        <canvas ref={canvasRef} />
        <Rulers widthMm={sheetSize.widthMm} heightMm={sheetSize.heightMm} pxPerMm={(base.w * zoom) / sheetSize.widthMm} />
      </div>
    </div>

      {/* One banner for everything that would print wrong */}
      <CanvasAlerts
        overflowCount={overflowCount}
        issues={stats.issues}
        onTidy={() => void arrangeSheet()}
        compact={isMobile}
      />

      {hideControls ? null : isMobile ? (
        // One button for how the sheet is shown; open, it floats above the
        // controls instead of covering the bottom of the sheet for good.
        <ViewMenu
          bg={canvasBg}
          onBg={setCanvasBg}
          dpi={showDpiOverlay}
          onDpi={setShowDpiOverlay}
        />
      ) : (
        <div style={CORNER}>
          <BackdropPicker value={canvasBg} onChange={setCanvasBg} />
          <DpiLegend
            visible={showDpiOverlay}
            onToggle={() => setShowDpiOverlay(!showDpiOverlay)}
          />
        </div>
      )}

      {/* Zoom, the whole sheet, or its width filling the view. */}
      {!hideControls && <ZoomControls
        zoom={zoom}
        onChange={setZoom}
        onFitWidth={() => {
          // Keep what is at the top of the view at the top; zooming about
          // the middle pushed the first row of designs out of sight.
          const box = containerRef.current?.getBoundingClientRect();
          if (box) zoomAnchorRef.current = { x: box.left, y: box.top };
          setZoom(fitZooms().width);
        }}
        onFitWhole={() => setZoom(fitZooms().whole)}
        bottom={isMobile ? 16 : 12}
      />}
    </div>
  );
}

/** A thin edge and a soft shadow: the film lifted off the table. */
const SHEET_FRAME = "0 0 0 1px rgba(16, 24, 40, 0.16), 0 8px 24px rgba(16, 24, 40, 0.10)";

/**
 * Centimetre rulers along the top and left of the sheet, so a 9 cm chest
 * logo reads as 9 cm. Ticks thin out when zoomed out, labels every 1-50 cm.
 */
function Rulers({ widthMm, heightMm, pxPerMm }: { widthMm: number; heightMm: number; pxPerMm: number }) {
  if (!(pxPerMm > 0)) return null;
  const pxPerCm = pxPerMm * 10;
  const label = [1, 2, 5, 10, 20, 50, 100].find((n) => n * pxPerCm >= 42) ?? 100;
  const minor = [1, 2, 5, 10, 20, 50].find((n) => n * pxPerCm >= 7 && label % n === 0) ?? label;
  const ruler = (lengthMm: number, vertical: boolean) => {
    const cm = Math.floor(lengthMm / 10);
    const ticks: React.ReactNode[] = [];
    for (let c = 0; c <= cm; c += minor) {
      const at = c * pxPerCm;
      const major = c % label === 0;
      const len = major ? 8 : 4;
      ticks.push(
        vertical ? (
          <line key={c} x1={16 - len} x2={16} y1={at} y2={at} stroke="rgba(0,0,0,0.35)" strokeWidth={1} />
        ) : (
          <line key={c} y1={16 - len} y2={16} x1={at} x2={at} stroke="rgba(0,0,0,0.35)" strokeWidth={1} />
        ),
      );
      if (major && c > 0) {
        ticks.push(
          vertical ? (
            <text key={`t${c}`} x={5} y={at - 3} fontSize={9} fill="rgba(0,0,0,0.5)" transform={`rotate(-90 5 ${at - 3})`} style={{ fontFamily: theme.fontFamily }}>
              {c}
            </text>
          ) : (
            <text key={`t${c}`} x={at + 3} y={8} fontSize={9} fill="rgba(0,0,0,0.5)" style={{ fontFamily: theme.fontFamily }}>
              {c}
            </text>
          ),
        );
      }
    }
    return ticks;
  };
  const w = widthMm * pxPerMm;
  const h = heightMm * pxPerMm;
  return (
    <>
      <svg width={w} height={16} style={{ position: "absolute", left: 0, top: -18, overflow: "visible", pointerEvents: "none" }} aria-hidden>
        {ruler(widthMm, false)}
        <text x={w + 4} y={13} fontSize={9} fill="rgba(0,0,0,0.45)" style={{ fontFamily: theme.fontFamily }}>cm</text>
      </svg>
      <svg width={16} height={h} style={{ position: "absolute", left: -18, top: 0, overflow: "visible", pointerEvents: "none" }} aria-hidden>
        {ruler(heightMm, true)}
      </svg>
    </>
  );
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

/** Bottom-left of the canvas: the backdrop picker above the DPI legend. */
const CORNER: React.CSSProperties = {
  position: "absolute",
  bottom: 12,
  left: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  zIndex: 5,
};

/** Floating controls over the canvas: light, like the sheet they sit on. */
const PANEL: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.97)",
  border: `1px solid ${theme.border}`,
  boxShadow: "0 4px 16px rgba(16, 24, 40, 0.12)",
  borderRadius: theme.radius,
  color: theme.text,
};

const PANEL_TITLE: React.CSSProperties = {
  fontSize: theme.fontSize.labelMd,
  fontWeight: theme.fontWeight.semibold,
  color: theme.text,
};

const SWATCH: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  border: "1px solid rgba(0,0,0,0.15)",
  padding: 0,
  cursor: "pointer",
  flexShrink: 0,
};

function swatchFill(bg: string): React.CSSProperties {
  if (bg !== "checks") return { background: bg };
  return { ...CHECKS, backgroundSize: "8px 8px", backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px" };
}

/** The garment colours to show the sheet on, plus one of your own. */
function BackdropSwatches({ value, onChange }: { value: string; onChange: (bg: string) => void }) {
  const custom = value !== "checks" && !BACKDROPS.some((b) => b.id === value);
  const ring = `0 0 0 2px #ffffff, 0 0 0 4px ${theme.accent}`;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {BACKDROPS.map((b) => {
        const active = value === b.id;
        return (
          <button
            key={b.id}
            type="button"
            title={b.label}
            aria-label={b.label}
            aria-pressed={active}
            onClick={() => onChange(b.id)}
            style={{ ...SWATCH, ...swatchFill(b.id === "checks" ? "checks" : b.color), boxShadow: active ? ring : "none" }}
          />
        );
      })}
      <label
        title="Egen färg"
        style={{
          ...SWATCH,
          position: "relative",
          background: custom ? value : "conic-gradient(#e53935, #fdd835, #43a047, #1e88e5, #8e24aa, #e53935)",
          boxShadow: custom ? ring : "none",
        }}
      >
        <input
          type="color"
          aria-label="Egen färg"
          value={custom ? value : "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
        />
      </label>
    </div>
  );
}

/** The computer's picker: always open beside the sheet, where there is room. */
function BackdropPicker({ value, onChange }: { value: string; onChange: (bg: string) => void }) {
  return (
    <div
      style={{
        ...PANEL,
        padding: "10px 12px",
        fontFamily: theme.fontFamily,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 224,
      }}
    >
      <span style={PANEL_TITLE}>Visa på plaggfärg</span>
      <BackdropSwatches value={value} onChange={onChange} />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        cursor: "pointer",
        fontSize: theme.fontSize.labelMd,
        fontWeight: theme.fontWeight.semibold,
        color: theme.text,
        whiteSpace: "nowrap",
      }}
    >
      {label}
      <span
        aria-hidden
        style={{
          position: "relative",
          width: 34,
          height: 20,
          borderRadius: 10,
          background: checked ? theme.accent : "rgba(0,0,0,0.18)",
          transition: "background 0.15s",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#ffffff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 0.15s",
          }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 1, height: 1, margin: 0 }}
      />
    </label>
  );
}

function DpiLevels() {
  const levels = [
    { label: `${DPI_LEVEL_LABELS.optimal} ≥ ${DPI_THRESHOLDS.optimal} DPI`, color: DPI_LEVEL_COLORS.optimal },
    { label: `${DPI_LEVEL_LABELS.good} ≥ ${DPI_THRESHOLDS.good} DPI`, color: DPI_LEVEL_COLORS.good },
    { label: `${DPI_LEVEL_LABELS.low} ≥ ${DPI_THRESHOLDS.low} DPI`, color: DPI_LEVEL_COLORS.low },
    { label: `${DPI_LEVEL_LABELS.bad} < ${DPI_THRESHOLDS.low} DPI`, color: DPI_LEVEL_COLORS.bad },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {levels.map((l) => (
        <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: l.color, flexShrink: 0 }} />
          <span style={{ color: theme.textMuted, fontSize: theme.fontSize.labelSm }}>{l.label}</span>
        </div>
      ))}
    </div>
  );
}

function DpiLegend({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <div
      style={{
        ...PANEL,
        padding: "8px 12px",
        fontFamily: theme.fontFamily,
        alignSelf: "flex-start",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Toggle label="DPI-kvalitet" checked={visible} onChange={() => onToggle()} />
      {visible && <DpiLevels />}
    </div>
  );
}

/**
 * The phone's one button for how the sheet is shown: garment colour and
 * the DPI check. Two dark panels used to sit on the bottom of the sheet.
 */
function ViewMenu({
  bg,
  onBg,
  dpi,
  onDpi,
}: {
  bg: string;
  onBg: (bg: string) => void;
  dpi: boolean;
  onDpi: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && <div aria-hidden onClick={() => setOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 6 }} />}
      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: 16,
          zIndex: 7,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        {open && (
          <div
            style={{
              ...PANEL,
              width: 236,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              fontFamily: theme.fontFamily,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={PANEL_TITLE}>Visa på plaggfärg</span>
              <BackdropSwatches value={bg} onChange={onBg} />
            </div>
            <div style={{ height: 1, background: theme.border }} />
            <Toggle label="Visa DPI-kvalitet" checked={dpi} onChange={onDpi} />
            {dpi && <DpiLevels />}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          style={{
            ...PANEL,
            height: 46,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px 0 11px",
            fontFamily: theme.fontFamily,
            fontSize: theme.fontSize.labelLg,
            fontWeight: theme.fontWeight.semibold,
            cursor: "pointer",
          }}
        >
          <span style={{ position: "relative", display: "flex" }}>
            <span style={{ ...SWATCH, width: 22, height: 22, ...swatchFill(bg), cursor: "inherit" }} />
            {dpi && (
              <span
                style={{
                  position: "absolute",
                  top: -2,
                  right: -3,
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: theme.accent,
                  border: "1.5px solid #ffffff",
                }}
              />
            )}
          </span>
          Visning
        </button>
      </div>
    </>
  );
}

/**
 * Everything the customer needs to fix before printing, in one place at
 * the top of the sheet — overlaps, designs off the film, copies that fall
 * past the end — each with the one-click fix next to it.
 */
function CanvasAlerts({
  overflowCount,
  issues,
  onTidy,
  compact,
}: {
  overflowCount: number;
  issues: { severity: "error" | "warning"; message: string }[];
  onTidy: () => void;
  /** A phone: edge to edge, so the text gets the width it needs. */
  compact?: boolean;
}) {
  const errors = issues.filter((i) => i.severity === "error");
  const hasOverflow = overflowCount > 0;
  if (errors.length === 0 && !hasOverflow) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: compact ? 8 : 12,
        left: compact ? 8 : "50%",
        right: compact ? 8 : undefined,
        transform: compact ? undefined : "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        zIndex: 6,
        maxWidth: compact ? undefined : "92%",
      }}
    >
      {hasOverflow && (
        <Alert>
          {overflowCount === 1
            ? "1 kopia får inte plats och skrivs inte ut."
            : `${overflowCount} kopior får inte plats och skrivs inte ut.`}{" "}
          Minska antalet eller välj ett längre ark.
        </Alert>
      )}
      {errors.map((issue, i) => (
        <Alert key={i} action={{ label: "Ordna om", onClick: onTidy }}>
          {issue.message}
        </Alert>
      ))}
    </div>
  );
}

function Alert({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      style={{
        background: "#fef2f2",
        border: "1px solid #f87171",
        color: "#991b1b",
        borderRadius: theme.radius,
        padding: "8px 12px",
        fontSize: theme.fontSize.labelMd,
        fontFamily: theme.fontFamily,
        fontWeight: theme.fontWeight.medium,
        boxShadow: theme.shadow,
        display: "flex",
        alignItems: "center",
        gap: 10,
        lineHeight: theme.lineHeight.normal,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {action && (
        <button
          onClick={action.onClick}
          style={{
            flexShrink: 0,
            padding: "4px 10px",
            border: "1px solid #f87171",
            borderRadius: theme.radiusSm,
            background: "#fff",
            color: "#991b1b",
            fontSize: theme.fontSize.labelMd,
            fontFamily: theme.fontFamily,
            fontWeight: theme.fontWeight.semibold,
            cursor: "pointer",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}


const ICON = {
  zoomOut: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M7.5 10.5h6M20 20l-4.5-4.5" />
    </svg>
  ),
  zoomIn: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M7.5 10.5h6M10.5 7.5v6M20 20l-4.5-4.5" />
    </svg>
  ),
  fitWidth: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 5v14M20.5 5v14M7.5 12h9M10 9l-3 3 3 3M14 9l3 3-3 3" />
    </svg>
  ),
  fitWhole: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  ),
};

/**
 * Zoom by steps, the whole sheet, or its width filling the view. Steps
 * multiply, so a tap does as much at 30 % as at 300 %; the old ±25 points
 * went from 25 % to 50 % in one tap and took ten taps to get anywhere big.
 */
function ZoomControls({
  zoom,
  onChange,
  onFitWidth,
  onFitWhole,
  bottom,
}: {
  zoom: number;
  onChange: (z: number) => void;
  /** Zoom so the sheet's width fills the view (designs at a readable size). */
  onFitWidth: () => void;
  onFitWhole: () => void;
  bottom: number;
}) {
  const btn: React.CSSProperties = {
    width: 36,
    height: 36,
    border: "none",
    borderRadius: 10,
    background: "transparent",
    color: theme.text,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    fontFamily: theme.fontFamily,
  };
  const atMin = zoom <= ZOOM_MIN + 1e-3;
  const atMax = zoom >= ZOOM_MAX - 1e-3;

  return (
    <div
      style={{
        ...PANEL,
        position: "absolute",
        bottom,
        right: 12,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 4,
        zIndex: 5,
      }}
    >
      <button type="button" onClick={() => onChange(zoom / ZOOM_STEP)} disabled={atMin} style={{ ...btn, opacity: atMin ? 0.35 : 1 }} aria-label="Zooma ut" title="Zooma ut">
        {ICON.zoomOut}
      </button>
      <button
        type="button"
        onClick={onFitWhole}
        style={{
          ...btn,
          width: "auto",
          minWidth: 46,
          padding: "0 2px",
          fontSize: theme.fontSize.labelLg,
          fontWeight: theme.fontWeight.semibold,
          fontVariantNumeric: "tabular-nums",
          color: theme.textMuted,
        }}
        aria-label="Visa hela arket"
        title="Visa hela arket"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={() => onChange(zoom * ZOOM_STEP)} disabled={atMax} style={{ ...btn, opacity: atMax ? 0.35 : 1 }} aria-label="Zooma in" title="Zooma in">
        {ICON.zoomIn}
      </button>
      <span style={{ width: 1, height: 22, background: theme.border, margin: "0 2px" }} />
      <button type="button" onClick={onFitWidth} style={btn} title="Fyll bredden" aria-label="Fyll bredden">
        {ICON.fitWidth}
      </button>
      <button type="button" onClick={onFitWhole} style={btn} title="Visa hela arket" aria-label="Visa hela arket">
        {ICON.fitWhole}
      </button>
    </div>
  );
}
