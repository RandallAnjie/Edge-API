import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyModelRequestRateLimit,
  checkModelRequestRateLimitGroup,
  getGroupRateLimit,
  modelRequestRateLimitApplies,
  modelRequestRateLimitSuccessMessage,
  modelRequestRateLimitTotalMessage,
  rateLimitCapacity,
  rateLimitDurationSeconds,
  tokenBucketAllow,
} from "../src/model-rate-limit.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { AuthToken, Env, ExecutionContextLike, KVNamespace } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function memoryKv(): KVNamespace {
  const m = new Map<string, string>();
  return {
    async get(key) {
      return m.get(key) ?? null;
    },
    async put(key, value) {
      m.set(key, value);
    },
  };
}

function env(db = createMemoryD1(), kv?: KVNamespace): Env {
  return kv ? { DB: db, KV: kv, SYSTEM_NAME: "Edge API Test" } : { DB: db, SYSTEM_NAME: "Edge API Test" };
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

async function createSk(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<{ id: number; key: string }> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "rl", remain_quota: 100000, unlimited_quota: true, ...body }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  const data = tok.body.data as { id: number; key: string };
  return { id: data.id, key: data.key };
}

function assertAbort(
  hit: { res: Response; body: Record<string, unknown>; text: string },
  status: number,
  message: string,
  code: string,
  requestId: string,
) {
  assert.equal(hit.res.status, status, hit.text);
  const err = hit.body.error as { message?: string; type?: string; code?: unknown; param?: unknown };
  assert.ok(err, hit.text);
  assert.deepEqual(Object.keys(err).sort(), ["code", "message", "type"]);
  assert.equal(err.type, "new_api_error");
  assert.equal(err.code, code);
  assert.equal(err.message, `${message} (request id: ${requestId})`);
  assert.equal("param" in err, false);
}

function chatReq(key: string, rid: string): Request {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
      "x-oneapi-request-id": rid,
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
}

test("original ModelRequestRateLimit helpers match Redis duration, capacity, and group JSON", () => {
  assert.equal(rateLimitDurationSeconds(1), 60);
  assert.equal(rateLimitDurationSeconds(0), 0);
  assert.equal(rateLimitCapacity(10, 60), 600);
  assert.equal(rateLimitCapacity(0, 60), 0);
  assert.equal(getGroupRateLimit("vip", '{"vip":[1,1000]}').found, true);
  assert.deepEqual(getGroupRateLimit("vip", '{"vip":[1,1000]}'), { totalCount: 1, successCount: 1000, found: true });
  assert.equal(getGroupRateLimit("default", '{"vip":[1,1000]}').found, false);
  assert.equal(checkModelRequestRateLimitGroup("{}"), null);
  assert.equal(checkModelRequestRateLimitGroup('{"vip":[0,1000]}'), null);
  assert.equal(
    checkModelRequestRateLimitGroup('{"vip":[-1,1000]}'),
    "group vip has negative rate limit values: [-1, 1000]",
  );
  assert.equal(
    checkModelRequestRateLimitGroup('{"vip":[1,0]}'),
    "group vip has negative rate limit values: [1, 0]",
  );
  assert.equal(modelRequestRateLimitApplies("POST", "/v1/chat/completions"), true);
  assert.equal(modelRequestRateLimitApplies("GET", "/v1/realtime"), true);
  assert.equal(modelRequestRateLimitApplies("POST", "/v1/responses"), true);
  assert.equal(modelRequestRateLimitApplies("GET", "/v1/models"), false);
  assert.equal(modelRequestRateLimitApplies("GET", "/v1/models/gpt-4o"), false);
  assert.equal(modelRequestRateLimitApplies("POST", "/mj/submit/imagine"), false);
  assert.equal(modelRequestRateLimitApplies("POST", "/v1/videos"), false);
  assert.equal(modelRequestRateLimitApplies("GET", "/v1/videos/abc"), false);
  const first = tokenBucketAllow(null, 1000, 60, 1, 60);
  assert.equal(first.allowed, true);
  assert.equal(first.bucket.tokens, 0);
  const second = tokenBucketAllow(first.bucket, 1000, 60, 1, 60);
  assert.equal(second.allowed, false);
});

test("original GET /api/option/ ModelRequestRateLimitSuccessCount default is 1000", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const opts = await json(new Request("http://local/api/option/", { headers: auth }), e);
  assert.equal(opts.body.success, true, String(opts.body.message));
  const rows = opts.body.data as { key: string; value: string }[];
  const success = rows.find((row) => row.key === "ModelRequestRateLimitSuccessCount");
  const enabled = rows.find((row) => row.key === "ModelRequestRateLimitEnabled");
  assert.equal(success?.value, "1000");
  assert.equal(enabled?.value, "false");
});

test("original PUT /api/option/ ModelRequestRateLimitGroup Check JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const bad = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRequestRateLimitGroup", value: '{"vip":[-1,1]}' }),
    }),
    e,
  );
  assert.equal(bad.res.status, 200);
  assert.equal(bad.body.success, false);
  assert.equal(bad.body.message, "group vip has negative rate limit values: [-1, 1]");

  const ok = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRequestRateLimitGroup", value: '{"vip":[1,1000]}' }),
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
});

test("original ModelRequestRateLimit stays disabled with KV and does not emit invented rate_limit JSON", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), memoryKv());
  const { auth } = await boot(e);
  const sk = await createSk(e, auth);
  const rid = "rl-disabled";
  for (let i = 0; i < 3; i++) {
    const hit = await json(chatReq(sk.key, rid), e);
    assert.notEqual(hit.res.status, 429, hit.text);
    const err = hit.body.error as { code?: unknown; param?: unknown } | undefined;
    assert.notEqual(err?.code, "rate_limit");
    assert.equal(err && "param" in err ? err.param : undefined, undefined);
  }
});

test("original ModelRequestRateLimit Redis-path total abortWithOpenAiMessage JSON", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), memoryKv());
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ModelRequestRateLimitEnabled", "true");
  await store.setOption("ModelRequestRateLimitCount", "1");
  await store.setOption("ModelRequestRateLimitSuccessCount", "1000");
  await store.setOption("ModelRequestRateLimitDurationMinutes", "1");
  const sk = await createSk(e, auth);
  const rid = "rl-total";
  const first = await json(chatReq(sk.key, rid), e);
  assert.notEqual(first.res.status, 429, first.text);
  const second = await json(chatReq(sk.key, rid), e);
  assertAbort(second, 429, modelRequestRateLimitTotalMessage(1, 1), "", rid);

  const models = await json(
    new Request("http://local/v1/models", {
      headers: { authorization: "Bearer " + sk.key, "x-oneapi-request-id": rid },
    }),
    e,
  );
  assert.equal(models.res.status, 200, models.text);
});

test("original ModelRequestRateLimit Redis-path success abortWithOpenAiMessage JSON", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), memoryKv());
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ModelRequestRateLimitEnabled", "true");
  await store.setOption("ModelRequestRateLimitCount", "0");
  await store.setOption("ModelRequestRateLimitSuccessCount", "1");
  await store.setOption("ModelRequestRateLimitDurationMinutes", "1");
  const sk = await createSk(e, auth);
  const user = await store.getUserById(1);
  const token = await store.getTokenById(sk.id);
  assert.ok(user && token);
  const authTok: AuthToken = { token, user, usingGroup: user.group || "default" };
  const req = new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "rl-succ" } });
  const gate1 = await applyModelRequestRateLimit(store, e, req, authTok);
  assert.equal(gate1 instanceof Response, false);
  await (gate1 as { recordSuccess: (status: number) => Promise<void> }).recordSuccess(200);
  const gate2 = await applyModelRequestRateLimit(store, e, req, authTok);
  assert.ok(gate2 instanceof Response);
  const text = await (gate2 as Response).text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assertAbort({ res: gate2 as Response, body, text }, 429, modelRequestRateLimitSuccessMessage(1, 1), "", "rl-succ");
});

test("original ModelRequestRateLimitGroup overrides global total count JSON", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), memoryKv());
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ModelRequestRateLimitEnabled", "true");
  await store.setOption("ModelRequestRateLimitCount", "1");
  await store.setOption("ModelRequestRateLimitSuccessCount", "1000");
  await store.setOption("ModelRequestRateLimitGroup", '{"vip":[100,1000]}');
  const vip = await createSk(e, auth, { group: "vip" });
  const rid = "rl-group";
  const first = await json(chatReq(vip.key, rid), e);
  assert.notEqual(first.res.status, 429, first.text);
  const second = await json(chatReq(vip.key, rid), e);
  assert.notEqual(second.res.status, 429, second.text);
});

test("original ModelRequestRateLimit Redis check failure is rate_limit_check_failed JSON", async () => {
  resetSchemaFlag();
  const kv: KVNamespace = {
    async get() {
      throw new Error("redis down");
    },
    async put() {},
  };
  const e = env(createMemoryD1(), kv);
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ModelRequestRateLimitEnabled", "true");
  await store.setOption("ModelRequestRateLimitCount", "1");
  const sk = await createSk(e, auth);
  const rid = "rl-fail";
  const hit = await json(chatReq(sk.key, rid), e);
  assertAbort(hit, 500, "rate_limit_check_failed", "", rid);
});

test("original ModelRequestRateLimit in-memory path is empty HTTP 429", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ModelRequestRateLimitEnabled", "true");
  await store.setOption("ModelRequestRateLimitCount", "1");
  await store.setOption("ModelRequestRateLimitSuccessCount", "1000");
  const sk = await createSk(e, auth);
  const rid = "rl-mem";
  const first = await json(chatReq(sk.key, rid), e);
  assert.notEqual(first.res.status, 429, first.text);
  const second = await json(chatReq(sk.key, rid), e);
  assert.equal(second.res.status, 429, second.text);
  assert.equal(second.text, "");
});
