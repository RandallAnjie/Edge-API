import { parseJson } from "./constants.js";
import { extractPluginMeta } from "./dto.js";
import type { Store } from "./store.js";
import { pinnedTaskPluginChannelTypes } from "./channel-constraint.js";

/** Original `jsplugin.HostProtocols` operations used for endpoint pinning. */
export const HOST_PROTOCOL_OPERATIONS: { name: string; method: string; path: string }[] = [
  { name: "openai_responses", method: "POST", path: "/v1/responses" },
  { name: "openai_responses", method: "GET", path: "/v1/responses/:response_id" },
  { name: "openai_video", method: "POST", path: "/v1/videos" },
  { name: "openai_video", method: "GET", path: "/v1/videos/:task_id" },
  { name: "openai_video", method: "GET", path: "/v1/videos/:task_id/content" },
  { name: "openai_video", method: "HEAD", path: "/v1/videos/:task_id/content" },
];

export type MatchedPlugin = {
  key: string;
  path: string;
  channelTypes: number[];
  kind: "route" | "endpoint";
  models: string[];
};

export async function matchPluginRoute(
  store: Store,
  method: string,
  path: string,
): Promise<MatchedPlugin | null> {
  return matchTaskPlugin(store, method, path);
}

export async function matchTaskPlugin(
  store: Store,
  method: string,
  path: string,
  model = "",
): Promise<MatchedPlugin | null> {
  const plugins = (await store.listTaskPlugins()) as {
    key: string;
    status: string;
    enabled?: number;
    routes: string;
    source?: string;
  }[];
  for (const p of plugins) {
    if (Number(p.enabled) === 0) continue;
    if (p.status !== "active" && p.status !== "enabled") continue;
    const meta = extractPluginMeta(String(p.source || ""));
    const channelTypes = pinnedTaskPluginChannelTypes(meta.channelTypes);
    const models = Array.isArray(meta.models) ? (meta.models as unknown[]).map((m) => String(m)) : [];
    const routes = pluginRoutes(p.routes, meta);
    for (const r of routes) {
      if ((r.method || "POST").toUpperCase() !== method.toUpperCase()) continue;
      if (pathMatches(r.path || "", path)) {
        return { key: p.key, path: r.path || path, channelTypes, kind: "route", models };
      }
    }
  }
  if (!model) return null;
  for (const p of plugins) {
    if (Number(p.enabled) === 0) continue;
    if (p.status !== "active" && p.status !== "enabled") continue;
    const meta = extractPluginMeta(String(p.source || ""));
    const models = Array.isArray(meta.models) ? (meta.models as unknown[]).map((m) => String(m)) : [];
    if (models.length && !models.includes(model)) continue;
    if (!models.length) continue;
    const claimed = claimedProtocolNames(meta);
    if (!claimed.length) continue;
    for (const op of HOST_PROTOCOL_OPERATIONS) {
      if (!claimed.includes(op.name)) continue;
      if (op.method.toUpperCase() !== method.toUpperCase()) continue;
      if (!pathMatches(op.path, path)) continue;
      return {
        key: p.key,
        path: op.path,
        channelTypes: pinnedTaskPluginChannelTypes(meta.channelTypes),
        kind: "endpoint",
        models,
      };
    }
  }
  return null;
}

function pluginRoutes(
  raw: string,
  meta: Record<string, unknown>,
): { method?: string; path?: string; type?: string }[] {
  const fromCol = parseJson<{ method?: string; path?: string; type?: string }[]>(raw, []);
  if (fromCol.length) return fromCol;
  return Array.isArray(meta.routes) ? (meta.routes as { method?: string; path?: string; type?: string }[]) : [];
}

function claimedProtocolNames(meta: Record<string, unknown>): string[] {
  const raw = meta.protocols;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      out.push(String((item as { name: string }).name));
    }
  }
  return out;
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const pp = pattern.split("/").filter(Boolean);
  const sp = path.split("/").filter(Boolean);
  let si = 0;
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith("*")) return true;
    if (si >= sp.length) return false;
    if (pp[i].startsWith(":")) {
      si += 1;
      continue;
    }
    if (pp[i] !== sp[si]) return false;
    si += 1;
  }
  return si === sp.length;
}
