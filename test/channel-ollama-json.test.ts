import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OLLAMA } from "../src/constants.js";
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

async function addOllama(e: Env, auth: Record<string, string>, extra: Record<string, unknown> = {}): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: extra.name || "ollama-admin",
        type: CHANNEL_TYPE_OLLAMA,
        key: extra.key ?? "ollama-key",
        models: "llama3",
        group: "default",
        base_url: extra.base_url ?? "http://ollama.local",
      }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original OllamaVersion JSON fields", async () => {
  const { e, auth } = await boot();
  const id = await addOllama(e, auth, { key: "line-a\nline-b" });
  const openaiId = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "not-ollama", type: 1, key: "sk-x", models: "gpt-4o", group: "default" }),
    }),
    e,
  );
  const notOllama = Number((openaiId.body.data as { id: number }).id);

  const origFetch = globalThis.fetch;
  const seen: { url: string; auth: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, auth: req.headers.get("authorization") || "" });
    if (req.url === "http://ollama.local/api/version") {
      const authz = req.headers.get("authorization");
      if (authz === "Bearer line-a") {
        return new Response(JSON.stringify({ version: "0.11.4" }), { status: 200 });
      }
      return new Response("wrong key", { status: 401 });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  try {
    const ok = await json(new Request("http://local/api/channel/ollama/version/" + id, { headers: auth }), e);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.body.success, true);
    assert.deepEqual(ok.body.data, { version: "0.11.4" });
    assert.equal(seen[0]?.auth, "Bearer line-a");

    const invalidId = await json(new Request("http://local/api/channel/ollama/version/abc", { headers: auth }), e);
    assert.equal(invalidId.res.status, 400);
    assert.equal(invalidId.body.success, false);
    assert.equal(invalidId.body.message, "Invalid channel id");

    const missing = await json(new Request("http://local/api/channel/ollama/version/999999", { headers: auth }), e);
    assert.equal(missing.res.status, 404);
    assert.equal(missing.body.message, "Channel not found");

    const wrongType = await json(new Request("http://local/api/channel/ollama/version/" + notOllama, { headers: auth }), e);
    assert.equal(wrongType.res.status, 400);
    assert.equal(wrongType.body.message, "This operation is only supported for Ollama channels");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original FetchOllamaVersion error JSON messages", async () => {
  const { e, auth } = await boot();
  const id = await addOllama(e, auth);
  const origFetch = globalThis.fetch;
  let mode: "status" | "empty" | "invalid" = "status";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "http://ollama.local/api/version") {
      if (mode === "status") return new Response("down", { status: 503 });
      if (mode === "empty") return new Response(JSON.stringify({ version: "" }), { status: 200 });
      return new Response("hello", { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const status = await json(new Request("http://local/api/channel/ollama/version/" + id, { headers: auth }), e);
    assert.equal(status.res.status, 200);
    assert.equal(status.body.success, false);
    assert.equal(status.body.message, "获取Ollama版本失败: 查询版本失败 503: down");
    assert.equal("data" in status.body, false);
    assert.deepEqual(Object.keys(status.body).sort(), ["message", "success"]);

    mode = "empty";
    const empty = await json(new Request("http://local/api/channel/ollama/version/" + id, { headers: auth }), e);
    assert.equal(empty.body.message, "获取Ollama版本失败: 未返回版本信息");
    assert.equal("data" in empty.body, false);

    mode = "invalid";
    const invalid = await json(new Request("http://local/api/channel/ollama/version/" + id, { headers: auth }), e);
    assert.equal(invalid.body.success, false);
    assert.match(String(invalid.body.message), /^获取Ollama版本失败: 解析响应失败: /);
    assert.equal("data" in invalid.body, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original OllamaPullModel / OllamaDeleteModel JSON fields", async () => {
  const { e, auth } = await boot();
  const id = await addOllama(e, auth);
  const origFetch = globalThis.fetch;
  const seen: { method: string; url: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith("http://ollama.local/api/")) {
      seen.push({ method: req.method, url: req.url, body: await req.text() });
      if (req.url.endsWith("/api/pull") && seen.filter((s) => s.url.endsWith("/api/pull")).length === 1) {
        return new Response("", { status: 200 });
      }
      if (req.url.endsWith("/api/pull")) return new Response("nope", { status: 404 });
      if (req.url.endsWith("/api/delete")) return new Response("", { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const missing = await json(
      new Request("http://local/api/channel/ollama/pull", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ channel_id: id }),
      }),
      e,
    );
    assert.equal(missing.res.status, 400);
    assert.equal(missing.body.message, "Channel ID and model name are required");

    const badJson = await json(
      new Request("http://local/api/channel/ollama/pull", { method: "POST", headers: auth, body: "hello" }),
      e,
    );
    assert.equal(badJson.res.status, 400);
    assert.equal(badJson.body.message, "Invalid request parameters");

    const pulled = await json(
      new Request("http://local/api/channel/ollama/pull", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ channel_id: id, model_name: "llama3" }),
      }),
      e,
    );
    assert.equal(pulled.res.status, 200);
    assert.equal(pulled.body.success, true);
    assert.equal(pulled.body.message, "Model llama3 pulled successfully");
    assert.equal(pulled.body.data, undefined);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "http://ollama.local/api/pull");
    assert.equal(seen[0]?.body, JSON.stringify({ name: "llama3" }));

    const failed = await json(
      new Request("http://local/api/channel/ollama/pull", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ channel_id: id, model_name: "missing" }),
      }),
      e,
    );
    assert.equal(failed.res.status, 500);
    assert.equal(failed.body.success, false);
    assert.equal(failed.body.message, "Failed to pull model: 拉取模型失败 404: nope");

    const deleted = await json(
      new Request("http://local/api/channel/ollama/delete", {
        method: "DELETE",
        headers: auth,
        body: JSON.stringify({ channel_id: id, model_name: "llama3" }),
      }),
      e,
    );
    assert.equal(deleted.res.status, 200);
    assert.equal(deleted.body.message, "Model llama3 deleted successfully");
    assert.equal(deleted.body.data, undefined);
    const del = seen.find((s) => s.url.endsWith("/api/delete"));
    assert.equal(del?.method, "DELETE");
    assert.equal(del?.body, JSON.stringify({ name: "llama3" }));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original OllamaPullModelStream SSE JSON fields", async () => {
  const { e, auth } = await boot();
  const id = await addOllama(e, auth);
  const origFetch = globalThis.fetch;
  let pullBody = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "http://ollama.local/api/pull") {
      pullBody = await req.text();
      return new Response(
        '{"status":"pulling","digest":"sha256:abc","total":10,"completed":3}\n{"status":"success"}\n',
        { status: 200 },
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const res = await handleFetch(
      new Request("http://local/api/channel/ollama/pull/stream", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ channel_id: id, model_name: "llama3" }),
      }),
      e,
      ctx(),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.equal(pullBody, JSON.stringify({ name: "llama3", stream: true }));
    assert.match(text, /data: \{"status":"pulling","digest":"sha256:abc","total":10,"completed":3\}/);
    assert.match(text, /data: \{"status":"success"\}/);
    assert.match(text, /data: \{"message":"Model llama3 pulled successfully"\}/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original OllamaPullModelStream error SSE keeps first upstream failure JSON", async () => {
  const { e, auth } = await boot();
  const id = await addOllama(e, auth);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "http://ollama.local/api/pull") {
      return new Response("busy", { status: 503 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const res = await handleFetch(
      new Request("http://local/api/channel/ollama/pull/stream", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ channel_id: id, model_name: "llama3" }),
      }),
      e,
      ctx(),
    );
    const text = await res.text();
    assert.match(text, /data: \{"error":"拉取模型失败 503: busy"\}/);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /pulled successfully/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
