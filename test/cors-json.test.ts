import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  CORS_ALLOW_METHODS,
  CORS_MAX_AGE_SECONDS,
  corsApplies,
  corsHeaders,
} from "../src/http.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function send(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  return { res, text };
}

function assertNoCors(res: Response) {
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
  assert.equal(res.headers.get("access-control-allow-methods"), null);
  assert.equal(res.headers.get("access-control-allow-headers"), null);
  assert.equal(res.headers.get("access-control-max-age"), null);
}

test("original gin-contrib/cors v1.7.2 applyCors skip and preflight vs normal headers", () => {
  assert.equal(CORS_ALLOW_METHODS, "GET,POST,PUT,DELETE,OPTIONS");
  assert.equal(CORS_MAX_AGE_SECONDS, "43200");
  assert.equal(corsApplies(new Request("http://local/v1/models")), false);
  assert.equal(
    corsApplies(new Request("http://local/v1/models", { headers: { origin: "http://local" } })),
    false,
  );
  assert.equal(
    corsApplies(new Request("http://local/v1/models", { headers: { origin: "https://local" } })),
    false,
  );
  assert.equal(
    corsApplies(new Request("http://local/v1/models", { headers: { origin: "https://evil.example" } })),
    true,
  );

  const preflight = corsHeaders(
    new Request("http://local/v1/models", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
  );
  assert.equal(preflight.get("access-control-allow-origin"), "*");
  assert.equal(preflight.get("access-control-allow-credentials"), "true");
  assert.equal(preflight.get("access-control-allow-methods"), CORS_ALLOW_METHODS);
  assert.equal(preflight.get("access-control-allow-headers"), "*");
  assert.equal(preflight.get("access-control-max-age"), CORS_MAX_AGE_SECONDS);
  assert.equal(preflight.get("vary"), null);

  const normal = corsHeaders(
    new Request("http://local/v1/models", { headers: { origin: "https://evil.example" } }),
  );
  assert.equal(normal.get("access-control-allow-origin"), "*");
  assert.equal(normal.get("access-control-allow-credentials"), "true");
  assert.equal(normal.get("access-control-allow-methods"), null);
  assert.equal(normal.get("access-control-allow-headers"), null);
  assert.equal(normal.get("access-control-max-age"), null);
  assert.equal(normal.get("vary"), null);
});

test("original middleware.CORS leftover headers on cross-origin relay; empty Origin skips", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };

  const none = await send(new Request("http://local/v1/models"), e);
  assert.equal(none.res.status, 401, none.text);
  assertNoCors(none.res);

  const same = await send(
    new Request("http://local/v1/models", { headers: { origin: "http://local" } }),
    e,
  );
  assert.equal(same.res.status, 401, same.text);
  assertNoCors(same.res);

  const cross = await send(
    new Request("http://local/v1/models", { headers: { origin: "https://evil.example" } }),
    e,
  );
  assert.equal(cross.res.status, 401, cross.text);
  assert.equal(cross.res.headers.get("access-control-allow-origin"), "*");
  assert.equal(cross.res.headers.get("access-control-allow-credentials"), "true");
  assert.equal(cross.res.headers.get("access-control-allow-methods"), null);
  assert.equal(cross.res.headers.get("access-control-allow-headers"), null);
  assert.equal(cross.res.headers.get("access-control-max-age"), null);

  const options = await send(
    new Request("http://local/v1/chat/completions", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
    e,
  );
  assert.equal(options.res.status, 204, options.text);
  assert.equal(options.text, "");
  assert.equal(options.res.headers.get("access-control-allow-origin"), "*");
  assert.equal(options.res.headers.get("access-control-allow-credentials"), "true");
  assert.equal(options.res.headers.get("access-control-allow-methods"), CORS_ALLOW_METHODS);
  assert.equal(options.res.headers.get("access-control-allow-headers"), "*");
  assert.equal(options.res.headers.get("access-control-max-age"), CORS_MAX_AGE_SECONDS);
  assert.equal(options.res.headers.get("vary"), null);

  const optionsNoOrigin = await send(new Request("http://local/api/status", { method: "OPTIONS" }), e);
  assert.equal(optionsNoOrigin.res.status, 204, optionsNoOrigin.text);
  assertNoCors(optionsNoOrigin.res);
});

test("original CORS leftover does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const body = JSON.parse(login.text) as { data?: { access_token: string } };
  const auth = {
    authorization: "Bearer " + body.data!.access_token,
    "content-type": "application/json",
    origin: "https://evil.example",
  };

  const unauth = await send(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN", origin: "https://evil.example" },
      body: JSON.stringify({ email: "new@example.com" }),
    }),
    e,
  );
  const unauthBody = JSON.parse(unauth.text) as { code?: string; message?: string };
  assert.equal(unauth.res.status, 401);
  assert.equal(unauthBody.code, "AUTH_UNAUTHORIZED");
  assert.equal(unauthBody.message, "Unauthorized");

  const created = await send(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cors-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  const createdBody = JSON.parse(created.text) as { success?: boolean };
  assert.equal(createdBody.success, true, created.text);
  assert.equal(created.res.headers.get("access-control-allow-origin"), "*");
  assert.equal(created.res.headers.get("access-control-allow-methods"), null);
});
