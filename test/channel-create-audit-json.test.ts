import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { CHANNEL_TYPE_TASK_PLUGIN, ROLE_ROOT } from "../src/constants.js";
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

test("original recordManageAudit English channel.create template", () => {
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["channel.create"],
    "Created channel ${name} (type ${type}, count ${count})",
  );
  assert.equal(
    auditContentEN("channel.create", { name: "audit-ch", type: 1, count: 1 }),
    "Created channel audit-ch (type 1, count 1)",
  );
  assert.equal(auditContentEN("channel.create", {}), "Created channel  (type , count )");
});

test("original recordManageAudit leftover channel.create JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  const rid = "manage-audit-channel-create-1";
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-audit-client",
        "cf-connecting-ip": "192.0.2.41",
      },
      body: JSON.stringify({ name: "hop327-ch", type: 1, key: "sk-secret-key" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.equal(created.body.message, "");
  const data = created.body.data as { id: number; count: number };
  assert.ok(data.id > 0);
  assert.equal(data.count, 1);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.create");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.41");
  assert.equal(privileged.user_agent, "channel-audit-client");
  assert.equal(privileged.content, "Created channel hop327-ch (type 1, count 1)");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, {
    action: "channel.create",
    params: { name: "hop327-ch", type: 1, count: 1 },
  });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("sk-secret-key"), false);

  const selfView = operationEvent(await auditsFor(e, auth, rid, "/api/audit/self"));
  assert.equal(selfView.action, "channel.create");
  assert.equal(selfView.other.admin_info, undefined);
  assert.equal(selfView.other.audit_info, undefined);
  assert.deepEqual(selfView.other.op, { action: "channel.create", params: { name: "hop327-ch", type: 1, count: 1 } });
});

test("original recordManageAudit leftover wrapped/batch channel.create JSON", async () => {
  const { e, auth } = await boot();
  const wrapRid = "manage-audit-channel-wrap-1";
  const wrapped = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": wrapRid },
      body: JSON.stringify({
        mode: "single",
        channel: { name: "wrapped-327", type: 1, key: "sk-wrap", models: "gpt-4o-mini", group: "default" },
      }),
    }),
    e,
  );
  assert.equal(wrapped.body.success, true, String(wrapped.body.message));
  const wrapOp = operationEvent(await auditsFor(e, auth, wrapRid));
  assert.equal(wrapOp.action, "channel.create");
  assert.equal(wrapOp.content, "Created channel wrapped-327 (type 1, count 1)");
  assert.equal(wrapOp.other.op?.params?.count, 1);
  assert.equal(wrapOp.other.audit_info, undefined);

  const batchRid = "manage-audit-channel-batch-1";
  const batch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": batchRid },
      body: JSON.stringify({
        mode: "batch",
        batch_add_set_key_prefix_2_name: true,
        channel: { name: "batch-ch", type: 1, key: "sk-batch-a\nsk-batch-b", models: "gpt-4o-mini", group: "default" },
      }),
    }),
    e,
  );
  assert.equal(batch.body.success, true, String(batch.body.message));
  assert.equal((batch.body.data as { count: number }).count, 2);
  const batchOp = operationEvent(await auditsFor(e, auth, batchRid));
  assert.equal(batchOp.action, "channel.create");
  assert.equal(batchOp.content, "Created channel batch-ch sk-batch- (type 1, count 2)");
  assert.equal(batchOp.other.op?.params?.name, "batch-ch sk-batch-");
  assert.equal(batchOp.other.op?.params?.count, 2);
  assert.equal(JSON.stringify(batchOp).includes("sk-batch-a"), false);
  assert.equal(JSON.stringify(batchOp).includes("sk-batch-b"), false);

  const failRid = "manage-audit-channel-mode-1";
  const failed = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ mode: "merge", channel: { name: "x", type: 1, key: "sk-x" } }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "不支持的添加模式");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.deepEqual(failOp.other.op?.params, { method: "POST", route: "/api/channel/" });
});

test("original recordManageAudit leftover channel.create plugin_default, reads/unauth, and PAT", async () => {
  const { e, auth } = await boot();
  const plugRid = "manage-audit-channel-plugin-1";
  const plugin = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": plugRid },
      body: JSON.stringify({
        name: "plugin-ch",
        type: CHANNEL_TYPE_TASK_PLUGIN,
        key: "sk-plugin",
        setting: { task_plugin_key: "demo" },
      }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, String(plugin.body.message));
  const plugOp = operationEvent(await auditsFor(e, auth, plugRid));
  assert.equal(plugOp.action, "channel.create");
  assert.equal(plugOp.content, "Created channel plugin-ch (type " + CHANNEL_TYPE_TASK_PLUGIN + ", count 1)");
  assert.equal(plugOp.other.op?.params?.base_url_source, "plugin_default");
  assert.equal(plugOp.other.op?.params?.type, CHANNEL_TYPE_TASK_PLUGIN);

  const getRid = "manage-audit-channel-get-1";
  await json(new Request("http://local/api/channel/", { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "manage-audit-channel-anon-1";
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
      body: JSON.stringify({ name: "anon-ch", type: 1, key: "sk-anon" }),
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
  const patRid = "manage-audit-pat-channel-1";
  const patCreate = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.81",
      },
      body: JSON.stringify({ name: "pat-ch", type: 1, key: "sk-pat" }),
    }),
    e,
  );
  assert.equal(patCreate.body.success, true, String(patCreate.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "channel.create");
  assert.equal(patOp.content, "Created channel pat-ch (type 1, count 1)");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
  assert.equal(JSON.stringify(patEvents).includes("sk-pat"), false);
});
