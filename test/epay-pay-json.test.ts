import assert from "node:assert/strict";
import { test } from "node:test";
import { md5Hex } from "../src/crypto.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function epayTopupCount(store: Store): Promise<number> {
  const { items } = await store.listTopups(null, 0, 1000);
  return items.filter((row) => String((row as { payment_provider?: string }).payment_provider) === "epay").length;
}

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { e, auth, store: new Store(e.DB) };
}

async function pay(e: Env, auth: Record<string, string>, body: unknown) {
  return json(
    new Request("http://local/api/user/pay", {
      method: "POST",
      headers: auth,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

async function expectedSign(params: Record<string, string>, key: string): Promise<string> {
  const filtered = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort();
  return md5Hex(filtered.map((k) => `${k}=${params[k]}`).join("&") + key);
}

test("original RequestEpay bind errors and missing method JSON", async () => {
  const { e, auth, store } = await boot();
  const before = await epayTopupCount(store);
  const empty = await json(new Request("http://local/api/user/pay", { method: "POST", headers: auth, body: "" }), e);
  assert.equal(empty.body.message, "error");
  assert.equal(empty.body.data, "参数错误");

  const invalid = await pay(e, auth, "{");
  assert.equal(invalid.body.message, "error");
  assert.equal(invalid.body.data, "参数错误");

  const missingMethod = await pay(e, auth, { amount: 10 });
  assert.equal(missingMethod.body.message, "error");
  assert.equal(missingMethod.body.data, "支付方式不存在");

  const unknown = await pay(e, auth, { amount: 10, payment_method: "paypal" });
  assert.equal(unknown.body.message, "error");
  assert.equal(unknown.body.data, "支付方式不存在");

  const low = await pay(e, auth, { amount: 0, payment_method: "alipay" });
  assert.equal(low.body.message, "error");
  assert.equal(low.body.data, "充值数量不能小于 1");
  assert.equal(await epayTopupCount(store), before);
});

test("original RequestEpay unconfigured gateway JSON does not insert", async () => {
  const { e, auth, store } = await boot();
  const before = await epayTopupCount(store);
  const out = await pay(e, auth, { amount: 10, payment_method: "alipay" });
  assert.equal(out.body.message, "error");
  assert.equal(out.body.data, "当前管理员未配置支付信息");
  assert.equal(await epayTopupCount(store), before);
});

test("original RequestEpay Purchase JSON: USR trade, TUC name, device pc, submit.php url", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("PayAddress", "https://epay.example");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  await store.setOption("ServerAddress", "https://console.example.com");
  await store.setOption("CustomCallbackAddress", "https://callback.example.com");
  const before = await epayTopupCount(store);
  const out = await pay(e, auth, { amount: 10, payment_method: "alipay" });
  assert.equal(out.res.status, 200);
  assert.equal(out.body.message, "success");
  assert.equal(out.body.url, "https://epay.example/submit.php");
  const data = out.body.data as Record<string, string>;
  assert.equal(data.pid, "1001");
  assert.equal(data.type, "alipay");
  assert.equal(data.name, "TUC10");
  assert.equal(data.device, "pc");
  assert.equal(data.money, "73.00");
  assert.equal(data.notify_url, "https://callback.example.com/api/user/epay/notify");
  assert.equal(data.return_url, "https://console.example.com/usage-logs");
  assert.equal(data.sign_type, "MD5");
  assert.match(String(data.out_trade_no || ""), /^USR1NO[0-9a-zA-Z]{6}\d+$/);
  assert.equal(data.sign, await expectedSign(data, "epay-secret"));
  assert.equal(new URL(String(out.body.url)).search, "");
  assert.equal(await epayTopupCount(store), before + 1);
  const { items } = await store.listTopups(null, 0, 10);
  const row = items.find((r) => String((r as { trade_no?: string }).trade_no) === data.out_trade_no) as {
    amount?: number;
    payment_method?: string;
    status?: string;
  };
  assert.equal(Number(row?.amount), 10);
  assert.equal(row?.payment_method, "alipay");
  assert.equal(row?.status, "pending");
});

test("original RequestEpay appends /submit.php onto PayAddress path", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("PayAddress", "https://epay.example/submit.php");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  await store.setOption("ServerAddress", "https://console.example.com");
  const out = await pay(e, auth, { amount: 10, payment_method: "wxpay" });
  assert.equal(out.body.message, "success");
  assert.equal(out.body.url, "https://epay.example/submit.php/submit.php");
  const data = out.body.data as Record<string, string>;
  assert.equal(data.type, "wxpay");
  assert.equal(data.name, "TUC10");
});
