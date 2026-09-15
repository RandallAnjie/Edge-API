import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
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

async function boot(e: Env) {
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
  return { token, auth, login };
}

async function insertAbility(
  e: Env,
  group: string,
  model: string,
  channelId: number,
  enabled: number,
): Promise<void> {
  await e.DB.prepare(
    `INSERT INTO abilities ("group", model, channel_id, enabled, priority, weight, tag) VALUES (?, ?, ?, ?, 0, 0, '')`,
  )
    .bind(group, model, channelId, enabled)
    .run();
}

test("original GetEnabledModels / GetUserModels query abilities only", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  const csvOnly = await store.insertChannel({
    name: "csv-only",
    type: 1,
    key: "sk-csv",
    models: "csv-only-model",
    group: "default",
  });
  await e.DB.prepare("DELETE FROM abilities").run();

  const enabledEmpty = await json(new Request("http://local/api/channel/models_enabled", { headers: auth }), e);
  assert.equal(enabledEmpty.body.success, true);
  assert.deepEqual(enabledEmpty.body.data, []);

  const userEmpty = await json(new Request("http://local/api/user/models", { headers: auth }), e);
  assert.equal(userEmpty.body.success, true);
  assert.deepEqual(userEmpty.body.data, []);

  const missingEmpty = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.equal(missingEmpty.body.success, true);
  assert.deepEqual(missingEmpty.body.data, []);

  const ch = await store.getChannel(csvOnly);
  assert.equal(ch?.models, "csv-only-model");

  await insertAbility(e, "default", "zz-default-only-model", 1, 1);
  await insertAbility(e, "default", "zz-disabled-model", 1, 0);
  await insertAbility(e, "vip", "zz-vip-only-model", 1, 1);

  const enabled = await json(new Request("http://local/api/channel/models_enabled", { headers: auth }), e);
  assert.equal(enabled.body.success, true);
  const enabledModels = enabled.body.data as string[];
  assert.ok(Array.isArray(enabledModels));
  assert.equal(enabledModels.includes("zz-default-only-model"), true);
  assert.equal(enabledModels.includes("zz-vip-only-model"), true);
  assert.equal(enabledModels.includes("zz-disabled-model"), false);
  assert.equal(enabledModels.includes("csv-only-model"), false);

  const defaultGroup = await json(new Request("http://local/api/user/models?group=default", { headers: auth }), e);
  assert.deepEqual(defaultGroup.body.data, ["zz-default-only-model"]);

  const vipGroup = await json(new Request("http://local/api/user/models?group=vip", { headers: auth }), e);
  assert.deepEqual(vipGroup.body.data, ["zz-vip-only-model"]);

  const unknownGroup = await json(new Request("http://local/api/user/models?group=does-not-exist", { headers: auth }), e);
  assert.deepEqual(unknownGroup.body.data, []);

  const missing = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  const missingModels = missing.body.data as string[];
  assert.equal(missingModels.includes("zz-default-only-model"), true);
  assert.equal(missingModels.includes("zz-vip-only-model"), true);
  assert.equal(missingModels.includes("zz-disabled-model"), false);
  assert.equal(missingModels.includes("csv-only-model"), false);

  await store.insertModelMeta("zz-default-only-model");
  const missingAfter = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  const missingAfterModels = missingAfter.body.data as string[];
  assert.equal(missingAfterModels.includes("zz-default-only-model"), false);
  assert.equal(missingAfterModels.includes("zz-vip-only-model"), true);
});

test("original GetUserModels expands auto groups in configured order", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  await store.setOption("AutoGroups", JSON.stringify(["vip", "default", "unavailable"]));
  await store.setOption(
    "UserUsableGroups",
    JSON.stringify({ auto: "自动分组", default: "默认分组", unavailable: "不可用分组" }),
  );
  await store.setOption(
    "GroupSpecialUsableGroup",
    JSON.stringify({ default: { "+:vip": "VIP 分组", "-:unavailable": "" } }),
  );

  await insertAbility(e, "vip", "zz-vip-model", 1, 1);
  await insertAbility(e, "vip", "zz-shared-model", 1, 1);
  await insertAbility(e, "default", "zz-default-model", 1, 1);
  await insertAbility(e, "default", "zz-shared-model", 2, 1);
  await insertAbility(e, "unavailable", "zz-unavailable-model", 1, 1);

  const auto = await json(new Request("http://local/api/user/models?group=auto", { headers: auth }), e);
  assert.equal(auto.body.success, true, String(auto.body.message));
  const models = auto.body.data as string[];
  assert.equal(models.length, 3);
  assert.deepEqual([...models.slice(0, 2)].sort(), ["zz-shared-model", "zz-vip-model"]);
  assert.equal(models[2], "zz-default-model");
  assert.equal(models.includes("zz-unavailable-model"), false);
});
