import { nowSec, parseJson, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_AZURE, CHANNEL_TYPE_OPENROUTER, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_TASK_PLUGIN } from "./constants.js";
import { defaultBaseUrl } from "./catalog.js";
import { apiFail, json } from "./http.js";
import type { Store } from "./store.js";
import type { ChannelRow } from "./types.js";

const CHANNEL_TYPE_CUSTOM = 8;
const CHANNEL_TYPE_AIPROXY = 10;
const CHANNEL_TYPE_API2GPT = 12;
const CHANNEL_TYPE_AIGC2D = 13;
const CHANNEL_TYPE_SILICONFLOW = 40;
const CHANNEL_TYPE_DEEPSEEK = 43;

export type ChannelBalanceResult = { balance: number } | { raw_response: string };

function isMultiKey(ch: ChannelRow): boolean {
  const info = parseJson<Record<string, unknown>>(String(ch.channel_info || ""), {});
  if (info.IsMultiKey === true || info.is_multi_key === true) return true;
  return String(ch.key || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean).length > 1;
}

function authHeader(key: string): HeadersInit {
  return { authorization: "Bearer " + String(key || "").split(/[\n,]/)[0].trim() };
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
  const startDate = hasPayment
    ? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`
    : new Date(now.getTime() - 100 * 86400000).toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  const usage = await getJson(`${base}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, key);
  if (!usage.ok) throw new Error(`status code: ${usage.status}`);
  return hard - Number(usage.json.total_usage || 0) / 100;
}

export async function queryChannelBalance(ch: ChannelRow): Promise<ChannelBalanceResult> {
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
    case CHANNEL_TYPE_DEEPSEEK: {
      const fetched = await getJson("https://api.deepseek.com/user/balance", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      const infos = ((fetched.json.balance_infos || []) as { currency?: string; total_balance?: string }[]);
      const cny = infos.find((i) => i.currency === "CNY") || infos[0];
      return { balance: Number(cny?.total_balance || 0) };
    }
    case CHANNEL_TYPE_MOONSHOT: {
      const fetched = await getJson("https://api.moonshot.cn/v1/users/me/balance", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      const data = (fetched.json.data || {}) as { available_balance?: number };
      return { balance: Number(data.available_balance || 0) };
    }
    case CHANNEL_TYPE_API2GPT: {
      const fetched = await getJson("https://api.api2gpt.com/dashboard/billing/credit_grants", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      return { balance: Number(fetched.json.total_available || 0) };
    }
    case CHANNEL_TYPE_AIGC2D: {
      const fetched = await getJson("https://api.aigc2d.com/dashboard/billing/credit_grants", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      return { balance: Number(fetched.json.total_available || 0) };
    }
    case CHANNEL_TYPE_AIPROXY: {
      const fetched = await getJson("https://aiproxy.io/api/user/info", key);
      if (!fetched.ok) throw new Error(`status code: ${fetched.status}`);
      const data = (fetched.json.data || {}) as { totalPoints?: number };
      return { balance: Number(data.totalPoints || 0) };
    }
    case CHANNEL_TYPE_OPENAI:
    case CHANNEL_TYPE_CUSTOM: {
      const base = customBase || defaultBaseUrl(ch.type) || "https://api.openai.com";
      return { balance: await openaiBillingBalance(base, key) };
    }
    default:
      throw new Error("尚未实现");
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
    const result = await queryChannelBalance(ch);
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
  for (const ch of channels) {
    if (isMultiKey(ch) || ch.type === CHANNEL_TYPE_TASK_PLUGIN) continue;
    try {
      const result = await queryChannelBalance(ch);
      if ("balance" in result) {
        await store.updateChannel(ch.id, { balance: result.balance, balance_updated_time: nowSec() });
      }
    } catch {
      continue;
    }
  }
  return json(200, { success: true, message: "" });
}
