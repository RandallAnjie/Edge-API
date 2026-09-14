/** Original `service.GetImageFromUrl` (`service/image.go`). */

import { MAX_FILE_DOWNLOAD_MB } from "./constants.js";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  throw new Error("failed to decode base64 string");
}

/** Original `constant.MaxFileDownloadMB` default 64. */
export function maxImageDownloadBytes(): number {
  return MAX_FILE_DOWNLOAD_MB * 1024 * 1024;
}

/** Original `service.GetImageFromUrl` — mime + standard-base64 payload. */
export async function getImageFromUrl(url: string): Promise<{ mimeType: string; data: string }> {
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`failed to download image: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status !== 200) {
    throw new Error(`failed to download image: HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (contentType !== "application/octet-stream" && !contentType.startsWith("image/")) {
    throw new Error(`invalid content type: ${contentType}, required image/*`);
  }
  const maxImageSize = maxImageDownloadBytes();
  const contentLength = Number(resp.headers.get("content-length") || 0);
  if (contentLength > maxImageSize) {
    throw new Error(`image size ${contentLength} exceeds maximum allowed size of ${maxImageSize} bytes`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength >= maxImageSize) {
    throw new Error(`image size exceeds maximum allowed size of ${maxImageSize} bytes`);
  }
  const data = bytesToBase64(buf);
  let mimeType = contentType;
  if (mimeType === "application/octet-stream") {
    mimeType = `image/${sniffImageMime(buf)}`;
  }
  return { mimeType, data };
}
