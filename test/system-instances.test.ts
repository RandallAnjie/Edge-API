import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  SYSTEM_INSTANCE_STALE_AFTER_SECONDS,
  decodeSystemInstanceInfo,
  getNodeIdentity,
  listSystemInstanceResponses,
  reportCurrentSystemInstance,
  toSystemInstanceResponse,
} from "../src/system-instance.js";
import { nowSec } from "../src/constants.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

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
  return { e, auth, store: new Store(e.DB) };
}

test("original ListSystemInstances SystemInstanceInfo JSON fields", async () => {
  const { e, auth } = await boot();
  const listed = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  assert.equal(listed.body.success, true);
  const rows = listed.body.data as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.node_name, "edge-api");
  assert.equal(row.status, "online");
  assert.equal(row.stale_after_seconds, 90);
  assert.equal(typeof row.started_at, "number");
  assert.equal(typeof row.last_seen_at, "number");
  const info = row.info as {
    schema_version: number;
    node: { name: string; source: string; manually_configured: boolean; should_configure_manually: boolean };
    role: { is_master: boolean };
    runtime: { version: string; goos: string; goarch: string; started_at: number };
    host: { hostname: string };
    resources: {
      cpu: { usage_percent: number };
      memory: { usage_percent: number };
      storage: { total_bytes: number; used_bytes: number; free_bytes: number; used_percent: number };
    };
  };
  assert.equal(info.schema_version, 1);
  assert.equal(info.node.name, "edge-api");
  assert.equal(info.node.source, "hostname");
  assert.equal(info.node.manually_configured, false);
  assert.equal(info.node.should_configure_manually, true);
  assert.equal(info.role.is_master, true);
  assert.equal(typeof info.runtime.version, "string");
  assert.equal(info.runtime.goos, "workerd");
  assert.equal(info.runtime.goarch, "wasm");
  assert.equal(typeof info.runtime.started_at, "number");
  assert.equal(info.host.hostname, "edge-api");
  assert.equal(typeof info.resources.cpu.usage_percent, "number");
  assert.equal(typeof info.resources.memory.usage_percent, "number");
  assert.equal(typeof info.resources.storage.total_bytes, "number");
  assert.equal(typeof info.resources.storage.used_bytes, "number");
  assert.equal(typeof info.resources.storage.free_bytes, "number");
  assert.equal(typeof info.resources.storage.used_percent, "number");
  assert.equal("extra" in info, false);

  const persisted = await e.DB.prepare("SELECT node_name, info FROM system_instances").all<{ node_name: string; info: string }>();
  assert.equal(persisted.results.length, 1);
  assert.equal(persisted.results[0].node_name, "edge-api");
  assert.match(persisted.results[0].info, /"schema_version":1/);
});

test("original NODE_NAME identity and NODE_TYPE slave JSON", async () => {
  const identity = getNodeIdentity({ NODE_NAME: "new-api-master-1" });
  assert.equal(identity.name, "new-api-master-1");
  assert.equal(identity.source, "manual");
  assert.equal(identity.manually_configured, true);
  assert.equal(identity.should_configure_manually, false);

  const { e, auth } = await boot({ NODE_NAME: "new-api-master-1", NODE_TYPE: "slave" });
  const listed = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  const row = (listed.body.data as Record<string, unknown>[])[0];
  assert.equal(row.node_name, "new-api-master-1");
  const info = row.info as {
    node: { name: string; source: string; manually_configured: boolean; should_configure_manually: boolean };
    role: { is_master: boolean };
    host: { hostname: string };
  };
  assert.equal(info.node.name, "new-api-master-1");
  assert.equal(info.node.source, "manual");
  assert.equal(info.node.manually_configured, true);
  assert.equal(info.node.should_configure_manually, false);
  assert.equal(info.role.is_master, false);
  assert.equal(info.host.hostname, "edge-api");
});

test("original ListSystemInstances stale status, delete JSON, and other projection", async () => {
  const { e, auth, store } = await boot();
  await reportCurrentSystemInstance(store, e);
  await store.upsertSystemInstance(
    "stale-node",
    JSON.stringify({ schema_version: 1, node: { name: "stale-node" } }),
    nowSec() - 1000,
    nowSec() - SYSTEM_INSTANCE_STALE_AFTER_SECONDS - 1,
  );

  const listed = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  const rows = listed.body.data as { node_name: string; status: string }[];
  const current = rows.find((r) => r.node_name === "edge-api");
  const stale = rows.find((r) => r.node_name === "stale-node");
  assert.ok(current);
  assert.equal(current.status, "online");
  assert.ok(stale);
  assert.equal(stale.status, "stale");
  assert.equal(rows[0].node_name, "edge-api");

  const denyOnline = await json(new Request("http://local/api/system-info/instances/edge-api", { method: "DELETE", headers: auth }), e);
  assert.equal(denyOnline.body.success, false);
  assert.equal(denyOnline.body.message, "instance is not stale or no longer exists");

  const missingName = await json(new Request("http://local/api/system-info/instances/%20", { method: "DELETE", headers: auth }), e);
  assert.equal(missingName.body.success, false);
  assert.equal(missingName.body.message, "node name is required");

  const deleteOne = await json(new Request("http://local/api/system-info/instances/stale-node", { method: "DELETE", headers: auth }), e);
  assert.equal(deleteOne.body.success, true);
  assert.deepEqual(deleteOne.body.data, { deleted_count: 1 });

  await store.upsertSystemInstance("stale-node-2", "{}", nowSec() - 1000, nowSec() - SYSTEM_INSTANCE_STALE_AFTER_SECONDS - 5);
  const deleteAll = await json(new Request("http://local/api/system-info/stale-instances", { method: "DELETE", headers: auth }), e);
  assert.equal(deleteAll.body.success, true);
  assert.deepEqual(deleteAll.body.data, { deleted_count: 1 });

  const remaining = await json(new Request("http://local/api/system-info/instances", { headers: auth }), e);
  const names = ((remaining.body.data as { node_name: string }[]) || []).map((r) => r.node_name);
  assert.deepEqual(names, ["edge-api"]);

  assert.equal(decodeSystemInstanceInfo(""), null);
  assert.equal(decodeSystemInstanceInfo("not-json"), "not-json");
  const emptyInfo = toSystemInstanceResponse({ node_name: "x", started_at: 1, last_seen_at: nowSec(), info: "" });
  assert.equal(emptyInfo.info, null);
  assert.equal(emptyInfo.status, "online");
  const staleResp = toSystemInstanceResponse({
    node_name: "x",
    started_at: 1,
    last_seen_at: nowSec() - SYSTEM_INSTANCE_STALE_AFTER_SECONDS - 1,
    info: '{"ok":true}',
  });
  assert.equal(staleResp.status, "stale");
  assert.deepEqual(staleResp.info, { ok: true });

  const responses = await listSystemInstanceResponses(store, e);
  assert.equal(responses[0].node_name, "edge-api");
});
