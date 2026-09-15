import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_MOONSHOT } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const CHANNEL_TYPE_AIPROXY = 10;
const CHANNEL_TYPE_API2GPT = 12;

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

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>): Promise<number> {
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

test("original UpdateChannelBalance AIProxy/API2GPT/DeepSeek/Moonshot JSON fields", async () => {
  const { e, auth } = await boot();
  const aiproxyId = await addChannel(e, auth, {
    name: "aiproxy-bal",
    type: CHANNEL_TYPE_AIPROXY,
    key: "ak-proxy",
    models: "gpt-4o",
    group: "default",
  });
  const api2gptId = await addChannel(e, auth, {
    name: "api2gpt-bal",
    type: CHANNEL_TYPE_API2GPT,
    key: "sk-api2gpt",
    models: "gpt-4o",
    group: "default",
  });
  const deepseekId = await addChannel(e, auth, {
    name: "deepseek-bal",
    type: CHANNEL_TYPE_DEEPSEEK,
    key: "sk-deepseek",
    models: "deepseek-chat",
    group: "default",
  });
  const moonshotId = await addChannel(e, auth, {
    name: "moonshot-bal",
    type: CHANNEL_TYPE_MOONSHOT,
    key: "sk-moonshot",
    models: "kimi-k2.5",
    group: "default",
  });

  const calls: { url: string; method: string; apiKey: string; authorization: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    calls.push({
      url,
      method: req.method,
      apiKey: req.headers.get("Api-Key") || "",
      authorization: req.headers.get("Authorization") || "",
    });
    if (url === "https://aiproxy.io/api/report/getUserOverview") {
      return new Response(
        JSON.stringify({ success: true, message: "ok", error_code: 0, data: { totalPoints: 42 } }),
        { status: 200 },
      );
    }
    if (url === "https://aiproxy.io/api/user/info") {
      return new Response(JSON.stringify({ data: { totalPoints: 99 } }), { status: 200 });
    }
    if (url === "https://api.api2gpt.com/dashboard/billing/credit_grants") {
      return new Response(JSON.stringify({ total_remaining: 3.5, total_available: 99 }), { status: 200 });
    }
    if (url === "https://api.deepseek.com/user/balance") {
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "1" },
            { currency: "CNY", total_balance: "8.5" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url === "https://api.moonshot.cn/v1/users/me/balance") {
      return new Response(
        JSON.stringify({
          status: true,
          code: 0,
          scode: "",
          data: { available_balance: 7.3, voucher_balance: 0, cash_balance: 7.3 },
        }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;

  try {
    const aiproxy = await json(new Request("http://local/api/channel/update_balance/" + aiproxyId, { headers: auth }), e);
    assert.equal(aiproxy.body.success, true, String(aiproxy.body.message));
    assert.equal(aiproxy.body.message, "");
    assert.equal(aiproxy.body.balance, 42);
    assert.equal(aiproxy.body.data, undefined);
    assert.equal(calls[0]?.url, "https://aiproxy.io/api/report/getUserOverview");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.apiKey, "ak-proxy");
    assert.equal(calls[0]?.authorization, "");

    const api2gpt = await json(new Request("http://local/api/channel/update_balance/" + api2gptId, { headers: auth }), e);
    assert.equal(api2gpt.body.success, true, String(api2gpt.body.message));
    assert.equal(api2gpt.body.balance, 3.5);
    assert.equal(api2gpt.body.data, undefined);
    assert.equal(calls[1]?.authorization, "Bearer sk-api2gpt");

    const deepseek = await json(new Request("http://local/api/channel/update_balance/" + deepseekId, { headers: auth }), e);
    assert.equal(deepseek.body.success, true, String(deepseek.body.message));
    assert.equal(deepseek.body.balance, 8.5);
    assert.equal(deepseek.body.data, undefined);

    const moonshot = await json(new Request("http://local/api/channel/update_balance/" + moonshotId, { headers: auth }), e);
    assert.equal(moonshot.body.success, true, String(moonshot.body.message));
    assert.equal(moonshot.body.balance, 1);
    assert.equal(moonshot.body.raw_response, undefined);
    assert.equal(moonshot.body.data, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original UpdateChannelBalance AIProxy/DeepSeek/Moonshot error JSON messages", async () => {
  const { e, auth } = await boot();
  const aiproxyId = await addChannel(e, auth, {
    name: "aiproxy-err",
    type: CHANNEL_TYPE_AIPROXY,
    key: "ak-err",
    models: "gpt-4o",
    group: "default",
  });
  const deepseekId = await addChannel(e, auth, {
    name: "deepseek-err",
    type: CHANNEL_TYPE_DEEPSEEK,
    key: "sk-ds-err",
    models: "deepseek-chat",
    group: "default",
  });
  const moonshotId = await addChannel(e, auth, {
    name: "moonshot-err",
    type: CHANNEL_TYPE_MOONSHOT,
    key: "sk-ms-err",
    models: "kimi-k2.5",
    group: "default",
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("getUserOverview")) {
      return new Response(JSON.stringify({ success: false, message: "token invalid", error_code: 7, data: {} }), { status: 200 });
    }
    if (url.includes("/user/balance")) {
      return new Response(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "1" }] }), { status: 200 });
    }
    if (url.includes("moonshot")) {
      return new Response(JSON.stringify({ status: false, code: 1, scode: "X", data: { available_balance: 9 } }), { status: 200 });
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;

  try {
    const aiproxy = await json(new Request("http://local/api/channel/update_balance/" + aiproxyId, { headers: auth }), e);
    assert.equal(aiproxy.body.success, false);
    assert.equal(aiproxy.body.message, "code: 7, message: token invalid");
    assert.equal(aiproxy.body.balance, undefined);

    const deepseek = await json(new Request("http://local/api/channel/update_balance/" + deepseekId, { headers: auth }), e);
    assert.equal(deepseek.body.success, false);
    assert.equal(deepseek.body.message, "currency CNY not found");
    assert.equal(deepseek.body.balance, undefined);

    const moonshot = await json(new Request("http://local/api/channel/update_balance/" + moonshotId, { headers: auth }), e);
    assert.equal(moonshot.body.success, false);
    assert.equal(moonshot.body.message, "failed to update moonshot balance, status: false, code: 1, scode: X");
    assert.equal(moonshot.body.balance, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});
