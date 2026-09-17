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
  await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: true }),
    }),
    e,
  );
  return { auth };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

test("original AddRedemption/GetRedemption/DeleteRedemption/TopUp ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await json(new Request("http://local/api/redemption/", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "EOF");

  const notObject = await json(
    new Request("http://local/api/redemption/", { method: "POST", headers: auth, body: JSON.stringify([]) }),
    e,
  );
  omitData(notObject.body, "json: cannot unmarshal array into Go value of type model.Redemption");

  const emptyName = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "", quota: 1, count: 1 }),
    }),
    e,
  );
  omitData(emptyName.body, "Redemption code name length must be between 1-20");

  const zhName = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ name: "", quota: 1, count: 1 }),
    }),
    e,
  );
  omitData(zhName.body, "兑换码名称长度必须在1-20之间");

  const noCount = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 1 }),
    }),
    e,
  );
  omitData(noCount.body, "Redemption code count must be greater than 0");

  const tooMany = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 1, count: 101 }),
    }),
    e,
  );
  omitData(tooMany.body, "Maximum 100 redemption codes can be generated at once");

  const noQuota = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", count: 1 }),
    }),
    e,
  );
  omitData(noQuota.body, "redemption quota must be positive");

  const getBad = await json(new Request("http://local/api/redemption/abc", { headers: auth }), e);
  omitData(getBad.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const getZero = await json(new Request("http://local/api/redemption/0", { headers: auth }), e);
  omitData(getZero.body, "id 为空！");

  const getMissing = await json(new Request("http://local/api/redemption/999", { headers: auth }), e);
  omitData(getMissing.body, "record not found");

  const delZero = await json(new Request("http://local/api/redemption/0/", { method: "DELETE", headers: auth }), e);
  omitData(delZero.body, "id 为空！");

  const delBad = await json(new Request("http://local/api/redemption/abc/", { method: "DELETE", headers: auth }), e);
  omitData(delBad.body, "id 为空！");

  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ok", quota: 10, count: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const id = Number(((listed.body.data as { items: { id: number }[] }).items || [])[0]?.id);
  assert.ok(id);

  const deleted = await json(new Request("http://local/api/redemption/" + id + "/", { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.body.success, true);
  assert.equal(deleted.body.message, "");
  assert.equal("data" in deleted.body, false);
  assert.deepEqual(Object.keys(deleted.body).sort(), ["message", "success"]);

  const emptyTopup = await json(new Request("http://local/api/user/topup", { method: "POST", headers: auth }), e);
  omitData(emptyTopup.body, "EOF");

  const badKey = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: "nope" }),
    }),
    e,
  );
  omitData(badKey.body, "Redemption failed, please try again later");

  const zhRedeem = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ key: "nope" }),
    }),
    e,
  );
  omitData(zhRedeem.body, "兑换失败，请稍后重试");
});

test("original DeleteRedemptionBatch ApiErrorI18n gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await json(new Request("http://local/api/redemption/batch", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "Invalid parameters");

  const zh = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ ids: [] }),
    }),
    e,
  );
  omitData(zh.body, "无效的参数");

  const emptyIds = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [] }),
    }),
    e,
  );
  omitData(emptyIds.body, "Invalid parameters");

  const zeroId = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [0] }),
    }),
    e,
  );
  omitData(zeroId.body, "Invalid parameters");

  const tooMany = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: Array.from({ length: 1001 }, (_, i) => i + 1) }),
    }),
    e,
  );
  omitData(tooMany.body, "Invalid parameters");

  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "batch", quota: 10, count: 2 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const ids = ((listed.body.data as { items: { id: number }[] }).items || []).map((row) => row.id);
  assert.equal(ids.length >= 2, true);

  const ok = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: ids.slice(0, 2) }),
    }),
    e,
  );
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "");
  assert.equal(ok.body.data, 2);
});
