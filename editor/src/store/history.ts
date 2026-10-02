import { useSyncExternalStore } from "react";
import { useEditorStore, type EditorImage, type SheetSize } from "./editorStore";

/**
 * Undo and redo for the sheet.
 *
 * Each change to the designs or the sheet length is a step. Changes that
 * land within half a second of each other count as one — a drag and the
 * nudge to a free spot that follows it, or a burst of typing in a size
 * field. Switching sheets starts over: undo never reaches into another
 * sheet. Before this, a wrong click on "Ordna arket" could not be taken
 * back at all.
 */

interface Snapshot {
  images: EditorImage[];
  sheetSize: SheetSize;
}

const LIMIT = 60;
const MERGE_MS = 500;

let past: Snapshot[] = [];
let future: Snapshot[] = [];
let restoring = false;
let lastChange = 0;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  for (const l of listeners) l();
}

function activeSheetId(state: { sheets: { id: string }[]; activeSheetIndex: number }) {
  return state.sheets[state.activeSheetIndex]?.id;
}

useEditorStore.subscribe((state, prev) => {
  if (restoring) return;
  if (state.sessionId !== prev.sessionId || activeSheetId(state) !== activeSheetId(prev)) {
    if (past.length > 0 || future.length > 0) {
      past = [];
      future = [];
      notify();
    }
    return;
  }
  if (state.images === prev.images && state.sheetSize === prev.sheetSize) return;

  const now = Date.now();
  if (past.length === 0 || now - lastChange > MERGE_MS) {
    past.push({ images: prev.images, sheetSize: prev.sheetSize });
    if (past.length > LIMIT) past.shift();
  }
  lastChange = now;
  future = [];
  notify();
});

function step(from: Snapshot[], to: Snapshot[]) {
  const snap = from.pop();
  if (!snap) return;
  const state = useEditorStore.getState();
  to.push({ images: state.images, sheetSize: state.sheetSize });
  restoring = true;
  try {
    state.restoreSnapshot(snap.images, snap.sheetSize);
  } finally {
    restoring = false;
  }
  // The next edit is a step of its own, however soon it comes.
  lastChange = 0;
  notify();
}

export function undo() {
  step(past, future);
}

export function redo() {
  step(future, past);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHistory(): { canUndo: boolean; canRedo: boolean } {
  useSyncExternalStore(subscribe, () => version);
  return { canUndo: past.length > 0, canRedo: future.length > 0 };
}

/** "⌘Z" on a Mac, "Ctrl+Z" elsewhere — for tooltips. */
export const UNDO_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl+Z";
export const REDO_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? "⇧⌘Z" : "Ctrl+Y";
