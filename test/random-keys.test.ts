import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  ALPHANUMERIC_CHARSET,
  TOKEN_KEY_CHARS,
  generateAffCode,
  generateRedemptionKey,
  generateTokenKey,
  getRandomString,
} from "../src/crypto.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
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
  return { e, auth };
}

function assertCharset(value: string, charset: string, label: string) {
  for (const ch of value) {
    assert.ok(charset.includes(ch), `${label} char ${ch} is outside original charset`);
  }
}

test("original GetRandomString, GenerateKey, and GetUUID shapes", () => {
  assert.equal(getRandomString(0), "");
  const aff = generateAffCode();
  assert.equal(aff.length, 4);
  assertCharset(aff, ALPHANUMERIC_CHARSET, "GetRandomString(4)");
  const key = generateTokenKey();
  assert.equal(key.length, 48);
  assertCharset(key, TOKEN_KEY_CHARS, "GenerateKey");
  const uuid = generateRedemptionKey();
  assert.equal(uuid.length, 32);
  assert.match(uuid, /^[0-9a-f]{32}$/);
  assert.equal(uuid[12], "4");
});

test("original GetAffCode JSON is GetRandomString(4)", async () => {
  const { e, auth } = await boot();
  const aff = await json(new Request("http://local/api/user/aff", { headers: auth }), e);
  assert.equal(aff.body.success, true, String(aff.body.message));
  assert.equal(aff.body.message, "");
  const code = aff.body.data;
  assert.equal(typeof code, "string");
  assert.equal(String(code).length, 4);
  assertCharset(String(code), ALPHANUMERIC_CHARSET, "GET /api/user/aff");
  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  assert.equal((self.body.data as { aff_code: string }).aff_code, code);
});

test("original GetTokenKey JSON is GenerateKey 48 alphanumeric chars", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "keyshape", remain_quota: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.equal(created.body.message, "");
  const extra = created.body.data as { id: number; key: string };
  assert.equal(typeof extra.id, "number");
  assert.match(extra.key, /^sk-/);
  const listed = await json(new Request("http://local/api/token/", { headers: auth }), e);
  const row = ((listed.body.data as { items: { id: number; name: string }[] }).items || []).find((t) => t.name === "keyshape");
  assert.ok(row);
  const revealed = await json(new Request("http://local/api/token/" + row.id + "/key", { method: "POST", headers: auth }), e);
  assert.equal(revealed.body.success, true, String(revealed.body.message));
  const raw = (revealed.body.data as { key: string }).key;
  assert.equal(raw.length, 48);
  assertCharset(raw, TOKEN_KEY_CHARS, "POST /api/token/:id/key");
  assert.equal(raw.startsWith("sk-"), false);
});

test("original AddRedemption JSON keys are GetUUID without hyphens", async () => {
  const { e, auth } = await boot();
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "uuidkey", quota: 100, count: 2 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.equal(created.body.message, "");
  const keys = created.body.data as string[];
  assert.equal(keys.length, 2);
  for (const key of keys) {
    assert.equal(key.length, 32);
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.equal(key[12], "4");
    assert.equal(key.includes("-"), false);
  }
});
