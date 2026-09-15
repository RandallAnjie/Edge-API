import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTOR_MODELS, OPENAI_MODEL_CREATED } from "../src/channel-models.js";
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

test("original ChannelListModels JSON is UniqBy-first static catalog with nil endpoint types", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const listed = await json(new Request("http://local/api/channel/models", { headers: auth }), e);
  assert.equal(listed.res.status, 200);
  assert.equal(listed.body.success, true);
  const rows = listed.body.data as {
    id: string;
    object: string;
    created: number;
    owned_by: string;
    supported_endpoint_types: unknown;
  }[];
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, ADAPTOR_MODELS.length);
  assert.equal(rows[0].id, ADAPTOR_MODELS[0].id);
  assert.equal(rows[0].owned_by, ADAPTOR_MODELS[0].owned_by);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["created", "id", "object", "owned_by", "supported_endpoint_types"]);
  assert.equal(rows[0].object, "model");
  assert.equal(rows[0].created, OPENAI_MODEL_CREATED);
  assert.equal(rows[0].supported_endpoint_types, null);

  const mini = rows.find((row) => row.id === "gpt-4o-mini");
  assert.ok(mini);
  assert.equal(mini.owned_by, "openai");
  assert.equal(mini.supported_endpoint_types, null);

  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);

  await json(new Request("http://local/api/pricing", { headers: auth }), e);
  const afterPricing = await json(new Request("http://local/api/channel/models", { headers: auth }), e);
  const miniAfter = (
    (afterPricing.body.data as { id: string; supported_endpoint_types: unknown }[]) || []
  ).find((row) => row.id === "gpt-4o-mini");
  assert.ok(miniAfter);
  assert.equal(miniAfter.supported_endpoint_types, null);
});
