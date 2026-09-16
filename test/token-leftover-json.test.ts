import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { e, auth };
}

async function createToken(e: Env, auth: Record<string, string>, body: Record<string, unknown>) {
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return created.body.data as { id: number; key: string };
}

test("original AddToken leftover ApiErrorI18n / max-tokens gin.H omit data", async () => {
  const { e, auth } = await boot();

  const tooLong = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "n".repeat(51), remain_quota: 1, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(tooLong.res.status, 200);
  omitData(tooLong.body, "Token name is too long");

  const tooLongZh = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ name: "n".repeat(51), remain_quota: 1, unlimited_quota: false }),
    }),
    e,
  );
  omitData(tooLongZh.body, "令牌名称过长");

  const negative = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "neg", remain_quota: -1, unlimited_quota: false }),
    }),
    e,
  );
  omitData(negative.body, "Quota value cannot be negative");

  const autoDup = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "auto-dup", group: "auto", auto_groups: ["default", "default"] }),
    }),
    e,
  );
  omitData(autoDup.body, "Auto group default is duplicated");

  const autoInvalid = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "auto-bad", group: "auto", auto_groups: ["missing-group"] }),
    }),
    e,
  );
  omitData(autoInvalid.body, "Auto group missing-group is unavailable or unauthorized");

  const cap = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "token_setting.max_user_tokens", value: "0" }),
    }),
    e,
  );
  assert.equal(cap.body.success, true, String(cap.body.message));
  const maxed = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "over-cap", unlimited_quota: true }),
    }),
    e,
  );
  omitData(maxed.body, "已达到最大令牌数量限制 (0)");
});

test("original GetToken / GetTokenKey leftover ApiError gin.H omit data", async () => {
  const { e, auth } = await boot();

  const badGet = await json(new Request("http://local/api/token/abc", { headers: auth }), e);
  assert.equal(badGet.res.status, 200);
  omitData(badGet.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const zeroGet = await json(new Request("http://local/api/token/0", { headers: auth }), e);
  omitData(zeroGet.body, "id 或 userId 为空！");

  const missingGet = await json(new Request("http://local/api/token/999999", { headers: auth }), e);
  omitData(missingGet.body, "record not found");

  const badKey = await json(new Request("http://local/api/token/abc/key", { method: "POST", headers: auth }), e);
  omitData(badKey.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const zeroKey = await json(new Request("http://local/api/token/0/key", { method: "POST", headers: auth }), e);
  omitData(zeroKey.body, "id 或 userId 为空！");

  const missingKey = await json(new Request("http://local/api/token/999999/key", { method: "POST", headers: auth }), e);
  omitData(missingKey.body, "record not found");
});

test("original UpdateToken leftover GetTokenByIds / enable gin.H omit data", async () => {
  const { e, auth } = await boot();

  for (const body of [JSON.stringify({}), JSON.stringify({ id: 0 }), JSON.stringify(null), ""]) {
    const res = await json(
      new Request("http://local/api/token/", {
        method: "PUT",
        headers: auth,
        body,
      }),
      e,
    );
    assert.equal(res.res.status, 200, String(body));
    omitData(res.body, "id 或 userId 为空！");
  }

  const missing = await json(
    new Request("http://local/api/token/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: 999999, name: "missing" }),
    }),
    e,
  );
  omitData(missing.body, "record not found");

  const expiredTok = await createToken(e, auth, { name: "expired", remain_quota: 10, unlimited_quota: false, expired_time: 1 });
  const markExpired = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: expiredTok.id, status: 3 }),
    }),
    e,
  );
  assert.equal(markExpired.body.success, true, String(markExpired.body.message));
  const enableExpired = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: expiredTok.id, status: 1 }),
    }),
    e,
  );
  omitData(
    enableExpired.body,
    "Token has expired and cannot be enabled. Please modify the expiration time or set it to never expire",
  );
  const enableExpiredZh = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ id: expiredTok.id, status: 1 }),
    }),
    e,
  );
  omitData(enableExpiredZh.body, "令牌已过期，无法启用，请先修改令牌过期时间，或者设置为永不过期");

  const exhaustedTok = await createToken(e, auth, { name: "exhausted", remain_quota: 0, unlimited_quota: false });
  const markExhausted = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: exhaustedTok.id, status: 4 }),
    }),
    e,
  );
  assert.equal(markExhausted.body.success, true, String(markExhausted.body.message));
  const enableExhausted = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: exhaustedTok.id, status: 1 }),
    }),
    e,
  );
  omitData(
    enableExhausted.body,
    "Token quota is exhausted and cannot be enabled. Please modify the remaining quota or set it to unlimited",
  );
});

test("original DeleteToken leftover ApiError gin.H omit data", async () => {
  const { e, auth } = await boot();

  const bad = await json(new Request("http://local/api/token/abc/", { method: "DELETE", headers: auth }), e);
  assert.equal(bad.res.status, 200);
  omitData(bad.body, "id 或 userId 为空！");

  const zero = await json(new Request("http://local/api/token/0/", { method: "DELETE", headers: auth }), e);
  omitData(zero.body, "id 或 userId 为空！");

  const missing = await json(new Request("http://local/api/token/999999/", { method: "DELETE", headers: auth }), e);
  omitData(missing.body, "record not found");

  const created = await createToken(e, auth, { name: "del-ok", unlimited_quota: true });
  const deleted = await json(new Request("http://local/api/token/" + created.id + "/", { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.body.success, true);
  assert.equal(deleted.body.message, "");
  assert.equal("data" in deleted.body, false);
  assert.deepEqual(Object.keys(deleted.body).sort(), ["message", "success"]);
});

test("original DeleteTokenBatch / GetTokenKeysBatch leftover ApiErrorI18n gin.H omit data", async () => {
  const { e, auth } = await boot();

  for (const path of ["/api/token/batch", "/api/token/batch/keys"]) {
    for (const body of ["", JSON.stringify({}), JSON.stringify({ ids: [] }), JSON.stringify({ ids: null }), JSON.stringify(null)]) {
      const res = await json(
        new Request("http://local" + path, {
          method: "POST",
          headers: auth,
          body,
        }),
        e,
      );
      assert.equal(res.res.status, 200, path + " " + String(body));
      omitData(res.body, "Invalid parameters");
    }
    const zh = await json(
      new Request("http://local" + path, {
        method: "POST",
        headers: { ...auth, "accept-language": "zh-CN" },
        body: JSON.stringify({ ids: [] }),
      }),
      e,
    );
    omitData(zh.body, "无效的参数");
  }

  const tooMany = await json(
    new Request("http://local/api/token/batch/keys", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }),
    }),
    e,
  );
  omitData(tooMany.body, "Too many items in batch request, maximum is 100");

  const tooManyZh = await json(
    new Request("http://local/api/token/batch/keys", {
      method: "POST",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }),
    }),
    e,
  );
  omitData(tooManyZh.body, "批量请求数量过多，最多 100 条");
});

test("original SearchUserTokens leftover ApiError gin.H omit data", async () => {
  const { e, auth } = await boot();
  await createToken(e, auth, { name: "alpha", unlimited_quota: true });
  await createToken(e, auth, { name: "beta", unlimited_quota: true });
  const cap = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "token_setting.max_user_tokens", value: "1" }),
    }),
    e,
  );
  assert.equal(cap.body.success, true, String(cap.body.message));
  const fuzzy = await json(
    new Request("http://local/api/token/search?keyword=" + encodeURIComponent("%al%"), { headers: auth }),
    e,
  );
  assert.equal(fuzzy.res.status, 200);
  omitData(fuzzy.body, "令牌数量超过上限，仅允许精确搜索，请勿使用 % 通配符");
});
