/** Original `relaykit/relayconvert/reasoning` + host `setting/reasoning` + `relay/helper.ApplyReasoningModelSuffix`. */

export const EFFORT_NONE = "none";
export const EFFORT_MINIMAL = "minimal";
export const EFFORT_LOW = "low";
export const EFFORT_MEDIUM = "medium";
export const EFFORT_HIGH = "high";
export const EFFORT_XHIGH = "xhigh";
export const EFFORT_MAX = "max";

export const MODE_UNSET = "";
export const MODE_ENABLED = "enabled";
export const MODE_ADAPTIVE = "adaptive";
export const MODE_DISABLED = "disabled";

export const SOURCE_EXPLICIT = "explicit";
export const SOURCE_NATIVE = "native";
export const SOURCE_SUFFIX = "suffix";
export const SOURCE_PIVOT = "pivot";

export const OPENAI_EFFORT_SUFFIXES = ["-max", "-xhigh", "-high", "-medium", "-low", "-minimal", "-none"];
export const DEEPSEEK_V4_EFFORT_SUFFIXES = ["-none", "-max"];

const LEGACY_OPENAI_MODEL = /^(gpt-[a-z0-9][a-z0-9._-]*|o[1-9][a-z0-9._-]*)$/;
const LEGACY_CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9._-]*$/;
const LEGACY_GEMINI_MODEL = /^gemini-[a-z0-9][a-z0-9._-]*$/;

const MODEL_MODIFIER_EXEMPTION_HINT =
  'If this segment is part of the real model name, add the model to the "Models that skip thinking suffix processing" setting (re: regex entries are supported)';

/** Original `model_setting` defaults for thinking-suffix / effort-tail exemption. */
export const DEFAULT_THINKING_MODEL_BLACKLIST = ["moonshotai/kimi-k2-thinking", "kimi-k2-thinking"];
export const DEFAULT_EFFORT_TAIL_MODEL_IDS = [
  "gpt-5.1-codex-max",
  "qwen-image-edit-max",
  "qwen-max",
  "stable-diffusion-3-medium",
  "yi-medium",
];

export type ReasoningIntent = {
  mode: string;
  effort: string;
  budgetTokens?: number;
  includeThoughts?: boolean;
  source: string;
  budgetSource: string;
};

export type ReasoningHostSettings = {
  thinkingModelBlacklist?: string[];
  effortTailModelIDs?: string[];
  claudeThinkingAdapterEnabled?: boolean;
  geminiThinkingAdapterEnabled?: boolean;
  claudeThinkingAdapterBudgetTokensPercentage?: number;
  geminiThinkingAdapterBudgetTokensPercentage?: number;
  claudeDefaultMaxTokens?: Record<string, number>;
  geminiSafetySettings?: Record<string, string>;
  geminiSupportedImagineModels?: string[];
  geminiFunctionCallThoughtSignatureEnabled?: boolean;
  removeFunctionResponseIdEnabled?: boolean;
  passThrough?: boolean;
};

export const DEFAULT_CLAUDE_MAX_TOKENS: Record<string, number> = { default: 8192 };
export const DEFAULT_GEMINI_SAFETY = "OFF";
export const GEMINI_SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];
export const GEMINI_THOUGHT_SIGNATURE_BYPASS = "context_engineering_is_the_way_to_go";
export const ERR_MISSING_CLAUDE_MAX_TOKENS =
  "claude messages request requires max_tokens: set max_tokens on the request or configure Options.Claude.DefaultMaxTokens";

export class ReasoningClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasoningClientError";
  }
}

export function asClientError(err: unknown): ReasoningClientError {
  if (err instanceof ReasoningClientError) return err;
  return new ReasoningClientError(err instanceof Error ? err.message : String(err));
}

export function isClientError(err: unknown): boolean {
  return err instanceof ReasoningClientError;
}

export const REASONING_CONVERSION = Symbol.for("new-api.reasoningConversion");

export type OpenAIChatBody = Record<string, unknown> & {
  [REASONING_CONVERSION]?: ReasoningIntent;
};

export function emptyIntent(): ReasoningIntent {
  return { mode: MODE_UNSET, effort: "", source: "", budgetSource: "" };
}

export function intentHasStrength(intent: ReasoningIntent): boolean {
  return intent.mode !== MODE_UNSET || intent.effort !== "" || intent.budgetTokens != null;
}

export function intentIsEmpty(intent: ReasoningIntent): boolean {
  return !intentHasStrength(intent) && intent.includeThoughts == null;
}

export function parseEffort(value: string): string {
  const effort = value.toLowerCase().trim();
  if (!effort) return "";
  switch (effort) {
    case EFFORT_NONE:
    case EFFORT_MINIMAL:
    case EFFORT_LOW:
    case EFFORT_MEDIUM:
    case EFFORT_HIGH:
    case EFFORT_XHIGH:
    case EFFORT_MAX:
      return effort;
    default:
      throw new Error(`unsupported reasoning effort: ${JSON.stringify(value)}`);
  }
}

function normalizeIntent(intent: ReasoningIntent): ReasoningIntent {
  const next: ReasoningIntent = { ...intent, effort: parseEffort(intent.effort) };
  switch (next.mode) {
    case MODE_UNSET:
    case MODE_ENABLED:
    case MODE_ADAPTIVE:
    case MODE_DISABLED:
      break;
    default:
      throw new Error(`unsupported reasoning mode ${JSON.stringify(next.mode)}`);
  }
  if (next.budgetTokens != null) {
    const budget = next.budgetTokens;
    if (budget < -1) throw new Error(`thinking budget must be -1 or non-negative, got ${budget}`);
    if (budget === 0) {
      if (next.mode === MODE_ENABLED || next.mode === MODE_ADAPTIVE || (next.effort !== "" && next.effort !== EFFORT_NONE)) {
        throw new Error("reasoning settings conflict: zero budget disables thinking");
      }
      next.mode = MODE_DISABLED;
      next.effort = EFFORT_NONE;
    } else if (next.mode === MODE_DISABLED || next.effort === EFFORT_NONE) {
      throw new Error("reasoning settings conflict: a non-zero budget enables thinking");
    } else if (next.mode === MODE_UNSET) {
      next.mode = MODE_ENABLED;
    }
  }
  if (next.effort === EFFORT_NONE) {
    if (next.mode === MODE_ENABLED || next.mode === MODE_ADAPTIVE) {
      throw new Error("reasoning settings conflict: effort none disables thinking");
    }
    next.mode = MODE_DISABLED;
  }
  return next;
}

export function mergeExplicit(primary: ReasoningIntent, secondary: ReasoningIntent, model: string): ReasoningIntent {
  const left = normalizeIntent(primary);
  const right = normalizeIntent(secondary);
  if (intentIsEmpty(left)) return right;
  if (intentIsEmpty(right)) return left;
  const leftDisabled = left.mode === MODE_DISABLED || left.effort === EFFORT_NONE;
  const rightDisabled = right.mode === MODE_DISABLED || right.effort === EFFORT_NONE;
  if (intentHasStrength(left) && intentHasStrength(right) && leftDisabled !== rightDisabled) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: explicit fields disagree about whether thinking is enabled`);
  }
  if (left.effort && right.effort && left.effort !== right.effort) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: explicit efforts ${JSON.stringify(left.effort)} and ${JSON.stringify(right.effort)} differ`);
  }
  if (left.budgetTokens != null && right.budgetTokens != null && left.budgetTokens !== right.budgetTokens) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: explicit budgets ${left.budgetTokens} and ${right.budgetTokens} differ`);
  }
  const merged: ReasoningIntent = { ...right };
  if (left.mode !== MODE_UNSET) merged.mode = left.mode;
  if (left.effort) merged.effort = left.effort;
  if (left.budgetTokens != null) {
    merged.budgetTokens = left.budgetTokens;
    merged.budgetSource = left.budgetSource;
  }
  if (left.includeThoughts != null) merged.includeThoughts = left.includeThoughts;
  return normalizeIntent(merged);
}

export function mergeExplicitAndSuffix(explicit: ReasoningIntent, suffix: ReasoningIntent, model: string): ReasoningIntent {
  const left = normalizeIntent(explicit);
  const right = normalizeIntent(suffix);
  if (!intentHasStrength(left)) {
    if (left.includeThoughts != null) right.includeThoughts = left.includeThoughts;
    return right;
  }
  if (!intentHasStrength(right)) {
    if (left.includeThoughts == null) left.includeThoughts = right.includeThoughts;
    return left;
  }
  const leftDisabled = left.mode === MODE_DISABLED || left.effort === EFFORT_NONE;
  const rightDisabled = right.mode === MODE_DISABLED || right.effort === EFFORT_NONE;
  if (leftDisabled !== rightDisabled) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: explicit fields and model suffix disagree about whether thinking is enabled`);
  }
  if (!leftDisabled && left.effort && right.effort && left.effort !== right.effort) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: explicit effort ${JSON.stringify(left.effort)} differs from suffix effort ${JSON.stringify(right.effort)}`);
  }
  if (left.budgetTokens != null && right.budgetTokens != null && left.budgetTokens !== right.budgetTokens) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: explicit budget ${left.budgetTokens} differs from suffix budget ${right.budgetTokens}`);
  }
  if ((left.effort && left.effort !== EFFORT_NONE && right.budgetTokens != null) || (left.budgetTokens != null && right.effort && right.effort !== EFFORT_NONE)) {
    throw new Error(`reasoning settings conflict for model ${JSON.stringify(model)}: effort and an exact suffix budget cannot both select reasoning strength`);
  }
  const merged: ReasoningIntent = { ...right };
  if (left.mode !== MODE_UNSET) merged.mode = left.mode;
  if (left.effort) merged.effort = left.effort;
  if (left.budgetTokens != null) {
    merged.budgetTokens = left.budgetTokens;
    merged.budgetSource = left.budgetSource;
  }
  if (left.includeThoughts != null) merged.includeThoughts = left.includeThoughts;
  return normalizeIntent(merged);
}

export function effortFromBudget(budget: number): string {
  if (budget === 0) return EFFORT_NONE;
  if (budget < 0) return EFFORT_HIGH;
  if (budget <= 1024) return EFFORT_LOW;
  if (budget <= 8192) return EFFORT_MEDIUM;
  return EFFORT_HIGH;
}

export function effectiveEffort(intent: ReasoningIntent): string {
  let normalized: ReasoningIntent;
  try {
    normalized = normalizeIntent(intent);
  } catch {
    return "";
  }
  if (normalized.mode === MODE_DISABLED) return EFFORT_NONE;
  if (normalized.effort) return normalized.effort;
  if (normalized.budgetTokens != null) return effortFromBudget(normalized.budgetTokens);
  if (normalized.mode === MODE_ENABLED || normalized.mode === MODE_ADAPTIVE) return EFFORT_HIGH;
  return "";
}

type OpenRouterReasoning = {
  enabled?: boolean;
  effort?: string;
  max_tokens?: number;
  exclude?: boolean;
};

function asReasoningObject(raw: unknown): OpenRouterReasoning | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return asReasoningObject(JSON.parse(raw));
    } catch {
      throw new Error("invalid reasoning config");
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid reasoning config");
  return raw as OpenRouterReasoning;
}

export function fromOpenAIChat(req: OpenAIChatBody | null | undefined): ReasoningIntent {
  if (!req) return emptyIntent();
  let intent = emptyIntent();
  intent.source = SOURCE_EXPLICIT;
  if (typeof req.reasoning_effort === "string" && req.reasoning_effort) {
    const effort = parseEffort(String(req.reasoning_effort));
    intent.effort = effort;
    intent.mode = effort === EFFORT_NONE ? MODE_DISABLED : MODE_ENABLED;
  }
  if (req.reasoning != null && req.reasoning !== "") {
    const raw = asReasoningObject(req.reasoning);
    const nested = emptyIntent();
    nested.source = SOURCE_EXPLICIT;
    nested.budgetSource = SOURCE_EXPLICIT;
    if (raw && raw.max_tokens != null) nested.budgetTokens = Number(raw.max_tokens);
    if (raw && raw.enabled != null) {
      if (raw.enabled) nested.mode = MODE_ENABLED;
      else {
        nested.mode = MODE_DISABLED;
        nested.effort = EFFORT_NONE;
      }
    }
    if (raw && raw.effort) {
      const effort = parseEffort(String(raw.effort));
      nested.effort = effort;
      if (effort === EFFORT_NONE) nested.mode = MODE_DISABLED;
      else if (nested.mode === MODE_UNSET) nested.mode = MODE_ENABLED;
    }
    if (raw && raw.exclude != null) nested.includeThoughts = !raw.exclude;
    intent = mergeExplicit(intent, nested, String(req.model || ""));
  }
  const pivot = req[REASONING_CONVERSION];
  if (!pivot) return normalizeIntent(intent);
  const pivotIntent: ReasoningIntent = {
    mode: pivot.mode,
    effort: pivot.effort,
    budgetTokens: pivot.budgetTokens,
    includeThoughts: pivot.includeThoughts,
    source: SOURCE_PIVOT,
    budgetSource: SOURCE_PIVOT,
  };
  if (typeof req.reasoning_effort === "string" && req.reasoning_effort) {
    if (req.reasoning_effort === effectiveEffort(pivotIntent)) {
      intent.effort = "";
      intent.mode = MODE_UNSET;
    }
  }
  return mergeExplicit(intent, pivotIntent, String(req.model || ""));
}

export function fromOpenAIResponses(req: Record<string, unknown> | null | undefined): ReasoningIntent {
  if (!req) return emptyIntent();
  let intent = emptyIntent();
  const reasoning = req.reasoning && typeof req.reasoning === "object" && !Array.isArray(req.reasoning) ? (req.reasoning as Record<string, unknown>) : null;
  if (reasoning) {
    intent.source = SOURCE_EXPLICIT;
    if (typeof reasoning.effort === "string" && reasoning.effort) {
      const effort = parseEffort(reasoning.effort);
      intent.effort = effort;
      intent.mode = effort === EFFORT_NONE ? MODE_DISABLED : MODE_ENABLED;
    }
    if (typeof reasoning.summary === "string" && reasoning.summary) intent.includeThoughts = true;
  }
  const pivot = (req as OpenAIChatBody)[REASONING_CONVERSION];
  if (!pivot) return normalizeIntent(intent);
  const pivotIntent: ReasoningIntent = {
    mode: pivot.mode,
    effort: pivot.effort,
    budgetTokens: pivot.budgetTokens,
    includeThoughts: pivot.includeThoughts,
    source: SOURCE_PIVOT,
    budgetSource: SOURCE_PIVOT,
  };
  if (reasoning && typeof reasoning.effort === "string" && reasoning.effort) {
    if (reasoning.effort === effectiveEffort(pivotIntent)) {
      intent.effort = "";
      intent.mode = MODE_UNSET;
    }
  }
  return mergeExplicit(intent, pivotIntent, String(req.model || ""));
}

export function fromClaudeThinking(thinking: Record<string, unknown> | null | undefined, maxTokens?: number): ReasoningIntent {
  if (!thinking) return emptyIntent();
  const intent = emptyIntent();
  intent.source = SOURCE_NATIVE;
  const typ = String(thinking.type || "");
  switch (typ) {
    case "":
    case "enabled":
      intent.mode = MODE_ENABLED;
      break;
    case "adaptive":
      intent.mode = MODE_ADAPTIVE;
      break;
    case "disabled":
      intent.mode = MODE_DISABLED;
      intent.effort = EFFORT_NONE;
      break;
    default:
      throw new Error(`unsupported Claude thinking type ${JSON.stringify(typ)}`);
  }
  if (thinking.budget_tokens != null) {
    const budget = Number(thinking.budget_tokens);
    intent.budgetTokens = budget;
    if (budget < 1024) throw new Error(`Claude thinking budget_tokens must be at least 1024, got ${budget}`);
    if (maxTokens != null && budget >= maxTokens) throw new Error("Claude thinking budget_tokens must be less than max_tokens");
    intent.budgetSource = SOURCE_NATIVE;
  }
  switch (String(thinking.display || "")) {
    case "summarized":
      intent.includeThoughts = true;
      break;
    case "omitted":
      intent.includeThoughts = false;
      break;
  }
  if (intent.mode === MODE_DISABLED && intent.effort && intent.effort !== EFFORT_NONE) return intent;
  return normalizeIntent(intent);
}

export type ModelModifier = { key: string; value: string };
export type ModelModifierSpec = { raw: string; base: string; modifiers: ModelModifier[] };

export function parseModelModifiers(modelName: string): ModelModifierSpec {
  const spec: ModelModifierSpec = { raw: modelName, base: modelName, modifiers: [] };
  const parts = modelName.split("@");
  if (parts.length < 2) return spec;
  let firstModifier = parts.length;
  for (let i = parts.length - 1; i > 0; i--) {
    const parsed = parseModelModifierSegment(parts[i]);
    if (!parsed) break;
    firstModifier = i;
    spec.modifiers.unshift({ key: parsed.key, value: parsed.value });
  }
  if (firstModifier === parts.length) return spec;
  const base = parts.slice(0, firstModifier).join("@");
  if (!base) return { raw: modelName, base: modelName, modifiers: [] };
  spec.base = base;
  return spec;
}

function parseModelModifierSegment(segment: string): { key: string; value: string } | null {
  const colon = segment.indexOf(":");
  if (colon <= 0) return null;
  const key = segment.slice(0, colon);
  for (let i = 0; i < key.length; i++) {
    const r = key.charCodeAt(i);
    const letter = (r >= 97 && r <= 122) || (r >= 65 && r <= 90);
    const digit = r >= 48 && r <= 57;
    if (i === 0 && !letter) return null;
    if (i > 0 && !letter && !digit && r !== 95 && r !== 45) return null;
  }
  return { key: key.toLowerCase(), value: segment.slice(colon + 1) };
}

export function parseThinkingModifier(raw: string): ReasoningIntent | null {
  const value = raw.toLowerCase().trim();
  switch (value) {
    case "on":
      return { mode: MODE_ENABLED, effort: "", source: SOURCE_SUFFIX, budgetSource: "" };
    case "adaptive":
      return { mode: MODE_ADAPTIVE, effort: "", source: SOURCE_SUFFIX, budgetSource: "" };
    case "off":
      return { mode: MODE_DISABLED, effort: EFFORT_NONE, source: SOURCE_SUFFIX, budgetSource: "" };
  }
  if (/^-?\d+$/.test(value)) {
    const budget = Number(value);
    if (budget < -1) return null;
    if (budget === 0) return { mode: MODE_DISABLED, effort: EFFORT_NONE, source: SOURCE_SUFFIX, budgetSource: "" };
    return { mode: MODE_ENABLED, effort: "", budgetTokens: budget, source: SOURCE_SUFFIX, budgetSource: SOURCE_SUFFIX };
  }
  return null;
}

export function trimEffortSuffixWithSuffixes(modelName: string, suffixes: string[]): { base: string; effort: string; ok: boolean } {
  const suffix = suffixes.find((s) => modelName.endsWith(s));
  if (!suffix) return { base: modelName, effort: "", ok: false };
  return { base: modelName.slice(0, -suffix.length), effort: suffix.slice(1), ok: true };
}

/** Original `reasoning.ParseDeepSeekV4ThinkingSuffix`. */
export function parseDeepSeekV4ThinkingSuffix(modelName: string): { base: string; thinkingType: string; effort: string; ok: boolean } {
  const trimmed = trimEffortSuffixWithSuffixes(modelName, DEEPSEEK_V4_EFFORT_SUFFIXES);
  if (!trimmed.ok || !trimmed.base.startsWith("deepseek-v4-")) {
    return { base: modelName, thinkingType: "", effort: "", ok: false };
  }
  if (trimmed.effort === "none") return { base: trimmed.base, thinkingType: "disabled", effort: "", ok: true };
  if (trimmed.effort === "max") return { base: trimmed.base, thinkingType: "enabled", effort: "max", ok: true };
  return { base: modelName, thinkingType: "", effort: "", ok: false };
}

export function splitModelNamespace(modelName: string): { prefix: string; bare: string } {
  const slash = modelName.lastIndexOf("/");
  if (slash >= 0) return { prefix: modelName.slice(0, slash + 1), bare: modelName.slice(slash + 1) };
  return { prefix: "", bare: modelName };
}

export function lastModelPathSegment(modelName: string): string {
  return splitModelNamespace(modelName).bare;
}

export function shouldPreserveThinkingSuffix(modelName: string, settings: ReasoningHostSettings = {}): boolean {
  const target = modelName.trim();
  if (!target) return false;
  const list = settings.thinkingModelBlacklist ?? DEFAULT_THINKING_MODEL_BLACKLIST;
  for (const entry of list) {
    const item = String(entry || "").trim();
    if (!item) continue;
    if (item.startsWith("re:")) {
      try {
        if (new RegExp(item.slice(3)).test(target)) return true;
      } catch {
        continue;
      }
      continue;
    }
    if (item === target) return true;
  }
  return false;
}

export function shouldPreserveEffortTail(modelName: string, settings: ReasoningHostSettings = {}): boolean {
  const target = modelName.trim();
  if (!target) return false;
  const bare = lastModelPathSegment(target);
  for (const entry of settings.effortTailModelIDs ?? DEFAULT_EFFORT_TAIL_MODEL_IDS) {
    const item = String(entry || "").trim();
    if (!item) continue;
    if (item === target || item === bare) return true;
  }
  return false;
}

/** Original `reasoning.ParseOpenAIReasoningEffortFromModelSuffix`. */
export function parseOpenAIReasoningEffortFromModelSuffix(modelName: string, settings: ReasoningHostSettings = {}): { effort: string; base: string } {
  if (shouldPreserveEffortTail(modelName, settings)) return { effort: "", base: modelName };
  const trimmed = trimEffortSuffixWithSuffixes(modelName, OPENAI_EFFORT_SUFFIXES);
  if (!trimmed.ok || !LEGACY_OPENAI_MODEL.test(lastModelPathSegment(trimmed.base))) {
    return { effort: "", base: modelName };
  }
  return { effort: trimmed.effort, base: trimmed.base };
}

function parseProviderModelSuffix(
  modelName: string,
  requiredPrefix: string,
  allowThinkingAlias: boolean,
  includeThoughts: boolean,
): { base: string; intent: ReasoningIntent; found: boolean } {
  if (allowThinkingAlias) {
    const marker = modelName.lastIndexOf("-thinking-");
    if (marker >= 0) {
      const baseModel = modelName.slice(0, marker);
      if (!baseModel.startsWith(requiredPrefix)) return { base: modelName, intent: emptyIntent(), found: false };
      const budgetRaw = modelName.slice(marker + "-thinking-".length);
      if (!/^-?\d+$/.test(budgetRaw)) {
        throw new Error(`invalid thinking budget suffix on model ${JSON.stringify(modelName)}: invalid syntax`);
      }
      const intent = emptyIntent();
      intent.budgetTokens = Number(budgetRaw);
      intent.source = SOURCE_SUFFIX;
      intent.budgetSource = SOURCE_SUFFIX;
      if (includeThoughts) intent.includeThoughts = true;
      return { base: baseModel, intent, found: true };
    }
    if (modelName.endsWith("-nothinking")) {
      return {
        base: modelName.slice(0, -"-nothinking".length),
        intent: { mode: MODE_DISABLED, effort: EFFORT_NONE, source: SOURCE_SUFFIX, budgetSource: "" },
        found: true,
      };
    }
    if (modelName.endsWith("-thinking")) {
      const intent: ReasoningIntent = { mode: MODE_ENABLED, effort: "", source: SOURCE_SUFFIX, budgetSource: "" };
      if (includeThoughts) intent.includeThoughts = true;
      return { base: modelName.slice(0, -"-thinking".length), intent, found: true };
    }
  }
  const trimmed = trimEffortSuffixWithSuffixes(modelName, OPENAI_EFFORT_SUFFIXES);
  if (!trimmed.ok || !trimmed.base.startsWith(requiredPrefix)) {
    return { base: modelName, intent: emptyIntent(), found: false };
  }
  const effort = parseEffort(trimmed.effort);
  const intent: ReasoningIntent = { effort, mode: MODE_ENABLED, source: SOURCE_SUFFIX, budgetSource: "" };
  if (effort === EFFORT_NONE) intent.mode = MODE_DISABLED;
  else if (includeThoughts) intent.includeThoughts = true;
  return { base: trimmed.base, intent, found: true };
}

export function parseClaudeModelSuffix(modelName: string, allowThinkingAlias: boolean): { base: string; intent: ReasoningIntent; found: boolean } {
  const { prefix, bare } = splitModelNamespace(modelName);
  if (!bare.startsWith("claude-")) return { base: modelName, intent: emptyIntent(), found: false };
  const parsed = parseProviderModelSuffix(bare, "claude-", allowThinkingAlias, true);
  if (!parsed.found || !LEGACY_CLAUDE_MODEL.test(parsed.base)) return { base: modelName, intent: emptyIntent(), found: false };
  return { base: prefix + parsed.base, intent: parsed.intent, found: true };
}

export function parseGeminiModelSuffix(modelName: string, allowThinkingAlias: boolean): { base: string; intent: ReasoningIntent; found: boolean } {
  const { prefix, bare } = splitModelNamespace(modelName);
  if (!bare.startsWith("gemini-")) return { base: modelName, intent: emptyIntent(), found: false };
  const parsed = parseProviderModelSuffix(bare, "gemini-", allowThinkingAlias, true);
  if (!parsed.found || !LEGACY_GEMINI_MODEL.test(parsed.base)) return { base: modelName, intent: emptyIntent(), found: false };
  return { base: prefix + parsed.base, intent: parsed.intent, found: true };
}

/** Original `setting/reasoning.ParseLegacyModelSuffix`. */
export function parseLegacyModelSuffix(
  modelName: string,
  allowClaudeThinkingAlias: boolean,
  allowGeminiThinkingAlias: boolean,
  settings: ReasoningHostSettings = {},
): { base: string; intent: ReasoningIntent; found: boolean } {
  const { prefix, bare } = splitModelNamespace(modelName);
  if (bare.startsWith("claude-")) {
    const parsed = parseClaudeModelSuffix(bare, allowClaudeThinkingAlias);
    if (!parsed.found) return { base: modelName, intent: emptyIntent(), found: false };
    return { base: prefix + parsed.base, intent: parsed.intent, found: true };
  }
  if (bare.startsWith("gemini-")) {
    const parsed = parseGeminiModelSuffix(bare, allowGeminiThinkingAlias);
    if (!parsed.found) return { base: modelName, intent: emptyIntent(), found: false };
    return { base: prefix + parsed.base, intent: parsed.intent, found: true };
  }
  const { effort, base } = parseOpenAIReasoningEffortFromModelSuffix(bare, settings);
  if (!effort) return { base: modelName, intent: emptyIntent(), found: false };
  const parsedEffort = parseEffort(effort);
  const mode = parsedEffort === EFFORT_NONE ? MODE_DISABLED : MODE_ENABLED;
  return {
    base: prefix + base,
    intent: { mode, effort: parsedEffort, source: SOURCE_SUFFIX, budgetSource: "" },
    found: true,
  };
}

/** Original `reasoning.BaseModelName`. */
export function baseModelName(modelName: string, settings: ReasoningHostSettings = {}): string {
  if (!modelName) return modelName;
  if (shouldPreserveThinkingSuffix(modelName, settings)) return modelName;
  const base = parseModelModifiers(modelName).base;
  if (shouldPreserveThinkingSuffix(base, settings)) return base;
  try {
    const legacy = parseLegacyModelSuffix(
      base,
      settings.claudeThinkingAdapterEnabled !== false,
      Boolean(settings.geminiThinkingAdapterEnabled),
      settings,
    );
    if (legacy.found) return legacy.base;
  } catch {
    return base;
  }
  return base;
}

export type ParsedModelModifiers = {
  base: string;
  hasSyntax: boolean;
  intent: ReasoningIntent;
  hasThinking: boolean;
  temperature?: number;
  topP?: number;
  hasTemperature: boolean;
  hasTopP: boolean;
};

/** Original `helper.parseRequestModelName`. */
export function parseHostModelModifiers(modelName: string, settings: ReasoningHostSettings = {}): ParsedModelModifiers {
  return parseRequestModelName(modelName, settings);
}

function modelModifierClientError(message: string): ReasoningClientError {
  return new ReasoningClientError(`${message}. ${MODEL_MODIFIER_EXEMPTION_HINT}`);
}

function parseFiniteFloat(raw: string): number | null {
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) return null;
  return value;
}

function parseExplicitModelModifiers(modelName: string): ParsedModelModifiers {
  const spec = parseModelModifiers(modelName);
  const parsed: ParsedModelModifiers = {
    base: spec.base,
    hasSyntax: spec.modifiers.length > 0,
    intent: emptyIntent(),
    hasThinking: false,
    hasTemperature: false,
    hasTopP: false,
  };
  const last = new Map<string, number>();
  spec.modifiers.forEach((modifier, index) => last.set(modifier.key, index));
  for (let index = 0; index < spec.modifiers.length; index++) {
    const modifier = spec.modifiers[index];
    if (last.get(modifier.key) !== index) continue;
    switch (modifier.key) {
      case "thinking": {
        const intent = parseThinkingModifier(modifier.value);
        if (!intent) throw modelModifierClientError(`invalid thinking modifier value ${JSON.stringify(modifier.value)}`);
        if (parsed.hasThinking && intent.mode !== MODE_DISABLED && intent.budgetTokens == null) {
          parsed.intent.mode = intent.mode;
          parsed.intent.source = SOURCE_SUFFIX;
        } else if (parsed.hasThinking && intent.mode !== MODE_DISABLED) {
          parsed.intent.mode = intent.mode;
          parsed.intent.budgetTokens = intent.budgetTokens;
          parsed.intent.budgetSource = intent.budgetSource;
          parsed.intent.source = SOURCE_SUFFIX;
        } else {
          parsed.intent = intent;
        }
        parsed.hasThinking = true;
        break;
      }
      case "effort": {
        let effort = "";
        try {
          effort = parseEffort(modifier.value);
        } catch {
          throw modelModifierClientError(`invalid effort modifier value ${JSON.stringify(modifier.value)}: must be one of none/low/medium/high/xhigh/max`);
        }
        if (!effort) {
          throw modelModifierClientError(`invalid effort modifier value ${JSON.stringify(modifier.value)}: must be one of none/low/medium/high/xhigh/max`);
        }
        if (effort === EFFORT_NONE) {
          parsed.intent = { mode: MODE_DISABLED, effort: EFFORT_NONE, source: SOURCE_SUFFIX, budgetSource: "" };
        } else {
          if (parsed.intent.mode === MODE_UNSET || parsed.intent.mode === MODE_DISABLED) parsed.intent.mode = MODE_ENABLED;
          parsed.intent.effort = effort;
          parsed.intent.source = SOURCE_SUFFIX;
        }
        parsed.hasThinking = true;
        break;
      }
      case "temperature": {
        const value = parseFiniteFloat(modifier.value);
        if (value == null) throw modelModifierClientError(`invalid temperature modifier value ${JSON.stringify(modifier.value)}: must be a finite number`);
        parsed.temperature = value;
        parsed.hasTemperature = true;
        break;
      }
      case "topp": {
        const value = parseFiniteFloat(modifier.value);
        if (value == null) throw modelModifierClientError(`invalid topp modifier value ${JSON.stringify(modifier.value)}: must be a finite number`);
        parsed.topP = value;
        parsed.hasTopP = true;
        break;
      }
      default:
        throw modelModifierClientError(`unsupported model modifier ${JSON.stringify(modifier.key)}`);
    }
  }
  return parsed;
}

function parseRequestModelName(name: string, settings: ReasoningHostSettings): ParsedModelModifiers {
  if (shouldPreserveThinkingSuffix(name, settings)) {
    return { base: name, hasSyntax: false, intent: emptyIntent(), hasThinking: false, hasTemperature: false, hasTopP: false };
  }
  const parsed = parseExplicitModelModifiers(name);
  if (shouldPreserveThinkingSuffix(parsed.base, settings)) return parsed;
  const legacy = parseLegacyModelSuffix(
    parsed.base,
    settings.claudeThinkingAdapterEnabled !== false,
    Boolean(settings.geminiThinkingAdapterEnabled),
    settings,
  );
  parsed.base = legacy.base;
  if (legacy.found && !parsed.hasThinking) {
    parsed.intent = legacy.intent;
    parsed.hasThinking = true;
  }
  return parsed;
}

function overlayMappedModelModifiers(origin: ParsedModelModifiers, mapped: ParsedModelModifiers): ParsedModelModifiers {
  const next = { ...origin, base: mapped.base, hasSyntax: origin.hasSyntax || mapped.hasSyntax };
  if (mapped.hasThinking) {
    next.intent = mapped.intent;
    next.hasThinking = true;
  }
  if (mapped.hasTemperature) {
    next.temperature = mapped.temperature;
    next.hasTemperature = true;
  }
  if (mapped.hasTopP) {
    next.topP = mapped.topP;
    next.hasTopP = true;
  }
  return next;
}

function applyModelControls(req: OpenAIChatBody, parsed: ParsedModelModifiers): void {
  if (parsed.hasTemperature) req.temperature = parsed.temperature;
  if (parsed.hasTopP) req.top_p = parsed.topP;
  if (!parsed.hasThinking) return;
  req[REASONING_CONVERSION] = parsed.intent;
  const reasoningConfig: Record<string, unknown> = {};
  if (req.reasoning != null && req.reasoning !== "") {
    const current = asReasoningObject(req.reasoning);
    if (!current || typeof current !== "object") throw new Error("OpenAI reasoning must be a JSON object");
    Object.assign(reasoningConfig, current);
  }
  if (parsed.intent.budgetTokens != null) {
    reasoningConfig.enabled = parsed.intent.mode !== MODE_DISABLED;
    reasoningConfig.max_tokens = parsed.intent.budgetTokens;
    delete reasoningConfig.effort;
    req.reasoning_effort = "";
  } else {
    delete reasoningConfig.enabled;
    delete reasoningConfig.effort;
    delete reasoningConfig.max_tokens;
    req.reasoning_effort = "";
    if (parsed.intent.effort) req.reasoning_effort = parsed.intent.effort;
  }
  if (Object.keys(reasoningConfig).length === 0) delete req.reasoning;
  else req.reasoning = reasoningConfig;
}

function applyResponsesModelControls(req: Record<string, unknown>, parsed: ParsedModelModifiers): void {
  if (parsed.hasTemperature) req.temperature = parsed.temperature;
  if (parsed.hasTopP) req.top_p = parsed.topP;
  if (!parsed.hasThinking) return;
  (req as OpenAIChatBody)[REASONING_CONVERSION] = parsed.intent;
  if (parsed.intent.effort) {
    const reasoning = req.reasoning && typeof req.reasoning === "object" && !Array.isArray(req.reasoning) ? { ...(req.reasoning as Record<string, unknown>) } : {};
    reasoning.effort = parsed.intent.effort;
    req.reasoning = reasoning;
  } else if (req.reasoning && typeof req.reasoning === "object" && parsed.intent.budgetTokens == null) {
    const reasoning = { ...(req.reasoning as Record<string, unknown>) };
    reasoning.effort = "";
    req.reasoning = reasoning;
  }
}

export type ApplyReasoningResult = {
  body: OpenAIChatBody;
  originModelName: string;
  upstreamModelName: string;
  reasoningEffort: string;
};

/** Original `helper.ApplyReasoningModelSuffix` for OpenAI chat / Responses JSON bodies. */
export function applyReasoningModelSuffix(
  body: OpenAIChatBody,
  originModelName: string,
  upstreamModelName: string,
  settings: ReasoningHostSettings = {},
  kind: "chat" | "responses" = "chat",
): ApplyReasoningResult {
  const out: OpenAIChatBody = { ...body };
  if (Array.isArray(body.messages)) {
    out.messages = (body.messages as unknown[]).map((m) => (m && typeof m === "object" ? { ...(m as object) } : m));
  }
  if (settings.passThrough) {
    return { body: out, originModelName, upstreamModelName, reasoningEffort: String(out.reasoning_effort || "") };
  }
  let originParsed: ParsedModelModifiers;
  let selected: ParsedModelModifiers;
  try {
    originParsed = parseRequestModelName(originModelName, settings);
    selected = originParsed;
    if (upstreamModelName !== originModelName) {
      selected = overlayMappedModelModifiers(originParsed, parseRequestModelName(upstreamModelName, settings));
    }
  } catch (err) {
    throw asClientError(err);
  }
  if (kind === "responses") applyResponsesModelControls(out, selected);
  else applyModelControls(out, selected);
  out.model = selected.base;
  let reasoningEffort = String(out.reasoning_effort || "");
  if (selected.hasThinking) reasoningEffort = effectiveEffort(selected.intent);
  return { body: out, originModelName, upstreamModelName: selected.base, reasoningEffort };
}

function suffixIntent(rawEffort: string): ReasoningIntent {
  const effort = parseEffort(rawEffort);
  return {
    mode: effort === EFFORT_NONE ? MODE_DISABLED : MODE_ENABLED,
    effort,
    source: SOURCE_SUFFIX,
    budgetSource: "",
  };
}

export type ConvertOpenAIResult = {
  body: OpenAIChatBody;
  upstreamModelName: string;
  reasoningEffort: string;
};

/** Original `openai.Adaptor.ConvertOpenAIRequest` reasoning projection (before chat capabilities). */
export function convertOpenAIAdaptorReasoning(
  body: OpenAIChatBody,
  channelType: number,
  originModelName: string,
  upstreamModelName: string,
  settings: ReasoningHostSettings = {},
): ConvertOpenAIResult {
  const CHANNEL_TYPE_OPENAI = 1;
  const CHANNEL_TYPE_AZURE = 3;
  const CHANNEL_TYPE_OPENROUTER = 20;
  const out: OpenAIChatBody = { ...body, model: upstreamModelName };
  if (Array.isArray(body.messages)) {
    out.messages = (body.messages as unknown[]).map((m) => (m && typeof m === "object" ? { ...(m as object) } : m));
  }
  if (body[REASONING_CONVERSION]) out[REASONING_CONVERSION] = body[REASONING_CONVERSION];

  const preserveSuffix = shouldPreserveThinkingSuffix(originModelName, settings) || shouldPreserveThinkingSuffix(upstreamModelName, settings);
  const upstreamParsed = parseOpenAIReasoningEffortFromModelSuffix(upstreamModelName, settings);
  const originParsed = parseOpenAIReasoningEffortFromModelSuffix(originModelName, settings);
  const renderReasoning =
    (out.reasoning != null && out.reasoning !== "") ||
    out[REASONING_CONVERSION] != null ||
    (!preserveSuffix && (upstreamParsed.effort !== "" || originParsed.effort !== ""));

  let reasoningEffort = "";
  if (channelType !== CHANNEL_TYPE_OPENROUTER && !renderReasoning) {
    reasoningEffort = String(out.reasoning_effort || "");
  }

  if (channelType === CHANNEL_TYPE_OPENROUTER) {
    let initialIntent: ReasoningIntent;
    try {
      initialIntent = fromOpenAIChat(out);
    } catch (err) {
      throw asClientError(err);
    }
    if (out.thinking != null && String(upstreamModelName).startsWith("anthropic")) {
      const thinking = out.thinking && typeof out.thinking === "object" && !Array.isArray(out.thinking) ? (out.thinking as Record<string, unknown>) : null;
      if (!thinking) throw new Error("error Unmarshal thinking");
      try {
        const legacyIntent = fromClaudeThinking(thinking);
        initialIntent = mergeExplicit(initialIntent, legacyIntent, String(out.model || ""));
      } catch (err) {
        throw asClientError(err);
      }
      delete out.thinking;
    }
    if (out.usage == null) out.usage = { include: true };
    const mergeEffortSuffix = (modelName: string) => {
      const { effort } = parseOpenAIReasoningEffortFromModelSuffix(modelName, settings);
      if (!effort) return;
      initialIntent = mergeExplicitAndSuffix(initialIntent, suffixIntent(effort), modelName);
    };
    try {
      if (!preserveSuffix) {
        mergeEffortSuffix(upstreamModelName);
        const stripped = parseOpenAIReasoningEffortFromModelSuffix(upstreamModelName, settings);
        if (stripped.base !== upstreamModelName) {
          upstreamModelName = stripped.base;
          out.model = stripped.base;
        }
        if (originModelName !== upstreamModelName) mergeEffortSuffix(originModelName);
      }
    } catch (err) {
      throw asClientError(err);
    }
    if (!intentIsEmpty(initialIntent)) {
      const reasoningConfig: Record<string, unknown> = {};
      if (out.reasoning != null && out.reasoning !== "") {
        const current = asReasoningObject(out.reasoning);
        if (current) Object.assign(reasoningConfig, current);
      }
      const disabled = initialIntent.mode === MODE_DISABLED || initialIntent.effort === EFFORT_NONE;
      if (intentHasStrength(initialIntent)) {
        reasoningConfig.enabled = !disabled;
        if (disabled) {
          delete reasoningConfig.effort;
          delete reasoningConfig.max_tokens;
        }
      }
      if (!disabled && initialIntent.budgetTokens != null) {
        reasoningConfig.max_tokens = initialIntent.budgetTokens;
        delete reasoningConfig.effort;
      } else if (!disabled && initialIntent.effort && initialIntent.effort !== EFFORT_NONE) {
        reasoningConfig.effort = initialIntent.effort;
        delete reasoningConfig.max_tokens;
      }
      if (initialIntent.includeThoughts != null) reasoningConfig.exclude = !initialIntent.includeThoughts;
      out.reasoning = reasoningConfig;
    }
    out.reasoning_effort = "";
    delete out.reasoning_effort;
    let effective = effectiveEffort(initialIntent);
    if (initialIntent.budgetTokens != null) effective = effortFromBudget(initialIntent.budgetTokens);
    reasoningEffort = effective;
  }

  if (channelType !== CHANNEL_TYPE_OPENROUTER && renderReasoning) {
    let { effort, base: baseModel } = parseOpenAIReasoningEffortFromModelSuffix(upstreamModelName, settings);
    if (preserveSuffix) effort = "";
    let currentIntent: ReasoningIntent;
    try {
      currentIntent = fromOpenAIChat(out);
    } catch (err) {
      throw asClientError(err);
    }
    const mergeSuffix = (modelName: string, rawEffort: string) => {
      if (!rawEffort) return;
      currentIntent = mergeExplicitAndSuffix(currentIntent, suffixIntent(rawEffort), modelName);
    };
    try {
      mergeSuffix(upstreamModelName, effort);
      if (!preserveSuffix && originModelName !== upstreamModelName) {
        const originEffort = parseOpenAIReasoningEffortFromModelSuffix(originModelName, settings).effort;
        mergeSuffix(originModelName, originEffort);
      }
    } catch (err) {
      throw asClientError(err);
    }
    if (effort) {
      upstreamModelName = baseModel;
      out.model = baseModel;
    }
    const canonical = effectiveEffort(currentIntent);
    if (canonical) {
      out.reasoning_effort = canonical;
      reasoningEffort = canonical;
    }
    if (channelType === CHANNEL_TYPE_OPENAI || channelType === CHANNEL_TYPE_AZURE) {
      delete out.reasoning;
    }
  }

  if (!out.reasoning_effort) delete out.reasoning_effort;
  return { body: out, upstreamModelName, reasoningEffort };
}

/** Original `moonshot.Adaptor.ConvertOpenAIRequest`. */
export function convertMoonshotOpenAIRequest(body: OpenAIChatBody, upstreamModelName: string): OpenAIChatBody {
  const out: OpenAIChatBody = { ...body };
  if (out.temperature != null && String(upstreamModelName).toLowerCase() === "kimi-k2.6" && Number(out.temperature) !== 1.0) {
    out.temperature = 1.0;
  }
  return out;
}

/** Original `dto.IsQwenThinkingBudgetModel`. */
export function isQwenThinkingBudgetModel(modelName: string): boolean {
  const normalized = String(modelName || "").toLowerCase().trim();
  return normalized.startsWith("qwen") || normalized.includes("/qwen") || normalized.startsWith("qwq") || normalized.includes("/qwq");
}

/** Original `ali.requestOpenAI2Ali`. */
export function convertAliOpenAIRequest(body: OpenAIChatBody, upstreamModelName: string): OpenAIChatBody {
  const out: OpenAIChatBody = { ...body, model: upstreamModelName || body.model };
  const modelName = String(upstreamModelName || out.model || "");
  if (!isQwenThinkingBudgetModel(modelName)) delete out.thinking_budget;
  if (out.top_p != null) {
    const topP = Number(out.top_p);
    if (topP >= 1) out.top_p = 0.99;
    else if (topP <= 0) out.top_p = 0.01;
  }
  return out;
}

/** Original `openai.Adaptor.ConvertOpenAIResponsesRequest`. */
export function convertOpenAIResponsesAdaptorRequest(
  body: Record<string, unknown>,
  channelType: number,
  originModelName: string,
  settings: ReasoningHostSettings = {},
): ConvertOpenAIResult {
  const CHANNEL_TYPE_OPENROUTER = 20;
  const out: OpenAIChatBody = { ...body };
  const state = (body as OpenAIChatBody)[REASONING_CONVERSION];
  if (state) out[REASONING_CONVERSION] = state;
  const model = String(out.model || "");
  const parsed = parseOpenAIReasoningEffortFromModelSuffix(model, settings);
  let effort = parsed.effort;
  const preserveSuffix = shouldPreserveThinkingSuffix(model, settings) || shouldPreserveThinkingSuffix(originModelName, settings);
  if (preserveSuffix) effort = "";
  let originEffort = "";
  if (!preserveSuffix) originEffort = parseOpenAIReasoningEffortFromModelSuffix(originModelName, settings).effort;
  if (channelType !== CHANNEL_TYPE_OPENROUTER && !effort && !originEffort && !out[REASONING_CONVERSION]) {
    const reasoning = out.reasoning && typeof out.reasoning === "object" ? (out.reasoning as Record<string, unknown>) : null;
    return { body: out, upstreamModelName: model, reasoningEffort: String(reasoning?.effort || "") };
  }
  let currentIntent: ReasoningIntent;
  try {
    currentIntent = fromOpenAIResponses(out);
  } catch (err) {
    throw asClientError(err);
  }
  const mergeSuffix = (modelName: string, rawEffort: string) => {
    if (!rawEffort) return;
    currentIntent = mergeExplicitAndSuffix(currentIntent, suffixIntent(rawEffort), modelName);
  };
  try {
    mergeSuffix(model, effort);
    if (!preserveSuffix && originModelName !== model) {
      mergeSuffix(originModelName, parseOpenAIReasoningEffortFromModelSuffix(originModelName, settings).effort);
    }
  } catch (err) {
    throw asClientError(err);
  }
  let upstream = model;
  if (effort) {
    upstream = parsed.base;
    out.model = parsed.base;
  }
  const canonical = effectiveEffort(currentIntent);
  let reasoningEffort = "";
  if (canonical) {
    const reasoning = out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning) ? { ...(out.reasoning as Record<string, unknown>) } : {};
    reasoning.effort = canonical;
    out.reasoning = reasoning;
    reasoningEffort = canonical;
  }
  return { body: out, upstreamModelName: upstream, reasoningEffort };
}

export function claudeDefaultMaxTokensFor(model: string, settings: ReasoningHostSettings = {}): number {
  const table = settings.claudeDefaultMaxTokens || DEFAULT_CLAUDE_MAX_TOKENS;
  const exact = table[model];
  if (exact != null) return exact;
  return table.default ?? 8192;
}

export function geminiSafetySettingFor(category: string, settings: ReasoningHostSettings = {}): string {
  const table = settings.geminiSafetySettings || { default: DEFAULT_GEMINI_SAFETY };
  return table[category] || table.default || DEFAULT_GEMINI_SAFETY;
}

export function geminiSupportsImagine(model: string, settings: ReasoningHostSettings = {}): boolean {
  const list = settings.geminiSupportedImagineModels;
  if (!list || !list.length) {
    return [
      "gemini-2.0-flash-exp-image-generation",
      "gemini-2.0-flash-exp",
      "gemini-3-pro-image-preview",
      "gemini-3-pro-image",
      "gemini-2.5-flash-image",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview",
    ].includes(model);
  }
  return list.includes(model);
}

/** Original `reasoning.FromClaude`. */
export function fromClaude(req: Record<string, unknown> | null | undefined): ReasoningIntent {
  if (!req) return emptyIntent();
  const thinking = req.thinking && typeof req.thinking === "object" && !Array.isArray(req.thinking) ? (req.thinking as Record<string, unknown>) : undefined;
  const maxTokens = req.max_tokens != null ? Number(req.max_tokens) : undefined;
  let intent = thinking ? fromClaudeThinking(thinking, Number.isFinite(maxTokens) ? maxTokens : undefined) : emptyIntent();
  if (!thinking) intent = emptyIntent();
  intent.source = SOURCE_NATIVE;
  const output = req.output_config;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const effortRaw = (output as { effort?: unknown }).effort;
    if (typeof effortRaw === "string" && effortRaw) intent.effort = parseEffort(effortRaw);
  }
  if (intent.mode === MODE_DISABLED && intent.effort && intent.effort !== EFFORT_NONE) return intent;
  return normalizeIntent(intent);
}

/** Original `reasoning.FromGemini`. */
export function fromGemini(req: Record<string, unknown> | null | undefined): ReasoningIntent {
  if (!req) return emptyIntent();
  const gc = (req.generationConfig || req.generation_config || {}) as Record<string, unknown>;
  const config = (gc.thinkingConfig || gc.thinking_config) as Record<string, unknown> | undefined;
  if (!config || typeof config !== "object") return emptyIntent();
  const budget = config.thinkingBudget ?? config.thinking_budget;
  const level = String(config.thinkingLevel || config.thinking_level || "");
  if (budget != null && level) throw new Error("reasoning settings conflict: Gemini thinkingBudget and thinkingLevel cannot both be set");
  const include = config.includeThoughts ?? config.include_thoughts;
  const intent: ReasoningIntent = {
    mode: MODE_UNSET,
    effort: "",
    source: SOURCE_NATIVE,
    budgetSource: SOURCE_NATIVE,
  };
  if (budget != null) intent.budgetTokens = Number(budget);
  if (typeof include === "boolean") intent.includeThoughts = include;
  if (level) {
    intent.effort = parseEffort(level);
    intent.mode = MODE_ENABLED;
  }
  return normalizeIntent(intent);
}

type ClaudeCapabilities = {
  adaptive: boolean;
  supportsManual: boolean;
  defaultThinking: boolean;
  supportsDisable: boolean;
  supportsEffort: boolean;
  supportsXHigh: boolean;
  supportsMax: boolean;
  strictSampling: boolean;
};

function claudeCapabilitiesFor(model: string): ClaudeCapabilities {
  const name = model.toLowerCase();
  const capabilities: ClaudeCapabilities = {
    adaptive: false,
    supportsManual: true,
    defaultThinking: false,
    supportsDisable: true,
    supportsEffort: false,
    supportsXHigh: false,
    supportsMax: false,
    strictSampling: false,
  };
  if (name.startsWith("claude-fable-5") || name.startsWith("claude-mythos-5")) {
    capabilities.adaptive = true;
    capabilities.supportsManual = false;
    capabilities.defaultThinking = true;
    capabilities.supportsDisable = false;
    capabilities.supportsXHigh = true;
    capabilities.supportsMax = true;
    capabilities.strictSampling = true;
  } else if (name.startsWith("claude-mythos-preview")) {
    capabilities.adaptive = true;
    capabilities.defaultThinking = true;
    capabilities.supportsDisable = false;
    capabilities.supportsMax = true;
    capabilities.strictSampling = true;
  } else if (
    name.startsWith("claude-opus-5") ||
    name.startsWith("claude-sonnet-5") ||
    name.startsWith("claude-opus-4-8") ||
    name.startsWith("claude-opus-4-7")
  ) {
    capabilities.adaptive = true;
    capabilities.supportsManual = false;
    if (name.startsWith("claude-opus-5") || name.startsWith("claude-sonnet-5")) capabilities.defaultThinking = true;
    capabilities.supportsEffort = true;
    capabilities.supportsXHigh = true;
    capabilities.supportsMax = true;
    capabilities.strictSampling = true;
  } else if (name.startsWith("claude-opus-4-6") || name.startsWith("claude-sonnet-4-6")) {
    capabilities.adaptive = true;
    capabilities.supportsEffort = true;
    capabilities.supportsMax = true;
  } else if (name.startsWith("claude-opus-4-5")) {
    capabilities.supportsEffort = true;
  }
  return capabilities;
}

function normalizeClaudeEffort(effort: string, capabilities: ClaudeCapabilities): string {
  switch (effort) {
    case EFFORT_MINIMAL:
      return EFFORT_LOW;
    case EFFORT_XHIGH:
      if (capabilities.supportsXHigh) return effort;
      if (capabilities.supportsMax) return EFFORT_MAX;
      return EFFORT_HIGH;
    case EFFORT_MAX:
      if (!capabilities.supportsMax) return EFFORT_HIGH;
      break;
  }
  return effort;
}

function effortPercentage(effort: string, adapterBudgetPercentage: number): number {
  switch (effort) {
    case EFFORT_MINIMAL:
      return 5;
    case EFFORT_LOW:
      return 20;
    case EFFORT_MEDIUM:
      return 50;
    case EFFORT_HIGH:
      return 80;
    case EFFORT_XHIGH:
    case EFFORT_MAX:
      return 95;
  }
  let percentage = Math.round(adapterBudgetPercentage * 100);
  if (percentage <= 0) return 80;
  if (percentage >= 100) return 99;
  return percentage;
}

export type ClaudeThinking = {
  type?: string;
  budget_tokens?: number;
  display?: string;
};

export type ClaudeRender = {
  thinking?: ClaudeThinking;
  outputEffort: string;
  effectiveEffort: string;
  clearSampling: boolean;
  constrainThinkingSampling: boolean;
};

/** Original `reasoning.IsKnownClaudeModel`. */
export function isKnownClaudeModel(modelName: string): boolean {
  let baseModel = trimEffortSuffixWithSuffixes(modelName, ["-max", "-xhigh", "-high", "-medium", "-low", "-minimal", "-none"]).base;
  const marker = baseModel.lastIndexOf("-thinking-");
  if (marker >= 0) baseModel = baseModel.slice(0, marker);
  else {
    if (baseModel.endsWith("-thinking")) baseModel = baseModel.slice(0, -"-thinking".length);
    else if (baseModel.endsWith("-nothinking")) baseModel = baseModel.slice(0, -"-nothinking".length);
  }
  const prefixes = [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-opus-4-",
    "claude-sonnet-4-",
    "claude-3-7-sonnet",
  ];
  return prefixes.some((prefix) => baseModel.startsWith(prefix));
}

/** Original `reasoning.ClaudeUsesManualThinking`. */
export function claudeUsesManualThinking(model: string, intent: ReasoningIntent): boolean {
  const capabilities = claudeCapabilitiesFor(model);
  return capabilities.supportsManual && intent.budgetTokens != null && intent.mode !== MODE_ADAPTIVE;
}

function thinkingDisplay(intent: ReasoningIntent): string | undefined {
  if (intent.includeThoughts == null) return undefined;
  return intent.includeThoughts ? "summarized" : "omitted";
}

/** Original `reasoning.RenderClaude`. */
export function renderClaude(model: string, intent: ReasoningIntent, maxTokens: number | undefined, adapterBudgetPercentage: number): ClaudeRender {
  const disabledWithEffort = intent.mode === MODE_DISABLED && intent.effort !== "" && intent.effort !== EFFORT_NONE;
  let working = intent;
  if (!disabledWithEffort) working = normalizeIntent(intent);
  else working = { ...intent, effort: parseEffort(intent.effort) };
  const capabilities = claudeCapabilitiesFor(model);
  const empty: ClaudeRender = { outputEffort: "", effectiveEffort: "", clearSampling: false, constrainThinkingSampling: false };
  if (!intentHasStrength(working)) {
    if (working.includeThoughts != null && capabilities.adaptive && capabilities.defaultThinking) {
      return {
        thinking: { type: "adaptive", display: thinkingDisplay(working) },
        outputEffort: "",
        effectiveEffort: EFFORT_HIGH,
        clearSampling: capabilities.strictSampling,
        constrainThinkingSampling: false,
      };
    }
    if (capabilities.defaultThinking) {
      return { ...empty, effectiveEffort: EFFORT_HIGH, clearSampling: capabilities.strictSampling };
    }
    return { ...empty, clearSampling: capabilities.strictSampling };
  }
  if (working.mode === MODE_DISABLED || working.effort === EFFORT_NONE) {
    if (!capabilities.supportsDisable) {
      if (capabilities.adaptive) {
        const thinking: ClaudeThinking = { type: "adaptive" };
        const display = thinkingDisplay(working);
        if (display) thinking.display = display;
        let outputEffort = "";
        let effective = EFFORT_HIGH;
        if (capabilities.supportsEffort) {
          outputEffort = EFFORT_LOW;
          effective = EFFORT_LOW;
        }
        return {
          thinking,
          outputEffort,
          effectiveEffort: effective,
          clearSampling: capabilities.strictSampling,
          constrainThinkingSampling: false,
        };
      }
      return empty;
    }
    return {
      thinking: { type: "disabled" },
      outputEffort: "",
      effectiveEffort: EFFORT_NONE,
      clearSampling: capabilities.strictSampling,
      constrainThinkingSampling: false,
    };
  }
  const preferManual = capabilities.supportsManual && working.budgetTokens != null && working.mode !== MODE_ADAPTIVE;
  if (capabilities.adaptive && !preferManual) {
    let effort = working.effort;
    if (!effort && working.budgetTokens != null) effort = effortFromBudget(working.budgetTokens);
    if (!effort && working.mode === MODE_ENABLED) effort = EFFORT_HIGH;
    const normalizedEffort = normalizeClaudeEffort(effort, capabilities);
    effort = normalizedEffort;
    let effective = effort;
    if (!effective && working.mode === MODE_ADAPTIVE) effective = EFFORT_HIGH;
    if (working.mode === MODE_UNSET) {
      return {
        outputEffort: effort,
        effectiveEffort: effective,
        clearSampling: capabilities.strictSampling,
        constrainThinkingSampling: false,
      };
    }
    const thinking: ClaudeThinking = { type: "adaptive" };
    const display = thinkingDisplay(working);
    if (display) thinking.display = display;
    return {
      thinking,
      outputEffort: effort,
      effectiveEffort: effective,
      clearSampling: capabilities.strictSampling,
      constrainThinkingSampling: !capabilities.strictSampling,
    };
  }
  if (working.mode === MODE_ADAPTIVE) {
    working = { ...working, mode: MODE_ENABLED, effort: working.effort || EFFORT_HIGH };
  }
  if (working.mode === MODE_UNSET) {
    return { ...empty, outputEffort: working.effort, effectiveEffort: working.effort };
  }
  if (maxTokens == null) throw new Error("max_tokens is required for manual Claude thinking");
  if (maxTokens <= 1024) throw new Error("max_tokens must be greater than 1024 for manual Claude thinking");
  let budget = 0;
  if (working.budgetTokens != null && working.budgetTokens >= 0) {
    const requested = working.budgetTokens;
    budget = Math.max(requested, 1024);
    if (budget >= maxTokens) budget = maxTokens - 1;
  } else {
    const percentage = effortPercentage(working.effort, adapterBudgetPercentage);
    budget = Math.max(Math.trunc((maxTokens * percentage) / 100), 1024);
    if (budget >= maxTokens) budget = maxTokens - 1;
  }
  let effective = working.effort;
  if (working.budgetTokens != null && !capabilities.supportsEffort) effective = effortFromBudget(budget);
  else if (!effective) effective = effortFromBudget(budget);
  let outputEffort = "";
  if (capabilities.supportsEffort && working.effort) {
    outputEffort = normalizeClaudeEffort(working.effort, capabilities);
    effective = outputEffort;
  }
  const thinking: ClaudeThinking = { type: "enabled", budget_tokens: budget };
  const display = thinkingDisplay(working);
  if (display) thinking.display = display;
  return {
    thinking,
    outputEffort,
    effectiveEffort: effective,
    clearSampling: false,
    constrainThinkingSampling: true,
  };
}

type GeminiThinkingKind = "unknown" | "not_configurable" | "budget" | "level";

type GeminiCapabilities = {
  kind: GeminiThinkingKind;
  supportsDisable: boolean;
  supportsIncludeThoughts: boolean;
  minBudget: number;
  maxBudget: number;
};

function geminiCapabilitiesFor(model: string): GeminiCapabilities {
  const name = model.toLowerCase();
  if (name.startsWith("gemini-2.5-flash-native-audio") || name.startsWith("gemini-live-2.5-flash-preview-native-audio")) {
    return { kind: "budget", supportsDisable: true, supportsIncludeThoughts: false, minBudget: 0, maxBudget: 24576 };
  }
  if (name.startsWith("gemini-2.5-flash-image") || name.includes("-tts") || name.includes("-native-audio") || name.includes("-live")) {
    return { kind: "not_configurable", supportsDisable: false, supportsIncludeThoughts: false, minBudget: 0, maxBudget: 0 };
  }
  if (name.startsWith("gemini-3-pro-image") || name.startsWith("nano-banana-pro")) {
    return { kind: "not_configurable", supportsDisable: false, supportsIncludeThoughts: true, minBudget: 0, maxBudget: 0 };
  }
  if (name === "gemini-flash-latest" || name === "gemini-flash-lite-latest" || name === "gemini-pro-latest") {
    return { kind: "level", supportsDisable: false, supportsIncludeThoughts: false, minBudget: 0, maxBudget: 0 };
  }
  if (name.startsWith("gemini-2.5-pro")) {
    return { kind: "budget", supportsDisable: false, supportsIncludeThoughts: false, minBudget: 128, maxBudget: 32768 };
  }
  if (name.startsWith("gemini-2.5-flash-lite")) {
    return { kind: "budget", supportsDisable: true, supportsIncludeThoughts: false, minBudget: 512, maxBudget: 24576 };
  }
  if (name.startsWith("gemini-2.5-")) {
    return { kind: "budget", supportsDisable: true, supportsIncludeThoughts: false, minBudget: 0, maxBudget: 24576 };
  }
  if (name.startsWith("gemini-3")) {
    return { kind: "level", supportsDisable: false, supportsIncludeThoughts: false, minBudget: 0, maxBudget: 0 };
  }
  return { kind: "unknown", supportsDisable: false, supportsIncludeThoughts: false, minBudget: 0, maxBudget: 0 };
}

function geminiDefaultEffort(model: string): string {
  const name = model.toLowerCase();
  if (name === "gemini-flash-latest" || (name.startsWith("gemini-3.5-flash") && !name.startsWith("gemini-3.5-flash-lite")) || name.startsWith("gemini-3.6-flash")) {
    return EFFORT_MEDIUM;
  }
  if (name === "gemini-flash-lite-latest" || name.startsWith("gemini-3.5-flash-lite") || name.startsWith("gemini-3.1-flash-lite")) {
    return EFFORT_MINIMAL;
  }
  if (name === "gemini-pro-latest" || name.startsWith("gemini-3.1-pro") || name.startsWith("gemini-3-pro") || name.startsWith("gemini-3-flash")) {
    return EFFORT_HIGH;
  }
  return "";
}

function gemini25BudgetForEffort(effort: string): number {
  switch (effort) {
    case EFFORT_MINIMAL:
    case EFFORT_LOW:
      return 1024;
    case EFFORT_MEDIUM:
      return 8192;
    case EFFORT_HIGH:
    case EFFORT_XHIGH:
    case EFFORT_MAX:
      return 24576;
    default:
      return 0;
  }
}

function geminiLevelForEffort(model: string, effort: string): string {
  const name = model.toLowerCase();
  if (name.startsWith("gemini-3.1-flash-image") || name.startsWith("gemini-3.1-flash-lite-image")) {
    if (effort === EFFORT_MINIMAL || effort === EFFORT_LOW) return EFFORT_MINIMAL;
    return EFFORT_HIGH;
  }
  if (name.startsWith("gemini-3-pro") && !name.startsWith("gemini-3.1-pro")) {
    if (effort === EFFORT_MINIMAL || effort === EFFORT_LOW) return EFFORT_LOW;
    return EFFORT_HIGH;
  }
  if (name.startsWith("gemini-3.1-pro") || name === "gemini-pro-latest") {
    if (effort === EFFORT_MINIMAL) return EFFORT_LOW;
  }
  switch (effort) {
    case EFFORT_MINIMAL:
    case EFFORT_LOW:
    case EFFORT_MEDIUM:
    case EFFORT_HIGH:
      return effort;
    case EFFORT_XHIGH:
    case EFFORT_MAX:
      return EFFORT_HIGH;
    case EFFORT_NONE:
      throw new Error(`thinking cannot be disabled for model ${JSON.stringify(model)}`);
    default:
      throw new Error(`unsupported reasoning effort ${JSON.stringify(effort)} for model ${JSON.stringify(model)}`);
  }
}

function clampGeminiBudget(budget: number, capabilities: GeminiCapabilities): number {
  if (budget < capabilities.minBudget) return capabilities.minBudget;
  if (budget > capabilities.maxBudget) return capabilities.maxBudget;
  return budget;
}

function validateGeminiBudget(model: string, budget: number, capabilities: GeminiCapabilities): void {
  if (budget === -1) return;
  if (budget === 0) {
    if (capabilities.supportsDisable) return;
    throw new Error(`thinking cannot be disabled for model ${JSON.stringify(model)}`);
  }
  if (budget < capabilities.minBudget || budget > capabilities.maxBudget) {
    throw new Error(`thinking budget ${budget} is outside the supported range [${capabilities.minBudget},${capabilities.maxBudget}] for model ${JSON.stringify(model)}`);
  }
}

export type GeminiThinkingConfig = {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
};

export type GeminiRender = {
  config?: GeminiThinkingConfig;
  effectiveEffort: string;
};

/** Original `reasoning.ResolveGeminiEnabledDefault`. */
export function resolveGeminiEnabledDefault(model: string, intent: ReasoningIntent, maxOutputTokens?: number): ReasoningIntent {
  if (intent.mode !== MODE_ENABLED || intent.effort || intent.budgetTokens != null) return intent;
  const capabilities = geminiCapabilitiesFor(model);
  if (capabilities.kind === "budget") {
    if (intent.source === SOURCE_SUFFIX && maxOutputTokens != null && maxOutputTokens > 0) return intent;
    return { ...intent, budgetTokens: -1, budgetSource: SOURCE_SUFFIX };
  }
  if (capabilities.kind === "level") return { ...intent, effort: geminiDefaultEffort(model) };
  return intent;
}

/** Original `reasoning.RenderGemini`. */
export function renderGemini(model: string, intent: ReasoningIntent, maxOutputTokens: number | undefined, adapterBudgetPercentage: number): GeminiRender {
  const working = normalizeIntent(intent);
  if (intentIsEmpty(working)) return { effectiveEffort: "" };
  const capabilities = geminiCapabilitiesFor(model);
  if (capabilities.kind === "not_configurable") {
    if (!intentHasStrength(working) && capabilities.supportsIncludeThoughts) {
      return { config: { includeThoughts: working.includeThoughts }, effectiveEffort: EFFORT_HIGH };
    }
    throw new Error(`model ${JSON.stringify(model)} does not support configurable thinking`);
  }
  if (capabilities.kind === "unknown") {
    if (intentHasStrength(working)) throw new Error(`model ${JSON.stringify(model)} does not have a known Gemini thinking configuration`);
    return { config: { includeThoughts: working.includeThoughts }, effectiveEffort: "" };
  }
  const config: GeminiThinkingConfig = {};
  if (working.includeThoughts != null) config.includeThoughts = working.includeThoughts;
  if (capabilities.kind === "budget") {
    if (working.mode === MODE_DISABLED || working.effort === EFFORT_NONE) {
      if (!capabilities.supportsDisable) throw new Error(`thinking cannot be disabled for model ${JSON.stringify(model)}`);
      config.thinkingBudget = 0;
      return { config, effectiveEffort: EFFORT_NONE };
    }
    let budget = 0;
    let hasBudget = false;
    if (working.budgetTokens != null) {
      budget = working.budgetTokens;
      if (working.budgetSource !== SOURCE_NATIVE && budget !== -1) budget = clampGeminiBudget(budget, capabilities);
      hasBudget = true;
    } else if (working.effort) {
      budget = gemini25BudgetForEffort(working.effort);
      hasBudget = true;
    } else if (working.mode !== MODE_UNSET && maxOutputTokens != null && maxOutputTokens > 0) {
      let percentage = adapterBudgetPercentage;
      if (percentage <= 0) percentage = 0.6;
      else if (percentage > 1) percentage = 1;
      budget = Math.round(maxOutputTokens * percentage);
      budget = clampGeminiBudget(budget, capabilities);
      hasBudget = true;
    }
    if (hasBudget) {
      validateGeminiBudget(model, budget, capabilities);
      config.thinkingBudget = budget;
    }
    let effort = working.effort;
    if (hasBudget) effort = effortFromBudget(budget);
    else if (working.mode === MODE_ENABLED || working.mode === MODE_ADAPTIVE) effort = geminiDefaultEffort(model);
    return { config, effectiveEffort: effort };
  }
  if (working.mode === MODE_DISABLED || working.effort === EFFORT_NONE) {
    throw new Error(`thinking cannot be disabled for model ${JSON.stringify(model)}`);
  }
  let effort = working.effort;
  if (!effort && working.budgetTokens != null) effort = effortFromBudget(working.budgetTokens);
  if (effort) {
    const level = geminiLevelForEffort(model, effort);
    config.thinkingLevel = level;
    effort = level;
  } else if (working.mode === MODE_ENABLED || working.mode === MODE_ADAPTIVE) {
    effort = geminiDefaultEffort(model);
  }
  return { config, effectiveEffort: effort };
}

/** Original `reasoning.EquivalentGeminiStrength`. */
export function equivalentGeminiStrength(model: string, left: ReasoningIntent, right: ReasoningIntent): boolean {
  const leftRendered = renderGemini(model, left, undefined, 0);
  const rightRendered = renderGemini(model, right, undefined, 0);
  if (!leftRendered.config || !rightRendered.config) return !leftRendered.config && !rightRendered.config;
  if (leftRendered.config.thinkingLevel !== rightRendered.config.thinkingLevel) return false;
  if ((leftRendered.config.thinkingBudget == null) !== (rightRendered.config.thinkingBudget == null)) return false;
  return leftRendered.config.thinkingBudget == null || leftRendered.config.thinkingBudget === rightRendered.config.thinkingBudget;
}
