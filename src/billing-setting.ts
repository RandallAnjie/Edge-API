import { getModelPriceFromMap, hasConfiguredModelRatio } from "./ratio-setting.js";
import { compileBillingExpr, usedUsageKeys, usesFixedPricing } from "./billing-expr.js";

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

/**
 * Original `helper.HasModelBillingConfig`.
 * Price or configured ratio counts; self-use fallback ratio does not.
 * Tiered mode counts only when the expression is present and non-whitespace.
 */
export function hasModelBillingConfig(
  modelName: string,
  modelPrice: Record<string, unknown> | Record<string, number> = {},
  modelRatio: Record<string, unknown> | Record<string, number> = {},
  persistedModes: Record<string, string> = {},
  persistedExprs: Record<string, string> = {},
): boolean {
  if (getModelPriceFromMap(modelName, modelPrice).configured) return true;
  if (hasConfiguredModelRatio(modelName, modelRatio)) return true;
  if (getBillingMode(modelName, persistedModes, modelRatio, modelPrice) !== BILLING_MODE_TIERED_EXPR) return false;
  const expr = getBillingExpr(modelName, persistedModes, persistedExprs, modelRatio, modelPrice);
  return Boolean(expr && expr.trim());
}

/** Original `GetBillingModeCopy` + `GetBillingExprCopy`. */
/** Original `billing_setting.PluginBillingExprKey`. */
export function pluginBillingExprLookupKey(pluginKey: string, model: string): string {
  return `${pluginKey}::${model}`;
}

/** Original `billing_setting.GetPluginBillingExpr`. */
export function getPluginBillingExpr(pluginExprs: Record<string, string>, pluginKey: string, model: string): string | undefined {
  const key = pluginBillingExprLookupKey(pluginKey, model);
  return Object.prototype.hasOwnProperty.call(pluginExprs, key) ? pluginExprs[key] : undefined;
}

/** Original `billing_setting.ResolveTaskBillingExpr`. */
export function resolveTaskBillingExpr(
  pluginKey: string,
  model: string,
  mappedModel: string,
  maps: {
    pluginExprs?: Record<string, string>;
    modes: Record<string, string>;
    exprs: Record<string, string>;
    modelRatio?: Record<string, unknown> | Record<string, number>;
    modelPrice?: Record<string, unknown> | Record<string, number>;
  },
): { expr: string; exists: boolean } {
  const pluginExprs = maps.pluginExprs || {};
  if (pluginKey) {
    const own = getPluginBillingExpr(pluginExprs, pluginKey, model);
    if (own != null) return { expr: own, exists: true };
    if (mappedModel && mappedModel !== model) {
      const mapped = getPluginBillingExpr(pluginExprs, pluginKey, mappedModel);
      if (mapped != null) return { expr: mapped, exists: true };
    }
  }
  if (getBillingMode(model, maps.modes, maps.modelRatio, maps.modelPrice) === BILLING_MODE_TIERED_EXPR) {
    const expr = getBillingExpr(model, maps.modes, maps.exprs, maps.modelRatio, maps.modelPrice);
    return { expr: expr || "", exists: Boolean(expr) };
  }
  if (mappedModel && mappedModel !== model && getBillingMode(mappedModel, maps.modes, maps.modelRatio, maps.modelPrice) === BILLING_MODE_TIERED_EXPR) {
    const expression = getBillingExpr(mappedModel, maps.modes, maps.exprs, maps.modelRatio, maps.modelPrice);
    return { expr: expression || "", exists: Boolean(expression && expression.trim()) };
  }
  return { expr: "", exists: false };
}

/** Original `billing_setting.TaskExprCompatible`. */
export function taskExprCompatible(expression: string, schema: Record<string, unknown> | undefined): boolean {
  if (!String(expression || "").trim()) return false;
  if (compileBillingExpr(expression)) return false;
  for (const key of Object.keys(usedUsageKeys(expression) || {})) {
    if (!schema || !Object.prototype.hasOwnProperty.call(schema, key)) return false;
  }
  return !usesFixedPricing(expression);
}

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
