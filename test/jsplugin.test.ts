import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  compile,
  compilePlugin,
  dryRunPlugin,
  HookError,
  validateRequestURL,
} from "../src/jsplugin.js";
import { FACTORY_TASK_PLUGIN_KEYS, FACTORY_TASK_PLUGIN_SOURCES } from "../src/task-plugin-factory-data.js";
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

const dryRunPluginSource = `
export const meta = {apiVersion: 1, key: "dryrun-probe", name: "DryRun", version: "1.0.0", author: {name: "Test"}, models: ["doc-1"], fetchMode: "per_task"};
export function buildSubmitRequest(payload) {
	if (!payload || !payload.model) { throw new Error("model required"); }
	return {model: payload.model};
}
export function parseSubmitResponse() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseTaskResult() { return {}; }
export const native = { info: function(ctx, task) { return "task:" + task.id; } };
`;

test("original jsplugin Engine.Call JSON: utils, forbidden syntax, HookError, CallMember own properties", () => {
  const logs: string[] = [];
  const engine = compile(
    `
export function sign(ctx) {
  console.log("called", ctx.name);
  return {
    now: utils.unixNow(),
    digest: utils.hmacSHA256(ctx.message, ctx.secret),
    encoded: utils.base64(ctx.message),
  };
}
export const meta = { apiVersion: 1, key: "mock" };
`,
    {
      key: "mock",
      version: "1.0.0",
      now: () => new Date(1234 * 1000),
      log: (message) => logs.push(message),
    },
  );
  const result = engine.call("sign", { name: "fixture", message: "hello", secret: "secret" }) as Record<string, unknown>;
  assert.deepEqual(result, {
    now: 1234,
    digest: "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
    encoded: "aGVsbG8=",
  });
  assert.deepEqual(logs, ["[plugin:mock@1.0.0] called fixture"]);
  assert.deepEqual(engine.export("meta"), { apiVersion: 1, key: "mock" });

  for (const source of [
    `export async function run() {}`,
    `import value from "dependency"; export function run() { return value; }`,
    `export function run() { return import("dependency"); }`,
    `const value = await work(); export function run() { return value; }`,
  ]) {
    assert.throws(() => compile(source, { key: "invalid" }), /unsupported plugin syntax/);
  }
  compile(`export function run() { return "import async await"; }`, { key: "valid" });

  const hookEngine = compile(`export function run() { throw new Error("model is required"); }`, { key: "diag", version: "1.0.0" });
  assert.throws(
    () => hookEngine.call("run"),
    (err: unknown) => {
      assert.ok(err instanceof HookError);
      assert.equal(err.hook, "run");
      assert.equal(err.jsMessage, "model is required");
      assert.match(err.message, /plugin diag@1.0.0/);
      assert.equal(err.jsMessage.includes("Error:"), false);
      return true;
    },
  );

  const control = compile("export function run() { throw new Error(\"line1\\nline2\\x1b[31mred\"); }", { key: "diag", version: "1.0.0" });
  try {
    control.call("run");
    assert.fail("expected HookError");
  } catch (err) {
    assert.ok(err instanceof HookError);
    assert.equal(err.jsMessage, "line1 line2 [31mred");
  }

  const long = compile(`export function run() { throw new Error("x".repeat(2000)); }`, { key: "diag", version: "1.0.0" });
  try {
    long.call("run");
    assert.fail("expected HookError");
  } catch (err) {
    assert.ok(err instanceof HookError);
    assert.equal([...err.jsMessage].length, 512);
  }

  const own = compile(
    `
const inheritedRenderers = {
	inherited: function(value) { return value; },
	constructor: function(value) { return value; },
	toString: function(value) { return value; },
	["__proto__"]: function(value) { return value; },
};
export const renderers = Object.create(inheritedRenderers);
renderers.own = function(value) { return {id: value.id}; };
`,
    { key: "own-hooks", version: "1.0.0" },
  );
  assert.equal(own.hasCallablePath("renderers", "own"), true);
  assert.deepEqual(own.callMember("renderers", "own", { id: "task-1" }), { id: "task-1" });
  for (const member of ["inherited", "constructor", "toString", "__proto__"]) {
    assert.equal(own.hasCallablePath("renderers", member), false);
    assert.throws(() => own.callMember("renderers", member), /not found/);
  }

  const live = compile(
    `
export let run = function(){return 1;};
export const native = {render:function(){return 1;}};
export function replace(){run=function(){return 2;};native.render=function(){return 3;};}
`,
    { key: "live" },
  );
  assert.equal(live.call("run"), 1);
  live.call("replace");
  assert.equal(live.call("run"), 2);
  assert.equal(live.callMember("native", "render"), 3);

  const cloned = compile(
    `
export function clone(input) {
  const result = utils.json.clone(input);
  result.items.push({text:"appended"});
  result.items[0].text = "changed";
  return {result, array:Array.isArray(result.items),
    prototype:Object.getPrototypeOf(result) === Object.prototype,
    ownProto:Object.prototype.hasOwnProperty.call(result,"__proto__"),
    available:utils.hasCapability("json-clone@1"), unavailable:utils.hasCapability("json-clone@2")};
}
`,
  );
  const input = JSON.parse('{"items":[{"text":"original"}],"__proto__":{"marker":"data"},"zero":0}') as {
    items: { text: string }[];
    zero: number;
  };
  input.zero = -0;
  const cloneResult = cloned.call("clone", input) as Record<string, unknown>;
  assert.equal(cloneResult.array, true);
  assert.equal(cloneResult.prototype, true);
  assert.equal(cloneResult.ownProto, true);
  assert.equal(cloneResult.available, true);
  assert.equal(cloneResult.unavailable, false);
  const resultObj = cloneResult.result as { items: unknown; zero: number };
  assert.deepEqual(resultObj.items, [{ text: "changed" }, { text: "appended" }]);
  assert.deepEqual((resultObj as { __proto__?: unknown }).__proto__, { marker: "data" });
  assert.equal(Object.is(resultObj.zero, -0), true);
  assert.deepEqual(input.items, [{ text: "original" }]);
});

test("original jsplugin json.clone rejects non-JSON values", () => {
  const engine = compile(`
export function invalid(kind) {
  let value;
  switch(kind) {
    case "cycle": value={}; value.self=value; break;
    case "function": value={run:function(){}}; break;
    case "undefined": value={missing:undefined}; break;
    case "nan": value=NaN; break;
    case "bigint": value=1n; break;
    case "date": value=new Date(); break;
    case "sparse": value=[,1]; break;
    case "size": value="<".repeat(200000); break;
    case "nodes": value=new Array(32768).fill(0); break;
  }
  return utils.json.clone(value);
}`);
  for (const kind of ["cycle", "function", "undefined", "nan", "bigint", "date", "sparse", "size", "nodes"]) {
    assert.throws(() => engine.call("invalid", kind));
  }
});

test("original DryRunTaskPlugin Call JSON fields", async () => {
  const { e, auth } = await boot();
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: dryRunPluginSource }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));

  const hook = await json(
    new Request("http://local/api/plugin/task/dryrun-probe/dryrun", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hook: "buildSubmitRequest", args: [{ model: "doc-1" }] }),
    }),
    e,
  );
  assert.equal(hook.body.success, true, String(hook.body.message));
  assert.deepEqual(hook.body.data, { model: "doc-1" });

  const member = await json(
    new Request("http://local/api/plugin/task/dryrun-probe/dryrun", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hook: "native", member: "info", args: [{}, { id: "t-1" }] }),
    }),
    e,
  );
  assert.equal(member.body.success, true, String(member.body.message));
  assert.equal(member.body.data, "task:t-1");

  const missing = await json(
    new Request("http://local/api/plugin/task/dryrun-probe/dryrun", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hook: "missingHook" }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.match(String(missing.body.message), /plugin export "missingHook" not found/);

  const malformed = await json(
    new Request("http://local/api/plugin/task/dryrun-probe/dryrun", {
      method: "POST",
      headers: auth,
      body: `{"hook":"buildSubmitRequest","args":[{`,
    }),
    e,
  );
  assert.equal(malformed.body.success, false);

  const rejected = await json(
    new Request("http://local/api/plugin/task/dryrun-probe/dryrun", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hook: "buildSubmitRequest", args: [{}] }),
    }),
    e,
  );
  assert.equal(rejected.body.success, false);
  assert.match(String(rejected.body.message), /model required/);
  assert.match(String(rejected.body.message), /plugin dryrun-probe@1.0.0/);

  const factory = await json(
    new Request("http://local/api/plugin/task/kling/dryrun", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hook: "buildSubmitRequest", args: [{ model: "kling-v1", requestBody: { prompt: "cat" }, baseUrl: "https://api.example.com", apiKey: "ak|sk" }] }),
    }),
    e,
  );
  assert.equal(factory.body.success, true, String(factory.body.message));
  const factoryData = factory.body.data as Record<string, unknown>;
  assert.equal(typeof factoryData.url, "string");
  assert.equal(factoryData.method, "POST");
});

test("original CompilePlugin accepts every factory plugin.js", () => {
  for (const key of FACTORY_TASK_PLUGIN_KEYS) {
    const loaded = compilePlugin(FACTORY_TASK_PLUGIN_SOURCES[key], { key });
    assert.equal((loaded.meta as { key?: string }).key, key, key);
    assert.equal(loaded.engine.hasCallablePath("buildSubmitRequest"), true, key);
  }
});

test("original DryRunTaskPlugin helper JSON", () => {
  const ok = dryRunPlugin(dryRunPluginSource, { hook: "buildSubmitRequest", args: [{ model: "doc-1" }] }, { key: "dryrun-probe" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.data, { model: "doc-1" });
  const missing = dryRunPlugin(dryRunPluginSource, { hook: "missingHook" }, { key: "dryrun-probe" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /plugin export "missingHook" not found/);
});

test("original ValidateRequestURL JSON errors", () => {
  validateRequestURL("https://api.example.com/v1/task", "https://api.example.com/v1");
  validateRequestURL("https://api.example.com:443/v1/task", "https://api.example.com");
  validateRequestURL("https://upload.example.com/task", "https://api.example.com", ["upload.example.com"]);
  assert.throws(() => validateRequestURL("/v1/task", "https://api.example.com"), /absolute/);
  assert.throws(() => validateRequestURL("https://evil.api.example.com/task", "https://api.example.com"), /not allowed/);
});
