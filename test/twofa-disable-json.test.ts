import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { totpCode } from "../src/totp.js";
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

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function rotationKeys(data: Record<string, unknown>) {
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.token_type, "Bearer");
  assert.equal(typeof data.access_expires_at, "number");
  assert.equal(typeof (data.session as { sid: string }).sid, "string");
  assert.equal("user" in data, false);
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

async function passwordProof(e: Env, auth: Record<string, string>, scope: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function twoFAProof(e: Env, auth: Record<string, string>, scope: string, secret: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope, code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function enableTwoFA(e: Env, auth: Record<string, string>): Promise<{ secret: string; auth: Record<string, string> }> {
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  const started = setup.body.data as { secret: string; flow_token: string };
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(started.secret), flow_token: started.flow_token }),
    }),
    e,
  );
  assert.equal(en.body.success, true, String(en.body.message));
  const token = (en.body.data as { access_token: string }).access_token;
  return { secret: started.secret, auth: { authorization: "Bearer " + token, "content-type": "application/json" } };
}

test("original Disable2FA authRotationData gin.H omits user", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const enabled = await enableTwoFA(e, auth);
  const proof = await twoFAProof(e, enabled.auth, "2fa.disable", enabled.secret);
  const disabled = await json(
    new Request("http://local/api/user/2fa/disable", {
      method: "POST",
      headers: { ...enabled.auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  assert.equal(disabled.body.message, "两步验证已禁用");
  const data = disabled.body.data as Record<string, unknown>;
  rotationKeys(data);
  assert.equal("backup_codes" in data, false);

  const nextAuth = { authorization: "Bearer " + data.access_token, "content-type": "application/json" };
  const status = await json(new Request("http://local/api/user/2fa/status", { headers: nextAuth }), e);
  assert.deepEqual(status.body.data, { enabled: false, locked: false });
});

test("original RegenerateBackupCodes authRotationData gin.H includes backup_codes", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const enabled = await enableTwoFA(e, auth);
  const proof = await twoFAProof(e, enabled.auth, "2fa.backup_codes.regenerate", enabled.secret);
  const regen = await json(
    new Request("http://local/api/user/2fa/backup_codes", {
      method: "POST",
      headers: { ...enabled.auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(regen.body.success, true, String(regen.body.message));
  assert.equal(regen.body.message, "备用码重新生成成功");
  const data = regen.body.data as Record<string, unknown> & { backup_codes: string[] };
  rotationKeys(data);
  assert.equal(data.backup_codes.length, 4);
  for (const code of data.backup_codes) assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(Object.keys(data).sort(), ["access_expires_at", "access_token", "backup_codes", "session", "token_type"]);

  const nextAuth = { authorization: "Bearer " + data.access_token, "content-type": "application/json" };
  const status = await json(new Request("http://local/api/user/2fa/status", { headers: nextAuth }), e);
  assert.equal((status.body.data as { backup_codes_remaining: number }).backup_codes_remaining, 4);
});

test("original AdminDisable2FA ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  for (const id of ["invalid", "0", "-1"]) {
    const bad = await json(new Request("http://local/api/user/" + id + "/2fa", { method: "DELETE", headers: auth }), e);
    assert.equal(bad.res.status, 200);
    omitData(bad.body, "用户ID格式错误");
  }

  const missing = await json(new Request("http://local/api/user/999/2fa", { method: "DELETE", headers: auth }), e);
  omitData(missing.body, "User does not exist");
  const missingZh = await json(
    new Request("http://local/api/user/999/2fa", {
      method: "DELETE",
      headers: { ...auth, "accept-language": "zh-CN" },
    }),
    e,
  );
  omitData(missingZh.body, "用户不存在");
  const missingTw = await json(
    new Request("http://local/api/user/999/2fa", {
      method: "DELETE",
      headers: { ...auth, "accept-language": "zh-TW" },
    }),
    e,
  );
  omitData(missingTw.body, "使用者不存在");

  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "member1", password: "password12", role: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const users = await json(new Request("http://local/api/user/", { headers: auth }), e);
  const member = (users.body.data as { items: { id: number; username: string }[] }).items.find((u) => u.username === "member1");
  assert.ok(member);
  const unused = await json(
    new Request("http://local/api/user/" + member.id + "/2fa", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(unused.body, "用户未启用2FA");

  const store = new Store(e.DB);
  await store.updateUser(member.id, { totp_enabled: 1, totp_secret: "JBSWY3DPEHPK3PXP" });
  const ok = await json(
    new Request("http://local/api/user/" + member.id + "/2fa", { method: "DELETE", headers: auth }),
    e,
  );
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "用户2FA已被强制禁用");
  assert.equal("data" in ok.body, false);
  assert.deepEqual(Object.keys(ok.body).sort(), ["message", "success"]);
  const fresh = await store.getUserById(member.id);
  assert.equal(Number(fresh?.totp_enabled), 0);

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "admin1", password: "password12", role: 1 }),
    }),
    e,
  );
  const all = await json(new Request("http://local/api/user/", { headers: auth }), e);
  const adminUser = (all.body.data as { items: { id: number; username: string }[] }).items.find((u) => u.username === "admin1");
  assert.ok(adminUser);
  await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: adminUser.id, action: "promote" }),
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
  const forbidden = await json(new Request("http://local/api/user/1/2fa", { method: "DELETE", headers: adminAuth }), e);
  omitData(forbidden.body, "无权操作同级或更高级用户的2FA设置");
});
