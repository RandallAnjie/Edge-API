import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION } from "../src/auth.js";
import { USER_DISABLED, USER_ENABLED } from "../src/constants.js";
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
  return { token, auth, login };
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

test("original VerifyLogin JSON uses flow payload login_method and security error codes", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  const secret = await enableTwoFA(e, auth);

  const challenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(challenge.body.success, true);
  const ch = challenge.body.data as {
    require_verification: boolean;
    require_2fa: boolean;
    flow_token: string;
    expires_at: number;
    methods: { method: string; available: boolean }[];
  };
  assert.equal(ch.require_verification, true);
  assert.equal(ch.require_2fa, true);
  assert.ok(ch.methods.some((m) => m.method === "2fa" && m.available));
  const stored = await e.DB.prepare("SELECT type, payload FROM auth_flows WHERE token = ?")
    .bind(ch.flow_token)
    .first<{ type: string; payload: string }>();
  assert.equal(stored?.type, AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION);
  const payload = JSON.parse(stored?.payload || "{}") as { login_method: string; auth_version: number };
  assert.equal(payload.login_method, "password");
  assert.ok(payload.auth_version > 0);

  const invalidJson = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    e,
  );
  assert.equal(invalidJson.body.success, false);
  assert.equal(invalidJson.body.message, "参数错误");

  const missing = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "2fa" }),
    }),
    e,
  );
  assert.equal(missing.body.message, "参数错误");

  const wrongMethod = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token, method: "password", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(wrongMethod.body.success, false);
  assert.equal(wrongMethod.body.code, "SECURITY_PROOF_METHOD_MISMATCH");
  assert.equal(wrongMethod.body.message, "This verification method is not allowed for this action.");
  assert.equal(setCookies(wrongMethod.res).length, 0);

  const badCode = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token, method: "2fa", code: "000000" }),
    }),
    e,
  );
  assert.equal(badCode.body.success, false);
  assert.equal(badCode.body.code, "SECURITY_VERIFICATION_FAILED");
  assert.equal(badCode.body.message, "Verification failed. Please try again.");
  assert.equal(JSON.stringify(badCode.body).includes("验证码错误"), false);

  const done = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token, code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  assert.equal(done.body.message, "");
  const data = done.body.data as { access_token: string; session: { login_method: string } };
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.session.login_method, "password");
  assert.ok(setCookies(done.res).some((c) => c.toLowerCase().includes("new_api")));

  const replay = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(replay.body.success, false);
  assert.equal(replay.body.code, "AUTH_FLOW_INVALID");
  assert.equal(replay.body.message, "Verification flow expired");
  assert.equal(setCookies(replay.res).length, 0);

  const aliasChallenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const aliasFlow = (aliasChallenge.body.data as { flow_token: string }).flow_token;
  const via2fa = await json(
    new Request("http://local/api/user/login/2fa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: aliasFlow, code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(via2fa.body.success, true, String(via2fa.body.message));
  assert.equal((via2fa.body.data as { session: { login_method: string } }).session.login_method, "password");

  const oauthFlow = "oauth-login-flow";
  const user = await store.getUserById(1);
  await store.insertAuthFlow({
    token: oauthFlow,
    type: AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION,
    user_id: 1,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    payload: JSON.stringify({ auth_version: Number(user?.auth_version || 1), login_method: "oauth:github" }),
  });
  const oauthDone = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: oauthFlow, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(oauthDone.body.success, true, String(oauthDone.body.message));
  assert.equal((oauthDone.body.data as { session: { login_method: string } }).session.login_method, "oauth:github");

  const legacy = "legacy-2fa-login";
  await store.insertAuthFlow({
    token: legacy,
    type: "2fa_login",
    user_id: 1,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    payload: JSON.stringify({ auth_version: Number(user?.auth_version || 1), login_method: "password" }),
  });
  const legacyRes = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: legacy, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(legacyRes.body.success, false);
  assert.equal(legacyRes.body.code, "AUTH_FLOW_INVALID");

  const next = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const nextFlow = (next.body.data as { flow_token: string }).flow_token;
  await store.updateUser(1, { status: USER_DISABLED });
  const disabled = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: nextFlow, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(disabled.res.status, 401);
  assert.equal(disabled.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(setCookies(disabled.res).length, 0);

  await store.updateUser(1, { status: USER_ENABLED });
  const versionChallenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const versionFlow = (versionChallenge.body.data as { flow_token: string }).flow_token;
  await store.bumpAuthVersion(1);
  const versioned = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: versionFlow, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(versioned.res.status, 401);
  assert.equal(versioned.body.code, "AUTH_UNAUTHORIZED");

  const removedChallenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const removedFlow = (removedChallenge.body.data as { flow_token: string }).flow_token;
  assert.equal(typeof removedFlow, "string");
  await store.updateUser(1, { totp_enabled: 0 });
  const removed = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: removedFlow, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(removed.body.success, false);
  assert.equal(removed.body.code, "SECURITY_PROOF_METHOD_MISMATCH");
  assert.equal(setCookies(removed.res).length, 0);
});
