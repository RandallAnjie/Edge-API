import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { CHANNEL_ENABLED, CHANNEL_MANUAL_DISABLED, ROLE_ROOT } from "../src/constants.js";
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

async function addChannel(e: Env, auth: Record<string, string>, name: string): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name, type: 1, key: "sk-" + name }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original recordManageAudit English channel.delete_disabled/delete_batch templates", () => {
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["channel.delete_disabled"],
    "Deleted all disabled channels (${count})",
  );
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.delete_batch"], "Batch deleted ${count} channels");
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.status_update"], undefined);
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.status_update_batch"], undefined);
  assert.equal(auditContentEN("channel.delete_disabled", { count: 3 }), "Deleted all disabled channels (3)");
  assert.equal(auditContentEN("channel.delete_batch", { count: 2 }), "Batch deleted 2 channels");
  assert.equal(auditContentEN("channel.status_update", { id: 9 }), "channel.status_update");
  assert.equal(auditContentEN("channel.status_update_batch", { count: 1 }), "channel.status_update_batch");
});

test("original recordManageAudit leftover channel.status_update JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, "hop329-status");
  const rid = "manage-audit-channel-status-1";
  const updated = await json(
    new Request("http://local/api/channel/" + id + "/status", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-status-client",
        "cf-connecting-ip": "192.0.2.61",
      },
      body: JSON.stringify({ status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  assert.equal(updated.body.message, "");
  assert.equal(updated.body.data, true);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.status_update");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/:id/status");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.61");
  assert.equal(privileged.user_agent, "channel-status-client");
  assert.equal(privileged.content, "channel.status_update");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, {
    action: "channel.status_update",
    params: { id, status: CHANNEL_MANUAL_DISABLED, changed: true },
  });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);

  const sameRid = "manage-audit-channel-status-unchanged-1";
  const same = await json(
    new Request("http://local/api/channel/" + id + "/status", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": sameRid },
      body: JSON.stringify({ status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  assert.equal(same.body.data, false);
  const sameOp = operationEvent(await auditsFor(e, auth, sameRid));
  assert.equal(sameOp.action, "channel.status_update");
  assert.deepEqual(sameOp.other.op?.params, { id, status: CHANNEL_MANUAL_DISABLED, changed: false });

  const missRid = "manage-audit-channel-status-missing-1";
  const missing = await json(
    new Request("http://local/api/channel/999999/status", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": missRid },
      body: JSON.stringify({ status: CHANNEL_ENABLED }),
    }),
    e,
  );
  assert.equal(missing.body.success, true);
  assert.equal(missing.body.data, false);
  const missOp = operationEvent(await auditsFor(e, auth, missRid));
  assert.equal(missOp.action, "channel.status_update");
  assert.deepEqual(missOp.other.op?.params, { id: 999999, status: CHANNEL_ENABLED, changed: false });

  const failRid = "manage-audit-channel-status-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/abc/status", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "Invalid parameters");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/channel/:id/status");
});

test("original recordManageAudit leftover channel.status_update_batch JSON", async () => {
  const { e, auth } = await boot();
  const a = await addChannel(e, auth, "hop329-batch-a");
  const b = await addChannel(e, auth, "hop329-batch-b");
  await json(
    new Request("http://local/api/channel/" + b + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  const rid = "manage-audit-channel-status-batch-1";
  const batch = await json(
    new Request("http://local/api/channel/status/batch", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "cf-connecting-ip": "192.0.2.62",
      },
      body: JSON.stringify({ ids: [a, b], status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  assert.equal(batch.body.success, true, String(batch.body.message));
  assert.equal(batch.body.data, 1);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.status_update_batch");
  assert.equal(privileged.success, true);
  assert.equal(privileged.route, "/api/channel/status/batch");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.content, "channel.status_update_batch");
  assert.deepEqual(privileged.other.op?.params, {
    count: 1,
    total: 2,
    status: CHANNEL_MANUAL_DISABLED,
  });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-channel-status-batch-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/status/batch", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ ids: [], status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "Invalid parameters");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/channel/status/batch");
});

test("original recordManageAudit leftover channel.delete_disabled JSON", async () => {
  const { e, auth } = await boot();
  const emptyRid = "manage-audit-channel-delete-disabled-empty-1";
  const empty = await json(
    new Request("http://local/api/channel/disabled", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": emptyRid },
    }),
    e,
  );
  assert.equal(empty.body.success, true, String(empty.body.message));
  assert.equal(empty.body.data, 0);
  const emptyOp = operationEvent(await auditsFor(e, auth, emptyRid));
  assert.equal(emptyOp.action, "channel.delete_disabled");
  assert.equal(emptyOp.content, "Deleted all disabled channels (0)");
  assert.deepEqual(emptyOp.other.op?.params, { count: 0 });
  assert.equal(emptyOp.other.audit_info, undefined);

  const id = await addChannel(e, auth, "hop329-disabled");
  await json(
    new Request("http://local/api/channel/" + id + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  const rid = "manage-audit-channel-delete-disabled-1";
  const deleted = await json(
    new Request("http://local/api/channel/disabled", {
      method: "DELETE",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-disabled-client",
        "cf-connecting-ip": "192.0.2.63",
      },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.equal(deleted.body.data, 1);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.delete_disabled");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/disabled");
  assert.equal(privileged.method, "DELETE");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.ip, "192.0.2.63");
  assert.equal(privileged.content, "Deleted all disabled channels (1)");
  assert.deepEqual(privileged.other.op, { action: "channel.delete_disabled", params: { count: 1 } });
  assert.equal(JSON.stringify(privileged).includes("sk-hop329-disabled"), false);

  const getRid = "manage-audit-channel-disabled-get-1";
  await json(new Request("http://local/api/channel/", { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "manage-audit-channel-disabled-anon-1";
  await json(
    new Request("http://local/api/channel/disabled", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, anonRid)).length, 0);
});

test("original recordManageAudit leftover channel.delete_batch JSON and PAT", async () => {
  const { e, auth } = await boot();
  const a = await addChannel(e, auth, "hop329-del-a");
  const b = await addChannel(e, auth, "hop329-del-b");
  const rid = "manage-audit-channel-delete-batch-1";
  const deleted = await json(
    new Request("http://local/api/channel/batch", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-batch-client",
        "cf-connecting-ip": "192.0.2.64",
      },
      body: JSON.stringify({ ids: [a, b] }),
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.equal(deleted.body.data, 2);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.delete_batch");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/batch");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.ip, "192.0.2.64");
  assert.equal(privileged.content, "Batch deleted 2 channels");
  assert.deepEqual(privileged.other.op, { action: "channel.delete_batch", params: { count: 2 } });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("sk-hop329-del-a"), false);

  const failRid = "manage-audit-channel-delete-batch-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/batch", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ ids: [] }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "参数错误");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/channel/batch");

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
  const keep = await addChannel(e, auth, "hop329-pat");
  const patRid = "manage-audit-pat-channel-delete-batch-1";
  const patDelete = await json(
    new Request("http://local/api/channel/batch", {
      method: "POST",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.83",
      },
      body: JSON.stringify({ ids: [keep] }),
    }),
    e,
  );
  assert.equal(patDelete.body.success, true, String(patDelete.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "channel.delete_batch");
  assert.equal(patOp.content, "Batch deleted 1 channels");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
});
