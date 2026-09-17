import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { VERSION } from "../src/constants.js";
import {
  DEFAULT_NEW_API_VERSION,
  NEW_API_VERSION_HEADER,
  REQUEST_ID_HEADER,
  REQUEST_ID_PREFIX,
  getRandomString,
  getTimeString,
  newApiVersion,
  newRequestId,
  requestIdFor,
} from "../src/request-id.js";
import type { AssetsBinding, Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  return { res, text };
}

function assetsFrom(files: Record<string, string>): AssetsBinding {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = files[path];
      if (body == null) return new Response("missing", { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    },
  };
}

const GENERATED_REQUEST_ID = new RegExp(`^\\d{23}${REQUEST_ID_PREFIX}[0-9A-Za-z]{8}$`);

test("original NewRequestId leftover uses GetTimeString + module prefix + 8 alphanumeric", () => {
  assert.equal(REQUEST_ID_HEADER, "X-Oneapi-Request-Id");
  assert.equal(NEW_API_VERSION_HEADER, "X-New-Api-Version");
  assert.equal(DEFAULT_NEW_API_VERSION, "v0.0.0");
  assert.equal(REQUEST_ID_PREFIX, "8268d9d6");
  assert.equal(getTimeString(new Date("2026-09-16T06:19:00.123Z")), "20260916061900123000000");
  assert.equal(getRandomString(0), "");
  assert.equal(getRandomString(-1), "");
  const id = newRequestId(new Date("2026-09-16T06:19:00.123Z"));
  assert.match(id, GENERATED_REQUEST_ID);
  assert.equal(id.slice(0, 23), "20260916061900123000000");
  assert.equal(id.slice(23, 31), REQUEST_ID_PREFIX);
  assert.equal(id.length, 39);
  assert.equal(newApiVersion(undefined), "v0.0.0");
  assert.equal(newApiVersion({}), "v0.0.0");
  assert.equal(newApiVersion({ VERSION: "" }), "v0.0.0");
  assert.equal(newApiVersion({ VERSION: "v1.2.3" }), "v1.2.3");
  const inbound = new Request("http://local/api/status", { headers: { "x-oneapi-request-id": "client-rid" } });
  assert.equal(requestIdFor(inbound), "client-rid");
  assert.match(requestIdFor(new Request("http://local/api/status")), GENERATED_REQUEST_ID);
});

test("original RequestId and Version leftover headers on /api/status", async () => {
  resetSchemaFlag();
  const e = env();
  const hit = await send(new Request("http://local/api/status"), e);
  assert.equal(hit.res.status, 200, hit.text);
  assert.match(hit.res.headers.get("x-oneapi-request-id") || "", GENERATED_REQUEST_ID);
  assert.equal(hit.res.headers.get("x-new-api-version"), DEFAULT_NEW_API_VERSION);
  const body = JSON.parse(hit.text) as { success?: boolean; data?: { version?: string } };
  assert.equal(body.success, true);
  assert.equal(body.data?.version, VERSION);
});

test("original RequestId leftover honors client X-Oneapi-Request-Id Extra-OK", async () => {
  resetSchemaFlag();
  const e = env();
  const hit = await send(
    new Request("http://local/v1/models", { headers: { "x-oneapi-request-id": "token-auth-req" } }),
    e,
  );
  assert.equal(hit.res.status, 401, hit.text);
  assert.equal(hit.res.headers.get("x-oneapi-request-id"), "token-auth-req");
  assert.equal(hit.res.headers.get("x-new-api-version"), DEFAULT_NEW_API_VERSION);
  assert.match(hit.text, /request id: token-auth-req/);
});

test("original Version leftover env VERSION overrides X-New-Api-Version", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { VERSION: "v9.9.9" });
  const hit = await send(new Request("http://local/api/status"), e);
  assert.equal(hit.res.status, 200, hit.text);
  assert.equal(hit.res.headers.get("x-new-api-version"), "v9.9.9");
  const body = JSON.parse(hit.text) as { data?: { version?: string } };
  assert.equal(body.data?.version, VERSION);
});

test("original RequestId and Version leftover headers on OPTIONS, CT 429, and SPA", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    CRITICAL_RATE_LIMIT: "1",
    CRITICAL_RATE_LIMIT_DURATION: "30",
    ASSETS: assetsFrom({ "/index.html": "<html>spa</html>" }),
  });

  const options = await send(new Request("http://local/api/status", { method: "OPTIONS" }), e);
  assert.equal(options.res.status, 204, options.text);
  assert.match(options.res.headers.get("x-oneapi-request-id") || "", GENERATED_REQUEST_ID);
  assert.equal(options.res.headers.get("x-new-api-version"), DEFAULT_NEW_API_VERSION);

  const ip = "192.0.2.114";
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  const first = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.notEqual(first.res.status, 429, first.text);
  assert.match(first.res.headers.get("x-oneapi-request-id") || "", GENERATED_REQUEST_ID);
  assert.equal(first.res.headers.get("x-new-api-version"), DEFAULT_NEW_API_VERSION);

  const limited = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.match(limited.res.headers.get("x-oneapi-request-id") || "", GENERATED_REQUEST_ID);
  assert.equal(limited.res.headers.get("x-new-api-version"), DEFAULT_NEW_API_VERSION);

  const spa = await send(new Request("http://local/security"), e);
  assert.equal(spa.res.status, 200, spa.text);
  assert.equal(spa.text, "<html>spa</html>");
  assert.match(spa.res.headers.get("x-oneapi-request-id") || "", GENERATED_REQUEST_ID);
  assert.equal(spa.res.headers.get("x-new-api-version"), DEFAULT_NEW_API_VERSION);
  assert.equal(spa.res.headers.get("cache-control"), "no-cache");
});
