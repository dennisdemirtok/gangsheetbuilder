// API service for communicating with the app proxy backend

let appProxyUrl = "";

export function setAppProxyUrl(url: string) {
  appProxyUrl = url;
}

export function getAppProxyUrl(): string {
  if (appProxyUrl) return appProxyUrl;
  const root = document.getElementById("gangsheet-editor-root");
  const url = root?.dataset.appProxyUrl || "";
  appProxyUrl = url;
  return url;
}

function getBaseUrl(): string {
  return getAppProxyUrl();
}

async function fetchApi(path: string, options: RequestInit = {}): Promise<any> {
  const base = getBaseUrl();
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

// Get presigned upload URL
export async function getPresignedUploadUrl(
  sessionId: string,
  filename: string,
  contentType: string,
): Promise<{ uploadUrl: string; imageId: string; key: string }> {
  return fetchApi("/api/presign", {
    method: "POST",
    body: JSON.stringify({ sessionId, filename, contentType }),
  });
}

// Upload file directly to R2 via presigned URL
export async function uploadToR2(
  presignedUrl: string,
  file: File,
): Promise<void> {
  await fetch(presignedUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });
}

/**
 * Ensure a gangSheet exists. Creates one if not.
 * Returns the gangSheetId.
 */
export async function ensureGangSheet(
  sessionId: string,
  widthMm: number,
  heightMm: number,
  filmType: string,
  currentGangSheetId: string | null,
): Promise<string> {
  if (currentGangSheetId) return currentGangSheetId;

  const result = await createGangSheet({
    sessionId,
    widthMm,
    heightMm,
    filmType,
  });
  return result.gangSheet.id;
}

// Upload file via multipart
/** Where an upload is: bytes going up, then the server converting it. */
export interface UploadProgress {
  phase: "upload" | "processing";
  /** 0-1 of the bytes sent. */
  sent: number;
}

/**
 * Upload one design. XMLHttpRequest rather than fetch, because only XHR
 * reports bytes sent: a 40 MB EPS used to sit on "Laddar upp…" with no
 * sign of life. After the last byte the server converts and trims the
 * file, which `phase: "processing"` reports.
 */
export function uploadImage(
  file: File,
  sessionId: string,
  gangSheetId: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<any> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("sessionId", sessionId);
  formData.append("gangSheetId", gangSheetId);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${getBaseUrl()}/api/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ phase: "upload", sent: e.loaded / Math.max(1, e.total) });
    };
    xhr.upload.onload = () => onProgress?.({ phase: "processing", sent: 1 });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed: ${xhr.statusText || xhr.status}`));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error("Servern svarade inte som väntat"));
      }
    };
    xhr.onerror = () => reject(new Error("Nätverksfel, kontrollera anslutningen"));
    xhr.send(formData);
  });
}

// Create a new gang sheet
export async function createGangSheet(data: {
  sessionId: string;
  widthMm: number;
  heightMm: number;
  filmType: string;
}): Promise<any> {
  return fetchApi("/api/gang-sheet", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

interface PlacementPayloadImage {
  id: string;
  dbId?: string;
  groupId?: string;
  positionX: number;
  positionY: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  quantity: number;
  marginMm?: number;
  /** Set when the customer uses the background-free version. */
  bgRemovedUrl?: string;
}

/**
 * Serialize the current placements to the save payload.
 * Shared by AddToCartButton and AutoBuildButton so cart and
 * auto-build send byte-identical state to the backend.
 *
 * Copies of one design are separate images in the editor but a single row
 * in the database — they share a dbId. Collapse them into one entry and
 * send every copy's position in `placements`, otherwise each copy would
 * overwrite the previous one's position and only one would be printed.
 */
export function buildPlacementsPayload(
  images: PlacementPayloadImage[],
  sheetSize: { widthMm: number; heightMm: number },
  filmType: string,
): any {
  const byRecord = new Map<string, PlacementPayloadImage[]>();
  for (const img of images) {
    const key = img.dbId || img.id;
    const existing = byRecord.get(key);
    if (existing) existing.push(img);
    else byRecord.set(key, [img]);
  }

  const payloadImages = [...byRecord.entries()].map(([id, copies]) => {
    const first = copies[0]!;
    return {
      id,
      positionX: first.positionX,
      positionY: first.positionY,
      displayWidth: first.displayWidth,
      displayHeight: first.displayHeight,
      rotation: first.rotation,
      flipX: first.flipX,
      flipY: first.flipY,
      quantity: copies.length,
      marginMm: first.marginMm ?? 5,
      // Print the background-free version only if the customer kept it —
      // they can take a removed background back in the guide.
      useBgRemoved: Boolean(first.bgRemovedUrl),
      // Each copy's own rotation: the packer turns single copies 90°, and
      // the export used to print every copy at the first one's angle.
      placements: copies.map((c) => ({ xMm: c.positionX, yMm: c.positionY, rotation: c.rotation })),
    };
  });

  return {
    filmType,
    widthMm: sheetSize.widthMm,
    heightMm: sheetSize.heightMm,
    linkImages: true, // Signal to backend to link unlinked images
    images: payloadImages,
  };
}

// Update gang sheet (save canvas state)
export async function saveGangSheet(
  id: string,
  data: any,
): Promise<any> {
  return fetchApi(`/api/gang-sheet/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// Run auto-build
export async function autoBuild(data: {
  gangSheetId: string;
  sheetWidthMm: number;
  sheetHeightMm: number;
  gapMm?: number;
  /** One entry per copy; ids are the editor's image ids. */
  items?: { id: string; width: number; height: number }[];
}): Promise<any> {
  return fetchApi("/api/auto-build", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Get pricing
export async function getPricing(): Promise<any> {
  return fetchApi("/api/pricing");
}

// Remove background
/**
 * Take the white background off a design. "all" also clears white inside
 * it (the hole of an "O") — offered after the customer has seen the first.
 */
export async function removeBg(imageId: string, mode: "background" | "all" = "background"): Promise<any> {
  return fetchApi("/api/remove-bg", {
    method: "POST",
    body: JSON.stringify({ imageId, mode }),
  });
}

// Prepare for cart
export async function prepareForCart(
  gangSheetId: string,
  quotedPrice?: number | null,
): Promise<any> {
  return fetchApi("/api/cart", {
    method: "POST",
    body: JSON.stringify({ gangSheetId, quotedPrice }),
  });
}


/* ─────────────── Ready-made sheets ───────────────
 * A customer who already has a finished 58 cm sheet uploads it whole
 * instead of laying one out. Same backend, same R2, same gang sheet
 * records — so it belongs next to the builder's calls rather than in a
 * second implementation inside the theme.
 */

export interface ReadySheetPresign {
  uploadUrl: string;
  sheetId: string;
  r2Key: string;
}

export async function presignReadySheet(file: File): Promise<ReadySheetPresign> {
  return fetchApi("/api/presign-sheet", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "image/png",
      fileSize: file.size,
    }),
  });
}

/** PUT straight to storage so a 500 MB file never passes through the app. */
export function uploadReadySheetToStorage(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "image/png");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Uppladdning till lagring misslyckades (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Nätverksfel vid uppladdning"));
    xhr.send(file);
  });
}

export interface ReadySheetAnalysis {
  sheetId: string;
  gangSheetId: string | null;
  r2Key: string;
  filename: string;
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
  widthCm: number;
  heightCm: number;
  dpi: number;
  hasAlpha: boolean;
  fileSizeBytes: number;
  sizeKey: string;
  warnings: string[];
  approved: boolean;
  error?: string;
}

export async function analyzeReadySheet(
  presign: ReadySheetPresign,
  file: File,
): Promise<ReadySheetAnalysis> {
  return fetchApi("/api/analyze-sheet", {
    method: "POST",
    body: JSON.stringify({
      r2Key: presign.r2Key,
      sheetId: presign.sheetId,
      filename: file.name,
      fileSize: file.size,
    }),
  });
}
