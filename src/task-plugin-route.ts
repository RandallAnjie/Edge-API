/**
 * Original `middleware.PrepareTaskPluginRoute` + `buildTaskPluginRouteRequest`
 * + `renderTaskPluginQuery` + `RespondTaskPluginError` on workerd.
 */
import { authenticateApiToken, rateLimit } from "./auth.js";
import { goUnmarshalJSON } from "./channel-validate.js";
import { MAX_FILE_DOWNLOAD_MB, MAX_REQUEST_BODY_MB, parseJson } from "./constants.js";
import {
  json,
  messageWithRequestId,
  pluginRoutePanicError,
  sanitizedTaskPluginError,
} from "./http.js";
import { compilePlugin, HookError, type LoadedPlugin, type PluginEngine } from "./jsplugin.js";
import { hit } from "./metrics.js";
import { applyOriginTaskIntent, type ApplyOriginTaskIntentResult, taskPluginLegacyPlatforms } from "./origin-task.js";
import type { MatchedPlugin } from "./plugin-dispatch.js";
import { Store } from "./store.js";
import { continueNativeSubmit as continueNativeRelayTaskSubmit } from "./task-plugin-submit.js";
import { refreshNativeQueryTask } from "./task-plugin-query.js";
import type { NativeSubmitFile } from "./task-plugin-submit-body.js";
import type { AuthToken, Env, ExecutionContextLike } from "./types.js";

export const TASK_PLUGIN_INVALID_ROUTE_RESULT = "plugin returned an invalid route result";
export const BODY_NONE = "none";
export const BODY_JSON = "json";
export const BODY_FORM = "form";
export const BODY_MULTIPART = "multipart";
export const ROUTE_SUBMIT = "submit";
export const ROUTE_QUERY = "query";
export const ROUTE_DYNAMIC = "dynamic";

const MAX_FORM_FIELDS = 256;
const MAX_MULTIPART_PARTS = 256;
const MAX_FILES = 32;
const MAX_FIELD_NAME_BYTES = 256;
const MAX_FIELD_VALUE_BYTES = 1 << 20;
const MAX_FILENAME_BYTES = 255;
const MAX_QUERY_TASK_IDS = 100;

const compiledPlugins = new Map<string, LoadedPlugin>();

export type RouteRequestContext = {
  path: string;
  method: string;
  params: Record<string, string>;
  query: Record<string, string[]>;
  body: Record<string, unknown>;
  files: Record<string, unknown>[];
  /** Host-owned inbound file bytes. Original `multipart.Form.File`. */
  fileContents?: NativeSubmitFile[];
  requestBody: unknown;
};

export class UnsupportedTaskPluginMediaType extends Error {
  constructor(mediaType: string) {
    super(`unsupported task plugin media type ${JSON.stringify(mediaType)}`);
    this.name = "UnsupportedTaskPluginMediaType";
  }
}

function isUnsupportedMediaType(err: unknown): boolean {
  return err instanceof UnsupportedTaskPluginMediaType;
}

function cheapSourceId(source: string, key: string, version: string): string {
  let h = 0;
  const step = Math.max(1, Math.floor(source.length / 64));
  for (let i = 0; i < source.length; i += step) h = (h * 33 + source.charCodeAt(i)) >>> 0;
  return `${key}@${version}:${source.length}:${h.toString(16)}`;
}

export function loadCompiledPlugin(source: string, key: string, version = ""): LoadedPlugin {
  const id = cheapSourceId(source, key, version);
  const cached = compiledPlugins.get(id);
  if (cached) return cached;
  const loaded = compilePlugin(source, { key, version });
  compiledPlugins.set(id, loaded);
  return loaded;
}

export function pluginRequestId(req: Request): string {
  return req.headers.get("x-oneapi-request-id") || crypto.randomUUID();
}

function utf8Valid(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function utf8String(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function isValidUtf8String(value: string): boolean {
  return utf8Valid(new TextEncoder().encode(value));
}

function parseMediaType(raw: string): { type: string; params: Record<string, string> } {
  const parts = String(raw || "").split(";").map((part) => part.trim()).filter(Boolean);
  const type = (parts.shift() || "").toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    params[name] = value;
  }
  return { type, params };
}

function formatMediaType(type: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let out = type.toLowerCase();
  for (const key of keys) {
    out += `; ${key}=${params[key]}`;
  }
  return out;
}

function requestContentTypes(req: Request): string[] {
  const out: string[] = [];
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-type") out.push(value);
  });
  return out;
}

function clonePluginRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => typeof item === "string")) return [...(value as string[])];
    return value.map((item) => clonePluginRequestValue(item));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) cloned[key] = clonePluginRequestValue(item);
    return cloned;
  }
  return value;
}

export function routeRequestJSValue(ctx: RouteRequestContext): Record<string, unknown> {
  const query: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(ctx.query)) query[key] = [...values];
  return {
    path: ctx.path,
    method: ctx.method,
    params: { ...ctx.params },
    query,
    body: clonePluginRequestValue(ctx.body),
  };
}

/** Original `pluginruntime.ProtocolRequestContext`. */
export type ProtocolRequestContext = RouteRequestContext & {
  protocol: string;
  operation: string;
  model: string;
  upstreamModel?: string;
  stream: boolean;
};

/** Original `ProtocolRequestContext.JSValue`. */
export function protocolRequestJSValue(ctx: ProtocolRequestContext): Record<string, unknown> {
  const value = routeRequestJSValue(ctx);
  value.protocol = ctx.protocol;
  value.operation = ctx.operation;
  value.model = ctx.model;
  if (ctx.upstreamModel) value.upstreamModel = ctx.upstreamModel;
  value.stream = ctx.stream;
  return value;
}

function emptyRouteContext(method: string, path: string, params: Record<string, string>, query: Record<string, string[]>): RouteRequestContext {
  return {
    path,
    method,
    params: { ...params },
    query,
    body: { kind: BODY_NONE },
    files: [],
    fileContents: [],
    requestBody: undefined,
  };
}

function queryFromSearch(search: string): Record<string, string[]> {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const query: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) query[key] = params.getAll(key);
  return query;
}

function validateFormFields(fields: Record<string, string[]>): void {
  let fieldCount = 0;
  for (const [name, values] of Object.entries(fields)) {
    if (!isValidUtf8String(name) || !name.length || new TextEncoder().encode(name).length > MAX_FIELD_NAME_BYTES) {
      throw new Error("invalid request field name");
    }
    for (const value of values) {
      fieldCount += 1;
      if (fieldCount > MAX_FORM_FIELDS) throw new Error(`request body exceeds ${MAX_FORM_FIELDS} fields`);
      if (!isValidUtf8String(value)) throw new Error(`request field ${JSON.stringify(name)} must be valid UTF-8`);
      if (new TextEncoder().encode(value).length > MAX_FIELD_VALUE_BYTES) {
        throw new Error(`request field ${JSON.stringify(name)} exceeds ${MAX_FIELD_VALUE_BYTES} bytes`);
      }
    }
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseDisposition(value: string): { name: string; filename: string } {
  const nameMatch = value.match(/name="([^"]*)"/i);
  const fileMatch = value.match(/filename="([^"]*)"/i);
  return { name: nameMatch?.[1] || "", filename: fileMatch?.[1] || "" };
}

function parseMultipartBody(raw: Uint8Array, boundary: string): {
  fields: Record<string, string[]>;
  files: Record<string, unknown>[];
  fileContents: NativeSubmitFile[];
} {
  if (!boundary) throw new Error("multipart boundary is required");
  const fileLimitMB = MAX_FILE_DOWNLOAD_MB > 0 ? MAX_FILE_DOWNLOAD_MB : 64;
  const delim = new TextEncoder().encode(`\r\n--${boundary}`);
  const prefixed = new Uint8Array(2 + raw.length);
  prefixed[0] = 13;
  prefixed[1] = 10;
  prefixed.set(raw, 2);
  const fields: Record<string, string[]> = {};
  const files: Record<string, unknown>[] = [];
  const fileContents: NativeSubmitFile[] = [];
  let partCount = 0;
  let fileCount = 0;
  let fieldCount = 0;
  let cursor = indexOfBytes(prefixed, delim, 0);
  if (cursor < 0) throw new Error("multipart boundary is required");
  while (cursor >= 0) {
    const start = cursor + delim.length;
    if (start + 2 <= prefixed.length && prefixed[start] === 45 && prefixed[start + 1] === 45) break;
    if (start + 2 <= prefixed.length && prefixed[start] === 13 && prefixed[start + 1] === 10) {
      const headerStart = start + 2;
      const next = indexOfBytes(prefixed, delim, headerStart);
      const partEnd = next < 0 ? prefixed.length : next;
      const headerSep = indexOfBytes(prefixed, new TextEncoder().encode("\r\n\r\n"), headerStart);
      if (headerSep < 0 || headerSep > partEnd) throw new Error("invalid multipart body");
      const headerText = utf8String(prefixed.slice(headerStart, headerSep));
      const body = prefixed.slice(headerSep + 4, partEnd);
      partCount += 1;
      if (partCount > MAX_MULTIPART_PARTS) throw new Error(`multipart body exceeds ${MAX_MULTIPART_PARTS} parts`);
      const headers: Record<string, string> = {};
      for (const line of headerText.split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      const disp = parseDisposition(headers["content-disposition"] || "");
      const name = disp.name;
      if (!isValidUtf8String(name) || !name.length || new TextEncoder().encode(name).length > MAX_FIELD_NAME_BYTES) {
        throw new Error("invalid multipart field name");
      }
      const partTypeRaw = headers["content-type"] || "";
      let partMediaType = "";
      if (partTypeRaw) {
        try {
          partMediaType = parseMediaType(partTypeRaw).type;
        } catch {
          throw new Error("invalid multipart part Content-Type");
        }
      }
      if (partMediaType.startsWith("multipart/")) throw new Error("nested multipart is not supported");
      if (!disp.filename) {
        fieldCount += 1;
        if (fieldCount > MAX_FORM_FIELDS) throw new Error(`request body exceeds ${MAX_FORM_FIELDS} fields`);
        if (body.length > MAX_FIELD_VALUE_BYTES) {
          throw new Error(`request field ${JSON.stringify(name)} exceeds ${MAX_FIELD_VALUE_BYTES} bytes`);
        }
        if (!utf8Valid(body)) throw new Error(`request field ${JSON.stringify(name)} must be valid UTF-8`);
        const value = utf8String(body);
        if (!fields[name]) fields[name] = [];
        fields[name].push(value);
      } else {
        fileCount += 1;
        if (fileCount > MAX_FILES) throw new Error(`multipart body exceeds ${MAX_FILES} files`);
        if (!isValidUtf8String(disp.filename) || new TextEncoder().encode(disp.filename).length > MAX_FILENAME_BYTES) {
          throw new Error("invalid multipart filename");
        }
        if (body.length > fileLimitMB * 1024 * 1024) throw new Error(`multipart file exceeds ${fileLimitMB} MB`);
        files.push({
          ref: "request_file:" + name,
          field: name,
          filename: disp.filename,
          mimeType: headers["content-type"] || "",
          size: body.length,
        });
        fileContents.push({
          field: name,
          filename: disp.filename,
          mimeType: headers["content-type"] || "",
          data: new Uint8Array(body),
        });
      }
      cursor = next;
      continue;
    }
    cursor = indexOfBytes(prefixed, delim, start);
  }
  validateFormFields(fields);
  return { fields, files, fileContents };
}

export function buildTaskPluginRouteRequestFromParts(input: {
  method: string;
  path: string;
  params?: Record<string, string>;
  query?: string;
  contentTypes?: string[];
  contentLength?: number;
  body?: Uint8Array;
}): RouteRequestContext {
  const query = queryFromSearch(input.query || "");
  const ctx = emptyRouteContext(input.method, input.path, input.params || {}, query);
  const contentTypes = input.contentTypes || [];
  let contentType = (contentTypes[0] || "").trim();
  if (contentTypes.length > 1) {
    let canonical = "";
    for (const value of contentTypes) {
      const parsed = parseMediaType(value);
      const current = formatMediaType(parsed.type, parsed.params);
      if (canonical && current !== canonical) throw new Error("conflicting Content-Type headers");
      canonical = current;
    }
    contentType = canonical;
  }
  const contentLength = input.contentLength ?? (input.body ? input.body.length : 0);
  if (!contentType || contentLength === 0) return ctx;
  const parsed = parseMediaType(contentType);
  if (!parsed.type) throw new Error("unsupported task plugin media type");
  const raw = input.body || new Uint8Array();
  const maxMB = MAX_REQUEST_BODY_MB > 0 ? MAX_REQUEST_BODY_MB : 128;
  if (raw.length > maxMB * 1024 * 1024) throw new Error(`request body exceeds ${maxMB} MB`);
  if (parsed.type === "application/json" || parsed.type.endsWith("+json")) {
    if (!utf8Valid(raw)) throw new Error("JSON body must be valid UTF-8");
    const decoded = goUnmarshalJSON(utf8String(raw));
    if (!decoded.ok) throw new Error(decoded.message);
    ctx.body = { kind: BODY_JSON, value: decoded.value };
    ctx.requestBody = decoded.value;
    return ctx;
  }
  if (parsed.type === "application/x-www-form-urlencoded") {
    if (!utf8Valid(raw)) throw new Error("form body must be valid UTF-8");
    const values = queryFromSearch(utf8String(raw));
    validateFormFields(fieldsAsForm(values));
    ctx.body = { kind: BODY_FORM, fields: values };
    return ctx;
  }
  if (parsed.type === "multipart/form-data") {
    const boundary = parsed.params.boundary || "";
    if (!boundary) throw new Error("multipart boundary is required");
    const parsedBody = parseMultipartBody(raw, boundary);
    ctx.files = parsedBody.files;
    ctx.fileContents = parsedBody.fileContents;
    ctx.body = { kind: BODY_MULTIPART, fields: parsedBody.fields, files: parsedBody.files };
    return ctx;
  }
  throw new UnsupportedTaskPluginMediaType(parsed.type);
}

function fieldsAsForm(values: Record<string, string[]>): Record<string, string[]> {
  return values;
}

export async function buildTaskPluginRouteRequest(
  req: Request,
  path: string,
  params: Record<string, string> = {},
): Promise<RouteRequestContext> {
  const url = new URL(req.url);
  const buf = req.method === "GET" || req.method === "HEAD" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
  const clHeader = req.headers.get("content-length");
  const contentLength = clHeader == null || clHeader === "" ? (buf.length ? buf.length : req.method === "GET" || req.method === "HEAD" ? 0 : -1) : Number(clHeader);
  return buildTaskPluginRouteRequestFromParts({
    method: req.method,
    path,
    params,
    query: url.search,
    contentTypes: requestContentTypes(req),
    contentLength,
    body: buf,
  });
}

export function hookDetail(err: unknown): string {
  if (err instanceof HookError) return err.jsMessage;
  return "";
}

function errorHeaders(requestId: string): HeadersInit {
  return requestId ? { "X-Oneapi-Request-Id": requestId } : {};
}

export function respondTaskPluginError(
  engine: PluginEngine | null,
  requestContext: RouteRequestContext | null,
  status: number,
  detail: string,
  requestId: string,
): Response {
  const taskErr = { code: "", message: detail, statusCode: status };
  const sanitized = sanitizedTaskPluginError(taskErr.statusCode || status, taskErr.message);
  if (engine && requestContext && engine.hasCallablePath("native", "error")) {
    try {
      const body = engine.callMember("native", "error", routeRequestJSValue(requestContext), {
        code: sanitized.code,
        message: sanitized.message,
        httpStatus: sanitized.httpStatus,
        retryable: sanitized.retryable,
        requestId,
      });
      return json(sanitized.httpStatus, body, errorHeaders(requestId));
    } catch {
      /* host fallback */
    }
  }
  return json(
    sanitized.httpStatus,
    { code: sanitized.code, message: messageWithRequestId(sanitized.message, requestId), data: null },
    errorHeaders(requestId),
  );
}

export function abortTaskPluginRouteErrorDetail(
  engine: PluginEngine | null,
  requestContext: RouteRequestContext | null,
  status: number,
  detail: string,
  requestId: string,
): Response {
  return respondTaskPluginError(engine, requestContext, status, detail, requestId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolvedTaskPluginIDs(value: unknown): { ok: true; ids: string[] } | { ok: false } {
  if (!Array.isArray(value) || value.length > MAX_QUERY_TASK_IDS) return { ok: false };
  const taskIDs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return { ok: false };
    taskIDs.push(item);
  }
  return { ok: true, ids: taskIDs };
}

function replacePrivateTaskID(value: unknown, privateTaskID: string, publicTaskID: string): unknown {
  if (!privateTaskID || privateTaskID === publicTaskID) return value;
  if (Array.isArray(value)) return value.map((item) => replacePrivateTaskID(item, privateTaskID, publicTaskID));
  if (isPlainObject(value)) {
    const replaced: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if ((key === "id" || key === "task_id" || key === "taskId") && item === privateTaskID) {
        replaced[key] = publicTaskID;
        continue;
      }
      replaced[key] = replacePrivateTaskID(item, privateTaskID, publicTaskID);
    }
    return replaced;
  }
  return value;
}

/** Original `service.BuildTaskPluginView`. */
export function buildTaskPluginView(row: Record<string, unknown>): Record<string, unknown> {
  const createdAt = Number(row.created_at || 0) || Number(row.submit_time || 0);
  const view: Record<string, unknown> = {
    task_id: String(row.task_id || ""),
    platform: String(row.platform || ""),
    status: String(row.status || ""),
    progress: String(row.progress || ""),
    fail_reason: String(row.fail_reason || ""),
    created_at: createdAt,
  };
  const updatedAt = Number(row.updated_at || 0);
  const finishedAt = Number(row.finish_time || 0);
  if (updatedAt) view.updated_at = updatedAt;
  if (finishedAt) view.finished_at = finishedAt;
  const raw = row.data;
  if (raw != null && String(raw) !== "") {
    let data: unknown = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    const privateData = parseJson<Record<string, unknown>>(String(row.private_data || ""), {});
    const privateId = String(privateData.upstream_task_id || privateData.UpstreamTaskID || "").trim();
    view.data = replacePrivateTaskID(data, privateId, String(row.task_id || ""));
  }
  return view;
}

async function renderTaskPluginQuery(
  store: Store,
  userId: number,
  plugin: MatchedPlugin,
  engine: PluginEngine,
  requestContext: RouteRequestContext,
  taskIDs: string[],
  renderer: string,
  multiple: boolean,
  requestId: string,
): Promise<Response> {
  const platforms = taskPluginLegacyPlatforms({ key: plugin.key, channelTypes: plugin.channelTypes });
  let tasks: Record<string, unknown>[];
  try {
    tasks = await store.getTasksByUserPlatformsAndIds(userId, platforms, taskIDs);
  } catch {
    return abortTaskPluginRouteErrorDetail(engine, requestContext, 500, "", requestId);
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const task of tasks) byId.set(String(task.task_id || ""), task);
  const serverAddress = await store.option("ServerAddress");
  const views: Record<string, unknown>[] = [];
  for (const taskID of taskIDs) {
    let task = byId.get(taskID);
    if (!task) return abortTaskPluginRouteErrorDetail(engine, requestContext, 404, "", requestId);
    try {
      task = await refreshNativeQueryTask({ store, engine, row: task, serverAddress });
    } catch {
      /* original query GET still renders the last persisted row if poll fails */
    }
    views.push(buildTaskPluginView(task));
  }
  const rendererInput: unknown = multiple ? views : views[0];
  try {
    const result = engine.callPath("native", [renderer], [routeRequestJSValue(requestContext), rendererInput]);
    return json(200, result ?? null, errorHeaders(requestId));
  } catch {
    return abortTaskPluginRouteErrorDetail(engine, requestContext, 500, "", requestId);
  }
}

export type PreparedNativeRoute =
  | { kind: "response"; response: Response }
  | {
      kind: "submit";
      model: string;
      action: string;
      requestBody: unknown;
      resolved: Record<string, unknown>;
      engine: PluginEngine;
      requestContext: RouteRequestContext;
      origin: ApplyOriginTaskIntentResult;
      protocol?: string;
      operation?: string;
      protocolContext?: ProtocolRequestContext;
    };

export async function prepareTaskPluginRoute(
  store: Store,
  userId: number,
  plugin: MatchedPlugin,
  requestContext: RouteRequestContext,
  requestId: string,
): Promise<PreparedNativeRoute> {
  let engine: PluginEngine | null = null;
  try {
    if (!plugin.source) throw new Error("plugin source is empty");
    engine = loadCompiledPlugin(plugin.source, plugin.key, plugin.version || "").engine;
  } catch {
    return { kind: "response", response: pluginRoutePanicError() };
  }
  const route = plugin.route || {};
  const routeType = String(route.type || "");
  const bodyObject = isPlainObject(requestContext.body) ? requestContext.body : { kind: BODY_NONE };
  const bodyKind = String(bodyObject.kind || BODY_NONE);
  if ((routeType === ROUTE_QUERY && bodyKind !== BODY_NONE) || (routeType !== ROUTE_QUERY && bodyKind !== BODY_JSON)) {
    const detail = routeType === ROUTE_QUERY ? "unsupported request body for this operation" : "this route requires a JSON body";
    return {
      kind: "response",
      response: abortTaskPluginRouteErrorDetail(engine, requestContext, 415, detail, requestId),
    };
  }
  if (routeType === ROUTE_QUERY) {
    const param = String(route.taskIdParam || "task_id");
    const taskID = requestContext.params[param] || "";
    return {
      kind: "response",
      response: await renderTaskPluginQuery(
        store,
        userId,
        plugin,
        engine,
        requestContext,
        [taskID],
        String(route.render || ""),
        false,
        requestId,
      ),
    };
  }

  const routeModels = Array.isArray(route.models) ? route.models.map(String) : [];
  if (routeModels.length) {
    const bodyValue = isPlainObject(bodyObject.value) ? bodyObject.value : {};
    const claimedModel = typeof bodyValue.model === "string" ? bodyValue.model : "";
    if (!claimedModel || !routeModels.includes(claimedModel)) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(
          engine,
          requestContext,
          400,
          `model ${JSON.stringify(claimedModel)} is not allowed on this route`,
          requestId,
        ),
      };
    }
  }

  const decode = String(route.decode || "");
  let resolvedValue: unknown;
  try {
    resolvedValue = engine.callMember("native", decode, routeRequestJSValue(requestContext));
  } catch (err) {
    return {
      kind: "response",
      response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, hookDetail(err), requestId),
    };
  }
  if (!isPlainObject(resolvedValue)) {
    return {
      kind: "response",
      response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
    };
  }
  const resolved = resolvedValue;
  if (typeof resolved.kind !== "string") {
    return {
      kind: "response",
      response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
    };
  }
  if (Object.prototype.hasOwnProperty.call(resolved, "renderer")) {
    return {
      kind: "response",
      response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
    };
  }
  const kind = resolved.kind;
  if (kind === ROUTE_SUBMIT) {
    const modelName = typeof resolved.model === "string" ? resolved.model : "";
    if (!modelName.trim()) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, "decoded request is missing a model", requestId),
      };
    }
    if (!plugin.models.includes(modelName)) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(
          engine,
          requestContext,
          400,
          `model ${JSON.stringify(modelName)} is not served by this plugin`,
          requestId,
        ),
      };
    }
    if (routeModels.length && !routeModels.includes(modelName)) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(
          engine,
          requestContext,
          400,
          `model ${JSON.stringify(modelName)} is not allowed on this route`,
          requestId,
        ),
      };
    }
    let action = String(route.action || "");
    if (Object.prototype.hasOwnProperty.call(resolved, "action")) {
      if (typeof resolved.action !== "string") {
        return {
          kind: "response",
          response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
        };
      }
      if (resolved.action.trim()) action = resolved.action;
    }
    if (Object.prototype.hasOwnProperty.call(resolved, "requestBody")) {
      requestContext.requestBody = resolved.requestBody;
    }
    const intent = await applyOriginTaskIntent(store, userId, resolved, {
      key: plugin.key,
      channelTypes: plugin.channelTypes,
    });
    if (intent.error) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(engine, requestContext, intent.error.statusCode, intent.error.message, requestId),
      };
    }
    return {
      kind: "submit",
      model: modelName,
      action,
      requestBody: requestContext.requestBody,
      resolved,
      engine,
      requestContext,
      origin: intent,
    };
  }
  if (kind === ROUTE_QUERY) {
    if (routeType !== ROUTE_DYNAMIC) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
      };
    }
    const ids = resolvedTaskPluginIDs(resolved.taskIds);
    if (!ids.ok) {
      return {
        kind: "response",
        response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
      };
    }
    return {
      kind: "response",
      response: await renderTaskPluginQuery(
        store,
        userId,
        plugin,
        engine,
        requestContext,
        ids.ids,
        String(route.render || ""),
        true,
        requestId,
      ),
    };
  }
  return {
    kind: "response",
    response: abortTaskPluginRouteErrorDetail(engine, requestContext, 400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId),
  };
}

async function continueNativeSubmit(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  plugin: MatchedPlugin,
  prepared: Extract<PreparedNativeRoute, { kind: "submit" }>,
  requestId: string,
  _ctx: ExecutionContextLike,
): Promise<Response> {
  return continueNativeRelayTaskSubmit(req, env, store, auth, plugin, prepared, requestId);
}

export async function executeNativePluginRoute(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  plugin: MatchedPlugin;
  ctx: ExecutionContextLike;
  requestId?: string;
}): Promise<Response> {
  const requestId = opts.requestId || pluginRequestId(opts.req);
  let requestContext: RouteRequestContext;
  try {
    requestContext = await buildTaskPluginRouteRequest(opts.req, new URL(opts.req.url).pathname, opts.plugin.params || {});
  } catch (err) {
    const status = isUnsupportedMediaType(err) ? 415 : 400;
    const detail = err instanceof Error ? err.message : String(err);
    let engine: PluginEngine | null = null;
    try {
      if (opts.plugin.source) engine = loadCompiledPlugin(opts.plugin.source, opts.plugin.key, opts.plugin.version || "").engine;
    } catch {
      engine = null;
    }
    return abortTaskPluginRouteErrorDetail(engine, null, status, detail, requestId);
  }
  const prepared = await prepareTaskPluginRoute(opts.store, opts.auth.user.id, opts.plugin, requestContext, requestId);
  if (prepared.kind === "response") return prepared.response;
  return continueNativeSubmit(opts.req, opts.env, opts.store, opts.auth, opts.plugin, prepared, requestId, opts.ctx);
}

export async function handleNativePluginRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContextLike,
  plugin: MatchedPlugin,
  store = new Store(env.DB),
): Promise<Response> {
  const auth = await authenticateApiToken(
    {
      req,
      env,
      url: new URL(req.url),
      params: {},
      waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
    },
    store,
  );
  if (auth instanceof Response) return auth;
  if (!(await rateLimit(env, auth.token.id))) {
    return abortTaskPluginRouteErrorDetail(null, null, 429, "", pluginRequestId(req));
  }
  hit("relay");
  return executeNativePluginRoute({ req, env, store, auth, plugin, ctx });
}
