import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import { accessTokenFingerprint } from "../src/crypto.js";
import {
  AUDIT_CATEGORY_OPERATION,
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
    audit_info?: {
      method?: string;
      route?: string;
      path?: string;
      status?: number;
      success?: boolean;
    };
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

function securityEvent(events: AuditItem[], action: string): AuditItem {
  const row = events.find((item) => item.category === AUDIT_CATEGORY_SECURITY && item.action === action);
  assert.ok(row, "missing security audit " + action);
  return row!;
}

const domainBody = {
  rp_id: "example.com",
  legacy_rp_ids: "www.example.com,WWW.example.com",
  origins: "https://example.com,https://www.example.com",
};

test("original recordPasskeyDomainAudit / recordUserSecurityAudit English templates", () => {
  assert.equal(
    AUDIT_CONTENT_TEMPLATES["option.passkey_domains"],
    "Updated Passkey domains: removed ${domains}; affected ${known}; unknown ${unknown}",
  );
  assert.equal(
    auditContentEN("option.passkey_domains", { domains: "www.example.com", known: 1, unknown: 2 }),
    "Updated Passkey domains: removed www.example.com; affected 1; unknown 2",
  );
  assert.equal(
    auditContentEN("option.passkey_domains_confirmed", { domains: "www.example.com", known: 1, unknown: 3 }),
    "Confirmed removal of Passkey domains: www.example.com; affected 1; unknown 3",
  );
  assert.equal(
    auditContentEN("option.passkey_domains_blocked", { domains: "www.example.com", known: 1, unknown: 2 }),
    "Passkey domain change blocked: www.example.com; affected 1; unknown 2",
  );
  assert.equal(auditContentEN("option.passkey_domains_failed", {}), "Passkey domain update failed");
  assert.equal(auditContentEN("access_token.generate", { token_ref: "abc" }), "Generated a system access token");
  assert.equal(auditContentEN("access_token.revoke", { token_ref: "abc" }), "Revoked the system access token");
});

test("original recordPasskeyDomainAudit leftover passkey domains JSON", async () => {
  const { e, auth } = await boot();
  const saveRid = "passkey-domain-audit-save-1";
  const saved = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": saveRid,
        "user-agent": "passkey-domain-client",
        "cf-connecting-ip": "192.0.2.120",
      },
      body: JSON.stringify({ ...domainBody, preview: false }),
    }),
    e,
  );
  assert.equal(saved.body.success, true, saved.text);
  const savedData = saved.body.data as {
    previous_rp_id: string;
    effective_rp_id: string;
    removed_rp_ids: string[];
    affected_credentials: number;
    unknown_credentials: number;
  };
  const savedOp = operationEvent(await auditsFor(e, auth, saveRid));
  assert.equal(savedOp.action, "option.passkey_domains");
  assert.equal(savedOp.category, AUDIT_CATEGORY_OPERATION);
  assert.equal(savedOp.success, true);
  assert.equal(savedOp.status, 200);
  assert.equal(savedOp.route, "/api/option/passkey/domains");
  assert.equal(savedOp.method, "PUT");
  assert.equal(savedOp.auth_method, "session");
  assert.equal(savedOp.token_ref, "");
  assert.equal(savedOp.ip, "192.0.2.120");
  assert.equal(savedOp.user_agent, "passkey-domain-client");
  assert.equal(savedOp.actor_role, ROLE_ROOT);
  assert.equal(
    savedOp.content,
    auditContentEN("option.passkey_domains", {
      domains: savedData.removed_rp_ids.join(", "),
      known: savedData.affected_credentials,
      unknown: savedData.unknown_credentials,
    }),
  );
  assert.deepEqual(savedOp.other.op, {
    action: "option.passkey_domains",
    params: {
      success: true,
      confirmed: false,
      domains: savedData.removed_rp_ids.join(", "),
      removed_rp_ids: savedData.removed_rp_ids,
      known: savedData.affected_credentials,
      unknown: savedData.unknown_credentials,
      previous_rp_id: savedData.previous_rp_id,
      effective_rp_id: savedData.effective_rp_id,
    },
  });
  assert.deepEqual(savedOp.other.admin_info, {
    admin_id: savedOp.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.deepEqual(savedOp.other.audit_info, {
    method: "PUT",
    route: "/api/option/passkey/domains",
    path: "/api/option/passkey/domains",
    status: 200,
    success: true,
  });

  const previewRid = "passkey-domain-audit-preview-1";
  await e.DB.prepare(
    "INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (1, '0', 'key', '', 0, 0, 'www.example.com')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (2, '1', 'key', '', 0, 0, 'WWW.example.com')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (3, '2', 'key', '', 0, 0, '')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (4, '3', 'key', '', 0, 0, '')",
  ).run();
  const preview = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": previewRid, "cf-connecting-ip": "192.0.2.121" },
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "WWW.example.com",
        origins: domainBody.origins,
        preview: true,
      }),
    }),
    e,
  );
  assert.equal(preview.body.success, true, preview.text);
  const previewEvents = await auditsFor(e, auth, previewRid);
  assert.equal(
    previewEvents.some((row) => String(row.action).startsWith("option.passkey_domains")),
    false,
  );

  const blockedRid = "passkey-domain-audit-blocked-1";
  const blocked = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": blockedRid, "cf-connecting-ip": "192.0.2.122" },
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "WWW.example.com",
        origins: domainBody.origins,
        preview: false,
      }),
    }),
    e,
  );
  assert.equal(blocked.res.status, 409);
  assert.equal(blocked.body.code, "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED");
  const blockedData = blocked.body.data as {
    removed_rp_ids: string[];
    affected_credentials: number;
    unknown_credentials: number;
    previous_rp_id: string;
    effective_rp_id: string;
    removal_confirmation: string;
  };
  const blockedOp = operationEvent(await auditsFor(e, auth, blockedRid));
  assert.equal(blockedOp.action, "option.passkey_domains_blocked");
  assert.equal(blockedOp.success, false);
  assert.equal(blockedOp.status, 409);
  assert.equal(blockedOp.route, "/api/option/passkey/domains");
  assert.equal(
    blockedOp.content,
    auditContentEN("option.passkey_domains_blocked", {
      domains: blockedData.removed_rp_ids.join(", "),
      known: blockedData.affected_credentials,
      unknown: blockedData.unknown_credentials,
    }),
  );
  assert.equal(blockedOp.other.op?.params?.confirmed, false);
  assert.equal(blockedOp.other.op?.params?.success, false);
  assert.deepEqual(blockedOp.other.op?.params?.removed_rp_ids, blockedData.removed_rp_ids);
  assert.equal(blockedOp.other.audit_info?.status, 409);
  assert.equal(blockedOp.other.audit_info?.success, false);
  assert.equal(JSON.stringify(blockedOp).includes(blockedData.removal_confirmation), false);

  const confirmedRid = "passkey-domain-audit-confirmed-1";
  const confirmed = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": confirmedRid, "cf-connecting-ip": "192.0.2.123" },
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "WWW.example.com",
        origins: domainBody.origins,
        preview: false,
        removal_confirmation: blockedData.removal_confirmation,
      }),
    }),
    e,
  );
  assert.equal(confirmed.body.success, true, confirmed.text);
  const confirmedOp = operationEvent(await auditsFor(e, auth, confirmedRid));
  assert.equal(confirmedOp.action, "option.passkey_domains_confirmed");
  assert.equal(confirmedOp.success, true);
  assert.equal(confirmedOp.status, 200);
  assert.equal(confirmedOp.other.op?.params?.confirmed, true);
  assert.deepEqual(confirmedOp.other.op?.params?.removed_rp_ids, ["www.example.com"]);
  assert.equal(confirmedOp.other.op?.params?.known, 1);
  assert.equal(confirmedOp.other.op?.params?.unknown, 2);
  assert.equal(
    confirmedOp.content,
    "Confirmed removal of Passkey domains: www.example.com; affected 1; unknown 2",
  );

  const failRid = "passkey-domain-audit-failed-1";
  const failed = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": failRid, "cf-connecting-ip": "192.0.2.124" },
      body: JSON.stringify({
        rp_id: "https://example.com",
        legacy_rp_ids: "",
        origins: "https://example.com",
        preview: false,
      }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.code, "PASSKEY_RP_ID_INVALID");
  const failedOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failedOp.action, "option.passkey_domains_failed");
  assert.equal(failedOp.success, false);
  assert.equal(failedOp.status, 200);
  assert.equal(failedOp.content, "Passkey domain update failed");
  assert.deepEqual(failedOp.other.op, {
    action: "option.passkey_domains_failed",
    params: { success: false, confirmed: false },
  });
  assert.equal(failedOp.other.audit_info?.status, 200);
  assert.equal(failedOp.other.audit_info?.success, false);

  const missingRid = "passkey-domain-audit-missing-1";
  const missing = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: { ...auth, "x-oneapi-request-id": missingRid },
      body: JSON.stringify({ rp_id: "example.com" }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  const missingOp = operationEvent(await auditsFor(e, auth, missingRid));
  assert.equal(missingOp.action, "generic");
  assert.equal(missingOp.success, false);
  assert.equal(missingOp.route, "/api/option/passkey/domains");
  assert.equal(missingOp.content, "PUT /api/option/passkey/domains");
  assert.ok(missingOp.other.audit_info);
});

test("original recordPasskeyDomainAudit leftover UpdateOption passkey JSON and PAT", async () => {
  const { e, auth } = await boot();
  const optionRid = "passkey-domain-audit-option-save-1";
  const saved = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: {
        ...auth,
        "x-oneapi-request-id": optionRid,
        "user-agent": "option-passkey-client",
        "cf-connecting-ip": "192.0.2.125",
      },
      body: JSON.stringify({ key: "passkey.rp_id", value: "example.com" }),
    }),
    e,
  );
  assert.equal(saved.body.success, true, saved.text);
  const savedData = saved.body.data as {
    previous_rp_id: string;
    effective_rp_id: string;
    removed_rp_ids: string[];
    affected_credentials: number;
    unknown_credentials: number;
  };
  const savedOp = operationEvent(await auditsFor(e, auth, optionRid));
  assert.equal(savedOp.action, "option.passkey_domains");
  assert.equal(savedOp.route, "/api/option/");
  assert.equal(savedOp.method, "PUT");
  assert.equal(savedOp.auth_method, "session");
  assert.equal(savedOp.token_ref, "");
  assert.equal(savedOp.other.audit_info?.route, "/api/option/");
  assert.equal(savedOp.other.audit_info?.path, "/api/option/");
  assert.equal(savedOp.other.op?.params?.confirmed, false);
  assert.deepEqual(savedOp.other.op?.params?.removed_rp_ids, savedData.removed_rp_ids);

  const proof = await passwordProof(e, auth, "access_token.generate");
  const issued = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token, "cf-connecting-ip": "192.0.2.126" },
    }),
    e,
  );
  const pat = String(issued.body.data || "");
  assert.ok(pat);
  const patRid = "passkey-domain-audit-pat-1";
  const patSave = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.127",
      },
      body: JSON.stringify({ key: "passkey.origins", value: "https://example.com" }),
    }),
    e,
  );
  assert.equal(patSave.body.success, true, patSave.text);
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "option.passkey_domains");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
});

test("original recordUserSecurityAudit leftover access_token.generate/revoke JSON", async () => {
  const { e, auth } = await boot();
  const getProof = await passwordProof(e, auth, "access_token.generate");
  const getRid = "access-token-audit-generate-get-1";
  const generatedGet = await json(
    new Request("http://local/api/user/token", {
      method: "GET",
      headers: {
        ...auth,
        "X-Security-Proof": getProof.proof_token,
        "x-oneapi-request-id": getRid,
        "user-agent": "access-token-client",
        "cf-connecting-ip": "192.0.2.128",
      },
    }),
    e,
  );
  assert.equal(generatedGet.body.success, true, generatedGet.text);
  const getToken = String(generatedGet.body.data || "");
  assert.ok(getToken);
  const getFp = await accessTokenFingerprint(getToken);
  const getEvents = await auditsFor(e, auth, getRid);
  assert.equal(getEvents.length, 1);
  const getSec = securityEvent(getEvents, "access_token.generate");
  assert.equal(getSec.category, AUDIT_CATEGORY_SECURITY);
  assert.equal(getSec.success, true);
  assert.equal(getSec.status, 200);
  assert.equal(getSec.method, "GET");
  assert.equal(getSec.route, "/api/user/token");
  assert.equal(getSec.auth_method, "session");
  assert.equal(getSec.token_ref, "");
  assert.equal(getSec.ip, "192.0.2.128");
  assert.equal(getSec.user_agent, "access-token-client");
  assert.equal(getSec.actor_role, ROLE_ROOT);
  assert.equal(getSec.content, "Generated a system access token");
  assert.deepEqual(getSec.other.op, { action: "access_token.generate", params: { token_ref: getFp } });
  assert.equal(getSec.other.admin_info, undefined);
  assert.equal(getSec.other.audit_info, undefined);
  assert.equal(JSON.stringify(getEvents).includes(getToken), false);

  const postProof = await passwordProof(e, auth, "access_token.generate");
  const postRid = "access-token-audit-generate-post-1";
  const generatedPost = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: {
        ...auth,
        "X-Security-Proof": postProof.proof_token,
        "x-oneapi-request-id": postRid,
        "cf-connecting-ip": "192.0.2.129",
      },
    }),
    e,
  );
  assert.equal(generatedPost.body.success, true, generatedPost.text);
  const postToken = String(generatedPost.body.data || "");
  const postFp = await accessTokenFingerprint(postToken);
  const postSec = securityEvent(await auditsFor(e, auth, postRid), "access_token.generate");
  assert.equal(postSec.method, "POST");
  assert.equal(postSec.route, "/api/user/token");
  assert.equal(postSec.token_ref, "");
  assert.equal(postSec.other.op?.params?.token_ref, postFp);
  assert.equal(postSec.other.admin_info, undefined);
  assert.equal(postSec.other.audit_info, undefined);

  const revokeProof = await passwordProof(e, auth, "access_token.revoke");
  const revokeRid = "access-token-audit-revoke-1";
  const revoked = await json(
    new Request("http://local/api/user/token", {
      method: "DELETE",
      headers: {
        ...auth,
        "X-Security-Proof": revokeProof.proof_token,
        "x-oneapi-request-id": revokeRid,
        "cf-connecting-ip": "192.0.2.130",
      },
    }),
    e,
  );
  assert.equal(revoked.body.success, true, revoked.text);
  const revokeSec = securityEvent(await auditsFor(e, auth, revokeRid), "access_token.revoke");
  assert.equal(revokeSec.category, AUDIT_CATEGORY_SECURITY);
  assert.equal(revokeSec.success, true);
  assert.equal(revokeSec.status, 200);
  assert.equal(revokeSec.method, "DELETE");
  assert.equal(revokeSec.route, "/api/user/token");
  assert.equal(revokeSec.auth_method, "session");
  assert.equal(revokeSec.token_ref, "");
  assert.equal(revokeSec.content, "Revoked the system access token");
  assert.deepEqual(revokeSec.other.op, { action: "access_token.revoke", params: { token_ref: postFp } });
  assert.equal(revokeSec.other.admin_info, undefined);
  assert.equal(revokeSec.other.audit_info, undefined);
  assert.equal(JSON.stringify(await auditsFor(e, auth, revokeRid)).includes(postToken), false);

  const emptyProof = await passwordProof(e, auth, "access_token.revoke");
  const emptyRid = "access-token-audit-revoke-empty-1";
  const empty = await json(
    new Request("http://local/api/user/token", {
      method: "DELETE",
      headers: {
        ...auth,
        "X-Security-Proof": emptyProof.proof_token,
        "x-oneapi-request-id": emptyRid,
        "cf-connecting-ip": "192.0.2.131",
      },
    }),
    e,
  );
  assert.equal(empty.body.success, true, empty.text);
  assert.equal((await auditsFor(e, auth, emptyRid)).length, 0);
});
