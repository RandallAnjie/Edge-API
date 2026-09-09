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
