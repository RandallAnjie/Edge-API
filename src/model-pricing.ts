import { BILLING_MODE_RATIO, BILLING_MODE_TIERED_EXPR, BUILTIN_BILLING_EXPR, getBuiltinBillingExpr } from "./billing-setting.js";
import { smokeTestExpr } from "./billing-expr.js";
import {
  CHANNEL_ENABLED,
  CHANNEL_TYPE_ALI,
  CHANNEL_TYPE_OPENROUTER,
  CHANNEL_TYPE_TASK_PLUGIN,
  NAME_RULE_EXACT,
  parseJson,
} from "./constants.js";
import { bytesToHex, sha256Bytes } from "./crypto.js";
import { endpointTypesForChannel, extractPluginMeta, isImageGenerationModel, matchesName } from "./dto.js";
import { defaultModelRatio } from "./ratio-defaults.js";
import { formatMatchingModelName, resolveCompletionRatio } from "./ratio-setting.js";
import { baseModelName } from "./reasoning.js";
import type { Store } from "./store.js";

/** Original `billing_setting.PluginBillingExprOption`. */
export const PLUGIN_BILLING_EXPR_OPTION = "billing_setting.plugin_billing_expr";

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
  PLUGIN_BILLING_EXPR_OPTION,
] as const;

export const ERR_MODEL_PRICING_CONFLICT = "model pricing changed; reload before saving";

const DEFAULT_CACHE_RATIO = 1;
const DEFAULT_CREATE_CACHE_RATIO = 1.25;
const DEFAULT_IMAGE_RATIO = 1;
const Z_IMAGE_PROMPT_EXTEND_MULTIPLIER = 2;

export type PricingValues = Record<string, unknown>;

export type ModelPricingChange = {
  model_name?: string;
  expected_version?: string;
  pricing?: PricingValues;
  reset?: boolean;
};

export type CacheWriteMode = "none" | "standard" | "claude_ttl";

export type LegacyPricingRule = {
  condition: string;
  multiplier: number;
};

export type LegacyBillingDetails = {
  audio_input_price?: number;
  audio_output_price?: number;
  image_count?: boolean;
  request_rules?: LegacyPricingRule[];
  audio_text_branches?: boolean;
  invalid_audio_price?: boolean;
  conflicting_audio_prices?: boolean;
};

export type ModelPricingDescription = {
  effective?: PricingValues;
  cache_write_mode?: CacheWriteMode;
  billing_details: LegacyBillingDetails;
};

export type ModelPricingConversion = ModelPricingDescription & {
  expression?: string;
  unsupported_reason?: string;
};

export type ModelPricingPluginVariant = {
  plugin_key: string;
  plugin_name: string;
  icon?: string;
  usage_schema: Record<string, unknown>;
  usage_examples?: unknown[];
  configured: string;
  effective: string;
  compatible: boolean;
  stale?: boolean;
};

export type ModelPricingEntry = ModelPricingDescription & {
  plugin_variants?: ModelPricingPluginVariant[];
  model_name: string;
  version: string;
  configured: PricingValues;
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

/** Original `billing_setting.PluginBillingExprKey`. */
export function pluginBillingExprKey(plugin: string, model: string): string {
  return `${plugin}::${model}`;
}

/** Original `billing_setting.SplitPluginBillingExprKey` + `jsplugin.ValidPluginKey`. */
export function splitPluginBillingExprKey(key: string): { plugin: string; model: string } | null {
  const idx = key.indexOf("::");
  if (idx < 1) return null;
  const plugin = key.slice(0, idx);
  const model = key.slice(idx + 2);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(plugin) || plugin.length > 30 || !model.trim()) return null;
  return { plugin, model };
}

function configuredFor(values: Record<string, Record<string, unknown>>, name: string): PricingValues {
  const result: PricingValues = {};
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    if (key === PLUGIN_BILLING_EXPR_OPTION) {
      const variants: Record<string, unknown> = {};
      for (const [variant, expression] of Object.entries(values[key] || {})) {
        const split = splitPluginBillingExprKey(variant);
        if (split && split.model === name) variants[split.plugin] = expression;
      }
      if (Object.keys(variants).length) result[key] = variants;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values[key], name)) result[key] = values[key][name];
  }
  return result;
}

function asFloat(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function effectiveFor(values: Record<string, Record<string, unknown>>, name: string, selfUse: boolean): PricingValues {
  const result = configuredFor(values, name);
  const alias = formatMatchingModelName(name);
  for (const key of ["ModelPrice", "ModelRatio", "CompletionRatio", "AudioRatio", "AudioCompletionRatio"] as const) {
    delete result[key];
    if (Object.prototype.hasOwnProperty.call(values[key], alias)) result[key] = values[key][alias];
  }
  let mode = result["billing_setting.billing_mode"];
  if (!mode) {
    const hasPrice = result.ModelPrice !== undefined;
    const hasRatio = result.ModelRatio !== undefined;
    if (getBuiltinBillingExpr(name) && !hasPrice && !hasRatio) mode = BILLING_MODE_TIERED_EXPR;
  }
  if (mode === BILLING_MODE_TIERED_EXPR) {
    result["billing_setting.billing_mode"] = mode;
    if (result["billing_setting.billing_expr"] == null) {
      const expression = getBuiltinBillingExpr(name);
      if (expression) result["billing_setting.billing_expr"] = expression;
    }
    return result;
  }
  if (result.ModelPrice !== undefined) return result;
  if (result.ModelRatio === undefined && selfUse) result.ModelRatio = 37.5;
  result.CompletionRatio = resolveCompletionRatio(name, asFloat(result.CompletionRatio)).ratio;
  if (result.CacheRatio === undefined) result.CacheRatio = DEFAULT_CACHE_RATIO;
  if (result.CreateCacheRatio === undefined) result.CreateCacheRatio = DEFAULT_CREATE_CACHE_RATIO;
  if (result.ImageRatio === undefined) result.ImageRatio = DEFAULT_IMAGE_RATIO;
  return result;
}

function replaceModelPricing(values: Record<string, Record<string, unknown>>, name: string, draft: PricingValues): void {
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    if (key === PLUGIN_BILLING_EXPR_OPTION) {
      for (const variant of Object.keys(values[key] || {})) {
        const split = splitPluginBillingExprKey(variant);
        if (split && split.model === name) delete values[key][variant];
      }
      const variants = draft[key];
      if (variants && typeof variants === "object" && !Array.isArray(variants)) {
        for (const [plugin, expression] of Object.entries(variants as Record<string, unknown>)) {
          values[key][pluginBillingExprKey(plugin, name)] = expression;
        }
      }
      continue;
    }
    delete values[key][name];
    if (Object.prototype.hasOwnProperty.call(draft, key)) values[key][name] = draft[key];
  }
}

export function resolveCacheWriteMode(name: string, configured: PricingValues): CacheWriteMode {
  if (name.toLowerCase().includes("claude")) return "claude_ttl";
  if (Object.prototype.hasOwnProperty.call(configured, "CreateCacheRatio")) return "standard";
  return "none";
}

function dallePriceRatio(model: string, size: string, quality: string): number {
  if (!model.startsWith("dall-e")) return 1;
  let sizeRatio = 1;
  let qualityRatio = 1;
  switch (size) {
    case "256x256":
      sizeRatio = 0.4;
      break;
    case "512x512":
      sizeRatio = 0.45;
      break;
    case "1024x1792":
    case "1792x1024":
      sizeRatio = 2;
      break;
  }
  if (model === "dall-e-3" && quality === "hd") {
    qualityRatio = 2;
    if (size === "1024x1792" || size === "1792x1024") qualityRatio = 1.5;
  }
  return sizeRatio * qualityRatio;
}

function legacyDallePricingRules(name: string): LegacyPricingRule[] {
  if (!name.startsWith("dall-e")) return [];
  const rules: LegacyPricingRule[] = [];
  if (name !== "dall-e-3") {
    for (const size of ["256x256", "512x512"]) {
      rules.push({ condition: `param("size") == "${size}"`, multiplier: dallePriceRatio(name, size, "") });
    }
  }
  const rectangle = dallePriceRatio(name, "1024x1792", "");
  if (name !== "dall-e-2" && name !== "dall-e") {
    rules.push({
      condition: `param("size") == "1024x1792" || param("size") == "1792x1024"`,
      multiplier: rectangle,
    });
  }
  if (name === "dall-e-3") {
    const squareHD = dallePriceRatio(name, "1024x1024", "hd");
    const rectangleHD = dallePriceRatio(name, "1024x1792", "hd");
    rules.push(
      {
        condition: `param("quality") == "hd" && param("size") != "1024x1792" && param("size") != "1792x1024"`,
        multiplier: squareHD,
      },
      {
        condition: `param("quality") == "hd" && (param("size") == "1024x1792" || param("size") == "1792x1024")`,
        multiplier: rectangleHD / rectangle,
      },
    );
  }
  return rules;
}

/** Original `operation_setting.GetGeminiInputAudioPricePerMillionTokens`. */
export function geminiInputAudioPricePerMillion(modelName: string): number {
  if (modelName.startsWith("gemini-2.5-flash-preview-native-audio")) return 3;
  if (modelName.startsWith("gemini-2.5-flash-preview-lite")) return 0.5;
  if (modelName.startsWith("gemini-2.5-flash-preview")) return 1;
  if (modelName.startsWith("gemini-2.5-flash")) return 1;
  if (modelName.startsWith("gemini-2.0-flash")) return 0.7;
  if (modelName.startsWith("gemini-robotics-er-1.5")) return 1;
  return 0;
}

/** Original shopspring `decimal.NewFromFloat(n).String()` via `strconv.FormatFloat(f, 'f', -1, 64)`. */
function shopspringString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  let s = abs.toString();
  if (/[eE]/.test(s)) {
    const match = /^([0-9]+)(?:\.([0-9]+))?[eE]([+-]?\d+)$/.exec(s);
    if (match) {
      const digits = match[1] + (match[2] || "");
      const exp = Number(match[3]) - (match[2] ? match[2].length : 0) + (match[1].length - 1);
      const point = exp + 1;
      if (point <= 0) s = "0." + "0".repeat(-point) + digits;
      else if (point >= digits.length) s = digits + "0".repeat(point - digits.length);
      else s = `${digits.slice(0, point)}.${digits.slice(point)}`;
    }
  }
  return sign + s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function legacyInputPricePerMillion(ratio: number, quotaPerUnit: number): number {
  if (!(quotaPerUnit > 0) || !Number.isFinite(quotaPerUnit)) throw new Error("invalid quota unit");
  if (ratio < 0 || !Number.isFinite(ratio)) throw new Error("input ratio must be finite and non-negative");
  return (ratio * 1_000_000) / quotaPerUnit;
}

export function resolveLegacyBillingDetails(
  name: string,
  effective: PricingValues,
  configured: PricingValues,
  quotaPerUnit = 500000,
): LegacyBillingDetails {
  const details: LegacyBillingDetails = {};
  if (effective["billing_setting.billing_mode"] === BILLING_MODE_TIERED_EXPR) return details;
  if (Object.prototype.hasOwnProperty.call(effective, "ModelPrice")) {
    details.image_count = isImageGenerationModel(name) || undefined;
    const rules = legacyDallePricingRules(name);
    if (rules.length) details.request_rules = rules;
    return details;
  }
  const ratio = asFloat(effective.ModelRatio);
  if (ratio === undefined) return details;
  let base: number;
  try {
    base = legacyInputPricePerMillion(ratio, quotaPerUnit);
  } catch {
    return details;
  }
  const geminiAudio = geminiInputAudioPricePerMillion(name);
  if (geminiAudio > 0) {
    details.audio_input_price = geminiAudio;
    const hasInput = asFloat(effective.AudioRatio) !== undefined;
    const hasOutput = asFloat(effective.AudioCompletionRatio) !== undefined;
    if (hasInput || hasOutput) {
      const audio = hasInput ? (asFloat(effective.AudioRatio) as number) : 1;
      const output = hasOutput ? (asFloat(effective.AudioCompletionRatio) as number) : 1;
      const audioPrice = base * audio;
      const textOutput = base * (asFloat(effective.CompletionRatio) as number);
      details.conflicting_audio_prices = audioPrice !== geminiAudio || audioPrice * output !== textOutput;
    }
    return details;
  }
  const hasAudio = asFloat(effective.AudioRatio) !== undefined;
  const hasAudioCompletion = asFloat(effective.AudioCompletionRatio) !== undefined;
  if (!hasAudio && !hasAudioCompletion) return details;
  const audioRatio = hasAudio ? (asFloat(effective.AudioRatio) as number) : 1;
  const audioCompletionRatio = hasAudioCompletion ? (asFloat(effective.AudioCompletionRatio) as number) : 1;
  const inPrice = base * audioRatio;
  const outPrice = inPrice * audioCompletionRatio;
  if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice)) {
    details.invalid_audio_price = true;
    return details;
  }
  details.audio_input_price = inPrice;
  details.audio_output_price = outPrice;
  if (effective.CacheRatio !== 1 || effective.ImageRatio !== 1 || resolveCacheWriteMode(name, configured) !== "none") {
    details.audio_text_branches = true;
  }
  return details;
}

function compactBillingDetails(details: LegacyBillingDetails): LegacyBillingDetails {
  const out: LegacyBillingDetails = {};
  if (details.audio_input_price !== undefined) out.audio_input_price = details.audio_input_price;
  if (details.audio_output_price !== undefined) out.audio_output_price = details.audio_output_price;
  if (details.image_count) out.image_count = true;
  if (details.request_rules?.length) out.request_rules = details.request_rules;
  if (details.audio_text_branches) out.audio_text_branches = true;
  return out;
}

export async function getModelPricingSnapshot(store: Store, names: string[]): Promise<ModelPricingSnapshot> {
  const values = await readPricingMaps(store);
  const nameSet = new Set(names.filter(Boolean));
  if (!nameSet.size) {
    for (const [key, entries] of Object.entries(values)) {
      for (const name of Object.keys(entries)) {
        if (key === PLUGIN_BILLING_EXPR_OPTION) {
          const split = splitPluginBillingExprKey(name);
          if (split) nameSet.add(split.model);
          continue;
        }
        nameSet.add(name);
      }
    }
    for (const name of Object.keys(BUILTIN_BILLING_EXPR)) nameSet.add(name);
  }
  const sorted = [...nameSet].sort();
  const selfUse = await store.optionBool("SelfUseModeEnabled", false);
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const entries: ModelPricingEntry[] = [];
  for (const name of sorted) {
    const configured = configuredFor(values, name);
    const effective = effectiveFor(values, name, selfUse);
    entries.push({
      model_name: name,
      version: await modelPricingVersion(configured),
      configured,
      effective,
      cache_write_mode: resolveCacheWriteMode(name, configured),
      billing_details: compactBillingDetails(resolveLegacyBillingDetails(name, effective, configured, quotaPerUnit)),
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
    if (key === PLUGIN_BILLING_EXPR_OPTION) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "plugin billing expressions must be a plugin-to-expression object";
      }
      for (const [plugin, expression] of Object.entries(value as Record<string, unknown>)) {
        if (typeof expression !== "string" || !expression.trim()) {
          return `model ${name}: plugin ${plugin}: billing expression is required`;
        }
      }
      continue;
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
    replaceModelPricing(values, name, pricing);
    updated.push(name);
  }
  for (const key of MODEL_PRICING_OPTION_KEYS) {
    await store.setOption(key, JSON.stringify(values[key]));
  }
  return updated;
}

export async function previewModelPricing(store: Store, name: string, draft: PricingValues | null): Promise<PricingValues> {
  if (!draft) throw new ModelPricingError("pricing draft is required", 200);
  const err = validatePricing(name, draft);
  if (err) throw new ModelPricingError(err, 200);
  const values = await readPricingMaps(store);
  replaceModelPricing(values, name, draft);
  return effectiveFor(values, name, await store.optionBool("SelfUseModeEnabled", false));
}

export async function previewModelPricingDescription(
  store: Store,
  name: string,
  draft: PricingValues | null,
): Promise<{ effective: PricingValues; cache_write_mode: CacheWriteMode; billing_details: LegacyBillingDetails }> {
  const effective = await previewModelPricing(store, name, draft);
  return {
    effective,
    cache_write_mode: resolveCacheWriteMode(name, draft || {}),
    billing_details: compactBillingDetails(
      resolveLegacyBillingDetails(name, effective, draft || {}, await store.optionNum("QuotaPerUnit", 500000)),
    ),
  };
}

function channelModels(models: string): string[] {
  if (!models) return [];
  return models.replace(/^,+|,+$/g, "").split(",");
}

function followChannelModelMapping(mapping: Record<string, string>, start: string): { upstream: string; cycle: boolean } {
  const map = { ...mapping };
  const candidates = [start, ...Object.values(map)];
  for (const candidate of candidates) {
    if (!map[candidate]) map[candidate] = map[baseModelName(candidate)] || "";
  }
  let current = start;
  const visited = new Set<string>([current]);
  for (;;) {
    const mapped = map[current];
    if (!mapped) return { upstream: current, cycle: false };
    if (visited.has(mapped)) {
      if (mapped === current) return { upstream: current, cycle: false };
      return { upstream: "", cycle: true };
    }
    visited.add(mapped);
    current = mapped;
  }
}

async function isTaskPluginModel(store: Store, name: string): Promise<boolean> {
  const plugins = (await store.listTaskPlugins()) as { source?: string; status?: string; enabled?: number }[];
  for (const plugin of plugins) {
    if (Number(plugin.enabled) === 0) continue;
    if (plugin.status && plugin.status !== "active" && plugin.status !== "enabled") continue;
    const meta = extractPluginMeta(String(plugin.source || ""));
    const models = Array.isArray(meta.models) ? (meta.models as unknown[]).map((m) => String(m)) : [];
    if (models.includes(name)) return true;
  }
  return false;
}

export async function previewModelPricingConversion(
  store: Store,
  name: string,
  draft: PricingValues | null,
): Promise<ModelPricingConversion> {
  if (!draft) throw new ModelPricingError("pricing draft is required", 200);
  const err = validatePricing(name, draft);
  if (err) throw new ModelPricingError(err, 200);
  if (draft["billing_setting.billing_mode"] === BILLING_MODE_TIERED_EXPR) {
    return { billing_details: {}, unsupported_reason: "This model already uses an expression." };
  }
  const legacyDraft: PricingValues = { ...draft, "billing_setting.billing_mode": BILLING_MODE_RATIO };
  const quotaPerUnit = await store.optionNum("QuotaPerUnit", 500000);
  const effective = await previewModelPricing(store, name, legacyDraft);
  const effectiveErr = validatePricing(name, effective);
  if (effectiveErr) throw new ModelPricingError(effectiveErr, 200);
  const fixedPrice = Object.prototype.hasOwnProperty.call(effective, "ModelPrice");
  const details = resolveLegacyBillingDetails(name, effective, draft, quotaPerUnit);
  if (details.invalid_audio_price) throw new ModelPricingError("audio prices must be finite", 200);
  if (details.conflicting_audio_prices) {
    return {
      effective,
      billing_details: compactBillingDetails(details),
      unsupported_reason: "Gemini and OpenAI audio prices differ for this model. Use separate billing model names to convert them.",
    };
  }
  if (await isTaskPluginModel(store, name)) {
    return {
      effective,
      billing_details: compactBillingDetails(details),
      unsupported_reason: "Task pricing must be converted manually using the task usage schema.",
    };
  }

  const channels = await store.channelsForModel(name);
  const names = [name];
  let aliPromptExtend = false;
  let otherImageRoute = false;
  for (const channel of channels) {
    if (!channelModels(channel.models).includes(name)) continue;
    if (channel.type === CHANNEL_TYPE_TASK_PLUGIN) {
      return {
        effective,
        billing_details: compactBillingDetails(details),
        unsupported_reason: "Task pricing must be converted manually using the task usage schema.",
      };
    }
    if (endpointTypesForChannel(channel.type, name).includes("openai-video")) {
      return {
        effective,
        billing_details: compactBillingDetails(details),
        unsupported_reason: "Video pricing must be converted manually.",
      };
    }
    if (channel.status === CHANNEL_ENABLED && channel.type === CHANNEL_TYPE_OPENROUTER && name.toLowerCase().includes("claude") && !fixedPrice) {
      const defaultRatio = defaultModelRatio[name];
      if (defaultRatio !== undefined && effective.ModelRatio === defaultRatio && asFloat(effective.CreateCacheRatio) !== 1) {
        return {
          effective,
          billing_details: compactBillingDetails(details),
          unsupported_reason: "This OpenRouter Claude price derives cache-write usage from upstream cost and must be converted manually.",
        };
      }
    }
    let upstream = name;
    if (channel.model_mapping) {
      let mapping: Record<string, string>;
      try {
        mapping = JSON.parse(channel.model_mapping) as Record<string, string>;
      } catch {
        return {
          effective,
          billing_details: compactBillingDetails(details),
          unsupported_reason: "The model routing configuration could not be verified.",
        };
      }
      const followed = followChannelModelMapping(mapping, name);
      if (followed.cycle) {
        return {
          effective,
          billing_details: compactBillingDetails(details),
          unsupported_reason: "The model routing configuration could not be verified.",
        };
      }
      upstream = followed.upstream;
      if (upstream !== name) names.push(upstream);
    }
    if (channel.status === CHANNEL_ENABLED) {
      if (channel.type === CHANNEL_TYPE_ALI && upstream.includes("z-image")) aliPromptExtend = true;
      else otherImageRoute = true;
    }
  }
  const previewDetails = { ...details };
  for (const modelName of names) {
    if (modelName.toLowerCase().includes("realtime")) {
      return {
        effective,
        billing_details: compactBillingDetails(previewDetails),
        unsupported_reason: "Realtime pricing must be converted manually.",
      };
    }
    if (fixedPrice && resolveLegacyBillingDetails(modelName, effective, draft, quotaPerUnit).image_count) {
      previewDetails.image_count = true;
    }
  }

  const meta = (await store.listModelMeta()) as { model_name?: string; name_rule?: number; endpoints?: string }[];
  for (const entry of meta) {
    const endpointsRaw = String(entry.endpoints || "");
    if (!endpointsRaw) continue;
    if (!names.some((n) => matchesName(Number(entry.name_rule || NAME_RULE_EXACT), String(entry.model_name || ""), n))) {
      continue;
    }
    let endpoints: Record<string, unknown>;
    try {
      endpoints = JSON.parse(endpointsRaw) as Record<string, unknown>;
    } catch {
      return {
        effective,
        billing_details: compactBillingDetails(previewDetails),
        unsupported_reason: "The model routing configuration could not be verified.",
      };
    }
    if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) continue;
    for (const endpoint of Object.keys(endpoints)) {
      if (endpoint === "image-generation" && fixedPrice) previewDetails.image_count = true;
      if (endpoint === "openai-video") {
        return {
          effective,
          billing_details: compactBillingDetails(previewDetails),
          unsupported_reason: "Video pricing must be converted manually.",
        };
      }
    }
  }

  let expression = "";
  let cacheWriteMode: CacheWriteMode | undefined;
  if (fixedPrice) {
    const price = asFloat(effective.ModelPrice) as number;
    expression = `tier("request", fixed(${shopspringString(price)}))`;
    if (previewDetails.image_count) {
      if (aliPromptExtend && otherImageRoute) {
        return {
          effective,
          billing_details: compactBillingDetails(previewDetails),
          unsupported_reason: "This model has different image request multipliers across channels. Use separate billing model names to convert them.",
        };
      }
      expression = `tier("image", fixed(${shopspringString(price)})) * image_count`;
      if (aliPromptExtend) {
        previewDetails.request_rules = [
          ...(previewDetails.request_rules || []),
          { condition: `param("parameters.prompt_extend") == true`, multiplier: Z_IMAGE_PROMPT_EXTEND_MULTIPLIER },
        ];
      }
      for (const rule of previewDetails.request_rules || []) {
        expression += ` * (${rule.condition} ? ${shopspringString(rule.multiplier)} : 1)`;
      }
    }
  } else {
    const ratio = asFloat(effective.ModelRatio);
    if (ratio === undefined) {
      return {
        effective,
        billing_details: compactBillingDetails(previewDetails),
        unsupported_reason: "Configure an input price before converting this model.",
      };
    }
    cacheWriteMode = resolveCacheWriteMode(name, draft);
    const base = legacyInputPricePerMillion(ratio, quotaPerUnit);
    const ordinaryAudio = previewDetails.audio_output_price !== undefined;
    if (ordinaryAudio && cacheWriteMode !== "none") previewDetails.audio_text_branches = true;
    const mergeCacheRead =
      base === 0 ||
      (cacheWriteMode === "none" && asFloat(effective.ImageRatio) === 1 && (previewDetails.audio_input_price === undefined || ordinaryAudio));
    let body = `tier("base", p * ${shopspringString(base)}`;
    for (const lane of [
      { variable: "c", key: "CompletionRatio", multiplier: 1 },
      { variable: "cr", key: "CacheRatio", multiplier: 1 },
      { variable: "cc", key: "CreateCacheRatio", multiplier: 1 },
      { variable: "cc1h", key: "CreateCacheRatio", multiplier: 6 / 3.75 },
      { variable: "img", key: "ImageRatio", multiplier: 1 },
    ] as const) {
      if (ordinaryAudio && !previewDetails.audio_text_branches && lane.variable !== "c") continue;
      if ((lane.variable === "cc" && cacheWriteMode === "none") || (lane.variable === "cc1h" && cacheWriteMode !== "claude_ttl")) {
        continue;
      }
      const multiplier = asFloat(effective[lane.key]) as number;
      if ((lane.variable === "img" || (lane.variable === "cr" && mergeCacheRead)) && multiplier === 1) continue;
      body += ` + ${lane.variable} * ${shopspringString(base * multiplier * lane.multiplier)}`;
    }
    for (const lane of [
      { variable: "ai", price: previewDetails.audio_input_price },
      { variable: "ao", price: previewDetails.audio_output_price },
    ]) {
      if (lane.price !== undefined && !previewDetails.audio_text_branches) {
        body += ` + ${lane.variable} * ${shopspringString(lane.price)}`;
      }
    }
    body += ")";
    expression = body;
    if (ordinaryAudio && previewDetails.audio_text_branches) {
      const completion = base * (asFloat(effective.CompletionRatio) as number);
      expression =
        `(ai > 0 || ao > 0) ? tier("audio", max(len - ai, 0) * ${shopspringString(base)} + c * ${shopspringString(completion)} + ai * ${shopspringString(previewDetails.audio_input_price as number)} + ao * ${shopspringString(previewDetails.audio_output_price as number)}) : ${expression}`;
    }
  }
  const smoke = smokeTestExpr(expression);
  if (smoke) throw new ModelPricingError(smoke.message, 200);
  const out: ModelPricingConversion = {
    effective,
    billing_details: compactBillingDetails(previewDetails),
    expression,
  };
  if (cacheWriteMode) out.cache_write_mode = cacheWriteMode;
  return out;
}
