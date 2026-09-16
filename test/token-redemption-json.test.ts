import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.Token` JSON tags plus `tokenResponse.auto_groups`. */
const ORIGINAL_TOKEN_JSON_FIELDS = [
  "id",
  "user_id",
  "key",
  "status",
  "name",
  "created_time",
  "accessed_time",
  "expired_time",
  "remain_quota",
  "unlimited_quota",
  "model_limits_enabled",
  "model_limits",
  "allow_ips",
  "used_quota",
  "group",
  "cross_group_retry",
  "DeletedAt",
  "auto_groups",
] as const;

/** Original `model.Redemption` JSON tags. `count` is `gorm:"-:all"` (always 0 on GET). */
const ORIGINAL_REDEMPTION_JSON_FIELDS = [
  "id",
  "user_id",
  "key",
  "status",
  "name",
  "quota",
  "created_time",
  "redeemed_time",
  "count",
  "used_user_id",
  "DeletedAt",
  "expired_time",
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

function assertTokenJson(item: Record<string, unknown>, label: string) {
  for (const k of ORIGINAL_TOKEN_JSON_FIELDS) {
    assert.ok(k in item, `${label} missing original Token field ${k}`);
  }
  assert.equal(item.DeletedAt, null, `${label} listed tokens use GORM default scope so DeletedAt is null`);
  assert.equal(typeof item.unlimited_quota, "boolean");
  assert.equal(typeof item.model_limits_enabled, "boolean");
  assert.equal(typeof item.cross_group_retry, "boolean");
  assert.equal(item.allow_ips, "");
  const key = String(item.key || "");
  assert.equal(key.includes("**********") || key.includes("****") || /^\*+$/.test(key), true, `${label} key must be masked`);
}

test("original GetAllTokens tokenResponse JSON includes DeletedAt", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "listed", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/token/", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const page = listed.body.data as { items: Record<string, unknown>[] };
  const item = page.items.find((t) => t.name === "listed");
  assert.ok(item);
  assertTokenJson(item, "GetAllTokens");
  assert.equal(item.auto_groups, null);
  assert.equal(item.unlimited_quota, true);
});

test("original GetToken and SearchTokens JSON include DeletedAt", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "searchme", remain_quota: 100 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/token/", { headers: auth }), e);
  const row = ((listed.body.data as { items: { id: number; name: string }[] }).items || []).find((t) => t.name === "searchme");
  assert.ok(row);
  const got = await json(new Request("http://local/api/token/" + row.id, { headers: auth }), e);
  assert.equal(got.body.success, true, String(got.body.message));
  assertTokenJson(got.body.data as Record<string, unknown>, "GetToken");
  const searched = await json(new Request("http://local/api/token/search?keyword=searchme", { headers: auth }), e);
  assert.equal(searched.body.success, true, String(searched.body.message));
  const found = ((searched.body.data as { items: Record<string, unknown>[] }).items || []).find((t) => t.name === "searchme");
  assert.ok(found);
  assertTokenJson(found, "SearchTokens");
});

test("original GetAllRedemptions JSON includes count zero and DeletedAt", async () => {
  const { e, auth } = await boot();
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth, body: JSON.stringify({ confirmed: true }) }), e);
  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 100, count: 3 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const page = listed.body.data as { items: Record<string, unknown>[] };
  assert.ok(page.items.length >= 1);
  const item = page.items[0];
  for (const k of ORIGINAL_REDEMPTION_JSON_FIELDS) {
    assert.ok(k in item, `GetAllRedemptions missing original Redemption field ${k}`);
  }
  assert.equal(item.count, 0, "count is gorm:-:all and must be the zero value on GET");
  assert.equal(item.DeletedAt, null);
  assert.equal(item.name, "gift");
});

test("original Token.Delete is a GORM soft delete that keeps the unique key", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "soft-del", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const createdData = created.body.data as { id: number; key: string };
  const key = String(createdData.key || "").replace(/^sk-/, "");
  assert.ok(key);
  const deleted = await json(new Request("http://local/api/token/" + createdData.id + "/", { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const after = await json(new Request("http://local/api/token/", { headers: auth }), e);
  const items = (after.body.data as { items: { id: number }[] }).items || [];
  assert.equal(items.some((t) => t.id === createdData.id), false);
  const got = await json(new Request("http://local/api/token/" + createdData.id, { headers: auth }), e);
  assert.equal(got.body.success, false);
  const usage = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer sk-" + key } }),
    e,
  );
  assert.equal(usage.body.success, false);
  const s = new Store(e.DB);
  await assert.rejects(() => s.insertToken({ user_id: 1, key, name: "reuse" }));
});

test("original Redemption.Delete is a GORM soft delete that keeps the unique key", async () => {
  const { e, auth } = await boot();
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth, body: JSON.stringify({ confirmed: true }) }), e);
  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "softdel", quota: 50, count: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const item = ((listed.body.data as { items: Record<string, unknown>[] }).items || []).find((r) => r.name === "softdel");
  assert.ok(item);
  const key = String(item.key);
  const deleted = await json(new Request("http://local/api/redemption/" + item.id + "/", { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const after = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const items = (after.body.data as { items: { id: number }[] }).items || [];
  assert.equal(items.some((r) => r.id === item.id), false);
  const got = await json(new Request("http://local/api/redemption/" + item.id, { headers: auth }), e);
  assert.equal(got.body.success, false);
  const topup = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key }),
    }),
    e,
  );
  assert.equal(topup.body.success, false);
  const s = new Store(e.DB);
  await assert.rejects(() => s.insertRedemption({ user_id: 1, key, name: "reuse", quota: 10 }));
});
