import { DEFAULT_WAFFO_PAY_METHODS, MAX_WALLET_QUOTA, nowSec, parseJson, randomHex } from "./constants.js";
import {
  createWaffoPancakeCheckoutSession,
  formatWaffoPancakeAmount,
  verifyWaffoPancakeWebhook,
  waffoPancakeBuyerIdentityFromUserId,
} from "./waffo-pancake.js";
import {
  getRandomString,
  hmacSha256Hex,
  md5Hex,
  sha1Hex,
  signWaffoBody,
  timingSafeEqualStr,
  validateWaffoPrivateKey,
  validateWaffoPublicKey,
  verifyWaffoBody,
} from "./crypto.js";
import { apiErrorMsg, apiOk, clientIp, json, payErr, payOk, paymentComplianceRequiredMessage, paymentReturnPath as serverPaymentReturnPath } from "./http.js";
import {
  ERR_SUBSCRIPTION_ORDER_NOT_FOUND,
  type Store,
} from "./store.js";
import type { Env, UserRow } from "./types.js";
import { parseTrustedRedirectDomains, validateRedirectURL } from "./url-validator.js";

/** Original `operation_setting.CurrentComplianceTermsVersion`. */
export const CURRENT_COMPLIANCE_TERMS_VERSION = "v1";

export async function paymentComplianceConfirmed(store: Store): Promise<boolean> {
  const confirmed = await store.optionBool("PaymentComplianceConfirmed", false);
  const version = await store.option("PaymentComplianceTermsVersion");
  return confirmed && version === CURRENT_COMPLIANCE_TERMS_VERSION;
}

/** Original `controller.requirePaymentCompliance` / `common.ApiErrorI18n` (omit `data`). */
export async function requirePaymentCompliance(store: Store, req: Request): Promise<Response | null> {
  if (await paymentComplianceConfirmed(store)) return null;
  return apiErrorMsg(paymentComplianceRequiredMessage(req));
}

/** Original `common.DecodeJson` into `PaymentComplianceRequest`. */
function decodePaymentComplianceRequest(raw: string): { confirmed: boolean } | Response {
  if (!raw.trim()) return apiErrorMsg("参数错误");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return apiErrorMsg("参数错误");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return apiErrorMsg("参数错误");
  }
  const rec = parsed as Record<string, unknown>;
  if ("confirmed" in rec && typeof rec.confirmed !== "boolean") {
    return apiErrorMsg("参数错误");
  }
  return { confirmed: rec.confirmed === true };
}

/** Original `controller.ConfirmPaymentCompliance`. */
export async function confirmPaymentCompliance(
  store: Store,
  user: { id: number; sid?: string },
  req: Request,
): Promise<Response> {
  if (!user.sid) {
    return json(403, {
      success: false,
      message: "This operation requires dashboard session authentication. API access token is not allowed.",
    });
  }
  const decoded = decodePaymentComplianceRequest(await req.text());
  if (decoded instanceof Response) return decoded;
  if (!decoded.confirmed) return apiErrorMsg("请确认合规声明");
  const now = nowSec();
  const updates: Record<string, string> = {
    "payment_setting.compliance_confirmed": "true",
    "payment_setting.compliance_terms_version": CURRENT_COMPLIANCE_TERMS_VERSION,
    "payment_setting.compliance_confirmed_at": String(now),
    "payment_setting.compliance_confirmed_by": String(user.id),
    "payment_setting.compliance_confirmed_ip": clientIp(req),
  };
  for (const [key, value] of Object.entries(updates)) {
    await store.setOption(key, value);
  }
  return apiOk({
    confirmed: true,
    terms_version: CURRENT_COMPLIANCE_TERMS_VERSION,
    confirmed_at: now,
    confirmed_by: user.id,
  });
}

export async function paymentConfigured(store: Store, kind: "stripe" | "epay" | "creem" | "waffo" | "waffo_pancake"): Promise<boolean> {
  if (kind === "stripe") {
    return Boolean(await stripeSecret(store)) && Boolean(await store.option("StripeWebhookSecret")) && Boolean(await store.option("StripePriceId"));
  }
  if (kind === "epay") {
    const address = (await store.option("PayAddress")) || (await store.option("EpayUrl"));
    const methods = parseJson<unknown[]>(await store.option("PayMethods"), []);
    return Boolean(address) && Boolean(await store.option("EpayId")) && Boolean(await store.option("EpayKey")) && methods.length > 0;
  }
  if (kind === "creem") {
    const products = ((await store.option("CreemProducts")) || "").trim();
    return Boolean(await store.option("CreemApiKey")) && products !== "" && products !== "[]";
  }
  if (kind === "waffo_pancake") {
    return (
      Boolean((await store.option("WaffoPancakeMerchantID")).trim()) &&
      Boolean((await store.option("WaffoPancakePrivateKey")).trim()) &&
      Boolean((await store.option("WaffoPancakeProductID")).trim())
    );
  }
  if (!(await store.optionBool("WaffoEnabled", false))) return false;
  if (await store.optionBool("WaffoSandbox", false)) {
    return (
      Boolean(await store.option("WaffoSandboxApiKey")) &&
      Boolean(await store.option("WaffoSandboxPrivateKey")) &&
      Boolean(await store.option("WaffoSandboxPublicCert"))
    );
  }
  return (
    Boolean(await store.option("WaffoApiKey")) &&
    Boolean(await store.option("WaffoPrivateKey")) &&
    Boolean(await store.option("WaffoPublicCert"))
  );
}

export async function paymentEnabled(store: Store, kind: "stripe" | "epay" | "creem" | "waffo" | "waffo_pancake"): Promise<boolean> {
  if (!(await paymentComplianceConfirmed(store))) return false;
  return paymentConfigured(store, kind);
}

export async function stripeSecret(store: Store): Promise<string> {
  return (await store.option("StripeApiSecret")) || (await store.option("StripeApiKey")) || (await store.option("StripeSecretKey"));
}

export async function topupInfo(store: Store): Promise<Record<string, unknown>> {
  const stripe = await paymentEnabled(store, "stripe");
  const epay = await paymentEnabled(store, "epay");
  const creem = await paymentEnabled(store, "creem");
  const waffo = await paymentEnabled(store, "waffo");
  const waffoPancake = await paymentEnabled(store, "waffo_pancake");
  const complianceConfirmed = await paymentComplianceConfirmed(store);
  const payMethods = complianceConfirmed
    ? parseJson<Record<string, string>[]>(await store.option("PayMethods"), [
        { name: "支付宝", icon: "SiAlipay", type: "alipay" },
        { name: "微信", icon: "SiWechat", type: "wxpay" },
        { name: "自定义1", icon: "LuCreditCard", type: "custom1", min_topup: "50" },
      ])
    : [];
  const methods = [...payMethods];
  const pushUnique = (type: string, method: Record<string, string>) => {
    if (!methods.some((m) => m.type === type)) methods.push(method);
  };
  if (stripe) {
    pushUnique("stripe", {
      name: "Stripe",
      type: "stripe",
      color: "#635BFF",
      min_topup: String(await store.optionNum("StripeMinTopUp", 1)),
    });
  }
  if (waffoPancake) {
    pushUnique("waffo_pancake", {
      name: "Waffo Pancake",
      type: "waffo_pancake",
      color: "#F97316",
      min_topup: String(await store.optionNum("WaffoPancakeMinTopUp", 1)),
    });
  }
  if (waffo) {
    pushUnique("waffo", {
      name: "Waffo (Global Payment)",
      type: "waffo",
      color: "#3B82F6",
      min_topup: String(await store.optionNum("WaffoMinTopUp", 1)),
    });
  }
  return {
    enable_online_topup: epay,
    enable_stripe_topup: stripe,
    enable_creem_topup: creem,
    enable_waffo_topup: waffo,
    enable_waffo_pancake_topup: waffoPancake,
    enable_redemption: complianceConfirmed,
    payment_compliance_confirmed: complianceConfirmed,
    payment_compliance_terms_version: CURRENT_COMPLIANCE_TERMS_VERSION,
    waffo_pay_methods: waffo ? parseJson(await store.option("WaffoPayMethods"), []) : null,
    creem_products: parseJson(await store.option("CreemProducts"), []),
    pay_methods: methods,
    min_topup: await store.optionNum("MinTopup", 1),
    stripe_min_topup: await store.optionNum("StripeMinTopUp", 1),
    waffo_min_topup: await store.optionNum("WaffoMinTopUp", 1),
    waffo_pancake_min_topup: await store.optionNum("WaffoPancakeMinTopUp", 1),
    amount_options: parseJson<number[]>(await store.option("AmountOptions"), [10, 20, 50, 100, 200, 500]),
    discount: parseJson<Record<string, number>>(await store.option("AmountDiscount"), {}),
    topup_link: await store.option("TopUpLink"),
  };
}

function paymentReturnPath(req: Request, suffix: string, serverAddress = ""): string {
  const base = (serverAddress || new URL(req.url).origin).replace(/\/+$/, "");
  return base + suffix;
}

/** Original `service.GetCallbackAddress`. */
async function callbackAddress(store: Store): Promise<string> {
  return ((await store.option("CustomCallbackAddress")) || (await store.option("ServerAddress")) || "").replace(/\/+$/, "");
}

/** Original go-epay `path.Join(base.Path, "/submit.php")`. */
function epayPurchaseUrl(gateway: string): string {
  const u = new URL(gateway);
  const trimmed = u.pathname.replace(/\/+$/, "");
  u.pathname = (trimmed || "") + "/submit.php";
  if (!u.pathname.startsWith("/")) u.pathname = "/" + u.pathname;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Original go-epay `GenerateParams` (empty values and sign/sign_type omitted from the digest). */
async function generateEpayParams(params: Record<string, string>, key: string): Promise<Record<string, string>> {
  const filtered = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort();
  const signStr = filtered.map((k) => `${k}=${params[k]}`).join("&") + key;
  params.sign = await md5Hex(signStr);
  params.sign_type = "MD5";
  return params;
}

export type PayAmountKind = "epay" | "stripe" | "waffo" | "waffo_pancake";

async function quotaDisplayType(store: Store): Promise<string> {
  return (await store.option("general_setting.quota_display_type")) || "USD";
}

async function topupGroupRatio(store: Store, group: string): Promise<number> {
  const ratios = parseJson<Record<string, number>>(await store.option("TopupGroupRatio"), {
    default: 1,
    vip: 1,
    svip: 1,
  });
  const ratio = ratios[group];
  if (ratio == null || ratio === 0) return 1;
  return ratio;
}

async function amountDiscount(store: Store, amount: number): Promise<number> {
  const discounts = parseJson<Record<string, number>>(await store.option("AmountDiscount"), {});
  const ds = discounts[String(amount)] ?? discounts[amount as unknown as string];
  return ds > 0 ? ds : 1;
}

async function minTopup(store: Store, optionKey: string, fallback: number): Promise<number> {
  let min = await store.optionNum(optionKey, fallback);
  if ((await quotaDisplayType(store)) === "TOKENS") {
    min = min * (await store.optionNum("QuotaPerUnit", 500000));
  }
  return min;
}

async function displayAmount(store: Store, amount: number): Promise<number> {
  if ((await quotaDisplayType(store)) === "TOKENS") {
    const qpu = await store.optionNum("QuotaPerUnit", 500000);
    return qpu > 0 ? amount / qpu : amount;
  }
  return amount;
}

async function payMoneyFor(
  store: Store,
  amount: number,
  group: string,
  unitPrice: number,
): Promise<number> {
  const money = (await displayAmount(store, amount)) * unitPrice * (await topupGroupRatio(store, group)) * (await amountDiscount(store, amount));
  return money;
}

async function rejectInvalidTopUpQuota(store: Store, userId: number, amount: number): Promise<Response | null> {
  void userId;
  const qpu = await store.optionNum("QuotaPerUnit", 500000);
  if (qpu <= 0) return payErr("充值数量无效");
  const maxAmount = Math.floor(MAX_WALLET_QUOTA / qpu);
  if (maxAmount > 0 && amount > maxAmount) return payErr(`单笔充值数量不能大于 ${maxAmount}`);
  return null;
}

export async function requestAmount(
  store: Store,
  user: { id: number; group: string },
  body: { amount?: number },
  kind: PayAmountKind,
): Promise<Response> {
  const amount = Number(body.amount || 0);
  const minKey = kind === "stripe" ? "StripeMinTopUp" : kind === "waffo" ? "WaffoMinTopUp" : kind === "waffo_pancake" ? "WaffoPancakeMinTopUp" : "MinTopup";
  const min =
    kind === "waffo" || kind === "waffo_pancake" ? await store.optionNum(minKey, 1) : await minTopup(store, minKey, 1);
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  if (kind === "stripe" && amount > 10000) return payErr("充值数量不能大于 10000");
  const invalid = await rejectInvalidTopUpQuota(store, user.id, amount);
  if (invalid) return invalid;
  const unit =
    kind === "stripe"
      ? await store.optionNum("StripeUnitPrice", 8)
      : kind === "waffo"
        ? await store.optionNum("WaffoUnitPrice", 1)
        : kind === "waffo_pancake"
          ? await store.optionNum("WaffoPancakeUnitPrice", 1)
          : await store.optionNum("Price", 7.3);
  const money = await payMoneyFor(store, amount, user.group, unit);
  if (money <= 0.01) return payErr("充值金额过低");
  return json(200, { message: "success", data: money.toFixed(2), success: true });
}

/** Original `StripeAdaptor.RequestPay` HTTP 400 when a custom redirect is untrusted. */
function stripeRedirectRejected(kind: "success" | "cancel"): Response {
  const message =
    kind === "success" ? "支付成功重定向URL不在可信任域名列表中" : "支付取消重定向URL不在可信任域名列表中";
  return json(400, { message, data: "" });
}

export async function requestStripePay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; payment_method?: string; success_url?: string; cancel_url?: string },
  trustedRedirectDomainsRaw?: string,
): Promise<Response> {
  if ((body.payment_method || "") !== "stripe") return payErr("不支持的支付渠道");
  const amount = Number(body.amount || 0);
  const min = await minTopup(store, "StripeMinTopUp", 1);
  if (amount < min) return json(200, { message: `充值数量不能小于 ${min}`, data: 10, success: false });
  if (amount > 10000) return json(200, { message: "充值数量不能大于 10000", data: 10, success: false });
  const successUrl = String(body.success_url ?? "");
  const cancelUrl = String(body.cancel_url ?? "");
  const trusted = parseTrustedRedirectDomains(trustedRedirectDomainsRaw);
  if (successUrl !== "" && validateRedirectURL(successUrl, trusted)) return stripeRedirectRejected("success");
  if (cancelUrl !== "" && validateRedirectURL(cancelUrl, trusted)) return stripeRedirectRejected("cancel");
  void req;
  const money = amount * (await topupGroupRatio(store, user.group));
  const invalid = await rejectInvalidTopUpQuota(store, user.id, money);
  if (invalid) return invalid;
  const secret = await stripeSecret(store);
  const reference = `new-api-ref-${user.id}-${Date.now()}-${randomHex(2)}`;
  const trade = "ref_" + (await sha1Hex(reference));
  const server = await store.option("ServerAddress");
  const params = new URLSearchParams({
    mode: "payment",
    success_url: successUrl || serverPaymentReturnPath(server, "/usage-logs"),
    cancel_url: cancelUrl || serverPaymentReturnPath(server, "/wallet"),
    "line_items[0][price]": await store.option("StripePriceId"),
    "line_items[0][quantity]": String(amount),
    client_reference_id: trade,
    allow_promotion_codes: String(await store.optionBool("StripePromotionCodesEnabled", false)),
  });
  let stripeCustomer = String(user.stripe_customer || "");
  if (!stripeCustomer) {
    try {
      const parsed = JSON.parse(user.settings || "{}") as Record<string, unknown>;
      stripeCustomer = String(parsed.stripe_customer || parsed.stripeCustomer || "");
    } catch {
      /* ignore */
    }
  }
  if (stripeCustomer) {
    params.set("customer", stripeCustomer);
  } else {
    if (user.email) params.set("customer_email", user.email);
    params.set("customer_creation", "always");
  }
  if (!secret.startsWith("sk_") && !secret.startsWith("rk_")) return payErr("拉起支付失败");
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !data.url) return payErr("拉起支付失败");
  try {
    await store.insertTopup({
      user_id: user.id,
      amount,
      money,
      trade_no: trade,
      payment_method: "stripe",
      payment_provider: "stripe",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  return payOk({ pay_link: data.url });
}

const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

function abortStripe(status: number): Response {
  return new Response(null, { status });
}

/** Original stripe-go `webhook.parseSignatureHeader` (`t=` + `v1=` hex only, exact `k=v` pairs). */
function parseStripeSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  const signatures: string[] = [];
  let timestamp = 0;
  for (const pair of header.split(",")) {
    const parts = pair.split("=");
    if (parts.length !== 2) return null;
    const key = parts[0];
    const value = parts[1];
    if (key === "t") {
      if (!/^-?\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) signatures.push(value.toLowerCase());
    }
  }
  if (!signatures.length) return null;
  return { timestamp, signatures };
}

/**
 * Original stripe-go `webhook.ConstructEventWithOptions` with
 * `IgnoreAPIVersionMismatch: true` and default 300s tolerance.
 */
async function constructStripeEvent(
  payload: string,
  header: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return null;
  if (Date.now() / 1000 - parsed.timestamp > STRIPE_SIGNATURE_TOLERANCE_SEC) return null;
  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${payload}`);
  let matched = false;
  for (const signature of parsed.signatures) {
    if (timingSafeEqualStr(expected, signature)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;
  try {
    const event = JSON.parse(payload) as unknown;
    if (event === null) return {};
    if (!isJsonObject(event)) return null;
    if ("type" in event && event.type != null && typeof event.type !== "string") return null;
    if ("data" in event && event.data != null && !isJsonObject(event.data)) return null;
    return event;
  } catch {
    return null;
  }
}

/** Original stripe-go `Event.GetObjectValue` for a top-level checkout-session field. */
function stripeGetObjectValue(event: Record<string, unknown>, key: string): string {
  const data = isJsonObject(event.data) ? event.data : null;
  const object = data && isJsonObject(data.object) ? data.object : null;
  if (!object || !(key in object) || object[key] == null) return "";
  const node = object[key];
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return String(node);
  return "";
}

/** Original `fulfillOrder` `common.GetJsonString` payload (encoding/json sorted keys). */
function stripeFulfillPayload(event: Record<string, unknown>): string {
  return JSON.stringify({
    amount_total: stripeGetObjectValue(event, "amount_total"),
    currency: stripeGetObjectValue(event, "currency").toUpperCase(),
    customer: stripeGetObjectValue(event, "customer"),
    event_type: typeof event.type === "string" ? event.type : "",
  });
}

async function stripeFulfillOrder(
  store: Store,
  event: Record<string, unknown>,
  referenceId: string,
  customerId: string,
  callerIp: string,
): Promise<void> {
  if (!referenceId) return;
  const result = await tryCompleteSubscriptionOrder(store, referenceId, stripeFulfillPayload(event), "stripe", "");
  if (result === "completed" || result === "rejected") return;
  try {
    await store.rechargeStripe(referenceId, customerId, callerIp);
  } catch {
    /* original logs Recharge errors and still returns 200 */
  }
}

async function stripeSessionAsyncPaymentFailed(store: Store, event: Record<string, unknown>): Promise<void> {
  const referenceId = stripeGetObjectValue(event, "client_reference_id");
  if (!referenceId) return;
  const row = await store.getTopupByTrade(referenceId);
  if (!row) return;
  if (String(row.payment_provider || "") !== "stripe") return;
  if (String(row.status) !== "pending") return;
  try {
    await store.updateTopup(Number(row.id), { status: "failed" });
  } catch {
    /* original logs Update errors and still returns 200 */
  }
}

async function stripeSessionExpired(store: Store, event: Record<string, unknown>): Promise<void> {
  const referenceId = stripeGetObjectValue(event, "client_reference_id");
  if (stripeGetObjectValue(event, "status") !== "expired") return;
  if (!referenceId) return;
  try {
    await store.expireSubscriptionOrder(referenceId, "stripe");
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== ERR_SUBSCRIPTION_ORDER_NOT_FOUND) return;
  }
  try {
    await store.updatePendingTopupStatus(referenceId, "stripe", "expired");
  } catch {
    /* original logs missing/invalid wallet orders and still 200 */
  }
}

/** Original `controller.StripeWebhook`. */
export async function handleStripeWebhook(store: Store, req: Request): Promise<Response> {
  if (!(await paymentEnabled(store, "stripe"))) return abortStripe(403);
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return abortStripe(503);
  }
  const secret = await store.option("StripeWebhookSecret");
  const event = await constructStripeEvent(raw, req.headers.get("Stripe-Signature") || "", secret);
  if (!event) return abortStripe(400);
  const eventType = typeof event.type === "string" ? event.type : "";
  const callerIp = clientIp(req);
  if (eventType === "checkout.session.completed") {
    if (stripeGetObjectValue(event, "status") !== "complete") return abortStripe(200);
    if (stripeGetObjectValue(event, "payment_status") !== "paid") return abortStripe(200);
    await stripeFulfillOrder(
      store,
      event,
      stripeGetObjectValue(event, "client_reference_id"),
      stripeGetObjectValue(event, "customer"),
      callerIp,
    );
  } else if (eventType === "checkout.session.async_payment_succeeded") {
    await stripeFulfillOrder(
      store,
      event,
      stripeGetObjectValue(event, "client_reference_id"),
      stripeGetObjectValue(event, "customer"),
      callerIp,
    );
  } else if (eventType === "checkout.session.async_payment_failed") {
    await stripeSessionAsyncPaymentFailed(store, event);
  } else if (eventType === "checkout.session.expired") {
    await stripeSessionExpired(store, event);
  }
  return abortStripe(200);
}

export async function requestEpay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; payment_method?: string },
): Promise<Response> {
  void req;
  const amount = Number(body.amount || 0);
  const min = await minTopup(store, "MinTopup", 1);
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const invalid = await rejectInvalidTopUpQuota(store, user.id, amount);
  if (invalid) return invalid;
  const methods = parseJson<{ type?: string }[]>(await store.option("PayMethods"), []);
  const method = String(body.payment_method || "");
  if (!methods.some((m) => m.type === method)) return payErr("支付方式不存在");
  const money = await payMoneyFor(store, amount, user.group, await store.optionNum("Price", 7.3));
  if (money < 0.01) return payErr("充值金额过低");
  const pid = await store.option("EpayId");
  const key = await store.option("EpayKey");
  const gateway = (await store.option("PayAddress")) || (await store.option("EpayUrl")) || "";
  if (!gateway || !pid || !key) return payErr("当前管理员未配置支付信息");
  let submitUrl = "";
  try {
    submitUrl = epayPurchaseUrl(gateway);
  } catch {
    return payErr("拉起支付失败");
  }
  const trade = `USR${user.id}NO${getRandomString(6)}${nowSec()}`;
  const params = await generateEpayParams(
    {
      pid,
      type: method,
      out_trade_no: trade,
      notify_url: `${await callbackAddress(store)}/api/user/epay/notify`,
      return_url: serverPaymentReturnPath(await store.option("ServerAddress"), "/usage-logs"),
      name: `TUC${amount}`,
      money: money.toFixed(2),
      device: "pc",
      sign_type: "MD5",
      sign: "",
    },
    key,
  );
  let storedAmount = amount;
  if ((await quotaDisplayType(store)) === "TOKENS") {
    const qpu = await store.optionNum("QuotaPerUnit", 500000);
    storedAmount = qpu > 0 ? Math.trunc(amount / qpu) : amount;
  }
  try {
    await store.insertTopup({
      user_id: user.id,
      amount: storedAmount,
      money,
      trade_no: trade,
      payment_method: method,
      payment_provider: "epay",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  return json(200, { message: "success", data: params, url: submitUrl, success: true });
}

/** Original gin `c.Writer.Write([]byte("success"|"fail"))` (HTTP 200). */
function epayNotifyText(ok: boolean): Response {
  return new Response(ok ? "success" : "fail", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Original `EpayNotify` POST `ParseForm`/`PostForm` vs GET query. */
async function collectEpayNotifyParams(req: Request, url: URL): Promise<Record<string, string> | null> {
  const params: Record<string, string> = {};
  if (req.method === "POST") {
    try {
      const contentType = (req.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) return params;
      new URLSearchParams(await req.text()).forEach((value, key) => {
        params[key] = value;
      });
    } catch {
      return null;
    }
    return params;
  }
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

/** Original go-epay `Client.Verify` (case-sensitive MD5, `GenerateParams` digest). */
async function verifyEpayNotify(
  params: Record<string, string>,
  key: string,
): Promise<{ ok: boolean; tradeNo: string; type: string; tradeStatus: string }> {
  const provided = params.sign || "";
  const copy = { ...params };
  await generateEpayParams(copy, key);
  return {
    ok: Boolean(provided) && provided === copy.sign,
    tradeNo: params.out_trade_no || "",
    type: params.type || "",
    tradeStatus: params.trade_status || "",
  };
}

/** Original `controller.EpayNotify`. */
export async function handleEpayNotify(store: Store, req: Request, url: URL): Promise<Response> {
  if (!(await paymentEnabled(store, "epay"))) return epayNotifyText(false);
  const params = await collectEpayNotifyParams(req, url);
  if (!params) return epayNotifyText(false);
  if (!Object.keys(params).length) return epayNotifyText(false);
  const address = (await store.option("PayAddress")) || (await store.option("EpayUrl"));
  const pid = await store.option("EpayId");
  const key = await store.option("EpayKey");
  if (!address || !pid || !key) return epayNotifyText(false);
  try {
    new URL(address);
  } catch {
    return epayNotifyText(false);
  }
  const verified = await verifyEpayNotify(params, key);
  if (!verified.ok) return epayNotifyText(false);
  if (verified.tradeStatus === "TRADE_SUCCESS") {
    try {
      await store.rechargeEpay(verified.tradeNo, verified.type, clientIp(req));
    } catch {
      return epayNotifyText(false);
    }
  }
  return epayNotifyText(true);
}

type CreemProduct = { productId?: string; name?: string; price?: number; quota?: number; currency?: string };

/** Original `genCreemLink` host: live vs `CreemTestMode` test API. No checkout-URL option override. */
export function creemCheckoutApiUrl(testMode: boolean): string {
  return testMode ? "https://test-api.creem.io/v1/checkouts" : "https://api.creem.io/v1/checkouts";
}

export async function requestCreemPay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { product_id?: string; payment_method?: string },
): Promise<Response> {
  if ((body.payment_method || "") !== "creem") return payErr("不支持的支付渠道");
  if (!body.product_id) return payErr("请选择产品");
  let products: CreemProduct[];
  try {
    const parsed = JSON.parse(await store.option("CreemProducts")) as unknown;
    if (!Array.isArray(parsed)) return payErr("产品配置错误");
    products = parsed as CreemProduct[];
  } catch {
    return payErr("产品配置错误");
  }
  const selected = products.find((p) => p.productId === body.product_id);
  if (!selected) return payErr("产品不存在");
  const invalid = await rejectInvalidTopUpQuota(store, user.id, Number(selected.quota || 0));
  if (invalid) return invalid;
  const reference = `creem-api-ref-${user.id}-${Date.now()}-${getRandomString(4)}`;
  const trade = "ref_" + (await sha1Hex(reference));
  try {
    await store.insertTopup({
      user_id: user.id,
      amount: Number(selected.quota || 0),
      money: Number(selected.price || 0),
      trade_no: trade,
      payment_method: "creem",
      payment_provider: "creem",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  const apiKey = await store.option("CreemApiKey");
  if (!apiKey) return payErr("拉起支付失败");
  const testMode = await store.optionBool("CreemTestMode", false);
  const endpoint = creemCheckoutApiUrl(testMode);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      product_id: selected.productId,
      request_id: trade,
      customer: { email: user.email || "" },
      metadata: {
        username: user.username,
        reference_id: trade,
        product_name: selected.name || "",
        quota: String(selected.quota || 0),
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { checkout_url?: string; id?: string };
  if (Math.floor(res.status / 100) !== 2 || !data.checkout_url) return payErr("拉起支付失败");
  void req;
  return payOk({ checkout_url: data.checkout_url, order_id: trade });
}

type WaffoPayMethod = { name?: string; payMethodType?: string; payMethodName?: string };

const WAFFO_ZERO_DECIMAL = new Set(["IDR", "JPY", "KRW", "VND"]);
const WAFFO_SDK_VERSION = "waffo-go/1.3.2";
const WAFFO_API_VERSION = "1.0.0";

async function waffoPayMethods(store: Store): Promise<WaffoPayMethod[]> {
  const raw = await store.option("WaffoPayMethods");
  if (!raw) return DEFAULT_WAFFO_PAY_METHODS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_WAFFO_PAY_METHODS;
    return parsed as WaffoPayMethod[];
  } catch {
    return DEFAULT_WAFFO_PAY_METHODS;
  }
}

function formatWaffoAmount(amount: number, currency: string): string {
  if (WAFFO_ZERO_DECIMAL.has(currency.toUpperCase())) return amount.toFixed(0);
  return amount.toFixed(2);
}

function waffoRedirectUrl(orderAction: string): string {
  if (!orderAction) return "";
  try {
    const action = JSON.parse(orderAction) as { actionType?: string; webUrl?: string; deeplinkUrl?: string };
    if (action.actionType === "DEEPLINK" && action.deeplinkUrl) return action.deeplinkUrl;
    return action.webUrl || "";
  } catch {
    return "";
  }
}

async function waffoCredentials(store: Store): Promise<{
  apiKey: string;
  privateKey: string;
  publicKey: string;
  sandbox: boolean;
} | null> {
  const sandbox = await store.optionBool("WaffoSandbox", false);
  const apiKey = sandbox ? await store.option("WaffoSandboxApiKey") : await store.option("WaffoApiKey");
  const privateKey = sandbox ? await store.option("WaffoSandboxPrivateKey") : await store.option("WaffoPrivateKey");
  const publicKey = sandbox ? await store.option("WaffoSandboxPublicCert") : await store.option("WaffoPublicCert");
  if (!apiKey || !privateKey || !publicKey) return null;
  if (!(await validateWaffoPrivateKey(privateKey)) || !(await validateWaffoPublicKey(publicKey))) return null;
  return { apiKey, privateKey, publicKey, sandbox };
}

export async function requestWaffoPay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; pay_method_index?: number; pay_method_type?: string; pay_method_name?: string },
  bindError = false,
): Promise<Response> {
  void req;
  if (!(await store.optionBool("WaffoEnabled", false))) return payErr("Waffo 支付未启用");
  if (bindError) return payErr("参数错误");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("WaffoMinTopUp", 1);
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const invalid = await rejectInvalidTopUpQuota(store, user.id, amount);
  if (invalid) return invalid;
  const methods = await waffoPayMethods(store);
  let resolvedType = "";
  let resolvedName = "";
  if (body.pay_method_index != null && String(body.pay_method_index) !== "") {
    const idx = Number(body.pay_method_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= methods.length) return payErr("不支持的支付方式");
    resolvedType = String(methods[idx]?.payMethodType || "");
    resolvedName = String(methods[idx]?.payMethodName || "");
  } else if (String(body.pay_method_type || "")) {
    const type = String(body.pay_method_type);
    const name = String(body.pay_method_name || "");
    const match = methods.find((m) => m.payMethodType === type && m.payMethodName === name);
    if (!match) return payErr("不支持的支付方式");
    resolvedType = String(match.payMethodType || "");
    resolvedName = String(match.payMethodName || "");
  }
  const money = await payMoneyFor(store, amount, user.group, await store.optionNum("WaffoUnitPrice", 1));
  if (money < 0.01) return payErr("充值金额过低");
  const trade = `WAFFO-${user.id}-${Date.now()}-${getRandomString(6)}`;
  let storedAmount = amount;
  if ((await quotaDisplayType(store)) === "TOKENS") {
    const qpu = await store.optionNum("QuotaPerUnit", 500000);
    storedAmount = Math.max(qpu > 0 ? Math.trunc(amount / qpu) : amount, 1);
  }
  let topupId = 0;
  try {
    topupId = await store.insertTopup({
      user_id: user.id,
      amount: storedAmount,
      money,
      trade_no: trade,
      payment_method: "waffo",
      payment_provider: "waffo",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  const creds = await waffoCredentials(store);
  if (!creds) {
    if (topupId) await store.updateTopup(topupId, { status: "failed" });
    return payErr("支付配置错误");
  }
  const currency = (await store.option("WaffoCurrency")) || "USD";
  const appName = ((await store.option("SystemName")) || "New API").trim() || "New API";
  const notifyOverride = await store.option("WaffoNotifyUrl");
  const notifyUrl = notifyOverride || `${await callbackAddress(store)}/api/waffo/webhook`;
  const returnOverride = await store.option("WaffoReturnUrl");
  const returnUrl = returnOverride || serverPaymentReturnPath(await store.option("ServerAddress"), "/wallet?show_history=true");
  const paymentInfo: Record<string, string> = { productName: "ONE_TIME_PAYMENT" };
  if (resolvedType) paymentInfo.payMethodType = resolvedType;
  if (resolvedName) paymentInfo.payMethodName = resolvedName;
  const payload: Record<string, unknown> = {
    paymentRequestId: trade,
    merchantOrderId: trade,
    orderCurrency: currency,
    orderAmount: formatWaffoAmount(money, currency),
    orderDescription: `Recharge ${amount} credits`,
    orderRequestedAt: new Date().toISOString(),
    notifyUrl,
    successRedirectUrl: returnUrl,
    failedRedirectUrl: returnUrl,
    userInfo: {
      userId: String(user.id),
      userEmail: `${user.id}@examples.com`,
      userTerminal: "WEB",
    },
    paymentInfo,
    goodsInfo: {
      goodsName: `Recharge ${amount} credits`,
      appName,
    },
  };
  const merchantId = await store.option("WaffoMerchantId");
  if (merchantId) payload.merchantInfo = { merchantId };
  const bodyJson = JSON.stringify(payload);
  const signature = await signWaffoBody(bodyJson, creds.privateKey);
  if (!signature) {
    await store.updateTopup(topupId, { status: "failed" });
    return payErr("支付配置错误");
  }
  const endpoint =
    (await store.option("WaffoCheckoutUrl")) ||
    (creds.sandbox ? "https://api-sandbox.waffo.com/api/v1/order/create" : "https://api.waffo.com/api/v1/order/create");
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-KEY": creds.apiKey,
        "X-SIGNATURE": signature,
        "X-API-VERSION": WAFFO_API_VERSION,
        "X-SDK-VERSION": WAFFO_SDK_VERSION,
      },
      body: bodyJson,
    });
  } catch {
    await store.updateTopup(topupId, { status: "failed" });
    return payErr("拉起支付失败");
  }
  const data = (await res.json().catch(() => ({}))) as {
    code?: string;
    msg?: string;
    data?: { orderAction?: string; payment_url?: string };
  };
  if (String(data.code ?? "") !== "0" || !data.data) {
    await store.updateTopup(topupId, { status: "failed" });
    return payErr("拉起支付失败");
  }
  const orderAction = String(data.data.orderAction || "");
  const paymentUrl = waffoRedirectUrl(orderAction) || orderAction;
  return payOk({ payment_url: paymentUrl, order_id: trade });
}

export async function requestWaffoPancakePay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number },
  bindError = false,
): Promise<Response> {
  void req;
  if (!(await paymentEnabled(store, "waffo_pancake"))) return payErr("Waffo Pancake 配置不完整");
  if (bindError) return payErr("参数错误");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("WaffoPancakeMinTopUp", 1);
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const invalid = await rejectInvalidTopUpQuota(store, user.id, amount);
  if (invalid) return invalid;
  const money = await payMoneyFor(store, amount, user.group, await store.optionNum("WaffoPancakeUnitPrice", 1));
  if (money < 0.01) return payErr("充值金额过低");
  const trade = `WAFFO_PANCAKE-${user.id}-${Date.now()}-${getRandomString(6)}`;
  let storedAmount = amount;
  if ((await quotaDisplayType(store)) === "TOKENS") {
    const qpu = await store.optionNum("QuotaPerUnit", 500000);
    storedAmount = qpu > 0 ? Math.trunc(amount / qpu) : amount;
    if (storedAmount < 1) storedAmount = 1;
  }
  let topupId = 0;
  try {
    topupId = await store.insertTopup({
      user_id: user.id,
      amount: storedAmount,
      money,
      trade_no: trade,
      payment_method: "waffo_pancake",
      payment_provider: "waffo_pancake",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  try {
    const session = await createWaffoPancakeCheckoutSession(
      await store.option("WaffoPancakeMerchantID"),
      await store.option("WaffoPancakePrivateKey"),
      {
        productId: await store.option("WaffoPancakeProductID"),
        buyerIdentity: waffoPancakeBuyerIdentityFromUserId(user.id),
        priceAmount: formatWaffoPancakeAmount(money),
        buyerEmail: (user.email || "").trim(),
        orderMerchantExternalId: trade,
        expiresInSeconds: 45 * 60,
      },
    );
    return payOk({
      checkout_url: session.checkoutUrl,
      session_id: session.sessionId,
      expires_at: session.expiresAt,
      order_id: trade,
      token: session.token,
      token_expires_at: session.tokenExpiresAt,
    });
  } catch {
    if (topupId) await store.updateTopup(topupId, { status: "failed" });
    return payErr("拉起支付失败");
  }
}

export async function requestHttpPay(
  store: Store,
  user: UserRow,
  req: Request,
  kind: "creem" | "waffo" | "waffo_pancake",
  body: Record<string, unknown>,
): Promise<Response> {
  if (kind === "creem") return requestCreemPay(store, user, req, body as { product_id?: string; payment_method?: string });
  if (kind === "waffo_pancake") return requestWaffoPancakePay(store, user, req, body as { amount?: number });
  return requestWaffoPay(store, user, req, body as { amount?: number });
}

async function creemWebhookEnabled(store: Store): Promise<boolean> {
  if (!(await paymentEnabled(store, "creem"))) return false;
  return Boolean((await store.option("CreemWebhookSecret")).trim());
}

function creemJsonString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function creemJsonInt(value: unknown): number | null {
  if (value == null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

function creemJsonStringMap(value: unknown): Record<string, string> | null | undefined {
  if (value == null) return undefined;
  if (!isJsonObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

function creemExpectStrings(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => !(key in obj) || obj[key] == null || typeof obj[key] === "string");
}

/** Original `common.GetJsonString` of `CreemWebhookEvent` (struct field order, zero values). */
function creemFulfillPayload(event: Record<string, unknown>): string | null {
  if (!creemExpectStrings(event, ["id", "eventType"])) return null;
  const obj = event.object == null ? {} : event.object;
  if (!isJsonObject(obj)) return null;
  const order = obj.order == null ? {} : obj.order;
  const product = obj.product == null ? {} : obj.product;
  const customer = obj.customer == null ? {} : obj.customer;
  if (!isJsonObject(order) || !isJsonObject(product) || !isJsonObject(customer)) return null;
  if (
    !creemExpectStrings(obj, ["id", "object", "request_id", "status", "mode"]) ||
    !creemExpectStrings(order, [
      "object",
      "id",
      "customer",
      "product",
      "currency",
      "status",
      "type",
      "transaction",
      "created_at",
      "updated_at",
      "mode",
    ]) ||
    !creemExpectStrings(product, [
      "id",
      "object",
      "name",
      "description",
      "currency",
      "billing_type",
      "billing_period",
      "status",
      "tax_mode",
      "tax_category",
      "default_success_url",
      "created_at",
      "updated_at",
      "mode",
    ]) ||
    !creemExpectStrings(customer, ["id", "object", "email", "name", "country", "created_at", "updated_at", "mode"])
  ) {
    return null;
  }
  const createdAt = creemJsonInt(event.created_at);
  const orderAmount = creemJsonInt(order.amount);
  const orderSubTotal = creemJsonInt(order.sub_total);
  const orderTax = creemJsonInt(order.tax_amount);
  const orderDue = creemJsonInt(order.amount_due);
  const orderPaid = creemJsonInt(order.amount_paid);
  const productPrice = creemJsonInt(product.price);
  const units = creemJsonInt(obj.units);
  if (
    createdAt == null ||
    orderAmount == null ||
    orderSubTotal == null ||
    orderTax == null ||
    orderDue == null ||
    orderPaid == null ||
    productPrice == null ||
    units == null
  ) {
    return null;
  }
  const metadata = creemJsonStringMap(obj.metadata);
  if (metadata === null) return null;
  const productOut: Record<string, unknown> = {
    id: creemJsonString(product.id),
    object: creemJsonString(product.object),
    name: creemJsonString(product.name),
    description: creemJsonString(product.description),
    price: productPrice,
    currency: creemJsonString(product.currency),
    billing_type: creemJsonString(product.billing_type),
    billing_period: creemJsonString(product.billing_period),
    status: creemJsonString(product.status),
    tax_mode: creemJsonString(product.tax_mode),
    tax_category: creemJsonString(product.tax_category),
    created_at: creemJsonString(product.created_at),
    updated_at: creemJsonString(product.updated_at),
    mode: creemJsonString(product.mode),
  };
  if (typeof product.default_success_url === "string") productOut.default_success_url = product.default_success_url;
  const objectOut: Record<string, unknown> = {
    id: creemJsonString(obj.id),
    object: creemJsonString(obj.object),
    request_id: creemJsonString(obj.request_id),
    order: {
      object: creemJsonString(order.object),
      id: creemJsonString(order.id),
      customer: creemJsonString(order.customer),
      product: creemJsonString(order.product),
      amount: orderAmount,
      currency: creemJsonString(order.currency),
      sub_total: orderSubTotal,
      tax_amount: orderTax,
      amount_due: orderDue,
      amount_paid: orderPaid,
      status: creemJsonString(order.status),
      type: creemJsonString(order.type),
      transaction: creemJsonString(order.transaction),
      created_at: creemJsonString(order.created_at),
      updated_at: creemJsonString(order.updated_at),
      mode: creemJsonString(order.mode),
    },
    product: productOut,
    units,
    customer: {
      id: creemJsonString(customer.id),
      object: creemJsonString(customer.object),
      email: creemJsonString(customer.email),
      name: creemJsonString(customer.name),
      country: creemJsonString(customer.country),
      created_at: creemJsonString(customer.created_at),
      updated_at: creemJsonString(customer.updated_at),
      mode: creemJsonString(customer.mode),
    },
    status: creemJsonString(obj.status),
    mode: creemJsonString(obj.mode),
  };
  if (metadata && Object.keys(metadata).length) objectOut.metadata = metadata;
  return JSON.stringify({
    id: creemJsonString(event.id),
    eventType: creemJsonString(event.eventType),
    created_at: createdAt,
    object: objectOut,
  });
}

async function creemHandleCheckoutCompleted(
  store: Store,
  req: Request,
  event: Record<string, unknown>,
  payload: string,
): Promise<Response> {
  const obj = isJsonObject(event.object) ? event.object : {};
  const order = isJsonObject(obj.order) ? obj.order : {};
  if (creemJsonString(order.status) !== "paid") return new Response(null, { status: 200 });
  const referenceId = creemJsonString(obj.request_id);
  if (!referenceId) return new Response(null, { status: 400 });
  const result = await tryCompleteSubscriptionOrder(store, referenceId, payload, "creem", "");
  if (result === "completed") return new Response(null, { status: 200 });
  if (result === "rejected") return new Response(null, { status: 500 });
  if (creemJsonString(order.type) !== "onetime") return new Response(null, { status: 200 });
  const row = await store.getTopupByTrade(referenceId);
  if (!row) return new Response(null, { status: 400 });
  if (String(row.status) !== "pending") return new Response(null, { status: 200 });
  const customer = isJsonObject(obj.customer) ? obj.customer : {};
  try {
    await store.rechargeCreem(referenceId, creemJsonString(customer.email), creemJsonString(customer.name), clientIp(req));
  } catch {
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}

/** Original `controller.CreemWebhook`. */
export async function handleCreemWebhook(store: Store, req: Request): Promise<Response> {
  if (!(await creemWebhookEnabled(store))) return new Response(null, { status: 403 });
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  const signature = req.headers.get("creem-signature") || "";
  if (!signature) return new Response(null, { status: 401 });
  const secret = await store.option("CreemWebhookSecret");
  const expected = await hmacSha256Hex(secret, raw);
  if (!timingSafeEqualStr(expected, signature)) return new Response(null, { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (parsed === null) return new Response(null, { status: 200 });
  if (!isJsonObject(parsed)) return new Response(null, { status: 400 });
  const payload = creemFulfillPayload(parsed);
  if (!payload) return new Response(null, { status: 400 });
  if (creemJsonString(parsed.eventType) === "checkout.completed") {
    return creemHandleCheckoutCompleted(store, req, parsed, payload);
  }
  return new Response(null, { status: 200 });
}

const WAFFO_PAYMENT_EVENT = "PAYMENT_NOTIFICATION";
const WAFFO_WEBHOOK_SUCCESS_BODY = '{"message":"success"}';
const WAFFO_WEBHOOK_FAILED_BODY = '{"message":"failed"}';

const WAFFO_PAYMENT_STRING_FIELDS = [
  "paymentRequestId",
  "merchantOrderId",
  "acquiringOrderId",
  "orderStatus",
  "orderAction",
  "orderCurrency",
  "orderAmount",
  "userCurrency",
  "finalDealAmount",
  "orderDescription",
  "orderRequestedAt",
  "orderExpiredAt",
  "orderUpdatedAt",
  "orderCompletedAt",
  "extendInfo",
  "refundExpiryAt",
  "cancelRedirectUrl",
] as const;

const WAFFO_PAYMENT_OBJECT_FIELDS = ["merchantInfo", "userInfo", "goodsInfo", "addressInfo", "paymentInfo"] as const;

function abortStatus(status: number): Response {
  return new Response(null, { status });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Original waffo-go `WebhookHandler.BuildSuccessResponse` / `BuildFailedResponse`. */
async function sendWaffoWebhookResponse(privateKey: string, success: boolean): Promise<Response> {
  const body = success ? WAFFO_WEBHOOK_SUCCESS_BODY : WAFFO_WEBHOOK_FAILED_BODY;
  const signature = (await signWaffoBody(body, privateKey)) || "";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "X-SIGNATURE": signature,
    },
  });
}

/** Original `encoding/json` into `webhookPayloadWithSubInfo` / `PaymentNotificationResult`. */
function parseWaffoPaymentResult(result: unknown): { merchantOrderId: string; orderStatus: string } | null {
  if (result == null) return { merchantOrderId: "", orderStatus: "" };
  if (!isJsonObject(result)) return null;
  for (const field of WAFFO_PAYMENT_STRING_FIELDS) {
    if (field in result && result[field] != null && typeof result[field] !== "string") return null;
  }
  for (const field of WAFFO_PAYMENT_OBJECT_FIELDS) {
    if (field in result && result[field] != null && !isJsonObject(result[field])) return null;
  }
  if ("subscriptionInfo" in result && result.subscriptionInfo != null && !isJsonObject(result.subscriptionInfo)) return null;
  if (
    "orderFailedReason" in result &&
    result.orderFailedReason != null &&
    typeof result.orderFailedReason !== "string" &&
    !isJsonObject(result.orderFailedReason)
  ) {
    return null;
  }
  return {
    merchantOrderId: typeof result.merchantOrderId === "string" ? result.merchantOrderId : "",
    orderStatus: typeof result.orderStatus === "string" ? result.orderStatus : "",
  };
}

/** Original `controller.WaffoWebhook` + `handleWaffoPayment` + `sendWaffoWebhookResponse`. */
export async function handleWaffoWebhook(store: Store, req: Request): Promise<Response> {
  if (!(await paymentEnabled(store, "waffo"))) return abortStatus(403);
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return abortStatus(400);
  }
  const creds = await waffoCredentials(store);
  if (!creds) return abortStatus(500);
  const signature = req.headers.get("X-SIGNATURE") || "";
  if (!(await verifyWaffoBody(raw, signature, creds.publicKey))) return abortStatus(400);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return sendWaffoWebhookResponse(creds.privateKey, false);
  }
  if (parsed === null) return sendWaffoWebhookResponse(creds.privateKey, true);
  if (!isJsonObject(parsed)) return sendWaffoWebhookResponse(creds.privateKey, false);
  if ("eventType" in parsed && parsed.eventType != null && typeof parsed.eventType !== "string") {
    return sendWaffoWebhookResponse(creds.privateKey, false);
  }
  const eventType = typeof parsed.eventType === "string" ? parsed.eventType : "";
  if (eventType !== WAFFO_PAYMENT_EVENT) return sendWaffoWebhookResponse(creds.privateKey, true);

  const payment = parseWaffoPaymentResult(parsed.result);
  if (!payment) return sendWaffoWebhookResponse(creds.privateKey, false);
  if (payment.orderStatus !== "PAY_SUCCESS") {
    if (payment.merchantOrderId) {
      try {
        await store.updatePendingTopupStatus(payment.merchantOrderId, "waffo", "failed");
      } catch {
        /* original ignores not-found / status-invalid and still acks */
      }
    }
    return sendWaffoWebhookResponse(creds.privateKey, true);
  }
  try {
    await store.rechargeWaffo(payment.merchantOrderId, clientIp(req));
  } catch {
    return sendWaffoWebhookResponse(creds.privateKey, false);
  }
  return sendWaffoWebhookResponse(creds.privateKey, true);
}

function pancakeWebhookText(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function handleWaffoPancakeWebhook(
  store: Store,
  req: Request,
  envParam: string,
  processEnv: Env | undefined = undefined,
): Promise<Response> {
  if (!(await paymentEnabled(store, "waffo_pancake"))) {
    return pancakeWebhookText(403, "webhook disabled");
  }
  const expectedEnv = String(envParam || "").trim();
  if (expectedEnv !== "test" && expectedEnv !== "prod") {
    return pancakeWebhookText(404, "unknown env");
  }
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return pancakeWebhookText(400, "bad request");
  }
  const signature = req.headers.get("X-Waffo-Signature") || "";
  let event;
  try {
    event = await verifyWaffoPancakeWebhook(raw, signature, {
      WAFFO_WEBHOOK_TEST_PUBLIC_KEY: processEnv?.WAFFO_WEBHOOK_TEST_PUBLIC_KEY,
      WAFFO_WEBHOOK_PROD_PUBLIC_KEY: processEnv?.WAFFO_WEBHOOK_PROD_PUBLIC_KEY,
      WAFFO_WEBHOOK_PUBLIC_KEY: processEnv?.WAFFO_WEBHOOK_PUBLIC_KEY,
    });
  } catch {
    return pancakeWebhookText(401, "invalid signature");
  }
  if (event.mode.trim().toLowerCase() !== expectedEnv.toLowerCase()) {
    return pancakeWebhookText(200, "OK");
  }
  if (event.eventType !== "order.completed") return pancakeWebhookText(200, "OK");
  const rawTradeNo = String(event.data.orderMerchantExternalId || "").trim();
  if (rawTradeNo.startsWith("WAFFO_PANCAKE_SUB-")) {
    const trade = await resolveWaffoPancakeSubscriptionTradeNo(store, event);
    if (!trade) return pancakeWebhookText(200, "OK");
    const result = await tryCompleteSubscriptionOrder(store, trade, raw, "waffo_pancake", "");
    if (result !== "completed") return pancakeWebhookText(500, "retry");
    return pancakeWebhookText(200, "OK");
  }
  const trade = await resolveWaffoPancakeTradeNo(store, event);
  if (!trade) return pancakeWebhookText(200, "OK");
  try {
    await store.rechargeWaffoPancake(trade);
  } catch {
    return pancakeWebhookText(500, "retry");
  }
  return pancakeWebhookText(200, "OK");
}

async function resolveWaffoPancakeTradeNo(
  store: Store,
  event: { data: { orderMerchantExternalId?: string; merchantProvidedBuyerIdentity?: string } },
): Promise<string | null> {
  const tradeNo = String(event.data.orderMerchantExternalId || "").trim();
  if (!tradeNo) return null;
  const row = await store.getTopupByTrade(tradeNo);
  if (!row || String(row.payment_provider || "") !== "waffo_pancake") return null;
  const expected = waffoPancakeBuyerIdentityFromUserId(Number(row.user_id || 0));
  const actual = String(event.data.merchantProvidedBuyerIdentity || "").trim();
  if (actual !== expected) return null;
  return tradeNo;
}

async function resolveWaffoPancakeSubscriptionTradeNo(
  store: Store,
  event: { data: { orderMerchantExternalId?: string; merchantProvidedBuyerIdentity?: string } },
): Promise<string | null> {
  const tradeNo = String(event.data.orderMerchantExternalId || "").trim();
  if (!tradeNo) return null;
  const order = await store.getSubscriptionOrderByTrade(tradeNo);
  if (!order || String(order.payment_provider || "") !== "waffo_pancake") return null;
  const expected = waffoPancakeBuyerIdentityFromUserId(Number(order.user_id || 0));
  const actual = String(event.data.merchantProvidedBuyerIdentity || "").trim();
  if (actual !== expected) return null;
  return tradeNo;
}

export async function tryCompleteSubscriptionOrder(
  store: Store,
  tradeNo: string,
  providerPayload: string,
  expectedPaymentProvider: string,
  actualPaymentMethod: string,
): Promise<"completed" | "not_found" | "rejected"> {
  try {
    await store.completeSubscriptionOrder(tradeNo, providerPayload, expectedPaymentProvider, actualPaymentMethod);
    return "completed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === ERR_SUBSCRIPTION_ORDER_NOT_FOUND) return "not_found";
    return "rejected";
  }
}

/** Dispatch original `Recharge*` by `payment_provider`. Returns false when the order is missing or settlement fails. */
export async function completePendingTopup(
  store: Store,
  tradeNo: string,
  extras: {
    callerIp?: string;
    customerId?: string;
    customerEmail?: string;
    customerName?: string;
    actualPaymentMethod?: string;
  } = {},
): Promise<boolean> {
  const row = await store.getTopupByTrade(tradeNo);
  if (!row) return false;
  const provider = String(row.payment_provider || "");
  try {
    if (provider === "stripe") await store.rechargeStripe(tradeNo, extras.customerId || "", extras.callerIp || "");
    else if (provider === "creem") {
      await store.rechargeCreem(tradeNo, extras.customerEmail || "", extras.customerName || "", extras.callerIp || "");
    } else if (provider === "waffo") await store.rechargeWaffo(tradeNo, extras.callerIp || "");
    else if (provider === "waffo_pancake") await store.rechargeWaffoPancake(tradeNo);
    else await store.rechargeEpay(tradeNo, extras.actualPaymentMethod || "", extras.callerIp || "");
    return true;
  } catch {
    return false;
  }
}
