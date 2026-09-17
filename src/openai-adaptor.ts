/** Original `relay.GetAdaptor` → `openai.Adaptor` (APITypeOpenAI, OpenRouter, Xinference, unknown→OpenAI). */

import { advancedCustomOpenaiShapedInbound } from "./advanced-custom-response.js";
import { geminiChatResponseUnmarshalError, geminiChatStreamSseUnmarshalError } from "./gemini-response.js";
import { CONVERTER_CHAT_TO_CLAUDE, CONVERTER_CHAT_TO_GEMINI, CONVERTER_CHAT_TO_RESPONSES, CONVERTER_NONE, CONVERTER_RESPONSES_TO_CHAT, CONVERTER_RESPONSES_TO_GEMINI } from "./advanced-custom-convert.js";
import { isNovaModel } from "./aws-convert.js";
import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";
import { supportsAliAnthropicMessages } from "./ali-convert.js";
import { isChannelSpecialBase } from "./catalog.js";
import { vertexRequestMode } from "./vertex-convert.js";
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
  CHANNEL_TYPE_OPENROUTER,
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
 * (`OpenaiHandler`, `OpenaiImageHandler`, `OaiResponsesHandler`,
 * `OaiResponsesCompactionHandler`). Audio / realtime / rerank use other
 * handlers (`RerankHandler` leftover unmarshal is `usesRerankHandlerUnmarshal`).
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

/**
 * Original `palm.palmHandler` / native `tencent.tencentHandler` /
 * `zhipu.zhipuHandler` `json.Unmarshal` (`NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Stream handlers log/continue (not leftover
 * gin.H). Tencent OpenAI-compat keys stay `openai.Adaptor`.
 */
export function usesPalmTencentZhipuUnmarshal(
  channelType: number,
  mode: string,
  nativeTencent = false,
): boolean {
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "images":
      return false;
    default:
      break;
  }
  if (channelType === CHANNEL_TYPE_PALM) return true;
  if (channelType === CHANNEL_TYPE_ZHIPU) return true;
  if (channelType === CHANNEL_TYPE_TENCENT) return nativeTencent;
  return false;
}

/** Original `json.Unmarshal` target type name for Palm / Tencent native / Zhipu v3. */
export function palmTencentZhipuUnmarshalTypeName(channelType: number): string {
  if (channelType === CHANNEL_TYPE_TENCENT) return "tencent.TencentChatResponseSB";
  if (channelType === CHANNEL_TYPE_ZHIPU) return "zhipu.ZhipuResponse";
  return "palm.PaLMChatResponse";
}

/**
 * Original `json.Unmarshal` into `palm.PaLMChatResponse` /
 * `tencent.TencentChatResponseSB` / `zhipu.ZhipuResponse`. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function palmTencentZhipuResponseUnmarshalError(text: string, channelType: number): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${palmTencentZhipuUnmarshalTypeName(channelType)}`;
  }
  return null;
}

/**
 * Original `baidu.baiduHandler` / `baidu.baiduEmbeddingHandler` `json.Unmarshal`
 * (`NewError` `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Stream uses
 * `baiduStreamHandler` (log/continue, not leftover gin.H).
 */
export function usesBaiduUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_BAIDU) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "images":
      return false;
    default:
      return true;
  }
}

/** Original `json.Unmarshal` target type name for Baidu chat / embeddings. */
export function baiduUnmarshalTypeName(mode: string): string {
  if (mode === "embeddings") return "baidu.BaiduEmbeddingResponse";
  return "baidu.BaiduChatResponse";
}

/**
 * Original `json.Unmarshal` into `baidu.BaiduChatResponse` /
 * `baidu.BaiduEmbeddingResponse`. Syntax errors match `encoding/json`. JSON
 * `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails).
 */
export function baiduResponseUnmarshalError(text: string, mode: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${baiduUnmarshalTypeName(mode)}`;
  }
  return null;
}

/**
 * Original `coze.cozeChatHandler` `json.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Stream uses
 * `cozeChatStreamHandler` (log/continue, not leftover gin.H). Create/poll
 * DoRequest unmarshal stays Extra-OK (not leftover gin.H).
 */
export function usesCozeUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_COZE) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "images":
    case "embeddings":
      return false;
    default:
      return true;
  }
}

/** Original `json.Unmarshal` target type name for Coze chat detail. */
export function cozeUnmarshalTypeName(): string {
  return "coze.CozeChatDetailResponse";
}

/**
 * Original `json.Unmarshal` into `coze.CozeChatDetailResponse`. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function cozeResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${cozeUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `dify.difyHandler` `json.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Stream uses
 * `difyStreamHandler` (log/continue, not leftover gin.H). Images / audio /
 * embeddings / responses convert `"not implemented"` before DoResponse.
 */
export function usesDifyUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_DIFY) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "images":
    case "embeddings":
      return false;
    default:
      return true;
  }
}

/** Original `json.Unmarshal` target type name for Dify chat. */
export function difyUnmarshalTypeName(): string {
  return "dify.DifyChatCompletionResponse";
}

/**
 * Original `json.Unmarshal` into `dify.DifyChatCompletionResponse`. Syntax
 * errors match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function difyResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${difyUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `mokaai.mokaEmbeddingHandler` `json.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Chat ConvertOpenAIRequest
 * is `"not implemented"` before DoResponse.
 */
export function usesMokaUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_MOKA && mode === "embeddings";
}

/** Original `json.Unmarshal` target type name for Moka embeddings. */
export function mokaUnmarshalTypeName(): string {
  return "dto.EmbeddingResponse";
}

/**
 * Original `json.Unmarshal` into `dto.EmbeddingResponse`. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function mokaResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${mokaUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `cloudflare.cfHandler` / `cloudflare.cfSTTHandler` `json.Unmarshal`
 * (`NewError` `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Chat and
 * embeddings fallthrough share `cfHandler`. Stream uses `cfStreamHandler`
 * (log/continue, not leftover gin.H). Responses uses `openai.OaiResponsesHandler`.
 * Completions is not in original DoResponse (returns nil, nil).
 */
export function usesCloudflareUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_CLOUDFLARE) return false;
  switch (mode) {
    case "chat":
    case "embeddings":
    case "audio_transcription":
    case "audio_translation":
      return true;
    default:
      return false;
  }
}

/** Original `json.Unmarshal` target type name for Cloudflare chat / embeddings / STT. */
export function cloudflareUnmarshalTypeName(mode: string): string {
  if (mode === "audio_transcription" || mode === "audio_translation") {
    return "cloudflare.CfAudioResponse";
  }
  return "dto.TextResponse";
}

/**
 * Original `json.Unmarshal` into `dto.TextResponse` (`cfHandler`, including
 * embeddings fallthrough) or `cloudflare.CfAudioResponse` (`cfSTTHandler`).
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function cloudflareResponseUnmarshalError(text: string, mode: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${cloudflareUnmarshalTypeName(mode)}`;
  }
  return null;
}

/**
 * Original `xai.xAIHandler` `common.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, not `NewOpenAIError`). Stream uses
 * `xAIStreamHandler` (log/continue, not leftover gin.H). Images uses
 * `openai.OpenaiImageHandler`. Responses uses `openai.OaiResponsesHandler`.
 * Embeddings / audio Convert is `"not available"` before DoResponse.
 */
export function usesXaiUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_XAI) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "images":
    case "embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/** Original `common.Unmarshal` target type name for xAI chat / completions. */
export function xaiUnmarshalTypeName(): string {
  return "xai.ChatCompletionResponse";
}

/**
 * Original `common.Unmarshal` into `xai.ChatCompletionResponse`. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function xaiResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${xaiUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `jimeng.jimengImageHandler` `json.Unmarshal` (`NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Chat / completions use `openai.OpenaiHandler`
 * (`usesJimengChatUnmarshal`). Stream uses `openai.OaiStreamHandler`
 * (log/continue, not leftover gin.H). Audio / embeddings / rerank / responses
 * convert `"not implemented"` before DoResponse.
 */
export function usesJimengUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_JIMENG && mode === "images";
}

/** Original `json.Unmarshal` target type name for Jimeng images. */
export function jimengUnmarshalTypeName(): string {
  return "jimeng.ImageResponse";
}

/**
 * Original `json.Unmarshal` into `jimeng.ImageResponse`. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function jimengResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${jimengUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `jimeng.Adaptor.DoResponse` non-image non-stream path
 * (`openai.OpenaiHandler` `common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Images stay `usesJimengUnmarshal`. Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Audio /
 * embeddings / rerank / responses convert `"not implemented"` before DoResponse
 * (hop 350). Extra-OK: ConvertClaudeRequest / ConvertGeminiRequest stay
 * `"not implemented"` (hop 350).
 */
export function usesJimengChatUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_JIMENG) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.OpenaiHandler` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for Jimeng chat / completions. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function jimengChatResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `mistral.Adaptor.DoResponse` non-stream path (`openai.OpenaiHandler`
 * `common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody`). Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Images / audio
 * / embeddings / responses convert `"not implemented"` before DoResponse
 * (hop 350). Extra-OK: ConvertClaudeRequest `"implement me"` / ConvertGeminiRequest
 * `"not implemented"` stay hop 350.
 */
export function usesMistralChatUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_MISTRAL) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.OpenaiHandler` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for Mistral chat / completions. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function mistralChatResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `submodel.Adaptor.DoResponse` non-stream path (`openai.OpenaiHandler`
 * `common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody`). Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Images / audio
 * / embeddings / rerank / responses convert `"submodel channel: endpoint not
 * supported"` before DoResponse (hop 350). Extra-OK: ConvertClaudeRequest /
 * ConvertGeminiRequest `"submodel channel: endpoint not supported"` stay hop
 * 350. Extra-OK: completions Convert `"submodel channel: endpoint not
 * supported"` stays hop 350 when `relayMode !== "chat"`.
 */
export function usesSubmodelChatUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_SUBMODEL) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.OpenaiHandler` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for Submodel chat / completions. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function submodelChatResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `jina.Adaptor.DoResponse` embeddings path (`openai.OpenaiHandler`
 * `common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody`). Rerank stays
 * `usesRerankHandlerUnmarshal` (hop 366). Chat GetRequestURL is
 * `"invalid relay mode"` before DoResponse. Images / audio / responses convert
 * `"not implemented"` before DoResponse (hop 350). Extra-OK: ConvertClaudeRequest
 * `"implement me"` / ConvertGeminiRequest `"not implemented"` stay hop 350.
 */
export function usesJinaEmbeddingsUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_JINA && (mode === "embeddings" || mode === "engines_embeddings");
}

/**
 * Original `openai.OpenaiHandler` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for Jina embeddings. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function jinaEmbeddingsResponseUnmarshalError(text: string, mode = "embeddings"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `vertex.Adaptor.DoResponse` non-stream `RequestModeOpenSource`
 * path (`openai.OpenaiHandler` `common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). RequestMode is `llama` / `-maas` (hop 390).
 * Stream uses `openai.OaiStreamHandler` (log/continue, not leftover gin.H).
 * Gemini / Claude RequestMode stay native handlers. Images use gemini
 * ConvertImageRequest before DoResponse. Audio / embeddings / rerank /
 * responses convert `"not implemented"` before DoResponse (hop 350). Extra-OK:
 * API-key OpenSource GetRequestURL `"unsupported request mode"` stays hop 350.
 * Extra-OK: ConvertClaudeRequest always wraps (RequestMode not consulted).
 * Extra-OK: ConvertGeminiRequest always strips IDs then gemini adaptor.
 */
export function usesVertexOpenSourceUnmarshal(channelType: number, mode: string, model: string): boolean {
  if (channelType !== CHANNEL_TYPE_VERTEX) return false;
  if (vertexRequestMode(model) !== "opensource") return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.OpenaiHandler` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for Vertex RequestModeOpenSource chat /
 * completions. Syntax errors match `encoding/json`. JSON `null` succeeds as a
 * zero-value struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function vertexOpenSourceResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `perplexity.Adaptor.DoResponse` always delegates to
 * `openai.Adaptor.DoResponse`. Non-stream chat / completions use
 * `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Responses Convert succeeds and uses
 * `OaiResponsesHandler` (same leftover OpenAI envelope; type
 * `dto.OpenAIResponsesResponse`). Stream uses `openai.OaiStreamHandler`
 * (log/continue, not leftover gin.H). Images / audio / embeddings convert
 * `"not implemented"` before DoResponse (hop 350). Extra-OK: ConvertClaudeRequest
 * delegates to `openai.Adaptor`. Extra-OK: ConvertGeminiRequest
 * `"not implemented"` stays hop 350. Extra-OK: ConvertRerankRequest `nil, nil`
 * rerank Unmarshal stays leftover. Extra-OK: hop 390 Vertex OpenSource stays.
 */
export function usesPerplexityUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_PERPLEXITY) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.OpenAIResponsesResponse` for Perplexity.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function perplexityResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `siliconflow.Adaptor.DoResponse` non-rerank path always delegates
 * to `openai.Adaptor.DoResponse`. Non-stream chat / completions / embeddings
 * use `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Images Convert succeeds then
 * `OpenaiImageHandler` (`dto.SimpleResponse`). Rerank stays
 * `siliconflowRerankHandler` (hop 367). Stream uses `openai.OaiStreamHandler`
 * (log/continue, not leftover gin.H). Responses Convert `"not implemented"`
 * before DoResponse (hop 350). Extra-OK: ConvertClaudeRequest delegates to
 * `openai.Adaptor`. Extra-OK: ConvertGeminiRequest `"not implemented"` stays
 * hop 350. Extra-OK: audio Convert delegates then `OpenaiTTSHandler` /
 * `OpenaiSTTHandler` stay Extra-OK. Extra-OK: hop 391 Perplexity stays.
 */
export function usesSiliconflowUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_SILICONFLOW) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.SimpleResponse` for Siliconflow non-rerank.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function siliconflowResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `deepseek.Adaptor.DoResponse` default path always delegates to
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`
 * (`clientFormat === "openai"` gate in relay). Non-stream chat / completions
 * use `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Responses Convert succeeds then
 * `OaiResponsesHandler` (`dto.OpenAIResponsesResponse`). Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Images /
 * audio / embeddings convert `"not implemented"` before DoResponse (hop 350).
 * Extra-OK: ConvertClaudeRequest uses `claude.Adaptor`. Extra-OK:
 * ConvertGeminiRequest `"not implemented"` stays hop 350. Extra-OK:
 * ConvertRerankRequest `nil, nil` rerank Unmarshal stays leftover. Extra-OK:
 * hop 392 Siliconflow stays.
 */
export function usesDeepseekUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_DEEPSEEK) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.OpenAIResponsesResponse` for Deepseek
 * OpenAI-format. Syntax errors match `encoding/json`. JSON `null` succeeds as
 * a zero-value struct. Extra-OK: nested field type mismatches are left to
 * convert (original fails).
 */
export function deepseekResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original Deepseek Claude-format `deepseek.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). OpenAI format stays hop 393 (`clientFormat ===
 * "openai"` gate). Images / audio / embeddings Convert `"not implemented"`
 * before DoResponse (hop 350). Extra-OK: hop 410 MiniMax Claude stays. Stream
 * stays hop 429 (`ClaudeStreamHandler`). Extra-OK: hop 428 MiniMax stream stays.
 */
export function usesDeepseekClaudeUnmarshal(channelType: number, mode: string): boolean {
  return usesDeepseekUnmarshal(channelType, mode);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Deepseek Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function deepseekClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Deepseek Claude-format `deepseek.Adaptor.DoResponse` stream
 * delegates to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-format stream
 * stays Extra-OK `OaiStreamHandler` log/continue. Responses stream stays
 * `ClaudeResponsesStreamHandler` (later hop, `NewOpenAIError`). Extra-OK: hop
 * 411 non-stream `ClaudeHandler` stays. Extra-OK: hop 428 MiniMax stream stays.
 * Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesDeepseekClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesDeepseekClaudeUnmarshal(channelType, mode);
}

/**
 * Original `moonshot.Adaptor.DoResponse` default path always delegates to
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`
 * (`clientFormat === "openai"` gate in relay). Non-stream chat / completions /
 * embeddings use `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Images Convert succeeds then
 * `OpenaiImageHandler` (`dto.SimpleResponse`). Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Audio Convert
 * `"not supported"` and responses Convert `"not implemented"` before DoResponse
 * (hop 350). Extra-OK: ConvertClaudeRequest uses `claude.Adaptor`. Extra-OK:
 * ConvertGeminiRequest `"not implemented"` stays hop 350. Extra-OK:
 * ConvertRerankRequest succeeds but hop 366 `RerankHandler` is openai.Adaptor +
 * Jina only, so Moonshot rerank Unmarshal stays leftover. Extra-OK: hop 393
 * Deepseek stays.
 */
export function usesMoonshotUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_MOONSHOT) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.SimpleResponse` for Moonshot OpenAI-format.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function moonshotResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original Moonshot Claude-format `moonshot.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). OpenAI format stays hop 394 (`clientFormat ===
 * "openai"` gate). Audio / responses Convert `"not supported"` / `"not
 * implemented"` before DoResponse (hop 350). ConvertRerank leftover hop 366.
 * Extra-OK: hop 408 Vertex Claude stays. Stream stays hop 427
 * (`ClaudeStreamHandler`). Extra-OK: hop 426 Vertex stream stays.
 */
export function usesMoonshotClaudeUnmarshal(channelType: number, mode: string): boolean {
  return usesMoonshotUnmarshal(channelType, mode);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Moonshot Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function moonshotClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Moonshot Claude-format `moonshot.Adaptor.DoResponse` stream
 * delegates to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-format stream
 * stays Extra-OK `OaiStreamHandler` log/continue (`clientFormat === "openai"`
 * gate). Extra-OK: hop 409 non-stream `ClaudeHandler` stays. Extra-OK: hop
 * 426 Vertex stream stays. Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesMoonshotClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  return usesMoonshotClaudeUnmarshal(channelType, mode);
}

/**
 * Original `baidu_v2.Adaptor.DoResponse` always delegates to
 * `openai.Adaptor.DoResponse`. Non-stream chat uses `openai.OpenaiHandler`
 * (`common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody`). Completions
 * GetRequestURL is `unsupported relay mode` before DoResponse. Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Images / audio /
 * embeddings / rerank / responses convert `"not implemented"` before DoResponse
 * (hop 350). Extra-OK: ConvertClaudeRequest delegates to `openai.Adaptor`.
 * Extra-OK: ConvertGeminiRequest `"not implemented"` stays hop 350. Extra-OK:
 * hop 394 Moonshot stays.
 */
export function usesBaiduV2Unmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_BAIDU_V2) return false;
  switch (mode) {
    case "chat":
      return true;
    default:
      return false;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for Baidu V2 chat. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function baiduV2ResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `ali.Adaptor.DoResponse` default path delegates to
 * `openai.Adaptor.DoResponse`. Images stay `aliImageHandler` and rerank stays
 * `ali.RerankHandler` (hop 367). Claude format + `supportsAliAnthropicMessages`
 * uses `claude.Adaptor.DoResponse` (gate in relay). Non-stream chat /
 * completions / embeddings use `openai.OpenaiHandler` (`common.Unmarshal`
 * `NewOpenAIError` `ErrorCodeBadResponseBody`). Responses Convert succeeds then
 * `OaiResponsesHandler` (`dto.OpenAIResponsesResponse`). Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Audio Convert
 * `"not implemented"` before DoResponse (hop 350). Extra-OK: ConvertClaudeRequest
 * anthropic-messages models stay `claude.Adaptor`. Extra-OK:
 * ConvertGeminiRequest `"not implemented"` stays hop 350. Extra-OK: hop 367 Ali
 * rerank stays. Extra-OK: hop 395 Baidu V2 stays.
 */
export function usesAliUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_ALI) return false;
  switch (mode) {
    case "images":
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
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.OpenAIResponsesResponse` for Ali
 * non-image/rerank. Syntax errors match `encoding/json`. JSON `null` succeeds
 * as a zero-value struct. Extra-OK: nested field type mismatches are left to
 * convert (original fails).
 */
export function aliResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original Ali Claude-format `ali.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` when `supportsAliAnthropicMessages` (`ClaudeHandler`
 * `HandleClaudeResponseData` `common.Unmarshal` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI format and
 * Claude format without anthropic-messages models stay hop 396. Images stay
 * hop 397. Rerank stays hop 367. Extra-OK: hop 415 Ollama Claude stays. Stream
 * stays hop 434 (`ClaudeStreamHandler`). Extra-OK: hop 433 Ollama stream stays.
 */
export function usesAliClaudeUnmarshal(channelType: number, mode: string, model: string): boolean {
  if (!usesAliUnmarshal(channelType, mode)) return false;
  return supportsAliAnthropicMessages(model);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Ali anthropic-messages Claude-format. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function aliClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Ali Claude-format `ali.Adaptor.DoResponse` stream delegates to
 * `claude.Adaptor.DoResponse` when `supportsAliAnthropicMessages`
 * (`ClaudeStreamHandler` `HandleStreamResponseData` `UnmarshalJsonStr`
 * `NewError` `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI
 * format and Claude format without anthropic-messages models stay Extra-OK
 * `OaiStreamHandler` log/continue. Responses stream stays
 * `ClaudeResponsesStreamHandler` (later hop, `NewOpenAIError`). Extra-OK: hop
 * 416 non-stream `ClaudeHandler` stays. Extra-OK: hop 433 Ollama stream stays.
 * Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesAliClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  model: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesAliClaudeUnmarshal(channelType, mode, model);
}

/**
 * Original `ali.aliImageHandler` `common.Unmarshal` (`NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Chat / completions / embeddings / responses stay
 * `openai.Adaptor.DoResponse` (hop 396). Rerank stays `ali.RerankHandler`
 * (hop 367). Audio Convert `"not implemented"` before DoResponse (hop 350).
 * Extra-OK: `updateTask` Unmarshal logs and continues (not leftover gin.H).
 * Extra-OK: hop 396 Ali openai.Adaptor stays.
 */
export function usesAliImageUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_ALI && mode === "images";
}

/** Original `common.Unmarshal` target type name for Ali images. */
export function aliImageUnmarshalTypeName(): string {
  return "ali.AliResponse";
}

/**
 * Original `common.Unmarshal` into `ali.AliResponse`. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function aliImageResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${aliImageUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `volcengine.Adaptor.DoResponse` default path delegates to
 * `openai.Adaptor.DoResponse`. Audio speech stays native `handleTTSResponse`.
 * Claude format + `ChannelSpecialBases` stays `claude.Adaptor.DoResponse`
 * (gate in relay). Non-stream chat / embeddings use `openai.OpenaiHandler`
 * (`common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody`). Images
 * Convert succeeds then `OpenaiImageHandler` (`dto.SimpleResponse`). Responses
 * Convert succeeds then `OaiResponsesHandler` (`dto.OpenAIResponsesResponse`).
 * Stream uses `openai.OaiStreamHandler` (log/continue, not leftover gin.H).
 * Completions GetRequestURL is `unsupported relay mode` before DoResponse.
 * Audio transcription / translation Convert `"unsupported audio relay mode"`
 * before DoResponse (hop 350). Extra-OK: ConvertRerankRequest `nil, nil`
 * rerank Unmarshal stays leftover. Extra-OK: ConvertGeminiRequest
 * `"not implemented"` stays hop 350. Extra-OK: hop 397 Ali image stays.
 */
export function usesVolcUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_VOLC) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "completions":
      return false;
    default:
      return true;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.SimpleResponse` /
 * `dto.OpenAIResponsesResponse` for Volc non-TTS. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function volcResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original Volc Claude-format `volcengine.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` when `ChannelSpecialBases[base_url]`
 * (`ClaudeHandler` `HandleClaudeResponseData` `common.Unmarshal` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI format and
 * Claude format without a special base stay hop 398. TTS stays hop 356 /
 * Volc TTS Extra-OK. Extra-OK: hop 416 Ali Claude stays. Stream stays hop 435
 * (`ClaudeStreamHandler`). Extra-OK: hop 434 Ali stream stays.
 */
export function usesVolcClaudeUnmarshal(channelType: number, mode: string, baseUrl?: string | null): boolean {
  if (!usesVolcUnmarshal(channelType, mode)) return false;
  return isChannelSpecialBase(baseUrl || "");
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Volc special-base Claude-format. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function volcClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Volc special-base Claude-format `volcengine.Adaptor.DoResponse` stream
 * delegates to `claude.Adaptor.DoResponse` when `ChannelSpecialBases[base_url]`
 * (`ClaudeStreamHandler` `HandleStreamResponseData` `UnmarshalJsonStr`
 * `NewError` `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI
 * format and Claude format without a special base stay Extra-OK
 * `OaiStreamHandler` log/continue. Responses stream stays
 * `ClaudeResponsesStreamHandler` (later hop, `NewOpenAIError`). Extra-OK: hop
 * 417 non-stream `ClaudeHandler` stays. Extra-OK: hop 434 Ali stream stays.
 * Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesVolcClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  baseUrl?: string | null,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesVolcClaudeUnmarshal(channelType, mode, baseUrl);
}

/**
 * Original `minimax.Adaptor.DoResponse` default path delegates to
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`
 * (`clientFormat === "openai"` gate in relay). Non-stream chat uses
 * `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Completions / embeddings / rerank GetRequestURL
 * is `unsupported relay mode` before DoResponse. Images stay
 * `miniMaxImageHandler`. Audio speech stays `handleTTSResponse` (hop 384).
 * Stream uses `openai.OaiStreamHandler` (log/continue, not leftover gin.H).
 * Responses Convert `"not implemented"` before DoResponse (hop 350). Extra-OK:
 * ConvertClaudeRequest uses `claude.Adaptor`. Extra-OK: ConvertGeminiRequest
 * `"not implemented"` stays hop 350. Extra-OK: ConvertRerankRequest `nil, nil`
 * leftover. Extra-OK: hop 398 Volc stays.
 */
export function usesMiniMaxUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_MINIMAX) return false;
  switch (mode) {
    case "chat":
      return true;
    default:
      return false;
  }
}

/**
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` for MiniMax OpenAI-format chat. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function miniMaxResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original MiniMax Claude-format `minimax.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). OpenAI-format chat stays hop 399. Images stay hop 400.
 * TTS stays hop 356 / MiniMax TTS unmarshal. Extra-OK: hop 409 Moonshot Claude
 * stays. Stream stays hop 428 (`ClaudeStreamHandler`). Extra-OK: hop 427
 * Moonshot stream stays.
 */
export function usesMiniMaxClaudeUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_MINIMAX) return false;
  return mode === "messages";
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for MiniMax Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function miniMaxClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original MiniMax Claude-format `minimax.Adaptor.DoResponse` stream delegates
 * to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-format stream
 * stays Extra-OK `OaiStreamHandler` log/continue. Extra-OK: hop 410 non-stream
 * `ClaudeHandler` stays. Extra-OK: hop 427 Moonshot stream stays. Extra-OK:
 * hop 422 Anthropic stream stays.
 */
export function usesMiniMaxClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  return usesMiniMaxClaudeUnmarshal(channelType, mode);
}

/**
 * Original `minimax.miniMaxImageHandler` `common.Unmarshal` (`NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Chat stays `openai.Adaptor.DoResponse` (hop 399).
 * Audio speech stays `handleTTSResponse` (hop 384). Extra-OK: hop 362
 * `minimax_image_error` `WithOpenAIError` stays leftover. Extra-OK: hop 399
 * MiniMax chat stays.
 */
export function usesMiniMaxImageUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_MINIMAX && mode === "images";
}

/** Original `common.Unmarshal` target type name for MiniMax images. */
export function miniMaxImageUnmarshalTypeName(): string {
  return "minimax.MiniMaxImageResponse";
}

/**
 * Original `common.Unmarshal` into `minimax.MiniMaxImageResponse`. Syntax
 * errors match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function miniMaxImageResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${miniMaxImageUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `ollama.ollamaEmbeddingHandler` / `ollama.ollamaChatHandler`
 * `common.Unmarshal` (`NewOpenAIError` `ErrorCodeBadResponseBody`). Stream stays
 * hop 438 (`ollamaStreamHandler` leftover gin.H). Responses uses
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`.
 * Images / audio Convert is `"not implemented"` before DoResponse.
 */
export function usesOllamaUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_OLLAMA) return false;
  switch (mode) {
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "images":
    case "responses":
      return false;
    default:
      return true;
  }
}

/** Original `common.Unmarshal` target type name for Ollama embeddings / chat. */
export function ollamaUnmarshalTypeName(mode: string): string {
  if (mode === "embeddings" || mode === "engines_embeddings") {
    return "ollama.OllamaEmbeddingResponse";
  }
  return "ollama.ollamaChatStreamChunk";
}

function ollamaUnmarshalIntoType(text: string, mode: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${ollamaUnmarshalTypeName(mode)}`;
  }
  return null;
}

/**
 * Original `common.Unmarshal` into `ollama.OllamaEmbeddingResponse` (whole
 * body) or `ollama.ollamaChatStreamChunk` (`ollamaChatHandler` line loop, then
 * whole-body fallback when `!parsedAny`). Syntax errors match `encoding/json`.
 * JSON `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails). Extra-OK: chat NDJSON with
 * at least one valid line stays convert (`rawText`), matching original
 * `parsedAny`.
 */
export function ollamaResponseUnmarshalError(text: string, mode: string): string | null {
  if (mode === "embeddings" || mode === "engines_embeddings") {
    return ollamaUnmarshalIntoType(text, mode);
  }
  const lines = text.split("\n");
  let parsedAny = false;
  for (const rawLine of lines) {
    const ln = rawLine.trim();
    if (!ln) continue;
    const lineErr = ollamaUnmarshalIntoType(ln, mode);
    if (lineErr) {
      if (lines.length === 1) return lineErr;
      continue;
    }
    parsedAny = true;
  }
  if (!parsedAny) return ollamaUnmarshalIntoType(text, mode);
  return null;
}

/**
 * Original Ollama Claude-format `ollama.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). OpenAI-format chat / completions / embeddings stay
 * hop 381 (`clientFormat === "openai"` gate). Images / audio Convert
 * `"not implemented"` before DoResponse (hop 350). Extra-OK: hop 414 sub2api
 * Claude stays. Stream stays hop 433 (`ClaudeStreamHandler`). Extra-OK: hop 432
 * sub2api stream stays.
 */
export function usesOllamaClaudeUnmarshal(channelType: number, mode: string): boolean {
  return usesOllamaUnmarshal(channelType, mode);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Ollama Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function ollamaClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Ollama Claude-format `ollama.Adaptor.DoResponse` stream delegates
 * to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-format stream
 * stays hop 438 (`ollamaStreamHandler`). Extra-OK: hop 415 non-stream
 * `ClaudeHandler` stays. Extra-OK: hop 432 sub2api stream stays.
 * Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesOllamaClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesOllamaClaudeUnmarshal(channelType, mode);
}

/**
 * Original `ollama.ollamaStreamHandler` NDJSON `common.Unmarshal` into
 * `ollama.ollamaChatStreamChunk` (`NewOpenAIError` `ErrorCodeBadResponseBody`).
 * First non-empty line that fails returns leftover gin.H (does not skip like
 * non-stream `parsedAny`). Embeddings stay hop 381. Responses stay
 * `openai.Adaptor`. Claude format stream stays hop 433. Extra-OK: hop 381
 * non-stream `ollamaChatHandler` stays. Extra-OK: hop 437 advanced-custom
 * Gemini stream stays. Extra-OK: replica buffers leftover gin.H before SSE
 * headers (original `SetEventStreamHeaders` + start empty chunk run first).
 */
export function usesOllamaStreamUnmarshal(channelType: number, mode: string, isStream = true): boolean {
  if (!isStream) return false;
  if (mode === "embeddings" || mode === "engines_embeddings") return false;
  if (mode === "responses") return false;
  return usesOllamaUnmarshal(channelType, mode);
}

/**
 * Original `ollamaStreamHandler` line-loop `common.Unmarshal` into
 * `ollama.ollamaChatStreamChunk`. Syntax errors match `encoding/json`. JSON
 * `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails).
 */
export function ollamaStreamUnmarshalError(text: string): string | null {
  for (const rawLine of String(text || "").split("\n")) {
    const ln = rawLine.trim();
    if (!ln) continue;
    const lineErr = ollamaUnmarshalIntoType(ln, "chat");
    if (lineErr) return lineErr;
  }
  return null;
}

/**
 * Original `zhipu_4v.Adaptor.DoResponse` default path always delegates to
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`
 * (`clientFormat === "openai"` gate in relay). Non-stream chat / completions /
 * embeddings use `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Images stay `zhipu4vImageHandler` (hop 382).
 * Responses use `openai.OaiResponsesHandler` (`dto.OpenAIResponsesResponse`).
 * Stream uses `openai.OaiStreamHandler` (log/continue, not leftover gin.H).
 * Audio Convert `"not implemented"` before DoResponse (hop 350). Extra-OK:
 * ConvertClaudeRequest uses `claude.Adaptor`. Extra-OK: ConvertGeminiRequest
 * `"not implemented"` stays hop 350. Extra-OK: ConvertRerankRequest `nil, nil`
 * leftover. Extra-OK: hop 400 MiniMax image stays.
 */
export function usesZhipuV4Unmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_ZHIPU_V4) return false;
  switch (mode) {
    case "images":
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
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.OpenAIResponsesResponse` for Zhipu v4
 * OpenAI-format. Syntax errors match `encoding/json`. JSON `null` succeeds as
 * a zero-value struct. Extra-OK: nested field type mismatches are left to
 * convert (original fails).
 */
export function zhipuV4ResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original Zhipu v4 Claude-format `zhipu_4v.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). OpenAI format stays hop 401 (`clientFormat ===
 * "openai"` gate). Images stay hop 382. Audio Convert `"not implemented"`
 * before DoResponse (hop 350). Extra-OK: hop 411 Deepseek Claude stays. Stream
 * stays hop 430 (`ClaudeStreamHandler`). Extra-OK: hop 429 Deepseek stream stays.
 */
export function usesZhipuV4ClaudeUnmarshal(channelType: number, mode: string): boolean {
  return usesZhipuV4Unmarshal(channelType, mode);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Zhipu v4 Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function zhipuV4ClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Zhipu v4 Claude-format `zhipu_4v.Adaptor.DoResponse` stream
 * delegates to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-format stream
 * stays Extra-OK `OaiStreamHandler` log/continue. Responses stream stays
 * `ClaudeResponsesStreamHandler` (later hop, `NewOpenAIError`). Extra-OK: hop
 * 412 non-stream `ClaudeHandler` stays. Extra-OK: hop 429 Deepseek stream stays.
 * Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesZhipuV4ClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesZhipuV4ClaudeUnmarshal(channelType, mode);
}

/**
 * Original `zhipu_4v.zhipu4vImageHandler` `common.Unmarshal` (`NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Chat / embeddings / responses stay
 * `openai.Adaptor.DoResponse` (hop 401). Claude format uses
 * `claude.Adaptor.DoResponse`. Audio Convert is `"not implemented"` before
 * DoResponse.
 */
export function usesZhipuV4ImageUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_ZHIPU_V4 && mode === "images";
}

/** Original `common.Unmarshal` target type name for Zhipu v4 images. */
export function zhipuV4ImageUnmarshalTypeName(): string {
  return "zhipu_4v.zhipuImageResponse";
}

/**
 * Original `common.Unmarshal` into `zhipu_4v.zhipuImageResponse`. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function zhipuV4ImageResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${zhipuV4ImageUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `newapi.Adaptor.DoResponse` default path always delegates to
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`
 * (`clientFormat === "openai"` gate in relay). Gemini format uses
 * `gemini.Adaptor.DoResponse`. Non-stream chat / completions / embeddings use
 * `openai.OpenaiHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Images use `OpenaiImageHandler`
 * (`dto.SimpleResponse`). Responses use `openai.OaiResponsesHandler`
 * (`dto.OpenAIResponsesResponse`). Stream uses `openai.OaiStreamHandler`
 * (log/continue, not leftover gin.H). Audio / rerank Convert
 * `"endpoint not supported"` before DoResponse (hop 350). Extra-OK:
 * ConvertClaudeRequest uses `claude.Adaptor`. Extra-OK: ConvertGeminiRequest
 * uses `gemini.Adaptor`. Extra-OK: hop 401 Zhipu v4 stays.
 */
export function usesNewApiUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_NEW_API) return false;
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
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.SimpleResponse` /
 * `dto.OpenAIResponsesResponse` for newapi OpenAI-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function newApiResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original newapi Claude-format `newapi.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). OpenAI format stays hop 402 (`clientFormat ===
 * "openai"` gate). Gemini format stays `gemini.Adaptor`. Audio / rerank
 * Convert `"endpoint not supported"` before DoResponse (hop 350). Extra-OK:
 * hop 412 Zhipu v4 Claude stays. Stream stays hop 431 (`ClaudeStreamHandler`).
 * Extra-OK: hop 430 Zhipu v4 stream stays.
 */
export function usesNewApiClaudeUnmarshal(channelType: number, mode: string): boolean {
  return usesNewApiUnmarshal(channelType, mode);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for newapi Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function newApiClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original newapi Claude-format `newapi.Adaptor.DoResponse` stream delegates
 * to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-format stream
 * stays Extra-OK `OaiStreamHandler` log/continue. Responses stream stays
 * `ClaudeResponsesStreamHandler` (later hop, `NewOpenAIError`). Extra-OK: hop
 * 413 non-stream `ClaudeHandler` stays. Extra-OK: hop 430 Zhipu v4 stream stays.
 * Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesNewApiClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesNewApiClaudeUnmarshal(channelType, mode);
}

/**
 * Original `sub2api.Adaptor` embeds `newapi.Adaptor`, so DoResponse is the
 * same leftover `openai.Adaptor.DoResponse` path. Claude format uses
 * `claude.Adaptor.DoResponse` (`clientFormat === "openai"` gate in relay).
 * Gemini format uses `gemini.Adaptor.DoResponse`. Non-stream chat /
 * completions / embeddings use `openai.OpenaiHandler` (`common.Unmarshal`
 * `NewOpenAIError` `ErrorCodeBadResponseBody`). Images use
 * `OpenaiImageHandler` (`dto.SimpleResponse`). Responses use
 * `openai.OaiResponsesHandler` (`dto.OpenAIResponsesResponse`). Stream uses
 * `openai.OaiStreamHandler` (log/continue, not leftover gin.H). Audio / rerank
 * Convert `"endpoint not supported"` before DoResponse (hop 350). Extra-OK:
 * ConvertClaudeRequest uses `claude.Adaptor`. Extra-OK: ConvertGeminiRequest
 * uses `gemini.Adaptor`. Extra-OK: hop 402 newapi stays.
 */
export function usesSub2apiUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_SUB2API) return false;
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
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.SimpleResponse` /
 * `dto.OpenAIResponsesResponse` for sub2api OpenAI-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function sub2apiResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original sub2api Claude-format `sub2api.Adaptor` embeds `newapi.Adaptor`,
 * so `DoResponse` delegates to `claude.Adaptor.DoResponse` (`ClaudeHandler`
 * `HandleClaudeResponseData` `common.Unmarshal` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI format stays
 * hop 403 (`clientFormat === "openai"` gate). Gemini format stays
 * `gemini.Adaptor`. Audio / rerank Convert `"endpoint not supported"` before
 * DoResponse (hop 350). Extra-OK: hop 413 newapi Claude stays. Stream stays hop
 * 432 (`ClaudeStreamHandler`). Extra-OK: hop 431 newapi stream stays.
 */
export function usesSub2apiClaudeUnmarshal(channelType: number, mode: string): boolean {
  return usesSub2apiUnmarshal(channelType, mode);
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for sub2api Claude-format. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function sub2apiClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original sub2api Claude-format stream `sub2api.Adaptor` embeds
 * `newapi.Adaptor`, so `DoResponse` delegates to `claude.Adaptor.DoResponse`
 * (`ClaudeStreamHandler` `HandleStreamResponseData` `UnmarshalJsonStr`
 * `NewError` `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`).
 * OpenAI-format stream stays Extra-OK `OaiStreamHandler` log/continue.
 * Responses stream stays `ClaudeResponsesStreamHandler` (later hop,
 * `NewOpenAIError`). Extra-OK: hop 414 non-stream `ClaudeHandler` stays.
 * Extra-OK: hop 431 newapi stream stays. Extra-OK: hop 422 Anthropic stream
 * stays.
 */
export function usesSub2apiClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesSub2apiClaudeUnmarshal(channelType, mode);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` `none` / Claude→chat /
 * Gemini→chat converters delegate to `openai.Adaptor.DoResponse`. Chat-to-Claude
 * / chat-to-Gemini stay `claude.Adaptor` / `gemini.Adaptor`. Non-stream chat /
 * completions / embeddings use `openai.OpenaiHandler` (`common.Unmarshal`
 * `NewOpenAIError` `ErrorCodeBadResponseBody`). Images use
 * `OpenaiImageHandler` (`dto.SimpleResponse`). Responses use
 * `openai.OaiResponsesHandler`. Stream uses `openai.OaiStreamHandler`
 * (log/continue, not leftover gin.H). Extra-OK: hop 403 sub2api stays. Extra-OK: hop 419 chat-to-Claude / ConverterNone+RelayFormatClaude `claude.Adaptor` stays.
 */
export function usesAdvancedCustomUnmarshal(channelType: number, mode: string, converter = "none"): boolean {
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  if (!advancedCustomOpenaiShapedInbound(converter)) return false;
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
 * Original `openai.Adaptor.DoResponse` `common.Unmarshal` into
 * `dto.OpenAITextResponse` / `dto.SimpleResponse` /
 * `dto.OpenAIResponsesResponse` for advanced-custom OpenAI-shaped inbound.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function advancedCustomResponseUnmarshalError(text: string, mode = "chat"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` chat-to-Claude converter and
 * ConverterNone+`RelayFormatClaude` delegate to `claude.Adaptor.DoResponse`
 * (`ClaudeHandler` `HandleClaudeResponseData` `common.Unmarshal` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-shaped inbound
 * stays hop 404. Chat-to-Gemini stays `gemini.Adaptor` (later hop). Stream
 * stays hop 436 (`ClaudeStreamHandler`). Extra-OK: hop 404 OpenAI stays.
 * Extra-OK: hop 418 AWS AKSK stays. Extra-OK: hop 420 chat-to-Gemini `gemini.Adaptor` stays.
 * Extra-OK: hop 435 Volc stream stays.
 */
export function usesAdvancedCustomClaudeUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  clientFormat?: string,
): boolean {
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  const id = String(converter || CONVERTER_NONE).trim() || CONVERTER_NONE;
  const chatToClaude = id === CONVERTER_CHAT_TO_CLAUDE;
  const nativeClaude = id === CONVERTER_NONE && clientFormat === "anthropic";
  if (!chatToClaude && !nativeClaude) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "engines_embeddings":
      return false;
    default:
      return true;
  }
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for advanced-custom `claude.Adaptor`. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function advancedCustomClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` stream chat-to-Claude converter
 * and ConverterNone+`RelayFormatClaude` delegate to `claude.Adaptor.DoResponse`
 * (`ClaudeStreamHandler` `HandleStreamResponseData` `UnmarshalJsonStr`
 * `NewError` `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). OpenAI-shaped
 * inbound stream stays Extra-OK `OaiStreamHandler` log/continue. Responses
 * stream stays `ClaudeResponsesStreamHandler` (later hop, `NewOpenAIError`).
 * Extra-OK: hop 419 non-stream `ClaudeHandler` stays. Extra-OK: hop 435 Volc
 * stream stays. Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesAdvancedCustomClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  clientFormat?: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesAdvancedCustomClaudeUnmarshal(channelType, mode, converter, clientFormat);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` chat-to-Gemini converter and
 * ConverterNone+`RelayFormatGemini` delegate to `gemini.Adaptor.DoResponse`
 * (`GeminiChatHandler` `common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody` into `dto.GeminiChatResponse`). OpenAI-shaped
 * inbound stays hop 404. Chat-to-Claude stays hop 419. Stream stays hop 437
 * (`GeminiChatStreamHandler`). Responses-to-Gemini uses the same `GeminiResponsesHandler` leftover (hop 421).
 * Extra-OK: hop 360 Gemini channel stays. Extra-OK: hop 419 Claude stays.
 * Extra-OK: hop 423 Gemini channel stream stays. Extra-OK: hop 436 Claude stream stays.
 * Extra-OK: hop 451 embedding-model `GeminiEmbeddingHandler` stays.
 * Extra-OK: hop 453 imagen `GeminiImageHandler` stays.
 */
export function usesAdvancedCustomGeminiUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  clientFormat?: string,
  mapped = "",
): boolean {
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  if (mode === "images" || mode === "embeddings" || mode === "engines_embeddings") return false;
  if (mapped.startsWith("imagen")) return false;
  if (
    mapped.startsWith("text-embedding") ||
    mapped.startsWith("embedding") ||
    mapped.startsWith("gemini-embedding")
  ) {
    return false;
  }
  const id = String(converter || CONVERTER_NONE).trim() || CONVERTER_NONE;
  const chatToGemini = id === CONVERTER_CHAT_TO_GEMINI;
  const responsesToGemini = id === CONVERTER_RESPONSES_TO_GEMINI;
  const nativeGemini = id === CONVERTER_NONE && clientFormat === "gemini";
  if (!chatToGemini && !responsesToGemini && !nativeGemini) return false;
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
 * Original `advancedcustom.Adaptor.DoResponse` chat-to-Gemini converter
 * delegates to `gemini.Adaptor.DoResponse`, which uses `GeminiEmbeddingHandler`
 * (`common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody` into
 * `dto.GeminiBatchEmbeddingResponse`) for embedding-model prefixes even when
 * the client streams. Embeddings-mode converters Convert `"does not support
 * embedding requests"` before DoResponse (hop 350). Native `RelayModeGemini`
 * `:embedContent` / `:batchEmbedContents` stays hop 450/452.
 * Extra-OK: hop 449 Gemini channel `GeminiEmbeddingHandler` stays.
 * Extra-OK: hop 420 non-embedding `GeminiChatHandler` stays.
 */
export function usesAdvancedCustomGeminiEmbeddingUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  mapped = "",
): boolean {
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  if (mode === "gemini" || mode === "responses") return false;
  if (mode === "images" || mode === "embeddings" || mode === "engines_embeddings") return false;
  const name = String(mapped || "");
  if (
    !name.startsWith("text-embedding") &&
    !name.startsWith("embedding") &&
    !name.startsWith("gemini-embedding")
  ) {
    return false;
  }
  return String(converter || CONVERTER_NONE).trim() === CONVERTER_CHAT_TO_GEMINI;
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` chat-to-Gemini converter
 * delegates to `gemini.Adaptor.DoResponse`, which uses `GeminiImageHandler`
 * (`common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody` into
 * `dto.GeminiImageResponse`) for imagen prefixes even when the client streams.
 * Images-mode converters Convert `"does not support image requests"` before
 * DoResponse (hop 350). Extra-OK: hop 448 Gemini/Vertex `GeminiImageHandler`
 * stays. Extra-OK: hop 420 non-imagen `GeminiChatHandler` stays. Extra-OK:
 * hop 451 embedding-model `GeminiEmbeddingHandler` stays.
 */
export function usesAdvancedCustomGeminiImageUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  mapped = "",
): boolean {
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  if (mode === "gemini" || mode === "responses") return false;
  if (mode === "images" || mode === "embeddings" || mode === "engines_embeddings") return false;
  if (!String(mapped || "").startsWith("imagen")) return false;
  return String(converter || CONVERTER_NONE).trim() === CONVERTER_CHAT_TO_GEMINI;
}

/**
 * Original `GeminiChatHandler` `common.Unmarshal` into `dto.GeminiChatResponse`
 * for advanced-custom `gemini.Adaptor`. Syntax errors match `encoding/json`.
 * JSON `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails).
 */
export function advancedCustomGeminiResponseUnmarshalError(text: string): string | null {
  return geminiChatResponseUnmarshalError(text);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` stream chat-to-Gemini converter
 * and ConverterNone+`RelayFormatGemini` delegate to `gemini.Adaptor.DoResponse`
 * (`GeminiChatStreamHandler` `geminiStreamHandler` wrap
 * `unmarshal Gemini stream response: %w` then `NewOpenAIError`
 * `ErrorCodeBadResponseBody` into `dto.GeminiChatResponse`). OpenAI-shaped
 * inbound stream stays Extra-OK `OaiStreamHandler` log/continue. Responses
 * stream stays `GeminiResponsesStreamHandler` (hop 441 typically
 * `FailResponsesStream`; hop 440 Gemini channel stays). Extra-OK: hop 420
 * non-stream `GeminiChatHandler` stays. Extra-OK: hop 423 Gemini channel stream
 * stays. Extra-OK: hop 436 Claude stream stays. Extra-OK: hop 421 non-stream
 * `GeminiResponsesHandler` stays.
 */
export function usesAdvancedCustomGeminiStreamUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  clientFormat?: string,
  mapped = "",
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesAdvancedCustomGeminiUnmarshal(channelType, mode, converter, clientFormat, mapped);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` ConverterOpenAIResponsesToGemini
 * stream delegates to `gemini.Adaptor.DoResponse`
 * (`GeminiResponsesStreamHandler` `geminiStreamHandler` wrap then typically
 * `FailResponsesStream("server_error", streamAPIError.Error(), "")`). Typical
 * path is HTTP 200 SSE, not leftover gin.H. Leftover `NewOpenAIError`
 * `ErrorCodeBadResponseBody` only when `FailResponsesStream` is unhandled.
 * Extra-OK: hop 437 chat-to-Gemini `GeminiChatStreamHandler` leftover gin.H
 * stays. Extra-OK: hop 421 non-stream `GeminiResponsesHandler` stays. Extra-OK:
 * hop 440 Gemini channel stays. Extra-OK: replica convert always has
 * `ChatToResponsesStreamState` so `FailResponsesStream` is handled.
 * Extra-OK: hop 442 `OaiChatToResponsesStreamHandler` stays.
 */
export function usesAdvancedCustomGeminiResponsesStreamUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  clientFormat?: string,
  mapped = "",
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode !== "responses") return false;
  return usesAdvancedCustomGeminiUnmarshal(channelType, mode, converter, clientFormat, mapped);
}

/**
 * Original `GeminiResponsesStreamHandler` first invalid SSE `data:` payload for
 * advanced-custom responses-to-Gemini. Same wrap as hop 440 / hop 423.
 */
export function advancedCustomGeminiResponsesStreamSseUnmarshalError(text: string): string | null {
  return geminiChatStreamSseUnmarshalError(text);
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` ConverterOpenAIResponsesToOpenAIChat
 * stream uses `OaiChatToResponsesStreamHandler` (`UnmarshalJsonStr` into
 * `dto.ChatCompletionsStreamResponse`). Typical path is
 * `FailResponsesStream("server_error", err.Error(), "")` SSE (HTTP 200), not
 * leftover gin.H. Leftover `NewOpenAIError` `ErrorCodeBadResponseBody` only when
 * `FailResponsesStream` is unhandled. Extra-OK: hop 441 responses-to-Gemini
 * stays. Extra-OK: hop 438 Ollama OpenAI stream leftover gin.H stays. Extra-OK:
 * replica convert always has `ChatToResponsesStreamState` so
 * `FailResponsesStream` is handled for `/v1/responses`. Extra-OK: hop 443
 * non-stream `OaiChatToResponsesHandler` leftover gin.H stays.
 */
export function usesOaiChatToResponsesStreamUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode !== "responses") return false;
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  return String(converter || CONVERTER_NONE).trim() === CONVERTER_RESPONSES_TO_CHAT;
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` ConverterOpenAIResponsesToOpenAIChat
 * non-stream uses `OaiChatToResponsesHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody` into `dto.OpenAITextResponse`). Stream stays hop
 * 442 (`OaiChatToResponsesStreamHandler` typically `FailResponsesStream`).
 * Extra-OK: hop 404 OpenAI-shaped ConverterNone stays. Extra-OK: hop 421
 * responses-to-Gemini stays.
 */
export function usesOaiChatToResponsesUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  isStream = false,
): boolean {
  if (isStream) return false;
  if (mode !== "responses") return false;
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  return String(converter || CONVERTER_NONE).trim() === CONVERTER_RESPONSES_TO_CHAT;
}

/**
 * Original `OaiChatToResponsesHandler` `common.Unmarshal` into
 * `dto.OpenAITextResponse`. Syntax errors match `encoding/json`. JSON `null`
 * succeeds as a zero-value struct.
 */
export function oaiChatToResponsesResponseUnmarshalError(text: string): string | null {
  return openaiHandlerResponseUnmarshalError(text, "chat");
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` ConverterOpenAIChatToOpenAIResponses
 * stream uses `OaiResponsesToChatStreamHandler` (`UnmarshalJsonStr` into
 * `dto.ResponsesStreamResponse` then `sr.Error` leftover `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Not `FailResponsesStream` (target is Chat).
 * Extra-OK: hop 442/443 responses-to-chat stay. Extra-OK: hop 438 Ollama
 * OpenAI stream stays. Extra-OK: replica buffers leftover gin.H before SSE
 * headers (original `SetEventStreamHeaders` runs first). Extra-OK: hop 445
 * non-stream `OaiResponsesToChatHandler` leftover gin.H stays.
 */
export function usesOaiResponsesToChatStreamUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  isStream = true,
): boolean {
  if (!isStream) return false;
  if (mode === "responses" || mode === "images" || mode === "embeddings" || mode === "engines_embeddings") return false;
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  return String(converter || CONVERTER_NONE).trim() === CONVERTER_CHAT_TO_RESPONSES;
}

/** Original `OaiResponsesToChatStreamHandler` `UnmarshalJsonStr` target type. */
export function oaiResponsesToChatStreamUnmarshalTypeName(): string {
  return "dto.ResponsesStreamResponse";
}

/**
 * Original `OaiResponsesToChatStreamHandler` `UnmarshalJsonStr` into
 * `dto.ResponsesStreamResponse` for the first invalid SSE `data:` payload.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct.
 */
export function oaiResponsesStreamEventUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${oaiResponsesToChatStreamUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `OaiResponsesToChatStreamHandler` first invalid SSE `data:` payload.
 */
export function oaiResponsesToChatStreamSseUnmarshalError(text: string): string | null {
  for (const payload of claudeStreamSseDataPayloads(text)) {
    const err = oaiResponsesStreamEventUnmarshalError(payload);
    if (err) return err;
  }
  return null;
}

/**
 * Original `advancedcustom.Adaptor.DoResponse` ConverterOpenAIChatToOpenAIResponses
 * non-stream uses `OaiResponsesToChatHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody` into `dto.OpenAIResponsesResponse`). Stream stays hop
 * 444 (`OaiResponsesToChatStreamHandler` leftover gin.H). Extra-OK: hop 443
 * responses-to-chat stays. Extra-OK: hop 365/371 native via-responses JSON stays.
 * Extra-OK: hop 446 native via-responses buffered stream leftover gin.H stays.
 */
export function usesOaiResponsesToChatUnmarshal(
  channelType: number,
  mode: string,
  converter = "none",
  isStream = false,
): boolean {
  if (isStream) return false;
  if (mode === "responses" || mode === "images" || mode === "embeddings" || mode === "engines_embeddings") return false;
  if (channelType !== CHANNEL_TYPE_ADVANCED_CUSTOM) return false;
  return String(converter || CONVERTER_NONE).trim() === CONVERTER_CHAT_TO_RESPONSES;
}

/**
 * Original `OaiResponsesToChatHandler` `common.Unmarshal` into
 * `dto.OpenAIResponsesResponse`. Syntax errors match `encoding/json`. JSON `null`
 * succeeds as a zero-value struct.
 */
export function oaiResponsesToChatResponseUnmarshalError(text: string): string | null {
  return openaiHandlerResponseUnmarshalError(text, "responses");
}

/**
 * Original `textRequestViaResponses` non-stream client + upstream SSE uses
 * `OaiResponsesToChatBufferedStreamHandler` (`UnmarshalJsonStr` into
 * `dto.ResponsesStreamResponse` then leftover `NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Client stream stays hop 444 advanced-custom or
 * native `OaiResponsesToChatStreamHandler`. Extra-OK: hop 371/445 non-stream
 * JSON leftover gin.H stays. Extra-OK: log prefix
 * `failed to unmarshal buffered responses stream event` is not in leftover gin.H.
 */
export function usesOaiResponsesToChatBufferedStreamUnmarshal(
  viaResponses: boolean,
  isStream = false,
): boolean {
  if (isStream) return false;
  return Boolean(viaResponses);
}

/**
 * Original `OaiResponsesToChatBufferedStreamHandler` first invalid SSE `data:`
 * payload. Same `dto.ResponsesStreamResponse` encoding/json as hop 444.
 */
export function oaiResponsesToChatBufferedStreamSseUnmarshalError(text: string): string | null {
  return oaiResponsesToChatStreamSseUnmarshalError(text);
}

/**
 * Original `OpenaiImageStreamHandler` non-SSE upstream uses
 * `openaiImageJSONAsStreamHandler` (`common.Unmarshal` `NewOpenAIError`
 * `ErrorCodeBadResponseBody` into `dto.SimpleResponse`) before wrapping JSON
 * as image SSE. Real SSE image streams unmarshal per-chunk with log/continue
 * (not leftover gin.H). Extra-OK: hop 365 non-stream `OpenaiImageHandler`
 * leftover gin.H stays. Extra-OK: hop 446 via-responses buffered stream stays.
 */
export function usesOpenaiImageJSONAsStreamUnmarshal(
  channelType: number,
  mode: string,
  isStream = true,
  contentType = "",
): boolean {
  if (!isStream) return false;
  if (mode !== "images") return false;
  if (!usesOpenAIAdaptor(channelType)) return false;
  return !String(contentType || "").toLowerCase().includes("text/event-stream");
}

/**
 * Original `openaiImageJSONAsStreamHandler` `common.Unmarshal` into
 * `dto.SimpleResponse`. Syntax errors match `encoding/json`. JSON `null`
 * succeeds as a zero-value struct.
 */
export function openaiImageJSONAsStreamResponseUnmarshalError(text: string): string | null {
  return openaiHandlerResponseUnmarshalError(text, "images");
}

/** Original `OaiChatToResponsesStreamHandler` `UnmarshalJsonStr` target type. */
export function oaiChatToResponsesStreamUnmarshalTypeName(): string {
  return "dto.ChatCompletionsStreamResponse";
}

/**
 * Original `OaiChatToResponsesStreamHandler` `UnmarshalJsonStr` into
 * `dto.ChatCompletionsStreamResponse`. Syntax errors match `encoding/json`.
 * JSON `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails). Extra-OK: the prior
 * `dto.OpenAITextResponse` error-envelope Unmarshal is skipped on failure
 * (original then unmarshals the chat chunk).
 */
export function oaiChatStreamChunkUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${oaiChatToResponsesStreamUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `OaiChatToResponsesStreamHandler` first invalid SSE `data:` payload.
 * `FailResponsesStream` uses encoding/json `err.Error()` (not the log prefix
 * `failed to unmarshal chat stream response`).
 */
export function oaiChatToResponsesStreamSseUnmarshalError(text: string): string | null {
  for (const payload of claudeStreamSseDataPayloads(text)) {
    const err = oaiChatStreamChunkUnmarshalError(payload);
    if (err) return err;
  }
  return null;
}

/**
 * Original `codex.Adaptor.DoResponse` responses uses `openai.OaiResponsesHandler`
 * (`common.Unmarshal` `NewOpenAIError` `ErrorCodeBadResponseBody`). Compact uses
 * `openai.OaiResponsesCompactionHandler` (`dto.OpenAIResponsesCompactionResponse`).
 * Stream uses `openai.OaiResponsesStreamHandler` (log/continue, not leftover
 * gin.H). Chat / embeddings / images / audio / rerank Convert
 * `"endpoint not supported"` before DoResponse (hop 350). Alpha search stays
 * `AlphaSearchHelper` (`ErrorCodeInvalidRequest`). Extra-OK: ConvertClaudeRequest
 * / ConvertGeminiRequest `"not supported"` stay hop 350. Extra-OK: hop 404
 * advanced-custom stays.
 */
export function usesCodexUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_CODEX && mode === "responses";
}

/**
 * Original `openai.OaiResponsesHandler` / `OaiResponsesCompactionHandler`
 * `common.Unmarshal` for Codex. Syntax errors match `encoding/json`. JSON
 * `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails).
 */
export function codexResponseUnmarshalError(text: string, mode = "responses"): string | null {
  return openaiHandlerResponseUnmarshalError(text, mode);
}

/**
 * Original `claude.Adaptor.DoResponse` non-stream uses `ClaudeHandler` →
 * `HandleClaudeResponseData` (`common.Unmarshal` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). Always ClaudeHandler
 * regardless of RelayFormat (OpenAI / Claude / Gemini / Responses). Stream uses
 * `ClaudeStreamHandler` `HandleStreamResponseData` (hop 422). Extra-OK:
 * `ClaudeResponsesStreamHandler` stays hop 439 (`FailResponsesStream` /
 * leftover `NewOpenAIError` when unhandled). Images /
 * audio / embeddings Convert `"not implemented"` before DoResponse (hop 350).
 * ConvertRerank is `nil,nil` leftover. Extra-OK: hop 405 Codex stays. Extra-OK:
 * Moonshot / MiniMax / Deepseek / Zhipu v4 Claude-format, AWS API-key, Vertex
 * Claude, NEW_API / SUB2API Claude, Ollama Claude, Ali anthropic-messages, Volc
 * special-base stay later hops.
 */
export function usesClaudeHandlerUnmarshal(channelType: number, mode: string): boolean {
  if (channelType !== CHANNEL_TYPE_ANTHROPIC) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "engines_embeddings":
      return false;
    default:
      return true;
  }
}

/** Original `common.Unmarshal` target type name for ClaudeHandler DoResponse. */
export function claudeHandlerUnmarshalTypeName(): string {
  return "dto.ClaudeResponse";
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse`. Syntax errors match `encoding/json`. JSON `null`
 * succeeds as a zero-value struct. Extra-OK: nested field type mismatches are
 * left to convert (original fails).
 */
export function claudeHandlerResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${claudeHandlerUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `claude.Adaptor.DoResponse` stream uses `ClaudeStreamHandler` →
 * `HandleStreamResponseData` (`common.UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). Always ClaudeStreamHandler
 * regardless of RelayFormat except OpenAIResponses stream
 * (`ClaudeResponsesStreamHandler`, hop 439, typically `FailResponsesStream`). Images /
 * audio / embeddings Convert `"not implemented"` before DoResponse (hop 350).
 * ConvertRerank is `nil,nil` leftover. Extra-OK: hop 406 non-stream
 * `ClaudeHandler` stays. Extra-OK: OaiStreamHandler log/continue stays.
 * Extra-OK: hop 421 responses-to-Gemini stays.
 */
export function usesClaudeStreamUnmarshal(channelType: number, mode: string, isStream = true): boolean {
  if (!isStream) return false;
  if (mode === "responses") return false;
  return usesClaudeHandlerUnmarshal(channelType, mode);
}

/**
 * Original `claude.Adaptor.DoResponse` OpenAIResponses stream uses
 * `ClaudeResponsesStreamHandler` (`UnmarshalJsonStr` into `dto.ClaudeResponse`).
 * Typical path is `FailResponsesStream("server_error", err.Error(), "")` SSE
 * (HTTP 200), not leftover gin.H. Leftover `NewOpenAIError`
 * `ErrorCodeBadResponseBody` only when `FailResponsesStream` is unhandled.
 * Extra-OK: hop 422 `ClaudeStreamHandler` leftover gin.H stays. Extra-OK: hop
 * 406 non-stream `ClaudeHandler` stays. Extra-OK: hop 438 Ollama OpenAI stream
 * stays. Extra-OK: replica convert always has `ChatToResponsesStreamState` so
 * `FailResponsesStream` is handled for `/v1/responses`.
 */
export function usesClaudeResponsesStreamUnmarshal(channelType: number, mode: string, isStream = true): boolean {
  if (!isStream) return false;
  if (mode !== "responses") return false;
  return usesClaudeHandlerUnmarshal(channelType, mode);
}

/**
 * Original `ClaudeResponsesStreamHandler` `UnmarshalJsonStr` into
 * `dto.ClaudeResponse` for the first invalid SSE `data:` payload. Same
 * encoding/json semantics as `ClaudeStreamHandler`.
 */
export function claudeResponsesStreamSseUnmarshalError(text: string): string | null {
  return claudeStreamSseUnmarshalError(text);
}

/**
 * Original `StreamScannerHandler` `data:` payloads (strip `data:`, TrimSpace,
 * skip empty / `[DONE]`). Lines shorter than 6 or without a `data:` /
 * `[DONE]` prefix are ignored. `[DONE]` stops further payloads.
 */
export function claudeStreamSseDataPayloads(text: string): string[] {
  const payloads: string[] = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
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
 * Original `HandleStreamResponseData` `UnmarshalJsonStr` into
 * `dto.ClaudeResponse` for the first invalid SSE `data:` payload. Syntax
 * errors match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 * Extra-OK: replica buffers and returns leftover gin.H before SSE headers
 * (original `SetEventStreamHeaders` runs first).
 */
export function claudeStreamSseUnmarshalError(text: string): string | null {
  for (const payload of claudeStreamSseDataPayloads(text)) {
    const err = claudeHandlerResponseUnmarshalError(payload);
    if (err) return err;
  }
  return null;
}

/**
 * Original AWS API-key `aws.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). AKSK Nova stays `handleNovaRequest` (hop 385).
 * Images / audio / embeddings / responses Convert `"not implemented"` before
 * DoResponse (hop 350). ConvertRerank is `nil,nil` leftover. Stream stays hop
 * 425 (`ClaudeStreamHandler`). Extra-OK: hop 406 Anthropic stays. Extra-OK:
 * hop 418 AKSK Claude `awsHandler` stays.
 */
export function usesAwsClaudeUnmarshal(channelType: number, mode: string, settings?: string | null): boolean {
  if (channelType !== CHANNEL_TYPE_AWS) return false;
  const raw = String(settings || "").trim();
  let apiKey = false;
  if (raw) {
    const parsed = goUnmarshalJSON(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      apiKey = (parsed.value as Record<string, unknown>).aws_key_type === "api_key";
    }
  }
  if (!apiKey) return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "engines_embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for AWS API-key. Syntax errors match `encoding/json`.
 * JSON `null` succeeds as a zero-value struct. Extra-OK: nested field type
 * mismatches are left to convert (original fails).
 */
export function awsClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original AWS API-key `aws.Adaptor.DoResponse` stream delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeStreamHandler` `HandleStreamResponseData`
 * `UnmarshalJsonStr` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). AKSK stream stays hop 424 (`awsStreamHandler`). Nova
 * stays hop 385. Extra-OK: hop 407 non-stream `ClaudeHandler` stays. Extra-OK:
 * hop 422 Anthropic stream stays. Extra-OK: hop 423 Gemini stream stays.
 */
export function usesAwsClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  settings?: string | null,
  isStream = true,
): boolean {
  if (!isStream) return false;
  return usesAwsClaudeUnmarshal(channelType, mode, settings);
}

/**
 * Original AWS AKSK non-Nova `aws.Adaptor.DoResponse` `awsHandler`
 * (`HandleClaudeResponseData` `common.Unmarshal` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). API-key stays hop
 * 407 (`claude.Adaptor`). Nova stays hop 385 (`handleNovaRequest`). Stream
 * uses `awsStreamHandler` `HandleStreamResponseData` (hop 424). Images / audio /
 * embeddings / responses Convert `"not implemented"` before DoResponse (hop
 * 350). ConvertRerank is `nil,nil` leftover. Extra-OK: hop 407 API-key stays.
 * Extra-OK: hop 385 Nova stays. Extra-OK: hop 417 Volc Claude stays.
 */
export function usesAwsAkskClaudeUnmarshal(
  channelType: number,
  model: string,
  mode: string,
  settings?: string | null,
): boolean {
  if (channelType !== CHANNEL_TYPE_AWS) return false;
  if (isNovaModel(model)) return false;
  const raw = String(settings || "").trim();
  if (raw) {
    const parsed = goUnmarshalJSON(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      if ((parsed.value as Record<string, unknown>).aws_key_type === "api_key") return false;
    }
  }
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "engines_embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for AWS AKSK non-Nova `awsHandler`. Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function awsAkskClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original AWS AKSK non-Nova `aws.Adaptor.DoResponse` stream uses
 * `awsStreamHandler` → `HandleStreamResponseData` (`UnmarshalJsonStr`
 * `NewError` `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`) on each
 * Bedrock chunk's Claude JSON. Replica `decodeAwsEventStreamResponse` rewrites
 * eventstream to Claude SSE `data:` payloads first. API-key stream stays hop
 * 425 (`claude.Adaptor` `ClaudeStreamHandler`). Nova stays hop 385.
 * Extra-OK: hop 418 non-stream `awsHandler` stays. Extra-OK: hop 422 Anthropic
 * stream stays. Extra-OK: hop 423 Gemini stream stays.
 */
export function usesAwsAkskClaudeStreamUnmarshal(
  channelType: number,
  model: string,
  mode: string,
  settings?: string | null,
  isStream = true,
): boolean {
  if (!isStream) return false;
  return usesAwsAkskClaudeUnmarshal(channelType, model, mode, settings);
}

/**
 * Original Vertex `RequestModeClaude` `vertex.Adaptor.DoResponse` delegates to
 * `claude.Adaptor.DoResponse` (`ClaudeHandler` `HandleClaudeResponseData`
 * `common.Unmarshal` `NewError` `ErrorCodeBadResponseBody` into
 * `dto.ClaudeResponse`). Gemini RequestMode stays hop 360. OpenSource stays
 * hop 390. Audio / embeddings / responses Convert `"not implemented"` before
 * DoResponse (hop 350). ConvertRerank is `nil,nil` leftover. Extra-OK: hop 407
 * AWS API-key stays. Stream stays hop 426 (`ClaudeStreamHandler`). Extra-OK:
 * hop 425 AWS API-key stream stays. Extra-OK: hop 423 Gemini stream stays.
 */
export function usesVertexClaudeUnmarshal(channelType: number, mode: string, model: string): boolean {
  if (channelType !== CHANNEL_TYPE_VERTEX) return false;
  if (vertexRequestMode(model) !== "claude") return false;
  switch (mode) {
    case "images":
    case "realtime":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "embeddings":
    case "engines_embeddings":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original `HandleClaudeResponseData` `common.Unmarshal` into
 * `dto.ClaudeResponse` for Vertex RequestModeClaude. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function vertexClaudeResponseUnmarshalError(text: string): string | null {
  return claudeHandlerResponseUnmarshalError(text);
}

/**
 * Original Vertex `RequestModeClaude` `vertex.Adaptor.DoResponse` stream
 * delegates to `claude.Adaptor.DoResponse` (`ClaudeStreamHandler`
 * `HandleStreamResponseData` `UnmarshalJsonStr` `NewError`
 * `ErrorCodeBadResponseBody` into `dto.ClaudeResponse`). Gemini stream stays
 * hop 423. OpenSource stream is Extra-OK OaiStreamHandler log/continue. Extra-OK:
 * hop 408 non-stream `ClaudeHandler` stays. Extra-OK: hop 425 AWS API-key
 * stream stays. Extra-OK: hop 422 Anthropic stream stays.
 */
export function usesVertexClaudeStreamUnmarshal(
  channelType: number,
  mode: string,
  model: string,
  isStream = true,
): boolean {
  if (!isStream) return false;
  return usesVertexClaudeUnmarshal(channelType, mode, model);
}

/**
 * Original `replicate.Adaptor.DoResponse` `common.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, wrap `"replicate adaptor: failed to decode
 * response: %w"`). Chat / embeddings / audio / rerank / responses Convert is
 * `"not implemented"` before DoResponse. Claude / Gemini Convert is
 * `"not implemented"` (hop 350). Image edits share RelayMode images.
 */
export function usesReplicateUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_REPLICATE && mode === "images";
}

/** Original `common.Unmarshal` target type name for Replicate DoResponse. */
export function replicateUnmarshalTypeName(): string {
  return "replicate.PredictionResponse";
}

/**
 * Original `common.Unmarshal` into `replicate.PredictionResponse`, wrapped as
 * `fmt.Errorf("replicate adaptor: failed to decode response: %w", err)`.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function replicateResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  const inner = !parsed.ok
    ? parsed.message
    : parsed.value === null
      ? null
      : typeof parsed.value !== "object" || Array.isArray(parsed.value)
        ? `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${replicateUnmarshalTypeName()}`
        : null;
  if (inner == null) return null;
  return `replicate adaptor: failed to decode response: ${inner}`;
}

/**
 * Original `minimax.handleTTSResponse` `json.Unmarshal` (`NewErrorWithStatusCode`
 * `ErrorCodeBadResponseBody` HTTP 500, wrap `"failed to unmarshal minimax TTS
 * response: %w"`). Chat / images use other DoResponse handlers. Extra-OK:
 * `base_resp` / empty audio stay hop 356 `bad_response` HTTP 400.
 */
export function usesMiniMaxTTSUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_MINIMAX && mode === "audio_speech";
}

/** Original `json.Unmarshal` target type name for MiniMax TTS. */
export function miniMaxTTSUnmarshalTypeName(): string {
  return "minimax.MiniMaxTTSResponse";
}

/**
 * Original `json.Unmarshal` into `minimax.MiniMaxTTSResponse`, wrapped as
 * `fmt.Errorf("failed to unmarshal minimax TTS response: %w", unmarshalErr)`.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct. Extra-OK: nested field type mismatches are left to convert
 * (original fails).
 */
export function miniMaxTTSResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  const inner = !parsed.ok
    ? parsed.message
    : parsed.value === null
      ? null
      : typeof parsed.value !== "object" || Array.isArray(parsed.value)
        ? `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${miniMaxTTSUnmarshalTypeName()}`
        : null;
  if (inner == null) return null;
  return `failed to unmarshal minimax TTS response: ${inner}`;
}

/**
 * Original `aws.handleNovaRequest` `json.Unmarshal` (`NewError`
 * `ErrorCodeBadResponseBody`, wrap `errors.Wrap(err, "unmarshal nova
 * response")`). AKSK only (`DoResponse` API-key uses `claude.Adaptor`).
 * Images / audio / embeddings / responses Convert is `"not implemented"`
 * before DoResponse (hop 350). Gemini Convert is `"not implemented"`
 * (hop 350). Extra-OK: Claude format stays `awsHandler`. Extra-OK: stream
 * stays worker SSE convert (original still uses non-stream InvokeModel).
 */
export function usesAwsNovaUnmarshal(
  channelType: number,
  model: string,
  mode: string,
  settings?: string | null,
): boolean {
  if (channelType !== CHANNEL_TYPE_AWS) return false;
  if (!isNovaModel(model)) return false;
  const raw = String(settings || "").trim();
  if (raw) {
    const parsed = goUnmarshalJSON(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      if ((parsed.value as Record<string, unknown>).aws_key_type === "api_key") return false;
    }
  }
  switch (mode) {
    case "images":
    case "embeddings":
    case "audio_speech":
    case "audio_translation":
    case "audio_transcription":
    case "rerank":
    case "responses":
      return false;
    default:
      return true;
  }
}

/**
 * Original anonymous `json.Unmarshal` target type name in
 * `aws.handleNovaRequest`.
 */
export function awsNovaUnmarshalTypeName(): string {
  return 'struct { Output struct { Message struct { Content []struct { Text string "json:\\"text\\"" } "json:\\"content\\"" } "json:\\"message\\"" } "json:\\"output\\""; Usage struct { InputTokens int "json:\\"inputTokens\\""; OutputTokens int "json:\\"outputTokens\\""; TotalTokens int "json:\\"totalTokens\\"" } "json:\\"usage\\"" }';
}

/**
 * Original `json.Unmarshal` into the Nova anonymous struct, wrapped as
 * `errors.Wrap(err, "unmarshal nova response")`. Syntax errors match
 * `encoding/json`. JSON `null` succeeds as a zero-value struct. Extra-OK:
 * nested field type mismatches are left to convert (original fails).
 */
export function awsNovaResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  const inner = !parsed.ok
    ? parsed.message
    : parsed.value === null
      ? null
      : typeof parsed.value !== "object" || Array.isArray(parsed.value)
        ? `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${awsNovaUnmarshalTypeName()}`
        : null;
  if (inner == null) return null;
  return `unmarshal nova response: ${inner}`;
}

/**
 * Original `ChannelOtherSettings.IsOpenRouterEnterprise` (`*bool`
 * `openrouter_enterprise`; nil/false is off).
 */
export function isOpenRouterEnterprise(settings: string | undefined | null): boolean {
  const raw = String(settings || "").trim();
  if (!raw) return false;
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return false;
  if (parsed.value == null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return false;
  return (parsed.value as Record<string, unknown>).openrouter_enterprise === true;
}

/**
 * Original `OpenaiHandler` OpenRouter enterprise unwrap (`ChannelTypeOpenRouter`
 * && `IsOpenRouterEnterprise`). Images / responses / audio / realtime / rerank
 * / stream use other handlers (Extra-OK stay).
 */
export function usesOpenRouterEnterpriseUnwrap(
  channelType: number,
  settings: string | undefined | null,
  mode: string,
): boolean {
  if (channelType !== CHANNEL_TYPE_OPENROUTER) return false;
  if (!isOpenRouterEnterprise(settings)) return false;
  switch (mode) {
    case "images":
    case "responses":
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

/** Original `common.Unmarshal` target type name for enterprise unwrap. */
export function openRouterEnterpriseUnmarshalTypeName(): string {
  return "openrouter.OpenRouterEnterpriseResponse";
}

/** Original `fmt.Errorf("openrouter response success=false")`. */
export const OPENROUTER_ENTERPRISE_SUCCESS_FALSE = "openrouter response success=false";

/**
 * Original `common.Unmarshal` into `openrouter.OpenRouterEnterpriseResponse`.
 * Syntax errors match `encoding/json`. JSON `null` succeeds as a zero-value
 * struct (`Success=false`). Extra-OK: nested field type mismatches are left
 * to convert (original fails).
 */
export function openRouterEnterpriseResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${openRouterEnterpriseUnmarshalTypeName()}`;
  }
  return null;
}

/**
 * Original `OpenaiHandler` enterprise unwrap before `OpenAITextResponse`.
 * Unmarshal fail and `Success=false` are `NewOpenAIError`
 * `ErrorCodeBadResponseBody`. `Success=true` replaces the body with `Data`
 * (`json.RawMessage`; missing `data` is empty bytes).
 */
export function unwrapOpenRouterEnterpriseResponse(
  text: string,
): { ok: true; body: string } | { ok: false; message: string } {
  const unmarshalErr = openRouterEnterpriseResponseUnmarshalError(text);
  if (unmarshalErr) return { ok: false, message: unmarshalErr };
  const parsed = goUnmarshalJSON(text);
  const value = parsed.ok ? parsed.value : null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: OPENROUTER_ENTERPRISE_SUCCESS_FALSE };
  }
  const obj = value as Record<string, unknown>;
  if (obj.success !== true) return { ok: false, message: OPENROUTER_ENTERPRISE_SUCCESS_FALSE };
  if (!Object.prototype.hasOwnProperty.call(obj, "data")) return { ok: true, body: "" };
  if (obj.data === undefined) return { ok: true, body: "" };
  if (obj.data === null) return { ok: true, body: "null" };
  return { ok: true, body: JSON.stringify(obj.data) };
}

/** Original `Path2RelayMode` `/v1/responses/compact` prefix → `RelayModeResponsesCompact`. */
export function isResponsesCompactPath(path: string): boolean {
  return path.startsWith("/v1/responses/compact");
}

/** Original `common.Unmarshal` target type name for `openai.Adaptor.DoResponse`. */
export function openaiHandlerUnmarshalTypeName(mode: string): string {
  if (mode === "images") return "dto.SimpleResponse";
  if (mode === "responses") return "dto.OpenAIResponsesResponse";
  if (mode === "responses_compact") return "dto.OpenAIResponsesCompactionResponse";
  return "dto.OpenAITextResponse";
}

/**
 * Original `OpenaiHandler` vs `OaiResponsesToChatHandler` vs
 * `OaiResponsesCompactionHandler` unmarshal target. Chat via-responses
 * unmarshals `dto.OpenAIResponsesResponse` (not chat). Compact unmarshals
 * `dto.OpenAIResponsesCompactionResponse` (not hop 365 responses).
 */
export function openaiDoResponseUnmarshalMode(mode: string, viaResponses = false, requestPath = ""): string {
  if (viaResponses) return "responses";
  if (isResponsesCompactPath(requestPath)) return "responses_compact";
  return mode;
}

/**
 * Original `common.Unmarshal` into `OpenAITextResponse` / `SimpleResponse` /
 * `OpenAIResponsesResponse` / `OpenAIResponsesCompactionResponse`. Syntax
 * errors match `encoding/json`. JSON `null` succeeds as a zero-value struct.
 * Non-object JSON is `json: cannot unmarshal … into Go value of type dto.*`.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
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
