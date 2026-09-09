import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, parseApiKey, signAccessJwt, splitRefreshToken, verifyAccessJwt, verifyPassword, signSession, verifySession, signSecurityProofJwt, verifySecurityProofJwt } from "../src/crypto.js";

test("parseApiKey strips sk- and extra segments", () => {
  assert.equal(parseApiKey("Bearer sk-abc123-extra"), "abc123");
  assert.equal(parseApiKey("sk-deadbeef"), "deadbeef");
  assert.equal(parseApiKey("x-api-key-not"), "x");
});

test("pbkdf2 hash verifies", async () => {
  const h = await hashPassword("hello-world-12");
  assert.match(h, /^\$pbkdf2-sha256\$i=100000\$/);
  assert.equal(await verifyPassword("hello-world-12", h), true);
  assert.equal(await verifyPassword("nope", h), false);
});

test("session sign/verify", async () => {
  const token = await signSession({ uid: 1, role: 100, username: "root", exp: Math.floor(Date.now() / 1000) + 60 }, "secret");
  const p = await verifySession(token, "secret");
  assert.equal(p?.uid, 1);
  assert.equal(await verifySession(token, "other"), null);
});

test("original access JWT and sid.secret refresh token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const sid = crypto.randomUUID();
  const jwt = await signAccessJwt("session-secret", { userId: 7, sid, userAuthVersion: 1, sessionVersion: 1 }, now, now + 900);
  assert.equal(jwt.split(".").length, 3);
  const payload = await verifyAccessJwt(jwt, "session-secret");
  assert.equal(payload?.iss, "new-api");
  assert.equal(payload?.aud, "new-api-dashboard");
  assert.equal(payload?.token_use, "access");
  assert.equal(payload?.sub, "7");
  assert.equal(payload?.sid, sid);
  assert.equal(await verifyAccessJwt(jwt, "other"), null);
  const parsed = splitRefreshToken(`${sid}.abcdefgh`);
  assert.equal(parsed?.sid, sid);
  assert.equal(splitRefreshToken("not-a-uuid.secret"), null);
});

test("original security proof JWT uses token_use=security_proof", async () => {
  const now = Math.floor(Date.now() / 1000);
  const sid = crypto.randomUUID();
  const jwt = await signSecurityProofJwt(
    "session-secret",
    { userId: 7, sid, userAuthVersion: 1, sessionVersion: 1 },
    { method: "password", scopes: ["2fa.setup"], contextHash: "abc", jti: "flow-token" },
    now,
    now + 60,
  );
  assert.equal(jwt.split(".").length, 3);
  const payload = await verifySecurityProofJwt(jwt, "session-secret");
  assert.equal(payload?.token_use, "security_proof");
  assert.equal(payload?.iss, "new-api");
  assert.equal(payload?.aud, "new-api-dashboard");
  assert.equal(payload?.method, "password");
  assert.deepEqual(payload?.scopes, ["2fa.setup"]);
  assert.equal(payload?.context_hash, "abc");
  assert.equal(payload?.jti, "flow-token");
  assert.equal(await verifySecurityProofJwt(jwt, "other"), null);
  assert.equal(await verifyAccessJwt(jwt, "session-secret"), null);
});
