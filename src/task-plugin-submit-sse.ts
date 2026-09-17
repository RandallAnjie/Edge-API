/**
 * Original jsplugin `TaskAdaptor.readSubmitEvents` — SSE framing, parseSubmitEvent /
 * parseSubmitEventDelta, and bounded JSON state. No route/submit imports.
 */
import { CAPABILITY_SUBMIT_SSE_DELTA, goJSONByteLength, goJSONMarshal, type PluginEngine } from "./jsplugin.js";
import { newJSONState } from "./jsplugin-json-state.js";
import { utf8Bytes } from "./jsplugin-sha256.js";

export const MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES = 1 << 20;
export const MAX_SUBMIT_STREAM_CONTROL_STATE_BYTES = 64 << 10;
/** Original `constant.StreamingTimeout` default seconds. */
export const STREAMING_TIMEOUT_SECONDS = 300;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Original `mime.ParseMediaType` media type (lowercase) or empty on error. */
export function parseSubmitMediaType(raw: string): string {
  const type = String(raw || "").split(";")[0].trim().toLowerCase();
  if (!type || !type.includes("/")) return "";
  return type;
}

/** Original `cloneJSONValue` (depth 64) used to isolate the next JS hook state. */
export function cloneJSONValue(value: unknown, depth = 0): { value: unknown; plainJSON: boolean } {
  if (depth > 64) return { value: null, plainJSON: false };
  if (value === null || typeof value === "boolean") return { value, plainJSON: true };
  if (typeof value === "string") return { value, plainJSON: true };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { value: null, plainJSON: false };
    return { value, plainJSON: true };
  }
  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    for (const item of value) {
      const child = cloneJSONValue(item, depth + 1);
      if (!child.plainJSON) return { value: null, plainJSON: false };
      cloned.push(child.value);
    }
    return { value: cloned, plainJSON: true };
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const child = cloneJSONValue(item, depth + 1);
      if (!child.plainJSON) return { value: null, plainJSON: false };
      cloned[key] = child.value;
    }
    return { value: cloned, plainJSON: true };
  }
  return { value: null, plainJSON: false };
}

function* scanSSELines(text: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    let line = text.slice(start, i);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    yield line;
    start = i + 1;
  }
  if (start < text.length) yield text.slice(start);
}

function ownKeyCount(value: Record<string, unknown>): number {
  return Object.keys(value).length;
}

/**
 * Original `TaskAdaptor.readSubmitEvents`. `body` is the already-buffered
 * upstream payload (workerd `fetch` completes before scan). Idle timeout
 * during a hanging pipe is extra extra and omitted for buffered bodies.
 */
export function readSubmitEvents(opts: {
  engine: PluginEngine;
  driverContext: Record<string, unknown>;
  contentType: string;
  body: string;
  requiredCapabilities?: string[];
}): unknown {
  const mediaType = parseSubmitMediaType(opts.contentType);
  if (mediaType !== "text/event-stream") throw new Error("expected a text/event-stream submit response");
  const capabilities = opts.requiredCapabilities || [];
  const delta = capabilities.includes(CAPABILITY_SUBMIT_SSE_DELTA);
  const hook = delta ? "parseSubmitEventDelta" : "parseSubmitEvent";
  const accumulated = delta ? newJSONState(MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) : null;
  let state: unknown = null;
  let data: string[] = [];
  let eventName = "";
  let lastID = "";
  let frameBytes = 0;
  let firstLine = true;
  const maxToken = MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES + 1;
  for (const rawLine of scanSSELines(opts.body)) {
    let line = rawLine;
    if (firstLine) {
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      firstLine = false;
    }
    const lineBytes = utf8Bytes(line).length;
    if (lineBytes > maxToken) throw new Error("read task submit stream: bufio.Scanner: token too long");
    frameBytes += lineBytes + 1;
    if (frameBytes > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) throw new Error("task submit SSE event exceeds size limit");
    if (line !== "") {
      const cut = line.indexOf(":");
      const field = cut < 0 ? line : line.slice(0, cut);
      let value = cut < 0 ? "" : line.slice(cut + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") eventName = value;
      else if (field === "id" && !value.includes("\0")) lastID = value;
      continue;
    }
    frameBytes = 0;
    if (!data.length) {
      eventName = "";
      continue;
    }
    if (!eventName) eventName = "message";
    const event = { event: eventName, id: lastID, data: data.join("\n") };
    const value = opts.engine.call(hook, opts.driverContext, event, state);
    if (!isPlainObject(value)) throw new Error(`${hook} must return an object`);
    const hasState = Object.prototype.hasOwnProperty.call(value, "state");
    const hasDone = typeof value.done === "boolean";
    if (!hasState || !hasDone) throw new Error(`${hook} must return state and a boolean done`);
    const nextState = value.state;
    let encoded: string;
    try {
      encoded = goJSONMarshal(nextState === undefined ? null : nextState);
    } catch (err) {
      throw new Error(`invalid submit stream state: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (utf8Bytes(encoded).length > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) {
      throw new Error("task submit stream state exceeds size limit");
    }
    if (accumulated) {
      if (ownKeyCount(value) !== 3) throw new Error("parseSubmitEventDelta must return only changes, state and done");
      if (utf8Bytes(encoded).length > MAX_SUBMIT_STREAM_CONTROL_STATE_BYTES) {
        throw new Error("task submit stream control state exceeds size limit");
      }
      try {
        accumulated.apply(value.changes);
      } catch (err) {
        throw new Error(`invalid submit stream changes: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const cloned = cloneJSONValue(nextState);
    if (cloned.plainJSON) state = cloned.value;
    else {
      try {
        state = JSON.parse(encoded);
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    if (value.done === true) {
      if (accumulated) return accumulated.value();
      return state;
    }
    data = [];
    eventName = "";
  }
  throw new Error("task submit stream ended before the plugin reported completion");
}

export { goJSONByteLength };
