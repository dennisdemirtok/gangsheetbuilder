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
export async function uploadImage(
  file: File,
  sessionId: string,
  gangSheetId: string,
): Promise<any> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("sessionId", sessionId);
  formData.append("gangSheetId", gangSheetId);

  const base = getBaseUrl();
  const response = await fetch(`${base}/api/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }

  return response.json();
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
      placements: copies.map((c) => ({ xMm: c.positionX, yMm: c.positionY })),
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
export async function removeBg(imageId: string): Promise<any> {
  return fetchApi("/api/remove-bg", {
    method: "POST",
    body: JSON.stringify({ imageId }),
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
