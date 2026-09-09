import { parseJson } from "./constants.js";
import type { Store } from "./store.js";

export async function computeQuota(
  store: Store,
  model: string,
  group: string,
  promptTokens: number,
  completionTokens: number,
): Promise<number> {
  const modelRatio = parseJson<Record<string, number>>(await store.option("ModelRatio"), {});
  const completionRatio = parseJson<Record<string, number>>(await store.option("CompletionRatio"), {});
  const groupRatio = parseJson<Record<string, number>>(await store.option("GroupRatio"), { default: 1 });
  const mr = modelRatio[model] ?? 1;
  const cr = completionRatio[model] ?? 1;
  const gr = groupRatio[group] ?? groupRatio.default ?? 1;
  const q = (promptTokens * mr + completionTokens * mr * cr) * gr;
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
