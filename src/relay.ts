import { csv, CHANNEL_TYPE_ADVANCED_CUSTOM, CHANNEL_TYPE_ALI, CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_AWS, CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_CLOUDFLARE, CHANNEL_TYPE_CODEX, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_COZE, CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_DIFY, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_JIMENG, CHANNEL_TYPE_JINA, CHANNEL_TYPE_MINIMAX, CHANNEL_TYPE_MOKA, CHANNEL_TYPE_NEW_API, CHANNEL_TYPE_OLLAMA, CHANNEL_TYPE_PALM, CHANNEL_TYPE_REPLICATE, CHANNEL_TYPE_SILICONFLOW, CHANNEL_TYPE_SUB2API, CHANNEL_TYPE_SUBMODEL, CHANNEL_TYPE_TASK_PLUGIN, CHANNEL_TYPE_TENCENT, CHANNEL_TYPE_VERTEX, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI, CHANNEL_TYPE_XUNFEI, CHANNEL_TYPE_ZHIPU, CHANNEL_TYPE_ZHIPU_V4, CLAUDE_VERSION, LOG_CONSUME, LOG_ERROR, parseBool, parseJson, tokenModelLimitsMap } from "./constants.js";
import { recordRelayPerf } from "./perf-metrics.js";
import {
  anthropicToOpenAI,
  convertAdvancedCustomClaudeRequest,
  convertAdvancedCustomGeminiRequest,
  convertClaudeRequest,
  convertGeminiRequest,
  convertOllamaEmbeddingRequest,
  convertOpenAIRequest,
  convertOpenAIResponsesRequest,
  convertTextRequestViaResponses,
  convertOpenAIAdaptorClaudeRequest,
  convertOpenAIAdaptorGeminiRequest,
  convertVolcClaudeRequest,
  convertDeepSeekClaudeRequest,
  openaiFromXaiResponse,
  xaiSseToOpenAIChat,
  nativeClaudeGeminiConvertError,
  nativeOpenAIConvertEndpointError,
  extractGeminiModelAction,
  geminiToOpenAIChat,
  openaiFromAnthropicResponse,
  claudeResponseToResponsesResponse,
  geminiResponseToResponsesResponse,
  responsesResponseToChatCompletion,
  shouldChatCompletionsUseResponsesPolicy,
  type ChatCompletionsToResponsesPolicy,
  openaiFromGeminiEmbedding,
  openaiFromGeminiResponse,
  openaiChatToClaudeResponse,
  openaiChatToGeminiResponse,
  openaiToAnthropic,
  openaiToGemini,
  sseFromOpenAIChatCompletion,
  sseOpenAIFromText,
  emptyOpenAIUsageCounts,
  usageFromOpenAI,
  convertClaudeMessagesToGeminiGenerateContent,
  convertGeminiGenerateContentToClaudeMessages,
  geminiResponseToClaudeMessages,
  claudeResponseToGeminiChat,
  geminiSseToClaudeSse,
  claudeSseToGeminiSse,
  applyGeminiChannelSystemPrompt,
  applyClaudeChannelSystemPrompt,
  applyChatChannelSystemPrompt,
  getOpenAISystemRoleName,
} from "./convert.js";
import { claudeUpstreamToOpenAIChat } from "./claude-response.js";
import { geminiChatEmptyCandidatesError, geminiChatResponseUnmarshalError, geminiChatStreamSseUnmarshalError, geminiUpstreamToOpenAIChat, usesGeminiChatStreamUnmarshal } from "./gemini-response.js";
import { compactUuid, looksLikeSse } from "./openai-usage.js";
import { convertAwsClaudeRequest, isNovaModel, openaiFromNovaResponse } from "./aws-convert.js";
import { openAIHttpMediaDialect, prefetchOpenAIHttpMedia } from "./openai-media.js";
import { applyAwsAkskAuth } from "./aws-auth.js";
import { decodeAwsEventStreamResponse } from "./aws-eventstream.js";
import { openaiFromOllamaChatResponse, openaiFromOllamaEmbedding, ollamaUpstreamToOpenAIChat } from "./ollama-convert.js";
import { convertVertexClaudeRequest, convertVertexGeminiRequest, imagenUsage, openaiFromImagenResponse, vertexRequestMode } from "./vertex-convert.js";
import { applyBaiduAccessToken, convertBaiduEmbeddingRequest, openaiFromBaiduEmbedding, openaiFromBaiduResponse, baiduUpstreamToOpenAIChat } from "./baidu-convert.js";
import { convertCohereRerankRequest, openaiFromCohereResponse, openaiFromCohereRerank, cohereUpstreamToOpenAIChat } from "./cohere-convert.js";
import { completeCozeNonStreamChat, openaiFromCozeDetailResponse, cozeUpstreamToOpenAIChat, type CozeUsage } from "./coze-convert.js";
import { openaiFromDifyResponse, difyUpstreamToOpenAIChat, convertDifyOpenAIRequestWithUploads } from "./dify-convert.js";
import { applyVertexAdcAuth } from "./vertex-auth.js";
import { applyZhipuV3Authorization, openaiFromZhipuResponse, openaiFromZhipuV4Image, zhipuUpstreamToOpenAIChat } from "./zhipu-convert.js";
import {
  cloudflareSTTUsage,
  cloudflareUpstreamToOpenAIChat,
  convertCloudflareAudioRequest,
  isCloudflareSTTRelayMode,
  openaiFromCloudflareResponse,
  openaiFromCloudflareSTT,
} from "./cloudflare-convert.js";
import { applyTencentTc3Authorization, openaiFromTencentResponse, tencentUpstreamToOpenAIChat, tencentUsesNativeAdaptor } from "./tencent-convert.js";
import { openaiFromMokaEmbedding } from "./moka-convert.js";
import { openaiFromJinaRerank } from "./jina-convert.js";
import { openaiFromSiliconFlowRerank } from "./siliconflow-convert.js";
import { openaiFromPalmResponse, palmUpstreamToOpenAIChat } from "./palm-convert.js";
import { dialOpenAIRealtimeWebSocket, openaiRealtimeUpstream } from "./openai-realtime.js";
import {
  accumulateRealtimeUsage,
  applyClientRealtimeEvent,
  applyUpstreamRealtimeEvent,
  emptyOpenaiRealtimeHandlerState,
  parseRealtimeEvent,
  remainingRealtimePreConsume,
  websocketMessageText,
  calculateAudioQuota,
  type RealtimeUsage,
} from "./openai-realtime-usage.js";
import { loadWssPriceData, postWssConsumeQuota, preWssConsumeQuota } from "./openai-realtime-billing.js";
import { parseXunfeiAuth, runXunfeiChat } from "./xunfei-convert.js";
import {
  parseVolcengineAuth,
  runVolcTtsWebSocket,
  volcTtsEncodingFromRequest,
  volcTtsIsStream,
  wrapVolcTtsHttpResponse,
} from "./volc-tts.js";
import { openaiFromReplicatePrediction } from "./replicate-convert.js";
import { applyJimengAuthorization, openaiFromJimengImage } from "./jimeng-convert.js";
import { miniMaxTTSDoResponse, openaiFromMiniMaxImage } from "./minimax-convert.js";
import {
  aliImageIsSync,
  convertAliFormEditFromRaw,
  isAliImageEdits,
  openaiFromAliImage,
  openaiFromAliRerank,
  supportsAliAnthropicMessages,
} from "./ali-convert.js";
import { convertOpenAIImageEditForm, usesOpenAIImageEditAdaptor, type OpenAIImageEditForm } from "./openai-image-convert.js";
import { convertOpenAIAudioForm, usesOpenAIAudioAdaptor } from "./openai-audio-convert.js";
import { applyTextHelperStreamOptions, aliSiliconflowRerankResponseUnmarshalError, awsNovaResponseUnmarshalError, baiduResponseUnmarshalError, cloudflareResponseUnmarshalError, cohereChatResponseUnmarshalError, cohereRerankResponseUnmarshalError, cozeResponseUnmarshalError, delegatesClaudeToOpenAIAdaptor, difyResponseUnmarshalError, jimengChatResponseUnmarshalError, jimengResponseUnmarshalError, jinaEmbeddingsResponseUnmarshalError, mistralChatResponseUnmarshalError, vertexOpenSourceResponseUnmarshalError, perplexityResponseUnmarshalError, siliconflowResponseUnmarshalError, deepseekResponseUnmarshalError, moonshotResponseUnmarshalError, baiduV2ResponseUnmarshalError, aliResponseUnmarshalError, aliImageResponseUnmarshalError, volcResponseUnmarshalError, miniMaxResponseUnmarshalError, miniMaxImageResponseUnmarshalError, mokaResponseUnmarshalError, submodelChatResponseUnmarshalError, ollamaResponseUnmarshalError, openaiDoResponseUnmarshalMode, openaiHandlerResponseUnmarshalError, palmTencentZhipuResponseUnmarshalError, rerankHandlerResponseUnmarshalError, unwrapOpenRouterEnterpriseResponse, usesAliSiliconflowRerankUnmarshal, usesAwsNovaUnmarshal, usesBaiduUnmarshal, usesClaudeAdaptorForClaudeRequest, usesCloudflareUnmarshal, usesCohereChatUnmarshal, usesCohereRerankUnmarshal, usesCozeUnmarshal, usesDifyUnmarshal, usesJimengChatUnmarshal, usesJimengUnmarshal, usesJinaEmbeddingsUnmarshal, usesMistralChatUnmarshal, usesVertexOpenSourceUnmarshal, usesPerplexityUnmarshal, usesSiliconflowUnmarshal, usesDeepseekUnmarshal, usesMoonshotUnmarshal, usesBaiduV2Unmarshal, usesAliUnmarshal, usesAliImageUnmarshal, usesVolcUnmarshal, usesMiniMaxUnmarshal, usesMiniMaxImageUnmarshal, usesMokaUnmarshal, usesSubmodelChatUnmarshal, usesOllamaUnmarshal, usesOpenAIAdaptor, usesOpenaiHandlerGetOpenAIError, usesOpenRouterEnterpriseUnwrap, usesPalmTencentZhipuUnmarshal, usesRerankHandlerUnmarshal, usesTextHelperStreamOptions, usesMiniMaxTTSUnmarshal, usesReplicateUnmarshal, usesXaiUnmarshal, usesZhipuV4Unmarshal, usesZhipuV4ImageUnmarshal, usesNewApiUnmarshal, usesSub2apiUnmarshal, usesAdvancedCustomUnmarshal, usesAdvancedCustomClaudeUnmarshal, usesAdvancedCustomGeminiUnmarshal, usesCodexUnmarshal, usesClaudeHandlerUnmarshal, usesClaudeStreamUnmarshal, usesAwsClaudeUnmarshal, usesAwsAkskClaudeUnmarshal, usesVertexClaudeUnmarshal, usesMoonshotClaudeUnmarshal, usesMiniMaxClaudeUnmarshal, usesDeepseekClaudeUnmarshal, usesZhipuV4ClaudeUnmarshal, usesNewApiClaudeUnmarshal, usesSub2apiClaudeUnmarshal, usesOllamaClaudeUnmarshal, usesAliClaudeUnmarshal, usesVolcClaudeUnmarshal, miniMaxTTSResponseUnmarshalError, replicateResponseUnmarshalError, xaiResponseUnmarshalError, zhipuV4ResponseUnmarshalError, zhipuV4ImageResponseUnmarshalError, newApiResponseUnmarshalError, sub2apiResponseUnmarshalError, advancedCustomResponseUnmarshalError, advancedCustomClaudeResponseUnmarshalError, advancedCustomGeminiResponseUnmarshalError, codexResponseUnmarshalError, claudeHandlerResponseUnmarshalError, claudeStreamSseUnmarshalError, awsClaudeResponseUnmarshalError, awsAkskClaudeResponseUnmarshalError, vertexClaudeResponseUnmarshalError, moonshotClaudeResponseUnmarshalError, miniMaxClaudeResponseUnmarshalError, deepseekClaudeResponseUnmarshalError, zhipuV4ClaudeResponseUnmarshalError, newApiClaudeResponseUnmarshalError, sub2apiClaudeResponseUnmarshalError, ollamaClaudeResponseUnmarshalError, aliClaudeResponseUnmarshalError, volcClaudeResponseUnmarshalError } from "./openai-adaptor.js";
import { newApiUnsupportedEndpoint } from "./newapi-convert.js";
import type { EncodedMultipart } from "./multipart-form.js";
import {
  abortWithOpenAiMessage,
  clientIp,
  ERROR_CODE_BAD_RESPONSE_BODY,
  ERROR_CODE_CHANNEL_INVALID_KEY,
  ERROR_CODE_CONVERT_REQUEST_FAILED,
  ERROR_CODE_DO_REQUEST_FAILED,
  ERROR_CODE_GET_CHANNEL_FAILED,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_TYPE_NEW_API_ERROR,
  getChannelRetryFailedMessage,
  resetNewAPIErrorStatusCode,
  groupAccessDeniedMessage,
  json,
  modelNameRequiredMessage,
  noAvailableChannelMessage,
  noAvailableChannelRetryMessage,
  leftoverWithOpenAIError,
  getOpenAIError,
  openaiError,
  relayErrorHandler,
  writeOpenaiHandlerOpenAIError,
  writeOpenaiHandlerUnmarshalError,
  tokenModelForbiddenMessage,
  writeGeminiChatEmptyCandidatesError,
  writeGeminiChatUnmarshalError,
  writeRelayNewAPIError,
} from "./http.js";
import { applyGetAndValidateRequest } from "./valid-request.js";
import { estimateRequestPromptTokens, getTokenCountMeta } from "./token-count.js";
import { applyChannelParamOverride, asParamOverrideReturnError, channelParamOverrideMap, ParamOverrideReturnError, requestHeadersFrom, type ParamOverrideRelayInfo } from "./param-override.js";
import { removeDisabledFields, usesRemoveDisabledFields, type ChannelDisabledFieldSettings } from "./relay-disabled-fields.js";
import {
  DEFAULT_CLAUDE_MAX_TOKENS,
  DEFAULT_EFFORT_TAIL_MODEL_IDS,
  DEFAULT_GEMINI_VERSION_SETTINGS,
  DEFAULT_THINKING_MODEL_BLACKLIST,
  ReasoningClientError,
  applyReasoningModelSuffix,
  convertAliOpenAIRequest,
  type ReasoningHostSettings,
} from "./reasoning.js";
import {
  cachedTokenRateModeByClientFormat,
  channelAffinityLogInfo,
  observeChannelAffinityUsageCache,
  recordChannelAffinity,
  type ChannelAffinityResolution,
} from "./channel-affinity.js";
import { cacheGetRandomSatisfiedChannel, increaseChannelSelectRetry, selectDistributedChannel } from "./channel-select.js";
import { PIN_RETRY_SAME_CHANNEL, PIN_RETRY_SINGLE_ATTEMPT, type ChannelPin } from "./channel-constraint.js";
import { retryStatusCodeRangesFromOption, shouldRetryByStatusCode } from "./status-code-ranges.js";
import {
  channelAttemptFromNewApi,
  channelAttemptFromUpstream,
  processChannelError,
  type ChannelAttemptError,
} from "./channel-error.js";
import type { OriginTaskRef } from "./origin-task.js";
import {
  billingSessionLogFields,
  preConsumeBilling,
  prepareImageBillingForRequest,
  refundBilling,
  settleBilling,
  type BillingSession,
} from "./billing-session.js";
import {
  textConsumePriceData,
  audioConsumeLogRatios,
  computeQuota,
  consumeLogModelName,
  modelPriceHelperQuotaToPreConsumeFromStore,
  modelPriceHelperReject,
  resolveBillingModelNameFromStore,
  storeLogQuota,
} from "./quota.js";
import {
  calculateTextQuotaFromStore,
  composeTieredTextQuota,
  noteQuotaClamp,
  postTextAudioInputQuota,
  postTextConsumeLogContent,
  postTextConsumeLogParts,
  postTextToolSurchargeQuota,
  textHasBillableUsage,
} from "./text-quota.js";
import { decodeToolPricesJSON, TOOL_PRICE_OPTION_KEY } from "./tool-price.js";
import {
  applyToolUsageFromJson,
  builtInToolCallCounts,
  createToolUsageState,
  finishOpenAIChatStreamToolUsage,
  ingestUpstreamToolUsage,
  type ToolUsageState,
} from "./tool-usage.js";
import {
  applySseScannerEndReason,
  StreamStatus,
  STREAM_END_REASON_DONE,
  STREAM_END_REASON_EOF,
  STREAM_END_REASON_SCANNER_ERR,
} from "./stream-status.js";
import { mapModel, pickChannelKey } from "./select.js";
import { parseChannelInfo } from "./channel-info.js";
import {
  buildAdvancedCustomModelListRequest,
  buildAdvancedCustomRelayTarget,
  resolveAdvancedCustomConverter,
  shouldApplyAdvancedCustomClaudeHeaders,
} from "./channel-validate.js";
import {
  CONVERTER_CHAT_TO_CLAUDE,
  CONVERTER_CHAT_TO_GEMINI,
  CONVERTER_CHAT_TO_RESPONSES,
  CONVERTER_NONE,
  CONVERTER_RESPONSES_TO_CHAT,
  CONVERTER_RESPONSES_TO_GEMINI,
  converterDoesNotSupport,
} from "./advanced-custom-convert.js";
import {
  advancedCustomOpenaiShapedInbound,
  convertAdvancedCustomInbound,
} from "./advanced-custom-response.js";
import { oaiChatSseToResponsesSse, oaiResponsesSseToChatSse, claudeSseToResponsesSse, geminiSseToResponsesSse } from "./responses-stream.js";
import { oaiChatSseToClaudeSse, oaiChatSseToGeminiSse } from "./openai-stream-convert.js";
import {
  looksLikeOpenAIResponsesResponse,
  looksLikeResponsesSse,
  oaiResponsesSseToClaudeSse,
  responsesResponseToClaudeMessagesResponse,
} from "./responses-claude.js";
import { buildCodexRelayTarget, fetchCodexChannelModels } from "./codex-models.js";
import { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env, ExecutionContextLike, UserRow } from "./types.js";
import { applyFetchModelsHeaderOverrides, applyModelMapping, buildUpstream, joinUrl, modelsUrl, normalizeModelNames, type RelayMode, type UpstreamTarget } from "./upstream.js";
import { channelKind, isChannelSpecialBase, resolveBaseUrl } from "./catalog.js";
import {
  anthropicModel,
  catalogOpenAIModel,
  consumeLogOther,
  geminiModel,
  groupInUserUsableGroups,
  modelNotFoundError,
  openAIModel,
  openaiModelList,
  ownerForChannelType,
  requestAutoGroups,
} from "./dto.js";
import { tokenAllowsModel } from "./auth.js";
import { OPENAI_MODELS_MAP } from "./channel-models.js";
import { factoryPluginMeta, listRoutingPlugins } from "./task-plugin-factory.js";
import { hasModelBillingConfig } from "./billing-setting.js";
import { imageHelperFloorUsageTokens, imageHelperLogParts, imageRequestCount, openaiImageDataCount, refreshOutboundImageQuantity } from "./image-billing.js";
import {
  billingUsageFromOpenAICounts,
  cacheCreationTokensTotal,
  captureTieredBillingSnapshot,
  injectTieredBillingInfo,
  isFixedPriceSettlement,
  resolveRelayTieredQuota,
  type BillingUsage,
} from "./tiered-settle.js";
import {
  audioConsumeLogContent,
  DEFAULT_RELAY_FRT_MS,
  requestConversionChain,
  shouldPostAudioConsumeQuota,
} from "./log-info-generate.js";
import { getModelSupportEndpointTypes } from "./pricing-cache.js";
import { listModelsTokenLimitAllows } from "./ratio-setting.js";

export type ClientFormat = "openai" | "anthropic" | "gemini";

export interface RelayRequest {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  mode: RelayMode;
  clientFormat: ClientFormat;
  model: string;
  body: unknown;
  stream: boolean;
  path: string;
  ctx?: ExecutionContextLike;
  playground?: boolean;
  rawBody?: ArrayBuffer;
  rawContentType?: string;
  method?: string;
  requestPath?: string;
  expectedTaskPluginKey?: string;
  taskPluginChannelTypes?: number[];
  originPin?: ChannelPin;
  originTasks?: OriginTaskRef[];
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Original TextHelper `convertedRequest.(*dto.GeneralOpenAIRequest)` after ConvertOpenAIRequest. */
function looksLikeGeneralOpenAIRequest(body: Record<string, unknown>): boolean {
  if ("contents" in body) return false;
  if ("instances" in body) return false;
  if ("anthropic_version" in body) return false;
  if (body.schemaVersion != null) return false;
  if ("keep_alive" in body) return false;
  if (typeof body.system === "string" || Array.isArray(body.system)) return false;
  if (body.options && typeof body.options === "object" && !Array.isArray(body.options)) return false;
  if (Array.isArray(body.messages)) return true;
  return typeof body.prompt === "string" && typeof body.model === "string";
}

function applyTextHelperSystemPromptIfNeeded(
  converted: unknown,
  extras: { systemPrompt?: string; systemPromptOverride?: boolean },
): unknown {
  const body = asObj(converted);
  if (!looksLikeGeneralOpenAIRequest(body)) return converted;
  return applyChatChannelSystemPrompt(
    body,
    extras.systemPrompt,
    extras.systemPromptOverride,
    getOpenAISystemRoleName(String(body.model || ""), String(body.reasoning_effort || "")),
  );
}

/** Original `compatible_handler` `ShouldIncludeUsage` (true unless `stream_options` is present). */
function shouldIncludeUsage(body: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, "stream_options") || body.stream_options == null) return true;
  return Boolean(asObj(body.stream_options).include_usage);
}

function parseAliOriginBody(rawText: string, fallback: Record<string, unknown>): unknown {
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return fallback;
  }
}

export function detectModel(body: unknown, path: string, url: URL): string {
  const o = asObj(body);
  if (typeof o.model === "string") return o.model;
  const gem = extractGeminiModelAction(path);
  if (gem) return gem.model;
  return url.searchParams.get("model") || "";
}

export function detectStream(body: unknown, req: Request): boolean {
  if (req.headers.get("accept")?.includes("text/event-stream")) return true;
  const o = asObj(body);
  return Boolean(o.stream);
}

function retryable(status: number, ranges = retryStatusCodeRangesFromOption("")): boolean {
  if (status >= 200 && status < 300) return false;
  if (status < 100 || status > 599) return true;
  return shouldRetryByStatusCode(status, ranges);
}

async function fetchUpstream(target: ReturnType<typeof buildUpstream>, timeoutMs = 120_000): Promise<Response> {
  void timeoutMs;
  const init: RequestInit = {
    method: target.method,
    headers: target.headers,
  };
  if (target.method !== "GET" && target.method !== "HEAD" && target.body != null) {
    if (target.body instanceof ArrayBuffer) {
      init.body = target.body;
    } else if (ArrayBuffer.isView(target.body)) {
      init.body = target.body as BufferSource;
    } else if (typeof target.body === "string") {
      init.body = target.body;
    } else {
      init.body = JSON.stringify(target.body);
    }
  }
  const res = await fetch(target.url, init);
  return decodeAwsEventStreamResponse(res);
}

/** Original host reasoning maps loaded before adaptor Convert*. */
export async function reasoningSettingsFromStore(store: Store): Promise<ReasoningHostSettings> {
  return {
    thinkingModelBlacklist: parseJson(await store.option("global.thinking_model_blacklist"), DEFAULT_THINKING_MODEL_BLACKLIST),
    effortTailModelIDs: parseJson(await store.option("global.effort_tail_model_ids"), DEFAULT_EFFORT_TAIL_MODEL_IDS),
    claudeThinkingAdapterEnabled: (await store.option("claude.thinking_adapter_enabled")) !== "false",
    geminiThinkingAdapterEnabled: (await store.option("gemini.thinking_adapter_enabled")) === "true",
    claudeThinkingAdapterBudgetTokensPercentage: Number(await store.option("claude.thinking_adapter_budget_tokens_percentage")) || 0.8,
    geminiThinkingAdapterBudgetTokensPercentage: Number(await store.option("gemini.thinking_adapter_budget_tokens_percentage")) || 0.6,
    claudeDefaultMaxTokens: parseJson(await store.option("claude.default_max_tokens"), DEFAULT_CLAUDE_MAX_TOKENS),
    geminiSafetySettings: parseJson(await store.option("gemini.safety_settings"), { default: "OFF" }),
    geminiVersionSettings: parseJson(await store.option("gemini.version_settings"), DEFAULT_GEMINI_VERSION_SETTINGS),
    geminiSupportedImagineModels: parseJson(await store.option("gemini.supported_imagine_models"), []),
    geminiFunctionCallThoughtSignatureEnabled: (await store.option("gemini.function_call_thought_signature_enabled")) !== "false",
    removeFunctionResponseIdEnabled: (await store.option("gemini.remove_function_response_id_enabled")) !== "false",
  };
}

function convertRequestFailed(err: unknown): ParamOverrideReturnError {
  if (err instanceof ParamOverrideReturnError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ReasoningClientError) {
    return new ParamOverrideReturnError(message, 400, "convert_request_failed", "new_api_error", true);
  }
  if (message === "model_mapping_contains_cycle" || message === "unmarshal_model_mapping_failed") {
    return new ParamOverrideReturnError(message, 400, "channel:model_mapped_error", "new_api_error", true);
  }
  return new ParamOverrideReturnError(message, 500, "convert_request_failed", "new_api_error", true);
}

/**
 * Original adaptor ConvertOpenAIRequest / ConvertClaudeRequest / ConvertGeminiRequest /
 * ConvertEmbeddingRequest / ConvertImageRequest / ConvertRerankRequest /
 * ConvertOpenAIResponsesRequest dispatch (`controller.testChannel` switch + HTTP TextHelper).
 */
export async function convertOutbound(
  kind: ReturnType<typeof channelKind>,
  client: ClientFormat,
  body: unknown,
  channelType = 0,
  mappedModel = "",
  originModel = "",
  settings: ReasoningHostSettings = {},
  mode: RelayMode = "chat",
  extras: {
    botId?: string;
    responseId?: string;
    cohereSafetySetting?: string;
    channelKey?: string;
    requestPath?: string;
    systemPrompt?: string;
    systemPromptOverride?: boolean;
    converter?: string;
    isStream?: boolean;
    channelBase?: string;
    viaResponses?: boolean;
    channelOtherSettings?: ChannelDisabledFieldSettings;
    passThrough?: boolean;
    applyViaResponsesChatParamOverride?: (chat: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): Promise<unknown> {
  let o = asObj(body);
  const origin = originModel || String(o.model || "");
  const upstream = mappedModel || String(o.model || "");
  const mediaDialect = openAIHttpMediaDialect({
    client,
    channelType,
    kind,
    mode,
    converter: extras.converter,
    upstreamModel: upstream,
  });
  let resolveMedia: ((url: string) => { data: string; mime: string } | null) | undefined;
  if (mediaDialect) {
    const media = await prefetchOpenAIHttpMedia(o, mediaDialect);
    resolveMedia = (url) => media.get(url) ?? null;
  }
  if (usesTextHelperStreamOptions(client, mode, Boolean(extras.viaResponses))) {
    o = applyTextHelperStreamOptions(o, channelType);
  }
  if (extras.viaResponses && (client === "anthropic" || client === "openai")) {
    return convertTextRequestViaResponses(o, client, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: "responses",
      converter: extras.converter,
      requestPath: extras.requestPath,
      isStream: extras.isStream,
      systemPrompt: extras.systemPrompt,
      systemPromptOverride: extras.systemPromptOverride,
      channelOtherSettings: extras.channelOtherSettings,
      passThrough: extras.passThrough,
      applyViaResponsesChatParamOverride: extras.applyViaResponsesChatParamOverride,
      resolveMedia,
    });
  }
  if (client === "gemini") {
    const embed = typeof extras.requestPath === "string" && extras.requestPath.toLowerCase().includes("embed");
    if (!embed) o = applyGeminiChannelSystemPrompt(o, extras.systemPrompt, extras.systemPromptOverride);
  } else if (client === "anthropic") {
    o = applyClaudeChannelSystemPrompt(o, extras.systemPrompt, extras.systemPromptOverride);
  }
  if (channelType === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const convertOpts = {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      converter: extras.converter || "none",
      requestPath: extras.requestPath,
      isStream: extras.isStream ?? Boolean(o.stream),
      resolveMedia,
    };
    if (client === "anthropic") return convertAdvancedCustomClaudeRequest(o, convertOpts);
    if (client === "gemini") return convertAdvancedCustomGeminiRequest(o, convertOpts);
    if (client === "openai" && mode === "responses") return convertOpenAIResponsesRequest(o, convertOpts);
    return applyTextHelperSystemPromptIfNeeded(convertOpenAIRequest(o, convertOpts), extras);
  }
  if (channelType === CHANNEL_TYPE_CODEX && client === "anthropic") {
    throw new Error("codex channel: /v1/messages endpoint not supported");
  }
  if (channelType === CHANNEL_TYPE_CODEX && client === "gemini") {
    throw new Error("codex channel: endpoint not supported");
  }
  if (channelType === CHANNEL_TYPE_OLLAMA && client === "anthropic") {
    return convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_ALI && client === "anthropic") {
    if (supportsAliAnthropicMessages(upstream)) return o;
    const chat = anthropicToOpenAI(o);
    if (extras.isStream) {
      chat.stream = true;
      chat.stream_options = { include_usage: true };
    }
    return convertAliOpenAIRequest(chat, upstream);
  }
  if (channelType === CHANNEL_TYPE_CODEX && client === "openai" && mode !== "responses" && mode !== "alpha_search") {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
    });
  }
  if ((channelType === CHANNEL_TYPE_NEW_API || channelType === CHANNEL_TYPE_SUB2API) && client === "anthropic") {
    return convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if ((channelType === CHANNEL_TYPE_NEW_API || channelType === CHANNEL_TYPE_SUB2API) && client === "gemini") {
    return convertGeminiRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_AWS && client === "anthropic" && !isNovaModel(upstream)) {
    return convertAwsClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_VERTEX && client === "anthropic") {
    return convertVertexClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (client === "anthropic" && kind === "anthropic") {
    return convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_VERTEX && client === "gemini") {
    return convertVertexGeminiRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (client === "gemini" && kind === "gemini") {
    return convertGeminiRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_GEMINI && client === "anthropic") {
    return convertClaudeMessagesToGeminiGenerateContent(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_ANTHROPIC && client === "gemini") {
    return convertGeminiGenerateContentToClaudeMessages(o, {
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      isStream: extras.isStream,
    });
  }
  if (usesOpenAIAdaptor(channelType) && client === "anthropic") {
    return convertOpenAIAdaptorClaudeRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      isStream: extras.isStream,
    });
  }
  if (usesOpenAIAdaptor(channelType) && client === "gemini") {
    return convertOpenAIAdaptorGeminiRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      isStream: extras.isStream,
    });
  }
  if (delegatesClaudeToOpenAIAdaptor(channelType) && client === "anthropic") {
    return convertOpenAIAdaptorClaudeRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      isStream: extras.isStream,
    });
  }
  if (delegatesClaudeToOpenAIAdaptor(channelType) && client === "gemini") {
    throw new Error("not implemented");
  }
  if (channelType === CHANNEL_TYPE_VOLC && client === "gemini") {
    throw new Error("not implemented");
  }
  if (channelType === CHANNEL_TYPE_VOLC && client === "anthropic") {
    return convertVolcClaudeRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      isStream: extras.isStream,
      channelBase: extras.channelBase,
    });
  }
  if (usesClaudeAdaptorForClaudeRequest(channelType) && client === "gemini") {
    throw new Error("not implemented");
  }
  if (usesClaudeAdaptorForClaudeRequest(channelType) && client === "anthropic") {
    if (channelType === CHANNEL_TYPE_DEEPSEEK) {
      return convertDeepSeekClaudeRequest(o, {
        originModelName: origin,
        upstreamModelName: upstream,
        settings,
      });
    }
    return convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  const nativeClaudeGeminiErr = nativeClaudeGeminiConvertError(channelType, client);
  if (nativeClaudeGeminiErr) throw new Error(nativeClaudeGeminiErr);
  if (client === "openai") {
    const endpointErr = nativeOpenAIConvertEndpointError(channelType, mode);
    if (endpointErr) throw new Error(endpointErr);
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_OLLAMA && mode === "embeddings") {
    return convertOllamaEmbeddingRequest(o, { upstreamModelName: upstream });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_BAIDU && mode === "embeddings") {
    return convertBaiduEmbeddingRequest(o);
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_VERTEX && mode === "embeddings") {
    throw new Error("not implemented");
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_GEMINI && mode === "embeddings") {
    return convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_DIFY && (mode === "chat" || mode === "completions")) {
    return convertDifyOpenAIRequestWithUploads(o, {
      responseId: extras.responseId,
      channelBase: extras.channelBase,
      channelKey: extras.channelKey,
    });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_COHERE && mode === "rerank") {
    return convertCohereRerankRequest(o, { upstreamModelName: upstream });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_COHERE && mode === "embeddings") {
    throw new Error("not implemented");
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_OLLAMA && mode === "completions") {
    return convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_CLOUDFLARE && mode === "completions") {
    return convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_MINIMAX && (mode === "images" || mode === "audio_speech")) {
    return convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
  }
  if (
    client === "openai" &&
    channelType === CHANNEL_TYPE_VOLC &&
    (mode === "audio_speech" || mode === "audio_transcription" || mode === "audio_translation")
  ) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      channelKey: extras.channelKey,
    });
  }
  if (
    client === "openai" &&
    channelType === CHANNEL_TYPE_XAI &&
    (mode === "images" ||
      mode === "embeddings" ||
      mode === "audio_speech" ||
      mode === "audio_transcription" ||
      mode === "audio_translation")
  ) {
    return convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_ALI && (mode === "images" || mode === "rerank")) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      requestPath: extras.requestPath,
    });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_MOKA && mode === "embeddings") {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      channelKey: extras.channelKey,
    });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_JINA && (mode === "embeddings" || mode === "rerank")) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      channelKey: extras.channelKey,
    });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_SILICONFLOW && (mode === "images" || mode === "rerank")) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      channelKey: extras.channelKey,
    });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_REPLICATE) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
    });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_JIMENG && mode === "images") {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
    });
  }
  if (client === "openai" && mode === "images" && (channelType === CHANNEL_TYPE_GEMINI || channelType === CHANNEL_TYPE_VERTEX)) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
    });
  }
  if (
    client === "openai" &&
    channelType === CHANNEL_TYPE_SUBMODEL &&
    mode !== "chat" &&
    !Array.isArray(o.messages)
  ) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
    });
  }
  if (
    client === "openai" &&
    (channelType === CHANNEL_TYPE_NEW_API || channelType === CHANNEL_TYPE_SUB2API) &&
    (mode === "rerank" || mode === "audio_speech" || mode === "audio_transcription" || mode === "audio_translation")
  ) {
    return convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
    });
  }
  if (client === "openai" && mode === "responses") {
    o = convertOpenAIResponsesRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      requestPath: extras.requestPath,
      systemPrompt: extras.systemPrompt,
      systemPromptOverride: extras.systemPromptOverride,
      resolveMedia,
    });
    if (channelType === CHANNEL_TYPE_ANTHROPIC) return o;
    if (channelType === CHANNEL_TYPE_GEMINI) return o;
    if (kind === "anthropic") {
      return openaiToAnthropic(
        {
          ...o,
          messages: o.input ?? o.messages,
          max_tokens: o.max_output_tokens ?? o.max_tokens,
        },
        settings,
        resolveMedia,
      );
    }
    if (kind === "gemini") {
      return openaiToGemini(
        {
          ...o,
          messages: o.input ?? o.messages,
          max_tokens: o.max_output_tokens ?? o.max_tokens,
        },
        settings,
        resolveMedia,
      );
    }
    return o;
  }
  if (client === "openai" && (mode === "chat" || Array.isArray(o.messages))) {
    o = convertOpenAIRequest(o, {
      channelType,
      originModelName: origin,
      upstreamModelName: upstream,
      settings,
      relayMode: mode,
      botId: extras.botId,
      responseId: extras.responseId,
      cohereSafetySetting: extras.cohereSafetySetting,
      channelKey: extras.channelKey,
      resolveMedia,
    });
    if (kind !== "anthropic" && kind !== "gemini") {
      o = applyTextHelperSystemPromptIfNeeded(o, extras) as Record<string, unknown>;
    }
    if (kind === "anthropic" || kind === "gemini") return o;
    body = o;
  }
  if (kind === "anthropic" && client === "openai") return openaiToAnthropic(o, settings, resolveMedia);
  if (kind === "gemini" && client === "openai") return openaiToGemini(o, settings, resolveMedia);
  if (kind === "openai" && client === "anthropic") return anthropicToOpenAI(o);
  if (kind === "openai" && client === "gemini") {
    const model = String(o.model || "");
    return geminiToOpenAIChat(o, model);
  }
  if (kind === "gemini" && client === "anthropic") return openaiToGemini(anthropicToOpenAI(o), settings);
  if (kind === "anthropic" && client === "gemini") return openaiToAnthropic(geminiToOpenAIChat(o, String(o.model || "")), settings);
  return body;
}

function buildChannelRelayTarget(
  channel: ChannelRow,
  mode: RelayMode,
  path: string,
  model: string,
  body: unknown,
  extraHeaders: Record<string, string>,
  method: string,
  stream: boolean,
  relayInfo: ParamOverrideRelayInfo = {},
): UpstreamTarget {
  const info: ParamOverrideRelayInfo = {
    ...relayInfo,
    originalModel: relayInfo.originalModel || model,
    requestPath: relayInfo.requestPath || path,
  };
  if (channel.type === CHANNEL_TYPE_CODEX) {
    const target = buildCodexRelayTarget(channel, mode, path, model, body, stream);
    target.body = applyChannelParamOverride(channel, target.body, target.headers, info, pickChannelKey(channel.key), model);
    return target;
  }
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const incoming = path.split("?")[0];
    const mapped = applyModelMapping(channel, model);
    const target = buildAdvancedCustomRelayTarget(channel, incoming, model, mapped, body, stream);
    applyFetchModelsHeaderOverrides(channel, pickChannelKey(channel.key), target.headers);
    if (shouldApplyAdvancedCustomClaudeHeaders(target.converter, info.relayFormat)) {
      target.headers["anthropic-version"] = extraHeaders["anthropic-version"] || CLAUDE_VERSION;
    }
    target.body = applyChannelParamOverride(channel, target.body, target.headers, { ...info, upstreamModel: mapped }, pickChannelKey(channel.key), mapped);
    return target;
  }
  return buildUpstream(channel, mode, path, model, body, extraHeaders, method, { ...info, isStream: stream });
}

async function convertInbound(
  kind: ReturnType<typeof channelKind>,
  client: ClientFormat,
  upstreamJson: Record<string, unknown>,
  model: string,
  opts: {
    requestId?: string;
    created?: number;
    fallbackPromptTokens?: number;
    channelType?: number;
    relayMode?: RelayMode;
    rawText?: string;
    cozeUsage?: CozeUsage;
    channelKey?: string;
    converter?: string;
    responseFormat?: string;
    channelBase?: string;
    requestPath?: string;
    upstreamStatus?: number;
    viaResponses?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  if (client === "anthropic" && looksLikeOpenAIResponsesResponse(upstreamJson)) {
    return responsesResponseToClaudeMessagesResponse(upstreamJson);
  }
  if (opts.viaResponses && client === "openai" && looksLikeOpenAIResponsesResponse(upstreamJson)) {
    const id = opts.requestId || String(upstreamJson.id || "");
    const chat = responsesResponseToChatCompletion(upstreamJson, id);
    if (!chat.model && model) chat.model = model;
    return chat;
  }
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    return convertAdvancedCustomInbound(opts.converter || "none", client, upstreamJson, model, {
      requestId: opts.requestId,
      created: opts.created,
      fallbackPromptTokens: opts.fallbackPromptTokens,
      relayMode: opts.relayMode,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_OLLAMA) {
    if (opts.relayMode === "embeddings") return openaiFromOllamaEmbedding(upstreamJson, model);
    if (opts.relayMode === "responses") return upstreamJson;
    return openaiFromOllamaChatResponse(opts.rawText ?? upstreamJson, model, {
      id: opts.requestId ? compactUuid() : undefined,
      created: opts.created,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_COHERE) {
    if (opts.relayMode === "rerank") {
      return openaiFromCohereRerank(upstreamJson, { estimatePromptTokens: opts.fallbackPromptTokens });
    }
    return openaiFromCohereResponse(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_DIFY) {
    return openaiFromDifyResponse(upstreamJson, { created: opts.created });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_COZE) {
    return openaiFromCozeDetailResponse(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      usage: opts.cozeUsage,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_BAIDU) {
    if (opts.relayMode === "embeddings") return openaiFromBaiduEmbedding(upstreamJson);
    return openaiFromBaiduResponse(upstreamJson, { created: opts.created });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_ZHIPU) {
    return openaiFromZhipuResponse(upstreamJson, { created: opts.created });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_CLOUDFLARE && isCloudflareSTTRelayMode(opts.relayMode)) {
    return openaiFromCloudflareSTT(upstreamJson);
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_CLOUDFLARE && opts.relayMode !== "responses") {
    return openaiFromCloudflareResponse(upstreamJson, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      upstreamModelName: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_TENCENT && tencentUsesNativeAdaptor(opts.channelKey || "")) {
    return openaiFromTencentResponse(upstreamJson, { fallbackPromptTokens: opts.fallbackPromptTokens });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_PALM) {
    return openaiFromPalmResponse(upstreamJson, { fallbackPromptTokens: opts.fallbackPromptTokens });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_MOKA && opts.relayMode === "embeddings") {
    return openaiFromMokaEmbedding(upstreamJson);
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_JINA && opts.relayMode === "rerank") {
    return openaiFromJinaRerank(upstreamJson);
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_SILICONFLOW && opts.relayMode === "rerank") {
    return openaiFromSiliconFlowRerank(upstreamJson);
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_REPLICATE && opts.relayMode === "images") {
    return openaiFromReplicatePrediction(upstreamJson, { created: opts.created, responseFormat: opts.responseFormat });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_ZHIPU_V4 && opts.relayMode === "images") {
    return openaiFromZhipuV4Image(upstreamJson, { created: opts.created });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_MINIMAX && opts.relayMode === "images") {
    return openaiFromMiniMaxImage(upstreamJson, { created: opts.created });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_ALI && opts.relayMode === "images") {
    return openaiFromAliImage(upstreamJson, {
      created: opts.created,
      responseFormat: opts.responseFormat,
      channelBase: opts.channelBase,
      channelKey: opts.channelKey,
      isSync: aliImageIsSync(model, opts.requestPath || ""),
      originBody: opts.rawText ? parseAliOriginBody(opts.rawText, upstreamJson) : upstreamJson,
      upstreamStatus: opts.upstreamStatus,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_ALI && opts.relayMode === "rerank") {
    return openaiFromAliRerank(upstreamJson, { upstreamStatus: opts.upstreamStatus });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_JIMENG && opts.relayMode === "images") {
    return openaiFromJimengImage(upstreamJson, { created: opts.created });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_AWS) {
    if (isNovaModel(model)) {
      return openaiFromNovaResponse(upstreamJson, model, {
        id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
        created: opts.created,
      });
    }
    if (opts.relayMode === "responses") {
      return claudeResponseToResponsesResponse(upstreamJson, model, { id: opts.requestId });
    }
    return openaiFromAnthropicResponse(upstreamJson, model);
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_VERTEX) {
    const mode = vertexRequestMode(model);
    if (mode === "claude") {
      if (opts.relayMode === "responses") {
        return claudeResponseToResponsesResponse(upstreamJson, model, { id: opts.requestId });
      }
      return openaiFromAnthropicResponse(upstreamJson, model);
    }
    if (model.startsWith("imagen")) return openaiFromImagenResponse(upstreamJson, { created: opts.created });
    if (mode === "opensource") return upstreamJson;
    return openaiFromGeminiResponse(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
      upstreamModel: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if (client === "anthropic" && opts.channelType === CHANNEL_TYPE_VERTEX) {
    const mode = vertexRequestMode(model);
    if (mode === "claude") return upstreamJson;
    if (mode === "opensource") return openaiChatToClaudeResponse(upstreamJson);
    return geminiResponseToClaudeMessages(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
      upstreamModel: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if (client === "gemini" && opts.channelType === CHANNEL_TYPE_VERTEX) {
    const mode = vertexRequestMode(model);
    if (mode === "claude") return claudeResponseToGeminiChat(upstreamJson, model);
    if (mode === "opensource") return openaiChatToGeminiResponse(upstreamJson);
    return upstreamJson;
  }
  if (client === "openai" && kind === "anthropic") {
    if (opts.relayMode === "responses") {
      return claudeResponseToResponsesResponse(upstreamJson, model, { id: opts.requestId });
    }
    return openaiFromAnthropicResponse(upstreamJson, model);
  }
  if (client === "openai" && kind === "gemini") {
    if (model.startsWith("imagen")) return openaiFromImagenResponse(upstreamJson, { created: opts.created });
    if (opts.relayMode === "embeddings") {
      return openaiFromGeminiEmbedding(upstreamJson, model, { fallbackPromptTokens: opts.fallbackPromptTokens });
    }
    if (opts.relayMode === "responses") {
      return geminiResponseToResponsesResponse(upstreamJson, model, {
        id: opts.requestId,
        created: opts.created,
        fallbackPromptTokens: opts.fallbackPromptTokens,
      });
    }
    return openaiFromGeminiResponse(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
      upstreamModel: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if ((usesOpenAIAdaptor(opts.channelType || 0) || delegatesClaudeToOpenAIAdaptor(opts.channelType || 0)) && client === "anthropic") {
    return openaiChatToClaudeResponse(upstreamJson);
  }
  if (opts.channelType === CHANNEL_TYPE_VOLC && client === "anthropic") {
    if (isChannelSpecialBase(opts.channelBase)) return upstreamJson;
    return openaiChatToClaudeResponse(upstreamJson);
  }
  if (usesOpenAIAdaptor(opts.channelType || 0) && client === "gemini") {
    return openaiChatToGeminiResponse(upstreamJson);
  }
  if (client === "anthropic" && opts.channelType === CHANNEL_TYPE_GEMINI) {
    return geminiResponseToClaudeMessages(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
      upstreamModel: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if (client === "gemini" && opts.channelType === CHANNEL_TYPE_ANTHROPIC) {
    return claudeResponseToGeminiChat(upstreamJson, model);
  }
  if (
    client === "openai" &&
    opts.channelType === CHANNEL_TYPE_XAI &&
    opts.relayMode !== "images" &&
    opts.relayMode !== "responses"
  ) {
    return openaiFromXaiResponse(upstreamJson);
  }
  return upstreamJson;
}

async function openaiClientFromProvider(
  kind: ReturnType<typeof channelKind>,
  text: string,
  mapped: string,
  stream: boolean,
  opts: {
    requestId: string;
    includeUsage?: boolean;
    fallbackPromptTokens?: number;
    channelType?: number;
    relayMode?: RelayMode;
    channelKey?: string;
    converter?: string;
    created?: number;
  },
): Promise<{ body: string; usageBody: Record<string, unknown> }> {
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM && opts.converter === CONVERTER_CHAT_TO_RESPONSES) {
    const out = oaiResponsesSseToChatSse(text, {
      id: `chatcmpl-${opts.requestId}`,
      model: mapped,
      created: opts.created,
      includeUsage: opts.includeUsage,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    return { body: out.sse, usageBody: out.usageBody };
  }
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM && opts.converter === CONVERTER_RESPONSES_TO_CHAT) {
    const out = oaiChatSseToResponsesSse(text, {
      id: `chatcmpl-${opts.requestId}`,
      model: mapped,
      created: opts.created,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    return { body: out.sse, usageBody: out.usageBody };
  }
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM && opts.converter === CONVERTER_CHAT_TO_CLAUDE) {
    const out = claudeUpstreamToOpenAIChat(text, mapped, { includeUsage: opts.includeUsage, upstreamModel: mapped });
    if (stream) {
      return {
        body: out.sse || (out.json ? sseFromOpenAIChatCompletion(out.json) : sseOpenAIFromText(mapped, "")),
        usageBody: out.json || {},
      };
    }
    return { body: JSON.stringify(out.json), usageBody: out.json || {} };
  }
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM && opts.converter === CONVERTER_CHAT_TO_GEMINI) {
    const out = geminiUpstreamToOpenAIChat(text, mapped, {
      id: `chatcmpl-${opts.requestId}`,
      upstreamModel: mapped,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    if (stream) {
      return {
        body: out.sse || (out.json ? sseFromOpenAIChatCompletion(out.json) : sseOpenAIFromText(mapped, "")),
        usageBody: out.json || {},
      };
    }
    return { body: JSON.stringify(out.json), usageBody: out.json || {} };
  }
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM && opts.converter === CONVERTER_RESPONSES_TO_GEMINI) {
    if (opts.relayMode === "responses") {
      const responseId = opts.requestId || "";
      if (stream) {
        if (looksLikeSse(text)) {
          const converted = geminiSseToResponsesSse(text, {
            id: responseId,
            model: mapped,
            created: opts.created,
            fallbackPromptTokens: opts.fallbackPromptTokens,
          });
          return { body: converted.sse, usageBody: converted.usageBody };
        }
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { candidates: [{ content: { parts: [{ text }] } }] };
        }
        const json = geminiResponseToResponsesResponse(parsed, mapped, {
          id: responseId,
          created: opts.created,
          fallbackPromptTokens: opts.fallbackPromptTokens,
        });
        return { body: `event: response.completed\ndata: ${JSON.stringify(json)}\n\n`, usageBody: json };
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { candidates: [{ content: { parts: [{ text }] } }] };
      }
      const json = geminiResponseToResponsesResponse(parsed, mapped, {
        id: responseId,
        created: opts.created,
        fallbackPromptTokens: opts.fallbackPromptTokens,
      });
      json.model = mapped;
      return { body: JSON.stringify(json), usageBody: json };
    }
    const out = geminiUpstreamToOpenAIChat(text, mapped, {
      id: `chatcmpl-${opts.requestId}`,
      upstreamModel: mapped,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    if (stream) {
      return {
        body: out.sse || (out.json ? sseFromOpenAIChatCompletion(out.json) : sseOpenAIFromText(mapped, "")),
        usageBody: out.json || {},
      };
    }
    return { body: JSON.stringify(out.json), usageBody: out.json || {} };
  }
  if (opts.channelType === CHANNEL_TYPE_OLLAMA && opts.relayMode !== "responses" && opts.relayMode !== "embeddings") {
    const out = ollamaUpstreamToOpenAIChat(text, mapped);
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_COHERE && opts.relayMode !== "rerank") {
    const out = cohereUpstreamToOpenAIChat(text, mapped, {
      id: `chatcmpl-${opts.requestId}`,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_DIFY) {
    const out = difyUpstreamToOpenAIChat(text, { fallbackPromptTokens: opts.fallbackPromptTokens });
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_COZE) {
    const out = cozeUpstreamToOpenAIChat(text, mapped, {
      id: `chatcmpl-${opts.requestId}`,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_BAIDU && opts.relayMode !== "embeddings") {
    const out = baiduUpstreamToOpenAIChat(text);
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_ZHIPU) {
    const out = zhipuUpstreamToOpenAIChat(text);
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_CLOUDFLARE && opts.relayMode !== "responses" && !isCloudflareSTTRelayMode(opts.relayMode)) {
    const out = cloudflareUpstreamToOpenAIChat(text, {
      id: `chatcmpl-${opts.requestId}`,
      upstreamModelName: mapped,
      fallbackPromptTokens: opts.fallbackPromptTokens,
      includeUsage: opts.includeUsage,
    });
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_TENCENT && tencentUsesNativeAdaptor(opts.channelKey || "")) {
    const out = tencentUpstreamToOpenAIChat(text, { fallbackPromptTokens: opts.fallbackPromptTokens });
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  if (opts.channelType === CHANNEL_TYPE_PALM) {
    const out = palmUpstreamToOpenAIChat(text, {
      id: `chatcmpl-${opts.requestId}`,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    return { body: stream ? out.sse : JSON.stringify(out.json), usageBody: out.json };
  }
  const vertexMode = opts.channelType === CHANNEL_TYPE_VERTEX ? vertexRequestMode(mapped) : null;
  const useClaude =
    kind === "anthropic" ||
    (opts.channelType === CHANNEL_TYPE_AWS && !isNovaModel(mapped)) ||
    vertexMode === "claude";
  const useGemini = (kind === "gemini" || opts.channelType === CHANNEL_TYPE_VERTEX) && vertexMode !== "claude" && !mapped.startsWith("imagen") && vertexMode !== "opensource";
  if (opts.channelType === CHANNEL_TYPE_AWS && isNovaModel(mapped)) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { output: { message: { content: [{ text }] } } };
    }
    const json = openaiFromNovaResponse(parsed, mapped, { id: `chatcmpl-${opts.requestId}` });
    return { body: stream ? sseFromOpenAIChatCompletion(json) : JSON.stringify(json), usageBody: json };
  }
  if (mapped.startsWith("imagen") && (opts.channelType === CHANNEL_TYPE_VERTEX || opts.channelType === CHANNEL_TYPE_GEMINI || kind === "gemini")) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { predictions: [] };
    }
    const json = openaiFromImagenResponse(parsed);
    const billed = imagenUsage((json.data as unknown[] | undefined)?.length || 0);
    return {
      body: JSON.stringify(json),
      usageBody: { usage: { prompt_tokens: billed.prompt, completion_tokens: 0, total_tokens: billed.total } },
    };
  }
  if (useClaude) {
    if (opts.relayMode === "responses") {
      const responseId = opts.requestId;
      if (stream) {
        if (looksLikeSse(text)) {
          const converted = claudeSseToResponsesSse(text, {
            id: responseId || "",
            model: mapped,
            created: opts.created,
            fallbackPromptTokens: opts.fallbackPromptTokens,
          });
          return { body: converted.sse, usageBody: converted.usageBody };
        }
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { content: [{ type: "text", text }] };
        }
        const json = claudeResponseToResponsesResponse(parsed, mapped, { id: responseId || String(parsed.id || "") });
        return { body: `event: response.completed\ndata: ${JSON.stringify(json)}\n\n`, usageBody: json };
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { content: [{ type: "text", text }] };
      }
      const json = claudeResponseToResponsesResponse(parsed, mapped, { id: responseId || String(parsed.id || "") });
      return { body: JSON.stringify(json), usageBody: json };
    }
    const out = claudeUpstreamToOpenAIChat(text, mapped, { includeUsage: opts.includeUsage, upstreamModel: mapped });
    if (stream) {
      return {
        body: out.sse || (out.json ? sseFromOpenAIChatCompletion(out.json) : sseOpenAIFromText(mapped, "")),
        usageBody: { usage: { prompt_tokens: out.usage.prompt_tokens, completion_tokens: out.usage.completion_tokens, total_tokens: out.usage.total_tokens, prompt_tokens_details: out.usage.prompt_tokens_details } },
      };
    }
    return { body: JSON.stringify(out.json), usageBody: out.json || {} };
  }
  if (useGemini) {
    if (opts.relayMode === "responses") {
      const responseId = opts.requestId || "";
      if (stream) {
        if (looksLikeSse(text)) {
          const converted = geminiSseToResponsesSse(text, {
            id: responseId,
            model: mapped,
            created: opts.created,
            fallbackPromptTokens: opts.fallbackPromptTokens,
          });
          return { body: converted.sse, usageBody: converted.usageBody };
        }
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { candidates: [{ content: { parts: [{ text }] } }] };
        }
        const json = geminiResponseToResponsesResponse(parsed, mapped, {
          id: responseId,
          created: opts.created,
          fallbackPromptTokens: opts.fallbackPromptTokens,
        });
        return { body: `event: response.completed\ndata: ${JSON.stringify(json)}\n\n`, usageBody: json };
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { candidates: [{ content: { parts: [{ text }] } }] };
      }
      const json = geminiResponseToResponsesResponse(parsed, mapped, {
        id: responseId,
        created: opts.created,
        fallbackPromptTokens: opts.fallbackPromptTokens,
      });
      json.model = mapped;
      return { body: JSON.stringify(json), usageBody: json };
    }
    const out = geminiUpstreamToOpenAIChat(text, mapped, {
      id: `chatcmpl-${opts.requestId}`,
      upstreamModel: mapped,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
    if (stream) {
      return {
        body: out.sse || (out.json ? sseFromOpenAIChatCompletion(out.json) : sseOpenAIFromText(mapped, "")),
        usageBody: { usage: { prompt_tokens: out.usage.prompt_tokens, completion_tokens: out.usage.completion_tokens, total_tokens: out.usage.total_tokens, prompt_tokens_details: out.usage.prompt_tokens_details } },
      };
    }
    return { body: JSON.stringify(out.json), usageBody: out.json || {} };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { content: text };
  }
  const converted = await convertInbound(kind, "openai", parsed, mapped, {
    requestId: opts.requestId,
    fallbackPromptTokens: opts.fallbackPromptTokens,
    channelType: opts.channelType,
    channelKey: opts.channelKey,
    relayMode: opts.relayMode,
    converter: opts.converter,
  });
  if (stream && converted.object === "response") {
    return { body: `event: response.completed\ndata: ${JSON.stringify(converted)}\n\n`, usageBody: converted };
  }
  return { body: stream ? sseFromOpenAIChatCompletion(converted) : JSON.stringify(converted), usageBody: converted };
}

function attachSettleUsage(
  extra: { cachedTokens?: number; promptCacheHitTokens?: number; billingUsage?: BillingUsage },
  usage: ReturnType<typeof usageFromOpenAI>,
): void {
  extra.cachedTokens = usage.cachedTokens;
  extra.promptCacheHitTokens = usage.promptCacheHitTokens;
  extra.billingUsage = billingUsageFromOpenAICounts(usage);
}

/**
 * Original Gemini adaptor DoResponse unmarshals `dto.GeminiChatResponse` in
 * GeminiChatHandler / GeminiResponsesHandler / native GeminiTextGenerationHandler
 * (not imagen / embedding).
 */
function usesGeminiChatResponseUnmarshal(channelType: number, mapped: string, mode: string): boolean {
  if (mode === "images" || mode === "embeddings" || mode === "engines_embeddings") return false;
  if (mapped.startsWith("imagen")) return false;
  if (mapped.startsWith("text-embedding") || mapped.startsWith("embedding") || mapped.startsWith("gemini-embedding")) {
    return false;
  }
  if (channelType === CHANNEL_TYPE_GEMINI) return true;
  if (channelType === CHANNEL_TYPE_VERTEX && vertexRequestMode(mapped) === "gemini") return true;
  return false;
}

/**
 * Original Gemini adaptor DoResponse uses GeminiChatHandler / GeminiResponsesHandler
 * leftover empty-candidates gin.H (not native GeminiTextGenerationHandler / imagen / embedding).
 */
function usesGeminiEmptyCandidatesHandler(channelType: number, mapped: string, mode: string): boolean {
  if (mode === "gemini") return false;
  return usesGeminiChatResponseUnmarshal(channelType, mapped, mode);
}

/** Original adaptor request format after ConvertRequest; client format is InitRequestConversionChain. */
function destinationRelayFormat(channelType: number, mode: string, viaResponses: boolean): string {
  if (viaResponses) return "openai_responses";
  if (mode === "embeddings" || mode === "engines_embeddings") return "embedding";
  if (mode === "rerank") return "rerank";
  if (mode === "images") return "openai_image";
  if (mode === "audio_speech" || mode === "audio_transcription" || mode === "audio_translation") return "openai_audio";
  if (mode === "realtime") return "openai_realtime";
  if (mode === "alpha_search") return "openai_alpha_search";
  if (channelType === CHANNEL_TYPE_ANTHROPIC || channelType === CHANNEL_TYPE_AWS) return "claude";
  if (channelType === CHANNEL_TYPE_GEMINI || channelType === CHANNEL_TYPE_VERTEX) return "gemini";
  if (mode === "messages") return "claude";
  if (mode === "gemini") return "gemini";
  if (mode === "responses") return "openai_responses";
  return "openai";
}

type SettleLogExtra = {
  upstreamRequestId?: string;
  requestPath?: string;
  channelAffinity?: Record<string, unknown>;
  env?: Env;
  affinity?: ChannelAffinityResolution;
  clientFormat?: string;
  cachedTokens?: number;
  promptCacheHitTokens?: number;
  billingUsage?: BillingUsage;
  startMs?: number;
  firstResponseMs?: number;
  useChannel?: string[];
  isModelMapped?: boolean;
  upstreamModelName?: string;
  reasoningEffort?: string;
  isSystemPromptOverwritten?: boolean;
  requestConversion?: string[];
  billingSource?: string;
  relayMode?: string;
  imageBody?: Record<string, unknown>;
  imageChannelType?: number;
  requestHeaders?: Record<string, string>;
  actualImageCount?: number;
  tieredSnapshot?: import("./billing-expr.js").BillingSnapshot;
  billingRequestInput?: import("./billing-expr.js").BillingRequestInput;
  builtInTools?: Record<string, number>;
  claudeWebSearchRequests?: number;
  geminiGoogleSearchCall?: boolean;
  otherRatios?: Record<string, number>;
  toolUsage?: ToolUsageState;
  paramOverrideAudit?: string[];
  streamStatus?: StreamStatus;
  billingModelName?: string;
  billing?: BillingSession | null;
  billingPreference?: string;
  subscriptionId?: number;
  subscriptionPreConsumed?: number;
  subscriptionPostDelta?: number;
  subscriptionPlanId?: number;
  subscriptionPlanTitle?: string;
  subscriptionAmountTotal?: number;
  subscriptionAmountUsedAfterPreConsume?: number;
};

async function settle(
  store: Store,
  auth: AuthToken,
  channel: ChannelRow,
  model: string,
  prompt: number,
  completion: number,
  useTime: number,
  stream: boolean,
  ip: string,
  requestId: string,
  ok: boolean,
  content: string,
  extra: SettleLogExtra = {},
): Promise<void> {
  if (extra.toolUsage) {
    extra.builtInTools = builtInToolCallCounts(extra.toolUsage);
    extra.claudeWebSearchRequests = extra.toolUsage.claudeWebSearchRequests || undefined;
    extra.geminiGoogleSearchCall = extra.toolUsage.geminiGoogleSearchCall || undefined;
  }
  if (extra.relayMode === "images" && ok) {
    if (prompt === 0) prompt = 1;
    if (extra.billingUsage && (extra.billingUsage.prompt_tokens || 0) === 0) extra.billingUsage.prompt_tokens = 1;
  }
  const originModel = model;
  const billingName = extra.billingModelName || originModel;
  const billingUsage =
    extra.billingUsage ||
    billingUsageFromOpenAICounts({
      prompt,
      completion,
      cachedTokens: extra.cachedTokens || 0,
      promptCacheHitTokens: extra.promptCacheHitTokens || 0,
    });
  const isClaude = extra.clientFormat === "anthropic" || billingUsage.usage_semantic === "anthropic";
  const tiered = await resolveRelayTieredQuota(store, billingName, auth.usingGroup, billingUsage, isClaude, {
    relayMode: extra.relayMode,
    imageBody: extra.imageBody,
    channelType: extra.imageChannelType,
    headers: extra.requestHeaders,
    actualImageCount: extra.actualImageCount,
    snapshot: extra.tieredSnapshot,
    request: extra.billingRequestInput,
    preConsumedQuota: extra.tieredSnapshot?.estimatedQuotaAfterGroup,
  });
  const price = await textConsumePriceData(store, billingName, auth.usingGroup, auth.user.group);
  const audioLog = await audioConsumeLogRatios(store, billingName);
  const details = billingUsage.prompt_tokens_details || {};
  const outDetails = billingUsage.completion_tokens_details || {};
  const cacheCreationTokens = cacheCreationTokensTotal(details);
  const frt =
    extra.firstResponseMs != null && extra.startMs != null
      ? extra.firstResponseMs - extra.startMs
      : DEFAULT_RELAY_FRT_MS;
  const finalRequestFormat = (extra.requestConversion || [])[(extra.requestConversion || []).length - 1];
  const useAudioOther = shouldPostAudioConsumeQuota({
    audioInput: details.audio_tokens,
    audioOutput: outDetails.audio_tokens,
    finalRequestFormat,
    containsAudioRatios: audioLog.containsAudioRatios,
    originModelName: originModel,
  });
  const textSummary = useAudioOther
    ? null
    : await calculateTextQuotaFromStore(store, {
        model: billingName,
        group: auth.usingGroup,
        userGroup: auth.user.group,
        usage: billingUsage,
        channelType: channel.type,
        finalRequestFormat,
        relayMode: extra.toolUsage?.relayMode || extra.relayMode,
        builtInTools: extra.builtInTools,
        claudeWebSearchRequests: extra.claudeWebSearchRequests,
        geminiGoogleSearchCall: extra.geminiGoogleSearchCall,
        otherRatios: extra.otherRatios,
        imageCount: extra.actualImageCount,
      });
  const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  const audioQuota = useAudioOther
    ? calculateAudioQuota({
        inputTextTokens: Number(details.text_tokens || 0),
        inputAudioTokens: Number(details.audio_tokens || 0),
        outputTextTokens: Number(outDetails.text_tokens || 0),
        outputAudioTokens: Number(outDetails.audio_tokens || 0),
        modelName: billingName,
        usePrice: price.usePrice,
        modelPrice: price.modelPrice,
        modelRatio: price.modelRatio,
        groupRatio: price.groupRatio,
        completionRatio: audioLog.completionRatio,
        audioRatio: audioLog.audioRatio,
        audioCompletionRatio: audioLog.audioCompletionRatio,
        quotaPerUnit,
      })
    : null;
  let quota: number;
  let quotaClamp = textSummary?.clamp || audioQuota?.clamp || null;
  if (tiered) {
    if (textSummary) {
      const composed = composeTieredTextQuota({
        toolCallSurchargeQuota: textSummary.toolCallSurchargeQuota,
        tieredQuota: tiered.quota,
        result: tiered.result,
        snap: tiered.snap,
      });
      quota = composed.quota;
      quotaClamp = noteQuotaClamp(quotaClamp, composed.clamp);
    } else {
      quota = tiered.quota;
    }
    quotaClamp = noteQuotaClamp(quotaClamp, tiered.result?.clamp);
  } else if (textSummary) {
    quota = textSummary.quota;
  } else if (audioQuota) {
    quota = audioQuota.quota;
  } else {
    quota = await computeQuota(store, billingName, auth.usingGroup, prompt, completion);
  }
  const audioTotalTokens = Number(billingUsage.prompt_tokens || 0) + Number(billingUsage.completion_tokens || 0);
  const audioFixedPrice = isFixedPriceSettlement(tiered?.result, extra.tieredSnapshot || tiered?.snap);
  if (useAudioOther && audioTotalTokens === 0 && !audioFixedPrice) {
    quota = 0;
  }
  if (ok && useAudioOther && extra.relayMode !== "images") {
    content = audioConsumeLogContent({
      usePrice: price.usePrice,
      modelRatio: price.modelRatio,
      completionRatio: audioLog.completionRatio,
      audioRatio: audioLog.audioRatio,
      audioCompletionRatio: audioLog.audioCompletionRatio,
      groupRatio: price.groupRatio,
      modelPrice: price.modelPrice,
      totalTokens: audioTotalTokens,
      fixedPriceBilling: audioFixedPrice,
    });
  } else if (ok && !useAudioOther && textSummary) {
    const prefix = extra.relayMode === "images" ? imageHelperLogParts(extra.imageBody || {}) : [];
    const quotaLabels = new Map<number, string>();
    const labelQuota = async (q: number): Promise<string> => {
      const hit = quotaLabels.get(q);
      if (hit != null) return hit;
      const formatted = await storeLogQuota(store, q);
      quotaLabels.set(q, formatted);
      return formatted;
    };
    for (const item of textSummary.toolSurchargeItems) {
      await labelQuota(postTextToolSurchargeQuota(item, price.groupRatio, quotaPerUnit));
    }
    if (textSummary.audioInputPrice > 0 && textSummary.audioTokens > 0) {
      await labelQuota(
        postTextAudioInputQuota(textSummary.audioInputPrice, textSummary.audioTokens, price.groupRatio, quotaPerUnit),
      );
    }
    content = postTextConsumeLogContent(
      prefix,
      postTextConsumeLogParts({
        toolSurcharges: textSummary.toolSurchargeItems,
        groupRatio: price.groupRatio,
        quotaPerUnit,
        formatQuota: (q) => quotaLabels.get(q) || "",
        audioInputPrice: textSummary.audioInputPrice,
        audioInputTokens: textSummary.audioTokens,
        hasBillableUsage: textHasBillableUsage(textSummary, audioFixedPrice),
        billingModelName: billingName,
      }),
    );
  }
  const publicExtra = tiered ? injectTieredBillingInfo({}, tiered.snap, tiered.result) : undefined;
  const logModel = useAudioOther ? billingName : consumeLogModelName(billingName);
  const billingLog = billingSessionLogFields(extra.billing);
  if (ok && quota > 0) {
    if (extra.billing) {
      await store.addUserUsedQuotaAndRequestCount(auth.user.id, quota);
      await store.addChannelUsedQuota(channel.id, quota);
    } else {
      await store.consumeQuota(auth.user.id, auth.token.id, channel.id, quota);
    }
    await store.bumpQuotaData(auth.user, logModel, quota, prompt + completion, {
      useGroup: auth.usingGroup,
      tokenId: auth.token.id,
      channelId: channel.id,
    });
  }
  if (ok && extra.billing) await settleBilling(store, auth, extra.billing, quota);
  else if (!ok && extra.billing) await refundBilling(store, auth, extra.billing);
  await store.insertLog({
    user_id: auth.user.id,
    type: ok ? LOG_CONSUME : LOG_ERROR,
    content,
    username: auth.user.username,
    token_name: auth.token.name,
    model_name: logModel,
    quota,
    prompt_tokens: textSummary ? textSummary.promptTokens : prompt,
    completion_tokens: completion,
    use_time: useTime,
    is_stream: stream ? 1 : 0,
    channel_id: channel.id,
    token_id: auth.token.id,
    group: auth.usingGroup,
    ip,
    request_id: requestId,
    upstream_request_id: extra.upstreamRequestId || "",
    other: consumeLogOther({
      model: originModel,
      billingModel: billingName,
      group: auth.usingGroup,
      groupRatio: price.groupRatio,
      modelRatio: price.modelRatio,
      completionRatio: useAudioOther ? audioLog.completionRatio : price.completionRatio,
      cacheTokens: useAudioOther ? 0 : Number(details.cached_tokens || 0),
      cacheRatio: useAudioOther ? 0 : price.cacheRatio,
      modelPrice: price.modelPrice,
      userGroupRatio: price.userGroupRatio,
      frt,
      reasoningEffort: extra.reasoningEffort,
      isModelMapped: extra.isModelMapped,
      upstreamModelName: extra.upstreamModelName,
      isSystemPromptOverwritten: extra.isSystemPromptOverwritten,
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      ok,
      requestPath: extra.requestPath,
      requestConversion: extra.requestConversion,
      isClaudeUsageSemantic: textSummary ? textSummary.isClaudeUsageSemantic : isClaude,
      finalRequestFormat,
      cacheCreationTokens: textSummary ? textSummary.cacheCreationTokens : cacheCreationTokens,
      cacheCreationRatio: price.cacheCreationRatio,
      cacheCreationTokens5m: textSummary ? textSummary.cacheCreationTokens5m : billingUsage.claude_cache_creation_5_m_tokens,
      cacheCreationRatio5m: price.cacheCreationRatio5m,
      cacheCreationTokens1h: textSummary ? textSummary.cacheCreationTokens1h : billingUsage.claude_cache_creation_1_h_tokens,
      cacheCreationRatio1h: price.cacheCreationRatio1h,
      imageTokens: details.image_tokens,
      imageRatio: price.imageRatio,
      audioInput: details.audio_tokens,
      audioOutput: outDetails.audio_tokens,
      textInput: details.text_tokens,
      textOutput: outDetails.text_tokens,
      audioRatio: audioLog.audioRatio,
      audioCompletionRatio: audioLog.audioCompletionRatio,
      containsAudioRatios: audioLog.containsAudioRatios,
      isMultiKey: parseChannelInfo(String(channel.channel_info || "")).is_multi_key,
      useChannel: extra.useChannel,
      channelAffinity: extra.channelAffinity,
      billingSource: extra.billingSource || billingLog.billingSource || "wallet",
      billingPreference: extra.billingPreference || billingLog.billingPreference,
      subscriptionId: extra.subscriptionId ?? billingLog.subscriptionId,
      subscriptionPreConsumed: extra.subscriptionPreConsumed ?? billingLog.subscriptionPreConsumed,
      subscriptionPostDelta: extra.subscriptionPostDelta ?? billingLog.subscriptionPostDelta,
      subscriptionPlanId: extra.subscriptionPlanId ?? billingLog.subscriptionPlanId,
      subscriptionPlanTitle: extra.subscriptionPlanTitle ?? billingLog.subscriptionPlanTitle,
      subscriptionAmountTotal: extra.subscriptionAmountTotal ?? billingLog.subscriptionAmountTotal,
      subscriptionAmountUsedAfterPreConsume:
        extra.subscriptionAmountUsedAfterPreConsume ?? billingLog.subscriptionAmountUsedAfterPreConsume,
      publicExtra,
      quotaClamp,
      toolSurcharges: textSummary?.toolSurchargeItems,
      audioInputPrice: textSummary?.audioInputPrice,
      audioInputTokens: textSummary?.audioTokens,
      paramOverrideAudit: extra.paramOverrideAudit,
      streamStatus: stream ? extra.streamStatus : undefined,
    }),
  });
  if (ok && extra.affinity && extra.env) {
    await observeChannelAffinityUsageCache(
      store,
      extra.env,
      extra.affinity,
      auth.usingGroup,
      {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        cachedTokens: extra.cachedTokens || 0,
        promptCacheHitTokens: extra.promptCacheHitTokens || 0,
      },
      cachedTokenRateModeByClientFormat(extra.clientFormat || "openai"),
    );
  }
  await recordRelayPerf(store, {
    model,
    group: auth.usingGroup,
    latencyMs: useTime * 1000,
    success: ok,
    outputTokens: completion,
    stream,
  });
}

export async function relay(opts: RelayRequest): Promise<Response> {
  const { store, mode, clientFormat, path, ctx } = opts;
  const auth = opts.auth;
  let model = opts.model;
  const abortRid = opts.req.headers.get("x-oneapi-request-id") || "";
  if (!model) return abortWithOpenAiMessage(400, modelNameRequiredMessage(opts.req), "", abortRid);
  if (!tokenAllowsModel(auth.token, model)) {
    return abortWithOpenAiMessage(403, tokenModelForbiddenMessage(opts.req, model), "", abortRid);
  }

  if (opts.playground) {
    const pgGroup = String(asObj(opts.body).group || "");
    if (pgGroup) {
      const allowed = await groupInUserUsableGroups(store, auth.user.group || "default", pgGroup);
      if (!allowed && pgGroup !== auth.usingGroup) {
        return abortWithOpenAiMessage(403, groupAccessDeniedMessage(opts.req), "", abortRid);
      }
      auth.usingGroup = pgGroup;
    }
    auth.token = { ...auth.token, name: `playground-${auth.usingGroup}`, group: auth.usingGroup };
  }

  try {
    opts.body = applyGetAndValidateRequest(mode, path, opts.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return writeRelayNewAPIError(opts.req, 400, message, ERROR_CODE_INVALID_REQUEST);
  }

  const requestPath = opts.requestPath || path;
  const rid = opts.req.headers.get("x-oneapi-request-id") || crypto.randomUUID();
  const selected = await selectDistributedChannel({
    store,
    env: opts.env,
    req: opts.req,
    auth,
    model,
    requestPath,
    body: opts.body,
    headers: requestHeadersFrom(opts.req),
    expectedTaskPluginKey: opts.expectedTaskPluginKey,
    taskPluginChannelTypes: opts.taskPluginChannelTypes,
    originPin: opts.originPin,
  });
  if (selected.error) {
    return abortWithOpenAiMessage(selected.error.status, selected.error.message, selected.error.code, rid);
  }
  auth.usingGroup = selected.usingGroup;
  const first = selected.channel;
  const usedAffinityChannel = selected.usedAffinity;
  const pinRetryMode = selected.pinRetryMode;
  const suppressesRetry = pinRetryMode === PIN_RETRY_SINGLE_ATTEMPT;
  const affinity = selected.affinity;
  const selectParam = selected.selectParam;
  const selectState = selected.selectState;
  if (!first) {
    const showGroup = auth.usingGroup === "auto" ? "auto" : auth.usingGroup;
    return abortWithOpenAiMessage(503, noAvailableChannelMessage(opts.req, showGroup, model), "model_not_found", rid);
  }

  const retryRanges = retryStatusCodeRangesFromOption(await store.option("AutomaticRetryStatusCodes"));
  const ip = clientIp(opts.req);
  const usedChannel: string[] = [];
  const requestStarted = Date.now();

  const convertSettings = await reasoningSettingsFromStore(store);
  const billingModelName = await resolveBillingModelNameFromStore(store, model, convertSettings);
  const priceReject = await modelPriceHelperReject(
    store,
    model,
    Number(auth.user.role || 0),
    auth.user.settings,
    convertSettings,
  );
  if (priceReject) return writeRelayNewAPIError(opts.req, 400, priceReject, "model_price_error");

  const tokenMeta = getTokenCountMeta({
    mode,
    clientFormat,
    path,
    body: opts.body,
    model,
  });
  const promptEst = estimateRequestPromptTokens({
    mode,
    clientFormat,
    path,
    body: opts.body,
    model,
  });
  const billingRequestInput = {
    headers: requestHeadersFrom(opts.req),
    body: asObj(opts.body),
  };
  let tieredSnapshot: import("./billing-expr.js").BillingSnapshot | null = null;
  try {
    const maxTokens = tokenMeta.maxTokens || Number(asObj(opts.body).max_tokens || asObj(opts.body).max_completion_tokens || 0);
    tieredSnapshot = await captureTieredBillingSnapshot(
      store,
      billingModelName,
      auth.usingGroup,
      promptEst,
      { maxTokens },
      billingRequestInput,
      { relayMode: mode, channelType: first.type, imageBody: asObj(opts.body) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return writeRelayNewAPIError(opts.req, 400, message, "model_price_error");
  }
  const priceQuota = await modelPriceHelperQuotaToPreConsumeFromStore(store, {
    billingModelName,
    promptTokens: promptEst,
    maxTokens: tokenMeta.maxTokens,
    imagePriceRatio: tokenMeta.imagePriceRatio,
    billingRatios: tokenMeta.billingRatios,
    group: auth.usingGroup,
    userGroup: auth.user.group,
    relayMode: mode,
    channelType: first.type,
    originModelName: model,
    upstreamModelName: applyModelMapping(first, model),
    body: asObj(opts.body),
    tieredQuotaToPreConsume: tieredSnapshot?.estimatedQuotaAfterGroup,
  });
  if (priceQuota.error) return writeRelayNewAPIError(opts.req, 400, priceQuota.error, "model_price_error");
  const preNeed = priceQuota.freeModel ? 0 : priceQuota.quotaToPreConsume;
  let billing: BillingSession | null = null;
  if (!priceQuota.freeModel) {
    const held = await preConsumeBilling(store, auth, {
      requestId: rid,
      quota: preNeed,
      playground: Boolean(opts.playground),
      billingModelName,
    });
    if (held.error) return writeRelayNewAPIError(opts.req, held.error.status, held.error.message, held.error.code);
    billing = held.session;
  }
  let pendingStreamSettle = false;
  try {
  let lastErr = noAvailableChannelRetryMessage(auth.usingGroup === "auto" ? "auto" : auth.usingGroup, model);
  let lastStatus = 500;
  let lastCode = ERROR_CODE_GET_CHANNEL_FAILED;
  let lastType = ERROR_TYPE_NEW_API_ERROR;

  const retryTimes = selectParam.retryTimes;
  const chatResponsesPolicy = parseJson<ChatCompletionsToResponsesPolicy>(
    await store.option("global.chat_completions_to_responses_policy"),
    { enabled: false, all_channels: true },
  );
  const passThroughGlobal = (await store.option("global.pass_through_request_enabled")) === "true";
  const toolPrices = decodeToolPricesJSON(await store.option(TOOL_PRICE_OPTION_KEY));

  for (let retry = 0; retry <= retryTimes; retry++) {
    let channel: ChannelRow | null;
    if (retry === 0) channel = first;
    else if (suppressesRetry) break;
    else if (pinRetryMode === PIN_RETRY_SAME_CHANNEL) channel = first;
    else {
      increaseChannelSelectRetry(selectState);
      const next = await cacheGetRandomSatisfiedChannel(store, selectParam, selectState);
      channel = next.channel;
      if (next.selectGroup && next.selectGroup !== "auto") auth.usingGroup = next.selectGroup;
      if (!channel) {
        const showGroup = next.selectGroup || (auth.usingGroup === "auto" ? "auto" : auth.usingGroup);
        lastErr = next.error
          ? getChannelRetryFailedMessage(showGroup, model, next.error)
          : noAvailableChannelRetryMessage(showGroup, model);
        lastStatus = 500;
        lastCode = ERROR_CODE_GET_CHANNEL_FAILED;
        lastType = ERROR_TYPE_NEW_API_ERROR;
        break;
      }
    }
    if (!channel) break;
    usedChannel.push(String(channel.id));
    const attemptChannel = channel;
    const noteAttempt = (err: ChannelAttemptError) =>
      processChannelError({
        store,
        env: opts.env,
        req: opts.req,
        auth,
        channel: attemptChannel,
        model,
        err,
        useChannel: [...usedChannel],
        useTimeSeconds: Math.max(0, Math.round((Date.now() - requestStarted) / 1000)),
        isStream: opts.stream,
        requestId: rid,
      });
    const skipFurtherRetry = suppressesRetry || (usedAffinityChannel && Boolean(affinity?.skipRetryOnFailure));
    const lastAttempt = retry === retryTimes || skipFurtherRetry;
    const affinityLog = usedAffinityChannel && affinity ? channelAffinityLogInfo(affinity, auth.usingGroup, channel.id) : undefined;
    const kind = channelKind(channel.type);
    let mapped = model;
    let outbound: unknown = opts.body;
    let advancedConverter: string | undefined;
    let openaiEditForm: OpenAIImageEditForm | undefined;
    let openaiAudioForm: EncodedMultipart | undefined;
    let cloudflareAudioBody: Uint8Array | undefined;
    let viaResponses = false;
    let viaParamApplied = false;
    const viaParamHeaders: Record<string, string> = {};
    const paramOverrideAudit: string[] = [];
    let passThrough = passThroughGlobal;
    let channelOtherSettings: ChannelDisabledFieldSettings = {};
    const multipartEdits =
      mode === "images" &&
      isAliImageEdits(requestPath) &&
      Boolean(opts.rawBody) &&
      (opts.rawContentType || "").includes("multipart/form-data");
    const multipartAudio =
      (mode === "audio_transcription" || mode === "audio_translation") &&
      Boolean(opts.rawBody) &&
      (opts.rawContentType || "").includes("multipart/form-data");
    const aliMultipartEdits = multipartEdits && channel.type === CHANNEL_TYPE_ALI;
    try {
      mapped = applyModelMapping(channel, model);
      const endpointErr = nativeOpenAIConvertEndpointError(channel.type, mode);
      if (endpointErr) throw new Error(endpointErr);
      const channelSetting = parseJson<Record<string, unknown>>(String(channel.setting || ""), {});
      channelOtherSettings = parseJson<ChannelDisabledFieldSettings>(String(channel.settings || ""), {});
      passThrough = passThroughGlobal || Boolean(channelSetting.pass_through_body_enabled);
      viaResponses =
        !passThrough &&
        !opts.rawBody &&
        ((clientFormat === "anthropic") || (clientFormat === "openai" && mode === "chat")) &&
        shouldChatCompletionsUseResponsesPolicy(chatResponsesPolicy, channel.id, channel.type, model);
      if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
        advancedConverter = resolveAdvancedCustomConverter(channel, requestPath, model);
      }
      if (
        multipartEdits &&
        channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM &&
        String(advancedConverter || CONVERTER_NONE).trim() &&
        String(advancedConverter || CONVERTER_NONE).trim() !== CONVERTER_NONE
      ) {
        throw converterDoesNotSupport(String(advancedConverter), "image");
      }
      if (
        multipartAudio &&
        channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM &&
        String(advancedConverter || CONVERTER_NONE).trim() &&
        String(advancedConverter || CONVERTER_NONE).trim() !== CONVERTER_NONE
      ) {
        throw converterDoesNotSupport(String(advancedConverter), "audio");
      }
      if (multipartAudio && (channel.type === CHANNEL_TYPE_NEW_API || channel.type === CHANNEL_TYPE_SUB2API)) {
        newApiUnsupportedEndpoint();
      }
      if (aliMultipartEdits) {
        outbound = convertAliFormEditFromRaw(opts.rawBody as ArrayBuffer, opts.rawContentType || "", {
          upstreamModelName: mapped,
          requestPath,
        });
      } else if (multipartEdits && usesOpenAIImageEditAdaptor(channel.type, advancedConverter)) {
        openaiEditForm = convertOpenAIImageEditForm(opts.rawBody as ArrayBuffer, opts.rawContentType || "", mapped);
        outbound = opts.body;
      } else if (multipartAudio && usesOpenAIAudioAdaptor(channel.type, advancedConverter)) {
        openaiAudioForm = convertOpenAIAudioForm(opts.rawBody as ArrayBuffer, opts.rawContentType || "", mapped);
        outbound = opts.body;
      } else if (multipartAudio && channel.type === CHANNEL_TYPE_CLOUDFLARE) {
        cloudflareAudioBody = convertCloudflareAudioRequest(opts.rawBody as ArrayBuffer, opts.rawContentType || "");
        outbound = opts.body;
      } else if (channel.type === CHANNEL_TYPE_CLOUDFLARE && isCloudflareSTTRelayMode(mode)) {
        throw new Error("file is required");
      } else if (opts.rawBody) {
        outbound = opts.body;
      } else {
        const convertExtras: {
          botId?: string;
          responseId?: string;
          channelKey?: string;
          requestPath?: string;
          systemPrompt?: string;
          systemPromptOverride?: boolean;
          converter?: string;
          isStream?: boolean;
          channelBase?: string;
          viaResponses?: boolean;
          channelOtherSettings?: ChannelDisabledFieldSettings;
          passThrough?: boolean;
          applyViaResponsesChatParamOverride?: (chat: Record<string, unknown>) => Record<string, unknown>;
        } = {
          botId: channel.other || "",
          responseId: `chatcmpl-${rid}`,
          channelKey: pickChannelKey(channel.key),
          channelBase: resolveBaseUrl(channel.type, channel.base_url),
          requestPath,
          systemPrompt: String(channelSetting.system_prompt || ""),
          systemPromptOverride: Boolean(channelSetting.system_prompt_override),
          converter: advancedConverter,
          isStream: opts.stream,
          viaResponses,
          channelOtherSettings,
          passThrough,
        };
        if (
          viaResponses &&
          clientFormat === "openai" &&
          Object.keys(channelParamOverrideMap(channel, affinity?.template)).length
        ) {
          convertExtras.applyViaResponsesChatParamOverride = (chat) => {
            const next = applyChannelParamOverride(
              channel,
              chat,
              viaParamHeaders,
              {
                requestHeaders: requestHeadersFrom(opts.req),
                userId: auth.user.id,
                userGroup: auth.user.group,
                tokenGroup: auth.token.group,
                usingGroup: auth.usingGroup,
                originalModel: model,
                upstreamModel: mapped,
                requestPath: path,
                retryIndex: retry,
                affinityTemplate: affinity?.template,
                isStream: opts.stream,
                relayFormat: "openai",
                isClaudeBetaQuery: new URL(opts.req.url).searchParams.get("beta") === "true",
                geminiVersionSettings: convertSettings.geminiVersionSettings,
                paramOverrideAudit,
              },
              pickChannelKey(channel.key),
              mapped,
            );
            viaParamApplied = true;
            return asObj(next);
          };
        }
        outbound = await convertOutbound(kind, clientFormat, opts.body, channel.type, mapped, model, convertSettings, mode, convertExtras);
      }
      if ((!opts.rawBody || aliMultipartEdits) && usesRemoveDisabledFields(clientFormat, mode, viaResponses)) {
        outbound = removeDisabledFields(outbound, channelOtherSettings, passThrough);
      }
      if (!opts.rawBody || aliMultipartEdits) {
        const convertedModel = asObj(outbound).model;
        if (typeof convertedModel === "string" && convertedModel) mapped = convertedModel;
        else {
          mapped = applyReasoningModelSuffix(
            asObj(opts.body),
            model,
            mapped,
            convertSettings,
            viaResponses || mode === "responses" ? "responses" : "chat",
          ).upstreamModelName;
        }
      }
    } catch (err) {
      const ret = convertRequestFailed(err);
      await noteAttempt(channelAttemptFromNewApi(ret.message, ret.statusCode, ret.code, ret.skipRetry));
      if (ret.skipRetry || lastAttempt) return writeRelayNewAPIError(opts.req, ret.statusCode, ret.message, ret.code, ret.type);
      lastErr = ret.message;
      lastStatus = ret.statusCode;
      lastCode = ret.code;
      lastType = ret.type || ERROR_TYPE_NEW_API_ERROR;
      continue;
    }
    const outboundMode = viaResponses ? "responses" : mode;
    const outboundPath = viaResponses ? "/v1/responses" : path;
    const relayInfo: ParamOverrideRelayInfo = {
      requestHeaders: requestHeadersFrom(opts.req),
      userId: auth.user.id,
      userGroup: auth.user.group,
      tokenGroup: auth.token.group,
      usingGroup: auth.usingGroup,
      originalModel: model,
      upstreamModel: mapped,
      requestPath: outboundPath,
      retryIndex: retry,
      affinityTemplate: affinity?.template,
      isStream: opts.stream,
      passThrough,
      relayFormat: clientFormat === "anthropic" ? "claude" : clientFormat === "gemini" ? "gemini" : "openai",
      isClaudeBetaQuery: new URL(opts.req.url).searchParams.get("beta") === "true",
      geminiVersionSettings: convertSettings.geminiVersionSettings,
      skipParamOverride: viaParamApplied,
      paramOverrideAudit,
    };
    let target: UpstreamTarget;
    try {
      target = buildChannelRelayTarget(
        channel,
        outboundMode,
        outboundPath,
        model,
        aliMultipartEdits || !opts.rawBody ? outbound : null,
        {
          "anthropic-version": opts.req.headers.get("anthropic-version") || "",
          "anthropic-beta": opts.req.headers.get("anthropic-beta") || "",
          plugin: opts.req.headers.get("plugin") || opts.req.headers.get("X-DashScope-Plugin") || "",
        },
        opts.method || opts.req.method || "POST",
        opts.stream,
        relayInfo,
      );
      if (viaParamApplied) {
        for (const [key, value] of Object.entries(viaParamHeaders)) {
          target.headers[key] = value;
        }
      }
    } catch (err) {
      const ret = asParamOverrideReturnError(err);
      if (ret) {
        await noteAttempt(channelAttemptFromNewApi(ret.message, ret.statusCode, ret.code, ret.skipRetry));
        if (ret.skipRetry || lastAttempt) return writeRelayNewAPIError(opts.req, ret.statusCode, ret.message, ret.code, ret.type);
        lastErr = ret.message;
        lastStatus = ret.statusCode;
        lastCode = ret.code;
        lastType = ret.type || ERROR_TYPE_NEW_API_ERROR;
        continue;
      }
      lastErr = err instanceof Error ? err.message : String(err);
      lastStatus = 400;
      lastCode = ERROR_CODE_CONVERT_REQUEST_FAILED;
      lastType = ERROR_TYPE_NEW_API_ERROR;
      await noteAttempt(channelAttemptFromNewApi(lastErr, 400, "convert_request_failed"));
      if (lastAttempt) return writeRelayNewAPIError(opts.req, 400, lastErr, ERROR_CODE_CONVERT_REQUEST_FAILED);
      continue;
    }
    if (openaiEditForm) {
      target.body = openaiEditForm.body;
      target.headers["content-type"] = openaiEditForm.contentType;
    } else if (openaiAudioForm) {
      target.body = openaiAudioForm.body;
      target.headers["content-type"] = openaiAudioForm.contentType;
    } else if (cloudflareAudioBody) {
      target.body = cloudflareAudioBody;
      delete target.headers["content-type"];
    } else if (opts.rawBody && !aliMultipartEdits) {
      target.body = opts.rawBody;
      if (opts.rawContentType) target.headers["content-type"] = opts.rawContentType;
      else delete target.headers["content-type"];
      if (typeof opts.rawBody === "string" && (opts.rawContentType || "").includes("json")) {
        try {
          target.body = applyChannelParamOverride(channel, opts.rawBody, target.headers, relayInfo, pickChannelKey(channel.key), mapped);
        } catch (err) {
          const ret = asParamOverrideReturnError(err);
          if (ret) {
            await noteAttempt(channelAttemptFromNewApi(ret.message, ret.statusCode, ret.code, ret.skipRetry));
            if (ret.skipRetry || lastAttempt) return writeRelayNewAPIError(opts.req, ret.statusCode, ret.message, ret.code, ret.type);
            lastErr = ret.message;
            lastStatus = ret.statusCode;
            lastCode = ret.code;
            lastType = ret.type || ERROR_TYPE_NEW_API_ERROR;
            continue;
          }
          lastErr = err instanceof Error ? err.message : String(err);
          lastStatus = 400;
          lastCode = ERROR_CODE_CONVERT_REQUEST_FAILED;
          lastType = ERROR_TYPE_NEW_API_ERROR;
          await noteAttempt(channelAttemptFromNewApi(lastErr, 400, "convert_request_failed"));
          if (lastAttempt) return writeRelayNewAPIError(opts.req, 400, lastErr, ERROR_CODE_CONVERT_REQUEST_FAILED);
          continue;
        }
      }
    }
    if (mode === "images") {
      let previousCount = 1;
      try {
        previousCount = imageRequestCount(asObj(opts.body), channel.type === CHANNEL_TYPE_ALI);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await noteAttempt(channelAttemptFromNewApi(message, 400, "invalid_request", true));
        return writeRelayNewAPIError(opts.req, 400, message, ERROR_CODE_INVALID_REQUEST);
      }
      const outbound = refreshOutboundImageQuantity(target, previousCount, channel.type);
      if (outbound.error) {
        await noteAttempt(channelAttemptFromNewApi(outbound.error, 400, "invalid_request", true));
        return writeRelayNewAPIError(opts.req, 400, outbound.error, ERROR_CODE_INVALID_REQUEST);
      }
      const prepared = await prepareImageBillingForRequest(store, auth, {
        count: outbound.count,
        promptExtend: outbound.promptExtend,
        channelType: channel.type,
        upstreamModelName: mapped,
        price: priceQuota,
        snapshot: tieredSnapshot,
        billingRequestInput,
        session: billing,
        requestId: rid,
        playground: Boolean(opts.playground),
        billingModelName,
      });
      if (prepared.error) {
        await noteAttempt(
          channelAttemptFromNewApi(prepared.error.message, prepared.error.status, prepared.error.code, prepared.error.skipRetry !== false),
        );
        return writeRelayNewAPIError(opts.req, prepared.error.status, prepared.error.message, prepared.error.code);
      }
      if (prepared.session) billing = prepared.session;
    }
    const started = Date.now();
    let res: Response;
    let cozeUsage: CozeUsage | undefined;
    try {
      if (channel.type === CHANNEL_TYPE_BAIDU) {
        target.url = await applyBaiduAccessToken(target.url, pickChannelKey(channel.key));
      }
      if (channel.type === CHANNEL_TYPE_VERTEX) {
        await applyVertexAdcAuth(channel, target.headers, target.apiKey || pickChannelKey(channel.key));
      }
      if (channel.type === CHANNEL_TYPE_AWS) {
        target.body = await applyAwsAkskAuth(
          channel,
          target.headers,
          target.url,
          target.method || "POST",
          target.body,
          target.apiKey || pickChannelKey(channel.key),
        );
      }
      if (channel.type === CHANNEL_TYPE_ZHIPU) {
        await applyZhipuV3Authorization(target.headers, pickChannelKey(channel.key));
      }
      if (channel.type === CHANNEL_TYPE_TENCENT && tencentUsesNativeAdaptor(pickChannelKey(channel.key))) {
        target.body = await applyTencentTc3Authorization(target.headers, target.body, pickChannelKey(channel.key));
      }
      if (channel.type === CHANNEL_TYPE_JIMENG) {
        target.body = await applyJimengAuthorization(
          target.headers,
          target.url,
          target.method || "POST",
          target.body,
          pickChannelKey(channel.key),
        );
      }
      if (channel.type === CHANNEL_TYPE_XUNFEI) {
        try {
          parseXunfeiAuth(pickChannelKey(channel.key));
          res = await runXunfeiChat(asObj(outbound), pickChannelKey(channel.key), {
            stream: opts.stream,
            requestUrl: opts.req.url,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "invalid auth") {
            await noteAttempt(channelAttemptFromNewApi("invalid auth", 500, ERROR_CODE_CHANNEL_INVALID_KEY));
            return writeRelayNewAPIError(opts.req, 500, message, ERROR_CODE_CHANNEL_INVALID_KEY);
          }
          lastErr = message;
          lastStatus = 500;
          lastCode = ERROR_CODE_DO_REQUEST_FAILED;
          lastType = ERROR_TYPE_NEW_API_ERROR;
          await noteAttempt(channelAttemptFromNewApi(message, 500, "do_request_failed"));
          if (!lastAttempt && retryable(500, retryRanges)) continue;
          return writeRelayNewAPIError(opts.req, 500, message, "do_request_failed");
        }
      } else if (channel.type === CHANNEL_TYPE_VOLC && mode === "audio_speech" && volcTtsIsStream(asObj(outbound))) {
        try {
          parseVolcengineAuth(pickChannelKey(channel.key));
          res = await runVolcTtsWebSocket(
            target.url,
            pickChannelKey(channel.key),
            asObj(outbound),
            volcTtsEncodingFromRequest(asObj(outbound)),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = Number((err as { status?: number }).status || 502);
          const code = String((err as { code?: string }).code || "bad_response_status_code");
          await noteAttempt({
            message,
            statusCode: status,
            errorCode: code,
            errorType: code.startsWith("channel:") ? "new_api_error" : "openai_error",
          });
          return writeRelayNewAPIError(opts.req, status, message, code);
        }
      } else {
        res = await fetchUpstream(target);
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      lastStatus = 500;
      lastCode = ERROR_CODE_DO_REQUEST_FAILED;
      lastType = ERROR_TYPE_NEW_API_ERROR;
      await noteAttempt(channelAttemptFromNewApi(lastErr, 500, ERROR_CODE_DO_REQUEST_FAILED));
      if (skipFurtherRetry || lastAttempt) return writeRelayNewAPIError(opts.req, 500, lastErr, ERROR_CODE_DO_REQUEST_FAILED);
      continue;
    }
    const useTime = Math.max(0, Math.round((Date.now() - started) / 1000));
    const channelSetting = parseJson<Record<string, unknown>>(String(channel.setting || ""), {});
    const extra: SettleLogExtra = {
      upstreamRequestId: res.headers.get("x-oneapi-request-id") || res.headers.get("x-request-id") || "",
      requestPath,
      channelAffinity: affinityLog,
      env: opts.env,
      affinity: affinity || undefined,
      clientFormat,
      cachedTokens: 0,
      promptCacheHitTokens: 0,
      startMs: requestStarted,
      firstResponseMs: Date.now(),
      useChannel: [...usedChannel],
      isModelMapped: mapped !== model,
      upstreamModelName: mapped,
      reasoningEffort: String(asObj(opts.body).reasoning_effort || ""),
      isSystemPromptOverwritten: Boolean(channelSetting.system_prompt && channelSetting.system_prompt_override),
      requestConversion: requestConversionChain({
        clientFormat,
        mode,
        viaResponses,
        destinationFormat: destinationRelayFormat(channel.type, mode, viaResponses),
      }),
      billingSource: billing?.funding || "wallet",
      billingPreference: billing?.billingPreference,
      billing,
      relayMode: mode,
      imageBody: asObj(opts.body),
      imageChannelType: channel.type,
      requestHeaders: requestHeadersFrom(opts.req),
      tieredSnapshot: tieredSnapshot || undefined,
      billingRequestInput,
      billingModelName,
      otherRatios: priceQuota.otherRatios,
      toolUsage: createToolUsageState({
        model: billingModelName,
        toolPrices,
        relayMode: viaResponses ? "responses" : mode,
        requestTools: asObj(opts.body).tools,
      }),
      paramOverrideAudit,
    };

    if (!res.ok) {
      const text = await res.text();
      lastErr = text || res.statusText;
      lastStatus = res.status;
      await noteAttempt(channelAttemptFromUpstream(res.status, text));
      if (!lastAttempt && retryable(res.status, retryRanges)) continue;
      await settle(store, auth, channel, model, promptEst, 0, useTime, opts.stream, ip, rid, false, lastErr.slice(0, 2000), extra);
      const errRes = relayErrorHandler(res.status, text, String(channel.status_code_mapping || ""), opts.req);
      const headers = new Headers(errRes.headers);
      headers.set("x-oneapi-request-id", rid);
      return new Response(errRes.body, { status: errRes.status, headers });
    }

    if (channel.type === CHANNEL_TYPE_COZE && !opts.stream && mode !== "embeddings" && mode !== "rerank") {
      try {
        const completed = await completeCozeNonStreamChat(res, resolveBaseUrl(channel.type, channel.base_url), target.headers);
        res = completed.response;
        cozeUsage = completed.usage;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, message.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
      }
    }

    const ct = res.headers.get("content-type") || "";
    let isSSE = ct.includes("text/event-stream") || opts.stream;
    if (channel.type === CHANNEL_TYPE_OLLAMA) {
      if (mode === "embeddings") isSSE = false;
      else if (mode !== "responses") isSSE = Boolean(opts.stream);
    }
    if (
      channel.type === CHANNEL_TYPE_COHERE ||
      channel.type === CHANNEL_TYPE_DIFY ||
      channel.type === CHANNEL_TYPE_COZE ||
      channel.type === CHANNEL_TYPE_BAIDU ||
      channel.type === CHANNEL_TYPE_ZHIPU
    ) {
      if (mode === "embeddings" || mode === "rerank") isSSE = false;
      else isSSE = Boolean(opts.stream);
    }
    if (channel.type === CHANNEL_TYPE_CLOUDFLARE && mode !== "responses") {
      isSSE = Boolean(opts.stream);
    }
    if (channel.type === CHANNEL_TYPE_PALM) {
      isSSE = Boolean(opts.stream);
    }
    if (channel.type === CHANNEL_TYPE_XUNFEI) {
      isSSE = Boolean(opts.stream);
    }
    if (channel.type === CHANNEL_TYPE_TENCENT && tencentUsesNativeAdaptor(pickChannelKey(channel.key))) {
      isSSE = Boolean(opts.stream);
    }
    if (affinity) {
      ctx?.waitUntil(recordChannelAffinity(store, opts.env, affinity.cacheKeySuffix, channel.id, affinity.ttlSeconds));
    }

    const ollamaResponsesPassthrough = channel.type === CHANNEL_TYPE_OLLAMA && mode === "responses";
    const openaiShapedInbound =
      (kind === "openai" &&
        channel.type !== CHANNEL_TYPE_PALM &&
        !(channel.type === CHANNEL_TYPE_TENCENT && tencentUsesNativeAdaptor(pickChannelKey(channel.key)))) ||
      channel.type === CHANNEL_TYPE_ZHIPU_V4 ||
      (channel.type === CHANNEL_TYPE_ALI && mode !== "images" && mode !== "rerank") ||
      (channel.type === CHANNEL_TYPE_CLOUDFLARE && mode === "responses") ||
      (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM && advancedCustomOpenaiShapedInbound(advancedConverter || "none"));
    if (isSSE && res.body) {
      extra.streamStatus = new StreamStatus();
      if (usesClaudeStreamUnmarshal(channel.type, mode, opts.stream)) {
        const streamText = await res.text();
        const unmarshalErr = claudeStreamSseUnmarshalError(streamText);
        if (unmarshalErr) {
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
        }
        res = new Response(streamText, { status: res.status, headers: res.headers });
      }
      if (usesGeminiChatStreamUnmarshal(channel.type, mapped, mode, opts.stream)) {
        const streamText = await res.text();
        const unmarshalErr = geminiChatStreamSseUnmarshalError(streamText);
        if (unmarshalErr) {
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
          return writeGeminiChatUnmarshalError(opts.req, unmarshalErr);
        }
        res = new Response(streamText, { status: res.status, headers: res.headers });
      }
      if (!res.body) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, "bad_response_body", extra);
        return writeRelayNewAPIError(opts.req, 500, "bad_response_body", ERROR_CODE_BAD_RESPONSE_BODY);
      }
      if (
        (usesOpenAIAdaptor(channel.type) ||
          (delegatesClaudeToOpenAIAdaptor(channel.type) && clientFormat === "anthropic") ||
          (channel.type === CHANNEL_TYPE_VOLC && clientFormat === "anthropic" && !isChannelSpecialBase(channel.base_url))) &&
        (clientFormat === "anthropic" || (usesOpenAIAdaptor(channel.type) && clientFormat === "gemini"))
      ) {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted =
            clientFormat === "anthropic"
              ? looksLikeResponsesSse(text)
                ? oaiResponsesSseToClaudeSse(text, { estimatePromptTokens: promptEst })
                : oaiChatSseToClaudeSse(text, { estimatePromptTokens: promptEst })
              : oaiChatSseToGeminiSse(text, { estimatePromptTokens: promptEst });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (
        clientFormat === "anthropic" &&
        (channel.type === CHANNEL_TYPE_GEMINI || (channel.type === CHANNEL_TYPE_VERTEX && vertexRequestMode(mapped) === "gemini"))
      ) {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted = geminiSseToClaudeSse(text, {
            estimatePromptTokens: promptEst,
            id: `chatcmpl-${rid}`,
            created: Math.floor(started / 1000),
            upstreamModel: mapped,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (channel.type === CHANNEL_TYPE_VERTEX && clientFormat === "anthropic" && vertexRequestMode(mapped) === "opensource") {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted = oaiChatSseToClaudeSse(text, { estimatePromptTokens: promptEst });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (
        clientFormat === "gemini" &&
        (channel.type === CHANNEL_TYPE_ANTHROPIC || (channel.type === CHANNEL_TYPE_VERTEX && vertexRequestMode(mapped) === "claude"))
      ) {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted = claudeSseToGeminiSse(text, {
            estimatePromptTokens: promptEst,
            upstreamModel: mapped,
            created: Math.floor(started / 1000),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (channel.type === CHANNEL_TYPE_VERTEX && clientFormat === "gemini" && vertexRequestMode(mapped) === "opensource") {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted = oaiChatSseToGeminiSse(text, { estimatePromptTokens: promptEst });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (
        viaResponses &&
        clientFormat === "openai"
      ) {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted = oaiResponsesSseToChatSse(text, {
            id: `chatcmpl-${rid}`,
            model: mapped,
            created: Math.floor(started / 1000),
            includeUsage: shouldIncludeUsage(asObj(opts.body)),
            fallbackPromptTokens: promptEst,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (
        clientFormat === "openai" &&
        channel.type === CHANNEL_TYPE_XAI &&
        mode !== "images" &&
        mode !== "responses"
      ) {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        let converted: { sse: string; usageBody: Record<string, unknown> };
        try {
          converted = xaiSseToOpenAIChat(text);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody && Object.keys(converted.usageBody).length ? { usage: converted.usageBody } : {});
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      if (!openaiShapedInbound && clientFormat === "openai" && !ollamaResponsesPassthrough) {
        const text = await res.text();
        ingestUpstreamToolUsage(extra.toolUsage, { sseText: text });
        noteRelaySseStatus(extra, text);
        const includeUsage = shouldIncludeUsage(asObj(opts.body));
        let converted: { body: string; usageBody: Record<string, unknown> };
        try {
          converted = await openaiClientFromProvider(kind, text, mapped, true, {
            requestId: rid,
            includeUsage,
            fallbackPromptTokens: promptEst,
            channelType: channel.type,
            relayMode: mode,
            channelKey: pickChannelKey(channel.key),
            converter: advancedConverter,
            created: Math.floor(started / 1000),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          if (message.startsWith("unsupported advanced custom converter:")) {
            return writeRelayNewAPIError(opts.req, 400, message, ERROR_CODE_INVALID_REQUEST);
          }
          return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody);
        attachSettleUsage(extra, usage);
        await settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra);
        return new Response(converted.body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      const [clientBody, logBody] = res.body.tee();
      pendingStreamSettle = true;
      ctx?.waitUntil(
        parseStreamAndSettle(store, auth, channel, model, promptEst, useTime, ip, rid, logBody, extra).finally(() =>
          refundBilling(store, auth, extra.billing),
        ),
      );
      const headers = new Headers();
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("cache-control", "no-cache");
      headers.set("x-oneapi-request-id", rid);
      return new Response(clientBody, { status: 200, headers });
    }

    if (channel.type === CHANNEL_TYPE_VOLC && mode === "audio_speech") {
      try {
        const encoding = volcTtsEncodingFromRequest(asObj(outbound));
        const audioRes = volcTtsIsStream(asObj(outbound)) ? res : await wrapVolcTtsHttpResponse(res, encoding);
        extra.cachedTokens = 0;
        extra.promptCacheHitTokens = 0;
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, true, "", extra);
        const headers = new Headers();
        headers.set("content-type", audioRes.headers.get("content-type") || "application/octet-stream");
        headers.set("x-oneapi-request-id", rid);
        return new Response(audioRes.body, { status: 200, headers });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = Number((err as { status?: number }).status || 500);
        const code = String((err as { code?: string }).code || "bad_response");
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, message.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, status, message, code);
      }
    }

    let text = await res.text();
    if (usesOpenRouterEnterpriseUnwrap(channel.type, channel.settings, mode) && !viaResponses) {
      const unwrapped = unwrapOpenRouterEnterpriseResponse(text);
      if (!unwrapped.ok) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unwrapped.message.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unwrapped.message);
      }
      text = unwrapped.body;
    }
    const openaiUnmarshalMode = openaiDoResponseUnmarshalMode(mode, viaResponses, path);
    if (usesGeminiChatResponseUnmarshal(channel.type, mapped, mode)) {
      const unmarshalErr = geminiChatResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeGeminiChatUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesOpenAIAdaptor(channel.type) && usesOpenaiHandlerGetOpenAIError(openaiUnmarshalMode)) {
      const unmarshalErr = openaiHandlerResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesRerankHandlerUnmarshal(channel.type, mode)) {
      const unmarshalErr = rerankHandlerResponseUnmarshalError(text, channel.type);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesAliSiliconflowRerankUnmarshal(channel.type, mode)) {
      const unmarshalErr = aliSiliconflowRerankResponseUnmarshalError(text, channel.type);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesCohereRerankUnmarshal(channel.type, mode)) {
      const unmarshalErr = cohereRerankResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesCohereChatUnmarshal(channel.type, mode)) {
      const unmarshalErr = cohereChatResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesPalmTencentZhipuUnmarshal(channel.type, mode, tencentUsesNativeAdaptor(pickChannelKey(channel.key)))) {
      const unmarshalErr = palmTencentZhipuResponseUnmarshalError(text, channel.type);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesBaiduUnmarshal(channel.type, mode)) {
      const unmarshalErr = baiduResponseUnmarshalError(text, mode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesCozeUnmarshal(channel.type, mode)) {
      const unmarshalErr = cozeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesDifyUnmarshal(channel.type, mode)) {
      const unmarshalErr = difyResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesMokaUnmarshal(channel.type, mode)) {
      const unmarshalErr = mokaResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesCloudflareUnmarshal(channel.type, mode)) {
      const unmarshalErr = cloudflareResponseUnmarshalError(text, mode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesXaiUnmarshal(channel.type, mode)) {
      const unmarshalErr = xaiResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesJimengUnmarshal(channel.type, mode)) {
      const unmarshalErr = jimengResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesJimengChatUnmarshal(channel.type, mode)) {
      const unmarshalErr = jimengChatResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesMistralChatUnmarshal(channel.type, mode)) {
      const unmarshalErr = mistralChatResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesSubmodelChatUnmarshal(channel.type, mode)) {
      const unmarshalErr = submodelChatResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesJinaEmbeddingsUnmarshal(channel.type, mode)) {
      const unmarshalErr = jinaEmbeddingsResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesVertexOpenSourceUnmarshal(channel.type, mode, mapped)) {
      const unmarshalErr = vertexOpenSourceResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesPerplexityUnmarshal(channel.type, mode)) {
      const unmarshalErr = perplexityResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesSiliconflowUnmarshal(channel.type, mode)) {
      const unmarshalErr = siliconflowResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesDeepseekUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = deepseekResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesMoonshotUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = moonshotResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesBaiduV2Unmarshal(channel.type, mode)) {
      const unmarshalErr = baiduV2ResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesAliUnmarshal(channel.type, mode) && !(clientFormat === "anthropic" && supportsAliAnthropicMessages(mapped))) {
      const unmarshalErr = aliResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesAliImageUnmarshal(channel.type, mode)) {
      const unmarshalErr = aliImageResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesVolcUnmarshal(channel.type, mode) && !(clientFormat === "anthropic" && isChannelSpecialBase(channel.base_url))) {
      const unmarshalErr = volcResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesMiniMaxUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = miniMaxResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesMiniMaxImageUnmarshal(channel.type, mode)) {
      const unmarshalErr = miniMaxImageResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesOllamaUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = ollamaResponseUnmarshalError(text, mode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesZhipuV4Unmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = zhipuV4ResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesZhipuV4ImageUnmarshal(channel.type, mode)) {
      const unmarshalErr = zhipuV4ImageResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesNewApiUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = newApiResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesSub2apiUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = sub2apiResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesAdvancedCustomUnmarshal(channel.type, mode, advancedConverter || "none") && clientFormat === "openai") {
      const unmarshalErr = advancedCustomResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesAdvancedCustomClaudeUnmarshal(channel.type, mode, advancedConverter || "none", clientFormat)) {
      const unmarshalErr = advancedCustomClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesAdvancedCustomGeminiUnmarshal(channel.type, mode, advancedConverter || "none", clientFormat, mapped)) {
      const unmarshalErr = advancedCustomGeminiResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeGeminiChatUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesCodexUnmarshal(channel.type, mode) && clientFormat === "openai") {
      const unmarshalErr = codexResponseUnmarshalError(text, openaiUnmarshalMode);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeOpenaiHandlerUnmarshalError(opts.req, unmarshalErr);
      }
    }
    if (usesClaudeHandlerUnmarshal(channel.type, mode)) {
      const unmarshalErr = claudeHandlerResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesAwsClaudeUnmarshal(channel.type, mode, channel.settings)) {
      const unmarshalErr = awsClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesAwsAkskClaudeUnmarshal(channel.type, mapped, mode, channel.settings)) {
      const unmarshalErr = awsAkskClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesVertexClaudeUnmarshal(channel.type, mode, mapped)) {
      const unmarshalErr = vertexClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesMoonshotClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = moonshotClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesMiniMaxClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = miniMaxClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesDeepseekClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = deepseekClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesZhipuV4ClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = zhipuV4ClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesNewApiClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = newApiClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesSub2apiClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = sub2apiClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesOllamaClaudeUnmarshal(channel.type, mode) && clientFormat === "anthropic") {
      const unmarshalErr = ollamaClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesAliClaudeUnmarshal(channel.type, mode, mapped) && clientFormat === "anthropic") {
      const unmarshalErr = aliClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesVolcClaudeUnmarshal(channel.type, mode, channel.base_url) && clientFormat === "anthropic") {
      const unmarshalErr = volcClaudeResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesReplicateUnmarshal(channel.type, mode)) {
      const unmarshalErr = replicateResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesMiniMaxTTSUnmarshal(channel.type, mode)) {
      const unmarshalErr = miniMaxTTSResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    if (usesAwsNovaUnmarshal(channel.type, mapped, mode, channel.settings)) {
      const unmarshalErr = awsNovaResponseUnmarshalError(text);
      if (unmarshalErr) {
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, unmarshalErr.slice(0, 2000), extra);
        return writeRelayNewAPIError(opts.req, 500, unmarshalErr, ERROR_CODE_BAD_RESPONSE_BODY);
      }
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
      if (usesGeminiChatResponseUnmarshal(channel.type, mapped, mode) && (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))) {
        parsed = {};
      }
      if (
        usesOpenAIAdaptor(channel.type) &&
        usesOpenaiHandlerGetOpenAIError(openaiUnmarshalMode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesRerankHandlerUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAliSiliconflowRerankUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesCohereRerankUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesCohereChatUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesPalmTencentZhipuUnmarshal(channel.type, mode, tencentUsesNativeAdaptor(pickChannelKey(channel.key))) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesBaiduUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesCozeUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesDifyUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMokaUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesCloudflareUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesXaiUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesJimengUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesJimengChatUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMistralChatUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesSubmodelChatUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesJinaEmbeddingsUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesVertexOpenSourceUnmarshal(channel.type, mode, mapped) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesPerplexityUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesSiliconflowUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesDeepseekUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMoonshotUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesBaiduV2Unmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAliUnmarshal(channel.type, mode) &&
        !(clientFormat === "anthropic" && supportsAliAnthropicMessages(mapped)) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAliImageUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesVolcUnmarshal(channel.type, mode) &&
        !(clientFormat === "anthropic" && isChannelSpecialBase(channel.base_url)) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMiniMaxUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMiniMaxImageUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesOllamaUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesZhipuV4Unmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesZhipuV4ImageUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesNewApiUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesSub2apiUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAdvancedCustomUnmarshal(channel.type, mode, advancedConverter || "none") &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAdvancedCustomClaudeUnmarshal(channel.type, mode, advancedConverter || "none", clientFormat) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAdvancedCustomGeminiUnmarshal(channel.type, mode, advancedConverter || "none", clientFormat, mapped) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesCodexUnmarshal(channel.type, mode) &&
        clientFormat === "openai" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesClaudeHandlerUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAwsClaudeUnmarshal(channel.type, mode, channel.settings) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAwsAkskClaudeUnmarshal(channel.type, mapped, mode, channel.settings) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesVertexClaudeUnmarshal(channel.type, mode, mapped) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMoonshotClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMiniMaxClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesDeepseekClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesZhipuV4ClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesNewApiClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesSub2apiClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesOllamaClaudeUnmarshal(channel.type, mode) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAliClaudeUnmarshal(channel.type, mode, mapped) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesVolcClaudeUnmarshal(channel.type, mode, channel.base_url) &&
        clientFormat === "anthropic" &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesReplicateUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesMiniMaxTTSUnmarshal(channel.type, mode) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      if (
        usesAwsNovaUnmarshal(channel.type, mapped, mode, channel.settings) &&
        (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      ) {
        parsed = {};
      }
      ingestUpstreamToolUsage(extra.toolUsage, { json: parsed });
    } catch {
      if (channel.type === CHANNEL_TYPE_OLLAMA && clientFormat === "openai" && mode !== "responses" && mode !== "embeddings") {
        parsed = {};
      } else {
        if (channel.type === CHANNEL_TYPE_OLLAMA && mode === "embeddings") {
          await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, "bad_response_body", extra);
          return writeRelayNewAPIError(opts.req, 500, "bad_response_body", "bad_response_body");
        }
        if (channel.type === CHANNEL_TYPE_CLOUDFLARE && isCloudflareSTTRelayMode(mode)) {
          await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, "bad_response_body", extra);
          return writeRelayNewAPIError(opts.req, 500, "bad_response_body", "bad_response_body");
        }
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, true, "", extra);
        return new Response(text, {
          status: 200,
          headers: { "content-type": ct || "application/json", "x-oneapi-request-id": rid },
        });
      }
    }
    if (usesGeminiEmptyCandidatesHandler(channel.type, mapped, mode)) {
      const empty = geminiChatEmptyCandidatesError(parsed);
      if (empty) {
        const status = resetNewAPIErrorStatusCode(empty.status, String(channel.status_code_mapping || ""));
        if (mode === "responses") {
          await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, empty.message.slice(0, 2000), extra);
          return writeRelayNewAPIError(opts.req, status, empty.message, empty.code);
        }
        const usage = usageFromOpenAI(parsed);
        attachSettleUsage(extra, usage);
        await settle(
          store,
          auth,
          channel,
          model,
          usage.prompt || promptEst,
          usage.completion,
          useTime,
          false,
          ip,
          rid,
          true,
          "",
          extra,
        );
        return writeGeminiChatEmptyCandidatesError(opts.req, status, empty.message, empty.code);
      }
    }
    if (usesOpenAIAdaptor(channel.type) && usesOpenaiHandlerGetOpenAIError(openaiUnmarshalMode)) {
      const oai = getOpenAIError(parsed.error);
      if (oai && oai.type) {
        await settle(
          store,
          auth,
          channel,
          model,
          promptEst,
          0,
          useTime,
          false,
          ip,
          rid,
          false,
          (oai.message || "openai_error").slice(0, 2000),
          extra,
        );
        return writeOpenaiHandlerOpenAIError(opts.req, res.status, oai);
      }
    }
    if (channel.type === CHANNEL_TYPE_MINIMAX && mode === "audio_speech") {
      try {
        const tts = miniMaxTTSDoResponse(parsed);
        extra.cachedTokens = 0;
        extra.promptCacheHitTokens = 0;
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, true, "", extra);
        if (tts.kind === "redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: tts.url, "x-oneapi-request-id": rid },
          });
        }
        return new Response(tts.body as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": tts.contentType, "x-oneapi-request-id": rid },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, message.slice(0, 2000), extra);
        const status = message.startsWith("minimax TTS error:") || message.startsWith("no audio data") ? 400 : 500;
        return writeRelayNewAPIError(opts.req, status, message, "bad_response");
      }
    }
    let converted: Record<string, unknown>;
    try {
      converted = await convertInbound(kind, clientFormat, parsed, mapped, {
        requestId: rid,
        created: Math.floor(started / 1000),
        fallbackPromptTokens: promptEst,
        channelType: channel.type,
        relayMode: mode,
        rawText: text,
        cozeUsage,
        channelKey: pickChannelKey(channel.key),
        converter: advancedConverter,
        responseFormat: String(asObj(opts.body).response_format || ""),
        channelBase: resolveBaseUrl(channel.type, channel.base_url),
        requestPath: path,
        upstreamStatus: res.status,
        viaResponses,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, message.slice(0, 2000), extra);
      if (message.startsWith("unsupported advanced custom converter:")) {
        return writeRelayNewAPIError(opts.req, 400, message, ERROR_CODE_INVALID_REQUEST);
      }
      const imageType = err instanceof Error ? (err as Error & { type?: string; code?: string }).type : undefined;
      // Original leftover Relay defer `c.JSON` gin.H after image `WithOpenAIError`
      // (`ToOpenAIError` ErrorTypeOpenAIError uses RelayError.Message, so a client
      // request id is not appended). Extra-OK: generated RequestId is not appended
      // (hop 314). HTTP status is upstream `resp.StatusCode`.
      if (imageType === "minimax_image_error") {
        const code = String((err as Error & { code?: string }).code || "");
        return openaiError(res.status, message, code, "minimax_image_error");
      }
      if (imageType === "zhipu_image_error") {
        const code = String((err as Error & { code?: string }).code || "");
        return openaiError(res.status, message, code, "zhipu_image_error");
      }
      if (imageType === "jimeng_error") {
        const code = String((err as Error & { code?: string }).code || "");
        return openaiError(res.status, message, code, "jimeng_error");
      }
      if ((err as Error & { withOpenAIError?: boolean }).withOpenAIError) {
        const type = String((err as Error & { type?: string }).type || "upstream_error");
        const code = (err as Error & { code?: string | number }).code ?? "unknown_error";
        const param = String((err as Error & { param?: string }).param || "");
        return leftoverWithOpenAIError(res.status, message, code, type, param);
      }
      const aliHandler = err instanceof Error ? (err as Error & { aliHandler?: string }).aliHandler : undefined;
      if (aliHandler === "rerank") {
        const code = String((err as Error & { code?: string }).code || "");
        const param = String((err as Error & { param?: string }).param || "");
        const status = Number((err as Error & { status?: number }).status || res.status);
        return json(status, { error: { message, type: String((err as Error & { type?: string }).type || code), param, code } });
      }
      if (aliHandler === "image") {
        const code = String((err as Error & { code?: string }).code || "bad_response");
        const type = String((err as Error & { type?: string }).type || "new_api_error");
        const status = Number((err as Error & { status?: number }).status || 500);
        if (type === "ali_error") {
          return openaiError(status, message, code, "ali_error");
        }
        return writeRelayNewAPIError(opts.req, status, message, code, type);
      }
      return writeRelayNewAPIError(opts.req, 500, message, "bad_response_body");
    }
    let usage = usageFromOpenAI(converted);
    if (mapped.startsWith("imagen") && Array.isArray(converted.data)) {
      usage = imagenUsage((converted.data as unknown[]).length);
    }
    if (channel.type === CHANNEL_TYPE_CLOUDFLARE && isCloudflareSTTRelayMode(mode)) {
      const sttUsage = cloudflareSTTUsage(String(converted.text || ""), mapped, promptEst);
      usage = {
        ...emptyOpenAIUsageCounts(),
        prompt: sttUsage.prompt_tokens,
        completion: sttUsage.completion_tokens,
        total: sttUsage.total_tokens,
      };
    }
    if (mode === "images") imageHelperFloorUsageTokens(usage);
    attachSettleUsage(extra, usage);
    if (mode === "images") extra.actualImageCount = openaiImageDataCount(converted);
    await settle(
      store,
      auth,
      channel,
      model,
      usage.prompt || promptEst,
      usage.completion,
      useTime,
      false,
      ip,
      rid,
      true,
      "",
      extra,
    );
    return new Response(JSON.stringify(converted), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "x-oneapi-request-id": rid },
    });
  }

  return writeRelayNewAPIError(opts.req, lastStatus, lastErr.slice(0, 800), lastCode, lastType);
  } finally {
    if (!pendingStreamSettle) await refundBilling(store, auth, billing);
  }
}

function noteRelaySseStatus(extra: SettleLogExtra, text: string): void {
  extra.streamStatus = extra.streamStatus || new StreamStatus();
  applySseScannerEndReason(extra.streamStatus, text);
}

async function parseStreamAndSettle(
  store: Store,
  auth: AuthToken,
  channel: ChannelRow,
  model: string,
  promptEst: number,
  useTime: number,
  ip: string,
  rid: string,
  body: ReadableStream<Uint8Array>,
  extra: SettleLogExtra = {},
): Promise<void> {
  const status = extra.streamStatus || (extra.streamStatus = new StreamStatus());
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let prompt = promptEst;
  let completion = 0;
  let lastUsage: ReturnType<typeof usageFromOpenAI> | null = null;
  const processLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      status.setEndReason(STREAM_END_REASON_DONE);
      return;
    }
    try {
      const obj = JSON.parse(data) as Record<string, unknown>;
      if (extra.toolUsage) applyToolUsageFromJson(extra.toolUsage, obj, { stream: true });
      const u = usageFromOpenAI(obj);
      if (u.prompt || u.completion || u.cachedTokens || u.imageTokens) lastUsage = u;
      if (u.prompt) prompt = u.prompt;
      if (u.completion) completion = u.completion;
      const delta = (obj.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content;
      if (typeof delta === "string") completion += Math.ceil(delta.length / 4);
    } catch (err) {
      status.recordError(err instanceof Error ? err.message : String(err));
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    buf += dec.decode();
    if (buf) processLine(buf);
  } catch (err) {
    status.setEndReason(
      STREAM_END_REASON_SCANNER_ERR,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
  status.setEndReason(STREAM_END_REASON_EOF);
  if (extra.toolUsage) finishOpenAIChatStreamToolUsage(extra.toolUsage);
  if (lastUsage) attachSettleUsage(extra, lastUsage);
  await settle(store, auth, channel, model, prompt, completion, useTime, true, ip, rid, true, "stream", extra);
}

export async function listModelsForAuth(store: Store, auth: AuthToken, format: ClientFormat): Promise<Response> {
  const groups =
    auth.usingGroup === "auto"
      ? await requestAutoGroups(store, auth.token, auth.user.group || "default")
      : [auth.usingGroup];
  const ownerGroups = groups.length ? groups : [auth.usingGroup];
  const names = await store.enabledModelsForGroups(ownerGroups);
  const selfUse = await store.optionBool("SelfUseModeEnabled", false);
  const settings = parseJson<Record<string, unknown>>(auth.user.settings || "", {});
  const acceptUnset = selfUse || Boolean(settings.accept_unset_model_ratio_model);
  const modelPrice = parseJson<Record<string, unknown>>(await store.option("ModelPrice"), {});
  const modelRatio = parseJson<Record<string, unknown>>(await store.option("ModelRatio"), {});
  const billingMode = parseJson<Record<string, string>>(await store.option("billing_setting.billing_mode"), {});
  const billingExpr = parseJson<Record<string, string>>(await store.option("billing_setting.billing_expr"), {});
  const modelLimitEnable = Boolean(auth.token.model_limits_enabled);
  const tokenModelLimit = modelLimitEnable ? tokenModelLimitsMap(String(auth.token.model_limits || "")) : {};
  const userModelNames: string[] = [];
  for (const modelName of names) {
    if (modelLimitEnable && !listModelsTokenLimitAllows(tokenModelLimit, modelName)) continue;
    if (!acceptUnset && !hasModelBillingConfig(modelName, modelPrice, modelRatio, billingMode, billingExpr)) continue;
    userModelNames.push(modelName);
  }
  const preferredTypes = await store.preferredModelOwnerChannelTypes(userModelNames, ownerGroups);
  const openaiModels = userModelNames.map((id) => {
    const staticHit = OPENAI_MODELS_MAP[id];
    const channelType = preferredTypes[id];
    const ownedBy = channelType != null ? ownerForChannelType(channelType) : staticHit?.owned_by || "custom";
    return openAIModel(id, ownedBy, getModelSupportEndpointTypes(id));
  });
  if (format === "gemini") {
    return new Response(
      JSON.stringify({
        models: userModelNames.map((id) => geminiModel(id)),
        nextPageToken: null,
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  if (format === "anthropic") {
    const data = userModelNames.map((id) => anthropicModel(id));
    return new Response(
      JSON.stringify({
        data,
        first_id: data[0]?.id || "",
        has_more: false,
        last_id: data[data.length - 1]?.id || "",
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return new Response(JSON.stringify(openaiModelList(openaiModels)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Original `controller.RetrieveModel`: static `openAIModelsMap` only (custom enabled models are not found). */
export function retrieveModel(model: string, format: ClientFormat = "openai"): Response {
  const staticHit = OPENAI_MODELS_MAP[model];
  if (!staticHit) {
    return new Response(JSON.stringify(modelNotFoundError(model)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (format === "anthropic") {
    return new Response(JSON.stringify(anthropicModel(staticHit.id)), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(catalogOpenAIModel(staticHit)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export { testChannel } from "./channel-test.js";

function parseUpstreamModelIDs(text: string, channelType: number): string[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  let ids: string[] = [];
  if (Array.isArray(parsed.data)) {
    ids = (parsed.data as { id?: string }[]).map((x) => String(x.id || ""));
  } else if (Array.isArray(parsed.models)) {
    ids = (parsed.models as { name?: string }[]).map((x) => String(x.name || ""));
  }
  if (channelType === CHANNEL_TYPE_GEMINI) ids = ids.map((id) => id.replace(/^models\//, ""));
  return normalizeModelNames(ids);
}

export async function fetchUpstreamModels(channel: ChannelRow, store?: Store): Promise<string[]> {
  if (channel.type === CHANNEL_TYPE_TASK_PLUGIN) {
    const setting = parseJson<Record<string, unknown>>(String(channel.setting || ""), {});
    const pluginKey = String(setting.task_plugin_key || setting.TaskPluginKey || "").trim();
    const registered = store ? (await listRoutingPlugins(store)).find((plugin) => plugin.key === pluginKey) : null;
    const meta = registered?.meta || factoryPluginMeta(pluginKey);
    if (!meta) throw new Error(`task plugin ${JSON.stringify(pluginKey)} is not registered`);
    const models = Array.isArray(meta.models) ? (meta.models as unknown[]).map((m) => String(m)) : [];
    return normalizeModelNames(models);
  }
  if (channel.type === CHANNEL_TYPE_CODEX) {
    return fetchCodexChannelModels(channel, store);
  }
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const target = buildAdvancedCustomModelListRequest(channel);
    applyFetchModelsHeaderOverrides(channel, pickChannelKey(channel.key), target.headers);
    const res = await fetchUpstream(target);
    const text = await res.text();
    if (!res.ok) throw new Error(text.slice(0, 400) || res.statusText);
    return parseUpstreamModelIDs(text, channel.type);
  }
  const target = modelsUrl(channel);
  const res = await fetchUpstream(target);
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 400) || res.statusText);
  return parseUpstreamModelIDs(text, channel.type);
}

export async function playgroundRelay(
  req: Request,
  env: Env,
  store: Store,
  user: UserRow,
  body: unknown,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const tokens = await store.listTokens(user.id, 0, 1);
  let token = tokens.items[0];
  if (!token) {
    const { generateTokenKey } = await import("./crypto.js");
    const key = generateTokenKey();
    const id = await store.insertToken({
      user_id: user.id,
      key,
      name: "playground",
      unlimited_quota: 1,
      remain_quota: 0,
    });
    token = (await store.getTokenById(id, user.id))!;
  }
  const o = asObj(body);
  return relay({
    req,
    env,
    store,
    auth: { token, user, usingGroup: token.group || user.group || "default" },
    mode: "chat",
    clientFormat: "openai",
    model: String(o.model || ""),
    body,
    stream: Boolean(o.stream),
    path: "/v1/chat/completions",
    requestPath: "/pg/chat/completions",
    ctx,
    playground: true,
  });
}

export { proxyMj } from "./midjourney.js";

void parseBool;

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

export async function proxyRealtime(
  req: Request,
  channel: ChannelRow,
  model: string,
  billing?: { store: Store; auth: AuthToken; env: Env; ctx?: ExecutionContextLike },
): Promise<Response> {
  if (typeof WebSocketPair === "undefined") {
    return openaiError(501, "当前运行时不支持 WebSocket", "not_implemented");
  }
  const originModel = model || "gpt-4o-realtime-preview";
  const upstreamModel = mapModel(channel.model_mapping, originModel);
  const target = openaiRealtimeUpstream(channel, req, originModel);
  let ws: WebSocket;
  try {
    ws = (await dialOpenAIRealtimeWebSocket(target.url, target.headers)) as unknown as WebSocket;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number((err as { status?: number }).status || 500);
    const code = String((err as { code?: string }).code || "do_request_failed");
    return openaiError(status, message, code);
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  (server as unknown as { accept(): void }).accept();
  const state = emptyOpenaiRealtimeHandlerState();
  const startMs = Date.now();
  let firstResponseMs = 0;
  let finalPreConsumedQuota = 0;
  let finished = false;
  let closing = false;
  const requestId = req.headers.get("x-oneapi-request-id") || crypto.randomUUID();
  let gate = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    const next = gate.then(fn, fn);
    gate = next.catch(() => {});
    billing?.ctx?.waitUntil(next);
  };
  const preConsume = async (usage: RealtimeUsage): Promise<void> => {
    if (!billing) return;
    const price = await loadWssPriceData(
      billing.store,
      originModel,
      upstreamModel,
      billing.auth.usingGroup,
      billing.auth.user.group || "default",
    );
    accumulateRealtimeUsage(state.sumUsage, usage);
    finalPreConsumedQuota += await preWssConsumeQuota({ store: billing.store, auth: billing.auth, price, usage });
  };
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    if (billing) {
      for (const leftover of remainingRealtimePreConsume(state)) {
        try {
          await preConsume(leftover);
        } catch {
          /* original close-path ignores leftover PreWss errors */
        }
      }
      const price = await loadWssPriceData(
        billing.store,
        originModel,
        upstreamModel,
        billing.auth.usingGroup,
        billing.auth.user.group || "default",
      );
      await postWssConsumeQuota({
        store: billing.store,
        auth: billing.auth,
        channel,
        req,
        price,
        usage: state.sumUsage,
        finalPreConsumedQuota,
        startMs,
        firstResponseMs,
        requestId,
      });
    }
  };
  server.addEventListener("message", (ev: MessageEvent) => {
    const raw = websocketMessageText(ev.data);
    enqueue(async () => {
      const event = parseRealtimeEvent(raw);
      if (event) {
        try {
          applyClientRealtimeEvent(state, event, upstreamModel);
        } catch {
          /* original errChan; extra-OK: keep proxying after 101 */
        }
      }
      try {
        ws.send(raw);
      } catch {
        /* ignore */
      }
    });
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    const raw = websocketMessageText(ev.data);
    enqueue(async () => {
      if (!firstResponseMs) firstResponseMs = Date.now();
      const event = parseRealtimeEvent(raw);
      if (event) {
        try {
          const applied = applyUpstreamRealtimeEvent(state, event, upstreamModel);
          if (applied.preConsume) {
            try {
              await preConsume(applied.preConsume);
            } catch {
              /* original errChan logs; extra-OK: keep proxying after 101 */
            }
          }
        } catch {
          /* original error unmarshalling / counting */
        }
      }
      try {
        server.send(raw);
      } catch {
        /* ignore */
      }
    });
  });
  const close = () => {
    if (closing) return;
    closing = true;
    enqueue(finish);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  server.addEventListener("close", close);
  ws.addEventListener("close", close);
  const protocol = req.headers.get("sec-websocket-protocol") || "";
  const init = {
    status: 101,
    webSocket: client,
    headers: protocol ? { "sec-websocket-protocol": protocol.split(",")[0].trim() } : undefined,
  } as ResponseInit;
  try {
    return new Response(null, init);
  } catch {
    return { status: 101, ok: false, headers: new Headers(init.headers), webSocket: client, text: async () => "" } as unknown as Response;
  }
}

