/**
 * Original `service.RunTaskPollingOnce` / `DispatchPlatformUpdate` /
 * `UpdateBatchTasks` / `UpdateVideoTasks` / `sweepTimedOutTasks` on workerd.
 */
import { resolveBaseUrl } from "./catalog.js";
import { nowSec, parseJson, randomHex } from "./constants.js";
import { compilePlugin, type PluginEngine } from "./jsplugin.js";
import { pickChannelKey } from "./select.js";
import { listRoutingPlugins } from "./task-plugin-factory.js";
import { refundTaskQuota } from "./task-plugin-billing.js";
import {
  applyNativePollToTask,
  buildNativeBatchQueryContext,
  buildNativeBatchQueryDescriptor,
  classifyPollHTTP,
  failNativeTaskInfo,
  failTaskFromPoll,
  fetchNativeQuery,
  getUpstreamTaskID,
  isNativeQueryError,
  isNonTerminalPollStatus,
  knownPollStatus,
  parseNativeBatchResult,
  persistNativePollUpdate,
  recordPollFailure,
  refreshNativeQueryTask,
  TASK_STATUS_FAILURE,
  TASK_STATUS_UNKNOWN,
} from "./task-plugin-query.js";
import type { Store } from "./store.js";

/** Original `constant.TaskQueryLimit` default. */
export const TASK_QUERY_LIMIT = 1000;
/** Original `constant.TaskTimeoutMinutes` default. */
export const TASK_TIMEOUT_MINUTES = 1440;
/** Original `model.TaskRefundLegacyCutoff` 2026-02-22 00:00:00 UTC. */
export const TASK_REFUND_LEGACY_CUTOFF = 1771718400;
export const SYSTEM_TASK_TYPE_ASYNC_TASK_POLL = "async_task_poll";
export const TASK_PLATFORM_MIDJOURNEY = "mj";

/** Original `service.TaskPollSummary`. */
export type TaskPollSummary = {
  unfinished_tasks: number;
  platforms_scanned: number;
  null_tasks_failed: number;
};

function pluginMeta(engine: PluginEngine): Record<string, unknown> {
  try {
    const meta = engine.export("meta");
    return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowId(row: Record<string, unknown>): number {
  return Number(row.id || 0);
}

async function sweepTimedOutTasks(store: Store): Promise<void> {
  if (TASK_TIMEOUT_MINUTES <= 0) return;
  const cutoff = nowSec() - TASK_TIMEOUT_MINUTES * 60;
  const tasks = await store.listTimedOutUnfinishedTasks(cutoff, 100);
  if (!tasks.length) return;
  const reason = `任务超时（${TASK_TIMEOUT_MINUTES}分钟）`;
  const legacyReason = "任务超时（旧系统遗留任务，不进行退款，请联系管理员）";
  const now = nowSec();
  for (const task of tasks) {
    const submitTime = Number(task.submit_time || 0);
    const isLegacy = submitTime > 0 && submitTime < TASK_REFUND_LEGACY_CUTOFF;
    const oldStatus = String(task.status || "");
    const next = { ...task };
    next.status = TASK_STATUS_FAILURE;
    next.progress = "100%";
    next.finish_time = now;
    next.fail_reason = isLegacy ? legacyReason : reason;
    next.updated_at = now;
    const patch: Record<string, unknown> = {
      status: TASK_STATUS_FAILURE,
      progress: "100%",
      fail_reason: next.fail_reason,
      finish_time: next.finish_time,
      updated_at: now,
    };
    if (isLegacy) {
      next.quota = 0;
      patch.quota = 0;
    }
    const won = await store.updateTaskByTidIfStatus(String(task.task_id || ""), oldStatus, patch);
    if (!won) continue;
    if (!isLegacy && Number(task.quota || 0) !== 0) {
      const persisted = (await store.getTaskByTid(String(task.task_id || ""))) || next;
      await refundTaskQuota(store, persisted, reason);
    }
  }
}

async function engineForPlatform(
  plugins: Awaited<ReturnType<typeof listRoutingPlugins>>,
  cache: Map<string, PluginEngine>,
  platform: string,
): Promise<PluginEngine | null> {
  if (cache.has(platform)) return cache.get(platform) || null;
  const plugin = plugins.find((item) => item.key === platform);
  if (!plugin?.source) return null;
  try {
    const loaded = compilePlugin(plugin.source, { key: plugin.key, version: String(plugin.meta.version || "") });
    cache.set(platform, loaded.engine);
    return loaded.engine;
  } catch {
    return null;
  }
}

async function updateBatchChannel(opts: {
  store: Store;
  engine: PluginEngine;
  channelId: number;
  tasks: Record<string, unknown>[];
  taskByUpstream: Map<string, Record<string, unknown>>;
}): Promise<void> {
  const channel = await opts.store.getChannel(opts.channelId);
  if (!channel) {
    const ids = opts.tasks.map(rowId).filter((id) => id > 0);
    await opts.store.bulkUpdateTasksByIds(ids, {
      fail_reason: `获取渠道信息失败，请联系管理员，渠道ID：${opts.channelId}`,
      status: TASK_STATUS_FAILURE,
      progress: "100%",
    });
    return;
  }
  const sample = opts.tasks[0];
  const privateData = parseJson<Record<string, unknown>>(String(sample?.private_data || "{}"), {});
  const apiKey = String(privateData.key || pickChannelKey(channel.key || ""));
  const baseUrl = resolveBaseUrl(Number(channel.type || 0), channel.base_url || "");
  const packed = buildNativeBatchQueryContext(opts.engine, opts.tasks, apiKey, baseUrl);
  if (isNativeQueryError(packed)) {
    for (const task of opts.tasks) {
      const failed = recordPollFailure(task, "hook_error", 0, packed.message);
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
    }
    return;
  }
  const descriptor = buildNativeBatchQueryDescriptor(opts.engine, packed.ctx, packed.taskContexts, baseUrl);
  if (isNativeQueryError(descriptor)) {
    for (const task of opts.tasks) {
      const failed = recordPollFailure(task, "hook_error", 0, descriptor.message);
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
    }
    return;
  }
  const fetched = await fetchNativeQuery(descriptor);
  if (isNativeQueryError(fetched)) {
    for (const task of opts.tasks) {
      const failed = recordPollFailure(task, "transport_error", 0, fetched.message);
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
    }
    return;
  }
  const httpClass = classifyPollHTTP(fetched.status);
  if (httpClass === "not_found") {
    const reason = `upstream task not found (HTTP ${fetched.status})`;
    for (const task of opts.tasks) {
      await persistNativePollUpdate({
        store: opts.store,
        previous: task,
        next: failTaskFromPoll(task, reason),
        taskInfo: failNativeTaskInfo(reason),
        engine: opts.engine,
      });
    }
    return;
  }
  if (httpClass === "auth" || httpClass === "transient") {
    for (const task of opts.tasks) {
      const failed = recordPollFailure(task, httpClass, fetched.status, "");
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
    }
    return;
  }
  const parsed = parseNativeBatchResult(opts.engine, packed.ctx, packed.taskContexts, fetched.status, fetched.headers, fetched.body);
  if (isNativeQueryError(parsed)) {
    for (const task of opts.tasks) {
      const failed = recordPollFailure(task, "hook_error", fetched.status, parsed.message);
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
    }
    return;
  }
  const serverAddress = await opts.store.option("ServerAddress");
  for (const [upstreamId, item] of Object.entries(parsed)) {
    const task = opts.taskByUpstream.get(upstreamId);
    if (!task) continue;
    const info = item.taskInfo;
    if (!info.status || info.status === TASK_STATUS_UNKNOWN || !knownPollStatus(info.status)) {
      const failed = recordPollFailure(task, "unrecognized", fetched.status, info.reason || info.status);
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
      continue;
    }
    if (httpClass === "other_client" && isNonTerminalPollStatus(info.status)) {
      const failed = recordPollFailure(task, "unrecognized", fetched.status, info.reason);
      await persistNativePollUpdate({ store: opts.store, previous: task, next: failed, taskInfo: null, engine: opts.engine });
      continue;
    }
    const applied = applyNativePollToTask(task, info, item.data != null ? item.data : {}, serverAddress);
    if (item.data == null) applied.data = task.data;
    if (item.submitTime) applied.submit_time = item.submitTime;
    if (item.startTime) applied.start_time = item.startTime;
    if (item.finishTime) applied.finish_time = item.finishTime;
    if (item.action) applied.action = item.action;
    await persistNativePollUpdate({ store: opts.store, previous: task, next: applied, taskInfo: info, engine: opts.engine });
  }
}

async function dispatchPlatformUpdate(
  store: Store,
  engine: PluginEngine,
  tasks: Record<string, unknown>[],
): Promise<void> {
  const byChannel = new Map<number, Record<string, unknown>[]>();
  const taskByUpstream = new Map<string, Record<string, unknown>>();
  for (const task of tasks) {
    const channelId = Number(task.channel_id || 0);
    if (!channelId) continue;
    const list = byChannel.get(channelId) || [];
    list.push(task);
    byChannel.set(channelId, list);
    taskByUpstream.set(getUpstreamTaskID(task), task);
  }
  const fetchMode = String(pluginMeta(engine).fetchMode || "per_task");
  if (fetchMode === "batch") {
    for (const [channelId, channelTasks] of byChannel) {
      await updateBatchChannel({
        store,
        engine,
        channelId,
        tasks: channelTasks,
        taskByUpstream,
      });
    }
    return;
  }
  for (const channelTasks of byChannel.values()) {
    for (const task of channelTasks) {
      await refreshNativeQueryTask({ store, engine, row: task });
    }
  }
}

/** Original `service.RunTaskPollingOnce`. */
export async function runTaskPollingOnce(store: Store): Promise<TaskPollSummary> {
  const summary: TaskPollSummary = { unfinished_tasks: 0, platforms_scanned: 0, null_tasks_failed: 0 };
  await sweepTimedOutTasks(store);
  const allTasks = await store.listUnfinishedSyncTasks(TASK_QUERY_LIMIT);
  summary.unfinished_tasks = allTasks.length;
  const byPlatform = new Map<string, Record<string, unknown>[]>();
  for (const task of allTasks) {
    const platform = String(task.platform || "");
    const list = byPlatform.get(platform) || [];
    list.push(task);
    byPlatform.set(platform, list);
  }
  const plugins = await listRoutingPlugins(store);
  const engines = new Map<string, PluginEngine>();
  for (const [platform, tasks] of byPlatform) {
    if (platform === TASK_PLATFORM_MIDJOURNEY) continue;
    if (!tasks.length) continue;
    summary.platforms_scanned++;
    const nullIds: number[] = [];
    const live: Record<string, unknown>[] = [];
    for (const task of tasks) {
      if (!getUpstreamTaskID(task)) {
        const id = rowId(task);
        if (id) nullIds.push(id);
        continue;
      }
      live.push(task);
    }
    if (nullIds.length) {
      summary.null_tasks_failed += nullIds.length;
      await store.bulkUpdateTasksByIds(nullIds, { status: TASK_STATUS_FAILURE, progress: "100%" });
    }
    if (!live.length) continue;
    const engine = await engineForPlatform(plugins, engines, platform);
    if (!engine) continue;
    await dispatchPlatformUpdate(store, engine, live);
  }
  return summary;
}

/** Original `async_task_poll` system-task runner. */
export async function runPendingAsyncTaskPoll(store: Store): Promise<TaskPollSummary | null> {
  const pending = await store.currentSystemTask(SYSTEM_TASK_TYPE_ASYNC_TASK_POLL);
  if (pending && String(pending.status) === "pending") {
    const id = String(pending.id || pending.task_id || "");
    await store.updateSystemTask(id, { status: "running" });
    try {
      const summary = await runTaskPollingOnce(store);
      await store.updateSystemTask(id, { status: "succeeded", result: JSON.stringify(summary) });
      return summary;
    } catch (err) {
      await store.updateSystemTask(id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  if (!(await store.hasUnfinishedSyncTasks())) return null;
  const id = "systask_" + randomHex(16);
  await store.insertSystemTask({ id, type: SYSTEM_TASK_TYPE_ASYNC_TASK_POLL, status: "running" });
  try {
    const summary = await runTaskPollingOnce(store);
    await store.updateSystemTask(id, { status: "succeeded", result: JSON.stringify(summary) });
    return summary;
  } catch (err) {
    await store.updateSystemTask(id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
