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

test("original UpdateOption CheckGroupRatio gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  async function put(value: string) {
    return json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key: "GroupRatio", value }),
      }),
      e,
    );
  }

  const neg = await put(JSON.stringify({ default: 1, vip: -0.1 }));
  omitData(neg.body, "group ratio must be not less than 0: vip");

  const arr = await put("[]");
  omitData(arr.body, "json: cannot unmarshal array into Go value of type map[string]float64");

  const str = await put(JSON.stringify({ vip: "1" }));
  omitData(str.body, "json: cannot unmarshal string into Go value of type float64");

  const invalid = await put("not-json");
  omitData(invalid.body, "invalid character 'o' looking for beginning of value");

  const ok = await put(JSON.stringify({ default: 1, vip: 0, svip: 1.5 }));
  omitDataOk(ok.body);
  assert.equal(await new Store(e.DB).option("GroupRatio"), JSON.stringify({ default: 1, vip: 0, svip: 1.5 }));
});

test("original UpdateOption Image/Audio/CreateCache ratio and status-code gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  async function put(key: string, value: string) {
    return json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key, value }),
      }),
      e,
    );
  }

  const unmarshalArr = "json: cannot unmarshal array into Go value of type map[string]float64";
  const image = await put("ImageRatio", "[]");
  omitData(image.body, "图片倍率设置失败: " + unmarshalArr);

  const audio = await put("AudioRatio", "[]");
  omitData(audio.body, "音频倍率设置失败: " + unmarshalArr);

  const audioComp = await put("AudioCompletionRatio", "[]");
  omitData(audioComp.body, "音频补全倍率设置失败: " + unmarshalArr);

  const cache = await put("CreateCacheRatio", "[]");
  omitData(cache.body, "缓存创建倍率设置失败: " + unmarshalArr);

  const notObj = await put("ImageRatio", JSON.stringify({ "gpt-image-1": "2" }));
  omitData(notObj.body, "图片倍率设置失败: json: cannot unmarshal string into Go value of type float64");

  const imageOk = await put("ImageRatio", JSON.stringify({ "gpt-image-1": 2 }));
  omitDataOk(imageOk.body);
  assert.equal(await store.option("ImageRatio"), JSON.stringify({ "gpt-image-1": 2 }));

  const disableBad = await put("AutomaticDisableStatusCodes", "abc");
  omitData(disableBad.body, "invalid http status code rules: abc");

  const retryBad = await put("AutomaticRetryStatusCodes", "200-abc");
  omitData(retryBad.body, "invalid http status code rules: 200-abc");

  const disableOk = await put("AutomaticDisableStatusCodes", "401,429");
  omitDataOk(disableOk.body);
  assert.equal(await store.option("AutomaticDisableStatusCodes"), "401,429");
});

test("original UpdateOption gemini/claude/tool-price gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  async function put(key: string, value: string) {
    return json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ key, value }),
      }),
      e,
    );
  }

  const geminiNull = await put("gemini.safety_settings", "null");
  omitData(geminiNull.body, "Gemini safety settings must be a JSON string map");

  const geminiArr = await put("gemini.safety_settings", "[]");
  omitData(
    geminiArr.body,
    "Gemini safety settings must be a JSON string map: json: cannot unmarshal array into Go value of type map[string]string",
  );

  const geminiBad = await put("gemini.safety_settings", JSON.stringify({ default: "NOPE" }));
  omitData(geminiBad.body, 'invalid Gemini safety threshold "NOPE" for "default"');

  const geminiOk = await put("gemini.safety_settings", JSON.stringify({ default: "OFF" }));
  omitDataOk(geminiOk.body);
  assert.equal(await store.option("gemini.safety_settings"), JSON.stringify({ default: "OFF" }));

  const claudeNull = await put("claude.default_max_tokens", "null");
  omitData(claudeNull.body, "Claude default max tokens must be a JSON map of model to integer");

  const claudeArr = await put("claude.default_max_tokens", "[]");
  omitData(
    claudeArr.body,
    "Claude default max tokens must be a JSON map of model to integer: json: cannot unmarshal array into Go value of type map[string]int",
  );

  const claudeFrac = await put("claude.default_max_tokens", JSON.stringify({ default: 1.5 }));
  omitData(
    claudeFrac.body,
    "Claude default max tokens must be a JSON map of model to integer: json: cannot unmarshal number 1.5 into Go value of type int",
  );

  const claudeNeg = await put("claude.default_max_tokens", JSON.stringify({ default: -1 }));
  omitData(claudeNeg.body, 'negative Claude default max_tokens -1 for "default"');

  const claudeOk = await put("claude.default_max_tokens", JSON.stringify({ default: 8192 }));
  omitDataOk(claudeOk.body);
  assert.equal(await store.option("claude.default_max_tokens"), JSON.stringify({ default: 8192 }));

  const pricesArr = await put("tool_price_setting.prices", "[]");
  omitData(pricesArr.body, "工具价格必须是 JSON 对象");

  const pricesStr = await put("tool_price_setting.prices", JSON.stringify({ x: "1" }));
  omitData(pricesStr.body, '工具价格 "x" 必须是非负数字');

  const pricesNeg = await put("tool_price_setting.prices", JSON.stringify({ x: -1 }));
  omitData(pricesNeg.body, '工具价格 "x" 必须是有限的非负数字');

  const pricesOk = await put("tool_price_setting.prices", JSON.stringify({ priced_fn: 5 }));
  omitDataOk(pricesOk.body);
  assert.equal(await store.option("tool_price_setting.prices"), JSON.stringify({ priced_fn: 5 }));
});
