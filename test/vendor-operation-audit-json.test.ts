import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
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

type AuditItem = {
  category: string;
  action: string;
  success: boolean;
  status: number;
  user_id: number;
  username: string;
  actor_role: number;
  method: string;
  route: string;
  request_id: string;
  event_id: string;
  token_ref: string;
  content: string;
  auth_method: string;
  other: {
    op?: { action?: string; params?: Record<string, unknown> };
    admin_info?: { admin_id?: number; admin_username?: string; admin_role?: number; auth_method?: string };
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

async function createVendor(e: Env, auth: Record<string, string>, name: string) {
  const created = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name, description: "", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return created.body.data as { id: number; name: string };
}

test("original vendor.metadata.save/delete Content falls back to the action string", () => {
  assert.equal(auditContentEN("vendor.metadata.save", { name: "OpenAI", vendor_id: 1 }), "vendor.metadata.save");
  assert.equal(auditContentEN("vendor.metadata.delete", { vendor_id: 1 }), "vendor.metadata.delete");
  assert.equal(auditContentEN("vendor.assign", {}), "vendor.assign");
  assert.equal(auditContentEN("vendor.merge", {}), "vendor.merge");
});

test("original recordManageAudit leftover vendor.metadata.save on UpdateVendorMeta", async () => {
  const { e, auth } = await boot();
  const vendor = await createVendor(e, auth, "audit-vendor-update");

  const failRid = "vendor-meta-save-fail";
  const failed = await json(
    new Request("http://local/api/vendors/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": failRid, "user-agent": "vendor-audit-client" },
      body: JSON.stringify({ description: "no-id" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "vendor.update");
  assert.equal(failOp.content, "PUT /api/vendors/");
  assert.ok(failOp.other.audit_info);

  const okRid = "vendor-meta-save-ok";
  const updated = await json(
    new Request("http://local/api/vendors/", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": okRid,
        "user-agent": "vendor-audit-client",
        "cf-connecting-ip": "192.0.2.220",
      },
      body: JSON.stringify({ id: vendor.id, description: "updated-desc" }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  const row = operationEvent(await auditsFor(e, auth, okRid));
  assert.equal(row.action, "vendor.metadata.save");
  assert.equal(row.success, true);
  assert.equal(row.status, 200);
  assert.equal(row.method, "PUT");
  assert.equal(row.route, "/api/vendors/");
  assert.equal(row.auth_method, "session");
  assert.equal(row.token_ref, "");
  assert.equal(row.actor_role, ROLE_ROOT);
  assert.equal(row.content, "vendor.metadata.save");
  assert.notEqual(row.event_id, okRid);
  assert.equal("audit_info" in row.other, false);
  assert.deepEqual(row.other.op, {
    action: "vendor.metadata.save",
    params: { vendor_id: vendor.id, name: "audit-vendor-update" },
  });
  assert.deepEqual(row.other.admin_info, {
    admin_id: row.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });

  const selfView = operationEvent(await auditsFor(e, auth, okRid, "/api/audit/self"));
  assert.equal(selfView.action, "vendor.metadata.save");
  assert.equal(selfView.other.admin_info, undefined);
  assert.equal(selfView.other.audit_info, undefined);
});

test("original recordManageAudit leftover vendor.{action} on ApplyVendorOperation", async () => {
  const { e, auth } = await boot();
  const source = await createVendor(e, auth, "op-source");
  const target = await createVendor(e, auth, "op-target");
  const created = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "gpt-vendor-op", vendor_id: source.id, status: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const model = created.body.data as { id: number };

  const failRid = "vendor-op-fail";
  const failed = await json(
    new Request("http://local/api/vendors/operations", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid, "user-agent": "vendor-audit-client" },
      body: JSON.stringify({ action: "assign", model_ids: [model.id], target_vendor_id: target.id }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.res.status, 409);
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.route, "/api/vendors/operations");
  assert.equal(failOp.content, "POST /api/vendors/operations");
  assert.ok(failOp.other.audit_info);

  const preview = await json(
    new Request("http://local/api/vendors/operations/preview", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "assign", model_ids: [model.id], target_vendor_id: target.id }),
    }),
    e,
  );
  assert.equal(preview.body.success, true, String(preview.body.message));
  const version = (preview.body.data as { version: string }).version;
  const okRid = "vendor-op-assign-ok";
  const applied = await json(
    new Request("http://local/api/vendors/operations", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": okRid,
        "user-agent": "vendor-audit-client",
        "cf-connecting-ip": "192.0.2.221",
      },
      body: JSON.stringify({
        action: "assign",
        model_ids: [model.id],
        target_vendor_id: target.id,
        expected_version: version,
      }),
    }),
    e,
  );
  assert.equal(applied.body.success, true, String(applied.body.message));
  const data = applied.body.data as { updated_models: number[]; deleted_vendors: number[] };
  const row = operationEvent(await auditsFor(e, auth, okRid));
  assert.equal(row.action, "vendor.assign");
  assert.equal(row.success, true);
  assert.equal(row.status, 200);
  assert.equal(row.method, "POST");
  assert.equal(row.route, "/api/vendors/operations");
  assert.equal(row.auth_method, "session");
  assert.equal(row.token_ref, "");
  assert.equal(row.content, "vendor.assign");
  assert.equal("audit_info" in row.other, false);
  assert.deepEqual(row.other.op, {
    action: "vendor.assign",
    params: {
      source_vendor_ids: null,
      target_vendor_id: target.id,
      updated_model_ids: data.updated_models,
      deleted_vendor_ids: data.deleted_vendors,
    },
  });
  assert.deepEqual(row.other.admin_info, {
    admin_id: row.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });

  const mergeSource = await createVendor(e, auth, "op-merge-source");
  const mergeTarget = await createVendor(e, auth, "op-merge-target");
  const mergePreview = await json(
    new Request("http://local/api/vendors/operations/preview", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "merge", vendor_ids: [mergeSource.id], target_vendor_id: mergeTarget.id }),
    }),
    e,
  );
  assert.equal(mergePreview.body.success, true, String(mergePreview.body.message));
  const mergeRid = "vendor-op-merge-ok";
  const merged = await json(
    new Request("http://local/api/vendors/operations", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": mergeRid },
      body: JSON.stringify({
        action: "merge",
        vendor_ids: [mergeSource.id],
        target_vendor_id: mergeTarget.id,
        expected_version: (mergePreview.body.data as { version: string }).version,
      }),
    }),
    e,
  );
  assert.equal(merged.body.success, true, String(merged.body.message));
  const mergeRow = operationEvent(await auditsFor(e, auth, mergeRid));
  assert.equal(mergeRow.action, "vendor.merge");
  assert.equal(mergeRow.route, "/api/vendors/operations");
  assert.deepEqual(mergeRow.other.op, {
    action: "vendor.merge",
    params: {
      source_vendor_ids: [mergeSource.id],
      target_vendor_id: mergeTarget.id,
      updated_model_ids: (merged.body.data as { updated_models: number[] }).updated_models,
      deleted_vendor_ids: (merged.body.data as { deleted_vendors: number[] }).deleted_vendors,
    },
  });

  const createRid = "vendor-create-fallback-ok";
  const stillCreate = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": createRid },
      body: JSON.stringify({ name: "still-create-fallback" }),
    }),
    e,
  );
  assert.equal(stillCreate.body.success, true, String(stillCreate.body.message));
  const createOp = operationEvent(await auditsFor(e, auth, createRid));
  assert.equal(createOp.action, "vendor.create");
  assert.equal(createOp.content, "POST /api/vendors/");
});
