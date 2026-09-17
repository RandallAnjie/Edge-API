import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  GIN_ROUTE_TAG_API,
  GIN_ROUTE_TAG_DEFAULT,
  GIN_ROUTE_TAG_OLD_API,
  GIN_ROUTE_TAG_RELAY,
  formatGinLog,
  formatGoDuration,
  ginLogLatencyNs,
  ginLogPath,
  ginRouteTag,
  setGinLogSink,
} from "../src/gin-logger.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
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

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  setGinLogSink((line) => {
    lines.push(line);
  });
  return {
    lines,
    restore() {
      setGinLogSink(null);
    },
  };
}

function lastGin(lines: string[]): string {
  assert.ok(lines.length > 0, "expected a gin log line");
  return lines[lines.length - 1];
}

function ginFields(line: string): {
  tag: string;
  requestId: string;
  status: string;
  latency: string;
  ip: string;
  method: string;
  path: string;
} {
  const parts = line.split(" | ");
  assert.equal(parts.length, 7, line);
  const methodPath = parts[6].replace(/\n$/, "");
  const method = methodPath.trimStart().slice(0, methodPath.trimStart().indexOf(" "));
  const path = methodPath.trimStart().slice(method.length + 1);
  return {
    tag: parts[1],
    requestId: parts[2],
    status: parts[3].trim(),
    latency: parts[4],
    ip: parts[5],
    method,
    path,
  };
}

async function boot(e: Env, ipHeaders: Record<string, string> = {}) {
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { auth };
}

test("original time.Duration.String and gin SetUpLogger sprintf", () => {
  assert.equal(formatGoDuration(0), "0s");
  assert.equal(formatGoDuration(1), "1ns");
  assert.equal(formatGoDuration(1234), "1.234µs");
  assert.equal(formatGoDuration(1000), "1µs");
  assert.equal(formatGoDuration(1_500_000), "1.5ms");
  assert.equal(formatGoDuration(1_000_000), "1ms");
  assert.equal(formatGoDuration(5_000_000), "5ms");
  assert.equal(formatGoDuration(1_000_000_000), "1s");
  assert.equal(formatGoDuration(1_500_000_000), "1.5s");
  assert.equal(formatGoDuration(5_000_000_000), "5s");
  assert.equal(formatGoDuration(60_000_000_000), "1m0s");
  assert.equal(formatGoDuration(62_000_000_000), "1m2s");
  assert.equal(formatGoDuration(ginLogLatencyNs(90_000_000_000)), "1m30s");
  assert.equal(formatGoDuration(5_000_000).padStart(13, " "), "          5ms");
  assert.equal("127.0.0.1".padStart(15, " "), "      127.0.0.1");
  assert.equal("GET".padStart(7, " "), "    GET");
  assert.equal("OPTIONS".padStart(7, " "), "OPTIONS");

  const line = formatGinLog({
    timeStamp: new Date(Date.UTC(2026, 8, 16, 18, 30, 45)),
    tag: "api",
    requestId: "rid-1",
    statusCode: 200,
    latencyNs: 0,
    clientIP: "127.0.0.1",
    method: "GET",
    path: "/api/status",
  });
  assert.equal(
    line,
    "[GIN] 2026/09/16 - 18:30:45 | api | rid-1 | 200 |            0s |       127.0.0.1 |     GET /api/status\n",
  );
});

test("original SetUpLogger OAuth Cut and task-artifact access redact", () => {
  assert.equal(ginLogPath("/api/oauth/github", "code=secret-code&state=abc"), "/api/oauth/github");
  assert.equal(ginLogPath("/oauth/callback", "code=secret-code"), "/oauth/callback");
  assert.equal(ginLogPath("/api/status", "x=1"), "/api/status?x=1");
  assert.equal(
    ginLogPath("/v1/tasks/task-1/artifacts/video/content", "access=never-log-this&keep=ok"),
    "/v1/tasks/task-1/artifacts/video/content?keep=ok",
  );
  assert.equal(ginLogPath("/v1/videos/t1/content", "access=never-log-this"), "/v1/videos/t1/content");
});

test("original RouteTag api relay old_api web leftover", () => {
  assert.equal(ginRouteTag("GET", "/api/status"), GIN_ROUTE_TAG_API);
  assert.equal(ginRouteTag("GET", "/api/this-route-does-not-exist"), GIN_ROUTE_TAG_DEFAULT);
  assert.equal(ginRouteTag("GET", "/dashboard/billing/subscription"), GIN_ROUTE_TAG_OLD_API);
  assert.equal(ginRouteTag("GET", "/v1/dashboard/billing/usage"), GIN_ROUTE_TAG_OLD_API);
  assert.equal(ginRouteTag("POST", "/v1/chat/completions", true), GIN_ROUTE_TAG_RELAY);
  assert.equal(ginRouteTag("GET", "/v1/not-a-registered-route", false), GIN_ROUTE_TAG_DEFAULT);
  assert.equal(ginRouteTag("POST", "/pg/chat/completions", false), GIN_ROUTE_TAG_RELAY);
  assert.equal(ginRouteTag("GET", "/console", false), GIN_ROUTE_TAG_DEFAULT);
});

test("original SetUpLogger leftover tags on /api relay NoRoute old_api and OAuth", async () => {
  resetSchemaFlag();
  const e = env();
  const cap = captureLogs();
  try {
    const status = await send(new Request("http://local/api/status", { headers: { "cf-connecting-ip": "192.0.2.80" } }), e);
    assert.equal(status.res.status, 200, status.text);
    const apiLine = ginFields(lastGin(cap.lines));
    assert.equal(apiLine.tag, GIN_ROUTE_TAG_API);
    assert.equal(apiLine.status, "200");
    assert.equal(apiLine.method, "GET");
    assert.equal(apiLine.path, "/api/status");
    assert.equal(apiLine.requestId, status.res.headers.get("x-oneapi-request-id"));
    assert.equal(apiLine.latency.length, 13);

    cap.lines.length = 0;
    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.81" },
        body: "{}",
      }),
      e,
    );
    assert.equal(chat.res.status, 401, chat.text);
    const relayLine = ginFields(lastGin(cap.lines));
    assert.equal(relayLine.tag, GIN_ROUTE_TAG_RELAY);
    assert.equal(relayLine.status, "401");
    assert.equal(relayLine.method, "POST");
    assert.equal(relayLine.path, "/v1/chat/completions");

    cap.lines.length = 0;
    const unknown = await send(new Request("http://local/v1/not-a-registered-route", { headers: { "cf-connecting-ip": "192.0.2.82" } }), e);
    assert.equal(unknown.res.status, 404, unknown.text);
    const webLine = ginFields(lastGin(cap.lines));
    assert.equal(webLine.tag, GIN_ROUTE_TAG_DEFAULT);
    assert.equal(webLine.status, "404");
    assert.equal(webLine.path, "/v1/not-a-registered-route");

    cap.lines.length = 0;
    const billing = await send(
      new Request("http://local/dashboard/billing/subscription", { headers: { "cf-connecting-ip": "192.0.2.83" } }),
      e,
    );
    assert.equal(billing.res.status, 401, billing.text);
    const oldLine = ginFields(lastGin(cap.lines));
    assert.equal(oldLine.tag, GIN_ROUTE_TAG_OLD_API);
    assert.equal(oldLine.path, "/dashboard/billing/subscription");

    cap.lines.length = 0;
    await send(
      new Request("http://local/api/oauth/github?code=secret-oauth-code&state=st", {
        headers: { "cf-connecting-ip": "192.0.2.84" },
      }),
      e,
    );
    const oauthLine = ginFields(lastGin(cap.lines));
    assert.equal(oauthLine.tag, GIN_ROUTE_TAG_API);
    assert.equal(oauthLine.path, "/api/oauth/github");
    assert.equal(lastGin(cap.lines).includes("secret-oauth-code"), false);

    cap.lines.length = 0;
    await send(
      new Request("http://local/v1/tasks/task-1/artifacts/video/content?access=never-log-this&keep=ok", {
        headers: { "cf-connecting-ip": "192.0.2.85" },
      }),
      e,
    );
    const artifactLine = lastGin(cap.lines);
    assert.equal(artifactLine.includes("never-log-this"), false);
    const art = ginFields(artifactLine);
    assert.equal(art.tag, GIN_ROUTE_TAG_RELAY);
    assert.equal(art.path, "/v1/tasks/task-1/artifacts/video/content?keep=ok");
  } finally {
    cap.restore();
  }
});

test("original SetUpLogger leftover does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const cap = captureLogs();
  try {
    const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.86" });

    const unauth = await send(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { "content-type": "application/json", "accept-language": "zh-CN" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      e,
    );
    assert.equal(unauth.res.status, 401);
    assert.equal(unauth.body.code, "AUTH_UNAUTHORIZED");
    assert.equal(unauth.body.message, "Unauthorized");

    const created = await send(
      new Request("http://local/api/vendors/", {
        method: "POST",
        headers: { ...auth, "cf-connecting-ip": "192.0.2.87", "x-oneapi-request-id": "hop346-vendor-create" },
        body: JSON.stringify({ name: "gin-logger-vendor", description: "d", icon: "" }),
      }),
      e,
    );
    assert.equal(created.body.success, true, created.text);
    const listed = await send(
      new Request("http://local/api/audit?page_size=100&request_id=hop346-vendor-create", { headers: auth }),
      e,
    );
    const items = ((listed.body.data as { items: { action: string }[] }).items || []);
    assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
  } finally {
    cap.restore();
  }
});
