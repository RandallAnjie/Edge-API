/** Original `openai.Adaptor` realtime GetRequestURL / SetupRequestHeader / DoWssRequest. */

import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_AZURE,
  CHANNEL_TYPE_CUSTOM,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_OPENROUTER,
  parseJson,
} from "./constants.js";
import { resolveBaseUrl } from "./catalog.js";
import {
  advancedCustomRealtimeSetupHeaders,
  buildAdvancedCustomRealtimeRequestURL,
} from "./channel-validate.js";
import { applyChannelParamOverride, requestHeadersFrom } from "./param-override.js";
import { mapModel, pickChannelKey } from "./select.js";
import type { ChannelRow } from "./types.js";

/** Original gorilla `websocket.DefaultDialer.HandshakeTimeout`. */
export const OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS = 45_000;

/** Original gorilla `websocket.ErrBadHandshake`. */
export const OPENAI_REALTIME_BAD_HANDSHAKE = "websocket: bad handshake";

/**
 * Original `constant.AzureNoRemoveDotTime` Unix seconds
 * (`time.Date(2025, time.May, 10, 0, 0, 0, 0, time.UTC).Unix()`).
 * Local literal so ESM/CJS init order cannot leave the cutoff undefined.
 */
export const OPENAI_AZURE_NO_REMOVE_DOT_TIME = 1746835200;

/** Original `constant.AzureDefaultAPIVersion` / `AZURE_DEFAULT_API_VERSION`. */
export const OPENAI_AZURE_DEFAULT_API_VERSION = "2025-04-01-preview";

type WsLike = {
  readyState?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  accept?(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
};

/** Original `relaycommon.GetFullRequestURL`. */
export function openaiRealtimeFullRequestURL(baseURL: string, requestURL: string, channelType: number): string {
  let full = `${baseURL}${requestURL}`;
  if (baseURL.startsWith("https://gateway.ai.cloudflare.com")) {
    if (channelType === CHANNEL_TYPE_OPENAI) full = `${baseURL}${requestURL.replace(/^\/v1/, "")}`;
    else if (channelType === CHANNEL_TYPE_AZURE) full = `${baseURL}${requestURL.replace(/^\/openai\/deployments/, "")}`;
  }
  return full;
}

/** Original realtime `ChannelBaseUrl` https→wss / http→ws before GetRequestURL. */
export function openaiRealtimeWsBase(baseURL: string): string {
  if (baseURL.startsWith("https://")) return `wss://${baseURL.slice("https://".length)}`;
  if (baseURL.startsWith("http://")) return `ws://${baseURL.slice("http://".length)}`;
  return baseURL;
}

/** Original `c.Request.URL.String()` for gin request URLs (path + query). */
export function openaiRealtimeRequestURLPath(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}${url.search}`;
}

function azureRealtimeModel(channel: ChannelRow, upstreamModel: string): string {
  if (Number(channel.created_time || 0) < OPENAI_AZURE_NO_REMOVE_DOT_TIME) {
    return upstreamModel.split(".").join("");
  }
  return upstreamModel;
}

/** Original `relaycommon.GetAPIVersion`: query `api-version`, else channel Other, else default. */
export function openaiAzureRealtimeApiVersion(channel: ChannelRow, requestUrlPath: string): string {
  const q = requestUrlPath.indexOf("?");
  const fromQuery = q >= 0 ? new URLSearchParams(requestUrlPath.slice(q + 1)).get("api-version") || "" : "";
  return fromQuery || String(channel.other || "") || OPENAI_AZURE_DEFAULT_API_VERSION;
}

/** Original `openai.Adaptor.GetRequestURL` for `RelayModeRealtime`. */
export function openaiRealtimeRequestURL(
  channel: ChannelRow,
  opts: { requestUrlPath: string; upstreamModel: string },
): string {
  const httpBase = resolveBaseUrl(channel.type, channel.base_url);
  const base = openaiRealtimeWsBase(httpBase);
  if (channel.type === CHANNEL_TYPE_AZURE) {
    const apiVersion = openaiAzureRealtimeApiVersion(channel, opts.requestUrlPath);
    const model = azureRealtimeModel(channel, opts.upstreamModel);
    const requestURL = `/openai/realtime?deployment=${model}&api-version=${apiVersion}`;
    return openaiRealtimeFullRequestURL(base, requestURL, channel.type);
  }
  if (channel.type === CHANNEL_TYPE_CUSTOM) {
    return base.split("{model}").join(opts.upstreamModel);
  }
  return openaiRealtimeFullRequestURL(base, opts.requestUrlPath, channel.type);
}

function headerOverrideHasAuthorization(channel: ChannelRow): boolean {
  const raw = parseJson<Record<string, unknown>>(channel.header_override || "", {});
  for (const key of Object.keys(raw)) {
    if (key.toLowerCase() === "authorization") return true;
  }
  return false;
}

/** Original `openai.Adaptor.SetupRequestHeader` realtime branch. */
export function openaiRealtimeSetupHeaders(
  channel: ChannelRow,
  opts: {
    apiKey: string;
    upstreamModel: string;
    clientSecWebSocketProtocol: string;
  },
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (channel.type === CHANNEL_TYPE_AZURE) {
    headers["api-key"] = opts.apiKey;
    return headers;
  }
  if (channel.type === CHANNEL_TYPE_OPENAI && channel.openai_organization) {
    headers["OpenAI-Organization"] = channel.openai_organization;
  }
  const hasAuthOverride = headerOverrideHasAuthorization(channel);
  const legacyRealtimeBeta = opts.upstreamModel.includes("-realtime-preview");
  const swp = opts.clientSecWebSocketProtocol;
  if (swp) {
    const items = ["realtime", `openai-insecure-api-key.${opts.apiKey}`];
    if (legacyRealtimeBeta) items.push("openai-beta.realtime-v1");
    headers["Sec-WebSocket-Protocol"] = items.join(",");
  } else {
    if (legacyRealtimeBeta) headers["openai-beta"] = "realtime=v1";
    if (!hasAuthOverride) headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  if (channel.type === CHANNEL_TYPE_OPENROUTER) {
    if (!headers["HTTP-Referer"] && !headers["http-referer"]) headers["HTTP-Referer"] = "https://www.newapi.ai";
    if (!headers["X-OpenRouter-Title"] && !headers["x-openrouter-title"]) headers["X-OpenRouter-Title"] = "New API";
  }
  return headers;
}

const SENSITIVE_QUERY_KEYS = new Set([
  "key",
  "api_key",
  "api-key",
  "apikey",
  "x-api-key",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "authorization",
  "auth",
  "client_secret",
  "secret",
  "password",
  "passwd",
  "signature",
  "sig",
  "awsaccesskeyid",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
]);

function isSensitiveURLQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().trim();
  if (SENSITIVE_QUERY_KEYS.has(normalized)) return true;
  return normalized.includes("token") || normalized.includes("secret") || normalized.includes("signature");
}

/** Original `common.SanitizeURLForLog`. */
export function sanitizeURLForLog(rawURL: string): string {
  if (!rawURL) return rawURL;
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (![...parsed.searchParams.keys()].length) return rawURL;
  let changed = false;
  const next = new URL(rawURL);
  next.search = "";
  parsed.searchParams.forEach((value, key) => {
    if (isSensitiveURLQueryKey(key)) {
      next.searchParams.append(key, "***masked***");
      changed = true;
    } else {
      next.searchParams.append(key, value);
    }
  });
  return changed ? next.toString() : rawURL;
}

const FETCH_SKIP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

/** Original DoWssRequest header override + client Content-Type after SetupRequestHeader. */
export function openaiRealtimeDialHeaders(channel: ChannelRow, req: Request, apiKey: string, upstreamModel: string): Record<string, string> {
  const headers = openaiRealtimeSetupHeaders(channel, {
    apiKey,
    upstreamModel,
    clientSecWebSocketProtocol: req.headers.get("Sec-WebSocket-Protocol") || "",
  });
  applyChannelParamOverride(
    channel,
    null,
    headers,
    {
      requestHeaders: requestHeadersFrom(req),
      originalModel: upstreamModel,
      upstreamModel,
      requestPath: openaiRealtimeRequestURLPath(req),
    },
    apiKey,
    upstreamModel,
  );
  headers["Content-Type"] = req.headers.get("Content-Type") || "";
  return headers;
}

function fetchHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { Upgrade: "websocket" };
  for (const [key, value] of Object.entries(headers)) {
    if (FETCH_SKIP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "upgrade") continue;
    out[key] = value;
  }
  return out;
}

/** Original `channel.DoWssRequest` gorilla `DefaultDialer.Dial`. */
export async function dialOpenAIRealtimeWebSocket(url: string, headers: Record<string, string>): Promise<WsLike> {
  let res: Response & { webSocket?: WsLike };
  try {
    res = (await fetch(url, {
      headers: fetchHeaders(headers),
      signal: AbortSignal.timeout(OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS),
    })) as Response & { webSocket?: WsLike };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`dial failed to ${sanitizeURLForLog(url)}: ${message}`), {
      status: 500,
      code: "do_request_failed",
    });
  }
  const ws = res.webSocket;
  if (!ws || res.status !== 101) {
    throw Object.assign(new Error(`dial failed to ${sanitizeURLForLog(url)}: ${OPENAI_REALTIME_BAD_HANDSHAKE}`), {
      status: 500,
      code: "do_request_failed",
    });
  }
  if (typeof ws.accept === "function") ws.accept();
  return ws;
}

export function openaiRealtimeUpstream(channel: ChannelRow, req: Request, model: string): { url: string; headers: Record<string, string> } {
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    return advancedCustomRealtimeUpstream(channel, req, model);
  }
  const apiKey = pickChannelKey(channel.key);
  const upstreamModel = mapModel(channel.model_mapping, model || "gpt-4o-realtime-preview");
  return {
    url: openaiRealtimeRequestURL(channel, {
      requestUrlPath: openaiRealtimeRequestURLPath(req),
      upstreamModel,
    }),
    headers: openaiRealtimeDialHeaders(channel, req, apiKey, upstreamModel),
  };
}

/** Original `advancedcustom.Adaptor` GetRequestURL + SetupRequestHeader + DoWssRequest header override. */
export function advancedCustomRealtimeUpstream(
  channel: ChannelRow,
  req: Request,
  model: string,
): { url: string; headers: Record<string, string> } {
  const apiKey = pickChannelKey(channel.key);
  const originModel = model || "gpt-4o-realtime-preview";
  const upstreamModel = mapModel(channel.model_mapping, originModel);
  const incomingPath = openaiRealtimeRequestURLPath(req).split("?")[0];
  let url: string;
  try {
    url = buildAdvancedCustomRealtimeRequestURL(channel, incomingPath, originModel, upstreamModel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`get request url failed: ${message}`), { status: 500, code: "do_request_failed" });
  }
  let headers: Record<string, string>;
  try {
    headers = advancedCustomRealtimeSetupHeaders(channel, incomingPath, originModel, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`setup request header failed: ${message}`), { status: 500, code: "do_request_failed" });
  }
  applyChannelParamOverride(
    channel,
    null,
    headers,
    {
      requestHeaders: requestHeadersFrom(req),
      originalModel: originModel,
      upstreamModel,
      requestPath: openaiRealtimeRequestURLPath(req),
    },
    apiKey,
    upstreamModel,
  );
  headers["Content-Type"] = req.headers.get("Content-Type") || "";
  return { url, headers };
}
