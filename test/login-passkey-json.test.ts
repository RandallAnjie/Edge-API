import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION } from "../src/auth.js";
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

function securityOp(body: Record<string, unknown>, code: string, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
}

function setCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
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

async function enableTwoFA(e: Env, auth: Record<string, string>): Promise<string> {
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  const secret = (setup.body.data as { secret: string; flow_token: string }).secret;
  const flowToken = (setup.body.data as { flow_token: string }).flow_token;
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(secret), flow_token: flowToken }),
    }),
    e,
  );
  assert.equal(en.body.success, true, String(en.body.message));
  return secret;
}

async function enablePasskey(e: Env, auth: Record<string, string>) {
  const r = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "passkey.enabled", value: "true" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message));
}

async function passwordLoginChallenge(e: Env) {
  const challenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(challenge.body.success, true, String(challenge.body.message));
  return challenge.body.data as {
    require_verification: boolean;
    flow_token: string;
    methods: { method: string; available: boolean }[];
  };
}

test("original LoginPasskeyBegin DecodeJson / leftover messages gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enableTwoFA(e, auth);

  const empty = await json(new Request("http://local/api/user/login/passkey/begin", { method: "POST" }), e);
  omitData(empty.body, "参数错误");
  const badJson = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    e,
  );
  omitData(badJson.body, "参数错误");
  const missing = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    e,
  );
  omitData(missing.body, "参数错误");
  const numbered = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: 1 }),
    }),
    e,
  );
  omitData(numbered.body, "参数错误");

  const stale = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: "missing" }),
    }),
    e,
  );
  assert.equal(stale.res.status, 200);
  securityOp(stale.body, "AUTH_FLOW_INVALID", "Verification flow expired");

  const ch = await passwordLoginChallenge(e);
  assert.ok(ch.methods.some((m) => m.method === "2fa" && m.available));
  const noPasskey = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token }),
    }),
    e,
  );
  securityOp(noPasskey.body, "SECURITY_PROOF_METHOD_MISMATCH", "This verification method is not allowed for this action.");
  assert.equal(noPasskey.body.message === "未绑定 Passkey", false);
  assert.equal(stale.body.message === "登录流程已过期", false);
});

test("original LoginPasskeyBegin SECURITY_METHOD_UNAVAILABLE gin.H omits data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enableTwoFA(e, auth);
  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.insertPasskey(root.id, "cred-root", "pubkey", "device", "");

  const ch = await passwordLoginChallenge(e);
  assert.ok(ch.methods.some((m) => m.method === "passkey" && !m.available));
  const disabled = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token }),
    }),
    e,
  );
  securityOp(disabled.body, "SECURITY_METHOD_UNAVAILABLE", "This verification method is currently unavailable.");
});

test("original LoginPasskeyFinish DecodeJson / AUTH_FLOW_INVALID / writeLoginResponse gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enablePasskey(e, auth);
  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.insertPasskey(root.id, "cred-root", "pubkey", "device", "");

  const empty = await json(new Request("http://local/api/user/login/passkey/finish", { method: "POST" }), e);
  omitData(empty.body, "参数错误");
  const missingCred = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: "x", passkey_flow_token: "y" }),
    }),
    e,
  );
  omitData(missingCred.body, "参数错误");

  const ch = await passwordLoginChallenge(e);
  assert.ok(ch.methods.some((m) => m.method === "passkey" && m.available));
  const begin = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token }),
    }),
    e,
  );
  assert.equal(begin.body.success, true, String(begin.body.message));
  const started = begin.body.data as { flow_token: string; expires_at: number; options: { userVerification: string }; rp_ids: string[] };
  assert.equal(typeof started.flow_token, "string");
  assert.equal(typeof started.expires_at, "number");
  assert.equal(started.options.userVerification, "required");
  assert.equal(Array.isArray(started.rp_ids), true);
  assert.equal("flow_id" in started, false);
  assert.equal("publicKey" in started, false);
  const stored = await e.DB.prepare("SELECT type FROM auth_flows WHERE token = ?")
    .bind(started.flow_token)
    .first<{ type: string }>();
  assert.equal(stored?.type, "login_passkey");

  const missingPasskeyFlow = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: ch.flow_token,
        passkey_flow_token: "missing",
        credential: { id: "cred-root" },
      }),
    }),
    e,
  );
  securityOp(missingPasskeyFlow.body, "AUTH_FLOW_INVALID", "Verification flow expired");
  assert.equal(missingPasskeyFlow.body.message === "流程无效", false);

  const nullCred = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: ch.flow_token,
        passkey_flow_token: started.flow_token,
        credential: null,
      }),
    }),
    e,
  );
  securityOp(nullCred.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");
  assert.equal(nullCred.body.message === "凭证无效", false);

  const wrongCred = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: ch.flow_token,
        passkey_flow_token: started.flow_token,
        credential: { id: "other-cred" },
      }),
    }),
    e,
  );
  securityOp(wrongCred.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");

  const replayBegin = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token }),
    }),
    e,
  );
  const replayToken = (replayBegin.body.data as { flow_token: string }).flow_token;
  const done = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: ch.flow_token,
        passkey_flow_token: replayToken,
        credential: { id: "cred-root" },
      }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  assert.equal(done.body.message, "");
  const data = done.body.data as { access_token: string; session: { login_method: string }; user: { username: string } };
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.session.login_method, "password");
  assert.equal(data.user.username, "root");
  assert.ok(setCookies(done.res).some((c) => c.toLowerCase().includes("new_api")));

  const parent = await e.DB.prepare("SELECT type FROM auth_flows WHERE token = ?")
    .bind(ch.flow_token)
    .first<{ type: string }>();
  assert.equal(parent?.type, AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION);
  const replay = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: ch.flow_token,
        passkey_flow_token: replayToken,
        credential: { id: "cred-root" },
      }),
    }),
    e,
  );
  securityOp(replay.body, "AUTH_FLOW_INVALID", "Verification flow expired");
  assert.equal(setCookies(replay.res).length, 0);
});
