import {
  nowSec,
  parseJson,
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_AZURE,
  CHANNEL_TYPE_OPENROUTER,
  CHANNEL_TYPE_MOONSHOT,
  CHANNEL_TYPE_TASK_PLUGIN,
} from "./constants.js";
import { defaultBaseUrl } from "./catalog.js";
import { buildAdvancedCustomBalanceRequest, goJSONSyntaxError } from "./channel-validate.js";
import { apiFail, json } from "./http.js";
import { applyFetchModelsHeaderOverrides } from "./upstream.js";
import type { Store } from "./store.js";
import type { ChannelRow } from "./types.js";

const CHANNEL_TYPE_CUSTOM = 8;
const CHANNEL_TYPE_AIPROXY = 10;
const CHANNEL_TYPE_API2GPT = 12;
const CHANNEL_TYPE_AIGC2D = 13;
const CHANNEL_TYPE_SILICONFLOW = 40;
const CHANNEL_TYPE_DEEPSEEK = 43;

export type ChannelBalanceResult = { balance: number } | { raw_response: string };

/** Original `controller.maxAdvancedCustomBalanceResponseBytes`. */
const MAX_ADVANCED_CUSTOM_BALANCE_RESPONSE_BYTES = 256 << 10;

function isMultiKey(ch: ChannelRow): boolean {
  const info = parseJson<Record<string, unknown>>(String(ch.channel_info || ""), {});
  if (info.IsMultiKey === true || info.is_multi_key === true) return true;
  return String(ch.key || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean).length > 1;
}

function authHeader(key: string): HeadersInit {
  return { authorization: "Bearer " + String(key || "").split(/[\n,]/)[0].trim() };
}

/** Original `controller.GetAuthHeader`. */
function getAuthHeader(token: string): HeadersInit {
  return { Authorization: "Bearer " + String(token || "") };
}

/** Original `controller.GetResponseBody` (status must be exactly 200). */
async function getResponseBody(url: string, headers: HeadersInit): Promise<string> {
  const res = await fetch(url, { method: "GET", headers });
  if (res.status !== 200) throw new Error(`status code: ${res.status}`);
  return res.text();
}

function unmarshalJSON<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(goJSONSyntaxError(raw, err));
  }
}

/** Original `strconv.ParseFloat(s, 64)`. */
function parseFloat64(s: string): number {
  const t = String(s);
  if (!t.trim() || Number.isNaN(Number(t))) {
    throw new Error(`strconv.ParseFloat: parsing ${JSON.stringify(t)}: invalid syntax`);
  }
  const n = Number(t);
  if (!Number.isFinite(n)) {
    throw new Error(`strconv.ParseFloat: parsing ${JSON.stringify(t)}: invalid syntax`);
  }
  return n;
}

async function getJson(url: string, key: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; raw: string }> {
  const res = await fetch(url, { headers: authHeader(key) });
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return { ok: res.ok, status: res.status, json: parsed, raw };
}

async function openaiBillingBalance(baseURL: string, key: string): Promise<number> {
  const base = baseURL.replace(/\/+$/, "");
  const sub = await getJson(`${base}/v1/dashboard/billing/subscription`, key);
  if (!sub.ok) throw new Error(`status code: ${sub.status}`);
  const hard = Number(sub.json.hard_limit_usd || 0);
  const hasPayment = Boolean(sub.json.has_payment_method);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startDate = hasPayment
    ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
    : ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 100));
  const endDate = ymd(now);
  const usage = await getJson(`${base}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, key);
  if (!usage.ok) throw new Error(`status code: ${usage.status}`);
  return hard - Number(usage.json.total_usage || 0) / 100;
}

/** Original `controller.updateChannelAIProxyBalance`. */
async function updateChannelAIProxyBalance(key: string): Promise<number> {
  const raw = await getResponseBody("https://aiproxy.io/api/report/getUserOverview", { "Api-Key": key });
  const response = unmarshalJSON<{
    success?: boolean;
    message?: string;
    error_code?: number;
    data?: { totalPoints?: number };
  }>(raw);
  if (!response.success) {
    throw new Error(`code: ${Number(response.error_code || 0)}, message: ${response.message || ""}`);
  }
  return Number(response.data?.totalPoints || 0);
}

/** Original `controller.updateChannelAPI2GPTBalance`. */
async function updateChannelAPI2GPTBalance(key: string): Promise<number> {
  const raw = await getResponseBody("https://api.api2gpt.com/dashboard/billing/credit_grants", getAuthHeader(key));
  const response = unmarshalJSON<{ total_remaining?: number }>(raw);
  return Number(response.total_remaining || 0);
}

/** Original `controller.updateChannelDeepSeekBalance`. */
async function updateChannelDeepSeekBalance(key: string): Promise<number> {
  const raw = await getResponseBody("https://api.deepseek.com/user/balance", getAuthHeader(key));
  const response = unmarshalJSON<{
    balance_infos?: { currency?: string; total_balance?: string }[];
  }>(raw);
  const infos = response.balance_infos || [];
  const index = infos.findIndex((info) => info.currency === "CNY");
  if (index === -1) throw new Error("currency CNY not found");
  return parseFloat64(String(infos[index].total_balance ?? ""));
}

/** Original `controller.updateChannelMoonshotBalance` (CNY → USD via `operation_setting.Price`). */
async function updateChannelMoonshotBalance(key: string, price: number): Promise<number> {
  const raw = await getResponseBody("https://api.moonshot.cn/v1/users/me/balance", getAuthHeader(key));
  const response = unmarshalJSON<{
    code?: number;
    data?: { available_balance?: number };
    scode?: string;
    status?: boolean;
  }>(raw);
  if (!response.status || Number(response.code || 0) !== 0) {
    throw new Error(
      `failed to update moonshot balance, status: ${Boolean(response.status)}, code: ${Number(response.code || 0)}, scode: ${response.scode || ""}`,
    );
  }
  return Number(response.data?.available_balance || 0) / price;
}

export async function queryChannelBalance(ch: ChannelRow, opts?: { price?: number }): Promise<ChannelBalanceResult> {
  if (ch.type === CHANNEL_TYPE_TASK_PLUGIN) {
    throw new Error("Task Plugin channels do not support balance queries");
  }
  if (isMultiKey(ch)) {
    throw new Error("多密钥渠道不支持余额查询");
  }
  const key = ch.key;
  const customBase = String(ch.base_url || "").replace(/\/+$/, "");
  switch (ch.type) {
    case CHANNEL_TYPE_AZURE:
      throw new Error("尚未实现");
    case CHANNEL_TYPE_OPENROUTER: {
      const fetched = await getJson("https://openrouter.ai/api/v1/credits", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      const data = (fetched.json.data || {}) as { total_credits?: number; total_usage?: number };
      return { balance: Number(data.total_credits || 0) - Number(data.total_usage || 0) };
    }
    case CHANNEL_TYPE_SILICONFLOW: {
      const fetched = await getJson("https://api.siliconflow.cn/v1/user/info", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      if (Number(fetched.json.code) !== 20000) {
        throw new Error(`code: ${fetched.json.code}, message: ${fetched.json.message || ""}`);
      }
      const data = (fetched.json.data || {}) as { totalBalance?: string };
      return { balance: Number(data.totalBalance || 0) };
    }
    case CHANNEL_TYPE_DEEPSEEK:
      return { balance: await updateChannelDeepSeekBalance(key) };
    case CHANNEL_TYPE_MOONSHOT:
      return { balance: await updateChannelMoonshotBalance(key, opts?.price ?? 7.3) };
    case CHANNEL_TYPE_API2GPT:
      return { balance: await updateChannelAPI2GPTBalance(key) };
    case CHANNEL_TYPE_AIGC2D: {
      const fetched = await getJson("https://api.aigc2d.com/dashboard/billing/credit_grants", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      return { balance: Number(fetched.json.total_available || 0) };
    }
    case CHANNEL_TYPE_AIPROXY:
      return { balance: await updateChannelAIProxyBalance(key) };
    case CHANNEL_TYPE_OPENAI:
    case CHANNEL_TYPE_CUSTOM: {
      const base = customBase || defaultBaseUrl(ch.type) || "https://api.openai.com";
      return { balance: await openaiBillingBalance(base, key) };
    }
    case CHANNEL_TYPE_ADVANCED_CUSTOM:
      return fetchAdvancedCustomBalance(ch);
    default:
      throw new Error("尚未实现");
  }
}

/** Original `controller.sanitizeFetchModelsError`. */
function sanitizeFetchModelsError(err: unknown, key: string): Error {
  let message = err instanceof Error ? err.message : String(err);
  const trimmed = String(key || "").trim();
  if (trimmed) {
    message = message.split(trimmed).join("[REDACTED]");
    message = message.split(encodeURIComponent(trimmed)).join("[REDACTED]");
  }
  return new Error(message);
}

/** Original `controller.sanitizeAdvancedCustomRequestError`. */
function sanitizeAdvancedCustomRequestError(err: unknown, key: string, requestURL: string): Error {
  let message = sanitizeFetchModelsError(err, key).message;
  try {
    const parsed = new URL(requestURL);
    parsed.searchParams.forEach((secret) => {
      if (!secret) return;
      message = message.split(secret).join("[REDACTED]");
      message = message.split(encodeURIComponent(secret)).join("[REDACTED]");
    });
  } catch {
    /* original returns the already-sanitized error when the URL cannot be parsed */
  }
  const trimmed = String(key || "").trim();
  if (trimmed) {
    message = message.split(trimmed).join("[REDACTED]");
    message = message.split(encodeURIComponent(trimmed)).join("[REDACTED]");
  }
  return new Error(message);
}

/** Original `common.GetJsonType`. */
function goGetJsonType(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) return "unknown";
  switch (trimmed[0]) {
    case "{":
      return "object";
    case "[":
      return "array";
    case '"':
      return "string";
    case "t":
    case "f":
      return "boolean";
    case "n":
      return "null";
    default:
      return "number";
  }
}

/** Original `encoding/json.Indent` with prefix "" and indent "  " / `common.IndentJson`. */
function goIndentJson(src: string): string {
  let i = 0;
  let depth = 0;
  let out = "";
  const n = src.length;
  const skipSpace = () => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i += 1;
      else break;
    }
  };
  skipSpace();
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const c = src[i];
    if (c === '"') {
      out += c;
      i += 1;
      while (i < n) {
        const ch = src[i];
        out += ch;
        i += 1;
        if (ch === "\\") {
          if (i < n) {
            out += src[i];
            i += 1;
          }
        } else if (ch === '"') {
          break;
        }
      }
      continue;
    }
    if (c === "{" || c === "[") {
      out += c;
      i += 1;
      skipSpace();
      if (i < n && ((c === "{" && src[i] === "}") || (c === "[" && src[i] === "]"))) {
        out += src[i];
        i += 1;
        continue;
      }
      depth += 1;
      out += "\n" + "  ".repeat(depth);
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      out += "\n" + "  ".repeat(Math.max(0, depth)) + c;
      i += 1;
      continue;
    }
    if (c === ",") {
      out += ",\n" + "  ".repeat(depth);
      i += 1;
      continue;
    }
    if (c === ":") {
      out += ": ";
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function jsonFieldRaw(objectSrc: string, field: string): string | null {
  try {
    const parsed = JSON.parse(objectSrc) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) return null;
    return JSON.stringify(parsed[field]);
  } catch {
    return null;
  }
}

/** Original `controller.fetchAdvancedCustomBalance`. */
async function fetchAdvancedCustomBalance(ch: ChannelRow): Promise<ChannelBalanceResult> {
  const key = String(ch.key || "").trim();
  let target: { url: string; headers: Record<string, string> };
  try {
    target = buildAdvancedCustomBalanceRequest(ch);
    applyFetchModelsHeaderOverrides(ch, key, target.headers);
  } catch (e) {
    throw sanitizeFetchModelsError(e, key);
  }

  let res: Response;
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(target.headers)) {
      if (name.toLowerCase() === "host") continue;
      headers.set(name, value);
    }
    res = await fetch(target.url, { method: "GET", headers });
  } catch (e) {
    throw sanitizeAdvancedCustomRequestError(e, key, target.url);
  }
  if (res.status !== 200) throw new Error(`status code: ${res.status}`);

  let body: Uint8Array;
  try {
    body = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw sanitizeAdvancedCustomRequestError(e, key, target.url);
  }
  if (body.byteLength > MAX_ADVANCED_CUSTOM_BALANCE_RESPONSE_BYTES) {
    throw new Error(`balance response exceeds ${MAX_ADVANCED_CUSTOM_BALANCE_RESPONSE_BYTES} bytes`);
  }
  const raw = new TextDecoder().decode(body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`invalid balance JSON response: ${goJSONSyntaxError(raw, err)}`);
  }
  if (goGetJsonType(raw) === "object" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const totalRaw = jsonFieldRaw(raw, "total_available");
    if (obj.object === "credit_summary" && totalRaw != null && goGetJsonType(totalRaw) === "number") {
      const balance = Number(obj.total_available);
      if (Number.isFinite(balance) && balance >= 0) return { balance };
    }
  }

  try {
    return { raw_response: goIndentJson(raw) };
  } catch (err) {
    throw new Error(`invalid balance JSON response: ${goJSONSyntaxError(raw, err)}`);
  }
}

export function channelBalanceResponse(result: ChannelBalanceResult): Response {
  const body: Record<string, unknown> = { success: true, message: "" };
  if ("raw_response" in result) body.raw_response = result.raw_response;
  else body.balance = result.balance;
  return json(200, body);
}

export async function updateOneChannelBalance(store: Store, ch: ChannelRow): Promise<Response> {
  try {
    const result = await queryChannelBalance(ch, { price: await store.optionNum("Price", 7.3) });
    if ("balance" in result) {
      await store.updateChannel(ch.id, { balance: result.balance, balance_updated_time: nowSec() });
    }
    return channelBalanceResponse(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "Task Plugin channels do not support balance queries" || message === "多密钥渠道不支持余额查询") {
      return json(200, { success: false, message });
    }
    return apiFail(message);
  }
}

export async function updateAllChannelBalances(store: Store): Promise<Response> {
  const channels = await store.enabledChannels();
  const price = await store.optionNum("Price", 7.3);
  for (const ch of channels) {
    if (isMultiKey(ch) || ch.type === CHANNEL_TYPE_TASK_PLUGIN) continue;
    try {
      const result = await queryChannelBalance(ch, { price });
      if ("balance" in result) {
        await store.updateChannel(ch.id, { balance: result.balance, balance_updated_time: nowSec() });
      }
    } catch {
      continue;
    }
  }
  return json(200, { success: true, message: "" });
}
