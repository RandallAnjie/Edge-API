/**
 * Original `relay.RelayTaskSubmit` + jsplugin `TaskAdaptor` +
 * `controller.presentTaskSubmission` on workerd.
 */
import { tokenAllowsModel } from "./auth.js";
import { resolveBaseUrl } from "./catalog.js";
import {
  cacheGetRandomSatisfiedChannel,
  increaseChannelSelectRetry,
  selectDistributedChannel,
} from "./channel-select.js";
import { PIN_RETRY_SINGLE_ATTEMPT } from "./channel-constraint.js";
import { CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_VERTEX, DEFAULT_GROUP_RATIO, parseJson, ROLE_ADMIN } from "./constants.js";
import {
  billingSnapshotJSON,
  evaluateTaskCompletionUsage,
  exprHashString,
  exprVersion,
  runExprWithRequest,
  usesFixedPricing,
  type BillingSnapshot,
} from "./billing-expr.js";
import { BILLING_MODE_TIERED_EXPR, getBillingMode, resolveTaskBillingExpr } from "./billing-setting.js";
import {
  abortWithOpenAiMessage,
  clientIp,
  getChannelRetryFailedMessage,
  json,
  noAvailableChannelMessage,
  noAvailableChannelRetryMessage,
  pluginProtocolSubmissionError,
  taskErrorJson,
  tokenModelForbiddenMessage,
} from "./http.js";
import {
  logTaskConsumption,
  taskPluginSnapshotFromMeta,
  type TaskPriceData,
} from "./task-plugin-billing.js";
import { type PluginEngine, validateRequestURL } from "./jsplugin.js";
import { requestHeadersFrom } from "./param-override.js";
import type { MatchedPlugin } from "./plugin-dispatch.js";
import { formatQuotaOriginal, insufficientTokenQuotaMessage, insufficientWalletQuotaMessage } from "./quota.js";
import { defaultModelPrice } from "./ratio-defaults.js";
import { getModelPriceFromMap, getModelRatioFromMap } from "./ratio-setting.js";
import { mapModel, pickChannelKey } from "./select.js";
import { isAlwaysSkipRetryStatusCode } from "./status-code-ranges.js";
import { normalizeBillingPreference } from "./subscription.js";
import type { Store } from "./store.js";
import {
  buildTaskPluginView,
  protocolRequestJSValue,
  respondTaskPluginError,
  routeRequestJSValue,
  type PreparedNativeRoute,
  type ProtocolRequestContext,
  type RouteRequestContext,
} from "./task-plugin-route.js";
import { openaiVideoView } from "./dto.js";
import type { AuthToken, ChannelRow, Env } from "./types.js";
import {
  encodeNativeSubmitBody,
  parseNativeSubmitParts,
  type NativeSubmitPart,
} from "./task-plugin-submit-body.js";
import { applyCompletionUsageFacts, buildNativeQueryContext, isNativeQueryError, type NativeTaskInfo } from "./task-plugin-query.js";
import { channelSettingProxy, resolvePluginAuth } from "./vertex-auth.js";
import { parseSubmitMediaType, readSubmitEvents } from "./task-plugin-submit-sse.js";
import {
  applyOtherRatiosToFloat,
  applyRelayTaskSubmitBilling,
  estimateBillingValidated,
  extractUsageFactsValidated,
  pluginHasUsageProfiles,
  quotaClampMessage,
  quotaFromFloatChecked,
  quotaRoundChecked,
  validateResolvedUsageRequest,
} from "./task-plugin-usage.js";

export const MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES = 1 << 20;
const TASK_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type NativeTaskError = {
  code: string;
  message: string;
  statusCode: number;
  localError: boolean;
  noRetry: boolean;
};

export type NativeSubmitDescriptor = {
  responseType: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  action: string;
  model: string;
  rewriteModel: string;
  bodyType: string;
  parts: NativeSubmitPart[];
};

export type NativeSubmitParsed = {
  upstreamTaskId: string;
  taskData: unknown;
  pluginState: unknown;
  immediate: Record<string, unknown> | null;
};

export type NativeSubmitInfo = {
  originModelName: string;
  upstreamModelName: string;
  action: string;
  publicTaskId: string;
  apiKey: string;
  channelBaseUrl: string;
  channelId: number;
  channelType: number;
  usingGroup: string;
  isModelMapped: boolean;
  proxy?: string;
};

/** Original `service.BillingSession` hold for native RelayTask. */
export type NativeTaskBillingSession = {
  preconsumed: number;
  started: boolean;
  funding: "wallet" | "subscription";
  requestId: string;
  extraReserved: number;
  subscriptionId: number;
  subscriptionPreConsumed: number;
  subscriptionAmountTotal: number;
  subscriptionAmountUsedAfter: number;
  subscriptionPlanId: number;
  subscriptionPlanTitle: string;
  billingPreference: string;
  postDelta: number;
};

function emptyNativeTaskBilling(requestId: string): NativeTaskBillingSession {
  return {
    preconsumed: 0,
    started: false,
    funding: "wallet",
    requestId,
    extraReserved: 0,
    subscriptionId: 0,
    subscriptionPreConsumed: 0,
    subscriptionAmountTotal: 0,
    subscriptionAmountUsedAfter: 0,
    subscriptionPlanId: 0,
    subscriptionPlanTitle: "",
    billingPreference: "subscription_first",
    postDelta: 0,
  };
}

function billingLogFromSession(billing: NativeTaskBillingSession): {
  billingSource: string;
  billingPreference: string;
  subscriptionId: number;
  subscriptionPreConsumed: number;
  subscriptionPostDelta: number;
  subscriptionPlanId: number;
  subscriptionPlanTitle: string;
  subscriptionAmountTotal: number;
  subscriptionAmountUsedAfterPreConsume: number;
} {
  return {
    billingSource: billing.funding,
    billingPreference: billing.billingPreference,
    subscriptionId: billing.subscriptionId,
    subscriptionPreConsumed: billing.subscriptionPreConsumed,
    subscriptionPostDelta: billing.postDelta,
    subscriptionPlanId: billing.subscriptionPlanId,
    subscriptionPlanTitle: billing.subscriptionPlanTitle,
    subscriptionAmountTotal: billing.subscriptionAmountTotal,
    subscriptionAmountUsedAfterPreConsume: billing.subscriptionAmountUsedAfter,
  };
}

type SubmitKind = Extract<PreparedNativeRoute, { kind: "submit" }>;

/** Original `model.GenerateTaskID`. */
export function generateTaskID(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let key = "";
  for (const b of bytes) key += TASK_ID_CHARS[b % TASK_ID_CHARS.length];
  return "task_" + key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Original `jsonValue` round-trip for plugin hook arguments. */
export function pluginJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function hookMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function taskErr(code: string, message: string, statusCode: number, localError: boolean, noRetry = false): NativeTaskError {
  return { code, message, statusCode, localError, noRetry };
}

async function formatTaskQuota(store: Store, quota: number): Promise<string> {
  const unit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  const display = (await store.option("general_setting.quota_display_type")) || "USD";
  const usdRate = (await store.optionNum("USDExchangeRate", 1)) || 1;
  const customSymbol = (await store.option("general_setting.custom_currency_symbol")) || "¤";
  const customRate = Number(await store.option("general_setting.custom_currency_exchange_rate")) || 1;
  return formatQuotaOriginal(quota, unit, display, usdRate, customSymbol, customRate);
}

async function refundNativeTaskBilling(store: Store, auth: AuthToken, billing: NativeTaskBillingSession | null): Promise<void> {
  if (!billing || !billing.started) return;
  const amount = billing.preconsumed;
  if (billing.funding === "subscription") {
    if (billing.requestId) {
      try {
        await store.refundSubscriptionPreConsume(billing.requestId);
      } catch {
        /* original logs refund errors */
      }
    }
    if (billing.extraReserved > 0 && billing.subscriptionId > 0) {
      try {
        await store.postConsumeUserSubscriptionDelta(billing.subscriptionId, -billing.extraReserved);
      } catch {
        /* original logs refund errors */
      }
    }
  } else if (amount > 0) {
    await store.releaseUserQuota(auth.user.id, amount);
    auth.user.quota += amount;
  }
  if (amount > 0) {
    await store.releaseTokenQuota(auth.token.id, amount);
    auth.token.remain_quota += amount;
    auth.token.used_quota -= amount;
  }
  billing.preconsumed = 0;
  billing.extraReserved = 0;
  billing.started = false;
}

function userBillingPreference(user: { billing_preference?: string; settings?: string }): string {
  const settings = parseJson<Record<string, unknown>>(String(user.settings || ""), {});
  return normalizeBillingPreference(user.billing_preference || settings.billing_preference);
}

function insufficientSubscriptionMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `订阅额度不足或未配置订阅: ${msg}`;
}

async function holdTokenForTask(
  store: Store,
  auth: AuthToken,
  quota: number,
): Promise<NativeTaskError | null> {
  if (quota <= 0) return null;
  const unlimited = Boolean(Number(auth.token.unlimited_quota));
  if (!unlimited && auth.token.remain_quota < quota) {
    return taskErr(
      "insufficient_user_quota",
      insufficientTokenQuotaMessage(await formatTaskQuota(store, auth.token.remain_quota), await formatTaskQuota(store, quota)),
      403,
      true,
    );
  }
  const tokenHeld = await store.tryHoldTokenQuota(auth.token.id, quota, unlimited);
  if (!tokenHeld) {
    return taskErr(
      "insufficient_user_quota",
      insufficientTokenQuotaMessage(await formatTaskQuota(store, auth.token.remain_quota), await formatTaskQuota(store, quota)),
      403,
      true,
    );
  }
  auth.token.remain_quota -= quota;
  auth.token.used_quota += quota;
  return null;
}

async function tryWalletPreConsume(
  store: Store,
  auth: AuthToken,
  billing: NativeTaskBillingSession,
  quota: number,
): Promise<NativeTaskError | null> {
  const remain = auth.user.quota;
  const formattedRemain = await formatTaskQuota(store, remain);
  const formattedNeed = await formatTaskQuota(store, quota);
  if (remain <= 0) {
    return taskErr("insufficient_user_quota", insufficientWalletQuotaMessage(remain, quota, formattedRemain, formattedNeed), 403, true);
  }
  if (remain < quota) {
    return taskErr("insufficient_user_quota", insufficientWalletQuotaMessage(remain, quota, formattedRemain, formattedNeed), 403, true);
  }
  const tokenErr = await holdTokenForTask(store, auth, quota);
  if (tokenErr) return tokenErr;
  if (quota > 0) {
    const userHeld = await store.tryHoldUserQuota(auth.user.id, quota);
    if (!userHeld) {
      await store.releaseTokenQuota(auth.token.id, quota);
      auth.token.remain_quota += quota;
      auth.token.used_quota -= quota;
      return taskErr("insufficient_user_quota", insufficientWalletQuotaMessage(remain, quota, formattedRemain, formattedNeed), 403, true);
    }
    auth.user.quota -= quota;
  }
  billing.started = true;
  billing.preconsumed = quota;
  billing.funding = "wallet";
  billing.subscriptionId = 0;
  billing.subscriptionPreConsumed = 0;
  return null;
}

async function trySubscriptionPreConsume(
  store: Store,
  auth: AuthToken,
  billing: NativeTaskBillingSession,
  quota: number,
): Promise<NativeTaskError | null> {
  const subConsume = quota > 0 ? quota : 1;
  const tokenErr = await holdTokenForTask(store, auth, subConsume);
  if (tokenErr) return tokenErr;
  try {
    const result = await store.preConsumeUserSubscription(billing.requestId, auth.user.id, subConsume);
    billing.started = true;
    billing.preconsumed = subConsume;
    billing.funding = "subscription";
    billing.subscriptionId = result.userSubscriptionId;
    billing.subscriptionPreConsumed = result.preConsumed;
    billing.subscriptionAmountTotal = result.amountTotal;
    billing.subscriptionAmountUsedAfter = result.amountUsedAfter;
    const plan = await store.getSubscriptionPlanInfoByUserSubscriptionId(result.userSubscriptionId);
    billing.subscriptionPlanId = plan?.planId || 0;
    billing.subscriptionPlanTitle = plan?.planTitle || "";
    return null;
  } catch (err) {
    if (subConsume > 0) {
      await store.releaseTokenQuota(auth.token.id, subConsume);
      auth.token.remain_quota += subConsume;
      auth.token.used_quota -= subConsume;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no active subscription") || msg.includes("subscription quota insufficient")) {
      return taskErr("insufficient_user_quota", insufficientSubscriptionMessage(err), 403, true);
    }
    return taskErr("update_data_error", msg, 500, true);
  }
}

async function preConsumeNativeTask(
  store: Store,
  auth: AuthToken,
  billing: NativeTaskBillingSession,
  quota: number,
): Promise<NativeTaskError | null> {
  if (billing.started) return null;
  if (quota < 0) {
    return taskErr("model_price_error", `pre-consume quota cannot be negative: ${quota}`, 400, true);
  }
  const pref = userBillingPreference(auth.user);
  billing.billingPreference = pref;
  const tryWallet = () => tryWalletPreConsume(store, auth, billing, quota);
  const trySubscription = () => trySubscriptionPreConsume(store, auth, billing, quota);
  switch (pref) {
    case "subscription_only":
      return trySubscription();
    case "wallet_only":
      return tryWallet();
    case "wallet_first": {
      const walletErr = await tryWallet();
      if (walletErr && walletErr.code === "insufficient_user_quota") return trySubscription();
      return walletErr;
    }
    case "subscription_first":
    default: {
      let hasSub = false;
      try {
        hasSub = await store.hasActiveUserSubscription(auth.user.id);
      } catch (err) {
        return taskErr("query_data_error", err instanceof Error ? err.message : String(err), 500, true);
      }
      if (!hasSub) return tryWallet();
      const subErr = await trySubscription();
      if (subErr && subErr.code === "insufficient_user_quota") {
        let allowOverflow = false;
        try {
          allowOverflow = await store.userActiveSubscriptionsAllowWalletOverflow(auth.user.id);
        } catch (err) {
          return taskErr("query_data_error", err instanceof Error ? err.message : String(err), 500, true);
        }
        if (allowOverflow) return tryWallet();
      }
      return subErr;
    }
  }
}

async function reserveNativeTask(
  store: Store,
  auth: AuthToken,
  billing: NativeTaskBillingSession,
  target: number,
): Promise<NativeTaskError | null> {
  if (!billing.started) return null;
  const extra = target - billing.preconsumed;
  if (extra <= 0) return null;
  if (billing.funding === "subscription") {
    try {
      await store.postConsumeUserSubscriptionDelta(billing.subscriptionId, extra);
    } catch (err) {
      return taskErr("insufficient_user_quota", insufficientSubscriptionMessage(err), 403, true);
    }
    const tokenHeld = await store.tryHoldTokenQuota(auth.token.id, extra, Boolean(Number(auth.token.unlimited_quota)));
    if (!tokenHeld) {
      await store.postConsumeUserSubscriptionDelta(billing.subscriptionId, -extra);
      return taskErr("insufficient_user_quota", "insufficient quota for adjusted task cost", 403, true);
    }
    billing.subscriptionPreConsumed += extra;
    billing.subscriptionAmountUsedAfter += extra;
  } else {
    await store.decreaseUserQuota(auth.user.id, extra);
    const tokenHeld = await store.tryHoldTokenQuota(auth.token.id, extra, Boolean(Number(auth.token.unlimited_quota)));
    if (!tokenHeld) {
      await store.releaseUserQuota(auth.user.id, extra);
      return taskErr("insufficient_user_quota", "insufficient quota for adjusted task cost", 403, true);
    }
    auth.user.quota -= extra;
  }
  auth.token.remain_quota -= extra;
  auth.token.used_quota += extra;
  billing.preconsumed += extra;
  billing.extraReserved += extra;
  return null;
}

async function settleNativeTask(store: Store, auth: AuthToken, billing: NativeTaskBillingSession, actual: number): Promise<void> {
  if (!billing.started) return;
  const delta = actual - billing.preconsumed;
  if (delta === 0) return;
  if (billing.funding === "subscription") {
    await store.postConsumeUserSubscriptionDelta(billing.subscriptionId, delta);
    billing.postDelta += delta;
  } else if (delta < 0) {
    const refund = -delta;
    await store.releaseUserQuota(auth.user.id, refund);
    auth.user.quota += refund;
  } else {
    await store.decreaseUserQuota(auth.user.id, delta);
    auth.user.quota -= delta;
  }
  if (delta < 0) {
    await store.releaseTokenQuota(auth.token.id, -delta);
    auth.token.remain_quota += -delta;
    auth.token.used_quota -= -delta;
  } else {
    await store.tryHoldTokenQuota(auth.token.id, delta, Boolean(Number(auth.token.unlimited_quota)));
    auth.token.remain_quota -= delta;
    auth.token.used_quota += delta;
  }
  billing.preconsumed = actual;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    out[key] = String(item);
  }
  return out;
}

function pluginMeta(engine: PluginEngine): Record<string, unknown> {
  try {
    const meta = engine.export("meta");
    return isPlainObject(meta) ? meta : {};
  } catch {
    return {};
  }
}

function allowedHosts(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.allowedHosts) ? meta.allowedHosts.map((item) => String(item)) : [];
}

function submitResponseTypes(meta: Record<string, unknown>): string[] {
  if (!("submitResponseTypes" in meta)) return ["json"];
  const items = meta.submitResponseTypes;
  if (!Array.isArray(items) || !items.length) return ["json"];
  return items.map((item) => String(item));
}

function requiredCapabilities(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.requiredCapabilities) ? meta.requiredCapabilities.map((item) => String(item)) : [];
}

function userAcceptsUnsetRatio(settingsRaw: unknown): boolean {
  const settings =
    typeof settingsRaw === "string"
      ? parseJson<Record<string, unknown>>(settingsRaw, {})
      : isPlainObject(settingsRaw)
        ? settingsRaw
        : {};
  return Boolean(settings.accept_unset_model_ratio_model);
}

function modelPriceNotConfigured(modelName: string, userRole: number): string {
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

/** Original `helper.HandleGroupRatio` + `helper.ModelPriceHelperPerCall` (task submit). */
export async function modelPriceHelperPerCall(
  store: Store,
  modelName: string,
  group: string,
  userRole: number,
  userSettings: unknown,
  userGroup = "",
): Promise<TaskPriceData | NativeTaskError> {
  const { groupRatio, groupSpecialRatio, hasSpecialRatio } = await handleGroupRatio(store, group, userGroup);
  const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  const modelPriceMap = parseJson<Record<string, number>>(await store.option("ModelPrice"), {});
  let priced = getModelPriceFromMap(modelName, modelPriceMap);
  let usePrice = priced.configured;
  let modelPrice = priced.price;
  let modelRatio = 0;
  if (!usePrice) {
    const defaults = getModelPriceFromMap(modelName, defaultModelPrice);
    if (defaults.configured) {
      modelPrice = defaults.price;
      usePrice = true;
    } else {
      const selfUse = await store.optionBool("SelfUseModeEnabled", false);
      const ratio = getModelRatioFromMap(
        modelName,
        parseJson<Record<string, number>>(await store.option("ModelRatio"), {}),
        selfUse,
      );
      if (!ratio.configured && !userAcceptsUnsetRatio(userSettings)) {
        return taskErr("model_price_error", modelPriceNotConfigured(ratio.name || modelName, userRole), 400, true);
      }
      modelRatio = ratio.ratio;
    }
  }
  let quota: number;
  let freeModel = false;
  let clamp: TaskPriceData["clamp"] = null;
  if (usePrice) {
    const checked = quotaFromFloatChecked(modelPrice * quotaPerUnit * groupRatio);
    quota = checked.quota;
    clamp = checked.clamp;
    if (groupRatio === 0 || modelPrice === 0) {
      quota = 0;
      freeModel = true;
    }
  } else {
    const checked = quotaFromFloatChecked((modelRatio / 2) * quotaPerUnit * groupRatio);
    quota = checked.quota;
    clamp = checked.clamp;
    modelPrice = -1;
    if (groupRatio === 0 || modelRatio === 0) {
      quota = 0;
      freeModel = true;
    }
  }
  return { quota, modelPrice, modelRatio, groupRatio, groupSpecialRatio, hasSpecialRatio, usePrice, freeModel, clamp };
}

export function shouldRetryNativeTaskRelay(err: NativeTaskError, remaining: number, suppress: boolean): boolean {
  if (err.noRetry) return false;
  if (remaining <= 0) return false;
  if (suppress) return false;
  if (err.statusCode === 429) return true;
  if (err.statusCode === 307) return true;
  if (Math.floor(err.statusCode / 100) === 5) {
    if (isAlwaysSkipRetryStatusCode(err.statusCode)) return false;
    return true;
  }
  if (err.statusCode === 400) return false;
  if (err.statusCode === 408) return false;
  if (err.localError) return false;
  if (Math.floor(err.statusCode / 100) === 2) return false;
  return true;
}

/** Original `TaskAdaptor.submitContext`. */
export async function buildNativeSubmitContext(opts: {
  engine: PluginEngine;
  requestContext: RouteRequestContext;
  requestBody: unknown;
  req: Request;
  info: NativeSubmitInfo;
  originTasks?: { taskId: string; upstreamTaskId: string; action: string; status: string; data: unknown }[];
}): Promise<Record<string, unknown>> {
  const meta = pluginMeta(opts.engine);
  const ctx = routeRequestJSValue(opts.requestContext);
  ctx.requestBody = pluginJsonValue(opts.requestBody ?? opts.requestContext.requestBody ?? {});
  ctx.requestHeaders = {
    "Content-Type": opts.req.headers.get("content-type") || "",
    Accept: opts.req.headers.get("accept") || "",
  };
  ctx.files = Array.isArray(opts.requestContext.files) ? pluginJsonValue(opts.requestContext.files) : [];
  ctx.action = opts.info.action;
  ctx.originTaskId = "";
  if (opts.originTasks?.length) {
    ctx.originTasks = opts.originTasks.map((ref) => ({
      taskId: ref.taskId,
      upstreamTaskId: ref.upstreamTaskId,
      action: ref.action,
      status: ref.status,
      data: ref.data,
    }));
  }
  ctx.publicTaskId = opts.info.publicTaskId;
  ctx.model = opts.info.originModelName;
  ctx.upstreamModel = opts.info.upstreamModelName;
  ctx.baseUrl = opts.info.channelBaseUrl;
  ctx.userSetting = {};
  const resolved = await resolvePluginAuth(meta, opts.info.apiKey, opts.info.proxy || "");
  if (resolved.authError) {
    ctx.authError = resolved.authError;
    return ctx;
  }
  ctx.auth = resolved.auth;
  ctx.authHeader = resolved.auth.authHeader;
  if (resolved.apiKey != null) ctx.apiKey = resolved.apiKey;
  return ctx;
}

export function descriptorFromHook(value: unknown): NativeSubmitDescriptor {
  const object = isPlainObject(value) ? value : {};
  return {
    responseType: String(object.responseType || ""),
    url: String(object.url || ""),
    method: String(object.method || ""),
    headers: stringMap(object.headers),
    body: Object.prototype.hasOwnProperty.call(object, "body") ? object.body : undefined,
    action: String(object.action || ""),
    model: String(object.model || ""),
    rewriteModel: String(object.rewriteModel || ""),
    bodyType: String(object.bodyType || ""),
    parts: parseNativeSubmitParts(object.parts),
  };
}

export function buildNativeSubmitDescriptor(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  channelBaseUrl: string,
): NativeSubmitDescriptor | NativeTaskError {
  let value: unknown;
  try {
    value = engine.call("buildSubmitRequest", submitContext);
  } catch (err) {
    return taskErr("plugin_request_invalid", hookMessage(err), 400, true);
  }
  const descriptor = descriptorFromHook(value);
  if (!descriptor.responseType) descriptor.responseType = "json";
  const allowed = submitResponseTypes(pluginMeta(engine));
  if (!allowed.includes(descriptor.responseType)) {
    return taskErr(
      "plugin_request_invalid",
      `plugin does not support submit response type ${JSON.stringify(descriptor.responseType)}`,
      400,
      true,
    );
  }
  if (!descriptor.url.trim()) return taskErr("plugin_request_invalid", "plugin returned an empty submit URL", 400, true);
  try {
    validateRequestURL(descriptor.url, channelBaseUrl, allowedHosts(pluginMeta(engine)));
  } catch (err) {
    return taskErr("plugin_request_invalid", hookMessage(err), 400, true);
  }
  return descriptor;
}

function responseHeaders(res: Response): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  res.headers.forEach((value, key) => {
    if (!headers[key]) headers[key] = [];
    headers[key].push(value);
  });
  return headers;
}

export function parseNativeSubmitResponse(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  statusCode: number,
  headers: Record<string, string[]>,
  body: unknown,
): NativeSubmitParsed | NativeTaskError {
  let value: unknown;
  try {
    value = engine.call("parseSubmitResponse", submitContext, { statusCode, headers, body });
  } catch (err) {
    return taskErr("plugin_submit_response_failed", hookMessage(err), 502, false);
  }
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "clientResponse")) {
    return taskErr("plugin_submit_response_invalid", "parseSubmitResponse must not return clientResponse", 502, true);
  }
  const object = isPlainObject(value) ? value : {};
  const taskId = String(object.taskId || "").trim();
  if (!taskId) return taskErr("plugin_submit_response_invalid", "plugin returned an empty taskId", 502, true);
  const taskData = object.taskData;
  if (taskData != null) {
    try {
      if (JSON.stringify(taskData).length > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) {
        return taskErr("plugin_submit_response_invalid", "task data exceeds size limit", 502, true);
      }
    } catch {
      return taskErr("plugin_submit_response_invalid", "task data exceeds size limit", 502, true);
    }
  }
  return {
    upstreamTaskId: taskId,
    taskData,
    pluginState: Object.prototype.hasOwnProperty.call(object, "state") ? object.state : undefined,
    immediate: isPlainObject(object.immediate) ? object.immediate : null,
  };
}

async function doNativeSubmitRequest(
  descriptor: NativeSubmitDescriptor,
  files: { field: string; filename: string; mimeType: string; data: Uint8Array }[] = [],
  opts?: { engine: PluginEngine; submitContext: Record<string, unknown> },
): Promise<{ status: number; headers: Record<string, string[]>; body: unknown; acceptedStream: boolean } | NativeTaskError> {
  const method = (descriptor.method || "POST").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(descriptor.headers)) headers.set(name, value);
  let body: BodyInit | undefined;
  try {
    const encoded = encodeNativeSubmitBody(descriptor, files);
    if (encoded.contentType) headers.set("Content-Type", encoded.contentType);
    if (encoded.body != null) body = encoded.body as unknown as BodyInit;
  } catch (err) {
    return taskErr("build_request_failed", hookMessage(err), 500, false);
  }
  let res: Response;
  try {
    res = await fetch(descriptor.url, { method, headers, body });
  } catch (err) {
    return taskErr("do_request_failed", hookMessage(err), 500, false);
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200) {
    return taskErr("fail_to_fetch_task", new TextDecoder().decode(raw), res.status, false);
  }
  const contentType = res.headers.get("content-type") || "";
  const mediaType = parseSubmitMediaType(contentType);
  const streaming = descriptor.responseType === "sse";
  const acceptedStream = streaming || mediaType === "text/event-stream";
  if (!streaming && acceptedStream) {
    return taskErr("plugin_submit_response_invalid", "unexpected SSE response for a JSON submission", 502, true, true);
  }
  if (streaming) {
    if (!opts) return taskErr("read_response_body_failed", "expected a text/event-stream submit response", 502, false, true);
    try {
      const parsedBody = readSubmitEvents({
        engine: opts.engine,
        driverContext: opts.submitContext,
        contentType,
        body: new TextDecoder().decode(raw),
        requiredCapabilities: requiredCapabilities(pluginMeta(opts.engine)),
      });
      return { status: res.status, headers: responseHeaders(res), body: parsedBody, acceptedStream: true };
    } catch (err) {
      return taskErr("read_response_body_failed", hookMessage(err), 502, false, true);
    }
  }
  if (raw.byteLength > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) {
    return taskErr("read_response_body_failed", "task submit response exceeds size limit", 502, false);
  }
  const text = new TextDecoder().decode(raw);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: responseHeaders(res), body: parsed, acceptedStream };
}

/** Original ParseResponse extractUsageOnComplete on immediate SUCCESS. */
export async function applyNativeSubmitCompletionUsage(
  engine: PluginEngine,
  parsed: NativeSubmitParsed,
  info: NativeSubmitInfo,
): Promise<void> {
  const immediate = parsed.immediate;
  if (!immediate || String(immediate.status || "") !== "SUCCESS") return;
  if (!engine.hasCallablePath("extractUsageOnComplete")) return;
  const privateData: Record<string, unknown> = { upstream_task_id: parsed.upstreamTaskId };
  if (parsed.pluginState != null) privateData.plugin_state = parsed.pluginState;
  const queryContext = await buildNativeQueryContext(
    engine,
    {
      task_id: info.publicTaskId,
      action: info.action,
      data: parsed.taskData,
      properties: {
        origin_model_name: info.originModelName,
        upstream_model_name: info.upstreamModelName,
      },
      private_data: privateData,
    },
    info.apiKey,
    info.channelBaseUrl,
    info.proxy || "",
  );
  if (isNativeQueryError(queryContext)) return;
  try {
    const facts = engine.call("extractUsageOnComplete", queryContext, pluginJsonValue(immediate), parsed.taskData);
    const result: NativeTaskInfo = {
      code: Number(immediate.code || 0) || 0,
      taskId: String(immediate.taskId || ""),
      status: String(immediate.status || ""),
      progress: String(immediate.progress || ""),
      reason: String(immediate.reason || ""),
      url: String(immediate.url || ""),
      remoteUrl: String(immediate.remoteUrl || ""),
      completionTokens: 0,
      totalTokens: 0,
    };
    applyCompletionUsageFacts(result, facts, info.upstreamModelName || info.originModelName, pluginMeta(engine));
    if (result.usageFacts) {
      immediate.usageFacts = result.usageFacts;
      immediate.usage_facts = result.usageFacts;
      immediate.completionTokens = result.completionTokens;
      immediate.totalTokens = result.totalTokens;
    }
  } catch {
    /* original retains reserved quota when the completion hook fails */
  }
}

function taskStatusFromImmediate(immediate: Record<string, unknown> | null): {
  status: string;
  progress: string;
  failReason: string;
} {
  if (!immediate) return { status: "NOT_START", progress: "0%", failReason: "" };
  return {
    status: String(immediate.status || "NOT_START"),
    progress: String(immediate.progress || "0%"),
    failReason: String(immediate.reason || ""),
  };
}

/** Original `controller.presentTaskSubmission`. */
export function presentTaskSubmission(opts: {
  engine: PluginEngine;
  requestContext: RouteRequestContext;
  render: string;
  taskRow: Record<string, unknown>;
  originModelName: string;
  otherRatios?: Record<string, number> | null;
  protocol?: string;
  operation?: string;
}): Response {
  const otherRatios = opts.otherRatios && Object.keys(opts.otherRatios).length ? opts.otherRatios : {};
  const extra: HeadersInit = { "X-New-Api-Other-Ratios": JSON.stringify(otherRatios) };
  if (opts.render) {
    try {
      const view = buildTaskPluginView(opts.taskRow);
      const body = opts.engine.callPath("native", [opts.render], [routeRequestJSValue(opts.requestContext), view]);
      return json(200, body, extra);
    } catch {
      /* host fallback */
    }
  }
  if (opts.protocol === "openai_video" && opts.operation === "create") {
    return json(200, openaiVideoView(opts.taskRow), extra);
  }
  const createdAt = Number(opts.taskRow.created_at || 0) || Number(opts.taskRow.submit_time || 0);
  return json(
    200,
    {
      id: String(opts.taskRow.task_id || ""),
      task_id: String(opts.taskRow.task_id || ""),
      status: "queued",
      model: opts.originModelName,
      created_at: createdAt,
    },
    extra,
  );
}

async function persistNativeTask(opts: {
  store: Store;
  auth: AuthToken;
  plugin: MatchedPlugin;
  engine: PluginEngine;
  info: NativeSubmitInfo;
  parsed: NativeSubmitParsed;
  quota: number;
  requestId: string;
  requestPath: string;
  otherRatios: Record<string, number>;
  price: TaskPriceData;
  snapshot?: BillingSnapshot | null;
  billing: NativeTaskBillingSession;
}): Promise<Record<string, unknown>> {
  const immediate = taskStatusFromImmediate(opts.parsed.immediate);
  const meta = pluginMeta(opts.engine);
  const snapshot = taskPluginSnapshotFromMeta(meta, opts.plugin);
  const privateData: Record<string, unknown> = {
    upstream_task_id: opts.parsed.upstreamTaskId,
    token_id: opts.auth.token.id,
    billing_source: opts.billing.funding,
    ...(opts.billing.funding === "subscription" && opts.billing.subscriptionId > 0
      ? { subscription_id: opts.billing.subscriptionId }
      : {}),
    execution: {
      request_id: opts.requestId,
      request_path: opts.requestPath,
      task_plugin: {
        key: snapshot.key,
        name: snapshot.name,
        version: snapshot.version,
        api_version: snapshot.apiVersion,
        generation: snapshot.generation,
        author: snapshot.author,
      },
    },
    billing_context: {
      model_price: opts.price.modelPrice,
      group_ratio: opts.price.groupRatio,
      model_ratio: opts.price.modelRatio,
      other_ratios: opts.otherRatios,
      origin_model_name: opts.info.originModelName,
      per_call_billing: opts.price.usePrice,
      ...(opts.snapshot ? { tiered_snapshot: billingSnapshotJSON(opts.snapshot) } : {}),
    },
  };
  if (opts.parsed.pluginState != null) privateData.plugin_state = opts.parsed.pluginState;
  if (opts.info.channelType === CHANNEL_TYPE_GEMINI || opts.info.channelType === CHANNEL_TYPE_VERTEX) {
    privateData.key = opts.info.apiKey;
  }
  if (opts.parsed.immediate && typeof opts.parsed.immediate.url === "string" && opts.parsed.immediate.url) {
    privateData.result_url = opts.parsed.immediate.url;
  }
  await opts.store.insertTask({
    task_id: opts.info.publicTaskId,
    user_id: opts.auth.user.id,
    token_id: opts.auth.token.id,
    channel_id: opts.info.channelId,
    group: opts.info.usingGroup,
    quota: opts.quota,
    platform: opts.plugin.key,
    action: opts.info.action,
    status: immediate.status,
    progress: immediate.progress,
    model_name: opts.info.originModelName,
    fail_reason: immediate.failReason,
    properties: {
      origin_model_name: opts.info.originModelName,
      upstream_model_name: opts.info.upstreamModelName,
    },
    data: opts.parsed.taskData ?? null,
    private_data: privateData,
  });
  return (
    (await opts.store.getTaskByTid(opts.info.publicTaskId)) || {
      task_id: opts.info.publicTaskId,
      status: immediate.status,
      progress: immediate.progress,
      platform: opts.plugin.key,
      data: opts.parsed.taskData,
      private_data: JSON.stringify(privateData),
    }
  );
}

async function relayTaskSubmitOnce(opts: {
  engine: PluginEngine;
  prepared: SubmitKind;
  req: Request;
  channel: ChannelRow;
  info: NativeSubmitInfo;
  store: Store;
  auth: AuthToken;
  billing: NativeTaskBillingSession;
  pluginKey: string;
}): Promise<
  | {
      parsed: NativeSubmitParsed;
      info: NativeSubmitInfo;
      otherRatios: Record<string, number>;
      quota: number;
      price: TaskPriceData;
      snapshot: BillingSnapshot | null;
    }
  | NativeTaskError
> {
  const info = { ...opts.info };
  let mapped = info.originModelName;
  try {
    mapped = mapModel(opts.channel.model_mapping, info.originModelName);
  } catch (err) {
    return taskErr("model_mapping_failed", hookMessage(err), 400, true);
  }
  info.upstreamModelName = mapped;
  info.isModelMapped = mapped !== info.originModelName;
  const submitContext = await buildNativeSubmitContext({
    engine: opts.engine,
    requestContext: opts.prepared.requestContext,
    requestBody: opts.prepared.requestBody,
    req: opts.req,
    info,
    originTasks: opts.prepared.origin.tasks,
  });
  const hasRequest = opts.prepared.requestBody != null;
  const hasProfiles = pluginHasUsageProfiles(opts.engine);
  if (hasRequest && !hasProfiles) {
    const usageErr = validateResolvedUsageRequest(opts.prepared.requestBody, "", pluginMeta(opts.engine));
    if (usageErr) return taskErr("plugin_usage_invalid", usageErr, 400, true);
  }
  const descriptor = buildNativeSubmitDescriptor(opts.engine, submitContext, info.channelBaseUrl);
  if ("statusCode" in descriptor) return descriptor;
  if (descriptor.action) info.action = descriptor.action;
  if (descriptor.model) info.originModelName = descriptor.model;
  if (descriptor.rewriteModel) info.upstreamModelName = descriptor.rewriteModel;
  submitContext.action = info.action;
  submitContext.model = info.originModelName;
  submitContext.upstreamModel = info.upstreamModelName;
  if (hasRequest && hasProfiles) {
    const usageErr = validateResolvedUsageRequest(
      opts.prepared.requestBody,
      info.upstreamModelName || info.originModelName,
      pluginMeta(opts.engine),
    );
    if (usageErr) return taskErr("plugin_usage_invalid", usageErr, 400, true);
  }

  const modelName = info.originModelName;
  const mappedModel = info.upstreamModelName || modelName;
  const billingMaps = {
    pluginExprs: parseJson<Record<string, string>>(await opts.store.option("billing_setting.plugin_billing_expr"), {}),
    modes: parseJson<Record<string, string>>(await opts.store.option("billing_setting.billing_mode"), {}),
    exprs: parseJson<Record<string, string>>(await opts.store.option("billing_setting.billing_expr"), {}),
    modelRatio: parseJson<Record<string, number>>(await opts.store.option("ModelRatio"), {}),
    modelPrice: parseJson<Record<string, number>>(await opts.store.option("ModelPrice"), {}),
  };
  const resolved = resolveTaskBillingExpr(opts.pluginKey, modelName, mappedModel, billingMaps);
  const useTiered = resolved.exists || getBillingMode(modelName, billingMaps.modes, billingMaps.modelRatio, billingMaps.modelPrice) === BILLING_MODE_TIERED_EXPR;
  let priced: TaskPriceData;
  let estimatedRatios: Record<string, number> = {};
  let snapshot: BillingSnapshot | null = null;
  let quota: number;
  if (useTiered) {
    if (usesFixedPricing(resolved.expr)) {
      return taskErr("model_price_error", "fixed pricing is not supported for task usage expressions", 400, false);
    }
    if (!resolved.exists) {
      return taskErr("model_price_error", `task model ${modelName} has no usage expression or meter`, 400, false);
    }
    const factsResult = extractUsageFactsValidated(opts.engine, submitContext, mappedModel);
    if ("error" in factsResult) return taskErr("plugin_usage_invalid", factsResult.error, 400, true);
    const facts = factsResult.facts && Object.keys(factsResult.facts).length ? factsResult.facts : {};
    let cost: number;
    let matchedTier = "";
    try {
      const ran = runExprWithRequest(resolved.expr, facts);
      cost = ran.cost;
      matchedTier = ran.matchedTier;
    } catch (err) {
      return taskErr("model_price_error", hookMessage(err), 400, false);
    }
    if (cost < 0) return taskErr("model_price_error", "negative task expression result", 400, false);
    const groupInfo = await handleGroupRatio(opts.store, info.usingGroup, opts.auth.user.group);
    const quotaPerUnit = (await opts.store.optionNum("QuotaPerUnit", 500000)) || 500000;
    const rounded = quotaRoundChecked(cost * quotaPerUnit * groupInfo.groupRatio);
    quota = rounded.quota;
    priced = {
      quota,
      modelPrice: 0,
      modelRatio: 0,
      groupRatio: groupInfo.groupRatio,
      groupSpecialRatio: groupInfo.groupSpecialRatio,
      hasSpecialRatio: groupInfo.hasSpecialRatio,
      usePrice: false,
      freeModel: false,
      clamp: rounded.clamp,
    };
    snapshot = {
      billingMode: BILLING_MODE_TIERED_EXPR,
      modelName,
      exprString: resolved.expr,
      exprHash: exprHashString(resolved.expr),
      groupRatio: groupInfo.groupRatio,
      estimatedPromptTokens: 0,
      estimatedCompletionTokens: 0,
      estimatedQuotaBeforeGroup: cost * quotaPerUnit,
      estimatedQuotaAfterGroup: quota,
      estimatedTier: matchedTier,
      quotaPerUnit,
      exprVersion: exprVersion(resolved.expr),
      taskUsageBilling: true,
      usageFacts: facts,
    };
  } else {
    const helper = await modelPriceHelperPerCall(
      opts.store,
      info.originModelName,
      info.usingGroup,
      opts.auth.user.role || 0,
      opts.auth.user.settings,
      opts.auth.user.group,
    );
    if ("statusCode" in helper) return helper;
    priced = helper;
    const estimated = estimateBillingValidated(
      opts.engine,
      submitContext,
      info.upstreamModelName || info.originModelName,
    );
    if ("error" in estimated) return taskErr("plugin_usage_invalid", estimated.error, 400, true);
    estimatedRatios = estimated.ratios && Object.keys(estimated.ratios).length ? estimated.ratios : {};
    quota = priced.quota;
    if (!priced.freeModel && Object.keys(estimatedRatios).length) {
      const checked = quotaFromFloatChecked(applyOtherRatiosToFloat(quota, estimatedRatios));
      quota = checked.quota;
      if (!priced.clamp) priced.clamp = checked.clamp;
    }
  }
  if (!priced.freeModel) {
    if (priced.clamp) return taskErr("model_price_error", quotaClampMessage(priced.clamp), 400, true);
    const holdErr = await preConsumeNativeTask(opts.store, opts.auth, opts.billing, quota);
    if (holdErr) return holdErr;
  }

  const upstream = await doNativeSubmitRequest(descriptor, opts.prepared.requestContext.fileContents || [], {
    engine: opts.engine,
    submitContext,
  });
  if ("statusCode" in upstream) return upstream;
  const parsed = parseNativeSubmitResponse(opts.engine, submitContext, upstream.status, upstream.headers, upstream.body);
  if ("statusCode" in parsed) {
    if (upstream.acceptedStream) parsed.noRetry = true;
    return parsed;
  }
  await applyNativeSubmitCompletionUsage(opts.engine, parsed, info);
  if (parsed.immediate && String(parsed.immediate.status || "") === "FAILURE") {
    quota = 0;
  } else if (snapshot) {
    const immediateFacts = isPlainObject(parsed.immediate?.usageFacts)
      ? parsed.immediate.usageFacts
      : isPlainObject(parsed.immediate?.usage_facts)
        ? parsed.immediate.usage_facts
        : null;
    if (parsed.immediate && String(parsed.immediate.status || "") === "SUCCESS" && immediateFacts && Object.keys(immediateFacts).length) {
      try {
        const settled = evaluateTaskCompletionUsage(snapshot, immediateFacts);
        quota = settled.result.actualQuotaAfterGroup;
        snapshot.usageFacts = settled.usage;
        snapshot.estimatedTier = settled.result.matchedTier;
        if (!priced.clamp) priced.clamp = settled.result.clamp;
      } catch {
        /* original retains reserved quota when immediate usage settlement fails */
      }
    }
  } else {
    const billed = applyRelayTaskSubmitBilling({
      engine: opts.engine,
      submitContext,
      modelName: info.upstreamModelName || info.originModelName,
      taskData: parsed.taskData,
      immediate: parsed.immediate,
      quota,
      otherRatios: estimatedRatios,
    });
    quota = billed.quota;
    estimatedRatios = billed.otherRatios;
    if (!priced.clamp) priced.clamp = billed.clamp;
  }
  return { parsed, info, otherRatios: estimatedRatios, quota, price: priced, snapshot };
}

function nativeSubmitError(prepared: SubmitKind, engine: PluginEngine, err: NativeTaskError, requestId: string): Response {
  if (prepared.protocol === "openai_responses") return pluginProtocolSubmissionError(err);
  if (prepared.protocol || prepared.pinnedRoute === false) return taskErrorJson(err.statusCode, err.code, err.message);
  return respondTaskPluginError(engine, prepared.requestContext, err.statusCode, err.message, requestId);
}

/** Original `middleware.Distribute` `abortWithOpenAiMessage` before `RelayTask`. */
function distributorAbortChannelError(
  prepared: SubmitKind,
  engine: PluginEngine,
  err: { status: number; code: string; message: string },
  requestId: string,
): Response {
  if (!prepared.protocol && prepared.pinnedRoute !== false) {
    return respondTaskPluginError(engine, prepared.requestContext, err.status, err.message, requestId);
  }
  return abortWithOpenAiMessage(err.status, err.message, err.code, requestId);
}

function getChannelFailedRetryError(selectGroup: string, model: string, error?: string): NativeTaskError {
  const message = error
    ? getChannelRetryFailedMessage(selectGroup, model, error)
    : noAvailableChannelRetryMessage(selectGroup, model);
  return taskErr("get_channel_failed", message, 500, true, true);
}

export type NativeTaskPersistOutcome = {
  row: Record<string, unknown>;
  originModelName: string;
  otherRatios: Record<string, number>;
  engine: PluginEngine;
};

/** Original `TaskAdaptor.ValidateRequestAndSetAction` final protocol decode. */
export function validateFinalProtocolDecoder(
  engine: PluginEngine,
  protocol: string,
  pinnedModel: string,
  protocolContext: ProtocolRequestContext,
): { requestBody?: unknown; action?: string } | NativeTaskError {
  let resolvedValue: unknown;
  try {
    resolvedValue = engine.callPath("protocols", [protocol, "decodeRequest"], [protocolRequestJSValue(protocolContext)]);
  } catch (err) {
    return taskErr("plugin_request_invalid", hookMessage(err), 400, true);
  }
  if (!isPlainObject(resolvedValue) || typeof resolvedValue.model !== "string" || resolvedValue.model !== pinnedModel) {
    return taskErr("plugin_request_invalid", "final task plugin decoder rejected the pinned model", 400, true);
  }
  if (Object.prototype.hasOwnProperty.call(resolvedValue, "renderer")) {
    return taskErr("plugin_request_invalid", "decoder must not return renderer", 400, true);
  }
  const out: { requestBody?: unknown; action?: string } = {};
  if (Object.prototype.hasOwnProperty.call(resolvedValue, "requestBody")) out.requestBody = resolvedValue.requestBody;
  if (typeof resolvedValue.action === "string" && resolvedValue.action.trim()) out.action = resolvedValue.action;
  return out;
}

/** Original `controller.executeTaskSubmission` native persist without presenting. */
export async function executeNativeTaskSubmission(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  plugin: MatchedPlugin,
  prepared: SubmitKind,
  requestId: string,
): Promise<NativeTaskPersistOutcome | { error: Response }> {
  const path = new URL(req.url).pathname;
  const engine = prepared.engine;
  if (prepared.protocol && prepared.protocolContext) {
    const decoded = validateFinalProtocolDecoder(engine, prepared.protocol, prepared.model, prepared.protocolContext);
    if ("statusCode" in decoded) return { error: nativeSubmitError(prepared, engine, decoded, requestId) };
    if (Object.prototype.hasOwnProperty.call(decoded, "requestBody")) prepared.requestBody = decoded.requestBody;
    if (decoded.action) prepared.action = decoded.action;
  }
  const model = prepared.model;
  if (!tokenAllowsModel(auth.token, model)) {
    return {
      error: distributorAbortChannelError(
        prepared,
        engine,
        { status: 403, code: "", message: tokenModelForbiddenMessage(req, model) },
        requestId,
      ),
    };
  }

  const selected = await selectDistributedChannel({
    store,
    env,
    req,
    auth,
    model,
    requestPath: path,
    body: prepared.requestBody,
    headers: requestHeadersFrom(req),
    expectedTaskPluginKey: plugin.key,
    taskPluginChannelTypes: plugin.channelTypes,
    originPin: prepared.origin.pin,
  });
  if (selected.error) {
    return { error: distributorAbortChannelError(prepared, engine, selected.error, requestId) };
  }
  auth.usingGroup = selected.usingGroup;
  let channel = selected.channel;
  if (!channel) {
    return {
      error: distributorAbortChannelError(
        prepared,
        engine,
        {
          status: 503,
          code: "model_not_found",
          message: noAvailableChannelMessage(req, auth.usingGroup, model),
        },
        requestId,
      ),
    };
  }

  const retryTimes = await store.optionNum("RetryTimes", 0);
  const suppress = selected.pinRetryMode === PIN_RETRY_SINGLE_ATTEMPT;
  const publicTaskId = generateTaskID();
  let lastErr: NativeTaskError | null = null;
  let outcome: {
    parsed: NativeSubmitParsed;
    info: NativeSubmitInfo;
    otherRatios: Record<string, number>;
    quota: number;
    price: TaskPriceData;
    snapshot: BillingSnapshot | null;
  } | null = null;
  const billing = emptyNativeTaskBilling(requestId);

  for (let attempt = 0; attempt <= retryTimes; attempt++) {
    if (!channel) break;
    const apiKey = pickChannelKey(channel.key);
    const info: NativeSubmitInfo = {
      originModelName: model,
      upstreamModelName: model,
      action: prepared.action,
      publicTaskId,
      apiKey,
      channelBaseUrl: resolveBaseUrl(channel.type, channel.base_url),
      channelId: channel.id,
      channelType: channel.type,
      usingGroup: auth.usingGroup,
      isModelMapped: false,
      proxy: channelSettingProxy(channel.setting),
    };
    const result = await relayTaskSubmitOnce({ engine, prepared, req, channel, info, store, auth, billing, pluginKey: plugin.key });
    if (!("statusCode" in result)) {
      outcome = result;
      lastErr = null;
      break;
    }
    lastErr = result;
    const remaining = retryTimes - attempt;
    if (!shouldRetryNativeTaskRelay(result, remaining, suppress)) break;
    if (!selected.pinned) {
      increaseChannelSelectRetry(selected.selectState);
      const next = await cacheGetRandomSatisfiedChannel(store, selected.selectParam, selected.selectState);
      if (next.error || !next.channel) {
        lastErr = getChannelFailedRetryError(next.selectGroup || auth.usingGroup, model, next.error);
        break;
      }
      channel = next.channel;
      if (next.selectGroup && next.selectGroup !== "auto") auth.usingGroup = next.selectGroup;
    }
  }

  if (lastErr) {
    await refundNativeTaskBilling(store, auth, billing);
    return { error: nativeSubmitError(prepared, engine, lastErr, requestId) };
  }
  if (!outcome) {
    await refundNativeTaskBilling(store, auth, billing);
    return { error: nativeSubmitError(prepared, engine, taskErr("task_submit_failed", "task submission returned no result", 500, true), requestId) };
  }

  const reserveErr = await reserveNativeTask(store, auth, billing, outcome.quota);
  if (reserveErr) {
    await refundNativeTaskBilling(store, auth, billing);
    return { error: nativeSubmitError(prepared, engine, reserveErr, requestId) };
  }

  let row: Record<string, unknown>;
  try {
    row = await persistNativeTask({
      store,
      auth,
      plugin,
      engine,
      info: outcome.info,
      parsed: outcome.parsed,
      quota: outcome.quota,
      requestId,
      requestPath: path,
      otherRatios: outcome.otherRatios,
      price: outcome.price,
      snapshot: outcome.snapshot,
      billing,
    });
  } catch (err) {
    await refundNativeTaskBilling(store, auth, billing);
    return { error: nativeSubmitError(prepared, engine, taskErr("task_insert_failed", hookMessage(err), 500, true), requestId) };
  }

  try {
    await settleNativeTask(store, auth, billing, outcome.quota);
  } catch {
    return {
      error: nativeSubmitError(
        prepared,
        engine,
        taskErr("task_billing_settlement_failed", "failed to settle task billing", 500, true),
        requestId,
      ),
    };
  }

  try {
    const meta = pluginMeta(engine);
    await logTaskConsumption({
      store,
      user: auth.user,
      tokenName: auth.token.name,
      tokenId: auth.token.id,
      channelId: outcome.info.channelId,
      group: outcome.info.usingGroup,
      ip: clientIp(req),
      requestId,
      input: {
        action: outcome.info.action,
        requestPath: path,
        originModelName: outcome.info.originModelName,
        upstreamModelName: outcome.info.upstreamModelName,
        isModelMapped: outcome.info.isModelMapped,
        price: { ...outcome.price, quota: outcome.quota },
        otherRatios: outcome.otherRatios,
        quota: outcome.quota,
        taskId: outcome.info.publicTaskId,
        upstreamTaskId: outcome.parsed.upstreamTaskId,
        plugin: taskPluginSnapshotFromMeta(meta, plugin),
        perCall: outcome.price.usePrice,
        billing: billingLogFromSession(billing),
        tiered: outcome.snapshot
          ? {
              exprString: outcome.snapshot.exprString,
              estimatedTier: outcome.snapshot.estimatedTier,
              usageFacts: outcome.snapshot.usageFacts,
            }
          : null,
      },
    });
  } catch {
    /* Original RecordConsumeLog failures are logged, not returned to the client. */
  }

  return { row, originModelName: outcome.info.originModelName, otherRatios: outcome.otherRatios, engine };
}

/** Original `controller.RelayTask` native submit after `PrepareTaskPluginRoute`. */
export async function continueNativeSubmit(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  plugin: MatchedPlugin,
  prepared: SubmitKind,
  requestId: string,
): Promise<Response> {
  const result = await executeNativeTaskSubmission(req, env, store, auth, plugin, prepared, requestId);
  if ("error" in result) return result.error;
  return presentTaskSubmission({
    engine: result.engine,
    requestContext: prepared.requestContext,
    render: String(plugin.route?.render || ""),
    taskRow: result.row,
    originModelName: result.originModelName,
    otherRatios: result.otherRatios,
    protocol: prepared.protocol,
    operation: prepared.operation,
  });
}
