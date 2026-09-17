/**
 * Original `controller.serveTaskPluginProtocol` + retrieve on workerd.
 */
import { parseJson } from "./constants.js";
import { buildTaskArtifactContentURL } from "./dto.js";
import { json, pluginProtocolError } from "./http.js";
import type { PluginEngine } from "./jsplugin.js";
import type { MatchedPlugin } from "./plugin-dispatch.js";
import { listRoutingPlugins } from "./task-plugin-factory.js";
import {
  decodePluginProtocolEventResult,
  encodePluginResponsesStreamEvent,
  PluginResponsesMachine,
  pluginProtocolEventsTerminal,
  protocolStatePluginValue,
  type PluginResponsesStreamEvent,
  type ProtocolState,
} from "./task-plugin-protocol.js";
import {
  BODY_JSON,
  BODY_NONE,
  buildTaskPluginView,
  loadCompiledPlugin,
  protocolRequestJSValue,
  type PreparedNativeRoute,
  type ProtocolRequestContext,
} from "./task-plugin-route.js";
import { refreshNativeQueryTask } from "./task-plugin-query.js";
import { executeNativeTaskSubmission } from "./task-plugin-submit.js";
import type { Store } from "./store.js";
import type { AuthToken, Env } from "./types.js";

const PROTOCOL_TIMEOUT_MS = 600_000;
const TICK_MS = 2000;
const TICK_JITTER_MS = 500;
const HEARTBEAT_MS = 15_000;
const TASK_ARTIFACT_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

type SubmitKind = Extract<PreparedNativeRoute, { kind: "submit" }>;

type ObservationLimits = { global: number; perPlugin: number; perUser: number; perToken: number };

const defaultObservationLimits: ObservationLimits = { global: 128, perPlugin: 32, perUser: 4, perToken: 2 };

class PluginProtocolObservationLimiter {
  global = 0;
  plugin = new Map<string, number>();
  user = new Map<number, number>();
  token = new Map<number, number>();
  constructor(private limits: ObservationLimits) {}
  acquire(pluginKey: string, userID: number, tokenID: number): (() => void) | { error: Response } {
    const key = pluginKey.trim();
    if (!key || userID <= 0 || tokenID <= 0) {
      return { error: pluginProtocolError(401, "authentication_error", "Authentication failed") };
    }
    const pluginCount = this.plugin.get(key) || 0;
    const userCount = this.user.get(userID) || 0;
    const tokenCount = this.token.get(tokenID) || 0;
    if (this.global >= this.limits.global || pluginCount >= this.limits.perPlugin || userCount >= this.limits.perUser || tokenCount >= this.limits.perToken) {
      return { error: pluginProtocolError(429, "rate_limit_exceeded", "Too many active task observations") };
    }
    this.global += 1;
    this.plugin.set(key, pluginCount + 1);
    this.user.set(userID, userCount + 1);
    this.token.set(tokenID, tokenCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.global = Math.max(0, this.global - 1);
      const nextPlugin = (this.plugin.get(key) || 1) - 1;
      if (nextPlugin <= 0) this.plugin.delete(key);
      else this.plugin.set(key, nextPlugin);
      const nextUser = (this.user.get(userID) || 1) - 1;
      if (nextUser <= 0) this.user.delete(userID);
      else this.user.set(userID, nextUser);
      const nextToken = (this.token.get(tokenID) || 1) - 1;
      if (nextToken <= 0) this.token.delete(tokenID);
      else this.token.set(tokenID, nextToken);
    };
  }
}

const observationAdmissions = new PluginProtocolObservationLimiter(defaultObservationLimits);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePrivate(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.private_data;
  if (isPlainObject(raw)) return { ...raw };
  return parseJson<Record<string, unknown>>(String(raw || ""), {});
}

function parseProperties(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.properties;
  if (isPlainObject(raw)) return raw;
  return parseJson<Record<string, unknown>>(String(raw || ""), {});
}

function protocolBackgroundFlag(ctx: ProtocolRequestContext): boolean {
  const body = isPlainObject(ctx.body) ? ctx.body : null;
  if (!body || body.kind !== BODY_JSON) return false;
  const value = isPlainObject(body.value) ? body.value : null;
  return Boolean(value && value.background === true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fnv64a(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

function pluginProtocolTickDelay(taskID: string, tick: number, base: number, jitter: number): number {
  if (jitter <= 0) return base;
  return base + Number(fnv64a(`${taskID}:${tick}`) % BigInt(jitter + 1));
}

function createdAtOf(row: Record<string, unknown>): number {
  return Number(row.created_at || 0) || Number(row.submit_time || 0) || Math.floor(Date.now() / 1000);
}

function originModelName(row: Record<string, unknown>, fallback: string): string {
  const properties = parseProperties(row);
  return String(properties.origin_model_name || row.model_name || fallback);
}

function pluginJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function taskArtifactContext(row: Record<string, unknown>): Record<string, unknown> {
  const privateData = parsePrivate(row);
  const execution = isPlainObject(privateData.execution) ? privateData.execution : {};
  const snapshot = isPlainObject(execution.task_plugin) ? execution.task_plugin : {};
  let data: unknown = null;
  const raw = row.data;
  if (raw != null && String(raw) !== "") {
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    } else data = raw;
  }
  return {
    taskId: String(row.task_id || ""),
    status: String(row.status || ""),
    action: String(row.action || ""),
    data,
    state: Object.prototype.hasOwnProperty.call(privateData, "plugin_state") ? privateData.plugin_state : null,
    producerVersion: String(snapshot.version || ""),
  };
}

type ProjectedArtifact = { key: string; type: string; mimeType?: string };

function validateProjectedTaskArtifacts(value: unknown): ProjectedArtifact[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("plugin listArtifacts must return an array");
  if (value.length > 64) throw new Error("too many artifacts");
  const seen = new Set<string>();
  const artifacts: ProjectedArtifact[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) throw new Error("invalid artifact identity");
    const key = String(item.key || "");
    const type = String(item.type || "");
    if (key !== key.trim() || type !== type.trim()) throw new Error("invalid artifact identity");
    if (!TASK_ARTIFACT_KEY.test(key)) throw new Error("invalid artifact key");
    if (seen.has(key)) throw new Error("duplicate artifact key");
    seen.add(key);
    if (type !== "video" && type !== "audio" && type !== "image" && type !== "file") throw new Error("invalid artifact type");
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : "";
    if (mimeType.length > 255 || /[\r\n]/.test(mimeType)) throw new Error("invalid artifact mime type");
    artifacts.push(mimeType ? { key, type, mimeType } : { key, type });
  }
  return artifacts;
}

async function rendererContextWithArtifacts(
  store: Store,
  engine: PluginEngine,
  protocolContext: ProtocolRequestContext,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rendererContext = protocolRequestJSValue(protocolContext);
  if (String(row.status || "") !== "SUCCESS") return rendererContext;
  if (!engine.hasCallablePath("listArtifacts")) return rendererContext;
  const listed = engine.call("listArtifacts", taskArtifactContext(row));
  const artifacts = validateProjectedTaskArtifacts(listed);
  if (!artifacts.length) return rendererContext;
  const rendererArtifacts: Record<string, unknown> = {};
  for (const artifact of artifacts) {
    const url = await buildTaskArtifactContentURL(store, String(row.task_id || ""), artifact.key);
    const item: Record<string, unknown> = { key: artifact.key, type: artifact.type, url };
    if (artifact.mimeType) item.mimeType = artifact.mimeType;
    rendererArtifacts[artifact.key] = item;
  }
  rendererContext.artifacts = rendererArtifacts;
  return rendererContext;
}

function sseHeaders(): Headers {
  return new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function encodeSse(event: PluginResponsesStreamEvent): Uint8Array {
  const encoded = JSON.stringify(encodePluginResponsesStreamEvent(event));
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${encoded}\n\n`);
}

async function loadOwnedPluginTask(
  store: Store,
  userId: number,
  pluginKey: string,
  taskId: string,
): Promise<Record<string, unknown> | null> {
  const row = await store.getTaskByUserAndTid(userId, taskId);
  if (!row) return null;
  if (String(row.platform || "") !== pluginKey) return null;
  return row;
}

async function refreshIfNeeded(store: Store, engine: PluginEngine, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await refreshNativeQueryTask({ store, engine, row, serverAddress: await store.option("ServerAddress") });
  } catch {
    return row;
  }
}

async function persistBackgroundFlag(store: Store, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const privateData = parsePrivate(row);
  privateData.responses_background = true;
  await store.updateTaskByTid(String(row.task_id || ""), { private_data: JSON.stringify(privateData) });
  return (await store.getTaskByTid(String(row.task_id || ""))) || { ...row, private_data: JSON.stringify(privateData) };
}

async function renderFinalResponse(
  store: Store,
  engine: PluginEngine,
  protocolContext: ProtocolRequestContext,
  row: Record<string, unknown>,
  machine: PluginResponsesMachine,
): Promise<Record<string, unknown>> {
  const view = pluginJsonValue(buildTaskPluginView(row));
  const rendererContext = await rendererContextWithArtifacts(store, engine, protocolContext, row);
  const payload = engine.callPath("protocols", ["openai_responses", "renderFinal"], [rendererContext, view]);
  return machine.finalResponse(payload, String(row.status || ""));
}

async function renderEventsResponse(
  store: Store,
  engine: PluginEngine,
  protocolContext: ProtocolRequestContext,
  row: Record<string, unknown>,
  machine: PluginResponsesMachine,
): Promise<Record<string, unknown>> {
  const view = pluginJsonValue(buildTaskPluginView(row));
  const rendererContext = await rendererContextWithArtifacts(store, engine, protocolContext, row);
  const value = engine.callPath("protocols", ["openai_responses", "renderEvents"], [rendererContext, view]);
  const result = decodePluginProtocolEventResult(value);
  return machine.finalFromEvents(result, String(row.status || ""));
}

function failureResponseBody(machine: PluginResponsesMachine, status: string): Record<string, unknown> {
  if (status === "FAILURE") return machine.finalResponse(null, status);
  return machine.failureResponse(status) as unknown as Record<string, unknown>;
}

async function waitTaskPluginProtocol(opts: {
  store: Store;
  engine: PluginEngine;
  plugin: MatchedPlugin;
  protocolContext: ProtocolRequestContext;
  taskId: string;
  userId: number;
  machine: PluginResponsesMachine;
  signal: AbortSignal;
}): Promise<Response> {
  const deadline = Date.now() + PROTOCOL_TIMEOUT_MS;
  let tick = 0;
  let lastStatus = "";
  while (!opts.signal.aborted) {
    if (Date.now() > deadline) {
      return json(200, opts.machine.timeoutResponse(lastStatus));
    }
    let row = await loadOwnedPluginTask(opts.store, opts.userId, opts.plugin.key, opts.taskId);
    if (!row) {
      if (Date.now() > deadline) return json(200, opts.machine.timeoutResponse(lastStatus));
      return json(200, failureResponseBody(opts.machine, lastStatus));
    }
    row = await refreshIfNeeded(opts.store, opts.engine, row);
    lastStatus = String(row.status || "");
    if (lastStatus === "FAILURE") return json(200, failureResponseBody(opts.machine, lastStatus));
    if (lastStatus === "SUCCESS") {
      try {
        const response = await renderFinalResponse(opts.store, opts.engine, opts.protocolContext, row, opts.machine);
        return json(200, response);
      } catch {
        return json(200, failureResponseBody(opts.machine, lastStatus));
      }
    }
    const delay = pluginProtocolTickDelay(opts.taskId, tick, TICK_MS, TICK_JITTER_MS);
    tick += 1;
    await sleep(delay);
  }
  return json(200, opts.machine.timeoutResponse(lastStatus));
}

function streamTaskPluginProtocol(opts: {
  store: Store;
  engine: PluginEngine;
  plugin: MatchedPlugin;
  protocolContext: ProtocolRequestContext;
  taskId: string;
  userId: number;
  machine: PluginResponsesMachine;
  signal: AbortSignal;
  onClose: () => void;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: PluginResponsesStreamEvent) => {
        controller.enqueue(encodeSse(event));
      };
      try {
        enqueue(opts.machine.createdEvent());
        const deadline = Date.now() + PROTOCOL_TIMEOUT_MS;
        let tick = 0;
        let lastStatus = "";
        let previous: ProtocolState = { present: false, null: false, value: undefined };
        let lastHeartbeat = Date.now();
        while (!opts.signal.aborted) {
          if (Date.now() > deadline) {
            try {
              enqueue(opts.machine.timeoutEvent(lastStatus));
            } catch {
              /* already terminal */
            }
            return;
          }
          let row = await loadOwnedPluginTask(opts.store, opts.userId, opts.plugin.key, opts.taskId);
          if (!row) {
            try {
              enqueue(opts.machine.failureEvent(lastStatus));
            } catch {
              /* already terminal */
            }
            return;
          }
          row = await refreshIfNeeded(opts.store, opts.engine, row);
          lastStatus = String(row.status || "");
          try {
            const view = pluginJsonValue(buildTaskPluginView(row));
            const rendererContext = await rendererContextWithArtifacts(opts.store, opts.engine, opts.protocolContext, row);
            const args: unknown[] = [rendererContext, view];
            if (previous.present) args.push(protocolStatePluginValue(previous));
            const value = opts.engine.callPath("protocols", ["openai_responses", "renderEvents"], args);
            const result = decodePluginProtocolEventResult(value);
            const events = opts.machine.applyTick(result, lastStatus);
            for (const event of events) enqueue(event);
            if (pluginProtocolEventsTerminal(events)) return;
            previous = result.state;
          } catch {
            try {
              enqueue(opts.machine.failureEvent(lastStatus));
            } catch {
              /* already terminal */
            }
            return;
          }
          const delay = pluginProtocolTickDelay(opts.taskId, tick, TICK_MS, TICK_JITTER_MS);
          tick += 1;
          const waitUntil = Date.now() + delay;
          while (Date.now() < waitUntil && !opts.signal.aborted) {
            if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
              controller.enqueue(new TextEncoder().encode(": PING\n"));
              lastHeartbeat = Date.now();
            }
            await sleep(Math.min(250, Math.max(0, waitUntil - Date.now())));
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        opts.onClose();
      }
    },
  });
  return new Response(stream, { status: 200, headers: sseHeaders() });
}

/** Original claimed `POST /v1/responses` after Pin + Prepare. */
export async function serveTaskPluginProtocolCreate(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  plugin: MatchedPlugin;
  prepared: SubmitKind;
  requestId: string;
}): Promise<Response> {
  const protocolContext = opts.prepared.protocolContext;
  if (!protocolContext || opts.prepared.protocol !== "openai_responses") {
    return pluginProtocolError(500, "task_protocol_error", "Task protocol request failed");
  }
  const acquired = observationAdmissions.acquire(opts.plugin.key, opts.auth.user.id, Number(opts.auth.token.id || 0));
  if (typeof acquired !== "function") return acquired.error;
  let release: () => void = acquired;
  try {
    const outcome = await executeNativeTaskSubmission(opts.req, opts.env, opts.store, opts.auth, opts.plugin, opts.prepared, opts.requestId);
    if ("error" in outcome) return outcome.error;
    let row = outcome.row;
    const createdAt = createdAtOf(row);
    const machine = new PluginResponsesMachine(String(row.task_id || ""), outcome.originModelName, createdAt);
    const background = protocolBackgroundFlag(protocolContext);
    if (background) {
      row = await persistBackgroundFlag(opts.store, row);
      machine.setBackground(true);
      if (!protocolContext.stream) return json(200, machine.pendingResponse(String(row.status || "")));
    }
    if (protocolContext.stream) {
      const hold = release;
      release = () => {};
      return streamTaskPluginProtocol({
        store: opts.store,
        engine: outcome.engine,
        plugin: opts.plugin,
        protocolContext,
        taskId: String(row.task_id || ""),
        userId: opts.auth.user.id,
        machine,
        signal: opts.req.signal,
        onClose: hold,
      });
    }
    return waitTaskPluginProtocol({
      store: opts.store,
      engine: outcome.engine,
      plugin: opts.plugin,
      protocolContext,
      taskId: String(row.task_id || ""),
      userId: opts.auth.user.id,
      machine,
      signal: opts.req.signal,
    });
  } finally {
    release();
  }
}

function pluginClaimsOpenAIResponses(meta: Record<string, unknown>): boolean {
  const protocols = Array.isArray(meta.protocols) ? meta.protocols : [];
  return protocols.some((item) => {
    if (typeof item === "string") return item === "openai_responses";
    return isPlainObject(item) && String(item.name || "") === "openai_responses";
  });
}

function protocolModes(meta: Record<string, unknown>): string[] {
  const raw = meta.protocols;
  if (!Array.isArray(raw)) return [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item === "openai_responses") return [];
      continue;
    }
    if (isPlainObject(item) && String(item.name || "") === "openai_responses") {
      return Array.isArray(item.supports) ? item.supports.map((name) => String(name)) : [];
    }
  }
  return [];
}

/** Original `controller.RetrieveTaskPluginResponse`. */
export async function retrieveTaskPluginResponse(opts: {
  store: Store;
  auth: AuthToken;
  responseId: string;
}): Promise<Response> {
  const responseId = opts.responseId.trim();
  if (!responseId.startsWith("resp_")) {
    return pluginProtocolError(404, "not_found", `No response found with id '${responseId}'.`);
  }
  const taskId = "task_" + responseId.slice("resp_".length);
  const row = await opts.store.getTaskByUserAndTid(opts.auth.user.id, taskId);
  if (!row) return pluginProtocolError(404, "not_found", `No response found with id '${responseId}'.`);
  const plugins = await listRoutingPlugins(opts.store);
  const routing = plugins.find((plugin) => plugin.key === String(row.platform || ""));
  if (!routing || !pluginClaimsOpenAIResponses(routing.meta)) {
    return pluginProtocolError(404, "not_found", `No response found with id '${responseId}'.`);
  }
  let engine: PluginEngine;
  try {
    engine = loadCompiledPlugin(routing.source, routing.key, String(routing.meta.version || "")).engine;
  } catch {
    return pluginProtocolError(500, "task_protocol_error", "Task protocol request failed");
  }
  let current = row;
  try {
    current = await refreshIfNeeded(opts.store, engine, row);
  } catch {
    current = row;
  }
  const createdAt = createdAtOf(current);
  const machine = new PluginResponsesMachine(String(current.task_id || ""), originModelName(current, ""), createdAt);
  machine.setBackground(Boolean(parsePrivate(current).responses_background));
  const protocolContext: ProtocolRequestContext = {
    path: `/v1/responses/${responseId}`,
    method: "GET",
    params: { response_id: responseId },
    query: {},
    body: { kind: BODY_NONE },
    files: [],
    requestBody: undefined,
    protocol: "openai_responses",
    operation: "retrieve",
    model: originModelName(current, ""),
    stream: false,
  };
  const status = String(current.status || "");
  if (status === "FAILURE") {
    try {
      return json(200, machine.finalResponse(null, status));
    } catch {
      return pluginProtocolError(500, "task_protocol_error", "Task protocol request failed");
    }
  }
  if (status !== "SUCCESS") return json(200, machine.pendingResponse(status));
  const modes = protocolModes(routing.meta);
  try {
    if (modes.includes("sync") || modes.includes("background")) {
      return json(200, await renderFinalResponse(opts.store, engine, protocolContext, current, machine));
    }
    return json(200, await renderEventsResponse(opts.store, engine, protocolContext, current, machine));
  } catch {
    try {
      return json(200, machine.failureResponse(status));
    } catch {
      return pluginProtocolError(500, "task_protocol_error", "Task protocol request failed");
    }
  }
}
