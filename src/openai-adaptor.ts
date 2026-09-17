/** Original `relay.GetAdaptor` → `openai.Adaptor` (APITypeOpenAI, OpenRouter, Xinference, unknown→OpenAI). */

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
 * realtime / rerank use other handlers.
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
