/** Original `relay/channel/zhipu` + `relay/channel/zhipu_4v` ConvertOpenAIRequest / GetRequestURL / DoResponse. */

import { CHANNEL_SPECIAL_BASES } from "./catalog.js";
import { hmacSha256Raw } from "./crypto.js";
import { asObj, sseLine } from "./openai-usage.js";

const ZHIPU_TOKEN_TTL_MS = 24 * 3600 * 1000;

type ZhipuTokenCache = { token: string; expiryTime: number };

const zhipuTokens = new Map<string, ZhipuTokenCache>();

export function clearZhipuTokenCache(): void {
  zhipuTokens.clear();
}

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

function getMaxTokens(req: Record<string, unknown>): number {
  const maxCompletion = Number(req.max_completion_tokens ?? 0);
  if (maxCompletion) return Math.trunc(maxCompletion);
  return Math.trunc(Number(req.max_tokens ?? 0));
}

function clampTopP(body: Record<string, unknown>): number | undefined {
  if (!("top_p" in body) || body.top_p == null) return undefined;
  const v = Number(body.top_p);
  return v >= 1 ? 0.99 : (body.top_p as number);
}

function stripDataImageUrl(url: string): string {
  if (!url.startsWith("data:image/")) return url;
  const idx = url.indexOf(",");
  return idx === -1 ? url : url.slice(idx + 1);
}

function rewriteZhipuV4Content(content: unknown): unknown {
  if (typeof content === "string" || content == null) return content;
  if (!Array.isArray(content)) return content;
  return content.map((item) => {
    if (!item || typeof item !== "object") return item;
    const part = { ...(item as Record<string, unknown>) };
    if (part.type !== "image_url") return part;
    const raw = part.image_url;
    if (typeof raw === "string") {
      part.image_url = { url: stripDataImageUrl(raw) };
      return part;
    }
    if (raw && typeof raw === "object") {
      const img = { ...(raw as Record<string, unknown>) };
      if (typeof img.url === "string") img.url = stripDataImageUrl(img.url);
      part.image_url = img;
    }
    return part;
  });
}

/** Original `zhipu.getZhipuToken` — HS256 JWT with `sign_type: SIGN`, exp/timestamp in milliseconds. Invalid key → "". */
export async function getZhipuToken(apikey: string, now = Date.now()): Promise<string> {
  const cached = zhipuTokens.get(apikey);
  if (cached && now < cached.expiryTime) return cached.token;

  const split = apikey.split(".");
  if (split.length !== 2) return "";

  const id = split[0];
  const secret = split[1];
  const expMillis = now + ZHIPU_TOKEN_TTL_MS;
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", sign_type: "SIGN", typ: "JWT" })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ api_key: id, exp: expMillis, timestamp: now })));
  const token = `${header}.${payload}.${b64url(await hmacSha256Raw(secret, `${header}.${payload}`))}`;
  zhipuTokens.set(apikey, { token, expiryTime: now + ZHIPU_TOKEN_TTL_MS });
  return token;
}

/** Original `zhipu.Adaptor.SetupRequestHeader` (`Authorization` is the raw JWT, not Bearer). */
export async function applyZhipuV3Authorization(headers: Record<string, string>, apiKey: string): Promise<void> {
  headers.authorization = await getZhipuToken(apiKey);
}

/** Original `zhipu.Adaptor.GetRequestURL`. */
export function zhipuV3RequestURL(base: string, upstreamModel: string, stream: boolean): string {
  const method = stream ? "sse-invoke" : "invoke";
  return `${base.replace(/\/+$/, "")}/api/paas/v3/model-api/${upstreamModel}/${method}`;
}

/** Original `zhipu_4v.Adaptor.GetRequestURL`. */
export function zhipuV4RequestURL(base: string, mode: string, rawBaseUrl = ""): string {
  const special = CHANNEL_SPECIAL_BASES[rawBaseUrl] || CHANNEL_SPECIAL_BASES[base];
  const root = base.replace(/\/+$/, "");
  if (mode === "messages") {
    if (special?.claude) return `${special.claude.replace(/\/+$/, "")}/v1/messages`;
    return `${root}/api/anthropic/v1/messages`;
  }
  if (mode === "embeddings") {
    if (special?.openai) return `${special.openai.replace(/\/+$/, "")}/embeddings`;
    return `${root}/api/paas/v4/embeddings`;
  }
  if (mode === "images") {
    if (special?.openai) return `${special.openai.replace(/\/+$/, "")}/images/generations`;
    return `${root}/api/paas/v4/images/generations`;
  }
  if (mode === "responses") return `${root}/api/v1/responses`;
  if (special?.openai) return `${special.openai.replace(/\/+$/, "")}/chat/completions`;
  return `${root}/api/paas/v4/chat/completions`;
}

/** Original `zhipu.requestOpenAI2Zhipu`. `incremental: false` is omitempty. */
export function convertZhipuOpenAIRequest(body: Record<string, unknown>): Record<string, unknown> {
  const prompt: { role: string; content: string }[] = [];
  const src = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (const message of src) {
    if (message.role === "system") {
      prompt.push({ role: "system", content: stringContent(message.content) });
      prompt.push({ role: "user", content: "Okay" });
    } else {
      prompt.push({ role: String(message.role || "user"), content: stringContent(message.content) });
    }
  }
  const out: Record<string, unknown> = { prompt };
  if (body.temperature != null && Number(body.temperature) !== 0) out.temperature = body.temperature;
  const topP = clampTopP(body);
  if (topP) out.top_p = topP;
  return out;
}

/** Original `zhipu_4v.requestOpenAI2Zhipu`. */
export function convertZhipuV4OpenAIRequest(
  body: Record<string, unknown>,
  opts: { upstreamModelName?: string } = {},
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const src = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  for (const message of src) {
    const isString = typeof message.content === "string";
    const msg: Record<string, unknown> = {
      role: message.role,
      content: isString ? message.content : rewriteZhipuV4Content(message.content),
    };
    if (message.tool_calls != null) msg.tool_calls = message.tool_calls;
    if (message.tool_call_id) msg.tool_call_id = message.tool_call_id;
    messages.push(msg);
  }
  let stop: string[] | undefined;
  if (typeof body.stop === "string") stop = [body.stop];
  else if (Array.isArray(body.stop)) stop = body.stop.filter((item): item is string => typeof item === "string");
  const out: Record<string, unknown> = {
    model: opts.upstreamModelName || String(body.model || ""),
    messages,
  };
  if (body.stream) out.stream = true;
  const topP = clampTopP(body);
  if (topP) out.top_p = topP;
  if (body.temperature != null && Number(body.temperature) !== 0) out.temperature = body.temperature;
  if (stop?.length) out.stop = stop;
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools;
  if (body.tool_choice != null) out.tool_choice = body.tool_choice;
  if (body.thinking != null) out.thinking = body.thinking;
  if ("max_tokens" in body || "max_completion_tokens" in body) {
    const maxTokens = getMaxTokens(body);
    if (maxTokens) out.max_tokens = maxTokens;
  }
  return out;
}

function usageFromZhipu(raw: Record<string, unknown>): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return {
    prompt_tokens: Number(raw.prompt_tokens || 0),
    completion_tokens: Number(raw.completion_tokens || 0),
    total_tokens: Number(raw.total_tokens || 0),
  };
}

/** Original `zhipu.responseZhipu2OpenAI`. `success` missing is Go false → error. */
export function openaiFromZhipuResponse(upstream: Record<string, unknown>, opts: { created?: number } = {}): Record<string, unknown> {
  if (upstream.success !== true) {
    throw new Error(String(upstream.msg || "zhipu error"));
  }
  const data = asObj(upstream.data);
  const src = Array.isArray(data.choices) ? (data.choices as { role?: string; content?: unknown }[]) : [];
  const choices = src.map((choice, i) => ({
    index: i,
    message: {
      role: choice.role,
      content: String(choice.content ?? "").replace(/^"+|"+$/g, ""),
    },
    finish_reason: i === src.length - 1 ? "stop" : "",
  }));
  return {
    id: String(data.task_id || ""),
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    choices,
    usage: usageFromZhipu(asObj(data.usage)),
  };
}

function parseZhipuStreamLines(text: string): { data: string[]; meta: Record<string, unknown> | null } {
  const data: string[] = [];
  let meta: Record<string, unknown> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length < 5) continue;
    if (raw.slice(0, 5) === "data:") data.push(raw.slice(5));
    else if (raw.slice(0, 5) === "meta:") {
      try {
        meta = JSON.parse(raw.slice(5)) as Record<string, unknown>;
      } catch {
        /* original logs and continues */
      }
    }
  }
  return { data, meta };
}

/** Original `zhipu.zhipuStreamHandler` / `zhipuHandler`. Stream model is `chatglm`; ends with `[DONE]`. */
export function zhipuUpstreamToOpenAIChat(
  text: string,
  opts: { created?: number } = {},
): { json: Record<string, unknown>; sse: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = openaiFromZhipuResponse(JSON.parse(trimmed) as Record<string, unknown>, opts);
      return { json, sse: sseFromZhipuJson(json) };
    } catch (err) {
      throw err;
    }
  }
  const parsed = parseZhipuStreamLines(text);
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  let sse = "";
  let content = "";
  for (const chunk of parsed.data) {
    content += chunk;
    sse += sseLine({
      object: "chat.completion.chunk",
      created,
      model: "chatglm",
      choices: [{ delta: { content: chunk } }],
    });
  }
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let id = "";
  if (parsed.meta) {
    id = String(parsed.meta.request_id || "");
    usage = usageFromZhipu(asObj(parsed.meta.usage));
    sse += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model: "chatglm",
      choices: [{ delta: { content: "" }, finish_reason: "stop" }],
    });
  }
  sse += "data: [DONE]\n\n";
  const json: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model: "chatglm",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  };
  return { json, sse };
}

function sseFromZhipuJson(json: Record<string, unknown>): string {
  const choice = asObj((json.choices as unknown[])?.[0]);
  const message = asObj(choice.message);
  const created = Number(json.created || Math.floor(Date.now() / 1000));
  const first = {
    object: "chat.completion.chunk",
    created,
    model: "chatglm",
    choices: [{ delta: { content: message.content ?? "" } }],
  };
  const done = {
    id: json.id,
    object: "chat.completion.chunk",
    created,
    model: "chatglm",
    choices: [{ delta: { content: "" }, finish_reason: "stop" }],
  };
  return sseLine(first) + sseLine(done) + "data: [DONE]\n\n";
}