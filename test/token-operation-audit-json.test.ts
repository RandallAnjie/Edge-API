import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT, ROLE_USER, TOKEN_DISABLED, TOKEN_ENABLED } from "../src/constants.js";
import {
  AUDIT_CATEGORY_SECURITY,
  TOKEN_OPERATION_AUDIT_MAX_BODY,
  auditActorRole,
  auditResponseSuccess,
  matchTokenOperationAudit,
  tokenBatchAuditFields,
  tokenOperationAuditApplies,
  tokenUpdateChangedFields,
  truncateAuditUserAgent,
} from "../src/token-operation-audit.js";
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
  token_ref: string;
  content: string;
  auth_method: string;
  other: { op?: AuditOp; admin_info?: unknown };
};

async function auditsFor(e: Env, auth: Record<string, string>, requestId: string): Promise<AuditItem[]> {
  const listed = await json(
    new Request("http://local/api/audit/self?page_size=100&request_id=" + encodeURIComponent(requestId), { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  return ((listed.body.data as { items: AuditItem[] }).items || []) as AuditItem[];
}

function securityEvent(events: AuditItem[]): AuditItem {
  const op = events.find((row) => row.category === AUDIT_CATEGORY_SECURITY);
  assert.ok(op, "missing security audit");
  return op!;
}

async function createOwned(e: Env, auth: Record<string, string>, name = "owned") {
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.40" },
      body: JSON.stringify({
        name,
        expired_time: -1,
        remain_quota: 100,
        unlimited_quota: true,
        group: "auto",
        auto_groups: ["default"],
        cross_group_retry: true,
        allow_ips: "",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return created.body.data as { id: number; key: string };
}

test("original TokenOperationAudit FullPath actions, success parse, and batch metadata", () => {
  assert.equal(TOKEN_OPERATION_AUDIT_MAX_BODY, 64 * 1024);
  assert.equal(AUDIT_CATEGORY_SECURITY, "security");
  assert.deepEqual(matchTokenOperationAudit("POST", "/api/token/"), {
    action: "token.create",
    content: "API token creation",
    route: "/api/token/",
  });
  assert.deepEqual(matchTokenOperationAudit("PUT", "/api/token", "true"), {
    action: "token.status_update",
    content: "API token status update",
    route: "/api/token/",
  });
  assert.equal(matchTokenOperationAudit("PUT", "/api/token/", "")?.action, "token.update");
  assert.deepEqual(matchTokenOperationAudit("DELETE", "/api/token/12"), {
    action: "token.delete",
    content: "API token deletion",
    route: "/api/token/:id",
    idFromPath: 12,
  });
  assert.equal(matchTokenOperationAudit("POST", "/api/token/7/key")?.action, "token.key_view");
  assert.equal(matchTokenOperationAudit("POST", "/api/token/batch")?.action, "token.delete_batch");
  assert.equal(matchTokenOperationAudit("POST", "/api/token/batch/keys")?.action, "token.key_view_batch");
  assert.equal(tokenOperationAuditApplies("GET", "/api/token/"), false);
  assert.equal(tokenOperationAuditApplies("POST", "/api/token/search"), false);
  assert.equal(auditResponseSuccess(429, ""), false);
  assert.equal(auditResponseSuccess(200, '{"success":false,"message":"x"}'), false);
  assert.equal(auditResponseSuccess(200, '{"success":true}'), true);
  assert.equal(auditActorRole(ROLE_ROOT), ROLE_ROOT);
  assert.equal(auditActorRole(ROLE_USER), ROLE_USER);
  assert.equal(auditActorRole(7), 0);
  assert.equal(truncateAuditUserAgent("é".repeat(513)).length, 512);
  const bounded = tokenBatchAuditFields(Array.from({ length: 101 }, (_, i) => 10000 + i));
  assert.equal(bounded.total, 101);
  assert.equal((bounded.requested_ids as number[]).length, 100);
  assert.equal(bounded.requested_ids_truncated, true);
  assert.deepEqual(
    tokenUpdateChangedFields(
      {
        name: "owned",
        expired_time: -1,
        remain_quota: 100,
        unlimited_quota: 1,
        model_limits_enabled: 0,
        model_limits: "",
        allow_ips: "",
        group: "auto",
        cross_group_retry: 1,
        auto_groups: '["default"]',
      },
      {
        name: "renamed",
        expired_time: -1,
        remain_quota: 200,
        unlimited_quota: 1,
        model_limits_enabled: 0,
        model_limits: "",
        allow_ips: "",
        group: "default",
        cross_group_retry: 0,
        auto_groups: "",
      },
    ),
    ["name", "remain_quota", "group", "cross_group_retry", "auto_groups"],
  );
});

test("original TokenOperationAudit leftover security JSON on create/update/delete/key", async () => {
  const { e, auth } = await boot();
  const rid = "token-audit-create-1";
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "api-token-audit-client",
        "cf-connecting-ip": "192.0.2.12",
      },
      body: JSON.stringify({ name: "created", expired_time: -1, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const createdId = (created.body.data as { id: number }).id;
  const createdEvents = await auditsFor(e, auth, rid);
  const createdOp = securityEvent(createdEvents);
  assert.equal(createdOp.action, "token.create");
  assert.equal(createdOp.success, true);
  assert.equal(createdOp.status, 200);
  assert.equal(createdOp.route, "/api/token/");
  assert.equal(createdOp.method, "POST");
  assert.equal(createdOp.auth_method, "session");
  assert.equal(createdOp.token_ref, "");
  assert.equal(createdOp.ip, "192.0.2.12");
  assert.equal(createdOp.user_agent, "api-token-audit-client");
  assert.equal(createdOp.content, "API token creation");
  assert.equal(createdOp.actor_role, ROLE_ROOT);
  assert.equal(createdOp.other.admin_info, undefined);
  assert.deepEqual(createdOp.other.op, { action: "token.create", params: { id: createdId, name: "created" } });
  assert.equal(JSON.stringify(createdEvents).includes(String((created.body.data as { key: string }).key)), false);

  const owned = await createOwned(e, auth);
  const updRid = "token-audit-update-1";
  const updated = await json(
    new Request("http://local/api/token/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": updRid, "cf-connecting-ip": "192.0.2.12" },
      body: JSON.stringify({
        id: owned.id,
        name: "renamed",
        expired_time: -1,
        remain_quota: 200,
        unlimited_quota: true,
        group: "default",
        cross_group_retry: true,
        allow_ips: "",
      }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  const upd = securityEvent(await auditsFor(e, auth, updRid));
  assert.equal(upd.action, "token.update");
  assert.equal(upd.success, true);
  assert.deepEqual(upd.other.op?.params, {
    id: owned.id,
    name: "renamed",
    changed_fields: ["name", "remain_quota", "group", "cross_group_retry", "auto_groups"],
  });

  const keyRid = "token-audit-key-1";
  const keyView = await json(
    new Request("http://local/api/token/" + owned.id + "/key", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": keyRid, "cf-connecting-ip": "192.0.2.12" },
    }),
    e,
  );
  assert.equal(keyView.body.success, true, String(keyView.body.message));
  assert.ok(String((keyView.body.data as { key: string }).key).length > 0);
  const keyOp = securityEvent(await auditsFor(e, auth, keyRid));
  assert.equal(keyOp.action, "token.key_view");
  assert.equal(keyOp.route, "/api/token/:id/key");
  assert.deepEqual(keyOp.other.op?.params, { id: owned.id, name: "renamed" });
  assert.equal(JSON.stringify(keyOp).includes(String((keyView.body.data as { key: string }).key)), false);

  const delRid = "token-audit-delete-1";
  const deleted = await json(
    new Request("http://local/api/token/" + owned.id, {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": delRid, "cf-connecting-ip": "192.0.2.12" },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const del = securityEvent(await auditsFor(e, auth, delRid));
  assert.equal(del.action, "token.delete");
  assert.equal(del.route, "/api/token/:id");
  assert.deepEqual(del.other.op?.params, { id: owned.id, name: "renamed" });
});

test("original TokenOperationAudit leftover failure params omit secrets", async () => {
  const { e, auth } = await boot();
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "other-owner", password: "password12" }),
    }),
    e,
  );
  const otherLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "other-owner", password: "password12" }),
    }),
    e,
  );
  const otherAuth = {
    authorization: "Bearer " + (otherLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const foreign = await createOwned(e, otherAuth, "private-foreign-name");

  const negRid = "token-audit-neg-1";
  const negative = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": negRid },
      body: JSON.stringify({ name: "attempt", remain_quota: -1 }),
    }),
    e,
  );
  assert.equal(negative.body.success, false);
  const neg = securityEvent(await auditsFor(e, auth, negRid));
  assert.equal(neg.action, "token.create");
  assert.equal(neg.success, false);
  assert.equal(neg.status, 200);
  assert.deepEqual(neg.other.op?.params, { name: "attempt" });

  const badRid = "token-audit-malformed-1";
  const malformed = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": badRid },
      body: '{"key":"raw-body-secret"',
    }),
    e,
  );
  assert.equal(malformed.body.success, false);
  assert.equal(malformed.res.status, 200);
  const bad = securityEvent(await auditsFor(e, auth, badRid));
  assert.equal(bad.action, "token.create");
  assert.equal(bad.success, false);
  assert.equal(bad.other.op?.params, undefined);
  assert.equal(JSON.stringify(bad).includes("raw-body-secret"), false);

  const owned = await createOwned(e, auth);
  const foreignRid = "token-audit-foreign-1";
  const forged = await json(
    new Request("http://local/api/token/", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": foreignRid },
      body: JSON.stringify({ id: foreign.id, name: "forged-name", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(forged.body.success, false);
  const foreignOp = securityEvent(await auditsFor(e, auth, foreignRid));
  assert.equal(foreignOp.action, "token.update");
  assert.deepEqual(foreignOp.other.op?.params, { id: foreign.id });
  assert.equal(JSON.stringify(foreignOp).includes("private-foreign-name"), false);
  assert.equal(JSON.stringify(foreignOp).includes(foreign.key), false);

  const emptyRid = "token-audit-empty-batch-1";
  const empty = await json(
    new Request("http://local/api/token/batch", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": emptyRid },
      body: JSON.stringify({ ids: [] }),
    }),
    e,
  );
  assert.equal(empty.body.success, false);
  const emptyOp = securityEvent(await auditsFor(e, auth, emptyRid));
  assert.equal(emptyOp.action, "token.delete_batch");
  assert.equal(emptyOp.success, false);
  assert.deepEqual(emptyOp.other.op?.params, { requested_ids: [], total: 0 });

  const batchRid = "token-audit-batch-1";
  const batch = await json(
    new Request("http://local/api/token/batch", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": batchRid },
      body: JSON.stringify({ ids: [owned.id, owned.id, foreign.id, 999999] }),
    }),
    e,
  );
  assert.equal(batch.body.success, true, String(batch.body.message));
  const batchOp = securityEvent(await auditsFor(e, auth, batchRid));
  assert.equal(batchOp.action, "token.delete_batch");
  assert.equal(batchOp.success, true);
  assert.deepEqual(batchOp.other.op?.params, {
    requested_ids: [owned.id, owned.id, foreign.id, 999999],
    total: 4,
    count: 1,
  });

  const keysOwned = await createOwned(e, auth, "keys-owned");
  const keysRid = "token-audit-batch-keys-1";
  const keys = await json(
    new Request("http://local/api/token/batch/keys", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": keysRid },
      body: JSON.stringify({ ids: [keysOwned.id, keysOwned.id, foreign.id, 999999] }),
    }),
    e,
  );
  assert.equal(keys.body.success, true, String(keys.body.message));
  const keysOp = securityEvent(await auditsFor(e, auth, keysRid));
  assert.equal(keysOp.action, "token.key_view_batch");
  assert.equal(keysOp.route, "/api/token/batch/keys");
  assert.deepEqual(keysOp.other.op?.params, {
    requested_ids: [keysOwned.id, keysOwned.id, foreign.id, 999999],
    total: 4,
    count: 1,
    returned_ids: [keysOwned.id],
  });
  assert.equal(JSON.stringify(keysOp).includes(keysOwned.key), false);
});

test("original TokenOperationAudit skips reads/unauth and records PAT, status, CT 429", async () => {
  const { e, auth, token } = await boot();
  const owned = await createOwned(e, auth);
  for (const [method, path, credential, body] of [
    ["GET", "/api/token/", token, undefined],
    ["GET", "/api/token/search?keyword=private-search", token, undefined],
    ["GET", "/api/token/999999", token, undefined],
    ["POST", "/api/token/", "", '{"name":"anon","unlimited_quota":true}'],
  ] as const) {
    const rid = "token-audit-skip-" + method + path;
    const headers: Record<string, string> = { "content-type": "application/json", "x-oneapi-request-id": rid };
    if (credential) headers.authorization = "Bearer " + credential;
    await json(new Request("http://local" + path, { method, headers, body }), e);
    assert.equal((await auditsFor(e, auth, rid)).length, 0, path);
  }

  const statusRid = "token-audit-status-1";
  const disabled = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": statusRid },
      body: JSON.stringify({ id: owned.id, status: TOKEN_DISABLED }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  const statusOp = securityEvent(await auditsFor(e, auth, statusRid));
  assert.equal(statusOp.action, "token.status_update");
  assert.deepEqual(statusOp.other.op?.params, {
    id: owned.id,
    name: "owned",
    from: TOKEN_ENABLED,
    to: TOKEN_DISABLED,
  });

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
  await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: owned.id, status: TOKEN_ENABLED }),
    }),
    e,
  );
  const patRid = "token-audit-pat-key-1";
  const patKey = await json(
    new Request("http://local/api/token/" + owned.id + "/key", {
      method: "POST",
      headers: {
        authorization: "Bearer " + pat,
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.80",
      },
    }),
    e,
  );
  assert.equal(patKey.body.success, true, String(patKey.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = securityEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "token.key_view");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);

  const ctIp = "192.0.2.90";
  const ctHeaders = { ...auth, "cf-connecting-ip": ctIp };
  for (let i = 0; i < 20; i++) {
    const hit = await json(
      new Request("http://local/api/token/" + owned.id + "/key", { method: "POST", headers: ctHeaders }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
  }
  const ctRid = "token-audit-ct-429";
  const limited = await json(
    new Request("http://local/api/token/" + owned.id + "/key", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": ctRid, "cf-connecting-ip": ctIp },
    }),
    e,
  );
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  const ctOp = securityEvent(await auditsFor(e, auth, ctRid));
  assert.equal(ctOp.action, "token.key_view");
  assert.equal(ctOp.success, false);
  assert.equal(ctOp.status, 429);
  assert.deepEqual(ctOp.other.op?.params, { id: owned.id });

  const boundIds = Array.from({ length: 101 }, (_, i) => 10000 + i);
  const boundRid = "token-audit-bound-1";
  const bound = await json(
    new Request("http://local/api/token/batch", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": boundRid },
      body: JSON.stringify({ ids: boundIds }),
    }),
    e,
  );
  assert.equal(bound.body.success, true, String(bound.body.message));
  const boundOp = securityEvent(await auditsFor(e, auth, boundRid));
  assert.equal((boundOp.other.op?.params?.requested_ids as number[]).length, 100);
  assert.equal(boundOp.other.op?.params?.requested_ids_truncated, true);
  assert.equal(boundOp.other.op?.params?.total, 101);
  assert.equal(boundOp.other.op?.params?.count, 0);
  assert.equal(boundOp.success, true);
});
