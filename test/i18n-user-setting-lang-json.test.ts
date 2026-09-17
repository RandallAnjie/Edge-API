import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { i18nLang, rememberRequestUserLanguageFromUser } from "../src/http.js";
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

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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
  return { e, auth, token };
}

test("original GetLangFromContext user setting then Accept-Language", () => {
  const settingWins = new Request("http://local/", { headers: { "accept-language": "zh-CN" } });
  rememberRequestUserLanguageFromUser(settingWins, { settings: JSON.stringify({ language: "en" }) });
  assert.equal(i18nLang(settingWins), "en");

  const emptyFallsThrough = new Request("http://local/", { headers: { "accept-language": "zh-TW" } });
  rememberRequestUserLanguageFromUser(emptyFallsThrough, { settings: JSON.stringify({ language: "" }) });
  assert.equal(i18nLang(emptyFallsThrough), "zh-TW");

  const missingFallsThrough = new Request("http://local/", { headers: { "accept-language": "zh-CN" } });
  rememberRequestUserLanguageFromUser(missingFallsThrough, { settings: "{}" });
  assert.equal(i18nLang(missingFallsThrough), "zh-CN");

  const unsupportedBecomesEnglish = new Request("http://local/", { headers: { "accept-language": "zh-CN" } });
  rememberRequestUserLanguageFromUser(unsupportedBecomesEnglish, { settings: JSON.stringify({ language: "fr" }) });
  assert.equal(i18nLang(unsupportedBecomesEnglish), "en");

  const zhPrefix = new Request("http://local/", { headers: { "accept-language": "en" } });
  rememberRequestUserLanguageFromUser(zhPrefix, { settings: JSON.stringify({ language: "zh" }) });
  assert.equal(i18nLang(zhPrefix), "zh-CN");

  const none = new Request("http://local/", { headers: { "accept-language": "zh-CN,en;q=0.8" } });
  assert.equal(i18nLang(none), "zh-CN");
});

test("original i18n.T uses auth-time user language on the next request; AUTH StatusText stays Unauthorized", async () => {
  const { e, auth } = await boot();

  const setZh = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "en" },
      body: JSON.stringify({ language: "zh-CN" }),
    }),
    e,
  );
  assert.equal(setZh.body.success, true, String(setZh.body.message));
  assert.equal(setZh.body.message, "Update successful");

  const emptyEnHeader = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "en" },
    }),
    e,
  );
  omitData(emptyEnHeader.body, "无效的参数");

  const setEmpty = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "en" },
      body: JSON.stringify({ language: "" }),
    }),
    e,
  );
  assert.equal(setEmpty.body.success, true, String(setEmpty.body.message));
  assert.equal(setEmpty.body.message, "更新成功");

  const emptyAfterClear = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
    }),
    e,
  );
  omitData(emptyAfterClear.body, "无效的参数");

  const setFr = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ language: "fr" }),
    }),
    e,
  );
  assert.equal(setFr.body.success, true, String(setFr.body.message));
  assert.equal(setFr.body.message, "更新成功");

  const emptyAfterFr = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
    }),
    e,
  );
  omitData(emptyAfterFr.body, "Invalid parameters");

  const loginZh = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN", "cf-connecting-ip": "i18n-342-login" },
    }),
    e,
  );
  omitData(loginZh.body, "无效的参数");

  const unauth = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ email: "new@example.com" }),
    }),
    e,
  );
  assert.equal(unauth.res.status, 401);
  assert.equal(unauth.body.success, false);
  assert.equal(unauth.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(unauth.body.message, "Unauthorized");
  assert.equal("data" in unauth.body, false);
});

test("original TokenAuth banned uses GetUserLanguage; TokenAuthReadOnly banned stays Accept-Language", async () => {
  const { e, auth } = await boot();
  const rid = "i18n-342-token";

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "i18n-banned", password: "password12", display_name: "i18n-banned" }),
    }),
    e,
  );
  const bannedLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "i18n-342-banned",
      },
      body: JSON.stringify({ username: "i18n-banned", password: "password12" }),
    }),
    e,
  );
  const bannedAuth = {
    authorization: "Bearer " + (bannedLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const setLang = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: bannedAuth,
      body: JSON.stringify({ language: "zh-CN" }),
    }),
    e,
  );
  assert.equal(setLang.body.success, true, String(setLang.body.message));
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: bannedAuth,
      body: JSON.stringify({ name: "i18n-banned-token", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const key = (created.body.data as { key: string }).key;
  const bannedUser = await e.DB.prepare("SELECT id FROM users WHERE username = ?")
    .bind("i18n-banned")
    .first<{ id: number }>();
  assert.ok(bannedUser);
  await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: bannedUser.id, action: "disable" }),
    }),
    e,
  );

  const tokenAuth = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer " + key,
        "accept-language": "en",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assert.equal(tokenAuth.res.status, 403, tokenAuth.text);
  const err = tokenAuth.body.error as { message?: string };
  assert.equal(err.message, "用户已被封禁 (request id: " + rid + ")");

  const readOnly = await json(
    new Request("http://local/api/usage/token", {
      headers: { authorization: "Bearer " + key, "accept-language": "en" },
    }),
    e,
  );
  assert.equal(readOnly.res.status, 403, readOnly.text);
  assert.equal(readOnly.body.success, false);
  assert.equal(readOnly.body.message, "User has been banned");
});
