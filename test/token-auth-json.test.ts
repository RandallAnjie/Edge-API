import assert from "node:assert/strict";
import { test } from "node:test";
import { generateTokenKey } from "../src/crypto.js";
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

async function createSk(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ id: number; key: string }> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  const data = tok.body.data as { id: number; key: string };
  return { id: data.id, key: data.key };
}

function assertAbort(
  hit: { res: Response; body: Record<string, unknown>; text: string },
  status: number,
  message: string,
  code: string,
  requestId: string,
) {
  assert.equal(hit.res.status, status, hit.text);
  const err = hit.body.error as { message?: string; type?: string; code?: unknown; param?: unknown };
  assert.ok(err, hit.text);
  assert.deepEqual(Object.keys(err).sort(), ["code", "message", "type"]);
  assert.equal(err.type, "new_api_error");
  assert.equal(err.code, code);
  assert.equal(err.message, `${message} (request id: ${requestId})`);
}

test("original TokenAuth abortWithOpenAiMessage JSON for missing, invalid, disabled, expired, and exhausted keys", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const rid = "token-auth-req";

  const missing = await json(
    new Request("http://local/v1/models", { headers: { "x-oneapi-request-id": rid } }),
    e,
  );
  assertAbort(missing, 401, "Invalid token", "", rid);

  const zh = await json(
    new Request("http://local/v1/models", {
      headers: { "accept-language": "zh-CN", "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(zh, 401, "无效的令牌", "", rid);

  const zhTw = await json(
    new Request("http://local/v1/models", {
      headers: { "accept-language": "zh-TW", "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(zhTw, 401, "無效的令牌", "", rid);

  const bogus = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer sk-no-such-token", "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(bogus, 401, "Invalid token", "", rid);

  const disabled = await createSk(e, auth, { name: "disabled-auth", unlimited_quota: true });
  await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: disabled.id, status: 2 }),
    }),
    e,
  );
  const disabledHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + disabled.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(disabledHit, 401, "Invalid token", "", rid);

  const expired = await createSk(e, auth, { name: "expired-auth", unlimited_quota: true, expired_time: 1 });
  const expiredHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + expired.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(expiredHit, 401, "Invalid token", "", rid);

  const zeroExpiry = await createSk(e, auth, { name: "zero-expiry", unlimited_quota: true, expired_time: 0 });
  const zeroHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + zeroExpiry.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(zeroHit, 401, "Invalid token", "", rid);

  const exhausted = await createSk(e, auth, { name: "exhausted-auth", remain_quota: 0, unlimited_quota: false });
  const exhaustedHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + exhausted.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(exhaustedHit, 401, "Invalid token", "", rid);

  const exhaustedStatus = await createSk(e, auth, { name: "exhausted-status", remain_quota: 10, unlimited_quota: false });
  await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: exhaustedStatus.id, status: 4 }),
    }),
    e,
  );
  const exhaustedStatusHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + exhaustedStatus.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(exhaustedStatusHit, 401, "Invalid token", "", rid);
});

test("original TokenAuth abortWithOpenAiMessage JSON for banned user, missing user, IP, group, and pin", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const rid = "token-auth-req";
  const store = new Store(e.DB);

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "bannedauth", password: "password12", display_name: "bannedauth" }),
    }),
    e,
  );
  const bannedLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bannedauth", password: "password12" }),
    }),
    e,
  );
  const bannedAuth = {
    authorization: "Bearer " + (bannedLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const bannedTk = await createSk(e, bannedAuth, { name: "banned-token", unlimited_quota: true });
  const bannedUser = await e.DB.prepare("SELECT id FROM users WHERE username = ?").bind("bannedauth").first<{ id: number }>();
  assert.ok(bannedUser);
  await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: bannedUser.id, action: "disable" }),
    }),
    e,
  );
  const bannedHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + bannedTk.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(bannedHit, 403, "User has been banned", "", rid);
  const bannedZh = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer " + bannedTk.key,
        "accept-language": "zh-CN",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assertAbort(bannedZh, 403, "用户已被封禁", "", rid);

  const orphanKey = generateTokenKey();
  await store.insertToken({
    user_id: 424242,
    key: orphanKey,
    name: "orphan",
    unlimited_quota: 1,
    remain_quota: 0,
  });
  const orphanHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer sk-" + orphanKey, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(orphanHit, 500, "Database error, please contact the administrator", "", rid);
  const orphanZh = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer sk-" + orphanKey,
        "accept-language": "zh-TW",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assertAbort(orphanZh, 500, "資料庫出錯，請聯繫管理員", "", rid);

  const ipTk = await createSk(e, auth, { name: "ip-token", unlimited_quota: true, allow_ips: "10.0.0.1" });
  const unparsed = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + ipTk.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(unparsed, 403, "无法解析客户端 IP 地址", "", rid);
  const badIp = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer " + ipTk.key,
        "x-real-ip": "not-an-ip",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assertAbort(badIp, 403, "无法解析客户端 IP 地址", "", rid);
  const deniedIp = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer " + ipTk.key,
        "x-real-ip": "10.0.0.2",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assertAbort(deniedIp, 403, "您的 IP 不在令牌允许访问的列表中", "access_denied", rid);
  const allowedIp = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer " + ipTk.key,
        "x-real-ip": "10.0.0.1",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assert.equal(allowedIp.res.status, 200, allowedIp.text);

  await store.setOption("UserUsableGroups", JSON.stringify({ default: "默认分组", vip: "vip分组", legacy: "legacy" }));
  const ghostTk = await createSk(e, auth, { name: "ghost-auth", unlimited_quota: true, group: "ghost" });
  const ghostHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + ghostTk.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(ghostHit, 403, "无权访问 ghost 分组", "", rid);
  const legacyTk = await createSk(e, auth, { name: "legacy-auth", unlimited_quota: true, group: "legacy" });
  const legacyHit = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + legacyTk.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(legacyHit, 403, "分组 legacy 已被弃用", "", rid);

  const pinTk = await createSk(e, auth, { name: "admin-pin", unlimited_quota: true });
  const invalidPin = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + pinTk.key + "-abc", "x-oneapi-request-id": rid },
    }),
    e,
  );
  assertAbort(invalidPin, 400, "Invalid channel ID", "", rid);
  const invalidPinZh = await json(
    new Request("http://local/v1/models", {
      headers: {
        authorization: "Bearer " + pinTk.key + "-abc",
        "accept-language": "zh-CN",
        "x-oneapi-request-id": rid,
      },
    }),
    e,
  );
  assertAbort(invalidPinZh, 400, "无效的渠道 Id", "", rid);
});

test("original distributor abortWithOpenAiMessage JSON for missing model and token model limits", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const rid = "token-auth-req";
  const sk = (await createSk(e, auth, { name: "relay-auth", unlimited_quota: true })).key;

  const missingModel = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + sk,
        "content-type": "application/json",
        "x-oneapi-request-id": rid,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assertAbort(missingModel, 400, "Model name not specified, model name cannot be empty", "", rid);
  const missingModelZh = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + sk,
        "content-type": "application/json",
        "accept-language": "zh-CN",
        "x-oneapi-request-id": rid,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assertAbort(missingModelZh, 400, "未指定模型名称，模型名称不能为空", "", rid);

  const emptyLimits = await createSk(e, auth, {
    name: "empty-limits",
    unlimited_quota: true,
    model_limits_enabled: true,
    model_limits: "",
  });
  const emptyForbidden = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + emptyLimits.key,
        "content-type": "application/json",
        "x-oneapi-request-id": rid,
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assertAbort(emptyForbidden, 403, "This token has no access to model gpt-4o-mini", "", rid);
});
