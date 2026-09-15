import { asciiFoldModel, pluginModelNames } from "./plugin-meta.js";
import { listRoutingPlugins, type RoutingPlugin } from "./task-plugin-factory.js";
import type { Store } from "./store.js";

/** Original `model.TaskAliasTarget`. */
export type TaskAliasTarget = {
  alias: string;
  declared: string;
  pluginKey: string;
};

type TaskAliasDraft = {
  spellings: string[];
  byPlugin: Map<string, Set<string>>;
};

type RoutingIndex = {
  byModel: Map<string, RoutingPlugin>;
  byKey: Map<string, RoutingPlugin>;
  canonicalModelByFold: Map<string, string>;
};

/** Original `model.Channel.GetModels` for the alias view. */
function channelGetModels(models: string): string[] {
  if (!models) return [];
  return String(models).replace(/^,+|,+$/g, "").split(",");
}

/** Original `jsplugin.RoutingGeneration` indexes used by `ResolveTaskModelAlias`. */
export function routingIndexFromPlugins(plugins: RoutingPlugin[]): RoutingIndex {
  const sorted = plugins.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byModel = new Map<string, RoutingPlugin>();
  const byKey = new Map<string, RoutingPlugin>();
  const canonicalModelByFold = new Map<string, string>();
  for (const plugin of sorted) {
    byKey.set(plugin.key, plugin);
    for (const model of pluginModelNames(plugin.meta)) {
      if (!byModel.has(model)) byModel.set(model, plugin);
      const folded = asciiFoldModel(model);
      const existing = canonicalModelByFold.get(folded);
      if (existing) {
        if (existing !== model) continue;
        continue;
      }
      canonicalModelByFold.set(folded, model);
    }
  }
  return { byModel, byKey, canonicalModelByFold };
}

/** Original `jsplugin.RoutingGeneration.CanonicalModel`. */
export function canonicalModel(index: RoutingIndex, model: string): string | undefined {
  if (!model) return undefined;
  if (index.byModel.has(model)) return model;
  return index.canonicalModelByFold.get(asciiFoldModel(model));
}

/** Original `model.followChannelModelMapping`. */
export function followChannelModelMapping(
  modelMap: Record<string, string>,
  start: string,
): { tail: string; cyclic: boolean } {
  let current = start;
  const visited: Record<string, boolean> = { [current]: true };
  for (;;) {
    const exists = Object.prototype.hasOwnProperty.call(modelMap, current);
    const mapped = exists ? modelMap[current] : "";
    if (!exists || mapped === "") return { tail: current, cyclic: false };
    if (visited[mapped]) {
      if (mapped === current) return { tail: current, cyclic: false };
      return { tail: "", cyclic: true };
    }
    visited[mapped] = true;
    current = mapped;
  }
}

function parseModelMapping(raw: string): Record<string, string> | undefined {
  if (!raw || raw === "{}") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") return undefined;
    out[key] = value;
  }
  return out;
}

/** Original `model.buildTaskAliasView` keyed by ASCII-folded alias. */
export async function buildTaskAliasView(
  store: Store,
  plugins?: RoutingPlugin[],
): Promise<Map<string, TaskAliasTarget>> {
  const routing = plugins ?? (await listRoutingPlugins(store));
  const index = routingIndexFromPlugins(routing);
  const view = new Map<string, TaskAliasTarget>();
  const drafts = new Map<string, TaskAliasDraft>();
  for (const channel of await store.enabledChannels()) {
    const modelMap = parseModelMapping(String(channel.model_mapping || ""));
    if (!modelMap) continue;
    const inModels = new Set(channelGetModels(String(channel.models || "")));
    for (const [alias, mapped] of Object.entries(modelMap)) {
      if (mapped === "") continue;
      if (!inModels.has(alias)) continue;
      if (canonicalModel(index, alias) !== undefined) continue;
      const followed = followChannelModelMapping(modelMap, alias);
      if (followed.cyclic) continue;
      const declared = canonicalModel(index, followed.tail);
      if (!declared) continue;
      const plugin = index.byModel.get(declared);
      if (!plugin) continue;
      const fold = asciiFoldModel(alias);
      let draft = drafts.get(fold);
      if (!draft) {
        draft = { spellings: [], byPlugin: new Map() };
        drafts.set(fold, draft);
      }
      draft.spellings.push(alias);
      let declareds = draft.byPlugin.get(plugin.key);
      if (!declareds) {
        declareds = new Set();
        draft.byPlugin.set(plugin.key, declareds);
      }
      declareds.add(declared);
    }
  }
  for (const draft of drafts.values()) {
    let alias = draft.spellings[0] || "";
    for (const spelling of draft.spellings.slice(1)) {
      if (spelling < alias) alias = spelling;
    }
    if (draft.byPlugin.size !== 1) continue;
    let pluginKey = "";
    let declared = "";
    for (const [key, declareds] of draft.byPlugin) {
      pluginKey = key;
      if (declareds.size === 1) {
        for (const name of declareds) declared = name;
      }
    }
    view.set(asciiFoldModel(alias), { alias, declared, pluginKey });
  }
  return view;
}

/** Original `model.ResolveTaskModelAlias`. */
export async function resolveTaskModelAlias(store: Store, name: string): Promise<TaskAliasTarget | undefined> {
  if (!name) return undefined;
  const view = await buildTaskAliasView(store);
  return view.get(asciiFoldModel(name));
}
