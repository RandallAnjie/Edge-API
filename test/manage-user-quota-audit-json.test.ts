import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { LOG_TOPUP, ROLE_ROOT } from "../src/constants.js";
import { AUDIT_CATEGORY_OPERATION } from "../src/admin-operation-audit.js";
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
  assert.ok(row);
  return row!.id;
}

type AuditItem = {
  category: string;
  action: string;
  success: boolean;
  status: number;
  actor_role: number;
  content: string;
  method: string;
  route: string;
  other: {
    op?: { action?: string; params?: Record<string, unknown> };
    admin_info?: { admin_username?: string };
    audit_info?: { path?: string; success?: boolean; status?: number; route?: string };
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

function operationEvent(events: AuditItem[]): AuditItem {
  const op = events.find((row) => row.category === AUDIT_CATEGORY_OPERATION);
  assert.ok(op, "missing operation audit");
  return op!;
}

test("original manageUserQuota leftover user.quota_add JSON omits data and writes topup log", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop326-add");
  const rid = "quota-audit-add-1";
  const added = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": rid, "cf-connecting-ip": "192.0.2.51" },
      body: JSON.stringify({ id, action: "add_quota", mode: "add", value: 100 }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  assert.equal(added.body.message, "");
  assert.equal("data" in added.body, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.quota_add");
  assert.equal(op.success, true);
  assert.equal(op.status, 200);
  assert.equal(op.route, "/api/user/manage");
  assert.equal(op.method, "POST");
  assert.equal(op.content, "Increased user quota by 100");
  assert.equal(op.other.op?.params?.target_user_id, id);
  assert.equal(op.other.op?.params?.mode, "add");
  assert.equal(op.other.op?.params?.requested_quota, 100);
  assert.equal(op.other.op?.params?.quota, 100);
  assert.equal(op.other.op?.params?.from, 0);
  assert.equal(op.other.op?.params?.to, 100);
  assert.equal(op.other.op?.params?.target_username, "hop326-add");
  assert.equal(op.other.audit_info?.path, "");
  assert.equal(op.other.audit_info?.success, true);
  assert.equal(op.other.audit_info?.route, "/api/user/manage");
  assert.equal(op.other.admin_info?.admin_username, "root");

  const logs = await json(new Request("http://local/api/log/?type=" + LOG_TOPUP + "&page_size=20", { headers: auth }), e);
  const items = ((logs.body.data as { items: { content: string; type: number; other: string }[] }).items || []);
  const topup = items.find((row) => row.content === "Increased user quota by 100");
  assert.ok(topup);
  assert.equal(topup.type, LOG_TOPUP);
  const other = JSON.parse(topup.other || "{}") as { op?: { action?: string } };
  assert.equal(other.op?.action, "user.quota_add");
});

test("original manageUserQuota leftover failed add audits Failed user quota adjustment", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop326-zero");
  const rid = "quota-audit-zero-1";
  const failed = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": rid },
      body: JSON.stringify({ id, action: "add_quota", mode: "add", value: 0 }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal("data" in failed.body, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.quota_add");
  assert.equal(op.success, false);
  assert.equal(op.content, "Failed user quota adjustment");
  assert.equal(op.other.op?.params?.failure_reason, "invalid_parameters");
  assert.equal(op.other.audit_info?.success, false);
  assert.equal(op.other.audit_info?.path, "");
});

test("original manageUserQuota leftover missing user is target_not_found", async () => {
  const { e, auth } = await boot();
  const rid = "quota-audit-missing-1";
  const missing = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": rid },
      body: JSON.stringify({ id: 99999, action: "add_quota", mode: "add", value: 10 }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "user.quota_add");
  assert.equal(op.success, false);
  assert.equal(op.other.op?.params?.failure_reason, "target_not_found");
});

test("original manageUserQuota leftover invalid mode is generic with add_quota params", async () => {
  const { e, auth } = await boot();
  const id = await createUser(e, auth, "hop326-mode");
  const rid = "quota-audit-mode-1";
  const bad = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": rid },
      body: JSON.stringify({ id, action: "add_quota", mode: "nope", value: 10 }),
    }),
    e,
  );
  assert.equal(bad.body.success, false);
  const op = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(op.action, "generic");
  assert.equal(op.success, false);
  assert.equal(op.content, "Failed user quota adjustment");
  assert.equal(op.other.op?.params?.action, "add_quota");
  assert.equal(op.other.op?.params?.method, "POST");
  assert.equal(op.other.op?.params?.route, "/api/user/manage");
  assert.equal(op.other.op?.params?.failure_reason, "invalid_parameters");
  assert.equal(op.actor_role, ROLE_ROOT);
});
