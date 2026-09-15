/**
 * Original `service.BuildTieredTokenParams` / `TryTieredSettle` /
 * `InjectTieredBillingInfo` (workerd).
 */
import {
  BILLING_MODE_TIERED_EXPR,
  getBillingExpr,
  getBillingMode,
} from "./billing-setting.js";
import {
  computeTieredQuotaWithRequest,
  emptyTokenParams,
  exprHashString,
  exprVersion,
  runExprWithRequest,
  usedVars,
  usesFixedPricing,
  type BillingRequestInput,
  type BillingSnapshot,
  type TokenParams,
  type TieredResult,
} from "./billing-expr.js";
import { parseJson } from "./constants.js";
import { resolveImageBillingRequestInput, updateBillingImageCount } from "./image-billing.js";
import { quotaRatios } from "./quota.js";
import { quotaRoundChecked } from "./task-plugin-usage.js";
import type { Store } from "./store.js";

export type BillingUsageDetails = {
  cached_tokens?: number;
  cached_creation_tokens?: number;
  cache_write_tokens?: number;
  image_tokens?: number;
  audio_tokens?: number;
  text_tokens?: number;
  cached_tokens_details?: {
    text_tokens?: number | null;
    image_tokens?: number | null;
    audio_tokens?: number | null;
  } | null;
};

export type BillingUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  usage_semantic?: string;
  usage_source?: string;
  cost?: number;
  claude_cache_creation_5_m_tokens?: number;
  claude_cache_creation_1_h_tokens?: number;
  prompt_tokens_details?: BillingUsageDetails;
  completion_tokens_details?: {
    image_tokens?: number;
    audio_tokens?: number;
    text_tokens?: number;
  };
};

function asInt(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

/** Original `dto.InputTokenDetails.CacheCreationTokensTotal`. */
export function cacheCreationTokensTotal(details: BillingUsageDetails | undefined): number {
  const total = Math.max(asInt(details?.cache_write_tokens), asInt(details?.cached_creation_tokens));
  return total < 0 ? 0 : total;
}

/** Original `service.BuildTieredTokenParams`. */
export function buildTieredTokenParams(
  usage: BillingUsage,
  isClaudeUsageSemantic: boolean,
  vars: Record<string, boolean> | null | undefined,
): TokenParams {
  const used = vars || {};
  const details = usage.prompt_tokens_details || {};
  const outDetails = usage.completion_tokens_details || {};
  let p = asInt(usage.prompt_tokens);
  let c = asInt(usage.completion_tokens);
  let cr = asInt(details.cached_tokens);
  let cc5m = cacheCreationTokensTotal(details);
  let cc1h = 0;
  if (usage.usage_semantic === "anthropic") {
    cc1h = asInt(usage.claude_cache_creation_1_h_tokens);
    cc5m = asInt(usage.claude_cache_creation_5_m_tokens);
  }
  let img = asInt(details.image_tokens);
  let imgCR = 0;
  if (used.img_cr && !isClaudeUsageSemantic) {
    const cachedImageRaw = details.cached_tokens_details?.image_tokens;
    if (cachedImageRaw != null) {
      const cachedImage = asInt(cachedImageRaw);
      const cached = asInt(details.cached_tokens);
      const image = asInt(details.image_tokens);
      let valid =
        cachedImage >= 0 &&
        cached >= cachedImage &&
        image >= cachedImage &&
        cached <= asInt(usage.prompt_tokens) &&
        image <= asInt(usage.prompt_tokens) - (cached - cachedImage);
      if (valid) {
        let remaining = cached - cachedImage;
        for (const count of [details.cached_tokens_details?.text_tokens, details.cached_tokens_details?.audio_tokens]) {
          if (count == null) continue;
          const n = asInt(count);
          if (n < 0 || n > remaining) {
            valid = false;
            break;
          }
          remaining -= n;
        }
      }
      if (valid) {
        imgCR = cachedImage;
        cr -= imgCR;
        img -= imgCR;
      }
    }
  }
  const ai = asInt(details.audio_tokens);
  const imgO = asInt(outDetails.image_tokens);
  const ao = asInt(outDetails.audio_tokens);
  let inputLen = p;
  if (isClaudeUsageSemantic) inputLen = p + cr + cc5m + cc1h;
  if (isClaudeUsageSemantic) {
    if (!used.cr) p += cr;
  } else {
    if (used.cr) p -= cr;
    if (used.cc) p -= cc5m;
    if (used.cc1h) p -= cc1h;
    if (used.img) p -= img;
    if (used.img_cr) p -= imgCR;
    if (used.ai) p -= ai;
    if (used.img_o) c -= imgO;
    if (used.ao) c -= ao;
  }
  if (p < 0) p = 0;
  if (c < 0) c = 0;
  return {
    p,
    c,
    len: inputLen,
    cr,
    cc: cc5m,
    cc1h,
    img,
    img_cr: imgCR,
    img_o: imgO,
    ai,
    ao,
  };
}

/** Original log `billing_tokens` map from `InjectTieredBillingInfo`. */
export function billingTokensJSON(tokens: TokenParams): Record<string, number> {
  return {
    p: tokens.p,
    c: tokens.c,
    len: tokens.len,
    cr: tokens.cr,
    cc: tokens.cc,
    cc1h: tokens.cc1h,
    img: tokens.img,
    img_cr: tokens.img_cr,
    img_o: tokens.img_o,
    ai: tokens.ai,
    ao: tokens.ao,
  };
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Original `service.InjectTieredBillingInfo` public `other` keys. */
export function injectTieredBillingInfo(
  other: Record<string, unknown>,
  snap: BillingSnapshot | null | undefined,
  result: TieredResult | null | undefined,
): Record<string, unknown> {
  if (!snap) return other;
  other.billing_mode = "tiered_expr";
  other.expr_b64 = utf8Base64(snap.exprString);
  if (result) {
    if (result.billingTokens && result.billingUnit === "token") {
      other.image_cache_tokens = result.billingTokens.img_cr;
      other.billing_tokens = billingTokensJSON(result.billingTokens);
    }
    if (result.imageCount != null) other.image_count = result.imageCount;
    other.matched_tier = result.matchedTier;
    if (result.billingUnit) other.billing_unit = result.billingUnit;
    if (result.fixedPrice != null) other.fixed_price = result.fixedPrice;
    if (result.requestRules && result.requestRules.length) other.request_rules = result.requestRules;
  } else if (snap.estimatedBillingUnit) {
    if (snap.estimatedImageCount != null) other.image_count = snap.estimatedImageCount;
    other.matched_tier = snap.estimatedTier;
    other.billing_unit = snap.estimatedBillingUnit;
    if (snap.estimatedFixedPrice != null) other.fixed_price = snap.estimatedFixedPrice;
  }
  return other;
}

export type TryTieredSettle =
  | { ok: false }
  | { ok: true; quota: number; result: TieredResult | null };

export type RelayTieredSettleOpts = {
  usage?: Record<string, unknown>;
  preConsumedQuota?: number;
  request?: BillingRequestInput;
  billingImageCount?: number;
  imageBody?: Record<string, unknown>;
  channelType?: number;
  headers?: Record<string, string>;
  relayMode?: string;
  actualImageCount?: number;
  /** original `RelayInfo.TieredBillingSnapshot` frozen by ModelPriceHelper */
  snapshot?: BillingSnapshot | null;
};

function settleRequestInput(snap: BillingSnapshot, opts?: RelayTieredSettleOpts): BillingRequestInput {
  const request: BillingRequestInput = { ...(opts?.request || {}) };
  if (opts?.billingImageCount != null) request.imageCount = opts.billingImageCount;
  else if (snap.estimatedImageCount != null) request.imageCount = snap.estimatedImageCount;
  return request;
}

/** Original `service.TryTieredSettle`. */
export function tryTieredSettle(
  snap: BillingSnapshot | null | undefined,
  params: TokenParams,
  opts?: RelayTieredSettleOpts,
): TryTieredSettle {
  if (!snap || snap.billingMode !== BILLING_MODE_TIERED_EXPR) return { ok: false };
  try {
    const result = computeTieredQuotaWithRequest(
      snap,
      opts?.usage || snap.usageFacts || {},
      params,
      settleRequestInput(snap, opts),
    );
    return { ok: true, quota: result.actualQuotaAfterGroup, result };
  } catch {
    const pre = Number(opts?.preConsumedQuota || 0);
    const quota = pre > 0 ? pre : snap.estimatedQuotaAfterGroup;
    return { ok: true, quota, result: null };
  }
}

function applyEstimatedTrace(snap: BillingSnapshot, request: BillingRequestInput, params: TokenParams): void {
  try {
    const trace = runExprWithRequest(snap.exprString, snap.usageFacts || {}, params, request);
    snap.estimatedTier = trace.matchedTier;
    snap.estimatedBillingUnit = trace.billingUnit;
    if (trace.imageCount != null) snap.estimatedImageCount = trace.imageCount;
    if (trace.fixedPrice != null) snap.estimatedFixedPrice = trace.fixedPrice;
    const before = snap.taskUsageBilling ? trace.cost * snap.quotaPerUnit : (trace.cost / 1_000_000) * snap.quotaPerUnit;
    snap.estimatedQuotaBeforeGroup = before;
    snap.estimatedQuotaAfterGroup = quotaRoundChecked(before * snap.groupRatio).quota;
  } catch {
    /* Original TryTieredSettle keeps the reservation when evaluation fails. */
  }
}

/** Original `helper.defaultTieredPreConsumeMaxTokens`. */
export const DEFAULT_TIERED_PRE_CONSUME_MAX_TOKENS = 8192;

/**
 * original `helper.modelPriceHelperTiered` frozen `RelayInfo.TieredBillingSnapshot`.
 * Returns null when the model is not `tiered_expr`.
 */
export async function captureTieredBillingSnapshot(
  store: Store,
  model: string,
  group: string,
  promptTokens: number,
  meta: { maxTokens?: number } = {},
  requestInput: BillingRequestInput = {},
  opts?: { relayMode?: string; channelType?: number; imageBody?: Record<string, unknown> },
): Promise<BillingSnapshot | null> {
  const modelRatio = parseJson<Record<string, unknown>>(await store.option("ModelRatio"), {});
  const modelPrice = parseJson<Record<string, unknown>>(await store.option("ModelPrice"), {});
  const modes = parseJson<Record<string, string>>(await store.option("billing_setting.billing_mode"), {});
  const exprs = parseJson<Record<string, string>>(await store.option("billing_setting.billing_expr"), {});
  if (getBillingMode(model, modes, modelRatio, modelPrice) !== BILLING_MODE_TIERED_EXPR) return null;
  const expr = getBillingExpr(model, modes, exprs, modelRatio, modelPrice);
  if (!expr) {
    throw new Error(`model ${model} is configured as tiered_expr but has no billing expression`);
  }
  const exprHash = exprHashString(expr);
  if (opts?.relayMode === "realtime" && usesFixedPricing(expr)) {
    throw new Error("fixed pricing is not supported for Realtime requests");
  }
  const ratios = await quotaRatios(store, model, group);
  let estimatedCompletionTokens = Math.max(0, Math.trunc(Number(meta.maxTokens || 0)));
  if (estimatedCompletionTokens === 0 && ratios.groupRatio !== 0) {
    estimatedCompletionTokens = DEFAULT_TIERED_PRE_CONSUME_MAX_TOKENS;
  }
  let request: BillingRequestInput = { ...requestInput };
  const vars = usedVars(expr);
  if (vars?.image_count && opts?.relayMode === "images" && opts.imageBody) {
    request = resolveImageBillingRequestInput(opts.imageBody, opts.channelType || 0, request);
  }
  const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  const params = {
    ...emptyTokenParams(),
    p: promptTokens,
    c: estimatedCompletionTokens,
    len: promptTokens,
  };
  let trace;
  try {
    trace = runExprWithRequest(expr, {}, params, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`model ${model} tiered expr run failed: ${message}`);
  }
  const quotaBeforeGroup = (trace.cost / 1_000_000) * quotaPerUnit;
  const rounded = quotaRoundChecked(quotaBeforeGroup * ratios.groupRatio);
  if (rounded.clamp) {
    throw new Error(`model ${model} tiered expr run failed: quota round ${rounded.clamp.kind}`);
  }
  return {
    billingMode: BILLING_MODE_TIERED_EXPR,
    modelName: model,
    exprString: expr,
    exprHash,
    groupRatio: ratios.groupRatio,
    estimatedPromptTokens: promptTokens,
    estimatedCompletionTokens,
    estimatedQuotaBeforeGroup: quotaBeforeGroup,
    estimatedQuotaAfterGroup: rounded.quota,
    estimatedTier: trace.matchedTier,
    estimatedBillingUnit: trace.billingUnit,
    estimatedImageCount: trace.imageCount,
    estimatedFixedPrice: trace.fixedPrice,
    quotaPerUnit,
    exprVersion: exprVersion(expr),
    taskUsageBilling: false,
    usageFacts: {},
  };
}

/** Original `service.TryTieredSettle` + frozen `BillingRequestInput.ImageCount`. */
export async function resolveRelayTieredQuota(
  store: Store,
  model: string,
  group: string,
  usage: BillingUsage,
  isClaudeUsageSemantic: boolean,
  opts?: RelayTieredSettleOpts,
): Promise<{ quota: number; snap: BillingSnapshot; result: TieredResult | null } | null> {
  let snap = opts?.snapshot ? { ...opts.snapshot, usageFacts: { ...(opts.snapshot.usageFacts || {}) } } : null;
  let request: BillingRequestInput = { ...(opts?.request || {}), headers: opts?.headers || opts?.request?.headers };
  if (!snap) {
    const modelRatio = parseJson<Record<string, unknown>>(await store.option("ModelRatio"), {});
    const modelPrice = parseJson<Record<string, unknown>>(await store.option("ModelPrice"), {});
    const modes = parseJson<Record<string, string>>(await store.option("billing_setting.billing_mode"), {});
    const exprs = parseJson<Record<string, string>>(await store.option("billing_setting.billing_expr"), {});
    if (getBillingMode(model, modes, modelRatio, modelPrice) !== BILLING_MODE_TIERED_EXPR) return null;
    const expr = getBillingExpr(model, modes, exprs, modelRatio, modelPrice);
    if (!expr) return null;
    const ratios = await quotaRatios(store, model, group);
    const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
    const vars = usedVars(expr);
    if (vars?.image_count && opts?.relayMode === "images" && opts.imageBody) {
      request = resolveImageBillingRequestInput(opts.imageBody, opts.channelType || 0, request);
    }
    snap = {
      billingMode: BILLING_MODE_TIERED_EXPR,
      modelName: model,
      exprString: expr,
      exprHash: exprHashString(expr),
      groupRatio: ratios.groupRatio,
      estimatedPromptTokens: usage.prompt_tokens,
      estimatedCompletionTokens: usage.completion_tokens,
      estimatedQuotaBeforeGroup: 0,
      estimatedQuotaAfterGroup: 0,
      estimatedTier: "",
      quotaPerUnit,
      exprVersion: exprVersion(expr),
      taskUsageBilling: false,
      usageFacts: {},
    };
    const params = buildTieredTokenParams(usage, isClaudeUsageSemantic, vars);
    applyEstimatedTrace(snap, request, params);
  } else {
    const vars = usedVars(snap.exprString);
    if (!opts?.request && vars?.image_count && opts?.relayMode === "images" && opts.imageBody) {
      request = resolveImageBillingRequestInput(opts.imageBody, opts.channelType || 0, request);
    }
  }
  const vars = usedVars(snap.exprString);
  const params = buildTieredTokenParams(usage, isClaudeUsageSemantic, vars);
  const billingImageCount =
    opts?.billingImageCount != null
      ? opts.billingImageCount
      : updateBillingImageCount(Number(opts?.actualImageCount || 0), snap.estimatedImageCount);
  const settled = tryTieredSettle(snap, params, { ...opts, request, billingImageCount, preConsumedQuota: opts?.preConsumedQuota ?? snap.estimatedQuotaAfterGroup });
  if (!settled.ok) return null;
  return { quota: settled.quota, snap, result: settled.result };
}

export function emptyBillingUsage(): BillingUsage {
  return { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: {}, completion_tokens_details: {} };
}

/** Map original OpenAI `Usage` JSON counts into `dto.Usage` field names. */
export function billingUsageFromOpenAICounts(usage: {
  prompt: number;
  completion: number;
  cachedTokens?: number;
  promptCacheHitTokens?: number;
  imageTokens?: number;
  cachedImageTokens?: number | null;
  audioTokens?: number;
  cacheWriteTokens?: number;
  cachedCreationTokens?: number;
  completionImageTokens?: number;
  completionAudioTokens?: number;
  textTokens?: number;
  completionTextTokens?: number;
  usageSemantic?: string;
  claudeCacheCreation5mTokens?: number;
  claudeCacheCreation1hTokens?: number;
  usageSource?: string;
  cost?: number;
}): BillingUsage {
  return {
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    usage_semantic: usage.usageSemantic || "",
    usage_source: usage.usageSource || "",
    cost: usage.cost || 0,
    claude_cache_creation_5_m_tokens: usage.claudeCacheCreation5mTokens || 0,
    claude_cache_creation_1_h_tokens: usage.claudeCacheCreation1hTokens || 0,
    prompt_tokens_details: {
      cached_tokens: usage.cachedTokens || usage.promptCacheHitTokens || 0,
      cached_creation_tokens: usage.cachedCreationTokens || 0,
      cache_write_tokens: usage.cacheWriteTokens || 0,
      image_tokens: usage.imageTokens || 0,
      audio_tokens: usage.audioTokens || 0,
      text_tokens: usage.textTokens || 0,
      cached_tokens_details:
        usage.cachedImageTokens == null
          ? null
          : { image_tokens: usage.cachedImageTokens },
    },
    completion_tokens_details: {
      image_tokens: usage.completionImageTokens || 0,
      audio_tokens: usage.completionAudioTokens || 0,
      text_tokens: usage.completionTextTokens || 0,
    },
  };
}
