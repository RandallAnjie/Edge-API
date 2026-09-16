import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function securityOp(body: Record<string, unknown>, code: string, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
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

async function passwordProof(e: Env, auth: Record<string, string>, scope: string, extra: Record<string, unknown> = {}) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12", ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

function mockWeChatBindFetch() {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "wechat.example" && url.pathname === "/api/wechat/user") {
      if (req.headers.get("authorization") !== "wechat-token") return Response.json({ success: false, message: "unauthorized" });
      const code = url.searchParams.get("code") || "";
      if (code === "wx-ok") return Response.json({ success: true, data: "wxid-root" });
      if (code === "wx-taken") return Response.json({ success: true, data: "wxid-owner" });
      return Response.json({ success: false, message: "验证码错误或已过期" });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return origFetch;
}

test("original WeChatBind DecodeJson / leftover gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("WeChatServerAddress", "https://wechat.example");
  await store.setOption("WeChatServerToken", "wechat-token");
  const origFetch = mockWeChatBindFetch();

  try {
    const unauth = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "wx-ok" }),
      }),
      e,
    );
    assert.equal(unauth.res.status, 401);
    securityOp(unauth.body, "AUTH_UNAUTHORIZED", "Unauthorized");

    const disabled = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ code: "wx-ok" }),
      }),
      e,
    );
    omitData(disabled.body, "管理员未开启通过微信登录以及注册");

    await store.setOption("WeChatAuthEnabled", "true");

    const empty = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: auth,
      }),
      e,
    );
    omitData(empty.body, "无效的请求");

    const badJson = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: auth,
        body: "{",
      }),
      e,
    );
    omitData(badJson.body, "无效的请求");

    const codeNum = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ code: 1 }),
      }),
      e,
    );
    omitData(codeNum.body, "无效的请求");

    const arrayBody = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: auth,
        body: "[]",
      }),
      e,
    );
    omitData(arrayBody.body, "无效的请求");

    const jsonNull = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: auth,
        body: "null",
      }),
      e,
    );
    assert.equal(jsonNull.res.status, 403);
    securityOp(jsonNull.body, "SECURITY_PROOF_REQUIRED", "需要安全验证");

    const emptyProof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "wechat", code: "" } });
    const emptyCode = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": emptyProof.proof_token },
        body: "null",
      }),
      e,
    );
    omitData(emptyCode.body, "无效的参数");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original WeChatBind JSON: already-bound message, empty success message, notification_warning", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("WeChatServerAddress", "https://wechat.example");
  await store.setOption("WeChatServerToken", "wechat-token");
  const origFetch = mockWeChatBindFetch();

  try {
    await store.setOption("WeChatAuthEnabled", "true");

    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "wechat", code: "wx-ok" } });
    const bound = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": proof.proof_token },
        body: JSON.stringify({ code: "wx-ok" }),
      }),
      e,
    );
    assert.equal(bound.body.success, true, String(bound.body.message));
    assert.equal(bound.body.message, "");
    const data = bound.body.data as { notification_warning: boolean; action?: string };
    assert.equal(typeof data.notification_warning, "boolean");
    assert.equal("action" in data, false);
    assert.equal((await store.getUserById(1))?.wechat_id, "wxid-root");

    await store.insertUser({ username: "owner", aff_code: "wxowner", wechat_id: "wxid-owner" });
    const takenProof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "wechat", code: "wx-taken" } });
    const taken = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": takenProof.proof_token },
        body: JSON.stringify({ code: "wx-taken" }),
      }),
      e,
    );
    omitData(taken.body, "该微信账号已被绑定");
    assert.equal((await store.getUserById(1))?.wechat_id, "wxid-root");
  } finally {
    globalThis.fetch = origFetch;
  }
});
