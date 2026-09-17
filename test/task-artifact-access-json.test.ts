import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { cryptoSecret } from "../src/auth.js";
import {
  ARTIFACT_ACCESS_LIMITED,
  ARTIFACT_ACCESS_LIMITED_MESSAGE,
  ARTIFACT_ACCESS_LIMITED_TYPE,
  ARTIFACT_ACCESS_RETRY_AFTER,
  ARTIFACT_NOT_FOUND,
  ARTIFACT_NOT_FOUND_MESSAGE,
  DEFAULT_TASK_ARTIFACT_GLOBAL_CONCURRENCY,
  DEFAULT_TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE,
  DEFAULT_TASK_ARTIFACT_IP_CONCURRENCY,
  DEFAULT_TASK_ARTIFACT_OBJECT_CONCURRENCY,
  MAX_ENCODED_TASK_ARTIFACT_ACCESS_QUERY_SIZE,
  TASK_ARTIFACT_ACCESS_LENGTH,
  TASK_ARTIFACT_ACCESS_QUERY_PARAMETER,
  TASK_ARTIFACT_CACHE_CONTROL,
  issueTaskArtifactAccess,
  loadTaskArtifactAccessLimits,
  newTaskArtifactAccessLimiter,
  popTaskArtifactAccessQuery,
  positiveTaskArtifactLimit,
  redactTaskArtifactAccessApplies,
  tokenOrTaskArtifactAccessAuthApplies,
  verifyTaskArtifactAccess,
  writeTaskArtifactAccessLimited,
  writeTaskArtifactAccessNotFound,
} from "../src/task-artifact-access.js";
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

async function boot(e: Env) {
  resetSchemaFlag();
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.80" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.80" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  return { token, auth: { authorization: "Bearer " + token, "content-type": "application/json" } };
}

test("original TokenOrTaskArtifactAccessAuth constants, pop, verify, limiter", async () => {
  assert.equal(TASK_ARTIFACT_ACCESS_QUERY_PARAMETER, "access");
  assert.equal(TASK_ARTIFACT_ACCESS_LENGTH, 43);
  assert.equal(MAX_ENCODED_TASK_ARTIFACT_ACCESS_QUERY_SIZE, 128);
  assert.equal(DEFAULT_TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE, 60);
  assert.equal(DEFAULT_TASK_ARTIFACT_GLOBAL_CONCURRENCY, 128);
  assert.equal(DEFAULT_TASK_ARTIFACT_IP_CONCURRENCY, 64);
  assert.equal(DEFAULT_TASK_ARTIFACT_OBJECT_CONCURRENCY, 16);
  assert.equal(ARTIFACT_NOT_FOUND, "artifact_not_found");
  assert.equal(ARTIFACT_NOT_FOUND_MESSAGE, "Task or artifact not found");
  assert.equal(ARTIFACT_ACCESS_LIMITED, "artifact_access_limited");
  assert.equal(ARTIFACT_ACCESS_LIMITED_TYPE, "rate_limit_error");
  assert.equal(ARTIFACT_ACCESS_LIMITED_MESSAGE, "Artifact access limit exceeded");
  assert.equal(ARTIFACT_ACCESS_RETRY_AFTER, "60");
  assert.equal(TASK_ARTIFACT_CACHE_CONTROL, "private, no-store");
  assert.equal(tokenOrTaskArtifactAccessAuthApplies("GET", "/v1/tasks/t1/artifacts/video/content"), true);
  assert.equal(tokenOrTaskArtifactAccessAuthApplies("HEAD", "/v1/tasks/t1/artifacts/video/content"), true);
  assert.equal(tokenOrTaskArtifactAccessAuthApplies("GET", "/v1/tasks/t1/artifacts"), false);
  assert.equal(tokenOrTaskArtifactAccessAuthApplies("POST", "/v1/tasks/t1/artifacts/video/content"), false);
  assert.equal(redactTaskArtifactAccessApplies("/v1/tasks/t1/artifacts/video/content"), true);
  assert.equal(redactTaskArtifactAccessApplies("/v1/videos/t1/content"), true);
  assert.equal(redactTaskArtifactAccessApplies("/v1/tasks/t1"), false);

  const kept = popTaskArtifactAccessQuery("access=secret-capability&keep=kept");
  assert.equal(kept.present, true);
  assert.equal(kept.rawAccess, "secret-capability");
  assert.equal(kept.invalid, false);
  assert.equal(kept.rawQuery, "keep=kept");
  assert.equal(kept.rawQuery.includes("access"), false);

  const missing = popTaskArtifactAccessQuery("keep=ok");
  assert.equal(missing.present, false);
  assert.equal(missing.rawQuery, "keep=ok");

  const dup = popTaskArtifactAccessQuery("access=first&access=second");
  assert.equal(dup.present, true);
  assert.equal(dup.rawAccess, "first");
  assert.equal(dup.invalid, true);

  const oversized = popTaskArtifactAccessQuery("access=" + "x".repeat(1024));
  assert.equal(oversized.present, true);
  assert.equal(oversized.invalid, true);

  assert.equal(positiveTaskArtifactLimit("17", 60), 17);
  assert.equal(positiveTaskArtifactLimit("0", 60), 60);
  assert.equal(positiveTaskArtifactLimit("-1", 60), 60);
  assert.equal(positiveTaskArtifactLimit("invalid", 60), 60);
  const fromEnv = loadTaskArtifactAccessLimits({
    TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE: "17",
    TASK_ARTIFACT_GLOBAL_CONCURRENCY: "23",
    TASK_ARTIFACT_IP_CONCURRENCY: "11",
    TASK_ARTIFACT_OBJECT_CONCURRENCY: "7",
  } as Env);
  assert.deepEqual(fromEnv, {
    invalidRatePerMinute: 17,
    globalConcurrency: 23,
    ipConcurrency: 11,
    objectConcurrency: 7,
  });

  const secret = "task-artifact-access-test-secret";
  const access = await issueTaskArtifactAccess(secret, "task-1", "video-main");
  assert.equal(access.length, 43);
  assert.equal(await verifyTaskArtifactAccess(access, "task-1", "video-main", secret), true);
  assert.equal(await verifyTaskArtifactAccess(access, "task-2", "video-main", secret), false);
  assert.equal(await verifyTaskArtifactAccess(access, "task-1", "video-other", secret), false);
  assert.equal(await verifyTaskArtifactAccess(access + "x", "task-1", "video-main", secret), false);
  assert.equal(await verifyTaskArtifactAccess(access, "task-1", "video-main", "another-node-secret"), false);

  const limits = {
    invalidRatePerMinute: DEFAULT_TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE,
    globalConcurrency: DEFAULT_TASK_ARTIFACT_GLOBAL_CONCURRENCY,
    ipConcurrency: DEFAULT_TASK_ARTIFACT_IP_CONCURRENCY,
    objectConcurrency: DEFAULT_TASK_ARTIFACT_OBJECT_CONCURRENCY,
  };
  const limiter = newTaskArtifactAccessLimiter(limits);
  const releases: Array<() => void> = [];
  for (let i = 0; i < limits.objectConcurrency; i++) {
    const got = limiter.acquire("192.0.2.1", "task-1", "video");
    assert.equal(got.ok, true);
    if (got.ok) releases.push(got.release);
  }
  assert.equal(limiter.acquire("192.0.2.2", "task-1", "video").ok, false, "task+key concurrency is shared across IPs");
  for (const release of releases) release();

  const rateLimiter = newTaskArtifactAccessLimiter(limits);
  const now = 1_000_000;
  for (let i = 0; i < limits.invalidRatePerMinute; i++) {
    assert.equal(rateLimiter.invalidAttempt(now, "192.0.2.10"), true);
  }
  assert.equal(rateLimiter.invalidAttempt(now, "192.0.2.10"), false);
  assert.equal(rateLimiter.invalidAttempt(now + 60_000, "192.0.2.10"), true);

  const notFound = writeTaskArtifactAccessNotFound();
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get("cache-control"), TASK_ARTIFACT_CACHE_CONTROL);
  assert.deepEqual(await notFound.json(), {
    error: { message: ARTIFACT_NOT_FOUND_MESSAGE, type: ARTIFACT_NOT_FOUND, code: ARTIFACT_NOT_FOUND },
  });
  const limited = writeTaskArtifactAccessLimited();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), TASK_ARTIFACT_CACHE_CONTROL);
  assert.equal(limited.headers.get("retry-after"), ARTIFACT_ACCESS_RETRY_AFTER);
  assert.deepEqual(await limited.json(), {
    error: {
      message: ARTIFACT_ACCESS_LIMITED_MESSAGE,
      type: ARTIFACT_ACCESS_LIMITED_TYPE,
      code: ARTIFACT_ACCESS_LIMITED,
    },
  });
});

test("original TokenOrTaskArtifactAccessAuth leftover HTTP 404 artifact_not_found", async () => {
  const e = env();
  await boot(e);
  const ip = { "cf-connecting-ip": "198.51.100.10" };
  for (const query of [
    "?access=",
    "?access=invalid",
    "?access=first&access=second",
    "?access=" + "x".repeat(1024),
    "?access=%20" + "A".repeat(43) + "%20",
  ]) {
    const hit = await send(
      new Request("http://local/v1/tasks/task-1/artifacts/video-main/content" + query, { headers: ip }),
      e,
    );
    assert.equal(hit.res.status, 404, query + " " + hit.text);
    assert.equal(hit.res.headers.get("cache-control"), TASK_ARTIFACT_CACHE_CONTROL);
    assert.deepEqual(hit.body.error, {
      message: ARTIFACT_NOT_FOUND_MESSAGE,
      type: ARTIFACT_NOT_FOUND,
      code: ARTIFACT_NOT_FOUND,
    });
    assert.equal("success" in hit.body, false);
  }
});

test("original TokenOrTaskArtifactAccessAuth leftover HTTP 429 artifact_access_limited", async () => {
  const e = env(createMemoryD1(), { TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE: "2" });
  await boot(e);
  const ip = { "cf-connecting-ip": "198.51.100.20" };
  const url = "http://local/v1/tasks/task-1/artifacts/video-main/content?access=invalid";
  const first = await send(new Request(url, { headers: ip }), e);
  assert.equal(first.res.status, 404, first.text);
  const second = await send(new Request(url, { headers: ip }), e);
  assert.equal(second.res.status, 404, second.text);
  const third = await send(new Request(url, { headers: ip }), e);
  assert.equal(third.res.status, 429, third.text);
  assert.equal(third.res.headers.get("cache-control"), TASK_ARTIFACT_CACHE_CONTROL);
  assert.equal(third.res.headers.get("retry-after"), ARTIFACT_ACCESS_RETRY_AFTER);
  assert.deepEqual(third.body.error, {
    message: ARTIFACT_ACCESS_LIMITED_MESSAGE,
    type: ARTIFACT_ACCESS_LIMITED_TYPE,
    code: ARTIFACT_ACCESS_LIMITED,
  });
  assert.equal("success" in third.body, false);
  assert.equal(third.text, JSON.stringify(third.body));
});

test("original TokenOrTaskArtifactAccessAuth capability skips TokenAuth; missing access stays TokenAuth", async () => {
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  const secret = await cryptoSecret(e, store);
  await e.DB.prepare(
    "INSERT INTO tasks (task_id, user_id, platform, action, status, progress, fail_reason, created_at, submit_time, finish_time, properties, data) VALUES (?, 1, 'suno', 'generate', 'IN_PROGRESS', '10%', '', ?, ?, 0, '{}', '{}')",
  )
    .bind("task-cap-1", Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
    .run();
  const access = await issueTaskArtifactAccess(secret, "task-cap-1", "video");
  const cap = await send(
    new Request("http://local/v1/tasks/task-cap-1/artifacts/video/content?access=" + access + "&keep=kept", {
      headers: { "cf-connecting-ip": "198.51.100.30" },
    }),
    e,
  );
  assert.equal(cap.res.status, 404, cap.text);
  assert.equal(cap.res.headers.get("cache-control"), TASK_ARTIFACT_CACHE_CONTROL);
  assert.deepEqual(cap.body.error, {
    message: ARTIFACT_NOT_FOUND_MESSAGE,
    type: ARTIFACT_NOT_FOUND,
    code: ARTIFACT_NOT_FOUND,
  });

  const missing = await send(
    new Request("http://local/v1/tasks/task-cap-1/artifacts/video/content", {
      headers: { "cf-connecting-ip": "198.51.100.31" },
    }),
    e,
  );
  assert.equal(missing.res.status, 401, missing.text);
  assert.equal(missing.res.headers.get("cache-control"), TASK_ARTIFACT_CACHE_CONTROL);
  assert.equal((missing.body.error as { type: string }).type, "new_api_error");
  assert.match(String((missing.body.error as { message: string }).message), /Invalid token/);

  const tok = await send(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.80" },
      body: JSON.stringify({ name: "artifact-token", remain_quota: 1000, unlimited_quota: true }),
    }),
    e,
  );
  const sk = String((tok.body.data as { key?: string })?.key || "");
  const withTokenInvalidAccess = await send(
    new Request("http://local/v1/tasks/task-cap-1/artifacts/video/content?access=invalid", {
      headers: { authorization: "Bearer " + sk, "cf-connecting-ip": "198.51.100.32" },
    }),
    e,
  );
  assert.equal(withTokenInvalidAccess.res.status, 404, withTokenInvalidAccess.text);
  assert.deepEqual(withTokenInvalidAccess.body.error, {
    message: ARTIFACT_NOT_FOUND_MESSAGE,
    type: ARTIFACT_NOT_FOUND,
    code: ARTIFACT_NOT_FOUND,
  });
});
