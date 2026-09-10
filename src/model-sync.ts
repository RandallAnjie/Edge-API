import { nowSec } from "./constants.js";
import { bytesToHex, sha256Bytes } from "./crypto.js";
import type { Store } from "./store.js";

const METADATA_SYNC_FIELDS = ["description", "icon", "tags", "vendor", "endpoints", "name_rule", "status"] as const;
const UPSTREAM_BASE_DEFAULT = "https://basellm.github.io/llm-metadata";

export type MetadataValues = {
  description: string;
  icon: string;
  tags: string;
  vendor: string;
  endpoints: string;
  name_rule: number;
  status: number;
};

export type MetadataSyncSelection = {
  model_name: string;
  record_version: string;
  create?: boolean;
  fields?: string[];
};

type UpstreamModel = {
  description?: string;
  endpoints?: unknown;
  icon?: string;
  model_name?: string;
  name_rule?: number;
  status?: number;
  tags?: string;
  vendor_name?: string;
};

type UpstreamVendor = { description?: string; icon?: string; name?: string; status?: number };

function normalizeLocale(locale: string): string | null {
  switch (locale.toLowerCase().trim()) {
    case "":
    case "zh":
    case "zh-cn":
      return "zh";
    case "en":
      return "en";
    case "ja":
      return "ja";
    default:
      return null;
  }
}

function upstreamBase(): string {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.SYNC_UPSTREAM_BASE || UPSTREAM_BASE_DEFAULT;
}

function upstreamUrls(locale: string): { models: string; vendors: string } {
  const base = upstreamBase().replace(/\/$/, "");
  return {
    models: `${base}/api/i18n/${locale}/newapi/models.json`,
    vendors: `${base}/api/i18n/${locale}/newapi/vendors.json`,
  };
}

function endpointsToString(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

async function fetchEnvelope<T>(url: string): Promise<T[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const parsed = (await res.json()) as { success?: boolean; data?: T[] } | T[];
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: T[] }).data)) {
    return (parsed as { data: T[] }).data;
  }
  throw new Error("upstream metadata source reported failure");
}

function findVendor(
  vendors: Record<string, Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  for (const v of Object.values(vendors)) {
    if (String(v.name || "").trim().toLowerCase() === want) return v;
  }
  return undefined;
}

function localValues(row: Record<string, unknown> | undefined, vendorName = ""): MetadataValues {
  return {
    description: String(row?.description || ""),
    icon: String(row?.icon || ""),
    tags: String(row?.tags || ""),
    vendor: vendorName,
    endpoints: String(row?.endpoints || ""),
    name_rule: Number(row?.name_rule || 0),
    status: row?.status == null ? 1 : Number(row.status),
  };
}

async function recordVersion(
  local: Record<string, unknown> | null,
  localVendor: Record<string, unknown> | undefined,
  upstreamVendor: Record<string, unknown> | undefined,
): Promise<string> {
  const encoded = JSON.stringify([local, localVendor || null, upstreamVendor || null]);
  return bytesToHex(await sha256Bytes(encoded));
}

export async function fetchMetadataCatalog(localeRaw: string): Promise<{
  source: { locale: string; models_url: string; vendors_url: string; version: string };
  models: Record<string, MetadataValues>;
  vendors: Record<string, UpstreamVendor>;
}> {
  const locale = normalizeLocale(localeRaw);
  if (!locale) throw new Error("unsupported metadata language");
  const urls = upstreamUrls(locale);
  const source = { locale, models_url: urls.models, vendors_url: urls.vendors, version: "" };
  const [modelRows, vendorRows] = await Promise.all([fetchEnvelope<UpstreamModel>(urls.models), fetchEnvelope<UpstreamVendor>(urls.vendors)]);
  const vendors: Record<string, UpstreamVendor> = {};
  for (const vendor of vendorRows) {
    const name = String(vendor.name || "").trim();
    if (!name) continue;
    vendors[name] = { name, description: vendor.description || "", icon: vendor.icon || "", status: Number(vendor.status ?? 1) };
  }
  const models: Record<string, MetadataValues> = {};
  for (const item of modelRows) {
    const modelName = String(item.model_name || "").trim();
    if (!modelName) continue;
    if (models[modelName]) throw new Error(`duplicate upstream model: ${modelName}`);
    models[modelName] = {
      description: String(item.description || ""),
      icon: String(item.icon || ""),
      tags: String(item.tags || ""),
      vendor: String(item.vendor_name || "").trim(),
      endpoints: endpointsToString(item.endpoints),
      name_rule: Number(item.name_rule || 0),
      status: Number(item.status ?? 1),
    };
  }
  const encoded = JSON.stringify([source.locale, models, vendors]);
  source.version = bytesToHex(await sha256Bytes(encoded));
  return { source, models, vendors };
}

export async function previewMetadataSync(
  store: Store,
  locale: string,
): Promise<{ source: Record<string, string>; candidates: Record<string, unknown>[] }> {
  const catalog = await fetchMetadataCatalog(locale);
  const locals = ((await store.listModelMeta()) as Record<string, unknown>[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
  const vendorRows = ((await store.listVendors()) as Record<string, unknown>[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
  const localByName: Record<string, Record<string, unknown>> = {};
  for (const row of locals) localByName[String(row.model_name)] = row;
  const vendorsByName: Record<string, Record<string, unknown>> = {};
  const vendorsById: Record<string, Record<string, unknown>> = {};
  for (const v of vendorRows) {
    vendorsByName[String(v.name)] = v;
    vendorsById[String(v.id)] = v;
  }
  const missing = await store.enabledModelsAll();
  const have = new Set(locals.map((m) => String(m.model_name)));
  const siteNames = new Set<string>([...Object.keys(localByName), ...missing.filter((n) => !have.has(n))]);
  const allNames = new Set<string>([...siteNames, ...Object.keys(catalog.models)]);
  const names = [...allNames].sort();
  const candidates: Record<string, unknown>[] = [];
  for (const name of names) {
    const candidate: Record<string, unknown> = {
      model_name: name,
      kind: "create",
      scope: siteNames.has(name) ? "site" : "catalog",
      record_version: "",
      fields: [] as { field: string; local: unknown; upstream: unknown }[],
    };
    const local = localByName[name];
    const up = catalog.models[name];
    if (!up) {
      candidate.kind = "missing_upstream";
      candidates.push(candidate);
      continue;
    }
    candidate.upstream = up;
    const localVendor = local ? vendorsById[String(local.vendor_id || 0)] : undefined;
    const upVendor = findVendor(vendorsByName, up.vendor);
    candidate.record_version = await recordVersion(local || null, localVendor, upVendor);
    if (local && Number(local.sync_official) === 0) {
      candidate.kind = "blocked";
      candidates.push(candidate);
      continue;
    }
    if (up.vendor && !upVendor) {
      if (!catalog.vendors[up.vendor]) {
        candidate.kind = "missing_vendor";
        candidates.push(candidate);
        continue;
      }
      candidate.vendor_to_create = up.vendor;
    }
    const current = localValues(local, localVendor ? String(localVendor.name || "") : "");
    if (local) candidate.kind = "update";
    const fields: { field: string; local: unknown; upstream: unknown }[] = [];
    for (const field of METADATA_SYNC_FIELDS) {
      const localVal = current[field];
      const upVal = up[field];
      if (!local || localVal !== upVal) fields.push({ field, local: localVal, upstream: upVal });
    }
    candidate.fields = fields;
    if (local && fields.length === 0) candidate.kind = "unchanged";
    candidates.push(candidate);
  }
  return { source: catalog.source, candidates };
}

export async function applyMetadataSync(
  store: Store,
  request: { locale?: string; source_version?: string; selections?: MetadataSyncSelection[] },
): Promise<Record<string, unknown>> {
  const selections = request.selections || [];
  if (!selections.length || !request.source_version) {
    const err = new Error("Preview and select metadata changes before applying");
    (err as Error & { status: number }).status = 400;
    throw err;
  }
  const catalog = await fetchMetadataCatalog(request.locale || "");
  if (catalog.source.version !== request.source_version) {
    const err = new Error("Upstream metadata changed; preview again");
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  const seen = new Set<string>();
  for (const sel of selections) {
    if (!sel.model_name?.trim() || seen.has(sel.model_name)) throw new Error("invalid or duplicate model selection");
    seen.add(sel.model_name);
    if (!sel.record_version) {
      const err = new Error("metadata changed; preview again before applying");
      (err as Error & { status: number }).status = 409;
      throw err;
    }
    const values = catalog.models[sel.model_name];
    if (!values) {
      const err = new Error("Selected upstream model is no longer available");
      (err as Error & { status: number }).status = 409;
      throw err;
    }
    if (!sel.create && !(sel.fields || []).length) throw new Error("select fields to update");
    for (const field of sel.fields || []) {
      if (!METADATA_SYNC_FIELDS.includes(field as (typeof METADATA_SYNC_FIELDS)[number])) {
        throw new Error(`unsupported metadata field: ${field}`);
      }
    }
  }

  const created_models: string[] = [];
  const updated_models: MetadataSyncSelection[] = [];
  const created_vendors: string[] = [];

  const locals = ((await store.listModelMeta()) as Record<string, unknown>[]).slice();
  const vendorRows = ((await store.listVendors()) as Record<string, unknown>[]).slice();
  const localByName: Record<string, Record<string, unknown>> = {};
  for (const row of locals) localByName[String(row.model_name)] = row;
  const vendorsByName: Record<string, Record<string, unknown>> = {};
  const vendorsById: Record<string, Record<string, unknown>> = {};
  for (const v of vendorRows) {
    vendorsByName[String(v.name)] = v;
    vendorsById[String(v.id)] = v;
  }

  for (const sel of selections) {
    const values = catalog.models[sel.model_name];
    const local = localByName[sel.model_name];
    if (local && Number(local.sync_official) === 0) throw new Error(`metadata sync is disabled for ${sel.model_name}`);
    const localVendor = local ? vendorsById[String(local.vendor_id || 0)] : undefined;
    const upVendor = findVendor(vendorsByName, values.vendor);
    const version = await recordVersion(local || null, localVendor, upVendor);
    if (version !== sel.record_version) {
      const err = new Error(`metadata changed; preview again before applying: ${sel.model_name}`);
      (err as Error & { status: number }).status = 409;
      throw err;
    }
    if ((sel.create && local) || (!sel.create && !local)) {
      const err = new Error("metadata changed; preview again before applying");
      (err as Error & { status: number }).status = 409;
      throw err;
    }
  }

  for (const sel of selections) {
    const values = catalog.models[sel.model_name];
    const selected = sel.create ? [...METADATA_SYNC_FIELDS] : sel.fields || [];
    const patch: Record<string, unknown> = { updated_time: nowSec() };
    for (const field of selected) {
      switch (field) {
        case "description":
          patch.description = values.description;
          break;
        case "icon":
          patch.icon = values.icon;
          break;
        case "tags":
          patch.tags = values.tags;
          break;
        case "endpoints":
          patch.endpoints = values.endpoints;
          break;
        case "name_rule":
          patch.name_rule = values.name_rule;
          break;
        case "status":
          patch.status = values.status;
          break;
        case "vendor": {
          let vendorId = 0;
          const name = values.vendor;
          if (name) {
            let vendor = findVendor(vendorsByName, name);
            if (!vendor) {
              const up = catalog.vendors[name];
              if (!up) throw new Error(`upstream vendor not found: ${name}`);
              const id = await store.insertVendor(name, up.description || "", up.icon || "");
              vendor = { id, name, description: up.description || "", icon: up.icon || "" };
              vendorsByName[name] = vendor;
              vendorsById[String(id)] = vendor;
              created_vendors.push(name);
            }
            vendorId = Number(vendor.id || 0);
          }
          patch.vendor_id = vendorId;
          break;
        }
      }
    }
    if (sel.create) {
      const id = await store.insertModelMeta(sel.model_name, String(patch.description || values.description || ""), Number(patch.vendor_id || 0));
      await store.updateModelMeta(id, {
        ...patch,
        sync_official: 1,
        created_time: nowSec(),
      });
      created_models.push(sel.model_name);
    } else {
      const local = localByName[sel.model_name];
      await store.updateModelMeta(Number(local.id), patch);
      updated_models.push(sel);
    }
  }

  return { created_models, updated_models, created_vendors };
}
