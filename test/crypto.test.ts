import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, parseApiKey, signSession, verifyPassword, verifySession } from "../src/crypto.js";

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
