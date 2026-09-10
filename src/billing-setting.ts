import { getModelPriceFromMap, hasConfiguredModelRatio } from "./ratio-setting.js";

export const BILLING_MODE_RATIO = "ratio";
export const BILLING_MODE_TIERED_EXPR = "tiered_expr";

/** Original `billing_setting.builtinBillingExpr`. */
export const BUILTIN_BILLING_EXPR: Record<string, string> = {
  "gpt-6-astra":
    'len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + cc * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + cc * 25)',
};

export function getBuiltinBillingExpr(model: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_BILLING_EXPR, model) ? BUILTIN_BILLING_EXPR[model] : undefined;
}

export type BillingMaps = {
  billing_mode: Record<string, string>;
  billing_expr: Record<string, string>;
};

function stringMap(raw: Record<string, unknown> | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

/** Original `billing_setting.GetBillingMode`. */
export function getBillingMode(
  model: string,
  persistedModes: Record<string, string>,
  modelRatio: Record<string, unknown> | Record<string, number> = {},
  modelPrice: Record<string, unknown> | Record<string, number> = {},
): string {
  if (Object.prototype.hasOwnProperty.call(persistedModes, model)) return persistedModes[model];
  if (getBuiltinBillingExpr(model)) {
    if (hasConfiguredModelRatio(model, modelRatio)) return BILLING_MODE_RATIO;
    if (getModelPriceFromMap(model, modelPrice).configured) return BILLING_MODE_RATIO;
    return BILLING_MODE_TIERED_EXPR;
  }
  return BILLING_MODE_RATIO;
}

/** Original `billing_setting.GetBillingExpr`. */
export function getBillingExpr(
  model: string,
  persistedModes: Record<string, string>,
  persistedExprs: Record<string, string>,
  modelRatio: Record<string, unknown> | Record<string, number> = {},
  modelPrice: Record<string, unknown> | Record<string, number> = {},
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(persistedExprs, model)) return persistedExprs[model];
  if (getBillingMode(model, persistedModes, modelRatio, modelPrice) === BILLING_MODE_TIERED_EXPR) {
    return getBuiltinBillingExpr(model);
  }
  return undefined;
}

/** Original `GetBillingModeCopy` + `GetBillingExprCopy`. */
export function billingCopies(opts: {
  billingMode?: Record<string, unknown> | Record<string, string>;
  billingExpr?: Record<string, unknown> | Record<string, string>;
  modelRatio?: Record<string, unknown> | Record<string, number>;
  modelPrice?: Record<string, unknown> | Record<string, number>;
}): BillingMaps {
  const persistedModes = stringMap(opts.billingMode);
  const persistedExprs = stringMap(opts.billingExpr);
  const modes = { ...persistedModes };
  const expressions = { ...persistedExprs };
  for (const model of Object.keys(BUILTIN_BILLING_EXPR)) {
    if (!Object.prototype.hasOwnProperty.call(modes, model) && getBillingMode(model, persistedModes, opts.modelRatio, opts.modelPrice) === BILLING_MODE_TIERED_EXPR) {
      modes[model] = BILLING_MODE_TIERED_EXPR;
    }
    if (Object.prototype.hasOwnProperty.call(expressions, model)) continue;
    const expression = getBillingExpr(model, persistedModes, persistedExprs, opts.modelRatio, opts.modelPrice);
    if (expression) expressions[model] = expression;
  }
  return { billing_mode: modes, billing_expr: expressions };
}
