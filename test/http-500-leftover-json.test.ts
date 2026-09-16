import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { optionMarshal } from "../src/dto.js";
import { MSG_DB_CONNECTION_FAILED, resetDbPingThrottle } from "../src/more-routes.js";
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
  const e = env();
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

test("original GetOptions leftover marshal gin.H HTTP 500 omits data", async () => {
  const { e, auth } = await boot();
  const orig = optionMarshal.map;
  optionMarshal.map = () => {
    throw new Error("json: unsupported type");
  };
  try {
    const res = await json(new Request("http://local/api/option/", { headers: auth }), e);
    assert.equal(res.res.status, 500);
    omitData(res.body, "json: unsupported type");
  } finally {
    optionMarshal.map = orig;
  }
});

test("original GetTagModels leftover gin.H HTTP 500 omits data", async () => {
  const { e, auth } = await boot();
  const orig = Store.prototype.channelsByTag;
  Store.prototype.channelsByTag = async () => {
    throw new Error("sqlite: no such table: channels");
  };
  try {
    const res = await json(new Request("http://local/api/channel/tag/models?tag=prod", { headers: auth }), e);
    assert.equal(res.res.status, 500);
    omitData(res.body, "sqlite: no such table: channels");
  } finally {
    Store.prototype.channelsByTag = orig;
  }
});

test("original FetchUpstreamRatios leftover 查询渠道失败 gin.H HTTP 500 omits data", async () => {
  const { e, auth } = await boot();
  const orig = Store.prototype.getChannelsByIds;
  Store.prototype.getChannelsByIds = async () => {
    throw new Error("sqlite boom");
  };
  try {
    const res = await json(
      new Request("http://local/api/ratio_sync/fetch", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ channel_ids: [1] }),
      }),
      e,
    );
    assert.equal(res.res.status, 500);
    omitData(res.body, "查询渠道失败");
  } finally {
    Store.prototype.getChannelsByIds = orig;
  }
});

test("original GetPerfMetrics leftover gin.H HTTP 500 omits data", async () => {
  const { e, auth } = await boot();
  const orig = Store.prototype.listPerfMetrics;
  Store.prototype.listPerfMetrics = async () => {
    throw new Error("perf query failed");
  };
  try {
    const res = await json(new Request("http://local/api/perf-metrics?model=gpt-4o-mini", { headers: auth }), e);
    assert.equal(res.res.status, 500);
    omitData(res.body, "perf query failed");
  } finally {
    Store.prototype.listPerfMetrics = orig;
  }
});

test("original GetPerfMetricsSummary leftover gin.H HTTP 500 omits data", async () => {
  const { e, auth } = await boot();
  const orig = Store.prototype.listPerfMetricBuckets;
  Store.prototype.listPerfMetricBuckets = async () => {
    throw new Error("summary query failed");
  };
  try {
    const res = await json(new Request("http://local/api/perf-metrics/summary", { headers: auth }), e);
    assert.equal(res.res.status, 500);
    omitData(res.body, "summary query failed");
  } finally {
    Store.prototype.listPerfMetricBuckets = orig;
  }
});

test("original TestStatus leftover ping-fail gin.H HTTP 503 omits data", async () => {
  const { e, auth } = await boot();
  resetDbPingThrottle();
  const origPrepare = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (query: string) => {
    if (String(query).trim() === "SELECT 1") throw new Error("db down");
    return origPrepare(query);
  };
  try {
    const res = await json(new Request("http://local/api/status/test", { headers: auth }), e);
    assert.equal(res.res.status, 503);
    omitData(res.body, MSG_DB_CONNECTION_FAILED);
  } finally {
    e.DB.prepare = origPrepare;
    resetDbPingThrottle();
  }
});
