import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import { Store } from "../src/store.js";
import {
  AUDIT_CATEGORY_SECURITY,
  AUDIT_CONTENT_TEMPLATES,
  auditContentEN,
} from "../src/admin-operation-audit.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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

async function boot(extra: Partial<Env> = {}) {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
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
  return { e, auth, token };
}

async function enablePasskey(e: Env, auth: Record<string, string>) {
  const r = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "passkey.enabled", value: "true" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message));
}

async function passwordProof(e: Env, auth: Record<string, string>, scope: string, ip: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": ip },
      body: JSON.stringify({ method: "password", scope, password: "password12" }),
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

function securityEvent(events: AuditItem[], action: string): AuditItem {
  const row = events.find((item) => item.category === AUDIT_CATEGORY_SECURITY && item.action === action);
  assert.ok(row, "missing security audit " + action);
  return row!;
}

function assertSecurityVerify(
  row: AuditItem,
  method: string,
  route: string,
  params: Record<string, unknown>,
) {
  assert.equal(row.category, AUDIT_CATEGORY_SECURITY);
  assert.equal(row.action, "user.security_verify");
  assert.equal(row.success, true);
  assert.equal(row.status, 200);
  assert.equal(row.method, method);
  assert.equal(row.route, route);
  assert.equal(row.auth_method, "session");
  assert.equal(row.token_ref, "");
  assert.equal(row.actor_role, ROLE_ROOT);
  assert.equal(row.username, "root");
  assert.equal(row.content, "Completed security verification");
  assert.deepEqual(row.other.op, { action: "user.security_verify", params });
  assert.equal(row.other.admin_info, undefined);
  assert.equal(row.other.audit_info, undefined);
}

test("original recordUserSecurityAudit English user.security_verify template", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.security_verify"], "Completed security verification");
  assert.equal(auditContentEN("user.security_verify", { method: "password", scope: "2fa.setup" }), "Completed security verification");
});

test("original recordUserSecurityAudit leftover UniversalVerify JSON", async () => {
  const { e, auth } = await boot();

  const failRid = "security-verify-audit-empty-1";
  const empty = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid, "cf-connecting-ip": "192.0.2.160" },
    }),
    e,
  );
  assert.equal(empty.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, failRid)).some((row) => row.action === "user.security_verify"),
    false,
  );

  const rid = "security-verify-audit-password-1";
  const verified = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "security-verify-client",
        "cf-connecting-ip": "192.0.2.161",
      },
      body: JSON.stringify({ method: "password", scope: "2fa.setup", password: "password12" }),
    }),
    e,
  );
  assert.equal(verified.body.success, true, String(verified.body.message));
  const events = await auditsFor(e, auth, rid);
  assert.equal(events.length, 1);
  const row = securityEvent(events, "user.security_verify");
  assertSecurityVerify(row, "POST", "/api/verify", { method: "password", scope: "2fa.setup" });
  assert.equal(row.ip, "192.0.2.161");
  assert.equal(row.user_agent, "security-verify-client");
});

test("original recordUserSecurityAudit leftover PasskeyVerifyFinish JSON", async () => {
  const { e, auth } = await boot();
  await enablePasskey(e, auth);
  const beginProof = await passwordProof(e, auth, "passkey.register", "192.0.2.162");
  const begin = await json(
    new Request("http://local/api/user/passkey/register/begin", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": beginProof.proof_token, "cf-connecting-ip": "192.0.2.163" },
    }),
    e,
  );
  assert.equal(begin.body.success, true, String(begin.body.message));
  const flowToken = (begin.body.data as { flow_token: string }).flow_token;
  const registered = await json(
    new Request("http://local/api/user/passkey/register/finish", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.164" },
      body: JSON.stringify({ flow_token: flowToken, credential: { id: "cred-hop336", rawId: "cred-hop336" } }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  const nextAuth = {
    authorization: "Bearer " + (registered.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };

  const verifyBegin = await json(
    new Request("http://local/api/user/passkey/verify/begin", {
      method: "POST",
      headers: { ...nextAuth, "cf-connecting-ip": "192.0.2.165" },
      body: JSON.stringify({ scope: "2fa.setup" }),
    }),
    e,
  );
  assert.equal(verifyBegin.body.success, true, String(verifyBegin.body.message));
  const verifyFlow = (verifyBegin.body.data as { flow_token: string }).flow_token;

  const failRid = "security-verify-audit-passkey-fail-1";
  const invalid = await json(
    new Request("http://local/api/user/passkey/verify/finish", {
      method: "POST",
      headers: { ...nextAuth, "x-oneapi-request-id": failRid, "cf-connecting-ip": "192.0.2.166" },
      body: JSON.stringify({ flow_token: verifyFlow }),
    }),
    e,
  );
  assert.equal(invalid.body.success, false);
  assert.equal(
    (await auditsFor(e, nextAuth, failRid)).some((row) => row.action === "user.security_verify"),
    false,
  );

  const rid = "security-verify-audit-passkey-1";
  const finished = await json(
    new Request("http://local/api/user/passkey/verify/finish", {
      method: "POST",
      headers: {
        ...nextAuth,
        "x-oneapi-request-id": rid,
        "user-agent": "passkey-verify-client",
        "cf-connecting-ip": "192.0.2.167",
      },
      body: JSON.stringify({ flow_token: verifyFlow, credential: { id: "cred-hop336", rawId: "cred-hop336" } }),
    }),
    e,
  );
  assert.equal(finished.body.success, true, String(finished.body.message));
  const row = securityEvent(await auditsFor(e, nextAuth, rid), "user.security_verify");
  assertSecurityVerify(row, "POST", "/api/user/passkey/verify/finish", { method: "passkey", scope: "2fa.setup" });
  assert.equal(row.ip, "192.0.2.167");
  assert.equal(row.user_agent, "passkey-verify-client");
});

test("original recordUserSecurityAudit leftover OAuth verification JSON", async () => {
  const { e, auth } = await boot();
  const store = new Store(e.DB);
  await store.setOption("GitHubClientId", "github-client");
  await store.setOption("GitHubClientSecret", "github-secret");
  await store.setOption("GitHubOAuthEnabled", "true");
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.updateUser(root.id, { github_id: "42" });

  let ctSeq = 0;
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

  async function oauthJson(req: Request) {
    const headers = new Headers(req.headers);
    if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `oauth-verify-${++ctSeq}`);
    return json(new Request(req, { headers }), e);
  }

  try {
    async function startVerify() {
      const started = await oauthJson(
        new Request("http://local/api/oauth/state", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ provider: "github", intent: "verify", scope: "2fa.setup" }),
        }),
      );
      assert.equal(started.body.success, true, String(started.body.message));
      return (started.body.data as { flow_token: string }).flow_token;
    }

    const mismatchFlow = await startVerify();
    grants.set("other-github", { id: 99, login: "other" });
    const mismatchRid = "security-verify-audit-oauth-mismatch-1";
    const mismatch = await oauthJson(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(mismatchFlow)}&code=other-github`,
        { headers: { ...auth, "x-oneapi-request-id": mismatchRid } },
      ),
    );
    assert.equal(mismatch.body.success, false);
    assert.equal(
      (await auditsFor(e, auth, mismatchRid)).some((row) => row.action === "user.security_verify"),
      false,
    );

    const okFlow = await startVerify();
    grants.set("ok-verify", { id: 42, login: "octocat" });
    const rid = "security-verify-audit-oauth-1";
    const ok = await oauthJson(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(okFlow)}&code=ok-verify`, {
        headers: {
          ...auth,
          "x-oneapi-request-id": rid,
          "user-agent": "oauth-verify-client",
          "cf-connecting-ip": "192.0.2.168",
        },
      }),
    );
    assert.equal(ok.body.success, true, String(ok.body.message));
    const row = securityEvent(await auditsFor(e, auth, rid), "user.security_verify");
    assertSecurityVerify(row, "GET", "/api/oauth/:provider", {
      method: "oauth",
      scope: "2fa.setup",
      provider: "github",
    });
    assert.equal(row.ip, "192.0.2.168");
    assert.equal(row.user_agent, "oauth-verify-client");
  } finally {
    globalThis.fetch = origFetch;
  }
});
