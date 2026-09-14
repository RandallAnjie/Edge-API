/**
 * Original `relay.RelayTaskSubmit` + jsplugin `TaskAdaptor` +
 * `controller.presentTaskSubmission` on workerd.
 */
import { tokenAllowsModel } from "./auth.js";
import { resolveBaseUrl } from "./catalog.js";
import {
  cacheGetRandomSatisfiedChannel,
  increaseChannelSelectRetry,
  selectDistributedChannel,
} from "./channel-select.js";
import { PIN_RETRY_SINGLE_ATTEMPT } from "./channel-constraint.js";
import { CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_VERTEX, DEFAULT_GROUP_RATIO, parseJson, ROLE_ADMIN } from "./constants.js";
import { json, noAvailableChannelMessage, openaiError, pluginProtocolSubmissionError, taskErrorJson, tokenModelForbiddenMessage } from "./http.js";
import { type PluginEngine, validateRequestURL } from "./jsplugin.js";
import { requestHeadersFrom } from "./param-override.js";
import type { MatchedPlugin } from "./plugin-dispatch.js";
import { remainingOk } from "./quota.js";
import { defaultModelPrice } from "./ratio-defaults.js";
import { getModelPriceFromMap, getModelRatioFromMap } from "./ratio-setting.js";
import { mapModel, pickChannelKey } from "./select.js";
import { isAlwaysSkipRetryStatusCode } from "./status-code-ranges.js";
import type { Store } from "./store.js";
import {
  buildTaskPluginView,
  protocolRequestJSValue,
  respondTaskPluginError,
  routeRequestJSValue,
  type PreparedNativeRoute,
  type ProtocolRequestContext,
  type RouteRequestContext,
} from "./task-plugin-route.js";
import { openaiVideoView } from "./dto.js";
import type { AuthToken, ChannelRow, Env } from "./types.js";
import {
  encodeNativeSubmitBody,
  parseNativeSubmitParts,
  type NativeSubmitPart,
} from "./task-plugin-submit-body.js";
import { applyCompletionUsageFacts, buildNativeQueryContext, isNativeQueryError, type NativeTaskInfo } from "./task-plugin-query.js";
import { parseSubmitMediaType, readSubmitEvents } from "./task-plugin-submit-sse.js";
import {
  applyOtherRatiosToFloat,
  applyRelayTaskSubmitBilling,
  estimateBillingValidated,
  quotaFromFloat,
} from "./task-plugin-usage.js";

export const MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES = 1 << 20;
const TASK_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type NativeTaskError = {
  code: string;
  message: string;
  statusCode: number;
  localError: boolean;
  noRetry: boolean;
};

export type NativeSubmitDescriptor = {
  responseType: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  action: string;
  model: string;
  rewriteModel: string;
  bodyType: string;
  parts: NativeSubmitPart[];
};

export type NativeSubmitParsed = {
  upstreamTaskId: string;
  taskData: unknown;
  pluginState: unknown;
  immediate: Record<string, unknown> | null;
};

export type NativeSubmitInfo = {
  originModelName: string;
  upstreamModelName: string;
  action: string;
  publicTaskId: string;
  apiKey: string;
  channelBaseUrl: string;
  channelId: number;
  channelType: number;
  usingGroup: string;
};

type SubmitKind = Extract<PreparedNativeRoute, { kind: "submit" }>;

/** Original `model.GenerateTaskID`. */
export function generateTaskID(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let key = "";
  for (const b of bytes) key += TASK_ID_CHARS[b % TASK_ID_CHARS.length];
  return "task_" + key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Original `jsonValue` round-trip for plugin hook arguments. */
export function pluginJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function hookMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function taskErr(code: string, message: string, statusCode: number, localError: boolean, noRetry = false): NativeTaskError {
  return { code, message, statusCode, localError, noRetry };
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

function submitResponseTypes(meta: Record<string, unknown>): string[] {
  if (!("submitResponseTypes" in meta)) return ["json"];
  const items = meta.submitResponseTypes;
  if (!Array.isArray(items) || !items.length) return ["json"];
  return items.map((item) => String(item));
}

function requiredCapabilities(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.requiredCapabilities) ? meta.requiredCapabilities.map((item) => String(item)) : [];
}

function resolvePluginAuth(meta: Record<string, unknown>, apiKey: string): { auth: Record<string, unknown>; apiKey?: string; authError?: string } {
  const authMeta = isPlainObject(meta.auth) ? meta.auth : {};
  const typeName = String(authMeta.type || "").trim();
  if (!typeName || typeName === "none" || typeName === "api_key") {
    return { auth: { authHeader: apiKey }, apiKey };
  }
  return { auth: {}, authError: "oauth2_jwt credentials are not available on workerd" };
}

function userAcceptsUnsetRatio(settingsRaw: unknown): boolean {
  const settings =
    typeof settingsRaw === "string"
      ? parseJson<Record<string, unknown>>(settingsRaw, {})
      : isPlainObject(settingsRaw)
        ? settingsRaw
        : {};
  return Boolean(settings.accept_unset_model_ratio_model);
}

function modelPriceNotConfigured(modelName: string, userRole: number): string {
  if (userRole >= ROLE_ADMIN) {
    return (
      `模型 ${modelName} 的价格未配置。请前往「系统设置 → 运营设置」开启自用模式，或在「系统设置 → 分组与模型定价设置」中为该模型配置价格；` +
      `Model ${modelName} price not configured. Go to System Settings → Operation Settings to enable self-use mode, or configure the model price in System Settings → Group & Model Pricing.`
    );
  }
  return (
    `模型 ${modelName} 的价格尚未由管理员配置，暂时无法使用，请联系站点管理员开启该模型；` +
    `Model ${modelName} has not been priced by the administrator yet. Please contact the site administrator to enable this model.`
  );
}

/** Original `helper.ModelPriceHelperPerCall` (task submit). */
export async function modelPriceHelperPerCall(
  store: Store,
  modelName: string,
  group: string,
  userRole: number,
  userSettings: unknown,
): Promise<
  | { quota: number; modelPrice: number; modelRatio: number; groupRatio: number; usePrice: boolean; freeModel: boolean }
  | NativeTaskError
> {
  const groupRatioMap = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  const groupRatio = groupRatioMap[group] ?? groupRatioMap.default ?? 1;
  const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  const modelPriceMap = parseJson<Record<string, number>>(await store.option("ModelPrice"), {});
  let priced = getModelPriceFromMap(modelName, modelPriceMap);
  let usePrice = priced.configured;
  let modelPrice = priced.price;
  let modelRatio = 0;
  if (!usePrice) {
    const defaults = getModelPriceFromMap(modelName, defaultModelPrice);
    if (defaults.configured) {
      modelPrice = defaults.price;
      usePrice = true;
    } else {
      const selfUse = await store.optionBool("SelfUseModeEnabled", false);
      const ratio = getModelRatioFromMap(
        modelName,
        parseJson<Record<string, number>>(await store.option("ModelRatio"), {}),
        selfUse,
      );
      if (!ratio.configured && !userAcceptsUnsetRatio(userSettings)) {
        return taskErr("model_price_error", modelPriceNotConfigured(ratio.name || modelName, userRole), 400, true);
      }
      modelRatio = ratio.ratio;
    }
  }
  let quota: number;
  let freeModel = false;
  if (usePrice) {
    quota = quotaFromFloat(modelPrice * quotaPerUnit * groupRatio);
    if (groupRatio === 0 || modelPrice === 0) {
      quota = 0;
      freeModel = true;
    }
  } else {
    quota = quotaFromFloat((modelRatio / 2) * quotaPerUnit * groupRatio);
    modelPrice = -1;
    if (groupRatio === 0 || modelRatio === 0) {
      quota = 0;
      freeModel = true;
    }
  }
  return { quota, modelPrice, modelRatio, groupRatio, usePrice, freeModel };
}

export function shouldRetryNativeTaskRelay(err: NativeTaskError, remaining: number, suppress: boolean): boolean {
  if (err.noRetry) return false;
  if (remaining <= 0) return false;
  if (suppress) return false;
  if (err.statusCode === 429) return true;
  if (err.statusCode === 307) return true;
  if (Math.floor(err.statusCode / 100) === 5) {
    if (isAlwaysSkipRetryStatusCode(err.statusCode)) return false;
    return true;
  }
  if (err.statusCode === 400) return false;
  if (err.statusCode === 408) return false;
  if (err.localError) return false;
  if (Math.floor(err.statusCode / 100) === 2) return false;
  return true;
}

/** Original `TaskAdaptor.submitContext`. */
export function buildNativeSubmitContext(opts: {
  engine: PluginEngine;
  requestContext: RouteRequestContext;
  requestBody: unknown;
  req: Request;
  info: NativeSubmitInfo;
  originTasks?: { taskId: string; upstreamTaskId: string; action: string; status: string; data: unknown }[];
}): Record<string, unknown> {
  const meta = pluginMeta(opts.engine);
  const ctx = routeRequestJSValue(opts.requestContext);
  ctx.requestBody = pluginJsonValue(opts.requestBody ?? opts.requestContext.requestBody ?? {});
  ctx.requestHeaders = {
    "Content-Type": opts.req.headers.get("content-type") || "",
    Accept: opts.req.headers.get("accept") || "",
  };
  ctx.files = Array.isArray(opts.requestContext.files) ? pluginJsonValue(opts.requestContext.files) : [];
  ctx.action = opts.info.action;
  ctx.originTaskId = "";
  if (opts.originTasks?.length) {
    ctx.originTasks = opts.originTasks.map((ref) => ({
      taskId: ref.taskId,
      upstreamTaskId: ref.upstreamTaskId,
      action: ref.action,
      status: ref.status,
      data: ref.data,
    }));
  }
  ctx.publicTaskId = opts.info.publicTaskId;
  ctx.model = opts.info.originModelName;
  ctx.upstreamModel = opts.info.upstreamModelName;
  ctx.baseUrl = opts.info.channelBaseUrl;
  ctx.userSetting = {};
  const resolved = resolvePluginAuth(meta, opts.info.apiKey);
  ctx.auth = resolved.auth;
  ctx.authHeader = resolved.auth.authHeader;
  if (resolved.apiKey != null) ctx.apiKey = resolved.apiKey;
  if (resolved.authError) ctx.authError = resolved.authError;
  return ctx;
}

export function descriptorFromHook(value: unknown): NativeSubmitDescriptor {
  const object = isPlainObject(value) ? value : {};
  return {
    responseType: String(object.responseType || ""),
    url: String(object.url || ""),
    method: String(object.method || ""),
    headers: stringMap(object.headers),
    body: Object.prototype.hasOwnProperty.call(object, "body") ? object.body : undefined,
    action: String(object.action || ""),
    model: String(object.model || ""),
    rewriteModel: String(object.rewriteModel || ""),
    bodyType: String(object.bodyType || ""),
    parts: parseNativeSubmitParts(object.parts),
  };
}

export function buildNativeSubmitDescriptor(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  channelBaseUrl: string,
): NativeSubmitDescriptor | NativeTaskError {
  let value: unknown;
  try {
    value = engine.call("buildSubmitRequest", submitContext);
  } catch (err) {
    return taskErr("plugin_request_invalid", hookMessage(err), 400, true);
  }
  const descriptor = descriptorFromHook(value);
  if (!descriptor.responseType) descriptor.responseType = "json";
  const allowed = submitResponseTypes(pluginMeta(engine));
  if (!allowed.includes(descriptor.responseType)) {
    return taskErr(
      "plugin_request_invalid",
      `plugin does not support submit response type ${JSON.stringify(descriptor.responseType)}`,
      400,
      true,
    );
  }
  if (!descriptor.url.trim()) return taskErr("plugin_request_invalid", "plugin returned an empty submit URL", 400, true);
  try {
    validateRequestURL(descriptor.url, channelBaseUrl, allowedHosts(pluginMeta(engine)));
  } catch (err) {
    return taskErr("plugin_request_invalid", hookMessage(err), 400, true);
  }
  return descriptor;
}

function responseHeaders(res: Response): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  res.headers.forEach((value, key) => {
    if (!headers[key]) headers[key] = [];
    headers[key].push(value);
  });
  return headers;
}

export function parseNativeSubmitResponse(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  statusCode: number,
  headers: Record<string, string[]>,
  body: unknown,
): NativeSubmitParsed | NativeTaskError {
  let value: unknown;
  try {
    value = engine.call("parseSubmitResponse", submitContext, { statusCode, headers, body });
  } catch (err) {
    return taskErr("plugin_submit_response_failed", hookMessage(err), 502, false);
  }
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "clientResponse")) {
    return taskErr("plugin_submit_response_invalid", "parseSubmitResponse must not return clientResponse", 502, true);
  }
  const object = isPlainObject(value) ? value : {};
  const taskId = String(object.taskId || "").trim();
  if (!taskId) return taskErr("plugin_submit_response_invalid", "plugin returned an empty taskId", 502, true);
  const taskData = object.taskData;
  if (taskData != null) {
    try {
      if (JSON.stringify(taskData).length > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) {
        return taskErr("plugin_submit_response_invalid", "task data exceeds size limit", 502, true);
      }
    } catch {
      return taskErr("plugin_submit_response_invalid", "task data exceeds size limit", 502, true);
    }
  }
  return {
    upstreamTaskId: taskId,
    taskData,
    pluginState: Object.prototype.hasOwnProperty.call(object, "state") ? object.state : undefined,
    immediate: isPlainObject(object.immediate) ? object.immediate : null,
  };
}

async function doNativeSubmitRequest(
  descriptor: NativeSubmitDescriptor,
  files: { field: string; filename: string; mimeType: string; data: Uint8Array }[] = [],
  opts?: { engine: PluginEngine; submitContext: Record<string, unknown> },
): Promise<{ status: number; headers: Record<string, string[]>; body: unknown; acceptedStream: boolean } | NativeTaskError> {
  const method = (descriptor.method || "POST").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(descriptor.headers)) headers.set(name, value);
  let body: BodyInit | undefined;
  try {
    const encoded = encodeNativeSubmitBody(descriptor, files);
    if (encoded.contentType) headers.set("Content-Type", encoded.contentType);
    if (encoded.body != null) body = encoded.body as unknown as BodyInit;
  } catch (err) {
    return taskErr("build_request_failed", hookMessage(err), 500, false);
  }
  let res: Response;
  try {
    res = await fetch(descriptor.url, { method, headers, body });
  } catch (err) {
    return taskErr("do_request_failed", hookMessage(err), 500, false);
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200) {
    return taskErr("fail_to_fetch_task", new TextDecoder().decode(raw), res.status, false);
  }
  const contentType = res.headers.get("content-type") || "";
  const mediaType = parseSubmitMediaType(contentType);
  const streaming = descriptor.responseType === "sse";
  const acceptedStream = streaming || mediaType === "text/event-stream";
  if (!streaming && acceptedStream) {
    return taskErr("plugin_submit_response_invalid", "unexpected SSE response for a JSON submission", 502, true, true);
  }
  if (streaming) {
    if (!opts) return taskErr("read_response_body_failed", "expected a text/event-stream submit response", 502, false, true);
    try {
      const parsedBody = readSubmitEvents({
        engine: opts.engine,
        driverContext: opts.submitContext,
        contentType,
        body: new TextDecoder().decode(raw),
        requiredCapabilities: requiredCapabilities(pluginMeta(opts.engine)),
      });
      return { status: res.status, headers: responseHeaders(res), body: parsedBody, acceptedStream: true };
    } catch (err) {
      return taskErr("read_response_body_failed", hookMessage(err), 502, false, true);
    }
  }
  if (raw.byteLength > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) {
    return taskErr("read_response_body_failed", "task submit response exceeds size limit", 502, false);
  }
  const text = new TextDecoder().decode(raw);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: responseHeaders(res), body: parsed, acceptedStream };
}

/** Original ParseResponse extractUsageOnComplete on immediate SUCCESS. */
export function applyNativeSubmitCompletionUsage(
  engine: PluginEngine,
  parsed: NativeSubmitParsed,
  info: NativeSubmitInfo,
): void {
  const immediate = parsed.immediate;
  if (!immediate || String(immediate.status || "") !== "SUCCESS") return;
  if (!engine.hasCallablePath("extractUsageOnComplete")) return;
  const privateData: Record<string, unknown> = { upstream_task_id: parsed.upstreamTaskId };
  if (parsed.pluginState != null) privateData.plugin_state = parsed.pluginState;
  const queryContext = buildNativeQueryContext(
    engine,
    {
      task_id: info.publicTaskId,
      action: info.action,
      data: parsed.taskData,
      properties: {
        origin_model_name: info.originModelName,
        upstream_model_name: info.upstreamModelName,
      },
      private_data: privateData,
    },
    info.apiKey,
    info.channelBaseUrl,
  );
  if (isNativeQueryError(queryContext)) return;
  try {
    const facts = engine.call("extractUsageOnComplete", queryContext, pluginJsonValue(immediate), parsed.taskData);
    const result: NativeTaskInfo = {
      code: Number(immediate.code || 0) || 0,
      taskId: String(immediate.taskId || ""),
      status: String(immediate.status || ""),
      progress: String(immediate.progress || ""),
      reason: String(immediate.reason || ""),
      url: String(immediate.url || ""),
      remoteUrl: String(immediate.remoteUrl || ""),
      completionTokens: 0,
      totalTokens: 0,
    };
    applyCompletionUsageFacts(result, facts, info.upstreamModelName || info.originModelName);
    if (result.usageFacts) {
      immediate.usageFacts = result.usageFacts;
      immediate.usage_facts = result.usageFacts;
      immediate.completionTokens = result.completionTokens;
      immediate.totalTokens = result.totalTokens;
    }
  } catch {
    /* original retains reserved quota when the completion hook fails */
  }
}

function taskStatusFromImmediate(immediate: Record<string, unknown> | null): {
  status: string;
  progress: string;
  failReason: string;
} {
  if (!immediate) return { status: "NOT_START", progress: "0%", failReason: "" };
  return {
    status: String(immediate.status || "NOT_START"),
    progress: String(immediate.progress || "0%"),
    failReason: String(immediate.reason || ""),
  };
}

/** Original `controller.presentTaskSubmission`. */
export function presentTaskSubmission(opts: {
  engine: PluginEngine;
  requestContext: RouteRequestContext;
  render: string;
  taskRow: Record<string, unknown>;
  originModelName: string;
  otherRatios?: Record<string, number> | null;
  protocol?: string;
  operation?: string;
}): Response {
  const otherRatios = opts.otherRatios && Object.keys(opts.otherRatios).length ? opts.otherRatios : {};
  const extra: HeadersInit = { "X-New-Api-Other-Ratios": JSON.stringify(otherRatios) };
  if (opts.render) {
    try {
      const view = buildTaskPluginView(opts.taskRow);
      const body = opts.engine.callPath("native", [opts.render], [routeRequestJSValue(opts.requestContext), view]);
      return json(200, body, extra);
    } catch {
      /* host fallback */
    }
  }
  if (opts.protocol === "openai_video" && opts.operation === "create") {
    return json(200, openaiVideoView(opts.taskRow), extra);
  }
  const createdAt = Number(opts.taskRow.created_at || 0) || Number(opts.taskRow.submit_time || 0);
  return json(
    200,
    {
      id: String(opts.taskRow.task_id || ""),
      task_id: String(opts.taskRow.task_id || ""),
      status: "queued",
      model: opts.originModelName,
      created_at: createdAt,
    },
    extra,
  );
}

async function persistNativeTask(opts: {
  store: Store;
  auth: AuthToken;
  plugin: MatchedPlugin;
  engine: PluginEngine;
  info: NativeSubmitInfo;
  parsed: NativeSubmitParsed;
  quota: number;
  requestId: string;
  requestPath: string;
  otherRatios: Record<string, number>;
}): Promise<Record<string, unknown>> {
  const immediate = taskStatusFromImmediate(opts.parsed.immediate);
  const meta = pluginMeta(opts.engine);
  const privateData: Record<string, unknown> = {
    upstream_task_id: opts.parsed.upstreamTaskId,
    execution: {
      request_id: opts.requestId,
      request_path: opts.requestPath,
      task_plugin: {
        key: opts.plugin.key,
        name: String(meta.name || opts.plugin.key),
        version: String(meta.version || opts.plugin.version || ""),
        api_version: Number(meta.apiVersion ?? 1),
        author: isPlainObject(meta.author) ? { name: String(meta.author.name || ""), url: String(meta.author.url || "") } : undefined,
      },
    },
    billing_context: { other_ratios: opts.otherRatios, origin_model_name: opts.info.originModelName },
  };
  if (opts.parsed.pluginState != null) privateData.plugin_state = opts.parsed.pluginState;
  if (opts.info.channelType === CHANNEL_TYPE_GEMINI || opts.info.channelType === CHANNEL_TYPE_VERTEX) {
    privateData.key = opts.info.apiKey;
  }
  if (opts.parsed.immediate && typeof opts.parsed.immediate.url === "string" && opts.parsed.immediate.url) {
    privateData.result_url = opts.parsed.immediate.url;
  }
  await opts.store.insertTask({
    task_id: opts.info.publicTaskId,
    user_id: opts.auth.user.id,
    token_id: opts.auth.token.id,
    channel_id: opts.info.channelId,
    group: opts.info.usingGroup,
    quota: opts.quota,
    platform: opts.plugin.key,
    action: opts.info.action,
    status: immediate.status,
    progress: immediate.progress,
    model_name: opts.info.originModelName,
    fail_reason: immediate.failReason,
    properties: {
      origin_model_name: opts.info.originModelName,
      upstream_model_name: opts.info.upstreamModelName,
    },
    data: opts.parsed.taskData ?? null,
    private_data: privateData,
  });
  return (
    (await opts.store.getTaskByTid(opts.info.publicTaskId)) || {
      task_id: opts.info.publicTaskId,
      status: immediate.status,
      progress: immediate.progress,
      platform: opts.plugin.key,
      data: opts.parsed.taskData,
      private_data: JSON.stringify(privateData),
    }
  );
}

async function relayTaskSubmitOnce(opts: {
  engine: PluginEngine;
  prepared: SubmitKind;
  req: Request;
  channel: ChannelRow;
  info: NativeSubmitInfo;
  store: Store;
  auth: AuthToken;
}): Promise<{ parsed: NativeSubmitParsed; info: NativeSubmitInfo; otherRatios: Record<string, number>; quota: number } | NativeTaskError> {
  const info = { ...opts.info };
  let mapped = info.originModelName;
  try {
    mapped = mapModel(opts.channel.model_mapping, info.originModelName);
  } catch (err) {
    return taskErr("model_mapping_failed", hookMessage(err), 400, true);
  }
  info.upstreamModelName = mapped;
  const submitContext = buildNativeSubmitContext({
    engine: opts.engine,
    requestContext: opts.prepared.requestContext,
    requestBody: opts.prepared.requestBody,
    req: opts.req,
    info,
    originTasks: opts.prepared.origin.tasks,
  });
  const descriptor = buildNativeSubmitDescriptor(opts.engine, submitContext, info.channelBaseUrl);
  if ("statusCode" in descriptor) return descriptor;
  if (descriptor.action) info.action = descriptor.action;
  if (descriptor.model) info.originModelName = descriptor.model;
  if (descriptor.rewriteModel) info.upstreamModelName = descriptor.rewriteModel;
  submitContext.action = info.action;
  submitContext.model = info.originModelName;
  submitContext.upstreamModel = info.upstreamModelName;

  const priced = await modelPriceHelperPerCall(
    opts.store,
    info.originModelName,
    info.usingGroup,
    opts.auth.user.role || 0,
    opts.auth.user.settings,
  );
  if ("statusCode" in priced) return priced;
  const estimated = estimateBillingValidated(
    opts.engine,
    submitContext,
    info.upstreamModelName || info.originModelName,
  );
  if ("error" in estimated) return taskErr("plugin_usage_invalid", estimated.error, 400, true);
  const estimatedRatios = estimated.ratios && Object.keys(estimated.ratios).length ? estimated.ratios : {};
  let quota = priced.quota;
  if (!priced.freeModel && Object.keys(estimatedRatios).length) {
    quota = quotaFromFloat(applyOtherRatiosToFloat(quota, estimatedRatios));
  }

  const upstream = await doNativeSubmitRequest(descriptor, opts.prepared.requestContext.fileContents || [], {
    engine: opts.engine,
    submitContext,
  });
  if ("statusCode" in upstream) return upstream;
  const parsed = parseNativeSubmitResponse(opts.engine, submitContext, upstream.status, upstream.headers, upstream.body);
  if ("statusCode" in parsed) {
    if (upstream.acceptedStream) parsed.noRetry = true;
    return parsed;
  }
  applyNativeSubmitCompletionUsage(opts.engine, parsed, info);
  const billed = applyRelayTaskSubmitBilling({
    engine: opts.engine,
    submitContext,
    modelName: info.upstreamModelName || info.originModelName,
    taskData: parsed.taskData,
    immediate: parsed.immediate,
    quota,
    otherRatios: estimatedRatios,
  });
  return { parsed, info, otherRatios: billed.otherRatios, quota: billed.quota };
}

function nativeSubmitError(prepared: SubmitKind, engine: PluginEngine, err: NativeTaskError, requestId: string): Response {
  if (prepared.protocol === "openai_responses") return pluginProtocolSubmissionError(err);
  if (prepared.protocol) return taskErrorJson(err.statusCode, err.code, err.message);
  return respondTaskPluginError(engine, prepared.requestContext, err.statusCode, err.message, requestId);
}

export type NativeTaskPersistOutcome = {
  row: Record<string, unknown>;
  originModelName: string;
  otherRatios: Record<string, number>;
  engine: PluginEngine;
};

/** Original `TaskAdaptor.ValidateRequestAndSetAction` final protocol decode. */
export function validateFinalProtocolDecoder(
  engine: PluginEngine,
  protocol: string,
  pinnedModel: string,
  protocolContext: ProtocolRequestContext,
): { requestBody?: unknown; action?: string } | NativeTaskError {
  let resolvedValue: unknown;
  try {
    resolvedValue = engine.callPath("protocols", [protocol, "decodeRequest"], [protocolRequestJSValue(protocolContext)]);
  } catch (err) {
    return taskErr("plugin_request_invalid", hookMessage(err), 400, true);
  }
  if (!isPlainObject(resolvedValue) || typeof resolvedValue.model !== "string" || resolvedValue.model !== pinnedModel) {
    return taskErr("plugin_request_invalid", "final task plugin decoder rejected the pinned model", 400, true);
  }
  if (Object.prototype.hasOwnProperty.call(resolvedValue, "renderer")) {
    return taskErr("plugin_request_invalid", "decoder must not return renderer", 400, true);
  }
  const out: { requestBody?: unknown; action?: string } = {};
  if (Object.prototype.hasOwnProperty.call(resolvedValue, "requestBody")) out.requestBody = resolvedValue.requestBody;
  if (typeof resolvedValue.action === "string" && resolvedValue.action.trim()) out.action = resolvedValue.action;
  return out;
}

/** Original `controller.executeTaskSubmission` native persist without presenting. */
export async function executeNativeTaskSubmission(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  plugin: MatchedPlugin,
  prepared: SubmitKind,
  requestId: string,
): Promise<NativeTaskPersistOutcome | { error: Response }> {
  const path = new URL(req.url).pathname;
  const engine = prepared.engine;
  if (prepared.protocol && prepared.protocolContext) {
    const decoded = validateFinalProtocolDecoder(engine, prepared.protocol, prepared.model, prepared.protocolContext);
    if ("statusCode" in decoded) return { error: nativeSubmitError(prepared, engine, decoded, requestId) };
    if (Object.prototype.hasOwnProperty.call(decoded, "requestBody")) prepared.requestBody = decoded.requestBody;
    if (decoded.action) prepared.action = decoded.action;
  }
  const model = prepared.model;
  if (!tokenAllowsModel(auth.token, model)) {
    if (prepared.protocol === "openai_responses") {
      return { error: pluginProtocolSubmissionError({ statusCode: 403, code: "model_not_allowed", message: tokenModelForbiddenMessage(req, model) }) };
    }
    return { error: openaiError(403, tokenModelForbiddenMessage(req, model), "model_not_allowed") };
  }

  const selected = await selectDistributedChannel({
    store,
    env,
    req,
    auth,
    model,
    requestPath: path,
    body: prepared.requestBody,
    headers: requestHeadersFrom(req),
    expectedTaskPluginKey: plugin.key,
    taskPluginChannelTypes: plugin.channelTypes,
    originPin: prepared.origin.pin,
  });
  if (selected.error) {
    if (prepared.protocol === "openai_responses") {
      return { error: pluginProtocolSubmissionError({ statusCode: selected.error.status, code: selected.error.code, message: selected.error.message }) };
    }
    return { error: openaiError(selected.error.status, selected.error.message, selected.error.code) };
  }
  auth.usingGroup = selected.usingGroup;
  let channel = selected.channel;
  if (!channel) {
    if (prepared.protocol === "openai_responses") {
      return {
        error: pluginProtocolSubmissionError({
          statusCode: 503,
          code: "no_available_channel",
          message: noAvailableChannelMessage(req, auth.usingGroup, model),
        }),
      };
    }
    return { error: openaiError(503, noAvailableChannelMessage(req, auth.usingGroup, model), "no_available_channel") };
  }

  const retryTimes = await store.optionNum("RetryTimes", 0);
  const suppress = selected.pinRetryMode === PIN_RETRY_SINGLE_ATTEMPT;
  const publicTaskId = generateTaskID();
  let lastErr: NativeTaskError | null = null;
  let outcome: { parsed: NativeSubmitParsed; info: NativeSubmitInfo; otherRatios: Record<string, number>; quota: number } | null =
    null;
  let preconsumed = 0;

  for (let attempt = 0; attempt <= retryTimes; attempt++) {
    if (!channel) break;
    const apiKey = pickChannelKey(channel.key);
    const info: NativeSubmitInfo = {
      originModelName: model,
      upstreamModelName: model,
      action: prepared.action,
      publicTaskId,
      apiKey,
      channelBaseUrl: resolveBaseUrl(channel.type, channel.base_url),
      channelId: channel.id,
      channelType: channel.type,
      usingGroup: auth.usingGroup,
    };
    const result = await relayTaskSubmitOnce({ engine, prepared, req, channel, info, store, auth });
    if (!("statusCode" in result)) {
      if (!preconsumed && result.quota > 0) {
        const shortage = remainingOk(
          auth.user.quota,
          auth.token.remain_quota,
          Boolean(Number(auth.token.unlimited_quota)),
          result.quota,
        );
        if (shortage) {
          lastErr = taskErr("insufficient_user_quota", shortage, 403, true);
          break;
        }
        await store.consumeQuota(auth.user.id, auth.token.id, channel.id, result.quota);
        auth.user.quota -= result.quota;
        preconsumed = result.quota;
      }
      outcome = result;
      lastErr = null;
      break;
    }
    lastErr = result;
    const remaining = retryTimes - attempt;
    if (!shouldRetryNativeTaskRelay(result, remaining, suppress)) break;
    if (!selected.pinned) {
      increaseChannelSelectRetry(selected.selectState);
      const next = await cacheGetRandomSatisfiedChannel(store, selected.selectParam, selected.selectState);
      if (!next.channel) break;
      channel = next.channel;
      if (next.selectGroup && next.selectGroup !== "auto") auth.usingGroup = next.selectGroup;
    }
  }

  if (lastErr) {
    if (preconsumed) await store.addQuota(auth.user.id, preconsumed);
    return { error: nativeSubmitError(prepared, engine, lastErr, requestId) };
  }
  if (!outcome) {
    return { error: nativeSubmitError(prepared, engine, taskErr("task_submit_failed", "task submission returned no result", 500, true), requestId) };
  }

  let row: Record<string, unknown>;
  try {
    row = await persistNativeTask({
      store,
      auth,
      plugin,
      engine,
      info: outcome.info,
      parsed: outcome.parsed,
      quota: outcome.quota,
      requestId,
      requestPath: path,
      otherRatios: outcome.otherRatios,
    });
  } catch (err) {
    if (preconsumed) await store.addQuota(auth.user.id, preconsumed);
    return { error: nativeSubmitError(prepared, engine, taskErr("task_insert_failed", hookMessage(err), 500, true), requestId) };
  }

  return { row, originModelName: outcome.info.originModelName, otherRatios: outcome.otherRatios, engine };
}

/** Original `controller.RelayTask` native submit after `PrepareTaskPluginRoute`. */
export async function continueNativeSubmit(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  plugin: MatchedPlugin,
  prepared: SubmitKind,
  requestId: string,
): Promise<Response> {
  const result = await executeNativeTaskSubmission(req, env, store, auth, plugin, prepared, requestId);
  if ("error" in result) return result.error;
  return presentTaskSubmission({
    engine: result.engine,
    requestContext: prepared.requestContext,
    render: String(plugin.route?.render || ""),
    taskRow: result.row,
    originModelName: result.originModelName,
    otherRatios: result.otherRatios,
    protocol: prepared.protocol,
    operation: prepared.operation,
  });
}
