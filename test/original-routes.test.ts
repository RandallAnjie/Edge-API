import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { runChannelTestTask, selectChannelsForAutomaticTest, buildTestRequest, channelTestRequestPath, normalizeChannelTestEndpoint, resolveChannelTestModel } from "../src/channel-test.js";
import { modelsUrl } from "../src/upstream.js";
import { resetCodexClientVersionCache, codexModelsURL } from "../src/codex-models.js";
import {
  buildAdvancedCustomModelListRequest,
  supportedEndpointTypesForModel,
  advancedCustomConfigFromSettings,
} from "../src/channel-validate.js";
import { relayErrorHandler } from "../src/http.js";
import type { ChannelRow, Env, ExecutionContextLike } from "../src/types.js";

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
  { method: "GET", path: "/api/log/stat" },
  { method: "GET", path: "/api/log/self/stat" },
  { method: "POST", path: "/api/channel/copy/1" },
  { method: "GET", path: "/api/channel/fetch_models/1" },
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
  for (const k of ["id", "username", "created_at", "last_login_at", "remark", "setting", "aff_code", "quota", "github_id", "linux_do_id", "wechat_id", "stripe_customer", "DeletedAt"]) {
    assert.ok(k in page.items[0], "missing GetAllUsers field " + k);
  }
  assert.equal(page.items[0].DeletedAt, null);

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

test("original GetPricing omitempty ratios and models matched_models JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const emptyName = await json(
    new Request("http://local/api/models/", { method: "POST", headers: auth, body: JSON.stringify({ model_name: "" }) }),
    e,
  );
  assert.equal(emptyName.body.success, false);
  assert.equal(emptyName.body.message, "模型名称不能为空");

  const createdExact = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "listing-exact", status: 1, sync_official: 1 }),
    }),
    e,
  );
  assert.equal(createdExact.body.success, true, String(createdExact.body.message));
  assert.equal((createdExact.body.data as { has_metadata: boolean; name_rule: number }).has_metadata, true);
  assert.equal((createdExact.body.data as { name_rule: number }).name_rule, 0);

  const dup = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "listing-exact", status: 1 }),
    }),
    e,
  );
  assert.equal(dup.body.success, false);
  assert.equal(dup.body.message, "模型名称已存在");

  const badRule = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "bad-rule", name_rule: 4, status: 1 }),
    }),
    e,
  );
  assert.equal(badRule.body.success, false);
  assert.equal(badRule.body.message, "invalid metadata matching rule");

  await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "listing-catalog", status: 1 }),
    }),
    e,
  );
  const prefix = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "listing-rule-", name_rule: 1, status: 1 }),
    }),
    e,
  );
  assert.equal(prefix.body.success, true, String(prefix.body.message));
  assert.equal((prefix.body.data as { name_rule: number }).name_rule, 1);
  const prefixId = Number((prefix.body.data as { id: number }).id);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name: "Listing active",
          type: 1,
          key: "sk-listing-active",
          models: "listing-exact, listing-new,listing-rule-child,listing-new, ,",
          group: "default",
        },
      }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name: "Listing inactive",
          type: 1,
          key: "sk-listing-inactive",
          models: "listing-new,listing-disabled",
          group: "default",
        },
      }),
    }),
    e,
  );
  const chSearch = await json(new Request("http://local/api/channel/search?keyword=Listing inactive", { headers: auth }), e);
  const inactive = (chSearch.body.data as { items: { id: number; name: string }[] }).items.find((c) => c.name === "Listing inactive");
  assert.ok(inactive);
  await json(
    new Request("http://local/api/channel/" + inactive!.id + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: 2 }),
    }),
    e,
  );

  const listed = await json(
    new Request("http://local/api/models/search?include_channel_models=true&keyword=listing-", { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  const items = (listed.body.data as { items: Record<string, unknown>[]; total: number }).items;
  assert.equal((listed.body.data as { total: number }).total, 6);
  assert.deepEqual(
    items.map((m) => m.model_name),
    ["listing-rule-", "listing-catalog", "listing-exact", "listing-disabled", "listing-new", "listing-rule-child"],
  );
  const byName = Object.fromEntries(items.map((m) => [String(m.model_name), m]));
  assert.equal(byName["listing-exact"].has_metadata, true);
  assert.equal(byName["listing-new"].has_metadata, false);
  assert.equal(byName["listing-new"].id, 0);
  assert.equal(byName["listing-new"].configured_channel_count, 2);
  assert.equal(byName["listing-disabled"].configured_channel_count, 1);
  assert.equal(byName["listing-disabled"].bound_channels, undefined);
  assert.equal(byName["listing-catalog"].configured_channel_count, 0);
  assert.deepEqual(byName["listing-rule-"].matched_models, ["listing-rule-child"]);
  assert.equal(byName["listing-rule-"].matched_count, 1);

  const page2 = await json(
    new Request("http://local/api/models/search?include_channel_models=true&keyword=listing-&p=2&page_size=2", {
      headers: auth,
    }),
    e,
  );
  assert.equal((page2.body.data as { total: number }).total, 6);
  assert.deepEqual(
    ((page2.body.data as { items: { model_name: string }[] }).items).map((m) => m.model_name),
    ["listing-exact", "listing-disabled"],
  );

  const enabledOnly = await json(
    new Request("http://local/api/models/search?include_channel_models=true&keyword=listing-&status=enabled", {
      headers: auth,
    }),
    e,
  );
  assert.equal((enabledOnly.body.data as { total: number }).total, 3);
  assert.deepEqual(
    ((enabledOnly.body.data as { items: { model_name: string }[] }).items).map((m) => m.model_name),
    ["listing-rule-", "listing-catalog", "listing-exact"],
  );

  const badSquare = await json(new Request("http://local/api/models/?square_state=unknown", { headers: auth }), e);
  assert.equal(badSquare.res.status, 400);
  assert.equal(badSquare.body.message, "Invalid model square state");

  const badPage = await json(
    new Request("http://local/api/models/search?square_state=visible&p=-1", { headers: auth }),
    e,
  );
  assert.equal(badPage.res.status, 400);
  assert.equal(badPage.body.message, "Invalid pagination");

  const detail = await json(new Request("http://local/api/models/" + prefixId, { headers: auth }), e);
  assert.equal(detail.body.success, true);
  assert.deepEqual((detail.body.data as { matched_models: string[] }).matched_models, ["listing-rule-child"]);
  assert.equal((detail.body.data as { matched_count: number }).matched_count, 1);
  assert.ok(["visible", "partial", "unavailable", "hidden"].includes(String((detail.body.data as { square_state: string }).square_state)));

  await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source:
          'const meta = { apiVersion: 1, key: "usage-task", name: "usage-task", version: "1.0.0", author: { name: "test" }, models: ["usage-task"], fetchMode: "per_task", routes: [], protocols: [], allowedHosts: [], auth: { type: "none" }, usageSchema: { clips: { type: "number", unit: "count" } }, usageExamples: [{ label: "one", facts: { clips: 1 } }] };',
      }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name: "pricing-ch",
          type: 1,
          key: "sk-pricing",
          models: "gpt-4o-mini,gpt-4o-audio-preview,gpt-image-1,gpt-6-astra,parity-unmapped-ratio,usage-task",
          group: "default",
        },
      }),
    }),
    e,
  );

  const pricing = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  assert.equal(pricing.body.success, true);
  assert.equal(pricing.body.pricing_version, "a42d372ccf0b5dd13ecf71203521f9d2");
  const rows = pricing.body.data as Record<string, unknown>[];
  assert.equal(rows[0].pricing_version, "5a90f2b86c08bd983a9a2e6d66c255f4eaef9c4bc934386d2b6ae84ef0ff1f1f");
  const byModel = Object.fromEntries(rows.map((m) => [String(m.model_name), m]));
  assert.equal(byModel["gpt-4o-mini"].cache_ratio, 0.5);
  assert.equal(byModel["gpt-4o-mini"].quota_type, 0);
  assert.equal(byModel["gpt-4o-mini"].model_ratio, 0.075);
  assert.equal("create_cache_ratio" in byModel["gpt-4o-mini"], false);
  assert.equal(byModel["gpt-4o-audio-preview"].audio_ratio, 16);
  assert.equal(byModel["gpt-image-1"].image_ratio, 2);
  assert.equal(byModel["gpt-6-astra"].billing_mode, "tiered_expr");
  assert.equal(
    byModel["gpt-6-astra"].billing_expr,
    'len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + cc * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + cc * 25)',
  );
  assert.equal(byModel["parity-unmapped-ratio"].model_ratio, 37.5);
  assert.equal(byModel["parity-unmapped-ratio"].quota_type, 0);
  assert.equal((byModel["usage-task"].billing_usage_schema as { clips: { type: string } }).clips.type, "number");
  assert.equal((byModel["usage-task"].billing_usage_examples as { label: string }[])[0].label, "one");
});

test("original GetLogsStat rpm window, GetGroups, checkin, CopyChannel, FetchUpstreamModels JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const s = new Store(e.DB);

  const ali = modelsUrl({ type: 17, key: "sk-ali", base_url: "" } as ChannelRow);
  assert.equal(ali.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/models");
  const ollama = modelsUrl({ type: 4, key: "ollama-key", base_url: "http://localhost:11434" } as ChannelRow);
  assert.equal(ollama.url, "http://localhost:11434/api/tags");
  const zhipu = modelsUrl({ type: 26, key: "sk-z", base_url: "" } as ChannelRow);
  assert.equal(zhipu.url, "https://open.bigmodel.cn/api/paas/v4/models");
  const glmPlan = modelsUrl({ type: 26, key: "sk-z", base_url: "glm-coding-plan" } as ChannelRow);
  assert.equal(glmPlan.url, "https://open.bigmodel.cn/api/coding/paas/v4/models");
  const volc = modelsUrl({ type: 45, key: "sk-v", base_url: "" } as ChannelRow);
  assert.equal(volc.url, "https://ark.cn-beijing.volces.com/api/v3/models");
  const gemini = modelsUrl({ type: 24, key: "gem-key", base_url: "" } as ChannelRow);
  assert.equal(gemini.url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(gemini.headers["x-goog-api-key"], "gem-key");
  assert.equal(gemini.url.includes("key="), false);

  const groups = await json(new Request("http://local/api/group/", { headers: auth }), e);
  assert.equal(groups.body.success, true);
  const names = groups.body.data as string[];
  assert.ok(Array.isArray(names));
  assert.ok(names.includes("default"));
  assert.ok(names.includes("vip"));
  assert.ok(names.includes("svip"));
  assert.equal(names.every((n) => typeof n === "string"), true);

  const userGroups = await json(new Request("http://local/api/user/self/groups", { headers: auth }), e);
  const ug = userGroups.body.data as Record<string, { ratio: number | string; desc: string }>;
  assert.equal(typeof ug.default.ratio, "number");
  assert.equal(typeof ug.default.desc, "string");
  assert.equal("auto" in ug, false);

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "checkin_setting.enabled", value: "true" }),
    }),
    e,
  );
  const doCk = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  assert.equal(doCk.body.success, true, String(doCk.body.message));
  assert.equal(doCk.body.message, "签到成功");
  const ck = doCk.body.data as { quota_awarded: number; checkin_date: string };
  assert.equal(typeof ck.quota_awarded, "number");
  assert.match(ck.checkin_date, /^\d{4}-\d{2}-\d{2}$/);
  const againCk = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  assert.equal(againCk.body.success, false);
  assert.equal(againCk.body.message, "今日已签到");

  const tooWide = await json(
    new Request("http://local/api/data/self?start_timestamp=1&end_timestamp=3000001", { headers: auth }),
    e,
  );
  assert.equal(tooWide.body.success, false);
  assert.equal(tooWide.body.message, "时间跨度不能超过 1 个月");
  const dataSelf = await json(
    new Request("http://local/api/data/self?start_timestamp=1&end_timestamp=100", { headers: auth }),
    e,
  );
  assert.equal(dataSelf.body.success, true);
  assert.ok(Array.isArray(dataSelf.body.data));
  const row0 = (dataSelf.body.data as Record<string, unknown>[])[0];
  if (row0) {
    assert.equal("user_id" in row0, true);
    assert.equal("model_name" in row0, true);
    assert.equal("token_used" in row0, true);
  }

  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "stat-src",
        type: 1,
        key: "sk-copy",
        models: "gpt-4o",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const srcId = Number((created.body.data as { id: number }).id);
  await s.updateChannel(srcId, { used_quota: 42, balance: "9.5" });
  const keepBal = await json(
    new Request("http://local/api/channel/copy/" + srcId + "?reset_balance=false&suffix=_bak", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(keepBal.body.success, true, String(keepBal.body.message));
  const keepId = Number((keepBal.body.data as { id: number }).id);
  const keepGet = await json(new Request("http://local/api/channel/" + keepId, { headers: auth }), e);
  const keepCh = keepGet.body.data as { name: string; used_quota: number; balance: number };
  assert.equal(keepCh.name, "stat-src_bak");
  assert.equal(keepCh.used_quota, 42);

  const pluginUp = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: pluginSource("fetch-demo", "Fetch Demo") }),
    }),
    e,
  );
  assert.equal(pluginUp.body.success, true, String(pluginUp.body.message));
  const pluginCh = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "plugin-fetch",
        type: 61,
        key: "plugin-key",
        models: "fetch-demo",
        group: "default",
        setting: JSON.stringify({ task_plugin_key: "fetch-demo" }),
      }),
    }),
    e,
  );
  assert.equal(pluginCh.body.success, true, String(pluginCh.body.message));
  const pluginId = Number((pluginCh.body.data as { id: number }).id);
  const pluginModels = await json(new Request("http://local/api/channel/fetch_models/" + pluginId, { headers: auth }), e);
  assert.equal(pluginModels.body.success, true, String(pluginModels.body.message));
  assert.deepEqual(pluginModels.body.data, ["fetch-demo"]);

  const missingPlugin = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "plugin-missing",
        type: 61,
        key: "x",
        models: "none",
        group: "default",
        setting: JSON.stringify({ task_plugin_key: "not-registered" }),
      }),
    }),
    e,
  );
  const missingId = Number((missingPlugin.body.data as { id: number }).id);
  const missingFetch = await json(new Request("http://local/api/channel/fetch_models/" + missingId, { headers: auth }), e);
  assert.equal(missingFetch.body.success, false);
  assert.equal(missingFetch.body.message, '获取模型列表失败: task plugin "not-registered" is not registered');

  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes("/compatible-mode/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-plus" }, { id: " qwen-max " }, { id: "qwen-plus" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3" }, { name: "mistral" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input as RequestInfo, undefined);
  };
  try {
    const aliFetch = await json(
      new Request("http://local/api/channel/fetch_models", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: 17, key: "sk-ali", base_url: "https://dashscope.aliyuncs.com" }),
      }),
      e,
    );
    assert.equal(aliFetch.body.success, true, String(aliFetch.body.message));
    assert.deepEqual(aliFetch.body.data, ["qwen-plus", "qwen-max"]);
    assert.ok(seen.some((u) => u === "https://dashscope.aliyuncs.com/compatible-mode/v1/models"));

    const ollamaCh = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "ollama-local",
          type: 4,
          key: "ollama-key",
          models: "llama3",
          group: "default",
          base_url: "http://localhost:11434",
        }),
      }),
      e,
    );
    const ollamaId = Number((ollamaCh.body.data as { id: number }).id);
    const ollamaFetch = await json(new Request("http://local/api/channel/fetch_models/" + ollamaId, { headers: auth }), e);
    assert.equal(ollamaFetch.body.success, true, String(ollamaFetch.body.message));
    assert.deepEqual(ollamaFetch.body.data, ["llama3", "mistral"]);
  } finally {
    globalThis.fetch = origFetch;
  }

  const now = Math.floor(Date.now() / 1000);
  await s.insertLog({
    user_id: 1,
    username: "root",
    type: 2,
    quota: 100,
    prompt_tokens: 1,
    completion_tokens: 1,
    created_at: now - 120,
    channel_id: 7,
  });
  await s.insertLog({
    user_id: 1,
    username: "root",
    type: 2,
    quota: 50,
    prompt_tokens: 10,
    completion_tokens: 5,
    created_at: now,
    channel_id: 8,
  });
  const hist = await json(
    new Request(`http://local/api/log/stat?start_timestamp=${now - 200}&end_timestamp=${now - 90}`, { headers: auth }),
    e,
  );
  const hs = hist.body.data as { quota: number; rpm: number; tpm: number };
  assert.equal(hs.quota, 100);
  assert.equal(hs.rpm, 1);
  assert.equal(hs.tpm, 15);

  const selfCh = await json(new Request("http://local/api/log/self/stat?channel=7", { headers: auth }), e);
  const ss = selfCh.body.data as { quota: number; rpm: number; tpm: number };
  assert.equal(ss.quota, 100);
  assert.equal(ss.rpm, 0);

  const likeBad = await json(new Request("http://local/api/log/?username=" + encodeURIComponent("%r%"), { headers: auth }), e);
  assert.equal(likeBad.body.success, false);
  assert.equal(likeBad.body.message, "使用模糊搜索时，关键词长度至少为 2 个字符");
  const likeOk = await json(new Request("http://local/api/log/?username=" + encodeURIComponent("%ro%"), { headers: auth }), e);
  assert.equal(likeOk.body.success, true);
  const items = (likeOk.body.data as { items: unknown[] }).items;
  assert.ok(items.length >= 2);

  const tagged = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "short-tag",
        type: 1,
        key: "sk-t",
        models: "a",
        group: "default",
        tag: "parity-tag",
      }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "long-tag",
        type: 1,
        key: "sk-t2",
        models: "gpt-4o,gpt-4o-mini,gpt-4.1",
        group: "default",
        tag: "parity-tag",
      }),
    }),
    e,
  );
  void tagged;
  const tagModels = await json(new Request("http://local/api/channel/tag/models?tag=parity-tag", { headers: auth }), e);
  assert.equal(tagModels.body.success, true);
  assert.equal(tagModels.body.data, "gpt-4o,gpt-4o-mini,gpt-4.1");
});

test("original FetchCodexChannelModels, advanced-custom fetch, GetPricing endpoints, GetAllTask/MJ JSON", async () => {
  resetSchemaFlag();
  resetCodexClientVersionCache();
  const e = env();
  const { auth } = await boot(e);
  const s = new Store(e.DB);
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const origFetch = globalThis.fetch;
  let advId = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    seen.push({ url, headers });
    if (url.startsWith("https://api.github.com/repos/openai/codex/releases/latest")) {
      assert.equal(headers.accept, "application/vnd.github+json");
      assert.equal(headers["user-agent"], "new-api");
      return new Response(JSON.stringify({ name: "0.50.0", draft: false, prerelease: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://auth.openai.com/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/backend-api/codex/models")) {
      assert.equal(headers["chatgpt-account-id"], "acct-1");
      assert.equal(headers["user-agent"], "codex-cli/0.50.0");
      if (headers.authorization === "Bearer expired-at") return new Response("unauthorized", { status: 401 });
      return new Response(
        JSON.stringify({ models: [{ slug: "gpt-5" }, { slug: "gpt-5.1-codex" }, { slug: "gpt-5" }, { slug: "  " }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://provider.example/provider/models")) {
      assert.equal(headers["x-api-key"], "Bearer sk-adv");
      assert.equal(headers["x-extra"], "ov-sk-adv");
      return new Response(JSON.stringify({ data: [{ id: "custom-a" }, { id: "custom-a" }, { id: "custom-b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.11.4" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  try {
    const setupFresh = env();
    const setup = await json(new Request("http://local/api/setup"), setupFresh);
    assert.equal(setup.body.success, true);
    const setupData = setup.body.data as { status: boolean; root_init: boolean; database_type: string };
    assert.equal(setupData.status, false);
    assert.equal(setupData.root_init, false);
    assert.equal(setupData.database_type, "d1");

    const setupDone = await json(new Request("http://local/api/setup"), e);
    const done = setupDone.body.data as { status: boolean; root_init: boolean; database_type: string };
    assert.equal(done.status, true);
    assert.equal(done.root_init, false);
    assert.equal(done.database_type, "");

    const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
    const selfData = self.body.data as Record<string, unknown>;
    for (const k of [
      "id",
      "username",
      "display_name",
      "has_password",
      "role",
      "status",
      "email",
      "github_id",
      "discord_id",
      "oidc_id",
      "wechat_id",
      "telegram_id",
      "group",
      "quota",
      "used_quota",
      "request_count",
      "aff_code",
      "aff_count",
      "aff_quota",
      "aff_history_quota",
      "inviter_id",
      "linux_do_id",
      "setting",
      "stripe_customer",
      "sidebar_modules",
      "permissions",
    ]) {
      assert.ok(k in selfData, "missing GetSelf field " + k);
    }
    const perms = selfData.permissions as { admin_permissions?: unknown; sidebar_settings?: boolean; is_root?: boolean };
    assert.ok(perms.admin_permissions);
    assert.equal(perms.sidebar_settings, false);
    assert.equal(perms.is_root, true);

    const users = await json(new Request("http://local/api/user/", { headers: auth }), e);
    const userPage = users.body.data as { items: Record<string, unknown>[] };
    for (const k of ["id", "username", "display_name", "role", "status", "email", "quota", "used_quota", "request_count", "group", "remark", "created_at", "last_login_at", "DeletedAt"]) {
      assert.ok(k in userPage.items[0], "missing GetAllUsers field " + k);
    }

    const advancedSettings = JSON.stringify({
      advanced_custom: {
        advanced_routes: [
          {
            incoming_path: "/v1/chat/completions",
            upstream_path: "/v1/chat/completions",
            converter: "none",
            models: ["gemini-2.5-flash"],
          },
          {
            incoming_path: "/v1/responses",
            upstream_path: "/v1/responses",
            converter: "none",
            models: ["gpt-4o"],
          },
          {
            incoming_path: "/v1/models",
            upstream_path: "https://provider.example/provider/models",
            converter: "none",
            auth: { type: "header", name: "X-Api-Key", value: "Bearer {api_key}" },
          },
        ],
      },
    });
    const advCh = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          mode: "single",
          channel: {
            name: "adv-custom",
            type: 58,
            key: "sk-adv",
            models: "gemini-2.5-flash,gpt-4o",
            group: "default",
            base_url: "https://provider.example",
            settings: advancedSettings,
            header_override: JSON.stringify({ "X-Extra": "ov-{api_key}" }),
          },
        }),
      }),
      e,
    );
    assert.equal(advCh.body.success, true, String(advCh.body.message));
    advId = Number((advCh.body.data as { id: number }).id);
    const savedAdv = (await s.getChannel(advId)) as ChannelRow;
    const listReq = buildAdvancedCustomModelListRequest(savedAdv);
    assert.equal(listReq.url, "https://provider.example/provider/models");
    assert.equal(listReq.headers["X-Api-Key"], "Bearer sk-adv");
    const cfg = advancedCustomConfigFromSettings(savedAdv.settings);
    assert.deepEqual(supportedEndpointTypesForModel(cfg, "gemini-2.5-flash"), ["openai"]);
    assert.deepEqual(supportedEndpointTypesForModel(cfg, "gpt-4o"), ["openai-response"]);
    assert.deepEqual(supportedEndpointTypesForModel(cfg, "other-model"), []);

    const advFetch = await json(new Request("http://local/api/channel/fetch_models/" + advId, { headers: auth }), e);
    assert.equal(advFetch.body.success, true, String(advFetch.body.message));
    assert.deepEqual(advFetch.body.data, ["custom-a", "custom-b"]);

    const missingRoute = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          mode: "single",
          channel: {
            name: "adv-no-models",
            type: 58,
            key: "sk-adv-2",
            models: "gemini-2.5-flash",
            group: "default",
            base_url: "https://provider.example",
            settings: JSON.stringify({
              advanced_custom: {
                advanced_routes: [
                  {
                    incoming_path: "/v1/chat/completions",
                    upstream_path: "/v1/chat/completions",
                    converter: "none",
                    models: ["gemini-2.5-flash"],
                  },
                ],
              },
            }),
          },
        }),
      }),
      e,
    );
    assert.equal(missingRoute.body.success, true, String(missingRoute.body.message));
    const missingId = Number((missingRoute.body.data as { id: number }).id);
    const missingFetch = await json(new Request("http://local/api/channel/fetch_models/" + missingId, { headers: auth }), e);
    assert.equal(missingFetch.body.success, false);
    assert.equal(missingFetch.body.message, "获取模型列表失败: advanced custom channel does not configure a /v1/models route");

    const pricing = await json(new Request("http://local/api/pricing", { headers: auth }), e);
    assert.equal(pricing.body.success, true);
    const byModel = Object.fromEntries(
      (pricing.body.data as Record<string, unknown>[]).map((m) => [String(m.model_name), m]),
    );
    assert.deepEqual(byModel["gemini-2.5-flash"].supported_endpoint_types, ["openai"]);
    assert.deepEqual(byModel["gpt-4o"].supported_endpoint_types, ["openai-response"]);

    const codexCh = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          mode: "single",
          channel: {
            name: "codex-ok",
            type: 57,
            key: JSON.stringify({ access_token: "good-at", account_id: "acct-1", refresh_token: "rt", type: "codex" }),
            models: "gpt-5",
            group: "default",
            base_url: "https://chatgpt.com",
          },
        }),
      }),
      e,
    );
    assert.equal(codexCh.body.success, true, String(codexCh.body.message));
    const codexId = Number((codexCh.body.data as { id: number }).id);
    assert.equal(
      codexModelsURL("https://chatgpt.com", "0.50.0"),
      "https://chatgpt.com/backend-api/codex/models?client_version=0.50.0",
    );
    const codexFetch = await json(new Request("http://local/api/channel/fetch_models/" + codexId, { headers: auth }), e);
    assert.equal(codexFetch.body.success, true, String(codexFetch.body.message));
    assert.deepEqual(codexFetch.body.data, ["gpt-5", "gpt-5.1-codex"]);
    assert.ok(seen.some((c) => c.url === "https://chatgpt.com/backend-api/codex/models?client_version=0.50.0"));

    const expiredCh = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          mode: "single",
          channel: {
            name: "codex-expired",
            type: 57,
            key: JSON.stringify({ access_token: "expired-at", account_id: "acct-1", refresh_token: "rt", type: "codex" }),
            models: "gpt-5",
            group: "default",
            base_url: "https://chatgpt.com",
          },
        }),
      }),
      e,
    );
    const expiredId = Number((expiredCh.body.data as { id: number }).id);
    const expiredFetch = await json(new Request("http://local/api/channel/fetch_models/" + expiredId, { headers: auth }), e);
    assert.equal(expiredFetch.body.success, true, String(expiredFetch.body.message));
    assert.deepEqual(expiredFetch.body.data, ["gpt-5", "gpt-5.1-codex"]);
    const refreshed = await s.getChannel(expiredId);
    const refreshedKey = JSON.parse(String(refreshed?.key || "")) as { access_token: string; refresh_token: string };
    assert.equal(refreshedKey.access_token, "new-at");
    assert.equal(refreshedKey.refresh_token, "new-rt");

    const multiId = await s.insertChannel({
      name: "codex-multi",
      type: 57,
      key: JSON.stringify({ access_token: "good-at", account_id: "acct-1", type: "codex" }),
      models: "gpt-5",
      group: "default",
      channel_info: JSON.stringify({
        is_multi_key: true,
        multi_key_size: 2,
        multi_key_status_list: {},
        multi_key_polling_index: 0,
        multi_key_mode: "random",
      }),
    });
    const multiFetch = await json(new Request("http://local/api/channel/fetch_models/" + multiId, { headers: auth }), e);
    assert.equal(multiFetch.body.success, false);
    assert.equal(multiFetch.body.message, "获取模型列表失败: codex channel does not support multi-key model discovery");

    const ollamaCh = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "ollama-ver",
          type: 4,
          key: "ollama-key",
          models: "llama3",
          group: "default",
          base_url: "http://localhost:11434",
        }),
      }),
      e,
    );
    const ollamaId = Number((ollamaCh.body.data as { id: number }).id);
    const ollamaVer = await json(new Request("http://local/api/channel/ollama/version/" + ollamaId, { headers: auth }), e);
    assert.equal(ollamaVer.body.success, true, String(ollamaVer.body.message));
    assert.equal((ollamaVer.body.data as { version: string }).version, "0.11.4");
    const ollamaBad = await json(new Request("http://local/api/channel/ollama/version/abc", { headers: auth }), e);
    assert.equal(ollamaBad.res.status, 400);
    assert.equal(ollamaBad.body.message, "Invalid channel id");
  } finally {
    globalThis.fetch = origFetch;
  }

  await s.insertTask({
    task_id: "task-parity-1",
    user_id: 1,
    channel_id: 3,
    group: "default",
    quota: 12,
    platform: "suno",
    action: "MUSIC",
    status: "IN_PROGRESS",
    progress: "40%",
    fail_reason: "",
    properties: { input: "make a song", origin_model_name: "suno-v4" },
    data: { clips: 1 },
    private_data: {
      execution: {
        request_id: "req-1",
        request_path: "/v1/tasks/suno",
        task_plugin: { key: "suno", name: "Suno", version: "1.0.0", api_version: 1, generation: 2, author: { name: "QN" } },
      },
      upstream_task_id: "up-1",
      node_name: "edge-api",
    },
  });
  const tasks = await json(new Request("http://local/api/task", { headers: auth }), e);
  assert.equal(tasks.body.success, true);
  const taskPage = tasks.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(typeof taskPage.total, "number");
  assert.equal(typeof taskPage.page, "number");
  assert.equal(typeof taskPage.page_size, "number");
  const task = taskPage.items[0];
  for (const k of ["id", "created_at", "updated_at", "task_id", "platform", "user_id", "group", "channel_id", "quota", "action", "status", "fail_reason", "submit_time", "start_time", "finish_time", "progress", "properties", "data", "username"]) {
    assert.ok(k in task, "missing GetAllTask field " + k);
  }
  assert.equal(task.task_id, "task-parity-1");
  assert.equal(task.username, "root");
  assert.equal((task.properties as { input: string }).input, "make a song");
  assert.equal((task.admin_info as { request_id: string }).request_id, "req-1");
  assert.equal((task.root_info as { task_plugin: { api_version: number; generation: number } }).task_plugin.api_version, 1);
  assert.equal((task.root_info as { task_plugin: { generation: number } }).task_plugin.generation, 2);
  assert.equal((task.root_info as { upstream_task_id: string }).upstream_task_id, "up-1");

  const selfTasks = await json(new Request("http://local/api/task/self", { headers: auth }), e);
  const selfItem = (selfTasks.body.data as { items: Record<string, unknown>[] }).items[0];
  assert.equal("username" in selfItem, false);
  assert.equal("admin_info" in selfItem, false);
  assert.equal("root_info" in selfItem, false);

  await s.setOption("MjForwardUrlEnabled", "true");
  await s.setOption("ServerAddress", "https://console.example");
  await s.insertMj({
    action: "IMAGINE",
    user_id: 1,
    mj_id: "mj-parity",
    prompt: "a cat",
    prompt_en: "a cat",
    status: "SUCCESS",
    image_url: "https://cdn.example/cat.png",
    progress: "100%",
  });
  const mj = await json(new Request("http://local/api/mj/", { headers: auth }), e);
  const mjItem = (mj.body.data as { items: Record<string, unknown>[] }).items[0];
  for (const k of ["id", "code", "user_id", "action", "mj_id", "prompt", "prompt_en", "description", "state", "submit_time", "start_time", "finish_time", "image_url", "video_url", "video_urls", "status", "progress", "fail_reason", "channel_id", "quota", "buttons", "properties"]) {
    assert.ok(k in mjItem, "missing GetAllMidjourney field " + k);
  }
  assert.equal(mjItem.image_url, "https://console.example/mj/image/mj-parity");

  const ch = await json(new Request("http://local/api/channel/" + advId, { headers: auth }), e);
  const channel = ch.body.data as Record<string, unknown>;
  for (const k of ["id", "type", "key", "openai_organization", "test_model", "status", "name", "weight", "created_time", "test_time", "response_time", "base_url", "other", "balance", "balance_updated_time", "models", "group", "used_quota", "model_mapping", "status_code_mapping", "priority", "auto_ban", "other_info", "tag", "setting", "param_override", "header_override", "remark", "channel_info", "settings"]) {
    assert.ok(k in channel, "missing GetChannel field " + k);
  }
  assert.equal(channel.key, "");
});

test("original TestChannel POSTs gin httptest chat/embeddings/responses bodies", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const openaiChat = buildTestRequest("gpt-4o-mini", "openai", false);
  assert.equal(openaiChat.kind, "chat");
  assert.deepEqual(openaiChat.body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(openaiChat.body.max_tokens, 16);
  const gpt6 = buildTestRequest("gpt-6-astra", "", false);
  assert.equal(gpt6.body.max_tokens, 16);
  const o3 = buildTestRequest("o3-mini", "", false);
  assert.equal(o3.body.max_completion_tokens, 16);
  assert.equal("max_tokens" in o3.body, false);
  const embed = buildTestRequest("text-embedding-3-small", "", false);
  assert.equal(embed.kind, "embedding");
  assert.deepEqual(embed.body.input, ["hello world"]);
  const responses = buildTestRequest("gpt-5.1-codex", "", true);
  assert.equal(responses.kind, "responses");
  assert.equal(responses.body.stream, true);
  assert.deepEqual(responses.body.input, [{ role: "user", content: "hi" }]);

  const fakeOpenAI = {
    type: 1,
    test_model: "",
    models: "gpt-4o-mini",
  } as ChannelRow;
  assert.equal(resolveChannelTestModel(fakeOpenAI, ""), "gpt-4o-mini");
  assert.equal(resolveChannelTestModel({ ...fakeOpenAI, test_model: "gpt-4o" }, ""), "gpt-4o");
  assert.equal(normalizeChannelTestEndpoint({ type: 57 } as ChannelRow, ""), "openai-response");
  assert.equal(channelTestRequestPath(fakeOpenAI, "text-embedding-3-small", "", false), "/v1/embeddings");
  assert.equal(channelTestRequestPath({ type: 44 } as ChannelRow, "moka-embed", "", false), "/v1/embeddings");
  assert.equal(channelTestRequestPath({ type: 45 } as ChannelRow, "doubao-seedream-4.0", "", false), "/v1/images/generations");
  assert.equal(channelTestRequestPath({ type: 1 } as ChannelRow, "gpt-5.1-codex", "", false), "/v1/responses");
  assert.equal(channelTestRequestPath({ type: 57 } as ChannelRow, "gpt-5", "openai-response", false), "/v1/responses");
  assert.equal(channelTestRequestPath({ type: 24 } as ChannelRow, "gemini-2.5-flash", "gemini", true).includes("streamGenerateContent"), true);

  const seen: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    seen.push({ url, method: String(init?.method || "GET"), headers, body });
    if (url.includes("/v1/chat/completions")) {
      const req = (body || {}) as { model?: string; stream?: boolean };
      if (req.model === "fail-me") {
        return new Response(JSON.stringify({ error: { message: "upstream rejected" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
      if (req.stream) {
        return new Response(
          `data: ${JSON.stringify({ id: "chatcmpl-stream", choices: [{ delta: { content: "hi" } }], usage })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/embeddings")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ embedding: [0.1], index: 0 }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/backend-api/codex/responses")) {
      if (url.includes("/compact")) {
        return new Response(JSON.stringify({ error: { message: "no compact" } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          output: [],
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/responses")) {
      return new Response(
        JSON.stringify({
          id: "resp_oai",
          object: "response",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const created = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "test-openai",
          type: 1,
          key: "sk-test",
          models: "gpt-4o-mini,gpt-6-astra,text-embedding-3-small",
          group: "default",
          base_url: "https://api.example.test",
        }),
      }),
      e,
    );
    assert.equal(created.body.success, true, String(created.body.message));
    const channels = await json(new Request("http://local/api/channel/", { headers: auth }), e);
    const openaiRow = ((channels.body.data as { items: { id: number; name: string }[] }).items || []).find((c) => c.name === "test-openai");
    assert.ok(openaiRow);

    seen.length = 0;
    const chat = await json(new Request("http://local/api/channel/test/" + openaiRow.id + "?model=gpt-4o-mini", { headers: auth }), e);
    assert.equal(chat.body.success, true, String(chat.body.message));
    assert.equal(chat.body.message, "");
    assert.equal(typeof chat.body.time, "number");
    assert.ok(Number(chat.body.time) >= 0);
    assert.ok(Number(chat.body.time) < 5);
    assert.equal(chat.body.data, undefined);
    assert.equal("error_code" in chat.body, false);
    const chatHit = seen.find((s) => s.url === "https://api.example.test/v1/chat/completions");
    assert.ok(chatHit, JSON.stringify(seen.map((s) => s.url)));
    assert.equal(chatHit.method, "POST");
    assert.equal((chatHit.body as { model?: string }).model, "gpt-4o-mini");
    assert.deepEqual((chatHit.body as { messages?: unknown }).messages, [{ role: "user", content: "hi" }]);
    assert.equal((chatHit.body as { max_tokens?: number }).max_tokens, 16);
    assert.match(String(chatHit.headers.authorization || ""), /Bearer sk-test/i);

    seen.length = 0;
    const overrideCreated = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "test-override",
          type: 1,
          key: "sk-ov",
          models: "openai/gpt-4o-mini",
          group: "default",
          base_url: "https://api.example.test",
          param_override: JSON.stringify({ operations: [{ path: "model", mode: "trim_prefix", value: "openai/" }] }),
        }),
      }),
      e,
    );
    assert.equal(overrideCreated.body.success, true, String(overrideCreated.body.message));
    const overrideRow = ((await json(new Request("http://local/api/channel/", { headers: auth }), e)).body.data as { items: { id: number; name: string }[] }).items.find((c) => c.name === "test-override");
    assert.ok(overrideRow);
    const overrideGot = await json(new Request("http://local/api/channel/" + overrideRow.id, { headers: auth }), e);
    assert.match(String((overrideGot.body.data as { param_override?: string }).param_override || ""), /trim_prefix/);
    const overrideTest = await json(new Request("http://local/api/channel/test/" + overrideRow.id + "?model=openai/gpt-4o-mini", { headers: auth }), e);
    assert.equal(overrideTest.body.success, true, String(overrideTest.body.message));
    const overrideHit = seen.find((s) => s.url === "https://api.example.test/v1/chat/completions");
    assert.ok(overrideHit);
    assert.equal((overrideHit.body as { model?: string }).model, "gpt-4o-mini");

    const got = await json(new Request("http://local/api/channel/" + openaiRow.id, { headers: auth }), e);
    assert.ok(Number((got.body.data as { test_time: number }).test_time) > 0);
    assert.ok(Number((got.body.data as { response_time: number }).response_time) >= 0);

    const logs = await json(new Request("http://local/api/log/?type=2&token_name=" + encodeURIComponent("模型测试"), { headers: auth }), e);
    const items = (logs.body.data as { items: { token_name?: string; content?: string; model_name?: string }[] }).items || [];
    const testLog = items.find((l) => l.token_name === "模型测试" && l.model_name === "gpt-4o-mini");
    assert.ok(testLog, "TestChannel must RecordConsumeLog with token_name 模型测试");
    assert.equal(testLog.content, "模型测试");
    assert.equal(testLog.model_name, "gpt-4o-mini");
    const overrideLog = items.find((l) => l.token_name === "模型测试" && l.model_name === "openai/gpt-4o-mini");
    assert.ok(overrideLog, "TestChannel RecordConsumeLog uses OriginModelName before param_override");

    seen.length = 0;
    const gpt6Test = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=gpt-6-astra&endpoint_type=openai&stream=true", { headers: auth }),
      e,
    );
    assert.equal(gpt6Test.body.success, true, String(gpt6Test.body.message));
    const gpt6Hit = seen.find((s) => s.url.includes("/v1/chat/completions"));
    assert.ok(gpt6Hit);
    assert.equal((gpt6Hit.body as { max_completion_tokens?: number }).max_completion_tokens, 16);
    assert.equal("max_tokens" in (gpt6Hit.body as object), false);
    assert.equal((gpt6Hit.body as { stream?: boolean }).stream, true);
    assert.deepEqual((gpt6Hit.body as { stream_options?: unknown }).stream_options, { include_usage: true });

    seen.length = 0;
    const embedTest = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=text-embedding-3-small", { headers: auth }),
      e,
    );
    assert.equal(embedTest.body.success, true, String(embedTest.body.message));
    const embedHit = seen.find((s) => s.url === "https://api.example.test/v1/embeddings");
    assert.ok(embedHit, JSON.stringify(seen.map((s) => s.url)));
    assert.deepEqual((embedHit.body as { input?: unknown }).input, ["hello world"]);

    seen.length = 0;
    const failed = await json(new Request("http://local/api/channel/test/" + openaiRow.id + "?model=fail-me", { headers: auth }), e);
    assert.equal(failed.body.success, false);
    assert.equal(failed.body.message, "upstream rejected");
    assert.equal(failed.body.time, 0);
    assert.equal(failed.body.error_code, "bad_response");

    const mj = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "mj-probe", type: 2, key: "mj-key", models: "midjourney" }),
      }),
      e,
    );
    assert.equal(mj.body.success, true, String(mj.body.message));
    const mjChannels = await json(new Request("http://local/api/channel/", { headers: auth }), e);
    const mjRow = ((mjChannels.body.data as { items: { id: number; name: string }[] }).items || []).find((c) => c.name === "mj-probe");
    assert.ok(mjRow);
    const mjTest = await json(new Request("http://local/api/channel/test/" + mjRow.id, { headers: auth }), e);
    assert.equal(mjTest.body.success, false);
    assert.equal(mjTest.body.message, "Midjourney channel test is not supported");
    assert.equal(mjTest.body.time, 0);

    const codex = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          mode: "single",
          channel: {
            name: "test-codex",
            type: 57,
            key: JSON.stringify({ access_token: "codex-at", account_id: "acct-test", refresh_token: "rt", type: "codex" }),
            models: "gpt-5.1-codex",
            group: "default",
            base_url: "https://chatgpt.com",
          },
        }),
      }),
      e,
    );
    assert.equal(codex.body.success, true, String(codex.body.message));
    const afterCodex = await json(new Request("http://local/api/channel/", { headers: auth }), e);
    const codexRow = ((afterCodex.body.data as { items: { id: number; name: string }[] }).items || []).find((c) => c.name === "test-codex");
    assert.ok(codexRow);
    seen.length = 0;
    const codexTest = await json(new Request("http://local/api/channel/test/" + codexRow.id, { headers: auth }), e);
    assert.equal(codexTest.body.success, true, String(codexTest.body.message));
    const codexHit = seen.find((s) => s.url === "https://chatgpt.com/backend-api/codex/responses");
    assert.ok(codexHit, JSON.stringify(seen.map((s) => s.url)));
    assert.equal(codexHit.headers["chatgpt-account-id"], "acct-test");
    assert.equal(codexHit.headers.authorization, "Bearer codex-at");
    assert.equal(codexHit.headers["openai-beta"], "responses=experimental");
    assert.equal(codexHit.headers.originator, "codex_cli_rs");
    assert.equal((codexHit.body as { store?: boolean }).store, false);
    assert.equal((codexHit.body as { instructions?: string }).instructions, "");
    assert.equal((codexHit.body as { model?: string }).model, "gpt-5.1-codex");

    seen.length = 0;
    const compact = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=gpt-4o-mini&endpoint_type=openai-response-compact", { headers: auth }),
      e,
    );
    assert.equal(compact.body.success, true, String(compact.body.message));
    const compactHit = seen.find((s) => s.url === "https://api.example.test/v1/responses/compact");
    assert.ok(compactHit, JSON.stringify(seen.map((s) => s.url)));

    const anthropicCompact = await json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "test-claude", type: 14, key: "sk-ant", models: "claude-3-5-sonnet", group: "default", base_url: "https://api.anthropic.com" }),
      }),
      e,
    );
    assert.equal(anthropicCompact.body.success, true, String(anthropicCompact.body.message));
    const claudeChannels = await json(new Request("http://local/api/channel/", { headers: auth }), e);
    const claudeRow = ((claudeChannels.body.data as { items: { id: number; name: string }[] }).items || []).find((c) => c.name === "test-claude");
    assert.ok(claudeRow);
    const compactDenied = await json(
      new Request("http://local/api/channel/test/" + claudeRow.id + "?endpoint_type=openai-response-compact", { headers: auth }),
      e,
    );
    assert.equal(compactDenied.body.success, false);
    assert.match(String(compactDenied.body.message), /responses compaction test is not supported for api type 1/);
    assert.equal(compactDenied.body.error_code, "invalid_api_type");
    assert.equal(compactDenied.body.time, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original user soft-delete, amount envelopes, billing expr, RelayErrorHandler JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const users = await json(new Request("http://local/api/user/?p=1&page_size=20", { headers: auth }), e);
  const live = ((users.body.data as { items: { username: string; DeletedAt: unknown }[] }).items || []).find((u) => u.username === "root");
  assert.ok(live);
  assert.equal(live.DeletedAt, null);

  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "softdeluser", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const found = await json(new Request("http://local/api/user/search?keyword=softdeluser", { headers: auth }), e);
  const soft = ((found.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "softdeluser");
  assert.ok(soft);

  const managed = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: soft.id, action: "delete" }),
    }),
    e,
  );
  assert.equal(managed.body.success, true, String(managed.body.message));

  const deletedSearch = await json(new Request("http://local/api/user/search?keyword=softdeluser&status=-1", { headers: auth }), e);
  const deletedRow = ((deletedSearch.body.data as { items: { username: string; DeletedAt: unknown }[] }).items || []).find((u) => u.username === "softdeluser");
  assert.ok(deletedRow);
  assert.equal(typeof deletedRow.DeletedAt, "string");
  assert.match(String(deletedRow.DeletedAt), /T/);

  const scoped = await json(new Request("http://local/api/user/" + soft.id, { headers: auth }), e);
  assert.equal(scoped.body.success, false);
  assert.equal(scoped.body.message, "用户不存在");

  const unscoped = await json(new Request("http://local/api/user/?p=1&page_size=50", { headers: auth }), e);
  assert.ok(((unscoped.body.data as { items: { username: string }[] }).items || []).some((u) => u.username === "softdeluser"));

  const loginDeleted = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "softdeluser", password: "password12" }),
    }),
    e,
  );
  assert.equal(loginDeleted.body.success, false);
  assert.equal(loginDeleted.body.message, "用户名或密码错误，或用户已被封禁");

  const registerDeleted = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "softdeluser", password: "password12" }),
    }),
    e,
  );
  assert.equal(registerDeleted.body.success, false);
  assert.equal(registerDeleted.body.message, "用户名已存在，或已注销");

  const hardCreated = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "harddeluser", password: "password12" }),
    }),
    e,
  );
  assert.equal(hardCreated.body.success, true, String(hardCreated.body.message));
  const hardFound = await json(new Request("http://local/api/user/search?keyword=harddeluser", { headers: auth }), e);
  const hard = ((hardFound.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "harddeluser");
  assert.ok(hard);
  const hardDeleted = await json(new Request("http://local/api/user/" + hard.id, { method: "DELETE", headers: auth }), e);
  assert.equal(hardDeleted.body.success, true, String(hardDeleted.body.message));
  const gone = await json(new Request("http://local/api/user/search?keyword=harddeluser&status=-1", { headers: auth }), e);
  assert.equal(((gone.body.data as { items: { username: string }[] }).items || []).some((u) => u.username === "harddeluser"), false);
  const unscopedGone = await json(new Request("http://local/api/user/?p=1&page_size=50", { headers: auth }), e);
  assert.equal(((unscopedGone.body.data as { items: { username: string }[] }).items || []).some((u) => u.username === "harddeluser"), false);

  const tooSmall = await json(
    new Request("http://local/api/user/amount", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 0 }),
    }),
    e,
  );
  assert.equal(tooSmall.body.message, "error");
  assert.equal(tooSmall.body.data, "充值数量不能小于 1");
  assert.equal(tooSmall.body.success, false);

  const epayAmount = await json(
    new Request("http://local/api/user/amount", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10 }),
    }),
    e,
  );
  assert.equal(epayAmount.body.message, "success");
  assert.equal(epayAmount.body.data, "73.00");

  const stripeCap = await json(
    new Request("http://local/api/user/stripe/amount", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10001 }),
    }),
    e,
  );
  assert.equal(stripeCap.body.message, "error");
  assert.equal(stripeCap.body.data, "充值数量不能大于 10000");

  const epayNoCap = await json(
    new Request("http://local/api/user/amount", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10001 }),
    }),
    e,
  );
  assert.equal(epayNoCap.body.message, "success");
  assert.equal(typeof epayNoCap.body.data, "string");
  assert.match(String(epayNoCap.body.data), /^\d+\.\d{2}$/);

  const stripeAmount = await json(
    new Request("http://local/api/user/stripe/amount", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 10 }),
    }),
    e,
  );
  assert.equal(stripeAmount.body.message, "success");
  assert.equal(stripeAmount.body.data, "80.00");

  const pricing = await json(new Request("http://local/api/option/model_pricing", { headers: auth }), e);
  const emptyVersion = (pricing.body.data as { empty_version: string }).empty_version;
  const badExpr = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        changes: [
          {
            model_name: "expr-test",
            expected_version: emptyVersion,
            pricing: {
              "billing_setting.billing_mode": "tiered_expr",
              "billing_setting.billing_expr": "p *",
            },
          },
        ],
      }),
    }),
    e,
  );
  assert.equal(badExpr.body.success, false);
  assert.match(String(badExpr.body.message), /^model expr-test: expr compile error:/);

  const usageKey = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        changes: [
          {
            model_name: "expr-test",
            expected_version: emptyVersion,
            pricing: {
              "billing_setting.billing_mode": "tiered_expr",
              "billing_setting.billing_expr": 'u("seconds")',
            },
          },
        ],
      }),
    }),
    e,
  );
  assert.equal(usageKey.body.success, false);
  assert.equal(
    usageKey.body.message,
    "model expr-test: expression references usage keys [seconds] but the model has no task plugin usage schema",
  );

  const okExpr = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        changes: [
          {
            model_name: "expr-test",
            expected_version: emptyVersion,
            pricing: {
              "billing_setting.billing_mode": "tiered_expr",
              "billing_setting.billing_expr": 'tier("base", p * 2 + c * 8)',
            },
          },
        ],
      }),
    }),
    e,
  );
  assert.equal(okExpr.body.success, true, String(okExpr.body.message));
  assert.deepEqual((okExpr.body.data as { updated_models: string[] }).updated_models, ["expr-test"]);

  const badStatus = relayErrorHandler(502, "not-json");
  const badJson = JSON.parse(await badStatus.text()) as { error: { message: string; type: string; code: unknown; param: string } };
  assert.equal(badStatus.status, 502);
  assert.equal(badJson.error.message, "bad response status code 502");
  assert.equal(badJson.error.type, "bad_response_status_code");
  assert.equal(badJson.error.code, "bad_response_status_code");
  assert.equal(badJson.error.param, "");

  const mapped = relayErrorHandler(403, JSON.stringify({ error: { message: "nope", type: "auth", code: "denied" } }), JSON.stringify({ "403": 404 }));
  const mappedJson = JSON.parse(await mapped.text()) as { error: { message: string; type: string; code: unknown } };
  assert.equal(mapped.status, 404);
  assert.equal(mappedJson.error.message, "nope");
  assert.equal(mappedJson.error.type, "auth");
  assert.equal(mappedJson.error.code, "denied");

  const emptyBatch = await json(new Request("http://local/api/channel/batch", { method: "POST", headers: auth, body: JSON.stringify({ ids: [] }) }), e);
  assert.equal(emptyBatch.body.success, false);
  assert.equal(emptyBatch.body.message, "参数错误");

  const tk = await json(new Request("http://local/api/token/", { method: "POST", headers: auth, body: JSON.stringify({ name: "affinity", unlimited_quota: true }) }), e);
  assert.equal(tk.body.success, true, String(tk.body.message));
  const sk = (tk.body.data as { key: string }).key;
  const affCh = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "affinity-openai",
        type: 1,
        key: "sk-aff",
        models: "gpt-5",
        group: "default",
        base_url: "https://api.example.test",
      }),
    }),
    e,
  );
  assert.equal(affCh.body.success, true, String(affCh.body.message));
  const seenAff: { url: string; headers: Record<string, string> }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === "object" && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    } else if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    seenAff.push({ url: String(input), headers });
    return new Response(
      JSON.stringify({
        id: "resp_aff",
        object: "response",
        output: [],
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const affRelay = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", originator: "codex_cli_rs" },
        body: JSON.stringify({ model: "gpt-5", input: [{ role: "user", content: "hi" }], prompt_cache_key: "sess-aff" }),
      }),
      e,
    );
    assert.equal(affRelay.res.status, 200, String(affRelay.body.error || affRelay.body.message));
    const hit = seenAff.find((s) => s.url.includes("/v1/responses"));
    assert.ok(hit, JSON.stringify(seenAff.map((s) => s.url)));
    assert.equal(hit.headers.originator, "codex_cli_rs");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original auto-group selection, playground group, affinity TTL/usage cache, and AuthBundle cookies", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, login } = await boot(e);
  const loginData = login.body.data as Record<string, unknown>;
  assert.equal(loginData.token_type, "Bearer");
  assert.equal(typeof loginData.access_token, "string");
  assert.equal(typeof loginData.access_expires_at, "number");
  const sess = loginData.session as Record<string, unknown>;
  for (const k of ["sid", "current", "login_method", "ip", "user_agent", "created_at", "last_active_at", "expires_at"]) {
    assert.ok(k in sess, "missing AuthBundle.session " + k);
  }
  assert.equal(sess.current, true);
  assert.equal(sess.login_method, "password");
  const setCookie = login.res.headers.getSetCookie?.() || [];
  const cookieJoined = setCookie.length ? setCookie.join("\n") : login.res.headers.get("set-cookie") || "";
  assert.match(cookieJoined, /session=/);
  assert.match(cookieJoined, /new_api_refresh=/);
  assert.match(cookieJoined, /new_api_has_session=/);

  const status = await json(new Request("http://local/api/status"), e);
  const st = status.body.data as Record<string, unknown>;
  for (const k of [
    "wechat_login",
    "telegram_oauth",
    "telegram_oauth_configured",
    "password_login_encryption_enabled",
    "oidc_enabled",
    "oidc_client_id",
    "passkey_login",
    "checkin_enabled",
    "user_agreement_enabled",
    "privacy_policy_enabled",
  ]) {
    assert.ok(k in st, "missing GetStatus field " + k);
  }

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        key: "UserUsableGroups",
        value: JSON.stringify({ default: "默认分组", vip: "vip分组", auto: "自动分组" }),
      }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "AutoGroups", value: "[]" }),
    }),
    e,
  );

  const vipCh = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "vip-auto",
        type: 1,
        key: "sk-vip-auto",
        models: "auto-select-model",
        group: "vip",
        base_url: "https://vip.example.test",
      }),
    }),
    e,
  );
  assert.equal(vipCh.body.success, true, String(vipCh.body.message));
  const vipId = Number((vipCh.body.data as { id: number }).id);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "default-auto",
        type: 1,
        key: "sk-default-auto",
        models: "auto-select-model",
        group: "default",
        base_url: "https://default.example.test",
      }),
    }),
    e,
  );

  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "auto-groups",
        unlimited_quota: true,
        group: "auto",
        auto_groups: ["vip", "default"],
      }),
    }),
    e,
  );
  assert.equal(tk.body.success, true, String(tk.body.message));
  const sk = (tk.body.data as { key: string }).key;

  const seen: { url: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push({ url: String(input) });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-auto",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const autoRelay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "auto-select-model", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(autoRelay.res.status, 200, String(autoRelay.body.error || autoRelay.body.message));
    assert.ok(seen.some((s) => s.url.startsWith("https://vip.example.test")), JSON.stringify(seen.map((s) => s.url)));

    const deniedPg = await json(
      new Request("http://local/pg/chat/completions", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "auto-select-model",
          group: "missing-group",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(deniedPg.res.status, 403);
    assert.equal((deniedPg.body.error as { message: string }).message, "No permission to access this group");

    seen.length = 0;
    const pg = await json(
      new Request("http://local/pg/chat/completions", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "auto-select-model",
          group: "vip",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(pg.res.status, 200, String(pg.body.error || pg.body.message));
    assert.ok(seen.some((s) => s.url.startsWith("https://vip.example.test")), JSON.stringify(seen.map((s) => s.url)));

    const missing = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(missing.res.status, 503);
    assert.match(String((missing.body.error as { message: string }).message), /No available channel for model no-such-model-xyz under group/);
    assert.match(String((missing.body.error as { message: string }).message), /\(distributor\)/);

    const realtime = await json(
      new Request("http://local/v1/realtime?model=auto-select-model", {
        headers: { authorization: "Bearer " + sk },
      }),
      e,
    );
    assert.equal(realtime.res.status, 426, String(realtime.body.error || realtime.body.message));
  } finally {
    globalThis.fetch = origFetch;
  }

  const logs = await json(new Request("http://local/api/log/?model_name=auto-select-model", { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || logs.body.data) as Record<string, unknown>[];
  const autoLog = (Array.isArray(items) ? items : []).find((l) => l.model_name === "auto-select-model");
  assert.ok(autoLog, "expected consume log for auto-select-model");
  if (vipId) assert.equal(autoLog.channel, vipId);

  const affTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "aff-usage", unlimited_quota: true }),
    }),
    e,
  );
  const affSk = (affTk.body.data as { key: string }).key;
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "aff-usage-openai",
        type: 1,
        key: "sk-aff-usage",
        models: "gpt-5",
        group: "default",
        base_url: "https://aff-usage.example.test",
      }),
    }),
    e,
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "resp_usage",
        object: "response",
        output: [],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 4 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const affRelay = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + affSk, "content-type": "application/json", originator: "codex_cli_rs" },
        body: JSON.stringify({ model: "gpt-5", input: [{ role: "user", content: "hi" }], prompt_cache_key: "sess-usage" }),
      }),
      e,
    );
    assert.equal(affRelay.res.status, 200, String(affRelay.body.error || affRelay.body.message));
  } finally {
    globalThis.fetch = origFetch;
  }

  const { sha1Hex } = await import("../src/crypto.js");
  const fp = (await sha1Hex("sess-usage")).slice(0, 8);
  const usageCache = await json(
    new Request(
      "http://local/api/log/channel_affinity_usage_cache?rule_name=" +
        encodeURIComponent("codex cli trace") +
        "&using_group=default&key_fp=" +
        fp,
      { headers: auth },
    ),
    e,
  );
  const uc = usageCache.body.data as Record<string, unknown>;
  assert.equal(uc.rule_name, "codex cli trace");
  assert.equal(uc.using_group, "default");
  assert.equal(uc.key_fp, fp);
  assert.equal(uc.total, 1);
  assert.equal(uc.hit, 1);
  assert.equal(uc.cached_tokens, 4);
  assert.equal(uc.cached_token_rate_mode, "cached_over_prompt");

  const affLogs = await json(new Request("http://local/api/log/?model_name=gpt-5", { headers: auth }), e);
  const affItems = ((affLogs.body.data as { items?: Record<string, unknown>[] })?.items || affLogs.body.data) as Record<
    string,
    unknown
  >[];
  const affLog = (Array.isArray(affItems) ? affItems : []).find((l) => l.model_name === "gpt-5");
  assert.ok(affLog);
  const other = JSON.parse(String(affLog.other || "{}")) as { admin_info?: { channel_affinity?: Record<string, unknown> } };
  assert.equal(typeof other.admin_info, "object");

  const invalidKey = await json(new Request("http://local/api/channel/abc/key", { method: "POST", headers: auth }), e);
  assert.equal(invalidKey.res.status, 400);
  assert.equal(invalidKey.body.code, "SECURITY_CONTEXT_INVALID");
});

test("original TokenAuth group checks, admin channel pin, and token model limits", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const ghostTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ghost-group", unlimited_quota: true, group: "ghost" }),
    }),
    e,
  );
  assert.equal(ghostTk.body.success, true, String(ghostTk.body.message));
  const ghostSk = (ghostTk.body.data as { key: string }).key;
  const ghostRelay = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + ghostSk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(ghostRelay.res.status, 403);
  assert.equal((ghostRelay.body.error as { message: string }).message, "无权访问 ghost 分组");

  const defCh = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "pin-default",
        type: 1,
        key: "sk-pin-default",
        models: "pin-model",
        group: "default",
        base_url: "https://pin-default.example.test",
      }),
    }),
    e,
  );
  const vipCh = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "pin-vip",
        type: 1,
        key: "sk-pin-vip",
        models: "pin-model",
        group: "vip",
        base_url: "https://pin-vip.example.test",
      }),
    }),
    e,
  );
  assert.equal(defCh.body.success, true, String(defCh.body.message));
  assert.equal(vipCh.body.success, true, String(vipCh.body.message));
  const vipId = Number((vipCh.body.data as { id: number }).id);
  const pinTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "pin-token", unlimited_quota: true }),
    }),
    e,
  );
  const pinSk = (pinTk.body.data as { key: string }).key;
  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-pin",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const pinned = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + pinSk + "-" + vipId, "content-type": "application/json" },
        body: JSON.stringify({ model: "pin-model", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(pinned.res.status, 200, String(pinned.body.error || pinned.body.message));
    assert.ok(seen.some((u) => u.startsWith("https://pin-vip.example.test")), JSON.stringify(seen));
  } finally {
    globalThis.fetch = origFetch;
  }

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "pinuser", password: "password12", display_name: "pinuser" }),
    }),
    e,
  );
  const userLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "pinuser", password: "password12" }),
    }),
    e,
  );
  const userAuth = {
    authorization: "Bearer " + (userLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const userTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: userAuth,
      body: JSON.stringify({ name: "user-pin", unlimited_quota: true }),
    }),
    e,
  );
  const userSk = (userTk.body.data as { key: string }).key;
  const deniedPin = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + userSk + "-" + vipId, "content-type": "application/json" },
      body: JSON.stringify({ model: "pin-model", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(deniedPin.res.status, 403);
  assert.equal((deniedPin.body.error as { message: string }).message, "普通用户不支持指定渠道");
  assert.equal(deniedPin.res.headers.get("specific_channel_version"), "701e3ae1dc3f7975556d354e0675168d004891c8");

  const limitedTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "limits",
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: "claude-3-7-sonnet",
      }),
    }),
    e,
  );
  const limitedSk = (limitedTk.body.data as { key: string }).key;
  const forbidden = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + limitedSk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(forbidden.res.status, 403);
  assert.equal((forbidden.body.error as { message: string }).message, "This token has no access to model gpt-4o-mini");

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "claude-base",
        type: 1,
        key: "sk-claude-base",
        models: "claude-3-7-sonnet",
        group: "default",
        base_url: "https://claude-base.example.test",
      }),
    }),
    e,
  );
  seen.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-alias",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const alias = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + limitedSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3-7-sonnet-thinking", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(alias.res.status, 200, String(alias.body.error || alias.body.message));
    assert.ok(seen.some((u) => u.startsWith("https://claude-base.example.test")), JSON.stringify(seen));
  } finally {
    globalThis.fetch = origFetch;
  }

  const emptyLimits = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "empty-limits", unlimited_quota: true, model_limits_enabled: true, model_limits: "" }),
    }),
    e,
  );
  const emptySk = (emptyLimits.body.data as { key: string }).key;
  const none = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + emptySk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(none.res.status, 403);
  assert.equal((none.body.error as { message: string }).message, "This token has no access to model gpt-4o-mini");
});





