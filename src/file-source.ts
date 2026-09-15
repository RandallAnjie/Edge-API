/** Original `service.GetBase64Data` / `LoadFileSource` / `loadFromURL` for URL sources. */

import { MAX_FILE_DOWNLOAD_MB } from "./constants.js";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Original `service.GetMimeTypeByExtension`. */
export function getMimeTypeByExtension(ext: string): string {
  switch (String(ext || "").toLowerCase()) {
    case "txt":
    case "md":
    case "markdown":
    case "csv":
    case "json":
    case "xml":
    case "html":
    case "htm":
      return "text/plain";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "jfif":
      return "image/jpeg";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "mp3":
      return "audio/mp3";
    case "wav":
      return "audio/wav";
    case "mpeg":
      return "audio/mpeg";
    case "mp4":
      return "video/mp4";
    case "wmv":
      return "video/wmv";
    case "flv":
      return "video/flv";
    case "mov":
      return "video/mov";
    case "mpg":
      return "video/mpg";
    case "avi":
      return "video/avi";
    case "mpegps":
      return "video/mpegps";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/** Original `service.guessMimeTypeFromURL`. */
export function guessMimeTypeFromURL(url: string): string {
  let cleaned = String(url || "");
  const q = cleaned.indexOf("?");
  if (q !== -1) cleaned = cleaned.slice(0, q);
  const slash = cleaned.lastIndexOf("/");
  if (slash !== -1 && slash + 1 < cleaned.length) {
    const last = cleaned.slice(slash + 1);
    const dot = last.lastIndexOf(".");
    if (dot !== -1 && dot + 1 < last.length) {
      return getMimeTypeByExtension(last.slice(dot + 1).toLowerCase());
    }
  }
  return "application/octet-stream";
}

/** Original `http.DetectContentType` subset used after header/URL mime miss. Extra-OK: skip HEIF box parse. */
function detectContentType(fileBytes: Uint8Array): string {
  const n = Math.min(fileBytes.length, 512);
  if (n >= 8 && fileBytes[0] === 0x89 && fileBytes[1] === 0x50 && fileBytes[2] === 0x4e && fileBytes[3] === 0x47) {
    return "image/png";
  }
  if (n >= 3 && fileBytes[0] === 0xff && fileBytes[1] === 0xd8 && fileBytes[2] === 0xff) return "image/jpeg";
  if (n >= 6 && fileBytes[0] === 0x47 && fileBytes[1] === 0x49 && fileBytes[2] === 0x46) return "image/gif";
  if (
    n >= 12 &&
    fileBytes[0] === 0x52 &&
    fileBytes[1] === 0x49 &&
    fileBytes[2] === 0x46 &&
    fileBytes[3] === 0x46 &&
    fileBytes[8] === 0x57 &&
    fileBytes[9] === 0x45 &&
    fileBytes[10] === 0x42 &&
    fileBytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (n >= 5 && fileBytes[0] === 0x25 && fileBytes[1] === 0x50 && fileBytes[2] === 0x44 && fileBytes[3] === 0x46 && fileBytes[4] === 0x2d) {
    return "application/pdf";
  }
  return "application/octet-stream";
}

function headerMediaType(value: string): string {
  let mime = String(value || "");
  const idx = mime.indexOf(";");
  if (idx !== -1) mime = mime.slice(0, idx).trim();
  else mime = mime.trim();
  return mime;
}

/**
 * Original `service.smartDetectMimeType`.
 * Extra-OK: skip `decodeImageConfig` / HEIF fallback after sniff.
 */
export function smartDetectMimeType(headers: Headers, url: string, fileBytes: Uint8Array): string {
  const mimeType = headerMediaType(headers.get("content-type") || "");
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;

  const cd = headers.get("content-disposition") || "";
  if (cd) {
    for (const raw of cd.split(";")) {
      const part = raw.trim();
      if (part.toLowerCase().startsWith("filename=")) {
        let name = part.slice("filename=".length).trim();
        if (name.length > 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
        const dot = name.lastIndexOf(".");
        if (dot !== -1 && dot + 1 < name.length) {
          const mt = getMimeTypeByExtension(name.slice(dot + 1).toLowerCase());
          if (mt !== "application/octet-stream") return mt;
        }
        break;
      }
    }
  }

  const fromUrl = guessMimeTypeFromURL(url);
  if (fromUrl !== "application/octet-stream") return fromUrl;

  if (fileBytes.length > 0) {
    const sniffed = detectContentType(fileBytes);
    if (sniffed && sniffed !== "application/octet-stream") return headerMediaType(sniffed);
  }
  return "application/octet-stream";
}

/** Original `types.FileSource.GetIdentifier` for URL and base64 sources. */
export function fileSourceIdentifier(raw: string): string {
  const data = String(raw || "");
  if (data.startsWith("http://") || data.startsWith("https://")) {
    return data.length > 100 ? data.slice(0, 100) + "..." : data;
  }
  if (data.length > 50) return "base64:" + data.slice(0, 50) + "...";
  return "base64:" + data;
}

/**
 * Original `service.GetBase64Data` for `types.NewURLFileSource`.
 * Extra-OK: skip gin context cache, Worker download proxy, and `ValidateSSRFProtectedFetchURL`.
 */
export async function getBase64DataFromUrl(url: string): Promise<{ data: string; mimeType: string }> {
  const maxFileSize = MAX_FILE_DOWNLOAD_MB * 1024 * 1024;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`failed to download file from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status !== 200) {
    throw new Error(`failed to download file, status code: ${resp.status}`);
  }
  const contentLength = Number(resp.headers.get("content-length") || 0);
  if (contentLength > maxFileSize) {
    throw new Error(`file size exceeds maximum allowed size: ${MAX_FILE_DOWNLOAD_MB}MB`);
  }
  const fileBytes = new Uint8Array(await resp.arrayBuffer());
  if (fileBytes.byteLength > maxFileSize) {
    throw new Error(`file size exceeds maximum allowed size: ${MAX_FILE_DOWNLOAD_MB}MB`);
  }
  return {
    data: bytesToBase64(fileBytes),
    mimeType: smartDetectMimeType(resp.headers, url, fileBytes),
  };
}
