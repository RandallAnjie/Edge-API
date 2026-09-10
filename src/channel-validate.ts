import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_NEW_API,
  CHANNEL_TYPE_TASK_PLUGIN,
  CHANNEL_TYPE_VERTEX,
  parseJson,
} from "./constants.js";
import { pickChannelKey } from "./select.js";
import type { ChannelRow } from "./types.js";

export const ADVANCED_CUSTOM_MODEL_LIST_PATH = "/v1/models";
const ADVANCED_CUSTOM_BALANCE_PATH = "/v1/dashboard/billing/credit_grants";
const ADVANCED_CUSTOM_CONVERTERS = new Set([
  "none",
  "anthropic_messages_to_openai_chat_completions",
  "openai_chat_completions_to_anthropic_messages",
  "openai_chat_completions_to_openai_responses",
  "openai_responses_to_openai_chat_completions",
  "openai_responses_to_gemini_generate_content",
  "gemini_generate_content_to_openai_chat_completions",
  "openai_chat_completions_to_gemini_generate_content",
]);

export type FetchModelsBody = {
  channel_id?: number;
  base_url?: string | null;
  type?: number;
  key?: string;
  advanced_custom?: string | null;
  header_override?: string | null;
  proxy?: string | null;
};

type AdvancedCustomRoute = {
  incoming_path?: string;
  upstream_path?: string;
  converter?: string;
  models?: string[];
  auth?: { type?: string; name?: string; value?: string };
};

export type AdvancedCustomConfig = { advanced_routes?: AdvancedCustomRoute[] };

function goJSONKind(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  return "object";
}

/** Original `encoding/json` syntax errors used by `common.UnmarshalJsonStr`. */
export function goJSONSyntaxError(raw: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/end of (JSON )?input|Unexpected end/i.test(msg)) return "unexpected end of JSON input";
  const quoted = msg.match(/Unexpected token ['`]([^'`])['`]/);
  if (quoted) return `invalid character '${quoted[1]}' looking for beginning of value`;
  const first = raw.trimStart()[0];
  if (first) return `invalid character '${first}' looking for beginning of value`;
  return "unexpected end of JSON input";
}

export function goUnmarshalJSON(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, message: goJSONSyntaxError(raw, err) };
  }
}

/** Original `json.Unmarshal` into `map[string]any`. `null` succeeds as an empty map. */
export function goUnmarshalObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: true, value: {} };
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {
      ok: false,
      message: `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type map[string]interface {}`,
    };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

function goUnmarshalNamed(raw: string, goType: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return parsed;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value) || parsed.value === null) {
    return {
      ok: false,
      message: `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type ${goType}`,
    };
  }
  return parsed;
}

/** Original `common.ParseProxyURLStrict`. */
export function parseProxyURLStrict(raw: string): Error | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return new Error("invalid proxy URL");
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks5" && scheme !== "socks5h") {
    return new Error("proxy URL must use http, https, socks5, or socks5h");
  }
  if (!parsed.hostname) return new Error("proxy URL must include a host");
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return new Error("proxy URL must include a valid port");
  }
  if (parsed.search || trimmed.includes("?")) return new Error("proxy URL must not include a query");
  if (trimmed.includes("#")) return new Error("proxy URL must not include a fragment");
  const path = parsed.pathname || "";
  if (path && path !== "/") return new Error("proxy URL must not include a path");
  return null;
}

function validateHTTPTransport(setting: Record<string, unknown>): Error | null {
  const protocol = String(setting.http_protocol || "").trim().toLowerCase();
  if (protocol && protocol !== "auto" && protocol !== "http1") {
    return new Error(`invalid http_protocol: ${setting.http_protocol}`);
  }
  const shards = Number(setting.http2_connection_shards || 0);
  if (shards < 0 || shards > 8) return new Error(`invalid http2_connection_shards: ${setting.http2_connection_shards}`);
  if (protocol === "http1" && shards > 1) return new Error("http2_connection_shards must be 1 when http_protocol is http1");
  return null;
}

function validateToolLossPolicy(settings: Record<string, unknown>): Error | null {
  const policy = String(settings.tool_loss_policy || "").trim();
  if (!policy || policy === "allow" || policy === "safe" || policy === "strict") return null;
  return new Error(`invalid tool_loss_policy: ${settings.tool_loss_policy}`);
}

function normalizeRouteModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return models.map((m) => String(m).trim()).filter(Boolean);
}

function validateAdvancedCustomUpstream(index: number, upstreamPath: string): Error | null {
  if (upstreamPath.startsWith("/")) {
    if (upstreamPath.startsWith("//")) {
      return new Error(`advanced_custom.advanced_routes[${index}].upstream_path must be a full URL or a path starting with /`);
    }
    return null;
  }
  try {
    const u = new URL(upstreamPath);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return new Error(`advanced_custom.advanced_routes[${index}].upstream_path must use http or https`);
    }
    return null;
  } catch {
    return new Error(`advanced_custom.advanced_routes[${index}].upstream_path must be a full URL or a path starting with /`);
  }
}

function validateAdvancedCustomConverterPath(index: number, incomingPath: string, converter: string): Error | null {
  if (incomingPath === "/v1/alpha/search") {
    if (converter === "none") return null;
    return new Error(`advanced_custom.advanced_routes[${index}].converter does not match incoming_path: ${converter}`);
  }
  if (converter === "none") return null;
  if (converter === "anthropic_messages_to_openai_chat_completions" && incomingPath === "/v1/messages") return null;
  if (
    (converter === "openai_chat_completions_to_anthropic_messages" ||
      converter === "openai_chat_completions_to_openai_responses" ||
      converter === "openai_chat_completions_to_gemini_generate_content") &&
    incomingPath === "/v1/chat/completions"
  ) {
    return null;
  }
  if (
    (converter === "openai_responses_to_openai_chat_completions" || converter === "openai_responses_to_gemini_generate_content") &&
    incomingPath === "/v1/responses"
  ) {
    return null;
  }
  if (
    converter === "gemini_generate_content_to_openai_chat_completions" &&
    (incomingPath.includes(":generateContent") || incomingPath.includes(":streamGenerateContent"))
  ) {
    return null;
  }
  return new Error(`advanced_custom.advanced_routes[${index}].converter does not match incoming_path: ${converter}`);
}

function validateAdvancedCustomRouteAuth(index: number, auth: AdvancedCustomRoute["auth"]): Error | null {
  if (!auth) return null;
  const authType = String(auth.type || "").trim();
  if (!authType || authType === "none") return null;
  if (authType === "header" || authType === "query") {
    if (!String(auth.name || "").trim()) return new Error(`advanced_custom.advanced_routes[${index}].auth.name is required`);
    if (!String(auth.value || "").trim()) return new Error(`advanced_custom.advanced_routes[${index}].auth.value is required`);
    return null;
  }
  return new Error(`advanced_custom.advanced_routes[${index}].auth.type is not supported: ${authType}`);
}

/** Original `dto.AdvancedCustomConfig.Validate`. */
export function validateAdvancedCustomConfig(config: AdvancedCustomConfig | null | undefined): Error | null {
  if (!config) return new Error("advanced_custom is required");
  const routes = config.advanced_routes || [];
  if (!routes.length) return new Error("advanced_custom requires at least one route");
  const paths = new Map<string, { catchAllIndex: number; modelIndexes: Map<string, number> }>();
  let modelListRouteIndex = -1;
  let balanceRouteIndex = -1;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const incomingPath = String(route.incoming_path || "").trim();
    const upstreamPath = String(route.upstream_path || "").trim();
    let converter = String(route.converter || "").trim() || "none";
    if (!incomingPath) return new Error(`advanced_custom.advanced_routes[${i}].incoming_path is required`);
    if (!incomingPath.startsWith("/")) {
      return new Error(`advanced_custom.advanced_routes[${i}].incoming_path must start with /`);
    }
    if (incomingPath.includes("?")) {
      return new Error(`advanced_custom.advanced_routes[${i}].incoming_path must not include query`);
    }
    if (incomingPath === ADVANCED_CUSTOM_MODEL_LIST_PATH || incomingPath === ADVANCED_CUSTOM_BALANCE_PATH) {
      const previous = incomingPath === ADVANCED_CUSTOM_BALANCE_PATH ? balanceRouteIndex : modelListRouteIndex;
      if (previous >= 0) {
        return new Error(`advanced_custom.advanced_routes[${i}] duplicates the ${incomingPath} route at advanced_routes[${previous}]`);
      }
      if (incomingPath === ADVANCED_CUSTOM_MODEL_LIST_PATH) modelListRouteIndex = i;
      else balanceRouteIndex = i;
      if (normalizeRouteModels(route.models).length) {
        return new Error(`advanced_custom.advanced_routes[${i}].models must be empty for ${incomingPath}`);
      }
      if (converter !== "none") {
        return new Error(`advanced_custom.advanced_routes[${i}].converter must be none for ${incomingPath}`);
      }
      if (upstreamPath.includes("{model}")) {
        return new Error(`advanced_custom.advanced_routes[${i}].upstream_path must not contain {model} for ${incomingPath}`);
      }
    }
    let state = paths.get(incomingPath);
    if (!state) {
      state = { catchAllIndex: -1, modelIndexes: new Map() };
      paths.set(incomingPath, state);
    }
    const normalizedModels = normalizeRouteModels(route.models);
    if (!normalizedModels.length) {
      if (state.catchAllIndex >= 0) {
        return new Error(`advanced_custom.advanced_routes[${i}].models catch-all already exists for incoming_path: ${incomingPath}`);
      }
      state.catchAllIndex = i;
    } else {
      if (state.catchAllIndex >= 0) {
        return new Error(`advanced_custom.advanced_routes[${i}].models catch-all route must be last for incoming_path: ${incomingPath}`);
      }
      const seen = new Set<string>();
      for (const model of normalizedModels) {
        if (model.startsWith("re:")) {
          const pattern = model.slice(3);
          if (!pattern) {
            return new Error(`advanced_custom.advanced_routes[${i}].models regex is empty for incoming_path ${incomingPath}: ${model}`);
          }
          try {
            new RegExp(pattern);
          } catch {
            return new Error(`advanced_custom.advanced_routes[${i}].models regex is invalid for incoming_path ${incomingPath}: ${model}`);
          }
        }
        if (seen.has(model)) {
          return new Error(`advanced_custom.advanced_routes[${i}].models contains duplicate model for incoming_path ${incomingPath}: ${model}`);
        }
        seen.add(model);
        const existing = state.modelIndexes.get(model);
        if (existing != null) {
          return new Error(
            `advanced_custom.advanced_routes[${i}].models overlaps with advanced_routes[${existing}] for incoming_path ${incomingPath}: ${model}`,
          );
        }
        state.modelIndexes.set(model, i);
      }
    }
    if (!upstreamPath) return new Error(`advanced_custom.advanced_routes[${i}].upstream_path is required`);
    const upstreamErr = validateAdvancedCustomUpstream(i, upstreamPath);
    if (upstreamErr) return upstreamErr;
    if (!ADVANCED_CUSTOM_CONVERTERS.has(converter)) {
      return new Error(`advanced_custom.advanced_routes[${i}].converter is not registered: ${converter}`);
    }
    const convErr = validateAdvancedCustomConverterPath(i, incomingPath, converter);
    if (convErr) return convErr;
    const authErr = validateAdvancedCustomRouteAuth(i, route.auth);
    if (authErr) return authErr;
  }
  return null;
}

/** Original `model.Channel.ValidateSettings`. */
export function validateChannelSettings(channel: { type: number; setting?: string; settings?: string }): Error | null {
  const settingRaw = String(channel.setting || "").trim();
  let setting: Record<string, unknown> = {};
  if (settingRaw) {
    const parsed = goUnmarshalNamed(settingRaw, "dto.ChannelSettings");
    if (!parsed.ok) return new Error(parsed.message);
    setting = parsed.value as Record<string, unknown>;
  }
  const proxyErr = parseProxyURLStrict(String(setting.proxy || ""));
  if (proxyErr) return new Error(`invalid channel proxy: ${proxyErr.message}`);
  const httpErr = validateHTTPTransport(setting);
  if (httpErr) return httpErr;
  const otherRaw = String(channel.settings || "").trim();
  let other: Record<string, unknown> = {};
  if (otherRaw) {
    const parsed = goUnmarshalNamed(otherRaw, "dto.ChannelOtherSettings");
    if (!parsed.ok) return new Error(parsed.message);
    other = parsed.value as Record<string, unknown>;
  }
  const toolErr = validateToolLossPolicy(other);
  if (toolErr) return toolErr;
  const advanced = other.advanced_custom as AdvancedCustomConfig | null | undefined;
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM && advanced == null) {
    return new Error("advanced_custom is required");
  }
  if (advanced != null) {
    const advErr = validateAdvancedCustomConfig(advanced);
    if (advErr) return advErr;
  }
  if (channel.type === CHANNEL_TYPE_ADVANCED_CUSTOM && other.upstream_model_update_check_enabled) {
    const routes = advanced?.advanced_routes || [];
    if (!routes.some((r) => String(r.incoming_path || "").trim() === ADVANCED_CUSTOM_MODEL_LIST_PATH)) {
      return new Error(`advanced custom channels require a ${ADVANCED_CUSTOM_MODEL_LIST_PATH} route when upstream model update checks are enabled`);
    }
  }
  return null;
}

const ADVANCED_CUSTOM_ENDPOINT_PATHS: Record<string, string> = {
  "/v1/chat/completions": "openai",
  "/v1/responses": "openai-response",
  "/v1/responses/compact": "openai-response-compact",
  "/v1/alpha/search": "openai-alpha-search",
  "/v1/messages": "anthropic",
  "/v1/rerank": "jina-rerank",
  "/v1/images/generations": "image-generation",
  "/v1/embeddings": "embeddings",
};

function isAdvancedCustomGeminiIncomingPath(incomingPath: string): boolean {
  if (!incomingPath.startsWith("/v1beta/models/")) return false;
  return incomingPath.includes(":generateContent") || incomingPath.includes(":streamGenerateContent");
}

function advancedCustomEndpointTypeFromIncomingPath(incomingPath: string): string | null {
  const mapped = ADVANCED_CUSTOM_ENDPOINT_PATHS[incomingPath];
  if (mapped) return mapped;
  if (isAdvancedCustomGeminiIncomingPath(incomingPath)) return "gemini";
  return null;
}

function matchAdvancedCustomRouteModelRule(rule: string, model: string): boolean {
  if (!rule.startsWith("re:")) return rule === model;
  const pattern = rule.slice(3);
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(model);
  } catch {
    return false;
  }
}

function matchAdvancedCustomRouteModel(models: string[] | undefined, model: string): boolean {
  const normalized = normalizeRouteModels(models);
  if (!normalized.length) return true;
  return normalized.some((rule) => matchAdvancedCustomRouteModelRule(rule, model));
}

/** Original `dto.AdvancedCustomConfig.SupportedEndpointTypesForModel`. */
export function supportedEndpointTypesForModel(config: AdvancedCustomConfig | null | undefined, model: string): string[] {
  if (!config) return [];
  const trimmed = String(model || "").trim();
  const endpoints: string[] = [];
  const seen = new Set<string>();
  for (const route of config.advanced_routes || []) {
    if (!matchAdvancedCustomRouteModel(route.models, trimmed)) continue;
    const endpoint = advancedCustomEndpointTypeFromIncomingPath(String(route.incoming_path || "").trim());
    if (!endpoint || seen.has(endpoint)) continue;
    seen.add(endpoint);
    endpoints.push(endpoint);
  }
  return endpoints;
}

/** Original `model.Channel.GetOtherSettings().AdvancedCustom`. */
export function advancedCustomConfigFromSettings(settings: string | undefined | null): AdvancedCustomConfig | null {
  const other = parseJson<Record<string, unknown>>(String(settings || ""), {});
  const raw = other.advanced_custom;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as AdvancedCustomConfig;
}

/** Original `dto.AdvancedCustomConfig.ModelListRoute`. */
export function advancedCustomModelListRoute(config: AdvancedCustomConfig | null | undefined): AdvancedCustomRoute | null {
  if (!config) return null;
  for (const route of config.advanced_routes || []) {
    if (String(route.incoming_path || "").trim() === ADVANCED_CUSTOM_MODEL_LIST_PATH) return route;
  }
  return null;
}

function applyAuthTemplate(template: string, apiKey: string): string {
  return template.replaceAll("{api_key}", apiKey);
}

function applyAdvancedCustomAuth(
  url: string,
  headers: Record<string, string>,
  auth: AdvancedCustomRoute["auth"],
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  if (!auth) {
    headers.authorization = "Bearer " + apiKey;
    return { url, headers };
  }
  const authType = String(auth.type || "").trim();
  if (authType === "header") {
    headers[String(auth.name || "").trim()] = applyAuthTemplate(String(auth.value || ""), apiKey);
  } else if (authType === "query") {
    const parsed = new URL(url);
    parsed.searchParams.set(String(auth.name || "").trim(), applyAuthTemplate(String(auth.value || ""), apiKey));
    url = parsed.toString();
  } else if (authType !== "none") {
    throw new Error(`invalid advanced custom auth type: ${authType}`);
  }
  return { url, headers };
}

const ADVANCED_CUSTOM_MODEL_PLACEHOLDER = "{model}";

/** Original `dto.matchAdvancedCustomIncomingPath`. */
export function matchAdvancedCustomIncomingPath(configuredPath: string, requestPath: string): boolean {
  if (matchAdvancedCustomIncomingPathTemplate(configuredPath, requestPath)) return true;
  if (configuredPath.includes(":generateContent")) {
    const streamPath = configuredPath.replace(":generateContent", ":streamGenerateContent");
    return matchAdvancedCustomIncomingPathTemplate(streamPath, requestPath);
  }
  return false;
}

function matchAdvancedCustomIncomingPathTemplate(configuredPath: string, requestPath: string): boolean {
  if (!configuredPath.includes(ADVANCED_CUSTOM_MODEL_PLACEHOLDER)) return configuredPath === requestPath;
  const parts = configuredPath.split(ADVANCED_CUSTOM_MODEL_PLACEHOLDER);
  if (parts.length !== 2) return false;
  if (!requestPath.startsWith(parts[0]) || !requestPath.endsWith(parts[1])) return false;
  const model = requestPath.slice(parts[0].length, requestPath.length - parts[1].length);
  return model !== "" && !model.includes("/");
}

/** Original `dto.AdvancedCustomConfig.MatchPathForModel`. */
export function matchAdvancedCustomPathForModel(
  config: AdvancedCustomConfig | null | undefined,
  requestPath: string,
  model: string,
): AdvancedCustomRoute | null {
  if (!config) return null;
  const trimmed = String(model || "").trim();
  for (const route of config.advanced_routes || []) {
    if (
      matchAdvancedCustomIncomingPath(String(route.incoming_path || "").trim(), requestPath) &&
      matchAdvancedCustomRouteModel(route.models, trimmed)
    ) {
      return route;
    }
  }
  return null;
}

function useGeminiStreamGenerateContentURL(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname.includes(":generateContent")) {
    parsed.pathname = parsed.pathname.replace(":generateContent", ":streamGenerateContent");
  }
  if (parsed.pathname.includes(":streamGenerateContent")) {
    parsed.searchParams.set("alt", "sse");
  }
  return parsed.toString();
}

function joinBaseURLAndUpstreamPath(baseURL: string, upstreamPath: string): string {
  const parsedBase = new URL(String(baseURL || "").trim());
  if (!/^https?:$/i.test(parsedBase.protocol) || !parsedBase.host) {
    throw new Error("channel base URL must be a full URL when advanced custom upstream path is relative");
  }
  const parsedPath = new URL(upstreamPath, "https://placeholder.invalid");
  parsedBase.pathname = `${parsedBase.pathname.replace(/\/+$/, "")}/${parsedPath.pathname.replace(/^\/+/, "")}`;
  parsedBase.search = parsedPath.search;
  parsedBase.hash = parsedPath.hash;
  return parsedBase.toString();
}

function resolveAdvancedCustomUpstreamURL(upstreamPath: string, channelBaseUrl: string): string {
  if (upstreamPath.startsWith("/")) {
    if (upstreamPath.startsWith("//")) {
      throw new Error("advanced custom upstream path must be a full URL or a path starting with /");
    }
    if (!String(channelBaseUrl || "").trim()) {
      throw new Error("channel base URL is required when advanced custom upstream path is relative");
    }
    return joinBaseURLAndUpstreamPath(channelBaseUrl, upstreamPath);
  }
  let parsed: URL;
  try {
    parsed = new URL(upstreamPath);
  } catch {
    throw new Error("advanced custom upstream path must be a full URL or a path starting with /");
  }
  if (!parsed.host) throw new Error("advanced custom upstream path must be a full URL or a path starting with /");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("advanced custom upstream path must use http or https");
  }
  return parsed.toString();
}

export type AdvancedCustomModelListRequest = {
  url: string;
  headers: Record<string, string>;
  body: null;
  method: "GET";
};

/** Original `advancedcustom.Adaptor.BuildModelListRequest`. */
export function buildAdvancedCustomModelListRequest(channel: ChannelRow): AdvancedCustomModelListRequest {
  const config = advancedCustomConfigFromSettings(channel.settings);
  if (!config) throw new Error("advanced_custom is required");
  const invalid = validateAdvancedCustomConfig(config);
  if (invalid) throw invalid;
  const route = advancedCustomModelListRoute(config);
  if (!route) throw new Error(`advanced custom channel does not configure a ${ADVANCED_CUSTOM_MODEL_LIST_PATH} route`);
  const converter = String(route.converter || "").trim() || "none";
  if (converter !== "none") {
    throw new Error(`converter ${JSON.stringify(converter)} does not support ${ADVANCED_CUSTOM_MODEL_LIST_PATH} requests`);
  }
  const apiKey = pickChannelKey(channel.key);
  const baseURL = String(channel.base_url || "").trim();
  const url = resolveAdvancedCustomUpstreamURL(String(route.upstream_path || "").trim(), baseURL);
  const applied = applyAdvancedCustomAuth(url, {}, route.auth, apiKey);
  return { url: applied.url, headers: applied.headers, body: null, method: "GET" };
}

export type AdvancedCustomRelayTarget = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  method: "POST";
  converter: string;
};

/** Original `advancedcustom.Adaptor.GetRequestURL` + `SetupRequestHeader` for a matched incoming path. */
export function buildAdvancedCustomRelayTarget(
  channel: ChannelRow,
  incomingPath: string,
  originModel: string,
  upstreamModel: string,
  body: unknown,
  isStream: boolean,
): AdvancedCustomRelayTarget {
  const config = advancedCustomConfigFromSettings(channel.settings);
  if (!config) throw new Error("advanced_custom is required");
  const invalid = validateAdvancedCustomConfig(config);
  if (invalid) throw invalid;
  const route = matchAdvancedCustomPathForModel(config, incomingPath, originModel);
  if (!route) {
    throw new Error(`advanced custom channel does not support request path ${incomingPath} for model ${originModel}`);
  }
  const converter = String(route.converter || "").trim() || "none";
  const apiKey = pickChannelKey(channel.key);
  const upstreamPath = String(route.upstream_path || "")
    .trim()
    .replaceAll(ADVANCED_CUSTOM_MODEL_PLACEHOLDER, upstreamModel);
  let url = resolveAdvancedCustomUpstreamURL(upstreamPath, String(channel.base_url || "").trim());
  if (
    isStream &&
    (converter === "openai_chat_completions_to_gemini_generate_content" ||
      converter === "openai_responses_to_gemini_generate_content")
  ) {
    url = useGeminiStreamGenerateContentURL(url);
  }
  const applied = applyAdvancedCustomAuth(url, { "content-type": "application/json" }, route.auth, apiKey);
  return { url: applied.url, headers: applied.headers, body, method: "POST", converter };
}

function modelsTooLong(models: string): string | null {
  for (const m of models.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (m.length > 255) return `模型名称过长: ${m}`;
  }
  return null;
}

/** Original `controller.validateChannel`. */
export function validateChannel(channel: Partial<ChannelRow> | null | undefined, isAdd: boolean): Error | null {
  if (!channel) return new Error("channel cannot be empty");
  const settingsErr = validateChannelSettings({
    type: Number(channel.type || 0),
    setting: channel.setting,
    settings: channel.settings,
  });
  if (settingsErr) return new Error(`渠道额外设置[channel setting] 格式错误：${settingsErr.message}`);
  const type = Number(channel.type || 0);
  if (type === CHANNEL_TYPE_TASK_PLUGIN) {
    const setting = parseJson<Record<string, unknown>>(String(channel.setting || ""), {});
    const pluginKey = String(setting.task_plugin_key || "").trim();
    if (!pluginKey) return new Error("task plugin key is required");
    if (pluginKey.length > 30) return new Error("task plugin key must not exceed 30 characters");
  }
  if (type === CHANNEL_TYPE_NEW_API && !String(channel.base_url || "").trim()) {
    return new Error("New API channel base URL cannot be empty");
  }
  if (isAdd) {
    if (!String(channel.key || "")) return new Error("channel cannot be empty");
    const long = modelsTooLong(String(channel.models || ""));
    if (long) return new Error(long);
  }
  if (type === CHANNEL_TYPE_VERTEX) {
    if (!String(channel.other || "")) return new Error("部署地区不能为空");
    const region = parseJson<Record<string, unknown> | null>(String(channel.other), null);
    if (!region || typeof region !== "object" || Array.isArray(region)) {
      return new Error('部署地区必须是标准的Json格式，例如{"default": "us-central1", "region2": "us-east1"}');
    }
    if (region.default == null) return new Error("部署地区必须包含default字段");
  }
  if (type === CHANNEL_TYPE_CODEX) {
    const trimmed = String(channel.key || "").trim();
    if (isAdd || trimmed) {
      if (!trimmed.startsWith("{")) return new Error("Codex key must be a valid JSON object");
      const parsed = goUnmarshalObject(trimmed);
      if (!parsed.ok) return new Error("Codex key must be a valid JSON object");
      if (!String(parsed.value.access_token ?? "").trim()) return new Error("Codex key JSON must include access_token");
      if (!String(parsed.value.account_id ?? "").trim()) return new Error("Codex key JSON must include account_id");
    }
  }
  return null;
}

/** Original `controller.getVertexArrayKeys`. */
export function getVertexArrayKeys(keys: string): string[] {
  if (!keys) return [];
  const parsed = goUnmarshalJSON(keys);
  if (!parsed.ok) {
    throw new Error(`批量添加 Vertex AI 必须使用标准的JsonArray格式，例如[{key1}, {key2}...]，请检查输入: ${parsed.message}`);
  }
  if (!Array.isArray(parsed.value)) {
    throw new Error(
      `批量添加 Vertex AI 必须使用标准的JsonArray格式，例如[{key1}, {key2}...]，请检查输入: json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type []interface {}`,
    );
  }
  return parsed.value.map((key) => (typeof key === "string" ? key.trim() : JSON.stringify(key))).filter(Boolean);
}

function vertexUsesJSONKeys(channel: { settings?: string; setting?: string }): boolean {
  const other = parseJson<Record<string, unknown>>(String(channel.settings || ""), {});
  return String(other.vertex_key_type || "") !== "api_key";
}

export function newlineKeys(key: string): string[] {
  return key.split("\n");
}

export type AddChannelMode = "single" | "batch" | "multi_to_single";

/** Original AddChannel key expansion after `validateChannel`. */
export function expandAddChannelKeys(
  channel: { type: number; key: string; settings?: string },
  mode: AddChannelMode,
): { keys: string[]; key: string; multiKey: boolean; multiKeyMode?: string } {
  const type = Number(channel.type || 0);
  if (mode === "multi_to_single") {
    let array: string[];
    if (type === CHANNEL_TYPE_VERTEX && vertexUsesJSONKeys(channel)) {
      array = getVertexArrayKeys(channel.key);
    } else {
      array = newlineKeys(channel.key).map((k) => k.trim()).filter(Boolean);
    }
    return { keys: [array.join("\n")], key: array.join("\n"), multiKey: true };
  }
  if (mode === "batch") {
    const keys =
      type === CHANNEL_TYPE_VERTEX && vertexUsesJSONKeys(channel) ? getVertexArrayKeys(channel.key) : newlineKeys(channel.key);
    return { keys, key: channel.key, multiKey: false };
  }
  return { keys: [channel.key], key: channel.key, multiKey: false };
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function channelFieldsFromBody(ch: Record<string, unknown>): Partial<ChannelRow> {
  return {
    type: Number(ch.type || 1),
    key: String(ch.key || ""),
    name: String(ch.name || ""),
    weight: Number(ch.weight ?? 1),
    base_url: String(ch.base_url || ""),
    other: String(ch.other || ""),
    models: String(ch.models || ""),
    group: String(ch.group || "default"),
    model_mapping: typeof ch.model_mapping === "string" ? ch.model_mapping : JSON.stringify(ch.model_mapping || ""),
    status_code_mapping: typeof ch.status_code_mapping === "string" ? ch.status_code_mapping : String(ch.status_code_mapping || ""),
    priority: Number(ch.priority || 0),
    auto_ban: ch.auto_ban == null ? 1 : Number(ch.auto_ban),
    tag: String(ch.tag || ""),
    header_override: typeof ch.header_override === "string" ? ch.header_override : JSON.stringify(ch.header_override || ""),
    param_override: typeof ch.param_override === "string" ? ch.param_override : JSON.stringify(ch.param_override || ""),
    remark: String(ch.remark || ""),
    openai_organization: String(ch.openai_organization || ""),
    test_model: String(ch.test_model || ""),
    settings: typeof ch.settings === "string" ? ch.settings : ch.settings ? JSON.stringify(ch.settings) : "",
    setting: typeof ch.setting === "string" ? ch.setting : ch.setting ? JSON.stringify(ch.setting) : asText(ch.setting || ch.settings || ""),
    other_info: String(ch.other_info || ""),
    balance: String(ch.balance ?? ""),
  };
}

function tempChannel(partial: Partial<ChannelRow>): ChannelRow {
  return {
    id: Number(partial.id || 0),
    type: Number(partial.type || 1),
    key: String(partial.key || ""),
    status: Number(partial.status ?? 1),
    name: String(partial.name || "tmp"),
    weight: Number(partial.weight ?? 1),
    created_time: Number(partial.created_time || 0),
    test_time: Number(partial.test_time || 0),
    response_time: Number(partial.response_time || 0),
    base_url: String(partial.base_url || ""),
    other: String(partial.other || ""),
    models: String(partial.models || ""),
    group: String(partial.group || "default"),
    used_quota: Number(partial.used_quota || 0),
    model_mapping: String(partial.model_mapping || ""),
    status_code_mapping: String(partial.status_code_mapping || ""),
    priority: Number(partial.priority || 0),
    auto_ban: partial.auto_ban == null ? 1 : Number(partial.auto_ban),
    tag: String(partial.tag || ""),
    header_override: String(partial.header_override || ""),
    param_override: String(partial.param_override || ""),
    remark: String(partial.remark || ""),
    settings: String(partial.settings || ""),
    openai_organization: String(partial.openai_organization || ""),
    test_model: String(partial.test_model || ""),
    setting: String(partial.setting || ""),
  };
}

function mergeOtherSettings(raw: string, patch: Record<string, unknown>): string {
  const current = parseJson<Record<string, unknown>>(raw, {});
  return JSON.stringify({ ...current, ...patch });
}

function mergeSetting(raw: string, patch: Record<string, unknown>): string {
  const current = parseJson<Record<string, unknown>>(raw, {});
  return JSON.stringify({ ...current, ...patch });
}

/** Original `controller.buildAdvancedCustomModelPreviewChannel`. */
export async function buildAdvancedCustomModelPreviewChannel(
  req: FetchModelsBody,
  getChannel: (id: number) => Promise<ChannelRow | null>,
): Promise<ChannelRow> {
  const channelId = Number(req.channel_id || 0);
  let channel: ChannelRow;
  if (channelId > 0) {
    const saved = await getChannel(channelId);
    if (!saved) throw new Error("record not found");
    if (saved.type !== CHANNEL_TYPE_ADVANCED_CUSTOM) {
      throw new Error(`channel ${channelId} is not an advanced custom channel`);
    }
    channel = { ...saved };
  } else {
    let key = String(req.key || "").trim();
    if (key) key = key.split("\n")[0] || "";
    channel = tempChannel({ type: Number(req.type || 0), key });
  }
  if (channel.type !== CHANNEL_TYPE_ADVANCED_CUSTOM) {
    throw new Error("channel type must be advanced custom");
  }
  if (req.base_url != null) channel.base_url = String(req.base_url).trim();
  if (req.advanced_custom != null) {
    const rawConfig = String(req.advanced_custom).trim();
    if (!rawConfig) throw new Error("advanced_custom is required");
    const parsed = goUnmarshalNamed(rawConfig, "dto.AdvancedCustomConfig");
    if (!parsed.ok) throw new Error(parsed.message);
    channel.settings = mergeOtherSettings(channel.settings || "", { advanced_custom: parsed.value });
  } else if (channelId <= 0) {
    throw new Error("advanced_custom is required");
  }
  if (req.header_override != null) {
    const rawHeaderOverride = String(req.header_override).trim();
    if (rawHeaderOverride) {
      const parsed = goUnmarshalObject(rawHeaderOverride);
      if (!parsed.ok) throw new Error(`header_override must be a JSON object: ${parsed.message}`);
    }
    channel.header_override = rawHeaderOverride;
  }
  if (req.proxy != null) {
    channel.setting = mergeSetting(channel.setting || channel.settings || "", { proxy: String(req.proxy).trim() });
  }
  const err = validateChannel(channel, false);
  if (err) throw err;
  return channel;
}

export function previewNonCustomChannel(req: FetchModelsBody, defaultBase: string): ChannelRow {
  let baseURL = String(req.base_url || "").trim();
  if (!baseURL) baseURL = defaultBase;
  let key = String(req.key || "").trim();
  if (Number(req.type || 0) !== CHANNEL_TYPE_CODEX) key = key.split("\n")[0] || "";
  return tempChannel({ type: Number(req.type || 0), key, base_url: baseURL });
}
