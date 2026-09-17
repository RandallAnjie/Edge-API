/**
 * Original `common.UnmarshalBodyReusable` leftover JSON/form/multipart parse
 * and `middleware.getModelFromJSONBody` / `getModelFromRequest`.
 *
 * Extra-OK: workerd has no disk-backed `storage.IsDisk()` stream decode.
 * Extra-OK: non-JSON/non-form Content-Type still JSON.parse when the body
 * looks like JSON so existing tests that omit Content-Type keep working
 * (original skip leaves a zero-value request).
 */
import { goUnmarshalJSON } from "./channel-validate.js";
import { abortWithOpenAiMessage, distributorInvalidRequestMessage } from "./http.js";
import { parseMultipartForm } from "./multipart-form.js";

/** Original gin `MIMEPOSTForm`. */
export const GIN_MIME_POST_FORM = "application/x-www-form-urlencoded";

/** Original gin `MIMEMultipartPOSTForm`. */
export const GIN_MIME_MULTIPART_POST_FORM = "multipart/form-data";

/** Original `common.errBoundaryNotFound`. */
export const ERR_BOUNDARY_NOT_FOUND = "multipart boundary not found";

/** Original `getModelFromJSONBody` `errors.New("invalid JSON request body")`. */
export const ERR_INVALID_JSON_REQUEST_BODY = "invalid JSON request body";

/** Original `getModelFromJSONBody` `errors.New("model must be provided once")`. */
export const ERR_MODEL_MUST_BE_PROVIDED_ONCE = "model must be provided once";

export type ModelRequest = {
  model: string;
  group: string;
};

export type ModelFromRequest = { ok: true } & ModelRequest | { ok: false; message: string };

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Original `mime.ParseMediaType` boundary param used by `parseBoundary`. */
export function parseBoundary(contentType: string): { ok: true; boundary: string } | { ok: false; notFound: boolean; message: string } {
  if (!contentType) return { ok: false, notFound: true, message: ERR_BOUNDARY_NOT_FOUND };
  const trimmed = contentType.trim();
  const semi = trimmed.indexOf(";");
  const rest = semi < 0 ? "" : trimmed.slice(semi + 1);
  const params: Record<string, string> = {};
  for (const part of rest.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (key) params[key] = value;
  }
  const boundary = params.boundary || "";
  if (!boundary) return { ok: false, notFound: true, message: ERR_BOUNDARY_NOT_FOUND };
  return { ok: true, boundary };
}

/** Original `common.processFormMap`. */
function processFormMap(formMap: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(formMap)) as Record<string, unknown>;
}

/** Original `common.parseFormData` (`url.ParseQuery`). */
export function parseFormData(data: Uint8Array): Record<string, unknown> {
  const values = new URLSearchParams(bytesToText(data));
  const formMap: Record<string, unknown> = {};
  for (const key of new Set(values.keys())) {
    const vals = values.getAll(key);
    formMap[key] = vals.length === 1 ? vals[0] : vals;
  }
  return processFormMap(formMap);
}

/** Original `common.parseMultipartFormData`. Missing boundary falls back to JSON. */
export function parseMultipartFormData(data: Uint8Array, contentType: string): unknown {
  const boundary = parseBoundary(contentType);
  if (!boundary.ok) {
    if (boundary.notFound) {
      const parsed = goUnmarshalJSON(bytesToText(data));
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.value;
    }
    throw new Error(boundary.message);
  }
  const parsed = parseMultipartForm(Uint8ArrayToArrayBuffer(data), contentType);
  const formMap: Record<string, unknown> = {};
  for (const [key, vals] of Object.entries(parsed.values)) {
    formMap[key] = vals.length === 1 ? vals[0] : vals;
  }
  return processFormMap(formMap);
}

function Uint8ArrayToArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}

/**
 * Original `common.UnmarshalBodyReusable` without gin context.
 * `application/json` uses `common.Unmarshal`; form-urlencoded and multipart
 * copy form values through JSON; other types skip (Extra-OK: JSON.parse).
 */
export function unmarshalBodyReusable(data: Uint8Array, contentType: string): unknown {
  if (contentType.startsWith("application/json")) {
    const parsed = goUnmarshalJSON(bytesToText(data));
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.value;
  }
  if (contentType.includes(GIN_MIME_POST_FORM)) return parseFormData(data);
  if (contentType.includes(GIN_MIME_MULTIPART_POST_FORM)) return parseMultipartFormData(data, contentType);
  const text = bytesToText(data);
  if (!text) return {};
  const parsed = goUnmarshalJSON(text);
  return parsed.ok ? parsed.value : {};
}

/**
 * Original `countTopLevelJSONKey`. Counts decoded top-level object keys equal
 * to `target` (used to reject duplicate `"model"`).
 */
export function countTopLevelJSONKey(data: Uint8Array, target: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let expectingKey = false;
  let count = 0;
  for (let index = 0; index < data.length; index++) {
    const current = data[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === 0x5c) {
        escaped = true;
        continue;
      }
      if (current !== 0x22) continue;
      inString = false;
      if (depth === 1 && expectingKey) {
        let key = bytesToText(data.subarray(stringStart, index));
        const quoted = bytesToText(data.subarray(stringStart - 1, index + 1));
        const decoded = goUnmarshalJSON(quoted);
        if (decoded.ok && typeof decoded.value === "string") key = decoded.value;
        let cursor = index + 1;
        while (
          cursor < data.length &&
          (data[cursor] === 0x20 || data[cursor] === 0x09 || data[cursor] === 0x0d || data[cursor] === 0x0a)
        ) {
          cursor++;
        }
        if (cursor < data.length && data[cursor] === 0x3a && key === target) count++;
        expectingKey = false;
      }
      continue;
    }
    switch (current) {
      case 0x22:
        inString = true;
        stringStart = index + 1;
        break;
      case 0x7b:
        depth++;
        if (depth === 1) expectingKey = true;
        break;
      case 0x7d:
        depth--;
        break;
      case 0x2c:
        if (depth === 1) expectingKey = true;
        break;
    }
  }
  return count;
}

/** Original `getJSONStringValue` on a gjson result. */
export function getJSONStringValue(value: unknown, field: string): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `field ${field} must be a string` };
}

/** Original `gjson.ValidBytes` via `encoding/json` validity. */
export function gjsonValidBytes(data: Uint8Array): boolean {
  return goUnmarshalJSON(bytesToText(data)).ok;
}

/** Original `middleware.getModelFromJSONBody`. */
export function getModelFromJSONBody(data: Uint8Array): ModelFromRequest {
  if (!gjsonValidBytes(data)) return { ok: false, message: ERR_INVALID_JSON_REQUEST_BODY };
  if (countTopLevelJSONKey(data, "model") > 1) return { ok: false, message: ERR_MODEL_MUST_BE_PROVIDED_ONCE };
  const parsed = goUnmarshalJSON(bytesToText(data));
  const rec = parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? (parsed.value as Record<string, unknown>)
    : {};
  const model = getJSONStringValue(rec.model, "model");
  if (!model.ok) return model;
  const group = getJSONStringValue(rec.group, "group");
  if (!group.ok) return group;
  return { ok: true, model: model.value, group: group.value };
}

/**
 * Original `getModelRequest` else-if that calls `getModelFromRequest`.
 * MJ / Gemini-path / remix / transcriptions / multipart skip this parse.
 */
export function distributeReadsJSONModel(path: string, contentType: string): boolean {
  if (path.includes("/mj/")) return false;
  if (path.includes("/v1/videos/") && path.endsWith("/remix")) return false;
  if (path.startsWith("/v1beta/models/") || path.startsWith("/v1/models/")) return false;
  if (path.startsWith("/v1/audio/transcriptions")) return false;
  if (contentType.includes(GIN_MIME_MULTIPART_POST_FORM)) return false;
  return true;
}

/**
 * Original `middleware.getModelFromRequest`. JSON uses `getModelFromJSONBody`;
 * other types use `UnmarshalBodyReusable`. JSON/form errors are wrapped once
 * with `MsgDistributorInvalidRequest` here; `Distribute` wraps again.
 */
export function getModelFromRequest(req: Request, data: Uint8Array): ModelFromRequest {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.startsWith("application/json")) {
    const parsed = getModelFromJSONBody(data);
    if (!parsed.ok) return { ok: false, message: distributorInvalidRequestMessage(req, parsed.message) };
    return parsed;
  }
  try {
    const body = unmarshalBodyReusable(data, contentType);
    const rec = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return {
      ok: true,
      model: typeof rec.model === "string" ? rec.model : "",
      group: typeof rec.group === "string" ? rec.group : "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: distributorInvalidRequestMessage(req, message) };
  }
}

/** Original `Distribute` `abortWithOpenAiMessage` wrapping `getModelFromRequest` err. */
export function abortDistributeInvalidRequest(req: Request, inner: string): Response {
  const rid = req.headers.get("x-oneapi-request-id") || "";
  return abortWithOpenAiMessage(400, distributorInvalidRequestMessage(req, inner), "", rid);
}
