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
import { totpCode } from "../src/totp.js";
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

async function passwordProof(
  e: Env,
  auth: Record<string, string>,
  scope: string,
  extra: Record<string, unknown> = {},
) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12", ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function twoFAProof(
  e: Env,
  auth: Record<string, string>,
  scope: string,
  secret: string,
  extra: Record<string, unknown> = {},
) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope, code: await totpCode(secret), ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function enableTwoFA(e: Env, auth: Record<string, string>): Promise<{ secret: string; auth: Record<string, string> }> {
  const proof = await passwordProof(e, auth, "2fa.setup");
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  const started = setup.body.data as { secret: string; flow_token: string };
  const en = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ code: await totpCode(started.secret), flow_token: started.flow_token }),
    }),
    e,
  );
  assert.equal(en.body.success, true, String(en.body.message));
  const token = (en.body.data as { access_token: string }).access_token;
  return { secret: started.secret, auth: { authorization: "Bearer " + token, "content-type": "application/json" } };
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

test("original recordManageAudit English channel.update/delete/copy/key_view templates", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.update"], "Updated channel ${name} (ID: ${id})");
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.delete"], "Deleted channel ${name} (ID: ${id})");
  assert.equal(AUDIT_CONTENT_TEMPLATES["channel.key_view"], "Viewed channel key ${name} (ID: ${id})");
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["channel.copy"],
    "Copied channel (source ID: ${sourceId}) to ${name} (new ID: ${id})",
  );
  assert.equal(
    auditContentEN("channel.update", { name: "openai", id: 7 }),
    "Updated channel openai (ID: 7)",
  );
  assert.equal(
    auditContentEN("channel.delete", { name: "gone", id: 3 }),
    "Deleted channel gone (ID: 3)",
  );
  assert.equal(
    auditContentEN("channel.key_view", { name: "secret", id: 9 }),
    "Viewed channel key secret (ID: 9)",
  );
  assert.equal(
    auditContentEN("channel.copy", { sourceId: 1, name: "openai_复制", id: 2 }),
    "Copied channel (source ID: 1) to openai_复制 (new ID: 2)",
  );
  assert.equal(auditContentEN("channel.delete", { id: 0 }), "Deleted channel  (ID: 0)");
});

test("original recordManageAudit leftover channel.update JSON skips generic fallback", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, { name: "hop328-upd", type: 1, key: "sk-secret-key" });
  const rid = "manage-audit-channel-update-1";
  const updated = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-update-client",
        "cf-connecting-ip": "192.0.2.51",
      },
      body: JSON.stringify({
        id,
        name: "hop328-renamed",
        models: "gpt-4o-mini",
        group: "vip",
        type: 2,
        base_url: "https://example.com",
        key: "sk-rotated-key",
      }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  assert.equal(updated.body.message, "");
  const data = updated.body.data as { id: number; name: string; key?: string };
  assert.equal(data.id, id);
  assert.equal(data.name, "hop328-renamed");
  assert.equal(data.key, "");
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.update");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/");
  assert.equal(privileged.method, "PUT");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.51");
  assert.equal(privileged.user_agent, "channel-update-client");
  assert.equal(privileged.content, "Updated channel hop328-renamed (ID: " + id + ")");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, {
    action: "channel.update",
    params: {
      id,
      name: "hop328-renamed",
      changed_fields: ["models", "group", "type", "base_url", "key"],
    },
  });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("sk-secret-key"), false);
  assert.equal(JSON.stringify(privileged).includes("sk-rotated-key"), false);

  const selfView = operationEvent(await auditsFor(e, auth, rid, "/api/audit/self"));
  assert.equal(selfView.action, "channel.update");
  assert.equal(selfView.other.admin_info, undefined);
  assert.equal(selfView.other.audit_info, undefined);
  assert.deepEqual(selfView.other.op?.params?.changed_fields, ["models", "group", "type", "base_url", "key"]);
});

test("original recordManageAudit leftover channel.update name-only, plugin_default, status, and GET/unauth", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, { name: "hop328-name", type: 1, key: "sk-name" });
  const nameRid = "manage-audit-channel-name-1";
  const named = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": nameRid },
      body: JSON.stringify({ id, name: "hop328-only-name" }),
    }),
    e,
  );
  assert.equal(named.body.success, true, String(named.body.message));
  const nameOp = operationEvent(await auditsFor(e, auth, nameRid));
  assert.equal(nameOp.action, "channel.update");
  assert.equal(nameOp.content, "Updated channel hop328-only-name (ID: " + id + ")");
  assert.deepEqual(nameOp.other.op?.params, { id, name: "hop328-only-name", changed_fields: [] });
  assert.equal(nameOp.other.audit_info, undefined);

  const plugId = await addChannel(e, auth, {
    name: "hop328-plugin",
    type: CHANNEL_TYPE_TASK_PLUGIN,
    key: "sk-plugin",
    setting: { task_plugin_key: "demo" },
  });
  const plugRid = "manage-audit-channel-update-plugin-1";
  const plugin = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": plugRid },
      body: JSON.stringify({ id: plugId, type: CHANNEL_TYPE_TASK_PLUGIN, models: "gpt-4o-mini" }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, String(plugin.body.message));
  const plugOp = operationEvent(await auditsFor(e, auth, plugRid));
  assert.equal(plugOp.action, "channel.update");
  assert.equal(plugOp.other.op?.params?.base_url_source, "plugin_default");
  assert.equal(plugOp.other.op?.params?.name, "hop328-plugin");
  assert.deepEqual(plugOp.other.op?.params?.changed_fields, ["models"]);
  assert.equal(JSON.stringify(plugOp).includes("sk-plugin"), false);

  const omitTypeRid = "manage-audit-channel-update-omit-type-1";
  const omitType = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": omitTypeRid },
      body: JSON.stringify({ id: plugId, models: "gpt-4o" }),
    }),
    e,
  );
  assert.equal(omitType.body.success, true, String(omitType.body.message));
  const omitOp = operationEvent(await auditsFor(e, auth, omitTypeRid));
  assert.equal(omitOp.action, "channel.update");
  assert.equal(omitOp.other.op?.params?.base_url_source, undefined);
  assert.deepEqual(omitOp.other.op?.params?.changed_fields, ["models"]);

  const failRid = "manage-audit-channel-status-1";
  const failed = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ id, name: "blocked-status", status: 2 }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "Invalid parameters");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.deepEqual(failOp.other.op?.params, { method: "PUT", route: "/api/channel/" });

  const getRid = "manage-audit-channel-get-328";
  await json(new Request("http://local/api/channel/" + id, { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "manage-audit-channel-anon-update-1";
  await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
      body: JSON.stringify({ id, name: "anon" }),
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, anonRid)).length, 0);
});

test("original recordManageAudit leftover channel.delete JSON including missing id", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, { name: "hop328-del", type: 1, key: "sk-delete-me" });
  const rid = "manage-audit-channel-delete-1";
  const deleted = await json(
    new Request("http://local/api/channel/" + id, {
      method: "DELETE",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-delete-client",
        "cf-connecting-ip": "192.0.2.52",
      },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.equal(deleted.body.message, "");
  assert.equal(deleted.body.data, null);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.delete");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/:id");
  assert.equal(privileged.method, "DELETE");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.52");
  assert.equal(privileged.content, "Deleted channel hop328-del (ID: " + id + ")");
  assert.deepEqual(privileged.other.op, { action: "channel.delete", params: { id, name: "hop328-del" } });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("sk-delete-me"), false);

  const missRid = "manage-audit-channel-delete-missing-1";
  const missing = await json(
    new Request("http://local/api/channel/999999", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": missRid },
    }),
    e,
  );
  assert.equal(missing.body.success, true, String(missing.body.message));
  const missOp = operationEvent(await auditsFor(e, auth, missRid));
  assert.equal(missOp.action, "channel.delete");
  assert.equal(missOp.content, "Deleted channel  (ID: 999999)");
  assert.deepEqual(missOp.other.op?.params, { id: 999999, name: "" });

  const abcRid = "manage-audit-channel-delete-abc-1";
  const abc = await json(
    new Request("http://local/api/channel/abc", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": abcRid },
    }),
    e,
  );
  assert.equal(abc.body.success, true, String(abc.body.message));
  const abcOp = operationEvent(await auditsFor(e, auth, abcRid));
  assert.equal(abcOp.action, "channel.delete");
  assert.equal(abcOp.content, "Deleted channel  (ID: 0)");
  assert.deepEqual(abcOp.other.op?.params, { id: 0, name: "" });
});

test("original recordManageAudit leftover channel.copy JSON and failed generic fallback", async () => {
  const { e, auth } = await boot();
  const sourceId = await addChannel(e, auth, { name: "hop328-src", type: 1, key: "sk-copy-src" });
  const rid = "manage-audit-channel-copy-1";
  const copied = await json(
    new Request("http://local/api/channel/copy/" + sourceId + "?suffix=_bak", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-copy-client",
        "cf-connecting-ip": "192.0.2.53",
      },
    }),
    e,
  );
  assert.equal(copied.body.success, true, String(copied.body.message));
  const cloneId = Number((copied.body.data as { id: number }).id);
  assert.ok(cloneId > 0);
  assert.notEqual(cloneId, sourceId);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "channel.copy");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/copy/:id");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.53");
  assert.equal(
    privileged.content,
    "Copied channel (source ID: " + sourceId + ") to hop328-src_bak (new ID: " + cloneId + ")",
  );
  assert.deepEqual(privileged.other.op, {
    action: "channel.copy",
    params: { sourceId, id: cloneId, name: "hop328-src_bak" },
  });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("sk-copy-src"), false);

  const failRid = "manage-audit-channel-copy-fail-1";
  const failed = await json(
    new Request("http://local/api/channel/copy/abc", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "invalid id");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/channel/copy/:id");
  assert.deepEqual(failOp.other.op?.params, { method: "POST", route: "/api/channel/copy/:id" });
});

test("original recordManageAudit leftover channel.key_view JSON, invalid-id Extra-OK, and PAT", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, { name: "hop328-key", type: 1, key: "sk-view-secret" });
  const invalidKey = await json(
    new Request("http://local/api/channel/abc/key", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(invalidKey.res.status, 400);
  assert.equal(invalidKey.body.code, "SECURITY_CONTEXT_INVALID");
  assert.equal(invalidKey.body.message, "The action details are invalid.");

  const invalidRid = "manage-audit-channel-key-invalid-1";
  await json(
    new Request("http://local/api/channel/abc/key", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": invalidRid },
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, invalidRid)).length, 0);

  const patProof = await passwordProof(e, auth, "access_token.generate");
  const issued = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": patProof.proof_token },
    }),
    e,
  );
  const pat = String(issued.body.data || "");
  assert.ok(pat);
  const patRid = "manage-audit-pat-channel-update-1";
  const patUpdate = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.82",
      },
      body: JSON.stringify({ id, name: "pat-renamed" }),
    }),
    e,
  );
  assert.equal(patUpdate.body.success, true, String(patUpdate.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "channel.update");
  assert.equal(patOp.content, "Updated channel pat-renamed (ID: " + id + ")");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);

  const enabled = await enableTwoFA(e, auth);
  const proof = await twoFAProof(e, enabled.auth, "channel.key.read", enabled.secret, {
    context: { channel_id: id },
  });
  const rid = "manage-audit-channel-key-view-1";
  const viewed = await json(
    new Request("http://local/api/channel/" + id + "/key", {
      method: "POST",
      headers: {
        ...enabled.auth,
        "X-Security-Proof": proof.proof_token,
        "x-oneapi-request-id": rid,
        "user-agent": "channel-key-client",
        "cf-connecting-ip": "192.0.2.54",
      },
    }),
    e,
  );
  assert.equal(viewed.body.success, true, String(viewed.body.message));
  assert.equal(viewed.body.message, "获取成功");
  assert.deepEqual(viewed.body.data, { key: "sk-view-secret" });
  const privileged = operationEvent(await auditsFor(e, enabled.auth, rid));
  assert.equal(privileged.action, "channel.key_view");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/channel/:id/key");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.54");
  assert.equal(privileged.content, "Viewed channel key pat-renamed (ID: " + id + ")");
  assert.deepEqual(privileged.other.op, { action: "channel.key_view", params: { id, name: "pat-renamed" } });
  assert.equal(privileged.other.audit_info, undefined);
  assert.equal(JSON.stringify(privileged).includes("sk-view-secret"), false);

  const missProof = await twoFAProof(e, enabled.auth, "channel.key.read", enabled.secret, {
    context: { channel_id: 999999 },
  });
  const missRid = "manage-audit-channel-key-missing-1";
  const missing = await json(
    new Request("http://local/api/channel/999999/key", {
      method: "POST",
      headers: {
        ...enabled.auth,
        "X-Security-Proof": missProof.proof_token,
        "x-oneapi-request-id": missRid,
        "cf-connecting-ip": "192.0.2.55",
      },
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  const missOp = operationEvent(await auditsFor(e, enabled.auth, missRid));
  assert.equal(missOp.action, "generic");
  assert.equal(missOp.success, false);
  assert.equal(missOp.route, "/api/channel/:id/key");
});
