import {
  AZURE_API_VERSION,
  CHANNEL_TYPE_ALI,
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_AWS,
  CHANNEL_TYPE_BAIDU_V2,
  CHANNEL_TYPE_CLOUDFLARE,
  CHANNEL_TYPE_DEEPSEEK,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_MINIMAX,
  CHANNEL_TYPE_MOONSHOT,
  CHANNEL_TYPE_OLLAMA,
  CHANNEL_TYPE_OPENROUTER,
  CHANNEL_TYPE_PERPLEXITY,
  CHANNEL_TYPE_VERTEX,
  CHANNEL_TYPE_VOLC,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_TYPE_ZHIPU_V4,
  CLAUDE_VERSION,
  parseJson,
} from "./constants.js";
import { awsConverseUrl, getAwsModelID, parseAwsApiKey } from "./aws-convert.js";
import { baiduWorkshopURL } from "./baidu-convert.js";
import { applyBaiduV2Auth, baiduV2RequestURL } from "./baidu-v2-convert.js";
import { cloudflareRequestURL } from "./cloudflare-convert.js";
import { minimaxRequestURL } from "./minimax-convert.js";
import { perplexityRequestURL } from "./perplexity-convert.js";
import { zhipuV3RequestURL, zhipuV4RequestURL } from "./zhipu-convert.js";
import {
  buildAnthropicModelURL,
  buildGoogleModelURL,
  buildOpenSourceChatCompletionsURL,
  getModelRegion,
  vertexActionSuffix,
  vertexClaudeURLModel,
  vertexProjectIdFromKey,
  vertexRequestMode,
} from "./vertex-convert.js";
import { CHANNEL_SPECIAL_BASES, channelKind, defaultBaseUrl, resolveBaseUrl } from "./catalog.js";
import { applyChannelParamOverride, type ParamOverrideRelayInfo } from "./param-override.js";
import { mapModel, pickChannelKey } from "./select.js";
import type { ChannelRow } from "./types.js";

export type RelayMode =
  | "chat"
  | "completions"
  | "embeddings"
  | "messages"
  | "gemini"
  | "images"
  | "moderations"
  | "audio_speech"
  | "audio_transcription"
  | "audio_translation"
  | "rerank"
  | "responses"
  | "models"
  | "passthrough"
  | "video"
  | "alpha_search"
  | "engines_embeddings"
  | "realtime";

export interface UpstreamTarget {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  method: string;
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (b.endsWith("/v1") && p.startsWith("/v1/")) return b + p.slice(3);
  if (b.endsWith("/api") && p.startsWith("/api/")) return b + p.slice(4);
  return b + p;
}

function openaiPath(mode: RelayMode, requestPath: string): string {
  switch (mode) {
    case "chat":
      return "/v1/chat/completions";
    case "completions":
      return "/v1/completions";
    case "embeddings":
      return "/v1/embeddings";
    case "images":
      return requestPath.includes("/edits") ? "/v1/images/edits" : "/v1/images/generations";
    case "moderations":
      return "/v1/moderations";
    case "audio_speech":
      return "/v1/audio/speech";
    case "audio_transcription":
      return "/v1/audio/transcriptions";
    case "audio_translation":
      return "/v1/audio/translations";
    case "rerank":
      return "/v1/rerank";
    case "responses":
      if (requestPath.includes("/v1/responses/compact")) return "/v1/responses/compact";
      return "/v1/responses";
    case "video":
      return requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
    case "alpha_search":
      return "/v1/alpha/search";
    case "engines_embeddings":
      return requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
    case "realtime":
      return requestPath.includes("?") ? requestPath : "/v1/realtime";
    case "models":
      return "/v1/models";
    default:
      return requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  }
}

export function applyModelMapping(channel: ChannelRow, model: string): string {
  return mapModel(channel.model_mapping, model);
}

export function buildUpstream(
  channel: ChannelRow,
  mode: RelayMode,
  requestPath: string,
  model: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  method = "POST",
  relayInfo: ParamOverrideRelayInfo = {},
): UpstreamTarget {
  const kind = channelKind(channel.type);
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const apiKey = pickChannelKey(channel.key);
  const upstreamModel = relayInfo.upstreamModel || applyModelMapping(channel, model);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };

  let url = "";
  let payload: unknown = body;

  if (payloadIsObject(body) && upstreamModel && "model" in body) {
    payload = { ...(body as Record<string, unknown>), model: upstreamModel };
  }

  if (channel.type === CHANNEL_TYPE_AWS) {
    const settings = parseJson<Record<string, unknown>>(channel.settings || "", {});
    const keyType = String(settings.aws_key_type || "");
    const parts = apiKey.split("|");
    if (keyType === "api_key" || parts.length === 2) {
      const parsed = parseAwsApiKey(apiKey);
      url = awsConverseUrl(getAwsModelID(upstreamModel), parsed.region);
      headers.authorization = `Bearer ${apiKey}`;
      headers["anthropic-version"] = extraHeaders["anthropic-version"] || CLAUDE_VERSION;
      payload = applyChannelParamOverride(channel, payload, headers, {
        ...relayInfo,
        originalModel: relayInfo.originalModel || model,
        upstreamModel: relayInfo.upstreamModel || upstreamModel,
        requestPath: relayInfo.requestPath || requestPath,
      }, apiKey, upstreamModel);
      return { url, headers, body: payload, method };
    }
    if (parts.length !== 3) throw new Error("invalid aws secret key");
    url = awsConverseUrl(getAwsModelID(upstreamModel), parts[2]);
    headers["anthropic-version"] = extraHeaders["anthropic-version"] || CLAUDE_VERSION;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_VERTEX) {
    const mode = vertexRequestMode(upstreamModel);
    const region = getModelRegion(channel.other || "", relayInfo.originalModel || model);
    const settings = parseJson<Record<string, unknown>>(channel.settings || "", {});
    const keyType = String(settings.vertex_key_type || "");
    const stream =
      requestPath.includes("streamGenerateContent") ||
      requestPath.includes("streamRawPredict") ||
      (payloadIsObject(body) && Boolean((body as { stream?: boolean }).stream));
    const suffix = vertexActionSuffix(mode, upstreamModel, stream);
    const urlModel = mode === "claude" ? vertexClaudeURLModel(upstreamModel) : upstreamModel;
    const projectID = vertexProjectIdFromKey(apiKey);
    if (keyType === "api_key") {
      if (mode === "opensource") throw new Error("unsupported request mode");
      const built =
        mode === "claude"
          ? buildAnthropicModelURL(base, "v1", "", region, urlModel, suffix)
          : buildGoogleModelURL(base, "v1", "", region, urlModel, suffix);
      const keyPrefix = suffix.endsWith("?alt=sse") ? "&" : "?";
      url = `${built}${keyPrefix}key=${encodeURIComponent(apiKey)}`;
      headers["x-goog-api-key"] = apiKey;
    } else {
      if (mode === "opensource") url = buildOpenSourceChatCompletionsURL(base, projectID, region);
      else if (mode === "claude") url = buildAnthropicModelURL(base, "v1", projectID, region, urlModel, suffix);
      else url = buildGoogleModelURL(base, "v1", projectID, region, urlModel, suffix);
      if (projectID) headers["x-goog-user-project"] = projectID;
    }
    if (mode === "claude") headers["anthropic-version"] = extraHeaders["anthropic-version"] || CLAUDE_VERSION;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_DEEPSEEK) {
    if (mode === "messages") url = `${base}/anthropic/v1/messages`;
    else if (mode === "completions") {
      const fim = base.endsWith("/beta") ? base : `${base}/beta`;
      url = `${fim}/completions`;
    } else if (mode === "responses") url = `${base}/responses`;
    else url = `${base}/v1/chat/completions`;
    headers.authorization = `Bearer ${apiKey}`;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_ZHIPU) {
    const stream = Boolean(relayInfo.isStream) || (payloadIsObject(body) && Boolean((body as { stream?: boolean }).stream));
    url = zhipuV3RequestURL(base, upstreamModel, stream);
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_ZHIPU_V4) {
    url = zhipuV4RequestURL(base, mode, channel.base_url || "");
    headers.authorization = `Bearer ${apiKey}`;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_PERPLEXITY) {
    url = perplexityRequestURL(base, mode);
    headers.authorization = `Bearer ${apiKey}`;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_CLOUDFLARE) {
    url = cloudflareRequestURL(base, channel.other || "", mode, upstreamModel);
    headers.authorization = `Bearer ${apiKey}`;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_BAIDU_V2) {
    url = baiduV2RequestURL(base, mode, requestPath);
    applyBaiduV2Auth(headers, apiKey);
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  if (channel.type === CHANNEL_TYPE_MINIMAX) {
    url = minimaxRequestURL(base, mode);
    headers.authorization = `Bearer ${apiKey}`;
    payload = applyChannelParamOverride(channel, payload, headers, {
      ...relayInfo,
      originalModel: relayInfo.originalModel || model,
      upstreamModel: relayInfo.upstreamModel || upstreamModel,
      requestPath: relayInfo.requestPath || requestPath,
    }, apiKey, upstreamModel);
    return { url, headers, body: payload, method };
  }

  switch (kind) {
    case "azure": {
      const version = channel.other || AZURE_API_VERSION;
      const task = openaiPath(mode, requestPath).replace(/^\/v1\//, "");
      url = `${base}/openai/deployments/${encodeURIComponent(upstreamModel)}/${task}?api-version=${encodeURIComponent(version)}`;
      headers["api-key"] = apiKey;
      break;
    }
    case "anthropic": {
      url = joinUrl(base, "/v1/messages");
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = extraHeaders["anthropic-version"] || CLAUDE_VERSION;
      delete headers.authorization;
      break;
    }
    case "gemini": {
      const version = "v1beta";
      const stream =
        requestPath.includes("streamGenerateContent") ||
        (payloadIsObject(body) && Boolean((body as { stream?: boolean }).stream));
      const action =
        mode === "embeddings"
          ? "embedContent"
          : stream
            ? "streamGenerateContent?alt=sse"
            : "generateContent";
      url = `${base}/${version}/models/${encodeURIComponent(upstreamModel)}:${action}`;
      if (apiKey) {
        url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(apiKey);
        headers["x-goog-api-key"] = apiKey;
      }
      break;
    }
    case "ollama": {
      if (mode === "embeddings") url = `${base}/api/embed`;
      else if (mode === "responses") {
        url = requestPath.includes("/v1/responses/compact") ? `${base}/v1/responses/compact` : `${base}/v1/responses`;
      } else if (mode === "completions") url = `${base}/api/generate`;
      else if (mode === "messages") url = `${base}/v1/messages`;
      else url = `${base}/api/chat`;
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "custom": {
      url = (channel.base_url || "").replace(/\{model\}/g, upstreamModel);
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "ali": {
      url = joinUrl(base, "/compatible-mode" + openaiPath(mode, requestPath));
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "volc": {
      const special = CHANNEL_SPECIAL_BASES[channel.base_url || ""];
      if (mode === "messages" && special?.claude) {
        url = `${special.claude.replace(/\/+$/, "")}/v1/messages`;
      } else if (mode === "chat" && special?.openai) {
        url = `${special.openai.replace(/\/+$/, "")}/chat/completions`;
      } else if (mode === "images") {
        url = `${base}/api/v3/images/generations`;
      } else if ((mode === "chat" || mode === "messages") && upstreamModel.startsWith("bot")) {
        url = `${base}/api/v3/bots/chat/completions`;
      } else {
        url = joinUrl(base, "/api/v3" + openaiPath(mode, requestPath).replace(/^\/v1/, ""));
      }
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "cohere": {
      if (mode === "rerank") url = joinUrl(base, "/v1/rerank");
      else url = joinUrl(base, "/v1/chat");
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "dify": {
      url = joinUrl(base, "/v1/chat-messages");
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "coze": {
      url = joinUrl(base, "/v3/chat");
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "baidu": {
      url = baiduWorkshopURL(base, upstreamModel);
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "mj": {
      url = joinUrl(base, requestPath);
      headers.authorization = `Bearer ${apiKey}`;
      headers["mj-api-secret"] = apiKey;
      break;
    }
    default: {
      url = joinUrl(base, openaiPath(mode, requestPath));
      headers.authorization = `Bearer ${apiKey}`;
      if (channel.openai_organization) headers["openai-organization"] = channel.openai_organization;
      if (channel.type === CHANNEL_TYPE_OPENROUTER) {
        if (!headers["HTTP-Referer"] && !headers["http-referer"]) headers["HTTP-Referer"] = "https://www.newapi.ai";
        if (!headers["X-OpenRouter-Title"] && !headers["x-openrouter-title"]) headers["X-OpenRouter-Title"] = "New API";
      }
    }
  }

  payload = applyChannelParamOverride(channel, payload, headers, {
    ...relayInfo,
    originalModel: relayInfo.originalModel || model,
    upstreamModel: relayInfo.upstreamModel || upstreamModel,
    requestPath: relayInfo.requestPath || requestPath,
  }, apiKey, upstreamModel);

  return { url, headers, body: payload, method };
}

function payloadIsObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Original `controller.normalizeModelNames`. */
export function normalizeModelNames(models: string[] | undefined | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models || []) {
    const trimmed = String(model || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function applyFetchModelsHeaderOverrides(channel: ChannelRow, apiKey: string, headers: Record<string, string>): void {
  const headerOverride = parseJson<Record<string, string>>(channel.header_override || "", {});
  for (const [k, v] of Object.entries(headerOverride)) {
    headers[k] = String(v).replace(/\{api_key\}/g, apiKey);
  }
}

/** Original `controller.fetchChannelUpstreamModelIDs` request URL + auth headers. */
export function modelsUrl(channel: ChannelRow): UpstreamTarget {
  const type = Number(channel.type);
  const apiKey = pickChannelKey(channel.key);
  const rawBase = String(channel.base_url || "").trim() || defaultBaseUrl(type);
  const special = CHANNEL_SPECIAL_BASES[rawBase];
  const headers: Record<string, string> = {};

  if (type === CHANNEL_TYPE_OLLAMA) {
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    applyFetchModelsHeaderOverrides(channel, apiKey, headers);
    return { url: `${rawBase.replace(/\/+$/, "")}/api/tags`, headers, body: null, method: "GET" };
  }

  if (type === CHANNEL_TYPE_GEMINI) {
    headers["x-goog-api-key"] = apiKey;
    applyFetchModelsHeaderOverrides(channel, apiKey, headers);
    return { url: `${rawBase.replace(/\/+$/, "")}/v1beta/models`, headers, body: null, method: "GET" };
  }

  if (type === CHANNEL_TYPE_ANTHROPIC) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = CLAUDE_VERSION;
    applyFetchModelsHeaderOverrides(channel, apiKey, headers);
    return { url: joinUrl(rawBase, "/v1/models"), headers, body: null, method: "GET" };
  }

  headers.authorization = `Bearer ${apiKey}`;
  applyFetchModelsHeaderOverrides(channel, apiKey, headers);

  let url: string;
  if (type === CHANNEL_TYPE_ALI) {
    url = `${rawBase.replace(/\/+$/, "")}/compatible-mode/v1/models`;
  } else if (type === CHANNEL_TYPE_ZHIPU_V4) {
    url = special?.openai
      ? `${special.openai.replace(/\/+$/, "")}/models`
      : `${rawBase.replace(/\/+$/, "")}/api/paas/v4/models`;
  } else if (type === CHANNEL_TYPE_VOLC) {
    url = special?.openai
      ? `${special.openai.replace(/\/+$/, "")}/v1/models`
      : `${rawBase.replace(/\/+$/, "")}/api/v3/models`;
  } else if (type === CHANNEL_TYPE_MOONSHOT && special?.openai) {
    url = `${special.openai.replace(/\/+$/, "")}/models`;
  } else {
    url = joinUrl(rawBase, "/v1/models");
  }
  return { url, headers, body: null, method: "GET" };
}
