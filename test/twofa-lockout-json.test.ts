import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { TOTP_LOCKOUT_DURATION_SEC, TOTP_MAX_FAIL_ATTEMPTS } from "../src/constants.js";
import { ERR_VERIFICATION_FAILED, ERR_VERIFICATION_LOCKED, totpCode } from "../src/totp.js";
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

async function totpRow(e: Env) {
  return e.DB.prepare("SELECT totp_failed_attempts, totp_locked_until FROM users WHERE username = ?")
    .bind("root")
    .first<{ totp_failed_attempts: number; totp_locked_until: number }>();
}

async function passwordLogin(e: Env) {
  return json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
}

test("original 2FA lockout JSON matches TwoFA.FailedAttempts / LoginChallenge / Get2FAStatus", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const secret = await enableTwoFA(e, auth);

  const unlockedStatus = await json(new Request("http://local/api/user/2fa/status", { headers: auth }), e);
  assert.equal(unlockedStatus.body.success, true);
  assert.equal((unlockedStatus.body.data as { enabled: boolean; locked: boolean }).enabled, true);
  assert.equal((unlockedStatus.body.data as { locked: boolean }).locked, false);

  const challenge = await passwordLogin(e);
  assert.equal(challenge.body.success, true);
  const ch = challenge.body.data as {
    require_verification: boolean;
    flow_token: string;
    methods: { method: string; available: boolean; reason?: string }[];
  };
  const twofa = ch.methods.find((m) => m.method === "2fa");
  assert.ok(twofa);
  assert.equal(twofa.available, true);
  assert.equal("reason" in twofa, false);

  for (let i = 1; i <= TOTP_MAX_FAIL_ATTEMPTS; i++) {
    const fail = await json(
      new Request("http://local/api/user/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow_token: ch.flow_token, method: "2fa", code: "000000" }),
      }),
      e,
    );
    assert.equal(fail.body.success, false);
    assert.equal(fail.body.code, "SECURITY_VERIFICATION_FAILED");
    assert.equal(fail.body.message, ERR_VERIFICATION_FAILED);
    const row = await totpRow(e);
    assert.equal(Number(row?.totp_failed_attempts), i);
    if (i < TOTP_MAX_FAIL_ATTEMPTS) {
      assert.equal(Number(row?.totp_locked_until), 0);
    }
  }

  const lockedAt = Math.floor(Date.now() / 1000);
  const lockedRow = await totpRow(e);
  assert.equal(Number(lockedRow?.totp_failed_attempts), TOTP_MAX_FAIL_ATTEMPTS);
  const until = Number(lockedRow?.totp_locked_until);
  const lockRemaining = until - lockedAt;
  assert.ok(lockRemaining >= TOTP_LOCKOUT_DURATION_SEC - 5, String(lockRemaining));
  assert.ok(lockRemaining <= TOTP_LOCKOUT_DURATION_SEC + 2, String(lockRemaining));

  const status = await json(new Request("http://local/api/user/2fa/status", { headers: auth }), e);
  assert.deepEqual(status.body.data, {
    enabled: true,
    locked: true,
    backup_codes_remaining: 8,
  });

  const sixth = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: ch.flow_token, method: "2fa", code: "000000" }),
    }),
    e,
  );
  assert.equal(sixth.body.success, false);
  assert.equal(sixth.body.code, "SECURITY_METHOD_UNAVAILABLE");
  assert.equal(sixth.body.message, "This verification method is currently unavailable.");
  assert.equal(Number((await totpRow(e))?.totp_failed_attempts), TOTP_MAX_FAIL_ATTEMPTS);

  const blockedLogin = await passwordLogin(e);
  assert.equal(blockedLogin.body.success, false);
  assert.equal(blockedLogin.body.code, "SECURITY_METHOD_UNAVAILABLE");
  assert.equal(blockedLogin.body.message, "This verification method is currently unavailable.");

  const methods = await json(new Request("http://local/api/verify/methods?scope=2fa.disable", { headers: auth }), e);
  assert.equal(methods.body.success, true);
  assert.deepEqual((methods.body.data as { methods: unknown }).methods, [
    { method: "2fa", available: false, reason: ERR_VERIFICATION_LOCKED },
  ]);

  const verifyLocked = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope: "2fa.disable", code: "000000" }),
    }),
    e,
  );
  assert.equal(verifyLocked.body.code, "SECURITY_METHOD_UNAVAILABLE");
  assert.equal(verifyLocked.body.message, "This verification method is currently unavailable.");

  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.setOption("PasskeyEnabled", "true");
  await store.insertPasskey(root.id, "cred-lockout", "pubkey", "device", "example.com");

  const passkeyChallenge = await passwordLogin(e);
  assert.equal(passkeyChallenge.body.success, true, String(passkeyChallenge.body.message));
  const pch = passkeyChallenge.body.data as {
    require_verification: boolean;
    require_2fa?: boolean;
    flow_token: string;
    methods: { method: string; available: boolean; reason?: string }[];
  };
  assert.equal(pch.require_verification, true);
  assert.equal(pch.require_2fa, true);
  assert.deepEqual(pch.methods, [
    { method: "2fa", available: false, reason: ERR_VERIFICATION_LOCKED },
    { method: "passkey", available: true },
  ]);

  const lockedOnOpenFlow = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: pch.flow_token, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(lockedOnOpenFlow.body.code, "SECURITY_METHOD_UNAVAILABLE");

  await e.DB.prepare("UPDATE users SET totp_locked_until = 0 WHERE username = ?").bind("root").run();
  const afterExpiry = await passwordLogin(e);
  const expiredMethods = (afterExpiry.body.data as { methods: { method: string; available: boolean; reason?: string }[] }).methods;
  const unlockedTwoFA = expiredMethods.find((m) => m.method === "2fa");
  assert.equal(unlockedTwoFA?.available, true);
  assert.equal("reason" in (unlockedTwoFA || {}), false);

  const done = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flow_token: (afterExpiry.body.data as { flow_token: string }).flow_token,
        method: "2fa",
        code: await totpCode(secret),
      }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  const reset = await totpRow(e);
  assert.equal(Number(reset?.totp_failed_attempts), 0);
  assert.equal(Number(reset?.totp_locked_until), 0);
  const resetStatus = await json(new Request("http://local/api/user/2fa/status", { headers: auth }), e);
  assert.equal((resetStatus.body.data as { locked: boolean }).locked, false);
});

test("original UniversalVerify 2FA lockout JSON and backup-code regenerate numeric-only", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const secret = await enableTwoFA(e, auth);

  const nonNumeric = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope: "2fa.backup_codes.regenerate", code: "ABCD-1234" }),
    }),
    e,
  );
  assert.equal(nonNumeric.body.success, false);
  assert.equal(nonNumeric.body.code, "SECURITY_VERIFICATION_FAILED");
  assert.equal(nonNumeric.body.message, ERR_VERIFICATION_FAILED);
  assert.equal(Number((await totpRow(e))?.totp_failed_attempts), 0);

  const invalidFormat = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope: "2fa.disable", code: "not-a-code" }),
    }),
    e,
  );
  assert.equal(invalidFormat.body.code, "SECURITY_VERIFICATION_FAILED");
  assert.equal(Number((await totpRow(e))?.totp_failed_attempts), 1);

  for (let i = 2; i <= TOTP_MAX_FAIL_ATTEMPTS; i++) {
    const fail = await json(
      new Request("http://local/api/verify", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ method: "2fa", scope: "2fa.disable", code: "000000" }),
      }),
      e,
    );
    assert.equal(fail.body.code, "SECURITY_VERIFICATION_FAILED");
    assert.equal(Number((await totpRow(e))?.totp_failed_attempts), i);
  }

  const sixth = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope: "2fa.disable", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(sixth.body.code, "SECURITY_METHOD_UNAVAILABLE");
  assert.equal(sixth.body.message, "This verification method is currently unavailable.");
  assert.equal(Number((await totpRow(e))?.totp_failed_attempts), TOTP_MAX_FAIL_ATTEMPTS);

  await e.DB.prepare("UPDATE users SET totp_locked_until = 0 WHERE username = ?").bind("root").run();
  const recovered = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope: "2fa.disable", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(recovered.body.success, true, String(recovered.body.message));
  assert.equal(typeof (recovered.body.data as { proof_token: string }).proof_token, "string");
  const reset = await totpRow(e);
  assert.equal(Number(reset?.totp_failed_attempts), 0);
  assert.equal(Number(reset?.totp_locked_until), 0);
});
