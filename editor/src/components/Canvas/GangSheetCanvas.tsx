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
} from "../../utils/units";
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

export function GangSheetCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<number>(1);
  const syncGenRef = useRef<number>(0);
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
  } = useEditorStore();

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
    canvas.on("selection:cleared", () => selectImage(null));

    /**
     * Persist one object's absolute transform to the store per the shared
     * placement contract: displayWidth/Height = unrotated dims (mm),
     * rotation = angle (deg), positionX/Y = top-left of the rotated bbox.
     * `centerX/centerY` are the object's absolute center in canvas px,
     * `angle` in degrees, `scaleX/scaleY` absolute scale.
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
    ) => {
      const displayWidth = canvasPxToMm(widthPx * Math.abs(scaleX), scaleFactor);
      const displayHeight = canvasPxToMm(heightPx * Math.abs(scaleY), scaleFactor);
      const rotation = angle;
      const { bboxW, bboxH } = rotatedBboxMm(displayWidth, displayHeight, rotation);
      updateImage(imageId, {
        positionX: canvasPxToMm(centerX, scaleFactor) - bboxW / 2,
        positionY: canvasPxToMm(centerY, scaleFactor) - bboxH / 2,
        displayWidth,
        displayHeight,
        rotation,
      });
    };

    canvas.on("object:modified", (e) => {
      const target = e.target;
      if (!target) return;

      if (target instanceof ActiveSelection) {
        // Multi-select: children's left/top are relative to the group.
        // Compose each child's transform with the group matrix to get
        // absolute (center-based) coordinates.
        for (const child of target.getObjects()) {
          const imageId = getObjData(child)?.imageId;
          if (!imageId) continue;
          const decomposed = util.qrDecompose(child.calcTransformMatrix());
          persistTransform(
            imageId,
            child.width || 0,
            child.height || 0,
            decomposed.translateX,
            decomposed.translateY,
            decomposed.angle,
            decomposed.scaleX,
            decomposed.scaleY,
          );
        }
        return;
      }

      const imageId = getObjData(target)?.imageId;
      if (!imageId) return;
      // Objects are created with originX/originY "center", so left/top IS the center
      persistTransform(
        imageId,
        target.width || 0,
        target.height || 0,
        target.left || 0,
        target.top || 0,
        target.angle || 0,
        target.scaleX || 1,
        target.scaleY || 1,
      );
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

    const scaleFactor = scaleRef.current;
    const sheetW = sheetSize.widthMm;
    const sheetH = sheetSize.heightMm;

    // Remove existing image objects and DPI overlays
    const toRemove = canvas
      .getObjects()
      .filter((obj) => getObjData(obj)?.imageId || getObjData(obj)?.dpiOverlay);
    toRemove.forEach((obj) => canvas.remove(obj));

    let overflow = 0;

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

      FabricImage.fromURL(url, { crossOrigin: "anonymous" }).then(
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

            if (doesNotFit) {
              canvas.add(
                new Rect({
                  left: mmToCanvasPx(pos.x, scaleFactor),
                  top: mmToCanvasPx(pos.y, scaleFactor),
                  width: mmToCanvasPx(bboxW, scaleFactor),
                  height: mmToCanvasPx(bboxH, scaleFactor),
                  fill: "rgba(239,68,68,0.25)",
                  stroke: "#ef4444",
                  strokeWidth: 2,
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
          if (!isStale()) canvas.renderAll();
        },
      );
    }

    setOverflowCount(overflow);
  }, [images, sheetSize, showDpiOverlay]);

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
          backgroundImage:
            "linear-gradient(45deg, #eee 25%, transparent 25%), " +
            "linear-gradient(-45deg, #eee 25%, transparent 25%), " +
            "linear-gradient(45deg, transparent 75%, #eee 75%), " +
            "linear-gradient(-45deg, transparent 75%, #eee 75%)",
          backgroundSize: "24px 24px",
          backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0px",
          backgroundColor: "#fff",
          transformOrigin: "center center",
          transition: "transform 0.15s ease",
        }}
      >
        <canvas ref={canvasRef} />
      </div>

      {/* Overflow warning — copies outside the sheet won't print */}
      {overflowCount > 0 && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#fef2f2",
            border: "1px solid #f87171",
            color: "#991b1b",
            borderRadius: theme.radius,
            padding: "8px 14px",
            fontSize: theme.fontSize.labelMd,
            fontFamily: theme.fontFamily,
            fontWeight: theme.fontWeight.semibold,
            zIndex: 6,
            boxShadow: theme.shadow,
            maxWidth: "90%",
            textAlign: "center",
          }}
        >
          {overflowCount === 1
            ? "1 kopia får inte plats på arket och kommer inte att skrivas ut."
            : `${overflowCount} kopior får inte plats på arket och kommer inte att skrivas ut.`}{" "}
          Minska antal eller välj ett större ark.
        </div>
      )}

      {/* DPI Legend */}
      <DpiLegend
        visible={showDpiOverlay}
        onToggle={() => setShowDpiOverlay(!showDpiOverlay)}
      />
    </div>
  );
}

function DpiLegend({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) {
  const levels = [
    { label: "Optimal ≥ 300 DPI", color: DPI_LEVEL_COLORS.optimal },
    { label: "Bra ≥ 250 DPI", color: DPI_LEVEL_COLORS.good },
    { label: "Dålig ≥ 200 DPI", color: DPI_LEVEL_COLORS.bad },
    { label: "Otillräcklig < 200 DPI", color: DPI_LEVEL_COLORS.terrible },
  ];

  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        background: "rgba(25, 28, 30, 0.88)",
        backdropFilter: "blur(12px)",
        borderRadius: theme.radius,
        padding: "10px 14px",
        fontSize: theme.fontSize.labelSm,
        fontFamily: theme.fontFamily,
        color: "#ffffff",
        zIndex: 5,
        minWidth: 170,
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
        }}
      >
        <input
          type="checkbox"
          checked={visible}
          onChange={onToggle}
          style={{ accentColor: theme.accent }}
        />
        Visa DPI-kvalitet
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
