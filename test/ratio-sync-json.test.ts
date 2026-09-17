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
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

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
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { auth };
}

test("original FetchUpstreamRatios gin.H omits message; empty upstreams omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await json(new Request("http://local/api/ratio_sync/fetch", { method: "POST", headers: auth, body: "{}" }), e);
  assert.equal(empty.res.status, 200);
  assert.equal(empty.body.success, false);
  assert.equal(empty.body.message, "无有效上游渠道");
  assert.equal("data" in empty.body, false);
  assert.deepEqual(Object.keys(empty.body).sort(), ["message", "success"]);

  const bad = await json(new Request("http://local/api/ratio_sync/fetch", { method: "POST", headers: auth, body: "{" }), e);
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.message, "请求参数格式错误");
  assert.equal("data" in bad.body, false);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/pricing")) {
      return new Response(
        JSON.stringify({ success: true, data: { model_ratio: { "gpt-sync": 2 }, completion_ratio: { "gpt-sync": 1 } } }),
        { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
      );
    }
    return origFetch(input as RequestInfo, undefined);
  };
  try {
    const fetched = await json(
      new Request("http://local/api/ratio_sync/fetch", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          upstreams: [{ id: 0, name: "upstream", base_url: "https://example.test", endpoint: "/api/pricing" }],
          timeout: 5,
        }),
      }),
      e,
    );
    assert.equal(fetched.res.status, 200);
    assert.equal(fetched.body.success, true);
    assert.equal("message" in fetched.body, false);
    assert.deepEqual(Object.keys(fetched.body).sort(), ["data", "success"]);
    const data = fetched.body.data as { test_results: { name: string; status: string }[] };
    assert.equal(data.test_results[0].name, "upstream");
    assert.equal(data.test_results[0].status, "success");
  } finally {
    globalThis.fetch = origFetch;
  }

  const channels = await json(new Request("http://local/api/ratio_sync/channels", { headers: auth }), e);
  assert.equal(channels.body.success, true);
  assert.equal(channels.body.message, "");
  const rows = channels.body.data as { id: number; name: string; type: number }[];
  assert.equal(rows.some((r) => r.id === -100 && r.name === "官方倍率预设"), true);
  assert.equal(rows.some((r) => r.id === -101 && r.name === "models.dev 价格预设" && r.type === 0), true);
});
