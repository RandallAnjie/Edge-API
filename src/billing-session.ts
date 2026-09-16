/**
 * Original `service.PreConsumeBilling` / `NewBillingSession` / `BillingSession`
 * wallet hold, settle-delta, and refund on workerd.
 */
import {
  getTrustQuota,
  insufficientTokenQuotaMessage,
  insufficientWalletQuotaMessage,
  storeFormatQuota,
} from "./quota.js";
import { normalizeBillingPreference } from "./subscription.js";
import type { Store } from "./store.js";
import type { AuthToken } from "./types.js";

export const BILLING_SOURCE_WALLET = "wallet";
export const BILLING_SOURCE_SUBSCRIPTION = "subscription";

export type BillingError = {
  status: number;
  message: string;
  code: string;
};

/** Original `service.BillingSession`. */
export type BillingSession = {
  preConsumedQuota: number;
  tokenConsumed: number;
  extraReserved: number;
  trusted: boolean;
  fundingSettled: boolean;
  settled: boolean;
  refunded: boolean;
  funding: "wallet" | "subscription";
  requestId: string;
  playground: boolean;
  forcePreConsume: boolean;
  subscriptionId: number;
  subscriptionPreConsumed: number;
  subscriptionAmountTotal: number;
  subscriptionAmountUsedAfter: number;
  subscriptionPlanId: number;
  subscriptionPlanTitle: string;
  billingPreference: string;
  postDelta: number;
};

export type BillingSessionOpts = {
  requestId: string;
  quota: number;
  playground?: boolean;
  forcePreConsume?: boolean;
  billingModelName?: string;
};

function billingErr(status: number, message: string, code: string): BillingError {
  return { status, message, code };
}

export function emptyBillingSession(requestId: string, playground = false): BillingSession {
  return {
    preConsumedQuota: 0,
    tokenConsumed: 0,
    extraReserved: 0,
    trusted: false,
    fundingSettled: false,
    settled: false,
    refunded: false,
    funding: BILLING_SOURCE_WALLET,
    requestId,
    playground,
    forcePreConsume: false,
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

function userBillingPreference(user: { billing_preference?: string; settings?: string }): string {
  let settingsPref = "";
  try {
    const settings = JSON.parse(String(user.settings || "")) as { billing_preference?: string };
    if (settings && typeof settings === "object") settingsPref = String(settings.billing_preference || "");
  } catch {
    settingsPref = "";
  }
  return normalizeBillingPreference(user.billing_preference || settingsPref);
}

function insufficientSubscriptionMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `订阅额度不足或未配置订阅: ${msg}`;
}

/** Original `BillingSession.shouldTrust`. */
export function shouldTrustWallet(opts: {
  forcePreConsume: boolean;
  trustQuota: number;
  tokenUnlimited: boolean;
  tokenQuota: number;
  userQuota: number;
  funding: "wallet" | "subscription";
}): boolean {
  if (opts.forcePreConsume) return false;
  if (opts.trustQuota <= 0) return false;
  const tokenTrusted = opts.tokenUnlimited || opts.tokenQuota > opts.trustQuota;
  if (!tokenTrusted) return false;
  if (opts.funding === BILLING_SOURCE_SUBSCRIPTION) return false;
  if (opts.funding !== BILLING_SOURCE_WALLET) return false;
  return opts.userQuota > opts.trustQuota;
}

function needsRefund(session: BillingSession): boolean {
  if (session.settled || session.refunded || session.fundingSettled) return false;
  if (session.tokenConsumed > 0) return true;
  if (session.funding === BILLING_SOURCE_SUBSCRIPTION && session.subscriptionPreConsumed > 0) return true;
  return false;
}

async function rollbackTokenHold(store: Store, auth: AuthToken, session: BillingSession, amount: number): Promise<void> {
  if (amount <= 0 || session.playground) return;
  await store.releaseTokenQuota(auth.token.id, amount);
  auth.token.remain_quota += amount;
  auth.token.used_quota -= amount;
}

async function holdTokenQuota(
  store: Store,
  auth: AuthToken,
  session: BillingSession,
  quota: number,
): Promise<BillingError | null> {
  if (quota <= 0 || session.playground) return null;
  const unlimited = Boolean(Number(auth.token.unlimited_quota));
  const held = await store.tryHoldTokenQuota(auth.token.id, quota, unlimited);
  if (held) {
    auth.token.remain_quota -= quota;
    auth.token.used_quota += quota;
    session.tokenConsumed += quota;
    return null;
  }
  const token = await store.getTokenById(auth.token.id);
  const remain = token ? Number(token.remain_quota || 0) : 0;
  return billingErr(
    403,
    insufficientTokenQuotaMessage(await storeFormatQuota(store, remain), await storeFormatQuota(store, quota)),
    "pre_consume_token_quota_failed",
  );
}

async function tryWalletPreConsume(
  store: Store,
  auth: AuthToken,
  session: BillingSession,
  quota: number,
): Promise<BillingError | null> {
  const fresh = await store.getUserById(auth.user.id);
  if (!fresh) return billingErr(500, "user not found", "query_data_error");
  const remain = Number(fresh.quota || 0);
  auth.user.quota = remain;
  const formattedRemain = await storeFormatQuota(store, remain);
  const formattedNeed = await storeFormatQuota(store, quota);
  if (remain <= 0) {
    return billingErr(403, insufficientWalletQuotaMessage(remain, quota, formattedRemain, formattedNeed), "insufficient_user_quota");
  }
  if (remain - quota < 0) {
    return billingErr(403, insufficientWalletQuotaMessage(remain, quota, formattedRemain, formattedNeed), "insufficient_user_quota");
  }
  session.funding = BILLING_SOURCE_WALLET;
  return preConsume(store, auth, session, quota);
}

async function trySubscriptionPreConsume(
  store: Store,
  auth: AuthToken,
  session: BillingSession,
  quota: number,
): Promise<BillingError | null> {
  const subConsume = quota > 0 ? quota : 1;
  session.funding = BILLING_SOURCE_SUBSCRIPTION;
  return preConsume(store, auth, session, subConsume);
}

async function preConsume(
  store: Store,
  auth: AuthToken,
  session: BillingSession,
  quota: number,
): Promise<BillingError | null> {
  let effectiveQuota = quota;
  const unit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  if (
    shouldTrustWallet({
      forcePreConsume: session.forcePreConsume,
      trustQuota: getTrustQuota(unit),
      tokenUnlimited: Boolean(Number(auth.token.unlimited_quota)),
      tokenQuota: Number(auth.token.remain_quota || 0),
      userQuota: Number(auth.user.quota || 0),
      funding: session.funding,
    })
  ) {
    session.trusted = true;
    effectiveQuota = 0;
  }

  if (effectiveQuota > 0) {
    const tokenErr = await holdTokenQuota(store, auth, session, effectiveQuota);
    if (tokenErr) return tokenErr;
  }

  if (session.funding === BILLING_SOURCE_SUBSCRIPTION) {
    try {
      const result = await store.preConsumeUserSubscription(session.requestId, auth.user.id, quota > 0 ? quota : 1);
      session.subscriptionId = result.userSubscriptionId;
      session.subscriptionPreConsumed = result.preConsumed;
      session.subscriptionAmountTotal = result.amountTotal;
      session.subscriptionAmountUsedAfter = result.amountUsedAfter;
      const plan = await store.getSubscriptionPlanInfoByUserSubscriptionId(result.userSubscriptionId);
      session.subscriptionPlanId = plan?.planId || 0;
      session.subscriptionPlanTitle = plan?.planTitle || "";
    } catch (err) {
      await rollbackTokenHold(store, auth, session, session.tokenConsumed);
      session.tokenConsumed = 0;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no active subscription") || msg.includes("subscription quota insufficient")) {
        return billingErr(403, insufficientSubscriptionMessage(err), "insufficient_user_quota");
      }
      return billingErr(500, msg, "update_data_error");
    }
    session.preConsumedQuota = quota > 0 ? quota : 1;
    return null;
  }

  if (effectiveQuota > 0) {
    const userHeld = await store.tryHoldUserQuota(auth.user.id, effectiveQuota);
    if (!userHeld) {
      await rollbackTokenHold(store, auth, session, session.tokenConsumed);
      session.tokenConsumed = 0;
      const fresh = await store.getUserById(auth.user.id);
      const remain = fresh ? Number(fresh.quota || 0) : 0;
      return billingErr(
        403,
        insufficientWalletQuotaMessage(remain, effectiveQuota, await storeFormatQuota(store, remain), await storeFormatQuota(store, effectiveQuota)),
        "insufficient_user_quota",
      );
    }
    auth.user.quota -= effectiveQuota;
  }
  session.preConsumedQuota = effectiveQuota;
  return null;
}

/** Original `service.PreConsumeBilling` + `NewBillingSession`. */
export async function preConsumeBilling(
  store: Store,
  auth: AuthToken,
  opts: BillingSessionOpts,
): Promise<{ session: BillingSession; error?: undefined } | { session?: undefined; error: BillingError }> {
  if (opts.quota < 0) {
    return { error: billingErr(400, `pre-consume quota cannot be negative: ${opts.quota}`, "model_price_error") };
  }
  const session = emptyBillingSession(opts.requestId, Boolean(opts.playground));
  session.forcePreConsume = Boolean(opts.forcePreConsume);
  session.billingPreference = userBillingPreference(auth.user);
  const tryWallet = () => tryWalletPreConsume(store, auth, session, opts.quota);
  const trySubscription = () => trySubscriptionPreConsume(store, auth, session, opts.quota);
  let err: BillingError | null = null;
  switch (session.billingPreference) {
    case "subscription_only":
      err = await trySubscription();
      break;
    case "wallet_only":
      err = await tryWallet();
      break;
    case "wallet_first": {
      err = await tryWallet();
      if (err && err.code === "insufficient_user_quota") err = await trySubscription();
      break;
    }
    case "subscription_first":
    default: {
      let hasSub = false;
      try {
        hasSub = await store.hasActiveUserSubscription(auth.user.id);
      } catch (e) {
        return { error: billingErr(500, e instanceof Error ? e.message : String(e), "query_data_error") };
      }
      if (!hasSub) {
        err = await tryWallet();
        break;
      }
      err = await trySubscription();
      if (err && err.code === "insufficient_user_quota") {
        let allowOverflow = false;
        try {
          allowOverflow = await store.userActiveSubscriptionsAllowWalletOverflow(auth.user.id);
        } catch (e) {
          return { error: billingErr(500, e instanceof Error ? e.message : String(e), "query_data_error") };
        }
        if (allowOverflow) err = await tryWallet();
      }
      break;
    }
  }
  if (err) return { error: err };
  return { session };
}

/** Original `service.SettleBilling` / `BillingSession.Settle`. */
export async function settleBilling(store: Store, auth: AuthToken, session: BillingSession | null | undefined, actualQuota: number): Promise<void> {
  if (!session || session.settled) return;
  const delta = actualQuota - session.preConsumedQuota;
  if (delta === 0) {
    session.settled = true;
    return;
  }
  if (!session.fundingSettled) {
    if (session.funding === BILLING_SOURCE_SUBSCRIPTION) {
      await store.postConsumeUserSubscriptionDelta(session.subscriptionId, delta);
      session.postDelta += delta;
    } else if (delta > 0) {
      await store.decreaseUserQuota(auth.user.id, delta);
      auth.user.quota -= delta;
    } else {
      await store.releaseUserQuota(auth.user.id, -delta);
      auth.user.quota += -delta;
    }
    session.fundingSettled = true;
  }
  if (!session.playground) {
    if (delta > 0) {
      await store.decreaseTokenQuota(auth.token.id, delta);
      auth.token.remain_quota -= delta;
      auth.token.used_quota += delta;
    } else {
      await store.releaseTokenQuota(auth.token.id, -delta);
      auth.token.remain_quota += -delta;
      auth.token.used_quota -= -delta;
    }
  }
  session.preConsumedQuota = actualQuota;
  session.settled = true;
}

/** Original `BillingSession.Refund`. */
export async function refundBilling(store: Store, auth: AuthToken, session: BillingSession | null | undefined): Promise<void> {
  if (!session || session.settled || session.refunded || !needsRefund(session)) return;
  session.refunded = true;
  if (session.funding === BILLING_SOURCE_SUBSCRIPTION) {
    if (session.requestId) {
      try {
        await store.refundSubscriptionPreConsume(session.requestId);
      } catch {
        /* original logs refund errors */
      }
    }
    if (session.extraReserved > 0 && session.subscriptionId > 0) {
      try {
        await store.postConsumeUserSubscriptionDelta(session.subscriptionId, -session.extraReserved);
      } catch {
        /* original logs refund errors */
      }
    }
  } else if (session.preConsumedQuota > 0) {
    await store.releaseUserQuota(auth.user.id, session.preConsumedQuota);
    auth.user.quota += session.preConsumedQuota;
  }
  if (session.tokenConsumed > 0 && !session.playground) {
    await store.releaseTokenQuota(auth.token.id, session.tokenConsumed);
    auth.token.remain_quota += session.tokenConsumed;
    auth.token.used_quota -= session.tokenConsumed;
  }
  session.preConsumedQuota = 0;
  session.tokenConsumed = 0;
  session.extraReserved = 0;
}

export function billingSessionLogFields(session: BillingSession | null | undefined): {
  billingSource: string;
  billingPreference?: string;
  subscriptionId?: number;
  subscriptionPreConsumed?: number;
  subscriptionPostDelta?: number;
  subscriptionPlanId?: number;
  subscriptionPlanTitle?: string;
  subscriptionAmountTotal?: number;
  subscriptionAmountUsedAfterPreConsume?: number;
} {
  if (!session) return { billingSource: BILLING_SOURCE_WALLET };
  return {
    billingSource: session.funding,
    billingPreference: session.billingPreference,
    subscriptionId: session.subscriptionId,
    subscriptionPreConsumed: session.subscriptionPreConsumed,
    subscriptionPostDelta: session.postDelta,
    subscriptionPlanId: session.subscriptionPlanId,
    subscriptionPlanTitle: session.subscriptionPlanTitle,
    subscriptionAmountTotal: session.subscriptionAmountTotal,
    subscriptionAmountUsedAfterPreConsume: session.subscriptionAmountUsedAfter,
  };
}
