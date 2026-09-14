/**
 * Original `controller.runMidjourneyTaskUpdateOnce` + `midjourney_poll` system task.
 */
import { resolveBaseUrl } from "./catalog.js";
import { nowMs, randomHex } from "./constants.js";
import { refundMidjourneyQuota } from "./midjourney-billing.js";
import { pickChannelKey } from "./select.js";
import type { Store } from "./store.js";

export const SYSTEM_TASK_TYPE_MIDJOURNEY_POLL = "midjourney_poll";
/** Original poll: `(nowMs - submitTime) > 3600000`. */
export const MJ_UPSTREAM_TIMEOUT_MS = 3_600_000;

/** Original `controller.midjourneyPollSummary`. */
export type MidjourneyPollSummary = {
  unfinished_tasks: number;
  channels_scanned: number;
  null_tasks_failed: number;
};

type MidjourneyPollItem = {
  id?: string;
  mj_id?: string;
  progress?: string;
  promptEn?: string;
  state?: string;
  submitTime?: number;
  startTime?: number;
  finishTime?: number;
  imageUrl?: string;
  status?: string;
  failReason?: string;
  properties?: unknown;
  buttons?: unknown;
  videoUrl?: string;
  videoUrls?: unknown;
};

function stringifyMaybe(value: unknown, fallback = ""): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/** Original `checkMjTaskNeedUpdate`. */
export function checkMjTaskNeedUpdate(oldTask: Record<string, unknown>, next: MidjourneyPollItem): boolean {
  if (Number(oldTask.code || 0) !== 1) return true;
  if (String(oldTask.progress || "") !== String(next.progress || "")) return true;
  if (String(oldTask.prompt_en || "") !== String(next.promptEn || "")) return true;
  if (String(oldTask.state || "") !== String(next.state || "")) return true;
  if (Number(oldTask.submit_time || 0) !== Number(next.submitTime || 0)) return true;
  if (Number(oldTask.start_time || 0) !== Number(next.startTime || 0)) return true;
  if (Number(oldTask.finish_time || 0) !== Number(next.finishTime || 0)) return true;
  if (String(oldTask.image_url || "") !== String(next.imageUrl || "")) return true;
  if (String(oldTask.status || "") !== String(next.status || "")) return true;
  if (String(oldTask.fail_reason || "") !== String(next.failReason || "")) return true;
  if (String(oldTask.progress || "") !== "100%" && next.failReason) return true;
  if (String(oldTask.video_url || "") !== String(next.videoUrl || "")) return true;
  if (next.videoUrls != null && Array.isArray(next.videoUrls) && next.videoUrls.length > 0) {
    if (String(oldTask.video_urls || "") !== stringifyMaybe(next.videoUrls)) return true;
  } else if (String(oldTask.video_urls || "") !== "") {
    return true;
  }
  return false;
}

async function persistMjPollItem(
  store: Store,
  task: Record<string, unknown>,
  responseItem: MidjourneyPollItem,
): Promise<void> {
  const useTime = nowMs() - Number(task.submit_time || 0);
  if (useTime > MJ_UPSTREAM_TIMEOUT_MS && String(task.progress || "") !== "100%") {
    responseItem.failReason = "上游任务超时（超过1小时）";
    responseItem.status = "FAILURE";
  }
  if (!checkMjTaskNeedUpdate(task, responseItem)) return;
  const preStatus = String(task.status || "");
  let propertiesStr = String(task.properties || "");
  if (responseItem.properties != null) propertiesStr = stringifyMaybe(responseItem.properties);
  let buttonsStr = String(task.buttons || "");
  if (responseItem.buttons != null) buttonsStr = stringifyMaybe(responseItem.buttons);
  let videoUrlsStr = String(task.video_urls || "");
  if (responseItem.videoUrls != null && Array.isArray(responseItem.videoUrls) && responseItem.videoUrls.length > 0) {
    videoUrlsStr = stringifyMaybe(responseItem.videoUrls, "[]");
  } else {
    videoUrlsStr = "";
  }
  const nextProgress = String(responseItem.progress ?? task.progress ?? "");
  const nextStatus = String(responseItem.status ?? task.status ?? "");
  const nextFail = String(responseItem.failReason ?? "");
  let progress = nextProgress;
  let shouldReturnQuota = false;
  if ((progress !== "100%" && nextFail) || (progress === "100%" && nextStatus === "FAILURE")) {
    progress = "100%";
    if (Number(task.quota || 0) !== 0) shouldReturnQuota = true;
  }
  const patch: Record<string, unknown> = {
    code: 1,
    progress,
    prompt_en: String(responseItem.promptEn ?? ""),
    state: String(responseItem.state ?? ""),
    submit_time: Number(responseItem.submitTime || 0),
    start_time: Number(responseItem.startTime || 0),
    finish_time: Number(responseItem.finishTime || 0),
    image_url: String(responseItem.imageUrl ?? ""),
    status: nextStatus,
    fail_reason: nextFail,
    properties: propertiesStr,
    buttons: buttonsStr,
    video_url: String(responseItem.videoUrl ?? ""),
    video_urls: videoUrlsStr,
  };
  const won = await store.updateMjByIdIfStatus(Number(task.id || 0), preStatus, patch);
  if (won && shouldReturnQuota) {
    const persisted = (await store.getMjById(Number(task.id || 0))) || { ...task, ...patch };
    await refundMidjourneyQuota(store, persisted, "构图失败");
  }
}

/** Original `controller.runMidjourneyTaskUpdateOnce`. */
export async function runMidjourneyTaskUpdateOnce(store: Store): Promise<MidjourneyPollSummary> {
  const summary: MidjourneyPollSummary = { unfinished_tasks: 0, channels_scanned: 0, null_tasks_failed: 0 };
  const tasks = await store.listUnfinishedMjTasks();
  if (!tasks.length) return summary;
  summary.unfinished_tasks = tasks.length;
  const taskChannelM = new Map<number, string[]>();
  const taskM = new Map<string, Record<string, unknown>>();
  const nullTaskIds: number[] = [];
  for (const task of tasks) {
    const mjId = String(task.mj_id || "");
    if (!mjId) {
      const id = Number(task.id || 0);
      if (id) nullTaskIds.push(id);
      continue;
    }
    taskM.set(mjId, task);
    const channelId = Number(task.channel_id || 0);
    const list = taskChannelM.get(channelId) || [];
    list.push(mjId);
    taskChannelM.set(channelId, list);
  }
  if (nullTaskIds.length) {
    summary.null_tasks_failed = nullTaskIds.length;
    await store.bulkUpdateMjByIds(nullTaskIds, { status: "FAILURE", progress: "100%" });
  }
  if (!taskChannelM.size) return summary;
  for (const [channelId, taskIds] of taskChannelM) {
    summary.channels_scanned += 1;
    if (!taskIds.length) continue;
    const channel = await store.getChannel(channelId);
    if (!channel) {
      await store.bulkUpdateMjByMjIds(taskIds, {
        fail_reason: `获取渠道信息失败，请联系管理员，渠道ID：${channelId}`,
        status: "FAILURE",
        progress: "100%",
      });
      continue;
    }
    const base = resolveBaseUrl(channel.type, channel.base_url).replace(/\/+$/, "");
    const requestUrl = `${base}/mj/task/list-by-condition`;
    const secret = pickChannelKey(channel.key).replace(/^Bearer\s+/i, "");
    let items: MidjourneyPollItem[] = [];
    try {
      const res = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "mj-api-secret": secret } : {}),
        },
        body: JSON.stringify({ ids: taskIds }),
      });
      if (res.status !== 200) continue;
      const parsed = (await res.json()) as unknown;
      if (!Array.isArray(parsed)) continue;
      items = parsed as MidjourneyPollItem[];
    } catch {
      continue;
    }
    for (const responseItem of items) {
      const mjId = String(responseItem.id || responseItem.mj_id || "");
      const task = taskM.get(mjId);
      if (!task) continue;
      await persistMjPollItem(store, task, responseItem);
    }
  }
  return summary;
}

/** Original `midjourneyPollHandler` system-task runner. */
export async function runPendingMidjourneyPoll(store: Store): Promise<MidjourneyPollSummary | null> {
  const pending = await store.currentSystemTask(SYSTEM_TASK_TYPE_MIDJOURNEY_POLL);
  if (pending && String(pending.status) === "pending") {
    const id = String(pending.id || pending.task_id || "");
    await store.updateSystemTask(id, { status: "running" });
    try {
      const summary = await runMidjourneyTaskUpdateOnce(store);
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
  if (!(await store.hasUnfinishedMjTasks())) return null;
  const id = "systask_" + randomHex(16);
  await store.insertSystemTask({ id, type: SYSTEM_TASK_TYPE_MIDJOURNEY_POLL, status: "running" });
  try {
    const summary = await runMidjourneyTaskUpdateOnce(store);
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
