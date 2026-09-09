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

function cookieVal(res: Response, name: string): string {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const line = all.find((c) => c.startsWith(name + "=")) || "";
  if (line) return decodeURIComponent(line.split(";")[0].slice(name.length + 1));
  const raw = String(res.headers.get("set-cookie") || "");
  const m = raw.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
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
  const refresh = cookieVal(login.res, "new_api_refresh");
  return { token, auth, login, refresh };
}

async function passwordProof(e: Env, auth: Record<string, string>, scope: string, extra: Record<string, unknown> = {}) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12", ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string; expires_at: number; method: string; scope: string };
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
  assert.equal(data.access_token.split(".").length, 3, "access_token must be a JWT");
  assert.match(data.session.sid, /^[0-9a-f-]{36}$/i);
  const setCookie = login.res.headers.getSetCookie?.() || [];
  const joined = setCookie.length ? setCookie.join("\n") : String(login.res.headers.get("set-cookie") || "");
  assert.match(joined, /session=/);
  assert.match(joined, /new-api_refresh|new_api_refresh/);
  assert.match(joined, /new_api_has_session/);
  assert.match(joined, /Path=\/api\/user\/auth/);
  assert.match(joined, /SameSite=Strict/);
  const refresh = cookieVal(login.res, "new_api_refresh");
  assert.equal(refresh.startsWith(data.session.sid + "."), true);
  assert.notEqual(refresh, data.access_token);
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

  const chk = await json(
    new Request("http://local/api/authz/check", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ resource: "channel", action: "read" }),
    }),
    e,
  );
  assert.equal(chk.body.success, true);
  assert.equal(chk.body.data.allowed, true);
  assert.equal(chk.body.data.resource, "channel");
  assert.equal(chk.body.data.action, "read");
  const chkGet = await json(new Request("http://local/api/authz/check?resource=channel&action=sensitive_write", { headers: auth }), e);
  assert.equal(chkGet.body.data.allowed, true);

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

  const needProof = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "a@example.com" }),
    }),
    e,
  );
  assert.equal(needProof.body.success, false);
  assert.equal(needProof.body.code, "SECURITY_PROOF_REQUIRED");
  const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "email", email: "a@example.com" } });
  const bind = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
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
  assert.equal(info.body.data[0].node_name, "edge-api");
  assert.equal(info.body.data[0].status, "online");
  assert.equal(info.body.data[0].stale_after_seconds, 90);
  assert.equal(info.body.data[0].info.runtime, "workerd");

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
  assert.ok((listed.body.data as { meta: { key: string }; active: boolean; runtime_status: string }[]).some((p) => p.meta.key === "demo" && p.active && p.runtime_status === "registered"));

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
  const setupProof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": setupProof.proof_token },
    }),
    e,
  );
  const secret = setup.body.data.secret as string;
  assert.equal(typeof setup.body.data.qr_code_data, "string");
  assert.ok(Array.isArray(setup.body.data.backup_codes));
  assert.equal(typeof setup.body.data.flow_token, "string");
  const { totpCode } = await import("../src/totp.js");
  const code = await totpCode(secret);
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code, flow_token: setup.body.data.flow_token }),
    }),
    e,
  );
  assert.equal(en.body.success, true, en.body.message);

  const status = await json(new Request("http://local/api/user/2fa/status", { headers: auth }), e);
  assert.equal(status.body.data.enabled, true);
  assert.equal(status.body.data.locked, false);
  assert.equal(status.body.data.backup_codes_remaining, 8);

  const v2 = await json(new Request("http://local/api/verify/methods?scope=2fa.disable", { headers: auth }), e);
  assert.equal(v2.body.success, true);
  assert.ok(v2.body.data.methods.some((m: { method: string }) => m.method === "2fa"));

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
  assert.equal(typeof st.body.data.expires_at, "number");
  assert.equal("state" in st.body.data, false);
});

test("GetPricing / topup info / verify methods / token booleans / channel DTO match original JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "pricing-ch",
        type: 1,
        key: "sk-a\nsk-b",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://example.invalid",
      }),
    }),
    e,
  );

  const pricing = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  assert.equal(pricing.body.success, true);
  for (const k of ["data", "vendors", "group_ratio", "usable_group", "supported_endpoint", "auto_groups", "pricing_version"]) {
    assert.ok(k in pricing.body, "missing GetPricing field " + k);
  }
  assert.ok(Array.isArray(pricing.body.data));
  assert.ok(pricing.body.data.some((m: { model_name: string }) => m.model_name === "gpt-4o-mini"));
  const row = pricing.body.data.find((m: { model_name: string }) => m.model_name === "gpt-4o-mini");
  assert.ok(Array.isArray(row.enable_groups));
  assert.ok(row.enable_groups.includes("default"));
  assert.equal(typeof row.completion_ratio, "number");
  assert.ok(Array.isArray(row.supported_endpoint_types));
  assert.equal(typeof pricing.body.group_ratio.default, "number");
  assert.equal(typeof pricing.body.usable_group.default, "string");
  assert.ok(pricing.body.supported_endpoint.openai?.path);
  assert.ok(Array.isArray(pricing.body.auto_groups));

  const info = await json(new Request("http://local/api/user/topup/info", { headers: auth }), e);
  const d = info.body.data;
  for (const k of [
    "enable_online_topup",
    "enable_stripe_topup",
    "enable_creem_topup",
    "enable_waffo_topup",
    "enable_waffo_pancake_topup",
    "enable_redemption",
    "payment_compliance_confirmed",
    "pay_methods",
    "min_topup",
    "amount_options",
    "discount",
    "topup_link",
  ]) {
    assert.ok(k in d, "missing topup/info field " + k);
  }
  assert.equal(d.enable_online_topup, false);
  assert.equal(d.enable_stripe_topup, false);
  assert.ok(Array.isArray(d.pay_methods));
  assert.ok(Array.isArray(d.amount_options));

  const methods = await json(new Request("http://local/api/verify/methods?scope=account.password.change", { headers: auth }), e);
  assert.equal(methods.body.success, true);
  assert.equal(methods.body.data.scope, "account.password.change");
  assert.ok(Array.isArray(methods.body.data.methods));
  assert.ok(methods.body.data.methods.some((m: { method: string; available: boolean }) => m.method === "password" && m.available));
  assert.ok(Array.isArray(methods.body.data.oauth_providers));
  assert.equal(typeof methods.body.data.password_encryption_enabled, "boolean");

  const badScope = await json(new Request("http://local/api/verify/methods", { headers: auth }), e);
  assert.equal(badScope.body.success, false);
  assert.equal(badScope.body.code, "SECURITY_PROOF_SCOPE_MISMATCH");

  const st2 = await json(new Request("http://local/api/user/2fa/status", { headers: auth }), e);
  assert.equal(st2.body.data.enabled, false);
  assert.equal(st2.body.data.locked, false);

  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "bools", unlimited_quota: true, model_limits_enabled: false }),
    }),
    e,
  );
  const listed = await json(new Request("http://local/api/token/", { headers: auth }), e);
  const item = listed.body.data.items.find((t: { name: string }) => t.name === "bools");
  assert.equal(item.unlimited_quota, true);
  assert.equal(typeof item.unlimited_quota, "boolean");
  assert.equal(typeof item.model_limits_enabled, "boolean");
  assert.equal(item.cross_group_retry, false);
  assert.equal(item.auto_groups, null);
  void tk;

  const chs = await json(new Request("http://local/api/channel/", { headers: auth }), e);
  assert.ok(chs.body.data.type_counts);
  assert.equal(typeof chs.body.data.type_counts["1"], "number");
  const ch = chs.body.data.items[0];
  assert.equal(typeof ch.balance, "number");
  assert.equal(typeof ch.balance_updated_time, "number");
  assert.equal(typeof ch.channel_info.is_multi_key, "boolean");
  assert.equal(ch.channel_info.is_multi_key, true);
  assert.equal(ch.key, "");
  assert.ok("setting" in ch);
  assert.ok("settings" in ch);

  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  for (const k of ["setting", "linux_do_id", "stripe_customer", "sidebar_modules", "has_password", "permissions"]) {
    assert.ok(k in self.body.data, "missing GetSelf field " + k);
  }
  assert.ok(self.body.data.permissions.admin_permissions);

  const groups = await json(new Request("http://local/api/user/groups", { headers: auth }), e);
  assert.equal(typeof groups.body.data.default.ratio, "number");
  assert.equal(typeof groups.body.data.default.desc, "string");

  const auto = await json(new Request("http://local/api/token/auto-groups", { headers: auth }), e);
  assert.ok(Array.isArray(auto.body.data.groups));
  assert.equal(typeof auto.body.data.max_count, "number");

  const img = await json(new Request("http://local/mj/image/abc"), e);
  assert.notEqual(img.res.status, 401);

  const mjTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "mj", unlimited_quota: true }),
    }),
    e,
  );
  const nested = await json(
    new Request("http://local/fast/mj/submit/imagine", {
      method: "POST",
      headers: { authorization: "Bearer " + mjTok.body.data.key, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    }),
    e,
  );
  assert.notEqual(nested.body?.error?.code, "not_implemented");
});

test("original DashboardListModels, logs, aff, checkin, options, ratio_sync, ListModels JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const dash = await json(new Request("http://local/api/models", { headers: auth }), e);
  assert.equal(dash.body.success, true);
  assert.ok(Array.isArray(dash.body.data["1"]));
  assert.ok(dash.body.data["1"].includes("gpt-4o-mini"));

  const adminMeta = await json(new Request("http://local/api/models/", { headers: auth }), e);
  assert.equal(adminMeta.body.success, true);
  assert.ok("vendor_counts" in adminMeta.body.data);
  assert.ok("items" in adminMeta.body.data);
  assert.equal(typeof adminMeta.body.data.page, "number");
  assert.equal(typeof adminMeta.body.data.page_size, "number");

  const chModels = await json(new Request("http://local/api/channel/models", { headers: auth }), e);
  assert.equal(chModels.body.data[0].object, "model");
  assert.equal(chModels.body.data[0].created, 1626777600);
  assert.ok(Array.isArray(chModels.body.data[0].supported_endpoint_types));

  const unknownGroup = await json(new Request("http://local/api/user/models?group=does-not-exist", { headers: auth }), e);
  assert.deepEqual(unknownGroup.body.data, []);

  const aff = await json(new Request("http://local/api/user/aff", { headers: auth }), e);
  assert.equal(typeof aff.body.data, "string");
  assert.ok(aff.body.data.length > 0);

  const ck = await json(new Request("http://local/api/user/checkin", { headers: auth }), e);
  assert.equal(ck.body.data.enabled, true);
  assert.equal(typeof ck.body.data.min_quota, "number");
  assert.equal(typeof ck.body.data.max_quota, "number");
  assert.equal(typeof ck.body.data.stats.checked_in_today, "boolean");
  assert.equal(typeof ck.body.data.stats.total_checkins, "number");
  assert.ok(Array.isArray(ck.body.data.stats.records));

  const doCk = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  assert.equal(doCk.body.success, true, doCk.body.message);
  assert.equal(typeof doCk.body.data.quota_awarded, "number");
  assert.equal(typeof doCk.body.data.checkin_date, "string");

  const opts = await json(new Request("http://local/api/option/", { headers: auth }), e);
  const keys = (opts.body.data as { key: string; value: string }[]).map((o) => o.key);
  assert.ok(keys.includes("CompletionRatioMeta"));
  assert.ok(keys.includes("billing_setting.billing_mode"));
  assert.ok(keys.includes("billing_setting.billing_expr"));
  assert.ok(!keys.some((k) => k.endsWith("Secret") || k.endsWith("Token")));

  const logSlash = await json(new Request("http://local/api/log/", { headers: auth }), e);
  const logNoSlash = await json(new Request("http://local/api/log", { headers: auth }), e);
  assert.equal(logSlash.body.success, true);
  assert.equal(logNoSlash.body.success, true);
  assert.ok("items" in logSlash.body.data);
  if (logSlash.body.data.items[0]) {
    const row = logSlash.body.data.items[0];
    assert.ok("channel" in row);
    assert.ok("is_stream" in row);
    assert.equal(typeof row.is_stream, "boolean");
    assert.ok("other" in row);
    assert.ok("request_id" in row);
    assert.ok("upstream_request_id" in row);
  }

  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "status-only", remain_quota: 0, unlimited_quota: false }),
    }),
    e,
  );
  const tid = tok.body.data.id as number;
  await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: tid, status: 4 }),
    }),
    e,
  );
  const cannotEnable = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: tid, status: 1 }),
    }),
    e,
  );
  assert.equal(cannotEnable.body.success, false);

  const ratioOff = await json(new Request("http://local/api/ratio_config"), e);
  assert.equal(ratioOff.res.status, 403);
  assert.equal(ratioOff.body.message, "倍率配置接口未启用");

  const syncCh = await json(new Request("http://local/api/ratio_sync/channels", { headers: auth }), e);
  assert.ok(syncCh.body.data.some((c: { id: number }) => c.id === -100));
  assert.ok(syncCh.body.data.some((c: { id: number }) => c.id === -101));
  assert.ok("status" in syncCh.body.data[0]);

  const rt = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  assert.equal(typeof rt.body.data.current_generation, "number");
  assert.ok(rt.body.data.last_rebuild);
  assert.equal(typeof rt.body.data.last_rebuild.error, "string");
  assert.ok("plugin_errors" in rt.body.data);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "list-models",
        type: 1,
        key: "sk-x",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://example.invalid",
      }),
    }),
    e,
  );
  const sk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "relay", unlimited_quota: true }),
    }),
    e,
  );
  const skAuth = { authorization: "Bearer " + sk.body.data.key };

  const v1 = await json(new Request("http://local/v1/models", { headers: skAuth }), e);
  assert.equal(v1.body.success, true);
  assert.equal(v1.body.object, "list");
  assert.ok(Array.isArray(v1.body.data));
  const m = v1.body.data.find((x: { id: string }) => x.id === "gpt-4o-mini") || v1.body.data[0];
  assert.equal(m.object, "model");
  assert.equal(m.created, 1626777600);
  assert.ok(Array.isArray(m.supported_endpoint_types));

  const gem = await json(
    new Request("http://local/v1/models", { headers: { ...skAuth, "x-goog-api-key": "g" } }),
    e,
  );
  assert.ok(Array.isArray(gem.body.models));
  assert.equal(gem.body.nextPageToken, null);
  if (gem.body.models[0]) assert.equal(typeof gem.body.models[0].name, "string");
  if (gem.body.models[0]) assert.equal(gem.body.models[0].name.startsWith("models/"), false);

  const anth = await json(
    new Request("http://local/v1/models", { headers: { ...skAuth, "x-api-key": "a", "anthropic-version": "2023-06-01" } }),
    e,
  );
  assert.ok(Array.isArray(anth.body.data));
  assert.equal(typeof anth.body.first_id, "string");
  assert.equal(anth.body.has_more, false);
  assert.equal(typeof anth.body.last_id, "string");
  if (anth.body.data[0]) {
    assert.equal(anth.body.data[0].type, "model");
    assert.equal(typeof anth.body.data[0].display_name, "string");
    assert.match(anth.body.data[0].created_at, /T/);
  }

  const missing = await json(new Request("http://local/v1/models/not-a-real-model", { headers: skAuth }), e);
  assert.equal(missing.res.status, 200);
  assert.equal(missing.body.error.code, "model_not_found");
  assert.equal(missing.body.error.type, "invalid_request_error");

  const usage = await json(new Request("http://local/api/usage/token", { headers: skAuth }), e);
  assert.equal(usage.body.code, true);
  assert.equal(usage.body.data.object, "token_usage");
  assert.equal(typeof usage.body.data.total_granted, "number");
  assert.equal(typeof usage.body.data.total_used, "number");
  assert.equal(typeof usage.body.data.total_available, "number");
  assert.equal(typeof usage.body.data.unlimited_quota, "boolean");
  assert.equal(typeof usage.body.data.model_limits_enabled, "boolean");
});

test("auth refresh keeps LoginSessionView sid and returns AuthBundle user", async () => {
  resetSchemaFlag();
  const e = env();
  const { login, refresh } = await boot(e);
  const sid = login.body.data.session.sid as string;
  const rotated = await json(
    new Request("http://local/api/user/auth/refresh", {
      method: "POST",
      headers: { "X-Auth-Session": sid, cookie: `new_api_refresh=${refresh}` },
    }),
    e,
  );
  assert.equal(rotated.body.success, true, rotated.body.message);
  assert.equal(rotated.body.data.session.sid, sid);
  assert.equal(rotated.body.data.token_type, "Bearer");
  assert.equal(rotated.body.data.access_token.split(".").length, 3);
  assert.notEqual(rotated.body.data.access_token, login.body.data.access_token);
  assert.equal(rotated.body.data.user.username, "root");
  assert.equal(typeof rotated.body.data.user.linux_do_id, "string");
  const nextRefresh = cookieVal(rotated.res, "new_api_refresh");
  assert.equal(nextRefresh.startsWith(sid + "."), true);
  assert.notEqual(nextRefresh, refresh);

  const replay = await json(
    new Request("http://local/api/user/auth/refresh", {
      method: "POST",
      headers: { "X-Auth-Session": sid, cookie: `new_api_refresh=${refresh}` },
    }),
    e,
  );
  assert.equal(replay.body.success, true, "original AUTH_REFRESH_RACE replay window reissues the rotated token");
  assert.equal(cookieVal(replay.res, "new_api_refresh"), nextRefresh);
  assert.equal(replay.body.data.session.sid, sid);

  const anon = await json(new Request("http://local/api/user/auth/refresh", { method: "POST" }), e);
  assert.equal(anon.res.status, 401);
  assert.equal(anon.body.code, "AUTH_UNAUTHORIZED");
});

test("oauth callback without state is original 403; state endpoint is flow_token only for github", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const missing = await json(new Request("http://local/api/oauth/github?code=abc"), e);
  assert.equal(missing.res.status, 403);
  assert.equal(missing.body.success, false);

  const st = await json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "github", intent: "login" }),
    }),
    e,
  );
  assert.equal(typeof st.body.data.flow_token, "string");
  assert.equal(typeof st.body.data.expires_at, "number");
});

test("security proof is an original JWT and is consumed once", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const proof = await passwordProof(e, auth, "2fa.setup");
  assert.equal(proof.method, "password");
  assert.equal(proof.scope, "2fa.setup");
  assert.equal(proof.proof_token.split(".").length, 3);
  const payload = JSON.parse(Buffer.from(proof.proof_token.split(".")[1], "base64url").toString());
  assert.equal(payload.token_use, "security_proof");
  assert.equal(payload.iss, "new-api");
  assert.equal(payload.aud, "new-api-dashboard");
  assert.deepEqual(payload.scopes, ["2fa.setup"]);
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, setup.body.message);
  const reuse = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(reuse.res.status, 403);
  assert.equal(reuse.body.code, "SECURITY_PROOF_CONSUMED");
  const missing = await json(new Request("http://local/api/user/2fa/setup", { method: "POST", headers: auth }), e);
  assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
});

