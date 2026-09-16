import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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

async function startSetup(e: Env, auth: Record<string, string>) {
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  return setup.body.data as { secret: string; flow_token: string; backup_codes: string[] };
}

test("original Enable2FA writeSecurityOperationError / ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await json(new Request("http://local/api/user/2fa/enable", { method: "POST", headers: auth }), e);
  omitData(empty.body, "参数错误");
  const badJson = await json(
    new Request("http://local/api/user/2fa/enable", { method: "POST", headers: auth, body: "{" }),
    e,
  );
  omitData(badJson.body, "参数错误");
  const codeNum = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: 123456, flow_token: "x" }),
    }),
    e,
  );
  omitData(codeNum.body, "参数错误");

  const missingFlow = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: "123456" }),
    }),
    e,
  );
  assert.equal(missingFlow.res.status, 409);
  securityOp(missingFlow.body, "TWOFA_SETUP_INVALID", "The two-factor setup has expired or changed. Start setup again.");

  const setup = await startSetup(e, auth);
  const badCode = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: "000000", flow_token: setup.flow_token }),
    }),
    e,
  );
  assert.equal(badCode.res.status, 200);
  securityOp(badCode.body, "TWOFA_CODE_INVALID", "The authenticator code is incorrect.");
  assert.equal(JSON.stringify(badCode.body).includes("验证码错误"), false);

  const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
    .bind(setup.flow_token)
    .first<{ consumed_at: number }>();
  assert.equal(Number(still?.consumed_at || 0), 0);

  const notNumeric = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: "abcdef", flow_token: setup.flow_token }),
    }),
    e,
  );
  securityOp(notNumeric.body, "TWOFA_CODE_INVALID", "The authenticator code is incorrect.");

  const ok = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(setup.secret), flow_token: setup.flow_token }),
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
  assert.equal(ok.body.message, "");
  const data = ok.body.data as { access_token: string; token_type: string; session: { sid: string } };
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.token_type, "Bearer");
  assert.equal(typeof data.session.sid, "string");
  assert.equal("backup_codes" in data, false);

  const replay = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(setup.secret), flow_token: setup.flow_token }),
    }),
    e,
  );
  assert.equal(replay.res.status, 409);
  securityOp(replay.body, "TWOFA_SETUP_INVALID", "The two-factor setup has expired or changed. Start setup again.");
});
