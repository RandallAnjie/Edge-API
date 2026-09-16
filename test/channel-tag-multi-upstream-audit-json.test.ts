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

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original recordManageAudit English channel tag/multi-key/upstream templates", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.tag_disable"], "Disabled channels with tag ${tag}");
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.tag_enable"], "Enabled channels with tag ${tag}");
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.tag_edit"], "Edited channels with tag ${tag}");
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.tag_batch_set"], "Batch set tag for ${count} channels");
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["channel.multi_key_manage"],
    "Multi-key management ${action} on channel (ID: ${id})",
  );
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["channel.upstream_apply"],
    "Applied upstream model changes to channel (ID: ${id})",
  );
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["channel.upstream_apply_all"],
    "Applied upstream model changes to ${count} channels",
  );
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.upstream_detect_all"], undefined);
  assert.equal(auditContentEN("channel.tag_disable", { tag: "prod" }), "Disabled channels with tag prod");
  assert.equal(auditContentEN("channel.tag_enable", { tag: "prod" }), "Enabled channels with tag prod");
  assert.equal(auditContentEN("channel.tag_edit", { tag: "prod" }), "Edited channels with tag prod");
  assert.equal(auditContentEN("channel.tag_batch_set", { count: 3 }), "Batch set tag for 3 channels");
  assert.equal(
    auditContentEN("channel.multi_key_manage", { action: "disable_key", id: 9 }),
    "Multi-key management disable_key on channel (ID: 9)",
  );
  assert.equal(auditContentEN("channel.upstream_apply", { id: 4 }), "Applied upstream model changes to channel (ID: 4)");
  assert.equal(auditContentEN("channel.upstream_apply_all", { count: 2 }), "Applied upstream model changes to 2 channels");
  assert.equal(auditContentEN("channel.upstream_detect_all", { task_id: "systask_x" }), "channel.upstream_detect_all");
});

test("original recordManageAudit leftover channel.tag_disable/enable/edit JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  await addChannel(e, auth, {
    name: "hop330-tag",
    type: 1,
    key: "sk-hop330-tag",
    models: "gpt-4o",
    group: "default",
    tag: "prod",
  });

  const disableRid = "manage-audit-channel-tag-disable-1";
  const disabled = await json(
    new Request("http://local/api/channel/tag/disabled", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": disableRid,
        "user-agent": "channel-tag-client",
        "cf-connecting-ip": "192.0.2.71",
      },
      body: JSON.stringify({ tag: "prod" }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  assert.equal(disabled.body.message, "");
  assert.equal("data" in disabled.body, false);
  const disableOp = operationEvent(await auditsFor(e, auth, disableRid));
  assert.equal(disableOp.action, "channel.tag_disable");
  assert.equal(disableOp.success, true);
  assert.equal(disableOp.status, 200);
  assert.equal(disableOp.route, "/api/channel/tag/disabled");
  assert.equal(disableOp.method, "POST");
  assert.equal(disableOp.auth_method, "session");
  assert.equal(disableOp.token_ref, "");
  assert.equal(disableOp.ip, "192.0.2.71");
  assert.equal(disableOp.user_agent, "channel-tag-client");
  assert.equal(disableOp.content, "Disabled channels with tag prod");
  assert.equal(disableOp.actor_role, ROLE_ROOT);
  assert.deepEqual(disableOp.other.op, { action: "channel.tag_disable", params: { tag: "prod" } });
  assert.deepEqual(disableOp.other.admin_info, {
    admin_id: disableOp.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(disableOp.other.audit_info, undefined);

  const enableRid = "manage-audit-channel-tag-enable-1";
  const enabled = await json(
    new Request("http://local/api/channel/tag/enabled", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": enableRid },
      body: JSON.stringify({ tag: "prod" }),
    }),
    e,
  );
  assert.equal(enabled.body.success, true, String(enabled.body.message));
  const enableOp = operationEvent(await auditsFor(e, auth, enableRid));
  assert.equal(enableOp.action, "channel.tag_enable");
  assert.equal(enableOp.route, "/api/channel/tag/enabled");
  assert.equal(enableOp.content, "Enabled channels with tag prod");
  assert.deepEqual(enableOp.other.op?.params, { tag: "prod" });
  assert.equal(enableOp.other.audit_info, undefined);

  const editRid = "manage-audit-channel-tag-edit-1";
  const edited = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": editRid },
      body: JSON.stringify({ tag: "prod", new_tag: "staging" }),
    }),
    e,
  );
  assert.equal(edited.body.success, true, String(edited.body.message));
  const editOp = operationEvent(await auditsFor(e, auth, editRid));
  assert.equal(editOp.action, "channel.tag_edit");
  assert.equal(editOp.route, "/api/channel/tag");
  assert.equal(editOp.method, "PUT");
  assert.equal(editOp.content, "Edited channels with tag prod");
  assert.deepEqual(editOp.other.op?.params, { tag: "prod" });

  const failRid = "manage-audit-channel-tag-disable-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/tag/disabled", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ tag: "" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "参数错误");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/channel/tag/disabled");
});

test("original recordManageAudit leftover channel.tag_batch_set JSON", async () => {
  const { e, auth } = await boot();
  const a = await addChannel(e, auth, { name: "hop330-batch-a", type: 1, key: "sk-hop330-a", models: "gpt-4o", group: "default" });
  const b = await addChannel(e, auth, { name: "hop330-batch-b", type: 1, key: "sk-hop330-b", models: "gpt-4o", group: "default" });
  const rid = "manage-audit-channel-tag-batch-1";
  const batched = await json(
    new Request("http://local/api/channel/batch/tag", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "cf-connecting-ip": "192.0.2.72",
      },
      body: JSON.stringify({ ids: [a, b], tag: "prod" }),
    }),
    e,
  );
  assert.equal(batched.body.success, true, String(batched.body.message));
  assert.equal(batched.body.data, 2);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.tag_batch_set");
  assert.equal(privileged.success, true);
  assert.equal(privileged.route, "/api/channel/batch/tag");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.content, "Batch set tag for 2 channels");
  assert.deepEqual(privileged.other.op?.params, { count: 2 });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-channel-tag-batch-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/batch/tag", {
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
  assert.equal(failOp.route, "/api/channel/batch/tag");
});

test("original recordManageAudit leftover channel.multi_key_manage JSON skips get_key_status", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, {
    name: "hop330-multi",
    type: 1,
    key: "sk-a\nsk-b",
    models: "gpt-4o",
    group: "default",
    mode: "multi_to_single",
    multi_key_mode: "random",
  });

  const statusRid = "manage-audit-channel-multi-status-1";
  const status = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": statusRid },
      body: JSON.stringify({ channel_id: id, action: "get_key_status" }),
    }),
    e,
  );
  assert.equal(status.body.success, true, String(status.body.message));
  const statusEvents = (await auditsFor(e, auth, statusRid)).filter((row) => row.category === AUDIT_CATEGORY_OPERATION);
  assert.equal(statusEvents.length, 0);

  const disableRid = "manage-audit-channel-multi-disable-1";
  const disabled = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": disableRid,
        "user-agent": "channel-multi-client",
        "cf-connecting-ip": "192.0.2.73",
      },
      body: JSON.stringify({ channel_id: id, action: "disable_key", key_index: 0 }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  assert.equal(disabled.body.message, "密钥已禁用");
  const disableOp = operationEvent(await auditsFor(e, auth, disableRid));
  assert.equal(disableOp.action, "channel.multi_key_manage");
  assert.equal(disableOp.success, true);
  assert.equal(disableOp.status, 200);
  assert.equal(disableOp.route, "/api/channel/multi_key/manage");
  assert.equal(disableOp.method, "POST");
  assert.equal(disableOp.auth_method, "session");
  assert.equal(disableOp.token_ref, "");
  assert.equal(disableOp.ip, "192.0.2.73");
  assert.equal(disableOp.user_agent, "channel-multi-client");
  assert.equal(disableOp.content, `Multi-key management disable_key on channel (ID: ${id})`);
  assert.deepEqual(disableOp.other.op, {
    action: "channel.multi_key_manage",
    params: { action: "disable_key", id },
  });
  assert.equal(disableOp.other.audit_info, undefined);

  const missingIndexRid = "manage-audit-channel-multi-missing-index-1";
  const missingIndex = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": missingIndexRid },
      body: JSON.stringify({ channel_id: id, action: "disable_key" }),
    }),
    e,
  );
  assert.equal(missingIndex.body.success, false);
  assert.equal(missingIndex.body.message, "未指定要禁用的密钥索引");
  const missingIndexOp = operationEvent(await auditsFor(e, auth, missingIndexRid));
  assert.equal(missingIndexOp.action, "channel.multi_key_manage");
  assert.equal(missingIndexOp.success, true);
  assert.deepEqual(missingIndexOp.other.op?.params, { action: "disable_key", id });

  const missRid = "manage-audit-channel-multi-missing-1";
  const missing = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": missRid },
      body: JSON.stringify({ channel_id: 999999, action: "disable_key", key_index: 0 }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "渠道不存在");
  const missOp = operationEvent(await auditsFor(e, auth, missRid));
  assert.equal(missOp.action, "generic");
  assert.equal(missOp.success, false);
  assert.equal(missOp.route, "/api/channel/multi_key/manage");
});

test("original recordManageAudit leftover channel.upstream_apply/apply_all/detect_all JSON", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, {
    name: "hop330-up",
    type: 1,
    key: "sk-hop330-up",
    models: "gpt-4o",
    group: "default",
    settings: JSON.stringify({
      upstream_model_update_check_enabled: true,
      upstream_model_update_last_detected_models: ["gpt-4.1"],
    }),
  });
  await addChannel(e, auth, {
    name: "hop330-up-all",
    type: 1,
    key: "sk-hop330-up-all",
    models: "gpt-4o",
    group: "default",
    settings: JSON.stringify({
      upstream_model_update_check_enabled: true,
      upstream_model_update_last_detected_models: ["gpt-4.1"],
    }),
  });

  const applyRid = "manage-audit-channel-upstream-apply-1";
  const applied = await json(
    new Request("http://local/api/channel/upstream_updates/apply", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": applyRid,
        "cf-connecting-ip": "192.0.2.74",
      },
      body: JSON.stringify({ id, add_models: ["gpt-4.1"] }),
    }),
    e,
  );
  assert.equal(applied.body.success, true, String(applied.body.message));
  const applyOp = operationEvent(await auditsFor(e, auth, applyRid));
  assert.equal(applyOp.action, "channel.upstream_apply");
  assert.equal(applyOp.success, true);
  assert.equal(applyOp.route, "/api/channel/upstream_updates/apply");
  assert.equal(applyOp.method, "POST");
  assert.equal(applyOp.content, `Applied upstream model changes to channel (ID: ${id})`);
  assert.deepEqual(applyOp.other.op?.params, { id });
  assert.equal(applyOp.other.audit_info, undefined);

  const applyAllRid = "manage-audit-channel-upstream-apply-all-1";
  const applyAll = await json(
    new Request("http://local/api/channel/upstream_updates/apply_all", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": applyAllRid },
      body: "{}",
    }),
    e,
  );
  assert.equal(applyAll.body.success, true, String(applyAll.body.message));
  const applyAllOp = operationEvent(await auditsFor(e, auth, applyAllRid));
  assert.equal(applyAllOp.action, "channel.upstream_apply_all");
  assert.equal(applyAllOp.route, "/api/channel/upstream_updates/apply_all");
  assert.equal(applyAllOp.content, "Applied upstream model changes to 1 channels");
  assert.deepEqual(applyAllOp.other.op?.params, { count: 1 });
  assert.equal(applyAllOp.other.audit_info, undefined);

  const detectRid = "manage-audit-channel-upstream-detect-all-1";
  const detectAll = await json(
    new Request("http://local/api/channel/upstream_updates/detect_all", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": detectRid },
      body: "{}",
    }),
    e,
  );
  assert.equal(detectAll.body.success, true, String(detectAll.body.message));
  const queued = detectAll.body.data as { task_id: string; status: string };
  assert.equal(typeof queued.task_id, "string");
  const detectOp = operationEvent(await auditsFor(e, auth, detectRid));
  assert.equal(detectOp.action, "channel.upstream_detect_all");
  assert.equal(detectOp.route, "/api/channel/upstream_updates/detect_all");
  assert.equal(detectOp.content, "channel.upstream_detect_all");
  assert.deepEqual(detectOp.other.op?.params, { task_id: queued.task_id });
  assert.equal(detectOp.other.audit_info, undefined);

  const conflictRid = "manage-audit-channel-upstream-detect-all-conflict-1";
  const conflict = await json(
    new Request("http://local/api/channel/upstream_updates/detect_all", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": conflictRid },
      body: "{}",
    }),
    e,
  );
  assert.equal(conflict.res.status, 409);
  const conflictOp = operationEvent(await auditsFor(e, auth, conflictRid));
  assert.equal(conflictOp.action, "generic");
  assert.equal(conflictOp.success, false);
  assert.equal(conflictOp.status, 409);
  assert.equal(conflictOp.route, "/api/channel/upstream_updates/detect_all");

  const failRid = "manage-audit-channel-upstream-apply-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/upstream_updates/apply", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ id: 0 }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "invalid channel id");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/channel/upstream_updates/apply");
});
