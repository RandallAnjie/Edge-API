import { nowSec, parseJson, randomHex } from "./constants.js";
import { hmacSha256Hex, timingSafeEqualStr } from "./crypto.js";
import { apiFail, apiOk, json, readJson } from "./http.js";
import type { Store } from "./store.js";
import type { UserRow } from "./types.js";

export async function paymentEnabled(store: Store, kind: "stripe" | "epay" | "creem" | "waffo"): Promise<boolean> {
  if (kind === "stripe") {
    return (await store.optionBool("StripeEnabled", false)) && Boolean(await stripeSecret(store));
  }
  if (kind === "epay") {
    return (await store.optionBool("EpayEnabled", false)) && Boolean(await store.option("EpayPid")) && Boolean(await store.option("EpayKey"));
  }
  if (kind === "creem") {
    return (await store.optionBool("CreemEnabled", false)) && Boolean(await store.option("CreemApiKey"));
  }
  return (await store.optionBool("WaffoEnabled", false)) && Boolean(await store.option("WaffoApiKey"));
}

async function stripeSecret(store: Store): Promise<string> {
  return (await store.option("StripeApiSecret")) || (await store.option("StripeApiKey")) || (await store.option("StripeSecretKey"));
}

export async function topupInfo(store: Store): Promise<Record<string, unknown>> {
  const stripe = await paymentEnabled(store, "stripe");
  const epay = await paymentEnabled(store, "epay");
  const creem = await paymentEnabled(store, "creem");
  const waffo = await paymentEnabled(store, "waffo");
  const waffoPancake = (await store.optionBool("WaffoPancakeEnabled", false)) && waffo;
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
  if (!(await paymentEnabled(store, "stripe"))) return apiFail("Stripe 未配置");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("MinTopup", 1);
  if (amount < min) return apiFail(`充值数量不能小于 ${min}`);
  const secret = await stripeSecret(store);
  const origin = new URL(req.url).origin;
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const unitPrice = await store.optionNum("StripeUnitPrice", 8);
  const money = payMoney(amount, unitPrice);
  const trade = "st_" + randomHex(12);
  const credited = Math.round(amount * quotaPerUnit);
  await store.insertTopup({
    user_id: user.id,
    amount: credited,
    money,
    trade_no: trade,
    payment_method: "stripe",
    status: "pending",
  });
  const params = new URLSearchParams({
    mode: "payment",
    success_url: body.success_url || `${origin}/#/wallet?topup=success`,
    cancel_url: body.cancel_url || `${origin}/#/wallet?topup=cancel`,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": `Quota x${amount}`,
    "line_items[0][price_data][unit_amount]": String(Math.round(money * 100)),
    "line_items[0][quantity]": "1",
    client_reference_id: trade,
    "metadata[user_id]": String(user.id),
    "metadata[trade_no]": trade,
    "metadata[quota]": String(credited),
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !data.url) return apiFail(data.error?.message || "Stripe Checkout 创建失败");
  return apiOk({ url: data.url, checkout_url: data.url, trade_no: trade, session_id: data.id });
}

export async function handleStripeWebhook(store: Store, req: Request): Promise<Response> {
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
    if (!timingSafeEqualStr(expected, parts.v1 || "")) return apiFail("invalid signature", null, 400);
  }
  const event = parseJson<{ type?: string; data?: { object?: Record<string, unknown> } }>(raw, {});
  if (event.type === "checkout.session.completed") {
    const obj = event.data?.object || {};
    const trade = String(obj.client_reference_id || (obj.metadata as { trade_no?: string } | undefined)?.trade_no || "");
    if (trade) await completePendingTopup(store, trade);
  }
  return apiOk({ received: true });
}

export async function requestEpay(
  store: Store,
  user: UserRow,
  req: Request,
  body: { amount?: number; payment_method?: string },
): Promise<Response> {
  if (!(await paymentEnabled(store, "epay"))) return apiFail("Epay 未配置");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("MinTopup", 1);
  if (amount < min) return apiFail(`充值数量不能小于 ${min}`);
  const pid = await store.option("EpayPid");
  const key = await store.option("EpayKey");
  const gateway = (await store.option("EpayUrl")) || "https://pay.example.com/submit.php";
  const origin = new URL(req.url).origin;
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const money = payMoney(amount, await store.optionNum("Price", 7.3));
  const trade = "ep_" + randomHex(12);
  const credited = Math.round(amount * quotaPerUnit);
  await store.insertTopup({
    user_id: user.id,
    amount: credited,
    money,
    trade_no: trade,
    payment_method: body.payment_method || "alipay",
    status: "pending",
  });
  const params: Record<string, string> = {
    pid,
    type: body.payment_method || "alipay",
    out_trade_no: trade,
    notify_url: `${origin}/api/user/epay/notify`,
    return_url: `${origin}/#/wallet`,
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
  return apiOk({ url, pay_link: url, trade_no: trade });
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

export async function requestHttpPay(
  store: Store,
  user: UserRow,
  req: Request,
  kind: "creem" | "waffo",
  body: { amount?: number; success_url?: string },
): Promise<Response> {
  if (!(await paymentEnabled(store, kind))) return apiFail(kind === "creem" ? "Creem 未配置" : "Waffo 未配置");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("MinTopup", 1);
  if (amount < min) return apiFail(`充值数量不能小于 ${min}`);
  const origin = new URL(req.url).origin;
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const money = payMoney(amount, await store.optionNum("Price", 7.3));
  const trade = (kind === "creem" ? "cr_" : "wf_") + randomHex(12);
  const credited = Math.round(amount * quotaPerUnit);
  await store.insertTopup({
    user_id: user.id,
    amount: credited,
    money,
    trade_no: trade,
    payment_method: kind,
    status: "pending",
  });
  const endpoint =
    kind === "creem"
      ? (await store.option("CreemCheckoutUrl")) || "https://api.creem.io/v1/checkouts"
      : (await store.option("WaffoCheckoutUrl")) || "https://api.waffo.com/v1/checkout";
  const apiKey = kind === "creem" ? await store.option("CreemApiKey") : await store.option("WaffoApiKey");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      amount: money,
      currency: "USD",
      success_url: body.success_url || `${origin}/#/wallet`,
      metadata: { user_id: user.id, trade_no: trade, quota: credited },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; checkout_url?: string; message?: string };
  if (!res.ok) return apiFail((data.message as string) || `${kind} checkout 创建失败`);
  return apiOk({ url: data.url || data.checkout_url, trade_no: trade });
}

export async function completePendingTopup(store: Store, tradeNo: string): Promise<boolean> {
  const row = await store.getTopupByTrade(tradeNo);
  if (!row || String(row.status) !== "pending") return false;
  await store.updateTopup(Number(row.id), { status: "success" });
  await store.addQuota(Number(row.user_id), Number(row.amount || 0));
  return true;
}
