/** Original `relay/channel/tencent` ConvertOpenAIRequest / GetRequestURL / SetupRequestHeader / DoResponse. */

import { bytesToHex, hmacSha256Raw, sha256Bytes } from "./crypto.js";
import { asInt, asObj, sseLine } from "./openai-usage.js";

export const TENCENT_DEFAULT_BASE = "https://hunyuan.tencentcloudapi.com";
export const TENCENT_TOKENHUB_BASE = "https://tokenhub.tencentmaas.com";

export type ConvertTencentOpts = {
  upstreamModelName?: string;
  created?: number;
  fallbackPromptTokens?: number;
};

function stripBearer(key: string): string {
  return String(key || "").replace(/^Bearer /i, "");
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

async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(await sha256Bytes(s));
}

function estimateCompletionTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Original `tencent.DispatchAdaptor`: three-segment `appId|secretId|secretKey` uses native TC3. */
export function tencentUsesNativeAdaptor(apiKey: string): boolean {
  return stripBearer(apiKey).includes("|");
}

/** Original `tencent.parseTencentConfig`. */
export function parseTencentConfig(config: string): { appId: number; secretId: string; secretKey: string } {
  const parts = stripBearer(config).split("|");
  if (parts.length !== 3) throw new Error("invalid tencent config");
  const appId = Number.parseInt(parts[0], 10);
  if (!/^-?\d+$/.test(parts[0]) || !Number.isFinite(appId)) {
    throw new Error(`strconv.ParseInt: parsing "${parts[0]}": invalid syntax`);
  }
  return { appId, secretId: parts[1], secretKey: parts[2] };
}

/** Original TokenHub rewrite when base is empty or the Hunyuan default. */
export function tencentTokenHubBase(channelBaseUrl: string): string {
  const raw = String(channelBaseUrl || "");
  if (raw === "" || raw.replace(/\/+$/, "") === TENCENT_DEFAULT_BASE) return TENCENT_TOKENHUB_BASE;
  return raw.replace(/\/+$/, "");
}

/** Original native `tencent.Adaptor.GetRequestURL`: `{base}/`. */
export function tencentNativeRequestURL(base: string): string {
  return `${String(base || "").replace(/\/+$/, "")}/`;
}

/** Original `tencent.requestOpenAI2Tencent` — PascalCase JSON tags. Stream false is included. */
export function convertTencentOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertTencentOpts = {},
): Record<string, unknown> {
  const src = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  const messages = src.map((message) => ({
    Role: String(message.role || ""),
    Content: stringContent(message.content),
  }));
  const out: Record<string, unknown> = {
    Model: opts.upstreamModelName || String(body.model || ""),
    Messages: messages,
  };
  if (typeof body.stream === "boolean") out.Stream = body.stream;
  if (body.top_p != null) out.TopP = body.top_p;
  if (body.temperature != null) out.Temperature = body.temperature;
  return out;
}

/** Original `tencent.getTencentSign`. Signs the exact JSON payload bytes. */
export async function getTencentSign(
  payload: string,
  secretId: string,
  secretKey: string,
  timestamp: number,
): Promise<string> {
  const host = "hunyuan.tencentcloudapi.com";
  const action = "ChatCompletions";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = await sha256Hex(payload);
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;
  const algorithm = "TC3-HMAC-SHA256";
  const requestTimestamp = String(timestamp);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/hunyuan/tc3_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const string2sign = `${algorithm}\n${requestTimestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;
  const secretDate = await hmacSha256Raw("TC3" + secretKey, date);
  const secretService = await hmacSha256Raw(secretDate, "hunyuan");
  const secretSigning = await hmacSha256Raw(secretService, "tc3_request");
  const signature = bytesToHex(await hmacSha256Raw(secretSigning, string2sign));
  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Original `tencent.Adaptor.SetupRequestHeader` after ConvertOpenAIRequest computed `a.Sign`. */
export async function applyTencentTc3Authorization(
  headers: Record<string, string>,
  body: unknown,
  apiKey: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { secretId, secretKey } = parseTencentConfig(apiKey);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  headers.authorization = await getTencentSign(payload, secretId, secretKey, timestamp);
  headers["X-TC-Action"] = "ChatCompletions";
  headers["X-TC-Version"] = "2023-09-01";
  headers["X-TC-Timestamp"] = String(timestamp);
  delete headers.Authorization;
  return payload;
}

function tencentUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    prompt_tokens: asInt(usage.PromptTokens ?? usage.prompt_tokens),
    completion_tokens: asInt(usage.CompletionTokens ?? usage.completion_tokens),
    total_tokens: asInt(usage.TotalTokens ?? usage.total_tokens),
  };
}

function tencentChatInner(upstream: Record<string, unknown>): Record<string, unknown> {
  const wrapped = asObj(upstream.Response);
  return Object.keys(wrapped).length ? wrapped : upstream;
}

/** Original `tencent.responseTencent2OpenAI` / `tencentHandler`. */
export function openaiFromTencentResponse(
  upstream: Record<string, unknown>,
  opts: ConvertTencentOpts = {},
): Record<string, unknown> {
  const inner = tencentChatInner(upstream);
  const err = asObj(inner.Error);
  if (asInt(err.Code ?? err.code) !== 0) {
    throw new Error(String(err.Message ?? err.message ?? ""));
  }
  const choicesSrc = Array.isArray(inner.Choices) ? (inner.Choices as Record<string, unknown>[]) : [];
  const choices = choicesSrc.length
    ? [
        {
          index: 0,
          message: {
            role: "assistant",
            content: String(asObj(asObj(choicesSrc[0]).Message).Content ?? ""),
          },
          finish_reason: String(choicesSrc[0].FinishReason ?? ""),
        },
      ]
    : [];
  return {
    id: String(inner.Id ?? ""),
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    choices,
    usage: tencentUsage(asObj(inner.Usage)),
  };
}

function streamChoice(tencent: Record<string, unknown>): Record<string, unknown> {
  const choicesSrc = Array.isArray(tencent.Choices) ? (tencent.Choices as Record<string, unknown>[]) : [];
  if (!choicesSrc.length) return { object: "chat.completion.chunk", created: 0, model: "tencent-hunyuan", choices: [] };
  const first = asObj(choicesSrc[0]);
  const choice: Record<string, unknown> = {
    delta: { content: String(asObj(first.Delta).Content ?? "") },
  };
  if (String(first.FinishReason ?? "") === "stop") choice.finish_reason = "stop";
  return {
    object: "chat.completion.chunk",
    created: 0,
    model: "tencent-hunyuan",
    choices: [choice],
  };
}

/** Original `tencent.tencentStreamHandler`. Stream model is `tencent-hunyuan`; ends with `[DONE]`. */
export function tencentUpstreamToOpenAIChat(
  text: string,
  opts: ConvertTencentOpts = {},
): { json: Record<string, unknown>; sse: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("data:")) {
    const json = openaiFromTencentResponse(JSON.parse(trimmed) as Record<string, unknown>, opts);
    return { json, sse: sseFromTencentJson(json) };
  }
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  let sse = "";
  let responseText = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line.length < 5 || !line.startsWith("data:")) continue;
    const data = line.slice("data:".length);
    let tencent: Record<string, unknown>;
    try {
      tencent = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const chunk = streamChoice(tencentChatInner(tencent));
    chunk.created = created;
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
    if (choices.length) responseText += String(asObj(choices[0].delta).content ?? "");
    sse += sseLine(chunk);
  }
  sse += "data: [DONE]\n\n";
  const prompt = opts.fallbackPromptTokens || 0;
  const completion = estimateCompletionTokens(responseText);
  const json: Record<string, unknown> = {
    object: "chat.completion",
    created,
    model: "tencent-hunyuan",
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
  return { json, sse };
}

function sseFromTencentJson(json: Record<string, unknown>): string {
  const choice = Array.isArray(json.choices) ? asObj((json.choices as Record<string, unknown>[])[0]) : {};
  return (
    sseLine({
      id: json.id,
      object: "chat.completion.chunk",
      created: json.created,
      model: "tencent-hunyuan",
      choices: [{ index: 0, delta: { content: asObj(choice.message).content ?? "" }, finish_reason: choice.finish_reason || "stop" }],
    }) + "data: [DONE]\n\n"
  );
}
