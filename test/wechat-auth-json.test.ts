import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { USER_DISABLED } from "../src/constants.js";
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

function setCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
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
}

function mockWeChatFetch() {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "wechat.example" && url.pathname === "/api/wechat/user") {
      if (req.headers.get("authorization") !== "wechat-token") return Response.json({ success: false, message: "unauthorized" });
      const code = url.searchParams.get("code") || "";
      if (code === "wx-new") return Response.json({ success: true, data: "wxid-new" });
      if (code === "wx-bound") return Response.json({ success: true, data: "wxid-bound" });
      if (code === "wx-deleted") return Response.json({ success: true, data: "wxid-deleted" });
      if (code === "wx-banned") return Response.json({ success: true, data: "wxid-banned" });
      if (code === "wx-passkey") return Response.json({ success: true, data: "wxid-passkey" });
      if (code === "wx-empty") return Response.json({ success: true, data: "" });
      if (code === "wx-fail") return Response.json({ success: false, message: "upstream-fail" });
      return Response.json({ success: false, message: "验证码错误或已过期" });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return origFetch;
}

test("original WeChatAuth leftover gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("WeChatServerAddress", "https://wechat.example");
  await store.setOption("WeChatServerToken", "wechat-token");

  const origFetch = mockWeChatFetch();
  try {
    const disabled = await json(new Request("http://local/api/oauth/wechat?code=wx-new"), e);
    omitData(disabled.body, "管理员未开启通过微信登录以及注册");

    await store.setOption("WeChatAuthEnabled", "true");

    const emptyCode = await json(new Request("http://local/api/oauth/wechat"), e);
    omitData(emptyCode.body, "无效的参数");

    const fail = await json(new Request("http://local/api/oauth/wechat?code=wx-fail"), e);
    omitData(fail.body, "upstream-fail");

    const emptyData = await json(new Request("http://local/api/oauth/wechat?code=wx-empty"), e);
    omitData(emptyData.body, "验证码错误或已过期");

    await store.setOption("RegisterEnabled", "false");
    const closed = await json(new Request("http://local/api/oauth/wechat?code=wx-new"), e);
    omitData(closed.body, "管理员关闭了新用户注册");

    const deletedId = await store.insertUser({ username: "gone", aff_code: "wxgone", wechat_id: "wxid-deleted" });
    await store.softDeleteUser(deletedId);
    const deleted = await json(new Request("http://local/api/oauth/wechat?code=wx-deleted"), e);
    omitData(deleted.body, "用户已注销");

    await store.insertUser({ username: "banned", aff_code: "wxban", wechat_id: "wxid-banned", status: USER_DISABLED });
    const banned = await json(new Request("http://local/api/oauth/wechat?code=wx-banned"), e);
    omitData(banned.body, "用户已被封禁");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original WeChatAuth JSON: register, login_method wechat, deleted, banned, LoginChallenge", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("WeChatServerAddress", "https://wechat.example");
  await store.setOption("WeChatServerToken", "wechat-token");

  const origFetch = mockWeChatFetch();
  try {
    const disabled = await json(new Request("http://local/api/oauth/wechat?code=wx-new"), e);
    omitData(disabled.body, "管理员未开启通过微信登录以及注册");

    await store.setOption("WeChatAuthEnabled", "true");

    const emptyCode = await json(new Request("http://local/api/oauth/wechat"), e);
    omitData(emptyCode.body, "无效的参数");

    const fail = await json(new Request("http://local/api/oauth/wechat?code=wx-fail"), e);
    omitData(fail.body, "upstream-fail");

    const emptyData = await json(new Request("http://local/api/oauth/wechat?code=wx-empty"), e);
    omitData(emptyData.body, "验证码错误或已过期");

    await store.setOption("RegisterEnabled", "false");
    const closed = await json(new Request("http://local/api/oauth/wechat?code=wx-new"), e);
    omitData(closed.body, "管理员关闭了新用户注册");

    await store.setOption("RegisterEnabled", "true");
    const created = await json(new Request("http://local/api/oauth/wechat?code=wx-new"), e);
    assert.equal(created.body.success, true, String(created.body.message));
    assert.equal(created.body.message, "");
    const createdData = created.body.data as {
      access_token: string;
      session: { login_method: string };
      user: { username: string; display_name: string };
      require_verification?: boolean;
    };
    assert.equal(typeof createdData.access_token, "string");
    assert.equal(createdData.session.login_method, "wechat");
    assert.equal(createdData.user.username, "wechat_2");
    assert.equal(createdData.user.display_name, "WeChat User");
    assert.equal("require_verification" in createdData, false);
    assert.ok(setCookies(created.res).some((c) => c.toLowerCase().includes("new_api")));
    const registered = await store.getUserByField("wechat_id", "wxid-new");
    assert.equal(registered?.username, "wechat_2");
    assert.equal(registered?.display_name, "WeChat User");

    const again = await json(new Request("http://local/api/oauth/wechat?code=wx-new"), e);
    assert.equal(again.body.success, true, String(again.body.message));
    const againData = again.body.data as { session: { login_method: string }; user: { username: string } };
    assert.equal(againData.session.login_method, "wechat");
    assert.equal(againData.user.username, "wechat_2");

    await store.setOption("RegisterEnabled", "false");
    const deletedId = await store.insertUser({ username: "gone", aff_code: "wxgone", wechat_id: "wxid-deleted" });
    await store.softDeleteUser(deletedId);
    const deleted = await json(new Request("http://local/api/oauth/wechat?code=wx-deleted"), e);
    omitData(deleted.body, "用户已注销");

    await store.insertUser({ username: "banned", aff_code: "wxban", wechat_id: "wxid-banned", status: USER_DISABLED });
    const banned = await json(new Request("http://local/api/oauth/wechat?code=wx-banned"), e);
    omitData(banned.body, "用户已被封禁");

    const pkUser = await store.insertUser({ username: "pkuser", aff_code: "wxpk", wechat_id: "wxid-passkey" });
    await store.insertPasskey(pkUser, "cred-wechat", "pubkey", "device", "example.com");
    await store.setOption("PasskeyEnabled", "true");
    const before = await store.countActiveSessions(pkUser);
    const challenge = await json(new Request("http://local/api/oauth/wechat?code=wx-passkey"), e);
    assert.equal(challenge.body.success, true, String(challenge.body.message));
    assert.equal(challenge.body.message, "");
    const ch = challenge.body.data as {
      require_verification: boolean;
      require_2fa?: boolean;
      flow_token: string;
      expires_at: number;
      methods: { method: string; available: boolean }[];
      access_token?: string;
    };
    assert.equal(ch.require_verification, true);
    assert.equal("require_2fa" in ch, false);
    assert.equal(typeof ch.flow_token, "string");
    assert.ok(ch.flow_token.length > 0);
    assert.equal(typeof ch.expires_at, "number");
    assert.deepEqual(ch.methods, [{ method: "passkey", available: true }]);
    assert.equal("access_token" in ch, false);
    assert.equal(setCookies(challenge.res).length, 0);
    assert.equal(await store.countActiveSessions(pkUser), before);
  } finally {
    globalThis.fetch = origFetch;
  }
});
