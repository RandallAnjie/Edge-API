import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import {
  ADMIN_OPERATION_AUDIT_MAX_BODY,
  AUDIT_CATEGORY_OPERATION,
  AUDIT_ROUTE_ACTIONS,
  isAdminAuditWriteMethod,
  matchAdminAuditRoute,
  reconstructAdminAuditRoute,
} from "../src/admin-operation-audit.js";
import { TOKEN_OPERATION_AUDIT_MAX_BODY, auditResponseSuccess } from "../src/token-operation-audit.js";
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

type AuditOp = { action?: string; params?: Record<string, unknown> };
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
    op?: AuditOp;
    admin_info?: {
      admin_id?: number;
      admin_username?: string;
      admin_role?: number;
      auth_method?: string;
    };
    audit_info?: {
      method?: string;
      route?: string;
      path?: string;
      status?: number;
      success?: boolean;
      params?: Record<string, string>;
    };
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

test("original beginAdminAudit FullPath actions, generic fallback, and write gate", () => {
  assert.equal(ADMIN_OPERATION_AUDIT_MAX_BODY, 64 * 1024);
  assert.equal(ADMIN_OPERATION_AUDIT_MAX_BODY, TOKEN_OPERATION_AUDIT_MAX_BODY);
  assert.equal(AUDIT_CATEGORY_OPERATION, "operation");
  assert.equal(AUDIT_ROUTE_ACTIONS["POST /api/vendors/"], "vendor.create");
  assert.equal(AUDIT_ROUTE_ACTIONS["DELETE /api/vendors/:id"], "vendor.delete");
  assert.equal(AUDIT_ROUTE_ACTIONS["POST /api/option/rest_model_ratio"], "option.reset_ratio");
  assert.equal(AUDIT_ROUTE_ACTIONS["POST /api/performance/gc"], "performance.gc");
  assert.deepEqual(matchAdminAuditRoute("POST", "/api/vendors/"), {
    action: "vendor.create",
    route: "/api/vendors/",
    params: {},
  });
  assert.equal(matchAdminAuditRoute("POST", "/api/vendors").route, "/api/vendors/");
  assert.deepEqual(matchAdminAuditRoute("DELETE", "/api/vendors/12"), {
    action: "vendor.delete",
    route: "/api/vendors/:id",
    params: { id: "12" },
  });
  assert.equal(matchAdminAuditRoute("DELETE", "/api/redemption/invalid").action, "redemption.delete_invalid");
  assert.deepEqual(matchAdminAuditRoute("DELETE", "/api/redemption/9"), {
    action: "redemption.delete",
    route: "/api/redemption/:id",
    params: { id: "9" },
  });
  assert.deepEqual(matchAdminAuditRoute("POST", "/api/performance/reset_stats"), {
    action: "generic",
    route: "/api/performance/reset_stats",
    params: {},
  });
  assert.equal(reconstructAdminAuditRoute("/api/user/5/2fa", { id: "5" }), "/api/user/:id/2fa");
  assert.equal(isAdminAuditWriteMethod("POST"), true);
  assert.equal(isAdminAuditWriteMethod("PATCH"), true);
  assert.equal(isAdminAuditWriteMethod("GET"), false);
  assert.equal(isAdminAuditWriteMethod("HEAD"), false);
  assert.equal(auditResponseSuccess(400, '{"success":true}'), false);
  assert.equal(auditResponseSuccess(200, '{"success":false}'), false);
});

test("original finishAdminAudit leftover operation JSON on vendor create/delete", async () => {
  const { e, auth } = await boot();
  const rid = "admin-audit-vendor-create-1";
  const created = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "admin-audit-client",
        "cf-connecting-ip": "192.0.2.21",
      },
      body: JSON.stringify({ name: "audit-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const createdId = (created.body.data as { id: number }).id;
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "vendor.create");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/vendors/");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.21");
  assert.equal(privileged.user_agent, "admin-audit-client");
  assert.equal(privileged.content, "POST /api/vendors/");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.equal(privileged.username, "root");
  assert.deepEqual(privileged.other.op, { action: "vendor.create" });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.deepEqual(privileged.other.audit_info, {
    method: "POST",
    route: "/api/vendors/",
    path: "/api/vendors/",
    status: 200,
    success: true,
  });

  const selfView = operationEvent(await auditsFor(e, auth, rid, "/api/audit/self"));
  assert.equal(selfView.action, "vendor.create");
  assert.equal(selfView.other.admin_info, undefined);
  assert.equal(selfView.other.audit_info, undefined);
  assert.deepEqual(selfView.other.op, { action: "vendor.create" });

  const delRid = "admin-audit-vendor-delete-1";
  const deleted = await json(
    new Request("http://local/api/vendors/" + createdId, {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": delRid, "cf-connecting-ip": "192.0.2.21" },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const del = operationEvent(await auditsFor(e, auth, delRid));
  assert.equal(del.action, "vendor.delete");
  assert.equal(del.route, "/api/vendors/:id");
  assert.equal(del.content, "DELETE /api/vendors/:id");
  assert.deepEqual(del.other.op, { action: "vendor.delete" });
  assert.deepEqual(del.other.audit_info?.params, { id: String(createdId) });
  assert.equal(del.other.audit_info?.path, "/api/vendors/:id");
});

test("original finishAdminAudit leftover failure, skip reads/unauth, and mapped root writes", async () => {
  const { e, auth } = await boot();
  const failRid = "admin-audit-vendor-fail-1";
  const failed = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ name: "  ", description: "" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.res.status, 400);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "vendor.create");
  assert.equal(failOp.success, false);
  assert.equal(failOp.status, 400);
  assert.deepEqual(failOp.other.op, { action: "vendor.create" });
  assert.equal(failOp.other.audit_info?.success, false);

  const getRid = "admin-audit-vendor-get-1";
  await json(new Request("http://local/api/vendors/", { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "admin-audit-vendor-anon-1";
  await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
      body: JSON.stringify({ name: "anon-vendor" }),
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, anonRid)).length, 0);

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "plain-user", password: "password12" }),
    }),
    e,
  );
  const userLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "plain-user", password: "password12" }),
    }),
    e,
  );
  const userAuth = {
    authorization: "Bearer " + (userLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const userRid = "admin-audit-vendor-user-1";
  const denied = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { ...userAuth, "x-oneapi-request-id": userRid },
      body: JSON.stringify({ name: "nope" }),
    }),
    e,
  );
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.message, "无权访问");
  assert.equal((await auditsFor(e, auth, userRid)).length, 0);
  assert.equal(denied.body.data, null);

  const ratioRid = "admin-audit-reset-ratio-1";
  const reset = await json(
    new Request("http://local/api/option/rest_model_ratio", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": ratioRid },
    }),
    e,
  );
  assert.equal(reset.body.success, true, String(reset.body.message));
  const ratio = operationEvent(await auditsFor(e, auth, ratioRid));
  assert.equal(ratio.action, "option.reset_ratio");
  assert.equal(ratio.route, "/api/option/rest_model_ratio");
  assert.equal(ratio.content, "POST /api/option/rest_model_ratio");
  assert.equal(ratio.actor_role, ROLE_ROOT);

  const gcRid = "admin-audit-gc-1";
  const gc = await json(
    new Request("http://local/api/performance/gc", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": gcRid },
    }),
    e,
  );
  assert.equal(gc.body.success, true, String(gc.body.message));
  const gcOp = operationEvent(await auditsFor(e, auth, gcRid));
  assert.equal(gcOp.action, "performance.gc");
  assert.equal(gcOp.route, "/api/performance/gc");
  assert.equal(gcOp.content, "POST /api/performance/gc");
});

test("original finishAdminAudit skips markAuditLogged, records generic, and PAT dual events", async () => {
  const { e, auth } = await boot();
  const chRid = "admin-audit-channel-create-1";
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": chRid, "cf-connecting-ip": "192.0.2.22" },
      body: JSON.stringify({ name: "audit-ch", type: 1, key: "sk-audit" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const chEvents = await auditsFor(e, auth, chRid);
  const chOp = operationEvent(chEvents);
  assert.equal(chOp.action, "channel.create");
  assert.notEqual(chOp.action, "generic");
  assert.equal(chOp.other.audit_info, undefined);

  const genRid = "admin-audit-generic-1";
  const resetStats = await json(
    new Request("http://local/api/performance/reset_stats", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": genRid, "user-agent": "generic-audit" },
    }),
    e,
  );
  assert.equal(resetStats.body.success, true, String(resetStats.body.message));
  const generic = operationEvent(await auditsFor(e, auth, genRid));
  assert.equal(generic.action, "generic");
  assert.equal(generic.route, "/api/performance/reset_stats");
  assert.equal(generic.content, "POST /api/performance/reset_stats");
  assert.deepEqual(generic.other.op, {
    action: "generic",
    params: { method: "POST", route: "/api/performance/reset_stats" },
  });
  assert.equal(generic.other.audit_info?.route, "/api/performance/reset_stats");
  assert.equal(generic.other.audit_info?.path, "/api/performance/reset_stats");

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
  const patRid = "admin-audit-pat-vendor-1";
  const patCreate = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.80",
      },
      body: JSON.stringify({ name: "pat-vendor" }),
    }),
    e,
  );
  assert.equal(patCreate.body.success, true, String(patCreate.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "vendor.create");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
});
