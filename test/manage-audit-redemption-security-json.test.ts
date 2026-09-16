import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import { Store } from "../src/store.js";
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
  await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: true }),
    }),
    e,
  );
  return { e, auth, token, store: new Store(e.DB) };
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

async function createMember(e: Env, auth: Record<string, string>, username: string): Promise<number> {
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username, password: "password12", role: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const users = await json(new Request("http://local/api/user/", { headers: auth }), e);
  const member = (users.body.data as { items: { id: number; username: string }[] }).items.find((u) => u.username === username);
  assert.ok(member);
  return member.id;
}

async function createPlan(e: Env, auth: Record<string, string>): Promise<number> {
  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: {
          title: "reset-json",
          total_amount: 1000,
          duration_unit: "day",
          duration_value: 30,
          price_amount: 0,
          quota_reset_period: "daily",
        },
      }),
    }),
    e,
  );
  const id = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(id, String(plan.body.message));
  return id;
}

test("original recordManageAudit English redemption/2fa/passkey/subscription templates", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["redemption.delete_batch"], "Batch deleted ${count} redemption codes");
  assert.equal(auditContentEN("redemption.delete_batch", { count: 2 }), "Batch deleted 2 redemption codes");
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["user.2fa_disable"],
    "Force-disabled two-factor authentication for the user",
  );
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.reset_passkey"], "Reset the user passkey");
  assert.equal(AUDIT_CONTENT_TEMPLATES["subscription.plan_reset"], "Reset active subscriptions for plan ${plan_id}");
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["subscription.user_plan_reset"],
    "Reset active plan ${plan_id} subscriptions for user ${target_user_id}",
  );
  assert.equal(auditContentEN("subscription.plan_reset", { plan_id: 9, plan_title: "hidden" }), "Reset active subscriptions for plan 9");
});

test("original recordManageAudit leftover redemption.delete_batch JSON and PAT", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "hop332", quota: 10, count: 2 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const ids = ((listed.body.data as { items: { id: number }[] }).items || []).map((row) => row.id);
  assert.equal(ids.length >= 2, true);
  const requested = [ids[0], ids[1], 999999];

  const rid = "manage-audit-redemption-delete-batch-1";
  const deleted = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "redemption-batch-client",
        "cf-connecting-ip": "192.0.2.91",
      },
      body: JSON.stringify({ ids: requested }),
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.equal(deleted.body.data, 2);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "redemption.delete_batch");
  assert.equal(privileged.category, AUDIT_CATEGORY_OPERATION);
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/redemption/batch");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.91");
  assert.equal(privileged.user_agent, "redemption-batch-client");
  assert.equal(privileged.content, "Batch deleted 2 redemption codes");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, {
    action: "redemption.delete_batch",
    params: { count: 2, total: 3, requested_redemption_ids: requested },
  });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-redemption-delete-batch-fail-1";
  const failed = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ ids: [] }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "Invalid parameters");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "redemption.delete_batch");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/redemption/batch");
  assert.equal(failOp.content, "POST /api/redemption/batch");
  assert.ok(failOp.other.audit_info);

  const getRid = "manage-audit-redemption-get-1";
  await json(new Request("http://local/api/redemption/", { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const anonRid = "manage-audit-redemption-anon-1";
  await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-oneapi-request-id": anonRid },
      body: JSON.stringify({ ids: [1] }),
    }),
    e,
  );
  assert.equal((await auditsFor(e, auth, anonRid)).length, 0);

  const extra = await json(
    new Request("http://local/api/redemption/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "hop332p", quota: 10, count: 1 }),
    }),
    e,
  );
  assert.equal(extra.body.success, true, String(extra.body.message));
  const extraListed = await json(new Request("http://local/api/redemption/", { headers: auth }), e);
  const extraId = Number(((extraListed.body.data as { items: { id: number }[] }).items || [])[0]?.id);
  assert.ok(extraId);

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
  const patRid = "manage-audit-pat-redemption-delete-batch-1";
  const patDelete = await json(
    new Request("http://local/api/redemption/batch", {
      method: "POST",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.92",
      },
      body: JSON.stringify({ ids: [extraId] }),
    }),
    e,
  );
  assert.equal(patDelete.body.success, true, String(patDelete.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "redemption.delete_batch");
  assert.equal(patOp.content, "Batch deleted 1 redemption codes");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
});

test("original recordManageAudit leftover user.2fa_disable JSON", async () => {
  const { e, auth, store } = await boot();
  const memberId = await createMember(e, auth, "hop332-2fa");
  await store.updateUser(memberId, { totp_enabled: 1, totp_secret: "JBSWY3DPEHPK3PXP" });

  const rid = "manage-audit-user-2fa-disable-1";
  const disabled = await json(
    new Request("http://local/api/user/" + memberId + "/2fa", {
      method: "DELETE",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "2fa-disable-client",
        "cf-connecting-ip": "192.0.2.93",
      },
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  assert.equal(disabled.body.message, "用户2FA已被强制禁用");
  assert.equal("data" in disabled.body, false);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "user.2fa_disable");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/user/:id/2fa");
  assert.equal(privileged.method, "DELETE");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.ip, "192.0.2.93");
  assert.equal(privileged.content, "Force-disabled two-factor authentication for the user");
  assert.deepEqual(privileged.other.op, { action: "user.2fa_disable", params: { target_user_id: memberId } });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-user-2fa-disable-fail-1";
  const failed = await json(
    new Request("http://local/api/user/invalid/2fa", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": failRid },
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "用户ID格式错误");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/user/:id/2fa");
  assert.equal(failOp.content, "DELETE /api/user/:id/2fa");
});

test("original recordManageAudit leftover user.reset_passkey JSON", async () => {
  const { e, auth, store } = await boot();
  const memberId = await createMember(e, auth, "hop332-pk");
  await store.insertPasskey(memberId, "cred-hop332", "pubkey", "device", "example.com");

  const rid = "manage-audit-user-reset-passkey-1";
  const reset = await json(
    new Request("http://local/api/user/" + memberId + "/reset_passkey", {
      method: "DELETE",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "reset-passkey-client",
        "cf-connecting-ip": "192.0.2.94",
      },
    }),
    e,
  );
  assert.equal(reset.body.success, true, String(reset.body.message));
  assert.equal(reset.body.message, "Passkey 已重置");
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "user.reset_passkey");
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/user/:id/reset_passkey");
  assert.equal(privileged.method, "DELETE");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.ip, "192.0.2.94");
  assert.equal(privileged.content, "Reset the user passkey");
  assert.deepEqual(privileged.other.op?.params, {
    username: "hop332-pk",
    id: memberId,
    target_user_id: memberId,
  });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-user-reset-passkey-fail-1";
  const failed = await json(
    new Request("http://local/api/user/invalid/reset_passkey", {
      method: "DELETE",
      headers: { ...auth, "x-oneapi-request-id": failRid },
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "无效的用户 ID");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "user.reset_passkey");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/user/:id/reset_passkey");
  assert.equal(failOp.content, "DELETE /api/user/:id/reset_passkey");
  assert.ok(failOp.other.audit_info);
});

test("original recordManageAudit leftover subscription.plan_reset/user_plan_reset JSON", async () => {
  const { e, auth } = await boot();
  const planId = await createPlan(e, auth);
  const emptyRid = "manage-audit-subscription-plan-reset-empty-1";
  const empty = await json(
    new Request("http://local/api/subscription/admin/plans/" + planId + "/subscriptions/reset", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": emptyRid, "cf-connecting-ip": "192.0.2.95" },
      body: JSON.stringify({ advance_reset_time: false }),
    }),
    e,
  );
  assert.equal(empty.body.success, true, String(empty.body.message));
  assert.deepEqual(empty.body.data, {
    plan_id: planId,
    matched_count: 0,
    reset_count: 0,
    user_count: 0,
    advance_reset_time: false,
  });
  assert.equal("plan_title" in (empty.body.data as object), false);
  const emptyOp = operationEvent(await auditsFor(e, auth, emptyRid));
  assert.equal(emptyOp.action, "subscription.plan_reset");
  assert.equal(emptyOp.success, true);
  assert.equal(emptyOp.route, "/api/subscription/admin/plans/:id/subscriptions/reset");
  assert.equal(emptyOp.content, "Reset active subscriptions for plan " + planId);
  assert.deepEqual(emptyOp.other.op?.params, {
    plan_id: planId,
    plan_title: "reset-json",
    reset_count: 0,
    user_count: 0,
    advance_reset_time: false,
  });
  assert.equal(emptyOp.other.audit_info, undefined);

  await json(
    new Request("http://local/api/subscription/admin/users/1/subscriptions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );

  const rid = "manage-audit-subscription-plan-reset-1";
  const reset = await json(
    new Request("http://local/api/subscription/admin/plans/" + planId + "/subscriptions/reset", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "plan-reset-client",
        "cf-connecting-ip": "192.0.2.96",
      },
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(reset.body.success, true, String(reset.body.message));
  assert.equal((reset.body.data as { reset_count: number }).reset_count, 1);
  assert.equal("plan_title" in (reset.body.data as object), false);
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "subscription.plan_reset");
  assert.equal(privileged.method, "POST");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.ip, "192.0.2.96");
  assert.equal(privileged.content, "Reset active subscriptions for plan " + planId);
  assert.deepEqual(privileged.other.op?.params, {
    plan_id: planId,
    plan_title: "reset-json",
    reset_count: 1,
    user_count: 1,
    advance_reset_time: true,
  });

  const userRid = "manage-audit-subscription-user-plan-reset-1";
  const userReset = await json(
    new Request("http://local/api/subscription/admin/users/1/subscriptions/reset", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": userRid, "cf-connecting-ip": "192.0.2.97" },
      body: JSON.stringify({ plan_id: planId, advance_reset_time: false }),
    }),
    e,
  );
  assert.equal(userReset.body.success, true, String(userReset.body.message));
  assert.equal("plan_title" in (userReset.body.data as object), false);
  const userOp = operationEvent(await auditsFor(e, auth, userRid));
  assert.equal(userOp.action, "subscription.user_plan_reset");
  assert.equal(userOp.success, true);
  assert.equal(userOp.route, "/api/subscription/admin/users/:id/subscriptions/reset");
  assert.equal(userOp.content, "Reset active plan " + planId + " subscriptions for user 1");
  assert.deepEqual(userOp.other.op?.params, {
    target_user_id: 1,
    plan_id: planId,
    plan_title: "reset-json",
    reset_count: 1,
    user_count: 1,
    advance_reset_time: false,
  });
  assert.equal(userOp.other.audit_info, undefined);

  const failRid = "manage-audit-subscription-plan-reset-fail-1";
  const failed = await json(
    new Request("http://local/api/subscription/admin/plans/" + planId + "/subscriptions/reset", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: "",
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "参数错误");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/subscription/admin/plans/:id/subscriptions/reset");

  const missingRid = "manage-audit-subscription-user-plan-reset-missing-1";
  const missing = await json(
    new Request("http://local/api/subscription/admin/users/999/subscriptions/reset", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": missingRid },
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "该用户没有有效的此套餐订阅");
  const missingOp = operationEvent(await auditsFor(e, auth, missingRid));
  assert.equal(missingOp.action, "generic");
  assert.equal(missingOp.success, false);
  assert.equal(missingOp.route, "/api/subscription/admin/users/:id/subscriptions/reset");
});
