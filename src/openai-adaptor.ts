/** Original `relay.GetAdaptor` → `openai.Adaptor` (APITypeOpenAI, OpenRouter, Xinference, unknown→OpenAI). */

import { isNovaModel } from "./aws-convert.js";
import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";
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
 * Original `ollama.ollamaEmbeddingHandler` / `ollama.ollamaChatHandler`
 * `common.Unmarshal` (`NewOpenAIError` `ErrorCodeBadResponseBody`). Stream uses
 * `ollamaStreamHandler` (log/continue, not leftover gin.H). Responses uses
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
 * Original `zhipu_4v.zhipu4vImageHandler` `common.Unmarshal` (`NewOpenAIError`
 * `ErrorCodeBadResponseBody`). Chat / embeddings / responses use
 * `openai.Adaptor.DoResponse`. Claude format uses `claude.Adaptor.DoResponse`.
 * Audio Convert is `"not implemented"` before DoResponse.
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
