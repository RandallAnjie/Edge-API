import { BILLING_MODE_TIERED_EXPR, getBillingExpr, getBillingMode } from "./billing-setting.js";
import { CHANNEL_TYPE_ALI, DEFAULT_GROUP_RATIO, parseJson, ROLE_ADMIN } from "./constants.js";
import { imageRequestCount, Z_IMAGE_PROMPT_EXTEND_MULTIPLIER } from "./image-billing.js";
import {
  formatMatchingModelName,
  getAudioCompletionRatioFromMap,
  getAudioRatioFromMap,
  getCacheRatioFromMap,
  getCompletionRatio,
  getCreateCacheRatioFromMap,
  getImageRatioFromMap,
  getModelPriceFromMap,
  getModelRatioFromMap,
  hasConfiguredModelRatio,
} from "./ratio-setting.js";
import {
  applyOtherRatiosToFloat,
  isValidOtherRatio,
  quotaClampMessage,
  quotaFromFloatStrict,
} from "./task-plugin-usage.js";
import {
  baseModelName,
  canonicalBillingModelNames,
  parseModelModifiers,
  type ReasoningHostSettings,
} from "./reasoning.js";
import type { Store } from "./store.js";

/** Original `helper.claudeCacheCreation1hMultiplier` (`6 / 3.75`). */
const CLAUDE_CACHE_CREATION_1H_MULTIPLIER = 6 / 3.75;

/** Original `helper.HandleGroupRatio`. */
export async function handleGroupRatio(
  store: Store,
  group: string,
  userGroup = "",
): Promise<{ groupRatio: number; groupSpecialRatio: number; hasSpecialRatio: boolean }> {
  const overlay = parseJson<Record<string, Record<string, number>>>(await store.option("GroupGroupRatio"), {});
  const nested = userGroup ? overlay[userGroup] : undefined;
  if (nested && nested[group] != null) {
    const groupRatio = Number(nested[group]);
    return { groupRatio, groupSpecialRatio: groupRatio, hasSpecialRatio: true };
  }
  const groupRatioMap = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  const groupRatio = groupRatioMap[group] ?? groupRatioMap.default ?? 1;
  return { groupRatio, groupSpecialRatio: -1, hasSpecialRatio: false };
}

/** Original `helper.ModelPriceHelper` fields copied into `GenerateTextOtherInfo`. */
export type TextConsumePriceData = {
  modelRatio: number;
  completionRatio: number;
  groupRatio: number;
  cacheRatio: number;
  cacheCreationRatio: number;
  cacheCreationRatio5m: number;
  cacheCreationRatio1h: number;
  imageRatio: number;
  audioRatio: number;
  audioCompletionRatio: number;
  modelPrice: number;
  userGroupRatio: number;
  hasSpecialRatio: boolean;
  usePrice: boolean;
  tiered: boolean;
};

export async function textConsumePriceData(
  store: Store,
  model: string,
  group: string,
  userGroup = "",
): Promise<TextConsumePriceData> {
  const groupInfo = await handleGroupRatio(store, group, userGroup);
  const modelRatioMap = parseJson<Record<string, unknown>>(await store.option("ModelRatio"), {});
  const modelPriceMap = parseJson<Record<string, unknown>>(await store.option("ModelPrice"), {});
  const modes = parseJson<Record<string, string>>(await store.option("billing_setting.billing_mode"), {});
  const exprs = parseJson<Record<string, string>>(await store.option("billing_setting.billing_expr"), {});
  if (
    getBillingMode(model, modes, modelRatioMap, modelPriceMap) === BILLING_MODE_TIERED_EXPR &&
    getBillingExpr(model, modes, exprs, modelRatioMap, modelPriceMap)
  ) {
    return {
      modelRatio: 0,
      completionRatio: 0,
      groupRatio: groupInfo.groupRatio,
      cacheRatio: 0,
      cacheCreationRatio: 0,
      cacheCreationRatio5m: 0,
      cacheCreationRatio1h: 0,
      imageRatio: 0,
      audioRatio: 0,
      audioCompletionRatio: 0,
      modelPrice: 0,
      userGroupRatio: groupInfo.groupSpecialRatio,
      hasSpecialRatio: groupInfo.hasSpecialRatio,
      usePrice: false,
      tiered: true,
    };
  }
  const priced = getModelPriceFromMap(model, modelPriceMap);
  if (priced.configured) {
    return {
      modelRatio: 0,
      completionRatio: 0,
      groupRatio: groupInfo.groupRatio,
      cacheRatio: 0,
      cacheCreationRatio: 0,
      cacheCreationRatio5m: 0,
      cacheCreationRatio1h: 0,
      imageRatio: 0,
      audioRatio: 0,
      audioCompletionRatio: 0,
      modelPrice: priced.price,
      userGroupRatio: groupInfo.groupSpecialRatio,
      hasSpecialRatio: groupInfo.hasSpecialRatio,
      usePrice: true,
      tiered: false,
    };
  }
  const { modelRatio, completionRatio } = await quotaRatios(store, model, group);
  const cacheRatioMap = parseJson<Record<string, number>>(await store.option("CacheRatio"), {});
  const createCacheRatioMap = parseJson<Record<string, number>>(await store.option("CreateCacheRatio"), {});
  const imageRatioMap = parseJson<Record<string, number>>(await store.option("ImageRatio"), {});
  const audioRatioMap = parseJson<Record<string, number>>(await store.option("AudioRatio"), {});
  const audioCompletionRatioMap = parseJson<Record<string, number>>(await store.option("AudioCompletionRatio"), {});
  const cacheCreation = getCreateCacheRatioFromMap(model, createCacheRatioMap).ratio;
  return {
    modelRatio,
    completionRatio,
    groupRatio: groupInfo.groupRatio,
    cacheRatio: getCacheRatioFromMap(model, cacheRatioMap).ratio,
    cacheCreationRatio: cacheCreation,
    cacheCreationRatio5m: cacheCreation,
    cacheCreationRatio1h: cacheCreation * CLAUDE_CACHE_CREATION_1H_MULTIPLIER,
    imageRatio: getImageRatioFromMap(model, imageRatioMap).ratio,
    audioRatio: getAudioRatioFromMap(model, audioRatioMap).ratio,
    audioCompletionRatio: getAudioCompletionRatioFromMap(model, audioCompletionRatioMap).ratio,
    modelPrice: -1,
    userGroupRatio: groupInfo.groupSpecialRatio,
    hasSpecialRatio: groupInfo.hasSpecialRatio,
    usePrice: false,
    tiered: false,
  };
}

/**
 * original PostAudioConsumeQuota `GetAudioRatio` / `GetAudioCompletionRatio` /
 * `GetCompletionRatio` (always from maps, not PriceData zeros on usePrice).
 */
export async function audioConsumeLogRatios(
  store: Store,
  model: string,
): Promise<{
  audioRatio: number;
  audioCompletionRatio: number;
  containsAudioRatios: boolean;
  completionRatio: number;
}> {
  const audioRatioMap = parseJson<Record<string, number>>(await store.option("AudioRatio"), {});
  const audioCompletionRatioMap = parseJson<Record<string, number>>(await store.option("AudioCompletionRatio"), {});
  const completionRatioMap = parseJson<Record<string, number>>(await store.option("CompletionRatio"), {});
  const audio = getAudioRatioFromMap(model, audioRatioMap);
  const audioCompletion = getAudioCompletionRatioFromMap(model, audioCompletionRatioMap);
  return {
    audioRatio: audio.ratio,
    audioCompletionRatio: audioCompletion.ratio,
    containsAudioRatios: audio.configured || audioCompletion.configured,
    completionRatio: getCompletionRatio(model, completionRatioMap),
  };
}

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

/** Original `common.GetTrustQuota` (`10 * QuotaPerUnit`). */
export function getTrustQuota(quotaPerUnit = 500000): number {
  return Math.trunc(10 * (quotaPerUnit || 500000));
}

/** Original `common.GetTrustQuota` using persisted `QuotaPerUnit`. */
export async function storeTrustQuota(store: Store): Promise<number> {
  return getTrustQuota((await store.optionNum("QuotaPerUnit", 500000)) || 500000);
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

/** Original `helper.modelPriceNotConfiguredError`. */
export function modelPriceNotConfiguredMessage(modelName: string, userRole: number): string {
  if (userRole >= ROLE_ADMIN) {
    return (
      `模型 ${modelName} 的价格未配置。请前往「系统设置 → 运营设置」开启自用模式，或在「系统设置 → 分组与模型定价设置」中为该模型配置价格；` +
      `Model ${modelName} price not configured. Go to System Settings → Operation Settings to enable self-use mode, or configure the model price in System Settings → Group & Model Pricing.`
    );
  }
  return (
    `模型 ${modelName} 的价格尚未由管理员配置，暂时无法使用，请联系站点管理员开启该模型；` +
    `Model ${modelName} has not been priced by the administrator yet. Please contact the site administrator to enable this model.`
  );
}

/** Original `helper.HasPriceOrRatioEntry` maps. */
export type BillingLookupMaps = {
  modelPrice: Record<string, unknown>;
  modelRatio: Record<string, unknown>;
  modes: Record<string, string>;
  exprs?: Record<string, string>;
};

/** Original `helper.HasPriceOrRatioEntry`. */
export function hasPriceOrRatioEntry(name: string, maps: BillingLookupMaps): boolean {
  const formatted = formatMatchingModelName(name);
  if (getModelPriceFromMap(formatted, maps.modelPrice).configured) return true;
  if (hasConfiguredModelRatio(formatted, maps.modelRatio)) return true;
  return getBillingMode(formatted, maps.modes, maps.modelRatio, maps.modelPrice) === BILLING_MODE_TIERED_EXPR;
}

/** Original `helper.resolveBillingModelName`. */
export function resolveBillingModelName(
  origin: string,
  maps: BillingLookupMaps,
  settings: ReasoningHostSettings = {},
): string {
  const candidates: string[] = [];
  if (parseModelModifiers(origin).modifiers.length === 0) candidates.push(origin);
  candidates.push(...canonicalBillingModelNames(origin, settings));
  const base = baseModelName(origin, settings);
  candidates.push(base);
  const seen = new Set<string>();
  let matched = "";
  for (const name of candidates) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (hasPriceOrRatioEntry(name, maps)) {
      matched = name;
      break;
    }
  }
  return matched || base;
}

export async function billingLookupMapsFromStore(store: Store): Promise<BillingLookupMaps> {
  return {
    modelRatio: parseJson<Record<string, unknown>>(await store.option("ModelRatio"), {}),
    modelPrice: parseJson<Record<string, unknown>>(await store.option("ModelPrice"), {}),
    modes: parseJson<Record<string, string>>(await store.option("billing_setting.billing_mode"), {}),
    exprs: parseJson<Record<string, string>>(await store.option("billing_setting.billing_expr"), {}),
  };
}

/** Original ModelPriceHelper `info.GetBillingModelName()` after `resolveBillingModelName`. */
export async function resolveBillingModelNameFromStore(
  store: Store,
  origin: string,
  settings: ReasoningHostSettings = {},
): Promise<string> {
  const maps = await billingLookupMapsFromStore(store);
  const matched = resolveBillingModelName(origin, maps, settings);
  return matched && matched !== origin ? matched : origin;
}

/**
 * Original PostText `RecordConsumeLog` `logModel` gizmo rewrite of `GetBillingModelName()`.
 * PostAudio and TestChannel skip this rewrite.
 */
export function consumeLogModelName(billingModelName: string): string {
  if (billingModelName.startsWith("gpt-4-gizmo")) return "gpt-4-gizmo-*";
  if (billingModelName.startsWith("gpt-4o-gizmo")) return "gpt-4o-gizmo-*";
  return billingModelName;
}

/** Original `helper.ModelPriceHelper` reject when ratio/price/tiered expr is missing. */
export async function modelPriceHelperReject(
  store: Store,
  modelName: string,
  userRole: number,
  userSettings: unknown,
  reasoningSettings: ReasoningHostSettings = {},
): Promise<string | null> {
  const maps = await billingLookupMapsFromStore(store);
  const billingModelName = resolveBillingModelNameFromStoreSync(modelName, maps, reasoningSettings);
  // Original ModelPriceHelper always enters modelPriceHelperTiered when billing
  // mode is tiered_expr, including a missing expression ("no billing expression").
  if (getBillingMode(billingModelName, maps.modes, maps.modelRatio, maps.modelPrice) === BILLING_MODE_TIERED_EXPR) {
    return null;
  }
  if (getModelPriceFromMap(billingModelName, maps.modelPrice).configured) return null;
  const selfUse = await store.optionBool("SelfUseModeEnabled", false);
  const ratio = getModelRatioFromMap(billingModelName, maps.modelRatio, selfUse);
  const settings =
    typeof userSettings === "string"
      ? parseJson<Record<string, unknown>>(userSettings, {})
      : userSettings && typeof userSettings === "object"
        ? (userSettings as Record<string, unknown>)
        : {};
  if (!ratio.configured && !Boolean(settings.accept_unset_model_ratio_model)) {
    return modelPriceNotConfiguredMessage(ratio.name || billingModelName, userRole);
  }
  return null;
}

export type ModelPriceHelperQuotaResult = {
  quotaToPreConsume: number;
  freeModel: boolean;
  usePrice: boolean;
  modelPrice: number;
  modelRatio: number;
  otherRatios: Record<string, number>;
  imageQuotaBeforeGroup: number;
  groupRatio: number;
  quotaPerUnit: number;
  error?: string;
};

export type ModelPriceHelperQuotaInput = {
  billingModelName: string;
  promptTokens: number;
  maxTokens?: number;
  imagePriceRatio?: number;
  billingRatios?: Record<string, number>;
  groupRatio: number;
  quotaPerUnit: number;
  preConsumedQuota: number;
  enableFreeModelPreConsume: boolean;
  modelRatioMap: Record<string, unknown>;
  modelPriceMap: Record<string, unknown>;
  modes: Record<string, string>;
  selfUse?: boolean;
  relayMode?: string;
  channelType?: number;
  originModelName?: string;
  upstreamModelName?: string;
  body?: Record<string, unknown>;
  tieredQuotaToPreConsume?: number;
};

function addOtherRatio(out: Record<string, number>, key: string, ratio: number): void {
  if (!isValidOtherRatio(ratio)) return;
  out[key] = ratio;
}

function quotaHelperError(message: string, groupRatio = 0, quotaPerUnit = 0): ModelPriceHelperQuotaResult {
  return {
    quotaToPreConsume: 0,
    freeModel: false,
    usePrice: false,
    modelPrice: 0,
    modelRatio: 0,
    otherRatios: {},
    imageQuotaBeforeGroup: 0,
    groupRatio,
    quotaPerUnit,
    error: message,
  };
}

/** Original `helper.ModelPriceHelper` `QuotaToPreConsume` / `FreeModel`. */
export function modelPriceHelperQuotaToPreConsume(input: ModelPriceHelperQuotaInput): ModelPriceHelperQuotaResult {
  const billing = input.billingModelName;
  const other: Record<string, number> = {};
  const helperErr = (message: string) => quotaHelperError(message, input.groupRatio, input.quotaPerUnit);
  if (getBillingMode(billing, input.modes, input.modelRatioMap, input.modelPriceMap) === BILLING_MODE_TIERED_EXPR) {
    let quota = Math.trunc(Number(input.tieredQuotaToPreConsume || 0));
    let freeModel = false;
    if (!input.enableFreeModelPreConsume && input.groupRatio === 0) {
      quota = 0;
      freeModel = true;
    }
    return {
      quotaToPreConsume: quota,
      freeModel,
      usePrice: false,
      modelPrice: 0,
      modelRatio: 0,
      otherRatios: other,
      imageQuotaBeforeGroup: 0,
      groupRatio: input.groupRatio,
      quotaPerUnit: input.quotaPerUnit,
    };
  }

  const priced = getModelPriceFromMap(billing, input.modelPriceMap);
  const usePrice = priced.configured;
  let modelPrice = priced.price;
  let modelRatio = 0;
  let imageQuotaBeforeGroup = 0;
  let quota = 0;

  if (!usePrice) {
    let preConsumedTokens = Math.max(Math.trunc(input.promptTokens || 0), Math.trunc(input.preConsumedQuota || 0));
    if (input.maxTokens) preConsumedTokens += Math.trunc(input.maxTokens);
    modelRatio = getModelRatioFromMap(billing, input.modelRatioMap, Boolean(input.selfUse)).ratio;
    const strict = quotaFromFloatStrict(preConsumedTokens * modelRatio * input.groupRatio);
    if (strict.clamp) return helperErr(quotaClampMessage(strict.clamp));
    quota = strict.quota;
    if (input.relayMode === "images") imageQuotaBeforeGroup = preConsumedTokens * modelRatio;
  } else if (input.imagePriceRatio) {
    modelPrice *= input.imagePriceRatio;
  }
  if (usePrice && input.relayMode === "images") imageQuotaBeforeGroup = modelPrice * input.quotaPerUnit;

  let freeModel = false;
  if (!input.enableFreeModelPreConsume) {
    if (input.groupRatio === 0) {
      quota = 0;
      freeModel = true;
    } else if (usePrice && modelPrice === 0) {
      quota = 0;
      freeModel = true;
    } else if (!usePrice && modelRatio === 0) {
      quota = 0;
      freeModel = true;
    }
  }

  if (usePrice && input.billingRatios) {
    for (const [name, ratio] of Object.entries(input.billingRatios)) addOtherRatio(other, name, ratio);
  }

  if (input.relayMode === "images") {
    try {
      const count = imageRequestCount(input.body || {}, input.channelType === CHANNEL_TYPE_ALI);
      if (usePrice || input.channelType === CHANNEL_TYPE_ALI) addOtherRatio(other, "n", count);
    } catch (err) {
      return helperErr(err instanceof Error ? err.message : String(err));
    }
    const parameters =
      input.body && typeof input.body.parameters === "object" && input.body.parameters
        ? (input.body.parameters as Record<string, unknown>)
        : {};
    if (input.channelType === CHANNEL_TYPE_ALI && parameters.prompt_extend === true) {
      const mapped = input.upstreamModelName || input.originModelName || billing;
      if (String(mapped).includes("z-image")) addOtherRatio(other, "prompt_extend", Z_IMAGE_PROMPT_EXTEND_MULTIPLIER);
    }
    if (!usePrice) {
      const strict = quotaFromFloatStrict(applyOtherRatiosToFloat(imageQuotaBeforeGroup * input.groupRatio, other));
      if (strict.clamp) return helperErr(quotaClampMessage(strict.clamp));
      quota = strict.quota;
    }
  }

  if (usePrice) {
    const strict = quotaFromFloatStrict(applyOtherRatiosToFloat(modelPrice * input.quotaPerUnit * input.groupRatio, other));
    if (strict.clamp) return helperErr(quotaClampMessage(strict.clamp));
    quota = strict.quota;
  }

  return {
    quotaToPreConsume: quota,
    freeModel,
    usePrice,
    modelPrice: usePrice ? modelPrice : -1,
    modelRatio,
    otherRatios: other,
    imageQuotaBeforeGroup,
    groupRatio: input.groupRatio,
    quotaPerUnit: input.quotaPerUnit,
  };
}

export async function modelPriceHelperQuotaToPreConsumeFromStore(
  store: Store,
  opts: {
    billingModelName: string;
    promptTokens: number;
    maxTokens?: number;
    imagePriceRatio?: number;
    billingRatios?: Record<string, number>;
    group: string;
    userGroup?: string;
    relayMode?: string;
    channelType?: number;
    originModelName?: string;
    upstreamModelName?: string;
    body?: Record<string, unknown>;
    tieredQuotaToPreConsume?: number;
  },
): Promise<ModelPriceHelperQuotaResult> {
  const groupInfo = await handleGroupRatio(store, opts.group, opts.userGroup || "");
  const preConsumedRaw = await store.option("PreConsumedQuota");
  const preConsumedParsed = Number(preConsumedRaw);
  return modelPriceHelperQuotaToPreConsume({
    billingModelName: opts.billingModelName,
    promptTokens: opts.promptTokens,
    maxTokens: opts.maxTokens,
    imagePriceRatio: opts.imagePriceRatio,
    billingRatios: opts.billingRatios,
    groupRatio: groupInfo.groupRatio,
    quotaPerUnit: (await store.optionNum("QuotaPerUnit", 500000)) || 500000,
    preConsumedQuota: preConsumedRaw && Number.isFinite(preConsumedParsed) ? preConsumedParsed : 500,
    enableFreeModelPreConsume: await store.optionBool("quota_setting.enable_free_model_pre_consume", true),
    modelRatioMap: parseJson<Record<string, unknown>>(await store.option("ModelRatio"), {}),
    modelPriceMap: parseJson<Record<string, unknown>>(await store.option("ModelPrice"), {}),
    modes: parseJson<Record<string, string>>(await store.option("billing_setting.billing_mode"), {}),
    selfUse: await store.optionBool("SelfUseModeEnabled", false),
    relayMode: opts.relayMode,
    channelType: opts.channelType,
    originModelName: opts.originModelName,
    upstreamModelName: opts.upstreamModelName,
    body: opts.body,
    tieredQuotaToPreConsume: opts.tieredQuotaToPreConsume,
  });
}

function resolveBillingModelNameFromStoreSync(
  origin: string,
  maps: BillingLookupMaps,
  settings: ReasoningHostSettings = {},
): string {
  const matched = resolveBillingModelName(origin, maps, settings);
  return matched && matched !== origin ? matched : origin;
}

/** Original `service.PreWssConsumeQuota` user insufficient message. */
export function insufficientWssUserQuotaMessage(formattedRemain: string, formattedNeed: string): string {
  return `user quota is not enough, user quota: ${formattedRemain}, need quota: ${formattedNeed}`;
}
