import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  decodeTurnstileCheckResponse,
  MSG_TURNSTILE_TOKEN_EMPTY,
  MSG_TURNSTILE_VERIFY_FAILED,
  TURNSTILE_SITEVERIFY_URL,
} from "../src/turnstile.js";
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
  return { e, auth, store: new Store(e.DB) };
}

async function enableTurnstile(store: Store) {
  await store.setOption("TurnstileSiteKey", "site-key");
  await store.setOption("TurnstileSecretKey", "secret-key");
  await store.setOption("TurnstileCheckEnabled", "true");
}

test("original TurnstileCheck leftover gin.H omit data", async () => {
  assert.deepEqual(decodeTurnstileCheckResponse(""), { ok: false, message: "EOF" });
  assert.deepEqual(decodeTurnstileCheckResponse("   "), { ok: false, message: "EOF" });
  assert.equal(decodeTurnstileCheckResponse("not-json").ok, false);
  assert.match(String((decodeTurnstileCheckResponse("not-json") as { message: string }).message), /invalid character 'o'/);
  assert.deepEqual(decodeTurnstileCheckResponse("null"), { ok: true, success: false });
  assert.equal(decodeTurnstileCheckResponse("[]").ok, false);
  assert.match(
    String((decodeTurnstileCheckResponse("[]") as { message: string }).message),
    /cannot unmarshal array into Go value of type middleware.turnstileCheckResponse/,
  );
  assert.deepEqual(decodeTurnstileCheckResponse("{}"), { ok: true, success: false });
  assert.deepEqual(decodeTurnstileCheckResponse('{"success":true}'), { ok: true, success: true });
  assert.deepEqual(decodeTurnstileCheckResponse('{"success":false}'), { ok: true, success: false });
  assert.equal(decodeTurnstileCheckResponse('{"success":"yes"}').ok, false);

  const { e, auth, store } = await boot();
  await enableTurnstile(store);

  const loginEmpty = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(loginEmpty.res.status, 200);
  omitData(loginEmpty.body, MSG_TURNSTILE_TOKEN_EMPTY);

  const registerEmpty = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "newuser", password: "password12" }),
    }),
    e,
  );
  omitData(registerEmpty.body, MSG_TURNSTILE_TOKEN_EMPTY);

  const verifyEmpty = await json(new Request("http://local/api/verification?email=new@example.com"), e);
  omitData(verifyEmpty.body, MSG_TURNSTILE_TOKEN_EMPTY);

  const resetEmpty = await json(new Request("http://local/api/reset_password?email=root@example.com"), e);
  omitData(resetEmpty.body, MSG_TURNSTILE_TOKEN_EMPTY);

  const checkinEmpty = await json(new Request("http://local/api/user/checkin", { method: "POST", headers: auth }), e);
  omitData(checkinEmpty.body, MSG_TURNSTILE_TOKEN_EMPTY);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/turnstile/v0/siteverify")) {
      return new Response("not-json", { status: 200 });
    }
    return origFetch(input as RequestInfo, init);
  };
  try {
    const badJson = await json(
      new Request("http://local/api/user/login?turnstile=tok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    assert.equal(badJson.res.status, 200);
    omitData(badJson.body, "invalid character 'o' looking for beginning of value");
  } finally {
    globalThis.fetch = origFetch;
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/turnstile/v0/siteverify")) return new Response("", { status: 200 });
    return origFetch(input as RequestInfo, init);
  };
  try {
    const eof = await json(
      new Request("http://local/api/user/login?turnstile=tok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    omitData(eof.body, "EOF");
  } finally {
    globalThis.fetch = origFetch;
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/turnstile/v0/siteverify")) {
      return new Response(JSON.stringify({ success: false }), { status: 200 });
    }
    return origFetch(input as RequestInfo, init);
  };
  try {
    const failed = await json(
      new Request("http://local/api/user/login?turnstile=tok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    omitData(failed.body, MSG_TURNSTILE_VERIFY_FAILED);
  } finally {
    globalThis.fetch = origFetch;
  }

  globalThis.fetch = async () => {
    throw new Error('Post "' + TURNSTILE_SITEVERIFY_URL + '": connection refused');
  };
  try {
    const net = await json(
      new Request("http://local/api/user/login?turnstile=tok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    omitData(net.body, 'Post "' + TURNSTILE_SITEVERIFY_URL + '": connection refused');
  } finally {
    globalThis.fetch = origFetch;
  }

  let captured = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === TURNSTILE_SITEVERIFY_URL) {
      captured = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body || "");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return origFetch(input as RequestInfo, init);
  };
  try {
    const ok = await json(
      new Request("http://local/api/user/login?turnstile=ok-token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    assert.equal(ok.body.success, true, String(ok.body.message));
    assert.equal(captured, "secret=secret-key&response=ok-token&remoteip=203.0.113.9");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original GetAllChannels / SearchChannels / GetMissingModels / ResetModelRatio leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const missingOk = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.equal(missingOk.res.status, 200);
  assert.equal(missingOk.body.success, true);
  assert.equal("message" in missingOk.body, false);
  assert.deepEqual(Object.keys(missingOk.body).sort(), ["data", "success"]);

  const resetOk = await json(new Request("http://local/api/option/rest_model_ratio", { method: "POST", headers: auth }), e);
  assert.equal(resetOk.res.status, 200);
  assert.equal(resetOk.body.success, true);
  assert.equal(resetOk.body.message, "重置模型倍率成功");
  assert.equal("data" in resetOk.body, false);
  assert.deepEqual(Object.keys(resetOk.body).sort(), ["message", "success"]);

  const ratioOff = await json(new Request("http://local/api/ratio_config"), e);
  assert.equal(ratioOff.res.status, 403);
  omitData(ratioOff.body, "倍率配置接口未启用");

  const noAuth = await json(new Request("http://local/api/usage/token"), e);
  assert.equal(noAuth.res.status, 401);
  omitData(noAuth.body, "Token not provided");

  const createdTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "usage-leftover", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(createdTk.body.success, true, String(createdTk.body.message));
  const sk = String((createdTk.body.data as { key?: string })?.key || "");
  const noBearer = await json(new Request("http://local/api/usage/token", { headers: { authorization: sk } }), e);
  assert.equal(noBearer.res.status, 401);
  omitData(noBearer.body, "Invalid Bearer token");

  await e.DB.exec("DROP TABLE channels");
  const listErr = await json(new Request("http://local/api/channel/", { headers: auth }), e);
  assert.equal(listErr.res.status, 200);
  omitData(listErr.body, "获取渠道数量失败，请稍后重试");

  const tagErr = await json(new Request("http://local/api/channel/?tag_mode=true", { headers: auth }), e);
  omitData(tagErr.body, "获取标签失败，请稍后重试");

  const searchErr = await json(new Request("http://local/api/channel/search", { headers: auth }), e);
  assert.equal(searchErr.res.status, 200);
  assert.equal(searchErr.body.success, false);
  assert.equal("data" in searchErr.body, false);
  assert.match(String(searchErr.body.message), /no such table/i);

  const syncErr = await json(new Request("http://local/api/ratio_sync/channels", { headers: auth }), e);
  assert.equal(syncErr.res.status, 200);
  assert.equal(syncErr.body.success, false);
  assert.equal("data" in syncErr.body, false);
  assert.match(String(syncErr.body.message), /no such table/i);

  await e.DB.exec("DROP TABLE abilities");
  const missingErr = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.equal(missingErr.res.status, 200);
  assert.equal(missingErr.body.success, false);
  assert.equal("data" in missingErr.body, false);
  assert.match(String(missingErr.body.message), /no such table/i);

  await e.DB.exec("DROP TABLE redemptions");
  const redErr = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  assert.equal(redErr.res.status, 200);
  assert.equal(redErr.body.success, false);
  assert.equal("data" in redErr.body, false);
  assert.match(String(redErr.body.message), /no such table/i);

  await e.DB.exec("DROP TABLE system_instances");
  const instErr = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  assert.equal(instErr.res.status, 200);
  assert.equal(instErr.body.success, false);
  assert.equal("data" in instErr.body, false);
  assert.match(String(instErr.body.message), /no such table/i);

  // Original ResetModelRatio leftover is `model.UpdateOption` err after RootAuth.
  // DROP options also breaks worker `sessionSecret` / `requireRoot`, so stub setOption.
  const origSetOption = Store.prototype.setOption;
  Store.prototype.setOption = async () => {
    throw new Error("no such table: options");
  };
  try {
    const resetErr = await json(new Request("http://local/api/option/rest_model_ratio", { method: "POST", headers: auth }), e);
    assert.equal(resetErr.res.status, 200);
    assert.equal(resetErr.body.success, false);
    assert.equal("data" in resetErr.body, false);
    assert.match(String(resetErr.body.message), /no such table/i);
  } finally {
    Store.prototype.setOption = origSetOption;
  }
});
