import { nowSec, parseJson } from "./constants.js";
import { md5Hex, randomCharsKey, sha1Hex } from "./crypto.js";
import { apiFail, json, payErr, payOk, paymentReturnPath, readJson } from "./http.js";
import {
  requirePaymentCompliance,
  stripeSecret,
  tryCompleteSubscriptionOrder,
} from "./payments.js";
import { isResponse, requireUser } from "./auth.js";
import { Store } from "./store.js";
import type { Context } from "./router.js";
import type { Env } from "./types.js";

type C = Context<Env>;

function store(c: C): Store {
  return new Store(c.env.DB);
}

async function callbackAddress(s: Store): Promise<string> {
  return ((await s.option("CustomCallbackAddress")) || (await s.option("ServerAddress")) || "").replace(/\/+$/, "");
}

async function epayClient(s: Store): Promise<{ address: string; pid: string; key: string } | null> {
  const address = (await s.option("PayAddress")) || "";
  const pid = (await s.option("EpayId")) || "";
  const key = (await s.option("EpayKey")) || "";
  if (!address || !pid || !key) return null;
  return { address, pid, key };
}

function containsPayMethod(methods: { type?: string }[], method: string): boolean {
  return methods.some((m) => m.type === method);
}

async function signEpayParams(params: Record<string, string>, key: string): Promise<string> {
  const parts = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return md5Hex(parts.join("&") + key);
}

async function verifyEpayParams(
  params: Record<string, string>,
  key: string,
): Promise<{ ok: boolean; tradeNo: string; type: string; tradeStatus: string }> {
  const sign = String(params.sign || "");
  if (!sign) return { ok: false, tradeNo: "", type: "", tradeStatus: "" };
  const expected = await signEpayParams(params, key);
  const tradeNo = String(params.out_trade_no || params.trade_no || "");
  const type = String(params.type || "");
  const tradeStatus = String(params.trade_status || params.status || "");
  return { ok: expected.toLowerCase() === sign.toLowerCase(), tradeNo, type, tradeStatus };
}

async function collectCallbackParams(req: Request, url: URL): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      new URLSearchParams(text).forEach((v, k) => {
        params[k] = v;
      });
    } else if (ct.includes("application/json")) {
      const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) params[k] = String(v ?? "");
    }
    return params;
  }
  url.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

function epayFail(): Response {
  return new Response("fail", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function epayOk(): Response {
  return new Response("success", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function loadPlanOrError(s: Store, planId: number): Promise<Record<string, unknown> | Response> {
  if (planId <= 0) return apiFail("参数错误");
  const plan = await s.getPlan(planId);
  if (!plan) return apiFail("record not found");
  return plan;
}

async function rejectDisabledOrCapped(
  s: Store,
  userId: number,
  plan: Record<string, unknown>,
): Promise<Response | null> {
  if (!Number(plan.enabled)) return apiFail("套餐未启用");
  const maxPurchase = Number(plan.max_purchase_per_user || 0);
  if (maxPurchase > 0) {
    const count = await s.countUserSubscriptionsByPlan(userId, Number(plan.id || 0));
    if (count >= maxPurchase) return apiFail("已达到该套餐购买上限");
  }
  return null;
}

function moneyOf(plan: Record<string, unknown>): number {
  return Number(plan.price_amount || 0);
}

/** Original `controller.SubscriptionRequestEpay`. */
export async function requestSubscriptionEpay(c: C): Promise<Response> {
  const s = store(c);
  const denied = await requirePaymentCompliance(s);
  if (denied) return denied;
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req).catch(() => ({}))) as { plan_id?: number; payment_method?: string };
  const planId = Number(body.plan_id || 0);
  const planOrErr = await loadPlanOrError(s, planId);
  if (planOrErr instanceof Response) return planOrErr;
  const plan = planOrErr;
  const capped = await rejectDisabledOrCapped(s, u.id, plan);
  if (capped) return capped;
  if (moneyOf(plan) < 0.01) return apiFail("套餐金额过低");
  const methods = parseJson<{ type?: string }[]>(await s.option("PayMethods"), []);
  const method = String(body.payment_method || "");
  if (!containsPayMethod(methods, method)) return apiFail("支付方式不存在");
  const client = await epayClient(s);
  if (!client) return apiFail("当前管理员未配置支付信息");
  const base = await callbackAddress(s);
  const tradeNo = `SUBUSR${u.id}NO${randomCharsKey(6)}${nowSec()}`;
  try {
    await s.insertSubscriptionOrder({
      user_id: u.id,
      plan_id: Number(plan.id),
      money: moneyOf(plan),
      trade_no: tradeNo,
      payment_method: method,
      payment_provider: "epay",
      status: "pending",
    });
  } catch {
    return apiFail("创建订单失败");
  }
  const params: Record<string, string> = {
    pid: client.pid,
    type: method,
    out_trade_no: tradeNo,
    notify_url: `${base}/api/subscription/epay/notify`,
    return_url: `${base}/api/subscription/epay/return`,
    name: `SUB:${String(plan.title || "")}`,
    money: moneyOf(plan).toFixed(2),
    device: "pc",
  };
  params.sign = await signEpayParams(params, client.key);
  params.sign_type = "MD5";
  const url = client.address + (client.address.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();
  return json(200, { message: "success", data: params, url, success: true });
}

/** Original `controller.SubscriptionEpayNotify`. */
export async function handleSubscriptionEpayNotify(c: C): Promise<Response> {
  const s = store(c);
  const params = await collectCallbackParams(c.req, c.url);
  if (!Object.keys(params).length) return epayFail();
  const client = await epayClient(s);
  if (!client) return epayFail();
  const verified = await verifyEpayParams(params, client.key);
  if (!verified.ok) return epayFail();
  if (verified.tradeStatus !== "TRADE_SUCCESS") return epayFail();
  const result = await tryCompleteSubscriptionOrder(s, verified.tradeNo, JSON.stringify(params), "epay", verified.type);
  if (result !== "completed") return epayFail();
  return epayOk();
}

/** Original `controller.SubscriptionEpayReturn`. */
export async function handleSubscriptionEpayReturn(c: C): Promise<Response> {
  const s = store(c);
  const server = await s.option("ServerAddress");
  const redirect = (suffix: string) =>
    new Response(null, { status: 302, headers: { location: paymentReturnPath(server, suffix), "cache-control": "no-store" } });
  const params = await collectCallbackParams(c.req, c.url);
  if (!Object.keys(params).length) return redirect("/wallet?pay=fail");
  const client = await epayClient(s);
  if (!client) return redirect("/wallet?pay=fail");
  const verified = await verifyEpayParams(params, client.key);
  if (!verified.ok) return redirect("/wallet?pay=fail");
  if (verified.tradeStatus === "TRADE_SUCCESS") {
    const result = await tryCompleteSubscriptionOrder(s, verified.tradeNo, JSON.stringify(params), "epay", verified.type);
    if (result !== "completed") return redirect("/wallet?pay=fail");
    return redirect("/wallet?pay=success");
  }
  return redirect("/wallet?pay=pending");
}

/** Original `controller.SubscriptionRequestStripePay`. */
export async function requestSubscriptionStripePay(c: C): Promise<Response> {
  const s = store(c);
  const denied = await requirePaymentCompliance(s);
  if (denied) return denied;
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req).catch(() => ({}))) as { plan_id?: number };
  const planOrErr = await loadPlanOrError(s, Number(body.plan_id || 0));
  if (planOrErr instanceof Response) return planOrErr;
  const plan = planOrErr;
  const capped = await rejectDisabledOrCapped(s, u.id, plan);
  if (capped) return capped;
  if (!String(plan.stripe_price_id || "").trim()) return apiFail("该套餐未配置 StripePriceId");
  const secret = await stripeSecret(s);
  if (!secret.startsWith("sk_") && !secret.startsWith("rk_")) return apiFail("Stripe 未配置或密钥无效");
  if (!(await s.option("StripeWebhookSecret"))) return apiFail("Stripe Webhook 未配置");
  const user = await s.getUserById(u.id);
  if (!user) return apiFail("用户不存在");
  const reference = `sub-stripe-ref-${user.id}-${Date.now()}-${randomCharsKey(4)}`;
  const referenceId = "sub_ref_" + (await sha1Hex(reference));
  const server = await s.option("ServerAddress");
  const params = new URLSearchParams({
    mode: "subscription",
    success_url: paymentReturnPath(server, "/wallet"),
    cancel_url: paymentReturnPath(server, "/wallet"),
    "line_items[0][price]": String(plan.stripe_price_id),
    "line_items[0][quantity]": "1",
    client_reference_id: referenceId,
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
  if (stripeCustomer) params.set("customer", stripeCustomer);
  else {
    if (user.email) params.set("customer_email", user.email);
    params.set("customer_creation", "always");
  }
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string };
  if (!res.ok || !data.url) return payErr("拉起支付失败");
  try {
    await s.insertSubscriptionOrder({
      user_id: user.id,
      plan_id: Number(plan.id),
      money: moneyOf(plan),
      trade_no: referenceId,
      payment_method: "stripe",
      payment_provider: "stripe",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  return payOk({ pay_link: data.url });
}

async function creemCurrency(s: Store): Promise<string> {
  const display = (await s.option("general_setting.quota_display_type")) || (await s.option("QuotaDisplayType")) || "USD";
  return display === "CNY" ? "CNY" : "USD";
}

/** Original `controller.SubscriptionRequestCreemPay`. */
export async function requestSubscriptionCreemPay(c: C): Promise<Response> {
  const s = store(c);
  const denied = await requirePaymentCompliance(s);
  if (denied) return denied;
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req).catch(() => ({}))) as { plan_id?: number };
  const planId = Number(body.plan_id || 0);
  if (planId <= 0) return payErr("参数错误");
  const plan = await s.getPlan(planId);
  if (!plan) return apiFail("record not found");
  const capped = await rejectDisabledOrCapped(s, u.id, plan);
  if (capped) return capped;
  if (!String(plan.creem_product_id || "").trim()) return apiFail("该套餐未配置 CreemProductId");
  const testMode = await s.optionBool("CreemTestMode", false);
  if (!(await s.option("CreemWebhookSecret")) && !testMode) return apiFail("Creem Webhook 未配置");
  const user = await s.getUserById(u.id);
  if (!user) return apiFail("用户不存在");
  const reference = "sub-creem-ref-" + randomCharsKey(6);
  const referenceId = "sub_ref_" + (await sha1Hex(reference + new Date().toString() + user.username));
  try {
    await s.insertSubscriptionOrder({
      user_id: user.id,
      plan_id: Number(plan.id),
      money: moneyOf(plan),
      trade_no: referenceId,
      payment_method: "creem",
      payment_provider: "creem",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  const apiKey = await s.option("CreemApiKey");
  const endpoint =
    (await s.option("CreemCheckoutUrl")) || (testMode ? "https://test-api.creem.io/v1/checkouts" : "https://api.creem.io/v1/checkouts");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      product_id: String(plan.creem_product_id),
      request_id: referenceId,
      customer: { email: user.email || "" },
      metadata: {
        username: user.username,
        reference_id: referenceId,
        product_name: String(plan.title || ""),
        quota: "0",
        currency: await creemCurrency(s),
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { checkout_url?: string };
  if (!res.ok || !data.checkout_url) return payErr("拉起支付失败");
  return payOk({ checkout_url: data.checkout_url, order_id: referenceId });
}

function waffoPancakeBuyerIdentity(userId: number): string {
  return `new-api-user-${userId}`;
}

/** Original `controller.SubscriptionRequestWaffoPancakePay`. */
export async function requestSubscriptionWaffoPancakePay(c: C): Promise<Response> {
  const s = store(c);
  const denied = await requirePaymentCompliance(s);
  if (denied) return denied;
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req).catch(() => ({}))) as { plan_id?: number };
  const planOrErr = await loadPlanOrError(s, Number(body.plan_id || 0));
  if (planOrErr instanceof Response) return planOrErr;
  const plan = planOrErr;
  const capped = await rejectDisabledOrCapped(s, u.id, plan);
  if (capped) return capped;
  if (!String(plan.waffo_pancake_product_id || "").trim()) return apiFail("该套餐未配置 WaffoPancakeProductId");
  const merchant = (await s.option("WaffoPancakeMerchantID")) || "";
  const privateKey = (await s.option("WaffoPancakePrivateKey")) || "";
  if (!merchant.trim() || !privateKey.trim()) return apiFail("Waffo Pancake 未配置或密钥无效");
  const user = await s.getUserById(u.id);
  if (!user) return apiFail("用户不存在");
  const tradeNo = `WAFFO_PANCAKE_SUB-${user.id}-${Date.now()}-${randomCharsKey(6)}`;
  try {
    await s.insertSubscriptionOrder({
      user_id: user.id,
      plan_id: Number(plan.id),
      money: moneyOf(plan),
      trade_no: tradeNo,
      payment_method: "waffo_pancake",
      payment_provider: "waffo_pancake",
      status: "pending",
    });
  } catch {
    return payErr("创建订单失败");
  }
  const endpoint = (await s.option("WaffoPancakeCheckoutUrl")) || "https://api.waffo.com/v1/pancake/checkout";
  const apiKey = (await s.option("WaffoPancakeApiKey")) || privateKey;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      productId: String(plan.waffo_pancake_product_id),
      merchantId: merchant,
      orderMerchantExternalId: tradeNo,
      buyerIdentity: waffoPancakeBuyerIdentity(user.id),
      amount: moneyOf(plan).toFixed(2),
      priceSnapshot: { amount: moneyOf(plan).toFixed(2), taxCategory: "saas" },
      buyerEmail: (user.email || "").trim(),
      expiresInSeconds: 45 * 60,
      successUrl: paymentReturnPath(await s.option("ServerAddress"), "/wallet?show_history=true"),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    checkout_url?: string;
    checkoutUrl?: string;
    session_id?: string;
    sessionId?: string;
    expires_at?: number | string;
    expiresAt?: number | string;
    token?: string;
    token_expires_at?: number | string;
    tokenExpiresAt?: number | string;
  };
  const checkoutUrl = data.checkout_url || data.checkoutUrl || "";
  if (!res.ok || !checkoutUrl) {
    const order = await s.getSubscriptionOrderByTrade(tradeNo);
    if (order) await s.updateSubscriptionOrder(Number(order.id), { status: "failed" });
    return payErr("拉起支付失败");
  }
  return payOk({
    checkout_url: checkoutUrl,
    session_id: data.session_id || data.sessionId || "",
    expires_at: data.expires_at || data.expiresAt || nowSec() + 45 * 60,
    order_id: tradeNo,
    token: data.token || "",
    token_expires_at: data.token_expires_at || data.tokenExpiresAt || nowSec() + 45 * 60,
  });
}
