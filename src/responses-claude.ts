/** Original `relaykit/relayconvert/internal/oai_responses` Responses → Claude Messages JSON. */

import {
  applyClaudeReasoning,
  functionParametersToInputSchema,
  mapOpenAIToolChoice,
  type ConvertClaudeOpts,
} from "./claude-convert.js";
import { chatAnnotationsToClaude, openaiFinishReasonToClaudeStopReason } from "./claude-response.js";
import { asInt, asObj, emptyOpenAIUsage, openAIUsageToJson, parseSseDataPayloads, type OpenAIUsage } from "./openai-usage.js";
import {
  asClientError,
  claudeDefaultMaxTokensFor,
  fromOpenAIResponses,
  ERR_MISSING_CLAUDE_MAX_TOKENS,
} from "./reasoning.js";
import { responsesFinishReasonFromStatus, usageFromResponsesUsage } from "./responses-convert.js";

export const CONVERTER_RESPONSES_TO_CLAUDE = "openai_responses_to_claude_messages";

const EVENT_CREATED = "response.created";
const EVENT_COMPLETED = "response.completed";
const EVENT_DONE = "response.done";
const EVENT_INCOMPLETE = "response.incomplete";
const EVENT_FAILED = "response.failed";
const EVENT_ERROR = "response.error";
const EVENT_OUTPUT_TEXT_DELTA = "response.output_text.delta";
const EVENT_OUTPUT_TEXT_DONE = "response.output_text.done";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  return t;
}

function present(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function jsonString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeDataURL(url: string): { data: string; mime: string } | null {
  const m = String(url).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  return { mime: m[1], data: m[2].replace(/\s+/g, "") };
}

function callID(item: Record<string, unknown>): string {
  const id = str(item.call_id).trim();
  if (id) return id;
  return str(item.id).trim();
}

function objectValue(value: unknown, fallbackKey: string): Record<string, unknown> {
  if (value == null) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      if (Array.isArray(parsed)) return { [fallbackKey]: parsed };
    } catch {
      /* keep raw string */
    }
    return { [fallbackKey]: value };
  }
  if (Array.isArray(value)) return { [fallbackKey]: value };
  return { [fallbackKey]: value };
}

function responsesToolChoiceToChat(choice: unknown): unknown {
  if (choice == null || typeof choice === "string") return choice;
  const o = asObj(choice);
  if (str(o.type) === "function") {
    const name = str(o.name).trim();
    if (name) return { type: "function", function: { name } };
  }
  return choice;
}

function requestFunctionDeclarations(tools: unknown): { name: string; description: string; parameters: unknown }[] {
  if (!Array.isArray(tools)) return [];
  const functions: { name: string; description: string; parameters: unknown }[] = [];
  for (const raw of tools) {
    const tool = asObj(raw);
    if (str(tool.type).trim() !== "function") continue;
    const name = str(tool.name).trim();
    if (!name) continue;
    functions.push({
      name,
      description: str(tool.description),
      parameters: tool.parameters,
    });
  }
  return functions;
}

function inputItems(input: unknown): Record<string, unknown>[] {
  if (input == null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return input.map((item) => asObj(item));
  throw new Error(`unsupported responses input type ${JSON.stringify(jsonType(input))}`);
}

function contentParts(content: unknown): Record<string, unknown>[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: jsonString(content) }];
  const parts: Record<string, unknown>[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push({ type: "input_text", text: item });
    else parts.push(asObj(item));
  }
  return parts;
}

function partDataAndMime(part: Record<string, unknown>, keys: string[]): { data: string; mime: string } {
  let mime = str(part.mime_type).trim();
  for (const key of keys) {
    if (!(key in part)) continue;
    const value = part[key];
    if (typeof value === "string" && value) return { data: value, mime };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = asObj(value);
      if (!mime) mime = str(nested.mime_type).trim();
      for (const nestedKey of ["url", "file_data", "file_url", "data"]) {
        const data = str(nested[nestedKey]).trim();
        if (data) return { data, mime };
      }
    }
  }
  return { data: "", mime };
}

function contentPartFileSource(part: Record<string, unknown>): { data: string; mime: string } | null {
  const partType = str(part.type).trim();
  let data = "";
  let mime = "";
  switch (partType) {
    case "input_image":
      ({ data, mime } = partDataAndMime(part, ["image_url", "url"]));
      break;
    case "input_file":
      ({ data, mime } = partDataAndMime(part, ["file", "file_data", "file_url", "url"]));
      break;
    case "input_audio": {
      ({ data, mime } = partDataAndMime(part, ["input_audio", "data", "url"]));
      if (!mime) {
        const format = str(asObj(part.input_audio).format).trim();
        if (format) mime = `audio/${format}`;
      }
      break;
    }
    case "input_video":
      ({ data, mime } = partDataAndMime(part, ["video_url", "url"]));
      break;
    default:
      return null;
  }
  if (!data) return null;
  return { data, mime };
}

function resolveFileSource(
  source: { data: string; mime: string },
  opts: ConvertClaudeOpts,
  reason: string,
): { data: string; mime: string } {
  const decoded = decodeDataURL(source.data);
  if (decoded) return decoded;
  if (opts.resolveMedia) {
    const resolved = opts.resolveMedia(source.data);
    if (resolved) return resolved;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(source.data) && !source.data.includes("://")) {
    return { data: source.data.replace(/\s+/g, ""), mime: source.mime || "image/png" };
  }
  throw new Error(`get file data failed: unable to resolve ${reason}`);
}

function responsesInputContentToClaudeMedia(
  content: unknown,
  opts: ConvertClaudeOpts,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const contentPart of contentParts(content)) {
    const partType = str(contentPart.type).trim();
    if (partType === "input_text" || partType === "output_text" || partType === "text") {
      const text = str(contentPart.text);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (partType === "input_image" || partType === "input_file" || partType === "input_audio" || partType === "input_video") {
      const source = contentPartFileSource(contentPart);
      if (!source) continue;
      const resolved = resolveFileSource(source, opts, "formatting Responses input for Claude");
      const claudePart: Record<string, unknown> = {
        source: { type: "base64", media_type: resolved.mime, data: resolved.data },
      };
      claudePart.type = resolved.mime.startsWith("application/pdf") ? "document" : "image";
      parts.push(claudePart);
    }
  }
  return parts;
}

function claudeMessageContentParts(content: unknown): Record<string, unknown>[] {
  if (Array.isArray(content)) return content.map((item) => asObj(item));
  if (typeof content === "string") {
    if (!content) return [];
    return [{ type: "text", text: content }];
  }
  return [];
}

function appendClaudeToolUse(messages: Record<string, unknown>[], toolUse: Record<string, unknown>): Record<string, unknown>[] {
  if (messages.length && str(messages[messages.length - 1].role) === "assistant") {
    const last = { ...messages[messages.length - 1] };
    last.content = [...claudeMessageContentParts(last.content), toolUse];
    messages[messages.length - 1] = last;
    return messages;
  }
  return [...messages, { role: "assistant", content: [toolUse] }];
}

function appendClaudeToolResult(messages: Record<string, unknown>[], toolResult: Record<string, unknown>): Record<string, unknown>[] {
  if (messages.length && str(messages[messages.length - 1].role) === "user") {
    const last = { ...messages[messages.length - 1] };
    last.content = [...claudeMessageContentParts(last.content), toolResult];
    messages[messages.length - 1] = last;
    return messages;
  }
  return [...messages, { role: "user", content: [toolResult] }];
}

function responsesClaudeRole(role: string): string {
  switch (role) {
    case "assistant":
      return "assistant";
    case "system":
    case "developer":
      return "system";
    default:
      return "user";
  }
}

function ensureClaudeMessagesStartWithUser(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  if (messages.length && str(messages[0].role) === "user") return messages;
  return [{ role: "user", content: [{ type: "text", text: "..." }] }, ...messages];
}

function validateUnsupportedStatefulFields(req: Record<string, unknown>): void {
  const unsupported: string[] = [];
  if (present(req.conversation)) unsupported.push("conversation");
  if (str(req.previous_response_id).trim()) unsupported.push("previous_response_id");
  if (present(req.prompt)) unsupported.push("prompt");
  if (present(req.context_management)) unsupported.push("context_management");
  if (unsupported.length) {
    throw new Error(`responses to chat conversion does not support stateful fields: ${unsupported.join(", ")}`);
  }
}

/** Original `OpenAIResponsesRequestToClaudeMessages`. */
export function convertOpenAIResponsesRequestToClaudeMessages(
  body: Record<string, unknown>,
  opts: ConvertClaudeOpts = {},
): Record<string, unknown> {
  if (!body) throw new Error("request is nil");
  const model = str(body.model || "").trim();
  if (!model) throw new Error("model is required");
  validateUnsupportedStatefulFields(body);

  const claudeRequest: Record<string, unknown> = { model: opts.upstreamModelName || model };
  if (body.temperature != null) claudeRequest.temperature = body.temperature;
  if (body.top_p != null) claudeRequest.top_p = body.top_p;
  if (body.stream != null) claudeRequest.stream = body.stream;
  const maxOutput = Number(body.max_output_tokens ?? 0);
  if (maxOutput > 0) claudeRequest.max_tokens = maxOutput;

  const functions = requestFunctionDeclarations(body.tools);
  if (functions.length) {
    claudeRequest.tools = functions.map((fn) => {
      const tool: Record<string, unknown> = {
        name: fn.name,
        input_schema: functionParametersToInputSchema(fn.parameters),
      };
      if (fn.description) tool.description = fn.description;
      return tool;
    });
  }

  const toolChoice = responsesToolChoiceToChat(body.tool_choice);
  if (toolChoice != null || body.parallel_tool_calls != null) {
    const choice = mapOpenAIToolChoice(toolChoice, body.parallel_tool_calls);
    if (choice) claudeRequest.tool_choice = choice;
  }

  try {
    const sourceReasoning = fromOpenAIResponses(body);
    applyClaudeReasoning(claudeRequest, sourceReasoning, { ...opts, upstreamModelName: str(claudeRequest.model) }, true);
  } catch (err) {
    throw asClientError(err);
  }
  if (claudeRequest.max_tokens == null) {
    claudeRequest.max_tokens = claudeDefaultMaxTokensFor(str(claudeRequest.model), opts.settings);
  }

  const systemMessages: Record<string, unknown>[] = [];
  if (present(body.instructions)) {
    const instructions = typeof body.instructions === "string" ? body.instructions : jsonString(body.instructions);
    if (instructions.trim()) systemMessages.push({ type: "text", text: instructions });
  }

  let messages: Record<string, unknown>[] = [];
  for (const item of inputItems(body.input)) {
    const itemType = str(item.type).trim();
    if (itemType === "function_call") {
      messages = appendClaudeToolUse(messages, {
        type: "tool_use",
        id: callID(item),
        name: str(item.name).trim(),
        input: objectValue(item.arguments, "arguments"),
      });
      continue;
    }
    if (itemType === "custom_tool_call") {
      messages = appendClaudeToolUse(messages, {
        type: "tool_use",
        id: callID(item),
        name: str(item.name).trim(),
        input: objectValue(item.input, "input"),
      });
      continue;
    }
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      messages = appendClaudeToolResult(messages, {
        type: "tool_result",
        tool_use_id: callID(item),
        content: item.output == null ? "" : item.output,
      });
      continue;
    }
    const sourceRole = str(item.role).trim();
    const role = responsesClaudeRole(sourceRole);
    const parts = responsesInputContentToClaudeMedia(item.content, opts);
    if (!sourceRole && !parts.length) continue;
    if (role === "system") {
      for (const part of parts) {
        if (str(part.type) === "text") systemMessages.push(part);
      }
      continue;
    }
    messages.push({
      role,
      content: parts.length ? parts : [{ type: "text", text: "..." }],
    });
  }

  if (systemMessages.length) claudeRequest.system = systemMessages;
  if (messages.length || systemMessages.length) {
    claudeRequest.messages = ensureClaudeMessagesStartWithUser(messages);
  } else {
    claudeRequest.messages = messages;
  }
  if (claudeRequest.max_tokens == null) throw asClientError(new Error(ERR_MISSING_CLAUDE_MAX_TOKENS));
  return claudeRequest;
}

function hasOpenAIUsageTokens(usage: OpenAIUsage): boolean {
  if (
    usage.prompt_tokens ||
    usage.completion_tokens ||
    usage.total_tokens ||
    usage.input_tokens ||
    usage.output_tokens ||
    usage.prompt_cache_hit_tokens ||
    usage.claude_cache_creation_5_m_tokens ||
    usage.claude_cache_creation_1_h_tokens
  ) {
    return true;
  }
  const d = usage.prompt_tokens_details;
  return Boolean(d.cached_tokens || d.cached_creation_tokens || d.cache_write_tokens || d.text_tokens || d.audio_tokens || d.image_tokens);
}

function originalResponsesUsageSnapshot(src: Record<string, unknown>): OpenAIUsage {
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = asInt(src.prompt_tokens);
  usage.completion_tokens = asInt(src.completion_tokens);
  usage.total_tokens = asInt(src.total_tokens);
  usage.input_tokens = asInt(src.input_tokens);
  usage.output_tokens = asInt(src.output_tokens);
  usage.claude_cache_creation_5_m_tokens = asInt(src.claude_cache_creation_5_m_tokens);
  usage.claude_cache_creation_1_h_tokens = asInt(src.claude_cache_creation_1_h_tokens);
  const details = asObj(src.prompt_tokens_details || src.input_tokens_details);
  usage.prompt_tokens_details.cached_tokens = asInt(details.cached_tokens);
  usage.prompt_tokens_details.text_tokens = asInt(details.text_tokens);
  usage.prompt_tokens_details.audio_tokens = asInt(details.audio_tokens);
  usage.prompt_tokens_details.image_tokens = asInt(details.image_tokens);
  if ("input_tokens_details" in src) {
    usage.input_tokens_details = src.input_tokens_details == null ? null : asObj(src.input_tokens_details) as OpenAIUsage["input_tokens_details"];
  }
  return usage;
}

function newOpenAIResponsesBillingUsage(src: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!src) return undefined;
  const snapshot = originalResponsesUsageSnapshot(src);
  if (!hasOpenAIUsageTokens(snapshot) && !asInt(src.input_tokens) && !asInt(src.output_tokens) && !asInt(src.total_tokens)) {
    return undefined;
  }
  if (!hasOpenAIUsageTokens(snapshot) && !(asInt(src.input_tokens) || asInt(src.output_tokens) || asInt(src.total_tokens))) {
    return undefined;
  }
  return { source: "oai_responses", semantic: "openai", openai_usage: openAIUsageToJson(snapshot) };
}

function usageFromResponsesUsageWithSidecar(src: Record<string, unknown> | null | undefined): OpenAIUsage {
  const usage = usageFromResponsesUsage(src);
  if (!usage.billing_usage) {
    const sidecar = newOpenAIResponsesBillingUsage(src);
    if (sidecar) usage.billing_usage = sidecar;
  }
  return usage;
}

function cacheCreationTokensTotal(details: OpenAIUsage["prompt_tokens_details"]): number {
  return Math.max(details.cache_write_tokens || 0, details.cached_creation_tokens || 0);
}

/** Original `sharedclaude.UsageFromOpenAI` over Responses-mapped usage. */
export function claudeUsageFromResponsesOpenAI(usage: OpenAIUsage | null | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const existing = usage.billing_usage ? { ...usage.billing_usage } : undefined;
  if (
    existing &&
    existing.claude_usage &&
    typeof existing.claude_usage === "object" &&
    (str(existing.source) === "claude_messages" || str(existing.semantic) === "anthropic")
  ) {
    const result = { ...asObj(existing.claude_usage) };
    result.billing_usage = existing;
    return claudeUsageJson(result);
  }
  const details = usage.prompt_tokens_details;
  const cacheCreation = cacheCreationTokensTotal(details);
  let inputTokens = usage.prompt_tokens;
  if (usage.usage_semantic !== "anthropic") {
    inputTokens = usage.prompt_tokens - details.cached_tokens - cacheCreation;
    if (inputTokens < 0) inputTokens = 0;
  }
  let billingUsage = existing;
  if (!billingUsage && hasOpenAIUsageTokens(usage)) {
    billingUsage = { source: "oai_chat", semantic: "openai", openai_usage: openAIUsageToJson(usage) };
  }
  return claudeUsageJson({
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: details.cached_tokens,
    output_tokens: usage.completion_tokens,
    claude_cache_creation_5_m_tokens: 0,
    claude_cache_creation_1_h_tokens: 0,
    billing_usage: billingUsage,
  });
}

function claudeUsageJson(usage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_tokens: asInt(usage.input_tokens),
    cache_creation_input_tokens: asInt(usage.cache_creation_input_tokens),
    cache_read_input_tokens: asInt(usage.cache_read_input_tokens),
    output_tokens: asInt(usage.output_tokens),
    claude_cache_creation_5_m_tokens: asInt(usage.claude_cache_creation_5_m_tokens),
    claude_cache_creation_1_h_tokens: asInt(usage.claude_cache_creation_1_h_tokens),
  };
  if (usage.cache_creation) out.cache_creation = usage.cache_creation;
  if (usage.server_tool_use) out.server_tool_use = usage.server_tool_use;
  if (usage.billing_usage) out.billing_usage = usage.billing_usage;
  return out;
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

function mergeUsageNonZero(current: OpenAIUsage | null | undefined, incoming: OpenAIUsage | null | undefined): OpenAIUsage {
  const out = current ? cloneUsage(current) : emptyOpenAIUsage();
  if (!incoming) return out;
  if (incoming.prompt_tokens > 0) out.prompt_tokens = incoming.prompt_tokens;
  if (incoming.completion_tokens > 0) out.completion_tokens = incoming.completion_tokens;
  if (incoming.total_tokens > 0) out.total_tokens = incoming.total_tokens;
  if (incoming.prompt_cache_hit_tokens) out.prompt_cache_hit_tokens = incoming.prompt_cache_hit_tokens;
  if (incoming.input_tokens > 0) out.input_tokens = incoming.input_tokens;
  if (incoming.output_tokens > 0) out.output_tokens = incoming.output_tokens;
  if (incoming.claude_cache_creation_5_m_tokens > 0) out.claude_cache_creation_5_m_tokens = incoming.claude_cache_creation_5_m_tokens;
  if (incoming.claude_cache_creation_1_h_tokens > 0) out.claude_cache_creation_1_h_tokens = incoming.claude_cache_creation_1_h_tokens;
  if (incoming.usage_semantic) out.usage_semantic = incoming.usage_semantic;
  if (incoming.billing_usage) out.billing_usage = incoming.billing_usage;
  out.prompt_tokens_details = { ...out.prompt_tokens_details, ...incoming.prompt_tokens_details };
  out.completion_tokens_details = { ...out.completion_tokens_details, ...incoming.completion_tokens_details };
  const total = out.prompt_tokens + out.completion_tokens;
  if (total > out.total_tokens) out.total_tokens = total;
  return out;
}

function responsesArgumentsString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "string") return parsed;
      } catch {
        /* keep raw */
      }
    }
    return value;
  }
  return jsonString(value);
}

function responsesArgumentsToClaudeInput(argumentsText: string): Record<string, unknown> {
  if (!argumentsText.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* original Unmarshal failure → {input: raw} */
  }
  return { input: argumentsText };
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

function responsesClaudeStopReason(resp: Record<string, unknown> | null | undefined, sawToolCall: boolean): string {
  if (resp) {
    const finish = responsesFinishReasonFromStatus(resp);
    if (finish) return openaiFinishReasonToClaudeStopReason(finish);
  }
  if (sawToolCall) return "tool_use";
  return "end_turn";
}

/** Original `ResponsesResponseToClaudeMessagesResponse`. */
export function responsesResponseToClaudeMessagesResponse(resp: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!resp) throw new Error("response is nil");
  const usage = usageFromResponsesUsageWithSidecar(asObj(resp.usage));
  const content: Record<string, unknown>[] = [];
  let sawToolCall = false;
  for (const output of Array.isArray(resp.output) ? resp.output : []) {
    const item = asObj(output);
    const type = str(item.type);
    if (type === "message" && str(item.role) && str(item.role) !== "assistant") continue;
    if (type === "reasoning") {
      const thinking = reasoningOutputText(item);
      if (thinking) content.push({ type: "thinking", thinking });
      continue;
    }
    if (type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const block = asObj(part);
        if (str(block.type) !== "output_text") continue;
        const text = str(block.text);
        const claudeBlock: Record<string, unknown> = { type: "text", text };
        const citations = chatAnnotationsToClaude(block.annotations, text);
        if (citations.length) claudeBlock.citations = citations;
        content.push(claudeBlock);
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      sawToolCall = true;
      let id = str(item.call_id).trim();
      if (!id) id = str(item.id).trim();
      content.push({
        type: "tool_use",
        id,
        name: item.name,
        input: responsesArgumentsToClaudeInput(responsesArgumentsString(item.arguments ?? item.input)),
      });
    }
  }
  const out: Record<string, unknown> = {
    id: resp.id,
    type: "message",
    role: "assistant",
    model: resp.model,
    usage: claudeUsageFromResponsesOpenAI(usage),
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: responsesClaudeStopReason(resp, sawToolCall),
  };
  return out;
}

export function looksLikeOpenAIResponsesResponse(json: Record<string, unknown>): boolean {
  return str(json.object) === "response";
}

type ResponsesClaudeStreamBlock = {
  index: number;
  kind: string;
  itemId: string;
  callId: string;
  name: string;
  started: boolean;
  stopped: boolean;
  value: string;
  sentBytes: number;
  annotationCount: number;
  needsReasoningBreak: boolean;
};

function responseStreamEventItemID(event: Record<string, unknown>): string {
  const item = event.item && typeof event.item === "object" ? asObj(event.item) : null;
  if (item && str(item.id).trim()) return str(item.id).trim();
  return str(event.item_id).trim();
}

function separatedResponsesDelta(delta: string): string {
  if (delta.startsWith("\n\n")) return delta;
  if (delta.startsWith("\n")) return `\n${delta}`;
  return `\n\n${delta}`;
}

/** Original `ResponsesToClaudeStreamState`. */
export class ResponsesToClaudeStreamState {
  id: string;
  model: string;
  usage: OpenAIUsage | null = null;
  private sentMessageStart = false;
  private done = false;
  private sawToolCall = false;
  private nextBlockIndex = 0;
  private blocks: ResponsesClaudeStreamBlock[] = [];
  private byOutputIndex = new Map<number, ResponsesClaudeStreamBlock>();
  private byItemID = new Map<string, ResponsesClaudeStreamBlock>();
  private lastByKind = new Map<string, ResponsesClaudeStreamBlock>();
  private usageTextParts = "";

  constructor(id = "", model = "") {
    this.id = id.trim();
    this.model = model.trim();
  }

  usageText(): string {
    return this.usageTextParts;
  }

  isDone(): boolean {
    return this.done;
  }

  setUsage(usage: OpenAIUsage | null | undefined): void {
    if (usage) this.usage = usage;
  }

  convertChunk(event: Record<string, unknown> | null | undefined, estimatedInputTokens = 0): Record<string, unknown>[] {
    if (!event || this.done) return [];
    this.applyResponseMetadata(event.response && typeof event.response === "object" ? asObj(event.response) : null);
    const type = str(event.type);
    switch (type) {
      case EVENT_CREATED:
        return this.ensureMessageStart(estimatedInputTokens);
      case EVENT_REASONING_SUMMARY_DELTA:
      case EVENT_REASONING_TEXT_DELTA: {
        const block = this.ensureBlock(event, "thinking");
        let delta = str(event.delta);
        if (block.needsReasoningBreak && delta) {
          delta = separatedResponsesDelta(delta);
          block.needsReasoningBreak = false;
        }
        return this.appendDelta(block, delta, estimatedInputTokens);
      }
      case EVENT_REASONING_SUMMARY_DONE:
      case EVENT_REASONING_TEXT_DONE: {
        const block = this.ensureBlock(event, "thinking");
        const responses: Record<string, unknown>[] = [];
        if (event.text != null) responses.push(...this.mergeFinalValue(block, str(event.text), estimatedInputTokens));
        if (block.value.length) block.needsReasoningBreak = true;
        return responses;
      }
      case EVENT_OUTPUT_TEXT_DELTA: {
        const block = this.ensureBlock(event, "text");
        return this.appendDelta(block, str(event.delta), estimatedInputTokens);
      }
      case EVENT_OUTPUT_TEXT_DONE: {
        const block = this.ensureBlock(event, "text");
        if (event.text == null) return [];
        return this.mergeFinalValue(block, str(event.text), estimatedInputTokens);
      }
      case EVENT_OUTPUT_TEXT_ANNOTATION_ADDED: {
        const block = this.ensureBlock(event, "text");
        return this.appendAnnotations(block, [event.annotation], estimatedInputTokens, false);
      }
      case EVENT_OUTPUT_ITEM_ADDED:
      case EVENT_OUTPUT_ITEM_DONE:
        return this.applyOutputItem(event, estimatedInputTokens, type === EVENT_OUTPUT_ITEM_DONE);
      case EVENT_FUNCTION_ARGS_DELTA:
      case EVENT_CUSTOM_TOOL_INPUT_DELTA: {
        const block = this.ensureBlock(event, "tool_use");
        return this.appendDelta(block, str(event.delta), estimatedInputTokens);
      }
      case EVENT_FUNCTION_ARGS_DONE:
      case EVENT_CUSTOM_TOOL_INPUT_DONE: {
        const block = this.ensureBlock(event, "tool_use");
        if (event.arguments == null && event.input == null) return [];
        return this.mergeFinalValue(block, responsesArgumentsString(event.arguments ?? event.input), estimatedInputTokens);
      }
      case EVENT_COMPLETED:
      case EVENT_DONE:
      case EVENT_INCOMPLETE:
        return this.finish(event.response && typeof event.response === "object" ? asObj(event.response) : null, estimatedInputTokens);
      case EVENT_FAILED:
      case EVENT_ERROR: {
        const message = str(event.message).trim() || type;
        throw new Error(`responses stream error: ${message}`);
      }
      default:
        return [];
    }
  }

  finalize(estimatedInputTokens = 0): Record<string, unknown>[] {
    if (this.done) return [];
    return this.finish(null, estimatedInputTokens);
  }

  private applyResponseMetadata(response: Record<string, unknown> | null): void {
    if (!response) return;
    if (str(response.id)) this.id = str(response.id);
    if (str(response.model)) this.model = str(response.model);
    if (response.usage && typeof response.usage === "object") {
      this.usage = mergeUsageNonZero(this.usage, usageFromResponsesUsageWithSidecar(asObj(response.usage)));
    }
  }

  private ensureMessageStart(estimatedInputTokens: number): Record<string, unknown>[] {
    if (this.sentMessageStart) return [];
    this.sentMessageStart = true;
    let inputTokens = estimatedInputTokens;
    if (this.usage) {
      const usage = claudeUsageFromResponsesOpenAI(this.usage);
      if (usage) inputTokens = asInt(usage.input_tokens);
    }
    return [
      {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          usage: {
            input_tokens: inputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            claude_cache_creation_5_m_tokens: 0,
            claude_cache_creation_1_h_tokens: 0,
          },
          content: [],
        },
      },
    ];
  }

  private findBlock(event: Record<string, unknown>): ResponsesClaudeStreamBlock | undefined {
    if (event.output_index != null) {
      const found = this.byOutputIndex.get(asInt(event.output_index));
      if (found) return found;
    }
    const itemID = responseStreamEventItemID(event);
    if (itemID) return this.byItemID.get(itemID);
    return undefined;
  }

  private applyBlockMetadata(block: ResponsesClaudeStreamBlock, event: Record<string, unknown>): void {
    if (event.output_index != null) this.byOutputIndex.set(asInt(event.output_index), block);
    const itemID = responseStreamEventItemID(event);
    if (itemID) {
      block.itemId = itemID;
      this.byItemID.set(itemID, block);
    }
    const item = event.item && typeof event.item === "object" ? asObj(event.item) : null;
    if (!item) return;
    const callID = str(item.call_id).trim();
    if (callID) block.callId = callID;
    else if (!block.callId) block.callId = str(item.id).trim();
    const name = str(item.name).trim();
    if (name) block.name = name;
  }

  private ensureBlock(event: Record<string, unknown>, kind: string): ResponsesClaudeStreamBlock {
    let block = this.findBlock(event);
    if (!block) {
      const last = this.lastByKind.get(kind);
      if (last && !last.stopped && event.output_index == null && !responseStreamEventItemID(event)) block = last;
    }
    if (!block) {
      block = {
        index: this.nextBlockIndex,
        kind,
        itemId: "",
        callId: "",
        name: "",
        started: false,
        stopped: false,
        value: "",
        sentBytes: 0,
        annotationCount: 0,
        needsReasoningBreak: false,
      };
      this.nextBlockIndex += 1;
      this.blocks.push(block);
    }
    if (!block.kind) block.kind = kind;
    if (block.kind !== kind) throw new Error(`Responses output item changed from ${block.kind} to ${kind}`);
    this.applyBlockMetadata(block, event);
    this.lastByKind.set(kind, block);
    return block;
  }

  private startBlock(block: ResponsesClaudeStreamBlock | undefined, estimatedInputTokens: number): Record<string, unknown>[] {
    if (!block || block.started || block.stopped) return [];
    let content: Record<string, unknown>;
    switch (block.kind) {
      case "text":
        content = { type: "text", text: "" };
        break;
      case "thinking":
        content = { type: "thinking", thinking: "" };
        break;
      case "tool_use": {
        if (!block.name) return [];
        const callID = block.callId || block.itemId;
        content = { type: "tool_use", id: callID, name: block.name, input: {} };
        this.sawToolCall = true;
        break;
      }
      default:
        return [];
    }
    block.started = true;
    const responses = this.ensureMessageStart(estimatedInputTokens);
    responses.push({ type: "content_block_start", index: block.index, content_block: content });
    return responses;
  }

  private appendDelta(block: ResponsesClaudeStreamBlock | undefined, delta: string, estimatedInputTokens: number): Record<string, unknown>[] {
    if (!block || block.stopped || !delta) return [];
    block.value += delta;
    return this.flushBlock(block, estimatedInputTokens);
  }

  private mergeFinalValue(block: ResponsesClaudeStreamBlock | undefined, finalValue: string, estimatedInputTokens: number): Record<string, unknown>[] {
    if (!block || block.stopped) return [];
    const current = block.value;
    if (!current) block.value = finalValue;
    else if (finalValue.startsWith(current)) block.value += finalValue.slice(current.length);
    return this.flushBlock(block, estimatedInputTokens);
  }

  private flushBlock(block: ResponsesClaudeStreamBlock | undefined, estimatedInputTokens: number): Record<string, unknown>[] {
    if (!block || block.stopped) return [];
    const responses = this.startBlock(block, estimatedInputTokens);
    if (!block.started) return responses;
    const value = block.value;
    if (block.sentBytes >= value.length) return responses;
    const delta = value.slice(block.sentBytes);
    block.sentBytes = value.length;
    this.usageTextParts += delta;
    const media: Record<string, unknown> = {};
    switch (block.kind) {
      case "text":
        media.type = "text_delta";
        media.text = delta;
        break;
      case "thinking":
        media.type = "thinking_delta";
        media.thinking = delta;
        break;
      case "tool_use":
        media.type = "input_json_delta";
        media.partial_json = delta;
        break;
    }
    responses.push({ type: "content_block_delta", index: block.index, delta: media });
    return responses;
  }

  private stopBlock(block: ResponsesClaudeStreamBlock | undefined, estimatedInputTokens: number): Record<string, unknown>[] {
    if (!block || block.stopped) return [];
    const responses = this.flushBlock(block, estimatedInputTokens);
    responses.push(...this.startBlock(block, estimatedInputTokens));
    if (!block.started) return responses;
    block.stopped = true;
    responses.push({ type: "content_block_stop", index: block.index });
    return responses;
  }

  private applyOutputItem(event: Record<string, unknown>, estimatedInputTokens: number, stop: boolean): Record<string, unknown>[] {
    const item = event.item && typeof event.item === "object" ? asObj(event.item) : null;
    if (!item) return [];
    let kind = "";
    switch (str(item.type)) {
      case "reasoning":
        kind = "thinking";
        break;
      case "message":
        if (str(item.role) && str(item.role) !== "assistant") return [];
        kind = "text";
        break;
      case "function_call":
      case "custom_tool_call":
        kind = "tool_use";
        break;
      default:
        return [];
    }
    const block = this.ensureBlock(event, kind);
    const responses: Record<string, unknown>[] = [];
    if (kind === "thinking") {
      responses.push(...this.mergeFinalValue(block, reasoningOutputText(item), estimatedInputTokens));
    } else if (kind === "text") {
      let text = "";
      const annotations: unknown[] = [];
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const content = asObj(part);
        if (str(content.type) !== "output_text") continue;
        text += str(content.text);
        if (Array.isArray(content.annotations)) annotations.push(...content.annotations);
      }
      responses.push(...this.mergeFinalValue(block, text, estimatedInputTokens));
      responses.push(...this.appendAnnotations(block, annotations, estimatedInputTokens, true));
    } else {
      responses.push(...this.mergeFinalValue(block, responsesArgumentsString(item.arguments ?? item.input), estimatedInputTokens));
    }
    if (stop) responses.push(...this.stopBlock(block, estimatedInputTokens));
    return responses;
  }

  private appendAnnotations(
    block: ResponsesClaudeStreamBlock | undefined,
    annotations: unknown[],
    estimatedInputTokens: number,
    snapshot: boolean,
  ): Record<string, unknown>[] {
    if (!block || block.kind !== "text" || block.stopped || !annotations.length) return [];
    let remaining = annotations;
    if (snapshot) {
      if (annotations.length <= block.annotationCount) return [];
      remaining = annotations.slice(block.annotationCount);
      block.annotationCount = annotations.length;
    } else {
      block.annotationCount += annotations.length;
    }
    const citations = chatAnnotationsToClaude(remaining, block.value);
    if (!citations.length) return [];
    const responses = this.startBlock(block, estimatedInputTokens);
    for (const citation of citations) {
      responses.push({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "citations_delta", citation },
      });
    }
    return responses;
  }

  private finish(response: Record<string, unknown> | null, estimatedInputTokens: number): Record<string, unknown>[] {
    if (this.done) return [];
    this.applyResponseMetadata(response);
    const responses: Record<string, unknown>[] = [];
    if (response && Array.isArray(response.output)) {
      response.output.forEach((raw, outputIndex) => {
        const item = asObj(raw);
        const event = { output_index: outputIndex, item_id: item.id, item };
        responses.push(...this.applyOutputItem(event, estimatedInputTokens, true));
      });
    }
    for (const block of this.blocks) responses.push(...this.stopBlock(block, estimatedInputTokens));
    responses.push(...this.ensureMessageStart(estimatedInputTokens));
    const stopReason = responsesClaudeStopReason(response, this.sawToolCall);
    responses.push(
      {
        type: "message_delta",
        usage: claudeUsageFromResponsesOpenAI(this.usage || emptyOpenAIUsage()),
        delta: { stop_reason: stopReason },
      },
      { type: "message_stop" },
    );
    this.done = true;
    return responses;
  }
}

/** Original Responses → Claude stream SSE over a buffered Responses SSE body. */
export function oaiResponsesSseToClaudeSse(
  sse: string,
  opts: { id?: string; model?: string; estimatePromptTokens?: number } = {},
): { sse: string; usageBody: Record<string, unknown>; events: Record<string, unknown>[] } {
  const state = new ResponsesToClaudeStreamState(opts.id || "", opts.model || "");
  const events: Record<string, unknown>[] = [];
  const estimate = opts.estimatePromptTokens || 0;
  for (const payload of parseSseDataPayloads(sse)) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(payload) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed) continue;
    events.push(...state.convertChunk(parsed, estimate));
  }
  events.push(...state.finalize(estimate));
  let encoded = "";
  for (const ev of events) {
    encoded += `event: ${str(ev.type)}\n`;
    encoded += `data: ${JSON.stringify(ev)}\n\n`;
  }
  return { sse: encoded, usageBody: state.usage ? openAIUsageToJson(state.usage) : {}, events };
}

export function looksLikeResponsesSse(text: string): boolean {
  return /"type"\s*:\s*"response\./.test(text);
}
