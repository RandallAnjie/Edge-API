import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_COZE, CHANNEL_TYPE_DIFY } from "../src/constants.js";
import { clearBaiduAccessTokenCache } from "../src/baidu-convert.js";
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

test("original Cohere, Dify, Coze, and Baidu ConvertOpenAIRequest JSON is sent upstream with original URLs and DoResponse fields", async () => {
  const { e, auth, sk } = await boot();
  clearBaiduAccessTokenCache();
  const cohere = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "cohere",
        type: CHANNEL_TYPE_COHERE,
        key: "ck",
        models: "command-r,rerank-english-v3.0",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(cohere.body.success, true, String(cohere.body.message));
  const dify = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "dify",
        type: CHANNEL_TYPE_DIFY,
        key: "dk",
        models: "dify-bot",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(dify.body.success, true, String(dify.body.message));
  const coze = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "coze",
        type: CHANNEL_TYPE_COZE,
        key: "zk",
        models: "moonshot-v1-8k",
        group: "default",
        other: "bot-xyz",
      }),
    }),
    e,
  );
  assert.equal(coze.body.success, true, String(coze.body.message));
  const baidu = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "baidu",
        type: CHANNEL_TYPE_BAIDU,
        key: "ak|sk",
        models: "ERNIE-4.0,Embedding-V1",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(baidu.body.success, true, String(baidu.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url.includes("/oauth/2.0/token")) {
      return new Response(JSON.stringify({ access_token: "bd-token", expires_in: 2592000 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v3/chat/retrieve")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { status: "completed", usage: { token_count: 9, output_count: 4, input_count: 5 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v3/chat/message/list")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: [{ type: "answer", content: "hello coze", created_at: 1700000000 }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v3/chat")) {
      return new Response(JSON.stringify({ code: 0, data: { id: "chat1", conversation_id: "conv1" } }), {
        headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/rerank")) {
      return new Response(
        JSON.stringify({
          results: [{ index: 0, relevance_score: 0.9, document: { text: "a" } }],
          meta: { billed_units: { input_tokens: 7, output_tokens: 0 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/embeddings/")) {
      return new Response(
        JSON.stringify({
          id: "emb-1",
          object: "embedding_list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/chat-messages")) {
      return new Response(
        JSON.stringify({
          conversation_id: "dify-conv",
          answer: "hello dify",
          metadata: { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/chat") && String(init?.body || "").includes('"stream":true')) {
      const ndjson = [
        JSON.stringify({ text: "ok ", is_finished: false }),
        JSON.stringify({
          is_finished: true,
          finish_reason: "COMPLETE",
          response: { meta: { billed_units: { input_tokens: 2, output_tokens: 2 } } },
        }),
      ].join("\n");
      return new Response(ndjson, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (url.includes("/v1/chat")) {
      return new Response(
        JSON.stringify({
          response_id: "resp-cohere",
          text: "hello cohere",
          finish_reason: "COMPLETE",
          meta: { billed_units: { input_tokens: 3, output_tokens: 5 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "as-baidu",
        created: 11,
        result: "hello baidu",
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const chat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "command-r",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi cohere" },
          ],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    const cohereCall = calls.find((c) => c.url.endsWith("/v1/chat"));
    if (!cohereCall) throw new Error("missing cohere upstream");
    assert.equal(cohereCall.url, "https://api.cohere.ai/v1/chat");
    assert.equal(cohereCall.body.model, "command-r");
    assert.equal(cohereCall.body.message, "hi cohere");
    assert.deepEqual(cohereCall.body.chat_history, [{ role: "SYSTEM", message: "sys" }]);
    assert.equal(cohereCall.body.stream, false);
    assert.equal(cohereCall.body.max_tokens, 4000);
    assert.equal("safety_mode" in cohereCall.body, false);
    assert.equal((chat.body.choices as { message: { content: string } }[])[0].message.content, "hello cohere");
    assert.equal((chat.body.choices as { finish_reason: string }[])[0].finish_reason, "stop");
    assert.equal((chat.body.usage as { total_tokens: number }).total_tokens, 8);

    const rerank = await json(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "rerank-english-v3.0",
          query: "q",
          documents: ["a", "b"],
          top_n: 0,
        }),
      }),
      e,
    );
    assert.equal(rerank.res.status, 200, rerank.text);
    const rerankCall = calls.find((c) => c.url.endsWith("/v1/rerank"));
    if (!rerankCall) throw new Error("missing cohere rerank upstream");
    assert.equal(rerankCall.body.top_n, 1);
    assert.equal(rerankCall.body.return_documents, true);
    assert.equal((rerank.body.results as unknown[]).length, 1);
    assert.equal((rerank.body.usage as { prompt_tokens: number }).prompt_tokens, 7);

    const difyChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "dify-bot",
          user: "alice",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi dify" },
          ],
        }),
      }),
      e,
    );
    assert.equal(difyChat.res.status, 200, difyChat.text);
    const difyCall = calls.find((c) => c.url.endsWith("/v1/chat-messages"));
    if (!difyCall) throw new Error("missing dify upstream");
    assert.equal(difyCall.url, "https://api.dify.ai/v1/chat-messages");
    assert.deepEqual(difyCall.body.inputs, {});
    assert.equal(difyCall.body.query, "SYSTEM: \nsys\nUSER: \nhi dify\n");
    assert.equal(difyCall.body.response_mode, "blocking");
    assert.equal(difyCall.body.user, "alice");
    assert.equal(difyCall.body.auto_generate_name, false);
    assert.deepEqual(difyCall.body.files, []);
    assert.equal(difyChat.body.id, "dify-conv");
    assert.equal((difyChat.body.choices as { message: { content: string } }[])[0].message.content, "hello dify");
    assert.equal((difyChat.body.usage as { total_tokens: number }).total_tokens, 5);

    const cozeChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "moonshot-v1-8k",
          user: "u1",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi coze" },
          ],
        }),
      }),
      e,
    );
    assert.equal(cozeChat.res.status, 200, cozeChat.text);
    const cozeCreate = calls.find((c) => c.url === "https://api.coze.cn/v3/chat");
    if (!cozeCreate) throw new Error("missing coze create upstream");
    assert.equal(cozeCreate.body.bot_id, "bot-xyz");
    assert.equal(cozeCreate.body.user_id, "u1");
    assert.deepEqual(cozeCreate.body.additional_messages, [{ role: "user", content: "hi coze", content_type: "text" }]);
    assert.equal("stream" in cozeCreate.body, false);
    assert.equal(calls.some((c) => c.url.includes("/v3/chat/retrieve")), true);
    assert.equal(calls.some((c) => c.url.includes("/v3/chat/message/list")), true);
    assert.equal((cozeChat.body.choices as { message: { content: string } }[])[0].message.content, "hello coze");
    assert.equal((cozeChat.body.usage as { prompt_tokens: number }).prompt_tokens, 5);
    assert.equal((cozeChat.body.usage as { completion_tokens: number }).completion_tokens, 4);
    assert.equal((cozeChat.body.usage as { total_tokens: number }).total_tokens, 9);

    const baiduChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "ERNIE-4.0",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi baidu" },
          ],
          max_tokens: 1,
          temperature: 0.2,
        }),
      }),
      e,
    );
    assert.equal(baiduChat.res.status, 200, baiduChat.text);
    const baiduCall = calls.find((c) => c.url.includes("wenxinworkshop/chat/completions_pro"));
    if (!baiduCall) throw new Error("missing baidu chat upstream");
    assert.equal(
      baiduCall.url,
      "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro?access_token=bd-token",
    );
    assert.equal(baiduCall.headers.get("authorization"), "Bearer ak|sk");
    assert.equal(baiduCall.body.system, "sys");
    assert.deepEqual(baiduCall.body.messages, [{ role: "user", content: "hi baidu" }]);
    assert.equal(baiduCall.body.max_output_tokens, 2);
    assert.equal(baiduCall.body.temperature, 0.2);
    assert.equal("model" in baiduCall.body, false);
    assert.equal((baiduChat.body.choices as { message: { content: string } }[])[0].message.content, "hello baidu");
    assert.equal((baiduChat.body.usage as { total_tokens: number }).total_tokens, 10);

    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "Embedding-V1", input: "hello" }),
      }),
      e,
    );
    assert.equal(embed.res.status, 200, embed.text);
    const embedCall = calls.find((c) => c.url.includes("wenxinworkshop/embeddings/embedding-v1"));
    if (!embedCall) throw new Error("missing baidu embedding upstream");
    assert.deepEqual(embedCall.body, { input: ["hello"] });
    assert.equal(embed.body.object, "list");
    assert.equal(embed.body.model, "baidu-embedding");
    assert.deepEqual(embed.body.data, [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }]);

    const stream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "command-r",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(stream.res.status, 200, stream.text);
    const sse = String(stream.body.raw || stream.text);
    assert.equal(sse.includes('"content":"ok "'), true);
    assert.equal(sse.includes('"finish_reason":"stop"'), true);
    assert.equal(sse.includes("data: [DONE]"), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});
