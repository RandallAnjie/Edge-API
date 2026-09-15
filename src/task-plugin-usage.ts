/**
 * Original jsplugin `TaskAdaptor` usage hooks + `relay.recalcQuotaFromRatios`
 * on workerd: EstimateBilling, ExtractUsageFacts, AdjustBillingOnSubmit.
 */
import type { PluginEngine } from "./jsplugin.js";
import { pluginUsageForModel } from "./plugin-meta.js";

/** Original `common.MaxQuota` / `MinQuota`. */
export const MAX_QUOTA = 2147483647;
export const MIN_QUOTA = -2147483648;
/** Original `relaycommon.MaxTaskDurationSeconds`. */
export const MAX_TASK_DURATION_SECONDS = 3600;
/** Original `dto.MaxImageN`. */
export const MAX_IMAGE_N = 128;

export type QuotaClamp = {
  op: string;
  kind: "overflow" | "underflow" | "nan";
  original: number;
  clamped: number;
};

/** Original `common.QuotaClamp.AuditMap` (`quota_math.go`). */
export function quotaClampAuditMap(
  clamp: QuotaClamp | null | undefined,
): { op: string; kind: string; original: number; clamped: number } | null {
  if (!clamp) return null;
  return {
    op: clamp.op,
    kind: clamp.kind,
    original: clamp.original,
    clamped: clamp.clamped,
  };
}

export type UsageFieldSchema = {
  type: string;
  unit: string;
  enum: string[];
};

export type UsageRatiosOk = { ratios: Record<string, number> | null };
export type UsageRatiosErr = { error: string };
export type UsageRatiosResult = UsageRatiosOk | UsageRatiosErr;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pluginMeta(engine: PluginEngine): Record<string, unknown> {
  try {
    const meta = engine.export("meta");
    return isPlainObject(meta) ? meta : {};
  } catch {
    return {};
  }
}

function fieldSchemaMap(raw: Record<string, unknown> | undefined): Record<string, UsageFieldSchema> {
  const out: Record<string, UsageFieldSchema> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    out[key] = {
      type: String(value.type || ""),
      unit: String(value.unit || ""),
      enum: Array.isArray(value.enum) ? value.enum.map((item) => String(item)) : [],
    };
  }
  return out;
}

/** Original `TaskAdaptor.usageNumber`. */
export function usageNumber(value: unknown, allowNumericString: boolean): { number: number; numeric: boolean } {
  if (typeof value === "number") return { number: value, numeric: true };
  if (typeof value === "string") {
    if (!allowNumericString) return { number: 0, numeric: false };
    const trimmed = value.trim();
    if (!trimmed) return { number: 0, numeric: false };
    if (trimmed.toLowerCase() === "nan") return { number: Number.NaN, numeric: true };
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) return { number: 0, numeric: false };
    return { number: parsed, numeric: true };
  }
  return { number: 0, numeric: false };
}

/** Original `TaskAdaptor.canonicalUsageLimit`. */
export function canonicalUsageLimit(key: string): { limit: number; canonical: boolean } {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  switch (normalized) {
    case "duration":
    case "durationseconds":
    case "second":
    case "seconds":
      return { limit: MAX_TASK_DURATION_SECONDS, canonical: true };
    case "n":
    case "count":
    case "imagecount":
    case "samplecount":
    case "batchcount":
    case "numimages":
      return { limit: MAX_IMAGE_N, canonical: true };
    default:
      return { limit: 0, canonical: false };
  }
}

/** Original `TaskAdaptor.validateUsageNumberLimit`. */
export function validateUsageNumberLimit(number: number, limit: number): string | null {
  if (Number.isNaN(number) || !Number.isFinite(number) || number < 0) {
    return "plugin usage value must be a finite non-negative number";
  }
  if (number > limit) return "plugin usage value exceeds the host limit";
  return null;
}

/** Original `common.QuotaFromFloatChecked`. */
export function quotaFromFloatChecked(value: number): { quota: number; clamp: QuotaClamp | null } {
  if (Number.isNaN(value)) {
    return { quota: 0, clamp: { op: "QuotaFromFloat", kind: "nan", original: value, clamped: 0 } };
  }
  if (value > MAX_QUOTA) {
    return { quota: MAX_QUOTA, clamp: { op: "QuotaFromFloat", kind: "overflow", original: value, clamped: MAX_QUOTA } };
  }
  if (value < MIN_QUOTA) {
    return { quota: MIN_QUOTA, clamp: { op: "QuotaFromFloat", kind: "underflow", original: value, clamped: MIN_QUOTA } };
  }
  return { quota: Math.trunc(value), clamp: null };
}

/** Original `common.QuotaRound` / `QuotaRoundChecked`. */
export function quotaRoundChecked(value: number): { quota: number; clamp: QuotaClamp | null } {
  if (Number.isNaN(value)) {
    return { quota: 0, clamp: { op: "QuotaRound", kind: "nan", original: value, clamped: 0 } };
  }
  const rounded = Math.round(value);
  if (rounded > MAX_QUOTA) {
    return { quota: MAX_QUOTA, clamp: { op: "QuotaRound", kind: "overflow", original: rounded, clamped: MAX_QUOTA } };
  }
  if (rounded < MIN_QUOTA) {
    return { quota: MIN_QUOTA, clamp: { op: "QuotaRound", kind: "underflow", original: rounded, clamped: MIN_QUOTA } };
  }
  return { quota: rounded, clamp: null };
}

/** Original `common.QuotaFromFloat`. */
export function quotaFromFloat(value: number): number {
  return quotaFromFloatChecked(value).quota;
}

/**
 * Original `common.QuotaFromDecimalChecked`.
 * shopspring `decimal.Round(0)` is half-away-from-zero; JS `Math.round` matches
 * for non-negative quotas used on the WSS path.
 */
export function quotaFromDecimalChecked(value: number): { quota: number; clamp: QuotaClamp | null } {
  if (Number.isNaN(value)) {
    return { quota: 0, clamp: { op: "QuotaFromDecimal", kind: "nan", original: value, clamped: 0 } };
  }
  const rounded = Math.round(value);
  if (rounded > MAX_QUOTA) {
    return { quota: MAX_QUOTA, clamp: { op: "QuotaFromDecimal", kind: "overflow", original: value, clamped: MAX_QUOTA } };
  }
  if (rounded < MIN_QUOTA) {
    return { quota: MIN_QUOTA, clamp: { op: "QuotaFromDecimal", kind: "underflow", original: value, clamped: MIN_QUOTA } };
  }
  return { quota: rounded, clamp: null };
}

/** Original `common.QuotaFromDecimal`. */
export function quotaFromDecimal(value: number): number {
  return quotaFromDecimalChecked(value).quota;
}

/** Original `common.QuotaClamp.Error`. */
export function quotaClampMessage(clamp: QuotaClamp): string {
  return `quota conversion (${clamp.op}) ${clamp.kind}: original=${clamp.original}, clamped=${clamp.clamped}`;
}

/** Original `types.isValidOtherRatio`. */
export function isValidOtherRatio(ratio: number): boolean {
  return ratio > 0 && ratio !== Number.POSITIVE_INFINITY;
}

/** Original `PriceData.OtherRatioMultiplier`. */
export function otherRatioMultiplier(ratios: Record<string, number> | null | undefined): number {
  let multiplier = 1;
  if (!ratios) return multiplier;
  for (const ratio of Object.values(ratios)) {
    if (isValidOtherRatio(ratio) && ratio !== 1) multiplier *= ratio;
  }
  return multiplier;
}

/** Original `PriceData.ApplyOtherRatiosToFloat`. */
export function applyOtherRatiosToFloat(value: number, ratios: Record<string, number> | null | undefined): number {
  return value * otherRatioMultiplier(ratios);
}

/** Original `PriceData.ApplyOtherRatiosToDecimal`. */
export function applyOtherRatiosToDecimal(value: number, ratios: Record<string, number> | null | undefined): number {
  if (!ratios) return value;
  for (const ratio of Object.values(ratios)) {
    if (isValidOtherRatio(ratio) && ratio !== 1) value *= ratio;
  }
  return value;
}

/** Original `PriceData.RemoveOtherRatiosFromFloat`. */
export function removeOtherRatiosFromFloat(value: number, ratios: Record<string, number> | null | undefined): number {
  if (!ratios) return value;
  for (const ratio of Object.values(ratios)) {
    if (isValidOtherRatio(ratio) && ratio !== 1) value /= ratio;
  }
  return value;
}

/** Original `PriceData.ReplaceOtherRatios`. */
export function replaceOtherRatios(ratios: Record<string, number> | null | undefined): Record<string, number> | null {
  const next: Record<string, number> = {};
  if (ratios) {
    for (const [key, ratio] of Object.entries(ratios)) {
      if (isValidOtherRatio(ratio)) next[key] = ratio;
    }
  }
  return Object.keys(next).length ? next : null;
}

/** Original `relay.recalcQuotaFromRatios` + `noteTaskQuotaClamp`. */
export function recalcQuotaFromRatios(
  quota: number,
  current: Record<string, number>,
  ratios: Record<string, number>,
): { quota: number; ratios: Record<string, number>; clamp: QuotaClamp | null } | null {
  const baseQuota = removeOtherRatiosFromFloat(quota, current);
  const replaced = replaceOtherRatios(ratios);
  if (!replaced) return null;
  const checked = quotaFromFloatChecked(applyOtherRatiosToFloat(baseQuota, replaced));
  return { quota: checked.quota, ratios: replaced, clamp: checked.clamp };
}

/** Original `TaskAdaptor.validateUsageValue`. */
export function validateUsageValue(
  value: unknown,
  schema: UsageFieldSchema,
  allowNumericString: boolean,
): { number: number } | { error: string } {
  if (schema.enum.length) {
    if (typeof value !== "string") return { error: "plugin usage enum must be a string" };
    if (schema.enum.includes(value)) return { number: 0 };
    return { error: "plugin usage enum is not an allowed value" };
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return { error: "plugin usage value must be a boolean" };
    return { number: 0 };
  }
  const parsed = usageNumber(value, allowNumericString);
  if (!parsed.numeric) return { error: "plugin usage value must be a number" };
  if (schema.unit === "token" || schema.unit === "credit") {
    if (Number.isNaN(parsed.number) || !Number.isFinite(parsed.number) || parsed.number < 0) {
      return { error: "plugin usage value must be a finite non-negative number" };
    }
    const checked = quotaFromFloatChecked(parsed.number);
    if (checked.clamp) return { number: checked.quota };
    return { number: parsed.number };
  }
  const limit = schema.unit === "count" ? MAX_IMAGE_N : MAX_TASK_DURATION_SECONDS;
  const err = validateUsageNumberLimit(parsed.number, limit);
  if (err) return { error: err };
  return { number: parsed.number };
}

/** Original `TaskAdaptor.validateUsageLimit`. */
export function validateUsageLimit(value: unknown, limit: number, allowNumericString: boolean): string | null {
  const parsed = usageNumber(value, allowNumericString);
  if (!parsed.numeric) return "plugin usage value must be a number";
  return validateUsageNumberLimit(parsed.number, limit);
}

/** Original `TaskAdaptor.validateResolvedUsageValue`. */
export function validateResolvedUsageValue(
  value: unknown,
  usageSchema: Record<string, UsageFieldSchema>,
): string | null {
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(usageSchema, key)) {
        const checked = validateUsageValue(item, usageSchema[key], true);
        if ("error" in checked) return checked.error;
      } else {
        const canonical = canonicalUsageLimit(key);
        if (canonical.canonical) {
          const err = validateUsageLimit(item, canonical.limit, true);
          if (err) return err;
        }
      }
      const nested = validateResolvedUsageValue(item, usageSchema);
      if (nested) return nested;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = validateResolvedUsageValue(item, usageSchema);
      if (nested) return nested;
    }
  }
  return null;
}

/** Original `TaskAdaptor.validateResolvedUsageRequest`. */
export function validateResolvedUsageRequest(
  request: unknown,
  modelName: string,
  meta: Record<string, unknown>,
): string | null {
  return validateResolvedUsageValue(request, fieldSchemaMap(pluginUsageForModel(meta, modelName).usageSchema));
}

/** Original ValidateRequestAndSetAction usage-profile gate. */
export function pluginHasUsageProfiles(engine: PluginEngine): boolean {
  const profiles = pluginMeta(engine).usageProfiles;
  return Array.isArray(profiles) && profiles.length > 0;
}

/** Original `TaskAdaptor.validatedUsageRatios`. Mutates `facts` like the Go map. */
export function validatedUsageRatios(
  facts: Record<string, unknown>,
  modelName: string,
  meta: Record<string, unknown>,
): UsageRatiosResult {
  const usageSchema = fieldSchemaMap(pluginUsageForModel(meta, modelName).usageSchema);
  const ratios: Record<string, number> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (Object.prototype.hasOwnProperty.call(usageSchema, key)) {
      const schema = usageSchema[key];
      const checked = validateUsageValue(value, schema, false);
      if ("error" in checked) return { error: checked.error };
      if (schema.type === "number") {
        facts[key] = checked.number;
        if (checked.number > 0) ratios[key] = checked.number;
      }
      continue;
    }
    const parsed = usageNumber(value, false);
    if (!parsed.numeric) continue;
    const canonical = canonicalUsageLimit(key);
    const limit = canonical.canonical ? canonical.limit : MAX_TASK_DURATION_SECONDS;
    const err = validateUsageNumberLimit(parsed.number, limit);
    if (err) return { error: err };
    facts[key] = parsed.number;
    if (parsed.number > 0) ratios[key] = parsed.number;
  }
  return { ratios };
}

/** Original `TaskAdaptor.usageRatios`. */
export function usageRatios(engine: PluginEngine, modelName: string, hook: string, ...args: unknown[]): UsageRatiosResult {
  if (!engine.hasCallablePath(hook)) return { ratios: null };
  let value: unknown;
  try {
    value = engine.call(hook, ...args);
  } catch {
    return { error: "plugin usage hook failed" };
  }
  if (value == null) return { ratios: null };
  if (!isPlainObject(value)) return { error: "plugin usage hook must return an object" };
  const facts = { ...value };
  const validated = validatedUsageRatios(facts, modelName, pluginMeta(engine));
  if ("error" in validated) return validated;
  return { ratios: validated.ratios };
}

/** Original `TaskAdaptor.EstimateBillingValidated`. */
export function estimateBillingValidated(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  modelName: string,
): UsageRatiosResult {
  const usageContext = { ...submitContext, usagePurpose: "billing_ratios" };
  return usageRatios(engine, modelName, "extractUsage", usageContext);
}

/** Original `TaskAdaptor.EstimateBilling` — rejected facts become nil, not a request error. */
export function estimateBilling(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  modelName: string,
): Record<string, number> | null {
  const result = estimateBillingValidated(engine, submitContext, modelName);
  if ("error" in result) return null;
  return result.ratios;
}

/** Original `TaskAdaptor.ExtractUsageFactsValidated`. */
export function extractUsageFactsValidated(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  modelName: string,
): { facts: Record<string, unknown> | null } | UsageRatiosErr {
  if (!engine.hasCallablePath("extractUsage")) return { facts: null };
  const usageContext = { ...submitContext, usagePurpose: "facts" };
  let value: unknown;
  try {
    value = engine.call("extractUsage", usageContext);
  } catch {
    return { error: "plugin usage hook failed" };
  }
  if (value == null) return { facts: null };
  if (!isPlainObject(value)) return { error: "plugin usage hook must return an object" };
  const facts = { ...value };
  const validated = validatedUsageRatios(facts, modelName, pluginMeta(engine));
  if ("error" in validated) return validated;
  return { facts };
}

/** Original `TaskAdaptor.ExtractUsageFacts`. */
export function extractUsageFacts(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  modelName: string,
): Record<string, unknown> | null {
  const result = extractUsageFactsValidated(engine, submitContext, modelName);
  if ("error" in result) return null;
  return result.facts;
}

/** Original `common.Unmarshal` of TaskData for AdjustBillingOnSubmit. */
export function unmarshalTaskData(taskData: unknown): unknown {
  if (taskData == null) return "";
  if (taskData instanceof Uint8Array) {
    const text = new TextDecoder().decode(taskData);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof taskData === "string") {
    try {
      return JSON.parse(taskData);
    } catch {
      return taskData;
    }
  }
  return taskData;
}

/** Original `TaskAdaptor.AdjustBillingOnSubmit`. Invalid/missing hooks return nil. */
export function adjustBillingOnSubmit(
  engine: PluginEngine,
  submitContext: Record<string, unknown>,
  modelName: string,
  taskData: unknown,
): Record<string, number> | null {
  const data = unmarshalTaskData(taskData);
  const result = usageRatios(engine, modelName, "extractUsageOnSubmit", submitContext, data);
  if ("error" in result) return null;
  return result.ratios;
}

/** Original RelayTask step 11: immediate FAILURE zeros quota, else AdjustBillingOnSubmit. */
export function applyRelayTaskSubmitBilling(opts: {
  engine: PluginEngine;
  submitContext: Record<string, unknown>;
  modelName: string;
  taskData: unknown;
  immediate: Record<string, unknown> | null;
  quota: number;
  otherRatios: Record<string, number>;
}): { quota: number; otherRatios: Record<string, number>; clamp: QuotaClamp | null } {
  if (opts.immediate && String(opts.immediate.status || "") === "FAILURE") {
    return { quota: 0, otherRatios: opts.otherRatios, clamp: null };
  }
  const adjusted = adjustBillingOnSubmit(opts.engine, opts.submitContext, opts.modelName, opts.taskData);
  if (adjusted && Object.keys(adjusted).length) {
    const recalced = recalcQuotaFromRatios(opts.quota, opts.otherRatios, adjusted);
    if (recalced) return { quota: recalced.quota, otherRatios: recalced.ratios, clamp: recalced.clamp };
  }
  return { quota: opts.quota, otherRatios: opts.otherRatios, clamp: null };
}

/** Original `TaskAdaptor.validatedCompletionUsageFacts`. */
export function validatedCompletionUsageFacts(
  facts: unknown,
  modelName: string,
  meta: Record<string, unknown>,
): { facts: Record<string, unknown> | null } | UsageRatiosErr {
  if (facts == null) return { facts: null };
  if (!isPlainObject(facts)) return { error: "plugin usage hook must return an object" };
  const usageSchema = fieldSchemaMap(pluginUsageForModel(meta, modelName).usageSchema);
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    validated[key] = value;
    if (Object.prototype.hasOwnProperty.call(usageSchema, key)) {
      const checked = validateUsageValue(value, usageSchema[key], false);
      if ("error" in checked) return { error: checked.error };
      if (usageSchema[key].type === "number") validated[key] = checked.number;
      continue;
    }
    const canonical = canonicalUsageLimit(key);
    if (canonical.canonical) {
      const parsed = usageNumber(value, false);
      if (!parsed.numeric) return { error: "plugin usage value must be a number" };
      const err = validateUsageNumberLimit(parsed.number, canonical.limit);
      if (err) return { error: err };
      validated[key] = parsed.number;
      continue;
    }
    if (key === "upstreamUnits" || key === "completionTokens" || key === "totalTokens") {
      const parsed = usageNumber(value, false);
      if (!parsed.numeric || Number.isNaN(parsed.number) || !Number.isFinite(parsed.number) || parsed.number < 0) {
        return { error: "plugin usage value must be a finite non-negative number" };
      }
      validated[key] = quotaFromFloat(parsed.number);
      continue;
    }
    const parsed = usageNumber(value, false);
    if (parsed.numeric) validated[key] = parsed.number;
  }
  return { facts: validated };
}
