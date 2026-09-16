import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
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

async function addModel(e: Env, auth: Record<string, string>, name: string): Promise<number> {
  const created = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: name }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return Number((created.body.data as { id: number }).id);
}

test("original recordManageAudit English model.delete templates are unregistered", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["model.delete"], undefined);
  assert.equal(AUDIT_CONTENT_TEMPLATES["model.delete_batch"], undefined);
  assert.equal(auditContentEN("model.delete", { model_ids: [1] }), "model.delete");
  assert.equal(auditContentEN("model.delete_batch", { model_ids: [2, 3] }), "model.delete_batch");
});

test("original recordManageAudit leftover model.delete JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  const id = await addModel(e, auth, "hop331-del");
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "hop331-ch",
        type: 1,
        key: "sk-hop331",
        models: "hop331-del,keep-me",
        group: "default",
      }),
    }),
    e,
  );

  const rid = "manage-audit-model-delete-1";
  const deleted = await json(
    new Request("http://local/api/models/" + id + "?remove_from_channels=true&remove_pricing=false", {
      method: "DELETE",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "model-delete-client",
        "cf-connecting-ip": "192.0.2.81",
      },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.deepEqual(deleted.body.data, { deleted_count: 1, updated_channels: 1 });
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "model.delete");
  assert.equal(privileged.category, AUDIT_CATEGORY_OPERATION);
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/models/:id");
  assert.equal(privileged.method, "DELETE");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.81");
  assert.equal(privileged.user_agent, "model-delete-client");
  assert.equal(privileged.content, "model.delete");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, {
    action: "model.delete",
    params: {
      model_ids: [id],
      remove_from_channels: true,
      remove_pricing: false,
      updated_channels: 1,
    },
  });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-model-delete-fail-1";
  const failed = await json(
    new Request("http://local/api/models/" + id + "?remove_from_channels=yes", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": failRid },
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.match(String(failed.body.message), /strconv.ParseBool/);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "model.delete");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/models/:id");
  assert.equal(failOp.content, "DELETE /api/models/:id");
  assert.ok(failOp.other.audit_info);
});

test("original recordManageAudit leftover model.delete_batch JSON", async () => {
  const { e, auth } = await boot();
  const id = await addModel(e, auth, "hop331-batch");
  const rid = "manage-audit-model-delete-batch-1";
  const batched = await json(
    new Request("http://local/api/models/delete", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "cf-connecting-ip": "192.0.2.82",
      },
      body: JSON.stringify({ model_ids: [id], remove_from_channels: false, remove_pricing: false }),
    }),
    e,
  );
  assert.equal(batched.body.success, true, String(batched.body.message));
  assert.deepEqual(batched.body.data, { deleted_count: 1, updated_channels: 0 });
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "model.delete_batch");
  assert.equal(privileged.success, true);
  assert.equal(privileged.route, "/api/models/delete");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.content, "model.delete_batch");
  assert.deepEqual(privileged.other.op?.params, {
    model_ids: [id],
    remove_from_channels: false,
    remove_pricing: false,
    updated_channels: 0,
  });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-model-delete-batch-fail-1";
  const failed = await json(
    new Request("http://local/api/models/delete", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: "{}",
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "select between 1 and 1000 models");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/models/delete");
});
