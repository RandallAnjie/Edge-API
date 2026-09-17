import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT, ROLE_USER } from "../src/constants.js";
import {
  AUDIT_CATEGORY_OPERATION,
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

async function passwordProof(e: Env, auth: Record<string, string>) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope: "access_token.generate", password: "password12" }),
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
    admin_info?: {
      admin_id?: number;
      admin_username?: string;
      admin_role?: number;
      auth_method?: string;
    };
    audit_info?: unknown;
  };
};

async function auditsFor(
  e: Env,
  auth: Record<string, string>,
  requestId: string,
  path = "/api/audit",
): Promise<AuditItem[]> {
  const listed = await json(
    new Request("http://local" + path + "?page_size=100&request_id=" + encodeURIComponent(requestId), { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  return ((listed.body.data as { items: AuditItem[] }).items || []) as AuditItem[];
}

function operationEvent(events: AuditItem[]): AuditItem {
  const op = events.find((row) => row.category === AUDIT_CATEGORY_OPERATION);
  assert.ok(op, "missing operation audit");
  return op!;
}

test("original recordManageAudit English templates and unregistered fallback", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["option.update"], "Updated system setting ${key}");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.create"], "Created user ${username} (role ${role})");
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["redemption.create"],
    "Created ${count} redemption codes named ${name} (${quota} each)",
  );
  assert.equal(auditContentEN("option.update", { key: "Notice" }), "Updated system setting Notice");
  assert.equal(auditContentEN("user.create", { username: "alice", role: 1 }), "Created user alice (role 1)");
  assert.equal(
    auditContentEN("redemption.create", { count: 2, name: "gift", quota: "＄1.000000 额度" }),
    "Created 2 redemption codes named gift (＄1.000000 额度 each)",
  );
  assert.equal(auditContentEN("option.update", {}), "Updated system setting ");
  assert.equal(auditContentEN("vendor.metadata.save", { name: "x" }), "vendor.metadata.save");
});

test("original recordManageAudit leftover option.update JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  const rid = "manage-audit-option-1";
  const updated = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "manage-audit-client",
        "cf-connecting-ip": "192.0.2.31",
      },
      body: JSON.stringify({ key: "Notice", value: "hop-324-notice" }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  assert.equal(updated.body.message, "");
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "option.update");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/option/");
  assert.equal(privileged.method, "PUT");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.31");
  assert.equal(privileged.user_agent, "manage-audit-client");
  assert.equal(privileged.content, "Updated system setting Notice");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, { action: "option.update", params: { key: "Notice" } });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("hop-324-notice"), false);

  const selfView = operationEvent(await auditsFor(e, auth, rid, "/api/audit/self"));
  assert.equal(selfView.action, "option.update");
  assert.equal(selfView.other.admin_info, undefined);
  assert.equal(selfView.other.audit_info, undefined);
  assert.deepEqual(selfView.other.op, { action: "option.update", params: { key: "Notice" } });

  const failRid = "manage-audit-option-fail-1";
  const failed = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ key: "", value: "x" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.deepEqual(failOp.other.op?.params, { method: "PUT", route: "/api/option/" });
});

test("original recordManageAudit leftover user.create JSON includes target_user_id", async () => {
  const { e, auth } = await boot();
  const rid = "manage-audit-user-create-1";
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": rid, "cf-connecting-ip": "192.0.2.32" },
      body: JSON.stringify({ username: "hop324-user", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.equal("data" in created.body, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.create");
  assert.equal(op.route, "/api/user/");
  assert.equal(op.method, "POST");
  assert.equal(op.content, "Created user hop324-user (role " + ROLE_USER + ")");
  assert.equal(op.other.op?.params?.username, "hop324-user");
  assert.equal(op.other.op?.params?.role, ROLE_USER);
  assert.equal(typeof op.other.op?.params?.target_user_id, "number");
  assert.notEqual(op.other.op?.params?.target_user_id, op.user_id);
  assert.equal(op.other.audit_info, undefined);
  assert.equal(op.other.admin_info?.admin_username, "root");
  assert.equal(JSON.stringify(op).includes("password12"), false);

  const missRid = "manage-audit-user-create-fail-1";
  const missing = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": missRid },
      body: JSON.stringify({ username: "", password: "password12" }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  const missOp = operationEvent(await auditsFor(e, auth, missRid));
  assert.equal(missOp.action, "generic");
  assert.equal(missOp.success, false);
});

test("original recordManageAudit skips reads/unauth and records PAT option.update", async () => {
  const { e, auth } = await boot();
  const getRid = "manage-audit-option-get-1";
  await json(new Request("http://local/api/option/", { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "manage-audit-option-anon-1";
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
      body: JSON.stringify({ key: "Notice", value: "anon" }),
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, anonRid)).length, 0);

  const proof = await passwordProof(e, auth);
  const issued = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  const pat = String(issued.body.data || "");
  assert.ok(pat);
  const patRid = "manage-audit-pat-option-1";
  const patPut = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.80",
      },
      body: JSON.stringify({ key: "About", value: "pat-about" }),
    }),
    e,
  );
  assert.equal(patPut.body.success, true, String(patPut.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "option.update");
  assert.equal(patOp.content, "Updated system setting About");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
});
