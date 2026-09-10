import { CHANNEL_ENABLED, nowSec, parseJson } from "./constants.js";
import { fetchUpstreamModels } from "./relay.js";
import { normalizeModelNames } from "./upstream.js";
import type { Store } from "./store.js";
import type { ChannelRow } from "./types.js";

export { normalizeModelNames };

/** Original `controller.channelUpstreamModelUpdateMinCheckIntervalSeconds`. */
export const CHANNEL_UPSTREAM_MODEL_UPDATE_MIN_CHECK_INTERVAL_SECONDS = 300;

export type ChannelOtherSettings = {
  upstream_model_update_check_enabled?: boolean;
  upstream_model_update_auto_sync_enabled?: boolean;
  upstream_model_update_last_check_time?: number;
  upstream_model_update_last_detected_models?: string[];
  upstream_model_update_last_removed_models?: string[];
  upstream_model_update_ignored_models?: string[];
  [key: string]: unknown;
};

export type UpstreamModelUpdateSummary = {
  checked_channels: number;
  changed_channels: number;
  detected_add_models: number;
  detected_remove_models: number;
  failed_channels: number;
  auto_added_models: number;
};

export type DetectChannelUpstreamModelUpdatesResult = {
  channel_id: number;
  channel_name: string;
  add_models: string[];
  remove_models: string[];
  last_check_time: number;
  auto_added_models: number;
};

export type ApplyChannelUpstreamModelUpdatesResult = {
  id: number;
  added_models: string[];
  removed_models: string[];
  ignored_models: string[];
  remaining_models: string[];
  remaining_remove_models: string[];
  models: string;
  settings: string;
};

export type ApplyAllChannelUpstreamModelUpdatesResult = {
  channel_id: number;
  channel_name: string;
  added_models: string[];
  removed_models: string[];
  remaining_models: string[];
  remaining_remove_models: string[];
};

/** Original `model.Channel.GetModels`. */
export function channelGetModels(channel: ChannelRow): string[] {
  if (!channel.models) return [];
  return String(channel.models).replace(/^,+|,+$/g, "").split(",");
}

/** Original `controller.mergeModelNames`. */
export function mergeModelNames(base: string[], appended: string[]): string[] {
  const merged = normalizeModelNames(base);
  const seen = new Set(merged);
  for (const model of normalizeModelNames(appended)) {
    if (seen.has(model)) continue;
    seen.add(model);
    merged.push(model);
  }
  return merged;
}

/** Original `controller.subtractModelNames`. */
export function subtractModelNames(base: string[], removed: string[]): string[] {
  const removeSet = new Set(normalizeModelNames(removed));
  return normalizeModelNames(base).filter((model) => !removeSet.has(model));
}

/** Original `controller.intersectModelNames`. */
export function intersectModelNames(base: string[], allowed: string[]): string[] {
  const allowedSet = new Set(normalizeModelNames(allowed));
  return normalizeModelNames(base).filter((model) => allowedSet.has(model));
}

/** Original `controller.applySelectedModelChanges`. Add wins when the same model is in both lists. */
export function applySelectedModelChanges(originModels: string[], addModels: string[], removeModels: string[]): string[] {
  const normalizedAdd = normalizeModelNames(addModels);
  const normalizedRemove = subtractModelNames(normalizeModelNames(removeModels), normalizedAdd);
  return subtractModelNames(mergeModelNames(originModels, normalizedAdd), normalizedRemove);
}

export function parseChannelOtherSettings(channel: ChannelRow): ChannelOtherSettings {
  return parseJson<ChannelOtherSettings>(String(channel.settings || ""), {});
}

function stringifyChannelOtherSettings(settings: ChannelOtherSettings): string {
  return JSON.stringify(settings);
}

/** Original `controller.normalizeChannelModelMapping`. */
export function normalizeChannelModelMapping(channel: ChannelRow): Record<string, string> | null {
  const raw = String(channel.model_mapping || "").trim();
  if (!raw || raw === "{}" || raw === '""') return null;
  const parsed = parseJson<Record<string, unknown> | null>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const normalized: Record<string, string> = {};
  for (const [source, target] of Object.entries(parsed)) {
    const normalizedSource = String(source || "").trim();
    const normalizedTarget = String(target || "").trim();
    if (!normalizedSource || !normalizedTarget) continue;
    normalized[normalizedSource] = normalizedTarget;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function ignoredModelMatches(ignoredModel: string, modelName: string): boolean {
  if (ignoredModel.startsWith("regex:")) {
    const body = ignoredModel.slice("regex:".length).trim();
    try {
      return new RegExp(body).test(modelName);
    } catch {
      return false;
    }
  }
  return ignoredModel === modelName;
}

/** Original `controller.collectPendingUpstreamModelChangesFromModels`. */
export function collectPendingUpstreamModelChangesFromModels(
  localModels: string[],
  upstreamModels: string[],
  ignoredModels: string[],
  modelMapping: Record<string, string> | null,
): { pendingAddModels: string[]; pendingRemoveModels: string[] } {
  localModels = normalizeModelNames(localModels);
  upstreamModels = normalizeModelNames(upstreamModels);
  const localSet = new Set(localModels);
  const upstreamSet = new Set(upstreamModels);
  const normalizedIgnoredModels = normalizeModelNames(ignoredModels);
  const redirectSourceSet = new Set<string>();
  const redirectTargetSet = new Set<string>();
  if (modelMapping) {
    for (const [source, target] of Object.entries(modelMapping)) {
      redirectSourceSet.add(source);
      redirectTargetSet.add(target);
    }
  }
  const coveredUpstreamSet = new Set<string>([...localSet, ...redirectTargetSet]);
  const pendingAdd = upstreamModels.filter((modelName) => {
    if (coveredUpstreamSet.has(modelName)) return false;
    return !normalizedIgnoredModels.some((ignored) => ignoredModelMatches(ignored, modelName));
  });
  const pendingRemove = localModels.filter((modelName) => {
    if (redirectSourceSet.has(modelName)) return false;
    return !upstreamSet.has(modelName);
  });
  return {
    pendingAddModels: normalizeModelNames(pendingAdd),
    pendingRemoveModels: normalizeModelNames(pendingRemove),
  };
}

function sanitizeFetchModelsError(err: unknown, key: string): Error {
  let message = err instanceof Error ? err.message : String(err);
  const trimmed = key.trim();
  if (trimmed) {
    message = message.split(trimmed).join("[REDACTED]");
    message = message.split(encodeURIComponent(trimmed)).join("[REDACTED]");
  }
  return new Error(message);
}

async function collectPendingUpstreamModelChanges(
  store: Store,
  channel: ChannelRow,
  settings: ChannelOtherSettings,
): Promise<{ pendingAddModels: string[]; pendingRemoveModels: string[] }> {
  let upstreamModels: string[];
  try {
    upstreamModels = await fetchUpstreamModels(channel, store);
  } catch (e) {
    throw sanitizeFetchModelsError(e, channel.key || "");
  }
  if (!upstreamModels.length) {
    throw new Error("OpenAI Models response contains no valid model IDs");
  }
  return collectPendingUpstreamModelChangesFromModels(
    channelGetModels(channel),
    upstreamModels,
    Array.isArray(settings.upstream_model_update_ignored_models)
      ? (settings.upstream_model_update_ignored_models as string[])
      : [],
    normalizeChannelModelMapping(channel),
  );
}

async function updateChannelUpstreamModelSettings(
  store: Store,
  channel: ChannelRow,
  settings: ChannelOtherSettings,
  updateModels: boolean,
): Promise<void> {
  channel.settings = stringifyChannelOtherSettings(settings);
  const patch: Record<string, unknown> = { settings: channel.settings };
  if (updateModels) patch.models = channel.models;
  await store.updateChannel(channel.id, patch);
}

/** Original `controller.checkAndPersistChannelUpstreamModelUpdates`. */
export async function checkAndPersistChannelUpstreamModelUpdates(
  store: Store,
  channel: ChannelRow,
  settings: ChannelOtherSettings,
  force: boolean,
  allowAutoApply: boolean,
): Promise<{ modelsChanged: boolean; autoAdded: number }> {
  const now = nowSec();
  if (!force) {
    const last = Number(settings.upstream_model_update_last_check_time || 0);
    if (last > 0 && now - last < CHANNEL_UPSTREAM_MODEL_UPDATE_MIN_CHECK_INTERVAL_SECONDS) {
      return { modelsChanged: false, autoAdded: 0 };
    }
  }

  let pendingAddModels: string[] = [];
  let pendingRemoveModels: string[] = [];
  try {
    const pending = await collectPendingUpstreamModelChanges(store, channel, settings);
    pendingAddModels = pending.pendingAddModels;
    pendingRemoveModels = pending.pendingRemoveModels;
  } catch (e) {
    settings.upstream_model_update_last_check_time = now;
    await updateChannelUpstreamModelSettings(store, channel, settings, false);
    throw e;
  }

  settings.upstream_model_update_last_check_time = now;
  let modelsChanged = false;
  let autoAdded = 0;
  if (allowAutoApply && settings.upstream_model_update_auto_sync_enabled && pendingAddModels.length > 0) {
    const originModels = normalizeModelNames(channelGetModels(channel));
    const mergedModels = mergeModelNames(originModels, pendingAddModels);
    if (mergedModels.length > originModels.length) {
      channel.models = mergedModels.join(",");
      autoAdded = mergedModels.length - originModels.length;
      modelsChanged = true;
    }
    settings.upstream_model_update_last_detected_models = [];
  } else {
    settings.upstream_model_update_last_detected_models = pendingAddModels;
  }
  settings.upstream_model_update_last_removed_models = pendingRemoveModels;
  await updateChannelUpstreamModelSettings(store, channel, settings, modelsChanged);
  return { modelsChanged, autoAdded };
}

/** Original `controller.applyChannelUpstreamModelUpdates`. */
export async function applyChannelUpstreamModelUpdates(
  store: Store,
  channel: ChannelRow,
  addModelsInput: string[] | undefined,
  ignoreModelsInput: string[] | undefined,
  removeModelsInput: string[] | undefined,
): Promise<{
  addedModels: string[];
  removedModels: string[];
  remainingModels: string[];
  remainingRemoveModels: string[];
  modelsChanged: boolean;
}> {
  const settings = parseChannelOtherSettings(channel);
  const pendingAddModels = normalizeModelNames(settings.upstream_model_update_last_detected_models);
  const pendingRemoveModels = normalizeModelNames(settings.upstream_model_update_last_removed_models);
  const addModels = intersectModelNames(addModelsInput || [], pendingAddModels);
  let ignoreModels = intersectModelNames(ignoreModelsInput || [], pendingAddModels);
  let removeModels = intersectModelNames(removeModelsInput || [], pendingRemoveModels);
  removeModels = subtractModelNames(removeModels, addModels);

  const originModels = normalizeModelNames(channelGetModels(channel));
  const nextModels = applySelectedModelChanges(originModels, addModels, removeModels);
  const modelsChanged = originModels.length !== nextModels.length || originModels.some((m, i) => m !== nextModels[i]);
  if (modelsChanged) channel.models = nextModels.join(",");

  settings.upstream_model_update_ignored_models = mergeModelNames(
    Array.isArray(settings.upstream_model_update_ignored_models) ? settings.upstream_model_update_ignored_models : [],
    ignoreModels,
  );
  if (addModels.length > 0) {
    settings.upstream_model_update_ignored_models = subtractModelNames(
      settings.upstream_model_update_ignored_models,
      addModels,
    );
  }
  const remainingModels = subtractModelNames(pendingAddModels, [...addModels, ...ignoreModels]);
  const remainingRemoveModels = subtractModelNames(pendingRemoveModels, removeModels);
  settings.upstream_model_update_last_detected_models = remainingModels;
  settings.upstream_model_update_last_removed_models = remainingRemoveModels;
  settings.upstream_model_update_last_check_time = nowSec();
  await updateChannelUpstreamModelSettings(store, channel, settings, modelsChanged);
  return { addedModels: addModels, removedModels: removeModels, remainingModels, remainingRemoveModels, modelsChanged };
}

export async function detectChannelUpstreamModelUpdates(
  store: Store,
  channel: ChannelRow,
): Promise<DetectChannelUpstreamModelUpdatesResult> {
  const settings = parseChannelOtherSettings(channel);
  const { autoAdded } = await checkAndPersistChannelUpstreamModelUpdates(store, channel, settings, true, false);
  const updated = (await store.getChannel(channel.id)) || channel;
  const next = parseChannelOtherSettings(updated);
  return {
    channel_id: channel.id,
    channel_name: channel.name,
    add_models: normalizeModelNames(next.upstream_model_update_last_detected_models),
    remove_models: normalizeModelNames(next.upstream_model_update_last_removed_models),
    last_check_time: Number(next.upstream_model_update_last_check_time || 0),
    auto_added_models: autoAdded,
  };
}

export async function applyChannelUpstreamModelUpdatesForId(
  store: Store,
  channel: ChannelRow,
  addModels: string[] | undefined,
  ignoreModels: string[] | undefined,
  removeModels: string[] | undefined,
): Promise<ApplyChannelUpstreamModelUpdatesResult> {
  const beforeSettings = parseChannelOtherSettings(channel);
  const ignoredModels = intersectModelNames(
    ignoreModels || [],
    beforeSettings.upstream_model_update_last_detected_models || [],
  );
  const applied = await applyChannelUpstreamModelUpdates(store, channel, addModels, ignoreModels, removeModels);
  const updated = (await store.getChannel(channel.id)) || channel;
  return {
    id: channel.id,
    added_models: applied.addedModels,
    removed_models: applied.removedModels,
    ignored_models: ignoredModels,
    remaining_models: applied.remainingModels,
    remaining_remove_models: applied.remainingRemoveModels,
    models: String(updated.models || ""),
    settings: String(updated.settings || ""),
  };
}

export async function applyAllChannelUpstreamModelUpdates(store: Store): Promise<{
  processed_channels: number;
  added_models: number;
  removed_models: number;
  failed_channel_ids: number[];
  results: ApplyAllChannelUpstreamModelUpdatesResult[];
}> {
  const results: ApplyAllChannelUpstreamModelUpdatesResult[] = [];
  const failed: number[] = [];
  let addedModelCount = 0;
  let removedModelCount = 0;
  const channels = (await store.enabledChannels()).filter((ch) => ch.status === CHANNEL_ENABLED);
  for (const channel of channels) {
    const settings = parseChannelOtherSettings(channel);
    if (!settings.upstream_model_update_check_enabled) continue;
    const pendingAddModels = normalizeModelNames(settings.upstream_model_update_last_detected_models);
    const pendingRemoveModels = normalizeModelNames(settings.upstream_model_update_last_removed_models);
    if (!pendingAddModels.length && !pendingRemoveModels.length) continue;
    try {
      const applied = await applyChannelUpstreamModelUpdates(store, channel, pendingAddModels, undefined, pendingRemoveModels);
      addedModelCount += applied.addedModels.length;
      removedModelCount += applied.removedModels.length;
      results.push({
        channel_id: channel.id,
        channel_name: channel.name,
        added_models: applied.addedModels,
        removed_models: applied.removedModels,
        remaining_models: applied.remainingModels,
        remaining_remove_models: applied.remainingRemoveModels,
      });
    } catch {
      failed.push(channel.id);
    }
  }
  return {
    processed_channels: results.length,
    added_models: addedModelCount,
    removed_models: removedModelCount,
    failed_channel_ids: failed,
    results,
  };
}

/** Original `controller.runChannelUpstreamModelUpdateTaskOnce`. */
export async function runChannelUpstreamModelUpdateTaskOnce(
  store: Store,
  force: boolean,
  allowAutoApply: boolean,
): Promise<UpstreamModelUpdateSummary> {
  let checkedChannels = 0;
  let failedChannels = 0;
  let changedChannels = 0;
  let detectedAddModels = 0;
  let detectedRemoveModels = 0;
  let autoAddedModels = 0;
  const channels = (await store.enabledChannels()).filter((ch) => ch.status === CHANNEL_ENABLED);
  for (const channel of channels) {
    const settings = parseChannelOtherSettings(channel);
    if (!settings.upstream_model_update_check_enabled) continue;
    checkedChannels++;
    try {
      const { autoAdded } = await checkAndPersistChannelUpstreamModelUpdates(store, channel, settings, force, allowAutoApply);
      const updated = (await store.getChannel(channel.id)) || channel;
      const next = parseChannelOtherSettings(updated);
      const currentAddModels = normalizeModelNames(next.upstream_model_update_last_detected_models);
      const currentRemoveModels = normalizeModelNames(next.upstream_model_update_last_removed_models);
      const currentAddCount = currentAddModels.length + autoAdded;
      const currentRemoveCount = currentRemoveModels.length;
      detectedAddModels += currentAddCount;
      detectedRemoveModels += currentRemoveCount;
      if (currentAddCount > 0 || currentRemoveCount > 0) changedChannels++;
      autoAddedModels += autoAdded;
    } catch {
      failedChannels++;
    }
  }
  return {
    checked_channels: checkedChannels,
    changed_channels: changedChannels,
    detected_add_models: detectedAddModels,
    detected_remove_models: detectedRemoveModels,
    failed_channels: failedChannels,
    auto_added_models: autoAddedModels,
  };
}

/** Original system-task runner for `model_update`. */
export async function runPendingModelUpdateSystemTask(store: Store): Promise<void> {
  const task = await store.currentSystemTask("model_update");
  if (!task || String(task.status) !== "pending") return;
  const id = String(task.id || task.task_id || "");
  await store.updateSystemTask(id, { status: "running" });
  try {
    const payload =
      typeof task.payload === "string"
        ? parseJson<{ manual?: boolean }>(String(task.payload || "{}"), {})
        : ((task.payload as { manual?: boolean } | null) ?? {});
    const manual = Boolean(payload.manual);
    const summary = await runChannelUpstreamModelUpdateTaskOnce(store, manual, !manual);
    await store.updateSystemTask(id, { status: "succeeded", result: JSON.stringify(summary) });
  } catch (err) {
    await store.updateSystemTask(id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
