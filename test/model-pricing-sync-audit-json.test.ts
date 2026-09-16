import assert from "node:assert/strict";
import http from "node:http";
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

function startCatalog(): Promise<{ base: string; close: () => Promise<void> }> {
  const models = [
    {
      model_name: "hop333-sync",
      description: "d",
      icon: "i",
      tags: "t",
      vendor_name: "HopVendor",
      endpoints: "",
      name_rule: 0,
      status: 1,
    },
  ];
  const vendors = [{ name: "HopVendor", description: "vd", icon: "vi", status: 1 }];
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    res.setHeader("content-type", "application/json");
    if (url.includes("/models.json")) res.end(JSON.stringify(models));
    else if (url.includes("/vendors.json")) res.end(JSON.stringify(vendors));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    server.on("error", reject);
  });
}

test("original recordManageAudit English model.pricing.update/metadata.sync templates are unregistered", () => {
  assert.equal(AUDIT_CONTENT_TEMPLATES["model.pricing.update"], undefined);
  assert.equal(AUDIT_CONTENT_TEMPLATES["model.metadata.sync"], undefined);
  assert.equal(auditContentEN("model.pricing.update", { models: ["gpt"] }), "model.pricing.update");
  assert.equal(auditContentEN("model.metadata.sync", { created_models: ["a"] }), "model.metadata.sync");
});

test("original recordManageAudit leftover model.pricing.update JSON and PAT", async () => {
  const { e, auth } = await boot();
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ "gpt-hop333": 1.5 }) }),
    }),
    e,
  );
  const priced = await json(new Request("http://local/api/option/model_pricing?model=gpt-hop333", { headers: auth }), e);
  const entry = (
    priced.body.data as { entries: { model_name: string; version: string }[] }
  ).entries[0];
  assert.equal(entry.model_name, "gpt-hop333");

  const rid = "manage-audit-model-pricing-update-1";
  const patched = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: {
        ...auth,
        "x-oneapi-request-id": rid,
        "user-agent": "pricing-update-client",
        "cf-connecting-ip": "192.0.2.101",
      },
      body: JSON.stringify({
        changes: [{ model_name: "gpt-hop333", expected_version: entry.version, pricing: { ModelRatio: 2 } }],
      }),
    }),
    e,
  );
  assert.equal(patched.body.success, true, String(patched.body.message));
  assert.deepEqual(patched.body.data, { updated_models: ["gpt-hop333"] });
  const privileged = operationEvent(await auditsFor(e, auth, rid));
  assert.equal(privileged.action, "model.pricing.update");
  assert.equal(privileged.category, AUDIT_CATEGORY_OPERATION);
  assert.equal(privileged.success, true);
  assert.equal(privileged.status, 200);
  assert.equal(privileged.route, "/api/option/model_pricing");
  assert.equal(privileged.method, "PATCH");
  assert.equal(privileged.auth_method, "session");
  assert.equal(privileged.token_ref, "");
  assert.equal(privileged.ip, "192.0.2.101");
  assert.equal(privileged.user_agent, "pricing-update-client");
  assert.equal(privileged.content, "model.pricing.update");
  assert.equal(privileged.actor_role, ROLE_ROOT);
  assert.deepEqual(privileged.other.op, { action: "model.pricing.update", params: { models: ["gpt-hop333"] } });
  assert.deepEqual(privileged.other.admin_info, {
    admin_id: privileged.user_id,
    admin_username: "root",
    admin_role: ROLE_ROOT,
    auth_method: "session",
  });
  assert.equal(privileged.other.audit_info, undefined);

  const failRid = "manage-audit-model-pricing-update-fail-1";
  const failed = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: JSON.stringify({ changes: [] }),
    }),
    e,
  );
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.message, "select model pricing changes before saving");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "generic");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/option/model_pricing");
  assert.equal(failOp.content, "PATCH /api/option/model_pricing");
  assert.ok(failOp.other.audit_info);

  const getRid = "manage-audit-model-pricing-get-1";
  await json(new Request("http://local/api/option/model_pricing", { headers: { ...auth, "x-oneapi-request-id": getRid } }), e);
  assert.equal((await auditsFor(e, auth, getRid)).length, 0);

  const next = await json(new Request("http://local/api/option/model_pricing?model=gpt-hop333", { headers: auth }), e);
  const nextEntry = (next.body.data as { entries: { version: string }[] }).entries[0];
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
  const patRid = "manage-audit-pat-model-pricing-update-1";
  const patPatch = await json(
    new Request("http://local/api/option/model_pricing", {
      method: "PATCH",
      headers: {
        authorization: "Bearer " + pat,
        "content-type": "application/json",
        "x-oneapi-request-id": patRid,
        "cf-connecting-ip": "192.0.2.102",
      },
      body: JSON.stringify({
        changes: [{ model_name: "gpt-hop333", expected_version: nextEntry.version, pricing: { ModelRatio: 2.5 } }],
      }),
    }),
    e,
  );
  assert.equal(patPatch.body.success, true, String(patPatch.body.message));
  const patEvents = await auditsFor(e, auth, patRid);
  assert.equal(patEvents.length, 2);
  const patOp = operationEvent(patEvents);
  assert.equal(patOp.auth_method, "access_token");
  assert.equal(patOp.action, "model.pricing.update");
  assert.equal(patOp.content, "model.pricing.update");
  assert.equal(patOp.other.admin_info?.auth_method, "access_token");
  const patAccess = patEvents.find((row) => row.category === "access_token");
  assert.ok(patAccess);
  assert.notEqual(patOp.event_id, patAccess!.event_id);
  assert.equal(JSON.stringify(patEvents).includes(pat), false);
});

test("original recordManageAudit leftover model.metadata.sync JSON", async () => {
  const { e, auth } = await boot();
  const failRid = "manage-audit-model-metadata-sync-fail-1";
  const failed = await json(
    new Request("http://local/api/models/sync_upstream", {
      method: "POST",
      headers: { ...auth, "x-oneapi-request-id": failRid },
      body: "{}",
    }),
    e,
  );
  assert.equal(failed.res.status, 400);
  assert.equal(failed.body.message, "Preview and select metadata changes before applying");
  const failOp = operationEvent(await auditsFor(e, auth, failRid));
  assert.equal(failOp.action, "model.sync_upstream");
  assert.equal(failOp.success, false);
  assert.equal(failOp.route, "/api/models/sync_upstream");
  assert.equal(failOp.content, "POST /api/models/sync_upstream");
  assert.ok(failOp.other.audit_info);

  const catalog = await startCatalog();
  const prev = process.env.SYNC_UPSTREAM_BASE;
  process.env.SYNC_UPSTREAM_BASE = catalog.base;
  try {
    const preview = await json(new Request("http://local/api/models/sync_upstream/preview?locale=zh", { headers: auth }), e);
    assert.equal(preview.body.success, true, String(preview.body.message));
    const pv = preview.body.data as {
      source: { version: string };
      candidates: { model_name: string; kind: string; record_version: string }[];
    };
    const create = pv.candidates.find((row) => row.model_name === "hop333-sync");
    assert.ok(create);
    assert.equal(create.kind, "create");
    const rid = "manage-audit-model-metadata-sync-1";
    const synced = await json(
      new Request("http://local/api/models/sync_upstream", {
        method: "POST",
        headers: {
          ...auth,
          "x-oneapi-request-id": rid,
          "user-agent": "metadata-sync-client",
          "cf-connecting-ip": "192.0.2.103",
        },
        body: JSON.stringify({
          locale: "zh",
          source_version: pv.source.version,
          selections: [
            {
              model_name: "hop333-sync",
              record_version: create.record_version,
              create: true,
            },
          ],
        }),
      }),
      e,
    );
    assert.equal(synced.body.success, true, String(synced.body.message));
    assert.deepEqual(synced.body.data, {
      created_models: ["hop333-sync"],
      updated_models: [],
      created_vendors: ["HopVendor"],
    });
    const privileged = operationEvent(await auditsFor(e, auth, rid));
    assert.equal(privileged.action, "model.metadata.sync");
    assert.equal(privileged.success, true);
    assert.equal(privileged.status, 200);
    assert.equal(privileged.route, "/api/models/sync_upstream");
    assert.equal(privileged.method, "POST");
    assert.equal(privileged.auth_method, "session");
    assert.equal(privileged.ip, "192.0.2.103");
    assert.equal(privileged.content, "model.metadata.sync");
    assert.deepEqual(privileged.other.op?.params, {
      created_models: ["hop333-sync"],
      updated_models: [],
      created_vendors: ["HopVendor"],
    });
    assert.equal(privileged.other.audit_info, undefined);
  } finally {
    if (prev == null) delete process.env.SYNC_UPSTREAM_BASE;
    else process.env.SYNC_UPSTREAM_BASE = prev;
    await catalog.close();
  }
});
