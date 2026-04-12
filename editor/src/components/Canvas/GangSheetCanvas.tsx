import { useEffect, useRef } from "react";
import { Canvas, FabricImage, Rect, FabricText } from "fabric";
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

export function GangSheetCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<number>(1);

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
      if (obj?.data?.imageId) selectImage(obj.data.imageId);
    });
    canvas.on("selection:updated", (e) => {
      const obj = e.selected?.[0];
      if (obj?.data?.imageId) selectImage(obj.data.imageId);
    });
    canvas.on("selection:cleared", () => selectImage(null));

    canvas.on("object:modified", (e) => {
      const obj = e.target;
      if (!obj?.data?.imageId) return;
      updateImage(obj.data.imageId, {
        positionX: canvasPxToMm(obj.left || 0, scaleFactor),
        positionY: canvasPxToMm(obj.top || 0, scaleFactor),
        displayWidth: canvasPxToMm(
          (obj.width || 0) * (obj.scaleX || 1),
          scaleFactor,
        ),
        displayHeight: canvasPxToMm(
          (obj.height || 0) * (obj.scaleY || 1),
          scaleFactor,
        ),
      });
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

    const scaleFactor = scaleRef.current;
    const sheetW = sheetSize.widthMm;
    const sheetH = sheetSize.heightMm;

    // Remove existing image objects and DPI overlays
    const toRemove = canvas
      .getObjects()
      .filter((obj) => obj.data?.imageId || obj.data?.dpiOverlay);
    toRemove.forEach((obj) => canvas.remove(obj));

    for (const img of images) {
      if (!img.placed) continue;
      const url = img.bgRemovedUrl || img.thumbnailUrl;
      const gap = img.marginMm || 5;
      const qty = img.quantity || 1;

      // Calculate grid positions for all copies
      const cellW = img.displayWidth + gap;
      const cellH = img.displayHeight + gap;
      const cols = Math.floor((sheetW - gap) / cellW) || 1;

      const positions: { x: number; y: number }[] = [];
      for (let q = 0; q < qty; q++) {
        const col = q % cols;
        const row = Math.floor(q / cols);
        positions.push({
          x: gap + col * cellW,
          y: gap + row * cellH,
        });
      }

      // If only 1 copy, use the stored position
      if (qty === 1) {
        positions[0] = { x: img.positionX, y: img.positionY };
      }

      FabricImage.fromURL(url, { crossOrigin: "anonymous" }).then(
        (fabricImg) => {
          const displayW = mmToCanvasPx(img.displayWidth, scaleFactor);
          const displayH = mmToCanvasPx(img.displayHeight, scaleFactor);

          for (let i = 0; i < positions.length; i++) {
            const pos = positions[i]!;
            const imgLeft = mmToCanvasPx(pos.x, scaleFactor);
            const imgTop = mmToCanvasPx(pos.y, scaleFactor);

            // Clone for copies > 0
            const fabricObj = i === 0 ? fabricImg : (fabricImg.clone as any)();

            // For async clone in newer Fabric, handle both sync and promise
            const applySettings = (obj: any) => {
              obj.set({
                left: imgLeft,
                top: imgTop,
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
                opacity: i === 0 ? 1 : 0.95,
              });
              canvas.add(obj);

              // DPI overlay on first copy only
              if (showDpiOverlay && i === 0) {
                const dpi = calculateDisplayDpi(img.widthPx, img.displayWidth);
                const color = getDpiColor(dpi);
                canvas.add(
                  new Rect({
                    left: imgLeft - 2, top: imgTop - 2,
                    width: displayW + 4, height: displayH + 4,
                    fill: "transparent", stroke: color, strokeWidth: 3,
                    selectable: false, evented: false,
                    data: { dpiOverlay: true },
                  }),
                );
                canvas.add(
                  new FabricText(`${dpi}`, {
                    left: imgLeft + 4, top: imgTop + 4,
                    fontSize: 11, fontFamily: "system-ui", fontWeight: "bold",
                    fill: "#fff", backgroundColor: color, padding: 2,
                    selectable: false, evented: false,
                    data: { dpiOverlay: true },
                  }),
                );
              }
            };

            if (i === 0) {
              applySettings(fabricObj);
            } else {
              // Clone the image for additional copies
              FabricImage.fromURL(url, { crossOrigin: "anonymous" }).then(
                (clonedImg) => {
                  applySettings(clonedImg);
                  canvas.renderAll();
                },
              );
            }
          }

          canvas.renderAll();
        },
      );
    }
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
          borderRadius: theme.radiusSm,
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
