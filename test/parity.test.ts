import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = await res.json();
  return { res, body };
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
  const token = login.body.data.access_token as string;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { token, auth, login };
}

test("GetStatus matches original SystemStatus fields", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  void auth;
  const st = await json(new Request("http://local/api/status"), e);
  assert.equal(st.body.success, true);
  const d = st.body.data;
  for (const k of [
    "version",
    "start_time",
    "email_verification",
    "github_oauth",
    "github_client_id",
    "discord_oauth",
    "linuxdo_oauth",
    "telegram_oauth",
    "telegram_oauth_configured",
    "telegram_bot_name",
    "theme",
    "system_name",
    "wechat_qrcode",
    "wechat_login",
    "turnstile_check",
    "quota_per_unit",
    "display_in_currency",
    "quota_display_type",
    "custom_currency_symbol",
    "enable_drawing",
    "enable_task",
    "enable_data_export",
    "chats",
    "demo_site_enabled",
    "self_use_mode_enabled",
    "register_enabled",
    "password_login_enabled",
    "oidc_enabled",
    "passkey_login",
    "setup",
    "user_agreement_enabled",
    "privacy_policy_enabled",
    "checkin_enabled",
    "HeaderNavModules",
    "SidebarModulesAdmin",
  ]) {
    assert.ok(k in d, "missing status field " + k);
  }
  assert.equal(d.setup, true);
  assert.equal(d.system_name, "Edge API Test");
});

test("login AuthBundle has original session + cookies", async () => {
  resetSchemaFlag();
  const e = env();
  const { login } = await boot(e);
  const data = login.body.data;
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.token_type, "Bearer");
  assert.equal(typeof data.access_expires_at, "number");
  assert.ok(data.access_expires_at > 0);
  assert.equal(typeof data.session.sid, "string");
  assert.equal(data.session.current, true);
  assert.equal(data.session.login_method, "password");
  assert.equal(typeof data.session.ip, "string");
  assert.equal(typeof data.session.user_agent, "string");
  assert.equal(typeof data.session.created_at, "number");
  assert.equal(typeof data.session.last_active_at, "number");
  assert.equal(typeof data.session.expires_at, "number");
  assert.equal(data.user.username, "root");
  assert.equal(typeof data.user.role, "number");
  const setCookie = login.res.headers.getSetCookie?.() || [];
  const joined = setCookie.length ? setCookie.join("\n") : String(login.res.headers.get("set-cookie") || "");
  assert.match(joined, /session=/);
  assert.match(joined, /new-api_refresh|new_api_refresh/);
  assert.match(joined, /new_api_has_session/);
});

test("authz catalog + channel GET update_balance + email bind without mail", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const cat = await json(new Request("http://local/api/authz/catalog", { headers: auth }), e);
  assert.equal(cat.body.success, true);
  assert.ok(Array.isArray(cat.body.data.resources));
  assert.ok(cat.body.data.resources.some((r: { resource: string }) => r.resource === "channel"));
  assert.ok(cat.body.data.roles.some((r: { key: string; superuser: boolean }) => r.key === "root" && r.superuser));

  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mock",
        type: 1,
        key: "sk-x",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://example.invalid",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.body.message);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const bal = await json(new Request("http://local/api/channel/update_balance", { headers: auth }), e);
    assert.equal(bal.body.success, true);
    assert.ok(Array.isArray(bal.body.data));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const bind = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "a@example.com" }),
    }),
    e,
  );
  assert.equal(bind.body.success, false);
  assert.match(String(bind.body.message), /邮件/);
});

test("system-info, task plugin upsert, original token usage, sessions view", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const info = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  assert.equal(info.body.success, true);
  assert.ok(Array.isArray(info.body.data));
  assert.equal(info.body.data[0].runtime, "workerd");

  const plugin = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: "demo", name: "Demo", version: "1.0.0", status: "active", routes: [] }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, plugin.body.message);
  const listed = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  assert.ok((listed.body.data as { key: string }[]).some((p) => p.key === "demo"));

  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "usage", unlimited_quota: true }),
    }),
    e,
  );
  const sk = tk.body.data.key as string;
  const usage = await json(new Request("http://local/api/usage/token", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(usage.body.code, true);
  assert.equal(usage.body.data.object, "token_usage");
  assert.equal(typeof usage.body.data.total_granted, "number");
  assert.equal(typeof usage.body.data.total_used, "number");
  assert.equal(typeof usage.body.data.total_available, "number");

  const sess = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  assert.equal(sess.body.success, true);
  assert.ok(Array.isArray(sess.body.data));
  assert.equal(typeof sess.body.data[0].user_agent, "string");
  assert.equal(typeof sess.body.data[0].login_method, "string");
  assert.equal(sess.body.data.some((x: { current: boolean }) => x.current), true);
});

test("2FA login still require_2fa plus original LoginChallenge fields", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const setup = await json(new Request("http://local/api/user/2fa/setup", { method: "POST", headers: auth }), e);
  const secret = setup.body.data.secret as string;
  const { totpCode } = await import("../src/totp.js");
  const code = await totpCode(secret);
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code }),
    }),
    e,
  );
  assert.equal(en.body.success, true, en.body.message);

  const challenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(challenge.body.data.require_2fa, true);
  assert.equal(challenge.body.data.require_verification, true);
  assert.ok(Array.isArray(challenge.body.data.methods));
  assert.ok(challenge.body.data.methods.some((m: { method: string }) => m.method === "2fa"));
  const flow = challenge.body.data.flow_token as string;
  const code2 = await totpCode(secret);
  const done = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: flow, method: "2fa", code: code2 }),
    }),
    e,
  );
  assert.equal(done.body.success, true, done.body.message);
  assert.ok(done.body.data.access_token);
  assert.equal(done.body.data.session.login_method, "2fa");
});

test("payments topup info reflects config; oauth state returns flow_token", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const info = await json(new Request("http://local/api/user/topup/info", { headers: auth }), e);
  assert.equal(info.body.success, true);
  assert.equal(info.body.data.enable_online_topup, false);
  assert.equal(typeof info.body.data.stripe, "boolean");

  const st = await json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "github", intent: "login" }),
    }),
    e,
  );
  assert.equal(st.body.success, true);
  assert.equal(typeof st.body.data.flow_token, "string");
  assert.equal(st.body.data.state, st.body.data.flow_token);
});
