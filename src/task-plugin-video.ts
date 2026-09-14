/**
 * Original jsplugin `TaskAdaptor.ConvertToOpenAIVideo` on workerd.
 */
import { openaiVideoView } from "./dto.js";
import { type PluginEngine } from "./jsplugin.js";
import { factoryPluginMeta } from "./task-plugin-factory.js";
import { resolveTaskPluginSource } from "./task-plugin-factory.js";
import { buildTaskPluginView, loadCompiledPlugin } from "./task-plugin-route.js";
import type { Store } from "./store.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pluginJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function pluginMeta(engine: PluginEngine): Record<string, unknown> {
  try {
    const meta = engine.export("meta");
    return isPlainObject(meta) ? meta : {};
  } catch {
    return {};
  }
}

/** Original `pluginruntime.ProtocolClaim` name check for `openai_video`. */
export function pluginClaimsOpenAIVideo(meta: Record<string, unknown>): boolean {
  const protocols = Array.isArray(meta.protocols) ? meta.protocols : [];
  return protocols.some((item) => {
    if (typeof item === "string") return item === "openai_video";
    return isPlainObject(item) && String(item.name || "") === "openai_video";
  });
}

/** Original `TaskAdaptor.ConvertToOpenAIVideo`. */
export function convertToOpenAIVideo(engine: PluginEngine, row: Record<string, unknown>): Record<string, unknown> {
  const meta = pluginMeta(engine);
  if (!pluginClaimsOpenAIVideo(meta)) throw new Error("plugin does not claim openai_video");
  const view = buildTaskPluginView(row);
  const value = engine.callPath("protocols", ["openai_video", "render"], [
    { protocol: "openai_video", operation: "retrieve" },
    pluginJsonValue(view),
  ]);
  if (!isPlainObject(value)) throw new Error("plugin returned an invalid OpenAI video object");
  const host = openaiVideoView(row);
  const rendered: Record<string, unknown> = { ...value };
  rendered.id = host.id;
  rendered.object = host.object;
  delete rendered.task_id;
  rendered.status = host.status;
  rendered.progress = host.progress;
  rendered.created_at = host.created_at;
  rendered.model = host.model;
  if (host.completed_at) rendered.completed_at = host.completed_at;
  else delete rendered.completed_at;
  return rendered;
}

function pluginKeyFromTask(row: Record<string, unknown>): string {
  const privateRaw = row.private_data;
  const privateData =
    typeof privateRaw === "string"
      ? (() => {
          try {
            return JSON.parse(privateRaw) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : isPlainObject(privateRaw)
        ? privateRaw
        : {};
  const execution = isPlainObject(privateData.execution) ? privateData.execution : {};
  const snapshot = isPlainObject(execution.task_plugin) ? execution.task_plugin : {};
  const fromSnapshot = String(snapshot.key || "").trim();
  if (fromSnapshot) return fromSnapshot;
  return String(row.platform || "");
}

export async function convertOwnedTaskToOpenAIVideo(
  store: Store,
  row: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const key = pluginKeyFromTask(row);
  if (!key) return null;
  const resolved = await resolveTaskPluginSource(store, key);
  if (!resolved?.source) return null;
  const meta = factoryPluginMeta(key) || {};
  const loaded = loadCompiledPlugin(resolved.source, key, String(meta.version || ""));
  if (!pluginClaimsOpenAIVideo(pluginMeta(loaded.engine))) return null;
  return convertToOpenAIVideo(loaded.engine, row);
}
