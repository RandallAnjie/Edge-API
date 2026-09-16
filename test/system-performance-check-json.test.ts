import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { ensureSchema, resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  NEW_API_ERROR_TYPE,
  SYSTEM_CPU_OVERLOADED,
  SYSTEM_DISK_OVERLOADED,
  SYSTEM_MEMORY_OVERLOADED,
  SYSTEM_PERFORMANCE_STATUS,
  ZERO_SYSTEM_STATUS,
  checkSystemPerformance,
  formatUsagePercent,
  setSystemStatusForDb,
  resetSystemStatusForDb,
  systemPerformanceCheckAppliesAfterAuth,
  systemPerformanceCheckAppliesBeforeAuth,
  systemPerformanceCheckExempt,
  systemPerformanceUsesClaudeError,
  toClaudePerformanceError,
  toOpenAIPerformanceError,
  usageInt,
  writeSystemPerformanceError,
} from "../src/system-performance-check.js";
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

function cpuOverload(db: object, n = 91) {
  setSystemStatusForDb(db, { cpuUsage: n, memoryUsage: 0, diskUsage: 0 });
}

describe("original SystemPerformanceCheck leftover HTTP 503", () => {
  test("original SystemPerformanceCheck constants, applies, ToOpenAIError/ToClaudeError, zeros never trip", async () => {
    assert.equal(NEW_API_ERROR_TYPE, "new_api_error");
    assert.equal(SYSTEM_CPU_OVERLOADED, "system_cpu_overloaded");
    assert.equal(SYSTEM_MEMORY_OVERLOADED, "system_memory_overloaded");
    assert.equal(SYSTEM_DISK_OVERLOADED, "system_disk_overloaded");
    assert.equal(SYSTEM_PERFORMANCE_STATUS, 503);
    assert.deepEqual(ZERO_SYSTEM_STATUS, { cpuUsage: 0, memoryUsage: 0, diskUsage: 0 });
    assert.equal(formatUsagePercent(91), "91.0");
    assert.equal(usageInt(90.9), 90);
    assert.equal(systemPerformanceUsesClaudeError("/v1/messages"), true);
    assert.equal(systemPerformanceUsesClaudeError("/v1/messages/count_tokens"), true);
    assert.equal(systemPerformanceUsesClaudeError("/v1/chat/completions"), false);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("POST", "/v1/chat/completions"), true);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("POST", "/v1/messages"), true);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("POST", "/v1/responses"), true);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("POST", "/pg/chat/completions"), true);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("POST", "/v1beta/models/gemini-pro:generateContent"), true);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("GET", "/v1/models"), false);
    assert.equal(systemPerformanceCheckAppliesBeforeAuth("POST", "/v1/video/generations"), false);
    assert.equal(systemPerformanceCheckAppliesAfterAuth("POST", "/v1/video/generations"), true);
    assert.equal(systemPerformanceCheckAppliesAfterAuth("POST", "/v1/videos"), true);
    assert.equal(systemPerformanceCheckAppliesAfterAuth("POST", "/v1/chat/completions"), false);
    assert.equal(systemPerformanceCheckExempt("GET", "/v1/models"), true);
    assert.equal(systemPerformanceCheckExempt("POST", "/v1/videos/abc/remix"), true);

    const err = {
      statusCode: 503,
      message: "system cpu overloaded (current: 91.0%, threshold: 90%)",
      code: SYSTEM_CPU_OVERLOADED,
    };
    assert.deepEqual(toOpenAIPerformanceError(err), {
      message: err.message,
      type: NEW_API_ERROR_TYPE,
      param: "",
      code: SYSTEM_CPU_OVERLOADED,
    });
    assert.deepEqual(toClaudePerformanceError(err), { type: NEW_API_ERROR_TYPE, message: err.message });
    const openaiRes = writeSystemPerformanceError("/v1/chat/completions", err);
    assert.equal(openaiRes.status, 503);
    const openaiBody = (await openaiRes.json()) as { error: Record<string, unknown> };
    assert.deepEqual(Object.keys(openaiBody), ["error"]);
    assert.deepEqual(Object.keys(openaiBody.error), ["message", "type", "param", "code"]);
    const claudeRes = writeSystemPerformanceError("/v1/messages", err);
    const claudeBody = (await claudeRes.json()) as { error: Record<string, unknown> };
    assert.deepEqual(Object.keys(claudeBody.error), ["type", "message"]);
    assert.equal("code" in claudeBody.error, false);
    assert.equal("param" in claudeBody.error, false);

    resetSchemaFlag();
    const db = createMemoryD1();
    await ensureSchema(db);
    const store = new Store(db);
    assert.equal(await checkSystemPerformance(store, db), null);
    setSystemStatusForDb(db, { cpuUsage: 90.9, memoryUsage: 0, diskUsage: 0 });
    assert.equal(await checkSystemPerformance(store, db), null);
  });

  test("original SystemPerformanceCheck leftover HTTP 503 OpenAI vs Claude before TokenAuth", async () => {
    resetSchemaFlag();
    const e = env();
    cpuOverload(e.DB!);
    const expectedMessage = "system cpu overloaded (current: 91.0%, threshold: 90%)";

    const chat = await send(new Request("http://local/v1/chat/completions", { method: "POST" }), e);
    assert.equal(chat.res.status, 503, chat.text);
    assert.equal("success" in chat.body, false);
    assert.deepEqual(chat.body, {
      error: { message: expectedMessage, type: NEW_API_ERROR_TYPE, param: "", code: SYSTEM_CPU_OVERLOADED },
    });
    assert.equal(chat.res.headers.get("x-new-api-version"), "v0.0.0");

    const messages = await send(new Request("http://local/v1/messages", { method: "POST" }), e);
    assert.equal(messages.res.status, 503, messages.text);
    assert.deepEqual(messages.body, {
      error: { type: NEW_API_ERROR_TYPE, message: expectedMessage },
    });
    assert.equal("code" in (messages.body.error as Record<string, unknown>), false);

    const playground = await send(new Request("http://local/pg/chat/completions", { method: "POST" }), e);
    assert.equal(playground.res.status, 503, playground.text);
    assert.deepEqual(playground.body, {
      error: { message: expectedMessage, type: NEW_API_ERROR_TYPE, param: "", code: SYSTEM_CPU_OVERLOADED },
    });

    const mj = await send(new Request("http://local/mj/submit/imagine", { method: "POST" }), e);
    assert.equal(mj.res.status, 503, mj.text);
    assert.equal((mj.body.error as { code?: string }).code, SYSTEM_CPU_OVERLOADED);
  });

  test("original SystemPerformanceCheck stays off models/api/unmatched and TokenAuth-first on video POST", async () => {
    resetSchemaFlag();
    const e = env();
    cpuOverload(e.DB!);

    const models = await send(new Request("http://local/v1/models"), e);
    assert.notEqual(models.res.status, 503, models.text);
    assert.notEqual((models.body.error as { code?: string } | undefined)?.code, SYSTEM_CPU_OVERLOADED);

    const video = await send(new Request("http://local/v1/video/generations", { method: "POST" }), e);
    assert.notEqual(video.res.status, 503, video.text);
    assert.notEqual((video.body.error as { code?: string } | undefined)?.code, SYSTEM_CPU_OVERLOADED);

    const videos = await send(new Request("http://local/v1/videos", { method: "POST" }), e);
    assert.notEqual(videos.res.status, 503, videos.text);

    const status = await send(new Request("http://local/api/status"), e);
    assert.notEqual(status.res.status, 503, status.text);

    const unknown = await send(new Request("http://local/v1/not-a-route", { method: "POST" }), e);
    assert.notEqual(unknown.res.status, 503, unknown.text);
    assert.match(unknown.text, /Invalid URL/);
  });

  test("original SystemPerformanceCheck disable, memory/disk order, OPTIONS 204, default zeros", async () => {
    resetSchemaFlag();
    const db = createMemoryD1();
    const e = env(db);
    await ensureSchema(db);
    const store = new Store(db);
    await store.setOption("performance_setting.monitor_enabled", "false");
    cpuOverload(db, 99);
    const disabled = await send(new Request("http://local/v1/chat/completions", { method: "POST" }), e);
    assert.notEqual(disabled.res.status, 503, disabled.text);

    await store.setOption("performance_setting.monitor_enabled", "true");
    setSystemStatusForDb(db, { cpuUsage: 0, memoryUsage: 91, diskUsage: 99 });
    const memory = await send(new Request("http://local/v1/chat/completions", { method: "POST" }), e);
    assert.equal(memory.res.status, 503, memory.text);
    assert.deepEqual(memory.body, {
      error: {
        message: "system memory overloaded (current: 91.0%, threshold: 90%)",
        type: NEW_API_ERROR_TYPE,
        param: "",
        code: SYSTEM_MEMORY_OVERLOADED,
      },
    });

    setSystemStatusForDb(db, { cpuUsage: 0, memoryUsage: 0, diskUsage: 96 });
    const disk = await send(new Request("http://local/v1/chat/completions", { method: "POST" }), e);
    assert.equal(disk.res.status, 503, disk.text);
    assert.equal((disk.body.error as { code: string }).code, SYSTEM_DISK_OVERLOADED);
    assert.equal(
      (disk.body.error as { message: string }).message,
      "system disk overloaded (current: 96.0%, threshold: 95%)",
    );

    resetSystemStatusForDb(db);
    const zeros = await send(new Request("http://local/v1/chat/completions", { method: "POST" }), e);
    assert.notEqual(zeros.res.status, 503, zeros.text);

    cpuOverload(db);
    const options = await send(new Request("http://local/v1/chat/completions", { method: "OPTIONS" }), e);
    assert.equal(options.res.status, 204, options.text);
    assert.equal(options.text, "");
  });
});
