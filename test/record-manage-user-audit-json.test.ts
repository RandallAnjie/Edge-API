import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ADMIN, ROLE_ROOT } from "../src/constants.js";
import { AUDIT_CATEGORY_OPERATION, auditContentEN } from "../src/admin-operation-audit.js";
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

async function createUser(e: Env, auth: Record<string, string>, username: string): Promise<number> {
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username, password: "password12" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/user/search?keyword=" + encodeURIComponent(username), { headers: auth }), e);
  const row = ((listed.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === username);
  assert.ok(row, "created user missing");
  return row!.id;
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

async function auditsFor(e: Env, auth: Record<string, string>, requestId: string, path = "/api/audit"): Promise<AuditItem[]> {
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

test("original recordManageAudit leftover user.update JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop325-upd");
  const rid = "manage-audit-user-update-1";
  const updated = await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "manage-user-audit",
        "cf-connecting-ip": "192.0.2.41",
      },
      body: JSON.stringify({ id, username: "hop325-upd", display_name: "Updated" }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  assert.equal("data" in updated.body, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.update");
  assert.equal(op.success, true);
  assert.equal(op.status, 200);
  assert.equal(op.route, "/api/user/");
  assert.equal(op.method, "PUT");
  assert.equal(op.auth_method, "session");
  assert.equal(op.token_ref, "");
  assert.equal(op.ip, "192.0.2.41");
  assert.equal(op.user_agent, "manage-user-audit");
  assert.equal(op.content, auditContentEN("user.update", { username: "hop325-upd", id }));
  assert.equal(op.actor_role, ROLE_ROOT);
  assert.deepEqual(op.other.op, { action: "user.update", params: { username: "hop325-upd", id, target_user_id: id } });
  assert.deepEqual(op.other.admin_info, {
    admin_id: op.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(op.other.audit_info, undefined);

  const selfView = operationEvent(await auditsFor(e, auth, rid, "/api/audit/self"));
  assert.equal(selfView.other.admin_info, undefined);
  assert.equal(selfView.other.audit_info, undefined);

  const failRid = "manage-audit-user-update-fail-1";
  const failed = await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ id, username: "" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
});

test("original recordManageAudit leftover user.delete JSON uses gin FullPath", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop325-del");
  const rid = "manage-audit-user-delete-1";
  const deleted = await json(
    new Request("http://local/api/user/" + id, {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": rid, "cf-connecting-ip": "192.0.2.42" },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.equal("data" in deleted.body, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.delete");
  assert.equal(op.route, "/api/user/:id");
  assert.equal(op.method, "DELETE");
  assert.equal(op.content, "Deleted user hop325-del (ID: " + id + ")");
  assert.equal(op.other.op?.params?.username, "hop325-del");
  assert.equal(op.other.op?.params?.id, id);
  assert.equal(op.other.op?.params?.target_user_id, id);
  assert.equal(op.other.audit_info, undefined);

  const missRid = "manage-audit-user-delete-fail-1";
  const missing = await json(
    new Request("http://local/api/user/99999", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": missRid },
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  const missOp = operationEvent(await auditsFor(e, auth, missRid));
  assert.equal(missOp.action, "generic");
  assert.equal(missOp.success, false);
  assert.equal(missOp.route, "/api/user/:id");
});

test("original recordManageAudit leftover user.manage JSON includes action params", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop325-mng");
  const rid = "manage-audit-user-manage-1";
  const promoted = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": rid, "cf-connecting-ip": "192.0.2.43" },
      body: JSON.stringify({ id, action: "promote" }),
    }),
    e,
  );
  assert.equal(promoted.body.success, true, String(promoted.body.message));
  const md = promoted.body.data as { role: number };
  assert.equal(md.role, ROLE_ADMIN);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.manage");
  assert.equal(op.route, "/api/user/manage");
  assert.equal(op.method, "POST");
  assert.equal(op.content, "Performed promote on user hop325-mng (ID: " + id + ")");
  assert.deepEqual(op.other.op?.params, { action: "promote", username: "hop325-mng", id, target_user_id: id });
  assert.equal(op.other.audit_info, undefined);

  const failRid = "manage-audit-user-manage-fail-1";
  const failed = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ id, action: "promote" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
});

test("original recordManageAudit leftover user.binding_clear JSON skips GET/unauth", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop325-bind");
  const getRid = "manage-audit-user-get-1";
  await json(new Request("http://local/api/user/" + id, { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "manage-audit-user-anon-1";
  await json(
    new Request("http://local/api/user/" + id, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, anonRid)).length, 0);

  const rid = "manage-audit-binding-clear-1";
  const cleared = await json(
    new Request("http://local/api/user/" + id + "/bindings/github", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": rid, "cf-connecting-ip": "192.0.2.44" },
    }),
    e,
  );
  assert.equal(cleared.body.success, true, String(cleared.body.message));
  assert.equal(cleared.body.message, "success");
  assert.equal("data" in cleared.body, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.binding_clear");
  assert.equal(op.route, "/api/user/:id/bindings/:binding_type");
  assert.equal(op.method, "DELETE");
  assert.equal(op.content, "Cleared github binding for user hop325-bind");
  assert.deepEqual(op.other.op?.params, { bindingType: "github", username: "hop325-bind", target_user_id: id });
  assert.equal(op.other.audit_info, undefined);
  assert.equal(op.other.admin_info?.admin_username, "root");
});
