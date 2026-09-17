import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { maskKey } from "../src/crypto.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
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

async function boot(e: Env, headers: Record<string, string> = {}) {
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { auth, token };
}

async function createToken(e: Env, auth: Record<string, string>, ip: string, body: Record<string, unknown>) {
  const created = await send(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const data = created.body.data as { id: number; key: string };
  assert.ok(data.id > 0);
  assert.ok(data.key);
  return data;
}

function assertMaskedUpdate(text: string, body: Record<string, unknown>, storedKey: string, displayKey: string) {
  assert.equal(body.success, true, String(body.message));
  assert.equal(body.message, "");
  const data = body.data as Record<string, unknown>;
  assert.equal(typeof data, "object");
  assert.ok(data);
  assert.equal(data.key, maskKey(storedKey));
  assert.notEqual(data.key, storedKey);
  assert.notEqual(data.key, displayKey);
  assert.equal(text.includes(storedKey), false);
  assert.equal(text.includes(displayKey), false);
}

test("original UpdateToken leftover gin.H returns masked token data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.180" });
  const created = await createToken(e, auth, "192.0.2.181", {
    name: "editable-token",
    expired_time: -1,
    remain_quota: 50,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: "",
    group: "default",
    cross_group_retry: false,
  });

  const storedKey = created.key.startsWith("sk-") ? created.key.slice(3) : created.key;
  const updated = await send(
    new Request("http://local/api/token/", {
      method: "PUT",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.182" },
      body: JSON.stringify({
        id: created.id,
        name: "updated-token",
        expired_time: -1,
        remain_quota: 100,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: "",
        group: "default",
        cross_group_retry: false,
      }),
    }),
    e,
  );
  assert.equal(updated.res.status, 200, updated.text);
  assertMaskedUpdate(updated.text, updated.body, storedKey, created.key);

  const data = updated.body.data as Record<string, unknown>;
  assert.equal(data.id, created.id);
  assert.equal(data.name, "updated-token");
  assert.equal(data.remain_quota, 100);
  assert.equal(data.unlimited_quota, true);
  assert.equal(data.auto_groups, null);
  assert.equal(data.status, 1);

  const detail = await send(
    new Request("http://local/api/token/" + created.id, {
      headers: { ...auth, "cf-connecting-ip": "192.0.2.183" },
    }),
    e,
  );
  assert.deepEqual(detail.body.data, data);
});

test("original UpdateToken status_only leftover gin.H also returns masked token data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.185" });
  const created = await createToken(e, auth, "192.0.2.186", {
    name: "status-token",
    remain_quota: 10,
    unlimited_quota: false,
  });

  const storedKey = created.key.startsWith("sk-") ? created.key.slice(3) : created.key;
  const disabled = await send(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.187" },
      body: JSON.stringify({ id: created.id, status: 2 }),
    }),
    e,
  );
  assert.equal(disabled.res.status, 200, disabled.text);
  assertMaskedUpdate(disabled.text, disabled.body, storedKey, created.key);
  const data = disabled.body.data as Record<string, unknown>;
  assert.equal(data.name, "status-token");
  assert.equal(data.status, 2);
  assert.equal(data.remain_quota, 10);
  assert.equal(data.auto_groups, null);

  const autoCreated = await createToken(e, auth, "192.0.2.188", {
    name: "auto-token",
    group: "auto",
    auto_groups: ["default"],
    unlimited_quota: true,
  });
  const autoUpdated = await send(
    new Request("http://local/api/token/", {
      method: "PUT",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.189" },
      body: JSON.stringify({
        id: autoCreated.id,
        name: "auto-token-updated",
        group: "auto",
        auto_groups: ["default"],
        unlimited_quota: true,
        expired_time: -1,
      }),
    }),
    e,
  );
  assert.equal(autoUpdated.body.success, true, autoUpdated.text);
  assert.equal(autoUpdated.body.message, "");
  const autoData = autoUpdated.body.data as Record<string, unknown>;
  assert.deepEqual(autoData.auto_groups, ["default"]);
  assert.equal(autoData.name, "auto-token-updated");
  assert.equal(String(autoData.key).includes("**********"), true);
});

test("original leftover UpdateToken does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.190" });

  const unauth = await send(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ email: "new@example.com" }),
    }),
    e,
  );
  assert.equal(unauth.res.status, 401);
  assert.equal(unauth.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(unauth.body.message, "Unauthorized");

  const created = await send(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.191", "x-oneapi-request-id": "hop355-vendor-create" },
      body: JSON.stringify({ name: "hop355-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop355-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
