import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { AUTH_FLOW_PURPOSE_PASSKEY_LOGIN } from "../src/auth.js";
import { USER_DISABLED, USER_ENABLED } from "../src/constants.js";
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

async function beginLogin(e: Env) {
  const begin = await json(
    new Request("http://local/api/user/passkey/login/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    e,
  );
  assert.equal(begin.body.success, true, String(begin.body.message));
  return begin.body.data as { flow_token: string; options: { rpId: string } };
}

test("original PasskeyLoginFinish leftover apiFail gin.H is writeSecurityOperationError", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enablePasskey(e, auth);
  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  assert.ok(root);

  const emptyCred = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: "x", credential: {} }),
    }),
    e,
  );
  securityOp(emptyCred.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");
  assert.equal(emptyCred.body.message === "凭证无效", false);

  const started = await beginLogin(e);
  const stored = await e.DB.prepare("SELECT type, user_id FROM auth_flows WHERE token = ?")
    .bind(started.flow_token)
    .first<{ type: string; user_id: number }>();
  assert.equal(stored?.type, AUTH_FLOW_PURPOSE_PASSKEY_LOGIN);
  assert.equal(Number(stored?.user_id), 0);

  const missingPk = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: started.flow_token, credential: { id: "no-such-cred" } }),
    }),
    e,
  );
  assert.equal(missingPk.res.status, 200);
  securityOp(missingPk.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");
  assert.equal(missingPk.body.message === "凭证无效", false);
  const replay = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: started.flow_token, credential: { id: "no-such-cred" } }),
    }),
    e,
  );
  securityOp(replay.body, "AUTH_FLOW_INVALID", "Verification flow expired");

  await store.insertPasskey(root.id, "cred-root", "pubkey", "device", "");
  const verifyBegin = await beginLogin(e);
  const badSig = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: verifyBegin.flow_token,
        credential: {
          id: "cred-root",
          response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
        },
      }),
    }),
    e,
  );
  securityOp(badSig.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");
  assert.equal(badSig.body.message === "Passkey 校验失败", false);

  const successBegin = await beginLogin(e);
  const done = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: successBegin.flow_token, credential: { id: "cred-root" } }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  assert.equal(done.body.message, "");
  const data = done.body.data as { access_token: string; session: { login_method: string }; user: { username: string } };
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.session.login_method, "passkey");
  assert.equal(data.user.username, "root");
  assert.ok(setCookies(done.res).some((c) => c.toLowerCase().includes("new_api")));
});

test("original PasskeyLoginFinish disabled user / UV gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enablePasskey(e, auth);
  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.insertPasskey(root.id, "cred-root", "pubkey", "device", "");

  await store.updateUser(root.id, { status: USER_DISABLED });
  const disabledBegin = await beginLogin(e);
  const disabled = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: disabledBegin.flow_token, credential: { id: "cred-root" } }),
    }),
    e,
  );
  securityOp(disabled.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");
  assert.equal(disabled.body.message === "用户不存在", false);
  assert.equal(disabled.body.message === "该用户已被禁用", false);
  assert.equal(setCookies(disabled.res).length, 0);

  await store.updateUser(root.id, { status: USER_ENABLED });
  const uvToken = "uv-not-required";
  await store.insertAuthFlow({
    token: uvToken,
    type: AUTH_FLOW_PURPOSE_PASSKEY_LOGIN,
    user_id: 0,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    payload: JSON.stringify({ challenge: "ch", rp_id: "local", user_verification: "preferred" }),
  });
  const uv = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: uvToken, credential: { id: "cred-root" } }),
    }),
    e,
  );
  securityOp(uv.body, "AUTH_FLOW_INVALID", "Verification flow expired");

  const rpBegin = await beginLogin(e);
  await store.insertPasskey(root.id, "cred-other-rp", "pubkey", "device", "other.example.com");
  const rpMismatch = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: rpBegin.flow_token, credential: { id: "cred-other-rp" } }),
    }),
    e,
  );
  securityOp(rpMismatch.body, "SECURITY_VERIFICATION_FAILED", "Verification failed. Please try again.");
});
