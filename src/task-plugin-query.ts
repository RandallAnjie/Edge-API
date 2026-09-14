/**
 * Original jsplugin `TaskAdaptor.FetchTask` / `ParseTaskResult` +
 * `service.updateVideoSingleTask` apply on workerd.
 */
import { resolveBaseUrl } from "./catalog.js";
import { nowSec, parseJson } from "./constants.js";
import { type PluginEngine, validateRequestURL } from "./jsplugin.js";
import { pickChannelKey } from "./select.js";
import type { Store } from "./store.js";
import type { ChannelRow } from "./types.js";
import { refundTaskQuota, settleTaskBillingOnComplete } from "./task-plugin-billing.js";
import { validatedCompletionUsageFacts } from "./task-plugin-usage.js";

export const MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES = 1 << 20;
export const TASK_POLL_MAX_FAILURES = 20;

export const TASK_STATUS_NOT_START = "NOT_START";
export const TASK_STATUS_SUBMITTED = "SUBMITTED";
export const TASK_STATUS_QUEUED = "QUEUED";
export const TASK_STATUS_IN_PROGRESS = "IN_PROGRESS";
export const TASK_STATUS_SUCCESS = "SUCCESS";
export const TASK_STATUS_FAILURE = "FAILURE";
export const TASK_STATUS_UNKNOWN = "UNKNOWN";

export const PROGRESS_SUBMITTED = "10%";
export const PROGRESS_QUEUED = "20%";
export const PROGRESS_IN_PROGRESS = "30%";
export const PROGRESS_COMPLETE = "100%";

const LEGACY_TASK_ACTION_ALIASES: Record<string, string> = {
  generate: "image_to_video",
  textGenerate: "text_to_video",
  firstTailGenerate: "first_tail_to_video",
  referenceGenerate: "reference_to_video",
  remixGenerate: "remix",
};

const POLL_OK = "ok";
const POLL_OTHER_CLIENT = "other_client";
const POLL_NOT_FOUND = "not_found";
const POLL_AUTH = "auth";
const POLL_TRANSIENT = "transient";
const POLL_UNRECOGNIZED = "unrecognized";
const POLL_HOOK_ERROR = "hook_error";
const POLL_TRANSPORT = "transport_error";

export type NativeQueryDescriptor = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type NativeTaskInfo = {
  code: number;
  taskId: string;
  status: string;
  progress: string;
  reason: string;
  url: string;
  remoteUrl: string;
  completionTokens: number;
  totalTokens: number;
  pluginState?: unknown;
  usageFacts?: Record<string, unknown>;
};

/** Original `service.BatchTaskResult`. */
export type NativeBatchTaskResult = {
  taskId: string;
  action: string;
  submitTime: number;
  startTime: number;
  finishTime: number;
  data: unknown;
  taskInfo: NativeTaskInfo;
};

export type NativeQueryError = { code: string; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pluginJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function pluginMeta(engine: PluginEngine): Record<string, unknown> {
  try {
    const meta = engine.export("meta");
    return isPlainObject(meta) ? meta : {};
  } catch {
    return {};
  }
}

function allowedHosts(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.allowedHosts) ? meta.allowedHosts.map((item) => String(item)) : [];
}

function resolvePluginAuth(meta: Record<string, unknown>, apiKey: string): { auth: Record<string, unknown>; apiKey?: string; authError?: string } {
  const authMeta = isPlainObject(meta.auth) ? meta.auth : {};
  const typeName = String(authMeta.type || "").trim();
  if (!typeName || typeName === "none" || typeName === "api_key") {
    return { auth: { authHeader: apiKey }, apiKey };
  }
  return { auth: {}, authError: "oauth2_jwt credentials are not available on workerd" };
}

function hookMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    out[key] = String(item);
  }
  return out;
}

export function isNativeQueryError(value: unknown): value is NativeQueryError {
  return isPlainObject(value) && typeof value.code === "string" && typeof value.message === "string";
}

function positiveInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/** Original `constant.NormalizeTaskAction`. */
export function normalizeTaskAction(action: string): string {
  return LEGACY_TASK_ACTION_ALIASES[action] || action;
}

/** Original `model.Task.GetUpstreamTaskID`. */
export function getUpstreamTaskID(row: Record<string, unknown>): string {
  const privateData = parsePrivateData(row);
  const upstream = String(privateData.upstream_task_id || "").trim();
  if (upstream) return upstream;
  return String(row.task_id || "");
}

export function parsePrivateData(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.private_data;
  if (isPlainObject(raw)) return { ...raw };
  if (typeof raw === "string") return parseJson<Record<string, unknown>>(raw, {});
  return {};
}

function parseProperties(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.properties;
  if (isPlainObject(raw)) return raw;
  if (typeof raw === "string") return parseJson<Record<string, unknown>>(raw, {});
  return {};
}

function parseTaskData(row: Record<string, unknown>): unknown {
  const raw = row.data;
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("task data is invalid");
  }
}

function parsePluginState(privateData: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(privateData, "plugin_state")) return null;
  const state = privateData.plugin_state;
  if (state == null) return null;
  if (typeof state === "string") {
    try {
      return JSON.parse(state);
    } catch {
      throw new Error("plugin state is invalid");
    }
  }
  return state;
}

/** Original `TaskAdaptor.queryContext`. */
export function buildNativeQueryContext(
  engine: PluginEngine,
  task: Record<string, unknown> | null,
  apiKey: string,
  baseUrl: string,
): Record<string, unknown> | NativeQueryError {
  const ctx: Record<string, unknown> = {
    taskId: "",
    publicTaskId: "",
    action: "",
    model: "",
    upstreamModel: "",
    baseUrl,
    data: null,
    state: null,
  };
  let key = apiKey;
  if (task) {
    const properties = parseProperties(task);
    const originModel = String(properties.origin_model_name || "");
    let upstreamModel = String(properties.upstream_model_name || "");
    if (!upstreamModel) upstreamModel = originModel;
    const privateData = parsePrivateData(task);
    ctx.taskId = getUpstreamTaskID(task);
    ctx.publicTaskId = String(task.task_id || "");
    ctx.action = normalizeTaskAction(String(task.action || ""));
    ctx.model = originModel;
    ctx.upstreamModel = upstreamModel;
    try {
      const raw = task.data;
      if (raw != null && String(raw) !== "") ctx.data = parseTaskData(task);
    } catch (err) {
      return { code: "task_data_invalid", message: hookMessage(err) };
    }
    try {
      ctx.state = parsePluginState(privateData);
    } catch (err) {
      return { code: "plugin_state_invalid", message: hookMessage(err) };
    }
    if (typeof privateData.key === "string" && privateData.key) key = privateData.key;
  }
  const meta = pluginMeta(engine);
  const resolved = resolvePluginAuth(meta, key);
  ctx.auth = resolved.auth;
  ctx.authHeader = resolved.auth.authHeader;
  if (resolved.apiKey != null) ctx.apiKey = resolved.apiKey;
  if (resolved.authError) return { code: "auth_error", message: resolved.authError };
  return ctx;
}

/** Original `TaskAdaptor.doFetchDescriptor` after `buildQueryRequest`. */
export function buildNativeQueryDescriptor(
  engine: PluginEngine,
  queryContext: Record<string, unknown>,
  channelBaseUrl: string,
): NativeQueryDescriptor | NativeQueryError {
  let value: unknown;
  try {
    value = engine.call("buildQueryRequest", queryContext);
  } catch (err) {
    return { code: "plugin_query_request_failed", message: hookMessage(err) };
  }
  const object = isPlainObject(value) ? value : {};
  const descriptor: NativeQueryDescriptor = {
    url: String(object.url || ""),
    method: String(object.method || ""),
    headers: stringMap(object.headers),
    body: Object.prototype.hasOwnProperty.call(object, "body") ? object.body : undefined,
  };
  try {
    validateRequestURL(descriptor.url, channelBaseUrl, allowedHosts(pluginMeta(engine)));
  } catch (err) {
    return { code: "plugin_query_request_invalid", message: hookMessage(err) };
  }
  return descriptor;
}

/** Original `TaskAdaptor.batchQueryContext`. */
export function buildNativeBatchQueryContext(
  engine: PluginEngine,
  tasks: (Record<string, unknown> | null)[],
  apiKey: string,
  baseUrl: string,
): { ctx: Record<string, unknown>; taskContexts: Record<string, unknown>[] } | NativeQueryError {
  const taskContexts: Record<string, unknown>[] = [];
  for (const task of tasks) {
    const taskCtx = buildNativeQueryContext(engine, task, apiKey, baseUrl);
    if (isNativeQueryError(taskCtx)) return taskCtx;
    taskContexts.push(taskCtx);
  }
  const ctx: Record<string, unknown> = { baseUrl, tasks: taskContexts };
  const resolved = resolvePluginAuth(pluginMeta(engine), apiKey);
  ctx.auth = resolved.auth;
  ctx.authHeader = resolved.auth.authHeader;
  if (resolved.apiKey != null) ctx.apiKey = resolved.apiKey;
  if (resolved.authError) return { code: "auth_error", message: resolved.authError };
  return { ctx, taskContexts };
}

/** Original `TaskAdaptor.doFetchDescriptor` after `buildBatchQueryRequest`. */
export function buildNativeBatchQueryDescriptor(
  engine: PluginEngine,
  batchContext: Record<string, unknown>,
  taskContexts: Record<string, unknown>[],
  channelBaseUrl: string,
): NativeQueryDescriptor | NativeQueryError {
  let value: unknown;
  try {
    value = engine.call("buildBatchQueryRequest", batchContext, taskContexts);
  } catch (err) {
    return { code: "plugin_query_request_failed", message: hookMessage(err) };
  }
  const object = isPlainObject(value) ? value : {};
  const descriptor: NativeQueryDescriptor = {
    url: String(object.url || ""),
    method: String(object.method || ""),
    headers: stringMap(object.headers),
    body: Object.prototype.hasOwnProperty.call(object, "body") ? object.body : undefined,
  };
  try {
    validateRequestURL(descriptor.url, channelBaseUrl, allowedHosts(pluginMeta(engine)));
  } catch (err) {
    return { code: "plugin_query_request_invalid", message: hookMessage(err) };
  }
  return descriptor;
}

function pluginStateFromBatchItem(state: unknown): unknown {
  if (state == null) return undefined;
  try {
    const encoded = JSON.stringify(state);
    if (encoded.length > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return state;
}

/** Original `TaskAdaptor.ParseBatchResult`. */
export function parseNativeBatchResult(
  engine: PluginEngine,
  batchContext: Record<string, unknown>,
  taskContexts: Record<string, unknown>[],
  statusCode: number,
  headers: Record<string, string>,
  body: unknown,
): Record<string, NativeBatchTaskResult> | NativeQueryError {
  let value: unknown;
  try {
    value = engine.call("parseBatchResult", batchContext, body, hookHTTPResponse(statusCode, headers));
  } catch (err) {
    return { code: "plugin_parse_batch_failed", message: hookMessage(err) };
  }
  if (!Array.isArray(value)) return { code: "plugin_parse_batch_invalid", message: "plugin returned an invalid batch result" };
  const results: Record<string, NativeBatchTaskResult> = {};
  const hasCompletionUsage = engine.hasCallablePath("extractUsageOnComplete");
  for (const raw of value) {
    const item = isPlainObject(raw) ? raw : {};
    const taskId = String(item.taskId || "").trim();
    if (!taskId) continue;
    const info: NativeTaskInfo = {
      code: 0,
      taskId,
      status: String(item.status || ""),
      progress: String(item.progress || ""),
      reason: String(item.reason || ""),
      url: String(item.url || ""),
      remoteUrl: "",
      completionTokens: 0,
      totalTokens: 0,
    };
    const pluginState = pluginStateFromBatchItem(item.state);
    if (pluginState !== undefined) info.pluginState = pluginState;
    if (hasCompletionUsage) {
      const usageBody = item.data != null ? item.data : pluginJsonValue(item);
      let itemCtx: Record<string, unknown> = batchContext;
      for (const taskCtx of taskContexts) {
        if (String(taskCtx.taskId ?? "") === taskId) {
          itemCtx = taskCtx;
          break;
        }
      }
      try {
        const facts = engine.call("extractUsageOnComplete", itemCtx, pluginJsonValue(info), usageBody);
        applyCompletionUsageFacts(info, facts, String(itemCtx.upstreamModel || ""), pluginMeta(engine));
      } catch {
        /* original keeps the parsed item when the completion hook fails */
      }
    }
    results[taskId] = {
      taskId,
      action: String(item.action || ""),
      submitTime: Number(item.submitTime || 0) || 0,
      startTime: Number(item.startTime || 0) || 0,
      finishTime: Number(item.finishTime || 0) || 0,
      data: Object.prototype.hasOwnProperty.call(item, "data") ? item.data : undefined,
      taskInfo: info,
    };
  }
  return results;
}

/** Original `hookHTTPResponse`. */
export function hookHTTPResponse(status: number, headers: Record<string, string>): Record<string, unknown> {
  return { status, headers };
}

function encodeReturnedPluginState(value: unknown): { present: boolean; state: unknown } {
  if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, "state") || value.state == null) {
    return { present: false, state: undefined };
  }
  try {
    const encoded = JSON.stringify(value.state);
    if (encoded.length > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) return { present: false, state: undefined };
  } catch {
    return { present: false, state: undefined };
  }
  return { present: true, state: value.state };
}

/** Original `TaskAdaptor.ParseTaskResult`. */
export function parseNativeTaskResult(
  engine: PluginEngine,
  queryContext: Record<string, unknown>,
  statusCode: number,
  headers: Record<string, string>,
  body: unknown,
): NativeTaskInfo | NativeQueryError {
  let value: unknown;
  try {
    value = engine.call("parseTaskResult", queryContext, body, hookHTTPResponse(statusCode, headers));
  } catch (err) {
    return { code: "plugin_parse_task_failed", message: hookMessage(err) };
  }
  if (!isPlainObject(value)) return { code: "plugin_parse_task_invalid", message: "plugin returned an invalid task result" };
  const encoded = encodeReturnedPluginState(value);
  const result: NativeTaskInfo = {
    code: Number(value.code || 0) || 0,
    taskId: String(value.taskId || ""),
    status: String(value.status || ""),
    progress: String(value.progress || ""),
    reason: String(value.reason || ""),
    url: String(value.url || ""),
    remoteUrl: String(value.remoteUrl || ""),
    completionTokens: positiveInt(value.completionTokens),
    totalTokens: positiveInt(value.totalTokens),
  };
  if (encoded.present) result.pluginState = encoded.state;
  if (engine.hasCallablePath("extractUsageOnComplete")) {
    try {
      const facts = engine.call("extractUsageOnComplete", queryContext, pluginJsonValue(result), body);
      applyCompletionUsageFacts(result, facts, String(queryContext.upstreamModel || ""), pluginMeta(engine));
    } catch {
      /* original retains ParseTaskResult when the completion hook fails */
    }
  }
  return result;
}

/** Original `TaskAdaptor.applyCompletionUsageFacts` after schema validation. */
export function applyCompletionUsageFacts(
  result: NativeTaskInfo,
  facts: unknown,
  modelName: string,
  meta: Record<string, unknown>,
): void {
  const validated = validatedCompletionUsageFacts(facts, modelName, meta);
  if ("error" in validated) return;
  if (!validated.facts || !Object.keys(validated.facts).length) return;
  const values = validated.facts;
  result.usageFacts = values;
  const units = positiveInt(values.upstreamUnits);
  if (units > 0) {
    result.completionTokens = units;
    result.totalTokens = units;
    return;
  }
  if (Object.prototype.hasOwnProperty.call(values, "completionTokens")) {
    result.completionTokens = positiveInt(values.completionTokens);
  }
  if (Object.prototype.hasOwnProperty.call(values, "totalTokens")) {
    result.totalTokens = positiveInt(values.totalTokens);
  }
}

function responseHeaderMap(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (!(key in headers)) headers[key] = value;
  });
  return headers;
}

export async function fetchNativeQuery(
  descriptor: NativeQueryDescriptor,
): Promise<{ status: number; headers: Record<string, string>; body: unknown; raw: string } | NativeQueryError> {
  const method = (descriptor.method || "GET").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(descriptor.headers)) headers.set(name, value);
  let body: BodyInit | undefined;
  if (descriptor.body != null) {
    if (typeof descriptor.body === "string") body = descriptor.body;
    else {
      try {
        body = JSON.stringify(descriptor.body);
      } catch (err) {
        return { code: "build_query_body_failed", message: hookMessage(err) };
      }
    }
  }
  let res: Response;
  try {
    res = await fetch(descriptor.url, { method, headers, body });
  } catch (err) {
    return { code: POLL_TRANSPORT, message: hookMessage(err) };
  }
  const rawBuf = await res.arrayBuffer();
  const text = new TextDecoder().decode(rawBuf);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: responseHeaderMap(res), body: parsed, raw: text };
}

export function classifyPollHTTP(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return POLL_OK;
  if (statusCode === 404 || statusCode === 410) return POLL_NOT_FOUND;
  if (statusCode === 401 || statusCode === 403) return POLL_AUTH;
  if (statusCode === 429 || statusCode >= 500) return POLL_TRANSIENT;
  if (statusCode >= 400 && statusCode < 500) return POLL_OTHER_CLIENT;
  return POLL_TRANSIENT;
}

export function knownPollStatus(status: string): boolean {
  return (
    status === TASK_STATUS_NOT_START ||
    status === TASK_STATUS_SUBMITTED ||
    status === TASK_STATUS_QUEUED ||
    status === TASK_STATUS_IN_PROGRESS ||
    status === TASK_STATUS_SUCCESS ||
    status === TASK_STATUS_FAILURE
  );
}

export function isNonTerminalPollStatus(status: string): boolean {
  return (
    status === TASK_STATUS_NOT_START ||
    status === TASK_STATUS_SUBMITTED ||
    status === TASK_STATUS_QUEUED ||
    status === TASK_STATUS_IN_PROGRESS
  );
}

function truncateBase64(value: string): string {
  if (value.length <= 256) return value;
  return value.slice(0, 256) + "...";
}

/** Original `redactVideoResponseBody`. */
export function redactVideoResponseBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const cloned = pluginJsonValue(body);
  if (!isPlainObject(cloned)) return body;
  const resp = isPlainObject(cloned.response) ? cloned.response : null;
  if (resp) {
    delete resp.bytesBase64Encoded;
    if (typeof resp.video === "string") resp.video = truncateBase64(resp.video);
    if (Array.isArray(resp.videos)) {
      for (const item of resp.videos) {
        if (isPlainObject(item)) delete item.bytesBase64Encoded;
      }
    }
  }
  return cloned;
}

/** Original `taskcommon.BuildProxyURL`. */
export function buildProxyURL(taskId: string, serverAddress: string): string {
  return `${String(serverAddress || "").replace(/\/+$/, "")}/v1/videos/${taskId}/content`;
}

function defaultProgress(status: string): string {
  switch (status) {
    case TASK_STATUS_SUBMITTED:
      return PROGRESS_SUBMITTED;
    case TASK_STATUS_QUEUED:
      return PROGRESS_QUEUED;
    case TASK_STATUS_IN_PROGRESS:
      return PROGRESS_IN_PROGRESS;
    case TASK_STATUS_SUCCESS:
    case TASK_STATUS_FAILURE:
      return PROGRESS_COMPLETE;
    default:
      return "";
  }
}

function parsePeerTaskResponse(body: unknown): NativeTaskInfo | null {
  if (!isPlainObject(body) || body.code !== "success" || !isPlainObject(body.data)) return null;
  const data = body.data;
  return {
    code: 0,
    taskId: String(data.task_id || ""),
    status: String(data.status || ""),
    progress: String(data.progress || ""),
    reason: String(data.fail_reason || ""),
    url: String(data.fail_reason || ""),
    remoteUrl: "",
    completionTokens: 0,
    totalTokens: 0,
  };
}

/** Original `updateVideoSingleTask` field apply (without billing settlement). */
export function applyNativePollToTask(
  row: Record<string, unknown>,
  info: NativeTaskInfo,
  rawBody: unknown,
  serverAddress: string,
  now = nowSec(),
): Record<string, unknown> {
  const next = { ...row };
  const privateData = parsePrivateData(row);
  next.data = JSON.stringify(redactVideoResponseBody(rawBody));
  if (info.pluginState !== undefined) privateData.plugin_state = info.pluginState;
  if (isNonTerminalPollStatus(info.status)) privateData.poll_failures = 0;
  let progress = defaultProgress(info.status);
  next.status = info.status;
  switch (info.status) {
    case TASK_STATUS_IN_PROGRESS:
      if (!Number(next.start_time || 0)) next.start_time = now;
      break;
    case TASK_STATUS_SUCCESS: {
      if (!Number(next.finish_time || 0)) next.finish_time = now;
      if (info.url.startsWith("data:")) privateData.result_url = buildProxyURL(String(row.task_id || ""), serverAddress);
      else if (info.url) privateData.result_url = info.url;
      else privateData.result_url = buildProxyURL(String(row.task_id || ""), serverAddress);
      break;
    }
    case TASK_STATUS_FAILURE:
      if (!Number(next.finish_time || 0)) next.finish_time = now;
      next.fail_reason = info.reason;
      break;
    default:
      break;
  }
  if (info.progress) progress = info.progress;
  next.progress = progress;
  next.private_data = JSON.stringify(privateData);
  next.updated_at = now;
  return next;
}

export function failTaskFromPoll(row: Record<string, unknown>, reason: string, now = nowSec()): Record<string, unknown> {
  const next = { ...row };
  const privateData = parsePrivateData(row);
  next.status = TASK_STATUS_FAILURE;
  next.progress = PROGRESS_COMPLETE;
  if (!Number(next.finish_time || 0)) next.finish_time = now;
  next.fail_reason = reason;
  next.private_data = JSON.stringify(privateData);
  next.updated_at = now;
  return next;
}

/** Original `relaycommon.FailTaskInfo`. */
export function failNativeTaskInfo(reason: string): NativeTaskInfo {
  return {
    code: 0,
    taskId: "",
    status: TASK_STATUS_FAILURE,
    progress: PROGRESS_COMPLETE,
    reason,
    url: "",
    remoteUrl: "",
    completionTokens: 0,
    totalTokens: 0,
  };
}

/** Original jsplugin `TaskAdaptor.AdjustBillingOnComplete` (returns 0 after stuffing facts). */
export function adjustBillingOnComplete(engine: PluginEngine, row: Record<string, unknown>, result: NativeTaskInfo): number {
  if (!engine.hasCallablePath("extractUsageOnComplete")) return 0;
  try {
    const facts = engine.call("extractUsageOnComplete", pluginJsonValue(row), pluginJsonValue(result));
    const properties = parseProperties(row);
    const model = String(properties.upstream_model_name || properties.origin_model_name || "");
    applyCompletionUsageFacts(result, facts, model, pluginMeta(engine));
  } catch {
    return 0;
  }
  return 0;
}

function taskPersistPatch(row: Record<string, unknown>): Record<string, unknown> {
  return {
    status: row.status,
    progress: row.progress,
    fail_reason: row.fail_reason ?? "",
    data: typeof row.data === "string" ? row.data : JSON.stringify(row.data ?? null),
    private_data: typeof row.private_data === "string" ? row.private_data : JSON.stringify(parsePrivateData(row)),
    start_time: Number(row.start_time || 0),
    finish_time: Number(row.finish_time || 0),
    submit_time: Number(row.submit_time || 0),
    action: row.action ?? "",
    updated_at: Number(row.updated_at || nowSec()),
  };
}

export async function persistNativePollUpdate(opts: {
  store: Store;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  taskInfo: NativeTaskInfo | null;
  engine?: PluginEngine;
}): Promise<Record<string, unknown>> {
  const taskId = String(opts.next.task_id || opts.previous.task_id || "");
  const fromStatus = String(opts.previous.status || "");
  const nextStatus = String(opts.next.status || "");
  const isDone = nextStatus === TASK_STATUS_SUCCESS || nextStatus === TASK_STATUS_FAILURE;
  const terminalTransition = isDone && fromStatus !== nextStatus;
  const won = await opts.store.updateTaskByTidIfStatus(taskId, fromStatus, taskPersistPatch(opts.next));
  if (!won) return (await opts.store.getTaskByTid(taskId)) || opts.next;
  const persisted = (await opts.store.getTaskByTid(taskId)) || opts.next;
  if (!terminalTransition) return persisted;
  const info = opts.taskInfo || failNativeTaskInfo(String(opts.next.fail_reason || ""));
  const settled = await settleTaskBillingOnComplete({
    store: opts.store,
    row: persisted,
    taskInfo: info,
    adjustBillingOnComplete: opts.engine ? (row) => adjustBillingOnComplete(opts.engine as PluginEngine, row, info) : undefined,
  });
  if (nextStatus === TASK_STATUS_FAILURE && !settled && Number(persisted.quota || 0) !== 0) {
    await refundTaskQuota(opts.store, persisted, String(opts.next.fail_reason || info.reason || ""));
  }
  return (await opts.store.getTaskByTid(taskId)) || persisted;
}

function pollFailureReason(className: string, statusCode: number, detail: string): string {
  let reason = `poll failed: ${className}`;
  if (statusCode > 0) reason = `poll failed: ${className} (HTTP ${statusCode})`;
  if (detail) reason = `${reason}: ${detail}`;
  return reason;
}

export function recordPollFailure(row: Record<string, unknown>, className: string, statusCode: number, detail: string): Record<string, unknown> {
  const privateData = parsePrivateData(row);
  const failures = Number(privateData.poll_failures || 0) + 1;
  privateData.poll_failures = failures;
  const next = { ...row, private_data: JSON.stringify(privateData), updated_at: nowSec() };
  if (TASK_POLL_MAX_FAILURES > 0 && failures >= TASK_POLL_MAX_FAILURES) {
    return failTaskFromPoll(next, pollFailureReason(className, statusCode, detail));
  }
  return next;
}

async function persistTaskRow(
  store: Store,
  previous: Record<string, unknown>,
  row: Record<string, unknown>,
  taskInfo: NativeTaskInfo | null = null,
  engine?: PluginEngine,
): Promise<Record<string, unknown>> {
  return persistNativePollUpdate({ store, previous, next: row, taskInfo, engine });
}

export async function refreshNativeQueryTask(opts: {
  store: Store;
  engine: PluginEngine;
  row: Record<string, unknown>;
  serverAddress?: string;
}): Promise<Record<string, unknown>> {
  const status = String(opts.row.status || "");
  if (!isNonTerminalPollStatus(status) && status !== "") return opts.row;
  const channelId = Number(opts.row.channel_id || 0);
  if (!channelId) return opts.row;
  const channel: ChannelRow | null = await opts.store.getChannel(channelId);
  if (!channel) return opts.row;
  const privateData = parsePrivateData(opts.row);
  const apiKey = String(privateData.key || pickChannelKey(channel.key || ""));
  const baseUrl = resolveBaseUrl(Number(channel.type || 0), channel.base_url || "");
  if (String(pluginMeta(opts.engine).fetchMode || "per_task") === "batch") {
    return refreshNativeBatchQueryTask(opts, apiKey, baseUrl);
  }
  const queryContext = buildNativeQueryContext(opts.engine, opts.row, apiKey, baseUrl);
  if (isNativeQueryError(queryContext)) {
    const failed = recordPollFailure(opts.row, POLL_HOOK_ERROR, 0, queryContext.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const descriptor = buildNativeQueryDescriptor(opts.engine, queryContext, baseUrl);
  if (isNativeQueryError(descriptor)) {
    const failed = recordPollFailure(opts.row, POLL_HOOK_ERROR, 0, descriptor.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const fetched = await fetchNativeQuery(descriptor);
  if (isNativeQueryError(fetched)) {
    const failed = recordPollFailure(opts.row, POLL_TRANSPORT, 0, fetched.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const httpClass = classifyPollHTTP(fetched.status);
  if (httpClass === POLL_NOT_FOUND) {
    const reason = `upstream task not found (HTTP ${fetched.status})`;
    return persistTaskRow(opts.store, opts.row, failTaskFromPoll(opts.row, reason), failNativeTaskInfo(reason), opts.engine);
  }
  if (httpClass === POLL_AUTH || httpClass === POLL_TRANSIENT) {
    return persistTaskRow(opts.store, opts.row, recordPollFailure(opts.row, httpClass, fetched.status, ""), null, opts.engine);
  }
  const peer = parsePeerTaskResponse(fetched.body);
  const info = peer || parseNativeTaskResult(opts.engine, queryContext, fetched.status, fetched.headers, fetched.body);
  if (isNativeQueryError(info)) {
    const failed = recordPollFailure(opts.row, POLL_HOOK_ERROR, fetched.status, info.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const parsed = info;
  if (!parsed.status || parsed.status === TASK_STATUS_UNKNOWN || !knownPollStatus(parsed.status)) {
    const failed = recordPollFailure(opts.row, POLL_UNRECOGNIZED, fetched.status, parsed.reason || parsed.status);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  if (httpClass === POLL_OTHER_CLIENT && isNonTerminalPollStatus(parsed.status)) {
    const failed = recordPollFailure(opts.row, POLL_UNRECOGNIZED, fetched.status, parsed.reason);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const serverAddress = opts.serverAddress ?? (await opts.store.option("ServerAddress"));
  const applied = applyNativePollToTask(opts.row, parsed, fetched.body, serverAddress);
  return persistTaskRow(opts.store, opts.row, applied, parsed, opts.engine);
}

async function refreshNativeBatchQueryTask(
  opts: {
    store: Store;
    engine: PluginEngine;
    row: Record<string, unknown>;
    serverAddress?: string;
  },
  apiKey: string,
  baseUrl: string,
): Promise<Record<string, unknown>> {
  const packed = buildNativeBatchQueryContext(opts.engine, [opts.row], apiKey, baseUrl);
  if (isNativeQueryError(packed)) {
    const failed = recordPollFailure(opts.row, POLL_HOOK_ERROR, 0, packed.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const descriptor = buildNativeBatchQueryDescriptor(opts.engine, packed.ctx, packed.taskContexts, baseUrl);
  if (isNativeQueryError(descriptor)) {
    const failed = recordPollFailure(opts.row, POLL_HOOK_ERROR, 0, descriptor.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const fetched = await fetchNativeQuery(descriptor);
  if (isNativeQueryError(fetched)) {
    const failed = recordPollFailure(opts.row, POLL_TRANSPORT, 0, fetched.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const httpClass = classifyPollHTTP(fetched.status);
  if (httpClass === POLL_NOT_FOUND) {
    const reason = `upstream task not found (HTTP ${fetched.status})`;
    return persistTaskRow(opts.store, opts.row, failTaskFromPoll(opts.row, reason), failNativeTaskInfo(reason), opts.engine);
  }
  if (httpClass === POLL_AUTH || httpClass === POLL_TRANSIENT) {
    return persistTaskRow(opts.store, opts.row, recordPollFailure(opts.row, httpClass, fetched.status, ""), null, opts.engine);
  }
  const parsed = parseNativeBatchResult(
    opts.engine,
    packed.ctx,
    packed.taskContexts,
    fetched.status,
    fetched.headers,
    fetched.body,
  );
  if (isNativeQueryError(parsed)) {
    const failed = recordPollFailure(opts.row, POLL_HOOK_ERROR, fetched.status, parsed.message);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const upstreamId = getUpstreamTaskID(opts.row);
  const item = parsed[upstreamId];
  if (!item) return opts.row;
  const info = item.taskInfo;
  if (!info.status || info.status === TASK_STATUS_UNKNOWN || !knownPollStatus(info.status)) {
    const failed = recordPollFailure(opts.row, POLL_UNRECOGNIZED, fetched.status, info.reason || info.status);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  if (httpClass === POLL_OTHER_CLIENT && isNonTerminalPollStatus(info.status)) {
    const failed = recordPollFailure(opts.row, POLL_UNRECOGNIZED, fetched.status, info.reason);
    return persistTaskRow(opts.store, opts.row, failed, null, opts.engine);
  }
  const serverAddress = opts.serverAddress ?? (await opts.store.option("ServerAddress"));
  const applied = applyNativePollToTask(opts.row, info, item.data != null ? item.data : {}, serverAddress);
  if (item.data == null) applied.data = opts.row.data;
  if (item.submitTime) applied.submit_time = item.submitTime;
  if (item.startTime) applied.start_time = item.startTime;
  if (item.finishTime) applied.finish_time = item.finishTime;
  if (item.action) applied.action = item.action;
  return persistTaskRow(opts.store, opts.row, applied, info, opts.engine);
}
