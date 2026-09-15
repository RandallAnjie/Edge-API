import { DEFAULT_GROUP_RATIO, parseJson } from "./constants.js";
import { getCompletionRatio, getModelRatioFromMap } from "./ratio-setting.js";
import type { Store } from "./store.js";

export async function quotaRatios(
  store: Store,
  model: string,
  group: string,
): Promise<{ modelRatio: number; completionRatio: number; groupRatio: number }> {
  const modelRatio = parseJson<Record<string, number>>(await store.option("ModelRatio"), {});
  const completionRatio = parseJson<Record<string, number>>(await store.option("CompletionRatio"), {});
  const groupRatio = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  return {
    modelRatio: getModelRatioFromMap(model, modelRatio).ratio,
    completionRatio: getCompletionRatio(model, completionRatio),
    groupRatio: groupRatio[group] ?? groupRatio.default ?? 1,
  };
}

export async function computeQuota(
  store: Store,
  model: string,
  group: string,
  promptTokens: number,
  completionTokens: number,
): Promise<number> {
  const { modelRatio, completionRatio, groupRatio } = await quotaRatios(store, model, group);
  const q = (promptTokens * modelRatio + completionTokens * modelRatio * completionRatio) * groupRatio;
  const n = Math.ceil(q);
  return n < 1 && promptTokens + completionTokens > 0 ? 1 : n;
}

export function remainingOk(userQuota: number, tokenRemain: number, unlimited: boolean, need: number): string | null {
  if (userQuota < need) return "用户额度不足";
  if (!unlimited && tokenRemain < need) return "令牌额度不足";
  return null;
}

export function formatQuota(quota: number, quotaPerUnit: number, displayCurrency: boolean): string {
  if (!displayCurrency) return String(quota);
  const usd = quota / (quotaPerUnit || 500000);
  return `$${usd.toFixed(4)}`;
}

/** Original `logger.FormatQuota` (USD / TOKENS / CNY / custom). */
export function formatQuotaOriginal(
  quota: number,
  quotaPerUnit: number,
  displayType = "USD",
  usdRate = 1,
  customSymbol = "¤",
  customRate = 1,
): string {
  const unit = quotaPerUnit || 500000;
  const usd = quota / unit;
  const type = String(displayType || "USD").toUpperCase();
  if (type === "TOKENS") return String(quota);
  if (type === "CNY") return `¥${(usd * (usdRate || 1)).toFixed(6)}`;
  if (type === "CUSTOM") {
    const rate = customRate > 0 ? customRate : 1;
    const symbol = customSymbol || "¤";
    return `${symbol}${(usd * rate).toFixed(6)}`;
  }
  return `＄${usd.toFixed(6)}`;
}

/** Original `logger.LogQuota` (FormatQuota plus ` 额度` / ` 点额度`). */
export function logQuota(
  quota: number,
  quotaPerUnit: number,
  displayType = "USD",
  usdRate = 1,
  customSymbol = "¤",
  customRate = 1,
): string {
  const type = String(displayType || "USD").toUpperCase();
  if (type === "TOKENS") return `${quota} 点额度`;
  return `${formatQuotaOriginal(quota, quotaPerUnit, displayType, usdRate, customSymbol, customRate)} 额度`;
}

async function quotaDisplayOptions(store: Store): Promise<{
  unit: number;
  display: string;
  usdRate: number;
  customSymbol: string;
  customRate: number;
}> {
  return {
    unit: (await store.optionNum("QuotaPerUnit", 500000)) || 500000,
    display:
      (await store.option("general_setting.quota_display_type")) || (await store.option("QuotaDisplayType")) || "USD",
    usdRate: (await store.optionNum("USDExchangeRate", 1)) || 1,
    customSymbol: (await store.option("general_setting.custom_currency_symbol")) || "¤",
    customRate: Number(await store.option("general_setting.custom_currency_exchange_rate")) || 1,
  };
}

/** Original `logger.FormatQuota` using persisted general_setting / QuotaPerUnit options. */
export async function storeFormatQuota(store: Store, quota: number): Promise<string> {
  const o = await quotaDisplayOptions(store);
  return formatQuotaOriginal(quota, o.unit, o.display, o.usdRate, o.customSymbol, o.customRate);
}

/** Original `logger.LogQuota` using persisted general_setting / QuotaPerUnit options. */
export async function storeLogQuota(store: Store, quota: number): Promise<string> {
  const o = await quotaDisplayOptions(store);
  return logQuota(quota, o.unit, o.display, o.usdRate, o.customSymbol, o.customRate);
}

/** Original `NewBillingSession` wallet insufficient messages. */
export function insufficientWalletQuotaMessage(remain: number, need: number, formattedRemain: string, formattedNeed: string): string {
  if (remain <= 0) return `用户额度不足, 剩余额度: ${formattedRemain}`;
  return `预扣费额度失败, 用户剩余额度: ${formattedRemain}, 需要预扣费额度: ${formattedNeed}`;
}

/** Original `PreConsumeTokenQuota` insufficient message. */
export function insufficientTokenQuotaMessage(formattedRemain: string, formattedNeed: string): string {
  return `token quota is not enough, token remain quota: ${formattedRemain}, need quota: ${formattedNeed}`;
}

/** Original `service.PreWssConsumeQuota` user insufficient message. */
export function insufficientWssUserQuotaMessage(formattedRemain: string, formattedNeed: string): string {
  return `user quota is not enough, user quota: ${formattedRemain}, need quota: ${formattedNeed}`;
}
