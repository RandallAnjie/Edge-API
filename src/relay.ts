import { csv, CHANNEL_TYPE_ADVANCED_CUSTOM, CHANNEL_TYPE_AWS, CHANNEL_TYPE_CODEX, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_OLLAMA, CHANNEL_TYPE_TASK_PLUGIN, CHANNEL_TYPE_VERTEX, CLAUDE_VERSION, LOG_CONSUME, LOG_ERROR, parseBool, parseJson } from "./constants.js";
import { recordRelayPerf } from "./perf-metrics.js";
import {
  anthropicToOpenAI,
  convertClaudeRequest,
  convertGeminiRequest,
  convertOllamaEmbeddingRequest,
  convertOpenAIRequest,
  convertOpenAIResponsesRequest,
  estimatePromptTokens,
  extractGeminiModelAction,
  geminiToOpenAIChat,
  openaiChatToResponses,
  openaiFromAnthropicResponse,
  openaiFromGeminiResponse,
  openaiToAnthropic,
  openaiToGemini,
  sseFromOpenAIChatCompletion,
  sseOpenAIFromText,
  usageFromOpenAI,
  type ChatMessage,
} from "./convert.js";
import { claudeUpstreamToOpenAIChat } from "./claude-response.js";
import { geminiUpstreamToOpenAIChat } from "./gemini-response.js";
import { compactUuid } from "./openai-usage.js";
import { isNovaModel, openaiFromNovaResponse } from "./aws-convert.js";
import { openaiFromOllamaChatResponse, openaiFromOllamaEmbedding, ollamaUpstreamToOpenAIChat } from "./ollama-convert.js";
import { imagenUsage, openaiFromImagenResponse, removeFunctionCallIDs, vertexRequestMode, wrapVertexClaude } from "./vertex-convert.js";
import { clientIp, groupAccessDeniedMessage, noAvailableChannelMessage, openaiError, relayErrorHandler, tokenModelForbiddenMessage } from "./http.js";
import { applyChannelParamOverride, asParamOverrideReturnError, ParamOverrideReturnError, requestHeadersFrom, type ParamOverrideRelayInfo } from "./param-override.js";
import {
  DEFAULT_CLAUDE_MAX_TOKENS,
  DEFAULT_EFFORT_TAIL_MODEL_IDS,
  DEFAULT_THINKING_MODEL_BLACKLIST,
  ReasoningClientError,
  applyReasoningModelSuffix,
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
import type { OriginTaskRef } from "./origin-task.js";
import { computeQuota, remainingOk, quotaRatios } from "./quota.js";
import { pickChannelKey } from "./select.js";
import { parseChannelInfo } from "./channel-info.js";
import { buildAdvancedCustomModelListRequest, buildAdvancedCustomRelayTarget } from "./channel-validate.js";
import { buildCodexRelayTarget, fetchCodexChannelModels } from "./codex-models.js";
import { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env, ExecutionContextLike, UserRow } from "./types.js";
import { applyFetchModelsHeaderOverrides, applyModelMapping, buildUpstream, joinUrl, modelsUrl, normalizeModelNames, type RelayMode, type UpstreamTarget } from "./upstream.js";
import { channelKind, resolveBaseUrl } from "./catalog.js";
import {
  anthropicModel,
  consumeLogOther,
  extractPluginMeta,
  geminiModel,
  groupInUserUsableGroups,
  modelNotFoundError,
  openAIModel,
  openaiModelList,
  ownerForChannelType,
  requestAutoGroups,
} from "./dto.js";
import { tokenAllowsModel } from "./auth.js";
import { ADAPTOR_MODELS } from "./channel-models.js";

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
  return fetch(target.url, init);
}

async function reasoningSettingsFromStore(store: Store): Promise<ReasoningHostSettings> {
  return {
    thinkingModelBlacklist: parseJson(await store.option("global.thinking_model_blacklist"), DEFAULT_THINKING_MODEL_BLACKLIST),
    effortTailModelIDs: parseJson(await store.option("global.effort_tail_model_ids"), DEFAULT_EFFORT_TAIL_MODEL_IDS),
    claudeThinkingAdapterEnabled: (await store.option("claude.thinking_adapter_enabled")) !== "false",
    geminiThinkingAdapterEnabled: (await store.option("gemini.thinking_adapter_enabled")) === "true",
    claudeThinkingAdapterBudgetTokensPercentage: Number(await store.option("claude.thinking_adapter_budget_tokens_percentage")) || 0.8,
    geminiThinkingAdapterBudgetTokensPercentage: Number(await store.option("gemini.thinking_adapter_budget_tokens_percentage")) || 0.6,
    claudeDefaultMaxTokens: parseJson(await store.option("claude.default_max_tokens"), DEFAULT_CLAUDE_MAX_TOKENS),
    geminiSafetySettings: parseJson(await store.option("gemini.safety_settings"), { default: "OFF" }),
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

function convertOutbound(
  kind: ReturnType<typeof channelKind>,
  client: ClientFormat,
  body: unknown,
  channelType = 0,
  mappedModel = "",
  originModel = "",
  settings: ReasoningHostSettings = {},
  mode: RelayMode = "chat",
): unknown {
  let o = asObj(body);
  const origin = originModel || String(o.model || "");
  const upstream = mappedModel || String(o.model || "");
  if (channelType === CHANNEL_TYPE_AWS && client === "anthropic" && !isNovaModel(upstream)) {
    return convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_VERTEX && client === "anthropic" && vertexRequestMode(upstream) === "claude") {
    return wrapVertexClaude(convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings }));
  }
  if (client === "anthropic" && kind === "anthropic") {
    return convertClaudeRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (channelType === CHANNEL_TYPE_VERTEX && client === "gemini") {
    const geminiReq = convertGeminiRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
    if (settings.removeFunctionResponseIdEnabled !== false) removeFunctionCallIDs(geminiReq);
    return geminiReq;
  }
  if (client === "gemini" && kind === "gemini") {
    return convertGeminiRequest(o, { originModelName: origin, upstreamModelName: upstream, settings });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_OLLAMA && mode === "embeddings") {
    return convertOllamaEmbeddingRequest(o, { upstreamModelName: upstream });
  }
  if (client === "openai" && channelType === CHANNEL_TYPE_OLLAMA && mode === "completions") {
    return convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
  }
  if (client === "openai" && mode === "responses") {
    o = convertOpenAIResponsesRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings });
    if (kind === "anthropic") {
      return openaiToAnthropic(
        {
          ...o,
          messages: o.input ?? o.messages,
          max_tokens: o.max_output_tokens ?? o.max_tokens,
        },
        settings,
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
      );
    }
    return o;
  }
  if (client === "openai" && (mode === "chat" || Array.isArray(o.messages))) {
    o = convertOpenAIRequest(o, { channelType, originModelName: origin, upstreamModelName: upstream, settings, relayMode: mode });
    if (kind === "anthropic" || kind === "gemini") return o;
    body = o;
  }
  if (kind === "anthropic" && client === "openai") return openaiToAnthropic(o, settings);
  if (kind === "gemini" && client === "openai") return openaiToGemini(o, settings);
  if (kind === "openai" && client === "anthropic") return anthropicToOpenAI(o);
  if (kind === "openai" && client === "gemini") {
    const model = String(o.model || "");
    return geminiToOpenAIChat(o, model);
  }
  if (kind === "gemini" && client === "anthropic") return openaiToGemini(anthropicToOpenAI(o), settings);
  if (kind === "anthropic" && client === "gemini") return openaiToAnthropic(geminiToOpenAIChat(o, String(o.model || "")), settings);
  return body;
}

function convertAdvancedCustomOpenAIChat(converter: string, body: unknown): unknown {
  const o = asObj(body);
  switch (converter) {
    case "none":
      return body;
    case "openai_chat_completions_to_anthropic_messages":
      return openaiToAnthropic(o);
    case "openai_chat_completions_to_gemini_generate_content":
      return openaiToGemini(o);
    case "openai_chat_completions_to_openai_responses":
      return openaiChatToResponses(o);
    default:
      throw new Error(`converter ${JSON.stringify(converter)} does not support OpenAI chat completions requests`);
  }
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
    target.body = convertAdvancedCustomOpenAIChat(target.converter, body);
    applyFetchModelsHeaderOverrides(channel, pickChannelKey(channel.key), target.headers);
    if (
      target.converter === "openai_chat_completions_to_anthropic_messages" ||
      (target.converter === "none" && incoming === "/v1/messages")
    ) {
      target.headers["anthropic-version"] = extraHeaders["anthropic-version"] || CLAUDE_VERSION;
    }
    target.body = applyChannelParamOverride(channel, target.body, target.headers, { ...info, upstreamModel: mapped }, pickChannelKey(channel.key), mapped);
    return target;
  }
  return buildUpstream(channel, mode, path, model, body, extraHeaders, method, info);
}

function convertInbound(
  kind: ReturnType<typeof channelKind>,
  client: ClientFormat,
  upstreamJson: Record<string, unknown>,
  model: string,
  opts: { requestId?: string; created?: number; fallbackPromptTokens?: number; channelType?: number; relayMode?: RelayMode; rawText?: string } = {},
): Record<string, unknown> {
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_OLLAMA) {
    if (opts.relayMode === "embeddings") return openaiFromOllamaEmbedding(upstreamJson, model);
    if (opts.relayMode === "responses") return upstreamJson;
    return openaiFromOllamaChatResponse(opts.rawText ?? upstreamJson, model, {
      id: opts.requestId ? compactUuid() : undefined,
      created: opts.created,
    });
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_AWS) {
    if (isNovaModel(model)) {
      return openaiFromNovaResponse(upstreamJson, model, {
        id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
        created: opts.created,
      });
    }
    return openaiFromAnthropicResponse(upstreamJson, model);
  }
  if (client === "openai" && opts.channelType === CHANNEL_TYPE_VERTEX) {
    const mode = vertexRequestMode(model);
    if (mode === "claude") return openaiFromAnthropicResponse(upstreamJson, model);
    if (model.startsWith("imagen")) return openaiFromImagenResponse(upstreamJson, { created: opts.created });
    if (mode === "opensource") return upstreamJson;
    return openaiFromGeminiResponse(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
      upstreamModel: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  if (client === "openai" && kind === "anthropic") return openaiFromAnthropicResponse(upstreamJson, model);
  if (client === "openai" && kind === "gemini") {
    return openaiFromGeminiResponse(upstreamJson, model, {
      id: opts.requestId ? `chatcmpl-${opts.requestId}` : undefined,
      created: opts.created,
      upstreamModel: model,
      fallbackPromptTokens: opts.fallbackPromptTokens,
    });
  }
  return upstreamJson;
}

function openaiClientFromProvider(
  kind: ReturnType<typeof channelKind>,
  text: string,
  mapped: string,
  stream: boolean,
  opts: { requestId: string; includeUsage?: boolean; fallbackPromptTokens?: number; channelType?: number; relayMode?: RelayMode },
): { body: string; usageBody: Record<string, unknown> } {
  if (opts.channelType === CHANNEL_TYPE_OLLAMA && opts.relayMode !== "responses" && opts.relayMode !== "embeddings") {
    const out = ollamaUpstreamToOpenAIChat(text, mapped);
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
  if (mapped.startsWith("imagen") && opts.channelType === CHANNEL_TYPE_VERTEX) {
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
  const converted = convertInbound(kind, "openai", parsed, mapped, {
    requestId: opts.requestId,
    fallbackPromptTokens: opts.fallbackPromptTokens,
    channelType: opts.channelType,
  });
  return { body: stream ? sseFromOpenAIChatCompletion(converted) : JSON.stringify(converted), usageBody: converted };
}

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
  extra: {
    upstreamRequestId?: string;
    requestPath?: string;
    channelAffinity?: Record<string, unknown>;
    env?: Env;
    affinity?: ChannelAffinityResolution;
    clientFormat?: string;
    cachedTokens?: number;
    promptCacheHitTokens?: number;
  } = {},
): Promise<void> {
  const quota = await computeQuota(store, model, auth.usingGroup, prompt, completion);
  if (ok && quota > 0) {
    await store.consumeQuota(auth.user.id, auth.token.id, channel.id, quota);
    await store.bumpQuotaData(auth.user, model, quota, prompt + completion, {
      useGroup: auth.usingGroup,
      tokenId: auth.token.id,
      channelId: channel.id,
    });
  }
  const ratios = await quotaRatios(store, model, auth.usingGroup);
  await store.insertLog({
    user_id: auth.user.id,
    type: ok ? LOG_CONSUME : LOG_ERROR,
    content,
    username: auth.user.username,
    token_name: auth.token.name,
    model_name: model,
    quota,
    prompt_tokens: prompt,
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
      model,
      group: auth.usingGroup,
      groupRatio: ratios.groupRatio,
      modelRatio: ratios.modelRatio,
      completionRatio: ratios.completionRatio,
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      ok,
      requestPath: extra.requestPath,
      isMultiKey: parseChannelInfo(String(channel.channel_info || "")).is_multi_key,
      channelAffinity: extra.channelAffinity,
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
  if (!model) return openaiError(400, "未提供模型名称", "model_not_found");
  if (!tokenAllowsModel(auth.token, model)) {
    return openaiError(403, tokenModelForbiddenMessage(opts.req, model), "model_not_allowed");
  }

  if (opts.playground) {
    const pgGroup = String(asObj(opts.body).group || "");
    if (pgGroup) {
      const allowed = await groupInUserUsableGroups(store, auth.user.group || "default", pgGroup);
      if (!allowed && pgGroup !== auth.usingGroup) {
        return openaiError(403, groupAccessDeniedMessage(opts.req), "access_denied");
      }
      auth.usingGroup = pgGroup;
    }
    auth.token = { ...auth.token, name: `playground-${auth.usingGroup}`, group: auth.usingGroup };
  }

  const requestPath = opts.requestPath || path;
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
    return openaiError(selected.error.status, selected.error.message, selected.error.code);
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
    return openaiError(503, noAvailableChannelMessage(opts.req, showGroup, model), "no_available_channel");
  }

  const autoDisable = await store.optionBool("AutomaticDisableChannelEnabled", false);
  const retryRanges = retryStatusCodeRangesFromOption(await store.option("AutomaticRetryStatusCodes"));
  const ip = clientIp(opts.req);
  const rid = opts.req.headers.get("x-oneapi-request-id") || crypto.randomUUID();

  const promptEst = estimatePromptTokens(
    asObj(opts.body).messages as ChatMessage[] | undefined,
    typeof asObj(opts.body).prompt === "string" ? String(asObj(opts.body).prompt) : undefined,
  );
  const precheck = remainingOk(
    auth.user.quota,
    auth.token.remain_quota,
    Boolean(auth.token.unlimited_quota),
    Math.max(1, promptEst),
  );
  if (precheck) return openaiError(403, precheck, "insufficient_quota");

  let lastErr = "所有渠道均失败";
  let lastStatus = 502;

  const retryTimes = selectParam.retryTimes;
  const convertSettings = await reasoningSettingsFromStore(store);

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
    }
    if (!channel) break;
    const skipFurtherRetry = suppressesRetry || (usedAffinityChannel && Boolean(affinity?.skipRetryOnFailure));
    const lastAttempt = retry === retryTimes || skipFurtherRetry;
    const affinityLog = usedAffinityChannel && affinity ? channelAffinityLogInfo(affinity, auth.usingGroup, channel.id) : undefined;
    const kind = channelKind(channel.type);
    let mapped = model;
    let outbound: unknown = opts.body;
    try {
      mapped = applyModelMapping(channel, model);
      outbound = opts.rawBody ? opts.body : convertOutbound(kind, clientFormat, opts.body, channel.type, mapped, model, convertSettings, mode);
      if (!opts.rawBody) {
        const convertedModel = asObj(outbound).model;
        if (typeof convertedModel === "string" && convertedModel) mapped = convertedModel;
        else {
          mapped = applyReasoningModelSuffix(
            asObj(opts.body),
            model,
            mapped,
            convertSettings,
            mode === "responses" ? "responses" : "chat",
          ).upstreamModelName;
        }
      }
    } catch (err) {
      const ret = convertRequestFailed(err);
      if (ret.skipRetry || lastAttempt) return openaiError(ret.statusCode, ret.message, ret.code, ret.type);
      lastErr = ret.message;
      lastStatus = ret.statusCode;
      continue;
    }
    const relayInfo: ParamOverrideRelayInfo = {
      requestHeaders: requestHeadersFrom(opts.req),
      userId: auth.user.id,
      userGroup: auth.user.group,
      tokenGroup: auth.token.group,
      usingGroup: auth.usingGroup,
      originalModel: model,
      upstreamModel: mapped,
      requestPath,
      retryIndex: retry,
      affinityTemplate: affinity?.template,
    };
    let target: UpstreamTarget;
    try {
      target = buildChannelRelayTarget(
        channel,
        mode,
        path,
        model,
        opts.rawBody ? null : outbound,
        {
          "anthropic-version": opts.req.headers.get("anthropic-version") || "",
        },
        opts.method || opts.req.method || "POST",
        opts.stream,
        relayInfo,
      );
    } catch (err) {
      const ret = asParamOverrideReturnError(err);
      if (ret) {
        if (ret.skipRetry || lastAttempt) return openaiError(ret.statusCode, ret.message, ret.code, ret.type);
        lastErr = ret.message;
        lastStatus = ret.statusCode;
        continue;
      }
      lastErr = err instanceof Error ? err.message : String(err);
      lastStatus = 400;
      continue;
    }
    if (opts.rawBody) {
      target.body = opts.rawBody;
      if (opts.rawContentType) target.headers["content-type"] = opts.rawContentType;
      else delete target.headers["content-type"];
      if (typeof opts.rawBody === "string" && (opts.rawContentType || "").includes("json")) {
        try {
          target.body = applyChannelParamOverride(channel, opts.rawBody, target.headers, relayInfo, pickChannelKey(channel.key), mapped);
        } catch (err) {
          const ret = asParamOverrideReturnError(err);
          if (ret) {
            if (ret.skipRetry || lastAttempt) return openaiError(ret.statusCode, ret.message, ret.code, ret.type);
            lastErr = ret.message;
            lastStatus = ret.statusCode;
            continue;
          }
          lastErr = err instanceof Error ? err.message : String(err);
          lastStatus = 400;
          continue;
        }
      }
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchUpstream(target);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      lastStatus = 502;
      if (autoDisable) await store.autoDisableChannel(channel.id);
      if (skipFurtherRetry) break;
      continue;
    }
    const useTime = Math.max(0, Math.round((Date.now() - started) / 1000));
    const extra = {
      upstreamRequestId: res.headers.get("x-oneapi-request-id") || res.headers.get("x-request-id") || "",
      requestPath,
      channelAffinity: affinityLog,
      env: opts.env,
      affinity: affinity || undefined,
      clientFormat,
      cachedTokens: 0,
      promptCacheHitTokens: 0,
    };

    if (!res.ok && retryable(res.status, retryRanges) && !lastAttempt) {
      lastErr = await res.text().catch(() => res.statusText);
      lastStatus = res.status;
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      lastErr = text || res.statusText;
      lastStatus = res.status;
      await settle(store, auth, channel, model, promptEst, 0, useTime, opts.stream, ip, rid, false, lastErr.slice(0, 2000), extra);
      if (res.status >= 500 && autoDisable) await store.autoDisableChannel(channel.id);
      if (!lastAttempt && retryable(res.status, retryRanges)) continue;
      const errRes = relayErrorHandler(res.status, text, String(channel.status_code_mapping || ""));
      const headers = new Headers(errRes.headers);
      headers.set("x-oneapi-request-id", rid);
      return new Response(errRes.body, { status: errRes.status, headers });
    }

    const ct = res.headers.get("content-type") || "";
    let isSSE = ct.includes("text/event-stream") || opts.stream;
    if (channel.type === CHANNEL_TYPE_OLLAMA) {
      if (mode === "embeddings") isSSE = false;
      else if (mode !== "responses") isSSE = Boolean(opts.stream);
    }
    if (affinity) {
      ctx?.waitUntil(recordChannelAffinity(store, opts.env, affinity.cacheKeySuffix, channel.id, affinity.ttlSeconds));
    }

    const ollamaResponsesPassthrough = channel.type === CHANNEL_TYPE_OLLAMA && mode === "responses";
    if (isSSE && res.body) {
      if (kind !== "openai" && clientFormat === "openai" && !ollamaResponsesPassthrough) {
        const text = await res.text();
        const includeUsage = Boolean(asObj(asObj(opts.body).stream_options).include_usage);
        let converted: { body: string; usageBody: Record<string, unknown> };
        try {
          converted = openaiClientFromProvider(kind, text, mapped, true, {
            requestId: rid,
            includeUsage,
            fallbackPromptTokens: promptEst,
            channelType: channel.type,
            relayMode: mode,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await settle(store, auth, channel, model, promptEst, 0, useTime, true, ip, rid, false, message.slice(0, 2000), extra);
          return openaiError(500, message, "bad_response_body");
        }
        const usage = usageFromOpenAI(converted.usageBody);
        extra.cachedTokens = usage.cachedTokens;
        extra.promptCacheHitTokens = usage.promptCacheHitTokens;
        ctx?.waitUntil(
          settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra),
        );
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
      ctx?.waitUntil(
        parseStreamAndSettle(store, auth, channel, model, promptEst, useTime, ip, rid, logBody, extra),
      );
      const headers = new Headers();
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("cache-control", "no-cache");
      headers.set("x-oneapi-request-id", rid);
      return new Response(clientBody, { status: 200, headers });
    }

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (channel.type === CHANNEL_TYPE_OLLAMA && clientFormat === "openai" && mode !== "responses" && mode !== "embeddings") {
        parsed = {};
      } else {
        if (channel.type === CHANNEL_TYPE_OLLAMA && mode === "embeddings") {
          await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, "bad_response_body", extra);
          return openaiError(500, "bad_response_body", "bad_response_body");
        }
        await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, true, "binary/text", extra);
        return new Response(text, {
          status: 200,
          headers: { "content-type": ct || "application/json", "x-oneapi-request-id": rid },
        });
      }
    }
    let converted: Record<string, unknown>;
    try {
      converted = convertInbound(kind, clientFormat, parsed, mapped, {
        requestId: rid,
        fallbackPromptTokens: promptEst,
        channelType: channel.type,
        relayMode: mode,
        rawText: text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, false, message.slice(0, 2000), extra);
      return openaiError(500, message, "bad_response_body");
    }
    let usage = usageFromOpenAI(converted);
    if (mapped.startsWith("imagen") && Array.isArray(converted.data)) {
      usage = imagenUsage((converted.data as unknown[]).length);
    }
    extra.cachedTokens = usage.cachedTokens;
    extra.promptCacheHitTokens = usage.promptCacheHitTokens;
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

  return openaiError(lastStatus, lastErr.slice(0, 800), "channel_error");
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
  extra: { upstreamRequestId?: string; requestPath?: string } = {},
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let prompt = promptEst;
  let completion = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as Record<string, unknown>;
          const u = usageFromOpenAI(obj);
          if (u.prompt) prompt = u.prompt;
          if (u.completion) completion = u.completion;
          const delta = (obj.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content;
          if (typeof delta === "string") completion += Math.ceil(delta.length / 4);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore parse errors */
  }
  await settle(store, auth, channel, model, prompt, completion, useTime, true, ip, rid, true, "stream", extra);
}

export async function listModelsForAuth(store: Store, auth: AuthToken, format: ClientFormat): Promise<Response> {
  const groups =
    auth.usingGroup === "auto"
      ? await requestAutoGroups(store, auth.token, auth.user.group || "default")
      : [auth.usingGroup];
  const names = (await store.enabledModelsForGroups(groups.length ? groups : [auth.usingGroup])).filter((id) =>
    tokenAllowsModel(auth.token, id),
  );
  const channels = await store.enabledChannels();
  const ownerByModel = new Map<string, string>();
  for (const ch of channels) {
    const owner = ownerForChannelType(ch.type);
    for (const m of csv(ch.models)) {
      if (!ownerByModel.has(m)) ownerByModel.set(m, owner);
    }
  }
  const openaiModels = names.map((id) => openAIModel(id, ownerByModel.get(id) || "custom"));
  if (format === "gemini") {
    return new Response(
      JSON.stringify({
        models: names.map((id) => geminiModel(id)),
        nextPageToken: null,
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  if (format === "anthropic") {
    const data = names.map((id) => anthropicModel(id));
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

export async function retrieveModel(store: Store, auth: AuthToken, model: string, format: ClientFormat = "openai"): Promise<Response> {
  const staticHit = ADAPTOR_MODELS.find((m) => m.id === model);
  const groups =
    auth.usingGroup === "auto"
      ? await requestAutoGroups(store, auth.token, auth.user.group || "default")
      : [auth.usingGroup];
  const enabled = (await store.enabledModelsForGroups(groups.length ? groups : [auth.usingGroup])).includes(model);
  if (!staticHit && !enabled) {
    return new Response(JSON.stringify(modelNotFoundError(model)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const ownedBy = staticHit?.owned_by || "custom";
  if (format === "anthropic") {
    return new Response(JSON.stringify(anthropicModel(model)), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(openAIModel(model, ownedBy)), {
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
    const plugin = store ? await store.getTaskPlugin(pluginKey) : null;
    if (!plugin) throw new Error(`task plugin ${JSON.stringify(pluginKey)} is not registered`);
    const meta = extractPluginMeta(String(plugin.source || ""));
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

export async function proxyMj(
  req: Request,
  store: Store,
  auth: AuthToken,
  path: string,
): Promise<Response> {
  const channels = (await store.enabledChannels()).filter((c) => channelKind(c.type) === "mj");
  const ch = channels[0];
  if (!ch) return openaiError(503, "没有可用的 Midjourney 渠道", "no_available_channel");
  const target = buildUpstream(ch, "passthrough", path, "midjourney", await readBodyMaybe(req));
  target.method = req.method;
  const res = await fetchUpstream(target);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.result) {
      await store.insertMj({
        action: path,
        user_id: auth.user.id,
        mj_id: parsed.result,
        prompt: asObj(target.body).prompt,
        status: "SUBMITTED",
        channel_id: ch.id,
      });
    }
  } catch {
    /* ignore */
  }
  return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json" } });
}

async function readBodyMaybe(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  try {
    return await req.clone().json();
  } catch {
    return null;
  }
}

void parseBool;

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

export async function proxyRealtime(req: Request, channel: ChannelRow, model: string): Promise<Response> {
  if (typeof WebSocketPair === "undefined") {
    return openaiError(501, "当前运行时不支持 WebSocket", "not_implemented");
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const apiKey = pickChannelKey(channel.key);
  const mapped = applyModelMapping(channel, model || "gpt-4o-realtime-preview");
  const url = joinUrl(base, `/v1/realtime?model=${encodeURIComponent(mapped)}`);
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Beta": "realtime=v1",
  };
  const protocol = req.headers.get("sec-websocket-protocol");
  if (protocol) headers["Sec-WebSocket-Protocol"] = protocol;
  const upstream = await fetch(url, { headers });
  const ws = (upstream as Response & { webSocket?: WebSocket }).webSocket;
  if (!ws) {
    const text = await upstream.text().catch(() => "");
    return openaiError(502, text.slice(0, 400) || "上游未升级为 WebSocket", "upstream_error");
  }
  (server as unknown as { accept(): void }).accept();
  (ws as unknown as { accept(): void }).accept();
  server.addEventListener("message", (ev: MessageEvent) => {
    try {
      ws.send(ev.data as string);
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    try {
      server.send(ev.data as string);
    } catch {
      /* ignore */
    }
  });
  const close = () => {
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
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: protocol ? { "sec-websocket-protocol": protocol.split(",")[0].trim() } : undefined,
  } as ResponseInit);
}

