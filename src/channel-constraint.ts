/** Original `model.ChannelSatisfiesFilters` + `dto.ChannelFilter`. */

import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_TASK_PLUGIN,
  parseJson,
} from "./constants.js";
import { advancedCustomConfigFromSettings, matchAdvancedCustomPathForModel } from "./channel-validate.js";

export const FILTER_REQUEST_PATH = "request_path" as const;
export const FILTER_TASK_PLUGIN_IDENTITY = "task_plugin_identity" as const;

export type ChannelFilterKind = typeof FILTER_REQUEST_PATH | typeof FILTER_TASK_PLUGIN_IDENTITY | "";

export type ChannelFilter = {
  kind: ChannelFilterKind;
  requestPath?: string;
  taskPluginKey?: string;
  taskPluginChannelTypes?: number[];
};

export type ChannelFilterSubject = {
  type: number;
  settings?: string;
  setting?: string;
};

const FILTER_EVAL_ORDER: ChannelFilterKind[] = [FILTER_REQUEST_PATH, FILTER_TASK_PLUGIN_IDENTITY];

/** Original `service.GetChannelConstraints` filters added by `middleware.Distribute`. */
export function distributorChannelFilters(
  requestPath: string,
  expectedTaskPluginKey = "",
  taskPluginChannelTypes?: number[],
): ChannelFilter[] {
  return [
    { kind: FILTER_REQUEST_PATH, requestPath },
    {
      kind: FILTER_TASK_PLUGIN_IDENTITY,
      taskPluginKey: expectedTaskPluginKey,
      taskPluginChannelTypes: taskPluginChannelTypes || [],
    },
  ];
}

/** Original `model.pinnedTaskPluginChannelTypes` — skip 0 and type-61. */
export function pinnedTaskPluginChannelTypes(channelTypes: unknown): number[] {
  if (!Array.isArray(channelTypes)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of channelTypes) {
    const n = Number(raw);
    if (!n || n === CHANNEL_TYPE_TASK_PLUGIN) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Original `model.identityFilterRequiresKey`. */
export function identityFilterRequiresKey(filters: ChannelFilter[]): boolean {
  return filters.some((filter) => filter.kind === FILTER_TASK_PLUGIN_IDENTITY && Boolean(filter.taskPluginKey));
}

function channelSettingTaskPluginKey(ch: ChannelFilterSubject): string {
  const setting = parseJson<Record<string, unknown>>(String(ch.setting || ""), {});
  return String(setting.task_plugin_key || setting.TaskPluginKey || "").trim();
}

function channelMatchesFilter(ch: ChannelFilterSubject, modelName: string, filter: ChannelFilter): boolean {
  switch (filter.kind) {
    case FILTER_REQUEST_PATH: {
      if (!filter.requestPath) return true;
      if (ch.type !== CHANNEL_TYPE_ADVANCED_CUSTOM) return true;
      const config = advancedCustomConfigFromSettings(ch.settings);
      return Boolean(config && matchAdvancedCustomPathForModel(config, filter.requestPath, modelName));
    }
    case FILTER_TASK_PLUGIN_IDENTITY: {
      if (ch.type === CHANNEL_TYPE_TASK_PLUGIN) {
        return Boolean(filter.taskPluginKey) && channelSettingTaskPluginKey(ch) === filter.taskPluginKey;
      }
      return !filter.taskPluginKey || Boolean(filter.taskPluginChannelTypes?.includes(ch.type));
    }
    default:
      return true;
  }
}

/** Original `model.ChannelSatisfiesFilters`. */
export function channelSatisfiesFilters(
  ch: ChannelFilterSubject | null | undefined,
  modelName: string,
  filters: ChannelFilter[],
): { ok: boolean; kind: ChannelFilterKind } {
  if (!ch) return { ok: false, kind: "" };
  for (const kind of FILTER_EVAL_ORDER) {
    for (const filter of filters) {
      if (filter.kind !== kind) continue;
      if (!channelMatchesFilter(ch, modelName, filter)) return { ok: false, kind };
    }
  }
  return { ok: true, kind: "" };
}

function filtersByKind(filters: ChannelFilter[], kind: ChannelFilterKind): ChannelFilter[] {
  return filters.filter((filter) => filter.kind === kind);
}

function candidatePassesKindFilters(
  ch: ChannelFilterSubject | undefined,
  exists: boolean,
  modelName: string,
  kind: ChannelFilterKind,
  filters: ChannelFilter[],
): boolean {
  if (kind === FILTER_REQUEST_PATH && !exists) return true;
  if (!exists || !ch) return false;
  for (const filter of filters) {
    if (!channelMatchesFilter(ch, modelName, filter)) return false;
  }
  return true;
}

/** Original `model.filterCandidateIDs`. */
export function filterCandidateIDs(
  ids: number[],
  modelName: string,
  filters: ChannelFilter[],
  channelsById: Map<number, ChannelFilterSubject>,
): { kept: number[]; emptiedBy: ChannelFilterKind } {
  if (!ids.length) return { kept: ids, emptiedBy: "" };
  let kept = ids;
  for (const kind of FILTER_EVAL_ORDER) {
    const kindFilters = filtersByKind(filters, kind);
    if (!kindFilters.length) continue;
    const next: number[] = [];
    for (const id of kept) {
      const channel = channelsById.get(id);
      if (candidatePassesKindFilters(channel, Boolean(channel), modelName, kind, kindFilters)) next.push(id);
    }
    if (kept.length > 0 && next.length === 0) return { kept: next, emptiedBy: kind };
    kept = next;
  }
  return { kept, emptiedBy: "" };
}
