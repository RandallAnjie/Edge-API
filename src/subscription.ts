import { nowSec, parseJson } from "./constants.js";

export const PAYMENT_COMPLIANCE_REQUIRED =
  "支付、兑换码、订阅计划和邀请返利功能已禁用。管理员需先确认合规声明后方可启用。";

export function normalizeBillingPreference(pref: unknown): string {
  switch (String(pref || "").trim()) {
    case "subscription_first":
    case "wallet_first":
    case "subscription_only":
    case "wallet_only":
      return String(pref).trim();
    default:
      return "subscription_first";
  }
}

export function normalizeResetPeriod(period: unknown): string {
  switch (String(period || "").trim()) {
    case "daily":
    case "weekly":
    case "monthly":
    case "custom":
      return String(period).trim();
    default:
      return "never";
  }
}

function asBool(v: unknown, fallback = true): boolean {
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v == null || v === "") return fallback;
  return Boolean(v);
}

function asInt(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function planFieldsFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.plan && typeof body.plan === "object" && !Array.isArray(body.plan) ? (body.plan as Record<string, unknown>) : null;
  const src = nested || body;
  const durationDays = asInt(src.duration_days || src.duration_value, 0);
  const durationUnit = String(src.duration_unit || (src.duration_days != null ? "day" : "month") || "month");
  const durationValue = asInt(src.duration_value, durationUnit === "day" && durationDays ? durationDays : durationDays || 1);
  const totalAmount = asInt(src.total_amount != null ? src.total_amount : src.grant_quota, 0);
  return {
    title: String(src.title || "").trim(),
    subtitle: String(src.subtitle || src.description || ""),
    price_amount: Number(src.price_amount != null ? src.price_amount : 0),
    currency: "USD",
    duration_unit: durationUnit,
    duration_value: durationValue <= 0 && durationUnit !== "custom" ? 1 : durationValue,
    custom_seconds: asInt(src.custom_seconds, 0),
    enabled: asBool(src.enabled, true) ? 1 : 0,
    sort_order: asInt(src.sort_order, 0),
    allow_balance_pay: asBool(src.allow_balance_pay, true) ? 1 : 0,
    allow_wallet_overflow: asBool(src.allow_wallet_overflow, true) ? 1 : 0,
    stripe_price_id: String(src.stripe_price_id || ""),
    creem_product_id: String(src.creem_product_id || ""),
    waffo_pancake_product_id: String(src.waffo_pancake_product_id || ""),
    max_purchase_per_user: asInt(src.max_purchase_per_user, 0),
    upgrade_group: String(src.upgrade_group || "").trim(),
    downgrade_group: String(src.downgrade_group || "").trim(),
    total_amount: totalAmount,
    quota_reset_period: normalizeResetPeriod(src.quota_reset_period),
    quota_reset_custom_seconds: asInt(src.quota_reset_custom_seconds, 0),
    description: String(src.description || src.subtitle || ""),
    price_quota: asInt(src.price_quota, 0),
    duration_days: asInt(src.duration_days, durationUnit === "day" ? durationValue : durationUnit === "month" ? durationValue * 30 : 30),
    grant_quota: totalAmount,
    group: String(src.group || src.upgrade_group || ""),
    models: String(src.models || ""),
  };
}

export function publicPlan(row: Record<string, unknown>): Record<string, unknown> {
  const durationUnit = String(row.duration_unit || (Number(row.duration_days) ? "day" : "month") || "month");
  const durationValue = asInt(row.duration_value, asInt(row.duration_days, 1) || 1);
  const totalAmount = asInt(row.total_amount != null && row.total_amount !== 0 ? row.total_amount : row.grant_quota, 0);
  return {
    id: asInt(row.id),
    title: String(row.title || ""),
    subtitle: String(row.subtitle || row.description || ""),
    price_amount: Number(row.price_amount != null ? row.price_amount : 0),
    currency: String(row.currency || "USD") || "USD",
    duration_unit: durationUnit,
    duration_value: durationValue,
    custom_seconds: asInt(row.custom_seconds, 0),
    enabled: asBool(row.enabled, true),
    sort_order: asInt(row.sort_order, 0),
    allow_balance_pay: asBool(row.allow_balance_pay, true),
    allow_wallet_overflow: asBool(row.allow_wallet_overflow, true),
    stripe_price_id: String(row.stripe_price_id || ""),
    creem_product_id: String(row.creem_product_id || ""),
    waffo_pancake_product_id: String(row.waffo_pancake_product_id || ""),
    max_purchase_per_user: asInt(row.max_purchase_per_user, 0),
    upgrade_group: String(row.upgrade_group || row.group || ""),
    downgrade_group: String(row.downgrade_group || ""),
    total_amount: totalAmount,
    quota_reset_period: normalizeResetPeriod(row.quota_reset_period),
    quota_reset_custom_seconds: asInt(row.quota_reset_custom_seconds, 0),
    created_at: asInt(row.created_at, 0),
    updated_at: asInt(row.updated_at, asInt(row.created_at, 0)),
  };
}

export function wrapPlan(row: Record<string, unknown>): { plan: Record<string, unknown> } {
  return { plan: publicPlan(row) };
}

export function subscriptionStatus(row: Record<string, unknown>, now = nowSec()): string {
  const raw = String(row.status ?? "");
  if (raw === "cancelled" || raw === "expired" || raw === "active") return raw;
  if (raw === "2" || Number(row.status) === 2) return "cancelled";
  const end = asInt(row.end_time != null && row.end_time !== 0 ? row.end_time : row.expire_at, 0);
  if (end > 0 && end <= now) return "expired";
  return "active";
}

export function publicUserSubscription(row: Record<string, unknown>, now = nowSec()): Record<string, unknown> {
  const start = asInt(row.start_time != null && row.start_time !== 0 ? row.start_time : row.start_at, 0);
  const end = asInt(row.end_time != null && row.end_time !== 0 ? row.end_time : row.expire_at, 0);
  const amountTotal = asInt(row.amount_total != null && row.amount_total !== 0 ? row.amount_total : row.remaining_quota, 0);
  return {
    id: asInt(row.id),
    user_id: asInt(row.user_id),
    plan_id: asInt(row.plan_id),
    status: subscriptionStatus(row, now),
    source: String(row.source || "order"),
    start_time: start,
    end_time: end,
    amount_total: amountTotal,
    amount_used: asInt(row.amount_used, 0),
    next_reset_time: asInt(row.next_reset_time, 0),
    last_reset_time: asInt(row.last_reset_time, 0),
    upgrade_group: String(row.upgrade_group || ""),
    prev_user_group: String(row.prev_user_group || ""),
    downgrade_group: String(row.downgrade_group || ""),
    allow_wallet_overflow: asBool(row.allow_wallet_overflow, true),
    created_at: asInt(row.created_at, 0),
    updated_at: asInt(row.updated_at, asInt(row.created_at, 0)),
  };
}

export function wrapUserSubscription(row: Record<string, unknown>, now = nowSec()): { subscription: Record<string, unknown> } {
  return { subscription: publicUserSubscription(row, now) };
}

export function isActiveSubscription(row: Record<string, unknown>, now = nowSec()): boolean {
  const sub = publicUserSubscription(row, now);
  return sub.status === "active" && asInt(sub.end_time, 0) > now;
}

export function calcPlanEndTime(startSec: number, plan: Record<string, unknown>): number {
  const unit = String(plan.duration_unit || "month");
  const value = asInt(plan.duration_value, asInt(plan.duration_days, 1) || 1);
  const start = new Date(startSec * 1000);
  if (unit === "year") {
    start.setUTCFullYear(start.getUTCFullYear() + value);
    return Math.floor(start.getTime() / 1000);
  }
  if (unit === "month") {
    start.setUTCMonth(start.getUTCMonth() + value);
    return Math.floor(start.getTime() / 1000);
  }
  if (unit === "day") return startSec + value * 86400;
  if (unit === "hour") return startSec + value * 3600;
  if (unit === "custom") {
    const custom = asInt(plan.custom_seconds, 0);
    return custom > 0 ? startSec + custom : startSec + 30 * 86400;
  }
  const days = asInt(plan.duration_days, 30) || 30;
  return startSec + days * 86400;
}

export function calcNextResetTime(baseSec: number, plan: Record<string, unknown>, endUnix: number): number {
  const period = normalizeResetPeriod(plan.quota_reset_period);
  if (period === "never") return 0;
  const base = new Date(baseSec * 1000);
  let next: Date;
  if (period === "daily") {
    next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1));
  } else if (period === "weekly") {
    let weekday = base.getUTCDay();
    if (weekday === 0) weekday = 7;
    next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + (8 - weekday)));
  } else if (period === "monthly") {
    next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  } else {
    const custom = asInt(plan.quota_reset_custom_seconds, 0);
    next = new Date((baseSec + (custom > 0 ? custom : 86400)) * 1000);
  }
  const unix = Math.floor(next.getTime() / 1000);
  if (endUnix > 0 && unix > endUnix) return 0;
  return unix;
}

export function decodePluginIcon(icon: string): { mediaType: string; body: Uint8Array } | null {
  const raw = String(icon || "").trim();
  if (!raw) return null;
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(raw);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mediaType: m[1], body: bytes };
  } catch {
    return null;
  }
}

export function parseCodexOAuthKey(key: string): { access_token: string; account_id: string; refresh_token: string } | null {
  const trimmed = String(key || "").trim();
  if (!trimmed) return null;
  const parsed = parseJson<Record<string, unknown>>(trimmed, {});
  if (parsed && (parsed.access_token || parsed.accessToken)) {
    return {
      access_token: String(parsed.access_token || parsed.accessToken || ""),
      account_id: String(parsed.account_id || parsed.accountId || parsed.chatgpt_account_id || ""),
      refresh_token: String(parsed.refresh_token || parsed.refreshToken || ""),
    };
  }
  return { access_token: trimmed, account_id: "", refresh_token: "" };
}
