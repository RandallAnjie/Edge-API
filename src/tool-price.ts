/**
 * Original `operation_setting` tool prices + Gemini audio input prices
 * (`tools.go`).
 */

import { goJSONSyntaxError } from "./channel-validate.js";

export const TOOL_PRICE_OPTION_KEY = "tool_price_setting.prices";

export const BUILD_IN_TOOL_WEB_SEARCH_PREVIEW = "web_search_preview";
export const BUILD_IN_TOOL_WEB_SEARCH = "web_search";
export const BUILD_IN_TOOL_FILE_SEARCH = "file_search";
export const BUILD_IN_TOOL_GOOGLE_SEARCH = "google_search";
export const BUILD_IN_TOOL_IMAGE_GENERATION = "image_generation";

const DEFAULT_WEB_SEARCH_TOOL_PRICE = 10;
const DEFAULT_WEB_SEARCH_PREVIEW_TOOL_PRICE = 10;
const DEFAULT_FILE_SEARCH_TOOL_PRICE = 2.5;
const DEFAULT_GOOGLE_SEARCH_TOOL_PRICE = 14;
const DEFAULT_IMAGE_GENERATION_TOOL_PRICE = 150;
const DEFAULT_SEARCH_PREVIEW_MODEL_PRICE = 25;

type PrefixEntry = { prefix: string; price: number };

type ToolPriceIndex = {
  defaults: Record<string, number>;
  prefixes: Record<string, PrefixEntry[]>;
};

function isValidToolPrice(price: number): boolean {
  return price >= 0 && Number.isFinite(price);
}

/** Original `common.GetJsonType`. */
function goGetJsonType(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) return "unknown";
  switch (trimmed[0]) {
    case "{":
      return "object";
    case "[":
      return "array";
    case '"':
      return "string";
    case "t":
    case "f":
      return "boolean";
    case "n":
      return "null";
    default:
      return "number";
  }
}

/** Original `operation_setting.ValidateToolPricesJSON`. */
export function validateToolPricesJSON(value: string): string | null {
  const trimmed = String(value ?? "").trim();
  if (goGetJsonType(trimmed) !== "object") return "工具价格必须是 JSON 对象";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return "解析工具价格失败: " + goJSONSyntaxError(trimmed, err);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "工具价格必须是 JSON 对象";
  }
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== "number") return `工具价格 "${name}" 必须是非负数字`;
    if (!isValidToolPrice(entry)) return `工具价格 "${name}" 必须是有限的非负数字`;
  }
  return null;
}

/** Original `seedHardcodedToolPrices`. */
export function seedHardcodedToolPrices(prices: Record<string, number> = {}): Record<string, number> {
  prices[BUILD_IN_TOOL_WEB_SEARCH] = DEFAULT_WEB_SEARCH_TOOL_PRICE;
  prices[BUILD_IN_TOOL_WEB_SEARCH_PREVIEW] = DEFAULT_WEB_SEARCH_PREVIEW_TOOL_PRICE;
  prices[BUILD_IN_TOOL_FILE_SEARCH] = DEFAULT_FILE_SEARCH_TOOL_PRICE;
  prices[BUILD_IN_TOOL_GOOGLE_SEARCH] = DEFAULT_GOOGLE_SEARCH_TOOL_PRICE;
  prices[BUILD_IN_TOOL_IMAGE_GENERATION] = DEFAULT_IMAGE_GENERATION_TOOL_PRICE;
  prices[`${BUILD_IN_TOOL_WEB_SEARCH_PREVIEW}:gpt-4o*`] = DEFAULT_SEARCH_PREVIEW_MODEL_PRICE;
  prices[`${BUILD_IN_TOOL_WEB_SEARCH_PREVIEW}:gpt-4.1*`] = DEFAULT_SEARCH_PREVIEW_MODEL_PRICE;
  prices[`${BUILD_IN_TOOL_WEB_SEARCH_PREVIEW}:gpt-4o-mini*`] = DEFAULT_SEARCH_PREVIEW_MODEL_PRICE;
  prices[`${BUILD_IN_TOOL_WEB_SEARCH_PREVIEW}:gpt-4.1-mini*`] = DEFAULT_SEARCH_PREVIEW_MODEL_PRICE;
  return prices;
}

/** Original `decodeToolPricesJSON` with invalid entries ignored. */
export function decodeToolPricesJSON(value: string): Record<string, number> {
  const trimmed = String(value || "").trim() || "{}";
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const prices: Record<string, number> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "number" || !isValidToolPrice(entry)) continue;
    prices[name] = entry;
  }
  return prices;
}

function rebuildToolPriceIndex(operatorPrices: Record<string, number> | null | undefined): ToolPriceIndex {
  const merged = seedHardcodedToolPrices({});
  if (operatorPrices) {
    for (const [key, price] of Object.entries(operatorPrices)) {
      if (isValidToolPrice(price)) merged[key] = price;
    }
  }
  const idx: ToolPriceIndex = { defaults: {}, prefixes: {} };
  for (const [key, price] of Object.entries(merged)) {
    const cut = key.indexOf(":");
    if (cut < 0) {
      idx.defaults[key] = price;
      continue;
    }
    const toolName = key.slice(0, cut);
    const prefix = key.slice(cut + 1).replace(/\*$/, "");
    (idx.prefixes[toolName] ||= []).push({ prefix, price });
  }
  for (const tool of Object.keys(idx.prefixes)) {
    idx.prefixes[tool].sort((a, b) => {
      if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
      return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0;
    });
  }
  return idx;
}

/**
 * Original `operation_setting.GetToolPriceForModel`.
 * Lookup: longest model prefix → tool default → 0. A matched numeric zero is terminal.
 */
export function getToolPriceForModel(
  toolName: string,
  modelName: string,
  operatorPrices?: Record<string, number> | null,
): number {
  const idx = rebuildToolPriceIndex(operatorPrices);
  const entries = idx.prefixes[toolName];
  if (entries && modelName) {
    for (const entry of entries) {
      if (modelName.startsWith(entry.prefix)) return entry.price;
    }
  }
  if (Object.prototype.hasOwnProperty.call(idx.defaults, toolName)) return idx.defaults[toolName];
  return 0;
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
