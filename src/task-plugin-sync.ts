/**
 * Original `controller.syncTaskPluginsOnceContext` + `GetTaskPluginRuntime` JSON.
 * Override-layer compile/hash state is stored per D1; factory routing generations
 * still live in QuantumNous `jsplugin.DefaultRegistry` and are not rebuilt here.
 */
import { GO_ZERO_TIME, parseJson } from "./constants.js";
import { publicTaskPluginRuntimeStatus, type TaskPluginRebuildOutcomeView } from "./dto.js";
import { compilePlugin } from "./jsplugin.js";
import type { Store } from "./store.js";

export type TaskPluginSyncState = {
  hashes: Record<string, string>;
  errors: Record<string, string>;
  lastRebuild: TaskPluginRebuildOutcomeView;
  currentGeneration: number;
  generationPublishedAt: string;
  overrideFingerprint: string;
};

function rfc3339Now(): string {
  return new Date().toISOString();
}

function overrideFingerprint(hashes: Record<string, string>): string {
  return Object.keys(hashes)
    .sort()
    .map((key) => `${key}\0${hashes[key]}`)
    .join("\n");
}

/** Original `jsplugin.NewRegistry` lastRebuild + generation 0. */
function newRegistryState(): TaskPluginSyncState {
  const now = rfc3339Now();
  return {
    hashes: {},
    errors: {},
    lastRebuild: {
      status: "success",
      attempted_at: now,
      generation: 0,
      plugin_error_count: 0,
    },
    currentGeneration: 0,
    generationPublishedAt: now,
    overrideFingerprint: "",
  };
}

function parseState(raw: string): TaskPluginSyncState {
  const parsed = parseJson<Partial<TaskPluginSyncState> | null>(raw, null);
  if (!parsed || typeof parsed !== "object") return newRegistryState();
  const last = parsed.lastRebuild && typeof parsed.lastRebuild === "object" ? parsed.lastRebuild : {};
  return {
    hashes: parsed.hashes && typeof parsed.hashes === "object" ? { ...parsed.hashes } : {},
    errors: parsed.errors && typeof parsed.errors === "object" ? { ...parsed.errors } : {},
    lastRebuild: {
      status: String(last.status || ""),
      attempted_at: String(last.attempted_at || GO_ZERO_TIME),
      generation: Math.trunc(Number(last.generation || 0)) || 0,
      plugin_error_count: Math.trunc(Number(last.plugin_error_count || 0)) || 0,
      database_revision: last.database_revision ? String(last.database_revision) : undefined,
      error: last.error ? String(last.error) : undefined,
    },
    currentGeneration: Math.trunc(Number(parsed.currentGeneration || 0)) || 0,
    generationPublishedAt: String(parsed.generationPublishedAt || GO_ZERO_TIME),
    overrideFingerprint: String(parsed.overrideFingerprint || ""),
  };
}

async function loadState(store: Store): Promise<TaskPluginSyncState> {
  const raw = await store.getTaskPluginSyncPayload();
  if (!raw) return newRegistryState();
  return parseState(raw);
}

async function saveState(store: Store, state: TaskPluginSyncState): Promise<void> {
  await store.setTaskPluginSyncPayload(JSON.stringify(state));
}

function compileErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Original `controller.syncTaskPluginsOnceContext`.
 * Compile failures are recorded as plugin errors (`partial`); snapshot
 * failures throw `sync task plugins: ...`.
 */
export async function syncTaskPluginsOnce(store: Store): Promise<void> {
  const started = rfc3339Now();
  const state = await loadState(store);
  let snapshot: { plugins: Record<string, unknown>[]; revision: string };
  try {
    snapshot = await store.getTaskPluginSyncSnapshot();
  } catch (err) {
    const syncErr = new Error(`sync task plugins: ${compileErrorMessage(err)}`);
    state.lastRebuild = {
      status: "failed",
      attempted_at: started,
      generation: state.currentGeneration,
      plugin_error_count: Object.keys(state.errors).length,
      database_revision: state.lastRebuild.database_revision,
      error: syncErr.message,
    };
    await saveState(store, state);
    throw syncErr;
  }

  const nextHashes: Record<string, string> = {};
  const seen: Record<string, boolean> = {};
  const plugins = [...snapshot.plugins].sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));
  for (const plugin of plugins) {
    const key = String(plugin.key || "");
    if (!key) continue;
    seen[key] = true;
    const version = String(plugin.version || "");
    const source = String(plugin.source || "");
    const sourceHash = String(plugin.source_hash || "");
    if (state.hashes[key] === sourceHash && sourceHash) {
      nextHashes[key] = sourceHash;
      continue;
    }
    try {
      compilePlugin(source, { key, version });
      nextHashes[key] = sourceHash;
      delete state.errors[key];
    } catch (err) {
      if (state.hashes[key]) nextHashes[key] = state.hashes[key];
      state.errors[key] = compileErrorMessage(err);
    }
  }
  for (const key of Object.keys(state.errors)) {
    if (!seen[key]) delete state.errors[key];
  }

  const nextFingerprint = overrideFingerprint(nextHashes);
  if (nextFingerprint !== state.overrideFingerprint) {
    state.currentGeneration += 1;
    state.generationPublishedAt = rfc3339Now();
    state.overrideFingerprint = nextFingerprint;
  }
  state.hashes = nextHashes;

  const pluginErrorCount = Object.keys(state.errors).length;
  state.lastRebuild = {
    status: pluginErrorCount > 0 ? "partial" : "success",
    attempted_at: rfc3339Now(),
    generation: state.currentGeneration,
    plugin_error_count: pluginErrorCount,
    database_revision: snapshot.revision,
  };
  await saveState(store, state);
}

function runtimeView(state: TaskPluginSyncState, snapshotRevision: string, databaseError?: string): Record<string, unknown> {
  const pluginErrors = { ...state.errors };
  const lastRebuild: TaskPluginRebuildOutcomeView = { ...state.lastRebuild };
  if (!lastRebuild.status) lastRebuild.status = "never";
  lastRebuild.plugin_error_count = Object.keys(pluginErrors).length;
  if (lastRebuild.status === "success" && lastRebuild.plugin_error_count > 0) lastRebuild.status = "partial";
  return publicTaskPluginRuntimeStatus({
    current_generation: state.currentGeneration,
    generation_published_at: state.generationPublishedAt || GO_ZERO_TIME,
    database_revision: snapshotRevision,
    database_error: databaseError,
    last_rebuild: lastRebuild,
    plugin_errors: pluginErrors,
  });
}

/** Original `controller.GetTaskPluginRuntime`. First call seeds NewRegistry + one SyncTaskPluginsOnce. */
export async function getTaskPluginRuntimeStatus(store: Store): Promise<Record<string, unknown>> {
  if (!(await store.getTaskPluginSyncPayload())) {
    await syncTaskPluginsOnce(store);
  }
  const state = await loadState(store);
  try {
    const snapshot = await store.getTaskPluginSyncSnapshot();
    return runtimeView(state, snapshot.revision);
  } catch {
    return runtimeView(state, state.lastRebuild.database_revision || "", "database snapshot unavailable");
  }
}
