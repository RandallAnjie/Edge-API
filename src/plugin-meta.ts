import { parseJson } from "./constants.js";

/** Original `jsplugin.asciiFold` — ASCII A–Z only. */
export function asciiFoldModel(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

export function extractPluginMeta(source: string): Record<string, unknown> {
  const idx = source.search(/\bmeta\s*=\s*\{/);
  if (idx < 0) return {};
  const start = source.indexOf("{", idx);
  if (start < 0) return {};
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = source.slice(start, i + 1);
        const jsonish = raw
          .replace(/'([^'\\]*)'/g, '"$1"')
          .replace(/([,{]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
          .replace(/,(\s*[}\]])/g, "$1");
        return parseJson<Record<string, unknown>>(jsonish, {});
      }
    }
  }
  return {};
}

function protocolViews(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") return { name: item };
    return item;
  });
}

/** Original ListTaskPlugins stub `jsplugin.Meta{Key, Version, APIVersion}` when Register fails. */
export function taskPluginStubMeta(row: {
  key?: unknown;
  version?: unknown;
  api_version?: unknown;
  apiVersion?: unknown;
}): Record<string, unknown> {
  return {
    apiVersion: Number(row.api_version ?? row.apiVersion ?? 0) || 0,
    key: String(row.key || ""),
    name: "",
    version: String(row.version || ""),
    author: { name: "" },
    models: null,
    fetchMode: "",
    allowedHosts: null,
    routes: null,
    protocols: null,
    auth: { type: "" },
  };
}

/** Original `jsplugin.Meta` JSON as returned by ListTaskPlugins / GetTaskPlugin. */
export function taskPluginMetaView(
  meta: Record<string, unknown>,
  fallback: { key: string; version?: string; name?: string } = { key: "" },
): Record<string, unknown> {
  const key = String(meta.key || fallback.key || "");
  const version = String(meta.version || fallback.version || "1.0.0");
  const name = String(meta.name || fallback.name || key);
  const authorRaw = meta.author && typeof meta.author === "object" ? (meta.author as Record<string, unknown>) : {};
  const submit = Array.isArray(meta.submitResponseTypes) ? (meta.submitResponseTypes as unknown[]) : [];
  const required = Array.isArray(meta.requiredCapabilities) ? (meta.requiredCapabilities as unknown[]) : [];
  const view: Record<string, unknown> = {
    sortPriority: Number(meta.sortPriority || 0) || undefined,
    website: meta.website ? String(meta.website) : undefined,
    apiVersion: Number(meta.apiVersion ?? meta.api_version ?? 1) || 1,
    key,
    name,
    icon: meta.icon ? String(meta.icon) : undefined,
    description: meta.description,
    version,
    author: { name: String(authorRaw.name || ""), url: authorRaw.url ? String(authorRaw.url) : undefined },
    baseUrl: meta.baseUrl ? String(meta.baseUrl) : undefined,
    channelTypes: Array.isArray(meta.channelTypes) ? meta.channelTypes : undefined,
    models: Array.isArray(meta.models) ? meta.models : [],
    fetchMode: String(meta.fetchMode || "per_task"),
    allowedHosts: Array.isArray(meta.allowedHosts) ? meta.allowedHosts : [],
    routes: Array.isArray(meta.routes) ? meta.routes : [],
    protocols: protocolViews(meta.protocols),
    usageSchema: meta.usageSchema,
    auth: meta.auth && typeof meta.auth === "object" ? meta.auth : typeof meta.auth === "string" ? { type: meta.auth } : { type: "" },
    submitResponseTypes: submit.length ? submit : ["json"],
  };
  if (required.length) view.requiredCapabilities = required;
  if (Array.isArray(meta.usageExamples) && meta.usageExamples.length) view.usageExamples = meta.usageExamples;
  if (Array.isArray(meta.usageProfiles) && meta.usageProfiles.length) view.usageProfiles = meta.usageProfiles;
  return view;
}

export type PluginUsageForModel = {
  usageSchema?: Record<string, unknown>;
  usageExamples?: unknown[];
};

/** Original `jsplugin.Meta.UsageForModel`. */
export function pluginUsageForModel(meta: Record<string, unknown>, model: string): PluginUsageForModel {
  const folded = asciiFoldModel(model);
  const profiles = Array.isArray(meta.usageProfiles) ? (meta.usageProfiles as Record<string, unknown>[]) : [];
  for (const profile of profiles) {
    const models = Array.isArray(profile.models) ? (profile.models as unknown[]).map((m) => String(m)) : [];
    if (models.some((declared) => asciiFoldModel(declared) === folded)) {
      return {
        usageSchema: (profile.schema as Record<string, unknown>) || {},
        usageExamples: Array.isArray(profile.examples) ? (profile.examples as unknown[]) : undefined,
      };
    }
  }
  const usageSchema = meta.usageSchema && typeof meta.usageSchema === "object" ? (meta.usageSchema as Record<string, unknown>) : undefined;
  const usageExamples = Array.isArray(meta.usageExamples) ? (meta.usageExamples as unknown[]) : undefined;
  return { usageSchema, usageExamples };
}

export function pluginModelNames(meta: Record<string, unknown>): string[] {
  return Array.isArray(meta.models) ? (meta.models as unknown[]).map((m) => String(m)).filter(Boolean) : [];
}
