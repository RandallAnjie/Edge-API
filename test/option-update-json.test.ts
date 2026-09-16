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

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
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
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { auth };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function omitDataOk(body: Record<string, unknown>) {
  assert.equal(body.success, true);
  assert.equal(body.message, "");
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

const EN =
  "Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.";
const ZH_CN = "支付、兑换码、订阅计划和邀请返利功能已禁用。管理员需先确认合规声明后方可启用。";
const ZH_TW = "支付、兌換碼、訂閱方案和邀請返利功能已停用。管理員需先確認合規聲明後方可啟用。";

test("original UpdateOption QuotaForInviter/Invitee ApiErrorI18n gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await json(new Request("http://local/api/option/", { method: "PUT", headers: auth }), e);
  assert.equal(empty.res.status, 400);
  omitData(empty.body, "无效的参数");

  const arr = await json(
    new Request("http://local/api/option/", { method: "PUT", headers: auth, body: "[]" }),
    e,
  );
  assert.equal(arr.res.status, 400);
  omitData(arr.body, "无效的参数");

  const inviter = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInviter", value: "1000" }),
    }),
    e,
  );
  assert.equal(inviter.res.status, 200);
  omitData(inviter.body, EN);

  const invitee = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInvitee", value: 1.5 }),
    }),
    e,
  );
  omitData(invitee.body, EN);

  const sci = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInviter", value: "1e2" }),
    }),
    e,
  );
  omitData(sci.body, EN);

  const padded = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInvitee", value: " 2 " }),
    }),
    e,
  );
  omitData(padded.body, EN);

  const zh = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ key: "QuotaForInviter", value: "1" }),
    }),
    e,
  );
  omitData(zh.body, ZH_CN);

  const tw = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-TW" },
      body: JSON.stringify({ key: "QuotaForInvitee", value: "1" }),
    }),
    e,
  );
  omitData(tw.body, ZH_TW);

  const zero = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInviter", value: "0" }),
    }),
    e,
  );
  assert.equal(zero.res.status, 200);
  omitDataOk(zero.body);

  const neg = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInvitee", value: "-1" }),
    }),
    e,
  );
  omitDataOk(neg.body);

  const nested = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "payment_setting.compliance_confirmed", value: "true" }),
    }),
    e,
  );
  omitData(nested.body, "合规确认字段不允许通过通用设置接口修改");

  await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: true }),
    }),
    e,
  );

  const stillBlocked = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "payment_setting.compliance_terms_version", value: "v1" }),
    }),
    e,
  );
  omitData(stillBlocked.body, "合规确认字段不允许通过通用设置接口修改");

  const okInviter = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInviter", value: "250000" }),
    }),
    e,
  );
  omitDataOk(okInviter.body);
  assert.equal(await new Store(e.DB).option("QuotaForInviter"), "250000");

  const okInvitee = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "QuotaForInvitee", value: "1000000" }),
    }),
    e,
  );
  omitDataOk(okInvitee.body);
  assert.equal(await new Store(e.DB).option("QuotaForInvitee"), "1000000");
});

test("original UpdateOption OAuth enablement gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  async function put(key: string, value: string, extra: Record<string, string> = {}) {
    return json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: { ...auth, ...extra },
        body: JSON.stringify({ key, value }),
      }),
      e,
    );
  }

  const github = await put("GitHubOAuthEnabled", "true");
  omitData(github.body, "无法启用 GitHub OAuth，请先填入 GitHub Client Id 以及 GitHub Client Secret！");

  const discord = await put("discord.enabled", "true");
  omitData(discord.body, "无法启用 Discord OAuth，请先填入 Discord Client Id 以及 Discord Client Secret！");

  const oidc = await put("oidc.enabled", "true");
  omitData(oidc.body, "无法启用 OIDC 登录，请先填入 OIDC Client Id 以及 OIDC Client Secret！");

  const linuxdo = await put("LinuxDOOAuthEnabled", "true");
  omitData(linuxdo.body, "无法启用 LinuxDO OAuth，请先填入 LinuxDO Client Id 以及 LinuxDO Client Secret！");

  const wechat = await put("WeChatAuthEnabled", "true");
  omitData(wechat.body, "无法启用微信登录，请先填入微信登录相关配置信息！");

  const turnstile = await put("TurnstileCheckEnabled", "true");
  omitData(turnstile.body, "无法启用 Turnstile 校验，请先填入 Turnstile 校验相关配置信息！");

  const theme = await put("theme.frontend", "classic");
  omitData(theme.body, "Classic 前端已移除，主题只能设置为 default");

  const ftp = await put("TaskPublicAddress", "ftp://media.example.com/tasks");
  omitData(ftp.body, "task artifact base URL must use http or https");

  const spaced = await put("TaskPublicAddress", " https://media.example.com");
  omitData(spaced.body, "task artifact base URL must not contain surrounding whitespace");

  const query = await put("TaskPublicAddress", "https://media.example.com/tasks?token=secret");
  omitData(query.body, "task artifact base URL must not contain a query or fragment");

  const userinfo = await put("TaskPublicAddress", "https://user:secret@media.example.com/tasks");
  omitData(userinfo.body, "task artifact base URL must contain a host and no userinfo");

  await store.setOption("GitHubClientId", "gh-client");
  const githubOk = await put("GitHubOAuthEnabled", "true");
  omitDataOk(githubOk.body);

  const themeOk = await put("theme.frontend", "default");
  omitDataOk(themeOk.body);

  const addrOk = await put("TaskPublicAddress", "https://media.example.com/task-content");
  omitDataOk(addrOk.body);

  const telegram = await put("TelegramOAuthEnabled", "true");
  assert.equal(telegram.body.success, false);
  assert.equal(telegram.body.code, "TELEGRAM_OAUTH_NOT_CONFIGURED");
  assert.equal("data" in telegram.body, false);
});
