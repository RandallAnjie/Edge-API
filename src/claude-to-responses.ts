/** Original `relaykit/relayconvert/internal/claude_messages/to_oai_responses_req.go`. */

import {
  asClientError,
  applyToOpenAIResponses,
  fromClaude,
  intentIsEmpty,
  mergeExplicitAndSuffix,
  parseHostModelModifiers,
  resolveClaudeDefault,
  type ReasoningHostSettings,
  type ReasoningIntent,
} from "./reasoning.js";

/** Original `requestConverterClaudeToResponses`. Not an advanced-custom ConvertClaudeRequest ID. */
export const CONVERTER_CLAUDE_TO_RESPONSES = "claude_messages_to_openai_responses";

export type ConvertClaudeToResponsesOpts = {
  originModelName?: string;
  upstreamModelName?: string;
  settings?: ReasoningHostSettings;
  suffixIntent?: ReasoningIntent;
  /** Original `convmeta.OptionsOf(info).OpenRouterDialect`. */
  openRouterDialect?: boolean;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function blockText(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

function interface2String(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value == null) return "";
  return String(value);
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function claudeSourceURL(source: unknown): string {
  const src = asObj(source);
  if (typeof src.url === "string" && src.url.trim()) return src.url;
  const data = interface2String(src.data);
  if (!data) return "";
  if (data.startsWith("data:")) return data;
  return `data:${String(src.media_type || src.mediaType || "")};base64,${data}`;
}

function claudeSystemToResponsesInstructions(body: Record<string, unknown>): string | undefined {
  if (body.system == null) return undefined;
  if (typeof body.system === "string") return body.system;
  if (!Array.isArray(body.system)) throw new Error("invalid Claude system content");
  let instructions = "";
  for (const raw of body.system) {
    const block = typeof raw === "string" ? { type: "text", text: raw } : asObj(raw);
    const type = String(block.type || "");
    if (type === "text" || type === "input_text" || type === "") instructions += blockText(block);
  }
  return instructions || undefined;
}

function claudeToolResultToResponsesOutput(content: unknown): unknown {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts: Record<string, unknown>[] = [];
  for (const raw of content) {
    const block = typeof raw === "string" ? { type: "text", text: raw } : asObj(raw);
    const type = String(block.type || "");
    if (type === "text" || type === "input_text") {
      parts.push({ type: "input_text", text: blockText(block) });
    } else if (type === "image") {
      const source = claudeSourceURL(block.source);
      if (source) parts.push({ type: "input_image", image_url: source });
    } else if (type === "document") {
      const source = claudeSourceURL(block.source);
      if (source) parts.push({ type: "input_file", file_data: source });
    }
  }
  return parts.length ? parts : content;
}

function claudeMessagesToResponsesInput(messages: unknown[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = asObj(messages[messageIndex]);
    const role = String(message.role || "").trim();
    if (!role) continue;
    if (typeof message.content === "string") {
      input.push({ role, content: message.content });
      continue;
    }
    if (message.content != null && !Array.isArray(message.content)) {
      throw new Error(`messages[${messageIndex}].content: invalid Claude message content`);
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    let contentParts: Record<string, unknown>[] = [];
    const flushContent = () => {
      if (!contentParts.length) return;
      input.push({ role, content: contentParts });
      contentParts = [];
    };
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const raw = blocks[blockIndex];
      const block = typeof raw === "string" ? { type: "text", text: raw } : asObj(raw);
      const type = String(block.type || "");
      switch (type) {
        case "text":
        case "input_text":
          contentParts.push({
            type: role === "assistant" ? "output_text" : "input_text",
            text: blockText(block),
          });
          break;
        case "image": {
          const source = claudeSourceURL(block.source);
          if (source) contentParts.push({ type: "input_image", image_url: source });
          break;
        }
        case "document": {
          const source = claudeSourceURL(block.source);
          if (source) contentParts.push({ type: "input_file", file_data: source });
          break;
        }
        case "tool_use": {
          flushContent();
          const argumentsJson = block.input == null ? "{}" : jsonString(block.input);
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: argumentsJson,
          });
          break;
        }
        case "tool_result":
          flushContent();
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id || block.toolUseId,
            output: claudeToolResultToResponsesOutput(block.content),
          });
          break;
      }
    }
    flushContent();
  }
  return input;
}

function claudeToolsToResponsesTools(value: unknown): Record<string, unknown>[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid Claude tools");
  return value.map((raw) => {
    const tool = asObj(raw);
    const functionTool: Record<string, unknown> = {
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema ?? tool.inputSchema,
    };
    if (tool.strict != null) functionTool.strict = tool.strict;
    return functionTool;
  });
}

function claudeToolChoiceToResponses(value: unknown): { toolChoice?: unknown; parallelToolCalls?: boolean } {
  if (value == null) return {};
  const choice = typeof value === "string" ? { type: value } : asObj(value);
  if (!choice.type && value && typeof value !== "object") throw new Error("invalid Claude tool_choice");
  const type = String(choice.type || "");
  let converted: unknown;
  switch (type) {
    case "":
    case "auto":
      converted = "auto";
      break;
    case "any":
      converted = "required";
      break;
    case "none":
      converted = "none";
      break;
    case "tool":
      converted = { type: "function", name: choice.name };
      break;
    default:
      throw new Error(`unsupported Claude tool_choice type ${JSON.stringify(type)}`);
  }
  const disableParallel = Boolean(choice.disable_parallel_tool_use ?? choice.disableParallelToolUse);
  const parallelToolCalls = disableParallel && type !== "none" ? false : undefined;
  return { toolChoice: converted, parallelToolCalls };
}

function claudeRequestReasoningIntent(
  body: Record<string, unknown>,
  opts: ConvertClaudeToResponsesOpts,
): ReasoningIntent {
  let intent = fromClaude(body);
  const sourceModel = opts.originModelName || String(body.model || "");
  const suffix = opts.suffixIntent;
  if (suffix && !intentIsEmpty(suffix)) {
    intent = mergeExplicitAndSuffix(intent, suffix, sourceModel);
  }
  return resolveClaudeDefault(sourceModel, intent);
}

/** Original ClaudeHelper system-prompt prepend before via-responses conversion. */
export function applyClaudeChannelSystemPrompt(
  body: Record<string, unknown>,
  systemPrompt: string | undefined,
  override: boolean | undefined,
): Record<string, unknown> {
  if (!systemPrompt) return body;
  const out = { ...body };
  if (out.system == null) {
    out.system = systemPrompt;
    return out;
  }
  if (!override) return out;
  if (typeof out.system === "string") {
    const existing = out.system.trim();
    out.system = existing === "" ? systemPrompt : `${systemPrompt}\n${existing}`;
    return out;
  }
  if (Array.isArray(out.system)) {
    out.system = [{ type: "text", text: systemPrompt }, ...out.system];
  }
  return out;
}

/** Original `claudemessages.ClaudeMessagesRequestToOpenAIResponses`. */
export function convertClaudeMessagesToOpenAIResponses(
  body: Record<string, unknown>,
  opts: ConvertClaudeToResponsesOpts = {},
): Record<string, unknown> {
  const settings = opts.settings || {};
  const origin = opts.originModelName || String(body.model || "");
  const upstream = opts.upstreamModelName || String(body.model || "");
  let suffixIntent = opts.suffixIntent;
  if (!suffixIntent) {
    const parsed = parseHostModelModifiers(origin !== upstream ? upstream : origin, settings);
    if (parsed.hasThinking) suffixIntent = parsed.intent;
  }
  const model = String(upstream || body.model || "").trim();
  if (!model) throw new Error("model is required");

  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const out: Record<string, unknown> = {
    model,
    input: claudeMessagesToResponsesInput(messages),
  };
  const instructions = claudeSystemToResponsesInstructions(body);
  if (instructions != null) out.instructions = instructions;
  if (body.metadata != null) out.metadata = body.metadata;
  if (body.service_tier) out.service_tier = body.service_tier;
  if (body.stream != null) out.stream = body.stream;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  const tools = claudeToolsToResponsesTools(body.tools);
  if (tools) out.tools = tools;
  const choice = claudeToolChoiceToResponses(body.tool_choice);
  if (choice.toolChoice != null) out.tool_choice = choice.toolChoice;
  if (choice.parallelToolCalls != null) out.parallel_tool_calls = choice.parallelToolCalls;
  if (!opts.openRouterDialect && origin.endsWith("-thinking") && !String(out.model).endsWith("-thinking")) {
    out.model = `${out.model}-thinking`;
  }
  if (body.max_tokens != null) out.max_output_tokens = Number(body.max_tokens);
  else if (body.max_tokens_to_sample != null) out.max_output_tokens = Number(body.max_tokens_to_sample);

  try {
    applyToOpenAIResponses(out, claudeRequestReasoningIntent(body, { ...opts, suffixIntent }));
  } catch (err) {
    throw asClientError(err);
  }
  return out;
}
