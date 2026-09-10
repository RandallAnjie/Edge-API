/** Original `relay/channel/xunfei` ConvertOpenAIRequest / DoResponse websocket JSON. */

import { hmacSha256Raw } from "./crypto.js";
import { asInt, asObj, sseLine } from "./openai-usage.js";

export type ConvertXunfeiOpts = {
  upstreamModelName?: string;
  created?: number;
};

const RFC1123_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC1123_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") out += o.text;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Go `url.QueryEscape` for typical Xunfei query values. */
export function goQueryEscape(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

/** Go `time.RFC1123` in UTC (`Mon, 02 Jan 2006 15:04:05 UTC`), not JS `toUTCString` GMT. */
export function rfc1123UTC(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${RFC1123_DAYS[date.getUTCDay()]}, ${dd} ${RFC1123_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${hh}:${mm}:${ss} UTC`;
}

/** Original `xunfei.Adaptor.GetRequestURL` returns `""` (DoRequest is a dummy HTTP 200). */
export function xunfeiRequestURL(): string {
  return "";
}

/** Original key split `appId|apiSecret|apiKey`. */
export function parseXunfeiAuth(apiKey: string): { appId: string; apiSecret: string; apiKey: string } {
  const parts = String(apiKey || "").split("|");
  if (parts.length !== 3) throw new Error("invalid auth");
  return { appId: parts[0], apiSecret: parts[1], apiKey: parts[2] };
}

/** Original `getAPIVersion`. */
export function xunfeiApiVersion(modelName: string, requestUrl = "", apiVersionContext = ""): string {
  let query = "";
  try {
    query = new URL(requestUrl, "http://local").searchParams.get("api-version") || "";
  } catch {
    query = "";
  }
  if (query) return query;
  const parts = String(modelName || "").split("-");
  if (parts.length === 2) return parts[1];
  if (apiVersionContext) return apiVersionContext;
  return "v1.1";
}

/** Original `apiVersion2domain`. */
export function xunfeiDomain(apiVersion: string): string {
  switch (apiVersion) {
    case "v1.1":
      return "lite";
    case "v2.1":
      return "generalv2";
    case "v3.1":
      return "generalv3";
    case "v3.5":
      return "generalv3.5";
    case "v4.0":
      return "4.0Ultra";
    default:
      return "general" + apiVersion;
  }
}

/** Original Xunfei ConvertOpenAIRequest: return `request` as-is (keeps `stream_options`). Conversion runs in DoResponse. */
export function convertXunfeiOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertXunfeiOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

function getMaxTokens(body: Record<string, unknown>): number {
  const maxCompletion = Number(body.max_completion_tokens ?? 0);
  if (maxCompletion) return maxCompletion;
  return Number(body.max_tokens ?? 0);
}

/** Original `requestOpenAI2Xunfei`. */
export function requestOpenAI2Xunfei(
  body: Record<string, unknown>,
  appId: string,
  domain: string,
): Record<string, unknown> {
  const model = String(body.model || "");
  const shouldConvertSystem = !model.endsWith("3.5");
  const src = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  const text: { role: string; content: string }[] = [];
  for (const message of src) {
    const role = String(message.role || "");
    const content = stringContent(message.content);
    if (role === "system" && shouldConvertSystem) {
      text.push({ role: "user", content });
      text.push({ role: "assistant", content: "Okay" });
    } else {
      text.push({ role, content });
    }
  }
  const chat: Record<string, unknown> = { domain };
  if (body.temperature != null) chat.temperature = body.temperature;
  const topK = Number(body.n ?? 0);
  if (topK) chat.top_k = topK;
  const maxTokens = getMaxTokens(body);
  if (maxTokens) chat.max_tokens = maxTokens;
  return {
    header: { app_id: appId },
    parameter: { chat },
    payload: { message: { text } },
  };
}

/** Original `buildXunfeiAuthUrl`. */
export async function buildXunfeiAuthUrl(
  hostUrl: string,
  apiKey: string,
  apiSecret: string,
  date = rfc1123UTC(new Date()),
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(hostUrl);
  } catch {
    parsed = new URL("wss://spark-api.xf-yun.com/v1.1/chat");
  }
  const sign = [`host: ${parsed.host}`, `date: ${date}`, `GET ${parsed.pathname} HTTP/1.1`].join("\n");
  const sha = bytesToBase64(await hmacSha256Raw(apiSecret, sign));
  const authHeader = `hmac username="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sha}"`;
  const authorization = bytesToBase64(new TextEncoder().encode(authHeader));
  const query = [
    ["authorization", authorization],
    ["date", date],
    ["host", parsed.host],
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${goQueryEscape(k)}=${goQueryEscape(v)}`)
    .join("&");
  return `${hostUrl}?${query}`;
}

export function xunfeiHostUrl(apiVersion: string): string {
  return `wss://spark-api.xf-yun.com/${apiVersion}/chat`;
}

function usageFromText(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    prompt_tokens: asInt(usage.prompt_tokens),
    completion_tokens: asInt(usage.completion_tokens),
    total_tokens: asInt(usage.total_tokens),
  };
}

function choiceText(payload: Record<string, unknown>): { content: string; status: number }[] {
  const choices = asObj(payload.choices);
  const text = Array.isArray(choices.text) ? (choices.text as Record<string, unknown>[]) : [];
  return text.map((item) => ({ content: String(item.content ?? ""), status: asInt(choices.status) }));
}

/** Original `responseXunfei2OpenAI`. */
export function openaiFromXunfeiResponse(
  upstream: Record<string, unknown>,
  opts: ConvertXunfeiOpts = {},
): Record<string, unknown> {
  const payload = asObj(upstream.payload);
  const items = choiceText(payload);
  const content = items.length ? items[0].content : "";
  const usage = usageFromText(asObj(asObj(payload.usage).text));
  return {
    id: "",
    model: "",
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

/** Original `streamResponseXunfei2OpenAI`. Stream model is `SparkDesk`. */
export function xunfeiUpstreamToOpenAIChat(
  responses: Record<string, unknown>[],
  opts: ConvertXunfeiOpts = {},
): { json: Record<string, unknown>; sse: string } {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  let content = "";
  let last: Record<string, unknown> = {};
  const chunks: string[] = [];
  for (const response of responses) {
    last = response;
    const payload = asObj(response.payload);
    const items = choiceText(payload);
    const piece = items.length ? items[0].content : "";
    if (items.length) content += piece;
    const status = asInt(asObj(payload.choices).status);
    const choice: Record<string, unknown> = { delta: { content: items.length ? piece : "" } };
    if (status === 2) choice.finish_reason = "stop";
    chunks.push(
      sseLine({
        object: "chat.completion.chunk",
        created,
        model: "SparkDesk",
        choices: [choice],
      }),
    );
  }
  const lastPayload = asObj(last.payload);
  const json = openaiFromXunfeiResponse(
    {
      ...last,
      payload: {
        ...lastPayload,
        choices: { ...asObj(lastPayload.choices), text: [{ content }] },
      },
    },
    { created },
  );
  return { json, sse: chunks.join("") + "data: [DONE]\n\n" };
}

type WsLike = {
  readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
};

async function openXunfeiWebSocket(url: string): Promise<WsLike> {
  const WS = (globalThis as { WebSocket?: { new (url: string): WsLike; OPEN?: number } }).WebSocket;
  if (!WS) throw new Error("websocket not available");
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const open = () => resolve(ws);
    ws.addEventListener("open", open);
    ws.addEventListener("error", () => reject(new Error("websocket error")));
    if (ws.readyState === (WS.OPEN ?? 1)) resolve(ws);
  });
}

/** Original `xunfeiMakeRequest` over the WebSocket API. */
export async function xunfeiCollectResponses(
  authUrl: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const ws = await openXunfeiWebSocket(authUrl);
  const out: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error("websocket error"));
      }
    });
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        finish();
        return;
      }
      out.push(parsed);
      if (asInt(asObj(asObj(parsed.payload).choices).status) === 2) finish();
    });
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return out;
}

/** Original Xunfei DoResponse: websocket then OpenAI JSON / SparkDesk SSE. */
export async function runXunfeiChat(
  openaiBody: Record<string, unknown>,
  apiKey: string,
  opts: { stream?: boolean; requestUrl?: string; created?: number } = {},
): Promise<Response> {
  const { appId, apiSecret, apiKey: xfKey } = parseXunfeiAuth(apiKey);
  const version = xunfeiApiVersion(String(openaiBody.model || ""), opts.requestUrl || "");
  const domain = xunfeiDomain(version);
  const authUrl = await buildXunfeiAuthUrl(xunfeiHostUrl(version), xfKey, apiSecret);
  const payload = requestOpenAI2Xunfei(openaiBody, appId, domain);
  const responses = await xunfeiCollectResponses(authUrl, payload);
  const converted = xunfeiUpstreamToOpenAIChat(responses, { created: opts.created });
  if (opts.stream) {
    return new Response(converted.sse, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return new Response(JSON.stringify(converted.json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
