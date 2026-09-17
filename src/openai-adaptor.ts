/** Original `relay.GetAdaptor` → `openai.Adaptor` (APITypeOpenAI, OpenRouter, Xinference, unknown→OpenAI). */

import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";
import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_ALI,
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_AWS,
  CHANNEL_TYPE_AZURE,
  CHANNEL_TYPE_BAIDU,
  CHANNEL_TYPE_BAIDU_V2,
  CHANNEL_TYPE_CLOUDFLARE,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_COHERE,
  CHANNEL_TYPE_COZE,
  CHANNEL_TYPE_DEEPSEEK,
  CHANNEL_TYPE_DIFY,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_JIMENG,
  CHANNEL_TYPE_JINA,
  CHANNEL_TYPE_MINIMAX,
  CHANNEL_TYPE_MISTRAL,
  CHANNEL_TYPE_MOKA,
  CHANNEL_TYPE_MOONSHOT,
  CHANNEL_TYPE_NEW_API,
  CHANNEL_TYPE_OLLAMA,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_PALM,
  CHANNEL_TYPE_PERPLEXITY,
  CHANNEL_TYPE_REPLICATE,
  CHANNEL_TYPE_SILICONFLOW,
  CHANNEL_TYPE_SUB2API,
  CHANNEL_TYPE_SUBMODEL,
  CHANNEL_TYPE_TASK_PLUGIN,
  CHANNEL_TYPE_TENCENT,
  CHANNEL_TYPE_VERTEX,
  CHANNEL_TYPE_VOLC,
  CHANNEL_TYPE_XAI,
  CHANNEL_TYPE_XINFERENCE,
  CHANNEL_TYPE_XUNFEI,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_TYPE_ZHIPU_V4,
} from "./constants.js";

/**
 * Channel types whose `GetAdaptor` is `openai.Adaptor`
 * (`APITypeOpenAI` including Azure fallback, OpenRouter, Xinference, unknown types).
 * Native adaptors and task plugins must not take this path.
 */
export function usesOpenAIAdaptor(channelType: number): boolean {
  switch (channelType) {
    case CHANNEL_TYPE_ALI:
    case CHANNEL_TYPE_ANTHROPIC:
    case CHANNEL_TYPE_BAIDU:
    case CHANNEL_TYPE_PALM:
    case CHANNEL_TYPE_ZHIPU:
    case CHANNEL_TYPE_XUNFEI:
    case CHANNEL_TYPE_TENCENT:
    case CHANNEL_TYPE_GEMINI:
    case CHANNEL_TYPE_ZHIPU_V4:
    case CHANNEL_TYPE_OLLAMA:
    case CHANNEL_TYPE_PERPLEXITY:
    case CHANNEL_TYPE_AWS:
    case CHANNEL_TYPE_COHERE:
    case CHANNEL_TYPE_DIFY:
    case CHANNEL_TYPE_JINA:
    case CHANNEL_TYPE_CLOUDFLARE:
    case CHANNEL_TYPE_SILICONFLOW:
    case CHANNEL_TYPE_VERTEX:
    case CHANNEL_TYPE_MISTRAL:
    case CHANNEL_TYPE_DEEPSEEK:
    case CHANNEL_TYPE_MOKA:
    case CHANNEL_TYPE_VOLC:
    case CHANNEL_TYPE_BAIDU_V2:
    case CHANNEL_TYPE_XAI:
    case CHANNEL_TYPE_COZE:
    case CHANNEL_TYPE_JIMENG:
    case CHANNEL_TYPE_MOONSHOT:
    case CHANNEL_TYPE_SUBMODEL:
    case CHANNEL_TYPE_MINIMAX:
    case CHANNEL_TYPE_REPLICATE:
    case CHANNEL_TYPE_CODEX:
    case CHANNEL_TYPE_ADVANCED_CUSTOM:
    case CHANNEL_TYPE_SUB2API:
    case CHANNEL_TYPE_NEW_API:
    case CHANNEL_TYPE_TASK_PLUGIN:
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` paths that call `GetOpenAIError`
 * (`OpenaiHandler`, `OpenaiImageHandler`, `OaiResponsesHandler`). Audio /
 * realtime / rerank use other handlers (`RerankHandler` leftover unmarshal
 * is `usesRerankHandlerUnmarshal`).
 */
export function usesOpenaiHandlerGetOpenAIError(mode: string): boolean {
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
      return false;
    default:
      return true;
  }
}

/**
 * Original `common_handler.RerankHandler` (`openai.Adaptor` RelayModeRerank
 * including Xinference, and `jina.Adaptor` rerank). Ali / Siliconflow use
 * `usesAliSiliconflowRerankUnmarshal`. Cohere uses `usesCohereRerankUnmarshal`.
 */
export function usesRerankHandlerUnmarshal(channelType: number, mode: string): boolean {
  if (mode !== "rerank") return false;
  return usesOpenAIAdaptor(channelType) || channelType === CHANNEL_TYPE_JINA;
}

/** Original `common.Unmarshal` target type name for `RerankHandler`. */
export function rerankHandlerUnmarshalTypeName(channelType: number): string {
  if (channelType === CHANNEL_TYPE_XINFERENCE) return "xinference.XinRerankResponse";
  return "dto.RerankResponse";
}

/**
 * Original `common.Unmarshal` into `dto.RerankResponse` /
 * `xinference.XinRerankResponse`. Syntax errors match `encoding/json`. JSON
 * `null` succeeds as a zero-value struct. Non-object JSON is
 * `json: cannot unmarshal … into Go value of type …`. Extra-OK: nested
 * field type mismatches are left to convert (original fails).
 */
export function rerankHandlerResponseUnmarshalError(text: string, channelType: number): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${rerankHandlerUnmarshalTypeName(channelType)}`;
  }
  return null;
}

/**
 * Original `ali.RerankHandler` / `siliconflowRerankHandler` `json.Unmarshal`
 * (`NewOpenAIError` `ErrorCodeBadResponseBody`). Cohere uses `NewError`
 * (`usesCohereRerankUnmarshal`).
 */
export function usesAliSiliconflowRerankUnmarshal(channelType: number, mode: string): boolean {
  if (mode !== "rerank") return false;
  return channelType === CHANNEL_TYPE_ALI || channelType === CHANNEL_TYPE_SILICONFLOW;
}

/** Original `json.Unmarshal` target type name for Ali / Siliconflow rerank. */
export function aliSiliconflowRerankUnmarshalTypeName(channelType: number): string {
  if (channelType === CHANNEL_TYPE_SILICONFLOW) return "siliconflow.SFRerankResponse";
  return "ali.AliRerankResponse";
}

/**
 * Original `json.Unmarshal` into `ali.AliRerankResponse` /
 * `siliconflow.SFRerankResponse`. Syntax errors match `encoding/json`. JSON
 * `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails).
 */
export function aliSiliconflowRerankResponseUnmarshalError(text: string, channelType: number): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${aliSiliconflowRerankUnmarshalTypeName(channelType)}`;
  }
  return null;
}

/**
 * Original `cohere.cohereRerankHandler` `json.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, not `NewOpenAIError`).
 */
export function usesCohereRerankUnmarshal(channelType: number, mode: string): boolean {
  return mode === "rerank" && channelType === CHANNEL_TYPE_COHERE;
}

/** Original `json.Unmarshal` target type name for Cohere rerank. */
export function cohereRerankUnmarshalTypeName(): string {
  return "cohere.CohereRerankResponseResult";
}

/**
 * Original `json.Unmarshal` into `cohere.CohereRerankResponseResult`. Syntax
 * errors match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function cohereRerankResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${cohereRerankUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `cohere.cohereHandler` `json.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Stream uses
 * `cohereStreamHandler` (line-by-line continue, not leftover gin.H).
 */
export function usesCohereChatUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_COHERE) return false;
  return mode !== "rerank";
}

/** Original `json.Unmarshal` target type name for Cohere chat. */
export function cohereChatUnmarshalTypeName(): string {
  return "cohere.CohereResponseResult";
}

/**
 * Original `json.Unmarshal` into `cohere.CohereResponseResult`. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function cohereChatResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${cohereChatUnmarshalTypeName()}`;
  }
  return null;
}

/** Original `common.Unmarshal` target type name for `openai.Adaptor.DoResponse`. */
export function openaiHandlerUnmarshalTypeName(mode: string): string {
  if (mode === "images") return "dto.SimpleResponse";
  if (mode === "responses") return "dto.OpenAIResponsesResponse";
  return "dto.OpenAITextResponse";
}

/**
 * Original `common.Unmarshal` into `OpenAITextResponse` / `SimpleResponse` /
 * `OpenAIResponsesResponse`. Syntax errors match `encoding/json`. JSON `null`
 * succeeds as a zero-value struct. Non-object JSON is
 * `json: cannot unmarshal … into Go value of type dto.*`. Extra-OK: nested
 * field type mismatches are left to convert (original fails).
 */
export function openaiHandlerResponseUnmarshalError(text: string, mode: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${openaiHandlerUnmarshalTypeName(mode)}`;
  }
  return null;
}

/**
 * Native adaptors whose ConvertClaudeRequest / DoResponse delegate to `openai.Adaptor`.
 * ConvertGeminiRequest on these types is original `not implemented`.
 */
export function delegatesClaudeToOpenAIAdaptor(channelType: number): boolean {
  switch (channelType) {
    case CHANNEL_TYPE_SILICONFLOW:
    case CHANNEL_TYPE_PERPLEXITY:
    case CHANNEL_TYPE_BAIDU_V2:
      return true;
    default:
      return false;
  }
}

/**
 * Native adaptors whose ConvertClaudeRequest / DoResponse use `claude.Adaptor`.
 * ConvertGeminiRequest on these types is original `not implemented`.
 */
export function usesClaudeAdaptorForClaudeRequest(channelType: number): boolean {
  switch (channelType) {
    case CHANNEL_TYPE_MOONSHOT:
    case CHANNEL_TYPE_MINIMAX:
    case CHANNEL_TYPE_DEEPSEEK:
    case CHANNEL_TYPE_ZHIPU_V4:
      return true;
    default:
      return false;
  }
}

/** Original `constant.ForceStreamOption` (`FORCE_STREAM_OPTION`, default true). */
export const FORCE_STREAM_OPTION = true;

/**
 * Original TextHelper helpers: chat/completions/moderations (the default
 * `relayHandler` path). ResponsesHelper, ImageHelper, EmbeddingHelper,
 * AudioHelper, RerankHelper, AlphaSearchHelper, and GeminiHelper do not mutate
 * `stream_options` this way. Via-responses is still TextHelper, so it does.
 */
export function usesTextHelperStreamOptions(client: string, mode: string, viaResponses = false): boolean {
  if (client !== "openai") return false;
  if (viaResponses) return true;
  switch (mode) {
    case "responses":
    case "images":
    case "audio_speech":
    case "audio_transcription":
    case "audio_translation":
    case "rerank":
    case "embeddings":
    case "engines_embeddings":
    case "alpha_search":
    case "video":
    case "passthrough":
    case "realtime":
    case "gemini":
    case "models":
      return false;
    default:
      return true;
  }
}

/**
 * Original TextHelper StreamOptions mutation before ConvertOpenAIRequest /
 * via-responses. `request.Stream` is the JSON `stream` field (not Accept).
 */
export function applyTextHelperStreamOptions(
  body: Record<string, unknown>,
  channelType: number,
  forceStreamOption = FORCE_STREAM_OPTION,
): Record<string, unknown> {
  const out = { ...body };
  const isStream = out.stream === true;
  if (!openaiAdaptorSupportStreamOptions(channelType) || !isStream) {
    delete out.stream_options;
    return out;
  }
  if (forceStreamOption) out.stream_options = { include_usage: true };
  return out;
}

/** Original `streamSupportedChannels` used by ConvertClaudeRequest `info.SupportStreamOptions`. */
export function openaiAdaptorSupportStreamOptions(channelType: number): boolean {
  switch (channelType) {
    case CHANNEL_TYPE_OPENAI:
    case CHANNEL_TYPE_ANTHROPIC:
    case CHANNEL_TYPE_AWS:
    case CHANNEL_TYPE_GEMINI:
    case CHANNEL_TYPE_CLOUDFLARE:
    case CHANNEL_TYPE_AZURE:
    case CHANNEL_TYPE_VOLC:
    case CHANNEL_TYPE_OLLAMA:
    case CHANNEL_TYPE_XAI:
    case CHANNEL_TYPE_DEEPSEEK:
    case CHANNEL_TYPE_BAIDU_V2:
    case CHANNEL_TYPE_ZHIPU_V4:
    case CHANNEL_TYPE_ALI:
    case CHANNEL_TYPE_SUBMODEL:
    case CHANNEL_TYPE_CODEX:
    case CHANNEL_TYPE_MOONSHOT:
    case CHANNEL_TYPE_MINIMAX:
    case CHANNEL_TYPE_SILICONFLOW:
    case CHANNEL_TYPE_ADVANCED_CUSTOM:
    case CHANNEL_TYPE_SUB2API:
    case CHANNEL_TYPE_NEW_API:
    case CHANNEL_TYPE_TENCENT:
      return true;
    default:
      return false;
  }
}
