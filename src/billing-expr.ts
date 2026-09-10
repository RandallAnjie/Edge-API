/** Original `pkg/billingexpr` compile + `billing_setting.SmokeTestExpr` (workerd sandbox). */

const TOKEN_VECTORS = [
  { p: 0, c: 0, len: 0 },
  { p: 1000, c: 1000, len: 1000 },
  { p: 100000, c: 100000, len: 100000 },
  { p: 1000000, c: 1000000, len: 1000000 },
];

const FORBIDDEN = /\b(?:Function|eval|globalThis|process|constructor|import|require)\b/;

export function parseExprVersion(exprStr: string): { version: number; body: string } {
  if (exprStr.startsWith("v1:")) return { version: 1, body: exprStr.slice(3) };
  return { version: 1, body: exprStr };
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

function envFor(tokens: { p: number; c: number; len: number }, usage: Record<string, unknown> = {}) {
  return {
    p: tokens.p,
    c: tokens.c,
    len: tokens.len,
    cr: 0,
    cc: 0,
    cc1h: 0,
    img: 0,
    img_o: 0,
    ai: 0,
    ao: 0,
    tier: (_name: string, value: number) => Number(value),
    fixed: (amount: number) => Number(amount) * 1_000_000,
    header: () => "",
    param: () => null,
    u: (key: string) => usage[key] ?? 0,
    has: (obj: unknown, key: string) => Boolean(obj && typeof obj === "object" && key in (obj as object)),
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
  const names = Object.keys(envFor({ p: 0, c: 0, len: 0 }));
  return new Function(...names, `"use strict"; return (${rewritten});`) as (...args: unknown[]) => number;
}

function run(fn: (...args: unknown[]) => number, tokens: { p: number; c: number; len: number }, usage: Record<string, unknown> = {}): number {
  const env = envFor(tokens, usage);
  const result = Number(fn(...Object.values(env)));
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`vector {p=${tokens.p}, c=${tokens.c}}: result must be finite and non-negative, got ${result}`);
  }
  return result;
}

/** Original `billing_setting.SmokeTestExpr`. */
export function smokeTestExpr(exprStr: string): Error | null {
  const { body } = parseExprVersion(exprStr);
  if (!body.trim()) return new Error("billing expression is required");
  let fn: (...args: unknown[]) => number;
  try {
    fn = compile(body);
  } catch (err) {
    return new Error(`expr compile error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const keys = usedUsageKeys(exprStr);
  if (keys) {
    const sorted = Object.keys(keys).sort();
    return new Error(`expression references usage keys [${sorted.join(" ")}] but the model has no task plugin usage schema`);
  }
  try {
    for (const vector of TOKEN_VECTORS) {
      run(fn, vector);
      run(fn, vector); // original also runs a second request-input vector
    }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}

/** Original `billing_setting.SmokeTestTaskExpr`. */
export function smokeTestTaskExpr(exprStr: string, schema: Record<string, unknown>): Error | null {
  const { body } = parseExprVersion(exprStr);
  if (!body.trim()) return new Error("billing expression is required");
  let fn: (...args: unknown[]) => number;
  try {
    fn = compile(body);
  } catch (err) {
    return new Error(`expr compile error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (usesFixedPricing(exprStr)) {
    return new Error("fixed pricing is not supported for task usage expressions");
  }
  for (const key of Object.keys(usedUsageKeys(exprStr) || {})) {
    if (!(key in schema)) return new Error(`usage key ${JSON.stringify(key)} is not declared by the task plugin`);
  }
  try {
    for (const vector of TOKEN_VECTORS) {
      run(fn, vector, Object.fromEntries(Object.keys(schema).map((k) => [k, 0])));
    }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}
