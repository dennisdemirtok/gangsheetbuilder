import crypto from "node:crypto";

/**
 * Download links that keep working after the email is sent.
 *
 * Storage links expire within days at most, and the print shop opens an
 * order email whenever they get to it. The email links to the app instead,
 * with a signed token naming the file; each click gets a fresh short-lived
 * storage link. The token cannot be altered to reach another file.
 */

const LINK_DAYS = 60;

function secret(): string {
  const s = process.env.FILE_LINK_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("FILE_LINK_SECRET or SHOPIFY_API_SECRET must be set");
  return s;
}

interface FileToken {
  /** Storage key. */
  k: string;
  /** File name the browser saves it as. */
  n: string;
  /** Expiry, unix seconds. */
  e: number;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function fileLink(key: string, filename: string, days = LINK_DAYS): string {
  const token: FileToken = { k: key, n: filename, e: Math.floor(Date.now() / 1000) + days * 86400 };
  const payload = Buffer.from(JSON.stringify(token)).toString("base64url");
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return `${base}/f/${payload}.${sign(payload)}`;
}

export function linkExpiry(days = LINK_DAYS): Date {
  return new Date(Date.now() + days * 86400 * 1000);
}

export function readFileToken(token: string): FileToken | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as FileToken;
    if (!t.k || !t.n || !t.e || t.e < Date.now() / 1000) return null;
    return t;
  } catch {
    return null;
  }
}
