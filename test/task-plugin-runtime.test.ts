import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { GO_ZERO_TIME } from "../src/constants.js";
import {
  publicTaskPluginRuntimeStatus,
  taskPluginSyncRevision,
  taskPluginSyncRevisionPayload,
} from "../src/dto.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `controller.taskPluginRuntimeStatus` JSON tags (`database_error` omitempty). */
const ORIGINAL_TASK_PLUGIN_RUNTIME_JSON_FIELDS = [
  "current_generation",
  "generation_published_at",
  "database_revision",
  "last_rebuild",
  "plugin_errors",
] as const;

/** Original `controller.taskPluginRebuildOutcome` JSON tags (`database_revision` / `error` omitempty). */
const ORIGINAL_TASK_PLUGIN_REBUILD_JSON_FIELDS = [
  "status",
  "attempted_at",
  "generation",
  "plugin_error_count",
] as const;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

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
  return { e, auth, store: new Store(e.DB) };
}

function pluginSource(key: string, version = "1.0.0") {
  return `const meta = { apiVersion: 1, key: "${key}", name: "${key}", version: "${version}", author: { name: "test" }, models: ["${key}"], fetchMode: "per_task", routes: [], protocols: [], allowedHosts: [], auth: { type: "none" } };`;
}

function assertRuntimeJson(data: Record<string, unknown>) {
  for (const key of ORIGINAL_TASK_PLUGIN_RUNTIME_JSON_FIELDS) {
    assert.ok(key in data, "missing taskPluginRuntimeStatus " + key);
  }
  assert.equal("database_error" in data, false);
  const last = data.last_rebuild as Record<string, unknown>;
  for (const key of ORIGINAL_TASK_PLUGIN_REBUILD_JSON_FIELDS) {
    assert.ok(key in last, "missing taskPluginRebuildOutcome " + key);
  }
  assert.equal("error" in last, false);
  assert.equal("database_revision" in last, false);
}

test("original GetTaskPluginSyncSnapshot hashes encoding/json [] when no active overrides", () => {
  assert.equal(taskPluginSyncRevisionPayload([]), "[]");
  assert.equal(taskPluginSyncRevision([]), sha256Hex("[]"));
});

test("original GetTaskPluginSyncSnapshot revisionEntry JSON field order and HTML escape", () => {
  const payload = taskPluginSyncRevisionPayload([
    { key: "z-last", api_version: 1, version: "2.0.0", source_hash: "b", enabled: false },
    { key: "a-first", api_version: 1, version: "1.0.0", source_hash: "a&b<c>", enabled: true },
  ]);
  assert.equal(
    payload,
    '[{"key":"a-first","api_version":1,"version":"1.0.0","source_hash":"a\\u0026b\\u003cc\\u003e","enabled":true},{"key":"z-last","api_version":1,"version":"2.0.0","source_hash":"b","enabled":false}]',
  );
  assert.equal(taskPluginSyncRevision([
    { key: "z-last", api_version: 1, version: "2.0.0", source_hash: "b", enabled: false },
    { key: "a-first", api_version: 1, version: "1.0.0", source_hash: "a&b<c>", enabled: true },
  ]), sha256Hex(payload));
});

test("original GetTaskPluginRuntime JSON uses SHA-256 database_revision not plugin count", async () => {
  const { e, auth, store } = await boot();
  const empty = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  assert.equal(empty.body.success, true, String(empty.body.message));
  const emptyData = empty.body.data as Record<string, unknown>;
  assertRuntimeJson(emptyData);
  assert.equal(emptyData.current_generation, 0);
  assert.equal(emptyData.generation_published_at, GO_ZERO_TIME);
  assert.equal(emptyData.database_revision, sha256Hex("[]"));
  assert.notEqual(emptyData.database_revision, "0");
  assert.deepEqual(emptyData.plugin_errors, {});
  const emptyRebuild = emptyData.last_rebuild as Record<string, unknown>;
  assert.equal(emptyRebuild.status, "never");
  assert.equal(emptyRebuild.attempted_at, GO_ZERO_TIME);
  assert.equal(emptyRebuild.generation, 0);
  assert.equal(emptyRebuild.plugin_error_count, 0);
  assert.deepEqual(
    emptyData,
    publicTaskPluginRuntimeStatus({
      current_generation: 0,
      generation_published_at: GO_ZERO_TIME,
      database_revision: sha256Hex("[]"),
      last_rebuild: { status: "never", attempted_at: GO_ZERO_TIME, generation: 0, plugin_error_count: 0 },
      plugin_errors: {},
    }),
  );

  const snapshot = await store.getTaskPluginSyncSnapshot();
  assert.deepEqual(snapshot.plugins, []);
  assert.equal(snapshot.revision, sha256Hex("[]"));
});

test("original GetTaskPluginSyncSnapshot revision tracks desired runtime state", async () => {
  const { e, auth, store } = await boot();
  const empty = await store.getTaskPluginSyncSnapshot();
  assert.deepEqual(empty.plugins, []);
  assert.equal(empty.revision, sha256Hex("[]"));

  await store.saveTaskPluginVersion({
    key: "revision-probe",
    api_version: 1,
    version: "1.0.0",
    source: "v1",
    source_hash: "hash-v1",
    enabled: 1,
  });
  const v1Snapshot = await store.getTaskPluginSyncSnapshot();
  assert.equal(v1Snapshot.plugins.length, 1);
  assert.equal(v1Snapshot.plugins[0].version, "1.0.0");
  assert.equal(
    v1Snapshot.revision,
    taskPluginSyncRevision([{ key: "revision-probe", api_version: 1, version: "1.0.0", source_hash: "hash-v1", enabled: true }]),
  );
  assert.notEqual(v1Snapshot.revision, empty.revision);

  const runtimeV1 = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  assert.equal((runtimeV1.body.data as { database_revision: string }).database_revision, v1Snapshot.revision);

  await store.saveTaskPluginVersion({
    key: "revision-probe",
    api_version: 1,
    version: "2.0.0",
    source: "v2",
    source_hash: "hash-v2",
    enabled: 1,
  });
  const inactiveAdded = await store.getTaskPluginSyncSnapshot();
  assert.equal(inactiveAdded.revision, v1Snapshot.revision);
  assert.equal(inactiveAdded.plugins[0].version, "1.0.0");

  await e.DB.prepare("UPDATE task_plugin_versions SET remark = ? WHERE key = ? AND version = ?")
    .bind("operator note", "revision-probe", "1.0.0")
    .run();
  const remarkChanged = await store.getTaskPluginSyncSnapshot();
  assert.equal(remarkChanged.revision, v1Snapshot.revision);

  const activated = await store.activateTaskPluginVersion("revision-probe", "2.0.0");
  assert.equal(activated, true);
  const v2Snapshot = await store.getTaskPluginSyncSnapshot();
  assert.equal(v2Snapshot.plugins.length, 1);
  assert.equal(v2Snapshot.plugins[0].version, "2.0.0");
  assert.equal(
    v2Snapshot.revision,
    taskPluginSyncRevision([{ key: "revision-probe", api_version: 1, version: "2.0.0", source_hash: "hash-v2", enabled: true }]),
  );
  assert.notEqual(v2Snapshot.revision, v1Snapshot.revision);

  await store.setTaskPluginEnabled("revision-probe", false);
  const disabled = await store.getTaskPluginSyncSnapshot();
  assert.deepEqual(disabled.plugins, []);
  assert.equal(
    disabled.revision,
    taskPluginSyncRevision([{ key: "revision-probe", api_version: 1, version: "2.0.0", source_hash: "hash-v2", enabled: false }]),
  );
  assert.notEqual(disabled.revision, v2Snapshot.revision);

  const runtimeDisabled = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  const runtimeData = runtimeDisabled.body.data as Record<string, unknown>;
  assertRuntimeJson(runtimeData);
  assert.equal(runtimeData.database_revision, disabled.revision);
  assert.notEqual(runtimeData.database_revision, String(1));
});

test("original GetTaskPluginRuntime database_revision changes after override upload", async () => {
  const { e, auth, store } = await boot();
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: pluginSource("runtime-upload") }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));
  const snapshot = await store.getTaskPluginSyncSnapshot();
  assert.equal(snapshot.plugins.length, 1);
  assert.equal(snapshot.plugins[0].key, "runtime-upload");
  assert.match(snapshot.revision, /^[0-9a-f]{64}$/);
  assert.notEqual(snapshot.revision, sha256Hex("[]"));

  const runtime = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  const data = runtime.body.data as Record<string, unknown>;
  assertRuntimeJson(data);
  assert.equal(data.database_revision, snapshot.revision);

  const uploadedV2 = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: pluginSource("runtime-upload", "2.0.0") }),
    }),
    e,
  );
  assert.equal(uploadedV2.body.success, true, String(uploadedV2.body.message));
  const stillV1 = await store.getTaskPluginSyncSnapshot();
  assert.equal(stillV1.revision, snapshot.revision);

  await json(
    new Request("http://local/api/plugin/task/runtime-upload/activate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ version: "2.0.0" }),
    }),
    e,
  );
  const afterActivate = await store.getTaskPluginSyncSnapshot();
  assert.equal(afterActivate.plugins[0].version, "2.0.0");
  assert.notEqual(afterActivate.revision, snapshot.revision);
  const runtimeV2 = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  assert.equal((runtimeV2.body.data as { database_revision: string }).database_revision, afterActivate.revision);
});
