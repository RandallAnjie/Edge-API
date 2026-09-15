import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { nowSec } from "../src/constants.js";
import { TOKEN_KEY_CHARS, generateSystemTaskId } from "../src/crypto.js";
import { Store, SystemTaskLockLostError } from "../src/store.js";
import {
  LOG_CLEANUP_BATCH_SIZE,
  SYSTEM_TASK_TYPE_LOG_CLEANUP,
  runPendingLogCleanupSystemTask,
  systemTaskLockUntil,
} from "../src/system-task.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.SystemTaskResponse` JSON tags (active_key is omitempty). */
const ORIGINAL_SYSTEM_TASK_JSON_FIELDS = [
  "id",
  "task_id",
  "type",
  "status",
  "payload",
  "state",
  "result",
  "error",
  "locked_by",
  "created_at",
  "updated_at",
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

function assertOriginalSystemTaskFields(row: Record<string, unknown>, extra: string[] = []) {
  for (const key of ORIGINAL_SYSTEM_TASK_JSON_FIELDS) {
    assert.ok(key in row, `missing SystemTaskResponse field ${key}`);
  }
  for (const key of extra) {
    assert.ok(key in row, `missing SystemTaskResponse field ${key}`);
  }
}

test("original StartLogCleanupTask SystemTaskResponse JSON is pending with active_key", async () => {
  const { e, auth, store } = await boot();
  for (let i = 0; i < 5; i++) {
    await store.insertLog({ created_at: 1, content: "old-" + i, username: "root" });
  }
  await store.insertLog({ created_at: 99, content: "keep", username: "root" });

  const missing = await json(new Request("http://local/api/system-task/log-cleanup", { method: "POST", headers: auth }), e);
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "target timestamp is required");

  const created = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.equal(created.body.message, "");
  const task = created.body.data as Record<string, unknown>;
  assertOriginalSystemTaskFields(task, ["active_key"]);
  assert.equal(typeof task.id, "number");
  assert.ok(Number(task.id) > 0);
  assert.match(String(task.task_id), new RegExp(`^systask_[${TOKEN_KEY_CHARS}]{32}$`));
  assert.equal(task.type, "log_cleanup");
  assert.equal(task.status, "pending");
  assert.equal(task.active_key, "log_cleanup");
  assert.equal(task.error, "");
  assert.equal(task.locked_by, "");
  assert.equal(task.result, null);
  const payload = task.payload as { target_timestamp: number; batch_size: number };
  assert.equal(payload.target_timestamp, 10);
  assert.equal(payload.batch_size, LOG_CLEANUP_BATCH_SIZE);
  const state = task.state as { total: number; processed: number; progress: number; remaining: number };
  assert.deepEqual(state, { total: 0, processed: 0, progress: 0, remaining: 0 });

  const again = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=20", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(again.body.success, true, String(again.body.message));
  const againTask = again.body.data as Record<string, unknown>;
  assert.equal(againTask.task_id, task.task_id);
  assert.equal((againTask.payload as { target_timestamp: number }).target_timestamp, 10);

  const current = await json(new Request("http://local/api/system-task/current?type=log_cleanup", { headers: auth }), e);
  assert.equal(current.body.success, true);
  const currentTask = current.body.data as Record<string, unknown>;
  assert.equal(currentTask.task_id, task.task_id);
  assert.equal(currentTask.active_key, "log_cleanup");

  const byId = await json(new Request("http://local/api/system-task/" + String(task.task_id), { headers: auth }), e);
  assert.equal(byId.body.success, true);
  assert.equal((byId.body.data as { task_id: string }).task_id, task.task_id);

  const missingId = await json(new Request("http://local/api/system-task/systask_missing", { headers: auth }), e);
  assert.equal(missingId.res.status, 404);
  assert.equal(missingId.body.message, "task not found");

  const oldCount = await store.countOldLogs(10);
  assert.equal(oldCount, 5);

  await runPendingLogCleanupSystemTask(store);

  const finished = await json(new Request("http://local/api/system-task/" + String(task.task_id), { headers: auth }), e);
  const done = finished.body.data as Record<string, unknown>;
  assertOriginalSystemTaskFields(done);
  assert.equal(done.status, "succeeded");
  assert.equal("active_key" in done, false);
  assert.equal(done.error, "");
  assert.ok(String(done.locked_by).startsWith("workerd-"));
  const result = done.result as { deleted_count: number };
  assert.equal(result.deleted_count, 5);
  const doneState = done.state as { total: number; processed: number; progress: number; remaining: number };
  assert.equal(doneState.remaining, 0);
  assert.equal(doneState.progress, 100);
  assert.equal(doneState.processed, 5);

  const afterCurrent = await json(new Request("http://local/api/system-task/current?type=log_cleanup", { headers: auth }), e);
  assert.equal(afterCurrent.body.success, true);
  assert.equal(afterCurrent.body.data, null);

  const leftoverLock = await e.DB.prepare("SELECT * FROM system_task_locks WHERE type = ?").bind("log_cleanup").first();
  assert.equal(leftoverLock, null);

  assert.equal(await store.countOldLogs(10), 0);
  const kept = await e.DB.prepare("SELECT COUNT(*) as c FROM request_logs WHERE created_at >= 10").first<{ c: number }>();
  assert.equal(Number(kept?.c || 0), 1);

  const next = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(next.body.success, true, String(next.body.message));
  const nextTask = next.body.data as Record<string, unknown>;
  assert.notEqual(nextTask.task_id, task.task_id);
  assert.equal(nextTask.status, "pending");
  assert.equal(nextTask.active_key, "log_cleanup");
});

test("original ListSystemTasks JSON order is id DESC with default 20 max 100", async () => {
  const { e, auth, store } = await boot();
  for (let i = 0; i < 101; i++) {
    await store.insertSystemTask({
      id: generateSystemTaskId(),
      type: "list_fill_" + i,
      status: "succeeded",
    });
  }
  const listed = await json(new Request("http://local/api/system-task/list", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const items = listed.body.data as Record<string, unknown>[];
  assert.equal(items.length, 20);
  assertOriginalSystemTaskFields(items[0]);
  assert.equal("active_key" in items[0], false);
  const ids = items.map((row) => Number(row.id));
  const sorted = [...ids].sort((a, b) => b - a);
  assert.deepEqual(ids, sorted);

  const five = await json(new Request("http://local/api/system-task/list?limit=5", { headers: auth }), e);
  assert.equal((five.body.data as unknown[]).length, 5);

  const clamped = await json(new Request("http://local/api/system-task/list?limit=200", { headers: auth }), e);
  assert.equal((clamped.body.data as unknown[]).length, 100);

  await store.insertSystemTask({ id: generateSystemTaskId(), type: "newest", status: "succeeded" });
  const after = await json(new Request("http://local/api/system-task/list?limit=1", { headers: auth }), e);
  assert.equal((after.body.data as { type: string }[])[0].type, "newest");
});

test("original log_cleanup runner deletes in logCleanupBatchSize batches", async () => {
  const { e, auth, store } = await boot();
  for (let i = 0; i < 150; i++) {
    await store.insertLog({ created_at: 1, content: "batch-" + i, username: "root" });
  }
  const created = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  await runPendingLogCleanupSystemTask(store);
  const taskId = String((created.body.data as { task_id: string }).task_id);
  const finished = await json(new Request("http://local/api/system-task/" + taskId, { headers: auth }), e);
  const result = (finished.body.data as { result: { deleted_count: number } }).result;
  assert.equal(result.deleted_count, 150);
  assert.equal(await store.countOldLogs(10), 0);
});

test("workerd waitUntil observation runs pending log_cleanup after StartLogCleanupTask", async () => {
  const { e, auth, store } = await boot();
  await store.insertLog({ created_at: 1, content: "waituntil", username: "root" });
  const pending: Promise<unknown>[] = [];
  const res = await handleFetch(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", {
      method: "POST",
      headers: auth,
    }),
    e,
    {
      waitUntil(p) {
        pending.push(p);
      },
    },
  );
  const body = JSON.parse(await res.text()) as { success: boolean; data: { status: string; task_id: string } };
  assert.equal(body.success, true);
  assert.equal(body.data.status, "pending");
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(await store.countOldLogs(10), 0);
  const finished = await json(new Request("http://local/api/system-task/" + body.data.task_id, { headers: auth }), e);
  assert.equal((finished.body.data as { status: string }).status, "succeeded");
  assert.equal("active_key" in (finished.body.data as object), false);
});

test("original SystemTask lock prevents concurrent claim of the same type", async () => {
  const { e, auth, store } = await boot();
  const created = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const firstId = String((created.body.data as { task_id: string }).task_id);
  await store.insertSystemTask({
    id: generateSystemTaskId(),
    type: SYSTEM_TASK_TYPE_LOG_CLEANUP,
    status: "pending",
    active_key: null,
  });
  const first = await store.claimSystemTask(firstId, "runner-a", SYSTEM_TASK_TYPE_LOG_CLEANUP, systemTaskLockUntil());
  assert.ok(first);
  assert.equal(first.status, "running");
  assert.equal(first.locked_by, "runner-a");

  const secondPending = await store.findPendingSystemTask(SYSTEM_TASK_TYPE_LOG_CLEANUP);
  assert.ok(secondPending);
  const secondId = String(secondPending.id);
  const second = await store.claimSystemTask(secondId, "runner-b", SYSTEM_TASK_TYPE_LOG_CLEANUP, systemTaskLockUntil());
  assert.equal(second, null);

  const held = await json(new Request("http://local/api/system-task/" + firstId, { headers: auth }), e);
  const heldTask = held.body.data as Record<string, unknown>;
  assertOriginalSystemTaskFields(heldTask, ["active_key"]);
  assert.equal(heldTask.status, "running");
  assert.equal(heldTask.locked_by, "runner-a");
  assert.equal(heldTask.active_key, SYSTEM_TASK_TYPE_LOG_CLEANUP);

  const blocked = await json(new Request("http://local/api/system-task/" + secondId, { headers: auth }), e);
  const blockedTask = blocked.body.data as Record<string, unknown>;
  assert.equal(blockedTask.status, "pending");
  assert.equal(blockedTask.locked_by, "");
});

test("original expired SystemTask lock fails old run JSON and claims legacy pending", async () => {
  const { e, auth, store } = await boot();
  const created = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  const firstId = String((created.body.data as { task_id: string }).task_id);
  const claimed = await store.claimSystemTask(firstId, "runner-a", SYSTEM_TASK_TYPE_LOG_CLEANUP, nowSec() + 60);
  assert.ok(claimed);
  await e.DB.prepare("UPDATE system_task_locks SET locked_until = ? WHERE task_id = ?")
    .bind(nowSec() - 1, firstId)
    .run();

  const secondId = generateSystemTaskId();
  await store.insertSystemTask({
    id: secondId,
    type: SYSTEM_TASK_TYPE_LOG_CLEANUP,
    status: "pending",
    active_key: null,
  });
  const stolen = await store.claimSystemTask(secondId, "runner-b", SYSTEM_TASK_TYPE_LOG_CLEANUP, systemTaskLockUntil());
  assert.ok(stolen);
  assert.equal(stolen.locked_by, "runner-b");
  assert.equal(String(stolen.id), secondId);

  const expired = await json(new Request("http://local/api/system-task/" + firstId, { headers: auth }), e);
  const expiredTask = expired.body.data as Record<string, unknown>;
  assertOriginalSystemTaskFields(expiredTask);
  assert.equal(expiredTask.status, "failed");
  assert.equal(expiredTask.error, "task lease expired");
  assert.equal("active_key" in expiredTask, false);
  assert.equal(expiredTask.locked_by, "runner-a");

  const current = await json(new Request("http://local/api/system-task/current?type=log_cleanup", { headers: auth }), e);
  const currentTask = current.body.data as Record<string, unknown>;
  assert.equal(currentTask.task_id, secondId);
  assert.equal(currentTask.status, "running");
  assert.equal(currentTask.locked_by, "runner-b");
  assert.equal("active_key" in currentTask, false);
});

test("original ExpireStaleSystemTaskLocks JSON fails old run and allows a new StartLogCleanupTask", async () => {
  const { e, auth, store } = await boot();
  const created = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  const firstId = String((created.body.data as { task_id: string }).task_id);
  assert.ok(await store.claimSystemTask(firstId, "runner-a", SYSTEM_TASK_TYPE_LOG_CLEANUP, nowSec() + 60));
  await e.DB.prepare("UPDATE system_task_locks SET locked_until = ? WHERE task_id = ?")
    .bind(nowSec() - 1, firstId)
    .run();

  await store.expireStaleSystemTaskLocks(nowSec());

  const expired = await json(new Request("http://local/api/system-task/" + firstId, { headers: auth }), e);
  const expiredTask = expired.body.data as Record<string, unknown>;
  assertOriginalSystemTaskFields(expiredTask);
  assert.equal(expiredTask.status, "failed");
  assert.equal(expiredTask.error, "task lease expired");
  assert.equal("active_key" in expiredTask, false);

  const lockCount = await e.DB.prepare("SELECT COUNT(*) as c FROM system_task_locks WHERE task_id = ?")
    .bind(firstId)
    .first<{ c: number }>();
  assert.equal(Number(lockCount?.c || 0), 0);

  const current = await json(new Request("http://local/api/system-task/current?type=log_cleanup", { headers: auth }), e);
  assert.equal(current.body.data, null);

  const next = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=10", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(next.body.success, true, String(next.body.message));
  const nextTask = next.body.data as Record<string, unknown>;
  assert.notEqual(nextTask.task_id, firstId);
  assert.equal(nextTask.status, "pending");
  assert.equal(nextTask.active_key, SYSTEM_TASK_TYPE_LOG_CLEANUP);
});

test("original FinishSystemTask and UpdateSystemTaskState require the held lock", async () => {
  const { store } = await boot();
  const created = await store.createSystemTask(SYSTEM_TASK_TYPE_LOG_CLEANUP, { target_timestamp: 10, batch_size: 100 }, {
    total: 0,
    processed: 0,
    progress: 0,
    remaining: 0,
  });
  const taskId = String(created.id);
  assert.ok(await store.claimSystemTask(taskId, "runner-a", SYSTEM_TASK_TYPE_LOG_CLEANUP, systemTaskLockUntil()));

  await assert.rejects(
    () => store.updateSystemTaskState(taskId, "runner-b", { progress: 10 }),
    SystemTaskLockLostError,
  );
  await assert.rejects(
    () => store.finishSystemTask(taskId, "runner-b", "succeeded", { deleted_count: 0 }, ""),
    SystemTaskLockLostError,
  );

  await store.finishSystemTask(taskId, "runner-a", "succeeded", { deleted_count: 0 }, "");
  const finished = await store.getSystemTask(taskId);
  assert.equal(finished?.status, "succeeded");
  assert.equal(finished?.locked_by, "runner-a");
  assert.equal(finished?.active_key, null);

  await assert.rejects(
    () => store.renewSystemTaskLock(taskId, "runner-a", systemTaskLockUntil()),
    SystemTaskLockLostError,
  );
});
