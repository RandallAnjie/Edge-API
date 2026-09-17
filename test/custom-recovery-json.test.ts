import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  NEW_API_PANIC_ISSUE_URL,
  NEW_API_PANIC_TYPE,
  newApiPanicError,
  panicDetectedMessage,
  panicValue,
  pluginRoutePanicError,
} from "../src/http.js";
import type { D1Database, Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db: D1Database | Env["DB"] = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db as D1Database, SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
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

function throwingDb(message = "simulated panic"): D1Database {
  return {
    prepare(query: string): never {
      void query;
      throw new Error(message);
    },
    async batch<T = unknown>(statements: never[]): Promise<never> {
      void statements;
      throw new Error(message);
    },
    async exec(query: string): Promise<never> {
      void query;
      throw new Error(message);
    },
  };
}

function panicBody(err: unknown) {
  return {
    error: {
      message: panicDetectedMessage(err),
      type: NEW_API_PANIC_TYPE,
    },
  };
}

test("original CustomRecovery leftover new_api_panic gin.H shape", async () => {
  assert.equal(NEW_API_PANIC_TYPE, "new_api_panic");
  assert.equal(NEW_API_PANIC_ISSUE_URL, "https://github.com/Calcium-Ion/new-api");
  assert.equal(panicValue(new Error("boom")), "boom");
  assert.equal(panicValue("plain"), "plain");
  assert.equal(panicValue(7), "7");
  assert.equal(
    panicDetectedMessage("disk full"),
    "Panic detected, error: disk full. Please submit a issue here: https://github.com/Calcium-Ion/new-api",
  );
  const res = newApiPanicError(new Error("nil pointer"));
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: { message: string; type: string; code?: string } };
  assert.equal(body.error.type, NEW_API_PANIC_TYPE);
  assert.equal(
    body.error.message,
    "Panic detected, error: nil pointer. Please submit a issue here: https://github.com/Calcium-Ion/new-api",
  );
  assert.equal("code" in body.error, false);
  assert.equal("success" in body, false);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["message", "type"]);
});

test("original CustomRecovery leftover HTTP 500 new_api_panic on uncaught throw", async () => {
  resetSchemaFlag();
  const e = env(throwingDb("db exploded"));
  const expected = panicBody(new Error("db exploded"));

  const relay = await send(new Request("http://local/v1/chat/completions", { method: "POST" }), e);
  assert.equal(relay.res.status, 500, relay.text);
  assert.deepEqual(relay.body, expected);
  assert.equal(relay.res.headers.get("x-new-api-version"), "v0.0.0");

  const api = await send(new Request("http://local/api/status"), e);
  assert.equal(api.res.status, 500, api.text);
  assert.deepEqual(api.body, expected);
});

test("original pluginRouteRecovery stays plugin_route_error and D1-missing stays apiFail", async () => {
  const plugin = pluginRoutePanicError();
  assert.equal(plugin.status, 500);
  assert.deepEqual(await plugin.json(), {
    error: { message: "internal plugin route error", type: "plugin_route_error" },
  });

  resetSchemaFlag();
  const missing = await send(new Request("http://local/api/status"), { SYSTEM_NAME: "Edge API Test" } as Env);
  assert.equal(missing.res.status, 500, missing.text);
  assert.equal(missing.body.success, false);
  assert.match(String(missing.body.message), /D1 binding DB is missing/);
  assert.notEqual((missing.body.error as { type?: string } | undefined)?.type, NEW_API_PANIC_TYPE);

  const options = await send(
    new Request("http://local/v1/chat/completions", { method: "OPTIONS" }),
    env(throwingDb()),
  );
  assert.equal(options.res.status, 204, options.text);
  assert.equal(options.text, "");
});

test("original CustomRecovery does not rewrite handler leftover omit-data HTTP 500", async () => {
  resetSchemaFlag();
  const e = env();
  const setup = await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  assert.equal(setup.body.success, true, setup.text);
  const status = await send(new Request("http://local/api/status"), e);
  assert.equal(status.res.status, 200, status.text);
  assert.equal(status.body.success, true);
});
