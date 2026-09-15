import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_QUOTA } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
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

async function boot(e: Env) {
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
  return { token, auth, login };
}

async function apiKey(e: Env, auth: Record<string, string>, extra: Record<string, unknown> = {}): Promise<{ id: number; key: string }> {
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "billing", ...extra }),
    }),
    e,
  );
  assert.equal(tk.body.success, true, String(tk.body.message));
  const data = tk.body.data as { id: number; key: string };
  return { id: data.id, key: data.key };
}

test("original GetSubscription/GetUsage JSON follows DisplayTokenStatEnabled", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  const until = 2_000_000_000;
  const created = await apiKey(e, auth, {
    remain_quota: 250000,
    unlimited_quota: true,
    expired_time: until,
  });
  await e.DB.prepare("UPDATE api_tokens SET used_quota = ? WHERE id = ?").bind(250000, created.id).run();
  await store.updateUser(1, { quota: ROOT_QUOTA, used_quota: 100000 });
  const skAuth = { authorization: "Bearer " + created.key };

  const sub = await json(new Request("http://local/v1/dashboard/billing/subscription", { headers: skAuth }), e);
  assert.equal(sub.res.status, 200);
  assert.deepEqual(Object.keys(sub.body).sort(), [
    "access_until",
    "hard_limit_usd",
    "has_payment_method",
    "object",
    "soft_limit_usd",
    "system_hard_limit_usd",
  ]);
  assert.equal(sub.body.object, "billing_subscription");
  assert.equal(sub.body.has_payment_method, true);
  assert.equal(sub.body.soft_limit_usd, 100000000);
  assert.equal(sub.body.hard_limit_usd, 100000000);
  assert.equal(sub.body.system_hard_limit_usd, 100000000);
  assert.equal(sub.body.access_until, until);

  const usage = await json(new Request("http://local/v1/dashboard/billing/usage", { headers: skAuth }), e);
  assert.deepEqual(Object.keys(usage.body).sort(), ["object", "total_usage"]);
  assert.equal(usage.body.object, "list");
  assert.equal(usage.body.total_usage, (250000 / 500000) * 100);

  await store.setOption("DisplayTokenStatEnabled", "false");
  const userSub = await json(new Request("http://local/dashboard/billing/subscription", { headers: skAuth }), e);
  assert.equal(userSub.body.object, "billing_subscription");
  assert.equal(userSub.body.access_until, 0);
  assert.equal(userSub.body.soft_limit_usd, (ROOT_QUOTA + 100000) / 500000);
  assert.equal(userSub.body.hard_limit_usd, userSub.body.soft_limit_usd);
  assert.equal(userSub.body.system_hard_limit_usd, userSub.body.soft_limit_usd);
  assert.notEqual(userSub.body.soft_limit_usd, 100000000);

  const userUsage = await json(new Request("http://local/dashboard/billing/usage", { headers: skAuth }), e);
  assert.equal(userUsage.body.object, "list");
  assert.equal(userUsage.body.total_usage, (100000 / 500000) * 100);

  await store.setOption("general_setting.quota_display_type", "CNY");
  await store.setOption("USDExchangeRate", "7");
  const cny = await json(new Request("http://local/v1/dashboard/billing/subscription", { headers: skAuth }), e);
  assert.equal(cny.body.soft_limit_usd, ((ROOT_QUOTA + 100000) / 500000) * 7);

  await store.setOption("general_setting.quota_display_type", "TOKENS");
  const tokens = await json(new Request("http://local/v1/dashboard/billing/usage", { headers: skAuth }), e);
  assert.equal(tokens.body.total_usage, 100000 * 100);
});
