/** Original `OaiResponsesToChatStreamHandler` / `OaiChatToResponsesStreamHandler` SSE JSON. Does not import convert.ts. */

import {
  asInt,
  asObj,
  compactJson,
  emptyOpenAIUsage,
  openAIUsageToJson,
  sseLine,
  type OpenAIUsage,
} from "./openai-usage.js";
import {
  buildOpenAIStyleUsageFromClaudeUsage,
  convertClaudeStreamChunk,
  formatClaudeResponseInfo,
  newClaudeToChatStreamState,
} from "./claude-response.js";
import { hostedResponsesOutputJson, normalizeResponsesWebSearchAction } from "./hosted-response.js";
import {
  responsesFinishReasonFromStatus,
  responsesStatusFromChatFinishReason,
  usageFromChatUsage,
  usageFromResponsesUsage,
} from "./responses-convert.js";

const EVENT_CREATED = "response.created";
const EVENT_COMPLETED = "response.completed";
const EVENT_DONE = "response.done";
const EVENT_INCOMPLETE = "response.incomplete";
const EVENT_FAILED = "response.failed";
const EVENT_ERROR = "response.error";
const EVENT_OUTPUT_TEXT_DELTA = "response.output_text.delta";
const EVENT_OUTPUT_TEXT_ANNOTATION_ADDED = "response.output_text.annotation.added";
const EVENT_OUTPUT_ITEM_ADDED = "response.output_item.added";
const EVENT_OUTPUT_ITEM_DONE = "response.output_item.done";
const EVENT_FUNCTION_ARGS_DELTA = "response.function_call_arguments.delta";
const EVENT_FUNCTION_ARGS_DONE = "response.function_call_arguments.done";
const EVENT_CUSTOM_TOOL_INPUT_DELTA = "response.custom_tool_call_input.delta";
const EVENT_CUSTOM_TOOL_INPUT_DONE = "response.custom_tool_call_input.done";
const EVENT_REASONING_SUMMARY_DELTA = "response.reasoning_summary_text.delta";
const EVENT_REASONING_SUMMARY_DONE = "response.reasoning_summary_text.done";
const EVENT_REASONING_TEXT_DELTA = "response.reasoning_text.delta";
const EVENT_REASONING_TEXT_DONE = "response.reasoning_text.done";

export type ChatToResponsesStreamEvent = {
  type: string;
  payload: Record<string, unknown>;
};

type OutputRef = { kind: string; toolIndex: number; hostedId?: string };

type StreamTool = {
  chatIndex: number;
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  done: boolean;
};

type HostedStreamTool = {
  outputIndex: number;
  output: Record<string, unknown>;
  done: boolean;
};

export type HostedToolStreamStart = {
  type: string;
  id: string;
  name?: string;
  action?: unknown;
  caller?: unknown;
  serverLabel?: string;
};

export type HostedToolStreamResult = {
  type?: string;
  id: string;
  result?: unknown;
  errorCode?: string;
  isError?: boolean;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function hostedEventPrefix(outputType: string): string {
  switch (outputType) {
    case "web_search_call":
      return "response.web_search_call";
    case "mcp_call":
      return "response.mcp_call";
    default:
      return "";
  }
}

function hostedTerminalEvent(outputType: string, failed: boolean): string {
  const prefix = hostedEventPrefix(outputType);
  if (!prefix) return "";
  if (!failed) return `${prefix}.completed`;
  if (outputType === "mcp_call") return `${prefix}.failed`;
  return "";
}

function hostedJSONString(value: unknown): string {
  if (value == null) return "";
  const raw = typeof value === "string" ? value.trim() : compactJson(value);
  if (!raw || raw === "null") return "";
  try {
    JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON payload");
  }
  return raw;
}

function hostedResultString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new Error("invalid JSON payload");
    }
    return hostedJSONString(trimmed);
  }
  return hostedJSONString(value);
}

function cloneHostedOutput(output: Record<string, unknown>): Record<string, unknown> {
  return hostedResponsesOutputJson({ ...output });
}

function cloneUsage(usage: OpenAIUsage): OpenAIUsage {
  return {
    ...usage,
    prompt_tokens_details: { ...usage.prompt_tokens_details },
    completion_tokens_details: { ...usage.completion_tokens_details },
    input_tokens_details: usage.input_tokens_details ? { ...usage.input_tokens_details } : null,
    billing_usage: usage.billing_usage ? { ...usage.billing_usage } : undefined,
  };
}

/** Original `dto.MergeUsageNonZero` for OpenAI usage snapshots. */
function mergeUsageNonZero(current: OpenAIUsage | null | undefined, incoming: OpenAIUsage | null | undefined): OpenAIUsage {
  const out = current ? cloneUsage(current) : emptyOpenAIUsage();
  if (!incoming) return out;
  if (incoming.prompt_tokens > 0) out.prompt_tokens = incoming.prompt_tokens;
  if (incoming.completion_tokens > 0) out.completion_tokens = incoming.completion_tokens;
  if (incoming.total_tokens > 0) out.total_tokens = incoming.total_tokens;
  if (incoming.prompt_cache_hit_tokens) out.prompt_cache_hit_tokens = incoming.prompt_cache_hit_tokens;
  if (incoming.input_tokens > 0) out.input_tokens = incoming.input_tokens;
  if (incoming.output_tokens > 0) out.output_tokens = incoming.output_tokens;
  if (incoming.claude_cache_creation_5_m_tokens > 0) {
    out.claude_cache_creation_5_m_tokens = incoming.claude_cache_creation_5_m_tokens;
  }
  if (incoming.claude_cache_creation_1_h_tokens > 0) {
    out.claude_cache_creation_1_h_tokens = incoming.claude_cache_creation_1_h_tokens;
  }
  const prompt = incoming.prompt_tokens_details;
  if (prompt.cached_tokens > 0) out.prompt_tokens_details.cached_tokens = prompt.cached_tokens;
  if (prompt.text_tokens > 0) out.prompt_tokens_details.text_tokens = prompt.text_tokens;
  if (prompt.audio_tokens > 0) out.prompt_tokens_details.audio_tokens = prompt.audio_tokens;
  if (prompt.image_tokens > 0) out.prompt_tokens_details.image_tokens = prompt.image_tokens;
  if (prompt.cached_creation_tokens) {
    out.prompt_tokens_details.cached_creation_tokens = prompt.cached_creation_tokens;
  }
  if (prompt.cache_write_tokens) out.prompt_tokens_details.cache_write_tokens = prompt.cache_write_tokens;
  const completion = incoming.completion_tokens_details;
  if (completion.text_tokens > 0) out.completion_tokens_details.text_tokens = completion.text_tokens;
  if (completion.audio_tokens > 0) out.completion_tokens_details.audio_tokens = completion.audio_tokens;
  if (completion.image_tokens > 0) out.completion_tokens_details.image_tokens = completion.image_tokens;
  if (completion.reasoning_tokens > 0) out.completion_tokens_details.reasoning_tokens = completion.reasoning_tokens;
  if (incoming.usage_semantic) out.usage_semantic = incoming.usage_semantic;
  if (incoming.usage_source) out.usage_source = incoming.usage_source;
  if (incoming.billing_usage) out.billing_usage = { ...incoming.billing_usage };
  const promptTotal = out.prompt_tokens + out.completion_tokens;
  if (promptTotal > out.total_tokens) out.total_tokens = promptTotal;
  const inputTotal = out.input_tokens + out.output_tokens;
  if (inputTotal > out.total_tokens) out.total_tokens = inputTotal;
  return out;
}

function estimateCompletionTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function usageFromText(text: string, promptTokens: number): OpenAIUsage {
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = promptTokens;
  usage.input_tokens = promptTokens;
  usage.completion_tokens = estimateCompletionTokens(text);
  usage.output_tokens = usage.completion_tokens;
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return usage;
}

function chatAnnotationsToResponses(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const converted: unknown[] = [];
  for (const annotation of raw) {
    const o = asObj(annotation);
    if (str(o.type) !== "url_citation") {
      converted.push(annotation);
      continue;
    }
    const citation = o.url_citation && typeof o.url_citation === "object" ? asObj(o.url_citation) : null;
    if (!citation) {
      converted.push(annotation);
      continue;
    }
    converted.push({ type: "url_citation", ...citation });
  }
  return converted;
}

function responseAnnotationToChat(annotation: unknown): Record<string, unknown> {
  const value = asObj(annotation);
  if (str(value.type) !== "url_citation") return value;
  const citation: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "type") citation[key] = item;
  }
  return { type: "url_citation", url_citation: citation };
}

function responsesOutputJson(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: str(item.type),
    id: str(item.id),
    status: str(item.status),
    role: str(item.role),
    content: item.content == null ? null : item.content,
    quality: str(item.quality),
    size: str(item.size),
  };
  if (Array.isArray(item.summary) && item.summary.length) out.summary = item.summary;
  if (item.result) out.result = item.result;
  if (item.call_id) out.call_id = item.call_id;
  if (item.name) out.name = item.name;
  if (item.arguments !== undefined) out.arguments = item.arguments;
  if (item.action != null) out.action = item.action;
  if (item.output != null) out.output = item.output;
  if (item.error != null) out.error = item.error;
  if (item.server_label) out.server_label = item.server_label;
  return out;
}

function responsesResponseWire(opts: {
  id: string;
  created: number;
  status: string;
  model: string;
  output: Record<string, unknown>[];
  usage?: OpenAIUsage | null;
  incomplete?: { reason: string };
  error?: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: opts.id,
    object: "response",
    created_at: opts.created,
    status: opts.status,
  };
  if (opts.error) out.error = opts.error;
  if (opts.incomplete) out.incomplete_details = opts.incomplete;
  out.instructions = null;
  out.max_output_tokens = 0;
  out.model = opts.model;
  out.output = opts.output;
  out.parallel_tool_calls = false;
  out.previous_response_id = null;
  out.reasoning = null;
  out.store = false;
  out.temperature = 0;
  out.tool_choice = null;
  out.tools = null;
  out.top_p = 0;
  out.truncation = null;
  out.usage = opts.usage ? openAIUsageToJson(opts.usage) : null;
  out.user = null;
  out.metadata = null;
  return out;
}

function payloadWithType(eventType: string, payload: Record<string, unknown>, sequenceNumber?: number): Record<string, unknown> {
  const out: Record<string, unknown> = { type: eventType };
  if (payload.response !== undefined) out.response = payload.response;
  if (payload.code) out.code = payload.code;
  if (payload.message) out.message = payload.message;
  if (payload.param) out.param = payload.param;
  if (payload.delta) out.delta = payload.delta;
  if (payload.arguments !== undefined) out.arguments = payload.arguments;
  if (payload.name) out.name = payload.name;
  if (payload.text !== undefined) out.text = payload.text;
  if (payload.item !== undefined) out.item = payload.item;
  if (sequenceNumber !== undefined) out.sequence_number = sequenceNumber;
  if (payload.annotation !== undefined) out.annotation = payload.annotation;
  if (payload.annotation_index !== undefined) out.annotation_index = payload.annotation_index;
  if (payload.obfuscation) out.obfuscation = payload.obfuscation;
  if (payload.output_index !== undefined) out.output_index = payload.output_index;
  if (payload.content_index !== undefined) out.content_index = payload.content_index;
  if (payload.summary_index !== undefined) out.summary_index = payload.summary_index;
  if (payload.item_id) out.item_id = payload.item_id;
  if (payload.part !== undefined) out.part = payload.part;
  return out;
}

/** Original `helper.ResponseChunkData`. */
export function responsesSseEvent(eventType: string, payload: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class ChatToResponsesStreamState {
  id: string;
  model: string;
  created: number;
  usage: OpenAIUsage;
  emitSequenceNumber = false;
  status = "completed";
  incompleteDetails: { reason: string } | undefined;
  private sentCreated = false;
  private textOutputIndex = -1;
  private textStarted = false;
  private textDone = false;
  private reasoningIndex = -1;
  private reasoningStarted = false;
  private reasoningDone = false;
  private finalized = false;
  private nextSequenceNumber = 0;
  private nextOutputIndex = 0;
  private toolsByIndex = new Map<number, StreamTool>();
  private hostedByID = new Map<string, HostedStreamTool>();
  private outputOrder: OutputRef[] = [];
  private text = "";
  private annotations: unknown[] = [];
  private reasoning = "";

  constructor(id: string, model: string) {
    this.id = id;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.usage = emptyOpenAIUsage();
  }

  usageText(): string {
    return this.text;
  }

  private event(eventType: string, payload: Record<string, unknown>): ChatToResponsesStreamEvent {
    let sequence: number | undefined;
    if (this.emitSequenceNumber) {
      sequence = this.nextSequenceNumber;
      this.nextSequenceNumber += 1;
    }
    return { type: eventType, payload: payloadWithType(eventType, payload, sequence) };
  }

  private messageId(): string {
    return `${this.id}_msg_0`;
  }

  private reasoningId(): string {
    return `${this.id}_reasoning_0`;
  }

  private outputStatus(): string {
    if (this.status === "incomplete" || this.status === "failed") return "incomplete";
    return "completed";
  }

  private nextIndex(kind: string, toolIndex: number, hostedId?: string): number {
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.outputOrder.push({ kind, toolIndex, hostedId });
    return index;
  }

  private nextHostedIndex(id: string): number {
    return this.nextIndex("hosted", -1, id);
  }

  private toolCallId(tool: StreamTool): string {
    return tool.callId || tool.itemId;
  }

  private messageOutput(status: string): Record<string, unknown> {
    return responsesOutputJson({
      type: "message",
      id: this.messageId(),
      status,
      role: "assistant",
      content: [{ type: "output_text", text: this.text, annotations: this.annotations }],
    });
  }

  private reasoningOutput(status: string): Record<string, unknown> {
    return responsesOutputJson({
      type: "reasoning",
      id: this.reasoningId(),
      status,
      summary: [{ type: "summary_text", text: this.reasoning }],
    });
  }

  private toolOutput(tool: StreamTool, status: string): Record<string, unknown> {
    return responsesOutputJson({
      type: "function_call",
      id: tool.itemId,
      status,
      call_id: this.toolCallId(tool),
      name: tool.name,
      arguments: tool.arguments,
    });
  }

  private createdResponse(): Record<string, unknown> {
    return responsesResponseWire({
      id: this.id,
      created: this.created,
      status: "in_progress",
      model: this.model,
      output: [],
      usage: null,
    });
  }

  private finalResponse(): Record<string, unknown> {
    const status = this.outputStatus();
    const output: Record<string, unknown>[] = [];
    for (const ref of this.outputOrder) {
      if (ref.kind === "message") output.push(this.messageOutput(status));
      else if (ref.kind === "reasoning") output.push(this.reasoningOutput(status));
      else if (ref.kind === "tool") {
        const tool = this.toolsByIndex.get(ref.toolIndex);
        if (tool) output.push(this.toolOutput(tool, status));
      } else if (ref.kind === "hosted") {
        const tool = this.hostedByID.get(ref.hostedId || "");
        if (tool) output.push(hostedResponsesOutputJson(tool.output));
      }
    }
    return responsesResponseWire({
      id: this.id,
      created: this.created,
      status: this.status,
      model: this.model,
      output,
      usage: this.usage,
      incomplete: this.incompleteDetails,
    });
  }

  ensureCreated(): ChatToResponsesStreamEvent[] {
    if (this.sentCreated) return [];
    this.sentCreated = true;
    return [this.event(EVENT_CREATED, { response: this.createdResponse() })];
  }

  private startText(): ChatToResponsesStreamEvent[] {
    if (this.textStarted) return [];
    this.textStarted = true;
    this.textOutputIndex = this.nextIndex("message", -1);
    return [
      this.event(EVENT_OUTPUT_ITEM_ADDED, {
        output_index: this.textOutputIndex,
        item: responsesOutputJson({
          type: "message",
          id: this.messageId(),
          status: "in_progress",
          role: "assistant",
          content: [],
        }),
      }),
    ];
  }

  appendTextDelta(delta: string): ChatToResponsesStreamEvent[] {
    const events = this.startText();
    this.text += delta;
    events.push(
      this.event(EVENT_OUTPUT_TEXT_DELTA, {
        output_index: this.textOutputIndex,
        content_index: 0,
        delta,
        item_id: this.messageId(),
      }),
    );
    return events;
  }

  appendAnnotationDelta(raw: unknown): ChatToResponsesStreamEvent[] {
    const annotations = chatAnnotationsToResponses(raw);
    const events = this.startText();
    for (const annotation of annotations) {
      const annotationIndex = this.annotations.length;
      this.annotations.push(annotation);
      events.push(
        this.event(EVENT_OUTPUT_TEXT_ANNOTATION_ADDED, {
          output_index: this.textOutputIndex,
          content_index: 0,
          annotation_index: annotationIndex,
          annotation,
          item_id: this.messageId(),
        }),
      );
    }
    return events;
  }

  appendReasoningDelta(delta: string): ChatToResponsesStreamEvent[] {
    const events: ChatToResponsesStreamEvent[] = [];
    if (!this.reasoningStarted) {
      this.reasoningStarted = true;
      this.reasoningIndex = this.nextIndex("reasoning", -1);
      events.push(
        this.event(EVENT_OUTPUT_ITEM_ADDED, {
          output_index: this.reasoningIndex,
          item: responsesOutputJson({
            type: "reasoning",
            id: this.reasoningId(),
            status: "in_progress",
            summary: [],
          }),
        }),
      );
    }
    this.reasoning += delta;
    events.push(
      this.event(EVENT_REASONING_SUMMARY_DELTA, {
        output_index: this.reasoningIndex,
        summary_index: 0,
        delta,
        item_id: this.reasoningId(),
      }),
    );
    return events;
  }

  appendToolCallDelta(toolCall: Record<string, unknown>): ChatToResponsesStreamEvent[] {
    const fn = asObj(toolCall.function);
    const chatIndex = toolCall.index == null ? 0 : asInt(toolCall.index);
    const incomingId = str(toolCall.id).trim();
    let tool = this.toolsByIndex.get(chatIndex);
    const events: ChatToResponsesStreamEvent[] = [];
    if (!tool) {
      tool = {
        chatIndex,
        outputIndex: this.nextIndex("tool", chatIndex),
        callId: incomingId,
        name: str(fn.name).trim(),
        itemId: incomingId,
        arguments: "",
        done: false,
      };
      if (!tool.itemId) tool.itemId = `${this.id}_call_${chatIndex}`;
      this.toolsByIndex.set(chatIndex, tool);
      events.push(
        this.event(EVENT_OUTPUT_ITEM_ADDED, {
          output_index: tool.outputIndex,
          item_id: tool.itemId,
          item: responsesOutputJson({
            type: "function_call",
            id: tool.itemId,
            status: "in_progress",
            call_id: this.toolCallId(tool),
            name: tool.name,
            arguments: "",
          }),
        }),
      );
    }
    if (tool.done) throw new Error(`tool-call stream index ${chatIndex} received data after completion`);
    if (incomingId) {
      if (tool.callId && tool.callId !== incomingId) {
        throw new Error(`tool-call stream index ${chatIndex} changed id from "${tool.callId}" to "${incomingId}"`);
      }
      tool.callId = incomingId;
    }
    const incomingName = str(fn.name).trim();
    if (incomingName) {
      if (tool.name && tool.name !== incomingName) {
        throw new Error(`tool-call stream index ${chatIndex} changed name from "${tool.name}" to "${incomingName}"`);
      }
      tool.name = incomingName;
    }
    const args = typeof fn.arguments === "string" ? fn.arguments : fn.arguments != null ? JSON.stringify(fn.arguments) : "";
    if (args) {
      tool.arguments += args;
      events.push(
        this.event(EVENT_FUNCTION_ARGS_DELTA, {
          output_index: tool.outputIndex,
          item_id: tool.itemId,
          delta: args,
        }),
      );
    }
    return events;
  }

  /** Original `ChatToResponsesStreamState.StartHostedTool`. */
  startHostedTool(start: HostedToolStreamStart): ChatToResponsesStreamEvent[] {
    const id = str(start.id).trim();
    if (!id) throw new Error("hosted-tool stream call is missing an id");
    if (this.hostedByID.has(id)) throw new Error(`duplicate hosted-tool stream call id ${JSON.stringify(id)}`);
    if (!hostedEventPrefix(start.type)) {
      throw new Error(`unsupported Responses hosted-tool output type ${JSON.stringify(start.type)}`);
    }
    const caller = typeof start.caller === "string" ? start.caller.trim() : start.caller == null ? "" : compactJson(start.caller);
    if (caller && caller !== "null") {
      throw new Error(`Responses ${start.type} cannot preserve Claude hosted-tool caller provenance`);
    }
    const output: Record<string, unknown> = {
      type: start.type,
      id,
      status: "in_progress",
    };
    if (start.type === "web_search_call") {
      output.action = normalizeResponsesWebSearchAction(start.action);
    } else if (start.type === "code_interpreter_call") {
      throw new Error("cannot map provider code execution to Responses code_interpreter_call without a container_id");
    } else if (start.type === "mcp_call") {
      if (!str(start.name).trim() || !str(start.serverLabel).trim()) {
        throw new Error("Responses MCP call requires name and server_label");
      }
      let argumentsText: string;
      try {
        argumentsText = hostedJSONString(start.action);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`encode Responses MCP arguments: ${message}`);
      }
      output.name = start.name;
      output.server_label = start.serverLabel;
      output.arguments = argumentsText;
    }
    const outputIndex = this.nextHostedIndex(id);
    const tool: HostedStreamTool = { outputIndex, output, done: false };
    this.hostedByID.set(id, tool);
    const events = this.ensureCreated();
    const addedItem = cloneHostedOutput(output);
    if (start.type === "mcp_call") addedItem.arguments = "";
    events.push(
      this.event(EVENT_OUTPUT_ITEM_ADDED, {
        output_index: outputIndex,
        item_id: id,
        item: addedItem,
      }),
      this.event(`${hostedEventPrefix(start.type)}.in_progress`, {
        output_index: outputIndex,
        item_id: id,
      }),
    );
    if (start.type === "web_search_call") {
      events.push(
        this.event(`${hostedEventPrefix(start.type)}.searching`, {
          output_index: outputIndex,
          item_id: id,
        }),
      );
    }
    if (start.type === "mcp_call") {
      const argumentsText = str(output.arguments);
      events.push(
        this.event("response.mcp_call_arguments.delta", {
          output_index: outputIndex,
          item_id: id,
          delta: argumentsText,
        }),
        this.event("response.mcp_call_arguments.done", {
          output_index: outputIndex,
          item_id: id,
          arguments: argumentsText,
        }),
      );
    }
    return events;
  }

  /** Original `ChatToResponsesStreamState.CompleteHostedTool`. */
  completeHostedTool(result: HostedToolStreamResult): ChatToResponsesStreamEvent[] {
    const id = str(result.id).trim();
    const tool = this.hostedByID.get(id);
    if (!tool) throw new Error(`hosted-tool result references unknown call ${JSON.stringify(id)}`);
    if (tool.done) throw new Error(`duplicate hosted-tool result for call ${JSON.stringify(id)}`);
    if (result.type && result.type !== tool.output.type) {
      throw new Error(`hosted-tool result type ${JSON.stringify(result.type)} does not match call type ${JSON.stringify(tool.output.type)}`);
    }
    const failed = Boolean(result.isError) || Boolean(str(result.errorCode).trim());
    tool.output.status = "completed";
    if (str(tool.output.type) === "code_interpreter_call") {
      throw new Error("Responses code_interpreter_call is not supported without a container_id");
    }
    if (str(tool.output.type) === "mcp_call") {
      try {
        tool.output.output = hostedResultString(result.result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`encode Responses MCP output: ${message}`);
      }
    }
    if (failed) {
      tool.output.status = "failed";
      const errorValue = str(result.errorCode).trim() || "hosted tool execution failed";
      if (str(tool.output.type) === "mcp_call") {
        tool.output.error = errorValue;
        delete tool.output.output;
      }
    }
    tool.done = true;
    const events: ChatToResponsesStreamEvent[] = [];
    const eventType = hostedTerminalEvent(str(tool.output.type), failed);
    if (eventType) {
      events.push(
        this.event(eventType, {
          output_index: tool.outputIndex,
          item_id: id,
        }),
      );
    }
    events.push(
      this.event(EVENT_OUTPUT_ITEM_DONE, {
        output_index: tool.outputIndex,
        item_id: id,
        item: cloneHostedOutput(tool.output),
      }),
    );
    return events;
  }

  applyFinishReason(finishReason: string): void {
    const mapped = responsesStatusFromChatFinishReason(finishReason);
    if (mapped.status) {
      this.status = mapped.status;
      this.incompleteDetails = mapped.incomplete_details;
    }
  }

  doneDeltaEvents(): ChatToResponsesStreamEvent[] {
    const events: ChatToResponsesStreamEvent[] = [];
    const status = this.outputStatus();
    if (this.textStarted && !this.textDone) {
      this.textDone = true;
      const textDone: Record<string, unknown> = {
        output_index: this.textOutputIndex,
        content_index: 0,
        item_id: this.messageId(),
      };
      if (this.emitSequenceNumber) textDone.text = this.text;
      events.push(this.event("response.output_text.done", textDone));
      events.push(
        this.event(EVENT_OUTPUT_ITEM_DONE, {
          output_index: this.textOutputIndex,
          item: this.messageOutput(status),
        }),
      );
    }
    if (this.reasoningStarted && !this.reasoningDone) {
      this.reasoningDone = true;
      const reasoningDone: Record<string, unknown> = {
        output_index: this.reasoningIndex,
        summary_index: 0,
        item_id: this.reasoningId(),
      };
      if (this.emitSequenceNumber) reasoningDone.text = this.reasoning;
      else reasoningDone.part = { type: "summary_text", text: this.reasoning };
      events.push(this.event(EVENT_REASONING_SUMMARY_DONE, reasoningDone));
      events.push(
        this.event(EVENT_OUTPUT_ITEM_DONE, {
          output_index: this.reasoningIndex,
          item: this.reasoningOutput(status),
        }),
      );
    }
    const tools = [...this.toolsByIndex.values()].sort((a, b) => a.chatIndex - b.chatIndex);
    for (const tool of tools) {
      if (tool.done) continue;
      tool.done = true;
      const argumentsDone: Record<string, unknown> = {
        output_index: tool.outputIndex,
        item_id: tool.itemId,
      };
      if (this.emitSequenceNumber) {
        argumentsDone.arguments = tool.arguments;
        argumentsDone.name = tool.name;
      }
      events.push(this.event(EVENT_FUNCTION_ARGS_DONE, argumentsDone));
      events.push(
        this.event(EVENT_OUTPUT_ITEM_DONE, {
          output_index: tool.outputIndex,
          item: this.toolOutput(tool, status),
        }),
      );
    }
    for (const ref of this.outputOrder) {
      if (ref.kind !== "hosted") continue;
      const tool = this.hostedByID.get(ref.hostedId || "");
      if (!tool || tool.done) continue;
      if (this.status !== "failed") this.status = "incomplete";
      tool.done = true;
      tool.output.status = "incomplete";
      if (this.status === "failed") {
        tool.output.status = "failed";
        if (str(tool.output.type) === "mcp_call") {
          tool.output.error = "provider stream failed before hosted-tool result";
          delete tool.output.output;
        }
        const eventType = hostedTerminalEvent(str(tool.output.type), true);
        if (eventType) {
          events.push(
            this.event(eventType, {
              output_index: tool.outputIndex,
              item_id: tool.output.id,
            }),
          );
        }
      }
      events.push(
        this.event(EVENT_OUTPUT_ITEM_DONE, {
          output_index: tool.outputIndex,
          item_id: tool.output.id,
          item: cloneHostedOutput(tool.output),
        }),
      );
    }
    return events;
  }

  fail(code: string, message: string, param = ""): ChatToResponsesStreamEvent[] {
    if (this.finalized) return [];
    const errCode = code.trim() || "server_error";
    const errMessage = message.trim() || "upstream response stream failed";
    this.status = "failed";
    const events = this.ensureCreated();
    events.push(...this.doneDeltaEvents());
    this.finalized = true;
    const errorPayload: Record<string, unknown> = { code: errCode, message: errMessage };
    if (param) errorPayload.param = param;
    events.push(this.event("error", errorPayload));
    const response = this.finalResponse();
    response.error = { code: errCode, message: errMessage };
    events.push(this.event("response.failed", { response }));
    return events;
  }

  finalize(): ChatToResponsesStreamEvent[] {
    if (this.finalized) return [];
    const events = this.doneDeltaEvents();
    this.finalized = true;
    const eventType = this.status === "incomplete" ? EVENT_INCOMPLETE : EVENT_COMPLETED;
    events.push(this.event(eventType, { response: this.finalResponse() }));
    return events;
  }
}

export function newChatToResponsesStreamState(
  id: string,
  model: string,
  opts: { created?: number; emitSequenceNumber?: boolean } = {},
): ChatToResponsesStreamState {
  const state = new ChatToResponsesStreamState(id, model);
  if (opts.created) state.created = opts.created;
  if (opts.emitSequenceNumber) state.emitSequenceNumber = true;
  return state;
}

function deltaContent(delta: Record<string, unknown>): string {
  return typeof delta.content === "string" ? delta.content : "";
}

function deltaReasoning(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
  return "";
}

/** Original `ChatCompletionsStreamChunkToResponsesEvents`. */
export function chatCompletionsStreamChunkToResponsesEvents(
  chunk: Record<string, unknown> | null,
  state: ChatToResponsesStreamState | null,
): ChatToResponsesStreamEvent[] {
  if (!chunk || !state) return [];
  if (!state.id) state.id = str(chunk.id);
  if (!state.model) state.model = str(chunk.model);
  if (!state.created) state.created = asInt(chunk.created);
  if (chunk.usage && typeof chunk.usage === "object") {
    state.usage = usageFromChatUsage(asObj(chunk.usage));
  }
  const events = state.ensureCreated();
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    const o = asObj(choice);
    const delta = asObj(o.delta);
    const reasoning = deltaReasoning(delta);
    if (reasoning) events.push(...state.appendReasoningDelta(reasoning));
    const content = deltaContent(delta);
    if (content) events.push(...state.appendTextDelta(content));
    if (Array.isArray(delta.annotations) && delta.annotations.length) {
      events.push(...state.appendAnnotationDelta(delta.annotations));
    }
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const toolCall of toolCalls) events.push(...state.appendToolCallDelta(asObj(toolCall)));
    const finish = o.finish_reason == null ? "" : str(o.finish_reason).trim();
    if (finish) {
      state.applyFinishReason(finish);
      events.push(...state.doneDeltaEvents());
    }
  }
  return events;
}

export function finalizeChatCompletionsStreamToResponses(state: ChatToResponsesStreamState | null): ChatToResponsesStreamEvent[] {
  return state ? state.finalize() : [];
}

type ResponsesStreamTool = {
  key: string;
  callId: string;
  itemId: string;
  name: string;
  arguments: string;
  index: number;
  sent: boolean;
  nameSent: boolean;
  argsSentAt: number;
};

function isResponsesToolOutputType(outputType: string): boolean {
  return outputType === "function_call" || outputType === "custom_tool_call";
}

function eventItemId(event: Record<string, unknown>): string {
  const item = asObj(event.item);
  const fromItem = str(item.id).trim();
  if (fromItem) return fromItem;
  return str(event.item_id).trim();
}

function fallbackToolKey(itemId: string, callId: string, outputIndex: number | undefined): string {
  if (outputIndex !== undefined) return `output:${outputIndex}`;
  if (itemId.trim()) return "item:" + itemId.trim();
  if (callId.trim()) return "call:" + callId.trim();
  return "";
}

function fallbackCallId(event: Record<string, unknown>): string {
  if (str(event.item_id).trim()) return str(event.item_id).trim();
  if (event.output_index != null) return `call_output_${asInt(event.output_index)}`;
  return "";
}

function argumentsString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function reasoningOutputText(output: Record<string, unknown>): string {
  const content = Array.isArray(output.content) ? output.content : [];
  const hasContentText = content.some((part) => str(asObj(part).text));
  const parts: string[] = [];
  if (hasContentText) {
    for (const part of content) {
      const text = str(asObj(part).text);
      if (text) parts.push(text);
    }
    return parts.join("");
  }
  for (const part of Array.isArray(output.summary) ? output.summary : []) {
    const text = str(asObj(part).text);
    if (text) parts.push(text);
  }
  return parts.join("");
}

export class ResponsesToChatStreamState {
  id = "";
  model: string;
  created: number;
  includeUsage: boolean;
  usage: OpenAIUsage;
  private sentStart = false;
  private finalized = false;
  private hasSentText = false;
  private sentAnnotationCount = 0;
  private sawToolCall = false;
  private hasSentReasoning = false;
  private needsReasoningSummaryBreak = false;
  private nextToolIndex = 0;
  private toolByKey = new Map<string, ResponsesStreamTool>();
  private outputIndexToKey = new Map<number, string>();
  private itemIdToKey = new Map<string, string>();
  private callIdToKey = new Map<string, string>();
  private pendingArgsByOutputIndex = new Map<number, string>();
  private pendingArgsByItemId = new Map<string, string>();
  private usageTextParts = "";

  constructor(model: string, includeUsage: boolean) {
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.includeUsage = includeUsage;
    this.usage = emptyOpenAIUsage();
  }

  usageText(): string {
    return this.usageTextParts;
  }

  markReasoningSummaryBreak(): void {
    if (this.hasSentReasoning) this.needsReasoningSummaryBreak = true;
  }

  get pendingArgsByOutputIndexForTest(): Map<number, string> {
    return this.pendingArgsByOutputIndex;
  }

  get pendingArgsByItemIdForTest(): Map<string, string> {
    return this.pendingArgsByItemId;
  }

  applyResponseMetadata(response: Record<string, unknown> | null | undefined): void {
    if (!response) return;
    if (str(response.id) && !this.id) this.id = str(response.id);
    if (str(response.model)) this.model = str(response.model);
    if (asInt(response.created_at) || asInt(response.created)) {
      this.created = asInt(response.created_at) || asInt(response.created);
    }
    if (response.usage && typeof response.usage === "object") {
      this.usage = mergeUsageNonZero(this.usage, usageFromResponsesUsage(asObj(response.usage)));
    }
  }

  makeChunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      system_fingerprint: null,
      choices: [
        {
          delta,
          logprobs: null,
          finish_reason: finishReason,
          index: 0,
        },
      ],
      usage: null,
    };
  }

  ensureStart(): Record<string, unknown>[] {
    if (this.sentStart) return [];
    this.sentStart = true;
    return [this.makeChunk({ role: "assistant", content: "" }, null)];
  }

  textDelta(delta: string): Record<string, unknown>[] {
    if (!delta) return [];
    this.usageTextParts += delta;
    this.hasSentText = true;
    const chunks = this.ensureStart();
    chunks.push(this.makeChunk({ content: delta }, null));
    return chunks;
  }

  reasoningDelta(delta: string): Record<string, unknown>[] {
    if (!delta) return [];
    let next = delta;
    if (this.needsReasoningSummaryBreak) {
      if (next.startsWith("\n\n")) this.needsReasoningSummaryBreak = false;
      else if (next.startsWith("\n")) {
        next = "\n" + next;
        this.needsReasoningSummaryBreak = false;
      } else {
        next = "\n\n" + next;
        this.needsReasoningSummaryBreak = false;
      }
    }
    this.usageTextParts += next;
    const chunks = this.ensureStart();
    chunks.push(this.makeChunk({ reasoning_content: next }, null));
    this.hasSentReasoning = true;
    return chunks;
  }

  annotationDelta(annotation: unknown): Record<string, unknown>[] {
    const converted = responseAnnotationToChat(annotation);
    this.sentAnnotationCount += 1;
    const chunks = this.ensureStart();
    chunks.push(this.makeChunk({ annotations: [converted] }, null));
    return chunks;
  }

  private keyForEvent(event: Record<string, unknown>): string {
    if (event.output_index != null) return `output:${asInt(event.output_index)}`;
    const item = asObj(event.item);
    const itemId = str(item.id).trim();
    if (itemId) return "item:" + itemId;
    const callId = str(item.call_id).trim();
    if (callId) return "call:" + callId;
    if (str(event.item_id).trim()) return "item:" + str(event.item_id).trim();
    return "";
  }

  private findToolForEvent(event: Record<string, unknown>): ResponsesStreamTool | undefined {
    if (event.output_index != null) {
      const key = this.outputIndexToKey.get(asInt(event.output_index));
      if (key) return this.toolByKey.get(key);
    }
    const itemId = str(event.item_id).trim();
    if (itemId) {
      const key = this.itemIdToKey.get(itemId);
      if (key) return this.toolByKey.get(key);
    }
    if (event.item && typeof event.item === "object") {
      const key = this.keyForEvent(event);
      if (key) return this.toolByKey.get(key);
    }
    return undefined;
  }

  private applyPendingArgs(tool: ResponsesStreamTool, event: Record<string, unknown>): void {
    if (event.output_index != null) {
      const outputIndex = asInt(event.output_index);
      this.outputIndexToKey.set(outputIndex, tool.key);
      const pending = this.pendingArgsByOutputIndex.get(outputIndex);
      if (pending) {
        tool.arguments += pending;
        this.pendingArgsByOutputIndex.delete(outputIndex);
      }
    }
    const itemId = eventItemId(event);
    if (itemId) {
      tool.itemId = itemId;
      this.itemIdToKey.set(itemId, tool.key);
      const pending = this.pendingArgsByItemId.get(itemId);
      if (pending) {
        tool.arguments += pending;
        this.pendingArgsByItemId.delete(itemId);
      }
    }
  }

  private ensureToolForEvent(event: Record<string, unknown>): ResponsesStreamTool | undefined {
    const item = asObj(event.item);
    if (!event.item) return undefined;
    let key = this.keyForEvent(event);
    if (!key) key = fallbackToolKey(item.id as string, str(item.call_id), event.output_index == null ? undefined : asInt(event.output_index));
    if (!key) return undefined;
    let tool = this.toolByKey.get(key);
    if (!tool) {
      const itemId = eventItemId(event);
      if (itemId) {
        const existingKey = this.itemIdToKey.get(itemId);
        if (existingKey) tool = this.toolByKey.get(existingKey);
      }
      if (!tool) {
        const callId = str(item.call_id).trim();
        if (callId) {
          const existingKey = this.callIdToKey.get(callId);
          if (existingKey) tool = this.toolByKey.get(existingKey);
        }
      }
      if (tool) this.toolByKey.set(key, tool);
    }
    if (!tool) {
      tool = {
        key,
        callId: "",
        itemId: "",
        name: "",
        arguments: "",
        index: this.nextToolIndex,
        sent: false,
        nameSent: false,
        argsSentAt: 0,
      };
      this.nextToolIndex += 1;
      this.toolByKey.set(key, tool);
    }
    this.applyPendingArgs(tool, event);
    const callId = str(item.call_id).trim();
    if (callId) {
      tool.callId = callId;
      this.callIdToKey.set(callId, key);
    } else if (!tool.callId) {
      tool.callId = str(item.id).trim();
    }
    const name = str(item.name).trim();
    if (name) tool.name = name;
    return tool;
  }

  private ensureFallbackToolForEvent(event: Record<string, unknown>): ResponsesStreamTool | undefined {
    let key = "";
    if (event.output_index != null) key = `output:${asInt(event.output_index)}`;
    if (!key && str(event.item_id).trim()) key = "item:" + str(event.item_id).trim();
    if (!key) return undefined;
    let tool = this.toolByKey.get(key);
    if (!tool) {
      tool = {
        key,
        callId: fallbackCallId(event),
        itemId: "",
        name: "",
        arguments: "",
        index: this.nextToolIndex,
        sent: false,
        nameSent: false,
        argsSentAt: 0,
      };
      this.nextToolIndex += 1;
      this.toolByKey.set(key, tool);
    }
    this.applyPendingArgs(tool, event);
    return tool;
  }

  toolDelta(tool: ResponsesStreamTool | undefined, explicitDelta: string): Record<string, unknown>[] {
    if (!tool) return [];
    let argsDelta = explicitDelta;
    if (!argsDelta && tool.arguments.length > tool.argsSentAt) argsDelta = tool.arguments.slice(tool.argsSentAt);
    if (tool.sent && !argsDelta && (!tool.name || tool.nameSent)) return [];
    const chunks = this.ensureStart();
    let callId = tool.callId.trim();
    if (!callId) callId = tool.key;
    const fn: Record<string, unknown> = {};
    if (!tool.nameSent && tool.name) {
      fn.name = tool.name;
      tool.nameSent = true;
    }
    fn.arguments = argsDelta;
    const responseTool: Record<string, unknown> = {
      index: tool.index,
      id: callId,
      type: "function",
      function: fn,
    };
    tool.sent = true;
    if (argsDelta) {
      tool.argsSentAt += argsDelta.length;
      this.usageTextParts += argsDelta;
    }
    if (fn.name) this.usageTextParts += str(fn.name);
    chunks.push(this.makeChunk({ tool_calls: [responseTool] }, null));
    this.sawToolCall = true;
    return chunks;
  }

  toolItem(event: Record<string, unknown>): Record<string, unknown>[] {
    const tool = this.ensureToolForEvent(event);
    if (!tool) return [];
    const args = argumentsString(asObj(event.item).arguments);
    if (args) tool.arguments = args;
    return this.toolDelta(tool, "");
  }

  toolArgumentsDelta(event: Record<string, unknown>): Record<string, unknown>[] {
    const delta = str(event.delta);
    if (!delta) return [];
    const tool = this.findToolForEvent(event);
    if (!tool) {
      if (event.output_index != null) {
        const outputIndex = asInt(event.output_index);
        this.pendingArgsByOutputIndex.set(outputIndex, (this.pendingArgsByOutputIndex.get(outputIndex) || "") + delta);
      } else if (str(event.item_id).trim()) {
        const itemId = str(event.item_id).trim();
        this.pendingArgsByItemId.set(itemId, (this.pendingArgsByItemId.get(itemId) || "") + delta);
      }
      return [];
    }
    tool.arguments += delta;
    return this.toolDelta(tool, delta);
  }

  flushPendingTool(event: Record<string, unknown>): Record<string, unknown>[] {
    let tool = this.findToolForEvent(event);
    if (!tool) tool = this.ensureFallbackToolForEvent(event);
    if (!tool) return [];
    return this.toolDelta(tool, "");
  }

  remainingAnnotationChunks(output: Record<string, unknown>, offset: number): Record<string, unknown>[] {
    const annotations: unknown[] = [];
    for (const content of Array.isArray(output.content) ? output.content : []) {
      const raw = asObj(content).annotations;
      if (Array.isArray(raw)) annotations.push(...raw);
    }
    const start = Math.max(this.sentAnnotationCount - offset, 0);
    if (start >= annotations.length) return [];
    const chunks: Record<string, unknown>[] = [];
    for (const annotation of annotations.slice(start)) chunks.push(...this.annotationDelta(annotation));
    return chunks;
  }

  terminalOutputChunks(response: Record<string, unknown> | null): Record<string, unknown>[] {
    const output = response && Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];
    if (!response || !output.length) return [];
    const chunks: Record<string, unknown>[] = [];
    const hadSentText = this.hasSentText;
    const hadSentReasoning = this.hasSentReasoning;
    let annotationOffset = 0;
    for (const out of output) {
      const type = str(out.type);
      if (type === "message" && !hadSentText) {
        let text = "";
        for (const c of Array.isArray(out.content) ? out.content : []) {
          const part = asObj(c);
          if (str(part.type) === "output_text" && str(part.text)) text += str(part.text);
        }
        chunks.push(...this.textDelta(text));
        chunks.push(...this.remainingAnnotationChunks(out, annotationOffset));
        annotationOffset += Array.isArray(out.content)
          ? (out.content as Record<string, unknown>[]).reduce((n, part) => n + (Array.isArray(asObj(part).annotations) ? (asObj(part).annotations as unknown[]).length : 0), 0)
          : 0;
      } else if (type === "message") {
        chunks.push(...this.remainingAnnotationChunks(out, annotationOffset));
        annotationOffset += Array.isArray(out.content)
          ? (out.content as Record<string, unknown>[]).reduce((n, part) => n + (Array.isArray(asObj(part).annotations) ? (asObj(part).annotations as unknown[]).length : 0), 0)
          : 0;
      } else if (type === "reasoning" && !hadSentReasoning) {
        chunks.push(...this.reasoningDelta(reasoningOutputText(out)));
      } else if (isResponsesToolOutputType(type)) {
        chunks.push(...this.toolItem({ item: out }));
      }
    }
    return chunks;
  }

  flushAllPendingTools(): Record<string, unknown>[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const key of this.toolByKey.keys()) {
      keys.push(key);
      seen.add(key);
    }
    for (const outputIndex of this.pendingArgsByOutputIndex.keys()) {
      const key = `output:${outputIndex}`;
      if (!seen.has(key)) {
        keys.push(key);
        seen.add(key);
      }
    }
    for (const itemId of this.pendingArgsByItemId.keys()) {
      const key = "item:" + itemId;
      if (!seen.has(key)) {
        keys.push(key);
        seen.add(key);
      }
    }
    keys.sort();
    const chunks: Record<string, unknown>[] = [];
    for (const key of keys) {
      let tool = this.toolByKey.get(key);
      if (!tool) {
        let callId = key.startsWith("item:") ? key.slice("item:".length) : key;
        if (key.startsWith("output:")) callId = "call_output_" + key.slice("output:".length);
        tool = {
          key,
          callId,
          itemId: "",
          name: "",
          arguments: "",
          index: this.nextToolIndex,
          sent: false,
          nameSent: false,
          argsSentAt: 0,
        };
        this.nextToolIndex += 1;
        this.toolByKey.set(key, tool);
      }
      if (key.startsWith("output:")) {
        const outputIndex = Number(key.slice("output:".length));
        tool.arguments += this.pendingArgsByOutputIndex.get(outputIndex) || "";
        this.pendingArgsByOutputIndex.delete(outputIndex);
      }
      if (key.startsWith("item:")) {
        const itemId = key.slice("item:".length);
        tool.arguments += this.pendingArgsByItemId.get(itemId) || "";
        this.pendingArgsByItemId.delete(itemId);
      }
      chunks.push(...this.toolDelta(tool, ""));
    }
    return chunks;
  }

  finalize(response: Record<string, unknown> | null): Record<string, unknown>[] {
    if (this.finalized) return [];
    this.finalized = true;
    const chunks = this.flushAllPendingTools();
    chunks.push(...this.ensureStart());
    let finishReason = "stop";
    const mapped = response ? responsesFinishReasonFromStatus(response) : undefined;
    if (mapped) finishReason = mapped;
    else if (this.sawToolCall) finishReason = "tool_calls";
    chunks.push(this.makeChunk({}, finishReason));
    if (this.includeUsage && this.usage) {
      chunks.push({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        system_fingerprint: null,
        choices: [],
        usage: openAIUsageToJson(this.usage),
      });
    }
    return chunks;
  }
}

export function newResponsesToChatStreamState(
  model: string,
  includeUsage: boolean,
  opts: { id?: string; created?: number } = {},
): ResponsesToChatStreamState {
  const state = new ResponsesToChatStreamState(model, includeUsage);
  if (opts.id) state.id = opts.id;
  if (opts.created) state.created = opts.created;
  return state;
}

function ensureIncompleteResponse(response: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out = response ? { ...response } : {};
  if (!str(out.status)) out.status = "incomplete";
  return out;
}

/** Original `ResponsesStreamEventToChatChunks`. */
export function responsesStreamEventToChatChunks(
  event: Record<string, unknown> | null,
  state: ResponsesToChatStreamState | null,
): Record<string, unknown>[] {
  if (!event || !state) return [];
  const type = str(event.type);
  switch (type) {
    case EVENT_CREATED:
      state.applyResponseMetadata(asObj(event.response));
      return state.ensureStart();
    case EVENT_REASONING_SUMMARY_DELTA:
    case EVENT_REASONING_TEXT_DELTA:
      return state.reasoningDelta(str(event.delta));
    case EVENT_REASONING_SUMMARY_DONE:
    case EVENT_REASONING_TEXT_DONE:
      state.markReasoningSummaryBreak();
      return [];
    case EVENT_OUTPUT_TEXT_DELTA:
      return state.textDelta(str(event.delta));
    case EVENT_OUTPUT_TEXT_ANNOTATION_ADDED:
      return event.annotation == null ? [] : state.annotationDelta(event.annotation);
    case EVENT_OUTPUT_ITEM_ADDED:
    case EVENT_OUTPUT_ITEM_DONE: {
      const item = asObj(event.item);
      if (!event.item || !isResponsesToolOutputType(str(item.type))) return [];
      return state.toolItem(event);
    }
    case EVENT_FUNCTION_ARGS_DELTA:
    case EVENT_CUSTOM_TOOL_INPUT_DELTA:
      return state.toolArgumentsDelta(event);
    case EVENT_FUNCTION_ARGS_DONE:
    case EVENT_CUSTOM_TOOL_INPUT_DONE:
      return state.flushPendingTool(event);
    case EVENT_COMPLETED:
    case EVENT_DONE:
    case EVENT_INCOMPLETE: {
      let response = event.response && typeof event.response === "object" ? asObj(event.response) : null;
      if (type === EVENT_INCOMPLETE) response = ensureIncompleteResponse(response);
      state.applyResponseMetadata(response);
      const chunks = state.terminalOutputChunks(response);
      chunks.push(...state.finalize(response));
      return chunks;
    }
    case EVENT_FAILED:
    case EVENT_ERROR:
      throw new Error(`responses stream error: ${type}`);
    default:
      return [];
  }
}

export function finalizeResponsesToChatStream(state: ResponsesToChatStreamState | null): Record<string, unknown>[] {
  return state ? state.finalize(null) : [];
}

function openAIErrorFrom(obj: Record<string, unknown>): { type: string; message: string } | null {
  const err = asObj(obj.error);
  if (str(err.type)) return { type: str(err.type), message: str(err.message) };
  return null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function usageBodyFrom(usage: OpenAIUsage): Record<string, unknown> {
  return { usage: openAIUsageToJson(usage) };
}

function maybeEstimateUsage(usage: OpenAIUsage, text: string, fallbackPromptTokens: number): OpenAIUsage {
  if (usage.total_tokens) return usage;
  return usageFromText(text, fallbackPromptTokens);
}

/** Original `helper.StreamScannerHandler` `data:` line extraction (not blank-line framed). */
function parseSseDataLines(text: string): string[] {
  const payloads: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 6) continue;
    if (!line.startsWith("data:") && line.slice(0, 6) !== "[DONE]") continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data.startsWith("[DONE]")) break;
    payloads.push(data);
  }
  return payloads;
}

/**
 * Original `OaiResponsesToChatStreamHandler` client SSE.
 * `includeUsage` is `info.ShouldIncludeUsage` (defaults true when stream_options is omitted).
 */
export function oaiResponsesSseToChatSse(
  text: string,
  opts: { id: string; model: string; created?: number; includeUsage?: boolean; fallbackPromptTokens?: number },
): { sse: string; usageBody: Record<string, unknown> } {
  const state = newResponsesToChatStreamState(opts.model, false, { id: opts.id, created: opts.created });
  const chunks: Record<string, unknown>[] = [];
  for (const payload of parseSseDataLines(text)) {
    const event = parseJsonObject(payload);
    if (!event) continue;
    if (str(event.type) === EVENT_ERROR || str(event.type) === EVENT_FAILED) {
      const response = asObj(event.response);
      const oai = openAIErrorFrom(response);
      if (oai) throw new Error(oai.message || `responses stream error: ${str(event.type)}`);
      throw new Error(`responses stream error: ${str(event.type)}`);
    }
    chunks.push(...responsesStreamEventToChatChunks(event, state));
  }
    if (!state.usage.total_tokens) state.usage = maybeEstimateUsage(state.usage, state.usageText(), opts.fallbackPromptTokens || 0);
  chunks.push(...finalizeResponsesToChatStream(state));
  if (opts.includeUsage !== false) {
    chunks.push({
      id: opts.id,
      object: "chat.completion.chunk",
      created: opts.created || state.created,
      model: opts.model,
      system_fingerprint: null,
      choices: [],
      usage: openAIUsageToJson(state.usage),
    });
  }
  let sse = chunks.map((chunk) => sseLine(chunk)).join("");
  sse += "data: [DONE]\n\n";
  return { sse, usageBody: usageBodyFrom(state.usage) };
}

function claudeHostedCallOutputType(blockType: string, name: string): string {
  if (blockType === "mcp_tool_use") return "mcp_call";
  switch (name.trim()) {
    case "web_search":
      return "web_search_call";
    case "code_execution":
      throw new Error("Claude code_execution has no valid OpenAI Responses mapping without a container_id");
    case "web_fetch":
      throw new Error("Claude web_fetch has no valid OpenAI Responses hosted-tool mapping");
    default:
      throw new Error(`unknown Claude server tool ${JSON.stringify(name)} cannot be represented as an OpenAI Responses hosted tool`);
  }
}

function claudeHostedResultOutputType(blockType: string): string {
  switch (blockType) {
    case "web_search_tool_result":
      return "web_search_call";
    case "mcp_tool_result":
      return "mcp_call";
    case "code_execution_tool_result":
      throw new Error("Claude code_execution result has no valid OpenAI Responses mapping without a container_id");
    case "web_fetch_tool_result":
      throw new Error("Claude web_fetch result has no valid OpenAI Responses hosted-tool mapping");
    default:
      throw new Error(`unknown Claude hosted-tool result ${JSON.stringify(blockType)}`);
  }
}

function claudeHostedResultErrorCode(content: unknown, fallback: string): string {
  if (fallback.trim()) return fallback.trim();
  const value = asObj(content);
  const contentType = str(value.type).trim();
  if (!contentType.endsWith("_error")) return "";
  return str(value.error_code).trim();
}

type ClaudeHostedStreamCall = {
  blockType: string;
  id: string;
  name: string;
  serverName: string;
  caller: unknown;
  startInput: unknown;
  input: string;
};

/** Original `ClaudeHostedStreamBridge`. */
export class ClaudeHostedStreamBridge {
  private pending = new Map<number, ClaudeHostedStreamCall>();

  convert(
    response: Record<string, unknown>,
    state: ChatToResponsesStreamState,
  ): { events: ChatToResponsesStreamEvent[]; consumed: boolean } {
    const type = str(response.type);
    const index = response.index == null ? 0 : asInt(response.index);
    if (type === "content_block_start") {
      const block = response.content_block ? asObj(response.content_block) : null;
      if (!block) return { events: [], consumed: false };
      const blockType = str(block.type).trim();
      if (blockType === "server_tool_use" || blockType === "mcp_tool_use") {
        if (this.pending.has(index)) {
          throw new Error(`duplicate Claude hosted-tool content block index ${index}`);
        }
        if (blockType === "mcp_tool_use" && (!str(block.name).trim() || !str(block.server_name).trim())) {
          throw new Error("Claude MCP tool use must include name and server_name");
        }
        claudeHostedCallOutputType(blockType, str(block.name));
        const pending: ClaudeHostedStreamCall = {
          blockType,
          id: str(block.id),
          name: str(block.name),
          serverName: str(block.server_name),
          caller: block.caller,
          startInput: undefined,
          input: "",
        };
        if (block.input != null) {
          const input = typeof block.input === "string" ? block.input.trim() : compactJson(block.input);
          if (input !== "{}" && input !== "null") pending.startInput = block.input;
        }
        this.pending.set(index, pending);
        return { events: [], consumed: true };
      }
      if (
        blockType === "web_search_tool_result" ||
        blockType === "mcp_tool_result" ||
        blockType === "code_execution_tool_result" ||
        blockType === "web_fetch_tool_result"
      ) {
        const outputType = claudeHostedResultOutputType(blockType);
        const result = outputType === "web_search_call" ? undefined : block.content;
        const events = state.completeHostedTool({
          type: outputType,
          id: str(block.tool_use_id),
          result,
          errorCode: claudeHostedResultErrorCode(block.content, str(block.error_code)),
          isError: block.is_error === true,
        });
        return { events, consumed: true };
      }
      return { events: [], consumed: false };
    }
    if (type === "content_block_delta") {
      const pending = this.pending.get(index);
      if (!pending) return { events: [], consumed: false };
      const delta = response.delta ? asObj(response.delta) : null;
      if (delta && str(delta.type) === "input_json_delta" && typeof delta.partial_json === "string") {
        pending.input += delta.partial_json;
      }
      return { events: [], consumed: true };
    }
    if (type === "content_block_stop") {
      const pending = this.pending.get(index);
      if (!pending) return { events: [], consumed: false };
      this.pending.delete(index);
      let action: unknown = pending.input;
      if (!str(pending.input).trim()) action = pending.startInput ?? {};
      const outputType = claudeHostedCallOutputType(pending.blockType, pending.name);
      const events = state.startHostedTool({
        type: outputType,
        id: pending.id,
        name: pending.name,
        action,
        caller: pending.caller,
        serverLabel: pending.serverName,
      });
      return { events, consumed: true };
    }
    return { events: [], consumed: false };
  }
}

/** Original `ClaudeResponsesStreamHandler` client SSE (`EmitSequenceNumber: true`). */
export function claudeSseToResponsesSse(
  text: string,
  opts: { id: string; model: string; created?: number; fallbackPromptTokens?: number },
): { sse: string; usageBody: Record<string, unknown> } {
  const state = newChatToResponsesStreamState(opts.id, opts.model, {
    created: opts.created,
    emitSequenceNumber: true,
  });
  const hosted = new ClaudeHostedStreamBridge();
  const claudeChat = newClaudeToChatStreamState();
  const info = {
    responseId: opts.id,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model: opts.model,
    usage: emptyOpenAIUsage(),
    done: false,
  };
  const events: ChatToResponsesStreamEvent[] = [];
  const fail = (err: Error): { sse: string; usageBody: Record<string, unknown> } => {
    events.push(...state.fail("server_error", err.message, ""));
    return {
      sse: events.map((event) => responsesSseEvent(event.type, event.payload)).join(""),
      usageBody: usageBodyFrom(state.usage),
    };
  };
  for (const payload of parseSseDataLines(text)) {
    const parsed = parseJsonObject(payload);
    if (!parsed) return fail(new Error("failed to unmarshal Claude stream event"));
    const claudeError = asObj(parsed.error);
    if (str(claudeError.type)) {
      return fail(new Error(str(claudeError.message) || str(claudeError.type)));
    }
    formatClaudeResponseInfo(parsed, null, info);
    if (!state.model && info.model) state.model = info.model;
    try {
      const hostedResult = hosted.convert(parsed, state);
      events.push(...hostedResult.events);
      if (hostedResult.consumed) continue;
      const chunk = convertClaudeStreamChunk(claudeChat, parsed);
      formatClaudeResponseInfo(parsed, chunk, info);
      if (!chunk) continue;
      events.push(...chatCompletionsStreamChunkToResponsesEvents(chunk, state));
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }
  }
  const mapped = buildOpenAIStyleUsageFromClaudeUsage(info.usage);
  state.usage = mapped.total_tokens ? mapped : maybeEstimateUsage(mapped, state.usageText(), opts.fallbackPromptTokens || 0);
  events.push(...finalizeChatCompletionsStreamToResponses(state));
  return {
    sse: events.map((event) => responsesSseEvent(event.type, event.payload)).join(""),
    usageBody: usageBodyFrom(state.usage),
  };
}

/** Original `OaiChatToResponsesStreamHandler` client SSE (`EmitSequenceNumber: true`). */
export function oaiChatSseToResponsesSse(
  text: string,
  opts: { id: string; model: string; created?: number; fallbackPromptTokens?: number },
): { sse: string; usageBody: Record<string, unknown> } {
  const state = newChatToResponsesStreamState(opts.id, opts.model, {
    created: opts.created,
    emitSequenceNumber: true,
  });
  const events: ChatToResponsesStreamEvent[] = [];
  const fail = (err: Error): { sse: string; usageBody: Record<string, unknown> } => {
    events.push(...state.fail("server_error", err.message, ""));
    return {
      sse: events.map((event) => responsesSseEvent(event.type, event.payload)).join(""),
      usageBody: usageBodyFrom(state.usage),
    };
  };
  for (const payload of parseSseDataLines(text)) {
    const parsed = parseJsonObject(payload);
    if (!parsed) {
      return fail(new Error("failed to unmarshal chat stream response"));
    }
    const oai = openAIErrorFrom(parsed);
    if (oai) return fail(new Error(oai.message));
    try {
      events.push(...chatCompletionsStreamChunkToResponsesEvents(parsed, state));
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (!state.usage.total_tokens) state.usage = maybeEstimateUsage(state.usage, state.usageText(), opts.fallbackPromptTokens || 0);
  events.push(...finalizeChatCompletionsStreamToResponses(state));
  return {
    sse: events.map((event) => responsesSseEvent(event.type, event.payload)).join(""),
    usageBody: usageBodyFrom(state.usage),
  };
}
