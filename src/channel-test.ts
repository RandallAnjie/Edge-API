import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_BAIDU,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_COHERE,
  CHANNEL_TYPE_COZE,
  CHANNEL_TYPE_JINA,
  CHANNEL_TYPE_MOKA,
  CHANNEL_TYPE_REPLICATE,
  CHANNEL_TYPE_SILICONFLOW,
  CHANNEL_TYPE_TENCENT,
  CHANNEL_TYPE_AWS,
  CHANNEL_TYPE_VERTEX,
  CHANNEL_TYPE_VOLC,
  CHANNEL_TYPE_XUNFEI,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_AUTO_DISABLED,
  CHANNEL_ENABLED,
  CHANNEL_MANUAL_DISABLED,
  CLAUDE_VERSION,
  LOG_CONSUME,
  UNSUPPORTED_CHANNEL_TEST_TYPES,
  csv,
  parseJson,
} from "./constants.js";
import { channelKind, channelTypeName, resolveBaseUrl } from "./catalog.js";
import {
  convertAdvancedCustomClaudeRequest,
  convertAdvancedCustomGeminiRequest,
  convertOpenAIRequest,
  convertOpenAIResponsesRequest,
  emptyOpenAIUsageCounts,
  isOpenAIReasoningOModel,
  usageFromOpenAI,
  type OpenAIUsageCounts,
} from "./convert.js";
import { applyBaiduAccessToken, convertBaiduEmbeddingRequest } from "./baidu-convert.js";
import { applyVertexAdcAuth } from "./vertex-auth.js";
import { applyAwsAkskAuth } from "./aws-auth.js";
import { decodeAwsEventStreamResponse } from "./aws-eventstream.js";
import { applyZhipuV3Authorization } from "./zhipu-convert.js";
import { applyTencentTc3Authorization, tencentUsesNativeAdaptor } from "./tencent-convert.js";
import { parseXunfeiAuth, runXunfeiChat } from "./xunfei-convert.js";
import { parseVolcengineAuth, runVolcTtsWebSocket, volcTtsEncodingFromRequest, volcTtsIsStream, wrapVolcTtsHttpResponse } from "./volc-tts.js";
import { convertCohereRerankRequest } from "./cohere-convert.js";
import { completeCozeNonStreamChat } from "./coze-convert.js";
import { consumeLogOther, DEFAULT_ENDPOINT_INFO } from "./dto.js";
import { calculateAudioQuota } from "./openai-realtime-usage.js";
import { computeQuota, textConsumePriceData, audioConsumeLogRatios } from "./quota.js";
import { calculateTextQuotaFromStore, composeTieredTextQuota, noteQuotaClamp } from "./text-quota.js";
import { decodeToolPricesJSON, TOOL_PRICE_OPTION_KEY } from "./tool-price.js";
import { builtInToolCallCounts, createToolUsageState, ingestUpstreamToolUsage } from "./tool-usage.js";
import { openaiImageDataCount } from "./image-billing.js";
import { billingUsageFromOpenAICounts, cacheCreationTokensTotal, injectTieredBillingInfo, isFixedPriceSettlement, resolveRelayTieredQuota } from "./tiered-settle.js";
import { applyModelMapping, buildUpstream, type RelayMode, type UpstreamTarget } from "./upstream.js";
import { relayFormatForClient, requestConversionChain, shouldPostAudioConsumeQuota } from "./log-info-generate.js";
import { applyChannelParamOverride, type ParamOverrideRelayInfo } from "./param-override.js";
import { buildAdvancedCustomRelayTarget, shouldApplyAdvancedCustomClaudeHeaders } from "./channel-validate.js";
import { buildCodexRelayTarget } from "./codex-models.js";
import { pickChannelKey } from "./select.js";
import { DEFAULT_GEMINI_VERSION_SETTINGS } from "./reasoning.js";
import {
  claimAndRunSystemTask,
  decodeSystemTaskJSON,
  scheduleSystemTaskIfDue,
  SYSTEM_TASK_TYPE_CHANNEL_TEST,
} from "./system-task.js";
import {
  channelAttemptFromNewApi,
  channelAttemptFromOpenAIWrap,
  channelAttemptFromResponseTimeExceeded,
  channelAttemptFromUpstream,
  channelDisableThresholdMs,
  errorWithStatusCode,
  processChannelError,
  shouldDisableChannel,
  shouldEnableChannel,
  type ChannelAttemptError,
} from "./channel-error.js";
import type { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env, TokenRow, UserRow } from "./types.js";

/** Original `controller.channelTestSummary`. */
export type ChannelTestSummary = {
  tested: number;
  succeeded: number;
  failed: number;
  disabled: number;
  enabled: number;
};

/** Original `controller.TestChannel` JSON plus health-check `testResult` fields. */
export type ChannelTestResult = {
  success: boolean;
  message: string;
  time: number;
  error_code?: string;
  /** Original `testResult.localErr != nil`. */
  localErr?: boolean;
  /** Original `testResult.newAPIError`. */
  newAPIError?: ChannelAttemptError | null;
  requestPath?: string;
  originModel?: string;
};

export type ChannelTestOpts = {
  model?: string;
  endpointType?: string;
  stream?: boolean;
  userId?: number;
  username?: string;
  group?: string;
};

const RESPONSES_INPUT = [{ role: "user", content: "hi" }];

/** Original `common.ChannelType2APIType` (iota `constant.APIType*`). */
const CHANNEL_TYPE_TO_API_TYPE: Record<number, number> = {
  1: 0, 14: 1, 11: 2, 15: 3, 16: 4, 17: 5, 18: 6, 21: 7, 23: 8, 24: 9, 26: 10, 4: 11, 27: 12, 33: 13, 34: 14, 37: 15,
  38: 16, 39: 17, 40: 18, 41: 19, 42: 20, 43: 21, 44: 22, 45: 23, 46: 24, 20: 25, 47: 26, 48: 27, 49: 28, 51: 29,
  25: 30, 53: 31, 35: 32, 56: 33, 57: 34, 58: 35, 59: 36, 60: 37,
};

function channelType2APIType(channelType: number): { apiType: number; mapped: boolean } {
  if (channelType === 61) return { apiType: -1, mapped: false };
  if (channelType in CHANNEL_TYPE_TO_API_TYPE) return { apiType: CHANNEL_TYPE_TO_API_TYPE[channelType], mapped: true };
  return { apiType: 0, mapped: false };
}

/** Original `common.SupportsResponsesCompact`. */
export function supportsResponsesCompact(channelType: number): boolean {
  const { apiType } = channelType2APIType(channelType);
  return apiType === 0 || apiType === 34 || apiType === 35 || apiType === 36 || apiType === 37;
}

/** Original `controller.normalizeChannelTestEndpoint`. */
export function normalizeChannelTestEndpoint(channel: ChannelRow, endpointType: string): string {
  const normalized = String(endpointType || "").trim();
  if (normalized) return normalized;
  if (channel.type === CHANNEL_TYPE_CODEX) return "openai-response";
  return normalized;
}

/** Original `controller.testChannel` model resolution. */
export function resolveChannelTestModel(channel: ChannelRow, requested: string): string {
  let testModel = String(requested || "").trim();
  if (testModel) return testModel;
  if (String(channel.test_model || "").trim()) return String(channel.test_model).trim();
  const models = csv(channel.models);
  if (models.length) testModel = models[0].trim();
  return testModel || "gpt-4o-mini";
}

/** Original `controller.testChannel` request path. */
export function channelTestRequestPath(channel: ChannelRow, testModel: string, endpointType: string, isStream: boolean): string {
  let requestPath = "/v1/chat/completions";
  if (endpointType) {
    const info = DEFAULT_ENDPOINT_INFO[endpointType];
    if (info?.path) requestPath = info.path;
  } else {
    const lower = testModel.toLowerCase();
    if (lower.includes("rerank")) requestPath = "/v1/rerank";
    if (
      lower.includes("embedding") ||
      testModel.startsWith("m3e") ||
      testModel.includes("bge-") ||
      testModel.includes("embed") ||
      channel.type === CHANNEL_TYPE_MOKA
    ) {
      requestPath = "/v1/embeddings";
    }
    if (channel.type === CHANNEL_TYPE_VOLC && testModel.includes("seedream")) {
      requestPath = "/v1/images/generations";
    }
    if (lower.includes("codex")) requestPath = "/v1/responses";
  }
  if (isStream && endpointType === "gemini") {
    requestPath = requestPath.replace(":generateContent", ":streamGenerateContent");
  }
  return requestPath;
}

function relayModeForTest(endpointType: string, requestPath: string): RelayMode {
  if (endpointType) {
    switch (endpointType) {
      case "openai":
        return "chat";
      case "openai-response":
        return "responses";
      case "openai-response-compact":
        return "responses";
      case "openai-alpha-search":
        return "alpha_search";
      case "anthropic":
        return "messages";
      case "gemini":
        return "gemini";
      case "jina-rerank":
        return "rerank";
      case "image-generation":
        return "images";
      case "embeddings":
        return "embeddings";
      default:
        return "chat";
    }
  }
  if (requestPath === "/v1/embeddings") return "embeddings";
  if (requestPath === "/v1/images/generations") return "images";
  if (requestPath === "/v1/messages") return "messages";
  if (requestPath.includes("/v1beta/models")) return "gemini";
  if (requestPath === "/v1/rerank" || requestPath === "/rerank") return "rerank";
  if (requestPath === "/v1/responses") return "responses";
  if (requestPath.startsWith("/v1/responses/compact")) return "responses";
  return "chat";
}

type TestRequestKind = "chat" | "embedding" | "image" | "rerank" | "responses" | "responses-compact" | "anthropic" | "gemini";

/** Original `controller.buildTestRequest`. */
export function buildTestRequest(
  model: string,
  endpointType: string,
  isStream: boolean,
): { kind: TestRequestKind; body: Record<string, unknown> } {
  if (endpointType) {
    switch (endpointType) {
      case "embeddings":
        return { kind: "embedding", body: { model, input: ["hello world"] } };
      case "image-generation":
        return { kind: "image", body: { model, prompt: "a cute cat", n: 1, size: "1024x1024" } };
      case "jina-rerank":
        return {
          kind: "rerank",
          body: {
            model,
            query: "What is Deep Learning?",
            documents: ["Deep Learning is a subset of machine learning.", "Machine learning is a field of artificial intelligence."],
            top_n: 2,
          },
        };
      case "openai-response":
        return { kind: "responses", body: { model, input: RESPONSES_INPUT, stream: isStream } };
      case "openai-response-compact":
        return { kind: "responses-compact", body: { model, input: RESPONSES_INPUT } };
      case "anthropic":
        return {
          kind: "anthropic",
          body: {
            model,
            stream: isStream,
            max_tokens: 16,
            messages: [{ role: "user", content: "hi" }],
          },
        };
      case "gemini":
        return {
          kind: "gemini",
          body: {
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            generationConfig: { maxOutputTokens: 3000 },
          },
        };
      case "openai": {
        const req: Record<string, unknown> = {
          model,
          stream: isStream,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 16,
        };
        if (isStream) req.stream_options = { include_usage: true };
        return { kind: "chat", body: req };
      }
    }
  }

  const lower = model.toLowerCase();
  if (lower.includes("rerank")) {
    return {
      kind: "rerank",
      body: {
        model,
        query: "What is Deep Learning?",
        documents: ["Deep Learning is a subset of machine learning.", "Machine learning is a field of artificial intelligence."],
        top_n: 2,
      },
    };
  }
  if (lower.includes("embedding") || model.startsWith("m3e") || model.includes("bge-")) {
    return { kind: "embedding", body: { model, input: ["hello world"] } };
  }
  if (lower.includes("codex")) {
    return { kind: "responses", body: { model, input: RESPONSES_INPUT, stream: isStream } };
  }

  const req: Record<string, unknown> = {
    model,
    stream: isStream,
    messages: [{ role: "user", content: "hi" }],
  };
  if (isStream) req.stream_options = { include_usage: true };
  if (isOpenAIReasoningOModel(model)) {
    req.max_completion_tokens = 16;
  } else if (model.includes("thinking")) {
    if (!model.includes("claude")) req.max_tokens = 50;
  } else if (model.includes("gemini")) {
    req.max_tokens = 3000;
  } else {
    req.max_tokens = 16;
  }
  return { kind: "chat", body: req };
}

async function fetchTarget(target: UpstreamTarget): Promise<Response> {
  const init: RequestInit = { method: target.method, headers: target.headers };
  if (target.method !== "GET" && target.method !== "HEAD" && target.body != null) {
    init.body = typeof target.body === "string" ? target.body : JSON.stringify(target.body);
  }
  const res = await fetch(target.url, init);
  return decodeAwsEventStreamResponse(res);
}

function detectErrorMessageFromJSON(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const err = (parsed as { error?: unknown }).error;
  if (err == null) return "";
  if (typeof err === "string") return err.trim() || "upstream returned error payload";
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const nested = o.message ?? (o.error && typeof o.error === "object" ? (o.error as { message?: unknown }).message : undefined);
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    try {
      return JSON.stringify(err);
    } catch {
      return "upstream returned error payload";
    }
  }
  return "upstream returned error payload";
}

function detectErrorFromTestResponseBody(text: string): Error | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const message = detectErrorMessageFromJSON(JSON.parse(trimmed));
      if (message) return new Error("upstream error: " + message);
    } catch {
      /* ignore */
    }
  }
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const message = detectErrorMessageFromJSON(JSON.parse(payload));
      if (message) return new Error("upstream error: " + message);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function validateStreamTestResponseBody(text: string): Error | null {
  const trimmed = text.trim();
  if (!trimmed) return new Error("stream response body is empty");
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    return null;
  }
  return new Error("stream response body does not contain a valid stream event");
}

function findUsage(parsed: unknown): { prompt: number; completion: number } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.usage && typeof o.usage === "object") {
    const u = o.usage as Record<string, unknown>;
    if (u.prompt_tokens != null || u.input_tokens != null || u.completion_tokens != null || u.output_tokens != null) {
      return {
        prompt: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
        completion: Number(u.completion_tokens ?? u.output_tokens ?? 0),
      };
    }
  }
  const meta = o.usageMetadata as Record<string, unknown> | undefined;
  if (meta) {
    return { prompt: Number(meta.promptTokenCount || 0), completion: Number(meta.candidatesTokenCount || 0) };
  }
  return null;
}

function extractUsageFromBody(text: string, isStream: boolean, estimate: number): OpenAIUsageCounts | Error {
  if (isStream) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (findUsage(parsed)) return usageFromOpenAI(parsed);
      } catch {
        /* ignore */
      }
    }
    return { ...emptyOpenAIUsageCounts(), prompt: estimate };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (findUsage(parsed)) return usageFromOpenAI(parsed);
  } catch {
    /* ignore */
  }
  return new Error("usage is nil");
}

function fail(
  message: string,
  opts?: {
    errorCode?: string;
    newAPIError?: ChannelAttemptError | null;
    requestPath?: string;
    originModel?: string;
  },
): ChannelTestResult {
  const out: ChannelTestResult = { success: false, message, time: 0, localErr: true };
  const code = opts?.errorCode ?? opts?.newAPIError?.errorCode;
  if (code) out.error_code = code;
  if (opts?.newAPIError) out.newAPIError = opts.newAPIError;
  if (opts?.requestPath) out.requestPath = opts.requestPath;
  if (opts?.originModel) out.originModel = opts.originModel;
  return out;
}

function healthCheckAuth(user: UserRow): AuthToken {
  const token: TokenRow = {
    id: 0,
    user_id: user.id,
    key: "",
    status: 1,
    name: "",
    created_time: 0,
    accessed_time: 0,
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: 1,
    model_limits_enabled: 0,
    model_limits: "",
    allow_ips: "",
    used_quota: 0,
    group: user.group || "default",
  };
  return { token, user, usingGroup: user.group || "default" };
}

function buildTestTarget(
  channel: ChannelRow,
  mode: RelayMode,
  requestPath: string,
  originModel: string,
  mappedModel: string,
  body: unknown,
  isStream: boolean,
  kind: TestRequestKind,
  relayInfo: ParamOverrideRelayInfo,
): UpstreamTarget {
  const info: ParamOverrideRelayInfo = {
    ...relayInfo,
    originalModel: originModel,
    upstreamModel: mappedModel,
    requestPath,
    isChannelTest: true,
    isStream,
  };
  if (channel.type === CHANNEL_TYPE_CODEX) {
    if (kind === "chat") throw new Error("codex channel: /v1/chat/completions endpoint not supported");
    if (kind === "embedding") throw new Error("codex channel: /v1/embeddings endpoint not supported");
    if (kind === "rerank") throw new Error("codex channel: /v1/rerank endpoint not supported");
    if (kind === "image") throw new Error("codex channel: endpoint not supported");
    if (kind === "anthropic") throw new Error("codex channel: /v1/messages endpoint not supported");
    if (kind === "gemini") throw new Error("codex channel: endpoint not supported");
    const channelSetting = parseJson<Record<string, unknown>>(String(channel.setting || ""), {});
    const converted =
      mode === "responses"
        ? convertOpenAIResponsesRequest(body as Record<string, unknown>, {
            channelType: channel.type,
            originModelName: originModel,
            upstreamModelName: mappedModel,
            requestPath,
            relayMode: mode,
            systemPrompt: String(channelSetting.system_prompt || ""),
            systemPromptOverride: Boolean(channelSetting.system_prompt_override),
          })
        : body;
    const target = buildCodexRelayTarget(channel, mode, requestPath, mappedModel, converted, isStream);
    target.body = applyChannelParamOverride(channel, target.body, target.headers, info, pickChannelKey(channel.key), mappedModel);
    return target;
  }
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const incoming = requestPath.split("?")[0];
    const target = buildAdvancedCustomRelayTarget(channel, incoming, originModel, mappedModel, body, isStream);
    const convertOpts = {
      channelType: channel.type,
      originModelName: originModel,
      upstreamModelName: mappedModel,
      converter: target.converter,
      requestPath,
      relayMode: mode,
      isStream,
    };
    let payload: unknown = body;
    if (kind === "chat") {
      payload = convertOpenAIRequest(body as Record<string, unknown>, convertOpts);
    } else if (kind === "responses" || kind === "responses-compact") {
      payload = convertOpenAIResponsesRequest(body as Record<string, unknown>, convertOpts);
    } else if (kind === "anthropic") {
      payload = convertAdvancedCustomClaudeRequest(body as Record<string, unknown>, convertOpts);
    } else if (kind === "gemini") {
      payload = convertAdvancedCustomGeminiRequest(body as Record<string, unknown>, convertOpts);
    } else if (kind === "embedding") {
      payload = convertOpenAIRequest(body as Record<string, unknown>, { ...convertOpts, relayMode: "embeddings" });
    } else if (kind === "image") {
      payload = convertOpenAIRequest(body as Record<string, unknown>, { ...convertOpts, relayMode: "images" });
    } else if (kind === "rerank") {
      payload = convertOpenAIRequest(body as Record<string, unknown>, { ...convertOpts, relayMode: "rerank" });
    }
    target.body = payload;
    const relayFormat = kind === "anthropic" ? "claude" : kind === "gemini" ? "gemini" : "openai";
    if (shouldApplyAdvancedCustomClaudeHeaders(target.converter, relayFormat)) {
      target.headers["anthropic-version"] = CLAUDE_VERSION;
    }
    target.body = applyChannelParamOverride(channel, target.body, target.headers, info, pickChannelKey(channel.key), mappedModel);
    return target;
  }

  let payload = body;
  const kindName = channelKind(channel.type);
  if (kind === "chat") {
    payload = convertOpenAIRequest(body as Record<string, unknown>, {
      channelType: channel.type,
      originModelName: originModel,
      upstreamModelName: mappedModel,
      botId: channel.other || "",
      channelKey: pickChannelKey(channel.key),
      relayMode: mode,
    });
    if (payload && typeof payload === "object" && typeof (payload as { model?: unknown }).model === "string") {
      info.upstreamModel = String((payload as { model: string }).model);
    }
  } else if (kind === "embedding" && channel.type === CHANNEL_TYPE_BAIDU) {
    payload = convertBaiduEmbeddingRequest(body as Record<string, unknown>);
  } else if (kind === "embedding" && (channel.type === CHANNEL_TYPE_MOKA || channel.type === CHANNEL_TYPE_JINA)) {
    payload = convertOpenAIRequest(body as Record<string, unknown>, {
      channelType: channel.type,
      originModelName: originModel,
      upstreamModelName: mappedModel,
      channelKey: pickChannelKey(channel.key),
      relayMode: "embeddings",
    });
  } else if (kind === "image" && (channel.type === CHANNEL_TYPE_SILICONFLOW || channel.type === CHANNEL_TYPE_REPLICATE)) {
    payload = convertOpenAIRequest(body as Record<string, unknown>, {
      channelType: channel.type,
      originModelName: originModel,
      upstreamModelName: mappedModel,
      relayMode: "images",
    });
  } else if (kind === "rerank" && channel.type === CHANNEL_TYPE_COHERE) {
    payload = convertCohereRerankRequest(body as Record<string, unknown>, { upstreamModelName: mappedModel });
  } else if (kind === "rerank" && (channel.type === CHANNEL_TYPE_JINA || channel.type === CHANNEL_TYPE_SILICONFLOW)) {
    payload = convertOpenAIRequest(body as Record<string, unknown>, {
      channelType: channel.type,
      originModelName: originModel,
      upstreamModelName: mappedModel,
      relayMode: "rerank",
    });
  } else if (channel.type === CHANNEL_TYPE_VOLC && mode === "audio_speech") {
    payload = convertOpenAIRequest(body as Record<string, unknown>, {
      channelType: channel.type,
      originModelName: originModel,
      upstreamModelName: mappedModel,
      channelKey: pickChannelKey(channel.key),
      relayMode: "audio_speech",
    });
  }
  const extra: Record<string, string> = {};
  if (kind === "anthropic" || kindName === "anthropic") extra["anthropic-version"] = CLAUDE_VERSION;
  if (kind === "anthropic") info.relayFormat = "claude";
  else if (kind === "gemini") info.relayFormat = "gemini";
  return buildUpstream(channel, mode, requestPath, mappedModel, payload, extra, "POST", info);
}

/** Original `controller.testChannel` / `controller.TestChannel`. Failures return `time: 0`. */
export async function testChannel(
  store: Store,
  channel: ChannelRow,
  opts: ChannelTestOpts = {},
): Promise<ChannelTestResult> {
  if (UNSUPPORTED_CHANNEL_TEST_TYPES.has(channel.type)) {
    return fail(`${channelTypeName(channel.type)} channel test is not supported`);
  }

  const originModel = resolveChannelTestModel(channel, opts.model || "");
  const endpointType = normalizeChannelTestEndpoint(channel, opts.endpointType || "");
  const isStream = Boolean(opts.stream);
  const requestPath = channelTestRequestPath(channel, originModel, endpointType, isStream);
  const mode = relayModeForTest(endpointType, requestPath);
  const testMeta = { requestPath, originModel };

  if (mode === "responses" && requestPath.includes("/compact") && !supportsResponsesCompact(channel.type)) {
    const { apiType } = channelType2APIType(channel.type);
    const message = `responses compaction test is not supported for api type ${apiType}`;
    return fail(message, {
      ...testMeta,
      errorCode: "invalid_api_type",
      newAPIError: channelAttemptFromNewApi(`unsupported api type: ${apiType}`, 500, "invalid_api_type"),
    });
  }

  const mappedModel = applyModelMapping(channel, originModel);
  const built = buildTestRequest(originModel, endpointType, isStream);
  let target: UpstreamTarget;
  try {
    target = buildTestTarget(channel, mode, requestPath, originModel, mappedModel, built.body, isStream, built.kind, {
      userId: opts.userId,
      userGroup: opts.group,
      usingGroup: opts.group,
      originalModel: originModel,
      upstreamModel: mappedModel,
      requestPath,
      isChannelTest: true,
      geminiVersionSettings: parseJson(await store.option("gemini.version_settings"), DEFAULT_GEMINI_VERSION_SETTINGS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("invalid api type") || message.includes("compaction") ? "invalid_api_type" : "convert_request_failed";
    return fail(message, {
      ...testMeta,
      errorCode: code,
      newAPIError: channelAttemptFromNewApi(message, 500, code),
    });
  }

  const started = Date.now();
  let res: Response;
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
    if (channel.type === CHANNEL_TYPE_XUNFEI) {
      parseXunfeiAuth(pickChannelKey(channel.key));
      const body = target.body && typeof target.body === "object" && !Array.isArray(target.body) ? (target.body as Record<string, unknown>) : {};
      res = await runXunfeiChat(body, pickChannelKey(channel.key), { stream: isStream });
    } else if (channel.type === CHANNEL_TYPE_VOLC && mode === "audio_speech") {
      parseVolcengineAuth(pickChannelKey(channel.key));
      const body = target.body && typeof target.body === "object" && !Array.isArray(target.body) ? (target.body as Record<string, unknown>) : {};
      if (volcTtsIsStream(body)) {
        res = await runVolcTtsWebSocket(target.url, pickChannelKey(channel.key), body, volcTtsEncodingFromRequest(body));
      } else {
        res = await wrapVolcTtsHttpResponse(await fetchTarget(target), volcTtsEncodingFromRequest(body));
      }
    } else {
      res = await fetchTarget(target);
    }
    if (channel.type === CHANNEL_TYPE_COZE && !isStream) {
      const completed = await completeCozeNonStreamChat(res, resolveBaseUrl(channel.type, channel.base_url), target.headers);
      res = completed.response;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, {
      ...testMeta,
      newAPIError: channelAttemptFromOpenAIWrap(message, "do_request_failed", 500),
    });
  }

  const milliseconds = Date.now() - started;
  const text = await res.text();
  if (res.status !== 200) {
    const attempt = channelAttemptFromUpstream(res.status, text);
    return fail(attempt.message, { ...testMeta, newAPIError: attempt });
  }

  const bodyErr = detectErrorFromTestResponseBody(isStream ? text.slice(0, 8 * 1024) : text);
  if (bodyErr) {
    return fail(bodyErr.message, {
      ...testMeta,
      newAPIError: channelAttemptFromOpenAIWrap(bodyErr.message, "bad_response_body", 500),
    });
  }
  if (isStream) {
    const streamErr = validateStreamTestResponseBody(text.slice(0, 8 * 1024));
    if (streamErr) {
      return fail(streamErr.message, {
        ...testMeta,
        newAPIError: channelAttemptFromOpenAIWrap(streamErr.message, "bad_response_body", 500),
      });
    }
  }

  const estimate = 1;
  const usage = extractUsageFromBody(text, isStream, estimate);
  if (usage instanceof Error) {
    return fail(usage.message, {
      ...testMeta,
      newAPIError: channelAttemptFromOpenAIWrap(usage.message, "bad_response_body", 500),
    });
  }

  await store.updateChannelResponseTime(channel.id, milliseconds);

  let user: UserRow | null = null;
  if (opts.userId) user = await store.getUserById(opts.userId);
  if (!user) user = await store.getRootUser();
  if (user && (await store.optionBool("LogConsumeEnabled", true))) {
    const group = opts.group || user.group || "default";
    const billingUsage = billingUsageFromOpenAICounts(usage);
    const isClaude = built.kind === "anthropic" || billingUsage.usage_semantic === "anthropic";
    let actualImageCount = 0;
    try {
      actualImageCount = openaiImageDataCount(JSON.parse(text) as Record<string, unknown>);
    } catch {
      actualImageCount = 0;
    }
    const tiered = await resolveRelayTieredQuota(store, originModel, group, billingUsage, isClaude, {
      relayMode: mode,
      imageBody: built.body,
      channelType: channel.type,
      actualImageCount,
    });
    const price = await textConsumePriceData(store, originModel, group, user.group);
    const audioLog = await audioConsumeLogRatios(store, originModel);
    const details = billingUsage.prompt_tokens_details || {};
    const outDetails = billingUsage.completion_tokens_details || {};
    const clientFormat = built.kind === "anthropic" ? "anthropic" : built.kind === "gemini" ? "gemini" : "openai";
    const destinationFormat =
      built.kind === "anthropic"
        ? "claude"
        : built.kind === "gemini"
          ? "gemini"
          : built.kind === "responses" || built.kind === "responses-compact"
            ? "openai_responses"
            : relayFormatForClient(clientFormat, mode);
    const useAudioOther = shouldPostAudioConsumeQuota({
      audioInput: details.audio_tokens,
      audioOutput: outDetails.audio_tokens,
      finalRequestFormat: destinationFormat,
      containsAudioRatios: audioLog.containsAudioRatios,
      originModelName: originModel,
    });
    const toolUsage = createToolUsageState({
      model: originModel,
      toolPrices: decodeToolPricesJSON(await store.option(TOOL_PRICE_OPTION_KEY)),
      relayMode: mode,
      requestTools: built.body.tools,
    });
    let toolJson: Record<string, unknown> | null = null;
    if (!isStream) {
      try {
        toolJson = JSON.parse(text) as Record<string, unknown>;
      } catch {
        toolJson = null;
      }
    }
    ingestUpstreamToolUsage(toolUsage, isStream ? { sseText: text } : { json: toolJson });
    const textSummary = useAudioOther
      ? null
      : await calculateTextQuotaFromStore(store, {
          model: originModel,
          group,
          userGroup: user.group,
          usage: billingUsage,
          channelType: channel.type,
          finalRequestFormat: destinationFormat,
          relayMode: toolUsage.relayMode || mode,
          builtInTools: builtInToolCallCounts(toolUsage),
          claudeWebSearchRequests: toolUsage.claudeWebSearchRequests || undefined,
          geminiGoogleSearchCall: toolUsage.geminiGoogleSearchCall || undefined,
          imageCount: actualImageCount,
        });
    const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
    const audioQuota = useAudioOther
      ? calculateAudioQuota({
          inputTextTokens: Number(details.text_tokens || 0),
          inputAudioTokens: Number(details.audio_tokens || 0),
          outputTextTokens: Number(outDetails.text_tokens || 0),
          outputAudioTokens: Number(outDetails.audio_tokens || 0),
          modelName: originModel,
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
      quota = await computeQuota(store, originModel, group, usage.prompt, usage.completion);
    }
    if (useAudioOther) {
      const totalTokens = Number(billingUsage.prompt_tokens || 0) + Number(billingUsage.completion_tokens || 0);
      if (totalTokens === 0 && !isFixedPriceSettlement(tiered?.result, tiered?.snap)) {
        quota = 0;
      }
    }
    const publicExtra = tiered ? injectTieredBillingInfo({}, tiered.snap, tiered.result) : undefined;
    await store.insertLog({
      user_id: user.id,
      type: LOG_CONSUME,
      content: "模型测试",
      username: opts.username || user.username,
      token_name: "模型测试",
      model_name: originModel,
      quota,
      prompt_tokens: textSummary ? textSummary.promptTokens : usage.prompt,
      completion_tokens: usage.completion,
      use_time: Math.floor(milliseconds / 1000),
      is_stream: isStream ? 1 : 0,
      channel_id: channel.id,
      token_id: 0,
      group,
      other: consumeLogOther({
        model: originModel,
        group,
        groupRatio: price.groupRatio,
        modelRatio: price.modelRatio,
        completionRatio: useAudioOther ? audioLog.completionRatio : price.completionRatio,
        cacheTokens: useAudioOther ? 0 : usage.cachedTokens,
        cacheRatio: useAudioOther ? 0 : price.cacheRatio,
        modelPrice: price.modelPrice,
        userGroupRatio: price.userGroupRatio,
        frt: milliseconds,
        isModelMapped: mappedModel !== originModel,
        upstreamModelName: mappedModel,
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        ok: true,
        requestPath,
        requestConversion: requestConversionChain({
          clientFormat,
          mode,
          destinationFormat,
        }),
        isClaudeUsageSemantic: textSummary ? textSummary.isClaudeUsageSemantic : isClaude,
        finalRequestFormat: destinationFormat,
        cacheCreationTokens: textSummary ? textSummary.cacheCreationTokens : cacheCreationTokensTotal(details),
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
        billingSource: "wallet",
        publicExtra,
        quotaClamp,
        toolSurcharges: textSummary?.toolSurchargeItems,
        audioInputPrice: textSummary?.audioInputPrice,
        audioInputTokens: textSummary?.audioTokens,
      }),
    });
  }

  return { success: true, message: "", time: milliseconds / 1000, requestPath, originModel };
}

/** Original `controller.selectChannelsForAutomaticTest`. */
export function selectChannelsForAutomaticTest(channels: ChannelRow[], mode: string): ChannelRow[] {
  return channels.filter((ch) => {
    if (ch.status === CHANNEL_MANUAL_DISABLED) return false;
    if (mode === "auto_ban_only" && Number(ch.auto_ban ?? 1) !== 1) return false;
    if (mode === "passive_recovery" && ch.status !== CHANNEL_AUTO_DISABLED) return false;
    return true;
  });
}

/** Original `controller.shouldUseStreamForAutomaticChannelTest`. */
export function shouldUseStreamForAutomaticChannelTest(channel: ChannelRow): boolean {
  return channel.type === CHANNEL_TYPE_CODEX;
}

/** Original `controller.testChannelForHealthCheck`. */
export async function testChannelForHealthCheck(
  store: Store,
  channel: ChannelRow,
  opts: {
    allowDisable: boolean;
    disableThreshold: number;
    autoDisableEnabled: boolean;
    testUser?: UserRow | null;
    env?: Env;
  },
): Promise<ChannelTestSummary> {
  const summary: ChannelTestSummary = { tested: 0, succeeded: 0, failed: 0, disabled: 0, enabled: 0 };
  const wasEnabled = channel.status === CHANNEL_ENABLED;
  const tik = Date.now();
  const result = await testChannel(store, channel, {
    stream: shouldUseStreamForAutomaticChannelTest(channel),
    userId: opts.testUser?.id,
    username: opts.testUser?.username,
    group: opts.testUser?.group || "default",
  });
  const milliseconds = Date.now() - tik;
  summary.tested++;

  let newAPIError = result.newAPIError ?? null;
  let shouldBan = false;
  if (newAPIError) shouldBan = await shouldDisableChannel(store, newAPIError);
  if (opts.autoDisableEnabled && !shouldBan && milliseconds > opts.disableThreshold) {
    newAPIError = channelAttemptFromResponseTimeExceeded(milliseconds, opts.disableThreshold);
    shouldBan = true;
  }

  if (!newAPIError) summary.succeeded++;
  else summary.failed++;

  if (opts.allowDisable && wasEnabled && shouldBan && Number(channel.auto_ban ?? 1) === 1 && newAPIError) {
    if (opts.testUser) {
      await processChannelError({
        store,
        env: opts.env,
        req: new Request("http://local" + (result.requestPath || "/v1/chat/completions"), { method: "POST" }),
        auth: healthCheckAuth(opts.testUser),
        channel,
        model: result.originModel || "",
        err: newAPIError,
        useChannel: [],
        useTimeSeconds: Math.floor(milliseconds / 1000),
      });
    } else {
      await store.autoDisableChannel(channel.id, errorWithStatusCode(newAPIError));
    }
    summary.disabled++;
  }

  if (!result.localErr && !wasEnabled && (await shouldEnableChannel(store, newAPIError, channel.status))) {
    await store.updateChannelStatus(channel.id, CHANNEL_ENABLED, "");
    summary.enabled++;
  }

  await store.updateChannelResponseTime(channel.id, milliseconds);
  return summary;
}

/** Original `controller.runChannelTestTask` (manual TestAllChannels uses scheduled_all). */
export async function runChannelTestTask(store: Store, mode: string, env?: Env): Promise<ChannelTestSummary> {
  const selected = selectChannelsForAutomaticTest(await store.allChannels(), mode || "scheduled_all");
  const allowDisable = mode !== "passive_recovery";
  const root = await store.getRootUser();
  const disableThreshold = channelDisableThresholdMs(await store.optionNum("ChannelDisableThreshold", 5));
  const autoDisableEnabled = await store.optionBool("AutomaticDisableChannelEnabled", false);
  const summary: ChannelTestSummary = { tested: 0, succeeded: 0, failed: 0, disabled: 0, enabled: 0 };
  for (const ch of selected) {
    const one = await testChannelForHealthCheck(store, ch, {
      allowDisable,
      disableThreshold,
      autoDisableEnabled,
      testUser: root,
      env,
    });
    summary.tested += one.tested;
    summary.succeeded += one.succeeded;
    summary.failed += one.failed;
    summary.disabled += one.disabled;
    summary.enabled += one.enabled;
  }
  return summary;
}

/** Original `channelTestHandler` + scheduled `Enabled`/`Interval`/`NewPayload`. */
export async function runPendingChannelTestSystemTask(store: Store, env?: Env): Promise<ChannelTestSummary | null> {
  const enabled = await store.optionBool("monitor_setting.auto_test_channel_enabled", false);
  let minutes = await store.optionNum("monitor_setting.auto_test_channel_minutes", 10);
  if (minutes <= 0) minutes = 10;
  await scheduleSystemTaskIfDue(store, SYSTEM_TASK_TYPE_CHANNEL_TEST, minutes * 60, enabled);
  return claimAndRunSystemTask(store, SYSTEM_TASK_TYPE_CHANNEL_TEST, async (task) => {
    const payload = (decodeSystemTaskJSON(task.payload) || {}) as { mode?: string; notify?: boolean };
    let mode = String(payload.mode || "").trim();
    if (!mode) mode = (await store.option("monitor_setting.channel_test_mode")) || "scheduled_all";
    return runChannelTestTask(store, mode, env);
  });
}
