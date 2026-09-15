import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { FACTORY_TASK_PLUGIN_SOURCES } from "../src/task-plugin-factory-data.js";
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
  return { e, auth, store: new Store(e.DB) };
}

/** Original `taskPluginControllerTestSource` with required hooks. */
function validPluginSource(key: string, version = "1.0.0") {
  return `export const meta = {apiVersion:1,key:${JSON.stringify(key)},name:${JSON.stringify(key)},version:${JSON.stringify(version)},author:{name:"Test"},models:[${JSON.stringify(key)}],fetchMode:"per_task",routes:[],protocols:[],allowedHosts:[],auth:{type:"none"}};
export function buildSubmitRequest(){return {url:"https://provider.example/submit"}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
`;
}

/** Meta-only stub: extractPluginMeta succeeds, original Register / compilePlugin fails. */
function compileFailSource(key: string, version = "1.0.0") {
  return `const meta = { apiVersion: 1, key: "${key}", name: "${key}", version: "${version}", author: { name: "test" }, models: ["${key}"], fetchMode: "per_task", routes: [], protocols: [], allowedHosts: [], auth: { type: "none" } };`;
}

/** Original `controller.taskPluginListItem` JSON tags (`runtime_error` / `factory_meta` omitempty). */
const ORIGINAL_LIST_ITEM_FIELDS = [
  "meta",
  "source",
  "enabled",
  "active",
  "source_hash",
  "has_icon",
  "remark",
  "runtime_status",
  "channel_count",
  "in_flight_count",
] as const;

/** Original `controller.taskPluginDetail` JSON tags (`plugin` omitempty). */
const ORIGINAL_DETAIL_FIELDS = ["meta", "source", "layer", "has_icon"] as const;

test("original ListTaskPlugins compiled Meta, runtime_status, and omitempty JSON", async () => {
  const { e, auth, store } = await boot();

  const listedFactory = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  assert.equal(listedFactory.body.success, true, String(listedFactory.body.message));
  const factoryItems = listedFactory.body.data as Record<string, unknown>[];
  for (const item of factoryItems) {
    for (const field of ORIGINAL_LIST_ITEM_FIELDS) assert.ok(field in item, "missing taskPluginListItem " + field);
    assert.equal("runtime_error" in item, false);
    assert.equal("factory_meta" in item, false);
    assert.equal(item.source, "factory");
    assert.equal(item.runtime_status, "registered");
    assert.equal(item.channel_count, 0);
    assert.equal(item.in_flight_count, 0);
  }

  const pendingSource = validPluginSource("list-pending");
  await store.saveTaskPluginVersion({
    key: "list-pending",
    api_version: 1,
    version: "1.0.0",
    source: pendingSource,
    source_hash: "pending-hash",
    enabled: 1,
  });
  await store.upsertTaskPlugin({
    key: "list-pending",
    version: "1.0.0",
    source: pendingSource,
    source_hash: "pending-hash",
    enabled: 1,
    active: 1,
    api_version: 1,
  });
  const beforeSync = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const pending = (beforeSync.body.data as Record<string, unknown>[]).find((p) => (p.meta as { key: string }).key === "list-pending");
  assert.ok(pending);
  for (const field of ORIGINAL_LIST_ITEM_FIELDS) assert.ok(field in pending, "missing override taskPluginListItem " + field);
  assert.equal(pending.source, "override");
  assert.equal(pending.runtime_status, "not_registered");
  assert.equal("runtime_error" in pending, false);
  assert.equal("factory_meta" in pending, false);
  assert.equal((pending.meta as { name: string }).name, "list-pending");
  assert.equal(pending.has_icon, false);
  assert.equal(pending.channel_count, 0);
  assert.equal(pending.in_flight_count, 0);

  const runtime = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  assert.equal(runtime.body.success, true, String(runtime.body.message));
  const afterSync = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const registered = (afterSync.body.data as Record<string, unknown>[]).find((p) => (p.meta as { key: string }).key === "list-pending");
  assert.equal(registered?.runtime_status, "registered");
  assert.equal("runtime_error" in (registered || {}), false);

  const off = await json(
    new Request("http://local/api/plugin/task/list-pending/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    }),
    e,
  );
  assert.equal(off.body.success, true, String(off.body.message));
  const listedOff = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const disabled = (listedOff.body.data as Record<string, unknown>[]).find((p) => (p.meta as { key: string }).key === "list-pending");
  assert.equal(disabled?.enabled, false);
  assert.equal(disabled?.runtime_status, "disabled_fallback");
});

test("original ListTaskPlugins compile_failed stub Meta and GetTaskPlugin Register error", async () => {
  const { e, auth, store } = await boot();
  await store.saveTaskPluginVersion({
    key: "list-bad",
    api_version: 1,
    version: "1.0.0",
    source: compileFailSource("list-bad"),
    source_hash: "bad-hash",
    enabled: 1,
  });

  const runtime = await json(new Request("http://local/api/plugin/task/runtime/status", { headers: auth }), e);
  const errors = (runtime.body.data as { plugin_errors: Record<string, string> }).plugin_errors;
  assert.equal(typeof errors["list-bad"], "string");
  assert.ok(errors["list-bad"].length > 0);

  const listed = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const item = (listed.body.data as Record<string, unknown>[]).find((p) => (p.meta as { key: string }).key === "list-bad");
  assert.ok(item);
  assert.equal(item.runtime_status, "compile_failed");
  assert.equal(item.runtime_error, errors["list-bad"]);
  const meta = item.meta as Record<string, unknown>;
  assert.equal(meta.key, "list-bad");
  assert.equal(meta.version, "1.0.0");
  assert.equal(meta.apiVersion, 1);
  assert.equal(meta.name, "");
  assert.equal(meta.models, null);
  assert.equal(meta.fetchMode, "");
  assert.equal(meta.routes, null);
  assert.equal(meta.protocols, null);
  assert.equal(meta.allowedHosts, null);

  const detail = await json(new Request("http://local/api/plugin/task/list-bad", { headers: auth }), e);
  assert.equal(detail.body.success, false);
  assert.equal(typeof detail.body.message, "string");
  assert.ok(String(detail.body.message).length > 0);
  assert.notEqual(detail.body.message, "task plugin not found");
});

test("original GetTaskPlugin Register Meta, version miss record not found, factory omits plugin", async () => {
  const { e, auth, store } = await boot();

  const factory = await json(new Request("http://local/api/plugin/task/kling", { headers: auth }), e);
  assert.equal(factory.body.success, true, String(factory.body.message));
  const factoryData = factory.body.data as Record<string, unknown>;
  for (const field of ORIGINAL_DETAIL_FIELDS) assert.ok(field in factoryData, "missing taskPluginDetail " + field);
  assert.equal("plugin" in factoryData, false);
  assert.equal(factoryData.layer, "factory");
  assert.equal(factoryData.source, FACTORY_TASK_PLUGIN_SOURCES.kling);
  assert.equal((factoryData.meta as { key: string }).key, "kling");
  assert.ok(Array.isArray((factoryData.meta as { routes: unknown[] }).routes));
  assert.equal(((factoryData.meta as { routes: unknown[] }).routes || []).length, 4);

  const versionMiss = await json(new Request("http://local/api/plugin/task/kling?version=no-such", { headers: auth }), e);
  assert.equal(versionMiss.body.success, false);
  assert.equal(versionMiss.body.message, "record not found");

  const missing = await json(new Request("http://local/api/plugin/task/no-such-plugin", { headers: auth }), e);
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "task plugin not found");

  await store.saveTaskPluginVersion({
    key: "get-ok",
    api_version: 1,
    version: "1.0.0",
    source: validPluginSource("get-ok"),
    source_hash: "ok-hash",
    enabled: 1,
    icon: "",
  });
  const override = await json(new Request("http://local/api/plugin/task/get-ok", { headers: auth }), e);
  assert.equal(override.body.success, true, String(override.body.message));
  const data = override.body.data as Record<string, unknown>;
  for (const field of ORIGINAL_DETAIL_FIELDS) assert.ok(field in data, "missing override taskPluginDetail " + field);
  assert.equal(data.layer, "override");
  assert.equal(data.has_icon, false);
  assert.ok(data.plugin && typeof data.plugin === "object");
  assert.equal("icon" in (data.plugin as object), false);
  assert.equal((data.meta as { key: string; fetchMode: string }).key, "get-ok");
  assert.equal((data.meta as { fetchMode: string }).fetchMode, "per_task");
  assert.ok(Array.isArray((data.meta as { models: string[] }).models));
});

test("original GetTaskPluginIcon DecodeIconDataURI 404 and override has_icon from row.Icon", async () => {
  const { e, auth, store } = await boot();

  const missing = await json(new Request("http://local/api/plugin/task/no-such-plugin/icon", { headers: auth }), e);
  assert.equal(missing.res.status, 404);

  const invalidPng = "data:image/png;base64,aaaa";
  await store.saveTaskPluginVersion({
    key: "icon-bad",
    api_version: 1,
    version: "1.0.0",
    source: validPluginSource("icon-bad"),
    source_hash: "icon-bad",
    enabled: 1,
    icon: invalidPng,
  });
  const badIcon = await json(new Request("http://local/api/plugin/task/icon-bad/icon", { headers: auth }), e);
  assert.equal(badIcon.res.status, 404);

  const listed = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const item = (listed.body.data as Record<string, unknown>[]).find((p) => (p.meta as { key: string }).key === "icon-bad");
  assert.equal(item?.has_icon, true);

  const svg =
    "data:image/svg+xml;base64," +
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>`).toString("base64");
  await store.saveTaskPluginVersion({
    key: "icon-ok",
    api_version: 1,
    version: "1.0.0",
    source: validPluginSource("icon-ok"),
    source_hash: "icon-ok",
    enabled: 1,
    icon: svg,
  });
  const okIcon = await json(new Request("http://local/api/plugin/task/icon-ok/icon", { headers: auth }), e);
  assert.equal(okIcon.res.status, 200);
  assert.equal(okIcon.res.headers.get("content-type"), "image/svg+xml");
  assert.equal(okIcon.res.headers.get("cache-control"), "private, max-age=3600");
  assert.equal(okIcon.res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(okIcon.res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  assert.match(okIcon.text, /<circle/);

  const detail = await json(new Request("http://local/api/plugin/task/icon-ok", { headers: auth }), e);
  assert.equal((detail.body.data as { has_icon: boolean }).has_icon, true);
  assert.equal(String(JSON.stringify(detail.body.data)).includes("base64,"), false);
});

/** Original GetTaskPluginOptions gin.H keys. */
const ORIGINAL_OPTION_FIELDS = [
  "key",
  "name",
  "description",
  "icon",
  "hasIcon",
  "baseUrl",
  "sortPriority",
  "website",
  "models",
  "channelTypes",
  "usageSchema",
  "usageProfiles",
] as const;

test("original GetTaskPluginOptions compiled Meta, LocalizedText, normalized baseUrl JSON", async () => {
  const { e, auth, store } = await boot();
  const source = `
export const meta = {
  apiVersion: 1, key: "usage-options-probe", name: "Usage Options", version: "1.0.0", author: {name: "Test"},
  description: {en: "Video generation via the vendor API", zh: "通过厂商接口生成视频"},
  icon: "text:UO", baseUrl: "http://localhost:9000/",
  channelTypes: [1990, 1991],
  models: ["usage-options-model"], fetchMode: "per_task",
  usageSchema: {seconds: {type: "number", unit: "second", description: "Video generation unit price"}},
  usageProfiles: [{models:["usage-options-model"],schema:{image_count:{type:"number",unit:"count"}}}]
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {}; }
`;
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));

  const options = await json(new Request("http://local/api/task_plugin_options", { headers: auth }), e);
  assert.equal(options.body.success, true, String(options.body.message));
  const items = options.body.data as Record<string, unknown>[];
  for (const item of items) {
    for (const field of ORIGINAL_OPTION_FIELDS) assert.ok(field in item, "missing GetTaskPluginOptions " + field);
  }
  const probe = items.find((item) => item.key === "usage-options-probe");
  assert.ok(probe);
  assert.deepEqual(probe!.description, {
    en: "Video generation via the vendor API",
    zh: "通过厂商接口生成视频",
  });
  assert.equal((probe!.usageSchema as Record<string, { unit: string; description: { en: string } }>).seconds.unit, "second");
  assert.equal(
    (probe!.usageSchema as Record<string, { description: { en: string } }>).seconds.description.en,
    "Video generation unit price",
  );
  const profiles = probe!.usageProfiles as { models: string[]; schema: Record<string, { unit: string }> }[];
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0].models, ["usage-options-model"]);
  assert.equal(profiles[0].schema.image_count.unit, "count");
  assert.equal(probe!.icon, "text:UO");
  assert.deepEqual(probe!.channelTypes, [1990, 1991]);
  assert.equal(probe!.baseUrl, "http://localhost:9000");
  assert.equal(typeof probe!.hasIcon, "boolean");
  assert.equal(typeof probe!.sortPriority, "number");

  await store.setOption("TaskPluginEnabled", "false");
  const empty = await json(new Request("http://local/api/task_plugin_options", { headers: auth }), e);
  assert.equal(empty.body.success, true, String(empty.body.message));
  assert.deepEqual(empty.body.data, []);
  const listed = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  assert.ok((listed.body.data as { meta: { key: string } }[]).some((item) => item.meta.key === "kling"));
});

test("original CompilePlugin normalizeV1Meta JSON on GetTaskPlugin and status/delete registry", async () => {
  const { e, auth } = await boot();
  const source = `
export const meta = {
  apiVersion: 1, key: "compile-normalize", name: "Normalize", version: "1.0.0", author: {name: "Test"},
  description: "Plain description",
  baseUrl: "http://localhost:9000/",
  models: ["compile-normalize"], fetchMode: "per_task",
  usageSchema: {seconds: {type: "number", unit: "second", description: "Video generation unit price"}},
  auth: "none"
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {}; }
`;
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));
  const uploadMeta = (uploaded.body.data as { meta: Record<string, unknown> }).meta;
  assert.equal(uploadMeta.baseUrl, "http://localhost:9000");
  assert.deepEqual(uploadMeta.description, { en: "Plain description" });
  assert.equal((uploadMeta.usageSchema as Record<string, { description: { en: string } }>).seconds.description.en, "Video generation unit price");
  assert.deepEqual(uploadMeta.auth, { type: "none" });
  assert.deepEqual(uploadMeta.submitResponseTypes, ["json"]);
  assert.deepEqual(uploadMeta.allowedHosts, []);
  assert.deepEqual(uploadMeta.routes, []);

  const detail = await json(new Request("http://local/api/plugin/task/compile-normalize", { headers: auth }), e);
  assert.equal(detail.body.success, true, String(detail.body.message));
  const meta = (detail.body.data as { meta: Record<string, unknown> }).meta;
  assert.equal(meta.baseUrl, "http://localhost:9000");
  assert.deepEqual(meta.description, { en: "Plain description" });
  assert.equal((meta.usageSchema as Record<string, { description: { en: string } }>).seconds.description.en, "Video generation unit price");

  const missingStatus = await json(
    new Request("http://local/api/plugin/task/no-such-plugin/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    }),
    e,
  );
  assert.equal(missingStatus.body.success, false);
  assert.equal(missingStatus.body.message, "record not found");

  const klingUp = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source:
          'export const meta = { apiVersion: 1, key: "kling", name: "Kling Override", version: "1.0.2-del", author: { name: "test" }, models: ["kling-v1"], fetchMode: "per_task", routes: [], protocols: [], allowedHosts: [], auth: { type: "none" } };\nexport function buildSubmitRequest(){return {url:"https://provider.example/submit"}}\nexport function parseSubmitResponse(){return {taskId:"upstream"}}\nexport function buildQueryRequest(){return {url:"https://provider.example"}}\nexport function parseTaskResult(){return {status:"SUCCESS"}}',
      }),
    }),
    e,
  );
  assert.equal(klingUp.body.success, true, String(klingUp.body.message));
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "kling-plugin-ch",
        type: 61,
        key: "plugin-key",
        models: "kling-v1",
        group: "default",
        setting: { task_plugin_key: "kling" },
      }),
    }),
    e,
  );
  const delFactory = await json(
    new Request("http://local/api/plugin/task/kling/versions/1.0.2-del", { method: "DELETE", headers: auth }),
    e,
  );
  assert.equal(delFactory.body.success, true, String(delFactory.body.message));
  assert.equal(delFactory.body.data, null);

  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "norm-plugin-ch",
        type: 61,
        key: "plugin-key-2",
        models: "compile-normalize",
        group: "default",
        setting: { task_plugin_key: "compile-normalize" },
      }),
    }),
    e,
  );
  const delCustom = await json(
    new Request("http://local/api/plugin/task/compile-normalize/versions/1.0.0", { method: "DELETE", headers: auth }),
    e,
  );
  assert.equal(delCustom.body.success, false);
  assert.equal(delCustom.body.message, "task plugin is still in use");
  assert.equal(typeof (delCustom.body.data as { in_flight_count: number }).in_flight_count, "number");
  assert.ok(Array.isArray((delCustom.body.data as { channels: unknown[] }).channels));
});
