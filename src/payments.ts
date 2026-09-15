import { DEFAULT_WAFFO_PAY_METHODS, MAX_WALLET_QUOTA, nowSec, parseJson, randomHex } from "./constants.js";
import {
  getRandomString,
  hmacSha256Hex,
  md5Hex,
  sha1Hex,
  signWaffoBody,
  timingSafeEqualStr,
  validateWaffoPrivateKey,
  validateWaffoPublicKey,
} from "./crypto.js";
import { apiFail, clientIp, json, payErr, payOk, paymentReturnPath as serverPaymentReturnPath, readJson } from "./http.js";
import { PAYMENT_COMPLIANCE_REQUIRED } from "./subscription.js";
import {
  ERR_SUBSCRIPTION_ORDER_NOT_FOUND,
  type Store,
} from "./store.js";
import type { UserRow } from "./types.js";
import { parseTrustedRedirectDomains, validateRedirectURL } from "./url-validator.js";

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
    return Boolean(address) && Boolean(await store.option("EpayId")) && Boolean(await store.option("EpayKey")) && methods.length > 0;
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

export async function stripeSecret(store: Store): Promise<string> {
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
  const min = await minTopup(store, minKey, 1);
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
          ? await store.optionNum("WaffoPancakeUnitPrice", 8)
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
    if (trade) {
      const result = await tryCompleteSubscriptionOrder(
        store,
        trade,
        raw,
        "stripe",
        "",
      );
      if (result === "completed" || result === "rejected") return new Response(null, { status: 200 });
      const customer = obj.customer;
      const customerId =
        typeof customer === "string" ? customer : String((customer as { id?: string } | undefined)?.id || "");
      try {
        await store.rechargeStripe(trade, customerId, clientIp(req));
      } catch {
        /* original StripeWebhook logs Recharge errors and still returns 200 */
      }
    }
  } else if (event.type === "checkout.session.expired") {
    const obj = event.data?.object || {};
    if (String(obj.status || "") !== "expired") return new Response(null, { status: 200 });
    const trade = String(obj.client_reference_id || "");
    if (trade) {
      try {
        await store.expireSubscriptionOrder(trade, "stripe");
        return new Response(null, { status: 200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== ERR_SUBSCRIPTION_ORDER_NOT_FOUND) return new Response(null, { status: 200 });
      }
      try {
        await store.updatePendingTopupStatus(trade, "stripe", "expired");
      } catch {
        /* original logs missing/invalid wallet orders and still 200 */
      }
    }
  }
  return new Response(null, { status: 200 });
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

export async function handleEpayNotify(store: Store, req: Request, url: URL): Promise<Response> {
  const params = url.searchParams;
  let trade = params.get("out_trade_no") || "";
  let status = params.get("trade_status") || params.get("status") || "";
  let payType = params.get("type") || "";
  if (req.method === "POST") {
    const body = (await readJson(req).catch(() => ({}))) as Record<string, string>;
    trade = trade || String(body.out_trade_no || "");
    status = status || String(body.trade_status || body.status || "");
    payType = payType || String(body.type || "");
  }
  if (!trade) return new Response("fail", { status: 400 });
  if (status && status !== "TRADE_SUCCESS" && status !== "success" && status !== "1") {
    return new Response("fail", { status: 400 });
  }
  try {
    await store.rechargeEpay(trade, payType, clientIp(req));
  } catch {
    return new Response("fail", { headers: { "content-type": "text/plain" } });
  }
  return new Response("success", { headers: { "content-type": "text/plain" } });
}

type CreemProduct = { productId?: string; name?: string; price?: number; quota?: number; currency?: string };

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
  const endpoint = (await store.option("CreemCheckoutUrl")) || (testMode ? "https://test-api.creem.io/v1/checkouts" : "https://api.creem.io/v1/checkouts");
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
): Promise<Response> {
  if (!(await paymentEnabled(store, "waffo_pancake"))) return payErr("Waffo Pancake 配置不完整");
  const amount = Number(body.amount || 0);
  const min = await store.optionNum("WaffoPancakeMinTopUp", await store.optionNum("MinTopup", 1));
  if (amount < min) return payErr(`充值数量不能小于 ${min}`);
  const invalid = await rejectInvalidTopUpQuota(store, user.id, amount);
  if (invalid) return invalid;
  const money = await payMoneyFor(store, amount, user.group, await store.optionNum("WaffoPancakeUnitPrice", 8));
  if (money <= 0.01) return payErr("充值金额过低");
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
  const event = parseJson<{
    eventType?: string;
    object?: {
      request_id?: string;
      order?: { id?: string; status?: string; type?: string };
      customer?: { email?: string; name?: string };
    };
  }>(raw, {});
  if (event.eventType === "checkout.completed") {
    if (event.object?.order?.status && event.object.order.status !== "paid") return new Response(null, { status: 200 });
    const trade = String(event.object?.request_id || "");
    if (!trade) return new Response(null, { status: 400 });
    const result = await tryCompleteSubscriptionOrder(store, trade, raw, "creem", "");
    if (result === "completed") return new Response(null, { status: 200 });
    if (result === "rejected") return new Response(null, { status: 500 });
    const orderType = String(event.object?.order?.type || "onetime");
    if (orderType && orderType !== "onetime") return new Response(null, { status: 200 });
    try {
      await store.rechargeCreem(
        trade,
        String(event.object?.customer?.email || ""),
        String(event.object?.customer?.name || ""),
        clientIp(req),
      );
    } catch {
      return new Response(null, { status: 500 });
    }
  }
  return new Response(null, { status: 200 });
}

export async function handleWaffoWebhook(store: Store, req: Request): Promise<Response> {
  if (!(await paymentEnabled(store, "waffo"))) return new Response(null, { status: 403 });
  const raw = await req.text();
  const signature = req.headers.get("X-SIGNATURE") || req.headers.get("x-signature") || "";
  if (!signature) return new Response(null, { status: 400 });
  const event = parseJson<{
    eventType?: string;
    result?: { merchantOrderID?: string; merchantOrderId?: string; orderStatus?: string };
    merchantOrderId?: string;
  }>(raw, {});
  const trade = String(event.result?.merchantOrderID || event.result?.merchantOrderId || event.merchantOrderId || "");
  const orderStatus = String(event.result?.orderStatus || "");
  if (trade && (!orderStatus || orderStatus === "PAY_SUCCESS")) {
    try {
      await store.rechargeWaffo(trade, clientIp(req));
    } catch {
      return new Response(JSON.stringify({ code: "FAIL" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  }
  return new Response(JSON.stringify({ code: "SUCCESS" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handleWaffoPancakeWebhook(store: Store, req: Request, envParam: string): Promise<Response> {
  if (!(await paymentEnabled(store, "waffo_pancake"))) {
    return new Response("webhook disabled", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const expectedEnv = String(envParam || "").trim();
  if (expectedEnv !== "test" && expectedEnv !== "prod") {
    return new Response("unknown env", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return new Response("bad request", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const signature = req.headers.get("X-Waffo-Signature") || "";
  if (!signature) {
    return new Response("invalid signature", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const event = parseJson<{
    mode?: string;
    event_type?: string;
    eventType?: string;
    type?: string;
    data?: { order_id?: string; orderId?: string; orderMerchantExternalId?: string; order_merchant_external_id?: string };
  }>(raw, {});
  const mode = String(event.mode || "").trim();
  if (mode && mode.toLowerCase() !== expectedEnv) {
    return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const eventType = String(event.event_type || event.eventType || event.type || "").toLowerCase();
  if (eventType === "order.completed" || eventType === "order_completed") {
    const trade = String(
      event.data?.order_merchant_external_id ||
        event.data?.orderMerchantExternalId ||
        event.data?.order_id ||
        event.data?.orderId ||
        "",
    );
    if (trade) {
      if (trade.startsWith("WAFFO_PANCAKE_SUB-")) {
        const order = await store.getSubscriptionOrderByTrade(trade);
        if (!order || String(order.payment_provider || "") !== "waffo_pancake") {
          return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        const identity = String(
          (event.data as { merchantProvidedBuyerIdentity?: string; merchant_provided_buyer_identity?: string } | undefined)
            ?.merchantProvidedBuyerIdentity ||
            (event.data as { merchant_provided_buyer_identity?: string } | undefined)?.merchant_provided_buyer_identity ||
            "",
        ).trim();
        if (identity !== `new-api-user-${Number(order.user_id || 0)}`) {
          return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        const result = await tryCompleteSubscriptionOrder(store, trade, raw, "waffo_pancake", "");
        if (result !== "completed") {
          return new Response("retry", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      try {
        await store.rechargeWaffoPancake(trade);
      } catch {
        return new Response("retry", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    }
  }
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
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
