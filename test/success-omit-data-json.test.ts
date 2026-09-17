import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
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

function omitDataSuccess(body: Record<string, unknown>, message = "") {
  assert.equal(body.success, true, String(body.message));
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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

test("original DeleteChannel leftover gin.H success omits data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.171" });

  const added = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.172" },
      body: JSON.stringify({ name: "hop354-del", type: 1, key: "sk-hop354-delete" }),
    }),
    e,
  );
  assert.equal(added.body.success, true, added.text);
  const id = Number((added.body.data as { id?: number })?.id || 0);
  assert.ok(id > 0);

  const deleted = await send(
    new Request("http://local/api/channel/" + id, {
      method: "DELETE",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.173" },
    }),
    e,
  );
  assert.equal(deleted.res.status, 200, deleted.text);
  omitDataSuccess(deleted.body);

  const missing = await send(
    new Request("http://local/api/channel/999999", {
      method: "DELETE",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.174" },
    }),
    e,
  );
  assert.equal(missing.res.status, 200, missing.text);
  omitDataSuccess(missing.body);
});

test("original DeleteCustomOAuthProvider leftover gin.H success omits data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.175" });

  const created = await send(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.176" },
      body: JSON.stringify({
        name: "GHE hop354",
        slug: "hop354-ghe",
        icon: "github",
        enabled: true,
        client_id: "cid",
        client_secret: "csecret",
        authorization_endpoint: "https://ghe.example/login/oauth/authorize",
        token_endpoint: "https://ghe.example/login/oauth/access_token",
        user_info_endpoint: "https://ghe.example/api/v3/user",
        scopes: "user:email",
        user_id_field: "id",
        username_field: "login",
        display_name_field: "name",
        email_field: "email",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const id = Number((created.body.data as { id: number }).id);
  assert.ok(id > 0);

  const deleted = await send(
    new Request("http://local/api/custom-oauth-provider/" + id, {
      method: "DELETE",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.177" },
    }),
    e,
  );
  assert.equal(deleted.res.status, 200, deleted.text);
  omitDataSuccess(deleted.body, "删除成功");
});

test("original leftover success omit-data does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.178" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.179", "x-oneapi-request-id": "hop354-vendor-create" },
      body: JSON.stringify({ name: "hop354-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop354-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
