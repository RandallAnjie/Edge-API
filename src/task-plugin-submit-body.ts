/**
 * Original jsplugin `TaskAdaptor.BuildRequestBody` multipart writer +
 * `inlineJSONFilePlaceholders` / `replaceJSONFilePlaceholders`.
 */
import { MAX_FILE_DOWNLOAD_MB } from "./constants.js";

export type NativeSubmitPart = {
  name: string;
  value: unknown;
  fileRef: string;
  filename: string;
};

/** Host-owned inbound file bytes. Plugin JSValue never receives `data`. */
export type NativeSubmitFile = {
  field: string;
  filename: string;
  mimeType: string;
  data: Uint8Array;
};

export type EncodedNativeSubmitBody = {
  body?: Uint8Array | string;
  contentType?: string;
};

const TSPECIALS = '()<>@,;:\\"/[]?=';
const UPPERHEX = "0123456789ABCDEF";

function isTSpecial(ch: number): boolean {
  return ch <= 0x7f && TSPECIALS.includes(String.fromCharCode(ch));
}

function isTokenChar(ch: number): boolean {
  return ch > 0x20 && ch < 0x7f && !isTSpecial(ch);
}

function isToken(s: string): boolean {
  if (!s) return false;
  for (const rune of s) {
    const code = rune.codePointAt(0) || 0;
    if (!isTokenChar(code)) return false;
  }
  return true;
}

function needsEncoding(s: string): boolean {
  for (const rune of s) {
    const b = rune.codePointAt(0) || 0;
    if ((b < 0x20 || b > 0x7e) && b !== 0x09) return true;
  }
  return false;
}

/** Original `mime.FormatMediaType`. */
export function formatMediaType(type: string, param: Record<string, string>): string {
  const slash = type.indexOf("/");
  let out = "";
  if (slash < 0) {
    if (!isToken(type)) return "";
    out = type.toLowerCase();
  } else {
    const major = type.slice(0, slash);
    const sub = type.slice(slash + 1);
    if (!isToken(major) || !isToken(sub)) return "";
    out = major.toLowerCase() + "/" + sub.toLowerCase();
  }
  const attrs = Object.keys(param).sort();
  const utf8 = new TextEncoder();
  for (const attribute of attrs) {
    const value = param[attribute];
    if (!isToken(attribute)) return "";
    out += "; " + attribute.toLowerCase();
    const needEnc = needsEncoding(value);
    if (needEnc) out += "*";
    out += "=";
    if (needEnc) {
      out += "utf-8''";
      const bytes = utf8.encode(value);
      let offset = 0;
      for (let index = 0; index < bytes.length; index++) {
        const ch = bytes[index];
        if (ch <= 0x20 || ch >= 0x7f || ch === 0x2a || ch === 0x27 || ch === 0x25 || isTSpecial(ch)) {
          out += utf8String(bytes.subarray(offset, index));
          offset = index + 1;
          out += "%" + UPPERHEX[ch >> 4] + UPPERHEX[ch & 0x0f];
        }
      }
      out += utf8String(bytes.subarray(offset));
      continue;
    }
    if (isToken(value)) {
      out += value;
      continue;
    }
    out += '"';
    let offset = 0;
    for (let index = 0; index < value.length; index++) {
      const character = value.charCodeAt(index);
      if (character === 0x22 || character === 0x5c) {
        out += value.slice(offset, index);
        offset = index;
        out += "\\";
      }
    }
    out += value.slice(offset);
    out += '"';
  }
  return out;
}

function utf8String(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function randomBoundary(): string {
  const buf = new Uint8Array(30);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, "0");
  return hex;
}

function formDataContentType(boundary: string): string {
  const specials = `()<>@,;:\\"/[]?= `;
  const quoted = [...boundary].some((ch) => specials.includes(ch)) ? `"${boundary}"` : boundary;
  return "multipart/form-data; boundary=" + quoted;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const part of parts) n += part.length;
  const out = new Uint8Array(n);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Original `fmt.Sprint` for plugin multipart part values. */
export function goSprint(value: unknown): string {
  if (value === null || value === undefined) return "<nil>";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return "[" + value.map((item) => goSprint(item)).join(" ") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj)) parts.push(`${key}:${goSprint(obj[key])}`);
    return "map[" + parts.join(" ") + "]";
  }
  return String(value);
}

function lookupFile(files: NativeSubmitFile[], fileRef: string): NativeSubmitFile | undefined {
  const field = fileRef.startsWith("request_file:") ? fileRef.slice("request_file:".length) : fileRef;
  return files.find((file) => file.field === field);
}

function goQuote(value: string): string {
  return JSON.stringify(value);
}

export function maxInlineFileBytes(limitMB = MAX_FILE_DOWNLOAD_MB): number {
  const mb = limitMB > 0 ? limitMB : 64;
  return mb * 1024 * 1024;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function usageNumber(value: unknown): { ok: true; n: number } | { ok: false } {
  if (typeof value === "number") return { ok: true, n: value };
  return { ok: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJSONValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return JSON.parse(JSON.stringify(value));
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return JSON.parse(JSON.stringify(value));
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneJSONValue(item, depth + 1));
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) cloned[key] = cloneJSONValue(item, depth + 1);
    return cloned;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function encodeFilePlaceholder(
  placeholder: Record<string, unknown>,
  files: NativeSubmitFile[],
  limit: number,
  total: { n: number },
): string {
  for (const key of Object.keys(placeholder)) {
    if (key !== "__fileRef" && key !== "encoding" && key !== "mimeType" && key !== "maxBytes") {
      throw new Error("invalid file placeholder");
    }
  }
  const ref = typeof placeholder.__fileRef === "string" ? placeholder.__fileRef : "";
  if (!ref.trim()) throw new Error(`unknown file reference ${goQuote(ref)}`);
  const encoding = typeof placeholder.encoding === "string" ? placeholder.encoding : "";
  if (encoding !== "base64" && encoding !== "dataUrl") {
    throw new Error('file placeholder encoding must be "base64" or "dataUrl"');
  }
  const file = lookupFile(files, ref);
  if (!file) throw new Error(`unknown file reference ${goQuote(ref)}`);
  let maxBytes = limit;
  if (Object.prototype.hasOwnProperty.call(placeholder, "maxBytes")) {
    const parsed = usageNumber(placeholder.maxBytes);
    if (!parsed.ok || parsed.n <= 0 || parsed.n !== Math.trunc(parsed.n)) {
      throw new Error("invalid file placeholder");
    }
    if (parsed.n < maxBytes) maxBytes = parsed.n;
  }
  if (file.data.length > maxBytes) {
    throw new Error(`file ${goQuote(ref)} exceeds the ${maxBytes} byte limit`);
  }
  if (total.n + file.data.length > limit) {
    throw new Error(`inlined files exceed the ${limit} byte limit`);
  }
  total.n += file.data.length;
  const encoded = bytesToBase64(file.data);
  if (encoding === "base64") return encoded;
  let mimeType = "application/octet-stream";
  if (typeof placeholder.mimeType === "string" && placeholder.mimeType.trim()) mimeType = placeholder.mimeType;
  else if (file.mimeType) mimeType = file.mimeType;
  return `data:${mimeType};base64,${encoded}`;
}

/** Original `replaceJSONFilePlaceholders`. */
export function replaceJSONFilePlaceholders(
  value: unknown,
  files: NativeSubmitFile[],
  limit: number,
  total: { n: number },
): unknown {
  if (isPlainObject(value)) {
    if (Object.prototype.hasOwnProperty.call(value, "__fileRef")) {
      return encodeFilePlaceholder(value, files, limit, total);
    }
    for (const key of Object.keys(value)) {
      value[key] = replaceJSONFilePlaceholders(value[key], files, limit, total);
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = replaceJSONFilePlaceholders(value[index], files, limit, total);
    }
    return value;
  }
  return value;
}

/** Original `inlineJSONFilePlaceholders`. */
export function inlineJSONFilePlaceholders(
  body: unknown,
  files: NativeSubmitFile[],
  limit = maxInlineFileBytes(),
): unknown {
  const cloned = cloneJSONValue(body);
  const total = { n: 0 };
  return replaceJSONFilePlaceholders(cloned, files, limit, total);
}

/** Original `TaskAdaptor.BuildRequestBody` multipart branch. */
export function encodeNativeMultipartSubmit(
  parts: NativeSubmitPart[],
  files: NativeSubmitFile[],
): EncodedNativeSubmitBody {
  const boundary = randomBoundary();
  const latin1 = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let started = false;
  const pushText = (s: string) => chunks.push(latin1.encode(s));
  for (const part of parts) {
    const prefix = started ? `\r\n--${boundary}\r\n` : `--${boundary}\r\n`;
    started = true;
    if (!part.fileRef) {
      const disposition = formatMediaType("form-data", { name: part.name });
      if (!disposition) throw new Error("invalid multipart name");
      pushText(`${prefix}Content-Disposition: ${disposition}\r\n\r\n${goSprint(part.value)}`);
      continue;
    }
    const file = lookupFile(files, part.fileRef);
    if (!file) throw new Error(`unknown file reference ${goQuote(part.fileRef)}`);
    const filename = part.filename || file.filename;
    const disposition = formatMediaType("form-data", { name: part.name, filename });
    if (!disposition) throw new Error("invalid multipart name or filename");
    pushText(`${prefix}Content-Disposition: ${disposition}\r\nContent-Type: ${file.mimeType}\r\n\r\n`);
    chunks.push(file.data);
  }
  pushText(`\r\n--${boundary}--\r\n`);
  return { body: concatBytes(chunks), contentType: formDataContentType(boundary) };
}

export function parseNativeSubmitParts(value: unknown): NativeSubmitPart[] {
  if (!Array.isArray(value)) return [];
  const parts: NativeSubmitPart[] = [];
  for (const item of value) {
    const object = isPlainObject(item) ? item : {};
    parts.push({
      name: String(object.name || ""),
      value: Object.prototype.hasOwnProperty.call(object, "value") ? object.value : undefined,
      fileRef: String(object.fileRef || ""),
      filename: String(object.filename || ""),
    });
  }
  return parts;
}

/** Original `TaskAdaptor.BuildRequestBody`. */
export function encodeNativeSubmitBody(
  descriptor: { bodyType: string; body?: unknown; parts?: NativeSubmitPart[] },
  files: NativeSubmitFile[],
  limit = maxInlineFileBytes(),
): EncodedNativeSubmitBody {
  if (descriptor.bodyType === "multipart") {
    return encodeNativeMultipartSubmit(descriptor.parts || [], files);
  }
  if (descriptor.body == null) return {};
  if (typeof descriptor.body === "string") return { body: descriptor.body };
  const inlined = inlineJSONFilePlaceholders(descriptor.body, files, limit);
  return { body: JSON.stringify(inlined) };
}
