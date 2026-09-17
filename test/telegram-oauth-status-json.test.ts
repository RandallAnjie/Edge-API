import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  ERR_TELEGRAM_OAUTH_CONFLICT,
  ERR_TELEGRAM_OAUTH_NOT_CONFIGURED,
  TELEGRAM_ISSUER,
} from "../src/telegram-oauth.js";
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

function securityOp(body: Record<string, unknown>, code: string, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
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

async function statusData(e: Env) {
  const st = await json(new Request("http://local/api/status"), e);
  assert.equal(st.body.success, true, String(st.body.message));
  return st.body.data as { telegram_oauth: boolean; telegram_oauth_configured: boolean };
}

async function oauthState(e: Env, auth: Record<string, string>) {
  return json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "telegram", intent: "login" }),
    }),
    e,
  );
}

test("original GetStatus telegram_oauth_configured matches TelegramConfigurationError JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  const unset = await statusData(e);
  assert.equal(unset.telegram_oauth, false);
  assert.equal(unset.telegram_oauth_configured, false);

  await store.setOption("TelegramBotToken", "123456:legacy-bot-token");
  const tokenOnly = await statusData(e);
  assert.equal(tokenOnly.telegram_oauth, false);
  assert.equal(tokenOnly.telegram_oauth_configured, false);

  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  const credsDisabled = await statusData(e);
  assert.equal(credsDisabled.telegram_oauth, false);
  assert.equal(credsDisabled.telegram_oauth_configured, false);

  await store.setOption("TelegramOAuthEnabled", "true");
  const configured = await statusData(e);
  assert.equal(configured.telegram_oauth, true);
  assert.equal(configured.telegram_oauth_configured, true);

  await store.setOption("telegram.client_id", "  ");
  const whitespace = await statusData(e);
  assert.equal(whitespace.telegram_oauth, true);
  assert.equal(whitespace.telegram_oauth_configured, false);

  await store.setOption("telegram.client_id", "12345");
  await store.setOption("TelegramOAuthEnabled", "false");
  const disabled = await statusData(e);
  assert.equal(disabled.telegram_oauth, false);
  assert.equal(disabled.telegram_oauth_configured, false);

  await store.setOption("telegram.client_secret", "");
  const enableMissing = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "TelegramOAuthEnabled", value: "true" }),
    }),
    e,
  );
  assert.equal(enableMissing.body.success, false);
  securityOp(enableMissing.body, "TELEGRAM_OAUTH_NOT_CONFIGURED", ERR_TELEGRAM_OAUTH_NOT_CONFIGURED);
  assert.equal((await statusData(e)).telegram_oauth, false);

  await store.setOption("telegram.client_secret", "telegram-client-secret");
  const enableOk = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "TelegramOAuthEnabled", value: "true" }),
    }),
    e,
  );
  assert.equal(enableOk.body.success, true, String(enableOk.body.message));
  assert.equal((await statusData(e)).telegram_oauth_configured, true);
});

test("original GenerateOAuthCode telegram authorization_url and config error JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  const missing = await oauthState(e, auth);
  securityOp(missing.body, "TELEGRAM_OAUTH_NOT_CONFIGURED", ERR_TELEGRAM_OAUTH_NOT_CONFIGURED);

  await store.setOption("TelegramOAuthEnabled", "true");
  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  const noServer = await oauthState(e, auth);
  securityOp(noServer.body, "TELEGRAM_OAUTH_NOT_CONFIGURED", ERR_TELEGRAM_OAUTH_NOT_CONFIGURED);
  assert.equal((await statusData(e)).telegram_oauth_configured, true);

  await store.setOption("ServerAddress", "https://example.com");
  const ok = await oauthState(e, auth);
  assert.equal(ok.body.success, true, String(ok.body.message));
  const data = ok.body.data as { flow_token: string; expires_at: number; authorization_url: string };
  assert.equal(typeof data.flow_token, "string");
  assert.ok(data.flow_token.length > 0);
  assert.equal(typeof data.expires_at, "number");
  const url = new URL(data.authorization_url);
  assert.equal(url.origin, TELEGRAM_ISSUER);
  assert.equal(url.pathname, "/auth");
  assert.equal(url.searchParams.get("client_id"), "12345");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/oauth/telegram");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid profile");
  assert.equal(url.searchParams.get("state"), data.flow_token);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal((url.searchParams.get("code_challenge") || "").length, 43);
  assert.equal(url.searchParams.has("bot_id"), false);
  assert.equal(data.authorization_url.includes("telegram-client-secret"), false);
});

test("original GetStatus telegram_oauth_configured false on custom telegram slug conflict JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("TelegramOAuthEnabled", "true");
  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  await store.setOption("ServerAddress", "https://example.com");
  await store.insertOAuthProvider({
    name: "Conflict",
    slug: "telegram",
    client_id: "custom",
    client_secret: "secret",
    authorization_endpoint: "https://idp.example/auth",
    token_endpoint: "https://idp.example/token",
    user_info_endpoint: "https://idp.example/user",
    enabled: 0,
  });

  const conflicted = await statusData(e);
  assert.equal(conflicted.telegram_oauth, true);
  assert.equal(conflicted.telegram_oauth_configured, false);

  const state = await oauthState(e, auth);
  securityOp(state.body, "TELEGRAM_OAUTH_CONFLICT", ERR_TELEGRAM_OAUTH_CONFLICT);
  assert.equal(JSON.stringify(state.body).includes("flow_token"), false);
});
