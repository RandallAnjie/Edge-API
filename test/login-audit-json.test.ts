import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT, ROLE_USER } from "../src/constants.js";
import { Store } from "../src/store.js";
import { totpCode } from "../src/totp.js";
import {
  AUDIT_CATEGORY_LOGIN,
  ginLoginAuditRoute,
  loginMethodFromContext,
} from "../src/admin-operation-audit.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

let ctSeq = 0;

async function json(req: Request, e: Env) {
  const headers = new Headers(req.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `login-audit-${++ctSeq}`);
  const res = await handleFetch(new Request(req, { headers }), e, ctx());
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
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

async function passwordProof(e: Env, auth: Record<string, string>, scope: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function enableTwoFA(e: Env, auth: Record<string, string>): Promise<{ secret: string; auth: Record<string, string> }> {
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  const secret = (setup.body.data as { secret: string; flow_token: string }).secret;
  const flowToken = (setup.body.data as { secret: string; flow_token: string }).flow_token;
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(secret), flow_token: flowToken }),
    }),
    e,
  );
  assert.equal(en.body.success, true, String(en.body.message));
  const token = (en.body.data as { access_token: string }).access_token;
  return { secret, auth: { authorization: "Bearer " + token, "content-type": "application/json" } };
}

type AuditItem = {
  category: string;
  action: string;
  success: boolean;
  status: number;
  user_id: number;
  username: string;
  actor_role: number;
  ip: string;
  user_agent: string;
  method: string;
  route: string;
  request_id: string;
  event_id: string;
  token_ref: string;
  content: string;
  auth_method: string;
  other: {
    op?: { action?: string; params?: Record<string, unknown> };
    login_method?: string;
    user_agent?: string;
    admin_info?: unknown;
    audit_info?: unknown;
  };
};

async function auditsFor(e: Env, auth: Record<string, string>, requestId: string): Promise<AuditItem[]> {
  const listed = await json(
    new Request("http://local/api/audit?page_size=100&request_id=" + encodeURIComponent(requestId), { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  return ((listed.body.data as { items: AuditItem[] }).items || []) as AuditItem[];
}

function loginEvent(events: AuditItem[]): AuditItem {
  const row = events.find((item) => item.category === AUDIT_CATEGORY_LOGIN && item.action === "login");
  assert.ok(row, "missing login audit");
  return row!;
}

test("original loginMethodFromContext FullPath mapping and gin login audit route", () => {
  assert.equal(loginMethodFromContext(new Request("http://local/api/user/login")), "password");
  assert.equal(loginMethodFromContext(new Request("http://local/api/user/login/2fa")), "2fa");
  assert.equal(loginMethodFromContext(new Request("http://local/api/user/passkey/login/finish")), "passkey");
  assert.equal(loginMethodFromContext(new Request("http://local/api/oauth/wechat")), "wechat");
  assert.equal(loginMethodFromContext(new Request("http://local/api/oauth/telegram/login")), "telegram");
  assert.equal(loginMethodFromContext(new Request("http://local/api/oauth/github")), "oauth:github");
  assert.equal(loginMethodFromContext(new Request("http://local/api/oauth/telegram")), "oauth:telegram");
  assert.equal(loginMethodFromContext(new Request("http://local/api/user/login/verify")), "unknown");
  assert.equal(loginMethodFromContext(new Request("http://local/api/user/login/2fa"), "password"), "password");
  assert.equal(ginLoginAuditRoute("/api/user/login"), "/api/user/login");
  assert.equal(ginLoginAuditRoute("/api/oauth/wechat"), "/api/oauth/wechat");
  assert.equal(ginLoginAuditRoute("/api/oauth/github"), "/api/oauth/:provider");
  assert.equal(ginLoginAuditRoute("/api/oauth/telegram"), "/api/oauth/:provider");
  assert.equal(ginLoginAuditRoute("/api/oauth/telegram/login"), "/api/oauth/telegram/login");
});

test("original RecordLoginLog leftover login audit JSON on password Login", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);

  const failRid = "login-password-fail";
  const fail = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": failRid,
        "user-agent": "login-audit-client",
      },
      body: JSON.stringify({ username: "root", password: "wrong-password" }),
    }),
    e,
  );
  assert.equal(fail.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, failRid)).filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length,
    0,
  );

  const okRid = "login-password-ok";
  const ok = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": okRid,
        "user-agent": "login-audit-client",
        "cf-connecting-ip": "192.0.2.210",
      },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
  const events = await auditsFor(e, auth, okRid);
  assert.equal(events.filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length, 1);
  const row = loginEvent(events);
  assert.equal(row.success, true);
  assert.equal(row.status, 200);
  assert.equal(row.user_id, root.id);
  assert.equal(row.username, "root");
  assert.equal(row.actor_role, ROLE_ROOT);
  assert.equal(row.auth_method, "session");
  assert.equal(row.token_ref, "");
  assert.equal(row.method, "POST");
  assert.equal(row.route, "/api/user/login");
  assert.equal(row.request_id, okRid);
  assert.notEqual(row.event_id, okRid);
  assert.equal(row.user_agent, "login-audit-client");
  assert.equal(row.ip, "192.0.2.210");
  assert.equal(row.content, "Logged in successfully via password");
  assert.equal("admin_info" in row.other, false);
  assert.equal("audit_info" in row.other, false);
  assert.deepEqual(row.other.op, { action: "login", params: { method: "password" } });
  assert.equal(row.other.login_method, "password");
  assert.equal(row.other.user_agent, "login-audit-client");
});

test("original RecordLoginLog leftover login audit JSON on VerifyLogin verification_method", async () => {
  const { e, auth: bootAuth } = await boot();
  const { secret, auth } = await enableTwoFA(e, bootAuth);

  const challengeRid = "login-2fa-challenge";
  const challenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": challengeRid,
        "user-agent": "login-2fa-client",
      },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(challenge.body.success, true, String(challenge.body.message));
  const ch = challenge.body.data as { require_verification: boolean; flow_token: string };
  assert.equal(ch.require_verification, true);
  assert.equal(
    (await auditsFor(e, auth, challengeRid)).filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length,
    0,
  );

  const failRid = "login-2fa-fail";
  const fail = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": failRid,
        "user-agent": "login-2fa-client",
      },
      body: JSON.stringify({ flow_token: ch.flow_token, method: "2fa", code: "000000" }),
    }),
    e,
  );
  assert.equal(fail.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, failRid)).filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length,
    0,
  );

  const okRid = "login-2fa-ok";
  const done = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": okRid,
        "user-agent": "login-2fa-client",
        "cf-connecting-ip": "192.0.2.211",
      },
      body: JSON.stringify({ flow_token: ch.flow_token, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  const row = loginEvent(await auditsFor(e, auth, okRid));
  assert.equal(row.content, "Logged in successfully via password");
  assert.equal(row.method, "POST");
  assert.equal(row.route, "/api/user/login/verify");
  assert.equal(row.auth_method, "session");
  assert.equal(row.actor_role, ROLE_ROOT);
  assert.deepEqual(row.other.op, {
    action: "login",
    params: { method: "password", verification_method: "2fa" },
  });
  assert.equal(row.other.login_method, "password");

  const aliasChallenge = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const aliasCh = aliasChallenge.body.data as { flow_token: string };
  const aliasRid = "login-2fa-alias";
  const alias = await json(
    new Request("http://local/api/user/login/2fa", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": aliasRid,
        "user-agent": "login-2fa-client",
      },
      body: JSON.stringify({ flow_token: aliasCh.flow_token, method: "2fa", code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(alias.body.success, true, String(alias.body.message));
  const aliasRow = loginEvent(await auditsFor(e, auth, aliasRid));
  assert.equal(aliasRow.route, "/api/user/login/2fa");
  assert.deepEqual(aliasRow.other.op, {
    action: "login",
    params: { method: "password", verification_method: "2fa" },
  });
});

test("original RecordLoginLog leftover login audit JSON on PasskeyLoginFinish and LoginPasskeyFinish", async () => {
  const { e, auth, store } = await boot();
  const enabled = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "passkey.enabled", value: "true" }),
    }),
    e,
  );
  assert.equal(enabled.body.success, true, String(enabled.body.message));
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.insertPasskey(root.id, "cred-root", "pubkey", "device", "");

  const failRid = "login-passkey-fail";
  const fail = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": failRid,
        "user-agent": "passkey-login-client",
      },
      body: JSON.stringify({ flow_token: "missing", credential: { id: "cred-root" } }),
    }),
    e,
  );
  assert.equal(fail.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, failRid)).filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length,
    0,
  );

  const begin = await json(
    new Request("http://local/api/user/passkey/login/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    e,
  );
  assert.equal(begin.body.success, true, String(begin.body.message));
  const flow = (begin.body.data as { flow_token: string }).flow_token;
  const okRid = "login-passkey-ok";
  const done = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": okRid,
        "user-agent": "passkey-login-client",
        "cf-connecting-ip": "192.0.2.212",
      },
      body: JSON.stringify({ flow_token: flow, credential: { id: "cred-root" } }),
    }),
    e,
  );
  assert.equal(done.body.success, true, String(done.body.message));
  const row = loginEvent(await auditsFor(e, auth, okRid));
  assert.equal(row.content, "Logged in successfully via passkey");
  assert.equal(row.route, "/api/user/passkey/login/finish");
  assert.equal(row.auth_method, "session");
  assert.equal(row.token_ref, "");
  assert.notEqual(row.event_id, okRid);
  assert.deepEqual(row.other.op, {
    action: "login",
    params: { method: "passkey", verification_method: "passkey" },
  });
  assert.equal(row.other.login_method, "passkey");

  const ch = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const challenge = ch.body.data as { require_verification?: boolean; flow_token: string };
  assert.equal(challenge.require_verification, true);
  const pkBegin = await json(
    new Request("http://local/api/user/login/passkey/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: challenge.flow_token }),
    }),
    e,
  );
  assert.equal(pkBegin.body.success, true, String(pkBegin.body.message));
  const factorRid = "login-passkey-factor";
  const factor = await json(
    new Request("http://local/api/user/login/passkey/finish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oneapi-request-id": factorRid,
        "user-agent": "passkey-login-client",
      },
      body: JSON.stringify({
        flow_token: challenge.flow_token,
        passkey_flow_token: (pkBegin.body.data as { flow_token: string }).flow_token,
        credential: { id: "cred-root" },
      }),
    }),
    e,
  );
  assert.equal(factor.body.success, true, String(factor.body.message));
  const factorRow = loginEvent(await auditsFor(e, auth, factorRid));
  assert.equal(factorRow.route, "/api/user/login/passkey/finish");
  assert.deepEqual(factorRow.other.op, {
    action: "login",
    params: { method: "password", verification_method: "passkey" },
  });
  assert.equal(factorRow.other.login_method, "password");
});

test("original RecordLoginLog leftover login audit JSON on WeChatAuth and HandleOAuth login", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("WeChatServerAddress", "https://wechat.example");
  await store.setOption("WeChatServerToken", "wechat-token");
  await store.setOption("WeChatAuthEnabled", "true");
  await store.setOption("GitHubClientId", "github-client");
  await store.setOption("GitHubClientSecret", "github-secret");
  await store.setOption("GitHubOAuthEnabled", "true");

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "wechat.example" && url.pathname === "/api/wechat/user") {
      if (req.headers.get("authorization") !== "wechat-token") return Response.json({ success: false, message: "unauthorized" });
      const code = url.searchParams.get("code") || "";
      if (code === "wx-ok") return Response.json({ success: true, data: "wxid-ok" });
      return Response.json({ success: false, message: "验证码错误或已过期" });
    }
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = (await req.json()) as { code?: string };
      if (body.code === "gh-ok") return Response.json({ access_token: "ghs_test", token_type: "bearer" });
      return Response.json({});
    }
    if (url.host === "api.github.com" && url.pathname === "/user") {
      if (req.headers.get("authorization") !== "Bearer ghs_test") return new Response("", { status: 401 });
      return Response.json({ id: 42, login: "octocat", name: "The Octocat", email: "octocat@github.com" });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  try {
    const failWechatRid = "login-wechat-fail";
    const failWechat = await json(
      new Request("http://local/api/oauth/wechat?code=wx-bad", {
        headers: { "x-oneapi-request-id": failWechatRid, "user-agent": "oauth-login-client" },
      }),
      e,
    );
    assert.equal(failWechat.body.success, false);
    assert.equal(
      (await auditsFor(e, auth, failWechatRid)).filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length,
      0,
    );

    const wechatRid = "login-wechat-ok";
    const wechat = await json(
      new Request("http://local/api/oauth/wechat?code=wx-ok", {
        headers: {
          "x-oneapi-request-id": wechatRid,
          "user-agent": "oauth-login-client",
          "cf-connecting-ip": "192.0.2.213",
        },
      }),
      e,
    );
    assert.equal(wechat.body.success, true, String(wechat.body.message));
    const wechatUser = await store.getUserByField("wechat_id", "wxid-ok");
    assert.ok(wechatUser);
    const wechatRow = loginEvent(await auditsFor(e, auth, wechatRid));
    assert.equal(wechatRow.content, "Logged in successfully via wechat");
    assert.equal(wechatRow.route, "/api/oauth/wechat");
    assert.equal(wechatRow.method, "GET");
    assert.equal(wechatRow.user_id, wechatUser.id);
    assert.equal(wechatRow.actor_role, ROLE_USER);
    assert.equal(wechatRow.auth_method, "session");
    assert.deepEqual(wechatRow.other.op, { action: "login", params: { method: "wechat" } });
    assert.equal(wechatRow.other.login_method, "wechat");
    assert.equal("admin_info" in wechatRow.other, false);
    assert.equal("audit_info" in wechatRow.other, false);

    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", intent: "login" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const flow = (started.body.data as { flow_token: string }).flow_token;

    const failOauthRid = "login-github-fail";
    const failOauth = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(flow)}&code=gh-bad`, {
        headers: { "x-oneapi-request-id": failOauthRid, "user-agent": "oauth-login-client" },
      }),
      e,
    );
    assert.equal(failOauth.body.success, false);
    assert.equal(
      (await auditsFor(e, auth, failOauthRid)).filter((row) => row.category === AUDIT_CATEGORY_LOGIN).length,
      0,
    );

    const oauthRid = "login-github-ok";
    const oauth = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(flow)}&code=gh-ok`, {
        headers: {
          "x-oneapi-request-id": oauthRid,
          "user-agent": "oauth-login-client",
          "cf-connecting-ip": "192.0.2.214",
        },
      }),
      e,
    );
    assert.equal(oauth.body.success, true, String(oauth.body.message));
    const ghUser = await store.getUserByField("github_id", "42");
    assert.ok(ghUser);
    const oauthRow = loginEvent(await auditsFor(e, auth, oauthRid));
    assert.equal(oauthRow.content, "Logged in successfully via oauth:github");
    assert.equal(oauthRow.route, "/api/oauth/:provider");
    assert.equal(oauthRow.method, "GET");
    assert.equal(oauthRow.user_id, ghUser.id);
    assert.equal(oauthRow.actor_role, ROLE_USER);
    assert.equal(oauthRow.auth_method, "session");
    assert.notEqual(oauthRow.event_id, oauthRid);
    assert.deepEqual(oauthRow.other.op, { action: "login", params: { method: "oauth:github" } });
    assert.equal(oauthRow.other.login_method, "oauth:github");
  } finally {
    globalThis.fetch = origFetch;
  }
});
