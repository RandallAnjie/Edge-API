import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENAI_MODEL_CREATED, OPENAI_MODELS_MAP } from "../src/channel-models.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const GEMINI_MODEL_KEYS = [
  "name",
  "baseModelId",
  "version",
  "displayName",
  "description",
  "inputTokenLimit",
  "outputTokenLimit",
  "supportedGenerationMethods",
  "thinking",
  "temperature",
  "maxTemperature",
  "topP",
  "topK",
] as const;

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

async function apiKey(e: Env, auth: Record<string, string>): Promise<string> {
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "retrieve-models", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tk.body.success, true, String(tk.body.message));
  return (tk.body.data as { key: string }).key;
}

test("original RetrieveModel JSON is catalog-only with nil supported_endpoint_types", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("SelfUseModeEnabled", "true");
  await store.insertChannel({
    name: "custom-only",
    type: 1,
    key: "sk-custom",
    models: "zz-custom-retrieve-only",
    group: "default",
  });
  const sk = await apiKey(e, auth);
  const skAuth = { authorization: "Bearer " + sk };

  const catalog = OPENAI_MODELS_MAP["gpt-4o-mini"];
  assert.ok(catalog);
  assert.equal(catalog.owned_by, "openai");
  assert.equal(OPENAI_MODELS_MAP["zz-custom-retrieve-only"], undefined);

  const listed = await json(new Request("http://local/v1/models", { headers: skAuth }), e);
  const listedIds = ((listed.body.data as { id: string }[]) || []).map((m) => m.id);
  assert.equal(listedIds.includes("zz-custom-retrieve-only"), true);

  const hit = await json(new Request("http://local/v1/models/gpt-4o-mini", { headers: skAuth }), e);
  assert.equal(hit.res.status, 200);
  assert.equal(hit.body.error, undefined);
  assert.deepEqual(Object.keys(hit.body).sort(), ["created", "id", "object", "owned_by", "supported_endpoint_types"]);
  assert.equal(hit.body.id, "gpt-4o-mini");
  assert.equal(hit.body.object, "model");
  assert.equal(hit.body.created, OPENAI_MODEL_CREATED);
  assert.equal(hit.body.owned_by, "openai");
  assert.equal(hit.body.supported_endpoint_types, null);

  const googRetrieve = await json(
    new Request("http://local/v1/models/gpt-4o-mini", { headers: { ...skAuth, "x-goog-api-key": "g" } }),
    e,
  );
  assert.equal(googRetrieve.body.id, "gpt-4o-mini");
  assert.equal(googRetrieve.body.supported_endpoint_types, null);
  assert.equal(googRetrieve.body.object, "model");

  const custom = await json(new Request("http://local/v1/models/zz-custom-retrieve-only", { headers: skAuth }), e);
  assert.equal(custom.res.status, 200);
  const customErr = custom.body.error as { message: string; type: string; param: string; code: string };
  assert.deepEqual(Object.keys(customErr).sort(), ["code", "message", "param", "type"]);
  assert.equal(customErr.message, "The model 'zz-custom-retrieve-only' does not exist");
  assert.equal(customErr.type, "invalid_request_error");
  assert.equal(customErr.param, "model");
  assert.equal(customErr.code, "model_not_found");

  const anth = await json(
    new Request("http://local/v1/models/gpt-4o-mini", {
      headers: { ...skAuth, "x-api-key": "a", "anthropic-version": "2023-06-01" },
    }),
    e,
  );
  assert.equal(anth.res.status, 200);
  assert.deepEqual(Object.keys(anth.body).sort(), ["created_at", "display_name", "id", "type"]);
  assert.equal(anth.body.id, "gpt-4o-mini");
  assert.equal(anth.body.type, "model");
  assert.equal(anth.body.display_name, "gpt-4o-mini");
  assert.equal(anth.body.created_at, "2021-07-20T10:40:00Z");

  const gem = await json(new Request("http://local/v1/models", { headers: { ...skAuth, "x-goog-api-key": "g" } }), e);
  assert.equal(gem.body.nextPageToken, null);
  const models = (gem.body.models as Record<string, unknown>[]) || [];
  const gemCustom = models.find((m) => m.name === "zz-custom-retrieve-only");
  assert.ok(gemCustom);
  assert.deepEqual(Object.keys(gemCustom), [...GEMINI_MODEL_KEYS]);
  assert.equal(gemCustom.name, "zz-custom-retrieve-only");
  assert.equal(gemCustom.displayName, "zz-custom-retrieve-only");
  for (const key of GEMINI_MODEL_KEYS) {
    if (key === "name" || key === "displayName") continue;
    assert.equal(gemCustom[key], null, key);
  }
});
