import { useMemo } from "react";
import type { EditorImage, SheetSize } from "../store/editorStore";
import { groupKey, useEditorStore } from "../store/editorStore";
import {
  EDGE_MARGIN_MM,
  contentBottomMm,
  findOverlappingIds,
  imageBbox,
  isOutsidePrintable,
  printableArea,
  utilization,
} from "./layout";
import { calculateDisplayDpi, getDpiLevel } from "./units";

export interface SheetIssue {
  kind: "overlap" | "outside" | "lowDpi";
  severity: "error" | "warning";
  message: string;
  imageIds: string[];
}

export interface SheetStats {
  /** Ids of designs that sit on top of another design. */
  overlappingIds: Set<string>;
  /** Ids of designs that reach past the printable area. */
  outsideIds: Set<string>;
  /** Share of the printable area covered, 0–1. */
  used: number;
  /** Unused film below the lowest design, in mm. */
  freeTailMm: number;
  issues: SheetIssue[];
  /** Nothing would print wrong. Warnings alone still count as ready. */
  ready: boolean;
}

export function computeSheetStats(
  images: EditorImage[],
  sheetSize: SheetSize,
): SheetStats {
  const placed = images.filter((img) => img.placed);
  const boxes = placed.map(imageBbox);

  const overlappingIds = findOverlappingIds(placed);
  const outsideIds = new Set(
    placed.filter((img) => isOutsidePrintable(img, sheetSize)).map((i) => i.id),
  );

  // One warning per design, not per copy — 45 copies of one logo is
  // still a single thing for the customer to fix.
  const lowDpiGroups = new Map<string, { dpi: number; name: string; ids: string[] }>();
  for (const img of placed) {
    const dpi = calculateDisplayDpi(img.widthPx, img.displayWidth);
    if (getDpiLevel(dpi) !== "bad") continue;
    const key = groupKey(img);
    const entry = lowDpiGroups.get(key);
    if (entry) entry.ids.push(img.id);
    else lowDpiGroups.set(key, { dpi, name: img.filename, ids: [img.id] });
  }

  const area = printableArea(sheetSize);
  const bottom = contentBottomMm(boxes);
  const freeTailMm = boxes.length
    ? Math.max(0, area.y + area.h - bottom)
    : area.h;

  const issues: SheetIssue[] = [];

  if (overlappingIds.size > 0) {
    issues.push({
      kind: "overlap",
      severity: "error",
      message:
        overlappingIds.size === 2
          ? "Två motiv ligger ovanpå varandra och skrivs ut så."
          : `${overlappingIds.size} motiv ligger ovanpå varandra och skrivs ut så.`,
      imageIds: [...overlappingIds],
    });
  }

  if (outsideIds.size > 0) {
    issues.push({
      kind: "outside",
      severity: "error",
      message: `${outsideIds.size} motiv ligger utanför det tryckbara området (${EDGE_MARGIN_MM} mm från kanten).`,
      imageIds: [...outsideIds],
    });
  }

  for (const [, entry] of lowDpiGroups) {
    issues.push({
      kind: "lowDpi",
      severity: "warning",
      message: `"${entry.name}" är ${entry.dpi} DPI i vald storlek och blir suddig i tryck.`,
      imageIds: entry.ids,
    });
  }

  return {
    overlappingIds,
    outsideIds,
    used: utilization(boxes, sheetSize),
    freeTailMm,
    issues,
    ready: !issues.some((i) => i.severity === "error"),
  };
}


/**
 * Sheet health for the current editor state.
 *
 * Four components need these numbers — the canvas, the design list, the
 * insight panel and the cart button. Each used to run the whole scan in
 * its own useMemo, so a single edit computed the same answer four times.
 * One cached result serves them all.
 */
let cache: {
  images: EditorImage[];
  sheetSize: SheetSize;
  stats: SheetStats;
} | null = null;

export function useSheetStats(): SheetStats {
  const images = useEditorStore((s) => s.images);
  const sheetSize = useEditorStore((s) => s.sheetSize);

  return useMemo(() => {
    if (cache && cache.images === images && cache.sheetSize === sheetSize) {
      return cache.stats;
    }
    const stats = computeSheetStats(images, sheetSize);
    cache = { images, sheetSize, stats };
    return stats;
  }, [images, sheetSize]);
}
