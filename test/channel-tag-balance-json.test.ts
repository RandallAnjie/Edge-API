import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_TASK_PLUGIN } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original UpdateChannelBalance leftover ApiError gin.H omit data", async () => {
  const { e, auth } = await boot();

  const invalidId = await json(new Request("http://local/api/channel/update_balance/abc", { headers: auth }), e);
  assert.equal(invalidId.res.status, 200);
  omitData(invalidId.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/channel/update_balance/999999", { headers: auth }), e);
  omitData(missing.body, "record not found");

  const pluginId = await addChannel(e, auth, {
    name: "task-plugin-bal",
    type: CHANNEL_TYPE_TASK_PLUGIN,
    key: "plugin-key",
    models: "suno",
    group: "default",
    setting: { task_plugin_key: "suno" },
  });
  const plugin = await json(new Request("http://local/api/channel/update_balance/" + pluginId, { headers: auth }), e);
  omitData(plugin.body, "Task Plugin channels do not support balance queries");

  const multiId = await addChannel(e, auth, {
    name: "multi-bal",
    type: 1,
    key: "sk-a\nsk-b",
    models: "gpt-4o",
    group: "default",
    mode: "multi_to_single",
    multi_key_mode: "random",
  });
  const multi = await json(new Request("http://local/api/channel/update_balance/" + multiId, { headers: auth }), e);
  omitData(multi.body, "多密钥渠道不支持余额查询");
});

test("original ManageMultiKeys leftover gin.H omit data", async () => {
  const { e, auth } = await boot();
  const missing = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel_id: 999999, action: "get_key_status" }),
    }),
    e,
  );
  omitData(missing.body, "渠道不存在");

  const singleId = await addChannel(e, auth, {
    name: "single-key",
    type: 1,
    key: "sk-one",
    models: "gpt-4o",
    group: "default",
  });
  const notMulti = await json(
    new Request("http://local/api/channel/multi_key/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel_id: singleId, action: "get_key_status" }),
    }),
    e,
  );
  omitData(notMulti.body, "该渠道不是多密钥模式");
});
