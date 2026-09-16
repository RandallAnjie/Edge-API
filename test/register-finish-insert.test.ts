import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { generateDefaultSidebarConfigForRole } from "../src/user-insert.js";
import { ROLE_ADMIN, ROLE_ROOT, ROLE_USER, ROOT_QUOTA } from "../src/constants.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

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
  return { e, auth };
}

async function putOption(e: Env, auth: Record<string, string>, key: string, value: string) {
  const res = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key, value }),
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
}

test("original generateDefaultSidebarConfigForRole JSON", () => {
  const user = JSON.parse(generateDefaultSidebarConfigForRole(ROLE_USER)) as {
    chat: Record<string, boolean>;
    console: Record<string, boolean>;
    personal: Record<string, boolean>;
    admin?: unknown;
  };
  assert.equal(user.chat.enabled, true);
  assert.equal(user.console.token, true);
  assert.equal(user.console.log, true);
  assert.equal("audit" in user.console, false);
  assert.equal(user.personal.topup, true);
  assert.equal("security" in user.personal, false);
  assert.equal(user.admin, undefined);
  const admin = JSON.parse(generateDefaultSidebarConfigForRole(ROLE_ADMIN)) as { admin: { setting: boolean } };
  assert.equal(admin.admin.setting, false);
  const root = JSON.parse(generateDefaultSidebarConfigForRole(ROLE_ROOT)) as { admin: { setting: boolean } };
  assert.equal(root.admin.setting, true);
  assert.equal(
    generateDefaultSidebarConfigForRole(ROLE_USER),
    '{"chat":{"chat":true,"enabled":true,"playground":true},"console":{"detail":true,"enabled":true,"log":true,"midjourney":true,"task":true,"token":true},"personal":{"enabled":true,"personal":true,"topup":true}}',
  );
});

test("original finishInsert 新用户注册赠送 LogQuota JSON and sidebar setting", async () => {
  const { e, auth } = await boot();
  await putOption(e, auth, "QuotaForNewUser", "500000");
  const registered = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "giftuser", password: "password12" }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "giftuser", password: "password12" }),
    }),
    e,
  );
  const userAuth = {
    authorization: "Bearer " + (login.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const self = await json(new Request("http://local/api/user/self", { headers: userAuth }), e);
  const data = self.body.data as {
    quota: number;
    setting: string;
    sidebar_modules: string;
  };
  assert.equal(data.quota, 500000);
  const setting = JSON.parse(data.setting) as { gotify_priority: number; sidebar_modules: string };
  assert.equal(setting.gotify_priority, 0);
  assert.equal(typeof setting.sidebar_modules, "string");
  assert.equal(data.sidebar_modules, setting.sidebar_modules);
  const sidebar = JSON.parse(setting.sidebar_modules) as { console: { audit?: boolean }; personal: { security?: boolean } };
  assert.equal(sidebar.console.audit, undefined);
  assert.equal(sidebar.personal.security, undefined);

  const logs = await json(new Request("http://local/api/log/self?type=4", { headers: userAuth }), e);
  const items = (logs.body.data as { items: { content: string; type: number }[] }).items;
  const gift = items.find((row) => String(row.content).startsWith("新用户注册赠送 "));
  assert.ok(gift);
  assert.equal(gift.content, "新用户注册赠送 ＄1.000000 额度");
  assert.equal(gift.type, 4);
});

test("original finishInsert invite rewards require payment compliance and skip inviter wallet", async () => {
  const { e, auth } = await boot();
  await putOption(e, auth, "QuotaForNewUser", "500000");
  const seeded = new Store(e.DB);
  await seeded.setOption("QuotaForInvitee", "1000000");
  await seeded.setOption("QuotaForInviter", "250000");
  const rootSelf = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  const aff = (rootSelf.body.data as { aff_code: string }).aff_code;
  assert.ok(aff);

  const blocked = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "noinvite", password: "password12", aff_code: aff }),
    }),
    e,
  );
  assert.equal(blocked.body.success, true, String(blocked.body.message));
  const blockedLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "noinvite", password: "password12" }),
    }),
    e,
  );
  const blockedAuth = {
    authorization: "Bearer " + (blockedLogin.body.data as { access_token: string }).access_token,
  };
  const blockedSelf = await json(new Request("http://local/api/user/self", { headers: blockedAuth }), e);
  assert.equal((blockedSelf.body.data as { quota: number }).quota, 500000);
  const rootAfterBlock = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  const rootBlocked = rootAfterBlock.body.data as { quota: number; aff_count: number; aff_quota: number };
  assert.equal(rootBlocked.quota, ROOT_QUOTA);
  assert.equal(rootBlocked.aff_count, 0);
  assert.equal(rootBlocked.aff_quota, 0);

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth, body: JSON.stringify({ confirmed: true }) }), e);
  const allowed = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "yesinvite", password: "password12", aff_code: aff }),
    }),
    e,
  );
  assert.equal(allowed.body.success, true, String(allowed.body.message));
  const allowedLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "yesinvite", password: "password12" }),
    }),
    e,
  );
  const allowedAuth = {
    authorization: "Bearer " + (allowedLogin.body.data as { access_token: string }).access_token,
  };
  const allowedSelf = await json(new Request("http://local/api/user/self", { headers: allowedAuth }), e);
  assert.equal((allowedSelf.body.data as { quota: number }).quota, 1500000);
  const inviteeLogs = await json(new Request("http://local/api/log/self?type=4", { headers: allowedAuth }), e);
  const inviteeItems = (inviteeLogs.body.data as { items: { content: string }[] }).items;
  assert.ok(inviteeItems.some((row) => row.content === "新用户注册赠送 ＄1.000000 额度"));
  assert.ok(inviteeItems.some((row) => row.content === "使用邀请码赠送 ＄2.000000 额度"));

  const rootAfter = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  const root = rootAfter.body.data as { quota: number; aff_count: number; aff_quota: number; aff_history_quota: number };
  assert.equal(root.quota, ROOT_QUOTA);
  assert.equal(root.aff_count, 1);
  assert.equal(root.aff_quota, 250000);
  assert.equal(root.aff_history_quota, 250000);
  const rootLogs = await json(new Request("http://local/api/log/self?type=4", { headers: auth }), e);
  const rootItems = (rootLogs.body.data as { items: { content: string }[] }).items;
  assert.ok(rootItems.some((row) => row.content === "邀请用户赠送 ＄0.500000 额度"));
});
