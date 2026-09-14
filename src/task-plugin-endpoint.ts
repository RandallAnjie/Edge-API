/**
 * Original `middleware.PinTaskPluginEndpoint` + `PrepareTaskPluginEndpoint`
 * + `controller.RelayTaskPluginEndpoint` openai_video create on workerd.
 */
import { goUnmarshalJSON } from "./channel-validate.js";
import {
  BODY_JSON,
  BODY_MULTIPART,
  ROUTE_SUBMIT,
  TASK_PLUGIN_INVALID_ROUTE_RESULT,
  UnsupportedTaskPluginMediaType,
  buildTaskPluginRouteRequest,
  hookDetail,
  loadCompiledPlugin,
  pluginRequestId,
  protocolRequestJSValue,
  type ProtocolRequestContext,
  type RouteRequestContext,
} from "./task-plugin-route.js";
import { messageWithRequestId, pluginProtocolError } from "./http.js";
import { applyOriginTaskIntent } from "./origin-task.js";
import {
  hostProtocolHasDefinedModes,
  lookupEndpointCandidates,
  lookupHostProtocolOperation,
  pluginProtocolSupports,
  unsupportedProtocolFormMessage,
  type EndpointCandidate,
  type MatchedPlugin,
} from "./plugin-dispatch.js";
import { serveTaskPluginProtocolCreate } from "./task-plugin-protocol-serve.js";
import { continueNativeSubmit } from "./task-plugin-submit.js";
import type { Store } from "./store.js";
import type { AuthToken, Env, ExecutionContextLike } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function abortOpenAi(status: number, message: string, requestId: string, code = ""): Response {
  return pluginProtocolError(status, code, messageWithRequestId(message, requestId));
}

function extractFormModel(buf: ArrayBuffer): string {
  const text = new TextDecoder("latin1").decode(buf.slice(0, 16_384));
  const re = new RegExp(`name="model"\\r\\n\\r\\n([^\\r]*)`);
  return (text.match(re)?.[1] || "").trim();
}

/** Original `getModelFromRequest` subset used by Pin for host protocol paths. */
export async function pinEndpointModel(req: Request): Promise<{ model: string } | { error: string }> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  const clone = req.clone();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    let raw: string;
    try {
      raw = await clone.text();
    } catch {
      return { error: "Invalid task protocol request" };
    }
    const decoded = goUnmarshalJSON(raw);
    if (!decoded.ok) return { error: "Invalid task protocol request" };
    if (decoded.value && typeof decoded.value === "object" && !Array.isArray(decoded.value)) {
      const body = decoded.value as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(body, "model")) return { model: "" };
      if (typeof body.model !== "string") return { error: "Invalid task protocol request" };
      return { model: body.model };
    }
    return { model: "" };
  }
  if (contentType.includes("multipart/form-data")) {
    try {
      const buf = await clone.arrayBuffer();
      return { model: extractFormModel(buf) };
    } catch {
      return { error: "Invalid task protocol request" };
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const raw = await clone.text();
      return { model: new URLSearchParams(raw).get("model") || "" };
    } catch {
      return { error: "Invalid task protocol request" };
    }
  }
  if (!contentType) {
    try {
      const raw = await clone.text();
      if (!raw) return { model: "" };
      const decoded = goUnmarshalJSON(raw);
      if (!decoded.ok) return { error: "Invalid task protocol request" };
      if (decoded.value && typeof decoded.value === "object" && !Array.isArray(decoded.value)) {
        const body = decoded.value as Record<string, unknown>;
        if (typeof body.model === "string") return { model: body.model };
        if (Object.prototype.hasOwnProperty.call(body, "model")) return { error: "Invalid task protocol request" };
      }
      return { model: "" };
    } catch {
      return { error: "Invalid task protocol request" };
    }
  }
  return { error: "Invalid task protocol request" };
}

function rewritePinnedMultipartModel(requestContext: RouteRequestContext, pinnedModel: string): void {
  const body = isPlainObject(requestContext.body) ? requestContext.body : null;
  if (!body || body.kind !== BODY_MULTIPART) return;
  const fields = isPlainObject(body.fields) ? (body.fields as Record<string, unknown>) : null;
  if (!fields) return;
  const values = fields.model;
  if (Array.isArray(values) && typeof values[0] === "string" && values[0] !== pinnedModel) {
    values[0] = pinnedModel;
  }
}

function protocolStreamFlag(requestContext: RouteRequestContext): { stream: boolean } | { error: string } {
  const body = isPlainObject(requestContext.body) ? requestContext.body : null;
  if (!body || body.kind !== BODY_JSON) return { stream: false };
  const value = isPlainObject(body.value) ? body.value : null;
  if (!value || !Object.prototype.hasOwnProperty.call(value, "stream")) return { stream: false };
  if (typeof value.stream !== "boolean") return { error: "stream must be a boolean" };
  return { stream: value.stream };
}

function decodeCandidate(
  candidate: EndpointCandidate,
  protocolContext: ProtocolRequestContext,
  pinnedModel: string,
): { resolved: Record<string, unknown>; engine: ReturnType<typeof loadCompiledPlugin>["engine"] } | { detail: string; reason: string } {
  let engine;
  try {
    if (!candidate.plugin.source) throw new Error("plugin source is empty");
    engine = loadCompiledPlugin(candidate.plugin.source, candidate.plugin.key, candidate.plugin.version || "").engine;
  } catch {
    return { detail: "Task protocol request failed", reason: "compile_failed" };
  }
  const candidateContext: ProtocolRequestContext = {
    ...protocolContext,
    protocol: candidate.protocol,
    operation: candidate.operation.operation,
  };
  let resolvedValue: unknown;
  try {
    resolvedValue = engine.callPath("protocols", [candidate.protocol, "decodeRequest"], [protocolRequestJSValue(candidateContext)]);
  } catch (err) {
    const detail = hookDetail(err) || "Invalid task protocol request";
    return { detail, reason: "hook_failed" };
  }
  if (!isPlainObject(resolvedValue)) {
    return { detail: TASK_PLUGIN_INVALID_ROUTE_RESULT, reason: "result_not_object" };
  }
  const kind = typeof resolvedValue.kind === "string" ? resolvedValue.kind : "";
  if (kind !== ROUTE_SUBMIT) {
    return { detail: TASK_PLUGIN_INVALID_ROUTE_RESULT, reason: "unsupported_kind" };
  }
  const model = typeof resolvedValue.model === "string" ? resolvedValue.model : "";
  if (!model.trim()) {
    return { detail: "decoded request is missing a model", reason: "invalid_model" };
  }
  if (model !== pinnedModel || !candidate.plugin.models.includes(model)) {
    return { detail: `model ${JSON.stringify(model)} is not served by this plugin`, reason: "resolved_model_not_owned" };
  }
  return { resolved: resolvedValue, engine };
}

/** Original `PrepareTaskPluginEndpoint` for a pinned openai_video create. */
export async function prepareTaskPluginEndpoint(
  store: Store,
  userId: number,
  req: Request,
  path: string,
  candidates: EndpointCandidate[],
  pinnedModel: string,
  requestId: string,
): Promise<{ kind: "response"; response: Response } | { kind: "submit"; plugin: MatchedPlugin; prepared: Extract<import("./task-plugin-route.js").PreparedNativeRoute, { kind: "submit" }> }> {
  if (!candidates.length) {
    return { kind: "response", response: abortOpenAi(500, "Task protocol request failed", requestId) };
  }
  const first = candidates[0];
  if (!first.operation.bodyKinds.length) {
    return { kind: "response", response: abortOpenAi(501, "Task protocol bridge is not available", requestId) };
  }
  let requestContext: RouteRequestContext;
  try {
    requestContext = await buildTaskPluginRouteRequest(req, path, {});
  } catch (err) {
    const status = err instanceof UnsupportedTaskPluginMediaType ? 415 : 400;
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "response", response: abortOpenAi(status, detail, requestId) };
  }
  rewritePinnedMultipartModel(requestContext, pinnedModel);
  const bodyObject = isPlainObject(requestContext.body) ? requestContext.body : { kind: "none" };
  const bodyKind = String(bodyObject.kind || "none");
  const allowed = first.operation.bodyKinds;
  if (!allowed.includes(bodyKind)) {
    const detail =
      allowed.length === 1 && allowed[0] === BODY_JSON
        ? "this route requires a JSON body"
        : "unsupported request body for this operation";
    return { kind: "response", response: abortOpenAi(415, detail, requestId) };
  }
  const streamFlag = protocolStreamFlag(requestContext);
  if ("error" in streamFlag) return { kind: "response", response: abortOpenAi(400, streamFlag.error, requestId) };

  const protocolContext: ProtocolRequestContext = {
    ...requestContext,
    protocol: first.protocol,
    operation: first.operation.operation,
    model: pinnedModel,
    stream: streamFlag.stream,
  };

  const accepted: EndpointCandidate[] = [];
  const failures: string[] = [];
  const rejectedPlugins = new Map<string, string[]>();
  let resolved: Record<string, unknown> | null = null;
  let acceptedEngine: ReturnType<typeof loadCompiledPlugin>["engine"] | null = null;
  let acceptedContext = protocolContext;
  for (const candidate of candidates) {
    const decoded = decodeCandidate(candidate, protocolContext, pinnedModel);
    if ("detail" in decoded) {
      if (!rejectedPlugins.has(decoded.detail)) failures.push(decoded.detail);
      rejectedPlugins.set(decoded.detail, [...(rejectedPlugins.get(decoded.detail) || []), candidate.plugin.key]);
      continue;
    }
    accepted.push(candidate);
    if (!resolved) {
      resolved = decoded.resolved;
      acceptedEngine = decoded.engine;
      acceptedContext = {
        ...protocolContext,
        protocol: candidate.protocol,
        operation: candidate.operation.operation,
      };
    }
  }
  if (!accepted.length || !resolved || !acceptedEngine) {
    const details =
      candidates.length > 1
        ? failures.map((detail) => `${(rejectedPlugins.get(detail) || []).join(", ")}: ${detail}`)
        : failures;
    return { kind: "response", response: abortOpenAi(400, details.join("; ") || "Invalid task protocol request", requestId) };
  }

  const plugin = accepted[0].plugin;
  let action = "";
  if (Object.prototype.hasOwnProperty.call(resolved, "action")) {
    if (typeof resolved.action !== "string") {
      return { kind: "response", response: abortOpenAi(400, TASK_PLUGIN_INVALID_ROUTE_RESULT, requestId) };
    }
    action = resolved.action;
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
      response: abortOpenAi(intent.error.statusCode, intent.error.message, requestId, intent.error.code),
    };
  }
  return {
    kind: "submit",
    plugin,
    prepared: {
      kind: "submit",
      model: pinnedModel,
      action,
      requestBody: requestContext.requestBody,
      resolved,
      engine: acceptedEngine,
      requestContext,
      origin: intent,
      protocol: accepted[0].protocol,
      operation: accepted[0].operation.operation,
      protocolContext: acceptedContext,
    },
  };
}

async function pinJsonBoolFlags(req: Request): Promise<{ stream: boolean; background: boolean }> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return { stream: false, background: false };
  }
  try {
    const raw = await req.clone().text();
    if (!raw) return { stream: false, background: false };
    const decoded = goUnmarshalJSON(raw);
    if (!decoded.ok || !decoded.value || typeof decoded.value !== "object" || Array.isArray(decoded.value)) {
      return { stream: false, background: false };
    }
    const body = decoded.value as Record<string, unknown>;
    return { stream: body.stream === true, background: body.background === true };
  } catch {
    return { stream: false, background: false };
  }
}

function filterModeCandidates(
  candidates: EndpointCandidate[],
  protocol: string,
  stream: boolean,
  background: boolean,
): EndpointCandidate[] {
  const required: string[] = [];
  if (stream) required.push("stream");
  if (background) required.push("background");
  if (!stream && !background) required.push("sync");
  return candidates.filter((candidate) => required.every((mode) => pluginProtocolSupports(candidate.plugin, protocol, mode)));
}

/**
 * Original claimed host protocol create (`POST /v1/videos` or `POST /v1/responses`).
 * Returns null when Pin leaves the request on ordinary Relay / RelayTask.
 */
export async function tryRelayTaskPluginEndpoint(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  ctx: ExecutionContextLike;
}): Promise<Response | null> {
  const path = new URL(opts.req.url).pathname;
  const operation = lookupHostProtocolOperation(opts.req.method, path);
  if (!operation || operation.operation !== "create") return null;
  if (operation.protocol !== "openai_video" && operation.protocol !== "openai_responses") return null;
  const requestId = pluginRequestId(opts.req);
  const pinned = await pinEndpointModel(opts.req);
  if ("error" in pinned) return abortOpenAi(400, pinned.error, requestId);
  if (!pinned.model.trim()) return null;
  let candidates = await lookupEndpointCandidates(opts.store, opts.req.method, path, pinned.model);
  if (!candidates.length) return null;
  if (hostProtocolHasDefinedModes(operation.protocol)) {
    const flags = await pinJsonBoolFlags(opts.req);
    const unfiltered = candidates;
    candidates = filterModeCandidates(candidates, operation.protocol, flags.stream, flags.background);
    if (!candidates.length) {
      return abortOpenAi(400, unsupportedProtocolFormMessage(unfiltered, operation.protocol, flags.stream, flags.background), requestId);
    }
  }
  const prepared = await prepareTaskPluginEndpoint(
    opts.store,
    opts.auth.user.id,
    opts.req,
    path,
    candidates,
    pinned.model,
    requestId,
  );
  if (prepared.kind === "response") return prepared.response;
  if (operation.protocol === "openai_responses") {
    return serveTaskPluginProtocolCreate({
      req: opts.req,
      env: opts.env,
      store: opts.store,
      auth: opts.auth,
      plugin: prepared.plugin,
      prepared: prepared.prepared,
      requestId,
    });
  }
  return continueNativeSubmit(opts.req, opts.env, opts.store, opts.auth, prepared.plugin, prepared.prepared, requestId);
}

/** Original claimed `POST /v1/videos` host protocol create. */
export async function tryRelayOpenAIVideoCreate(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  ctx: ExecutionContextLike;
}): Promise<Response | null> {
  const path = new URL(opts.req.url).pathname;
  if (path !== "/v1/videos") return null;
  return tryRelayTaskPluginEndpoint(opts);
}
