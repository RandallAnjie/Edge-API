import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import { Store } from "../src/store.js";
import { parseEmailBindingState } from "../src/email-binding.js";
import {
  AUDIT_CATEGORY_SECURITY,
  AUDIT_CONTENT_TEMPLATES,
  auditContentEN,
} from "../src/admin-operation-audit.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

let ctSeq = 0;

async function json(req: Request, e: Env) {
  const headers = new Headers(req.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `bind-audit-${++ctSeq}`);
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
    admin_info?: unknown;
    audit_info?: { method?: string; route?: string; path?: string; status?: number; success?: boolean };
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

function securityEvent(events: AuditItem[], action: string): AuditItem {
  const row = events.find((item) => item.category === AUDIT_CATEGORY_SECURITY && item.action === action);
  assert.ok(row, "missing security audit " + action);
  return row!;
}

function codeFromHtml(html: string): string {
  const m = html.match(/<strong>([0-9]{6})<\/strong>/);
  assert.ok(m, "missing original email binding code HTML");
  return m[1];
}

function mockResend() {
  const inbox: { to: string; subject: string; html: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
      const body = (await req.json()) as { to: string; subject: string; html: string };
      inbox.push(body);
      return Response.json({ id: "email_test" });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return { origFetch, inbox };
}

function mockWeChat() {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "wechat.example" && url.pathname === "/api/wechat/user") {
      if (req.headers.get("authorization") !== "wechat-token") return Response.json({ success: false, message: "unauthorized" });
      const code = url.searchParams.get("code") || "";
      if (code === "wx-ok") return Response.json({ success: true, data: "wxid-root" });
      return Response.json({ success: false, message: "验证码错误或已过期" });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return origFetch;
}

test("original recordUserSecurityAudit English user.binding_* templates", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.binding_start"], "Account binding request");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.binding_bind"], "Account binding");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.binding_unbind"], "Account unlinking");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.email_binding_resend"], "Email confirmation code resend");
  assert.equal(auditContentEN("user.binding_start", { provider: "email", success: false }), "Account binding request");
  assert.equal(auditContentEN("user.binding_bind", { provider: "wechat", success: true }), "Account binding");
  assert.equal(auditContentEN("user.binding_unbind", { provider_id: 1, success: false }), "Account unlinking");
  assert.equal(auditContentEN("user.email_binding_resend", { success: false }), "Email confirmation code resend");
});

test("original recordUserSecurityAudit leftover EmailBindStart/Resend/Bind JSON", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("ResendApiKey", "re_test");
  await store.setOption("SystemName", "new-api");
  const { origFetch, inbox } = mockResend();

  try {
    const unauthRid = "email-bind-audit-unauth-1";
    const unauth = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-oneapi-request-id": unauthRid },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      e,
    );
    assert.equal(unauth.res.status, 401);
    assert.equal(
      (await auditsFor(e, auth, unauthRid)).some((row) => row.action === "user.binding_start"),
      false,
    );

    const invalidRid = "email-bind-audit-invalid-1";
    const invalid = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: {
          ...auth,
          "x-oneapi-request-id": invalidRid,
          "user-agent": "email-bind-client",
          "cf-connecting-ip": "192.0.2.190",
        },
        body: JSON.stringify({ email: "not-an-email" }),
      }),
      e,
    );
    assert.equal(invalid.body.code, "EMAIL_ADDRESS_REJECTED");
    const invalidRow = securityEvent(await auditsFor(e, auth, invalidRid), "user.binding_start");
    assert.equal(invalidRow.success, false);
    assert.equal(invalidRow.status, 200);
    assert.equal(invalidRow.method, "POST");
    assert.equal(invalidRow.route, "/api/oauth/email/bind/start");
    assert.equal(invalidRow.auth_method, "session");
    assert.equal(invalidRow.token_ref, "");
    assert.equal(invalidRow.actor_role, ROLE_ROOT);
    assert.equal(invalidRow.content, "Account binding request");
    assert.equal(invalidRow.ip, "192.0.2.190");
    assert.equal(invalidRow.user_agent, "email-bind-client");
    assert.equal(invalidRow.other.admin_info, undefined);
    assert.deepEqual(invalidRow.other.op, {
      action: "user.binding_start",
      params: { provider: "email", success: false, notification_failed: false, code: "EMAIL_ADDRESS_REJECTED" },
    });
    assert.deepEqual(invalidRow.other.audit_info, {
      method: "POST",
      route: "/api/oauth/email/bind/start",
      path: "/api/oauth/email/bind/start",
      status: 200,
      success: false,
    });

    const missingRid = "email-bind-audit-missing-proof-1";
    const missing = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": missingRid, "cf-connecting-ip": "192.0.2.191" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      e,
    );
    assert.equal(missing.res.status, 403);
    assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
    const missingRow = securityEvent(await auditsFor(e, auth, missingRid), "user.binding_start");
    assert.equal(missingRow.success, false);
    assert.equal(missingRow.status, 403);
    assert.equal(missingRow.other.op?.params?.code, "SECURITY_PROOF_REQUIRED");

    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "email", email: "new@example.com" } });
    const okRid = "email-bind-audit-start-ok-1";
    const started = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": proof.proof_token, "x-oneapi-request-id": okRid, "cf-connecting-ip": "192.0.2.192" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const startRow = securityEvent(await auditsFor(e, auth, okRid), "user.binding_start");
    assert.equal(startRow.success, true);
    assert.equal(startRow.status, 200);
    assert.deepEqual(startRow.other.op, {
      action: "user.binding_start",
      params: { provider: "email", success: true, notification_failed: false },
    });
    const flowToken = (started.body.data as { flow_token: string }).flow_token;
    const newCode = codeFromHtml(inbox[0].html);
    const flowRow = await store.getAuthFlow(flowToken);
    assert.ok(parseEmailBindingState(flowRow?.payload || ""));

    const resendRid = "email-bind-audit-resend-wait-1";
    const tooSoon = await json(
      new Request("http://local/api/oauth/email/bind/resend", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": resendRid, "cf-connecting-ip": "192.0.2.193" },
        body: JSON.stringify({ flow_token: flowToken }),
      }),
      e,
    );
    assert.equal(tooSoon.res.status, 429);
    assert.equal(tooSoon.body.code, "EMAIL_BINDING_RESEND_WAIT");
    const resendRow = securityEvent(await auditsFor(e, auth, resendRid), "user.email_binding_resend");
    assert.equal(resendRow.success, false);
    assert.equal(resendRow.status, 429);
    assert.equal(resendRow.route, "/api/oauth/email/bind/resend");
    assert.equal(resendRow.content, "Email confirmation code resend");
    assert.deepEqual(resendRow.other.op, {
      action: "user.email_binding_resend",
      params: { success: false, code: "EMAIL_BINDING_RESEND_WAIT" },
    });

    const emptyBindRid = "email-bind-audit-empty-1";
    const emptyBind = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": emptyBindRid, "cf-connecting-ip": "192.0.2.194" },
        body: JSON.stringify({}),
      }),
      e,
    );
    assert.equal(emptyBind.body.code, "AUTH_FLOW_INVALID");
    const emptyBindRow = securityEvent(await auditsFor(e, auth, emptyBindRid), "user.binding_bind");
    assert.equal(emptyBindRow.success, false);
    assert.equal(emptyBindRow.route, "/api/oauth/email/bind");
    assert.equal(emptyBindRow.content, "Account binding");
    assert.deepEqual(emptyBindRow.other.op, {
      action: "user.binding_bind",
      params: { provider: "email", success: false, notification_failed: false, code: "AUTH_FLOW_INVALID" },
    });

    const bindRid = "email-bind-audit-ok-1";
    const bound = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": bindRid, "cf-connecting-ip": "192.0.2.195" },
        body: JSON.stringify({ flow_token: flowToken, new_code: newCode }),
      }),
      e,
    );
    assert.equal(bound.body.success, true, String(bound.body.message));
    const bindRow = securityEvent(await auditsFor(e, auth, bindRid), "user.binding_bind");
    assert.equal(bindRow.success, true);
    assert.equal(bindRow.status, 200);
    assert.deepEqual(bindRow.other.op, {
      action: "user.binding_bind",
      params: { provider: "email", success: true, notification_failed: false },
    });
    assert.equal(bindRow.other.admin_info, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original recordUserSecurityAudit leftover WeChatBind JSON", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("WeChatServerAddress", "https://wechat.example");
  await store.setOption("WeChatServerToken", "wechat-token");
  const origFetch = mockWeChat();

  try {
    const disabledRid = "wechat-bind-audit-disabled-1";
    const disabled = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": disabledRid, "cf-connecting-ip": "192.0.2.196" },
        body: JSON.stringify({ code: "wx-ok" }),
      }),
      e,
    );
    assert.equal(disabled.body.success, false);
    const disabledRow = securityEvent(await auditsFor(e, auth, disabledRid), "user.binding_bind");
    assert.equal(disabledRow.success, false);
    assert.equal(disabledRow.status, 200);
    assert.equal(disabledRow.route, "/api/oauth/wechat/bind");
    assert.equal(disabledRow.content, "Account binding");
    assert.deepEqual(disabledRow.other.op, {
      action: "user.binding_bind",
      params: { provider: "wechat", success: false, notification_failed: false },
    });
    assert.equal(disabledRow.other.admin_info, undefined);

    await store.setOption("WeChatAuthEnabled", "true");
    const missingRid = "wechat-bind-audit-missing-proof-1";
    const missing = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": missingRid, "cf-connecting-ip": "192.0.2.197" },
        body: JSON.stringify({ code: "wx-ok" }),
      }),
      e,
    );
    assert.equal(missing.res.status, 403);
    assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
    const missingRow = securityEvent(await auditsFor(e, auth, missingRid), "user.binding_bind");
    assert.equal(missingRow.success, false);
    assert.equal(missingRow.status, 403);
    assert.equal(missingRow.other.op?.params?.code, "SECURITY_PROOF_REQUIRED");

    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "wechat", code: "wx-ok" } });
    const okRid = "wechat-bind-audit-ok-1";
    const ok = await json(
      new Request("http://local/api/oauth/wechat/bind", {
        method: "POST",
        headers: {
          ...auth,
          "X-Security-Proof": proof.proof_token,
          "x-oneapi-request-id": okRid,
          "cf-connecting-ip": "192.0.2.198",
        },
        body: JSON.stringify({ code: "wx-ok" }),
      }),
      e,
    );
    assert.equal(ok.body.success, true, String(ok.body.message));
    const okRow = securityEvent(await auditsFor(e, auth, okRid), "user.binding_bind");
    assert.equal(okRow.success, true);
    assert.equal(okRow.status, 200);
    assert.deepEqual(okRow.other.op, {
      action: "user.binding_bind",
      params: { provider: "wechat", success: true, notification_failed: false },
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original recordUserSecurityAudit leftover OAuth bind start/callback JSON", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("GitHubOAuthEnabled", "true");
  await store.setOption("GitHubClientId", "github-client");
  await store.setOption("GitHubClientSecret", "github-secret");

  const grants = new Map<string, { id: number; login: string }>();
  let lastCode = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = (await req.json()) as { code?: string };
      lastCode = body.code || "";
      const grant = grants.get(lastCode);
      if (!grant) return Response.json({});
      return Response.json({ access_token: "ghs_test", token_type: "bearer" });
    }
    if (url.host === "api.github.com" && url.pathname === "/user") {
      const grant = grants.get(lastCode);
      if (!grant || req.headers.get("authorization") !== "Bearer ghs_test") return new Response("", { status: 401 });
      grants.delete(lastCode);
      return Response.json({ id: grant.id, login: grant.login });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  try {
    const loginRid = "oauth-bind-audit-login-1";
    const login = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { ...auth, "x-oneapi-request-id": loginRid, "cf-connecting-ip": "192.0.2.199" },
        body: JSON.stringify({ provider: "github", intent: "login" }),
      }),
      e,
    );
    assert.equal(login.body.success, true, String(login.body.message));
    assert.equal(
      (await auditsFor(e, auth, loginRid)).some((row) => row.action === "user.binding_start"),
      false,
    );

    const missingRid = "oauth-bind-audit-missing-proof-1";
    const missing = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: {
          ...auth,
          "x-oneapi-request-id": missingRid,
          "user-agent": "oauth-bind-client",
          "cf-connecting-ip": "192.0.2.200",
        },
        body: JSON.stringify({ provider: "github", intent: "bind" }),
      }),
      e,
    );
    assert.equal(missing.res.status, 403);
    assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
    const missingRow = securityEvent(await auditsFor(e, auth, missingRid), "user.binding_start");
    assert.equal(missingRow.success, false);
    assert.equal(missingRow.status, 403);
    assert.equal(missingRow.route, "/api/oauth/state");
    assert.equal(missingRow.content, "Account binding request");
    assert.equal(missingRow.user_agent, "oauth-bind-client");
    assert.deepEqual(missingRow.other.op, {
      action: "user.binding_start",
      params: { provider: "github", success: false, code: "SECURITY_PROOF_REQUIRED" },
    });
    assert.equal(missingRow.other.admin_info, undefined);

    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "github" } });
    const startRid = "oauth-bind-audit-start-ok-1";
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: {
          ...auth,
          "X-Security-Proof": proof.proof_token,
          "x-oneapi-request-id": startRid,
          "cf-connecting-ip": "192.0.2.201",
        },
        body: JSON.stringify({ provider: "github", intent: "bind" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const startRow = securityEvent(await auditsFor(e, auth, startRid), "user.binding_start");
    assert.equal(startRow.success, true);
    assert.deepEqual(startRow.other.op, {
      action: "user.binding_start",
      params: { provider: "github", success: true },
    });
    const flow = (started.body.data as { flow_token: string }).flow_token;

    const mismatchRid = "oauth-bind-audit-mismatch-1";
    const otherLogin = await json(
      new Request("http://local/api/user/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.202" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    const otherToken = (otherLogin.body.data as { access_token: string }).access_token;
    const mismatch = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(flow)}&code=mismatch-code`, {
        headers: { authorization: "Bearer " + otherToken, "x-oneapi-request-id": mismatchRid, "cf-connecting-ip": "192.0.2.203" },
      }),
      e,
    );
    assert.equal(mismatch.res.status, 403);
    const mismatchRow = securityEvent(await auditsFor(e, auth, mismatchRid), "user.binding_bind");
    assert.equal(mismatchRow.success, false);
    assert.equal(mismatchRow.status, 403);
    assert.equal(mismatchRow.route, "/api/oauth/:provider");
    assert.equal(mismatchRow.content, "Account binding");
    assert.deepEqual(mismatchRow.other.op, {
      action: "user.binding_bind",
      params: { provider: "github", success: false, notification_failed: false },
    });

    const missingStateRid = "oauth-bind-audit-missing-state-1";
    const missingState = await json(
      new Request("http://local/api/oauth/github?code=no-state", {
        headers: { ...auth, "x-oneapi-request-id": missingStateRid, "cf-connecting-ip": "192.0.2.204" },
      }),
      e,
    );
    assert.equal(missingState.res.status, 403);
    assert.equal(
      (await auditsFor(e, auth, missingStateRid)).some((row) => row.action === "user.binding_bind"),
      false,
    );

    grants.set("ok-bind", { id: 42, login: "octocat" });
    const okRid = "oauth-bind-audit-callback-ok-1";
    const ok = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(flow)}&code=ok-bind`, {
        headers: { ...auth, "x-oneapi-request-id": okRid, "cf-connecting-ip": "192.0.2.205" },
      }),
      e,
    );
    assert.equal(ok.body.success, true, String(ok.body.message));
    const okRow = securityEvent(await auditsFor(e, auth, okRid), "user.binding_bind");
    assert.equal(okRow.success, true);
    assert.equal(okRow.status, 200);
    assert.equal(okRow.route, "/api/oauth/:provider");
    assert.deepEqual(okRow.other.op, {
      action: "user.binding_bind",
      params: { provider: "github", success: true, notification_failed: false },
    });
    assert.equal(okRow.other.admin_info, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original recordUserSecurityAudit leftover UnbindCustomOAuth JSON", async () => {
  const { e, auth, store } = await boot();
  const created = await json(
    new Request("http://local/api/custom-oauth-provider/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "GHE",
        slug: "ghe-unbind-audit",
        icon: "github",
        enabled: true,
        client_id: "cid",
        client_secret: "csecret",
        authorization_endpoint: "https://ghe.example/login/oauth/authorize",
        token_endpoint: "https://ghe.example/login/oauth/access_token",
        user_info_endpoint: "https://ghe.example/api/v3/user",
        scopes: "user:email",
        user_id_field: "id",
        username_field: "login",
        display_name_field: "name",
        email_field: "email",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const providerId = Number((created.body.data as { id: number }).id);
  await store.upsertUserOAuthBinding(1, providerId, "ghe-user-1");

  const invalidRid = "oauth-unbind-audit-invalid-1";
  const invalid = await json(
    new Request("http://local/api/user/oauth/bindings/abc", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": invalidRid },
    }),
    e,
  );
  assert.equal(invalid.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, invalidRid)).some((row) => row.action === "user.binding_unbind"),
    false,
  );

  const missingRid = "oauth-unbind-audit-missing-proof-1";
  const missing = await json(
    new Request("http://local/api/user/oauth/bindings/" + providerId, {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": missingRid, "user-agent": "unbind-client", "cf-connecting-ip": "192.0.2.206" },
    }),
    e,
  );
  assert.equal(missing.res.status, 403);
  assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
  const missingRow = securityEvent(await auditsFor(e, auth, missingRid), "user.binding_unbind");
  assert.equal(missingRow.success, false);
  assert.equal(missingRow.status, 403);
  assert.equal(missingRow.method, "DELETE");
  assert.equal(missingRow.route, "/api/user/oauth/bindings/:provider_id");
  assert.equal(missingRow.content, "Account unlinking");
  assert.equal(missingRow.user_agent, "unbind-client");
  assert.deepEqual(missingRow.other.op, {
    action: "user.binding_unbind",
    params: { provider_id: providerId, success: false, notification_failed: false, code: "SECURITY_PROOF_REQUIRED" },
  });
  assert.equal(missingRow.other.admin_info, undefined);

  const proof = await passwordProof(e, auth, "account.binding.unbind", { context: { provider_id: providerId } });
  const okRid = "oauth-unbind-audit-ok-1";
  const ok = await json(
    new Request("http://local/api/user/oauth/bindings/" + providerId, {
      method: "DELETE",
      headers: { ...auth, "X-Security-Proof": proof.proof_token, "x-oneapi-request-id": okRid, "cf-connecting-ip": "192.0.2.207" },
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
  const okRow = securityEvent(await auditsFor(e, auth, okRid), "user.binding_unbind");
  assert.equal(okRow.success, true);
  assert.equal(okRow.status, 200);
  assert.deepEqual(okRow.other.op, {
    action: "user.binding_unbind",
    params: { provider_id: providerId, success: true, notification_failed: false },
  });
});
