import assert from "node:assert/strict";
import { test } from "node:test";
import { runTaskPollingOnce } from "../src/task-plugin-poll.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
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

async function listedTask(e: Env, auth: Record<string, string>, taskId: string) {
  const listed = await json(new Request("http://local/api/task?task_id=" + encodeURIComponent(taskId), { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const items = (listed.body.data as { items: Record<string, unknown>[] }).items;
  return items.find((item) => String(item.task_id) === taskId);
}

test("original UpdateVideoTasks missing channel fail_reason JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const taskId = "task_missing_channel_per_task";
  await store.insertTask({
    task_id: taskId,
    user_id: root.id,
    channel_id: 99999,
    platform: "sora",
    action: "GENERATE",
    status: "IN_PROGRESS",
    progress: "10%",
    model_name: "sora-2",
    private_data: { upstream_task_id: "upstream-sora-1" },
  });
  const summary = await runTaskPollingOnce(store);
  assert.equal(summary.unfinished_tasks, 1);
  assert.equal(summary.platforms_scanned, 1);
  const row = await listedTask(e, auth, taskId);
  assert.ok(row, "missing GET /api/task item");
  assert.equal(row.status, "FAILURE");
  assert.equal(row.progress, "100%");
  assert.equal(row.fail_reason, "Failed to get channel info, channel ID: 99999");
  assert.equal(row.channel_id, 99999);
});

test("original UpdateBatchTasks missing channel fail_reason JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const taskId = "task_missing_channel_batch";
  await store.insertTask({
    task_id: taskId,
    user_id: root.id,
    channel_id: 4242,
    platform: "sunoapi",
    action: "MUSIC",
    status: "IN_PROGRESS",
    progress: "20%",
    model_name: "suno_music",
    private_data: { upstream_task_id: "upstream-suno-1" },
  });
  const summary = await runTaskPollingOnce(store);
  assert.equal(summary.unfinished_tasks, 1);
  assert.equal(summary.platforms_scanned, 1);
  const row = await listedTask(e, auth, taskId);
  assert.ok(row, "missing GET /api/task item");
  assert.equal(row.status, "FAILURE");
  assert.equal(row.progress, "100%");
  assert.equal(row.fail_reason, "获取渠道信息失败，请联系管理员，渠道ID：4242");
  assert.equal(row.channel_id, 4242);
});
