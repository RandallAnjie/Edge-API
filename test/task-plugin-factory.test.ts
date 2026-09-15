import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { pluginMethodNotAllowed } from "../src/http.js";
import {
  FACTORY_TASK_PLUGIN_KEYS,
  FACTORY_TASK_PLUGIN_HASHES,
  FACTORY_TASK_PLUGIN_SOURCES,
} from "../src/task-plugin-factory-data.js";
import { parseTaskPluginDisabledFactoryKeys, normalizeTaskPluginDisabledFactoryKeys } from "../src/task-plugin-factory.js";
import { Store } from "../src/store.js";
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

type ListItem = {
  meta: {
    key: string;
    name: string;
    version: string;
    models: string[];
    routes: { method?: string; path?: string; type?: string; action?: string; render?: string }[];
    protocols: { name?: string; supports?: string[] }[];
    usageSchema?: Record<string, { type?: string; unit?: string }>;
    usageExamples?: unknown[];
    usageProfiles?: unknown[];
    channelTypes?: number[];
    submitResponseTypes?: string[];
    requiredCapabilities?: string[];
  };
  source: string;
  enabled: boolean;
  active: boolean;
  source_hash: string;
  has_icon: boolean;
  remark: string;
  runtime_status: string;
  channel_count: number;
  in_flight_count: number;
  factory_meta?: { key: string };
};

test("original TaskPluginDisabledFactoryKeys parse/normalize JSON", () => {
  assert.deepEqual(parseTaskPluginDisabledFactoryKeys(""), []);
  assert.deepEqual(parseTaskPluginDisabledFactoryKeys("not-json"), []);
  assert.deepEqual(parseTaskPluginDisabledFactoryKeys(`["kling","sora","kling"]`), ["kling", "sora", "kling"]);
  assert.deepEqual(normalizeTaskPluginDisabledFactoryKeys(["kling", "sora", "kling", " hailuo "]), ["hailuo", "kling", "sora"]);
});

test("original factory task-plugin list JSON, options usageSchema, native routes", async () => {
  const { e, auth } = await boot();

  const listed = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const items = listed.body.data as ListItem[];
  assert.deepEqual(
    items.map((p) => p.meta.key),
    [...FACTORY_TASK_PLUGIN_KEYS],
  );
  for (const key of FACTORY_TASK_PLUGIN_KEYS) {
    const item = items.find((p) => p.meta.key === key);
    assert.ok(item, key);
    assert.equal(item!.source, "factory");
    assert.equal(item!.enabled, true);
    assert.equal(item!.active, true);
    assert.equal(item!.runtime_status, "registered");
    assert.equal(item!.source_hash, FACTORY_TASK_PLUGIN_HASHES[key]);
    assert.equal(typeof item!.has_icon, "boolean");
    assert.equal(item!.channel_count, 0);
    assert.equal(item!.in_flight_count, 0);
    assert.ok(item!.meta.models.length >= 1, key);
    assert.ok((item!.meta.usageSchema as object) && Object.keys(item!.meta.usageSchema || {}).length >= 1, key);
    assert.ok(item!.meta.protocols.some((p) => p.name === "openai_responses"));
    const responses = item!.meta.protocols.find((p) => p.name === "openai_responses");
    assert.deepEqual(responses?.supports, ["stream", "sync", "background"]);
    assert.deepEqual(item!.meta.submitResponseTypes, key === "alibaba" ? ["json", "sse"] : ["json"]);
  }

  const kling = items.find((p) => p.meta.key === "kling")!;
  assert.equal(kling.meta.version, "1.0.2");
  assert.deepEqual(
    kling.meta.routes.map((r) => `${r.method} ${r.path}`),
    [
      "POST /kling/v1/videos/text2video",
      "POST /kling/v1/videos/image2video",
      "GET /kling/v1/videos/text2video/:task_id",
      "GET /kling/v1/videos/image2video/:task_id",
    ],
  );
  assert.equal(kling.meta.routes[0].type, "submit");
  assert.equal(kling.meta.routes[0].action, "text_to_video");
  assert.equal(kling.meta.usageSchema?.units?.unit, "credit");
  assert.deepEqual(kling.meta.channelTypes, [50]);

  const sunoapi = items.find((p) => p.meta.key === "sunoapi")!;
  assert.deepEqual(
    sunoapi.meta.routes.map((r) => `${r.method} ${r.path}`),
    ["POST /suno/submit/:action", "POST /suno/fetch", "GET /suno/fetch/:task_id"],
  );

  const doubao = items.find((p) => p.meta.key === "doubao")!;
  assert.deepEqual(doubao.meta.channelTypes, [54, 45]);
  assert.ok(doubao.meta.routes.some((r) => r.path === "/doubao/api/v3/contents/generations/tasks"));

  const jimeng = items.find((p) => p.meta.key === "jimeng")!;
  assert.equal(jimeng.meta.routes[0]?.path, "/jimeng/");

  const alibaba = items.find((p) => p.meta.key === "alibaba")!;
  assert.ok(Array.isArray(alibaba.meta.usageProfiles) && alibaba.meta.usageProfiles.length === 2);
  assert.ok(alibaba.meta.requiredCapabilities);

  const detail = await json(new Request("http://local/api/plugin/task/kling", { headers: auth }), e);
  assert.equal(detail.body.success, true, String(detail.body.message));
  const detailData = detail.body.data as { layer: string; source: string; meta: { key: string; routes: unknown[] }; has_icon: boolean; plugin?: unknown };
  assert.equal(detailData.layer, "factory");
  assert.equal(detailData.meta.key, "kling");
  assert.equal(detailData.source, FACTORY_TASK_PLUGIN_SOURCES.kling);
  assert.equal("plugin" in detailData, false);
  assert.equal(typeof detailData.has_icon, "boolean");
  assert.ok(Array.isArray(detailData.meta.routes) && detailData.meta.routes.length === 4);

  const options = await json(new Request("http://local/api/task_plugin_options", { headers: auth }), e);
  assert.equal(options.body.success, true, String(options.body.message));
  const optionItems = options.body.data as {
    key: string;
    name: string;
    usageSchema?: Record<string, { unit?: string }>;
    usageProfiles?: unknown[];
    channelTypes?: number[];
    hasIcon?: boolean;
    icon?: string;
    models?: string[];
  }[];
  assert.deepEqual(
    optionItems.map((p) => p.key),
    [...FACTORY_TASK_PLUGIN_KEYS],
  );
  const klingOpt = optionItems.find((p) => p.key === "kling")!;
  assert.equal(klingOpt.name, "Kling");
  assert.equal(klingOpt.usageSchema?.units?.unit, "credit");
  assert.deepEqual(klingOpt.channelTypes, [50]);
  assert.equal(typeof klingOpt.hasIcon, "boolean");
  assert.ok(klingOpt.models?.includes("kling-v1"));
  const aliOpt = optionItems.find((p) => p.key === "alibaba")!;
  assert.equal(aliOpt.usageProfiles?.length, 2);

  const ownedMismatch = await handleFetch(new Request("http://local/kling/v1/videos/text2video/task-1", { method: "POST" }), e, ctx());
  assert.equal(ownedMismatch.status, 405);
  assert.equal(await ownedMismatch.text(), "");
  assert.equal(pluginMethodNotAllowed().status, 405);

  const native = await json(
    new Request("http://local/kling/v1/videos/text2video", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "kling-v1", prompt: "a cat" }),
    }),
    e,
  );
  assert.notEqual(native.res.status, 404);
  assert.notEqual(native.text, "Not Found");

  const sunoNative = await json(
    new Request("http://local/suno/submit/music", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ prompt: "song" }),
    }),
    e,
  );
  assert.notEqual(sunoNative.res.status, 404);

  const jimengNative = await json(
    new Request("http://local/jimeng/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ prompt: "clip" }),
    }),
    e,
  );
  assert.notEqual(jimengNative.res.status, 404);

  const off = await json(
    new Request("http://local/api/plugin/task/kling/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    }),
    e,
  );
  assert.equal(off.body.success, true, String(off.body.message));
  assert.equal((off.body.data as { plugin_enabled: boolean }).plugin_enabled, false);

  const listedOff = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const klingOff = (listedOff.body.data as ListItem[]).find((p) => p.meta.key === "kling")!;
  assert.equal(klingOff.source, "factory");
  assert.equal(klingOff.enabled, false);
  assert.equal(klingOff.runtime_status, "disabled");

  const optionsOff = await json(new Request("http://local/api/task_plugin_options", { headers: auth }), e);
  assert.equal((optionsOff.body.data as { key: string }[]).some((p) => p.key === "kling"), false);

  const disabledRaw = await new Store(e.DB).option("TaskPluginDisabledFactoryKeys");
  assert.equal(disabledRaw, `["kling"]`);

  const afterDisable = await handleFetch(new Request("http://local/kling/v1/videos/text2video", { method: "POST" }), e, ctx());
  assert.equal(afterDisable.status, 404);

  const on = await json(
    new Request("http://local/api/plugin/task/kling/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    }),
    e,
  );
  assert.equal(on.body.success, true, String(on.body.message));
  const listedOn = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const klingOn = (listedOn.body.data as ListItem[]).find((p) => p.meta.key === "kling")!;
  assert.equal(klingOn.enabled, true);
  assert.equal(klingOn.runtime_status, "registered");

  const overrideUp = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source:
          'export const meta = { apiVersion: 1, key: "kling", name: "Kling Override", version: "1.0.2-test", author: { name: "test" }, models: ["kling-v1"], fetchMode: "per_task", routes: [], protocols: [], allowedHosts: [], auth: { type: "none" } };\nexport function buildSubmitRequest(){return {url:"https://provider.example/submit"}}\nexport function parseSubmitResponse(){return {taskId:"upstream"}}\nexport function buildQueryRequest(){return {url:"https://provider.example"}}\nexport function parseTaskResult(){return {status:"SUCCESS"}}',
      }),
    }),
    e,
  );
  assert.equal(overrideUp.body.success, true, String(overrideUp.body.message));
  assert.equal((overrideUp.body.data as { layer: string }).layer, "override");
  const listedOv = await json(new Request("http://local/api/plugin/task", { headers: auth }), e);
  const klingOv = (listedOv.body.data as ListItem[]).find((p) => p.meta.key === "kling")!;
  assert.equal(klingOv.source, "override_over_factory");
  assert.equal(klingOv.factory_meta?.key, "kling");
  assert.equal(klingOv.meta.name, "Kling Override");
});

test("original DashboardListModels overlays routing plugin Meta.Models by channelTypes", async () => {
  const { e, auth } = await boot();

  const dash = await json(new Request("http://local/api/models", { headers: auth }), e);
  assert.equal(dash.body.success, true, String(dash.body.message));
  const data = dash.body.data as Record<string, string[]>;
  assert.deepEqual(data["1"], ["sora-2", "sora-2-pro"]);
  assert.deepEqual(data["36"], ["suno_music", "suno_lyrics"]);
  assert.deepEqual(data["50"], ["kling-v1", "kling-v1-6", "kling-v2-master"]);
  assert.deepEqual(data["51"], ["jimeng_vgfm_t2v_l20"]);
  assert.deepEqual(data["52"], ["viduq2", "viduq1", "vidu2.0", "vidu1.5"]);
  assert.deepEqual(data["55"], ["sora-2", "sora-2-pro"]);
  assert.ok(data["17"].includes("wan3.0-video"));
  assert.ok(data["24"].includes("veo-3.0-generate-001"));
  assert.ok(data["45"].includes("doubao-seedance-1-0-pro-250528"));
  assert.ok(data["54"].includes("doubao-seedance-1-0-pro-250528"));
  assert.equal("61" in data, false);

  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: `export const meta = {apiVersion:1,key:"dash-overlay",name:"Dash Overlay",version:"1.0.0",author:{name:"Test"},channelTypes:[1999],models:["dash-overlay-v1"],fetchMode:"per_task",routes:[],protocols:[],allowedHosts:[],auth:{type:"none"}};
export function buildSubmitRequest(){return {url:"https://provider.example/submit"}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
`,
      }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));
  const withOverride = await json(new Request("http://local/api/models", { headers: auth }), e);
  assert.deepEqual((withOverride.body.data as Record<string, string[]>)["1999"], ["dash-overlay-v1"]);
  assert.deepEqual((withOverride.body.data as Record<string, string[]>)["1"], ["sora-2", "sora-2-pro"]);

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "TaskPluginEnabled", value: "false" }),
    }),
    e,
  );
  const disabled = await json(new Request("http://local/api/models", { headers: auth }), e);
  const off = disabled.body.data as Record<string, string[]>;
  assert.ok(off["1"].includes("gpt-4o-mini"));
  assert.equal("50" in off, false);
  assert.equal("1999" in off, false);
});
