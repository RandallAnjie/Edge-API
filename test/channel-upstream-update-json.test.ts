import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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

test("original DetectChannelUpstreamModelUpdates leftover gin.H omit data", async () => {
  const { e, auth } = await boot();
  for (const body of [JSON.stringify({}), JSON.stringify({ id: 0 }), JSON.stringify({ id: -1 }), JSON.stringify(null), ""]) {
    const res = await json(
      new Request("http://local/api/channel/upstream_updates/detect", {
        method: "POST",
        headers: auth,
        body,
      }),
      e,
    );
    assert.equal(res.res.status, 200, String(body));
    omitData(res.body, "invalid channel id");
  }

  const missing = await json(
    new Request("http://local/api/channel/upstream_updates/detect", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: 999999 }),
    }),
    e,
  );
  omitData(missing.body, "record not found");
});

test("original ApplyChannelUpstreamModelUpdates leftover gin.H omit data", async () => {
  const { e, auth } = await boot();
  const empty = await json(
    new Request("http://local/api/channel/upstream_updates/apply", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  omitData(empty.body, "invalid channel id");

  const missing = await json(
    new Request("http://local/api/channel/upstream_updates/apply", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: 999999, add_models: ["gpt-4.1"] }),
    }),
    e,
  );
  omitData(missing.body, "record not found");
});
