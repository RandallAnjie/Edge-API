import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { decodeIconDataURI } from "../src/jsplugin-icon.js";
import { validateV1Meta } from "../src/jsplugin-validate.js";
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
  return { e, auth };
}

/** Original `taskPluginControllerTestSource`. */
function controllerTestSource(key: string, version = "1.0.0"): string {
  return `
export const meta = {apiVersion: 1, key: ${JSON.stringify(key)}, name: "Test", version: ${JSON.stringify(version)}, author: {name: "Test"}, models: ["doc-1"], fetchMode: "per_task"};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {}; }
`;
}

/** Original `taskPluginControllerChannelSource`. */
function controllerChannelSource(key: string, version: string, channelType: number): string {
  return `
export const meta = {apiVersion: 1, key: ${JSON.stringify(key)}, name: "Test", version: ${JSON.stringify(version)}, author: {name: "Test"}, channelTypes: [${channelType}], models: ["doc-1"], fetchMode: "per_task"};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {}; }
`;
}

const PNG_ICON = "data:image/png;base64,iVBORw0KGgo=";
const SVG_ICON =
  "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>`).toString("base64");
const SCRIPT_SVG =
  "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`).toString("base64");

const ORIGINAL_UPLOAD_DETAIL_FIELDS = ["plugin", "meta", "source", "layer", "has_icon"] as const;
const ORIGINAL_PLUGIN_RECORD_FIELDS = ["id", "key", "api_version", "version", "source", "source_hash", "enabled", "active", "created_at", "remark"] as const;

test("original DecodeIconDataURI and ValidateV1Meta JSON constraints", () => {
  const png = decodeIconDataURI(PNG_ICON);
  assert.equal(png.mediaType, "image/png");
  assert.equal(png.data[0], 0x89);
  const svg = decodeIconDataURI(SVG_ICON);
  assert.equal(svg.mediaType, "image/svg+xml");
  assert.throws(() => decodeIconDataURI("data:image/png;base64,aaaa"), /PNG/);
  assert.throws(() => decodeIconDataURI(SCRIPT_SVG), /script/i);
  validateV1Meta({
    apiVersion: 1,
    key: "ok-plugin",
    name: "Ok",
    version: "1.0.0",
    author: { name: "Test" },
    models: ["doc-1"],
    fetchMode: "per_task",
  });
  assert.throws(
    () => validateV1Meta({ apiVersion: 1, key: "ok-plugin", name: "Ok", version: "1.0.0", author: { name: "Test" }, models: [], fetchMode: "per_task" }),
    /at least one model/,
  );
});

test("original UploadTaskPlugin Register rejects meta-only source missing hooks", async () => {
  const { e, auth } = await boot();
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: `export const meta = {apiVersion:1,key:"no-hooks",name:"Test",version:"1.0.0",author:{name:"Test"},models:["doc-1"],fetchMode:"per_task"};`,
      }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, false);
  assert.match(String(uploaded.body.message), /missing required export "buildSubmitRequest"/);
});

test("original UploadTaskPlugin localizes UnknownMetaFieldError", async () => {
  const { e, auth } = await boot();
  const source = `export const meta = { futureField: true };`;
  for (const [language, message] of [
    [
      "en",
      'Plugin metadata contains an unknown field "futureField". If this plugin was downloaded from the official marketplace, it may require a newer version of new-api. Try updating new-api and installing the plugin again.',
    ],
    [
      "zh-CN",
      "插件元数据包含未知字段“futureField”。如果插件来自官方市场，可能需要更高版本的 new-api。请尝试更新 new-api 后重新安装插件。",
    ],
    [
      "zh-TW",
      "外掛中繼資料包含未知欄位「futureField」。如果外掛來自官方市集，可能需要較新版本的 new-api。請嘗試更新 new-api 後重新安裝外掛。",
    ],
  ] as const) {
    const uploaded = await json(
      new Request("http://local/api/plugin/task", {
        method: "POST",
        headers: { ...auth, "accept-language": language },
        body: JSON.stringify({ source }),
      }),
      e,
    );
    assert.equal(uploaded.body.success, false, language);
    assert.equal(uploaded.body.message, message, language);
  }
});

test("original UploadTaskPlugin RejectsMetaViolatingV1Schema", async () => {
  const { e, auth } = await boot();
  const cases = [
    {
      name: "key with uppercase characters",
      meta: `{apiVersion: 1, key: "Bad-Key", name: "Bad", version: "1.0.0", author: {name: "Test"}, models: ["doc-1"], fetchMode: "per_task"}`,
      expected: "plugin meta key must match",
    },
    {
      name: "version that is not semver",
      meta: `{apiVersion: 1, key: "bad-plugin", name: "Bad", version: "one", author: {name: "Test"}, models: ["doc-1"], fetchMode: "per_task"}`,
      expected: "plugin meta version must be semver",
    },
    {
      name: "unsupported fetch mode",
      meta: `{apiVersion: 1, key: "bad-plugin", name: "Bad", version: "1.0.0", author: {name: "Test"}, models: ["doc-1"], fetchMode: "sometimes"}`,
      expected: "plugin meta fetchMode must be per_task or batch",
    },
    {
      name: "empty model list",
      meta: `{apiVersion: 1, key: "bad-plugin", name: "Bad", version: "1.0.0", author: {name: "Test"}, models: [], fetchMode: "per_task"}`,
      expected: "plugin meta models must contain at least one model",
    },
  ];
  for (const testCase of cases) {
    const source = `export const meta = ${testCase.meta};
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
    assert.equal(uploaded.body.success, false, testCase.name);
    assert.match(String(uploaded.body.message), new RegExp(testCase.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), testCase.name);
  }
});

test("original UploadTaskPlugin sourceSha256", async () => {
  const { e, auth } = await boot();
  const source = controllerTestSource("sha256-match");
  const hash = createHash("sha256").update(source).digest("hex");
  const match = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source, sourceSha256: "  " + hash.toUpperCase() + "  " }),
    }),
    e,
  );
  assert.equal(match.body.success, true, String(match.body.message));
  const mismatch = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: controllerTestSource("sha256-mismatch"), sourceSha256: "deadbeef" }),
    }),
    e,
  );
  assert.equal(mismatch.body.success, false);
  assert.equal(mismatch.body.message, "plugin source sha256 mismatch");
  const absent = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: controllerTestSource("sha256-absent") }),
    }),
    e,
  );
  assert.equal(absent.body.success, true, String(absent.body.message));
});

test("original UploadTaskPlugin PreflightRoutingConflict against factory kling channelType 50", async () => {
  const { e, auth } = await boot();
  const rejected = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: controllerChannelSource("preflight-reject", "1.0.0", 50) }),
    }),
    e,
  );
  assert.equal(rejected.body.success, false);
  assert.match(String(rejected.body.message), /channelType 50 conflicts/);
  assert.match(String(rejected.body.message), /kling/);

  const forced = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: controllerChannelSource("preflight-force", "1.0.0", 50), force: true }),
    }),
    e,
  );
  assert.equal(forced.body.success, true, String(forced.body.message));

  const disabled = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: controllerChannelSource("preflight-disabled", "1.0.0", 50), enabled: false }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
});

test("original UploadTaskPlugin DecodeIconDataURI sidecar JSON", async () => {
  const { e, auth } = await boot();
  const key = "icon-sidecar";
  const source = controllerTestSource(key);
  const rejected = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source, icon: SCRIPT_SVG }),
    }),
    e,
  );
  assert.equal(rejected.body.success, false);
  assert.match(String(rejected.body.message), /script/i);
  const pngRejected = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source, icon: "data:image/png;base64,aaaa" }),
    }),
    e,
  );
  assert.equal(pngRejected.body.success, false);
  assert.match(String(pngRejected.body.message), /PNG/);

  const accepted = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source, icon: SVG_ICON }),
    }),
    e,
  );
  assert.equal(accepted.body.success, true, String(accepted.body.message));
  const data = accepted.body.data as Record<string, unknown>;
  for (const field of ORIGINAL_UPLOAD_DETAIL_FIELDS) assert.ok(field in data, "missing taskPluginDetail " + field);
  assert.equal(data.layer, "override");
  assert.equal(data.has_icon, true);
  assert.equal(typeof data.source, "string");
  assert.equal(String(JSON.stringify(data)).includes("base64,"), false, "icon bytes never travel inside detail JSON");
  const plugin = data.plugin as Record<string, unknown>;
  for (const field of ORIGINAL_PLUGIN_RECORD_FIELDS) assert.ok(field in plugin, "missing TaskPlugin " + field);
  assert.equal("icon" in plugin, false);
  const meta = data.meta as Record<string, unknown>;
  assert.equal(meta.key, key);
  assert.equal(meta.apiVersion, 1);
  assert.equal(meta.fetchMode, "per_task");
  assert.ok(Array.isArray(meta.models));
  assert.ok(Array.isArray(meta.routes));
  assert.ok(Array.isArray(meta.protocols));
  assert.ok(Array.isArray(meta.allowedHosts));

  const icon = await json(new Request("http://local/api/plugin/task/" + key + "/icon", { headers: auth }), e);
  assert.equal(icon.res.status, 200);
  assert.equal(icon.res.headers.get("content-type"), "image/svg+xml");
  assert.equal(icon.res.headers.get("x-content-type-options"), "nosniff");
  assert.match(icon.text, /<circle/);
});

test("original ActivateTaskPlugin Register compiles source before activate", async () => {
  const { e, auth } = await boot();
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: controllerTestSource("activate-compile", "1.0.0") }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));
  const missing = await json(
    new Request("http://local/api/plugin/task/activate-compile/activate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ version: "9.9.9" }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "plugin version not found");
  const ok = await json(
    new Request("http://local/api/plugin/task/activate-compile/activate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ version: "1.0.0" }),
    }),
    e,
  );
  assert.equal(ok.body.success, true, String(ok.body.message));
  assert.equal(ok.body.data, null);
});
