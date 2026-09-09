import { parseJson } from "./constants.js";
import type { Store } from "./store.js";

export async function quotaRatios(
  store: Store,
  model: string,
  group: string,
): Promise<{ modelRatio: number; completionRatio: number; groupRatio: number }> {
  const modelRatio = parseJson<Record<string, number>>(await store.option("ModelRatio"), {});
  const completionRatio = parseJson<Record<string, number>>(await store.option("CompletionRatio"), {});
  const groupRatio = parseJson<Record<string, number>>(await store.option("GroupRatio"), { default: 1 });
  return {
    modelRatio: modelRatio[model] ?? 1,
    completionRatio: completionRatio[model] ?? 1,
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
