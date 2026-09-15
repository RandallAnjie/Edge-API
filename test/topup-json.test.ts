import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { LOG_TOPUP, ROOT_QUOTA, nowSec } from "../src/constants.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.TopUp` JSON tags from GetUserTopUps / GetAllTopUps. */
const ORIGINAL_TOPUP_JSON_FIELDS = [
  "id",
  "user_id",
  "amount",
  "money",
  "trade_no",
  "payment_method",
  "payment_provider",
  "create_time",
  "complete_time",
  "status",
] as const;

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
  return { e, auth };
}

function items(body: Record<string, unknown>): Record<string, unknown>[] {
  return ((body.data as { items?: Record<string, unknown>[] })?.items || []);
}

test("original GetUserTopUps / GetAllTopUps JSON includes TopUp fields", async () => {
  const { e, auth } = await boot();
  const s = new Store(e.DB);
  await s.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: "RECENT-ORDER",
    payment_method: "epay",
    payment_provider: "epay",
    status: "success",
  });
  const self = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
  assert.equal(self.body.success, true, String(self.body.message));
  const recent = items(self.body).find((row) => row.trade_no === "RECENT-ORDER");
  assert.ok(recent);
  for (const k of ORIGINAL_TOPUP_JSON_FIELDS) {
    assert.ok(k in recent, `GetUserTopUps missing original TopUp field ${k}`);
  }
  assert.equal(recent.status, "success");
  assert.equal(typeof recent.create_time, "number");
  const all = await json(new Request("http://local/api/user/topup", { headers: auth }), e);
  assert.equal(all.body.success, true, String(all.body.message));
  const adminItem = items(all.body).find((row) => row.trade_no === "RECENT-ORDER");
  assert.ok(adminItem);
  for (const k of ORIGINAL_TOPUP_JSON_FIELDS) {
    assert.ok(k in adminItem, `GetAllTopUps missing original TopUp field ${k}`);
  }
});

test("original GetUserTopUps applies 30-day cutoff; GetAllTopUps does not", async () => {
  const { e, auth } = await boot();
  const s = new Store(e.DB);
  const old = nowSec() - 40 * 24 * 60 * 60;
  await s.insertTopup({
    user_id: 1,
    amount: 5,
    money: 5,
    trade_no: "OLD-ORDER",
    payment_method: "epay",
    payment_provider: "epay",
    status: "success",
    created_at: old,
  });
  const self = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
  assert.equal(items(self.body).some((row) => row.trade_no === "OLD-ORDER"), false);
  const all = await json(new Request("http://local/api/user/topup", { headers: auth }), e);
  const found = items(all.body).find((row) => row.trade_no === "OLD-ORDER");
  assert.ok(found);
  assert.equal(found.create_time, old);
});

test("original SearchUserTopUps / SearchAllTopUps trade_no LIKE without wrapping %", async () => {
  const { e, auth } = await boot();
  const s = new Store(e.DB);
  await s.insertTopup({
    user_id: 1,
    amount: 1,
    money: 1,
    trade_no: "ABC-ORDER-99",
    payment_method: "epay",
    payment_provider: "epay",
    status: "pending",
  });
  const exactMiss = await json(
    new Request("http://local/api/user/topup/self?keyword=ORDER", { headers: auth }),
    e,
  );
  assert.equal(exactMiss.body.success, true, String(exactMiss.body.message));
  assert.equal(items(exactMiss.body).length, 0);

  const fuzzy = await json(
    new Request("http://local/api/user/topup/self?keyword=" + encodeURIComponent("%ORDER%"), { headers: auth }),
    e,
  );
  assert.equal(fuzzy.body.success, true, String(fuzzy.body.message));
  assert.deepEqual(items(fuzzy.body).map((row) => row.trade_no), ["ABC-ORDER-99"]);

  const exact = await json(
    new Request("http://local/api/user/topup?keyword=ABC-ORDER-99", { headers: auth }),
    e,
  );
  assert.equal(exact.body.success, true, String(exact.body.message));
  assert.equal(items(exact.body).length, 1);

  const bad = await json(
    new Request("http://local/api/user/topup/self?keyword=" + encodeURIComponent("a%%b"), { headers: auth }),
    e,
  );
  assert.equal(bad.body.success, false);
  assert.equal(bad.body.message, "搜索模式中不允许包含连续的 % 通配符");
});

test("original AdminCompleteTopUp JSON uses trade_no and credits Amount * QuotaPerUnit", async () => {
  const { e, auth } = await boot();
  const s = new Store(e.DB);
  const before = await s.getUserById(1);
  assert.ok(before);
  await s.insertTopup({
    user_id: 1,
    amount: 10,
    money: 12.5,
    trade_no: "PENDING-EPAY",
    payment_method: "alipay",
    payment_provider: "epay",
    status: "pending",
  });
  const missing = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "参数错误");

  const unknown = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ trade_no: "missing" }),
    }),
    e,
  );
  assert.equal(unknown.body.success, false);
  assert.equal(unknown.body.message, "充值订单不存在");

  const done = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ trade_no: "PENDING-EPAY" }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  assert.equal(done.body.data, null);
  const after = await s.getUserById(1);
  assert.equal(Number(after?.quota), Number(before?.quota || ROOT_QUOTA) + 10 * 500000);
  const listed = await json(new Request("http://local/api/user/topup/self?keyword=PENDING-EPAY", { headers: auth }), e);
  const row = items(listed.body)[0];
  assert.equal(row.status, "success");
  assert.ok(Number(row.complete_time) > 0);
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_TOPUP, { headers: auth }), e);
  const log = ((logs.body.data as { items: { content: string; other: string }[] }).items || []).find((item) =>
    String(item.content).startsWith("管理员补单成功"),
  );
  assert.ok(log);
  assert.match(log.content, /管理员补单成功，充值金额: ＄10\.000000，支付金额：12\.500000/);
  const other = JSON.parse(log.other || "{}") as { admin_info?: Record<string, unknown> };
  assert.equal(other.admin_info?.callback_payment_method, "admin");
  assert.equal(other.admin_info?.payment_method, "alipay");

  const again = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ trade_no: "PENDING-EPAY" }),
    }),
    e,
  );
  assert.equal(again.body.success, true, String(again.body.message));
  const afterIdempotent = await s.getUserById(1);
  assert.equal(Number(afterIdempotent?.quota), Number(after?.quota));
});

test("original ManualCompleteTopUp Stripe credits Money * QuotaPerUnit", async () => {
  const { e, auth } = await boot();
  const s = new Store(e.DB);
  const before = await s.getUserById(1);
  await s.insertTopup({
    user_id: 1,
    amount: 10,
    money: 9.5,
    trade_no: "PENDING-STRIPE",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  const done = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ trade_no: "PENDING-STRIPE" }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  const after = await s.getUserById(1);
  assert.equal(Number(after?.quota), Number(before?.quota) + Math.round(9.5 * 500000));
});

test("original ManualCompleteTopUp rejects non-pending orders", async () => {
  const { e, auth } = await boot();
  const s = new Store(e.DB);
  await s.insertTopup({
    user_id: 1,
    amount: 1,
    money: 1,
    trade_no: "EXPIRED-ORDER",
    payment_method: "epay",
    payment_provider: "epay",
    status: "expired",
  });
  const res = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ trade_no: "EXPIRED-ORDER" }),
    }),
    e,
  );
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, "订单状态不是待支付，无法补单");
});
