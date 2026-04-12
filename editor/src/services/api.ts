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
export async function prepareForCart(gangSheetId: string): Promise<any> {
  return fetchApi("/api/cart", {
    method: "POST",
    body: JSON.stringify({ gangSheetId }),
  });
}
