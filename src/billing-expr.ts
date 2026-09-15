/**
 * Original `pkg/billingexpr` compile + `billing_setting.SmokeTestExpr` (workerd sandbox).
 */
import { bytesToHex, sha256BytesSync, utf8Bytes } from "./jsplugin-sha256.js";
import { quotaRoundChecked, type QuotaClamp } from "./task-plugin-usage.js";

const TOKEN_VECTORS = [
  { p: 0, c: 0, len: 0 },
  { p: 1000, c: 1000, len: 1000 },
  { p: 100000, c: 100000, len: 100000 },
  { p: 1000000, c: 1000000, len: 1000000 },
];

const FORBIDDEN = /\b(?:Function|eval|globalThis|process|constructor|import|require)\b/;

const EXPR_ENV_KEYS = [
  "image_count",
  "p",
  "c",
  "len",
  "cr",
  "cc",
  "cc1h",
  "img",
  "img_cr",
  "img_o",
  "ai",
  "ao",
  "tier",
  "fixed",
  "header",
  "param",
  "u",
  "has",
  "hour",
  "minute",
  "weekday",
  "month",
  "day",
  "max",
  "min",
  "abs",
  "ceil",
  "floor",
] as const;

export type BillingUnit = "token" | "request";

/** Original `billingexpr.TokenParams` (log `billing_tokens` keys). */
export type TokenParams = {
  p: number;
  c: number;
  len: number;
  cr: number;
  cc: number;
  cc1h: number;
  img: number;
  img_cr: number;
  img_o: number;
  ai: number;
  ao: number;
};

export function emptyTokenParams(): TokenParams {
  return { p: 0, c: 0, len: 0, cr: 0, cc: 0, cc1h: 0, img: 0, img_cr: 0, img_o: 0, ai: 0, ao: 0 };
}

export function normalizeTokenParams(tokens?: Partial<TokenParams> | { p?: number; c?: number; len?: number }): TokenParams {
  return { ...emptyTokenParams(), ...(tokens || {}) };
}

export type BillingSnapshot = {
  billingMode: string;
  modelName: string;
  exprString: string;
  exprHash: string;
  groupRatio: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedQuotaBeforeGroup: number;
  estimatedQuotaAfterGroup: number;
  estimatedTier: string;
  quotaPerUnit: number;
  exprVersion: number;
  taskUsageBilling: boolean;
  usageFacts: Record<string, unknown>;
};

export type ExprTraceResult = {
  cost: number;
  matchedTier: string;
  billingUnit: BillingUnit;
};

export type TieredResult = {
  actualQuotaBeforeGroup: number;
  actualQuotaAfterGroup: number;
  matchedTier: string;
  crossedTier: boolean;
  clamp: QuotaClamp | null;
  billingUnit: BillingUnit;
  billingTokens?: TokenParams;
};

export function parseExprVersion(exprStr: string): { version: number; body: string } {
  if (exprStr.startsWith("v1:")) return { version: 1, body: exprStr.slice(3) };
  return { version: 1, body: exprStr };
}

/** Original `billingexpr.ExprVersion`. */
export function exprVersion(exprStr: string): number {
  return parseExprVersion(exprStr).version;
}

/** Original `billingexpr.ExprHashString`. */
export function exprHashString(expr: string): string {
  return bytesToHex(sha256BytesSync(utf8Bytes(expr)));
}

/** Original `billingexpr.UsedVars` identifier names (strings stripped). */
export function usedVars(exprStr: string): Record<string, boolean> | null {
  if (!exprStr) return null;
  const { body } = parseExprVersion(exprStr);
  const stripped = body.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
  const vars: Record<string, boolean> = {};
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    if (match[0] === "_trace" || match[0] === "_trace_int") continue;
    vars[match[0]] = true;
  }
  return Object.keys(vars).length ? vars : null;
}

/** Original `billingexpr.UsedUsageKeys` (literal `u("...")` only). */
export function usedUsageKeys(exprStr: string): Record<string, boolean> | null {
  if (!exprStr) return null;
  const keys: Record<string, boolean> = {};
  const re = /\bu\(\s*"([^"]*)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(exprStr))) {
    keys[match[1].trim()] = true;
  }
  return Object.keys(keys).length ? keys : null;
}

export function usesFixedPricing(exprStr: string): boolean {
  return /\bfixed\s*\(/.test(parseExprVersion(exprStr).body);
}

function rewriteExpr(body: string): string {
  return body.replace(/\bnil\b/g, "null").replace(/\band\b/g, "&&").replace(/\bor\b/g, "||");
}

function envFor(
  tokens: Partial<TokenParams> & { p: number; c: number; len: number },
  usage: Record<string, unknown> = {},
  trace?: { matchedTier: string; billingUnit: BillingUnit; cost: number },
) {
  const params = normalizeTokenParams(tokens);
  return {
    image_count: 1,
    p: params.p,
    c: params.c,
    len: params.len,
    cr: params.cr,
    cc: params.cc,
    cc1h: params.cc1h,
    img: params.img,
    img_cr: params.img_cr,
    img_o: params.img_o,
    ai: params.ai,
    ao: params.ao,
    tier: (name: string, value: number) => {
      const cost = Number(value);
      if (trace) {
        trace.matchedTier = String(name);
        trace.cost = cost;
      }
      return cost;
    },
    fixed: (amount: number) => {
      if (trace) trace.billingUnit = "request";
      return Number(amount) * 1_000_000;
    },
    header: (_key: string) => "",
    param: () => null,
    u: (key: string) => {
      const name = String(key || "").trim();
      if (!name || !usage || !Object.prototype.hasOwnProperty.call(usage, name)) return null;
      return usage[name];
    },
    has: (source: unknown, substr: string) => {
      if (source == null || !substr) return false;
      return String(source).includes(String(substr));
    },
    hour: () => 0,
    minute: () => 0,
    weekday: () => 0,
    month: () => 0,
    day: () => 0,
    max: Math.max,
    min: Math.min,
    abs: Math.abs,
    ceil: Math.ceil,
    floor: Math.floor,
  };
}

function compile(body: string): (...args: unknown[]) => number {
  if (FORBIDDEN.test(body)) throw new Error("expression validation failed");
  const rewritten = rewriteExpr(body);
  return new Function(...EXPR_ENV_KEYS, `"use strict"; return (${rewritten});`) as (...args: unknown[]) => number;
}

function envValues(env: ReturnType<typeof envFor>): unknown[] {
  return EXPR_ENV_KEYS.map((key) => env[key]);
}

function run(fn: (...args: unknown[]) => number, tokens: { p: number; c: number; len: number }, usage: Record<string, unknown> = {}): number {
  const env = envFor(tokens, usage);
  const result = Number(fn(...envValues(env)));
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`vector {p=${tokens.p}, c=${tokens.c}}: result must be finite and non-negative, got ${result}`);
  }
  return result;
}

/** Original `billingexpr.CompileFromCache` (workerd Function sandbox). */
export function compileBillingExpr(exprStr: string): Error | null {
  const { body } = parseExprVersion(exprStr);
  if (!body.trim()) return new Error("billing expression is required");
  try {
    compile(body);
    return null;
  } catch (err) {
    return new Error(`expr compile error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Original `billingexpr.RunExprWithRequest`. */
export function runExprWithRequest(
  exprStr: string,
  usage: Record<string, unknown> = {},
  tokens: Partial<TokenParams> & { p?: number; c?: number; len?: number } = {},
): ExprTraceResult {
  const { body } = parseExprVersion(exprStr);
  const fn = compile(body);
  const trace: { matchedTier: string; billingUnit: BillingUnit; cost: number } = {
    matchedTier: "",
    billingUnit: "token",
    cost: 0,
  };
  const env = envFor(normalizeTokenParams(tokens), usage, trace);
  const cost = Number(fn(...envValues(env)));
  if (!Number.isFinite(cost)) throw new Error(`expr run error: result is ${cost}`);
  return { cost, matchedTier: trace.matchedTier, billingUnit: trace.billingUnit };
}

function quotaConversion(exprOutput: number, snap: BillingSnapshot): number {
  if (snap.taskUsageBilling) return exprOutput * snap.quotaPerUnit;
  return (exprOutput / 1_000_000) * snap.quotaPerUnit;
}

/** Original `billingexpr.ComputeTieredQuota`. */
export function computeTieredQuota(snap: BillingSnapshot, params: TokenParams): TieredResult {
  return computeTieredQuotaWithRequest(snap, snap.usageFacts || {}, params);
}

/** Original `billingexpr.ComputeTieredQuotaWithRequest`. */
export function computeTieredQuotaWithRequest(
  snap: BillingSnapshot,
  usage: Record<string, unknown> = {},
  params?: Partial<TokenParams>,
): TieredResult {
  if (snap.taskUsageBilling && usesFixedPricing(snap.exprString)) {
    throw new Error("fixed pricing is not supported for task usage expressions");
  }
  const tokens = normalizeTokenParams(params);
  const { cost, matchedTier, billingUnit } = runExprWithRequest(snap.exprString, usage, tokens);
  const quotaBeforeGroup = quotaConversion(cost, snap);
  const afterGroup = quotaRoundChecked(quotaBeforeGroup * snap.groupRatio);
  const result: TieredResult = {
    actualQuotaBeforeGroup: quotaBeforeGroup,
    actualQuotaAfterGroup: afterGroup.quota,
    matchedTier,
    crossedTier: matchedTier !== snap.estimatedTier,
    clamp: afterGroup.clamp,
    billingUnit,
  };
  if (billingUnit === "token" && usedVars(snap.exprString)?.img_cr) result.billingTokens = tokens;
  return result;
}

/** Original `service.EvaluateTaskCompletionUsage`. */
export function evaluateTaskCompletionUsage(
  snap: BillingSnapshot,
  facts: Record<string, unknown> | null | undefined,
): { result: TieredResult; usage: Record<string, unknown> } {
  const usage: Record<string, unknown> = { ...(snap.usageFacts || {}), ...(facts || {}) };
  const result = computeTieredQuotaWithRequest(snap, usage);
  if (result.actualQuotaBeforeGroup < 0 || Number.isNaN(result.actualQuotaBeforeGroup)) {
    throw new Error("task completion expression produced an invalid cost");
  }
  return { result, usage };
}

/** Original BillingSnapshot JSON (`json` struct tags). */
export function billingSnapshotJSON(snap: BillingSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {
    billing_mode: snap.billingMode,
    model_name: snap.modelName,
    expr_string: snap.exprString,
    expr_hash: snap.exprHash,
    group_ratio: snap.groupRatio,
    estimated_prompt_tokens: snap.estimatedPromptTokens,
    estimated_completion_tokens: snap.estimatedCompletionTokens,
    estimated_quota_before_group: snap.estimatedQuotaBeforeGroup,
    estimated_quota_after_group: snap.estimatedQuotaAfterGroup,
    estimated_tier: snap.estimatedTier,
    quota_per_unit: snap.quotaPerUnit,
    expr_version: snap.exprVersion,
  };
  if (snap.taskUsageBilling) out.task_usage_billing = true;
  if (snap.usageFacts && Object.keys(snap.usageFacts).length) out.usage_facts = snap.usageFacts;
  return out;
}

function numberField(raw: unknown, fallback = 0): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function stringField(raw: unknown, fallback = ""): string {
  return raw == null ? fallback : String(raw);
}

function usageFactsFrom(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

/** Original BillingSnapshot JSON restore from persisted `tiered_snapshot`. */
export function parseBillingSnapshot(raw: unknown): BillingSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const exprString = stringField(obj.expr_string ?? obj.exprString);
  if (!exprString) return null;
  const facts = usageFactsFrom(obj.usage_facts ?? obj.usageFacts);
  return {
    billingMode: stringField(obj.billing_mode ?? obj.billingMode, "tiered_expr"),
    modelName: stringField(obj.model_name ?? obj.modelName),
    exprString,
    exprHash: stringField(obj.expr_hash ?? obj.exprHash),
    groupRatio: numberField(obj.group_ratio ?? obj.groupRatio, 1),
    estimatedPromptTokens: numberField(obj.estimated_prompt_tokens ?? obj.estimatedPromptTokens),
    estimatedCompletionTokens: numberField(obj.estimated_completion_tokens ?? obj.estimatedCompletionTokens),
    estimatedQuotaBeforeGroup: numberField(obj.estimated_quota_before_group ?? obj.estimatedQuotaBeforeGroup),
    estimatedQuotaAfterGroup: numberField(obj.estimated_quota_after_group ?? obj.estimatedQuotaAfterGroup),
    estimatedTier: stringField(obj.estimated_tier ?? obj.estimatedTier),
    quotaPerUnit: numberField(obj.quota_per_unit ?? obj.quotaPerUnit, 500000) || 500000,
    exprVersion: numberField(obj.expr_version ?? obj.exprVersion, 1) || 1,
    taskUsageBilling: Boolean(obj.task_usage_billing ?? obj.taskUsageBilling),
    usageFacts: facts,
  };
}

/** Original `billing_setting.SmokeTestExpr`. */
export function smokeTestExpr(exprStr: string): Error | null {
  const compiled = compileBillingExpr(exprStr);
  if (compiled) return compiled;
  const keys = usedUsageKeys(exprStr);
  if (keys) {
    const sorted = Object.keys(keys).sort();
    return new Error(`expression references usage keys [${sorted.join(" ")}] but the model has no task plugin usage schema`);
  }
  try {
    const fn = compile(parseExprVersion(exprStr).body);
    for (const vector of TOKEN_VECTORS) {
      run(fn, vector);
      run(fn, vector);
    }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}

/** Original `billing_setting.SmokeTestTaskExpr`. */
export function smokeTestTaskExpr(exprStr: string, schema: Record<string, unknown>): Error | null {
  const compiled = compileBillingExpr(exprStr);
  if (compiled) return compiled;
  if (usesFixedPricing(exprStr)) {
    return new Error("fixed pricing is not supported for task usage expressions");
  }
  for (const key of Object.keys(usedUsageKeys(exprStr) || {})) {
    if (!(key in schema)) return new Error(`usage key ${JSON.stringify(key)} is not declared by the task plugin`);
  }
  try {
    const fn = compile(parseExprVersion(exprStr).body);
    for (const vector of TOKEN_VECTORS) {
      run(fn, vector, Object.fromEntries(Object.keys(schema).map((k) => [k, 0])));
    }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}
