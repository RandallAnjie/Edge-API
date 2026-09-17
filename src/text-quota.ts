/**
 * Original `service.calculateTextQuotaSummary` / `PostTextConsumeQuota` ratio-path
 * billing on workerd. Must not import relay / convert / query / submit.
 */
import { CHANNEL_TYPE_OPENROUTER } from "./constants.js";
import { defaultModelRatio } from "./ratio-defaults.js";
import { textConsumePriceData, type TextConsumePriceData } from "./quota.js";
import type { Store } from "./store.js";
import { applyOtherRatiosToDecimal, quotaFromDecimal, quotaFromDecimalChecked, quotaRoundChecked, type QuotaClamp } from "./task-plugin-usage.js";
import { cacheCreationTokensTotal, type BillingUsage } from "./tiered-settle.js";
import type { BillingSnapshot, TieredResult } from "./billing-expr.js";
import {
  BUILD_IN_TOOL_GOOGLE_SEARCH,
  BUILD_IN_TOOL_WEB_SEARCH,
  BUILD_IN_TOOL_WEB_SEARCH_PREVIEW,
  decodeToolPricesJSON,
  geminiInputAudioPricePerMillion,
  getToolPriceForModel,
  TOOL_PRICE_OPTION_KEY,
} from "./tool-price.js";

export type ToolSurchargeItem = {
  name: string;
  count: number;
  price: number;
};

export type TextQuotaUsage = BillingUsage & {
  cost?: number;
  usage_source?: string;
};

export type TextQuotaSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheTokens: number;
  cacheCreationTokens: number;
  cacheCreationTokens5m: number;
  cacheCreationTokens1h: number;
  imageTokens: number;
  audioTokens: number;
  quota: number;
  clamp: QuotaClamp | null;
  isClaudeUsageSemantic: boolean;
  usageSemantic: string;
  audioInputPrice: number;
  toolSurchargeItems: ToolSurchargeItem[];
  toolCallSurchargeQuota: number;
};

export type CalculateTextQuotaOpts = {
  model: string;
  price: TextConsumePriceData;
  usage: TextQuotaUsage | null | undefined;
  quotaPerUnit?: number;
  channelType?: number;
  finalRequestFormat?: string;
  relayMode?: string;
  builtInTools?: Record<string, number>;
  claudeWebSearchRequests?: number;
  geminiGoogleSearchCall?: boolean;
  otherRatios?: Record<string, number>;
  toolPrices?: Record<string, number> | null;
  /** Original `RelayInfo.UpdateImageCount` `n` overlay when UsePrice. */
  imageCount?: number;
};

function asInt(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Original `service.usageSemanticFromUsage`. */
export function usageSemanticFromUsage(
  usage: TextQuotaUsage | null | undefined,
  finalRequestFormat?: string,
): string {
  if (usage?.usage_semantic) return usage.usage_semantic;
  if (finalRequestFormat === "claude") return "anthropic";
  return "openai";
}

/** Original `service.isLegacyClaudeDerivedOpenAIUsage`. */
export function isLegacyClaudeDerivedOpenAIUsage(
  usage: TextQuotaUsage | null | undefined,
  finalRequestFormat?: string,
): boolean {
  if (!usage) return false;
  if (finalRequestFormat === "claude") return false;
  if (usage.usage_source || usage.usage_semantic) return false;
  return asInt(usage.claude_cache_creation_5_m_tokens) > 0 || asInt(usage.claude_cache_creation_1_h_tokens) > 0;
}

/** Original `service.hasCustomModelRatio`. */
export function hasCustomModelRatio(modelName: string, currentRatio: number): boolean {
  if (!Object.prototype.hasOwnProperty.call(defaultModelRatio, modelName)) return true;
  return currentRatio !== defaultModelRatio[modelName];
}

/** Original `service.CalcOpenRouterCacheCreateTokens`. */
export function calcOpenRouterCacheCreateTokens(
  usage: TextQuotaUsage,
  price: TextConsumePriceData,
  quotaPerUnit: number,
): number {
  if (price.cacheCreationRatio === 1) return 0;
  const quotaPrice = price.modelRatio / quotaPerUnit;
  const promptCacheCreatePrice = quotaPrice * price.cacheCreationRatio;
  const promptCacheReadPrice = quotaPrice * price.cacheRatio;
  const completionPrice = quotaPrice * price.completionRatio;
  const cost = Number(usage.cost || 0);
  const value =
    (cost -
      usage.prompt_tokens * quotaPrice +
      asInt(usage.prompt_tokens_details?.cached_tokens) * (quotaPrice - promptCacheReadPrice) -
      usage.completion_tokens * completionPrice) /
    (promptCacheCreatePrice - quotaPrice);
  const rounded = quotaRoundChecked(value);
  if (rounded.clamp) return -1;
  return rounded.quota;
}

function collectToolSurchargeItem(
  items: ToolSurchargeItem[],
  name: string,
  count: number,
  modelName: string,
  toolPrices: Record<string, number> | null | undefined,
): ToolSurchargeItem[] {
  if (count <= 0) return items;
  const price = getToolPriceForModel(name, modelName, toolPrices);
  if (price <= 0 || Number.isNaN(price) || !Number.isFinite(price)) return items;
  items.push({ name, count, price });
  return items;
}

/** Original `service.mergeToolSurchargeItems`. */
export function mergeToolSurchargeItems(items: ToolSurchargeItem[]): ToolSurchargeItem[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => {
    if (a.name === b.name) return a.price < b.price ? -1 : a.price > b.price ? 1 : 0;
    return a.name < b.name ? -1 : 1;
  });
  const merged: ToolSurchargeItem[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.name === item.name && last.price === item.price) {
      const next = last.count + item.count;
      last.count = next > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : next;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

/** Original `service.calculateTextToolCallSurcharge`. */
export function calculateTextToolCallSurcharge(opts: {
  model: string;
  groupRatio: number;
  quotaPerUnit: number;
  relayMode?: string;
  builtInTools?: Record<string, number>;
  claudeWebSearchRequests?: number;
  geminiGoogleSearchCall?: boolean;
  toolPrices?: Record<string, number> | null;
}): { items: ToolSurchargeItem[]; surcharge: number } {
  let items: ToolSurchargeItem[] = [];
  for (const [name, count] of Object.entries(opts.builtInTools || {})) {
    items = collectToolSurchargeItem(items, name, asInt(count), opts.model, opts.toolPrices);
  }
  if (opts.relayMode !== "responses" && opts.model.endsWith("search-preview")) {
    items = collectToolSurchargeItem(items, BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, 1, opts.model, opts.toolPrices);
  }
  items = collectToolSurchargeItem(
    items,
    BUILD_IN_TOOL_WEB_SEARCH,
    asInt(opts.claudeWebSearchRequests),
    opts.model,
    opts.toolPrices,
  );
  if (opts.geminiGoogleSearchCall) {
    items = collectToolSurchargeItem(items, BUILD_IN_TOOL_GOOGLE_SEARCH, 1, opts.model, opts.toolPrices);
  }
  items = mergeToolSurchargeItems(items);
  let surcharge = 0;
  for (const item of items) {
    surcharge += (item.price * item.count) / 1000 * opts.groupRatio * opts.quotaPerUnit;
  }
  return { items, surcharge };
}

function hasBillableUsage(summary: TextQuotaSummary, fixedPriceBilling = false): boolean {
  return fixedPriceBilling || summary.totalTokens > 0 || summary.toolCallSurchargeQuota !== 0;
}

/** Original `textQuotaSummary.hasBillableUsage` after `TryTieredSettle`. */
export { hasBillableUsage as textHasBillableUsage };

export type PostTextConsumeLogPartsOpts = {
  usageMissing?: boolean;
  toolSurcharges?: ToolSurchargeItem[];
  groupRatio: number;
  quotaPerUnit: number;
  formatQuota: (quota: number) => string;
  audioInputPrice?: number;
  audioInputTokens?: number;
  hasBillableUsage: boolean;
  billingModelName: string;
};

/** Original `PostTextConsumeQuota` tool-surcharge `QuotaFromDecimal` line. */
export function postTextToolSurchargeQuota(
  item: ToolSurchargeItem,
  groupRatio: number,
  quotaPerUnit: number,
): number {
  return quotaFromDecimal((item.price * item.count) / 1000 * groupRatio * quotaPerUnit);
}

/** Original `PostTextConsumeQuota` Audio Input `QuotaFromDecimal` line. */
export function postTextAudioInputQuota(
  audioInputPrice: number,
  audioTokens: number,
  groupRatio: number,
  quotaPerUnit: number,
): number {
  return quotaFromDecimal((audioInputPrice / 1_000_000) * audioTokens * groupRatio * quotaPerUnit);
}

/**
 * Original `PostTextConsumeQuota` extraContent append order, then
 * `strings.Join(extraContent, ", ")`.
 */
export function postTextConsumeLogParts(opts: PostTextConsumeLogPartsOpts): string[] {
  const parts: string[] = [];
  if (opts.usageMissing) parts.push("上游无计费信息");
  for (const item of opts.toolSurcharges || []) {
    parts.push(
      `${item.name} 调用 ${item.count} 次，调用花费 ${opts.formatQuota(postTextToolSurchargeQuota(item, opts.groupRatio, opts.quotaPerUnit))}`,
    );
  }
  if ((opts.audioInputPrice || 0) > 0 && (opts.audioInputTokens || 0) > 0) {
    parts.push(
      `Audio Input 花费 ${opts.formatQuota(postTextAudioInputQuota(opts.audioInputPrice || 0, opts.audioInputTokens || 0, opts.groupRatio, opts.quotaPerUnit))}`,
    );
  }
  if (!opts.hasBillableUsage) parts.push("上游没有返回计费信息，无法扣费（可能是上游超时）");
  if (opts.billingModelName.startsWith("gpt-4-gizmo")) parts.push(`模型 ${opts.billingModelName}`);
  else if (opts.billingModelName.startsWith("gpt-4o-gizmo")) parts.push(`模型 ${opts.billingModelName}`);
  return parts;
}

/** Original `strings.Join(extraContent, ", ")`. */
export function postTextConsumeLogContent(prefix: string[], extras: string[]): string {
  return [...prefix, ...extras].join(", ");
}

/**
 * Original `service.calculateTextQuotaSummary`.
 * `QuotaFromDecimal` (half-away-from-zero) not `Math.ceil`.
 */
export function calculateTextQuotaSummary(opts: CalculateTextQuotaOpts): TextQuotaSummary {
  const quotaPerUnit = opts.quotaPerUnit || 500000;
  const usage = opts.usage;
  const price = opts.price;
  let otherRatios = opts.otherRatios;
  if (price.usePrice && opts.imageCount && opts.imageCount > 0) {
    otherRatios = { ...(otherRatios || {}), n: opts.imageCount };
  }
  const usageSemantic = usageSemanticFromUsage(usage, opts.finalRequestFormat);
  const isClaudeUsageSemantic = usageSemantic === "anthropic";
  let promptTokens = asInt(usage?.prompt_tokens);
  const completionTokens = asInt(usage?.completion_tokens);
  const cacheTokens = asInt(usage?.prompt_tokens_details?.cached_tokens);
  let cacheCreationTokens = cacheCreationTokensTotal(usage?.prompt_tokens_details);
  const cacheCreationTokens5m = asInt(usage?.claude_cache_creation_5_m_tokens);
  const cacheCreationTokens1h = asInt(usage?.claude_cache_creation_1_h_tokens);
  const imageTokens = asInt(usage?.prompt_tokens_details?.image_tokens);
  const audioTokens = asInt(usage?.prompt_tokens_details?.audio_tokens);
  const totalTokens = promptTokens + completionTokens;
  const legacyClaudeDerived = isLegacyClaudeDerivedOpenAIUsage(usage, opts.finalRequestFormat);
  const isOpenRouterClaudeBilling =
    opts.channelType === CHANNEL_TYPE_OPENROUTER && isClaudeUsageSemantic;

  if (isOpenRouterClaudeBilling) {
    promptTokens -= cacheTokens;
    const isUsingCustomSettings = price.usePrice || hasCustomModelRatio(opts.model, price.modelRatio);
    if (
      cacheCreationTokens === 0 &&
      price.cacheCreationRatio !== 1 &&
      Number(usage?.cost || 0) !== 0 &&
      !isUsingCustomSettings &&
      usage
    ) {
      const maybe = calcOpenRouterCacheCreateTokens(usage, price, quotaPerUnit);
      if (maybe >= 0 && promptTokens >= maybe) cacheCreationTokens = maybe;
    }
    promptTokens -= cacheCreationTokens;
  }

  const tools = calculateTextToolCallSurcharge({
    model: opts.model,
    groupRatio: price.groupRatio,
    quotaPerUnit,
    relayMode: opts.relayMode,
    builtInTools: opts.builtInTools,
    claudeWebSearchRequests: opts.claudeWebSearchRequests,
    geminiGoogleSearchCall: opts.geminiGoogleSearchCall,
    toolPrices: opts.toolPrices,
  });

  const ratio = price.modelRatio * price.groupRatio;
  let audioInputPrice = 0;
  let quotaCalculate = 0;
  if (!price.usePrice) {
    let baseTokens = promptTokens;
    let cachedTokensWithRatio = 0;
    if (cacheTokens !== 0) {
      if (!isClaudeUsageSemantic && !legacyClaudeDerived) baseTokens -= cacheTokens;
      cachedTokensWithRatio = cacheTokens * price.cacheRatio;
    }
    let cachedCreationTokensWithRatio = 0;
    const hasSplit = cacheCreationTokens5m > 0 || cacheCreationTokens1h > 0;
    if (cacheCreationTokens !== 0 || hasSplit) {
      if (!isClaudeUsageSemantic && !legacyClaudeDerived) {
        baseTokens -= cacheCreationTokens;
        cachedCreationTokensWithRatio = cacheCreationTokens * price.cacheCreationRatio;
      } else {
        const remaining = Math.max(cacheCreationTokens - cacheCreationTokens5m - cacheCreationTokens1h, 0);
        cachedCreationTokensWithRatio =
          remaining * price.cacheCreationRatio +
          cacheCreationTokens5m * price.cacheCreationRatio5m +
          cacheCreationTokens1h * price.cacheCreationRatio1h;
      }
    }
    let imageTokensWithRatio = 0;
    if (imageTokens !== 0) {
      baseTokens -= imageTokens;
      imageTokensWithRatio = imageTokens * price.imageRatio;
    }
    let audioInputQuota = 0;
    if (audioTokens !== 0) {
      audioInputPrice = geminiInputAudioPricePerMillion(opts.model);
      if (audioInputPrice > 0) {
        baseTokens -= audioTokens;
        audioInputQuota = (audioInputPrice / 1_000_000) * audioTokens * price.groupRatio * quotaPerUnit;
      }
    }
    if (baseTokens < 0) baseTokens = 0;
    const promptQuota = baseTokens + cachedTokensWithRatio + imageTokensWithRatio + cachedCreationTokensWithRatio;
    const completionQuota = completionTokens * price.completionRatio;
    quotaCalculate = (promptQuota + completionQuota) * ratio;
    quotaCalculate += audioInputQuota;
    quotaCalculate = applyOtherRatiosToDecimal(quotaCalculate, otherRatios);
    quotaCalculate += tools.surcharge;
    if (ratio !== 0 && quotaCalculate <= 0) quotaCalculate = 1;
  } else {
    quotaCalculate = price.modelPrice * quotaPerUnit * price.groupRatio;
    quotaCalculate = applyOtherRatiosToDecimal(quotaCalculate, otherRatios);
    quotaCalculate += tools.surcharge;
  }

  const rounded = quotaFromDecimalChecked(quotaCalculate);
  const summary: TextQuotaSummary = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheTokens,
    cacheCreationTokens,
    cacheCreationTokens5m,
    cacheCreationTokens1h,
    imageTokens,
    audioTokens,
    quota: rounded.quota,
    clamp: rounded.clamp,
    isClaudeUsageSemantic,
    usageSemantic,
    audioInputPrice,
    toolSurchargeItems: tools.items,
    toolCallSurchargeQuota: tools.surcharge,
  };
  if (!hasBillableUsage(summary)) summary.quota = 0;
  else if (ratio !== 0 && summary.quota === 0) summary.quota = 1;
  return summary;
}

/**
 * Original `service.composeTieredTextQuota`.
 * First-wins clamp is left to the caller (`noteQuotaClamp`).
 */
export function composeTieredTextQuota(opts: {
  toolCallSurchargeQuota: number;
  tieredQuota: number;
  result?: TieredResult | null;
  snap?: BillingSnapshot | null;
}): { quota: number; clamp: QuotaClamp | null } {
  if (!opts.toolCallSurchargeQuota) return { quota: opts.tieredQuota, clamp: null };
  if (opts.result && opts.snap) {
    return quotaFromDecimalChecked(
      opts.result.actualQuotaBeforeGroup * opts.snap.groupRatio + opts.toolCallSurchargeQuota,
    );
  }
  return quotaFromDecimalChecked(opts.tieredQuota + opts.toolCallSurchargeQuota);
}

export async function calculateTextQuotaFromStore(
  store: Store,
  opts: Omit<CalculateTextQuotaOpts, "price" | "quotaPerUnit" | "toolPrices"> & {
    group: string;
    userGroup?: string;
  },
): Promise<TextQuotaSummary> {
  const price = await textConsumePriceData(store, opts.model, opts.group, opts.userGroup || "");
  const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  const toolPrices = decodeToolPricesJSON(await store.option(TOOL_PRICE_OPTION_KEY));
  return calculateTextQuotaSummary({
    ...opts,
    price,
    quotaPerUnit,
    toolPrices,
  });
}

export function noteQuotaClamp(current: QuotaClamp | null | undefined, next: QuotaClamp | null | undefined): QuotaClamp | null {
  return current || next || null;
}
