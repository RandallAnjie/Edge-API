import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_TYPE_BAIDU_V2,
  CHANNEL_TYPE_CLOUDFLARE,
  CHANNEL_TYPE_MINIMAX,
  CHANNEL_TYPE_PERPLEXITY,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_TYPE_ZHIPU_V4,
} from "../src/constants.js";
import { clearZhipuTokenCache } from "../src/zhipu-convert.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cli", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, sk };
}

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>) {
  const res = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
  return res;
}

test("original Zhipu, Perplexity, Cloudflare, BaiduV2, and MiniMax ConvertOpenAIRequest JSON is sent upstream with original URLs and DoResponse fields", async () => {
  const { e, auth, sk } = await boot();
  clearZhipuTokenCache();
  await addChannel(e, auth, {
    name: "zhipu",
    type: CHANNEL_TYPE_ZHIPU,
    key: "id.secret",
    models: "chatglm_std",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "zhipu-v4",
    type: CHANNEL_TYPE_ZHIPU_V4,
    key: "sk-z",
    models: "glm-4",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "pplx",
    type: CHANNEL_TYPE_PERPLEXITY,
    key: "pk",
    models: "sonar",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "cf",
    type: CHANNEL_TYPE_CLOUDFLARE,
    key: "cfk",
    models: "llama-3",
    group: "default",
    other: "acct-1",
  });
  await addChannel(e, auth, {
    name: "baidu-v2",
    type: CHANNEL_TYPE_BAIDU_V2,
    key: "tok|app-1",
    models: "ernie-4.0-8k-search",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "minimax",
    type: CHANNEL_TYPE_MINIMAX,
    key: "mk",
    models: "abab6.5s-chat",
    group: "default",
  });

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url.includes("/api/paas/v3/model-api/")) {
      if (url.endsWith("/sse-invoke")) {
        return new Response('data:hello glm\nmeta:{"request_id":"req-1","usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            task_id: "task-1",
            choices: [{ role: "assistant", content: '"hello glm"' }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/client/v4/accounts/")) {
      return new Response(
        JSON.stringify({
          id: "cf-orig",
          model: "wrong-model",
          choices: [{ index: 0, message: { role: "assistant", content: "hello cf" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v2/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "ernie-1",
          model: "ernie-4.0-8k",
          choices: [{ index: 0, message: { role: "assistant", content: "hello v2" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/chat/completions") || url.includes("/chatcompletion_v2") || url.includes("/api/paas/v4/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "oa-1",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const zhipuChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatglm_std",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi zhipu" },
          ],
          top_p: 1,
        }),
      }),
      e,
    );
    assert.equal(zhipuChat.res.status, 200, zhipuChat.text);
    const zhipuCall = calls.find((c) => c.url.includes("/api/paas/v3/model-api/chatglm_std/invoke"));
    if (!zhipuCall) throw new Error("missing zhipu v3 upstream");
    assert.deepEqual(zhipuCall.body.prompt, [
      { role: "system", content: "sys" },
      { role: "user", content: "Okay" },
      { role: "user", content: "hi zhipu" },
    ]);
    assert.equal(zhipuCall.body.top_p, 0.99);
    assert.equal("incremental" in zhipuCall.body, false);
    const zhipuAuth = zhipuCall.headers.get("authorization") || "";
    assert.equal(zhipuAuth.startsWith("Bearer "), false);
    assert.equal(zhipuAuth.split(".").length, 3);
    assert.equal(zhipuChat.body.id, "task-1");
    assert.equal((zhipuChat.body.choices as { message: { content: string } }[])[0].message.content, "hello glm");
    assert.equal((zhipuChat.body.usage as { total_tokens: number }).total_tokens, 5);

    const zhipuStream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatglm_std",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(zhipuStream.res.status, 200, zhipuStream.text);
    const zhipuSse = calls.find((c) => c.url.endsWith("/sse-invoke"));
    if (!zhipuSse) throw new Error("missing zhipu v3 stream upstream");
    assert.match(zhipuStream.text, /"model":"chatglm"/);
    assert.match(zhipuStream.text, /hello glm/);
    assert.match(zhipuStream.text, /data: \[DONE\]/);

    const zhipuV4Chat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-4",
          messages: [{ role: "user", content: "hi v4" }],
          stream_options: { include_usage: true },
          frequency_penalty: 0.4,
        }),
      }),
      e,
    );
    assert.equal(zhipuV4Chat.res.status, 200, zhipuV4Chat.text);
    const zhipuV4Call = calls.find((c) => c.url === "https://open.bigmodel.cn/api/paas/v4/chat/completions");
    if (!zhipuV4Call) throw new Error("missing zhipu v4 upstream");
    assert.equal(zhipuV4Call.headers.get("authorization"), "Bearer sk-z");
    assert.equal("stream_options" in zhipuV4Call.body, false);
    assert.equal("frequency_penalty" in zhipuV4Call.body, false);
    assert.equal((zhipuV4Chat.body.choices as { message: { content: string } }[])[0].message.content, "hello");

    const pplxChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", name: "bob", content: "hi pplx" }],
          top_p: 1,
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(pplxChat.res.status, 200, pplxChat.text);
    const pplxCall = calls.find((c) => c.url === "https://api.perplexity.ai/chat/completions");
    if (!pplxCall) throw new Error("missing perplexity upstream");
    assert.equal(pplxCall.body.top_p, 0.99);
    assert.deepEqual(pplxCall.body.messages, [{ role: "user", content: "hi pplx" }]);
    assert.equal("stream_options" in pplxCall.body, false);

    const cfChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "llama-3",
          messages: [{ role: "user", content: "hi cf" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(cfChat.res.status, 200, cfChat.text);
    const cfCall = calls.find((c) => c.url.includes("/ai/v1/chat/completions"));
    if (!cfCall) throw new Error("missing cloudflare upstream");
    assert.equal(cfCall.url, "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions");
    assert.deepEqual(cfCall.body.stream_options, { include_usage: true });
    assert.equal(cfChat.body.model, "llama-3");
    assert.match(String(cfChat.body.id), /^chatcmpl-/);
    assert.equal((cfChat.body.choices as { message: { content: string } }[])[0].message.content, "hello cf");
    assert.notEqual((cfChat.body.usage as { prompt_tokens: number }).prompt_tokens, 0);

    const baiduV2Chat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "ernie-4.0-8k-search",
          messages: [{ role: "user", content: "hi v2" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(baiduV2Chat.res.status, 200, baiduV2Chat.text);
    const baiduV2Call = calls.find((c) => c.url === "https://qianfan.baidubce.com/v2/chat/completions");
    if (!baiduV2Call) throw new Error("missing baidu v2 upstream");
    assert.equal(baiduV2Call.body.model, "ernie-4.0-8k");
    assert.deepEqual(baiduV2Call.body.web_search, {
      enable: true,
      enable_citation: true,
      enable_trace: true,
      enable_status: false,
    });
    assert.equal(baiduV2Call.headers.get("authorization"), "Bearer tok");
    assert.equal(baiduV2Call.headers.get("appid"), "app-1");
    assert.equal((baiduV2Chat.body.choices as { message: { content: string } }[])[0].message.content, "hello v2");

    const mmChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "abab6.5s-chat",
          messages: [{ role: "user", content: "hi mm" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(mmChat.res.status, 200, mmChat.text);
    const mmCall = calls.find((c) => c.url === "https://api.minimax.chat/v1/text/chatcompletion_v2");
    if (!mmCall) throw new Error("missing minimax upstream");
    assert.deepEqual(mmCall.body.stream_options, { include_usage: true });
    assert.equal((mmChat.body.choices as { message: { content: string } }[])[0].message.content, "hello");
  } finally {
    globalThis.fetch = origFetch;
  }
});
