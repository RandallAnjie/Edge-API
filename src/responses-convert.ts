/** Original `relaykit/relayconvert` Chat Completions ↔ Responses + Gemini/Claude→Responses JSON. */

import { openaiFromAnthropicResponse } from "./claude-response.js";
import { groundingWebSearchQueries, openaiFromGeminiResponse } from "./gemini-response.js";
import { attachOpenAIHostedResponse, extractClaudeHostedResponse } from "./hosted-response.js";
import {
  asInt,
  asObj,
  compactUuid,
  emptyOpenAIUsage,
  openAIUsageToJson,
  type OpenAIUsage,
} from "./openai-usage.js";

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asArr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const o = asObj(part);
        if (o.type === "text" || o.type === "output_text" || o.type === "input_text" || o.type == null) {
          return str(o.text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

function reasoningFromMessage(message: Record<string, unknown>): string {
  if (typeof message.reasoning_content === "string" && message.reasoning_content) return message.reasoning_content;
  if (typeof message.reasoning === "string" && message.reasoning) return message.reasoning;
  return "";
}

function chatCreatedAt(created: unknown): number {
  if (typeof created === "number" && Number.isFinite(created)) return Math.trunc(created);
  if (typeof created === "string" && created) {
    const n = Number(created);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return Math.floor(Date.now() / 1000);
}

function hasOpenAIUsageTokens(src: Record<string, unknown>): boolean {
  if (
    asInt(src.prompt_tokens) ||
    asInt(src.completion_tokens) ||
    asInt(src.total_tokens) ||
    asInt(src.input_tokens) ||
    asInt(src.output_tokens) ||
    asInt(src.prompt_cache_hit_tokens) ||
    asInt(src.claude_cache_creation_5_m_tokens) ||
    asInt(src.claude_cache_creation_1_h_tokens)
  ) {
    return true;
  }
  const promptDetails = asObj(src.prompt_tokens_details);
  const completionDetails = asObj(src.completion_tokens_details);
  return Boolean(
    asInt(promptDetails.cached_tokens) ||
      asInt(promptDetails.cached_creation_tokens) ||
      asInt(promptDetails.cache_write_tokens) ||
      asInt(promptDetails.text_tokens) ||
      asInt(promptDetails.audio_tokens) ||
      asInt(promptDetails.image_tokens) ||
      asInt(completionDetails.reasoning_tokens) ||
      asInt(completionDetails.text_tokens) ||
      asInt(completionDetails.audio_tokens) ||
      asInt(completionDetails.image_tokens),
  );
}

function newOpenAIChatBillingUsage(src: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!hasOpenAIUsageTokens(src)) return undefined;
  const snapshot = emptyOpenAIUsage();
  snapshot.prompt_tokens = asInt(src.prompt_tokens);
  snapshot.completion_tokens = asInt(src.completion_tokens);
  snapshot.total_tokens = asInt(src.total_tokens);
  snapshot.input_tokens = asInt(src.input_tokens);
  snapshot.output_tokens = asInt(src.output_tokens);
  snapshot.claude_cache_creation_5_m_tokens = asInt(src.claude_cache_creation_5_m_tokens);
  snapshot.claude_cache_creation_1_h_tokens = asInt(src.claude_cache_creation_1_h_tokens);
  const details = asObj(src.prompt_tokens_details);
  snapshot.prompt_tokens_details.cached_tokens = asInt(details.cached_tokens);
  snapshot.prompt_tokens_details.text_tokens = asInt(details.text_tokens);
  snapshot.prompt_tokens_details.audio_tokens = asInt(details.audio_tokens);
  snapshot.prompt_tokens_details.image_tokens = asInt(details.image_tokens);
  if (asInt(details.cached_creation_tokens)) snapshot.prompt_tokens_details.cached_creation_tokens = asInt(details.cached_creation_tokens);
  if (asInt(details.cache_write_tokens)) snapshot.prompt_tokens_details.cache_write_tokens = asInt(details.cache_write_tokens);
  const completionDetails = asObj(src.completion_tokens_details);
  snapshot.completion_tokens_details.reasoning_tokens = asInt(completionDetails.reasoning_tokens);
  snapshot.completion_tokens_details.text_tokens = asInt(completionDetails.text_tokens);
  snapshot.completion_tokens_details.audio_tokens = asInt(completionDetails.audio_tokens);
  snapshot.completion_tokens_details.image_tokens = asInt(completionDetails.image_tokens);
  if (src.input_tokens_details == null) snapshot.input_tokens_details = null;
  else snapshot.input_tokens_details = asObj(src.input_tokens_details) as OpenAIUsage["input_tokens_details"];
  return { source: "oai_chat", semantic: "openai", openai_usage: openAIUsageToJson(snapshot) };
}

function copyInputDetails(src: Record<string, unknown>): OpenAIUsage["input_tokens_details"] {
  const details: NonNullable<OpenAIUsage["input_tokens_details"]> = {
    cached_tokens: asInt(src.cached_tokens),
    text_tokens: asInt(src.text_tokens),
    audio_tokens: asInt(src.audio_tokens),
    image_tokens: asInt(src.image_tokens),
  };
  if (asInt(src.cached_creation_tokens)) details.cached_creation_tokens = asInt(src.cached_creation_tokens);
  if (asInt(src.cache_write_tokens)) details.cache_write_tokens = asInt(src.cache_write_tokens);
  return details;
}

/** Original `oaichat.UsageFromChatUsage`. */
export function usageFromChatUsage(src: Record<string, unknown> | null | undefined): OpenAIUsage {
  const usage = emptyOpenAIUsage();
  if (!src) return usage;
  if (typeof src.usage_semantic === "string" && src.usage_semantic) usage.usage_semantic = src.usage_semantic;
  if (typeof src.usage_source === "string" && src.usage_source) usage.usage_source = src.usage_source;
  if (src.billing_usage && typeof src.billing_usage === "object") usage.billing_usage = asObj(src.billing_usage);
  else usage.billing_usage = newOpenAIChatBillingUsage(src);
  const prompt = asInt(src.prompt_tokens);
  const completion = asInt(src.completion_tokens);
  if (prompt) {
    usage.prompt_tokens = prompt;
    usage.input_tokens = prompt;
  }
  if (completion) {
    usage.completion_tokens = completion;
    usage.output_tokens = completion;
  }
  const total = asInt(src.total_tokens);
  usage.total_tokens = total || usage.input_tokens + usage.output_tokens;
  const promptDetails = asObj(src.prompt_tokens_details);
  if (
    asInt(promptDetails.cached_tokens) ||
    asInt(promptDetails.image_tokens) ||
    asInt(promptDetails.audio_tokens) ||
    asInt(promptDetails.cached_creation_tokens) ||
    asInt(promptDetails.cache_write_tokens) ||
    asInt(promptDetails.text_tokens)
  ) {
    usage.input_tokens_details = copyInputDetails(promptDetails);
  }
  const completionDetails = asObj(src.completion_tokens_details);
  if (
    asInt(completionDetails.reasoning_tokens) ||
    asInt(completionDetails.text_tokens) ||
    asInt(completionDetails.audio_tokens) ||
    asInt(completionDetails.image_tokens)
  ) {
    usage.completion_tokens_details.reasoning_tokens = asInt(completionDetails.reasoning_tokens);
    usage.completion_tokens_details.text_tokens = asInt(completionDetails.text_tokens);
    usage.completion_tokens_details.audio_tokens = asInt(completionDetails.audio_tokens);
    usage.completion_tokens_details.image_tokens = asInt(completionDetails.image_tokens);
  }
  usage.claude_cache_creation_5_m_tokens = asInt(src.claude_cache_creation_5_m_tokens);
  usage.claude_cache_creation_1_h_tokens = asInt(src.claude_cache_creation_1_h_tokens);
  return usage;
}

/** Original `oairesponses.UsageFromResponsesUsage`. */
export function usageFromResponsesUsage(src: Record<string, unknown> | null | undefined): OpenAIUsage {
  const usage = emptyOpenAIUsage();
  if (!src) return usage;
  const input = asInt(src.input_tokens);
  const output = asInt(src.output_tokens);
  if (input) {
    usage.prompt_tokens = input;
    usage.input_tokens = input;
  }
  if (output) {
    usage.completion_tokens = output;
    usage.output_tokens = output;
  }
  const total = asInt(src.total_tokens);
  usage.total_tokens = total || usage.prompt_tokens + usage.completion_tokens;
  const inputDetails = asObj(src.input_tokens_details);
  if (Object.keys(inputDetails).length) {
    usage.prompt_tokens_details.cached_tokens = asInt(inputDetails.cached_tokens);
    usage.prompt_tokens_details.text_tokens = asInt(inputDetails.text_tokens);
    usage.prompt_tokens_details.audio_tokens = asInt(inputDetails.audio_tokens);
    usage.prompt_tokens_details.image_tokens = asInt(inputDetails.image_tokens);
    if (asInt(inputDetails.cached_creation_tokens)) {
      usage.prompt_tokens_details.cached_creation_tokens = asInt(inputDetails.cached_creation_tokens);
    }
    if (asInt(inputDetails.cache_write_tokens)) {
      usage.prompt_tokens_details.cache_write_tokens = asInt(inputDetails.cache_write_tokens);
    }
  }
  const completionDetails = asObj(src.completion_tokens_details);
  if (
    asInt(completionDetails.reasoning_tokens) ||
    asInt(completionDetails.text_tokens) ||
    asInt(completionDetails.audio_tokens) ||
    asInt(completionDetails.image_tokens)
  ) {
    usage.completion_tokens_details.reasoning_tokens = asInt(completionDetails.reasoning_tokens);
    usage.completion_tokens_details.text_tokens = asInt(completionDetails.text_tokens);
    usage.completion_tokens_details.audio_tokens = asInt(completionDetails.audio_tokens);
    usage.completion_tokens_details.image_tokens = asInt(completionDetails.image_tokens);
  }
  if (src.billing_usage && typeof src.billing_usage === "object") usage.billing_usage = asObj(src.billing_usage);
  usage.claude_cache_creation_5_m_tokens = asInt(src.claude_cache_creation_5_m_tokens);
  usage.claude_cache_creation_1_h_tokens = asInt(src.claude_cache_creation_1_h_tokens);
  return usage;
}

/** Original `oaichat.ResponsesStatusFromChatFinishReason`. */
export function responsesStatusFromChatFinishReason(finishReason: string): {
  status: string;
  incomplete_details?: { reason: string };
} {
  switch (String(finishReason || "").trim()) {
    case "length":
      return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    case "content_filter":
      return { status: "incomplete", incomplete_details: { reason: "content_filter" } };
    default:
      return { status: "completed" };
  }
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

function outputStatus(status: string): string {
  return status === "incomplete" ? "incomplete" : "completed";
}

/** Original `oaichat.ChatCompletionsResponseToResponsesResponse` + `dto.OpenAIResponsesResponse` JSON. */
export function chatCompletionToResponsesResponse(
  resp: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const usage = usageFromChatUsage(asObj(resp.usage));
  const out: Record<string, unknown> = {
    id,
    object: "response",
    created_at: chatCreatedAt(resp.created),
    status: "completed",
    instructions: null,
    max_output_tokens: 0,
    model: str(resp.model),
    output: [] as Record<string, unknown>[],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: 0,
    tool_choice: null,
    tools: null,
    top_p: 0,
    truncation: null,
    usage: openAIUsageToJson(usage),
    user: null,
    metadata: null,
  };
  const choices = asArr(resp.choices);
  if (!choices.length) return out;
  const choice = choices[0];
  const message = asObj(choice.message);
  const mapped = responsesStatusFromChatFinishReason(str(choice.finish_reason));
  out.status = mapped.status;
  if (mapped.incomplete_details) out.incomplete_details = mapped.incomplete_details;
  const status = outputStatus(mapped.status);
  const reasoning = reasoningFromMessage(message);
  const output = out.output as Record<string, unknown>[];
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: `${id}_reasoning_0`,
      status,
      role: "",
      content: null,
      quality: "",
      size: "",
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }
  const text = stringContent(message.content);
  if (text) {
    output.push({
      type: "message",
      id: `${id}_msg_0`,
      status,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: chatAnnotationsToResponses(message.annotations) }],
      quality: "",
      size: "",
    });
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  toolCalls.forEach((item, index) => {
    const tc = asObj(item);
    const fn = asObj(tc.function);
    let callId = str(tc.id).trim();
    if (!callId) callId = `${id}_call_${index}`;
    const name = str(fn.name);
    const args = typeof fn.arguments === "string" ? fn.arguments : fn.arguments != null ? JSON.stringify(fn.arguments) : "";
    const type = str(tc.type) || "function";
    if (type === "" || type === "function") {
      output.push({
        type: "function_call",
        id: callId,
        status,
        role: "",
        content: null,
        quality: "",
        size: "",
        call_id: callId,
        name,
        arguments: args,
      });
      return;
    }
    output.push({
      type,
      id: callId,
      status,
      role: "",
      content: null,
      quality: "",
      size: "",
      call_id: callId,
      arguments: tc.custom,
    });
  });
  return out;
}

function appendSeparatedText(parts: string[], text: string): void {
  if (!text) return;
  if (!parts.length) {
    parts.push(text);
    return;
  }
  const current = parts[parts.length - 1];
  let trailing = 0;
  for (let i = current.length - 1; i >= 0 && trailing < 2 && current[i] === "\n"; i--) trailing += 1;
  let leading = 0;
  while (leading < text.length && leading < 2 && text[leading] === "\n") leading += 1;
  const missing = 2 - trailing - leading;
  const pad = missing > 0 ? "\n".repeat(missing) : "";
  parts[parts.length - 1] = current + pad + text;
}

/** Original `oairesponses.ExtractOutputTextFromResponses`. */
export function extractOutputTextFromResponses(resp: Record<string, unknown>): string {
  const output = asArr(resp.output);
  if (!output.length) return "";
  const preferred: string[] = [];
  for (const item of output) {
    if (str(item.type) !== "message") continue;
    if (item.role && str(item.role) !== "assistant") continue;
    let text = "";
    for (const part of asArr(item.content)) {
      if (str(part.type) === "output_text" && str(part.text)) text += str(part.text);
    }
    appendSeparatedText(preferred, text);
  }
  if (preferred.length) return preferred.join("");
  const fallback: string[] = [];
  for (const item of output) {
    let text = "";
    for (const part of asArr(item.content)) {
      if (str(part.text)) text += str(part.text);
    }
    appendSeparatedText(fallback, text);
  }
  return fallback.join("");
}

/** Original `oairesponses.ExtractReasoningTextFromResponses`. */
export function extractReasoningTextFromResponses(resp: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of asArr(resp.output)) {
    if (str(item.type) !== "reasoning") continue;
    const content = asArr(item.content);
    const hasContentText = content.some((part) => str(part.text));
    if (hasContentText) {
      const texts: string[] = [];
      for (const part of content) appendSeparatedText(texts, str(part.text));
      appendSeparatedText(parts, texts.join(""));
      continue;
    }
    const summary: string[] = [];
    for (const part of asArr(item.summary)) appendSeparatedText(summary, str(part.text));
    appendSeparatedText(parts, summary.join(""));
  }
  return parts.join("");
}

/** Original `oairesponses.ResponsesFinishReasonFromStatus`. */
export function responsesFinishReasonFromStatus(resp: Record<string, unknown>): string | undefined {
  const status = str(resp.status).trim();
  if (status !== "incomplete") return undefined;
  const reason = str(asObj(resp.incomplete_details).reason).trim();
  if (reason === "content_filter") return "content_filter";
  return "length";
}

function responsesArgumentsString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

/** Original `oairesponses.ResponsesResponseToChatCompletionsResponse`. */
export function responsesResponseToChatCompletion(
  resp: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const text = extractOutputTextFromResponses(resp);
  const reasoning = extractReasoningTextFromResponses(resp);
  const usage = usageFromResponsesUsage(asObj(resp.usage));
  const toolCalls: Record<string, unknown>[] = [];
  for (const item of asArr(resp.output)) {
    const type = str(item.type);
    if (type !== "function_call" && type !== "custom_tool_call") continue;
    const name = str(item.name).trim();
    if (!name) continue;
    let callId = str(item.call_id).trim();
    if (!callId) callId = str(item.id).trim();
    toolCalls.push({
      id: callId,
      type: "function",
      function: { name, arguments: responsesArgumentsString(item.arguments) },
    });
  }
  let finishReason = "stop";
  const mapped = responsesFinishReasonFromStatus(resp);
  if (mapped) finishReason = mapped;
  else if (toolCalls.length) finishReason = "tool_calls";
  const message: Record<string, unknown> = { role: "assistant", content: text };
  const annotations: Record<string, unknown>[] = [];
  for (const item of asArr(resp.output)) {
    if (str(item.type) !== "message") continue;
    for (const part of asArr(item.content)) {
      const raw = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of raw) annotations.push(responseAnnotationToChat(annotation));
    }
  }
  if (annotations.length) message.annotations = annotations;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created: asInt(resp.created_at) || chatCreatedAt(resp.created),
    model: str(resp.model),
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: openAIUsageToJson(usage),
  };
}

/** Original Claude ConvertResponse: ExtractHosted + Claude→Chat→Responses + AttachHosted. */
export function claudeResponseToResponsesResponse(
  upstream: Record<string, unknown>,
  model = "",
  opts: { id?: string } = {},
): Record<string, unknown> {
  const { remaining, hosted } = extractClaudeHostedResponse(upstream);
  const chat = openaiFromAnthropicResponse(remaining, model);
  const converted = chatCompletionToResponsesResponse(chat, opts.id || str(chat.id) || "");
  return attachOpenAIHostedResponse(converted, hosted);
}

/** Original GeminiResponsesHandler: Gemini chat JSON → OpenAI Responses via Gemini→Chat then Chat→Responses. */
export function geminiResponseToResponsesResponse(
  upstream: Record<string, unknown>,
  model: string,
  opts: { id?: string; created?: number; fallbackPromptTokens?: number } = {},
): Record<string, unknown> {
  const chat = openaiFromGeminiResponse(upstream, model, {
    id: opts.id,
    created: opts.created,
    upstreamModel: model,
    fallbackPromptTokens: opts.fallbackPromptTokens,
  });
  const converted = chatCompletionToResponsesResponse(chat, str(chat.id) || opts.id || "");
  converted.model = model;
  converted.usage = openAIUsageToJson(usageFromChatUsage(asObj(chat.usage)));
  const queries = groundingWebSearchQueries(upstream);
  if (queries.length) {
    const output = asArr(converted.output);
    output.push({
      type: "web_search_call",
      id: `ws_${compactUuid()}`,
      status: "completed",
      action: { type: "search", queries },
    });
    converted.output = output;
  }
  return converted;
}
