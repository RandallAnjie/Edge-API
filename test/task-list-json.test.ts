import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `dto.TaskDto` JSON tags from GetAllTask / GetUserTask. */
const ORIGINAL_TASK_JSON_FIELDS = [
  "id",
  "created_at",
  "updated_at",
  "task_id",
  "platform",
  "user_id",
  "group",
  "channel_id",
  "quota",
  "action",
  "status",
  "fail_reason",
  "submit_time",
  "start_time",
  "finish_time",
  "progress",
  "properties",
  "data",
] as const;

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

async function loginAs(e: Env, username: string) {
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "password12" }),
    }),
    e,
  );
  assert.equal(login.body.success, true, String(login.body.message));
  return {
    authorization: "Bearer " + (login.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
}

function pageItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return ((body.data as { items?: Record<string, unknown>[] })?.items || []);
}

test("original GetAllTask / GetUserTask TaskDto JSON and channel_id Omit", async () => {
  const { e, auth, store } = await boot();
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "taskuser", password: "password12", role: 1 }),
    }),
    e,
  );
  const user = await store.getUserByUsername("taskuser");
  assert.ok(user);

  await store.insertTask({
    task_id: "task_older",
    user_id: user.id,
    channel_id: 77,
    group: "default",
    quota: 9,
    platform: "suno",
    action: "MUSIC",
    status: "IN_PROGRESS",
    progress: "40%",
    fail_reason: "",
    properties: { input: "make a song", origin_model_name: "suno-v4" },
    data: { clips: 1 },
    private_data: {
      result_url: "https://cdn.example/song.mp3",
      execution: {
        request_id: "req-task",
        request_path: "/suno/submit",
        task_plugin: { key: "suno", name: "Suno", version: "1.0.0", api_version: 1, generation: 3, author: { name: "QN" } },
      },
      upstream_task_id: "up-task",
      node_name: "edge-api",
    },
  });
  await store.insertTask({
    task_id: "task_success_data_url",
    user_id: user.id,
    channel_id: 77,
    group: "vip",
    quota: 4,
    platform: "kling",
    action: "generate",
    status: "SUCCESS",
    progress: "100%",
    fail_reason: "data:video/mp4;base64,ZGF0YQ==",
    properties: { input: "" },
    data: {},
    private_data: { result_url: "https://cdn.example/secret.mp4" },
  });

  const listed = await json(new Request("http://local/api/task?page_size=100", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const data = listed.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(data.page, 1);
  assert.equal(data.page_size, 100);
  assert.equal(data.total, 2);
  const items = data.items;
  assert.equal(items[0].task_id, "task_success_data_url");
  assert.equal(items[1].task_id, "task_older");
  const adminRow = items[1];
  for (const field of ORIGINAL_TASK_JSON_FIELDS) {
    assert.ok(field in adminRow, "missing original TaskDto field " + field);
  }
  assert.equal(adminRow.username, "taskuser");
  assert.equal(adminRow.channel_id, 77);
  assert.equal(adminRow.action, "MUSIC");
  assert.equal(adminRow.result_url, "https://cdn.example/song.mp3");
  assert.equal((adminRow.properties as { input: string; origin_model_name: string }).input, "make a song");
  assert.equal((adminRow.properties as { origin_model_name: string }).origin_model_name, "suno-v4");
  assert.equal((adminRow.admin_info as { request_id: string }).request_id, "req-task");
  assert.equal((adminRow.root_info as { upstream_task_id: string }).upstream_task_id, "up-task");
  assert.equal((adminRow.root_info as { task_plugin: { generation: number } }).task_plugin.generation, 3);

  const success = items[0];
  assert.equal(success.action, "image_to_video");
  assert.equal(success.fail_reason, "", "SUCCESS data: fail_reason is a legacy result URL");
  assert.equal("result_url" in success, false, "SUCCESS TaskDto ResultURL is cleared");
  assert.equal(success.channel_id, 77);
  assert.equal(success.username, "taskuser");

  const byChannel = await json(new Request("http://local/api/task?channel_id=77&page_size=100", { headers: auth }), e);
  assert.equal(pageItems(byChannel.body).length, 2);
  const byPlatform = await json(new Request("http://local/api/task?platform=suno&page_size=100", { headers: auth }), e);
  assert.equal(pageItems(byPlatform.body).length, 1);
  assert.equal(pageItems(byPlatform.body)[0].task_id, "task_older");

  const userAuth = await loginAs(e, "taskuser");
  const self = await json(new Request("http://local/api/task/self?page_size=100", { headers: userAuth }), e);
  assert.equal(self.body.success, true, String(self.body.message));
  const selfItems = pageItems(self.body);
  assert.equal(selfItems.length, 2);
  for (const row of selfItems) {
    for (const field of ORIGINAL_TASK_JSON_FIELDS) {
      assert.ok(field in row, "self missing original TaskDto field " + field);
    }
    assert.equal(row.channel_id, 0, "GetUserTask Omits channel_id");
    assert.equal("username" in row, false);
    assert.equal("admin_info" in row, false);
    assert.equal("root_info" in row, false);
  }
  assert.equal(selfItems[1].result_url, "https://cdn.example/song.mp3");
  assert.equal(selfItems[0].fail_reason, "");
  assert.equal("result_url" in selfItems[0], false);

  const selfChannel = await json(
    new Request("http://local/api/task/self?channel_id=77&page_size=100", { headers: userAuth }),
    e,
  );
  assert.equal(pageItems(selfChannel.body).length, 2, "GetUserTask does not filter channel_id");
});
