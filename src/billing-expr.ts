/**
 * Original `pkg/billingexpr` compile + `billing_setting.SmokeTestExpr` (workerd sandbox).
 */
import { bytesToHex, sha256BytesSync, utf8Bytes } from "./jsplugin-sha256.js";
import { MAX_IMAGE_N, quotaRoundChecked, type QuotaClamp } from "./task-plugin-usage.js";

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
  "_trace",
  "_trace_int",
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

/** Original `billingexpr.RequestInput`. */
export type BillingRequestInput = {
  headers?: Record<string, string>;
  body?: unknown;
  usage?: Record<string, unknown>;
  imageCount?: number;
};

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
  estimatedBillingUnit?: BillingUnit;
  estimatedImageCount?: number;
  estimatedFixedPrice?: number;
  quotaPerUnit: number;
  exprVersion: number;
  taskUsageBilling: boolean;
  usageFacts: Record<string, unknown>;
};

export type RequestRuleTrace = {
  cond: string;
  multiplier: number;
  matched: boolean;
};

export type ExprTraceResult = {
  cost: number;
  matchedTier: string;
  billingUnit: BillingUnit;
  imageCount?: number;
  fixedPrice?: number;
  requestRules: RequestRuleTrace[];
};

export type TieredResult = {
  actualQuotaBeforeGroup: number;
  actualQuotaAfterGroup: number;
  matchedTier: string;
  crossedTier: boolean;
  clamp: QuotaClamp | null;
  billingUnit: BillingUnit;
  billingTokens?: TokenParams;
  imageCount?: number;
  fixedPrice?: number;
  requestRules?: RequestRuleTrace[];
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

const REQUEST_PROBE = /\b(?:param|header|hour|minute|weekday|month|day)\s*\(/;

type ExprTraceState = {
  matchedTier: string;
  billingUnit: BillingUnit;
  cost: number;
  imageCount?: number;
  fixedPrice?: number;
  requestRules: RequestRuleTrace[];
};

function skipString(body: string, start: number): number {
  const quote = body[start];
  for (let i = start + 1; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === quote) return i;
  }
  return body.length - 1;
}

function matchingParen(body: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      i = skipString(body, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseNumberLiteral(raw: string): { value: number; integer: boolean } | null {
  const text = raw.trim();
  if (/^-?\d+$/.test(text)) return { value: Number(text), integer: true };
  if (/^-?\d+\.\d+$/.test(text)) return { value: Number(text), integer: false };
  return null;
}

function parseTernaryRequestRule(inner: string): { cond: string; multiplier: number; integer: boolean } | null {
  let question = -1;
  let colon = -1;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'") {
      i = skipString(inner, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "?" && question < 0) question = i;
    else if (depth === 0 && c === ":" && question >= 0) {
      colon = i;
      break;
    }
  }
  if (question < 0 || colon < 0) return null;
  const cond = inner.slice(0, question).trim();
  const thenNum = parseNumberLiteral(inner.slice(question + 1, colon));
  const elseNum = parseNumberLiteral(inner.slice(colon + 1));
  if (!thenNum || !elseNum || elseNum.value !== 1) return null;
  if (!REQUEST_PROBE.test(cond)) return null;
  return { cond, multiplier: thenNum.value, integer: thenNum.integer && elseNum.integer };
}

/** Original `requestRulePatcher` compile-time `_trace` rewrite. */
function patchRequestRuleTraces(body: string): { body: string; rules: RequestRuleTrace[] } {
  const matches: { start: number; end: number; cond: string; multiplier: number; integer: boolean }[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      i = skipString(body, i);
      continue;
    }
    if (c !== "(") continue;
    const end = matchingParen(body, i);
    if (end < 0) continue;
    const parsed = parseTernaryRequestRule(body.slice(i + 1, end));
    if (!parsed) continue;
    matches.push({ start: i, end, ...parsed });
  }
  if (!matches.length) return { body, rules: [] };
  const rules: RequestRuleTrace[] = matches.map((match) => ({
    cond: match.cond,
    multiplier: match.multiplier,
    matched: false,
  }));
  let out = body;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const fn = match.integer ? "_trace_int" : "_trace";
    const multiplier = match.integer ? String(match.multiplier) : String(match.multiplier);
    out = `${out.slice(0, match.start)}(${fn}(${i}, ${match.cond}, ${multiplier}))${out.slice(match.end + 1)}`;
  }
  return { body: out, rules };
}

function reservedTraceIdentifier(body: string): string | null {
  if (/\b_trace_int\b/.test(body)) return "_trace_int";
  if (/\b_trace\b/.test(body)) return "_trace";
  return null;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = key.toLowerCase().trim();
    const v = String(value || "").trim();
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

function paramBody(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

/** Original gjson.GetBytes path used by `param()`. */
function gjsonGet(value: unknown, path: string): { exists: boolean; value: unknown } {
  const trimmed = path.trim();
  if (!trimmed) return { exists: false, value: undefined };
  let current: unknown = value;
  for (const part of trimmed.split(".")) {
    if (current == null || typeof current !== "object") return { exists: false, value: undefined };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return { exists: false, value: undefined };
      const idx = Number(part);
      if (idx < 0 || idx >= current.length) return { exists: false, value: undefined };
      current = current[idx];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function envFor(
  tokens: Partial<TokenParams> & { p: number; c: number; len: number },
  usage: Record<string, unknown> = {},
  trace?: ExprTraceState,
  imageCount = 1,
  request: BillingRequestInput = {},
) {
  const params = normalizeTokenParams(tokens);
  const headers = normalizeHeaders(request.headers);
  const body = paramBody(request.body);
  const noteRule = (ruleIndex: number, matched: boolean) => {
    if (trace && matched && ruleIndex >= 0 && ruleIndex < trace.requestRules.length) {
      trace.requestRules[ruleIndex].matched = true;
    }
  };
  return {
    image_count: imageCount,
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
      if (trace) {
        trace.billingUnit = "request";
        trace.fixedPrice = Number(amount);
      }
      return Number(amount) * 1_000_000;
    },
    _trace: (ruleIndex: number, matched: boolean, multiplier: number) => {
      noteRule(ruleIndex, matched);
      return matched ? multiplier : 1;
    },
    _trace_int: (ruleIndex: number, matched: boolean, multiplier: number) => {
      noteRule(ruleIndex, matched);
      return matched ? multiplier : 1;
    },
    header: (key: string) => headers[String(key || "").toLowerCase().trim()] || "",
    param: (path: string) => {
      const name = String(path || "").trim();
      if (!name || body == null) return null;
      const got = gjsonGet(body, name);
      return got.exists ? got.value : null;
    },
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

/** Original `billingexpr.CompileFromCache`. */
export function compileBillingExpr(exprStr: string): Error | null {
  const { body } = parseExprVersion(exprStr);
  if (!body.trim()) return new Error("billing expression is required");
  const reserved = reservedTraceIdentifier(body);
  if (reserved) return new Error(`expr compile error: identifier ${JSON.stringify(reserved)} is reserved for internal use`);
  try {
    compile(patchRequestRuleTraces(body).body);
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
  request: BillingRequestInput = {},
): ExprTraceResult {
  const { body } = parseExprVersion(exprStr);
  const reserved = reservedTraceIdentifier(body);
  if (reserved) throw new Error(`expr compile error: identifier ${JSON.stringify(reserved)} is reserved for internal use`);
  const patched = patchRequestRuleTraces(body);
  const fn = compile(patched.body);
  const vars = usedVars(exprStr) || {};
  let imageCount = 1;
  if (vars.image_count) {
    if (request.imageCount != null) {
      imageCount = Math.trunc(Number(request.imageCount));
    } else if (usage.image_count != null && usage.image_count !== "") {
      imageCount = Math.trunc(Number(usage.image_count));
    }
    if (!Number.isFinite(imageCount) || imageCount < 1 || imageCount > MAX_IMAGE_N) {
      throw new Error(`image_count must be between 1 and ${MAX_IMAGE_N}`);
    }
  }
  const trace: ExprTraceState = {
    matchedTier: "",
    billingUnit: "token",
    cost: 0,
    requestRules: patched.rules.map((rule) => ({ ...rule })),
  };
  if (vars.image_count) trace.imageCount = imageCount;
  const env = envFor(normalizeTokenParams(tokens), usage, trace, imageCount, request);
  const cost = Number(fn(...envValues(env)));
  if (!Number.isFinite(cost)) throw new Error(`expr run error: result is ${cost}`);
  return {
    cost,
    matchedTier: trace.matchedTier,
    billingUnit: trace.billingUnit,
    imageCount: trace.imageCount,
    fixedPrice: trace.fixedPrice,
    requestRules: trace.requestRules,
  };
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
  request: BillingRequestInput = {},
): TieredResult {
  if (snap.taskUsageBilling && usesFixedPricing(snap.exprString)) {
    throw new Error("fixed pricing is not supported for task usage expressions");
  }
  const tokens = normalizeTokenParams(params);
  const { cost, matchedTier, billingUnit, imageCount, fixedPrice, requestRules } = runExprWithRequest(
    snap.exprString,
    usage,
    tokens,
    request,
  );
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
  if (imageCount != null) result.imageCount = imageCount;
  if (fixedPrice != null) result.fixedPrice = fixedPrice;
  if (requestRules.length) result.requestRules = requestRules;
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
  if (snap.estimatedBillingUnit) out.estimated_billing_unit = snap.estimatedBillingUnit;
  if (snap.estimatedImageCount != null) out.estimated_image_count = snap.estimatedImageCount;
  if (snap.estimatedFixedPrice != null) out.estimated_fixed_price = snap.estimatedFixedPrice;
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
    estimatedBillingUnit: (stringField(obj.estimated_billing_unit ?? obj.estimatedBillingUnit) || undefined) as BillingSnapshot["estimatedBillingUnit"],
    estimatedImageCount:
      obj.estimated_image_count != null || obj.estimatedImageCount != null
        ? numberField(obj.estimated_image_count ?? obj.estimatedImageCount)
        : undefined,
    estimatedFixedPrice:
      obj.estimated_fixed_price != null || obj.estimatedFixedPrice != null
        ? numberField(obj.estimated_fixed_price ?? obj.estimatedFixedPrice)
        : undefined,
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
