import assert from "node:assert/strict";
import { test } from "node:test";
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
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

const oauthBody = {
  name: "GHE",
  slug: "ghe-omit",
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
};

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

test("original custom OAuth provider leftover ApiErrorMsg gin.H omit data", async () => {
  const { e, auth, store } = await boot();
  const created = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(oauthBody),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const id = Number((created.body.data as { id: number }).id);

  const badId = await json(new Request("http://local/api/custom-oauth-provider/abc", { headers: auth }), e);
  omitData(badId.body, "无效的 ID");
  const missing = await json(new Request("http://local/api/custom-oauth-provider/999999", { headers: auth }), e);
  omitData(missing.body, "未找到该 OAuth 提供商");

  const taken = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...oauthBody, name: "Other" }),
    }),
    e,
  );
  omitData(taken.body, "该 Slug 已被使用");

  const builtin = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...oauthBody, slug: "github" }),
    }),
    e,
  );
  omitData(builtin.body, "该 Slug 与内置 OAuth 提供商冲突");

  const discoveryEmpty = await json(
    new Request("http://local/api/custom-oauth-provider/discovery", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  omitData(discoveryEmpty.body, "请先填写 Discovery URL 或 Issuer URL");

  const discoveryBad = await json(
    new Request("http://local/api/custom-oauth-provider/discovery", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ well_known_url: "ftp://example.com" }),
    }),
    e,
  );
  omitData(discoveryBad.body, "Discovery URL 无效，仅支持 http/https");

  const putBad = await json(
    new Request("http://local/api/custom-oauth-provider/abc", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "x" }),
    }),
    e,
  );
  omitData(putBad.body, "无效的 ID");

  const delBad = await json(
    new Request("http://local/api/custom-oauth-provider/abc", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(delBad.body, "无效的 ID");

  await store.upsertUserOAuthBinding(1, id, "ghe-user-1");
  const delBound = await json(
    new Request("http://local/api/custom-oauth-provider/" + id, { method: "DELETE", headers: auth }),
    e,
  );
  omitData(delBound.body, "该 OAuth 提供商还有用户绑定，无法删除。请先解除所有用户绑定。");
});

test("original UnbindCustomOAuth / admin OAuth binding leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const unbindBad = await json(
    new Request("http://local/api/user/oauth/bindings/abc", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(unbindBad.body, "无效的提供商 ID");

  const unbindZero = await json(
    new Request("http://local/api/user/oauth/bindings/0", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(unbindZero.body, "无效的提供商 ID");

  const adminBadUser = await json(new Request("http://local/api/user/abc/oauth/bindings", { headers: auth }), e);
  omitData(adminBadUser.body, "invalid user id");

  const adminMissing = await json(new Request("http://local/api/user/999999/oauth/bindings", { headers: auth }), e);
  omitData(adminMissing.body, "record not found");

  const adminDelUser = await json(
    new Request("http://local/api/user/abc/oauth/bindings/1", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(adminDelUser.body, "invalid user id");

  const adminDelProvider = await json(
    new Request("http://local/api/user/1/oauth/bindings/abc", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(adminDelProvider.body, "invalid provider id");

  const unknownBinding = await json(
    new Request("http://local/api/user/1/bindings/not-a-provider", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(unknownBinding.body, "invalid binding type");

  const cleared = await json(
    new Request("http://local/api/user/1/bindings/github", { method: "DELETE", headers: auth }),
    e,
  );
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.body.success, true);
  assert.equal(cleared.body.message, "success");
  assert.equal("data" in cleared.body, false);
  assert.deepEqual(Object.keys(cleared.body).sort(), ["message", "success"]);
});
