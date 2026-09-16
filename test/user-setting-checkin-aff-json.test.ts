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

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
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
  const userId = (login.body.data as { user: { id: number } }).user.id;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { e, auth, userId };
}

test("original GetCheckinStatus / DoCheckin leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const disabledGet = await json(new Request("http://local/api/user/checkin", { headers: auth }), e);
  assert.equal(disabledGet.res.status, 200);
  omitData(disabledGet.body, "签到功能未启用");

  const disabledPost = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  omitData(disabledPost.body, "签到功能未启用");

  const enable = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "checkin_setting.enabled", value: "true" }),
    }),
    e,
  );
  assert.equal(enable.body.success, true, String(enable.body.message));

  const status = await json(new Request("http://local/api/user/checkin", { headers: auth }), e);
  assert.equal(status.res.status, 200);
  assert.equal(status.body.success, true);
  assert.equal("message" in status.body, false);
  assert.deepEqual(Object.keys(status.body).sort(), ["data", "success"]);
  assert.equal((status.body.data as { enabled: boolean }).enabled, true);

  const doCk = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  assert.equal(doCk.body.success, true, String(doCk.body.message));
  assert.equal(doCk.body.message, "签到成功");

  const again = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  omitData(again.body, "今日已签到");
});

test("original UpdateUserSetting leftover ApiErrorI18n gin.H omit data", async () => {
  const { e, auth } = await boot();

  const empty = await json(new Request("http://local/api/user/setting", { method: "PUT", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "Invalid parameters");

  const emptyZh = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
    }),
    e,
  );
  omitData(emptyZh.body, "无效的参数");

  const type = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "sms", quota_warning_threshold: 1 }),
    }),
    e,
  );
  omitData(type.body, "Invalid warning type");
  const typeZh = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ notify_type: "sms", quota_warning_threshold: 1 }),
    }),
    e,
  );
  omitData(typeZh.body, "无效的预警类型");

  const threshold = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "email", quota_warning_threshold: 0 }),
    }),
    e,
  );
  omitData(threshold.body, "Warning threshold must be greater than 0");

  const webhookEmpty = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "webhook", quota_warning_threshold: 1, webhook_url: "" }),
    }),
    e,
  );
  omitData(webhookEmpty.body, "Webhook URL cannot be empty");

  const webhookInvalid = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "webhook", quota_warning_threshold: 1, webhook_url: "not a url" }),
    }),
    e,
  );
  omitData(webhookInvalid.body, "Invalid Webhook URL");

  const emailInvalid = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "email", quota_warning_threshold: 1, notification_email: "nope" }),
    }),
    e,
  );
  omitData(emailInvalid.body, "Invalid email address");

  const barkEmpty = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "bark", quota_warning_threshold: 1 }),
    }),
    e,
  );
  omitData(barkEmpty.body, "Bark push URL cannot be empty");

  const barkScheme = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "bark", quota_warning_threshold: 1, bark_url: "ftp://bark.example/push" }),
    }),
    e,
  );
  omitData(barkScheme.body, "URL must start with http:// or https://");

  const gotifyToken = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "gotify", quota_warning_threshold: 1, gotify_url: "https://gotify.example" }),
    }),
    e,
  );
  omitData(gotifyToken.body, "Gotify token cannot be empty");

  const saved = await json(
    new Request("http://local/api/user/setting", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ notify_type: "email", quota_warning_threshold: 1000, record_ip_log: true }),
    }),
    e,
  );
  assert.equal(saved.body.success, true);
  assert.equal(saved.body.message, "Settings updated");
  assert.equal(saved.body.data, null);
});

test("original TransferAffQuota leftover ApiError / ApiErrorI18n gin.H omit data", async () => {
  const { e, auth, userId } = await boot();
  await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: true }),
    }),
    e,
  );

  const eof = await json(new Request("http://local/api/user/aff_transfer", { method: "POST", headers: auth }), e);
  assert.equal(eof.res.status, 200);
  omitData(eof.body, "EOF");

  const required = await json(
    new Request("http://local/api/user/aff_transfer", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  omitData(
    required.body,
    "Key: 'TransferAffQuotaRequest.Quota' Error:Field validation for 'Quota' failed on the 'required' tag",
  );

  const min = await json(
    new Request("http://local/api/user/aff_transfer", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ quota: 1 }),
    }),
    e,
  );
  omitData(min.body, "Transfer failed 转移额度最小为＄1.000000 额度！");

  const minZh = await json(
    new Request("http://local/api/user/aff_transfer", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ quota: 1 }),
    }),
    e,
  );
  omitData(minZh.body, "划转失败 转移额度最小为＄1.000000 额度！");

  const s = new Store(e.DB);
  await s.updateUser(userId, { aff_quota: 100 });
  const short = await json(
    new Request("http://local/api/user/aff_transfer", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ quota: 500000 }),
    }),
    e,
  );
  omitData(short.body, "Transfer failed 邀请额度不足！");

  const shortZh = await json(
    new Request("http://local/api/user/aff_transfer", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ quota: 500000 }),
    }),
    e,
  );
  omitData(shortZh.body, "划转失败 邀请额度不足！");
});
