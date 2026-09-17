/**
 * Original QuantumNous `jsplugin.PreflightRoutingConflict` /
 * `buildRoutingGenerationFromPlugins`.
 */
import { CHANNEL_TYPE_TASK_PLUGIN } from "./constants.js";
import { compilePlugin } from "./jsplugin.js";
import { routePathShapeForPreflight } from "./jsplugin-validate.js";
import { asciiFoldModel } from "./plugin-meta.js";
import {
  FACTORY_TASK_PLUGIN_KEYS,
  FACTORY_TASK_PLUGIN_METAS,
} from "./task-plugin-factory-data.js";
import { getTaskPluginDisabledFactoryKeys } from "./task-plugin-factory.js";
import type { Store } from "./store.js";

export type RoutingPluginMeta = {
  key: string;
  models: string[];
  channelTypes: number[];
  routes: { method: string; path: string }[];
  protocols: { name: string; models: string[] }[];
};

const PROTOCOL_MODEL_OPS: { protocol: string; method: string; path: string }[] = [
  { protocol: "openai_responses", method: "POST", path: "/v1/responses" },
  { protocol: "openai_video", method: "POST", path: "/v1/videos" },
];

export function routingMetaFromRecord(meta: Record<string, unknown>, keyFallback = ""): RoutingPluginMeta {
  const key = String(meta.key || keyFallback);
  const models = Array.isArray(meta.models) ? (meta.models as unknown[]).map((item) => String(item)) : [];
  const channelTypes = Array.isArray(meta.channelTypes)
    ? (meta.channelTypes as unknown[]).map((item) => Number(item)).filter((n) => n && n !== CHANNEL_TYPE_TASK_PLUGIN)
    : [];
  const routes = Array.isArray(meta.routes)
    ? (meta.routes as unknown[]).map((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return { method: String(row.method || ""), path: String(row.path || "") };
      })
    : [];
  const protocols: { name: string; models: string[] }[] = [];
  if (Array.isArray(meta.protocols)) {
    for (const item of meta.protocols as unknown[]) {
      if (typeof item === "string") {
        protocols.push({ name: item, models: [] });
        continue;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        protocols.push({
          name: String(row.name || ""),
          models: Array.isArray(row.models) ? (row.models as unknown[]).map((m) => String(m)) : [],
        });
      }
    }
  }
  return { key, models, channelTypes, routes, protocols };
}

/** Original `jsplugin.buildRoutingGenerationFromPlugins`. */
export function buildRoutingGenerationFromPlugins(effective: Map<string, RoutingPluginMeta>): void {
  const keys = [...effective.keys()].sort();
  const byModel = new Map<string, RoutingPluginMeta>();
  const canonicalModelByFold = new Map<string, string>();
  const byChannelType = new Map<number, RoutingPluginMeta>();
  const routeIndex = new Map<string, { plugin: RoutingPluginMeta; path: string }>();
  const protocolIndex = new Map<string, { plugin: RoutingPluginMeta; protocol: string }[]>();
  for (const key of keys) {
    const plugin = effective.get(key)!;
    for (const model of plugin.models) {
      if (!byModel.has(model)) byModel.set(model, plugin);
      const folded = asciiFoldModel(model);
      const existing = canonicalModelByFold.get(folded);
      if (existing) {
        if (existing !== model) {
          const other = byModel.get(existing);
          throw new Error(
            `plugin ${plugin.key} model ${JSON.stringify(model)} conflicts with plugin ${other?.key || plugin.key} model ${JSON.stringify(existing)}`,
          );
        }
        continue;
      }
      canonicalModelByFold.set(folded, model);
    }
    for (const channelType of plugin.channelTypes) {
      if (!channelType || channelType === CHANNEL_TYPE_TASK_PLUGIN) continue;
      const other = byChannelType.get(channelType);
      if (other) {
        throw new Error(`plugin ${plugin.key} channelType ${channelType} conflicts with plugin ${other.key}`);
      }
      byChannelType.set(channelType, plugin);
    }
    for (const route of plugin.routes) {
      if (!route.path) continue;
      const shape = routePathShapeForPreflight(route.path);
      const indexKey = `${route.method} ${shape}`;
      const other = routeIndex.get(indexKey);
      if (other) {
        throw new Error(
          `plugin ${plugin.key} route ${route.method} ${route.path} conflicts with plugin ${other.plugin.key} route ${other.path}`,
        );
      }
      routeIndex.set(indexKey, { plugin, path: route.path });
    }
    for (const claim of plugin.protocols) {
      const boundModels = claim.models.length ? claim.models : plugin.models;
      for (const operation of PROTOCOL_MODEL_OPS) {
        if (operation.protocol !== claim.name) continue;
        for (const model of boundModels) {
          const indexKey = `${operation.method}\0${operation.path}\0${model}`;
          const bindings = protocolIndex.get(indexKey) || [];
          if (bindings.length) {
            const other = bindings[0];
            if (claim.name !== other.protocol) {
              throw new Error(
                `plugin ${plugin.key} protocol ${operation.method} ${operation.path} model ${JSON.stringify(model)} conflicts with plugin ${other.plugin.key}`,
              );
            }
          }
          bindings.push({ plugin, protocol: claim.name });
          protocolIndex.set(indexKey, bindings);
        }
      }
    }
  }
}

/** Original `jsplugin.PreflightRoutingConflict`. Same-key entries are replaced first. */
export function preflightRoutingConflict(current: RoutingPluginMeta[], candidate: RoutingPluginMeta): void {
  const effective = new Map<string, RoutingPluginMeta>();
  for (const plugin of current) effective.set(plugin.key, plugin);
  effective.set(candidate.key, candidate);
  buildRoutingGenerationFromPlugins(effective);
}

/** Serving DefaultRegistry generation analogue: factory minus disabled, plus compiling enabled overrides. */
export async function currentRoutingGeneration(store: Store): Promise<RoutingPluginMeta[]> {
  const disabled = new Set(await getTaskPluginDisabledFactoryKeys(store));
  const byKey = new Map<string, RoutingPluginMeta>();
  for (const key of FACTORY_TASK_PLUGIN_KEYS) {
    if (disabled.has(key)) continue;
    const meta = FACTORY_TASK_PLUGIN_METAS[key];
    if (meta) byKey.set(key, routingMetaFromRecord(meta, key));
  }
  const snapshot = await store.getTaskPluginSyncSnapshot();
  for (const row of snapshot.plugins as Record<string, unknown>[]) {
    const source = String(row.source || "");
    if (!source) continue;
    try {
      const loaded = compilePlugin(source);
      byKey.set(String(loaded.meta.key || row.key || ""), routingMetaFromRecord(loaded.meta, String(row.key || "")));
    } catch {
      /* original ReplaceOverrides omits compile failures from the published generation */
    }
  }
  return [...byKey.values()];
}
