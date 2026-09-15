import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ADVANCED_CUSTOM } from "../src/constants.js";
import { getModelQuotaTypes, getModelSupportEndpointTypes, invalidatePricingCache } from "../src/pricing-cache.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
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
  return { token, auth, login };
}

test("original GetModelQuotaTypes is empty until GetPricing fills the cache", () => {
  invalidatePricingCache();
  assert.deepEqual(getModelQuotaTypes("gemini-3.5-flash"), []);
  assert.deepEqual(getModelSupportEndpointTypes("gemini-3.5-flash"), []);
});

test("original GetAllModelsMeta JSON uses GetModelSupportEndpointTypes and GetModelQuotaTypes", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.insertChannel({
    name: "advanced-custom-channel",
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    key: "advanced-custom-key",
    models: "gemini-3.5-flash",
    group: "default",
    settings: JSON.stringify({
      advanced_custom: {
        advanced_routes: [
          { incoming_path: "/v1/chat/completions", upstream_path: "/v1/chat/completions" },
          {
            incoming_path: "/v1/responses",
            upstream_path: "/v1beta/models/{model}:generateContent",
            converter: "openai_responses_to_gemini_generate_content",
            models: ["re:^gemini-"],
          },
        ],
      },
    }),
  });
  const listed = await json(
    new Request("http://local/api/models/search?include_channel_models=true&keyword=gemini-3.5-flash", { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  const items = ((listed.body.data as { items?: Record<string, unknown>[] })?.items || []) as {
    model_name: string;
    supported_endpoints?: string[];
    quota_types?: number[];
  }[];
  const row = items.find((m) => m.model_name === "gemini-3.5-flash");
  assert.ok(row);
  assert.deepEqual(row.supported_endpoints, ["openai", "openai-response"]);
  assert.deepEqual(row.quota_types, [0]);
  assert.deepEqual(getModelSupportEndpointTypes("gemini-3.5-flash"), ["openai", "openai-response"]);
  assert.deepEqual(getModelQuotaTypes("gemini-3.5-flash"), [0]);
});
