import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { generateQrCodeData, totpCode } from "../src/totp.js";
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

test("original Setup2FA TwoFASetup gin.H omits otpauth_url and matches GenerateQRCodeData", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  assert.equal(setup.body.message, "");
  const data = setup.body.data as {
    secret: string;
    qr_code_data: string;
    backup_codes: string[];
    flow_token: string;
    expires_at: number;
  };
  assert.deepEqual(Object.keys(data).sort(), ["backup_codes", "expires_at", "flow_token", "qr_code_data", "secret"]);
  assert.equal("otpauth_url" in data, false);
  assert.equal(typeof data.secret, "string");
  assert.equal(typeof data.flow_token, "string");
  assert.equal(typeof data.expires_at, "number");
  assert.equal(data.qr_code_data, generateQrCodeData(data.secret, "root", "New API"));
  assert.equal(data.qr_code_data.includes("algorithm="), false);
  assert.equal(data.qr_code_data.includes("%20"), false);
  assert.equal(data.backup_codes.length, 4);
  for (const code of data.backup_codes) {
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  }
});

test("original GetVerificationRequirements TWOFA_ALREADY_ENABLED gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  const started = setup.body.data as { secret: string; flow_token: string };
  const enabled = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(started.secret), flow_token: started.flow_token }),
    }),
    e,
  );
  assert.equal(enabled.body.success, true, String(enabled.body.message));
  const nextAuth = {
    authorization: "Bearer " + (enabled.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };

  const methods = await json(new Request("http://local/api/verify/methods?scope=2fa.setup", { headers: nextAuth }), e);
  assert.equal(methods.res.status, 200);
  securityOp(methods.body, "TWOFA_ALREADY_ENABLED", "Two-factor authentication is already enabled.");

  const verify = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: nextAuth,
      body: JSON.stringify({ method: "password", scope: "2fa.setup", password: "password12" }),
    }),
    e,
  );
  assert.equal(verify.res.status, 200);
  securityOp(verify.body, "TWOFA_ALREADY_ENABLED", "Two-factor authentication is already enabled.");
});

test("original Enable2FA authRotationData gin.H omits user", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  const data = setup.body.data as { secret: string; flow_token: string };
  const ok = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(data.secret), flow_token: data.flow_token }),
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
  const rotated = ok.body.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(rotated).sort(), ["access_expires_at", "access_token", "session", "token_type"]);
  assert.equal("user" in rotated, false);
  assert.equal("backup_codes" in rotated, false);
});
