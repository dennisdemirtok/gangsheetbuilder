import { useEffect, useRef, useState } from "react";
import { Canvas, FabricImage, FabricObject, Rect, FabricText, ActiveSelection, util } from "fabric";
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
  // Mid-grey checks: white logos vanished on a white one, and DTF
  // prints white as often as any colour.
  backgroundImage:
    "linear-gradient(45deg, #b4b4b4 25%, transparent 25%), " +
    "linear-gradient(-45deg, #b4b4b4 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, #b4b4b4 75%), " +
    "linear-gradient(-45deg, transparent 75%, #b4b4b4 75%)",
  backgroundSize: "24px 24px",
  backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0px",
  backgroundColor: "#cdcdcd",
};

function backdropStyle(bg: string): React.CSSProperties {
  if (bg === "checks" || !/^#[0-9a-f]{6}$/i.test(bg)) return CHECKS;
  return { backgroundImage: "none", backgroundColor: bg };
}

export function GangSheetCanvas() {
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
  const [overflowCount, setOverflowCount] = useState(0);

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

  // Collision + out-of-bounds state, recomputed whenever anything moves.
  const stats = useSheetStats();
  const isMobile = useIsMobile();

  // Initialize canvas
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const scaleFactor = calculateScaleFactor(
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
                  fill: "transparent", stroke: color, strokeWidth: 3,
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

    const spread = () => {
      const [a, b] = [...points.values()];
      if (!a || !b) return 0;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size === 2) {
        startSpread = spread();
        startZoom = useEditorStore.getState().zoom;
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size !== 2 || startSpread <= 0) return;
      e.preventDefault();
      setZoom(startZoom * (spread() / startSpread));
    };

    const onUp = (e: PointerEvent) => {
      points.delete(e.pointerId);
      if (points.size < 2) startSpread = 0;
    };

    container.addEventListener("pointerdown", onDown);
    container.addEventListener("pointermove", onMove, { passive: false });
    container.addEventListener("pointerup", onUp);
    container.addEventListener("pointercancel", onUp);
    return () => {
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onUp);
      container.removeEventListener("pointercancel", onUp);
    };
  }, [setZoom]);

  // Apply zoom via CSS transform (not Fabric zoom — simpler, works with all objects)
  useEffect(() => {
    const wrapper = containerRef.current?.querySelector(".gs-canvas-wrapper") as HTMLElement;
    if (wrapper) {
      wrapper.style.transform = `scale(${zoom})`;
    }
  }, [zoom]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: theme.bgCanvas,
        position: "relative",
        overflow: "auto",
      }}
    >
      <div
        className="gs-canvas-wrapper"
        style={{
          boxShadow: theme.shadowLg,
          borderRadius: 0,
          lineHeight: 0,
          ...backdropStyle(canvasBg),
          transformOrigin: "center center",
          transition: "transform 0.15s ease",
        }}
      >
        <canvas ref={canvasRef} />
      </div>

      {/* One banner for everything that would print wrong */}
      <CanvasAlerts
        overflowCount={overflowCount}
        issues={stats.issues}
        onTidy={() => void arrangeSheet()}
      />

      <div style={CORNER}>
        <BackdropPicker value={canvasBg} onChange={setCanvasBg} collapsible={isMobile} />
        <DpiLegend
          visible={showDpiOverlay}
          onToggle={() => setShowDpiOverlay(!showDpiOverlay)}
        />
      </div>

      {/* Pinch works, but nothing on screen said so. */}
      {isMobile && (
        <ZoomControls zoom={zoom} onChange={setZoom} />
      )}
    </div>
  );
}

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

const PANEL: React.CSSProperties = {
  background: "rgba(25, 28, 30, 0.88)",
  backdropFilter: "blur(12px)",
  borderRadius: theme.radius,
};

function BackdropPicker({
  value,
  onChange,
  collapsible,
}: {
  value: string;
  onChange: (bg: string) => void;
  /** Phones: one small button until tapped — open, it covered the sheet. */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const custom = value !== "checks" && !BACKDROPS.some((b) => b.id === value);
  const pick = (bg: string) => {
    onChange(bg);
    if (collapsible) setOpen(false);
  };
  const current =
    value === "checks"
      ? { ...CHECKS, backgroundSize: "8px 8px", backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px" }
      : { background: value };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          ...PANEL,
          alignSelf: "flex-start",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: "none",
          color: "#ffffff",
          fontFamily: theme.fontFamily,
          fontSize: theme.fontSize.labelMd,
          fontWeight: theme.fontWeight.semibold,
          cursor: "pointer",
        }}
      >
        <span style={{ ...SWATCH, ...current, cursor: "inherit" }} />
        Plaggfärg
      </button>
    );
  }

  return (
    <div
      style={{
        ...PANEL,
        padding: "8px 10px",
        fontFamily: theme.fontFamily,
        color: "#ffffff",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span style={{ fontSize: theme.fontSize.labelMd, fontWeight: theme.fontWeight.semibold }}>
        Visa på plaggfärg
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 196 }}>
        {BACKDROPS.map((b) => {
          const active = value === b.id;
          return (
            <button
              key={b.id}
              type="button"
              title={b.label}
              aria-label={b.label}
              aria-pressed={active}
              onClick={() => pick(b.id)}
              style={{
                ...SWATCH,
                ...(b.id === "checks" ? { ...CHECKS, backgroundSize: "8px 8px", backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px" } : { background: b.color }),
                boxShadow: active ? `0 0 0 2px rgba(25,28,30,1), 0 0 0 4px ${theme.accent}` : "none",
              }}
            />
          );
        })}
        <label
          title="Egen färg"
          style={{
            ...SWATCH,
            position: "relative",
            background: custom
              ? value
              : "conic-gradient(#e53935, #fdd835, #43a047, #1e88e5, #8e24aa, #e53935)",
            boxShadow: custom ? `0 0 0 2px rgba(25,28,30,1), 0 0 0 4px ${theme.accent}` : "none",
            cursor: "pointer",
          }}
        >
          <input
            type="color"
            aria-label="Egen färg"
            value={custom ? value : "#ffffff"}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => collapsible && setOpen(false)}
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
          />
        </label>
      </div>
    </div>
  );
}

const SWATCH: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.35)",
  padding: 0,
  cursor: "pointer",
  flexShrink: 0,
};

function DpiLegend({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) {
  const levels = [
    {
      label: `${DPI_LEVEL_LABELS.optimal} ≥ ${DPI_THRESHOLDS.optimal} DPI`,
      color: DPI_LEVEL_COLORS.optimal,
    },
    {
      label: `${DPI_LEVEL_LABELS.good} ≥ ${DPI_THRESHOLDS.good} DPI`,
      color: DPI_LEVEL_COLORS.good,
    },
    {
      label: `${DPI_LEVEL_LABELS.low} ≥ ${DPI_THRESHOLDS.low} DPI`,
      color: DPI_LEVEL_COLORS.low,
    },
    {
      label: `${DPI_LEVEL_LABELS.bad} < ${DPI_THRESHOLDS.low} DPI`,
      color: DPI_LEVEL_COLORS.bad,
    },
  ];

  return (
    <div
      style={{
        ...PANEL,
        padding: visible ? "10px 14px" : "6px 12px",
        fontSize: theme.fontSize.labelSm,
        fontFamily: theme.fontFamily,
        color: "#ffffff",
        alignSelf: "flex-start",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          marginBottom: visible ? 8 : 0,
          fontWeight: theme.fontWeight.semibold,
          fontSize: theme.fontSize.labelMd,
          color: "#ffffff",
          whiteSpace: "nowrap",
        }}
      >
        <input
          type="checkbox"
          checked={visible}
          onChange={onToggle}
          style={{ accentColor: theme.accent }}
        />
        DPI-kvalitet
      </label>
      {visible && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {levels.map((l) => (
            <div
              key={l.label}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: l.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "rgba(255,255,255,0.75)", fontSize: theme.fontSize.labelXs }}>
                {l.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
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
}: {
  overflowCount: number;
  issues: { severity: "error" | "warning"; message: string }[];
  onTidy: () => void;
}) {
  const errors = issues.filter((i) => i.severity === "error");
  const hasOverflow = overflowCount > 0;
  if (errors.length === 0 && !hasOverflow) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        zIndex: 6,
        maxWidth: "92%",
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


/** Zoom for the phone shell, which has no toolbar to put it in. */
function ZoomControls({
  zoom,
  onChange,
}: {
  zoom: number;
  onChange: (z: number) => void;
}) {
  const btn: React.CSSProperties = {
    width: 40,
    height: 40,
    border: "none",
    background: "transparent",
    color: "#fff",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
    fontFamily: theme.fontFamily,
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        right: 12,
        display: "flex",
        alignItems: "center",
        background: "rgba(25, 28, 30, 0.88)",
        backdropFilter: "blur(12px)",
        borderRadius: theme.radius,
        zIndex: 5,
        overflow: "hidden",
      }}
    >
      <button onClick={() => onChange(zoom - 0.25)} style={btn} aria-label="Zooma ut">
        −
      </button>
      <button
        onClick={() => onChange(1)}
        style={{
          ...btn,
          width: "auto",
          padding: "0 4px",
          fontSize: theme.fontSize.labelMd,
          color: "rgba(255,255,255,0.75)",
        }}
        aria-label="Återställ zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button onClick={() => onChange(zoom + 0.25)} style={btn} aria-label="Zooma in">
        +
      </button>
    </div>
  );
}
