import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import { totpCode } from "../src/totp.js";
import {
  AUDIT_CATEGORY_SECURITY,
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

async function passwordProof(e: Env, auth: Record<string, string>, scope: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function twoFAProof(e: Env, auth: Record<string, string>, scope: string, secret: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope, code: await totpCode(secret) }),
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
    admin_info?: unknown;
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

function securityEvent(events: AuditItem[], action: string): AuditItem {
  const row = events.find((item) => item.category === AUDIT_CATEGORY_SECURITY && item.action === action);
  assert.ok(row, "missing security audit " + action);
  return row!;
}

function assertNilParamSecurity(row: AuditItem, action: string, method: string, route: string, content: string) {
  assert.equal(row.category, AUDIT_CATEGORY_SECURITY);
  assert.equal(row.action, action);
  assert.equal(row.success, true);
  assert.equal(row.status, 200);
  assert.equal(row.method, method);
  assert.equal(row.route, route);
  assert.equal(row.auth_method, "session");
  assert.equal(row.token_ref, "");
  assert.equal(row.actor_role, ROLE_ROOT);
  assert.equal(row.username, "root");
  assert.equal(row.content, content);
  assert.deepEqual(row.other.op, { action });
  assert.equal(row.other.admin_info, undefined);
  assert.equal(row.other.audit_info, undefined);
}

test("original recordUserSecurityAudit English 2FA/passkey self templates", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.2fa_setup"], "Started two-factor authentication setup");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.2fa_enable"], "Enabled two-factor authentication");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.2fa_disable_self"], "Disabled two-factor authentication");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.2fa_backup_codes"], "Regenerated two-factor backup codes");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.passkey_register"], "Registered a passkey");
  assert.equal(AUDIT_CONTENT_TEMPLATES["user.passkey_delete"], "Deleted a passkey");
  assert.equal(auditContentEN("user.2fa_setup", {}), "Started two-factor authentication setup");
  assert.equal(auditContentEN("user.passkey_delete", {}), "Deleted a passkey");
});

test("original recordUserSecurityAudit leftover 2FA self JSON", async () => {
  const { e, auth } = await boot();

  const failSetupRid = "twofa-security-audit-setup-fail-1";
  const emptyEnable = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failSetupRid },
    }),
    e,
  );
  assert.equal(emptyEnable.body.success, false);
  assert.equal((await auditsFor(e, auth, failSetupRid)).length, 0);

  const setupProof = await passwordProof(e, auth, "2fa.setup");
  const setupRid = "twofa-security-audit-setup-1";
  const setup = await json(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: {
        ...auth,
        "X-Security-Proof": setupProof.proof_token,
        "x-oneapi-request-id": setupRid,
        "user-agent": "twofa-setup-client",
        "cf-connecting-ip": "192.0.2.140",
      },
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
  const started = setup.body.data as { secret: string; flow_token: string };
  const setupEvents = await auditsFor(e, auth, setupRid);
  assert.equal(setupEvents.length, 1);
  const setupSec = securityEvent(setupEvents, "user.2fa_setup");
  assertNilParamSecurity(
    setupSec,
    "user.2fa_setup",
    "POST",
    "/api/user/2fa/setup",
    "Started two-factor authentication setup",
  );
  assert.equal(setupSec.ip, "192.0.2.140");
  assert.equal(setupSec.user_agent, "twofa-setup-client");

  const enableRid = "twofa-security-audit-enable-1";
  const enabled = await json(
    new Request("http://local/api/user/2fa/enable", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": enableRid,
        "user-agent": "twofa-enable-client",
        "cf-connecting-ip": "192.0.2.141",
      },
      body: JSON.stringify({ code: await totpCode(started.secret), flow_token: started.flow_token }),
    }),
    e,
  );
  assert.equal(enabled.body.success, true, String(enabled.body.message));
  const nextAuth = {
    authorization: "Bearer " + (enabled.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const enableSec = securityEvent(await auditsFor(e, nextAuth, enableRid), "user.2fa_enable");
  assertNilParamSecurity(enableSec, "user.2fa_enable", "POST", "/api/user/2fa/enable", "Enabled two-factor authentication");
  assert.equal(enableSec.ip, "192.0.2.141");

  const backupProof = await twoFAProof(e, nextAuth, "2fa.backup_codes.regenerate", started.secret);
  const backupRid = "twofa-security-audit-backup-1";
  const backup = await json(
    new Request("http://local/api/user/2fa/backup_codes", {
      method: "POST",
      headers: {
        ...nextAuth,
        "X-Security-Proof": backupProof.proof_token,
        "x-oneapi-request-id": backupRid,
        "cf-connecting-ip": "192.0.2.142",
      },
    }),
    e,
  );
  assert.equal(backup.body.success, true, String(backup.body.message));
  const backupAuth = {
    authorization: "Bearer " + (backup.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const backupSec = securityEvent(await auditsFor(e, backupAuth, backupRid), "user.2fa_backup_codes");
  assertNilParamSecurity(
    backupSec,
    "user.2fa_backup_codes",
    "POST",
    "/api/user/2fa/backup_codes",
    "Regenerated two-factor backup codes",
  );

  const disableProof = await twoFAProof(e, backupAuth, "2fa.disable", started.secret);
  const disableRid = "twofa-security-audit-disable-1";
  const disabled = await json(
    new Request("http://local/api/user/2fa/disable", {
      method: "POST",
      headers: {
        ...backupAuth,
        "X-Security-Proof": disableProof.proof_token,
        "x-oneapi-request-id": disableRid,
        "cf-connecting-ip": "192.0.2.143",
      },
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  const disableAuth = {
    authorization: "Bearer " + (disabled.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const disableSec = securityEvent(await auditsFor(e, disableAuth, disableRid), "user.2fa_disable_self");
  assertNilParamSecurity(
    disableSec,
    "user.2fa_disable_self",
    "POST",
    "/api/user/2fa/disable",
    "Disabled two-factor authentication",
  );

  const notEnabledRid = "twofa-security-audit-disable-fail-1";
  const notEnabledProof = await passwordProof(e, disableAuth, "2fa.disable");
  const notEnabled = await json(
    new Request("http://local/api/user/2fa/disable", {
      method: "POST",
      headers: {
        ...disableAuth,
        "X-Security-Proof": notEnabledProof.proof_token,
        "x-oneapi-request-id": notEnabledRid,
      },
    }),
    e,
  );
  assert.equal(notEnabled.body.success, false);
  assert.equal(
    (await auditsFor(e, disableAuth, notEnabledRid)).some((row) => row.action === "user.2fa_disable_self"),
    false,
  );
});

test("original recordUserSecurityAudit leftover passkey register/delete JSON", async () => {
  const { e, auth } = await boot();
  const missingRid = "passkey-security-audit-delete-missing-1";
  const missingProof = await passwordProof(e, auth, "passkey.delete");
  const missing = await json(
    new Request("http://local/api/user/passkey", {
      method: "DELETE",
      headers: {
        ...auth,
        "X-Security-Proof": missingProof.proof_token,
        "x-oneapi-request-id": missingRid,
      },
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, missingRid)).some((row) => row.action === "user.passkey_delete"),
    false,
  );

  const beginProof = await passwordProof(e, auth, "passkey.register");
  const begin = await json(
    new Request("http://local/api/user/passkey/register/begin", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": beginProof.proof_token, "cf-connecting-ip": "192.0.2.144" },
    }),
    e,
  );
  assert.equal(begin.body.success, true, String(begin.body.message));
  const flowToken = (begin.body.data as { flow_token: string }).flow_token;

  const invalidFinishRid = "passkey-security-audit-register-fail-1";
  const invalidFinish = await json(
    new Request("http://local/api/user/passkey/register/finish", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": invalidFinishRid },
      body: JSON.stringify({ flow_token: flowToken }),
    }),
    e,
  );
  assert.equal(invalidFinish.body.success, false);
  assert.equal(
    (await auditsFor(e, auth, invalidFinishRid)).some((row) => row.action === "user.passkey_register"),
    false,
  );

  const registerRid = "passkey-security-audit-register-1";
  const registered = await json(
    new Request("http://local/api/user/passkey/register/finish", {
      method: "POST",
      headers: {
        ...auth,
        "x-oneapi-request-id": registerRid,
        "user-agent": "passkey-register-client",
        "cf-connecting-ip": "192.0.2.145",
      },
      body: JSON.stringify({ flow_token: flowToken, credential: { id: "cred-hop335", rawId: "cred-hop335" } }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  const registerAuth = {
    authorization: "Bearer " + (registered.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const registerSec = securityEvent(await auditsFor(e, registerAuth, registerRid), "user.passkey_register");
  assertNilParamSecurity(
    registerSec,
    "user.passkey_register",
    "POST",
    "/api/user/passkey/register/finish",
    "Registered a passkey",
  );
  assert.equal(registerSec.ip, "192.0.2.145");
  assert.equal(registerSec.user_agent, "passkey-register-client");

  const deleteProof = await passwordProof(e, registerAuth, "passkey.delete");
  const deleteRid = "passkey-security-audit-delete-1";
  const deleted = await json(
    new Request("http://local/api/user/passkey", {
      method: "DELETE",
      headers: {
        ...registerAuth,
        "X-Security-Proof": deleteProof.proof_token,
        "x-oneapi-request-id": deleteRid,
        "cf-connecting-ip": "192.0.2.146",
      },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const deleteAuth = {
    authorization: "Bearer " + (deleted.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const deleteSec = securityEvent(await auditsFor(e, deleteAuth, deleteRid), "user.passkey_delete");
  assertNilParamSecurity(deleteSec, "user.passkey_delete", "DELETE", "/api/user/passkey", "Deleted a passkey");
});
