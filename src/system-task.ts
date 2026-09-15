/**
 * Original `service.StartLogCleanupTask` / `runLogCleanupTask` on workerd.
 */
import { ERR_SYSTEM_TASK_LOCK_LOST, SYSTEM_TASK_LOCK_TTL_SEC, nowSec, parseJson } from "./constants.js";
import { generateSystemTaskId, getRandomString } from "./crypto.js";
import { SystemTaskLockLostError, type Store } from "./store.js";

export const SYSTEM_TASK_TYPE_LOG_CLEANUP = "log_cleanup";
export const SYSTEM_TASK_TYPE_CHANNEL_TEST = "channel_test";
export const SYSTEM_TASK_TYPE_MODEL_UPDATE = "model_update";
/** Original `service.logCleanupBatchSize`. */
export const LOG_CLEANUP_BATCH_SIZE = 100;
/** Original `service.systemTaskLockTTL`. */
export const SYSTEM_TASK_LOCK_TTL = SYSTEM_TASK_LOCK_TTL_SEC;

export type LogCleanupPayload = {
  target_timestamp: number;
  batch_size: number;
};

export type LogCleanupState = {
  total: number;
  processed: number;
  progress: number;
  remaining: number;
};

export type LogCleanupResult = {
  deleted_count: number;
};

export function decodeSystemTaskJSON(raw: unknown): unknown {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return raw;
  return parseJson(raw, raw);
}

function logCleanupProgress(processed: number, total: number): number {
  if (total <= 0) return 100;
  if (processed <= 0) return 0;
  if (processed >= total) return 100;
  return Math.trunc((processed * 100) / total);
}

function syncLogCleanupStateFromRemaining(state: LogCleanupState, remaining: number): void {
  if (state.total <= 0) {
    state.total = remaining;
    state.processed = 0;
  } else {
    const processedFromRemaining = state.total - remaining;
    if (processedFromRemaining > state.processed) state.processed = processedFromRemaining;
  }
  if (state.processed < 0) state.processed = 0;
  state.remaining = remaining;
  state.progress = logCleanupProgress(state.processed, state.total);
}

export function systemTaskIdOf(row: Record<string, unknown>): string {
  return String(row.id || row.task_id || "");
}

function taskIdOf(row: Record<string, unknown>): string {
  return systemTaskIdOf(row);
}

function isSystemTaskLockLost(err: unknown): boolean {
  return err instanceof SystemTaskLockLostError || (err instanceof Error && err.message === ERR_SYSTEM_TASK_LOCK_LOST);
}

/** Original `service.systemTaskLockUntil`. */
export function systemTaskLockUntil(now = nowSec()): number {
  return now + SYSTEM_TASK_LOCK_TTL_SEC;
}

/** Starts only when awaited / then'd so test no-op `waitUntil` does not run the runner. */
export function lazySystemTaskRun(work: () => Promise<unknown>): Promise<unknown> {
  return {
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve()
        .then(work)
        .then(onFulfilled, onRejected);
    },
  } as Promise<unknown>;
}

async function persistLogCleanupState(store: Store, taskId: string, runnerId: string, state: LogCleanupState): Promise<boolean> {
  try {
    await store.updateSystemTaskState(taskId, runnerId, state);
    await store.renewSystemTaskLock(taskId, runnerId, systemTaskLockUntil());
    return true;
  } catch (err) {
    if (isSystemTaskLockLost(err)) return false;
    throw err;
  }
}

async function failLogCleanup(store: Store, task: Record<string, unknown>, runnerId: string, err: unknown): Promise<void> {
  try {
    await store.finishSystemTask(
      taskIdOf(task),
      runnerId,
      "failed",
      null,
      err instanceof Error ? err.message : String(err),
    );
  } catch (finishErr) {
    if (isSystemTaskLockLost(finishErr)) return;
    throw finishErr;
  }
}

/** Original `service.EnqueueSystemTask`. */
export async function enqueueSystemTask(
  store: Store,
  taskType: string,
  payload: unknown = null,
): Promise<{ task: Record<string, unknown>; created: boolean }> {
  const active = await store.currentSystemTask(taskType);
  if (active) return { task: active, created: false };
  const id = generateSystemTaskId();
  try {
    await store.insertSystemTask({ id, type: taskType, status: "pending", payload });
  } catch {
    const existing = await store.currentSystemTask(taskType);
    if (existing) return { task: existing, created: false };
    throw new Error("create system task failed");
  }
  const row = await store.getSystemTask(id);
  if (row) return { task: row, created: true };
  const existing = await store.currentSystemTask(taskType);
  if (existing) return { task: existing, created: false };
  throw new Error("create system task failed");
}

/** Original `service.runSystemTaskScheduler` for one registered type. */
export async function scheduleSystemTaskIfDue(
  store: Store,
  taskType: string,
  intervalSec: number,
  enabled: boolean,
  payload: unknown = null,
): Promise<void> {
  if (!enabled) return;
  const latest = await store.getLatestSystemTask(taskType);
  if (latest) {
    const status = String(latest.status || "");
    if (status === "pending" || status === "running") return;
    if (nowSec() - Number(latest.updated_at || 0) < intervalSec) return;
  }
  await store.createSystemTask(taskType, payload, null);
}

async function finishClaimedSystemTask(
  store: Store,
  taskId: string,
  runnerId: string,
  status: string,
  result: unknown,
  errorMessage: string,
): Promise<boolean> {
  try {
    await store.finishSystemTask(taskId, runnerId, status, result, errorMessage);
    return true;
  } catch (err) {
    if (isSystemTaskLockLost(err)) return false;
    throw err;
  }
}

/**
 * Original `service.runSystemTaskClaimPass` + `finishSystemTaskHandler` for one type.
 * Run owns the lifecycle: claim with the per-type lock, then FinishSystemTask.
 */
export async function claimAndRunSystemTask<T>(
  store: Store,
  taskType: string,
  run: (task: Record<string, unknown>, runnerId: string) => Promise<T>,
): Promise<T | null> {
  const pending = await store.findPendingSystemTask(taskType);
  if (!pending) return null;
  const runnerId = `workerd-${getRandomString(8)}`;
  const claimed = await store.claimSystemTask(taskIdOf(pending), runnerId, taskType, systemTaskLockUntil());
  if (!claimed) return null;
  const id = taskIdOf(claimed);
  try {
    const result = await run(claimed, runnerId);
    await finishClaimedSystemTask(store, id, runnerId, "succeeded", result ?? null, "");
    return result;
  } catch (err) {
    await finishClaimedSystemTask(
      store,
      id,
      runnerId,
      "failed",
      null,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Original `service.StartLogCleanupTask`. */
export async function startLogCleanupTask(store: Store, targetTimestamp: number): Promise<Record<string, unknown>> {
  if (targetTimestamp <= 0) throw new Error("target timestamp is required");
  const existing = await store.currentSystemTask(SYSTEM_TASK_TYPE_LOG_CLEANUP);
  if (existing) return existing;
  const payload: LogCleanupPayload = {
    target_timestamp: targetTimestamp,
    batch_size: LOG_CLEANUP_BATCH_SIZE,
  };
  const state: LogCleanupState = { total: 0, processed: 0, progress: 0, remaining: 0 };
  return store.createSystemTask(SYSTEM_TASK_TYPE_LOG_CLEANUP, payload, state);
}

/** Original `service.runLogCleanupTask`. */
export async function runLogCleanupTask(store: Store, task: Record<string, unknown>, runnerId: string): Promise<void> {
  const id = taskIdOf(task);
  const payloadRaw = decodeSystemTaskJSON(task.payload) as LogCleanupPayload | null;
  const payload: LogCleanupPayload = {
    target_timestamp: Number(payloadRaw?.target_timestamp || 0),
    batch_size: Number(payloadRaw?.batch_size || 0),
  };
  if (payload.target_timestamp <= 0) {
    await failLogCleanup(store, task, runnerId, new Error("target timestamp is required"));
    return;
  }
  if (payload.batch_size <= 0) payload.batch_size = LOG_CLEANUP_BATCH_SIZE;

  const stateRaw = decodeSystemTaskJSON(task.state) as LogCleanupState | null;
  const state: LogCleanupState = {
    total: Number(stateRaw?.total || 0),
    processed: Number(stateRaw?.processed || 0),
    progress: Number(stateRaw?.progress || 0),
    remaining: Number(stateRaw?.remaining || 0),
  };

  for (;;) {
    const remaining = await store.countOldLogs(payload.target_timestamp);
    syncLogCleanupStateFromRemaining(state, remaining);
    if (!(await persistLogCleanupState(store, id, runnerId, state))) return;
    if (state.remaining === 0) break;

    let progressed = false;
    while (state.remaining > 0) {
      const rowsAffected = await store.deleteOldLogBatch(payload.target_timestamp, payload.batch_size);
      if (rowsAffected === 0) break;
      progressed = true;
      state.processed += rowsAffected;
      if (state.total < state.processed) state.total = state.processed;
      if (state.remaining > rowsAffected) state.remaining -= rowsAffected;
      else state.remaining = 0;
      state.progress = logCleanupProgress(state.processed, state.total);
      if (!(await persistLogCleanupState(store, id, runnerId, state))) return;
    }

    if (!progressed) {
      await failLogCleanup(store, task, runnerId, new Error("no log rows were deleted"));
      return;
    }
  }

  state.remaining = 0;
  state.progress = 100;
  if (state.total < state.processed) state.total = state.processed;
  if (!(await persistLogCleanupState(store, id, runnerId, state))) return;
  const result: LogCleanupResult = { deleted_count: state.processed };
  try {
    await store.finishSystemTask(id, runnerId, "succeeded", result, "");
  } catch (err) {
    if (isSystemTaskLockLost(err)) return;
    throw err;
  }
}

/** Original runner claim pass for `log_cleanup`. */
export async function runPendingLogCleanupSystemTask(store: Store): Promise<void> {
  await store.expireStaleSystemTaskLocks(nowSec());
  const pending = await store.findPendingSystemTask(SYSTEM_TASK_TYPE_LOG_CLEANUP);
  if (!pending) return;
  const runnerId = `workerd-${getRandomString(8)}`;
  const claimed = await store.claimSystemTask(
    taskIdOf(pending),
    runnerId,
    SYSTEM_TASK_TYPE_LOG_CLEANUP,
    systemTaskLockUntil(),
  );
  if (!claimed) return;
  await runLogCleanupTask(store, claimed, runnerId);
}
