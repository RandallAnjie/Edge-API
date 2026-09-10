import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_BAIDU,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_COHERE,
  CHANNEL_TYPE_COZE,
  CHANNEL_TYPE_MOKA,
  CHANNEL_TYPE_VOLC,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_AUTO_DISABLED,
  CHANNEL_ENABLED,
  CHANNEL_MANUAL_DISABLED,
  CLAUDE_VERSION,
  LOG_CONSUME,
  UNSUPPORTED_CHANNEL_TEST_TYPES,
  csv,
} from "./constants.js";
import { channelKind, channelTypeName, resolveBaseUrl } from "./catalog.js";
import {
  convertOpenAIRequest,
  isOpenAIReasoningOModel,
  openaiChatToResponses,
  openaiToAnthropic,
  openaiToGemini,
} from "./convert.js";
import { applyBaiduAccessToken, convertBaiduEmbeddingRequest } from "./baidu-convert.js";
import { applyZhipuV3Authorization } from "./zhipu-convert.js";
import { convertCohereRerankRequest } from "./cohere-convert.js";
import { completeCozeNonStreamChat } from "./coze-convert.js";
import { consumeLogOther, DEFAULT_ENDPOINT_INFO } from "./dto.js";
import { computeQuota, quotaRatios } from "./quota.js";
import { applyModelMapping, buildUpstream, type RelayMode, type UpstreamTarget } from "./upstream.js";
import { applyChannelParamOverride, type ParamOverrideRelayInfo } from "./param-override.js";
import { buildAdvancedCustomRelayTarget } from "./channel-validate.js";
import { buildCodexRelayTarget } from "./codex-models.js";
import { pickChannelKey } from "./select.js";
import type { Store } from "./store.js";
import type { ChannelRow, UserRow } from "./types.js";

/** Original `controller.channelTestSummary`. */
export type ChannelTestSummary = {
  tested: number;
  succeeded: number;
  failed: number;
  disabled: number;
  enabled: number;
};

/** Original `controller.TestChannel` JSON. */
export type ChannelTestResult = {
  success: boolean;
  message: string;
  time: number;
  error_code?: string;
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

function convertAdvancedCustomOpenAIChat(converter: string, body: Record<string, unknown>): unknown {
  switch (converter) {
    case "none":
      return body;
    case "openai_chat_completions_to_anthropic_messages":
      return openaiToAnthropic(body);
    case "openai_chat_completions_to_gemini_generate_content":
      return openaiToGemini(body);
    case "openai_chat_completions_to_openai_responses":
      return openaiChatToResponses(body);
    default:
      throw new Error(`converter ${JSON.stringify(converter)} does not support OpenAI chat completions requests`);
  }
}

async function fetchTarget(target: UpstreamTarget): Promise<Response> {
  const init: RequestInit = { method: target.method, headers: target.headers };
  if (target.method !== "GET" && target.method !== "HEAD" && target.body != null) {
    init.body = typeof target.body === "string" ? target.body : JSON.stringify(target.body);
  }
  return fetch(target.url, init);
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

function extractUsageFromBody(text: string, isStream: boolean, estimate: number): { prompt: number; completion: number } | Error {
  if (isStream) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const usage = findUsage(JSON.parse(payload));
        if (usage) return usage;
      } catch {
        /* ignore */
      }
    }
    return { prompt: estimate, completion: 0 };
  }
  try {
    const usage = findUsage(JSON.parse(text));
    if (usage) return usage;
  } catch {
    /* ignore */
  }
  return new Error("usage is nil");
}

function fail(message: string, errorCode?: string): ChannelTestResult {
  const out: ChannelTestResult = { success: false, message, time: 0 };
  if (errorCode) out.error_code = errorCode;
  return out;
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
    const target = buildCodexRelayTarget(channel, mode, requestPath, mappedModel, body, isStream);
    target.body = applyChannelParamOverride(channel, target.body, target.headers, info, pickChannelKey(channel.key), mappedModel);
    return target;
  }
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const target = buildAdvancedCustomRelayTarget(channel, requestPath, originModel, mappedModel, body, isStream);
    if (kind === "chat") {
      target.body = convertAdvancedCustomOpenAIChat(target.converter, body as Record<string, unknown>);
    } else if (target.converter !== "none") {
      throw new Error(`converter ${JSON.stringify(target.converter)} does not support ${requestPath} requests`);
    }
    if (
      target.converter === "openai_chat_completions_to_anthropic_messages" ||
      (target.converter === "none" && requestPath === "/v1/messages")
    ) {
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
    });
    if (payload && typeof payload === "object" && typeof (payload as { model?: unknown }).model === "string") {
      info.upstreamModel = String((payload as { model: string }).model);
    }
  } else if (kind === "embedding" && channel.type === CHANNEL_TYPE_BAIDU) {
    payload = convertBaiduEmbeddingRequest(body as Record<string, unknown>);
  } else if (kind === "rerank" && channel.type === CHANNEL_TYPE_COHERE) {
    payload = convertCohereRerankRequest(body as Record<string, unknown>, { upstreamModelName: mappedModel });
  }
  const extra: Record<string, string> = {};
  if (kind === "anthropic" || kindName === "anthropic") extra["anthropic-version"] = CLAUDE_VERSION;
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

  if (mode === "responses" && requestPath.includes("/compact") && !supportsResponsesCompact(channel.type)) {
    const { apiType } = channelType2APIType(channel.type);
    return fail(`responses compaction test is not supported for api type ${apiType}`, "invalid_api_type");
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("invalid api type") || message.includes("compaction") ? "invalid_api_type" : "convert_request_failed";
    return fail(message, code);
  }

  const started = Date.now();
  let res: Response;
  try {
    if (channel.type === CHANNEL_TYPE_BAIDU) {
      target.url = await applyBaiduAccessToken(target.url, pickChannelKey(channel.key));
    }
    if (channel.type === CHANNEL_TYPE_ZHIPU) {
      await applyZhipuV3Authorization(target.headers, pickChannelKey(channel.key));
    }
    res = await fetchTarget(target);
    if (channel.type === CHANNEL_TYPE_COZE && !isStream) {
      const completed = await completeCozeNonStreamChat(res, resolveBaseUrl(channel.type, channel.base_url), target.headers);
      res = completed.response;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), "do_request_failed");
  }

  const milliseconds = Date.now() - started;
  const text = await res.text();
  if (res.status !== 200) {
    let message = text.slice(0, 500) || res.statusText;
    try {
      const parsed = JSON.parse(text) as unknown;
      const extracted = detectErrorMessageFromJSON(parsed);
      if (extracted) message = extracted;
    } catch {
      /* keep raw */
    }
    return fail(message, "bad_response");
  }

  const bodyErr = detectErrorFromTestResponseBody(isStream ? text.slice(0, 8 * 1024) : text);
  if (bodyErr) return fail(bodyErr.message, "bad_response_body");
  if (isStream) {
    const streamErr = validateStreamTestResponseBody(text.slice(0, 8 * 1024));
    if (streamErr) return fail(streamErr.message, "bad_response_body");
  }

  const estimate = 1;
  const usage = extractUsageFromBody(text, isStream, estimate);
  if (usage instanceof Error) return fail(usage.message, "bad_response_body");

  await store.updateChannel(channel.id, {
    test_time: Math.floor(Date.now() / 1000),
    response_time: milliseconds,
  });

  let user: UserRow | null = null;
  if (opts.userId) user = await store.getUserById(opts.userId);
  if (!user) user = await store.getRootUser();
  if (user && (await store.optionBool("LogConsumeEnabled", true))) {
    const group = opts.group || user.group || "default";
    const quota = await computeQuota(store, originModel, group, usage.prompt, usage.completion);
    const ratios = await quotaRatios(store, originModel, group);
    await store.insertLog({
      user_id: user.id,
      type: LOG_CONSUME,
      content: "模型测试",
      username: opts.username || user.username,
      token_name: "模型测试",
      model_name: originModel,
      quota,
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      use_time: Math.floor(milliseconds / 1000),
      is_stream: isStream ? 1 : 0,
      channel_id: channel.id,
      token_id: 0,
      group,
      other: consumeLogOther({
        model: originModel,
        group,
        groupRatio: ratios.groupRatio,
        modelRatio: ratios.modelRatio,
        completionRatio: ratios.completionRatio,
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        ok: true,
        requestPath,
        billingSource: "wallet",
      }),
    });
  }

  return { success: true, message: "", time: milliseconds / 1000 };
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

/** Original `controller.runChannelTestTask` (manual TestAllChannels uses scheduled_all). */
export async function runChannelTestTask(store: Store, mode: string): Promise<ChannelTestSummary> {
  const selected = selectChannelsForAutomaticTest(await store.allChannels(), mode || "scheduled_all");
  const allowDisable = mode !== "passive_recovery";
  const root = await store.getRootUser();
  const summary: ChannelTestSummary = { tested: 0, succeeded: 0, failed: 0, disabled: 0, enabled: 0 };
  for (const ch of selected) {
    const wasEnabled = ch.status === CHANNEL_ENABLED;
    const result = await testChannel(store, ch, {
      stream: shouldUseStreamForAutomaticChannelTest(ch),
      userId: root?.id,
      username: root?.username,
      group: root?.group || "default",
    });
    summary.tested++;
    if (result.success) {
      summary.succeeded++;
      if (!wasEnabled && ch.status === CHANNEL_AUTO_DISABLED) {
        await store.updateChannel(ch.id, { status: CHANNEL_ENABLED });
        summary.enabled++;
      }
    } else {
      summary.failed++;
      if (allowDisable && wasEnabled && Number(ch.auto_ban ?? 1) === 1) {
        await store.autoDisableChannel(ch.id);
        summary.disabled++;
      }
    }
  }
  return summary;
}
