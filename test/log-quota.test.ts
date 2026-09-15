import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { logQuota } from "../src/quota.js";
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

test("original logger.LogQuota USD/CNY/TOKENS/CUSTOM strings", () => {
  assert.equal(logQuota(1000, 500000, "USD"), "＄0.002000 额度");
  assert.equal(logQuota(500000, 500000, "USD"), "＄1.000000 额度");
  assert.equal(logQuota(500000, 500000, "CNY", 7), "¥7.000000 额度");
  assert.equal(logQuota(42, 500000, "TOKENS"), "42 点额度");
  assert.equal(logQuota(500000, 500000, "CUSTOM", 1, "€", 0.9), "€0.900000 额度");
  assert.equal(logQuota(500000, 500000, "CUSTOM", 1, "", 0), "¤1.000000 额度");
});

test("original checkin and redemption RecordLog content uses LogQuota JSON", async () => {
  const { e, auth } = await boot();
  await putOption(e, auth, "checkin_setting.enabled", "true");
  await putOption(e, auth, "checkin_setting.min_quota", "1000");
  await putOption(e, auth, "checkin_setting.max_quota", "1000");
  const doCk = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  assert.equal(doCk.body.success, true, String(doCk.body.message));
  assert.equal((doCk.body.data as { quota_awarded: number }).quota_awarded, 1000);

  const logs = await json(new Request("http://local/api/log/self?type=4", { headers: auth }), e);
  const items = (logs.body.data as { items: { content: string; quota: number; type: number }[] }).items;
  const checkin = items.find((row) => String(row.content).startsWith("用户签到，获得额度 "));
  assert.ok(checkin);
  assert.equal(checkin.content, "用户签到，获得额度 ＄0.002000 额度");
  assert.equal(checkin.quota, 1000);
  assert.equal(checkin.type, 4);

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 500000, count: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const code = (created.body.data as string[])[0];
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const red = ((listed.body.data as { items: { id: number; key: string }[] }).items || []).find((row) => row.key === code);
  assert.ok(red);
  const redeemed = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: code }),
    }),
    e,
  );
  assert.equal(redeemed.body.success, true, String(redeemed.body.message));
  const topupLogs = await json(new Request("http://local/api/log/self?type=1", { headers: auth }), e);
  const topupItems = (topupLogs.body.data as { items: { content: string; quota: number }[] }).items;
  const redeemLog = topupItems.find((row) => String(row.content).startsWith("通过兑换码充值 "));
  assert.ok(redeemLog);
  assert.equal(redeemLog.content, `通过兑换码充值 ＄1.000000 额度，兑换码ID ${red.id}`);
  assert.equal(redeemLog.quota, 500000);
});

test("original checkin RecordLog content follows TOKENS LogQuota JSON", async () => {
  const { e, auth } = await boot();
  await putOption(e, auth, "general_setting.quota_display_type", "TOKENS");
  await putOption(e, auth, "checkin_setting.enabled", "true");
  await putOption(e, auth, "checkin_setting.min_quota", "2500");
  await putOption(e, auth, "checkin_setting.max_quota", "2500");
  const doCk = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  assert.equal(doCk.body.success, true, String(doCk.body.message));
  const logs = await json(new Request("http://local/api/log/self?type=4", { headers: auth }), e);
  const items = (logs.body.data as { items: { content: string }[] }).items;
  const checkin = items.find((row) => String(row.content).startsWith("用户签到，获得额度 "));
  assert.ok(checkin);
  assert.equal(checkin.content, "用户签到，获得额度 2500 点额度");
});
