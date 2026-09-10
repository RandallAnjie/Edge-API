/** Original `middleware.applyOriginTaskIntent` + `taskPluginLegacyPlatforms`. */

import { CHANNEL_ENABLED, CHANNEL_TYPE_TASK_PLUGIN, parseJson, TASK_PLATFORM_SUNO } from "./constants.js";
import {
  originTaskChannelPin,
  type ChannelPin,
} from "./channel-constraint.js";
import type { Store } from "./store.js";

export const MAX_ORIGIN_TASK_IDS = 16;
export const MAX_ORIGIN_TASK_ID_LEN = 128;

export type OriginTaskIntentError = {
  code: string;
  message: string;
  statusCode: number;
};

export type OriginTaskPluginMeta = {
  key: string;
  channelTypes?: number[];
};

/** Original `relaycommon.OriginTaskRef`. */
export type OriginTaskRef = {
  taskId: string;
  upstreamTaskId: string;
  action: string;
  status: string;
  data: unknown;
};

export type ApplyOriginTaskIntentResult = {
  error?: OriginTaskIntentError;
  pin?: ChannelPin;
  tasks?: OriginTaskRef[];
};

function runeCount(s: string): number {
  return [...s].length;
}

function originIntentError(code: string, message: string, statusCode: number): ApplyOriginTaskIntentResult {
  return { error: { code, message, statusCode } };
}

/** Original `middleware.taskPluginLegacyPlatforms`. */
export function taskPluginLegacyPlatforms(meta: OriginTaskPluginMeta): string[] {
  const platforms: string[] = [String(meta.key || "")];
  if (meta.key === "sunoapi") platforms.push(TASK_PLATFORM_SUNO);
  const seen = new Set(platforms);
  for (const raw of meta.channelTypes || []) {
    const channelType = Number(raw);
    if (!channelType || channelType === CHANNEL_TYPE_TASK_PLUGIN) continue;
    const platform = String(channelType);
    if (seen.has(platform)) continue;
    seen.add(platform);
    platforms.push(platform);
  }
  return platforms;
}

function originTaskRefFromRow(row: Record<string, unknown>): OriginTaskRef {
  const taskId = String(row.task_id || "");
  const privateData = parseJson<Record<string, unknown>>(String(row.private_data || ""), {});
  const upstream =
    String(privateData.upstream_task_id || privateData.UpstreamTaskID || "").trim() || taskId;
  let data: unknown = null;
  const raw = row.data;
  if (typeof raw === "string" && raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  } else if (raw != null) {
    data = raw;
  }
  return {
    taskId,
    upstreamTaskId: upstream,
    action: String(row.action || ""),
    status: String(row.status || ""),
    data,
  };
}

/** Original `middleware.applyOriginTaskIntent`. */
export async function applyOriginTaskIntent(
  store: Store,
  userId: number,
  intent: Record<string, unknown> | null | undefined,
  meta: OriginTaskPluginMeta,
): Promise<ApplyOriginTaskIntentResult> {
  if (!intent || !Object.prototype.hasOwnProperty.call(intent, "originTaskIds")) {
    return {};
  }
  const raw = intent.originTaskIds;
  let values: unknown[];
  if (Array.isArray(raw)) values = raw;
  else return originIntentError("invalid_origin_task_ids", "origin task ids are invalid", 400);
  if (values.length > MAX_ORIGIN_TASK_IDS) {
    return originIntentError("invalid_origin_task_ids", "origin task ids are invalid", 400);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      return originIntentError("invalid_origin_task_ids", "origin task ids are invalid", 400);
    }
    const id = value.trim();
    if (!id || runeCount(id) > MAX_ORIGIN_TASK_ID_LEN) {
      return originIntentError("invalid_origin_task_ids", "origin task ids are invalid", 400);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return {};

  const allowed = new Set(taskPluginLegacyPlatforms(meta));
  const tasks: OriginTaskRef[] = [];
  let channelId = 0;
  for (const id of ids) {
    let row: Record<string, unknown> | null = null;
    try {
      row = await store.getTaskByUserAndTid(userId, id);
    } catch {
      return originIntentError("origin_task_not_found", "origin task not found or not owned by you", 500);
    }
    if (!row) {
      return originIntentError("origin_task_not_found", "origin task not found or not owned by you", 400);
    }
    const platform = String(row.platform || "");
    if (!allowed.has(platform)) {
      return originIntentError("origin_task_platform_mismatch", "origin task does not belong to this plugin", 400);
    }
    const taskChannelId = Number(row.channel_id || 0);
    if (!channelId) channelId = taskChannelId;
    else if (taskChannelId !== channelId) {
      return originIntentError("origin_task_channel_conflict", "origin tasks must belong to the same channel", 400);
    }
    tasks.push(originTaskRefFromRow(row));
  }

  const channel = await store.getChannel(channelId);
  if (!channel || channel.status !== CHANNEL_ENABLED) {
    return originIntentError("origin_task_channel_disabled", "origin task channel is disabled", 400);
  }
  return { pin: originTaskChannelPin(channel.id), tasks };
}
