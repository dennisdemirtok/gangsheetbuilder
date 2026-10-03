import { useEditorStore, type EditorImage } from "../store/editorStore";
import { ensureGangSheet, getAppProxyUrl, uploadImage } from "../services/api";
import { renderTextAtHeight } from "../utils/textRender";
import { showToast } from "../utils/toast";
import type { Graphic, OrderProgress } from "./order";

/**
 * Names and numbers in the builder: each piece drawn at 300 DPI, uploaded
 * to this sheet and nested onto it with the rest — the sheet grows if it
 * has to. Each stays a text design, so it can be edited like any text.
 */
export async function addGraphicsToSheet(graphics: Graphic[], onProgress: (p: OrderProgress) => void): Promise<void> {
  const usable = graphics.filter((g) => !g.tooWide);
  const total = usable.length;
  let done = 0;
  onProgress({ step: "draw", done, total });

  const state = useEditorStore.getState();
  const gsId = await ensureGangSheet(state.sessionId, state.sheetSize.widthMm, state.sheetSize.heightMm, state.filmType, state.gangSheetId);
  if (gsId !== state.gangSheetId) state.setGangSheetId(gsId);
  const base = getAppProxyUrl();
  const abs = (url: string) => (url?.startsWith("/") ? base + url : url);

  const entries: { image: EditorImage; count: number }[] = [];
  const queue = [...usable];
  const worker = async () => {
    while (queue.length > 0) {
      const g = queue.shift()!;
      const drawn = await renderTextAtHeight(g.spec, g.heightCm * 10);
      if (!drawn) throw new Error(`Kunde inte rita "${g.text}"`);
      const blob: Blob | null = await new Promise((r) => drawn.canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error(`Kunde inte spara "${g.text}"`);
      onProgress({ step: "upload", done, total });
      const kind = g.kind === "name" ? "namn" : "nummer";
      const file = new File([blob], `${kind}-${g.text.replace(/[^\wåäöÅÄÖ-]+/g, "_").slice(0, 24) || "x"}.png`, { type: "image/png" });
      const result = await uploadImage(file, state.sessionId, gsId);
      const mm = drawn.mmPerPx;
      const dpi = Math.round(25.4 / mm);
      entries.push({
        count: g.count,
        image: {
          id: result.imageId || result.id,
          dbId: result.id,
          groupId: "grp_" + Math.random().toString(36).slice(2, 10),
          filename: `${g.kind === "name" ? "Namn" : "Nummer"}: ${g.text}`,
          thumbnailUrl: abs(result.thumbnailUrl),
          originalUrl: abs(result.originalUrl),
          widthPx: result.width,
          heightPx: result.height,
          dpiX: dpi,
          dpiY: dpi,
          positionX: 0,
          positionY: 0,
          displayWidth: result.width * mm,
          displayHeight: result.height * mm,
          rotation: 0,
          flipX: false,
          flipY: false,
          quantity: 1,
          marginMm: useEditorStore.getState().gapMm,
          bgRemoved: true,
          placed: true,
          text: { ...g.spec, widthMm: result.width * mm },
        },
      });
      done++;
      onProgress({ step: "upload", done, total });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, usable.length) }, worker));

  onProgress({ step: "sheet", done, total });
  const s = useEditorStore.getState();
  const result = s.addDesigns(entries, { floor: s.sheetSize, keepExisting: true });
  if (result.overflow > 0) {
    showToast(`${result.overflow} tryck fick inte plats på arket. Lägg dem på ett nytt ark.`, "warning");
  }
}
