/** Original composed `claude_messages_to_gemini_generate_content` / `gemini_generate_content_to_claude_messages`. */

import { convertClaudeMessagesToOpenAIChat, convertGeminiContentToOpenAIChat } from "./advanced-custom-convert.js";
import { convertOpenAIChatToClaude, type ConvertClaudeOpts } from "./claude-convert.js";
import { openaiFromAnthropicResponse, claudeSseToOpenAIChat } from "./claude-response.js";
import { convertOpenAIChatToGemini, type ConvertGeminiOpts } from "./gemini-convert.js";
import { openaiFromGeminiResponse, geminiSseToOpenAIChat, type GeminiToOpenAIOpts } from "./gemini-response.js";
import { openaiChatToClaudeResponse, openaiChatToGeminiResponse } from "./openai-format-convert.js";
import { oaiChatSseToClaudeSse, oaiChatSseToGeminiSse } from "./openai-stream-convert.js";

/** Original `requestConverterClaudeToGemini`. Not an advanced-custom ConvertClaudeRequest ID. */
export const CONVERTER_CLAUDE_TO_GEMINI = "claude_messages_to_gemini_generate_content";
/** Original `requestConverterGeminiToClaude`. Not an advanced-custom ConvertGeminiRequest ID. */
export const CONVERTER_GEMINI_TO_CLAUDE = "gemini_generate_content_to_claude_messages";

export type ConvertClaudeGeminiOpts = ConvertGeminiOpts & ConvertClaudeOpts & {
  isStream?: boolean;
};

/** Original Gemini `ConvertClaudeRequest` via `service.ConvertRequest(..., RelayFormatGemini)`. */
export function convertClaudeMessagesToGeminiGenerateContent(
  body: Record<string, unknown>,
  opts: ConvertClaudeGeminiOpts = {},
): Record<string, unknown> {
  const chat = convertClaudeMessagesToOpenAIChat(body, opts.upstreamModelName || String(body.model || ""), {
    originModelName: opts.originModelName,
    settings: opts.settings,
    suffixIntent: opts.suffixIntent,
  });
  return convertOpenAIChatToGemini(chat, opts);
}

/** Original Claude `ConvertGeminiRequest` via `service.ConvertRequest(..., RelayFormatClaude)`. */
export function convertGeminiGenerateContentToClaudeMessages(
  body: Record<string, unknown> | null | undefined,
  opts: ConvertClaudeGeminiOpts = {},
): Record<string, unknown> {
  if (body == null) throw new Error("request is nil");
  const chat = convertGeminiContentToOpenAIChat(body, opts.upstreamModelName || "", Boolean(opts.isStream), {
    originModelName: opts.originModelName,
    settings: opts.settings,
    suffixIntent: opts.suffixIntent,
  });
  return convertOpenAIChatToClaude(chat, opts);
}

/** Original Gemini `DoResponse` Claude path: Gemini JSON → OpenAI chat → Claude messages. */
export function geminiResponseToClaudeMessages(
  upstream: Record<string, unknown>,
  model: string,
  opts: GeminiToOpenAIOpts = {},
): Record<string, unknown> {
  const chat = openaiFromGeminiResponse(upstream, model, opts);
  return openaiChatToClaudeResponse(chat);
}

/** Original Claude `DoResponse` Gemini path: Claude JSON → OpenAI chat → Gemini chat. */
export function claudeResponseToGeminiChat(upstream: Record<string, unknown>, model = ""): Record<string, unknown> {
  const chat = openaiFromAnthropicResponse(upstream, model);
  return openaiChatToGeminiResponse(chat);
}

/** Original Gemini `GeminiChatStreamHandler` + `RelayFormatClaude`. */
export function geminiSseToClaudeSse(
  text: string,
  opts: { estimatePromptTokens?: number; id?: string; created?: number; upstreamModel?: string } = {},
): { sse: string; usageBody: Record<string, unknown> } {
  const chat = geminiSseToOpenAIChat(text, {
    id: opts.id,
    created: opts.created,
    upstreamModel: opts.upstreamModel,
    fallbackPromptTokens: opts.estimatePromptTokens,
  });
  return oaiChatSseToClaudeSse(chat.body, { estimatePromptTokens: opts.estimatePromptTokens });
}

/** Original Claude stream `RelayFormatGemini` (`NewResponseStreamState(Claude → Gemini)`). */
export function claudeSseToGeminiSse(
  text: string,
  opts: { estimatePromptTokens?: number; includeUsage?: boolean; upstreamModel?: string; created?: number } = {},
): { sse: string; usageBody: Record<string, unknown> } {
  const chat = claudeSseToOpenAIChat(text, {
    includeUsage: opts.includeUsage ?? true,
    upstreamModel: opts.upstreamModel,
    created: opts.created,
  });
  return oaiChatSseToGeminiSse(chat.body, { estimatePromptTokens: opts.estimatePromptTokens });
}
