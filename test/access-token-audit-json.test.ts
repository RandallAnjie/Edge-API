import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { ROLE_ROOT } from "../src/constants.js";
import { AUDIT_CATEGORY_ACCESS_TOKEN } from "../src/auth.js";
import { accessTokenFingerprint } from "../src/crypto.js";
import { ginFullPath } from "../src/router.js";
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

async function issuePat(e: Env, auth: Record<string, string>): Promise<string> {
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
  return pat;
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
  other: Record<string, unknown>;
};

async function auditsFor(e: Env, auth: Record<string, string>, requestId: string): Promise<AuditItem[]> {
  const listed = await json(
    new Request("http://local/api/audit?page_size=100&request_id=" + encodeURIComponent(requestId), { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  return ((listed.body.data as { items: AuditItem[] }).items || []) as AuditItem[];
}

function accessEvent(events: AuditItem[]): AuditItem {
  const row = events.find((item) => item.category === AUDIT_CATEGORY_ACCESS_TOKEN);
  assert.ok(row, "missing access_token audit");
  return row!;
}

test("original gin FullPath for AccessTokenAudit uses templates not request URIs", () => {
  assert.equal(ginFullPath("GET", "/api/status"), "/api/status");
  assert.equal(ginFullPath("GET", "/api/user/self"), "/api/user/self");
  assert.equal(ginFullPath("GET", "/api/user/42"), "/api/user/:id");
  assert.equal(ginFullPath("POST", "/api/vendors/"), "/api/vendors/");
  assert.equal(ginFullPath("GET", "/api/missing-pat-audit"), "");
});

test("original AccessTokenAudit leftover JSON on public reads, failures, and gin FullPath", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "pat-target", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const listed = await json(
    new Request("http://local/api/user/search?keyword=pat-target", { headers: auth }),
    e,
  );
  const target = ((listed.body.data as { items: { id: number; username: string }[] }).items || []).find(
    (u) => u.username === "pat-target",
  );
  assert.ok(target);

  const pat = await issuePat(e, auth);
  const fp = await accessTokenFingerprint(pat);
  const patAuth = {
    authorization: "Bearer " + pat,
    "content-type": "application/json",
    "user-agent": "audit-test-client",
  };

  const publicRid = "pat-audit-public";
  const pub = await json(
    new Request("http://local/api/status", {
      headers: { ...patAuth, "x-oneapi-request-id": publicRid, "cf-connecting-ip": "192.0.2.8" },
    }),
    e,
  );
  assert.equal(pub.body.success, true);
  const pubRow = accessEvent(await auditsFor(e, auth, publicRid));
  assert.equal(pubRow.success, true);
  assert.equal(pubRow.status, 200);
  assert.equal(pubRow.action, "");
  assert.equal(pubRow.content, "");
  assert.equal(pubRow.method, "GET");
  assert.equal(pubRow.route, "/api/status");
  assert.equal(pubRow.auth_method, "access_token");
  assert.equal(pubRow.token_ref, fp);
  assert.equal(pubRow.actor_role, ROLE_ROOT);
  assert.equal(pubRow.username, "root");
  assert.equal(pubRow.ip, "192.0.2.8");
  assert.equal(pubRow.user_agent, "audit-test-client");
  assert.notEqual(pubRow.event_id, publicRid);
  assert.equal(pubRow.other.op, undefined);
  assert.equal(pubRow.other.admin_info, undefined);
  assert.equal(JSON.stringify(pubRow).includes(pat), false);

  const missingRid = "pat-audit-missing";
  const missing = await json(
    new Request("http://local/api/missing-pat-audit", {
      headers: { ...patAuth, "x-oneapi-request-id": missingRid, "cf-connecting-ip": "192.0.2.9" },
    }),
    e,
  );
  assert.equal(missing.res.status, 404);
  const missRow = accessEvent(await auditsFor(e, auth, missingRid));
  assert.equal(missRow.success, false);
  assert.equal(missRow.status, 404);
  assert.equal(missRow.action, "");
  assert.equal(missRow.content, "");
  assert.equal(missRow.route, "");

  const idRid = "pat-audit-user-id";
  const got = await json(
    new Request("http://local/api/user/" + target!.id + "?password=secret-query", {
      headers: { ...patAuth, "x-oneapi-request-id": idRid, "cf-connecting-ip": "192.0.2.10" },
    }),
    e,
  );
  assert.equal(got.body.success, true, String(got.body.message));
  const idRow = accessEvent(await auditsFor(e, auth, idRid));
  assert.equal(idRow.success, true);
  assert.equal(idRow.route, "/api/user/:id");
  assert.equal(idRow.route.includes(String(target!.id)), false);
  assert.equal(JSON.stringify(idRow).includes("secret-query"), false);

  const failRid = "pat-audit-business-fail";
  const failed = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...patAuth, "x-oneapi-request-id": failRid, "cf-connecting-ip": "192.0.2.11" },
      body: JSON.stringify({ secret: "body-must-not-be-logged" }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.res.status, 200);
  const failRow = accessEvent(await auditsFor(e, auth, failRid));
  assert.equal(failRow.success, false);
  assert.equal(failRow.status, 200);
  assert.equal(failRow.route, "/api/option/");
  assert.equal(failRow.action, "");
  assert.equal(JSON.stringify(failRow).includes("body-must-not-be-logged"), false);
  assert.equal(JSON.stringify(failRow).includes(pat), false);
});

test("original AccessTokenAudit skips browser sessions and unknown tokens", async () => {
  const { e, auth, token } = await boot();
  const sessionRid = "pat-audit-session";
  const sessionHit = await json(
    new Request("http://local/api/status", {
      headers: { ...auth, "x-oneapi-request-id": sessionRid, "user-agent": "audit-test-client" },
    }),
    e,
  );
  assert.equal(sessionHit.body.success, true);
  assert.equal(
    (await auditsFor(e, auth, sessionRid)).filter((row) => row.category === AUDIT_CATEGORY_ACCESS_TOKEN).length,
    0,
  );

  const unknownRid = "pat-audit-unknown";
  await json(
    new Request("http://local/api/status", {
      headers: { authorization: "Bearer unknown-token", "x-oneapi-request-id": unknownRid },
    }),
    e,
  );
  assert.equal(
    (await auditsFor(e, auth, unknownRid)).filter((row) => row.category === AUDIT_CATEGORY_ACCESS_TOKEN).length,
    0,
  );

  const pat = await issuePat(e, auth);
  const dualRid = "pat-audit-dual-vendor";
  const created = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": dualRid,
        "cf-connecting-ip": "192.0.2.12",
      },
      body: JSON.stringify({ name: "pat-audit-vendor", description: "", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const events = await auditsFor(e, auth, dualRid);
  const access = accessEvent(events);
  const operation = events.find((row) => row.category === "operation");
  assert.ok(operation);
  assert.notEqual(access.event_id, operation!.event_id);
  assert.equal(access.action, "");
  assert.equal(access.route, "/api/vendors/");
  assert.equal(JSON.stringify(events).includes(pat), false);
  assert.equal(JSON.stringify(events).includes(token), false);
});
