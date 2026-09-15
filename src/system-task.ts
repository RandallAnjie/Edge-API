/**
 * Original `service.StartLogCleanupTask` / `runLogCleanupTask` on workerd.
 */
import { parseJson } from "./constants.js";
import { getRandomString } from "./crypto.js";
import type { Store } from "./store.js";

export const SYSTEM_TASK_TYPE_LOG_CLEANUP = "log_cleanup";
/** Original `service.logCleanupBatchSize`. */
export const LOG_CLEANUP_BATCH_SIZE = 100;

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

function decodeSystemTaskJSON(raw: unknown): unknown {
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

function taskIdOf(row: Record<string, unknown>): string {
  return String(row.id || row.task_id || "");
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

async function failLogCleanup(store: Store, task: Record<string, unknown>, err: unknown): Promise<void> {
  await store.updateSystemTask(taskIdOf(task), {
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  });
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
export async function runLogCleanupTask(store: Store, task: Record<string, unknown>): Promise<void> {
  const id = taskIdOf(task);
  const payloadRaw = decodeSystemTaskJSON(task.payload) as LogCleanupPayload | null;
  const payload: LogCleanupPayload = {
    target_timestamp: Number(payloadRaw?.target_timestamp || 0),
    batch_size: Number(payloadRaw?.batch_size || 0),
  };
  if (payload.target_timestamp <= 0) {
    await failLogCleanup(store, task, new Error("target timestamp is required"));
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
    await store.updateSystemTask(id, { state: JSON.stringify(state) });
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
      await store.updateSystemTask(id, { state: JSON.stringify(state) });
    }

    if (!progressed) {
      await failLogCleanup(store, task, new Error("no log rows were deleted"));
      return;
    }
  }

  state.remaining = 0;
  state.progress = 100;
  if (state.total < state.processed) state.total = state.processed;
  await store.updateSystemTask(id, { state: JSON.stringify(state) });
  const result: LogCleanupResult = { deleted_count: state.processed };
  await store.updateSystemTask(id, {
    status: "succeeded",
    result: JSON.stringify(result),
    error: "",
  });
}

/** Original runner claim pass for `log_cleanup`. */
export async function runPendingLogCleanupSystemTask(store: Store): Promise<void> {
  const pending = await store.findPendingSystemTask(SYSTEM_TASK_TYPE_LOG_CLEANUP);
  if (!pending) return;
  const runnerId = `workerd-${getRandomString(8)}`;
  const claimed = await store.claimSystemTask(taskIdOf(pending), runnerId);
  if (!claimed) return;
  await runLogCleanupTask(store, claimed);
}
