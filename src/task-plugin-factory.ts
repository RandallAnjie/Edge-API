import { parseJson } from "./constants.js";
import { compilePlugin } from "./jsplugin.js";
import {
  extractPluginMeta,
  pluginModelNames,
  pluginUsageForModel,
  taskPluginMetaView,
  taskPluginStubMeta,
} from "./plugin-meta.js";
import {
  FACTORY_TASK_PLUGIN_HASHES,
  FACTORY_TASK_PLUGIN_ICONS,
  FACTORY_TASK_PLUGIN_KEYS,
  FACTORY_TASK_PLUGIN_METAS,
  FACTORY_TASK_PLUGIN_SOURCES,
} from "./task-plugin-factory-data.js";
import type { Store } from "./store.js";

export { FACTORY_TASK_PLUGIN_KEYS };

export type RoutingPlugin = {
  key: string;
  meta: Record<string, unknown>;
  source: string;
  hasIcon: boolean;
};

function rowEnabled(row: Record<string, unknown>): boolean {
  if (row.enabled != null) return Boolean(Number(row.enabled) || row.enabled === true || row.enabled === "true");
  return String(row.status || "") === "active" || String(row.status || "") === "enabled";
}

function rowActive(row: Record<string, unknown>): boolean {
  if (row.active != null) return Boolean(Number(row.active) || row.active === true);
  return rowEnabled(row);
}

export function hasFactoryPlugin(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(FACTORY_TASK_PLUGIN_SOURCES, key);
}

export function factoryPluginSource(key: string): string | undefined {
  return FACTORY_TASK_PLUGIN_SOURCES[key];
}

export function factoryPluginMeta(key: string): Record<string, unknown> | undefined {
  return FACTORY_TASK_PLUGIN_METAS[key];
}

export function factoryPluginHash(key: string): string {
  return FACTORY_TASK_PLUGIN_HASHES[key] || "";
}

export function factoryPluginIcon(key: string): { mediaType: string; dataUri: string } | undefined {
  return FACTORY_TASK_PLUGIN_ICONS[key];
}

export function factoryPluginHasIcon(key: string): boolean {
  return Boolean(FACTORY_TASK_PLUGIN_ICONS[key]);
}

export function factoryMetaView(key: string): Record<string, unknown> {
  const meta = FACTORY_TASK_PLUGIN_METAS[key] || { key };
  return taskPluginMetaView(meta, { key, version: String(meta.version || ""), name: String(meta.name || key) });
}

/** Original `setting.ParseTaskPluginDisabledFactoryKeys`. */
export function parseTaskPluginDisabledFactoryKeys(raw: string): string[] {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  const keys = parseJson<unknown>(trimmed, []);
  if (!Array.isArray(keys)) return [];
  return keys.map((key) => String(key));
}

/** Original `setting.SetTaskPluginDisabledFactoryKeysOption` normalize. */
export function normalizeTaskPluginDisabledFactoryKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const key = String(raw || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  out.sort();
  return out;
}

export async function getTaskPluginDisabledFactoryKeys(store: Store): Promise<string[]> {
  return parseTaskPluginDisabledFactoryKeys(await store.option("TaskPluginDisabledFactoryKeys"));
}

export async function isTaskPluginFactoryDisabled(store: Store, key: string): Promise<boolean> {
  return (await getTaskPluginDisabledFactoryKeys(store)).includes(key);
}

export async function setTaskPluginDisabledFactoryKeys(store: Store, keys: string[]): Promise<string[]> {
  const normalized = normalizeTaskPluginDisabledFactoryKeys(keys);
  await store.setOption("TaskPluginDisabledFactoryKeys", JSON.stringify(normalized));
  return normalized;
}

export async function taskPluginMasterEnabled(store: Store): Promise<boolean> {
  return store.optionBool("TaskPluginEnabled", true);
}

export function overrideMetaFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const extracted = extractPluginMeta(String(row.source || ""));
  const manifest = parseJson<Record<string, unknown>>(String(row.manifest || "{}"), {});
  return taskPluginMetaView(
    { ...manifest, ...extracted },
    { key: String(row.key || extracted.key || ""), version: String(row.version || ""), name: String(row.name || "") },
  );
}

/** Original ListTaskPlugins `NewRegistry().Register(row.Source)` Meta, else stub `{Key, Version, APIVersion}`. */
export function compiledOverrideListMeta(row: Record<string, unknown>): Record<string, unknown> {
  try {
    const loaded = compilePlugin(String(row.source || ""), {
      key: String(row.key || ""),
      version: String(row.version || ""),
    });
    return taskPluginMetaView(loaded.meta, {
      key: String(row.key || loaded.meta.key || ""),
      version: String(row.version || loaded.meta.version || ""),
      name: String(loaded.meta.name || ""),
    });
  } catch {
    return taskPluginStubMeta(row);
  }
}

/** Original ListTaskPlugins RoutingErrors + Snapshot().Override keys. */
export type TaskPluginListRuntime = {
  errors: Record<string, string>;
  overrideKeys: Set<string>;
};

function sortPriorityOf(meta: Record<string, unknown>): number {
  return Number(meta.sortPriority || 0) || 0;
}

function comparePluginItems(a: { meta: Record<string, unknown> }, b: { meta: Record<string, unknown> }): number {
  const pa = sortPriorityOf(a.meta);
  const pb = sortPriorityOf(b.meta);
  if (pa !== pb) return pb - pa;
  return String(a.meta.key || "").localeCompare(String(b.meta.key || ""));
}

/** Original ListTaskPlugins union of factory keys + every database plugin key; Active rows supply override fields. */
export async function listTaskPluginListItems(
  store: Store,
  runtime: TaskPluginListRuntime = { errors: {}, overrideKeys: new Set() },
): Promise<Record<string, unknown>[]> {
  const rows = await store.listTaskPluginCatalogRows();
  const activeRows = new Map<string, Record<string, unknown>>();
  const keys = new Set<string>(FACTORY_TASK_PLUGIN_KEYS);
  for (const row of rows) {
    const key = String(row.key || "");
    if (!key) continue;
    keys.add(key);
    if (rowActive(row)) activeRows.set(key, row);
  }
  const disabled = new Set(await getTaskPluginDisabledFactoryKeys(store));
  const items: { meta: Record<string, unknown>; [key: string]: unknown }[] = [];
  for (const key of keys) {
    const factory = hasFactoryPlugin(key);
    const row = activeRows.get(key);
    if (row) {
      const enabled = rowEnabled(row);
      const item: { meta: Record<string, unknown>; [key: string]: unknown } = {
        meta: compiledOverrideListMeta(row),
        source: factory ? "override_over_factory" : "override",
        enabled,
        active: rowActive(row),
        source_hash: String(row.source_hash || ""),
        has_icon: String(row.icon || "") !== "",
        remark: String(row.remark || ""),
        runtime_status: "registered",
        channel_count: 0,
        in_flight_count: 0,
      };
      if (factory) item.factory_meta = factoryMetaView(key);
      const errMsg = runtime.errors[key] || "";
      if (errMsg) {
        item.runtime_status = "compile_failed";
        item.runtime_error = errMsg;
      } else if (runtime.overrideKeys.has(key)) {
        /* live Snapshot().Override Meta ≈ compiled Register Meta already set */
      } else if (!enabled) {
        item.runtime_status = "disabled_fallback";
      } else {
        item.runtime_status = "not_registered";
      }
      if (item.runtime_status === "disabled_fallback" && factory && disabled.has(key)) {
        item.runtime_status = "disabled";
      }
      if (!factory) {
        const usage = await store.taskPluginUsage(key);
        item.channel_count = usage.channel_count;
        item.in_flight_count = usage.in_flight_count;
      }
      items.push(item);
      continue;
    }
    const enabled = !disabled.has(key);
    const factoryErr = runtime.errors[key] || "";
    let runtimeStatus = "registered";
    if (!enabled) runtimeStatus = "disabled";
    else if (factoryErr) runtimeStatus = "compile_failed";
    const factoryItem: { meta: Record<string, unknown>; [key: string]: unknown } = {
      meta: factoryMetaView(key),
      source: "factory",
      enabled,
      active: true,
      source_hash: factoryPluginHash(key),
      has_icon: factoryPluginHasIcon(key),
      remark: "",
      runtime_status: runtimeStatus,
      channel_count: 0,
      in_flight_count: 0,
    };
    if (runtimeStatus === "compile_failed") factoryItem.runtime_error = factoryErr;
    items.push(factoryItem);
  }
  items.sort(comparePluginItems);
  return items;
}

export type TaskPluginDetail = {
  plugin?: Record<string, unknown>;
  meta: Record<string, unknown>;
  source: string;
  layer: "factory" | "override";
  has_icon: boolean;
};

export function factoryTaskPluginDetail(key: string): TaskPluginDetail | null {
  const source = factoryPluginSource(key);
  if (source == null) return null;
  return {
    meta: factoryMetaView(key),
    source,
    layer: "factory",
    has_icon: factoryPluginHasIcon(key),
  };
}

/** Plugins that serve traffic: enabled overrides, else factory fallback. */
export async function listRoutingPlugins(store: Store): Promise<RoutingPlugin[]> {
  if (!(await taskPluginMasterEnabled(store))) return [];
  const rows = (await store.listTaskPlugins()) as Record<string, unknown>[];
  const enabledOverrides = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (rowActive(row) && rowEnabled(row)) enabledOverrides.set(String(row.key || ""), row);
  }
  const disabled = new Set(await getTaskPluginDisabledFactoryKeys(store));
  const out: RoutingPlugin[] = [];
  const seen = new Set<string>();
  for (const [key, row] of enabledOverrides) {
    seen.add(key);
    out.push({
      key,
      meta: overrideMetaFromRow(row),
      source: String(row.source || ""),
      hasIcon: Boolean(row.icon),
    });
  }
  for (const key of FACTORY_TASK_PLUGIN_KEYS) {
    if (seen.has(key) || disabled.has(key)) continue;
    out.push({
      key,
      meta: factoryMetaView(key),
      source: FACTORY_TASK_PLUGIN_SOURCES[key],
      hasIcon: factoryPluginHasIcon(key),
    });
  }
  return out;
}

/** Original GetTaskPluginOptions JSON. */
export async function listTaskPluginOptions(store: Store): Promise<Record<string, unknown>[]> {
  if (!(await taskPluginMasterEnabled(store))) return [];
  const plugins = await listRoutingPlugins(store);
  const options = plugins.map((plugin) => {
    const meta = plugin.meta;
    return {
      key: String(meta.key || plugin.key),
      name: String(meta.name || plugin.key),
      description: meta.description,
      icon: meta.icon ? String(meta.icon) : "",
      hasIcon: plugin.hasIcon,
      baseUrl: meta.baseUrl ? String(meta.baseUrl) : "",
      sortPriority: Number(meta.sortPriority || 0) || 0,
      website: meta.website ? String(meta.website) : "",
      models: Array.isArray(meta.models) ? meta.models : [],
      channelTypes: Array.isArray(meta.channelTypes) ? meta.channelTypes : [],
      usageSchema: meta.usageSchema,
      usageProfiles: Array.isArray(meta.usageProfiles) ? meta.usageProfiles : [],
    };
  });
  options.sort((a, b) => {
    if (a.sortPriority !== b.sortPriority) return b.sortPriority - a.sortPriority;
    return String(a.key).localeCompare(String(b.key));
  });
  return options;
}

export async function pluginUsageByModel(store: Store): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const plugin of await listRoutingPlugins(store)) {
    for (const name of pluginModelNames(plugin.meta)) {
      if (!out.has(name)) {
        const usage = pluginUsageForModel(plugin.meta, name);
        out.set(name, { ...plugin.meta, usageSchema: usage.usageSchema, usageExamples: usage.usageExamples, pluginKey: plugin.key });
      }
    }
  }
  return out;
}

export async function routingPluginsByModel(store: Store, name: string): Promise<RoutingPlugin[]> {
  const folded = name;
  const out: RoutingPlugin[] = [];
  for (const plugin of await listRoutingPlugins(store)) {
    if (pluginModelNames(plugin.meta).includes(folded)) out.push(plugin);
  }
  out.sort(comparePluginItems);
  return out;
}

export async function resolveTaskPluginSource(store: Store, key: string, version = ""): Promise<{ source: string; row?: Record<string, unknown> } | null> {
  const row = await store.getTaskPluginVersion(key, version);
  if (row) return { source: String(row.source || ""), row };
  if (version) return null;
  const source = factoryPluginSource(key);
  if (source == null) return null;
  return { source };
}
