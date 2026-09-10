import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_TYPE_JINA,
  CHANNEL_TYPE_MISTRAL,
  CHANNEL_TYPE_MOKA,
  CHANNEL_TYPE_PALM,
  CHANNEL_TYPE_SILICONFLOW,
  CHANNEL_TYPE_TENCENT,
} from "../src/constants.js";
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

test("original Tencent, Mistral, Moka, Jina, SiliconFlow, and PaLM ConvertOpenAIRequest JSON is sent upstream with original URLs and DoResponse fields", async () => {
  const { e, auth, sk } = await boot();
  await addChannel(e, auth, {
    name: "tencent-native",
    type: CHANNEL_TYPE_TENCENT,
    key: "1300000000|AKIDxxxxxxxx|secretxxxxxxxx",
    models: "hunyuan-lite",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "tencent-tokenhub",
    type: CHANNEL_TYPE_TENCENT,
    key: "sk-tokenhub",
    models: "hunyuan-pro",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "mistral",
    type: CHANNEL_TYPE_MISTRAL,
    key: "ms",
    models: "mistral-small-latest",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "moka",
    type: CHANNEL_TYPE_MOKA,
    key: "mk",
    models: "m3e-base",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "jina",
    type: CHANNEL_TYPE_JINA,
    key: "jk",
    models: "jina-clip-v1,jina-reranker-v2-base-multilingual",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "siliconflow",
    type: CHANNEL_TYPE_SILICONFLOW,
    key: "sfk",
    models: "Qwen/Qwen2-7B-Instruct,BAAI/bge-reranker-v2-m3",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "palm",
    type: CHANNEL_TYPE_PALM,
    key: "palm-key",
    models: "PaLM-2",
    group: "default",
    base_url: "https://generativelanguage.googleapis.com",
  });

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers; raw: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: new Headers(init?.headers), raw });
    if (url === "https://hunyuan.tencentcloudapi.com/") {
      if ((body as { Stream?: boolean }).Stream) {
        return new Response('data: {"Choices":[{"Delta":{"Content":"hello hunyuan"},"FinishReason":"stop"}]}\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          Response: {
            Id: "hy-1",
            Choices: [{ Message: { Role: "assistant", Content: "hello hunyuan" }, FinishReason: "stop" }],
            Usage: { PromptTokens: 2, CompletionTokens: 3, TotalTokens: 5 },
            Error: { Code: 0, Message: "" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/embeddings") || url.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          object: "list",
          model: "upstream-embed",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("api.jina.ai/v1/rerank")) {
      return new Response(
        JSON.stringify({
          results: [{ index: 0, relevance_score: 0.9 }],
          usage: { total_tokens: 11, prompt_tokens: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("api.siliconflow.cn/v1/rerank")) {
      return new Response(
        JSON.stringify({
          results: [{ index: 1, relevance_score: 0.8 }],
          meta: { tokens: { input_tokens: 6, output_tokens: 2 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("generateMessage")) {
      return new Response(
        JSON.stringify({ candidates: [{ author: "1", content: "hello palm" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/chat/completions") || url.includes("tokenhub.tencentmaas.com")) {
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
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const tencentChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "hunyuan-lite",
          messages: [{ role: "user", content: "hi hunyuan" }],
          temperature: 0.5,
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(tencentChat.res.status, 200, tencentChat.text);
    const tencentCall = calls.find((c) => c.url === "https://hunyuan.tencentcloudapi.com/");
    if (!tencentCall) throw new Error("missing tencent native upstream");
    assert.deepEqual(tencentCall.body.Messages, [{ Role: "user", Content: "hi hunyuan" }]);
    assert.equal(tencentCall.body.Model, "hunyuan-lite");
    assert.equal(tencentCall.body.Temperature, 0.5);
    assert.equal("stream_options" in tencentCall.body, false);
    const tencentAuth = tencentCall.headers.get("authorization") || "";
    assert.equal(tencentAuth.startsWith("Bearer "), false);
    assert.match(tencentAuth, /^TC3-HMAC-SHA256 Credential=AKIDxxxxxxxx\//);
    assert.equal(tencentCall.headers.get("X-TC-Action"), "ChatCompletions");
    assert.equal(tencentCall.headers.get("X-TC-Version"), "2023-09-01");
    assert.ok(tencentCall.headers.get("X-TC-Timestamp"));
    assert.equal(tencentChat.body.id, "hy-1");
    assert.equal(tencentChat.body.object, "chat.completion");
    assert.equal((tencentChat.body.choices as { message: { content: string } }[])[0].message.content, "hello hunyuan");
    assert.equal((tencentChat.body.usage as { total_tokens: number }).total_tokens, 5);

    const tencentStream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "hunyuan-lite",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(tencentStream.res.status, 200, tencentStream.text);
    assert.match(tencentStream.text, /"model":"tencent-hunyuan"/);
    assert.match(tencentStream.text, /hello hunyuan/);
    assert.match(tencentStream.text, /data: \[DONE\]/);

    const tokenHubChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "hunyuan-pro",
          messages: [{ role: "user", content: "hi tokenhub" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(tokenHubChat.res.status, 200, tokenHubChat.text);
    const hubCall = calls.find((c) => c.url === "https://tokenhub.tencentmaas.com/v1/chat/completions");
    if (!hubCall) throw new Error("missing tencent tokenhub upstream");
    assert.equal(hubCall.headers.get("authorization"), "Bearer sk-tokenhub");
    assert.equal("stream_options" in hubCall.body, false);
    assert.equal((tokenHubChat.body.choices as { message: { content: string } }[])[0].message.content, "hello");

    const mistralChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "mistral-small-latest",
          messages: [{ role: "user", name: "alice", content: "hi mistral" }],
          stream_options: { include_usage: true },
          frequency_penalty: 0.4,
        }),
      }),
      e,
    );
    assert.equal(mistralChat.res.status, 200, mistralChat.text);
    const mistralCall = calls.find((c) => c.url === "https://api.mistral.ai/v1/chat/completions");
    if (!mistralCall) throw new Error("missing mistral upstream");
    assert.equal("stream_options" in mistralCall.body, false);
    assert.equal("frequency_penalty" in mistralCall.body, false);
    assert.equal("name" in (mistralCall.body.messages as Record<string, unknown>[])[0], false);
    assert.deepEqual((mistralCall.body.messages as { content: unknown }[])[0].content, [{ type: "text", text: "hi mistral" }]);

    const mokaEmbed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "m3e-base", input: "hello world" }),
      }),
      e,
    );
    assert.equal(mokaEmbed.res.status, 200, mokaEmbed.text);
    const mokaCall = calls.find((c) => c.url === "https://api.moka.ai/embeddings");
    if (!mokaCall) throw new Error("missing moka upstream");
    assert.deepEqual(mokaCall.body, { input: ["hello world"], model: "m3e-base" });
    assert.equal(mokaEmbed.body.object, "list");
    assert.equal(mokaEmbed.body.model, "baidu-embedding");

    const jinaEmbed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "jina-clip-v1", input: ["hi"], encoding_format: "float" }),
      }),
      e,
    );
    assert.equal(jinaEmbed.res.status, 200, jinaEmbed.text);
    const jinaEmbedCall = calls.find((c) => c.url === "https://api.jina.ai/v1/embeddings");
    if (!jinaEmbedCall) throw new Error("missing jina embeddings upstream");
    assert.equal("encoding_format" in jinaEmbedCall.body, false);

    const jinaRerank = await json(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "jina-reranker-v2-base-multilingual",
          query: "q",
          documents: ["a", "b"],
        }),
      }),
      e,
    );
    assert.equal(jinaRerank.res.status, 200, jinaRerank.text);
    const jinaRerankCall = calls.find((c) => c.url === "https://api.jina.ai/v1/rerank");
    if (!jinaRerankCall) throw new Error("missing jina rerank upstream");
    assert.equal((jinaRerank.body.usage as { prompt_tokens: number }).prompt_tokens, 11);

    const jinaChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "jina-clip-v1",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(jinaChat.res.status, 400, jinaChat.text);
    assert.match(String(jinaChat.body.error && (jinaChat.body.error as { message?: string }).message || jinaChat.text), /invalid relay mode/);

    const sfFim = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "Qwen/Qwen2-7B-Instruct",
          prefix: "def ",
          suffix: ":",
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(sfFim.res.status, 200, sfFim.text);
    const sfCall = calls.find((c) => c.url === "https://api.siliconflow.cn/v1/chat/completions");
    if (!sfCall) throw new Error("missing siliconflow upstream");
    assert.deepEqual(sfCall.body.messages, [{ role: "user", content: "" }]);
    assert.equal(sfCall.body.prefix, "def ");
    assert.deepEqual(sfCall.body.stream_options, { include_usage: true });

    const sfRerank = await json(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "BAAI/bge-reranker-v2-m3",
          query: "q",
          documents: ["a"],
        }),
      }),
      e,
    );
    assert.equal(sfRerank.res.status, 200, sfRerank.text);
    const sfRerankCall = calls.find((c) => c.url === "https://api.siliconflow.cn/v1/rerank");
    if (!sfRerankCall) throw new Error("missing siliconflow rerank upstream");
    assert.equal((sfRerank.body.usage as { prompt_tokens: number }).prompt_tokens, 6);
    assert.equal((sfRerank.body.usage as { completion_tokens: number }).completion_tokens, 2);
    assert.equal((sfRerank.body.usage as { total_tokens: number }).total_tokens, 8);

    const palmChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "PaLM-2",
          messages: [{ role: "user", content: "hi palm" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(palmChat.res.status, 200, palmChat.text);
    const palmCall = calls.find((c) => c.url.endsWith("/v1beta2/models/chat-bison-001:generateMessage"));
    if (!palmCall) throw new Error("missing palm upstream");
    assert.equal(palmCall.url, "https://generativelanguage.googleapis.com/v1beta2/models/chat-bison-001:generateMessage");
    assert.equal(palmCall.headers.get("x-goog-api-key"), "palm-key");
    assert.equal(palmCall.headers.get("authorization"), null);
    assert.deepEqual(palmCall.body.stream_options, { include_usage: true });
    assert.equal((palmChat.body.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello palm");
    assert.equal((palmChat.body.choices as { finish_reason: string }[])[0].finish_reason, "stop");

    const palmStream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "PaLM-2",
          stream: true,
          messages: [{ role: "user", content: "hi palm" }],
        }),
      }),
      e,
    );
    assert.equal(palmStream.res.status, 200, palmStream.text);
    assert.match(palmStream.text, /"model":"palm2"/);
    assert.match(palmStream.text, /hello palm/);
    assert.match(palmStream.text, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
