import { AZURE_API_VERSION, CLAUDE_VERSION, parseJson } from "./constants.js";
import { channelKind, resolveBaseUrl } from "./catalog.js";
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
  | "passthrough";

export interface UpstreamTarget {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  method: string;
}

function joinUrl(base: string, path: string): string {
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
      return "/v1/responses";
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
): UpstreamTarget {
  const kind = channelKind(channel.type);
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const apiKey = pickChannelKey(channel.key);
  const upstreamModel = applyModelMapping(channel, model);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };

  let url = "";
  let payload: unknown = body;

  if (payloadIsObject(body) && upstreamModel && "model" in body) {
    payload = { ...(body as Record<string, unknown>), model: upstreamModel };
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
      const stream = payloadIsObject(body) && Boolean((body as { stream?: boolean }).stream);
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
      url = joinUrl(base, openaiPath(mode, requestPath));
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "cloudflare": {
      const account = channel.other || "";
      url = `${base}/client/v4/accounts/${account}/ai/v1${openaiPath(mode, requestPath).replace(/^\/v1/, "")}`;
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
    case "zhipu": {
      const p = openaiPath(mode, requestPath).replace(/^\/v1/, "/api/paas/v4");
      url = joinUrl(base, p);
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "volc": {
      url = joinUrl(base, "/api/v3" + openaiPath(mode, requestPath).replace(/^\/v1/, ""));
      headers.authorization = `Bearer ${apiKey}`;
      break;
    }
    case "cohere": {
      url = joinUrl(base, mode === "embeddings" ? "/v1/embed" : "/v2/chat");
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
      url = joinUrl(base, "/v2/chat/completions");
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
    }
  }

  const headerOverride = parseJson<Record<string, string>>(channel.header_override, {});
  for (const [k, v] of Object.entries(headerOverride)) {
    headers[k] = String(v).replace(/\{api_key\}/g, apiKey).replace(/\{model\}/g, upstreamModel);
  }
  const paramOverride = parseJson<Record<string, unknown>>(channel.param_override, {});
  if (payloadIsObject(payload) && Object.keys(paramOverride).length) {
    payload = { ...(payload as Record<string, unknown>), ...paramOverride };
  }

  return { url, headers, body: payload, method: "POST" };
}

function payloadIsObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function modelsUrl(channel: ChannelRow): UpstreamTarget {
  const kind = channelKind(channel.type);
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const apiKey = pickChannelKey(channel.key);
  if (kind === "gemini") {
    return {
      url: `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      headers: { "x-goog-api-key": apiKey },
      body: null,
      method: "GET",
    };
  }
  if (kind === "anthropic") {
    return {
      url: joinUrl(base, "/v1/models"),
      headers: { "x-api-key": apiKey, "anthropic-version": CLAUDE_VERSION },
      body: null,
      method: "GET",
    };
  }
  if (kind === "azure") {
    const version = channel.other || AZURE_API_VERSION;
    return {
      url: `${base}/openai/models?api-version=${encodeURIComponent(version)}`,
      headers: { "api-key": apiKey },
      body: null,
      method: "GET",
    };
  }
  return {
    url: joinUrl(base, "/v1/models"),
    headers: { authorization: `Bearer ${apiKey}` },
    body: null,
    method: "GET",
  };
}
