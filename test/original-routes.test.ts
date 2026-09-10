import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { runChannelTestTask, selectChannelsForAutomaticTest } from "../src/channel-test.js";
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

function pluginSource(key: string, name = key) {
  return `const meta = { apiVersion: 1, key: "${key}", name: "${name}", version: "1.0.0", author: { name: "test" }, models: ["${key}"], fetchMode: "per_task", routes: [], protocols: [], allowedHosts: [], auth: { type: "none" } };`;
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
  { method: "GET", path: "/api/log/token" },
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
  { method: "GET", path: "/api/channel/test" },
  { method: "GET", path: "/v1/videos/task_missing" },
  { method: "GET", path: "/api/subscription/epay/return" },
  { method: "GET", path: "/api/oauth/github" },
  { method: "GET", path: "/v1/responses/resp_missing" },
  { method: "POST", path: "/api/waffo-pancake/webhook/test" },
  { method: "POST", path: "/api/waffo/webhook" },
  { method: "GET", path: "/api/channel/ollama/version/1" },
  { method: "POST", path: "/api/channel/upstream_updates/detect" },
  { method: "POST", path: "/api/channel/upstream_updates/detect_all" },
  { method: "POST", path: "/api/channel/upstream_updates/apply" },
  { method: "POST", path: "/api/channel/upstream_updates/apply_all" },
  { method: "POST", path: "/api/models/delete" },
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
  assert.equal(st.checkin_enabled, false);
  assert.equal(st.passkey_login, false);
  assert.equal(st.uptime_kuma_enabled, true);
  assert.equal(st.docs_link, "https://docs.newapi.pro");

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
  const hardware = await json(new Request("http://local/api/deployments/hardware-types", { headers: auth }), e);
  assert.equal(hardware.body.success, false);
  assert.match(String(hardware.body.message), /io\.net model deployment is not enabled/);

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
  for (const k of [
    "disk_cache_threshold_mb",
    "disk_cache_max_size_mb",
    "disk_cache_path",
    "is_running_in_container",
    "monitor_enabled",
    "monitor_cpu_threshold",
    "monitor_memory_threshold",
    "monitor_disk_threshold",
  ]) {
    assert.ok(k in cfg, "missing performance config " + k);
  }

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
  const usageNoAuth = await json(new Request("http://local/api/usage/token"), e);
  assert.equal(usageNoAuth.res.status, 401);
  assert.equal(usageNoAuth.body.success, false);
  assert.equal(usageNoAuth.body.message, "Token not provided");
  const usageBad = await json(new Request("http://local/api/usage/token", { headers: { authorization: "Token x" } }), e);
  assert.equal(usageBad.res.status, 401);
  assert.equal(usageBad.body.message, "Invalid token");
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

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "passkey.enabled", value: "true" }),
    }),
    e,
  );
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
      body: JSON.stringify({ id: adminRow!.id, username: "admin1", admin_permissions: { channel: { read: false } } }),
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
      body: JSON.stringify({ source: pluginSource("suno", "Suno"), remark: "suno" }),
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
  assert.equal(suno?.channel_count, 0);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "suno-plugin-ch",
        type: 61,
        key: "plugin-key",
        models: "suno",
        group: "default",
        setting: { task_plugin_key: "suno" },
      }),
    }),
    e,
  );
  const pluginListBound = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const sunoBound = (pluginListBound.body.data as { meta: { key: string }; channel_count: number; in_flight_count: number }[]).find(
    (p) => p.meta.key === "suno",
  );
  assert.equal(sunoBound?.channel_count, 1);
  assert.equal(typeof sunoBound?.in_flight_count, "number");

  const stripePay = await json(
    new Request("http://local/api/user/stripe/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10, payment_method: "stripe" }),
    }),
    e,
  );
  assert.equal(stripePay.body.success, false);
  assert.equal(stripePay.body.message, "error");
  assert.equal(stripePay.body.data, "拉起支付失败");

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
    await json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key: "WaffoPrivateKey", value: "wk_private" }),
      }),
      e,
    );
    await json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key: "WaffoPublicCert", value: "wk_cert" }),
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
    assert.ok(fixData.success >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const compliance = await json(
    new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(compliance.body.success, true, String(compliance.body.message));
  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: { title: "reset-plan", total_amount: 1000, duration_unit: "day", duration_value: 30, price_amount: 0 },
      }),
    }),
    e,
  );
  const planId = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(planId, String(plan.body.message));
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

test("original subscription self/plans wrapping, token mask, plugin get, tag models, encryption-key", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const enc = await json(new Request("http://local/api/user/login/encryption-key"), e);
  assert.equal(enc.body.success, true);
  assert.equal((enc.body.data as { enabled: boolean }).enabled, false);

  const plansLocked = await json(new Request("http://local/api/subscription/plans", { headers: auth }), e);
  assert.equal(plansLocked.body.success, true);
  assert.deepEqual(plansLocked.body.data, []);

  const selfBefore = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const selfData = selfBefore.body.data as {
    billing_preference: string;
    subscriptions: unknown[];
    all_subscriptions: unknown[];
  };
  assert.equal(selfData.billing_preference, "subscription_first");
  assert.ok(Array.isArray(selfData.subscriptions));
  const pref = await json(
    new Request("http://local/api/subscription/self/preference", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ billing_preference: "wallet_first" }),
    }),
    e,
  );
  assert.equal(pref.body.success, true);
  assert.equal((pref.body.data as { billing_preference: string }).billing_preference, "wallet_first");
  const selfAfterPref = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  assert.equal((selfAfterPref.body.data as { billing_preference: string }).billing_preference, "wallet_first");
  assert.ok(Array.isArray(selfData.all_subscriptions));

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const created = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: {
          title: "pro",
          subtitle: "monthly",
          price_amount: 9.9,
          duration_unit: "month",
          duration_value: 1,
          total_amount: 500000,
          quota_reset_period: "monthly",
        },
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const planObj = created.body.data as Record<string, unknown>;
  assert.equal(planObj.title, "pro");
  assert.equal(planObj.price_amount, 9.9);
  assert.equal(planObj.duration_unit, "month");
  assert.equal(planObj.enabled, true);
  assert.equal(typeof planObj.allow_balance_pay, "boolean");
  assert.equal(typeof planObj.total_amount, "number");

  const listed = await json(new Request("http://local/api/subscription/admin/plans", { headers: auth }), e);
  const listedPlans = listed.body.data as { plan: Record<string, unknown> }[];
  assert.equal(listedPlans[0].plan.title, "pro");
  assert.equal(listedPlans[0].plan.currency, "USD");

  const publicPlans = await json(new Request("http://local/api/subscription/plans", { headers: auth }), e);
  assert.equal((publicPlans.body.data as { plan: { title: string } }[])[0].plan.title, "pro");

  const bind = await json(
    new Request("http://local/api/subscription/admin/users/1/subscriptions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planObj.id }),
    }),
    e,
  );
  assert.equal(bind.body.success, true, String(bind.body.message));
  const selfAfter = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const after = selfAfter.body.data as {
    subscriptions: { subscription: Record<string, unknown> }[];
    all_subscriptions: { subscription: Record<string, unknown> }[];
  };
  assert.ok(after.all_subscriptions.length);
  const sub = after.all_subscriptions[0].subscription;
  assert.equal(typeof sub.id, "number");
  assert.equal(sub.status, "active");
  assert.equal(typeof sub.start_time, "number");
  assert.equal(typeof sub.end_time, "number");
  assert.equal(typeof sub.amount_total, "number");
  assert.equal(typeof sub.amount_used, "number");
  assert.ok(after.subscriptions.length);

  const createdTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "batch-key", remain_quota: 1 }),
    }),
    e,
  );
  const tokId = Number((createdTok.body.data as { id?: number })?.id || 0);
  assert.ok(tokId);
  const tokens = await json(new Request("http://local/api/token/", { headers: auth }), e);
  const tokenItems = (tokens.body.data as { items: { key: string }[] }).items;
  assert.ok(tokenItems.length);
  assert.equal(tokenItems[0].key.startsWith("sk-"), false);
  assert.match(tokenItems[0].key, /^\w{2,4}\*+\w{2,4}$/);

  const revealed = await json(new Request("http://local/api/token/" + tokId + "/key", { method: "POST", headers: auth }), e);
  const rawKey = (revealed.body.data as { key: string }).key;
  assert.equal(rawKey.startsWith("sk-"), false);
  const batchKeys = await json(
    new Request("http://local/api/token/batch/keys", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [tokId] }),
    }),
    e,
  );
  assert.equal((batchKeys.body.data as { keys: Record<string, string> }).keys[String(tokId)], rawKey);

  const pluginUp = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: pluginSource("demo", "Demo"),
        icon: "data:image/png;base64,aaaa",
      }),
    }),
    e,
  );
  assert.equal(pluginUp.body.success, true, String(pluginUp.body.message));
  const plugin = await json(new Request("http://local/api/plugin/task/demo", { headers: auth }), e);
  const detail = plugin.body.data as { meta: { key: string }; source: string; layer: string; has_icon: boolean };
  assert.equal(plugin.body.success, true, String(plugin.body.message));
  assert.equal(detail.meta.key, "demo");
  assert.equal(detail.layer, "override");
  assert.equal(typeof detail.source, "string");
  assert.equal(typeof detail.has_icon, "boolean");
  const missingIcon = await json(new Request("http://local/api/plugin/task/missing/icon", { headers: auth }), e);
  assert.equal(missingIcon.res.status, 404);

  const noTag = await json(new Request("http://local/api/channel/tag/models", { headers: auth }), e);
  assert.equal(noTag.res.status, 400);
  assert.equal(noTag.body.message, "tag不能为空");

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "tagged", type: 1, key: "sk-t", models: "gpt-4o,gpt-4o-mini", group: "default", tag: "prod" }),
    }),
    e,
  );
  const tagModels = await json(new Request("http://local/api/channel/tag/models?tag=prod", { headers: auth }), e);
  assert.equal(tagModels.body.success, true);
  assert.equal(typeof tagModels.body.data, "string");
  assert.match(String(tagModels.body.data), /gpt-4o/);

  const batchTag = await json(
    new Request("http://local/api/channel/batch/tag", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [1], tag: "prod" }),
    }),
    e,
  );
  assert.equal(typeof batchTag.body.data, "number");

  const missingUserReset = await json(
    new Request("http://local/api/subscription/admin/users/999/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planObj.id, advance_reset_time: true }),
    }),
    e,
  );
  assert.equal(missingUserReset.body.success, false);
  assert.equal(missingUserReset.body.message, "该用户没有有效的此套餐订阅");
});

test("original TopUp, GetAllUsers, SearchUsers, settings, data/flow, performance JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const setup = await json(new Request("http://local/api/setup"), e);
  const setupData = setup.body.data as { status: boolean; root_init: boolean; database_type: string };
  assert.equal(setupData.status, true);
  assert.equal(setupData.root_init, false);
  assert.equal(setupData.database_type, "");

  const deniedTopup = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: "missing" }),
    }),
    e,
  );
  assert.equal(deniedTopup.body.success, false);
  assert.equal(deniedTopup.body.message, "支付、兑换码、订阅计划和邀请返利功能已禁用。管理员需先确认合规声明后方可启用。");

  const deniedRedemption = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 100, count: 1 }),
    }),
    e,
  );
  assert.equal(deniedRedemption.body.success, false);
  assert.equal(deniedRedemption.body.message, deniedTopup.body.message);

  const deniedAff = await json(
    new Request("http://local/api/user/aff_transfer", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ quota: 500000 }),
    }),
    e,
  );
  assert.equal(deniedAff.body.success, false);
  assert.equal(deniedAff.body.message, deniedTopup.body.message);

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);

  const badRedeem = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: "nope" }),
    }),
    e,
  );
  assert.equal(badRedeem.body.success, false);
  assert.equal(badRedeem.body.message, "兑换失败，请稍后重试");

  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 4321, count: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.equal(created.body.message, "");
  assert.ok(Array.isArray(created.body.data));
  const code = (created.body.data as string[])[0];
  const redeemed = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: code }),
    }),
    e,
  );
  assert.equal(redeemed.body.success, true);
  assert.equal(redeemed.body.data, 4321);
  assert.equal(redeemed.body.message, "");

  const users = await json(new Request("http://local/api/user/?p=1&page_size=20&sort_by=id&sort_order=asc", { headers: auth }), e);
  const page = users.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(page.page, 1);
  assert.equal(typeof page.total, "number");
  assert.equal(typeof page.page_size, "number");
  for (const k of ["id", "username", "created_at", "last_login_at", "remark", "setting", "aff_code", "quota", "github_id", "linux_do_id", "wechat_id", "stripe_customer"]) {
    assert.ok(k in page.items[0], "missing GetAllUsers field " + k);
  }

  const createUser = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "vipuser", password: "password12" }),
    }),
    e,
  );
  assert.equal(createUser.body.success, true, String(createUser.body.message));
  assert.equal(createUser.body.message, "");
  assert.equal(createUser.body.data, null);
  const createdUser = await json(new Request("http://local/api/user/search?keyword=vipuser", { headers: auth }), e);
  const vip = ((createdUser.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "vipuser");
  assert.ok(vip);
  const putGroup = await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: vip.id, username: "vipuser", group: "vip" }),
    }),
    e,
  );
  assert.equal(putGroup.body.success, true, String(putGroup.body.message));
  const searched = await json(new Request("http://local/api/user/search?keyword=vipuser&group=vip&role=1", { headers: auth }), e);
  const found = ((searched.body.data as { items: { username: string; group: string }[] }).items || []).find((u) => u.username === "vipuser");
  assert.ok(found);
  assert.equal(found.group, "vip");

  const groups = await json(new Request("http://local/api/user/groups", { headers: auth }), e);
  const groupMap = groups.body.data as Record<string, { ratio: number | string; desc: string }>;
  assert.equal(typeof groupMap.default.ratio, "number");
  assert.equal(typeof groupMap.default.desc, "string");

  const badSetting = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "sms", quota_warning_threshold: 1 }),
    }),
    e,
  );
  assert.equal(badSetting.body.message, "无效的预警类型");
  const okSetting = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "email", quota_warning_threshold: 1000, record_ip_log: true }),
    }),
    e,
  );
  assert.equal(okSetting.body.success, true);
  assert.equal(okSetting.body.message, "设置已更新");

  const flowMissing = await json(new Request("http://local/api/data/flow", { headers: auth }), e);
  assert.equal(flowMissing.body.message, "invalid start_timestamp");
  const flowRange = await json(
    new Request("http://local/api/data/flow?start_timestamp=100&end_timestamp=50", { headers: auth }),
    e,
  );
  assert.equal(flowRange.body.message, "invalid time range");
  const selfSpan = await json(
    new Request("http://local/api/data/self?start_timestamp=1&end_timestamp=3000000", { headers: auth }),
    e,
  );
  assert.equal(selfSpan.body.message, "时间跨度不能超过 1 个月");
  const selfOk = await json(new Request("http://local/api/data/self?start_timestamp=1&end_timestamp=10", { headers: auth }), e);
  assert.ok(Array.isArray(selfOk.body.data));

  const perf = await json(new Request("http://local/api/performance/stats", { headers: auth }), e);
  const pd = perf.body.data as Record<string, unknown>;
  for (const k of ["cache_stats", "memory_stats", "disk_cache_info", "disk_space_info", "config"]) {
    assert.ok(k in pd, "missing performance field " + k);
  }
  const cache = pd.cache_stats as Record<string, unknown>;
  for (const k of [
    "active_disk_files",
    "current_disk_usage_bytes",
    "active_memory_buffers",
    "current_memory_usage_bytes",
    "disk_cache_hits",
    "memory_cache_hits",
    "disk_cache_max_bytes",
    "disk_cache_threshold_bytes",
  ]) {
    assert.ok(k in cache, "missing cache_stats " + k);
  }
  const mem = pd.memory_stats as Record<string, unknown>;
  for (const k of ["alloc", "total_alloc", "sys", "num_gc", "num_goroutine"]) {
    assert.ok(k in mem, "missing memory_stats " + k);
  }
  const diskInfo = pd.disk_cache_info as Record<string, unknown>;
  for (const k of ["path", "exists", "file_count", "total_size"]) {
    assert.ok(k in diskInfo, "missing disk_cache_info " + k);
  }
  const spaceInfo = pd.disk_space_info as Record<string, unknown>;
  for (const k of ["total", "free", "used", "used_percent"]) {
    assert.ok(k in spaceInfo, "missing disk_space_info " + k);
  }
  const cfg = pd.config as Record<string, unknown>;
  for (const k of [
    "disk_cache_enabled",
    "disk_cache_threshold_mb",
    "disk_cache_max_size_mb",
    "disk_cache_path",
    "is_running_in_container",
    "monitor_enabled",
    "monitor_cpu_threshold",
    "monitor_memory_threshold",
    "monitor_disk_threshold",
  ]) {
    assert.ok(k in cfg, "missing performance config " + k);
  }
  const logs = await json(new Request("http://local/api/performance/logs", { headers: auth }), e);
  const lf = logs.body.data as Record<string, unknown>;
  assert.equal(lf.enabled, false);
  assert.equal(typeof lf.file_count, "number");
  assert.equal(lf.files, null);

  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ability", type: 1, key: "sk-x", models: "gpt-4o-mini", group: "default" }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const userModels = await json(new Request("http://local/api/user/models", { headers: auth }), e);
  assert.ok((userModels.body.data as string[]).includes("gpt-4o-mini"));
  const fix = await json(new Request("http://local/api/channel/fix", { method: "POST", headers: auth }), e);
  assert.equal((fix.body.data as { success: number; fails: number }).fails, 0);
  assert.ok((fix.body.data as { success: number }).success >= 1);

  const webhook = await json(new Request("http://local/api/stripe/webhook", { method: "POST", body: "{}" }), e);
  assert.equal(webhook.res.status, 403);
  const creemHook = await json(new Request("http://local/api/creem/webhook", { method: "POST", body: "{}" }), e);
  assert.equal(creemHook.res.status, 403);

  const wechatOff = await json(new Request("http://local/api/oauth/wechat?code=abc"), e);
  assert.equal(wechatOff.body.success, false);
  assert.equal(wechatOff.body.message, "管理员未开启通过微信登录以及注册");

  const topups = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
  const topPage = topups.body.data as { items: Record<string, unknown>[] };
  assert.ok(topPage.items.length >= 1);
  for (const k of ["id", "user_id", "amount", "money", "trade_no", "payment_method", "payment_provider", "create_time", "complete_time", "status"]) {
    assert.ok(k in topPage.items[0], "missing GetUserTopUps field " + k);
  }

  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  const sd = self.body.data as Record<string, unknown>;
  for (const k of ["has_password", "sidebar_modules", "permissions", "setting", "linux_do_id", "aff_history_quota"]) {
    assert.ok(k in sd, "missing GetSelf field " + k);
  }
  assert.equal(typeof (sd.permissions as { admin_permissions?: unknown }).admin_permissions, "object");

  const stTest = await json(new Request("http://local/api/status/test", { headers: auth }), e);
  assert.equal(stTest.body.success, true);
  assert.equal(stTest.body.message, "Server is running");
  assert.equal(typeof (stTest.body.http_stats as { active_connections: number }).active_connections, "number");

  const higher = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "root2", password: "password12", role: 100 }),
    }),
    e,
  );
  assert.equal(higher.body.message, "无法创建权限大于等于自己的用户");
});

test("original JSON fields: RelayNotImplemented, 2FA stats, groups, manage, plugins, vendors, system-task", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth: bootAuth } = await boot(e);
  let auth = bootAuth;

  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "relay", remain_quota: 1000, unlimited_quota: true }),
    }),
    e,
  );
  const sk = String((tok.body.data as { key?: string })?.key || "");
  const unimplemented = await json(
    new Request("http://local/v1/files", { headers: { authorization: "Bearer " + sk } }),
    e,
  );
  assert.equal(unimplemented.res.status, 501);
  const err = unimplemented.body.error as Record<string, unknown>;
  assert.equal(err.message, "API not implemented");
  assert.equal(err.type, "new_api_error");
  assert.equal(err.param, "");
  assert.equal(err.code, "api_not_implemented");
  const variations = await json(
    new Request("http://local/v1/images/variations", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: "{}",
    }),
    e,
  );
  assert.equal(variations.res.status, 501);
  assert.equal((variations.body.error as { code: string }).code, "api_not_implemented");

  const stats = await json(new Request("http://local/api/user/2fa/stats", { headers: auth }), e);
  const st = stats.body.data as Record<string, unknown>;
  assert.equal(typeof st.total_users, "number");
  assert.equal(typeof st.enabled_users, "number");
  assert.equal(typeof st.enabled_rate, "string");
  assert.match(String(st.enabled_rate), /^\d+\.\d%$/);

  const groups = await json(new Request("http://local/api/group/", { headers: auth }), e);
  const names = groups.body.data as string[];
  assert.ok(names.includes("default"));
  assert.ok(names.includes("vip"));
  assert.ok(names.includes("svip"));

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "member1", password: "password12", role: 1 }),
    }),
    e,
  );
  const users = await json(new Request("http://local/api/user/", { headers: auth }), e);
  const member = (users.body.data as { items: { id: number; username: string }[] }).items.find((u) => u.username === "member1");
  assert.ok(member);
  const promoted = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: member!.id, action: "promote" }),
    }),
    e,
  );
  assert.equal(promoted.body.success, true, String(promoted.body.message));
  assert.equal(promoted.body.message, "");
  const md = promoted.body.data as { role: number; status: number };
  assert.equal(md.role, 10);
  assert.equal(typeof md.status, "number");
  const already = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: member!.id, action: "promote" }),
    }),
    e,
  );
  assert.equal(already.body.message, "该用户已经是管理员");

  const pwProof = await passwordProof(e, auth, "account.password.change");
  const pw = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "x-security-proof": pwProof.proof_token },
      body: JSON.stringify({ password: "password12", original_password: "password12" }),
    }),
    e,
  );
  assert.equal(pw.body.success, true, String(pw.body.message));
  assert.equal((pw.body.data as { has_password: boolean }).has_password, true);
  assert.equal(typeof (pw.body.data as { notification_warning: boolean }).notification_warning, "boolean");
  const nextToken = String((pw.body.data as { access_token?: string }).access_token || "");
  assert.ok(nextToken);
  auth = { authorization: "Bearer " + nextToken, "content-type": "application/json" };

  const vendor = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "OpenAI", icon: "OpenAI" }),
    }),
    e,
  );
  assert.equal(vendor.body.success, true, String(vendor.body.message));
  const vd = vendor.body.data as Record<string, unknown>;
  assert.equal(vd.name, "OpenAI");
  assert.equal(typeof vd.created_time, "number");
  assert.equal(typeof vd.status, "number");
  const vendorList = await json(new Request("http://local/api/vendors/", { headers: auth }), e);
  const page = vendorList.body.data as { items: unknown[]; total: number; page: number; page_size: number };
  assert.ok(Array.isArray(page.items));
  assert.equal(typeof page.total, "number");
  assert.equal(typeof page.page, "number");
  assert.equal(typeof page.page_size, "number");

  const preview = await json(
    new Request("http://local/api/vendors/operations/preview", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "delete", vendor_ids: [vd.id] }),
    }),
    e,
  );
  assert.equal(preview.body.success, true, String(preview.body.message));
  const pv = preview.body.data as { action: string; sources: unknown[]; models: unknown[]; version: string; target: unknown };
  assert.equal(pv.action, "delete");
  assert.ok(Array.isArray(pv.sources));
  assert.ok(Array.isArray(pv.models));
  assert.equal(typeof pv.version, "string");
  const applied = await json(
    new Request("http://local/api/vendors/operations", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "delete", vendor_ids: [vd.id], expected_version: pv.version }),
    }),
    e,
  );
  assert.equal(applied.body.success, true, String(applied.body.message));
  assert.ok(Array.isArray((applied.body.data as { updated_models: number[] }).updated_models));
  assert.ok(Array.isArray((applied.body.data as { deleted_vendors: number[] }).deleted_vendors));

  const pluginUp = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: pluginSource("kling", "Kling") }),
    }),
    e,
  );
  assert.equal(pluginUp.body.success, true, String(pluginUp.body.message));
  const uploaded = pluginUp.body.data as { plugin: Record<string, unknown>; meta: { key: string; apiVersion: number }; layer: string; has_icon: boolean };
  assert.equal(uploaded.layer, "override");
  assert.equal(uploaded.meta.key, "kling");
  assert.equal(typeof uploaded.meta.apiVersion, "number");
  assert.equal(typeof uploaded.has_icon, "boolean");
  const versions = await json(new Request("http://local/api/plugin/task/kling/versions", { headers: auth }), e);
  const ver = (versions.body.data as Record<string, unknown>[])[0];
  for (const k of ["id", "key", "api_version", "version", "source", "source_hash", "enabled", "active", "created_at", "remark"]) {
    assert.ok(k in ver, "missing TaskPluginRecord " + k);
  }
  assert.equal("icon" in ver, false);
  const activate = await json(
    new Request("http://local/api/plugin/task/kling/activate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ version: "1.0.0" }),
    }),
    e,
  );
  assert.equal(activate.body.success, true, String(activate.body.message));
  const statusOff = await json(
    new Request("http://local/api/plugin/task/kling/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    }),
    e,
  );
  assert.equal(statusOff.body.success, true, String(statusOff.body.message));
  const sd = statusOff.body.data as { plugin_enabled: boolean; disabled_channels: number };
  assert.equal(sd.plugin_enabled, false);
  assert.equal(typeof sd.disabled_channels, "number");
  const dryMissing = await json(
    new Request("http://local/api/plugin/task/kling/dryrun", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  assert.equal(dryMissing.body.success, false);
  assert.match(String(dryMissing.body.message), /Hook/);

  const cleanupMissing = await json(new Request("http://local/api/system-task/log-cleanup", { method: "POST", headers: auth }), e);
  assert.equal(cleanupMissing.body.message, "target timestamp is required");
  const cleanup = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=1", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(cleanup.body.success, true, String(cleanup.body.message));
  const task = cleanup.body.data as Record<string, unknown>;
  assert.equal(typeof task.id, "number");
  assert.equal(typeof task.task_id, "string");
  assert.equal(task.type, "log_cleanup");
  assert.equal(task.status, "succeeded");
  assert.equal(typeof task.payload, "object");
  assert.equal(typeof (task.payload as { target_timestamp: number }).target_timestamp, "number");
  const currentMissing = await json(new Request("http://local/api/system-task/current", { headers: auth }), e);
  assert.equal(currentMissing.body.message, "type is required");
  const current = await json(new Request("http://local/api/system-task/current?type=log_cleanup", { headers: auth }), e);
  assert.equal(current.body.success, true);
});

test("original JSON fields: perf-metrics, rankings, quota data, model sync", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const missingModel = await json(new Request("http://local/api/perf-metrics"), e);
  assert.equal(missingModel.res.status, 400);
  assert.equal(missingModel.body.message, "model is required");

  await e.DB.prepare(
    `INSERT INTO perf_metrics (model_name, "group", bucket_ts, request_count, success_count, total_latency_ms, ttft_sum_ms, ttft_count, output_tokens, generation_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("gpt-4o-mini", "default", Math.floor(Date.now() / 1000) - 60, 4, 3, 800, 120, 3, 40, 1000)
    .run();

  const metrics = await json(new Request("http://local/api/perf-metrics?model=gpt-4o-mini"), e);
  assert.equal(metrics.body.success, true, String(metrics.body.message));
  const md = metrics.body.data as { model_name: string; series_schema: string; groups: Record<string, unknown>[] };
  assert.equal(md.model_name, "gpt-4o-mini");
  assert.equal(md.series_schema, "dbcd0a3c01b55203");
  assert.ok(Array.isArray(md.groups));
  if (md.groups.length) {
    const g0 = md.groups[0];
    for (const k of ["group", "avg_ttft_ms", "avg_latency_ms", "success_rate", "avg_tps", "series"]) {
      assert.ok(k in g0, "missing GroupResult " + k);
    }
    const series = g0.series as Record<string, unknown>[];
    if (series.length) {
      for (const k of ["ts", "avg_ttft_ms", "avg_latency_ms", "success_rate", "avg_tps"]) {
        assert.ok(k in series[0], "missing BucketPoint " + k);
      }
    }
  }

  const summary = await json(new Request("http://local/api/perf-metrics/summary"), e);
  assert.equal(summary.body.success, true);
  const sm = summary.body.data as { models: Record<string, unknown>[] };
  assert.ok(Array.isArray(sm.models));
  if (sm.models.length) {
    for (const k of ["model_name", "avg_latency_ms", "success_rate", "avg_tps"]) {
      assert.ok(k in sm.models[0], "missing ModelSummary " + k);
    }
  }

  const ranks = await json(new Request("http://local/api/rankings"), e);
  const rd = ranks.body.data as Record<string, unknown>;
  for (const k of ["models", "vendors", "top_movers", "top_droppers", "models_history", "vendor_share_history"]) {
    assert.ok(k in rd, "missing RankingsResponse " + k);
  }
  const hist = rd.models_history as { points: unknown[]; models: unknown[]; buckets: number };
  assert.ok(Array.isArray(hist.points));
  assert.ok(Array.isArray(hist.models));
  assert.equal(typeof hist.buckets, "number");
  const vhist = rd.vendor_share_history as { points: unknown[]; vendors: unknown[]; buckets: number };
  assert.equal(typeof vhist.buckets, "number");
  const badPeriod = await json(new Request("http://local/api/rankings?period=decade"), e);
  assert.equal(badPeriod.res.status, 400);
  assert.match(String(badPeriod.body.message), /invalid ranking period/);

  const data = await json(new Request("http://local/api/data/?start_timestamp=1&end_timestamp=10", { headers: auth }), e);
  assert.ok(Array.isArray(data.body.data));
  if ((data.body.data as unknown[]).length) {
    const row = (data.body.data as Record<string, unknown>[])[0];
    for (const k of ["id", "user_id", "username", "model_name", "created_at", "use_group", "token_id", "channel_id", "node_name", "token_used", "count", "quota"]) {
      assert.ok(k in row, "missing QuotaData " + k);
    }
  } else {
    await e.DB.prepare(
      "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (1, 'root', 'gpt-4o-mini', 100, 10, 20, 1, 'default', 1, 1, 'workerd')",
    ).run();
    const data2 = await json(new Request("http://local/api/data/?start_timestamp=1&end_timestamp=200", { headers: auth }), e);
    const row = (data2.body.data as Record<string, unknown>[])[0];
    for (const k of ["id", "user_id", "username", "model_name", "created_at", "use_group", "token_id", "channel_id", "node_name", "token_used", "count", "quota"]) {
      assert.ok(k in row, "missing QuotaData " + k);
    }
  }

  const applyEmpty = await json(
    new Request("http://local/api/models/sync_upstream", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  assert.equal(applyEmpty.res.status, 400);
  assert.equal(applyEmpty.body.message, "Preview and select metadata changes before applying");

  const preview = await json(new Request("http://local/api/models/sync_upstream/preview?locale=zh", { headers: auth }), e);
  if (preview.body.success) {
    const pv = preview.body.data as { source: Record<string, unknown>; candidates: unknown[] };
    for (const k of ["locale", "models_url", "vendors_url", "version"]) {
      assert.ok(k in pv.source, "missing metadataSyncSource " + k);
    }
    assert.ok(Array.isArray(pv.candidates));
  } else {
    assert.equal(typeof preview.body.message, "string");
  }

  const runtime = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  const rtd = runtime.body.data as { last_rebuild: Record<string, unknown>; plugin_errors: unknown };
  assert.equal(rtd.last_rebuild.status, "never");
  assert.equal(typeof rtd.last_rebuild.attempted_at, "string");
  assert.equal(typeof rtd.last_rebuild.generation, "number");
  assert.equal(typeof rtd.last_rebuild.plugin_error_count, "number");
  assert.equal("error" in rtd.last_rebuild, false);
  assert.equal(typeof rtd.plugin_errors, "object");

  const uptime = await json(new Request("http://local/api/uptime/status"), e);
  assert.equal(uptime.body.success, true);
  assert.ok(Array.isArray(uptime.body.data));
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        key: "console_setting.uptime_kuma_groups",
        value: JSON.stringify([{ categoryName: "Core", url: "", slug: "" }]),
      }),
    }),
    e,
  );
  const uptimeGroup = await json(new Request("http://local/api/uptime/status"), e);
  assert.equal(uptimeGroup.body.success, true);
  const ug = (uptimeGroup.body.data as { categoryName: string; monitors: unknown[] }[])[0];
  assert.equal(ug.categoryName, "Core");
  assert.deepEqual(ug.monitors, []);

  const now = Math.floor(Date.now() / 1000);
  await e.DB.prepare(
    "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (1, 'root', 'openai/gpt-4o', ?, 10, 100, 1, 'default', 1, 1, 'workerd')",
  ).bind(now - 3600).run();
  await e.DB.prepare(
    "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (1, 'root', 'openai/gpt-4o', ?, 5, 40, 1, 'default', 1, 1, 'workerd')",
  ).bind(now - 8 * 86400).run();
  await e.DB.prepare(
    "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (1, 'root', 'anthropic/claude', ?, 8, 80, 1, 'default', 1, 1, 'workerd')",
  ).bind(now - 9 * 86400).run();
  const ranked = await json(new Request("http://local/api/rankings?period=week"), e);
  const models = (ranked.body.data as { models: Record<string, unknown>[]; models_history: { points: unknown[]; buckets: number } }).models;
  assert.ok(models.length);
  assert.equal(typeof models[0].rank, "number");
  assert.equal(typeof models[0].share, "number");
  assert.equal(typeof models[0].growth_pct, "number");
  assert.ok("previous_rank" in models[0] || models[0].growth_pct === 100);
  const hist2 = (ranked.body.data as { models_history: { points: unknown[]; buckets: number } }).models_history;
  assert.ok(hist2.buckets >= 1);
  assert.ok(Array.isArray(hist2.points));
  if (hist2.points.length) {
    const p0 = hist2.points[0] as Record<string, unknown>;
    for (const k of ["ts", "label", "model", "vendor", "tokens"]) assert.ok(k in p0, "missing history point " + k);
  }

  const opts = await json(new Request("http://local/api/option/", { headers: auth }), e);
  const optionKeys = (opts.body.data as { key: string }[]).map((o) => o.key);
  for (const key of [
    "console_setting.uptime_kuma_groups",
    "passkey.enabled",
    "checkin_setting.enabled",
    "legal.user_agreement",
    "oidc.enabled",
    "channel_affinity_setting.enabled",
    "TaskPluginMarketplaceSources",
    "SMTPPort",
    "EpayId",
    "MinTopUp",
    "DisplayInCurrencyEnabled",
    "TaskPluginEnabled",
    "HeaderNavModules",
    "LogConsumeEnabled",
    "QuotaRemindThreshold",
  ]) {
    assert.ok(optionKeys.includes(key), "missing option " + key);
  }

  const market = await json(new Request("http://local/api/plugin/task/marketplace/sources", { headers: auth }), e);
  const sources = market.body.data as { name: string; index_url: string }[];
  assert.ok(sources.some((s) => s.name === "Official"));
  assert.ok(sources.some((s) => s.name === "GitHub"));

  const ops = await json(new Request("http://local/api/channel/ops", { headers: auth }), e);
  assert.equal((ops.body.data as { retry_times: number }).retry_times, 0);

  const affinity = await json(new Request("http://local/api/option/channel_affinity_cache", { headers: auth }), e);
  const aff = affinity.body.data as Record<string, unknown>;
  for (const k of ["enabled", "total", "unknown", "by_rule_name", "cache_capacity", "cache_algo"]) {
    assert.ok(k in aff, "missing affinity cache field " + k);
  }
  assert.equal(aff.cache_algo, "lru");
  assert.equal(typeof (aff.by_rule_name as Record<string, number>)["codex cli trace"], "number");
  const affClear = await json(new Request("http://local/api/option/channel_affinity_cache?all=true", { method: "DELETE", headers: auth }), e);
  assert.equal((affClear.body.data as { deleted: number }).deleted, 0);
  const affMissing = await json(new Request("http://local/api/option/channel_affinity_cache", { method: "DELETE", headers: auth }), e);
  assert.equal(affMissing.res.status, 400);
  assert.match(String(affMissing.body.message), /rule_name/);

  const usageCache = await json(
    new Request("http://local/api/log/channel_affinity_usage_cache?rule_name=codex%20cli%20trace&key_fp=abc", { headers: auth }),
    e,
  );
  const uc = usageCache.body.data as Record<string, unknown>;
  for (const k of ["rule_name", "using_group", "key_fp", "hit", "total", "prompt_tokens", "cached_tokens", "last_seen_at"]) {
    assert.ok(k in uc, "missing usage cache field " + k);
  }

  const pricing = await json(new Request("http://local/api/option/model_pricing", { headers: auth }), e);
  const snap = pricing.body.data as { entries: unknown[]; options: Record<string, string>; empty_version: string };
  assert.ok(Array.isArray(snap.entries));
  assert.equal(typeof snap.empty_version, "string");
  assert.equal(snap.empty_version.length, 64);
  for (const k of [
    "ModelRatio",
    "CompletionRatio",
    "ModelPrice",
    "CacheRatio",
    "CreateCacheRatio",
    "ImageRatio",
    "AudioRatio",
    "AudioCompletionRatio",
    "billing_setting.billing_mode",
    "billing_setting.billing_expr",
  ]) {
    assert.ok(k in snap.options, "missing pricing option " + k);
  }
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ "gpt-test": 1.5 }) }),
    }),
    e,
  );
  const priced = await json(new Request("http://local/api/option/model_pricing?model=gpt-test", { headers: auth }), e);
  const entry = (priced.body.data as { entries: { model_name: string; version: string; configured: Record<string, unknown>; effective: Record<string, unknown> }[] }).entries[0];
  assert.equal(entry.model_name, "gpt-test");
  assert.equal(entry.configured.ModelRatio, 1.5);
  const patch = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        changes: [{ model_name: "gpt-test", expected_version: entry.version, pricing: { ModelRatio: 2 } }],
      }),
    }),
    e,
  );
  assert.equal(patch.body.success, true);
  assert.deepEqual((patch.body.data as { updated_models: string[] }).updated_models, ["gpt-test"]);
  const stale = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        changes: [{ model_name: "gpt-test", expected_version: entry.version, pricing: { ModelRatio: 3 } }],
      }),
    }),
    e,
  );
  assert.equal(stale.res.status, 409);

  const resetRatio = await json(new Request("http://local/api/option/rest_model_ratio", { method: "POST", headers: auth }), e);
  assert.equal(resetRatio.body.message, "重置模型倍率成功");
  const afterReset = await json(new Request("http://local/api/option/", { headers: auth }), e);
  const ratioOpt = (afterReset.body.data as { key: string; value: string }[]).find((o) => o.key === "ModelRatio");
  assert.ok(ratioOpt, "ModelRatio option missing after reset");
  const restored = JSON.parse(ratioOpt!.value) as Record<string, number>;
  assert.equal(restored["gpt-4"], 15);
  assert.equal(restored["gpt-4o-mini"], 0.075);
  assert.equal("gpt-test" in restored, false);

  await e.DB.prepare(
    "INSERT INTO tasks (task_id, user_id, platform, action, status, progress, fail_reason, created_at, submit_time, finish_time, properties, data) VALUES (?, 1, 'suno', 'generate', 'SUCCESS', '100%', '', ?, ?, 0, '{}', '{}')",
  ).bind("task_json_1", Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run();
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "task-json", remain_quota: 1000, unlimited_quota: true }),
    }),
    e,
  );
  const sk = String((tok.body.data as { key?: string })?.key || "");
  const tokenId = Number((tok.body.data as { id?: number })?.id || 0);
  const fetched = await json(new Request("http://local/v1/tasks/task_json_1", { headers: { authorization: "Bearer " + sk } }), e);
  const tv = fetched.body as Record<string, unknown>;
  for (const k of ["task_id", "platform", "status", "progress", "fail_reason", "created_at", "finished_at"]) {
    assert.ok(k in tv, "missing GetTask field " + k);
  }
  assert.equal(tv.task_id, "task_json_1");
  assert.equal(tv.platform, "suno");
  const missingTask = await json(new Request("http://local/v1/tasks/missing", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(missingTask.res.status, 404);
  assert.equal((missingTask.body.error as { type: string }).type, "invalid_request_error");
  const arts = await json(new Request("http://local/v1/tasks/task_json_1/artifacts", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal((arts.body as { task_id: string }).task_id, "task_json_1");
  assert.ok(Array.isArray((arts.body as { artifacts: unknown[] }).artifacts));
  const dashArts = await json(new Request("http://local/api/task/task_json_1/artifacts", { headers: auth }), e);
  assert.equal((dashArts.body.data as { task_id: string }).task_id, "task_json_1");
  assert.ok(Array.isArray((dashArts.body.data as { artifacts: unknown[] }).artifacts));

  const taskList = await json(new Request("http://local/api/task", { headers: auth }), e);
  assert.equal(taskList.body.success, true, JSON.stringify(taskList.body));
  const taskPage = taskList.body.data as { items?: Record<string, unknown>[] } | undefined;
  assert.ok(taskPage && Array.isArray(taskPage.items) && taskPage.items.length, JSON.stringify(taskList.body));
  const t0 = taskPage.items![0];
  for (const k of ["id", "task_id", "platform", "user_id", "action", "status", "submit_time", "progress", "properties", "data"]) {
    assert.ok(k in t0, "missing TaskDto field " + k);
  }
  assert.equal(t0.action, "image_to_video");

  await e.DB.prepare(
    "INSERT INTO mj_tasks (action, user_id, mj_id, prompt, status, progress, channel_id, submit_time, code, description, state, video_url, video_urls, quota, buttons, properties) VALUES ('imagine', 1, 'mj-1', 'a cat', 'SUCCESS', '100%', 1, ?, 1, '', '', '', '', 0, '', '')",
  ).bind(Math.floor(Date.now() / 1000)).run();
  const mjList = await json(new Request("http://local/api/mj/", { headers: auth }), e);
  const m0 = (mjList.body.data as { items: Record<string, unknown>[] }).items[0];
  for (const k of ["id", "code", "user_id", "action", "mj_id", "prompt", "prompt_en", "image_url", "video_url", "status", "progress", "fail_reason", "channel_id", "quota", "buttons", "properties"]) {
    assert.ok(k in m0, "missing Midjourney field " + k);
  }

  await e.DB.prepare(
    `INSERT INTO request_logs (user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id, token_id, "group", ip, other)
     VALUES (1, ?, 2, 'ok', 'root', 'task-json', 'gpt-4', 1, 1, 1, 1, 0, 9, ?, 'default', '127.0.0.1', ?)`,
  )
    .bind(Math.floor(Date.now() / 1000), tokenId || 1, JSON.stringify({ admin_info: { channel_id: 9 }, root_info: { node: "x" } }))
    .run();
  const selfLogs = await json(new Request("http://local/api/log/self", { headers: auth }), e);
  const selfItems = (selfLogs.body.data as { items: { id: number; channel_name: string; other: string }[] }).items;
  assert.ok(selfItems.length);
  for (let i = 0; i < selfItems.length; i++) {
    assert.equal(selfItems[i].id, i + 1);
    assert.equal(selfItems[i].channel_name, "");
  }
  const other = JSON.parse(selfItems[0].other || "{}") as Record<string, unknown>;
  assert.equal("admin_info" in other, false);
  assert.equal("root_info" in other, false);
  const byKey = await json(new Request("http://local/api/log/token", { headers: { authorization: "Bearer " + sk } }), e);
  assert.ok(Array.isArray(byKey.body.data), JSON.stringify(byKey.body));
  const keyed = byKey.body.data as { id: number; channel_name: string; token_id: number }[];
  assert.ok(keyed.length);
  assert.equal(keyed[0].id, 1);
  assert.equal(keyed[0].channel_name, "");
  if (tokenId) assert.equal(keyed[0].token_id, tokenId);

  const logBySession = await json(new Request("http://local/api/log/token", { headers: auth }), e);
  assert.equal(logBySession.res.status, 401);
  assert.equal(logBySession.body.success, false);
  assert.equal(logBySession.body.message, "Invalid token");
  assert.equal("error" in logBySession.body, false);

  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "copy-src",
        type: 1,
        key: "sk-a\nsk-b",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://example.invalid",
        mode: "multi_to_single",
        multi_key_mode: "random",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const srcId = Number((created.body.data as { id: number }).id);
  const badCopy = await json(new Request("http://local/api/channel/copy/abc", { method: "POST", headers: auth }), e);
  assert.equal(badCopy.body.message, "invalid id");
  const missingCopy = await json(new Request("http://local/api/channel/copy/999999", { method: "POST", headers: auth }), e);
  assert.equal(missingCopy.body.message, "获取渠道信息失败，请稍后重试");
  const copied = await json(new Request("http://local/api/channel/copy/" + srcId, { method: "POST", headers: auth }), e);
  assert.equal(copied.body.success, true, String(copied.body.message));
  assert.equal(copied.body.message, "");
  const copyId = Number((copied.body.data as { id: number }).id);
  assert.ok(copyId > 0);
  const copyGet = await json(new Request("http://local/api/channel/" + copyId, { headers: auth }), e);
  const copyCh = copyGet.body.data as { name: string; used_quota: number; test_time: number; response_time: number; channel_info: { is_multi_key: boolean } };
  assert.equal(copyCh.name, "copy-src_复制");
  assert.equal(copyCh.used_quota, 0);
  assert.equal(copyCh.test_time, 0);
  assert.equal(copyCh.response_time, 0);
  assert.equal(copyCh.channel_info.is_multi_key, true);

  const status = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel_id: srcId, action: "get_key_status" }),
    }),
    e,
  );
  const st = status.body.data as {
    keys: { index: number; status: number; key_preview: string }[];
    total: number;
    page: number;
    page_size: number;
    total_pages: number;
    enabled_count: number;
    manual_disabled_count: number;
    auto_disabled_count: number;
  };
  assert.equal(status.body.success, true, String(status.body.message));
  assert.equal(st.total, 2);
  assert.equal(st.page, 1);
  assert.equal(st.page_size, 50);
  assert.equal(st.enabled_count, 2);
  assert.equal(st.keys[0].key_preview.length > 0, true);

  const disabled = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel_id: srcId, action: "disable_key", key_index: 0 }),
    }),
    e,
  );
  assert.equal(disabled.body.message, "密钥已禁用");

  const fetchBad = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: "{",
    }),
    e,
  );
  assert.equal(fetchBad.res.status, 400);
  assert.equal(fetchBad.body.message, "Invalid request");
});

test("original FetchUpstreamRatios, UpdateChannel, email, sessions, token batch, logs, prefill JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const emptyFetch = await json(
    new Request("http://local/api/ratio_sync/fetch", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  assert.equal(emptyFetch.res.status, 200);
  assert.equal(emptyFetch.body.success, false);
  assert.equal(emptyFetch.body.message, "无有效上游渠道");
  const badFetch = await json(
    new Request("http://local/api/ratio_sync/fetch", { method: "POST", headers: auth, body: "{" }),
    e,
  );
  assert.equal(badFetch.res.status, 400);
  assert.equal(badFetch.body.message, "请求参数格式错误");

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.resend.com")) return new Response("{}", { status: 200 });
    if (url.includes("/api/pricing")) {
      return new Response(
        JSON.stringify({ success: true, data: { model_ratio: { "gpt-sync": 2 }, completion_ratio: { "gpt-sync": 1 } } }),
        { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
      );
    }
    return origFetch(input as RequestInfo, undefined);
  };
  try {
    const fetched = await json(
      new Request("http://local/api/ratio_sync/fetch", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          upstreams: [{ id: 0, name: "upstream", base_url: "https://example.test", endpoint: "/api/pricing" }],
          timeout: 5,
        }),
      }),
      e,
    );
    assert.equal(fetched.body.success, true, String(fetched.body.message));
    const data = fetched.body.data as {
      differences: Record<string, Record<string, { current: unknown; upstreams: Record<string, unknown>; confidence: Record<string, boolean> }>>;
      prices: Record<string, { current: Record<string, unknown>; upstreams: Record<string, Record<string, unknown>> }>;
      test_results: { name: string; status: string; error?: string }[];
    };
    assert.ok(Array.isArray(data.test_results));
    assert.equal(data.test_results[0].name, "upstream");
    assert.equal(data.test_results[0].status, "success");
    assert.ok(data.differences["gpt-sync"]);
    assert.ok("model_ratio" in data.differences["gpt-sync"]);
    assert.equal(typeof data.differences["gpt-sync"].model_ratio.confidence, "object");
    assert.equal(data.differences["gpt-sync"].model_ratio.upstreams.upstream, 2);
    assert.ok("current" in data.prices["gpt-sync"]);
    assert.ok("upstreams" in data.prices["gpt-sync"]);

    await json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key: "ResendApiKey", value: "re_test" }),
      }),
      e,
    );
    const invalidEmail = await json(new Request("http://local/api/verification?email=not-an-email"), e);
    assert.equal(invalidEmail.body.success, false);
    assert.equal(invalidEmail.body.code, "EMAIL_ADDRESS_REJECTED");
    assert.equal(invalidEmail.body.message, "Please enter a valid email address");
    await e.DB.prepare("UPDATE users SET email = ? WHERE id = 1").bind("taken@example.com").run();
    const taken = await json(new Request("http://local/api/verification?email=taken@example.com"), e);
    assert.equal(taken.body.message, "邮箱地址已被占用");
    const sent = await json(new Request("http://local/api/verification?email=new@example.com"), e);
    assert.equal(sent.body.success, true, String(sent.body.message));
    assert.equal(sent.body.message, "");

    const resetMissing = await json(new Request("http://local/api/reset_password?email=nobody@example.com"), e);
    assert.equal(resetMissing.body.success, true);
    assert.equal(resetMissing.body.message, "");
    const resetBad = await json(new Request("http://local/api/reset_password?email=not-an-email"), e);
    assert.equal(resetBad.body.message, "无效的参数");
  } finally {
    globalThis.fetch = origFetch;
  }

  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "sync-ch",
        type: 1,
        key: "sk-a\nsk-b",
        models: "gpt-4o-mini",
        group: "default",
        mode: "multi_to_single",
        multi_key_mode: "random",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const chId = Number((created.body.data as { id?: number })?.id || 0);
  assert.ok(chId);
  const statusPut = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: chId, name: "sync-ch", status: 2 }),
    }),
    e,
  );
  assert.equal(statusPut.body.success, false);
  assert.equal(statusPut.body.message, "无效的参数");
  const before = await json(new Request("http://local/api/channel/" + chId, { headers: auth }), e);
  const beforeInfo = (before.body.data as { channel_info: { is_multi_key: boolean; multi_key_size: number } }).channel_info;
  assert.equal(beforeInfo.is_multi_key, true);
  const renamed = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: chId, name: "sync-renamed" }),
    }),
    e,
  );
  assert.equal(renamed.body.success, true);
  assert.equal(renamed.body.message, "");
  const renamedData = renamed.body.data as { name: string; key: string; channel_info: Record<string, unknown> };
  assert.equal(renamedData.name, "sync-renamed");
  assert.equal(renamedData.key, "");
  assert.equal(renamedData.channel_info.is_multi_key, true);
  assert.equal("multi_key_disabled_reason" in renamedData.channel_info, false);
  const appended = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: chId, key: "sk-c", key_mode: "append" }),
    }),
    e,
  );
  assert.equal(appended.body.success, true, String(appended.body.message));
  assert.equal((appended.body.data as { channel_info: { multi_key_size: number } }).channel_info.multi_key_size, 3);

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "writeadmin", password: "password12", role: 10 }),
    }),
    e,
  );
  const adminLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "writeadmin", password: "password12" }),
    }),
    e,
  );
  const adminAuth = {
    authorization: "Bearer " + (adminLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const sensitive = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: adminAuth,
      body: JSON.stringify({ id: chId, key: "sk-new" }),
    }),
    e,
  );
  assert.equal(sensitive.body.success, false);
  assert.equal(sensitive.body.message, "无权进行此操作，权限不足");

  const proof = await passwordProof(e, auth, "access_token.generate");
  const issued = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  const pat = String(issued.body.data || "");
  const patSessions = await json(
    new Request("http://local/api/user/sessions", { headers: { authorization: "Bearer " + pat } }),
    e,
  );
  assert.equal(patSessions.res.status, 403);
  assert.equal(patSessions.body.code, "AUTH_SESSION_REQUIRED");
  assert.equal(patSessions.body.message, "a dashboard login session is required");

  const passkey = await json(new Request("http://local/api/user/passkey", { headers: auth }), e);
  assert.equal((passkey.body.data as { enabled: boolean }).enabled, false);
  assert.equal("last_used_at" in (passkey.body.data as object), false);

  const tooMany = await json(
    new Request("http://local/api/token/batch/keys", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }),
    }),
    e,
  );
  assert.equal(tooMany.body.message, "批量请求数量过多，最多 100 条");

  const logStat = await json(new Request("http://local/api/log/stat", { headers: auth }), e);
  const ls = logStat.body.data as { quota: number; rpm: number; tpm: number };
  assert.equal(typeof ls.quota, "number");
  assert.equal(typeof ls.rpm, "number");
  assert.equal(typeof ls.tpm, "number");
  const selfStat = await json(new Request("http://local/api/log/self/stat", { headers: auth }), e);
  const ss = selfStat.body.data as { quota: number; rpm: number; tpm: number };
  assert.equal(typeof ss.quota, "number");
  assert.equal(typeof ss.rpm, "number");
  assert.equal(typeof ss.tpm, "number");

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "codes", quota: 100, count: 1 }),
    }),
    e,
  );
  const redemptions = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const page = redemptions.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(typeof page.total, "number");
  assert.equal(typeof page.page, "number");
  assert.equal(typeof page.page_size, "number");
  assert.ok(page.items.length);
  for (const k of ["id", "user_id", "key", "status", "name", "quota", "created_time", "redeemed_time", "used_user_id", "expired_time"]) {
    assert.ok(k in page.items[0], "missing Redemption field " + k);
  }

  const prefill = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "models", type: "model", items: ["gpt-4o"], description: "d" }),
    }),
    e,
  );
  assert.equal(prefill.body.success, true, String(prefill.body.message));
  const groups = await json(new Request("http://local/api/prefill_group/", { headers: auth }), e);
  assert.ok(Array.isArray(groups.body.data));
  const g0 = (groups.body.data as Record<string, unknown>[])[0];
  for (const k of ["id", "name", "type", "items", "description", "created_time", "updated_time"]) {
    assert.ok(k in g0, "missing PrefillGroup field " + k);
  }
  assert.ok(Array.isArray(g0.items));

  const auditBad = await json(new Request("http://local/api/audit/self?category=nope", { headers: auth }), e);
  assert.equal(auditBad.body.message, "Invalid audit filters");

  const syncCh = await json(new Request("http://local/api/ratio_sync/channels", { headers: auth }), e);
  const channels = syncCh.body.data as { id: number; name: string }[];
  assert.ok(channels.some((ch) => ch.id === -100 && ch.name === "官方倍率预设"));
  assert.ok(channels.some((ch) => ch.id === -101 && ch.name === "models.dev 价格预设"));
});

test("original ResetPassword, Register, CustomOAuth, GetUser JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  const rootId = Number((self.body.data as { id: number }).id);
  const setEmail = await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: rootId, username: "root", email: "root@example.com" }),
    }),
    e,
  );
  assert.equal(setEmail.body.success, true, String(setEmail.body.message));

  const resetMail = await json(new Request("http://local/api/reset_password?email=root@example.com"), e);
  assert.equal(resetMail.body.success, true);
  assert.equal(resetMail.body.message, "");
  const codeRow = await e.DB.prepare("SELECT code FROM email_codes WHERE email = ? AND type = 'reset' AND used = 0")
    .bind("root@example.com")
    .first<{ code: string }>();
  assert.ok(codeRow?.code);
  assert.equal(codeRow.code.length, 32);

  const missingToken = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com" }),
    }),
    e,
  );
  assert.equal(missingToken.body.success, false);
  assert.equal(missingToken.body.message, "无效的参数");

  const badToken = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", token: "deadbeef" }),
    }),
    e,
  );
  assert.equal(badToken.body.success, false);
  assert.equal(badToken.body.message, "重置链接非法或已过期");

  const reset = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", token: codeRow.code }),
    }),
    e,
  );
  assert.equal(reset.body.success, true, String(reset.body.message));
  assert.equal(reset.body.message, "");
  const generated = String(reset.body.data);
  assert.equal(generated.length, 12);
  assert.match(generated, /^[0-9a-f]+$/);

  const relogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: generated }),
    }),
    e,
  );
  assert.equal(relogin.body.success, true, String(relogin.body.message));
  const newAuth = {
    authorization: "Bearer " + (relogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };

  const registered = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "newuser", password: "password12" }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  assert.equal(registered.body.message, "");
  assert.equal(registered.body.data, null);
  const dup = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "newuser", password: "password12" }),
    }),
    e,
  );
  assert.equal(dup.body.success, false);
  assert.equal(dup.body.message, "用户名已存在，或已注销");
  const userLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "newuser", password: "password12" }),
    }),
    e,
  );
  assert.equal(userLogin.body.success, true, String(userLogin.body.message));
  assert.equal(typeof (userLogin.body.data as { access_token: string }).access_token, "string");

  const oauthBody = {
    name: "GitHub Enterprise",
    slug: "github-enterprise",
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
    well_known: "",
    auth_style: 1,
    access_policy: "",
    access_denied_message: "",
  };
  const createdOAuth = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: newAuth,
      body: JSON.stringify(oauthBody),
    }),
    e,
  );
  assert.equal(createdOAuth.body.success, true, String(createdOAuth.body.message));
  assert.equal(createdOAuth.body.message, "创建成功");
  const provider = createdOAuth.body.data as Record<string, unknown>;
  for (const k of [
    "id",
    "name",
    "slug",
    "icon",
    "enabled",
    "client_id",
    "authorization_endpoint",
    "token_endpoint",
    "user_info_endpoint",
    "scopes",
    "user_id_field",
    "username_field",
    "display_name_field",
    "email_field",
    "well_known",
    "auth_style",
    "access_policy",
    "access_denied_message",
  ]) {
    assert.ok(k in provider, "missing CustomOAuthProvider field " + k);
  }
  assert.equal(provider.enabled, true);
  assert.equal(provider.authorization_endpoint, oauthBody.authorization_endpoint);
  assert.equal("client_secret" in provider, false);

  const listed = await json(new Request("http://local/api/custom-oauth-provider/", { headers: newAuth }), e);
  const list = listed.body.data as Record<string, unknown>[];
  assert.equal(list[0].slug, "github-enterprise");
  assert.equal(list[0].enabled, true);

  const got = await json(new Request("http://local/api/custom-oauth-provider/" + provider.id, { headers: newAuth }), e);
  assert.equal(got.body.success, true);
  assert.equal((got.body.data as { slug: string }).slug, "github-enterprise");
  assert.equal("client_secret" in (got.body.data as object), false);

  const badId = await json(new Request("http://local/api/custom-oauth-provider/abc", { headers: newAuth }), e);
  assert.equal(badId.body.message, "无效的 ID");
  const missing = await json(new Request("http://local/api/custom-oauth-provider/999", { headers: newAuth }), e);
  assert.equal(missing.body.message, "未找到该 OAuth 提供商");

  const taken = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: newAuth,
      body: JSON.stringify({ ...oauthBody, name: "Other" }),
    }),
    e,
  );
  assert.equal(taken.body.message, "该 Slug 已被使用");
  const builtin = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: newAuth,
      body: JSON.stringify({ ...oauthBody, slug: "github" }),
    }),
    e,
  );
  assert.equal(builtin.body.message, "该 Slug 与内置 OAuth 提供商冲突");

  const discoveryEmpty = await json(
    new Request("http://local/api/custom-oauth-provider/discovery", {
      method: "POST",
      headers: newAuth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(discoveryEmpty.body.message, "请先填写 Discovery URL 或 Issuer URL");
  const discoveryBad = await json(
    new Request("http://local/api/custom-oauth-provider/discovery", {
      method: "POST",
      headers: newAuth,
      body: JSON.stringify({ well_known_url: "ftp://example.com" }),
    }),
    e,
  );
  assert.equal(discoveryBad.body.message, "Discovery URL 无效，仅支持 http/https");

  const status = await json(new Request("http://local/api/status"), e);
  const customs = (status.body.data as { custom_oauth_providers: Record<string, unknown>[] }).custom_oauth_providers;
  assert.ok(Array.isArray(customs));
  assert.equal(customs[0].slug, "github-enterprise");
  assert.equal(customs[0].authorization_endpoint, oauthBody.authorization_endpoint);
  assert.equal(customs[0].client_id, "cid");

  const adminCreate = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: newAuth,
      body: JSON.stringify({ username: "siteadmin", password: "password12", role: 10 }),
    }),
    e,
  );
  assert.equal(adminCreate.body.success, true, String(adminCreate.body.message));
  const adminLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "siteadmin", password: "password12" }),
    }),
    e,
  );
  const adminAuth = {
    authorization: "Bearer " + (adminLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const forbidden = await json(new Request("http://local/api/user/" + rootId, { headers: adminAuth }), e);
  assert.equal(forbidden.body.success, false);
  assert.equal(forbidden.body.message, "无权获取同级或更高等级用户的信息");

  const searched = await json(new Request("http://local/api/user/search?keyword=siteadmin", { headers: newAuth }), e);
  const adminRow = ((searched.body.data as { items: { id: number; username: string }[] }).items || []).find(
    (u) => u.username === "siteadmin",
  );
  assert.ok(adminRow);
  const getAdmin = await json(new Request("http://local/api/user/" + adminRow.id, { headers: newAuth }), e);
  const adminData = getAdmin.body.data as { admin_permissions?: unknown; permissions?: { admin_permissions?: unknown } };
  assert.ok(adminData.admin_permissions, "GetUser must include top-level admin_permissions");
  assert.ok(adminData.permissions?.admin_permissions);

  const del = await json(
    new Request("http://local/api/custom-oauth-provider/" + provider.id, { method: "DELETE", headers: newAuth }),
    e,
  );
  assert.equal(del.body.success, true);
  assert.equal(del.body.message, "删除成功");
});

test("original TestChannel, UpdateSelf, video, OAuth, and subscription return JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const mj = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "mj-test", type: 2, key: "mj-key", models: "midjourney" }),
    }),
    e,
  );
  assert.equal(mj.body.success, true, String(mj.body.message));
  const channels = await json(new Request("http://local/api/channel/", { headers: auth }), e);
  const mjRow = ((channels.body.data as { items: { id: number; name: string }[] }).items || []).find((c) => c.name === "mj-test");
  assert.ok(mjRow);
  const tested = await json(new Request("http://local/api/channel/test/" + mjRow.id, { headers: auth }), e);
  assert.equal(tested.body.success, false);
  assert.equal(tested.body.message, "Midjourney channel test is not supported");
  assert.equal(tested.body.time, 0);
  assert.equal(tested.body.data, undefined);

  const badChannelId = await json(new Request("http://local/api/channel/test/abc", { headers: auth }), e);
  assert.equal(badChannelId.body.message, 'strconv.Atoi: parsing "abc": invalid syntax');
  const badGetChannel = await json(new Request("http://local/api/channel/abc", { headers: auth }), e);
  assert.equal(badGetChannel.body.message, 'strconv.Atoi: parsing "abc": invalid syntax');

  const allTest = await json(new Request("http://local/api/channel/test", { headers: auth }), e);
  assert.equal(allTest.body.success, true, String(allTest.body.message));
  const queued = allTest.body.data as { task_id: string; status: string };
  assert.equal(typeof queued.task_id, "string");
  assert.ok(String(queued.task_id).startsWith("systask_"));
  assert.equal(queued.status, "pending");
  const conflict = await json(new Request("http://local/api/channel/test", { headers: auth }), e);
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.message, "已有通道测试任务正在运行或等待中，不能启动本次手动任务");
  const cdata = conflict.body.data as { task_id: string; status: string; type: string };
  assert.equal(cdata.task_id, queued.task_id);
  assert.equal(cdata.type, "channel_test");

  const store = new Store(e.DB);
  const skippedManual = selectChannelsForAutomaticTest(
    [
      { id: 1, status: 2, auto_ban: 1, type: 1 } as never,
      { id: 2, status: 1, auto_ban: 1, type: 1 } as never,
    ],
    "scheduled_all",
  );
  assert.equal(skippedManual.length, 1);
  assert.equal(skippedManual[0].id, 2);
  const summary = await runChannelTestTask(store, "scheduled_all");
  assert.equal(typeof summary.tested, "number");
  assert.equal(typeof summary.succeeded, "number");
  assert.equal(typeof summary.failed, "number");
  assert.equal(typeof summary.disabled, "number");
  assert.equal(typeof summary.enabled, "number");
  assert.ok(summary.tested >= 1);
  assert.ok(summary.failed >= 1);

  const sidebar = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ sidebar_modules: JSON.stringify({ chat: true }) }),
    }),
    e,
  );
  assert.equal(sidebar.body.success, true, String(sidebar.body.message));
  assert.equal(sidebar.body.message, "更新成功");
  const lang = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ language: "en" }),
    }),
    e,
  );
  assert.equal(lang.body.success, true);
  assert.equal(lang.body.message, "更新成功");
  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  assert.ok(String((self.body.data as { sidebar_modules?: string }).sidebar_modules || "").includes("chat"));

  const unknownOauth = await json(new Request("http://local/api/oauth/not-a-provider"), e);
  assert.equal(unknownOauth.res.status, 400);
  assert.equal(unknownOauth.body.message, "Unknown OAuth provider");
  const zhUnknown = await json(new Request("http://local/api/oauth/not-a-provider", { headers: { "accept-language": "zh-CN" } }), e);
  assert.equal(zhUnknown.body.message, "未知的 OAuth 提供商");
  const oauthState = await json(new Request("http://local/api/oauth/github"), e);
  assert.equal(oauthState.res.status, 403);
  assert.equal(oauthState.body.message, "State parameter is empty or mismatched");
  const zhState = await json(new Request("http://local/api/oauth/github", { headers: { "accept-language": "zh-CN" } }), e);
  assert.equal(zhState.body.message, "state 参数为空或不匹配");

  const epayReturn = await json(new Request("http://local/api/subscription/epay/return"), e);
  assert.equal(epayReturn.res.status, 302);
  assert.equal(epayReturn.res.headers.get("location"), "/wallet?pay=fail");

  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "video-json", remain_quota: 1000, unlimited_quota: true }),
    }),
    e,
  );
  const sk = String((tok.body.data as { key?: string })?.key || "");
  await e.DB.prepare(
    `INSERT INTO tasks (task_id, user_id, platform, action, status, progress, properties, private_data, created_at, updated_at, finish_time, submit_time)
     VALUES (?, 1, 'jimeng', 'text_to_video', 'SUCCESS', '100%', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "task_jimeng_public",
      JSON.stringify({ origin_model_name: "jimeng_vgfm_t2v_l20" }),
      JSON.stringify({ result_url: "data:video/mp4;base64,ZGF0YQ==" }),
      1710000000,
      1710000060,
      1710000060,
      1710000000,
    )
    .run();
  const video = await json(new Request("http://local/v1/videos/task_jimeng_public", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(video.body.id, "task_jimeng_public");
  assert.equal(video.body.object, "video");
  assert.equal(video.body.status, "completed");
  assert.equal(video.body.progress, 100);
  assert.equal(video.body.created_at, 1710000000);
  assert.equal(video.body.completed_at, 1710000060);
  const generations = await json(
    new Request("http://local/v1/video/generations/task_jimeng_public", { headers: { authorization: "Bearer " + sk } }),
    e,
  );
  assert.equal(generations.body.object, "video");
  assert.equal(generations.body.status, "completed");
  const content = await json(
    new Request("http://local/v1/videos/task_jimeng_public/content", { headers: { authorization: "Bearer " + sk } }),
    e,
  );
  assert.equal(content.res.status, 200);
  assert.equal(content.text, "data");
  const missingVideo = await json(new Request("http://local/v1/videos/missing/content", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(missingVideo.res.status, 404);
  assert.equal((missingVideo.body.error as { type: string }).type, "invalid_request_error");
  assert.equal((missingVideo.body.error as { message: string }).message, "Task not found");

  const delUser = await json(new Request("http://local/api/user/abc", { method: "DELETE", headers: auth }), e);
  assert.equal(delUser.body.message, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missingChannel = await json(new Request("http://local/api/channel/999999", { headers: auth }), e);
  assert.equal(missingChannel.body.message, "record not found");
  const missingBalance = await json(new Request("http://local/api/channel/update_balance/999999", { headers: auth }), e);
  assert.equal(missingBalance.body.message, "record not found");

  const codexId = await json(new Request("http://local/api/channel/abc/codex/refresh", { method: "POST", headers: auth }), e);
  assert.equal(codexId.body.message, 'invalid channel id: strconv.Atoi: parsing "abc": invalid syntax');
  const ollamaId = await json(new Request("http://local/api/channel/ollama/version/abc", { headers: auth }), e);
  assert.equal(ollamaId.res.status, 400);
  assert.equal(ollamaId.body.message, "Invalid channel id");
  const ollamaMissing = await json(new Request("http://local/api/channel/ollama/version/999999", { headers: auth }), e);
  assert.equal(ollamaMissing.res.status, 404);
  assert.equal(ollamaMissing.body.message, "Channel not found");

  const respRetrieve = await json(new Request("http://local/v1/responses/resp_missing", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(respRetrieve.res.status, 404);
  assert.equal((respRetrieve.body.error as { type: string; code: string; message: string }).type, "new_api_error");
  assert.equal((respRetrieve.body.error as { code: string }).code, "not_found");
  assert.equal((respRetrieve.body.error as { message: string }).message, "No response found with id 'resp_missing'.");

  const pancake = await json(new Request("http://local/api/waffo-pancake/webhook/test", { method: "POST" }), e);
  assert.equal(pancake.res.status, 403);
  assert.equal(pancake.text, "webhook disabled");
  const pancakeEnv = await json(
    new Request("http://local/api/waffo-pancake/webhook/staging", { method: "POST" }),
    e,
  );
  assert.equal(pancakeEnv.res.status, 403);
  const waffoHook = await json(new Request("http://local/api/waffo/webhook", { method: "POST" }), e);
  assert.equal(waffoHook.res.status, 403);
});

test("original AddChannel, FetchModels, channel status, and RelayNotFound JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const badMode = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ mode: "merge", channel: { name: "x", type: 1, key: "sk-x" } }),
    }),
    e,
  );
  assert.equal(badMode.body.success, false);
  assert.equal(badMode.body.message, "不支持的添加模式");

  const emptyKey = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ mode: "single", channel: { name: "empty-key", type: 1, key: "" } }),
    }),
    e,
  );
  assert.equal(emptyKey.body.message, "channel cannot be empty");

  const wrapped = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: { name: "wrapped-ch", type: 1, key: "sk-one", models: "gpt-4o-mini", group: "default" },
      }),
    }),
    e,
  );
  assert.equal(wrapped.body.success, true, String(wrapped.body.message));
  const wrappedId = Number((wrapped.body.data as { id: number }).id);

  const batch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "batch",
        batch_add_set_key_prefix_2_name: true,
        channel: { name: "batch-ch", type: 1, key: "sk-batch-a\nsk-batch-b", models: "gpt-4o-mini", group: "default" },
      }),
    }),
    e,
  );
  assert.equal(batch.body.success, true, String(batch.body.message));
  assert.equal((batch.body.data as { count: number }).count, 2);
  const listed = await json(new Request("http://local/api/channel/search?keyword=batch-ch", { headers: auth }), e);
  const items = (listed.body.data as { items: { name: string }[] }).items;
  assert.ok(items.some((ch) => ch.name.startsWith("batch-ch sk-batch")));

  const autoBan = await json(
    new Request("http://local/api/channel/" + wrappedId + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: 3 }),
    }),
    e,
  );
  assert.equal(autoBan.body.success, false);
  assert.equal(autoBan.body.message, "Invalid parameters");
  const zhStatus = await json(
    new Request("http://local/api/channel/" + wrappedId + "/status", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ status: 3 }),
    }),
    e,
  );
  assert.equal(zhStatus.body.message, "无效的参数");
  const badStatusId = await json(
    new Request("http://local/api/channel/abc/status", { method: "POST", headers: auth, body: JSON.stringify({ status: 2 }) }),
    e,
  );
  assert.equal(badStatusId.body.message, "Invalid parameters");
  const disabled = await json(
    new Request("http://local/api/channel/" + wrappedId + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: 2 }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true);
  assert.equal(disabled.body.data, true);
  const again = await json(
    new Request("http://local/api/channel/" + wrappedId + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: 2 }),
    }),
    e,
  );
  assert.equal(again.body.data, false);
  const batchEmpty = await json(
    new Request("http://local/api/channel/status/batch", { method: "POST", headers: auth, body: JSON.stringify({ ids: [], status: 1 }) }),
    e,
  );
  assert.equal(batchEmpty.body.message, "Invalid parameters");
  const batchOk = await json(
    new Request("http://local/api/channel/status/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [wrappedId], status: 1 }),
    }),
    e,
  );
  assert.equal(batchOk.body.success, true);
  assert.equal(batchOk.body.data, 1);
  assert.equal(typeof batchOk.body.data, "number");

  const headerBad = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        type: 58,
        key: "sk-x",
        advanced_custom: '{"advanced_routes":[{"incoming_path":"/v1/chat/completions","upstream_path":"/v1/chat/completions"}]}',
        header_override: "not-json",
      }),
    }),
    e,
  );
  assert.equal(headerBad.body.success, false);
  assert.match(String(headerBad.body.message), /^header_override must be a JSON object: /);
  const headerArray = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        type: 58,
        key: "sk-x",
        advanced_custom: '{"advanced_routes":[{"incoming_path":"/v1/chat/completions","upstream_path":"/v1/chat/completions"}]}',
        header_override: "[]",
      }),
    }),
    e,
  );
  assert.equal(
    headerArray.body.message,
    "header_override must be a JSON object: json: cannot unmarshal array into Go value of type map[string]interface {}",
  );
  const typeMust = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: 1, channel_id: wrappedId }),
    }),
    e,
  );
  assert.equal(typeMust.body.message, `channel ${wrappedId} is not an advanced custom channel`);
  const typeMust2 = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: 58, key: "sk-x", advanced_custom: "[]" }),
    }),
    e,
  );
  assert.equal(typeMust2.body.message, "json: cannot unmarshal array into Go value of type dto.AdvancedCustomConfig");
  const emptyRoutes = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: 58, key: "sk-x", advanced_custom: "{}" }),
    }),
    e,
  );
  assert.equal(emptyRoutes.body.message, "渠道额外设置[channel setting] 格式错误：advanced_custom requires at least one route");
  const needAdv = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: 58, key: "sk-x" }),
    }),
    e,
  );
  assert.equal(needAdv.body.message, "advanced_custom is required");

  const unknownV1 = await json(new Request("http://local/v1/not-a-registered-route"), e);
  assert.equal(unknownV1.res.status, 404);
  assert.equal((unknownV1.body.error as { message: string; type: string; code: string }).type, "invalid_request_error");
  assert.equal((unknownV1.body.error as { message: string }).message, "Invalid URL (GET /v1/not-a-registered-route)");
  assert.equal((unknownV1.body.error as { code: string }).code, "");
  assert.equal(unknownV1.res.headers.get("cache-control"), "no-store, no-cache, must-revalidate, private, max-age=0");
  const unknownApi = await json(new Request("http://local/api/not-a-registered-route", { headers: auth }), e);
  assert.equal(unknownApi.res.status, 404);
  assert.equal((unknownApi.body.error as { message: string }).message, "Invalid URL (GET /api/not-a-registered-route)");
  const unknownAssets = await json(new Request("http://local/assets/missing.js"), e);
  assert.equal(unknownAssets.res.status, 404);
  assert.equal((unknownAssets.body.error as { message: string }).message, "Invalid URL (GET /assets/missing.js)");
  const getChat = await json(new Request("http://local/v1/chat/completions"), e);
  assert.equal(getChat.res.status, 404);
  assert.equal((getChat.body.error as { message: string }).message, "Invalid URL (GET /v1/chat/completions)");
});

test("original upstream model updates, token i18n, and EditTag JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const tooLong = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "n".repeat(51), remain_quota: 1, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(tooLong.body.success, false);
  assert.equal(tooLong.body.message, "Token name is too long");
  const tooLongZh = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ name: "n".repeat(51), remain_quota: 1, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(tooLongZh.body.message, "令牌名称过长");
  const negative = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "neg", remain_quota: -1, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(negative.body.message, "Quota value cannot be negative");
  const autoDup = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "auto-dup", group: "auto", auto_groups: ["default", "default"] }),
    }),
    e,
  );
  assert.equal(autoDup.body.message, "Auto group default is duplicated");

  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name: "up-detect",
          type: 1,
          key: "sk-upstream-secret",
          models: "gpt-4o",
          group: "default",
          base_url: "https://example.invalid",
          settings: JSON.stringify({ upstream_model_update_check_enabled: true }),
        },
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const channelId = Number((created.body.data as { id: number }).id);

  const badDetect = await json(
    new Request("http://local/api/channel/upstream_updates/detect", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(badDetect.body.message, "invalid channel id");
  const missingDetect = await json(
    new Request("http://local/api/channel/upstream_updates/detect", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: 999999 }),
    }),
    e,
  );
  assert.equal(missingDetect.body.message, "record not found");

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: " gpt-4.1 " }, { id: "o3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input as RequestInfo);
  }) as typeof fetch;
  try {
    const detected = await json(
      new Request("http://local/api/channel/upstream_updates/detect", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ id: channelId }),
      }),
      e,
    );
    assert.equal(detected.body.success, true, String(detected.body.message));
    const d = detected.body.data as {
      channel_id: number;
      channel_name: string;
      add_models: string[];
      remove_models: string[];
      last_check_time: number;
      auto_added_models: number;
    };
    assert.equal(d.channel_id, channelId);
    assert.equal(d.channel_name, "up-detect");
    assert.deepEqual(d.add_models, ["gpt-4.1", "o3"]);
    assert.deepEqual(d.remove_models, []);
    assert.equal(typeof d.last_check_time, "number");
    assert.ok(d.last_check_time > 0);
    assert.equal(d.auto_added_models, 0);

    const applied = await json(
      new Request("http://local/api/channel/upstream_updates/apply", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          id: channelId,
          add_models: ["gpt-4.1"],
          ignore_models: ["o3"],
          remove_models: [],
        }),
      }),
      e,
    );
    assert.equal(applied.body.success, true, String(applied.body.message));
    const a = applied.body.data as {
      id: number;
      added_models: string[];
      removed_models: string[];
      ignored_models: string[];
      remaining_models: string[];
      remaining_remove_models: string[];
      models: string;
      settings: string;
    };
    assert.equal(a.id, channelId);
    assert.deepEqual(a.added_models, ["gpt-4.1"]);
    assert.deepEqual(a.removed_models, []);
    assert.deepEqual(a.ignored_models, ["o3"]);
    assert.deepEqual(a.remaining_models, []);
    assert.deepEqual(a.remaining_remove_models, []);
    assert.equal(a.models, "gpt-4o,gpt-4.1");
    const settings = JSON.parse(a.settings) as {
      upstream_model_update_ignored_models: string[];
      upstream_model_update_last_detected_models: string[];
    };
    assert.deepEqual(settings.upstream_model_update_ignored_models, ["o3"]);
    assert.deepEqual(settings.upstream_model_update_last_detected_models, []);

    const created2 = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          mode: "single",
          channel: {
            name: "up-all",
            type: 1,
            key: "sk-upstream-all",
            models: "old-model",
            group: "default",
            base_url: "https://example.invalid",
            settings: JSON.stringify({ upstream_model_update_check_enabled: true }),
          },
        }),
      }),
      e,
    );
    const channelId2 = Number((created2.body.data as { id: number }).id);
    const detected2 = await json(
      new Request("http://local/api/channel/upstream_updates/detect", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ id: channelId2 }),
      }),
      e,
    );
    const d2 = detected2.body.data as { add_models: string[]; remove_models: string[] };
    assert.deepEqual(d2.add_models, ["gpt-4o", "gpt-4.1", "o3"]);
    assert.deepEqual(d2.remove_models, ["old-model"]);

    const applyAll = await json(
      new Request("http://local/api/channel/upstream_updates/apply_all", { method: "POST", headers: auth, body: "{}" }),
      e,
    );
    assert.equal(applyAll.body.success, true, String(applyAll.body.message));
    const all = applyAll.body.data as {
      processed_channels: number;
      added_models: number;
      removed_models: number;
      failed_channel_ids: number[];
      results: { channel_id: number; added_models: string[]; removed_models: string[] }[];
    };
    assert.equal(all.processed_channels, 1);
    assert.equal(all.added_models, 3);
    assert.equal(all.removed_models, 1);
    assert.deepEqual(all.failed_channel_ids, []);
    assert.equal(all.results[0].channel_id, channelId2);
    assert.deepEqual(all.results[0].added_models, ["gpt-4o", "gpt-4.1", "o3"]);
    assert.deepEqual(all.results[0].removed_models, ["old-model"]);

    const detectAll = await json(
      new Request("http://local/api/channel/upstream_updates/detect_all", { method: "POST", headers: auth, body: "{}" }),
      e,
    );
    assert.equal(detectAll.body.success, true, String(detectAll.body.message));
    const queued = detectAll.body.data as { task_id: string; status: string };
    assert.equal(typeof queued.task_id, "string");
    assert.ok(queued.task_id.startsWith("systask_"));
    assert.equal(queued.status, "pending");
    const conflict = await json(
      new Request("http://local/api/channel/upstream_updates/detect_all", { method: "POST", headers: auth, body: "{}" }),
      e,
    );
    assert.equal(conflict.res.status, 409);
    assert.equal(conflict.body.message, "已有模型更新任务正在运行或等待中，不能启动本次手动任务");
    const cdata = conflict.body.data as { task_id: string; status: string; type: string };
    assert.equal(cdata.task_id, queued.task_id);
    assert.equal(cdata.type, "model_update");
    assert.equal(cdata.status, "pending");
  } finally {
    globalThis.fetch = origFetch;
  }

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: { name: "tagged", type: 1, key: "sk-tag", models: "gpt-4o", group: "default", tag: "prod" },
      }),
    }),
    e,
  );
  const badOverride = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ tag: "prod", param_override: "{not-json" }),
    }),
    e,
  );
  assert.equal(badOverride.body.message, "参数覆盖必须是合法的 JSON 格式");
  const badHeader = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ tag: "prod", header_override: "not-json" }),
    }),
    e,
  );
  assert.equal(badHeader.body.message, "请求头覆盖必须是合法的 JSON 格式");
});

test("original GetOptions billing, models delete, and redemption PUT JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const opts = await json(new Request("http://local/api/option/", { headers: auth }), e);
  const rows = opts.body.data as { key: string; value: string }[];
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const meta = JSON.parse(byKey.CompletionRatioMeta) as Record<string, { ratio: number; locked: boolean }>;
  assert.equal(meta["gpt-4o-2024-05-13"].locked, true);
  assert.equal(meta["gpt-4o-2024-05-13"].ratio, 3);
  assert.equal(meta["gpt-5"].locked, true);
  assert.equal(meta["gpt-5"].ratio, 8);
  assert.equal(meta["gpt-4-all"].locked, false);
  assert.equal(meta["gpt-4-all"].ratio, 2);
  const modes = JSON.parse(byKey["billing_setting.billing_mode"]) as Record<string, string>;
  const exprs = JSON.parse(byKey["billing_setting.billing_expr"]) as Record<string, string>;
  assert.equal(modes["gpt-6-astra"], "tiered_expr");
  assert.equal(
    exprs["gpt-6-astra"],
    'len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + cc * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + cc * 25)',
  );

  const createdA = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "delete-me-a" }),
    }),
    e,
  );
  const createdB = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "delete-me-b" }),
    }),
    e,
  );
  const idA = Number((createdA.body.data as { id: number }).id);
  const idB = Number((createdB.body.data as { id: number }).id);
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name: "delete-models-ch",
          type: 1,
          key: "sk-delete-models",
          models: "delete-me-a,keep-me",
          group: "default",
        },
      }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelPrice", value: JSON.stringify({ "delete-me-a": 0.04, "keep-price": 1 }) }),
    }),
    e,
  );

  const emptyDelete = await json(
    new Request("http://local/api/models/delete", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  assert.equal(emptyDelete.body.success, false);
  assert.equal(emptyDelete.body.message, "select between 1 and 1000 models");

  const badFlag = await json(
    new Request("http://local/api/models/" + idA + "?remove_from_channels=yes", { method: "DELETE", headers: auth }),
    e,
  );
  assert.equal(badFlag.body.success, false);
  assert.match(String(badFlag.body.message), /strconv.ParseBool/);

  const deleted = await json(
    new Request("http://local/api/models/" + idA + "?remove_from_channels=true&remove_pricing=true", {
      method: "DELETE",
      headers: auth,
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.deepEqual(deleted.body.data, { deleted_count: 1, updated_channels: 1 });

  const channels = await json(new Request("http://local/api/channel/search?keyword=delete-models-ch", { headers: auth }), e);
  const ch = (channels.body.data as { items: { models: string }[] }).items[0];
  assert.equal(ch.models, "keep-me");
  const priceAfter = await json(new Request("http://local/api/option/", { headers: auth }), e);
  const priceMap = JSON.parse(
    (priceAfter.body.data as { key: string; value: string }[]).find((row) => row.key === "ModelPrice")!.value,
  ) as Record<string, number>;
  assert.equal("delete-me-a" in priceMap, false);
  assert.equal(priceMap["keep-price"], 1);

  const batch = await json(
    new Request("http://local/api/models/delete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_ids: [idB], remove_from_channels: false, remove_pricing: false }),
    }),
    e,
  );
  assert.equal(batch.body.success, true, String(batch.body.message));
  assert.deepEqual(batch.body.data, { deleted_count: 1, updated_channels: 0 });

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const future = Math.floor(Date.now() / 1000) + 3600;
  const createdCode = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 500, count: 1, expired_time: future }),
    }),
    e,
  );
  assert.equal(createdCode.body.success, true, String(createdCode.body.message));
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const red = (listed.body.data as { items: Record<string, unknown>[] }).items[0];
  assert.equal(red.expired_time, future);
  assert.equal(red.used_user_id, 0);

  const later = future + 60;
  const updated = await json(
    new Request("http://local/api/redemption/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: red.id, name: "gift2", quota: 800, expired_time: later }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  const data = updated.body.data as Record<string, unknown>;
  assert.equal(data.id, red.id);
  assert.equal(data.name, "gift2");
  assert.equal(data.quota, 800);
  assert.equal(data.expired_time, later);
  assert.equal(data.status, 1);
  assert.equal(data.used_user_id, 0);

  const statusOnly = await json(
    new Request("http://local/api/redemption/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: red.id, status: 2 }),
    }),
    e,
  );
  assert.equal(statusOnly.body.success, true, String(statusOnly.body.message));
  assert.equal((statusOnly.body.data as { status: number; name: string; quota: number }).status, 2);
  assert.equal((statusOnly.body.data as { name: string }).name, "gift2");
  assert.equal((statusOnly.body.data as { quota: number }).quota, 800);

  const pastExpire = await json(
    new Request("http://local/api/redemption/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: red.id, name: "gift2", quota: 800, expired_time: 1 }),
    }),
    e,
  );
  assert.equal(pastExpire.body.success, false);
  assert.equal(pastExpire.body.message, "Expiration time cannot be earlier than current time");

  await e.DB.prepare("UPDATE redemptions SET status = 1, expired_time = ? WHERE id = ?")
    .bind(Math.floor(Date.now() / 1000) - 10, red.id)
    .run();
  const expiredSearch = await json(new Request("http://local/api/redemption/search?status=expired", { headers: auth }), e);
  const expiredItems = (expiredSearch.body.data as { items: { id: number }[] }).items;
  assert.ok(expiredItems.some((item) => item.id === red.id));
});


