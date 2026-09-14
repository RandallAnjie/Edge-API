/** Original `oaichat.ResponseOpenAI2Claude` / `ResponseOpenAI2Gemini`. Does not import convert.ts or upstream.ts. */

import { openaiFinishReasonToClaudeStopReason } from "./claude-response.js";
import { asInt, asObj } from "./openai-usage.js";

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    const part = asObj(item);
    if (str(part.type) === "text" && typeof part.text === "string") out += part.text;
  }
  return out;
}

function reasoningContent(message: Record<string, unknown>): string {
  if (typeof message.reasoning_content === "string") return message.reasoning_content;
  if (typeof message.reasoning === "string") return message.reasoning;
  return "";
}

function toolCallsOf(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
}

function parseToolInput(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
  if (!text || text === "null") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* original Unmarshal failure → {} */
  }
  return {};
}

function geminiFunctionArguments(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
  if (!text || text === "null") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* preserve historically accepted malformed input */
  }
  return { arguments: typeof raw === "string" ? raw : text };
}

function claudeUsageFromOpenAI(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const details = asObj(usage.prompt_tokens_details);
  const cached = asInt(details.cached_tokens);
  const cacheCreation = asInt(details.cached_creation_tokens) || asInt(details.cache_write_tokens);
  const prompt = asInt(usage.prompt_tokens);
  let input = prompt - cached - cacheCreation;
  if (input < 0) input = 0;
  const out: Record<string, unknown> = {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cached,
    output_tokens: asInt(usage.completion_tokens),
    claude_cache_creation_5_m_tokens: asInt(usage.claude_cache_creation_5_m_tokens),
    claude_cache_creation_1_h_tokens: asInt(usage.claude_cache_creation_1_h_tokens),
  };
  if (prompt || asInt(usage.completion_tokens) || asInt(usage.total_tokens)) {
    out.billing_usage = {
      source: "oai_chat",
      semantic: "openai",
      openai_usage: {
        prompt_tokens: prompt,
        completion_tokens: asInt(usage.completion_tokens),
        total_tokens: asInt(usage.total_tokens) || prompt + asInt(usage.completion_tokens),
      },
    };
  }
  return out;
}

function geminiFinishReason(finishReason: string): string {
  switch (finishReason) {
    case "stop":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    case "tool_calls":
      return "STOP";
    default:
      return "STOP";
  }
}

/** Original `oaichat.ResponseOpenAI2Claude`. */
export function openaiChatToClaudeResponse(openAI: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(openAI.choices) ? (openAI.choices as Record<string, unknown>[]) : [];
  const content: Record<string, unknown>[] = [];
  let stopReason = "";
  for (const choice of choices) {
    const message = asObj(choice.message);
    stopReason = openaiFinishReasonToClaudeStopReason(str(choice.finish_reason));
    const thinking = reasoningContent(message);
    const text = messageText(message.content);
    const tools = toolCallsOf(message);
    if (thinking) content.push({ type: "thinking", thinking });
    if (text !== "" || (!thinking && tools.length === 0)) {
      content.push({ type: "text", text });
    }
    for (const tool of tools) {
      const fn = asObj(tool.function);
      content.push({
        type: "tool_use",
        id: tool.id,
        name: fn.name,
        input: parseToolInput(fn.arguments),
      });
    }
  }
  const usage = claudeUsageFromOpenAI(openAI.usage ? asObj(openAI.usage) : undefined);
  const out: Record<string, unknown> = {
    id: openAI.id,
    type: "message",
    role: "assistant",
    model: openAI.model,
    content,
    stop_reason: stopReason,
  };
  if (usage) out.usage = usage;
  return out;
}

/** Original `oaichat.ResponseOpenAI2Gemini`. */
export function openaiChatToGeminiResponse(openAI: Record<string, unknown>): Record<string, unknown> {
  const usage = asObj(openAI.usage);
  const prompt = asInt(usage.prompt_tokens);
  const completion = asInt(usage.completion_tokens);
  const total = asInt(usage.total_tokens) || prompt + completion;
  const choices = Array.isArray(openAI.choices) ? (openAI.choices as Record<string, unknown>[]) : [];
  const candidates: Record<string, unknown>[] = [];
  for (const choice of choices) {
    const message = asObj(choice.message);
    const parts: Record<string, unknown>[] = [];
    const text = messageText(message.content);
    if (text) parts.push({ text });
    for (const tool of toolCallsOf(message)) {
      const fn = asObj(tool.function);
      parts.push({
        functionCall: {
          id: tool.id,
          name: fn.name,
          args: geminiFunctionArguments(fn.arguments),
        },
      });
    }
    candidates.push({
      index: Number(choice.index || 0),
      finishReason: geminiFinishReason(str(choice.finish_reason)),
      safetyRatings: [],
      content: { role: "model", parts },
    });
  }
  return {
    candidates,
    usageMetadata: {
      promptTokenCount: prompt,
      toolUsePromptTokenCount: 0,
      candidatesTokenCount: completion,
      totalTokenCount: total,
      thoughtsTokenCount: 0,
      cachedContentTokenCount: 0,
    },
  };
}
