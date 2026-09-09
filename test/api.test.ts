import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = await res.json();
  return { res, body };
}

test("setup + login + channel + token + mocked relay", async () => {
  resetSchemaFlag();
  const e = env();

  const setupGet = await json(new Request("http://local/api/setup"), e);
  assert.equal(setupGet.body.success, true);
  assert.equal(setupGet.body.data.status, false);

  const setup = await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "root",
        password: "password12",
        confirmPassword: "password12",
        SelfUseModeEnabled: true,
      }),
    }),
    e,
  );
  assert.equal(setup.body.success, true, setup.body.message);

  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(login.body.success, true, login.body.message);
  const token = login.body.data.access_token as string;
  assert.ok(token);
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };

  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  assert.equal(self.body.data.username, "root");
  assert.equal(self.body.data.role, 100);

  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mock-openai",
        type: 1,
        key: "sk-upstream",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://example.invalid",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.body.message);

  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cli", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tk.body.success, true, tk.body.message);
  const sk = tk.body.data.key as string;
  assert.match(sk, /^sk-/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /\/v1\/chat\/completions/);
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const relay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
      }),
      e,
    );
    assert.equal(relay.res.status, 200);
    assert.equal(relay.body.choices[0].message.content, "pong");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const logs = await json(new Request("http://local/api/log/self", { headers: auth }), e);
  assert.ok((logs.body.data.items || []).length >= 1);

  const models = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(models.body.object, "list");
  assert.ok(models.body.data.some((m: { id: string }) => m.id === "gpt-4o-mini"));

  const red = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "gift", quota: 1234, count: 1 }),
    }),
    e,
  );
  assert.equal(red.body.success, true);
  const code = red.body.data[0] as string;
  const topup = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: code }),
    }),
    e,
  );
  assert.equal(topup.body.success, true, topup.body.message);
});

test("status reports setup after init", async () => {
  resetSchemaFlag();
  const e = env();
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const st = await json(new Request("http://local/api/status"), e);
  assert.equal(st.body.data.setup, true);
  assert.equal(st.body.data.system_name, "Edge API Test");
});

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
  const token = login.body.data.access_token as string;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { token, auth, login };
}

async function passwordProof(e: Env, auth: Record<string, string>, scope: string, extra: Record<string, unknown> = {}) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12", ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data.proof_token as string;
}

test("2FA setup then login challenge", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const setupProof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": setupProof },
    }),
    e,
  );
  assert.equal(setup.body.success, true, setup.body.message);
  const secret = setup.body.data.secret as string;
  assert.equal(typeof setup.body.data.qr_code_data, "string");
  assert.ok(Array.isArray(setup.body.data.backup_codes));
  assert.equal(typeof setup.body.data.flow_token, "string");
  assert.equal(typeof setup.body.data.expires_at, "number");
  const { totpCode } = await import("../src/totp.js");
  const code = await totpCode(secret);
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code, flow_token: setup.body.data.flow_token }),
    }),
    e,
  );
  assert.equal(en.body.success, true, en.body.message);
  assert.ok(Array.isArray(en.body.data.backup_codes));
  assert.equal(typeof en.body.data.access_token, "string");
  assert.equal(en.body.data.token_type, "Bearer");
  assert.equal(typeof en.body.data.session.sid, "string");

  const challenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(challenge.body.data.require_2fa, true);
  const flow = challenge.body.data.flow_token as string;
  const code2 = await totpCode(secret);
  const done = await json(
    new Request("http://local/api/user/login/2fa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: flow, code: code2 }),
    }),
    e,
  );
  assert.equal(done.body.success, true, done.body.message);
  assert.ok(done.body.data.access_token);
});

test("rankings + subscription buy + token batch", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const rank = await json(new Request("http://local/api/rankings"), e);
  assert.equal(rank.body.success, true);
  assert.ok(Array.isArray(rank.body.data.models));
  assert.ok(Array.isArray(rank.body.data.vendors));
  assert.ok(Array.isArray(rank.body.data.top_movers));
  assert.ok(Array.isArray(rank.body.data.top_droppers));
  assert.ok(rank.body.data.models_history);
  assert.ok(rank.body.data.vendor_share_history);

  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);

  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: { title: "pro", price_amount: 0, total_amount: 1000, duration_unit: "day", duration_value: 30 },
      }),
    }),
    e,
  );
  assert.equal(plan.body.success, true, plan.body.message);
  const planId = plan.body.data.id as number;
  const buy = await json(
    new Request("http://local/api/subscription/balance/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  assert.equal(buy.body.success, true, buy.body.message);

  const t1 = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "a", unlimited_quota: true }),
    }),
    e,
  );
  const t2 = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "b", unlimited_quota: true }),
    }),
    e,
  );
  const batch = await json(
    new Request("http://local/api/token/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [t1.body.data.id, t2.body.data.id] }),
    }),
    e,
  );
  assert.equal(batch.body.success, true);
  assert.equal(batch.body.data, 2);
});

test("session revoke + 501 files + multipart audio relay", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const sess = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  assert.equal(sess.body.success, true);
  assert.ok((sess.body.data as { sid: string }[]).length >= 1);
  const sid = (sess.body.data as { sid: string; current?: boolean }[]).find((x) => x.current)?.sid;
  assert.ok(sid);

  const files = await json(new Request("http://local/v1/files", { headers: { authorization: "Bearer sk-nope" } }), e);
  assert.equal(files.res.status, 401);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "mock", type: 1, key: "sk-up", models: "whisper-1", group: "default", base_url: "https://example.invalid" }),
    }),
    e,
  );
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cli", unlimited_quota: true }),
    }),
    e,
  );
  const sk = tk.body.data.key as string;

  const filesAuth = await json(new Request("http://local/v1/files", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(filesAuth.res.status, 501);

  const boundary = "----edgeapi";
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n` +
    `--${boundary}--\r\n`;
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenCt = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(input);
    if (init?.headers && typeof init.headers === "object" && !(init.headers instanceof Headers)) {
      seenCt = String((init.headers as Record<string, string>)["content-type"] || "");
    }
    return new Response(JSON.stringify({ text: "hello" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const relay = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
      }),
      e,
    );
    assert.equal(relay.res.status, 200);
    assert.match(seenUrl, /transcriptions/);
    assert.match(seenCt, /multipart/);
    assert.equal(relay.body.text, "hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

