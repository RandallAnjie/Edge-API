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

const ORIGINAL_API: { method: string; path: string }[] = [
  { method: "GET", path: "/api/setup" },
  { method: "GET", path: "/api/status" },
  { method: "GET", path: "/api/uptime/status" },
  { method: "GET", path: "/api/models" },
  { method: "GET", path: "/api/status/test" },
  { method: "GET", path: "/api/notice" },
  { method: "GET", path: "/api/user-agreement" },
  { method: "GET", path: "/api/privacy-policy" },
  { method: "GET", path: "/api/about" },
  { method: "GET", path: "/api/home_page_content" },
  { method: "GET", path: "/api/pricing" },
  { method: "GET", path: "/api/perf-metrics/summary" },
  { method: "GET", path: "/api/rankings" },
  { method: "GET", path: "/api/ratio_config" },
  { method: "POST", path: "/api/oauth/state" },
  { method: "POST", path: "/api/oauth/email/bind/start" },
  { method: "GET", path: "/api/oauth/wechat" },
  { method: "GET", path: "/api/oauth/telegram/login" },
  { method: "GET", path: "/api/verify/methods?scope=account.password.change" },
  { method: "POST", path: "/api/user/auth/refresh" },
  { method: "POST", path: "/api/user/auth/logout" },
  { method: "GET", path: "/api/user/login/encryption-key" },
  { method: "GET", path: "/api/user/sessions" },
  { method: "GET", path: "/api/user/self" },
  { method: "GET", path: "/api/user/models" },
  { method: "GET", path: "/api/user/token/status" },
  { method: "GET", path: "/api/user/passkey" },
  { method: "POST", path: "/api/user/passkey/login/begin" },
  { method: "GET", path: "/api/user/aff" },
  { method: "GET", path: "/api/user/topup/info" },
  { method: "GET", path: "/api/user/2fa/status" },
  { method: "GET", path: "/api/user/checkin" },
  { method: "GET", path: "/api/user/oauth/bindings" },
  { method: "GET", path: "/api/subscription/plans" },
  { method: "GET", path: "/api/subscription/self" },
  { method: "GET", path: "/api/subscription/admin/plans" },
  { method: "GET", path: "/api/option/" },
  { method: "GET", path: "/api/custom-oauth-provider/" },
  { method: "GET", path: "/api/performance/stats" },
  { method: "GET", path: "/api/ratio_sync/channels" },
  { method: "GET", path: "/api/plugin/task" },
  { method: "GET", path: "/api/plugin/task/runtime/status" },
  { method: "GET", path: "/api/task_plugin_options" },
  { method: "GET", path: "/api/authz/catalog" },
  { method: "GET", path: "/api/authz/check?resource=channel&action=read" },
  { method: "GET", path: "/api/channel/" },
  { method: "GET", path: "/api/channel/models" },
  { method: "GET", path: "/api/channel/models_enabled" },
  { method: "GET", path: "/api/channel/ops" },
  { method: "GET", path: "/api/channel/update_balance" },
  { method: "GET", path: "/api/channel/tag/models" },
  { method: "GET", path: "/api/token/" },
  { method: "GET", path: "/api/token/auto-groups" },
  { method: "GET", path: "/api/redemption/" },
  { method: "GET", path: "/api/audit" },
  { method: "GET", path: "/api/log/" },
  { method: "GET", path: "/api/log/self" },
  { method: "GET", path: "/api/system-task/list" },
  { method: "GET", path: "/api/system-info/instances" },
  { method: "GET", path: "/api/data/" },
  { method: "GET", path: "/api/data/users" },
  { method: "GET", path: "/api/data/flow?start_timestamp=1&end_timestamp=2" },
  { method: "GET", path: "/api/group/" },
  { method: "GET", path: "/api/prefill_group/" },
  { method: "GET", path: "/api/mj/" },
  { method: "GET", path: "/api/task" },
  { method: "GET", path: "/api/vendors/" },
  { method: "GET", path: "/api/models/" },
  { method: "GET", path: "/api/models/missing" },
  { method: "GET", path: "/api/deployments/" },
  { method: "GET", path: "/api/deployments/settings" },
  { method: "GET", path: "/api/user/self/groups" },
  { method: "GET", path: "/api/data/self" },
  { method: "GET", path: "/api/data/flow/self?start_timestamp=1&end_timestamp=2" },
  { method: "GET", path: "/api/log/search" },
  { method: "POST", path: "/api/channel/fix" },
  { method: "GET", path: "/dashboard/billing/subscription" },
];

test("original Gin API surfaces are registered (not 404)", async () => {
  resetSchemaFlag();
  const e = env();
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

  for (const route of ORIGINAL_API) {
    const { res, text } = await json(
      new Request("http://local" + route.path, { method: route.method, headers: auth }),
      e,
    );
    assert.notEqual(res.status, 404, `${route.method} ${route.path} was 404: ${text.slice(0, 80)}`);
    assert.notEqual(text, "Not Found", `${route.method} ${route.path} returned Not Found`);
  }
});

test("original JSON fields for status, models, deployments, performance, data, usage, authz", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const status = await json(new Request("http://local/api/status"), e);
  const st = status.body.data as Record<string, unknown>;
  assert.equal(typeof st.start_time, "number");
  assert.ok((st.start_time as number) < Date.now() / 50, "start_time is unix seconds");
  assert.equal(typeof st.passkey_login, "boolean");
  assert.equal(typeof st.oidc_enabled, "boolean");
  assert.equal(typeof st.checkin_enabled, "boolean");

  await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "gpt-4o", description: "test" }),
    }),
    e,
  );
  const models = await json(new Request("http://local/api/models/", { headers: auth }), e);
  const md = models.body.data as Record<string, unknown>;
  assert.ok(Array.isArray(md.items));
  assert.equal(typeof md.total, "number");
  assert.equal(typeof md.page, "number");
  assert.equal(typeof md.page_size, "number");
  assert.equal(typeof md.vendor_counts, "object");
  const first = (md.items as Record<string, unknown>[])[0];
  assert.equal(first.model_name, "gpt-4o");
  assert.equal(first.has_metadata, true);
  assert.equal(typeof first.square_state, "string");
  assert.equal(typeof first.created_time, "number");
  assert.equal(typeof first.name_rule, "number");

  const deploy = await json(new Request("http://local/api/deployments/settings", { headers: auth }), e);
  const ds = deploy.body.data as Record<string, unknown>;
  assert.equal(ds.provider, "io.net");
  assert.equal(typeof ds.enabled, "boolean");
  assert.equal(typeof ds.configured, "boolean");
  assert.equal(typeof ds.can_connect, "boolean");
  const deployList = await json(new Request("http://local/api/deployments/", { headers: auth }), e);
  assert.equal(deployList.body.success, false);
  assert.match(String(deployList.body.message), /io\.net model deployment is not enabled/);

  const perf = await json(new Request("http://local/api/performance/stats", { headers: auth }), e);
  const pd = perf.body.data as Record<string, unknown>;
  const cache = pd.cache_stats as Record<string, unknown>;
  assert.equal(typeof cache.active_disk_files, "number");
  assert.equal(typeof cache.current_disk_usage_bytes, "number");
  const mem = pd.memory_stats as Record<string, unknown>;
  assert.equal(typeof mem.alloc, "number");
  assert.equal(typeof mem.num_gc, "number");
  const disk = pd.disk_cache_info as Record<string, unknown>;
  assert.equal(typeof disk.file_count, "number");
  assert.equal(typeof disk.total_size, "number");
  const space = pd.disk_space_info as Record<string, unknown>;
  assert.equal(typeof space.used_percent, "number");
  const cfg = pd.config as Record<string, unknown>;
  assert.equal(typeof cfg.disk_cache_enabled, "boolean");

  const inst = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  const nodes = inst.body.data as Record<string, unknown>[];
  assert.equal(nodes[0].node_name, "edge-api");
  assert.equal(nodes[0].status, "online");
  assert.equal(nodes[0].stale_after_seconds, 90);
  assert.equal(typeof nodes[0].started_at, "number");
  assert.equal(typeof nodes[0].last_seen_at, "number");

  const topup = await json(new Request("http://local/api/user/topup/info", { headers: auth }), e);
  const ti = topup.body.data as Record<string, unknown>;
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
  ]) {
    assert.ok(k in ti, "missing topup info " + k);
  }

  const flow = await json(
    new Request("http://local/api/data/flow?start_timestamp=1&end_timestamp=2", { headers: auth }),
    e,
  );
  assert.equal(flow.body.success, true);
  assert.ok(Array.isArray(flow.body.data));

  const usersData = await json(new Request("http://local/api/data/users?start_timestamp=1&end_timestamp=9999999999", { headers: auth }), e);
  assert.ok(Array.isArray(usersData.body.data));

  const token = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "json-test", remain_quota: 1000, unlimited_quota: false }),
    }),
    e,
  );
  const sk = String((token.body.data as { key?: string })?.key || "");
  assert.ok(sk.startsWith("sk-"));
  const usage = await json(new Request("http://local/api/usage/token", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(usage.body.code, true);
  assert.equal(usage.body.message, "ok");
  const ud = usage.body.data as Record<string, unknown>;
  assert.equal(ud.object, "token_usage");
  assert.equal(typeof ud.total_granted, "number");
  assert.equal(typeof ud.total_used, "number");
  assert.equal(typeof ud.total_available, "number");
  assert.equal(typeof ud.unlimited_quota, "boolean");
  assert.equal(typeof ud.model_limits_enabled, "boolean");
  assert.equal(typeof ud.expires_at, "number");

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "admin1", password: "password12", role: 10 }),
    }),
    e,
  );
  const adminLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin1", password: "password12" }),
    }),
    e,
  );
  const adminAuth = {
    authorization: "Bearer " + (adminLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const denied = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ name: "blocked", type: 1, key: "sk-x" }),
    }),
    e,
  );
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.success, false);
  const listed = await json(new Request("http://local/api/channel/", { headers: adminAuth }), e);
  assert.equal(listed.body.success, true);
  assert.ok("type_counts" in (listed.body.data as object));

  const sessions = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  const views = sessions.body.data as Record<string, unknown>[];
  assert.ok(views.length);
  for (const k of ["sid", "current", "login_method", "ip", "user_agent", "created_at", "last_active_at", "expires_at"]) {
    assert.ok(k in views[0], "missing LoginSessionView " + k);
  }
  assert.equal("last_seen" in views[0], false);

  const verify = await json(new Request("http://local/api/verify/methods?scope=account.password.change", { headers: auth }), e);
  const vr = verify.body.data as Record<string, unknown>;
  assert.equal(vr.scope, "account.password.change");
  assert.ok(Array.isArray(vr.methods));
  assert.ok(Array.isArray(vr.oauth_providers));
  assert.equal(typeof vr.password_encryption_enabled, "boolean");

  const tokenStatus = await json(new Request("http://local/api/user/token/status", { headers: auth }), e);
  const ts = tokenStatus.body.data as Record<string, unknown>;
  assert.equal(ts.exists, false);
  assert.equal("token_ref" in ts, true);
  assert.equal("created_at" in ts, true);
  assert.equal("last_used_at" in ts, true);
  assert.equal("last_used_ip" in ts, true);

  const proof = await passwordProof(e, auth, "access_token.generate");
  assert.equal(proof.proof_token.split(".").length, 3);
  const issued = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(issued.body.success, true, String(issued.body.message));
  assert.equal(typeof issued.body.data, "string");
  const after = await json(new Request("http://local/api/user/token/status", { headers: auth }), e);
  assert.equal((after.body.data as { exists: boolean }).exists, true);
  assert.equal(typeof (after.body.data as { token_ref: string }).token_ref, "string");
  assert.equal((after.body.data as { token_ref: string }).token_ref.length, 64);

  const rules = await e.DB.prepare("SELECT COUNT(*) as c FROM casbin_rule WHERE v0 = 'role:admin'").first<{ c: number }>();
  assert.ok(Number(rules?.c) >= 3);

  const roles = await e.DB.prepare("SELECT COUNT(*) as c FROM authz_roles WHERE built_in = 1").first<{ c: number }>();
  assert.equal(Number(roles?.c), 2);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "openai-a", type: 1, key: "sk-a", models: "gpt-4o", group: "default" }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "claude-b", type: 14, key: "sk-b", models: "claude-3", group: "default" }),
    }),
    e,
  );
  const allCh = await json(new Request("http://local/api/channel/", { headers: auth }), e);
  const counts = (allCh.body.data as { type_counts: Record<string, number> }).type_counts;
  const typed = await json(new Request("http://local/api/channel/?type=1", { headers: auth }), e);
  assert.deepEqual((typed.body.data as { type_counts: Record<string, number> }).type_counts, counts);

  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  const me = self.body.data as Record<string, unknown>;
  assert.equal(me.has_password, true);
  assert.equal("linux_do_id" in me, true);
  assert.equal("permissions" in me, true);
  const perms = me.permissions as Record<string, unknown>;
  assert.equal("admin_permissions" in perms, true);
  assert.equal("sidebar_settings" in perms, true);

  const bindings = await json(new Request("http://local/api/user/oauth/bindings", { headers: auth }), e);
  assert.equal(Array.isArray(bindings.body.data), true);

  const passkeyBegin = await json(
    new Request("http://local/api/user/passkey/login/begin", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    e,
  );
  assert.equal(passkeyBegin.body.success, true);
  const pkd = passkeyBegin.body.data as Record<string, unknown>;
  assert.equal(typeof pkd.flow_token, "string");
  assert.equal(typeof pkd.expires_at, "number");
  assert.equal(typeof pkd.options, "object");
  assert.equal("username" in (JSON.parse("{}") as object), false);

  const catalog = await json(new Request("http://local/api/authz/catalog", { headers: auth }), e);
  const cat = catalog.body.data as { resources: { resource: string }[]; roles: { key: string; built_in: boolean; superuser: boolean; grants: Record<string, Record<string, boolean>> }[] };
  assert.ok(cat.resources.some((r) => r.resource === "channel"));
  assert.ok(cat.resources.some((r) => r.resource === "audit"));
  assert.ok(cat.resources.some((r) => r.resource === "task_plugin"));
  const adminRole = cat.roles.find((r) => r.key === "admin");
  assert.equal(adminRole?.built_in, true);
  assert.equal(adminRole?.superuser, false);
  assert.equal(adminRole?.grants.channel.read, true);
  assert.equal(adminRole?.grants.channel.sensitive_write, false);
  const rootRole = cat.roles.find((r) => r.key === "root");
  assert.equal(rootRole?.superuser, true);
  assert.equal(rootRole?.grants.channel.sensitive_write, true);

  const oauthState = await json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "not-a-provider", intent: "login" }),
    }),
    e,
  );
  assert.equal(oauthState.body.success, false);

  const githubState = await json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "github", intent: "login" }),
    }),
    e,
  );
  assert.equal(githubState.body.success, true);
  const stateData = githubState.body.data as Record<string, unknown>;
  assert.equal(typeof stateData.flow_token, "string");
  assert.equal(typeof stateData.expires_at, "number");
  assert.equal("state" in stateData, false);

  const bindState = await json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "github", intent: "bind" }),
    }),
    e,
  );
  assert.equal(bindState.body.success, false);
  assert.equal(bindState.body.code, "SECURITY_PROOF_REQUIRED");

  const audit = await json(new Request("http://local/api/audit", { headers: auth }), e);
  const ad = audit.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(typeof ad.total, "number");
  assert.equal(typeof ad.page, "number");
  if (ad.items.length) {
    for (const k of ["event_id", "user_id", "username", "category", "action", "token_ref", "ip", "success", "created_at"]) {
      assert.ok(k in ad.items[0], "missing audit field " + k);
    }
  }

  const pat = String(issued.body.data);
  const selfPat = await json(new Request("http://local/api/user/self", { headers: { authorization: "Bearer " + pat } }), e);
  assert.equal(selfPat.body.success, true);
  const used = await json(new Request("http://local/api/user/token/status", { headers: auth }), e);
  const usedData = used.body.data as { last_used_at: number | null; last_used_ip: string };
  assert.equal(typeof usedData.last_used_at, "number");

  await json(new Request("http://local/api/this-route-does-not-exist", { headers: { authorization: "Bearer " + pat } }), e);
  const patAudit = await json(new Request("http://local/api/audit?category=access_token", { headers: auth }), e);
  const patItems = (patAudit.body.data as { items: { route: string; status: number; success: boolean }[] }).items;
  assert.ok(patItems.some((row) => row.route === "/api/user/self" && row.status === 200 && row.success === true));
  assert.ok(patItems.some((row) => row.route === "/api/this-route-does-not-exist" && row.status === 404 && row.success === false));

  const users = await json(new Request("http://local/api/user/search?keyword=admin1", { headers: auth }), e);
  const adminRow = ((users.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "admin1");
  assert.ok(adminRow);
  await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: adminRow!.id, admin_permissions: { channel: { read: false } } }),
    }),
    e,
  );
  const deniedRead = await json(new Request("http://local/api/channel/", { headers: adminAuth }), e);
  assert.equal(deniedRead.res.status, 403);
  assert.equal(deniedRead.body.message, "无权进行此操作，权限不足");

  const plugins = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  assert.ok(Array.isArray(plugins.body.data));

  await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: "suno", name: "Suno", version: "1.0.0", status: "active", routes: [{ method: "POST", path: "/suno/submit" }] }),
    }),
    e,
  );
  const pluginList = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const suno = (pluginList.body.data as { meta: { key: string }; enabled: boolean; active: boolean; runtime_status: string; has_icon: boolean; channel_count: number }[]).find(
    (p) => p.meta.key === "suno",
  );
  assert.equal(suno?.enabled, true);
  assert.equal(suno?.active, true);
  assert.equal(suno?.runtime_status, "registered");
  assert.equal(typeof suno?.has_icon, "boolean");
  assert.equal(typeof suno?.channel_count, "number");

  const stripePay = await json(
    new Request("http://local/api/user/stripe/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10, payment_method: "stripe" }),
    }),
    e,
  );
  assert.equal(stripePay.body.success, false);
  assert.equal(stripePay.body.message, "Stripe 未配置");

  const statusType = await json(new Request("http://local/api/status"), e);
  assert.equal((statusType.body.data as { quota_display_type: string }).quota_display_type, "USD");
  assert.equal(typeof (statusType.body.data as { display_token_stat_enabled: boolean }).display_token_stat_enabled, "boolean");
  assert.equal(typeof (statusType.body.data as { oauth_register_enabled: boolean }).oauth_register_enabled, "boolean");

  const setupDone = await json(new Request("http://local/api/setup"), e);
  const setupData = setupDone.body.data as { status: boolean; root_init: boolean; database_type: string };
  assert.equal(setupDone.body.success, true);
  assert.equal(setupData.status, true);
  assert.equal(setupData.root_init, false);
  assert.equal(setupData.database_type, "");

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "Notice", value: "hello-notice" }),
    }),
    e,
  );
  const notice = await json(new Request("http://local/api/notice"), e);
  assert.equal(notice.body.success, true);
  assert.equal(notice.body.data, "hello-notice");
  assert.match(notice.res.headers.get("etag") || "", /^W\/"/);
  assert.equal(notice.res.headers.get("cache-control"), "no-cache");
  const notice304 = await json(
    new Request("http://local/api/notice", { headers: { "if-none-match": notice.res.headers.get("etag") || "" } }),
    e,
  );
  assert.equal(notice304.res.status, 304);

  const searchLogs = await json(new Request("http://local/api/log/search", { headers: auth }), e);
  assert.equal(searchLogs.body.success, false);
  assert.equal(searchLogs.body.message, "该接口已废弃");

  const creemUnconfigured = await json(
    new Request("http://local/api/user/creem/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ product_id: "prod_1", payment_method: "creem" }),
    }),
    e,
  );
  assert.equal(creemUnconfigured.body.message, "error");
  assert.equal(creemUnconfigured.body.data, "未配置Creem API密钥");

  const waffoDisabled = await json(
    new Request("http://local/api/user/waffo/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10 }),
    }),
    e,
  );
  assert.equal(waffoDisabled.body.message, "error");
  assert.equal(waffoDisabled.body.data, "Waffo 支付未启用");

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        key: "CreemProducts",
        value: JSON.stringify([{ productId: "prod_1", name: "Pack", price: 10, quota: 500000 }]),
      }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "CreemApiKey", value: "ck_test" }),
    }),
    e,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("creem.io") || url.includes("/v1/checkouts")) {
      return new Response(JSON.stringify({ checkout_url: "https://checkout.creem.io/pay", id: "ch_1" }), { status: 200 });
    }
    if (url.includes("/v1/dashboard/billing/subscription")) {
      return new Response(JSON.stringify({ hard_limit_usd: 20, has_payment_method: true }), { status: 200 });
    }
    if (url.includes("/v1/dashboard/billing/usage")) {
      return new Response(JSON.stringify({ total_usage: 100 }), { status: 200 });
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  try {
    const creemPay = await json(
      new Request("http://local/api/user/creem/pay", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ product_id: "prod_1", payment_method: "creem" }),
      }),
      e,
    );
    assert.equal(creemPay.body.message, "success");
    const creemData = creemPay.body.data as { checkout_url: string; order_id: string };
    assert.equal(creemData.checkout_url, "https://checkout.creem.io/pay");
    assert.equal(typeof creemData.order_id, "string");

    await json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key: "WaffoEnabled", value: "true" }),
      }),
      e,
    );
    await json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key: "WaffoApiKey", value: "wk_test" }),
      }),
      e,
    );
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.includes("waffo")) {
        return new Response(JSON.stringify({ payment_url: "https://pay.waffo.com/x", orderAction: "https://pay.waffo.com/x" }), { status: 200 });
      }
      if (url.includes("/v1/dashboard/billing/subscription")) {
        return new Response(JSON.stringify({ hard_limit_usd: 20, has_payment_method: true }), { status: 200 });
      }
      if (url.includes("/v1/dashboard/billing/usage")) {
        return new Response(JSON.stringify({ total_usage: 100 }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const waffoPay = await json(
      new Request("http://local/api/user/waffo/pay", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ amount: 10 }),
      }),
      e,
    );
    assert.equal(waffoPay.body.message, "success");
    const waffoData = waffoPay.body.data as { payment_url: string; order_id: string };
    assert.equal(waffoData.payment_url, "https://pay.waffo.com/x");
    assert.equal(typeof waffoData.order_id, "string");

    const chCreated = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "bal-openai", type: 1, key: "sk-balance", models: "gpt-4o", group: "default", base_url: "https://api.openai.com" }),
      }),
      e,
    );
    const chId = Number((chCreated.body.data as { id?: number })?.id || 0);
    assert.ok(chId);
    const oneBal = await json(new Request("http://local/api/channel/update_balance/" + chId, { headers: auth }), e);
    assert.equal(oneBal.body.success, true);
    assert.equal(oneBal.body.balance, 19);
    assert.equal(oneBal.body.data, undefined);

    const fix = await json(new Request("http://local/api/channel/fix", { method: "POST", headers: auth }), e);
    assert.equal(fix.body.success, true);
    const fixData = fix.body.data as { success: number; fails: number };
    assert.equal(typeof fixData.success, "number");
    assert.equal(fixData.fails, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "reset-plan", grant_quota: 1000, duration_days: 30, price_quota: 0 }),
    }),
    e,
  );
  const planId = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(planId);
  await json(
    new Request(`http://local/api/subscription/admin/users/1/subscriptions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  const reset = await json(
    new Request(`http://local/api/subscription/admin/plans/${planId}/subscriptions/reset`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ advance_reset_time: false }),
    }),
    e,
  );
  assert.equal(reset.body.success, true);
  const rd = reset.body.data as { plan_id: number; matched_count: number; reset_count: number; user_count: number; advance_reset_time: boolean };
  assert.equal(rd.plan_id, planId);
  assert.equal(typeof rd.matched_count, "number");
  assert.equal(typeof rd.reset_count, "number");
  assert.equal(typeof rd.user_count, "number");
  assert.equal(rd.advance_reset_time, false);
});

