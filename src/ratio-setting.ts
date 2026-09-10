import { baseModelName } from "./reasoning.js";

export type CompletionRatioInfo = { ratio: number; locked: boolean };

function handleThinkingBudgetModel(name: string, prefix: string, wildcard: string): string {
  if (name.startsWith(prefix) && name.includes("-thinking-")) return wildcard;
  return name;
}

/** Original `ratio_setting.FormatMatchingModelName`. */
export function formatMatchingModelName(name: string): string {
  if (name.startsWith("gemini-2.5-flash-lite")) {
    name = handleThinkingBudgetModel(name, "gemini-2.5-flash-lite", "gemini-2.5-flash-lite-thinking-*");
  } else if (name.startsWith("gemini-2.5-flash")) {
    name = handleThinkingBudgetModel(name, "gemini-2.5-flash", "gemini-2.5-flash-thinking-*");
  } else if (name.startsWith("gemini-2.5-pro")) {
    name = handleThinkingBudgetModel(name, "gemini-2.5-pro", "gemini-2.5-pro-thinking-*");
  }
  if (name.startsWith("gpt-4-gizmo")) name = "gpt-4-gizmo-*";
  if (name.startsWith("gpt-4o-gizmo")) name = "gpt-4o-gizmo-*";
  return name;
}

/** Original `reasoning.BaseModelName` for token-limit / ability fallback matching. */
export { baseModelName } from "./reasoning.js";

/** Original `ratio_setting.RoutingMatchModelName`. */
export function routingMatchModelName(name: string, settings?: import("./reasoning.js").ReasoningHostSettings): string {
  return formatMatchingModelName(baseModelName(name, settings));
}

/** Original `middleware.tokenModelLimitAllows`. */
export function tokenModelLimitAllows(
  limit: Record<string, boolean>,
  model: string,
  settings?: import("./reasoning.js").ReasoningHostSettings,
): boolean {
  if (limit[model]) return true;
  const formatted = formatMatchingModelName(model);
  if (limit[formatted]) return true;
  return Boolean(limit[routingMatchModelName(model, settings)]);
}

function numberMap(map: Record<string, unknown> | Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map || {})) {
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function mapHas(map: Record<string, number>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

/** Original `ratio_setting.getHardcodedCompletionModelRatio`. */
export function getHardcodedCompletionModelRatio(name: string): { ratio: number; locked: boolean } {
  const isReservedModel = name.endsWith("-all") || name.endsWith("-gizmo-*");
  if (isReservedModel) return { ratio: 2, locked: false };

  if (name.startsWith("gpt-")) {
    if (name.startsWith("gpt-4o")) {
      if (name === "gpt-4o-2024-05-13") return { ratio: 3, locked: true };
      if (name.startsWith("gpt-4o-mini-tts")) return { ratio: 20, locked: false };
      return { ratio: 4, locked: false };
    }
    if (name.startsWith("gpt-5")) {
      if (!name.includes(".")) return { ratio: 8, locked: true };
      if (name.startsWith("gpt-5.4")) {
        if (name.startsWith("gpt-5.4-nano")) return { ratio: 6.25, locked: true };
        return { ratio: 6, locked: true };
      }
      return { ratio: 6, locked: false };
    }
    if (name.startsWith("gpt-4.5-preview")) return { ratio: 2, locked: true };
    if (name.startsWith("gpt-4-turbo") || name.endsWith("gpt-4-1106") || name.endsWith("gpt-4-1105")) {
      return { ratio: 3, locked: true };
    }
    return { ratio: 2, locked: false };
  }
  if (name.startsWith("o1") || name.startsWith("o3")) return { ratio: 4, locked: true };
  if (name === "chatgpt-4o-latest") return { ratio: 3, locked: true };

  if (name.includes("claude-3")) return { ratio: 5, locked: true };
  if (name.includes("claude-sonnet-4") || name.includes("claude-opus-4") || name.includes("claude-haiku-4")) {
    return { ratio: 5, locked: true };
  }

  if (name.startsWith("gpt-3.5")) {
    if (name === "gpt-3.5-turbo" || name.endsWith("0125")) return { ratio: 3, locked: true };
    if (name.endsWith("1106")) return { ratio: 2, locked: true };
    return { ratio: 4.0 / 3.0, locked: true };
  }
  if (name.startsWith("mistral-")) return { ratio: 3, locked: true };
  if (name.startsWith("gemini-")) {
    if (name.startsWith("gemini-1.5")) return { ratio: 4, locked: true };
    if (name.startsWith("gemini-2.0")) return { ratio: 4, locked: true };
    if (name.startsWith("gemini-2.5-pro")) return { ratio: 8, locked: false };
    if (name.startsWith("gemini-2.5-flash")) {
      if (name.startsWith("gemini-2.5-flash-preview")) return { ratio: 3.5 / 0.15, locked: false };
      if (name.startsWith("gemini-2.5-flash-lite")) return { ratio: 4, locked: false };
      return { ratio: 2.5 / 0.3, locked: false };
    }
    if (name.startsWith("gemini-robotics-er-1.5")) return { ratio: 2.5 / 0.3, locked: false };
    if (name.startsWith("gemini-3-pro")) {
      if (name.startsWith("gemini-3-pro-image")) return { ratio: 60, locked: false };
      return { ratio: 6, locked: false };
    }
    return { ratio: 4, locked: false };
  }
  if (name.startsWith("command")) {
    switch (name) {
      case "command-r":
        return { ratio: 3, locked: true };
      case "command-r-plus":
        return { ratio: 5, locked: true };
      case "command-r-08-2024":
        return { ratio: 4, locked: true };
      case "command-r-plus-08-2024":
        return { ratio: 4, locked: true };
      default:
        return { ratio: 4, locked: false };
    }
  }
  if (name.startsWith("ERNIE-Speed-")) return { ratio: 2, locked: true };
  if (name.startsWith("ERNIE-Lite-")) return { ratio: 2, locked: true };
  if (name.startsWith("ERNIE-Character")) return { ratio: 2, locked: true };
  if (name.startsWith("ERNIE-Functions")) return { ratio: 2, locked: true };
  switch (name) {
    case "llama2-70b-4096":
      return { ratio: 0.8 / 0.64, locked: true };
    case "llama3-8b-8192":
      return { ratio: 2, locked: true };
    case "llama3-70b-8192":
      return { ratio: 0.79 / 0.59, locked: true };
  }
  return { ratio: 1, locked: false };
}

/** Original `ratio_setting.GetCompletionRatioInfo`. */
export function getCompletionRatioInfo(
  name: string,
  completionRatioMap: Record<string, unknown> | Record<string, number> = {},
): CompletionRatioInfo {
  const map = numberMap(completionRatioMap);
  name = formatMatchingModelName(name);
  if (name.includes("/")) {
    if (mapHas(map, name)) return { ratio: map[name], locked: false };
  }
  const hardCoded = getHardcodedCompletionModelRatio(name);
  if (hardCoded.locked) return { ratio: hardCoded.ratio, locked: true };
  if (mapHas(map, name)) return { ratio: map[name], locked: false };
  return { ratio: hardCoded.ratio, locked: false };
}

/** Original `ratio_setting.GetCompletionRatio`. */
export function getCompletionRatio(
  name: string,
  completionRatioMap: Record<string, unknown> | Record<string, number> = {},
): number {
  const map = numberMap(completionRatioMap);
  name = formatMatchingModelName(name);
  if (name.includes("/")) {
    if (mapHas(map, name)) return map[name];
  }
  const hardCoded = getHardcodedCompletionModelRatio(name);
  if (hardCoded.locked) return hardCoded.ratio;
  if (mapHas(map, name)) return map[name];
  return hardCoded.ratio;
}

/** Original `ratio_setting.HasConfiguredModelRatio`. */
export function hasConfiguredModelRatio(
  name: string,
  modelRatioMap: Record<string, unknown> | Record<string, number> = {},
): boolean {
  const map = numberMap(modelRatioMap);
  return mapHas(map, formatMatchingModelName(name));
}

/** Original `ratio_setting.GetModelPrice` — returns configured=false when missing. */
export function getModelPriceFromMap(
  name: string,
  modelPriceMap: Record<string, unknown> | Record<string, number> = {},
): { price: number; configured: boolean } {
  const map = numberMap(modelPriceMap);
  name = formatMatchingModelName(name);
  if (mapHas(map, name)) return { price: map[name], configured: true };
  return { price: -1, configured: false };
}

/**
 * Original `ratio_setting.GetModelRatio`.
 * Missing names return 37.5; `configured` is SelfUseModeEnabled in that case.
 */
export function getModelRatioFromMap(
  name: string,
  modelRatioMap: Record<string, unknown> | Record<string, number> = {},
  selfUseModeEnabled = false,
): { ratio: number; configured: boolean; name: string } {
  const map = numberMap(modelRatioMap);
  name = formatMatchingModelName(name);
  if (mapHas(map, name)) return { ratio: map[name], configured: true, name };
  return { ratio: 37.5, configured: selfUseModeEnabled, name };
}

function exactMapRatio(
  name: string,
  ratioMap: Record<string, unknown> | Record<string, number> | undefined,
  missing: number,
): { ratio: number; configured: boolean } {
  const map = numberMap(ratioMap);
  if (mapHas(map, name)) return { ratio: map[name], configured: true };
  return { ratio: missing, configured: false };
}

/** Original `ratio_setting.GetCacheRatio` — lookup is exact, not FormatMatchingModelName. */
export function getCacheRatioFromMap(
  name: string,
  cacheRatioMap: Record<string, unknown> | Record<string, number> = {},
): { ratio: number; configured: boolean } {
  return exactMapRatio(name, cacheRatioMap, 1);
}

/** Original `ratio_setting.GetCreateCacheRatio`. */
export function getCreateCacheRatioFromMap(
  name: string,
  createCacheRatioMap: Record<string, unknown> | Record<string, number> = {},
): { ratio: number; configured: boolean } {
  return exactMapRatio(name, createCacheRatioMap, 1.25);
}

/** Original `ratio_setting.GetImageRatio`. */
export function getImageRatioFromMap(
  name: string,
  imageRatioMap: Record<string, unknown> | Record<string, number> = {},
): { ratio: number; configured: boolean } {
  return exactMapRatio(name, imageRatioMap, 1);
}

/** Original `ratio_setting.ContainsAudioRatio` / `GetAudioRatio`. */
export function getAudioRatioFromMap(
  name: string,
  audioRatioMap: Record<string, unknown> | Record<string, number> = {},
): { ratio: number; configured: boolean } {
  return exactMapRatio(formatMatchingModelName(name), audioRatioMap, 1);
}

/** Original `ratio_setting.ContainsAudioCompletionRatio` / `GetAudioCompletionRatio`. */
export function getAudioCompletionRatioFromMap(
  name: string,
  audioCompletionRatioMap: Record<string, unknown> | Record<string, number> = {},
): { ratio: number; configured: boolean } {
  return exactMapRatio(formatMatchingModelName(name), audioCompletionRatioMap, 1);
}
