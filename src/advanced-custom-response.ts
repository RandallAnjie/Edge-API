/** Original `advancedcustom.Adaptor.DoResponse` converter dispatch. Does not import convert.ts. */

import {
  CONVERTER_CHAT_TO_CLAUDE,
  CONVERTER_CHAT_TO_GEMINI,
  CONVERTER_CHAT_TO_RESPONSES,
  CONVERTER_CLAUDE_TO_CHAT,
  CONVERTER_GEMINI_TO_CHAT,
  CONVERTER_NONE,
  CONVERTER_RESPONSES_TO_CHAT,
  CONVERTER_RESPONSES_TO_GEMINI,
} from "./advanced-custom-convert.js";
import { openaiFromAnthropicResponse } from "./claude-response.js";
import { openaiFromGeminiResponse } from "./gemini-response.js";
import { isGeminiEmbeddingModel, openaiFromGeminiEmbedding } from "./gemini-convert.js";
import { openaiFromImagenResponse } from "./vertex-convert.js";
import {
  chatCompletionToResponsesResponse,
  claudeResponseToResponsesResponse,
  geminiResponseToResponsesResponse,
  responsesResponseToChatCompletion,
} from "./responses-convert.js";

export type AdvancedCustomClientFormat = "openai" | "anthropic" | "gemini";

export type AdvancedCustomInboundOpts = {
  requestId?: string;
  created?: number;
  fallbackPromptTokens?: number;
  relayMode?: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function responseId(opts: AdvancedCustomInboundOpts, fallback: string): string {
  if (opts.requestId) return opts.requestId;
  return fallback;
}

function chatCompletionId(opts: AdvancedCustomInboundOpts, fallback: string): string {
  if (opts.requestId) return `chatcmpl-${opts.requestId}`;
  return fallback;
}

/** Original `fmt.Errorf("unsupported advanced custom converter: %s", a.converter)` — unquoted `%s`. */
export function unsupportedAdvancedCustomConverter(converter: string): Error {
  return new Error(`unsupported advanced custom converter: ${converter}`);
}

function claudeAdaptorDoResponse(
  client: AdvancedCustomClientFormat,
  relayMode: string | undefined,
  upstreamJson: Record<string, unknown>,
  model: string,
  opts: AdvancedCustomInboundOpts,
): Record<string, unknown> {
  if (client === "anthropic") return upstreamJson;
  if (client === "openai" && relayMode === "responses") {
    return claudeResponseToResponsesResponse(upstreamJson, model, { id: responseId(opts, str(upstreamJson.id)) });
  }
  return openaiFromAnthropicResponse(upstreamJson, model);
}

function geminiAdaptorDoResponse(
  client: AdvancedCustomClientFormat,
  relayMode: string | undefined,
  upstreamJson: Record<string, unknown>,
  model: string,
  opts: AdvancedCustomInboundOpts,
): Record<string, unknown> {
  if (relayMode === "responses") {
    return geminiResponseToResponsesResponse(upstreamJson, model, {
      id: responseId(opts, ""),
      created: opts.created,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if (client === "gemini") return upstreamJson;
  // Original chat-to-Gemini DoResponse uses GeminiImageHandler for imagen prefixes
  // (hop 470 empty predictions leftover NewOpenAIError gin.H). Extra-OK: hop 465
  // `/v1/responses` stays GeminiResponsesHandler above. Extra-OK: hop 460 native
  // RelayModeGemini `:predict` copies via client === "gemini".
  if (model.startsWith("imagen")) {
    return openaiFromImagenResponse(upstreamJson, { created: opts.created });
  }
  // Original chat-to-Gemini DoResponse uses GeminiEmbeddingHandler for
  // embedding-model prefixes (hop 468 OpenAI embedding JSON; hop 471 even when
  // the client streams). Extra-OK: hop 458 `/v1/responses` stays
  // GeminiResponsesHandler above. Extra-OK: hop 463 Vertex RequestModeGemini
  // stays GeminiChatHandler (not this adaptor).
  if (isGeminiEmbeddingModel(model)) {
    return openaiFromGeminiEmbedding(upstreamJson, model, {
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  return openaiFromGeminiResponse(upstreamJson, model, {
    id: chatCompletionId(opts, ""),
    created: opts.created,
    upstreamModel: model,
    fallbackPromptTokens: opts.fallbackPromptTokens,
  });
}

function responsesToClient(
  client: AdvancedCustomClientFormat,
  relayMode: string | undefined,
  upstreamJson: Record<string, unknown>,
  model: string,
  opts: AdvancedCustomInboundOpts,
): Record<string, unknown> {
  if (client === "openai" && relayMode === "responses") return upstreamJson;
  const id = chatCompletionId(opts, str(upstreamJson.id));
  const chat = responsesResponseToChatCompletion(upstreamJson, id || str(upstreamJson.id));
  if (!chat.model && model) chat.model = model;
  return chat;
}

/** Original `advancedcustom.Adaptor.DoResponse` + `doNativeResponse`. */
export function convertAdvancedCustomInbound(
  converter: string,
  client: AdvancedCustomClientFormat,
  upstreamJson: Record<string, unknown>,
  model: string,
  opts: AdvancedCustomInboundOpts = {},
): Record<string, unknown> {
  const id = String(converter || CONVERTER_NONE).trim() || CONVERTER_NONE;
  const relayMode = opts.relayMode;
  switch (id) {
    case CONVERTER_NONE:
      return upstreamJson;
    case CONVERTER_CLAUDE_TO_CHAT:
    case CONVERTER_GEMINI_TO_CHAT:
      return upstreamJson;
    case CONVERTER_CHAT_TO_CLAUDE:
      return claudeAdaptorDoResponse(client, relayMode, upstreamJson, model, opts);
    case CONVERTER_CHAT_TO_GEMINI:
      return geminiAdaptorDoResponse(client, relayMode, upstreamJson, model, opts);
    case CONVERTER_RESPONSES_TO_GEMINI:
      return geminiAdaptorDoResponse(client, relayMode, upstreamJson, model, opts);
    case CONVERTER_CHAT_TO_RESPONSES:
      return responsesToClient(client, relayMode, upstreamJson, model, opts);
    case CONVERTER_RESPONSES_TO_CHAT:
      return chatCompletionToResponsesResponse(upstreamJson, responseId(opts, str(upstreamJson.id)));
    default:
      throw unsupportedAdvancedCustomConverter(id);
  }
}

/** Original openai adaptor DoResponse for `none` / Claude→chat / Gemini→chat converters. */
export function advancedCustomOpenaiShapedInbound(converter: string): boolean {
  const id = String(converter || CONVERTER_NONE).trim() || CONVERTER_NONE;
  return id === CONVERTER_NONE || id === CONVERTER_CLAUDE_TO_CHAT || id === CONVERTER_GEMINI_TO_CHAT;
}
