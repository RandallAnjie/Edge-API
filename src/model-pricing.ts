import { getBuiltinBillingExpr } from "./billing-setting.js";
import { smokeTestExpr } from "./billing-expr.js";
import { parseJson } from "./constants.js";
import { bytesToHex, sha256Bytes } from "./crypto.js";
import { formatMatchingModelName, getCompletionRatioInfo } from "./ratio-setting.js";
import type { Store } from "./store.js";

/** Original `model.modelPricingOptionKeys`. */
export const MODEL_PRICING_OPTION_KEYS = [
  "AudioCompletionRatio",
  "AudioRatio",
  "CacheRatio",
  "CompletionRatio",
  "CreateCacheRatio",
  "ImageRatio",
  "ModelPrice",
  "ModelRatio",
  "billing_setting.billing_expr",
  "billing_setting.billing_mode",
] as const;

export const ERR_MODEL_PRICING_CONFLICT = "model pricing changed; reload before saving";

export type PricingValues = Record<string, unknown>;

export type ModelPricingChange = {
  model_name?: string;
  expected_version?: string;
  pricing?: PricingValues;
  reset?: boolean;
};

export type ModelPricingEntry = {
  model_name: string;
  version: string;
  configured: PricingValues;
  effective: PricingValues;
  usage_schema?: Record<string, unknown>;
};

export type ModelPricingSnapshot = {
  entries: ModelPricingEntry[];
  options: Record<string, string>;
  empty_version: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

export async function modelPricingVersion(values: PricingValues): Promise<string> {
  const digest = await sha256Bytes(stableJson(values));
  return bytesToHex(digest);
}

async function readPricingMaps(store: Store): Promise<Record<string, Record<string, unknown>>> {
  const values: Record<string, Record<string, unknown>> = {};
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    values[key] = parseJson<Record<string, unknown>>(await store.option(key), {});
  }
  return values;
}

function configuredFor(values: Record<string, Record<string, unknown>>, name: string): PricingValues {
  const result: PricingValues = {};
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values[key], name)) result[key] = values[key][name];
  }
  return result;
}

function effectiveFor(values: Record<string, Record<string, unknown>>, name: string, selfUse: boolean): PricingValues {
  const result = configuredFor(values, name);
  const alias = formatMatchingModelName(name);
  for (const key of MODEL_PRICING_OPTION_KEYS.slice(0, 8)) {
    if (Object.prototype.hasOwnProperty.call(values[key], alias)) result[key] = values[key][alias];
  }
  let mode = result["billing_setting.billing_mode"];
  if (!mode) {
    const hasPrice = result.ModelPrice !== undefined;
    const hasRatio = result.ModelRatio !== undefined;
    if (getBuiltinBillingExpr(name) && !hasPrice && !hasRatio) mode = "tiered_expr";
  }
  if (mode === "tiered_expr") {
    result["billing_setting.billing_mode"] = mode;
    if (result["billing_setting.billing_expr"] == null) {
      const expression = getBuiltinBillingExpr(name);
      if (expression) result["billing_setting.billing_expr"] = expression;
    }
    return result;
  }
  if (result.ModelPrice !== undefined) return result;
  if (result.ModelRatio === undefined && selfUse) result.ModelRatio = 37.5;
  const completion = getCompletionRatioInfo(name, values.CompletionRatio as Record<string, number>);
  if (result.CompletionRatio === undefined || completion.locked) result.CompletionRatio = completion.ratio;
  return result;
}

export async function getModelPricingSnapshot(store: Store, names: string[]): Promise<ModelPricingSnapshot> {
  const values = await readPricingMaps(store);
  const nameSet = new Set(names.filter(Boolean));
  if (!nameSet.size) {
    for (const entries of Object.values(values)) {
      for (const name of Object.keys(entries)) nameSet.add(name);
    }
  }
  const sorted = [...nameSet].sort();
  const selfUse = await store.optionBool("SelfUseModeEnabled", false);
  const entries: ModelPricingEntry[] = [];
  for (const name of sorted) {
    const configured = configuredFor(values, name);
    entries.push({
      model_name: name,
      version: await modelPricingVersion(configured),
      configured,
      effective: effectiveFor(values, name, selfUse),
    });
  }
  const options: Record<string, string> = {};
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    options[key] = JSON.stringify(values[key]);
  }
  return { entries, options, empty_version: await modelPricingVersion({}) };
}

function validatePricing(name: string, values: PricingValues): string | null {
  if (!name.trim()) return "model name is required";
  for (const [key, value] of Object.entries(values)) {
    if (!MODEL_PRICING_OPTION_KEYS.includes(key as (typeof MODEL_PRICING_OPTION_KEYS)[number])) {
      return `unsupported pricing field: ${key}`;
    }
    if (key === "billing_setting.billing_mode") {
      if (value !== "ratio" && value !== "tiered_expr") return "invalid billing mode";
      continue;
    }
    if (key === "billing_setting.billing_expr") {
      if (typeof value !== "string" || !value.trim()) return "billing expression is required";
      const err = smokeTestExpr(value);
      if (err) return `model ${name}: ${err.message}`;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `${key} must be a finite, non-negative number`;
    }
  }
  if (values["billing_setting.billing_mode"] === "tiered_expr" && values["billing_setting.billing_expr"] == null) {
    return "billing expression is required";
  }
  return null;
}

export class ModelPricingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function updateModelPricing(store: Store, changes: ModelPricingChange[]): Promise<string[]> {
  if (!changes.length) throw new ModelPricingError("select model pricing changes before saving");
  const seen = new Set<string>();
  for (const change of changes) {
    const name = String(change.model_name || "");
    if (seen.has(name)) throw new ModelPricingError("duplicate model pricing change");
    seen.add(name);
    if (!change.expected_version) throw new ModelPricingError(ERR_MODEL_PRICING_CONFLICT, 409);
    const err = validatePricing(name, change.pricing || {});
    if (err) throw new ModelPricingError(err);
  }
  const values = await readPricingMaps(store);
  const updated: string[] = [];
  for (const change of changes) {
    const name = String(change.model_name);
    const current = await modelPricingVersion(configuredFor(values, name));
    if (current !== change.expected_version) {
      throw new ModelPricingError(`${ERR_MODEL_PRICING_CONFLICT}: ${name}`, 409);
    }
    const pricing = change.reset ? {} : change.pricing || {};
    for (const key of MODEL_PRICING_OPTION_KEYS) {
      delete values[key][name];
      if (Object.prototype.hasOwnProperty.call(pricing, key)) values[key][name] = pricing[key];
    }
    updated.push(name);
  }
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    await store.setOption(key, JSON.stringify(values[key]));
  }
  return updated;
}
