/** Original `relay/channel/baidu` ConvertOpenAIRequest / ConvertEmbeddingRequest / GetRequestURL / DoResponse. */

import { asObj, parseSseDataPayloads, sseLine } from "./openai-usage.js";

export type ConvertBaiduOpts = {
  upstreamModelName?: string;
  created?: number;
};

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

function parseInput(input: unknown): string[] {
  if (input == null) return [];
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/** Original `baidu.requestOpenAI2Baidu`. */
export function convertBaiduOpenAIRequest(body: Record<string, unknown>, _opts: ConvertBaiduOpts = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    messages: [] as { role: string; content: string }[],
  };
  if (body.temperature != null) out.temperature = body.temperature;
  const topP = Number(body.top_p ?? 0);
  if (topP) out.top_p = body.top_p;
  const penalty = Number(body.frequency_penalty ?? 0);
  if (penalty) out.penalty_score = body.frequency_penalty;
  if (body.stream) out.stream = true;
  if (body.user != null && body.user !== "") out.user_id = body.user;
  let maxTokens = getMaxTokens(body);
  if (maxTokens !== 0) {
    if (maxTokens === 1) maxTokens = 2;
    out.max_output_tokens = maxTokens;
  }
  const messages: { role: string; content: string }[] = [];
  const src = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (const message of src) {
    if (message.role === "system") {
      out.system = stringContent(message.content);
    } else {
      messages.push({
        role: String(message.role || "user"),
        content: stringContent(message.content),
      });
    }
  }
  out.messages = messages;
  return out;
}

/** Original `baidu.embeddingRequestOpenAI2Baidu`. */
export function convertBaiduEmbeddingRequest(body: Record<string, unknown>): Record<string, unknown> {
  return { input: parseInput(body.input) };
}

/** Original `baidu.Adaptor.GetRequestURL` path after `{base}/rpc/2.0/ai_custom/v1/wenxinworkshop/`. */
export function baiduWorkshopSuffix(upstreamModelName: string): string {
  let suffix = "chat/";
  if (upstreamModelName.startsWith("Embedding")) suffix = "embeddings/";
  if (upstreamModelName.startsWith("bge-large")) suffix = "embeddings/";
  if (upstreamModelName.startsWith("tao-8k")) suffix = "embeddings/";
  switch (upstreamModelName) {
    case "ERNIE-4.0":
    case "ERNIE-Bot-4":
    case "ERNIE-4.0-8K":
      suffix += "completions_pro";
      break;
    case "ERNIE-Bot":
    case "ERNIE-3.5-8K":
      suffix += "completions";
      break;
    case "ERNIE-Bot-turbo":
    case "ERNIE-Lite-8K-0922":
      suffix += "eb-instant";
      break;
    case "ERNIE-Speed":
    case "ERNIE-Speed-8K":
      suffix += "ernie_speed";
      break;
    case "ERNIE-3.5-8K-0205":
      suffix += "ernie-3.5-8k-0205";
      break;
    case "ERNIE-3.5-8K-1222":
      suffix += "ernie-3.5-8k-1222";
      break;
    case "ERNIE-Bot-8K":
      suffix += "ernie_bot_8k";
      break;
    case "ERNIE-3.5-4K-0205":
      suffix += "ernie-3.5-4k-0205";
      break;
    case "ERNIE-Speed-128K":
      suffix += "ernie-speed-128k";
      break;
    case "ERNIE-Lite-8K-0308":
      suffix += "ernie-lite-8k";
      break;
    case "ERNIE-Tiny-8K":
      suffix += "ernie-tiny-8k";
      break;
    case "BLOOMZ-7B":
      suffix += "bloomz_7b1";
      break;
    case "Embedding-V1":
      suffix += "embedding-v1";
      break;
    case "bge-large-zh":
      suffix += "bge_large_zh";
      break;
    case "bge-large-en":
      suffix += "bge_large_en";
      break;
    case "tao-8k":
      suffix += "tao_8k";
      break;
    default:
      suffix += upstreamModelName.toLowerCase();
  }
  return suffix;
}

/** Original GetRequestURL without `?access_token=` (token is appended after AK/SK mint). */
export function baiduWorkshopURL(base: string, upstreamModelName: string): string {
  const b = base.replace(/\/+$/, "");
  return `${b}/rpc/2.0/ai_custom/v1/wenxinworkshop/${baiduWorkshopSuffix(upstreamModelName)}`;
}

type BaiduTokenCache = { accessToken: string; expiresAt: number };
const baiduTokenStore = new Map<string, BaiduTokenCache>();

/** Test helper. */
export function clearBaiduAccessTokenCache(): void {
  baiduTokenStore.clear();
}

/** Original `baidu.getBaiduAccessToken` (AK|SK → oauth token). */
export async function getBaiduAccessToken(apiKey: string): Promise<string> {
  const cached = baiduTokenStore.get(apiKey);
  if (cached) {
    if (Date.now() + 60 * 60 * 1000 > cached.expiresAt) {
      void getBaiduAccessTokenHelper(apiKey).catch(() => undefined);
    }
    return cached.accessToken;
  }
  const token = await getBaiduAccessTokenHelper(apiKey);
  return token.accessToken;
}

async function getBaiduAccessTokenHelper(apiKey: string): Promise<BaiduTokenCache> {
  const parts = apiKey.split("|");
  if (parts.length !== 2) throw new Error("invalid baidu apikey");
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${parts[0]}&client_secret=${parts[1]}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (body.error) throw new Error(`${String(body.error)}: ${String(body.error_description || "")}`);
  const accessToken = String(body.access_token || "");
  if (!accessToken) throw new Error("getBaiduAccessTokenHelper get empty access token");
  const expiresIn = Number(body.expires_in || 0);
  const cached: BaiduTokenCache = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  baiduTokenStore.set(apiKey, cached);
  return cached;
}

/** Original GetRequestURL query append (`?access_token=` + token, not URL-escaped). */
export async function applyBaiduAccessToken(url: string, apiKey: string): Promise<string> {
  const token = await getBaiduAccessToken(apiKey);
  if (url.includes("access_token=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}access_token=${token}`;
}

function usageFromBaidu(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    prompt_tokens: Number(raw.prompt_tokens || 0),
    completion_tokens: Number(raw.completion_tokens || 0),
    total_tokens: Number(raw.total_tokens || 0),
  };
}

/** Original `baidu.responseBaidu2OpenAI`. */
export function openaiFromBaiduResponse(upstream: Record<string, unknown>, opts: { created?: number } = {}): Record<string, unknown> {
  if (upstream.error_msg) throw new Error(String(upstream.error_msg));
  return {
    id: String(upstream.id || ""),
    object: "chat.completion",
    created: Number(upstream.created || opts.created || Math.floor(Date.now() / 1000)),
    model: "",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: upstream.result ?? "" },
        finish_reason: "stop",
      },
    ],
    usage: usageFromBaidu(asObj(upstream.usage)),
  };
}

/** Original `baidu.embeddingResponseBaidu2OpenAI`. */
export function openaiFromBaiduEmbedding(upstream: Record<string, unknown>): Record<string, unknown> {
  if (upstream.error_msg) throw new Error(String(upstream.error_msg));
  const data = Array.isArray(upstream.data) ? (upstream.data as Record<string, unknown>[]) : [];
  return {
    object: "list",
    data: data.map((item) => ({
      object: item.object,
      index: item.index,
      embedding: item.embedding,
    })),
    model: "baidu-embedding",
    usage: usageFromBaidu(asObj(upstream.usage)),
  };
}

/** Original `baidu.baiduStreamHandler`. Stream chunks use model `ernie-bot`; no trailing `[DONE]`. */
export function baiduUpstreamToOpenAIChat(
  text: string,
  opts: { created?: number } = {},
): { json: Record<string, unknown>; sse: string } {
  const payloads = parseBaiduStream(text);
  if (payloads.length === 1 && payloads[0].result != null && payloads[0].is_end == null && !payloads[0].sentence_id) {
    const json = openaiFromBaiduResponse(payloads[0], opts);
    return { json, sse: sseFromBaiduJson(json) };
  }
  let sse = "";
  let result = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let id = "";
  let created = opts.created ?? Math.floor(Date.now() / 1000);
  for (const baidu of payloads) {
    if (asObj(baidu.usage).total_tokens) {
      const total = Number(asObj(baidu.usage).total_tokens || 0);
      const prompt = Number(asObj(baidu.usage).prompt_tokens || 0);
      usage = { prompt_tokens: prompt, completion_tokens: total - prompt, total_tokens: total };
    }
    if (baidu.id) id = String(baidu.id);
    if (baidu.created != null) created = Number(baidu.created);
    result += String(baidu.result || "");
    const choice: Record<string, unknown> = {
      delta: { content: baidu.result ?? "" },
    };
    if (baidu.is_end) choice.finish_reason = "stop";
    sse += sseLine({
      id: String(baidu.id || id),
      object: "chat.completion.chunk",
      created: Number(baidu.created || created),
      model: "ernie-bot",
      choices: [choice],
    });
  }
  const json: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model: "",
    choices: [{ index: 0, message: { role: "assistant", content: result }, finish_reason: "stop" }],
    usage,
  };
  return { json, sse };
}

function parseBaiduStream(text: string): Record<string, unknown>[] {
  const payloads = parseSseDataPayloads(text);
  if (payloads.length) {
    return payloads.map((p) => {
      try {
        return JSON.parse(p) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  }
  try {
    return [JSON.parse(text) as Record<string, unknown>];
  } catch {
    return [];
  }
}

function sseFromBaiduJson(json: Record<string, unknown>): string {
  const choice = Array.isArray(json.choices) ? asObj(json.choices[0]) : {};
  const message = asObj(choice.message);
  return sseLine({
    id: String(json.id || ""),
    object: "chat.completion.chunk",
    created: Number(json.created || 0),
    model: "ernie-bot",
    choices: [{ delta: { content: message.content ?? "" }, finish_reason: "stop" }],
  });
}
