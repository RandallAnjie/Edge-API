import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ADVANCED_CUSTOM } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

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
  return { e, auth, store: new Store(e.DB) };
}

function advancedSettings(balanceRoute?: Record<string, unknown>) {
  const routes: Record<string, unknown>[] = [
    {
      incoming_path: "/v1/chat/completions",
      upstream_path: "/v1/chat/completions",
      converter: "none",
      models: ["gpt-test"],
    },
  ];
  if (balanceRoute) routes.push(balanceRoute);
  return JSON.stringify({ advanced_custom: { advanced_routes: routes } });
}

async function addChannel(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original UpdateChannelBalance Advanced Custom credit_summary vs raw_response JSON", async () => {
  const { e, auth, store } = await boot();
  const id = await addChannel(e, auth, {
    name: "adv-balance",
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    key: "sk-balance-secret",
    models: "gpt-test",
    group: "default",
    base_url: "https://provider.example",
    header_override: JSON.stringify({ "X-Extra": "ov-{api_key}" }),
    settings: advancedSettings({
      incoming_path: "/v1/dashboard/billing/credit_grants",
      upstream_path: "/provider/credits",
      converter: "none",
      auth: { type: "header", name: "X-Api-Key", value: "Bearer {api_key}" },
    }),
  });

  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  let nextBody: { status: number; body: string } = {
    status: 200,
    body: JSON.stringify({ object: "credit_summary", total_available: 12.5, total_granted: 20 }),
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ url: req.url, method: req.method, headers });
    return new Response(nextBody.body, {
      status: nextBody.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const credit = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(credit.res.status, 200, credit.text);
    assert.equal(credit.body.success, true);
    assert.equal(credit.body.message, "");
    assert.equal(credit.body.balance, 12.5);
    assert.equal(credit.body.raw_response, undefined);
    assert.equal(credit.body.data, undefined);
    assert.equal(calls[0]?.url, "https://provider.example/provider/credits");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.headers["x-api-key"], "Bearer sk-balance-secret");
    assert.equal(calls[0]?.headers["x-extra"], "ov-sk-balance-secret");
    const saved = await store.getChannel(id);
    assert.equal(Number(saved?.balance), 12.5);
    assert.ok(Number(saved?.balance_updated_time) > 0);

    nextBody = {
      status: 200,
      body: JSON.stringify({ object: "credit_grants", total_available: 9, grants: [{ amount: 1 }] }),
    };
    const rawObject = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(rawObject.body.success, true);
    assert.equal(rawObject.body.message, "");
    assert.equal(rawObject.body.balance, undefined);
    assert.equal(rawObject.body.data, undefined);
    assert.equal(
      rawObject.body.raw_response,
      "{\n  \"object\": \"credit_grants\",\n  \"total_available\": 9,\n  \"grants\": [\n    {\n      \"amount\": 1\n    }\n  ]\n}",
    );
    assert.equal(Number((await store.getChannel(id))?.balance), 12.5);

    nextBody = { status: 200, body: JSON.stringify({ object: "credit_summary", total_available: "12.5" }) };
    const stringAvail = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(stringAvail.body.balance, undefined);
    assert.equal(
      stringAvail.body.raw_response,
      "{\n  \"object\": \"credit_summary\",\n  \"total_available\": \"12.5\"\n}",
    );

    nextBody = { status: 200, body: JSON.stringify({ object: "credit_summary", total_available: -1 }) };
    const negative = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(negative.body.balance, undefined);
    assert.equal(negative.body.raw_response, "{\n  \"object\": \"credit_summary\",\n  \"total_available\": -1\n}");

    nextBody = { status: 200, body: JSON.stringify({ object: "credit_summary", total_available: 0 }) };
    const zero = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(zero.body.success, true);
    assert.equal(zero.body.balance, 0);
    assert.equal(zero.body.raw_response, undefined);

    nextBody = { status: 200, body: "[1,2]" };
    const arr = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(arr.body.balance, undefined);
    assert.equal(arr.body.raw_response, "[\n  1,\n  2\n]");

    nextBody = { status: 201, body: JSON.stringify({ object: "credit_summary", total_available: 3 }) };
    const created = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(created.body.success, false);
    assert.equal(created.body.message, "status code: 201");
    assert.equal(created.body.balance, undefined);
    assert.equal(created.body.raw_response, undefined);

    nextBody = { status: 200, body: "not-json" };
    const invalid = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(invalid.body.success, false);
    assert.equal(invalid.body.message, "invalid balance JSON response: invalid character 'n' looking for beginning of value");

    nextBody = { status: 200, body: `{"pad":"${"a".repeat(262145)}"}` };
    const tooLarge = await json(new Request("http://local/api/channel/update_balance/" + id, { headers: auth }), e);
    assert.equal(tooLarge.body.success, false);
    assert.equal(tooLarge.body.message, "balance response exceeds 262144 bytes");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original UpdateChannelBalance Advanced Custom missing route / query auth / connect sanitization JSON", async () => {
  const { e, auth } = await boot();
  const missingId = await addChannel(e, auth, {
    name: "adv-no-balance",
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    key: "sk-missing",
    models: "gpt-test",
    group: "default",
    base_url: "https://provider.example",
    settings: advancedSettings(),
  });
  const missing = await json(new Request("http://local/api/channel/update_balance/" + missingId, { headers: auth }), e);
  assert.equal(missing.body.success, false);
  assert.equal(
    missing.body.message,
    "advanced custom channel does not configure a /v1/dashboard/billing/credit_grants route",
  );
  assert.equal(missing.body.balance, undefined);
  assert.equal(missing.body.raw_response, undefined);

  const queryId = await addChannel(e, auth, {
    name: "adv-query-balance",
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    key: "sk-query-secret",
    models: "gpt-test",
    group: "default",
    base_url: "https://provider.example",
    settings: advancedSettings({
      incoming_path: "/v1/dashboard/billing/credit_grants",
      upstream_path: "/provider/credits",
      converter: "none",
      auth: { type: "query", name: "api_key", value: "{api_key}" },
    }),
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/provider/credits") {
      throw new Error("Get \"https://provider.example/provider/credits?api_key=sk-query-secret\": connection refused");
    }
    return origFetch(input, init);
  }) as typeof fetch;

  try {
    const leaked = await json(new Request("http://local/api/channel/update_balance/" + queryId, { headers: auth }), e);
    assert.equal(leaked.body.success, false);
    assert.equal(String(leaked.body.message).includes("sk-query-secret"), false);
    assert.match(String(leaked.body.message), /\[REDACTED\]/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
