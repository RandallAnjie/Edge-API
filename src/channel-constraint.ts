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

/** Original `dto.PinSourceToken` / `PinSourceOriginTask`. */
export const PIN_SOURCE_TOKEN = "token" as const;
export const PIN_SOURCE_ORIGIN_TASK = "origin_task" as const;

export type ChannelPinSource = typeof PIN_SOURCE_TOKEN | typeof PIN_SOURCE_ORIGIN_TASK;

/** Original `dto.PinRankToken` / `PinRankOriginTask`. */
export const PIN_RANK_TOKEN = 0;
export const PIN_RANK_ORIGIN_TASK = 10;

/** Original `dto.PinRetrySameChannel` / `PinRetrySingleAttempt` (iota). */
export const PIN_RETRY_SAME_CHANNEL = 0;
export const PIN_RETRY_SINGLE_ATTEMPT = 1;

export type PinRetryMode = typeof PIN_RETRY_SAME_CHANNEL | typeof PIN_RETRY_SINGLE_ATTEMPT;

/** Original `dto.PinRetryMode.Stricter`. */
export function stricterPinRetryMode(a: PinRetryMode, other: PinRetryMode): PinRetryMode {
  if (a === PIN_RETRY_SINGLE_ATTEMPT || other === PIN_RETRY_SINGLE_ATTEMPT) return PIN_RETRY_SINGLE_ATTEMPT;
  return PIN_RETRY_SAME_CHANNEL;
}

/** Original `dto.ChannelPin`. */
export type ChannelPin = {
  channelId: number;
  source: ChannelPinSource;
  rank: number;
  retryMode: PinRetryMode;
};

export function tokenChannelPin(channelId: number): ChannelPin {
  return {
    channelId,
    source: PIN_SOURCE_TOKEN,
    rank: PIN_RANK_TOKEN,
    retryMode: PIN_RETRY_SINGLE_ATTEMPT,
  };
}

export function originTaskChannelPin(channelId: number): ChannelPin {
  return {
    channelId,
    source: PIN_SOURCE_ORIGIN_TASK,
    rank: PIN_RANK_ORIGIN_TASK,
    retryMode: PIN_RETRY_SAME_CHANNEL,
  };
}

/** Original `dto.ChannelConstraints.ResolvedPin`. Lowest Rank wins; same-channel pins merge to stricter RetryMode. */
export function resolvedPin(pins: ChannelPin[] | null | undefined): {
  pin: ChannelPin | null;
  found: boolean;
  overridden: ChannelPin[];
} {
  if (!pins?.length) return { pin: null, found: false, overridden: [] };
  const merged = new Map<number, ChannelPin>();
  const order: number[] = [];
  for (const pin of pins) {
    const existing = merged.get(pin.channelId);
    if (!existing) {
      merged.set(pin.channelId, { ...pin });
      order.push(pin.channelId);
      continue;
    }
    const next: ChannelPin = {
      ...existing,
      retryMode: stricterPinRetryMode(existing.retryMode, pin.retryMode),
    };
    if (pin.rank < existing.rank) {
      next.rank = pin.rank;
      next.source = pin.source;
    }
    merged.set(pin.channelId, next);
  }
  let winner = merged.get(order[0])!;
  for (const channelId of order.slice(1)) {
    const candidate = merged.get(channelId)!;
    if (candidate.rank < winner.rank) winner = candidate;
  }
  const overridden: ChannelPin[] = [];
  for (const channelId of order) {
    const candidate = merged.get(channelId)!;
    if (candidate.channelId !== winner.channelId) overridden.push(candidate);
  }
  return { pin: winner, found: true, overridden };
}

/** Original `dto.ChannelConstraints.SuppressesRetry`. */
export function suppressesRetry(pins: ChannelPin[] | null | undefined): boolean {
  const { pin, found } = resolvedPin(pins);
  return found && pin?.retryMode === PIN_RETRY_SINGLE_ATTEMPT;
}
