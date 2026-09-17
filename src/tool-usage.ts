/**
 * Original `relay/common.CountBillableToolCall` + Responses/Claude/Gemini
 * DoResponse tool billing. Must not import store / relay / convert / query / submit.
 */
import { bytesToHex, sha256BytesSync, utf8Bytes } from "./jsplugin-sha256.js";
import { MAX_IMAGE_N } from "./task-plugin-usage.js";
import {
  BUILD_IN_TOOL_FILE_SEARCH,
  BUILD_IN_TOOL_GOOGLE_SEARCH,
  BUILD_IN_TOOL_IMAGE_GENERATION,
  BUILD_IN_TOOL_WEB_SEARCH,
  BUILD_IN_TOOL_WEB_SEARCH_PREVIEW,
  getToolPriceForModel,
} from "./tool-price.js";

export const BUILD_IN_CALL_WEB_SEARCH_CALL = "web_search_call";
export const BUILD_IN_CALL_FILE_SEARCH_CALL = "file_search_call";
export const BUILD_IN_CALL_FUNCTION_CALL = "function_call";
export const BUILD_IN_CALL_TOOL_USE = "tool_use";
export const RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL = "image_generation_call";
export const RESPONSES_OUTPUT_TYPE_ITEM_DONE = "response.output_item.done";

const RESERVED_BILLABLE_TOOL_NAMES = new Set([
  BUILD_IN_TOOL_WEB_SEARCH_PREVIEW,
  BUILD_IN_TOOL_WEB_SEARCH,
  BUILD_IN_TOOL_FILE_SEARCH,
  BUILD_IN_TOOL_GOOGLE_SEARCH,
  BUILD_IN_TOOL_IMAGE_GENERATION,
]);

export type BuildInToolInfo = {
  toolName: string;
  callCount: number;
  searchContextSize?: string;
};

export type ToolUsageState = {
  model: string;
  toolPrices: Record<string, number> | null;
  relayMode: string;
  builtInTools: Record<string, BuildInToolInfo>;
  claudeWebSearchRequests: number;
  geminiGoogleSearchCall: boolean;
  imageCounter: ImageGenerationCallCounter;
  imageCommitted: boolean;
  streamFunctionCallNames: string[];
  seenStreamToolCalls: Record<string, true>;
};

export type ResponsesOutput = {
  type?: string;
  id?: string;
  status?: string;
  result?: string;
  call_id?: string;
  name?: string;
};

/** Original `relay/common.CountBillableToolCall`. */
export function countBillableToolCall(state: ToolUsageState | null | undefined, itemType: string, functionName = ""): void {
  if (!state) return;
  switch (itemType) {
    case BUILD_IN_CALL_WEB_SEARCH_CALL:
      incrementBillableToolCall(state, resolveWebSearchToolName(state.builtInTools));
      return;
    case BUILD_IN_CALL_FILE_SEARCH_CALL:
      incrementBillableToolCall(state, BUILD_IN_TOOL_FILE_SEARCH);
      return;
    case BUILD_IN_CALL_FUNCTION_CALL:
    case BUILD_IN_CALL_TOOL_USE: {
      if (!functionName) return;
      if (RESERVED_BILLABLE_TOOL_NAMES.has(functionName)) return;
      if (getToolPriceForModel(functionName, state.model, state.toolPrices) <= 0) return;
      incrementBillableToolCall(state, functionName);
    }
  }
}

function resolveWebSearchToolName(tools: Record<string, BuildInToolInfo>): string {
  if (Object.prototype.hasOwnProperty.call(tools, BUILD_IN_TOOL_WEB_SEARCH_PREVIEW)) return BUILD_IN_TOOL_WEB_SEARCH_PREVIEW;
  if (Object.prototype.hasOwnProperty.call(tools, BUILD_IN_TOOL_WEB_SEARCH)) return BUILD_IN_TOOL_WEB_SEARCH;
  return BUILD_IN_TOOL_WEB_SEARCH_PREVIEW;
}

function incrementBillableToolCall(state: ToolUsageState, name: string): void {
  const existing = state.builtInTools[name];
  if (existing) {
    existing.callCount++;
    return;
  }
  state.builtInTools[name] = { toolName: name, callCount: 1 };
}

/** Original `relay/common.ImageGenerationCallCounter`. */
export class ImageGenerationCallCounter {
  seen: Record<string, true> | null = null;
  count = 0;

  observe(item: ResponsesOutput | null | undefined, outputIndex: number | null = null): void {
    if (!item) return;
    if (item.type !== RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL) return;
    if (!String(item.result || "").trim()) return;
    switch (String(item.status || "").trim().toLowerCase()) {
      case "failed":
      case "cancelled":
      case "canceled":
      case "incomplete":
      case "partial":
        return;
    }
    const aliases: string[] = [];
    if (item.id) aliases.push("id:" + item.id);
    if (item.call_id) aliases.push("call:" + item.call_id);
    if (outputIndex != null && outputIndex >= 0) aliases.push("index:" + String(outputIndex));
    aliases.push("result:" + bytesToHex(sha256BytesSync(utf8Bytes(String(item.result || "")))));
    if (!this.seen) this.seen = {};
    for (const alias of aliases) {
      if (this.seen[alias]) return;
    }
    for (const alias of aliases) this.seen[alias] = true;
    this.count++;
  }

  reset(): void {
    this.seen = null;
    this.count = 0;
  }

  Count(): number {
    return this.count;
  }

  commit(state: ToolUsageState | null | undefined): void {
    if (!state) return;
    let count = this.count;
    if (count > MAX_IMAGE_N) count = MAX_IMAGE_N;
    const existing = state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION];
    if (existing) {
      existing.callCount = count;
      return;
    }
    state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION] = {
      toolName: BUILD_IN_TOOL_IMAGE_GENERATION,
      callCount: count,
    };
  }
}

/**
 * Original `relay/common.IsNonBillableResponsesStatus`.
 * Accepts JSON-encoded bytes/strings (`"failed"`) and already-parsed status strings.
 */
export function isNonBillableResponsesStatus(status: unknown): boolean {
  if (status == null) return false;
  let s = "";
  if (typeof status === "string") {
    const trimmed = status.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed !== "string") return false;
        s = parsed;
      } catch {
        return false;
      }
    } else {
      s = trimmed;
    }
  } else if (status instanceof Uint8Array) {
    if (!status.length) return false;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(status)) as unknown;
      if (typeof parsed !== "string") return false;
      s = parsed;
    } catch {
      return false;
    }
  } else {
    return false;
  }
  switch (s.toLowerCase().trim()) {
    case "failed":
    case "cancelled":
    case "canceled":
    case "incomplete":
      return true;
    default:
      return false;
  }
}

export function createToolUsageState(opts: {
  model: string;
  toolPrices?: Record<string, number> | null;
  relayMode?: string;
  requestTools?: unknown;
}): ToolUsageState {
  const state: ToolUsageState = {
    model: opts.model,
    toolPrices: opts.toolPrices || null,
    relayMode: opts.relayMode || "",
    builtInTools: {},
    claudeWebSearchRequests: 0,
    geminiGoogleSearchCall: false,
    imageCounter: new ImageGenerationCallCounter(),
    imageCommitted: false,
    streamFunctionCallNames: [],
    seenStreamToolCalls: {},
  };
  if (opts.relayMode === "responses") seedResponsesRequestTools(state, opts.requestTools);
  if (opts.relayMode === "alpha_search") {
    state.builtInTools[BUILD_IN_TOOL_WEB_SEARCH_PREVIEW] = {
      toolName: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW,
      callCount: 0,
    };
  }
  return state;
}

/** Original `GenRelayInfoResponses` BuiltInTools seed from `request.Tools`. */
export function seedResponsesRequestTools(state: ToolUsageState, tools: unknown): void {
  for (const tool of toolsMap(tools)) {
    const toolType = interface2String(tool.type);
    state.builtInTools[toolType] = { toolName: toolType, callCount: 0 };
    if (toolType === BUILD_IN_TOOL_WEB_SEARCH_PREVIEW) {
      const searchContextSize = interface2String(tool.search_context_size) || "medium";
      state.builtInTools[toolType].searchContextSize = searchContextSize;
    }
  }
}

function toolsMap(tools: unknown): Record<string, unknown>[] {
  let raw: unknown = tools;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) out.push(item as Record<string, unknown>);
  }
  return out;
}

function interface2String(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export function builtInToolCallCounts(state: ToolUsageState | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!state) return out;
  for (const [name, tool] of Object.entries(state.builtInTools)) out[name] = tool.callCount;
  return out;
}

/** Original `OaiResponsesHandler` output-call counting + image Commit. */
export function countOpenAIResponsesHandler(state: ToolUsageState, json: Record<string, unknown>): void {
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const row = asOutput(item);
    if (!row) continue;
    if (row.type === BUILD_IN_CALL_WEB_SEARCH_CALL) countBillableToolCall(state, BUILD_IN_CALL_WEB_SEARCH_CALL);
    else if (row.type === BUILD_IN_CALL_FILE_SEARCH_CALL) countBillableToolCall(state, BUILD_IN_CALL_FILE_SEARCH_CALL);
    else if (row.type === BUILD_IN_CALL_FUNCTION_CALL) countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, row.name || "");
  }
  if (!isNonBillableResponsesStatus(json.status)) {
    for (let i = 0; i < output.length; i++) {
      state.imageCounter.observe(asOutput(output[i]), i);
    }
  }
  state.imageCounter.commit(state);
  state.imageCommitted = true;
}

/** Original `OaiResponsesStreamHandler` per-event counting. */
export function applyResponsesStreamEvent(state: ToolUsageState, json: Record<string, unknown>): void {
  const type = String(json.type || "");
  if (type === "response.completed" || type === "response.done") {
    const response = asObj(json.response);
    if (response) {
      if (!state.imageCommitted) {
        if (isNonBillableResponsesStatus(response.status)) {
          state.imageCounter.reset();
          state.imageCounter.commit(state);
          state.imageCommitted = true;
        } else {
          const output = Array.isArray(response.output) ? response.output : [];
          for (let i = 0; i < output.length; i++) {
            state.imageCounter.observe(asOutput(output[i]), i);
          }
          state.imageCounter.commit(state);
          state.imageCommitted = true;
        }
      }
    } else if (!state.imageCommitted) {
      state.imageCounter.commit(state);
      state.imageCommitted = true;
    }
    return;
  }
  if (type === "response.failed" || type === "response.incomplete" || type === "response.cancelled" || type === "response.canceled") {
    if (!state.imageCommitted) {
      state.imageCounter.reset();
      state.imageCounter.commit(state);
      state.imageCommitted = true;
    }
    return;
  }
  if (type === RESPONSES_OUTPUT_TYPE_ITEM_DONE) {
    const item = asOutput(json.item);
    if (!item) return;
    if (item.type === BUILD_IN_CALL_WEB_SEARCH_CALL) countBillableToolCall(state, BUILD_IN_CALL_WEB_SEARCH_CALL);
    else if (item.type === BUILD_IN_CALL_FILE_SEARCH_CALL) countBillableToolCall(state, BUILD_IN_CALL_FILE_SEARCH_CALL);
    else if (item.type === BUILD_IN_CALL_FUNCTION_CALL) countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, item.name || "");
    else if (item.type === RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL && !state.imageCommitted) {
      state.imageCounter.observe(item, outputIndexPtr(json.output_index));
    }
  }
}

/** Original `Message.ParseToolCalls` then `CountBillableToolCall(function_call)`. */
export function countOpenAIChatHandler(state: ToolUsageState, json: Record<string, unknown>): void {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as Record<string, unknown>).message;
    for (const tc of parseToolCalls(message)) {
      countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, tc.name);
    }
  }
}

export function parseToolCalls(message: unknown): { name: string }[] {
  if (!message || typeof message !== "object") return [];
  let raw: unknown = (message as Record<string, unknown>).tool_calls;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: { name: string }[] = [];
  for (const tc of raw) {
    if (!tc || typeof tc !== "object") continue;
    const fn = (tc as Record<string, unknown>).function;
    const name = fn && typeof fn === "object" ? String((fn as Record<string, unknown>).name || "") : "";
    out.push({ name });
  }
  return out;
}

/** Original `collectStreamFunctionCallNames`. */
export function collectStreamFunctionCallNames(
  data: string | Record<string, unknown>,
  seen: Record<string, true>,
  names: string[],
): void {
  let json: Record<string, unknown>;
  if (typeof data === "string") {
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
  } else {
    json = data;
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const row = choice as Record<string, unknown>;
    const choiceIndex = Number(row.index || 0);
    const delta = asObj(row.delta);
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = asObj(toolCalls[i]);
      const fn = asObj(tc.function);
      const name = String(fn.name || "").trim();
      if (!name) continue;
      let toolIdx = i;
      if (typeof tc.index === "number" && Number.isFinite(tc.index)) toolIdx = Math.trunc(tc.index);
      const fallbackKey = `index\0${choiceIndex}\0${toolIdx}\0${name}`;
      const activeKey = `active\0${choiceIndex}\0${toolIdx}\0${name}`;
      const callID = String(tc.id || "").trim();
      if (callID) {
        const idKey = `id\0${choiceIndex}\0${callID}`;
        if (seen[idKey]) continue;
        seen[idKey] = true;
        seen[activeKey] = true;
        if (seen[fallbackKey]) {
          delete seen[fallbackKey];
          continue;
        }
      } else {
        if (seen[fallbackKey]) continue;
        if (seen[activeKey]) continue;
        seen[fallbackKey] = true;
        seen[activeKey] = true;
      }
      names.push(name);
    }
  }
}

export function finishOpenAIChatStreamToolUsage(state: ToolUsageState): void {
  for (const name of state.streamFunctionCallNames) {
    countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, name);
  }
  state.streamFunctionCallNames = [];
}

/** Original `HandleClaudeResponseData` tool_use + `claude_web_search_requests`. */
export function countClaudeHandler(state: ToolUsageState, json: Record<string, unknown>): void {
  const usage = asObj(json.usage);
  const server = asObj(usage.server_tool_use);
  const webSearchRequests = Number(server.web_search_requests || 0);
  if (webSearchRequests > 0) state.claudeWebSearchRequests = Math.trunc(webSearchRequests);
  const content = Array.isArray(json.content) ? json.content : [];
  for (const block of content) {
    const row = asObj(block);
    if (row.type === BUILD_IN_CALL_TOOL_USE) {
      countBillableToolCall(state, BUILD_IN_CALL_TOOL_USE, String(row.name || ""));
    }
  }
}

/** Original `countClaudeStreamBillableTools`. */
export function countClaudeStreamBillableTools(state: ToolUsageState, json: Record<string, unknown>): void {
  const type = String(json.type || "");
  const block = asObj(json.content_block);
  if (type === "content_block_start" && block.type === BUILD_IN_CALL_TOOL_USE) {
    countBillableToolCall(state, BUILD_IN_CALL_TOOL_USE, String(block.name || ""));
  }
  if (type === "message_delta") {
    const usage = asObj(json.usage);
    const server = asObj(usage.server_tool_use);
    const webSearchRequests = Number(server.web_search_requests || 0);
    if (webSearchRequests > 0) state.claudeWebSearchRequests = Math.trunc(webSearchRequests);
  }
}

/** Original `markGeminiGoogleSearchCall`. */
export function markGeminiGoogleSearchCall(state: ToolUsageState, json: Record<string, unknown>): void {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  for (const candidate of candidates) {
    const row = asObj(candidate);
    const grounding = asObj(row.groundingMetadata);
    const queries = grounding.webSearchQueries;
    if (Array.isArray(queries) && queries.length > 0) {
      state.geminiGoogleSearchCall = true;
      return;
    }
  }
}

/** Original `countGeminiBillableFunctionCalls`. */
export function countGeminiBillableFunctionCalls(state: ToolUsageState, json: Record<string, unknown>): void {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  for (const candidate of candidates) {
    const content = asObj(asObj(candidate).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      const row = asObj(part);
      const call = asObj(row.functionCall);
      if (!Object.keys(call).length) continue;
      if (call.willContinue === true) continue;
      countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, String(call.name || ""));
    }
  }
}

export function applyToolUsageFromJson(
  state: ToolUsageState,
  json: Record<string, unknown> | null | undefined,
  opts: { stream?: boolean } = {},
): void {
  if (!json) return;
  if (opts.stream) {
    if (isResponsesStreamEvent(json)) {
      applyResponsesStreamEvent(state, json);
      return;
    }
    if (Array.isArray(json.candidates)) {
      markGeminiGoogleSearchCall(state, json);
      countGeminiBillableFunctionCalls(state, json);
      return;
    }
    if (isClaudeStreamEvent(json)) {
      countClaudeStreamBillableTools(state, json);
      return;
    }
    if (Array.isArray(json.choices)) {
      collectStreamFunctionCallNames(json, state.seenStreamToolCalls, state.streamFunctionCallNames);
    }
    return;
  }
  if (Array.isArray(json.output) || json.object === "response") {
    countOpenAIResponsesHandler(state, json);
    return;
  }
  if (Array.isArray(json.candidates)) {
    markGeminiGoogleSearchCall(state, json);
    countGeminiBillableFunctionCalls(state, json);
    return;
  }
  if (isClaudeMessage(json)) {
    countClaudeHandler(state, json);
    return;
  }
  if (Array.isArray(json.choices)) countOpenAIChatHandler(state, json);
}

export function applyToolUsageFromSse(state: ToolUsageState, text: string): void {
  for (const data of sseDataPayloads(text)) {
    try {
      applyToolUsageFromJson(state, JSON.parse(data) as Record<string, unknown>, { stream: true });
    } catch {
      /* ignore */
    }
  }
}

export function ingestUpstreamToolUsage(
  state: ToolUsageState | undefined,
  source: { json?: Record<string, unknown> | null; sseText?: string },
): void {
  if (!state) return;
  if (source.sseText != null) {
    applyToolUsageFromSse(state, source.sseText);
    finishOpenAIChatStreamToolUsage(state);
    return;
  }
  if (source.json) applyToolUsageFromJson(state, source.json, { stream: false });
}

export function sseDataPayloads(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    out.push(data);
  }
  return out;
}

function isResponsesStreamEvent(json: Record<string, unknown>): boolean {
  const type = String(json.type || "");
  return type === RESPONSES_OUTPUT_TYPE_ITEM_DONE || type.startsWith("response.");
}

function isClaudeStreamEvent(json: Record<string, unknown>): boolean {
  const type = String(json.type || "");
  return type === "content_block_start" || type === "message_delta" || type === "message_start" || type === "content_block_delta" || type === "content_block_stop" || type === "message_stop";
}

function isClaudeMessage(json: Record<string, unknown>): boolean {
  if (json.type === "message") return true;
  if (!Array.isArray(json.content)) return false;
  return json.content.some((block) => {
    const row = asObj(block);
    return typeof row.type === "string";
  });
}

function asObj(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asOutput(value: unknown): ResponsesOutput | null {
  const row = asObj(value);
  if (!Object.keys(row).length) return null;
  return {
    type: row.type != null ? String(row.type) : undefined,
    id: row.id != null ? String(row.id) : undefined,
    status: row.status != null ? String(row.status) : undefined,
    result: row.result != null ? String(row.result) : undefined,
    call_id: row.call_id != null ? String(row.call_id) : undefined,
    name: row.name != null ? String(row.name) : undefined,
  };
}

function outputIndexPtr(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}
