import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT, ROLE_USER } from "../src/constants.js";
import { ERR_ACCOUNT_PASSWORD_LENGTH } from "../src/crypto.js";
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
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `pw-del-${++ctSeq}`);
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
  return { e, auth };
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

test("original recordUserSecurityAudit English password_change / account_delete templates", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.password_change"], "Account password change");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.account_delete"], "Account deletion");
  assert.equal(auditContentEN("user.password_change", { success: true }), "Account password change");
  assert.equal(auditContentEN("user.account_delete", { success: false }), "Account deletion");
});

test("original recordUserSecurityAudit leftover UpdateSelf password_change JSON", async () => {
  const { e, auth } = await boot();

  const emptyRid = "password-change-audit-empty-1";
  const empty = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": emptyRid },
    }),
    e,
  );
  assert.equal(empty.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, emptyRid)).some((row) => row.action === "user.password_change"),
    false,
  );

  const sidebarRid = "password-change-audit-sidebar-1";
  const sidebar = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": sidebarRid },
      body: JSON.stringify({ sidebar_modules: JSON.stringify({ chat: true }) }),
    }),
    e,
  );
  assert.equal(sidebar.body.success, true);
  assert.equal(
    (await auditsFor(e, auth, sidebarRid)).some((row) => row.action === "user.password_change"),
    false,
  );

  const missingRid = "password-change-audit-missing-proof-1";
  const missing = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": missingRid,
        "user-agent": "password-change-client",
        "cf-connecting-ip": "192.0.2.180",
      },
      body: JSON.stringify({ password: "password13" }),
    }),
    e,
  );
  assert.equal(missing.res.status, 403);
  assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
  const missingRow = securityEvent(await auditsFor(e, auth, missingRid), "user.password_change");
  assert.equal(missingRow.success, false);
  assert.equal(missingRow.status, 403);
  assert.equal(missingRow.method, "PUT");
  assert.equal(missingRow.route, "/api/user/self");
  assert.equal(missingRow.auth_method, "session");
  assert.equal(missingRow.token_ref, "");
  assert.equal(missingRow.actor_role, ROLE_ROOT);
  assert.equal(missingRow.content, "Account password change");
  assert.equal(missingRow.ip, "192.0.2.180");
  assert.equal(missingRow.user_agent, "password-change-client");
  assert.deepEqual(missingRow.other.op, {
    action: "user.password_change",
    params: { success: false, notification_failed: false, code: "SECURITY_PROOF_REQUIRED" },
  });
  assert.equal(missingRow.other.admin_info, undefined);
  assert.deepEqual(missingRow.other.audit_info, {
    method: "PUT",
    route: "/api/user/self",
    path: "/api/user/self",
    status: 403,
    success: false,
  });

  const policyProof = await passwordProof(e, auth, "account.password.change");
  const policyRid = "password-change-audit-policy-1";
  const policy = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: {
        ...auth,
        "X-Security-Proof": policyProof.proof_token,
        "x-oneapi-request-id": policyRid,
        "cf-connecting-ip": "192.0.2.181",
      },
      body: JSON.stringify({ password: "short" }),
    }),
    e,
  );
  assert.equal(policy.res.status, 200);
  assert.equal(policy.body.code, "PASSWORD_POLICY_REJECTED");
  assert.equal(policy.body.message, ERR_ACCOUNT_PASSWORD_LENGTH);
  const policyRow = securityEvent(await auditsFor(e, auth, policyRid), "user.password_change");
  assert.equal(policyRow.success, false);
  assert.equal(policyRow.status, 200);
  assert.deepEqual(policyRow.other.op?.params, {
    success: false,
    notification_failed: false,
    code: "PASSWORD_POLICY_REJECTED",
  });
  assert.equal(policyRow.other.audit_info?.status, 200);
  assert.equal(policyRow.other.audit_info?.success, false);

  const okProof = await passwordProof(e, auth, "account.password.change");
  const okRid = "password-change-audit-ok-1";
  const ok = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: {
        ...auth,
        "X-Security-Proof": okProof.proof_token,
        "x-oneapi-request-id": okRid,
        "cf-connecting-ip": "192.0.2.182",
      },
      body: JSON.stringify({ password: "password13" }),
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
  const okAuth = {
    authorization: "Bearer " + (ok.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const okRow = securityEvent(await auditsFor(e, okAuth, okRid), "user.password_change");
  assert.equal(okRow.success, true);
  assert.equal(okRow.status, 200);
  assert.equal(okRow.route, "/api/user/self");
  assert.deepEqual(okRow.other.op, {
    action: "user.password_change",
    params: { success: true, notification_failed: false },
  });
  assert.equal(okRow.other.admin_info, undefined);
  assert.deepEqual(okRow.other.audit_info, {
    method: "PUT",
    route: "/api/user/self",
    path: "/api/user/self",
    status: 200,
    success: true,
  });
});

test("original recordUserSecurityAudit leftover DeleteSelf account_delete JSON", async () => {
  const { e, auth } = await boot();

  const missingRid = "account-delete-audit-missing-proof-1";
  const missing = await json(
    new Request("http://local/api/user/self", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": missingRid, "cf-connecting-ip": "192.0.2.183" },
    }),
    e,
  );
  assert.equal(missing.res.status, 403);
  assert.equal(missing.body.code, "SECURITY_PROOF_REQUIRED");
  const missingRow = securityEvent(await auditsFor(e, auth, missingRid), "user.account_delete");
  assert.equal(missingRow.success, false);
  assert.equal(missingRow.status, 403);
  assert.equal(missingRow.method, "DELETE");
  assert.equal(missingRow.route, "/api/user/self");
  assert.equal(missingRow.content, "Account deletion");
  assert.deepEqual(missingRow.other.op, {
    action: "user.account_delete",
    params: { success: false, code: "SECURITY_PROOF_REQUIRED" },
  });
  assert.equal(missingRow.other.admin_info, undefined);
  assert.deepEqual(missingRow.other.audit_info, {
    method: "DELETE",
    route: "/api/user/self",
    path: "/api/user/self",
    status: 403,
    success: false,
  });

  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "member-del", password: "password12", role: ROLE_USER }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const memberLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "member-del", password: "password12" }),
    }),
    e,
  );
  const memberAuth = {
    authorization: "Bearer " + (memberLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const delProof = await passwordProof(e, memberAuth, "account.delete");
  const okRid = "account-delete-audit-ok-1";
  const deleted = await json(
    new Request("http://local/api/user/self", {
      method: "DELETE",
      headers: {
        ...memberAuth,
        "X-Security-Proof": delProof.proof_token,
        "x-oneapi-request-id": okRid,
        "user-agent": "account-delete-client",
        "cf-connecting-ip": "192.0.2.184",
      },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const okRow = securityEvent(await auditsFor(e, auth, okRid), "user.account_delete");
  assert.equal(okRow.success, true);
  assert.equal(okRow.status, 200);
  assert.equal(okRow.username, "member-del");
  assert.equal(okRow.actor_role, ROLE_USER);
  assert.equal(okRow.ip, "192.0.2.184");
  assert.equal(okRow.user_agent, "account-delete-client");
  assert.deepEqual(okRow.other.op, { action: "user.account_delete", params: { success: true } });
  assert.deepEqual(okRow.other.audit_info, {
    method: "DELETE",
    route: "/api/user/self",
    path: "/api/user/self",
    status: 200,
    success: true,
  });
});
