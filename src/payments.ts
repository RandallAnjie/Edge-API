import { nowSec, parseJson, randomHex } from "./constants.js";
import { hmacSha256Hex, sha1Hex, timingSafeEqualStr } from "./crypto.js";
import { apiFail, json, payErr, payOk, readJson } from "./http.js";
import { PAYMENT_COMPLIANCE_REQUIRED } from "./subscription.js";
import type { Store } from "./store.js";
import type { UserRow } from "./types.js";

export { PAYMENT_COMPLIANCE_REQUIRED };

export async function paymentComplianceConfirmed(store: Store): Promise<boolean> {
  return store.optionBool("PaymentComplianceConfirmed", false);
}

export async function requirePaymentCompliance(store: Store): Promise<Response | null> {
  if (await paymentComplianceConfirmed(store)) return null;
  return apiFail(PAYMENT_COMPLIANCE_REQUIRED);
}

export async function paymentConfigured(store: Store, kind: "stripe" | "epay" | "creem" | "waffo" | "waffo_pancake"): Promise<boolean> {
  if (kind === "stripe") {
    return Boolean(await stripeSecret(store)) && Boolean(await store.option("StripeWebhookSecret")) && Boolean(await store.option("StripePriceId"));
  }
  if (kind === "epay") {
    const address = (await store.option("PayAddress")) || (await store.option("EpayUrl"));
    const methods = parseJson<unknown[]>(await store.option("PayMethods"), []);
    return Boolean(address) && Boolean(await store.option("EpayPid")) && Boolean(await store.option("EpayKey")) && methods.length > 0;
  }
  if (kind === "creem") {
    const products = ((await store.option("CreemProducts")) || "").trim();
    return Boolean(await store.option("CreemApiKey")) && products !== "" && products !== "[]";
  }
  if (kind === "waffo_pancake") {
    return (
      Boolean(await store.option("WaffoPancakeMerchantID")) &&
      Boolean((await store.option("WaffoPancakePrivateKey")) || (await store.option("WaffoPancakeApiKey"))) &&
      Boolean(await store.option("WaffoPancakeProductID"))
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

async function stripeSecret(store: Store): Promise<string> {
  return (await store.option("StripeApiSecret")) || (await store.option("StripeApiKey")) || (await store.option("StripeSecretKey"));
}

export async function topupInfo(store: Store): Promise<Record<string, unknown>> {
  const stripe = await paymentEnabled(store, "stripe");
  const epay = await paymentEnabled(store, "epay");
  const creem = await paymentEnabled(store, "creem");
  const waffo = await paymentEnabled(store, "waffo");
  const waffoPancake = await paymentEnabled(store, "waffo_pancake");
  const complianceConfirmed = await store.optionBool("PaymentComplianceConfirmed", false);
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
    payment_compliance_terms_version: (await store.option("PaymentComplianceTermsVersion")) || "v1",
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
    stripe,
    epay,
    creem,
    waffo,
    quota_per_unit: await store.optionNum("QuotaPerUnit", 500000),
    stripe_unit_price: await store.optionNum("StripeUnitPrice", 8),
    price: await store.optionNum("Price", 7.3),
    usd_exchange_rate: await store.optionNum("USDExchangeRate", 1),
  };
}

function paymentReturnPath(req: Request, suffix: string, serverAddress = ""): string {
  const base = (serverAddress || new URL(req.url).origin).replace(/\/+$/, "");
  return base + suffix;
}

function payMoney(amount: number, unitPrice: number): number {
  return Math.round(amount * unitPrice * 100) / 100;
}

export async function requestAmount(store: Store, body: { amount?: number; payment_method?: string }): Promise<Response> {
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("MinTopup", 1);
  if (amount < min) return apiFail(`充值数量不能小于 ${min}`);
  if (amount > 10000) return apiFail("充值数量不能大于 10000");
  const method = body.payment_method || "stripe";
  const unit =
    method === "stripe" ? await store.optionNum("StripeUnitPrice", 8) : await store.optionNum("Price", 7.3);
  return json(200, { message: "success", data: String(payMoney(amount, unit)), success: true });
}

export async function requestStripePay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; payment_method?: string; success_url?: string; cancel_url?: string },
): Promise<Response> {
  if ((body.payment_method || "") !== "stripe") return payErr("不支持的支付渠道");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("StripeMinTopUp", await store.optionNum("MinTopup", 1));
  if (amount < min) return json(200, { message: `充值数量不能小于 ${min}`, data: 10, success: false });
  if (amount > 10000) return json(200, { message: "充值数量不能大于 10000", data: 10, success: false });
  const secret = await stripeSecret(store);
  if (!secret.startsWith("sk_") && !secret.startsWith("rk_")) return payErr("拉起支付失败");
  const unitPrice = await store.optionNum("StripeUnitPrice", 8);
  const money = payMoney(amount, unitPrice);
  if (money <= 0.01) return payErr("充值金额过低");
  const reference = `new-api-ref-${user.id}-${Date.now()}-${randomHex(2)}`;
  const trade = "ref_" + (await sha1Hex(reference));
  await store.insertTopup({
    user_id: user.id,
    amount,
    money,
    trade_no: trade,
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  const priceId = await store.option("StripePriceId");
  const params = new URLSearchParams({
    mode: "payment",
    success_url: body.success_url || paymentReturnPath(req, "/usage-logs"),
    cancel_url: body.cancel_url || paymentReturnPath(req, "/wallet"),
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": String(amount),
    client_reference_id: trade,
  });
  if (await store.optionBool("StripePromotionCodesEnabled", false)) {
    params.set("allow_promotion_codes", "true");
  }
  let stripeCustomer = "";
  try {
    const parsed = JSON.parse(user.settings || "{}") as Record<string, unknown>;
    stripeCustomer = String(parsed.stripe_customer || parsed.stripeCustomer || "");
  } catch {
    /* ignore */
  }
  if (stripeCustomer) {
    params.set("customer", stripeCustomer);
  } else {
    if (user.email) params.set("customer_email", user.email);
    params.set("customer_creation", "always");
  }
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
  return payOk({ pay_link: data.url });
}

export async function handleStripeWebhook(store: Store, req: Request): Promise<Response> {
  if (!(await paymentEnabled(store, "stripe"))) return new Response(null, { status: 403 });
  const secret = await store.option("StripeWebhookSecret");
  const raw = await req.text();
  if (secret) {
    const header = req.headers.get("stripe-signature") || "";
    const parts = Object.fromEntries(
      header.split(",").map((p) => {
        const [k, ...rest] = p.split("=");
        return [k.trim(), rest.join("=")];
      }),
    );
    const signed = `${parts.t}.${raw}`;
    const expected = await hmacSha256Hex(secret, signed);
    if (!timingSafeEqualStr(expected, parts.v1 || "")) return new Response(null, { status: 400 });
  }
  const event = parseJson<{ type?: string; data?: { object?: Record<string, unknown> } }>(raw, {});
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const obj = event.data?.object || {};
    const status = String(obj.status || "");
    const paymentStatus = String(obj.payment_status || "");
    if (event.type === "checkout.session.completed" && status && status !== "complete") {
      return new Response(null, { status: 200 });
    }
    if (event.type === "checkout.session.completed" && paymentStatus && paymentStatus !== "paid") {
      return new Response(null, { status: 200 });
    }
    const trade = String(obj.client_reference_id || (obj.metadata as { trade_no?: string } | undefined)?.trade_no || "");
    if (trade) await completePendingTopup(store, trade);
  }
  return new Response(null, { status: 200 });
}

export async function requestEpay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; payment_method?: string },
): Promise<Response> {
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("MinTopup", 1);
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const methods = parseJson<{ type?: string }[]>(await store.option("PayMethods"), []);
  const method = body.payment_method || "alipay";
  if (methods.length && !methods.some((m) => m.type === method)) return payErr("支付方式不存在");
  const pid = await store.option("EpayPid");
  const key = await store.option("EpayKey");
  const gateway = (await store.option("PayAddress")) || (await store.option("EpayUrl")) || "";
  if (!gateway || !pid || !key) return payErr("当前管理员未配置支付信息");
  const origin = new URL(req.url).origin;
  const money = payMoney(amount, await store.optionNum("Price", 7.3));
  const trade = "ep_" + randomHex(12);
  await store.insertTopup({
    user_id: user.id,
    amount,
    money,
    trade_no: trade,
    payment_method: body.payment_method || "alipay",
    payment_provider: "epay",
    status: "pending",
  });
  const params: Record<string, string> = {
    pid,
    type: body.payment_method || "alipay",
    out_trade_no: trade,
    notify_url: `${origin}/api/user/epay/notify`,
    return_url: paymentReturnPath(req, "/usage-logs"),
    name: "quota",
    money: money.toFixed(2),
  };
  const signStr =
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&") + key;
  const { md5Hex } = await import("./crypto.js");
  params.sign = await md5Hex(signStr);
  params.sign_type = "MD5";
  const url = gateway + (gateway.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();
  return json(200, { message: "success", data: params, url, success: true });
}

export async function handleEpayNotify(store: Store, req: Request, url: URL): Promise<Response> {
  const params = url.searchParams;
  let trade = params.get("out_trade_no") || "";
  let status = params.get("trade_status") || params.get("status") || "";
  if (req.method === "POST") {
    const body = (await readJson(req).catch(() => ({}))) as Record<string, string>;
    trade = trade || String(body.out_trade_no || "");
    status = status || String(body.trade_status || body.status || "");
  }
  if (!trade) return new Response("fail", { status: 400 });
  if (status && status !== "TRADE_SUCCESS" && status !== "success" && status !== "1") {
    return new Response("fail", { status: 400 });
  }
  await completePendingTopup(store, trade);
  return new Response("success", { headers: { "content-type": "text/plain" } });
}

type CreemProduct = { productId?: string; name?: string; price?: number; quota?: number; currency?: string };

export async function requestCreemPay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { product_id?: string; payment_method?: string },
): Promise<Response> {
  if ((body.payment_method || "creem") !== "creem") return payErr("不支持的支付渠道");
  if (!body.product_id) return payErr("请选择产品");
  const apiKey = await store.option("CreemApiKey");
  if (!apiKey) return payErr("未配置Creem API密钥");
  const products = parseJson<CreemProduct[]>(await store.option("CreemProducts"), []);
  if (!products.length) return payErr("产品配置错误");
  const selected = products.find((p) => p.productId === body.product_id);
  if (!selected) return payErr("产品不存在");
  const trade = "ref_" + randomHex(16);
  await store.insertTopup({
    user_id: user.id,
    amount: Number(selected.quota || 0),
    money: Number(selected.price || 0),
    trade_no: trade,
    payment_method: "creem",
    payment_provider: "creem",
    status: "pending",
  });
  const testMode = await store.optionBool("CreemTestMode", false);
  const endpoint = (await store.option("CreemCheckoutUrl")) || (testMode ? "https://test-api.creem.io/v1/checkouts" : "https://api.creem.io/v1/checkouts");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      product_id: selected.productId,
      request_id: trade,
      customer: { email: user.email || `${user.username}@users.invalid` },
      metadata: {
        username: user.username,
        reference_id: trade,
        product_name: selected.name || "",
        quota: String(selected.quota || 0),
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { checkout_url?: string; id?: string };
  if (!res.ok || !data.checkout_url) return payErr("拉起支付失败");
  void req;
  return payOk({ checkout_url: data.checkout_url, order_id: trade });
}

export async function requestWaffoPay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; pay_method_index?: number; pay_method_type?: string; pay_method_name?: string },
): Promise<Response> {
  if (!(await store.optionBool("WaffoEnabled", false))) return payErr("Waffo 支付未启用");
  if (!(await paymentConfigured(store, "waffo"))) return payErr("支付配置错误");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("WaffoMinTopUp", await store.optionNum("MinTopup", 1));
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const money = payMoney(amount, await store.optionNum("Price", 7.3));
  if (money < 0.01) return payErr("充值金额过低");
  const trade = `WAFFO-${user.id}-${Date.now()}-${randomHex(3)}`;
  await store.insertTopup({
    user_id: user.id,
    amount,
    money,
    trade_no: trade,
    payment_method: "waffo",
    payment_provider: "waffo",
    status: "pending",
  });
  const endpoint = (await store.option("WaffoCheckoutUrl")) || "https://api.waffo.com/v1/checkout";
  const apiKey = await store.option("WaffoApiKey");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      paymentRequestId: trade,
      merchantOrderId: trade,
      orderAmount: money.toFixed(2),
      notifyUrl: (await store.option("WaffoNotifyUrl")) || `${new URL(req.url).origin}/api/waffo/webhook`,
      successRedirectURL: paymentReturnPath(req, "/wallet?show_history=true"),
      failedRedirectURL: paymentReturnPath(req, "/wallet?show_history=true"),
      payMethodIndex: body.pay_method_index,
      payMethodType: body.pay_method_type,
      payMethodName: body.pay_method_name,
      userId: String(user.id),
      userEmail: user.email || "",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    payment_url?: string;
    checkout_url?: string;
    url?: string;
    orderAction?: string;
  };
  const paymentUrl = data.payment_url || data.checkout_url || data.url || data.orderAction || "";
  if (!res.ok || !paymentUrl) return payErr("拉起支付失败");
  return payOk({ payment_url: paymentUrl, order_id: trade });
}

export async function requestWaffoPancakePay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number },
): Promise<Response> {
  if (!(await paymentEnabled(store, "waffo_pancake"))) return payErr("Waffo Pancake 配置不完整");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("WaffoPancakeMinTopUp", await store.optionNum("MinTopup", 1));
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const money = payMoney(amount, await store.optionNum("Price", 7.3));
  const trade = `WAFFO_PANCAKE-${user.id}-${Date.now()}-${randomHex(3)}`;
  await store.insertTopup({
    user_id: user.id,
    amount,
    money,
    trade_no: trade,
    payment_method: "waffo_pancake",
    payment_provider: "waffo_pancake",
    status: "pending",
  });
  const endpoint = (await store.option("WaffoPancakeCheckoutUrl")) || "https://api.waffo.com/v1/pancake/checkout";
  const apiKey = (await store.option("WaffoPancakeApiKey")) || (await store.option("WaffoPancakePrivateKey"));
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      productId: await store.option("WaffoPancakeProductID"),
      merchantId: await store.option("WaffoPancakeMerchantID"),
      orderMerchantExternalId: trade,
      amount: money.toFixed(2),
      buyerEmail: user.email || "",
      expiresInSeconds: 45 * 60,
      successUrl: paymentReturnPath(req, "/wallet?show_history=true"),
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
  if (!res.ok || !checkoutUrl) return payErr("拉起支付失败");
  return payOk({
    checkout_url: checkoutUrl,
    session_id: data.session_id || data.sessionId || "",
    expires_at: data.expires_at || data.expiresAt || nowSec() + 45 * 60,
    order_id: trade,
    token: data.token || "",
    token_expires_at: data.token_expires_at || data.tokenExpiresAt || nowSec() + 45 * 60,
  });
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

export async function handleCreemWebhook(store: Store, req: Request): Promise<Response> {
  if (!(await paymentEnabled(store, "creem"))) return new Response(null, { status: 403 });
  const secret = await store.option("CreemWebhookSecret");
  const raw = await req.text();
  if (secret) {
    const signature = req.headers.get("creem-signature") || "";
    if (!signature) return new Response(null, { status: 401 });
    const expected = await hmacSha256Hex(secret, raw);
    if (!timingSafeEqualStr(expected, signature)) return new Response(null, { status: 401 });
  }
  const event = parseJson<{ eventType?: string; object?: { request_id?: string; order?: { id?: string; status?: string } } }>(raw, {});
  if (event.eventType === "checkout.completed") {
    if (event.object?.order?.status && event.object.order.status !== "paid") return new Response(null, { status: 200 });
    const trade = String(event.object?.request_id || "");
    if (trade) await completePendingTopup(store, trade);
  }
  return new Response(null, { status: 200 });
}

export async function completePendingTopup(store: Store, tradeNo: string): Promise<boolean> {
  const row = await store.getTopupByTrade(tradeNo);
  if (!row || String(row.status) !== "pending") return false;
  await store.updateTopup(Number(row.id), { status: "success", complete_time: nowSec() });
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const method = String(row.payment_method || "");
  const provider = String(row.payment_provider || "");
  const amount = Number(row.amount || 0);
  const money = Number(row.money || 0);
  let credit = amount;
  if (provider === "stripe" || method === "stripe") credit = Math.round(money * quotaPerUnit);
  else if (provider === "creem" || method === "creem") credit = amount;
  else if (provider === "epay" || provider === "waffo" || provider === "waffo_pancake") {
    credit = Math.round(amount * quotaPerUnit);
  }
  if (credit > 0) await store.addQuota(Number(row.user_id), credit);
  return true;
}
