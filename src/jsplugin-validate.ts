/**
 * Original QuantumNous `jsplugin.ValidateV1Meta` / `normalizeV1Meta`.
 */
import { CHANNEL_TYPE_TASK_PLUGIN } from "./constants.js";
import { CAPABILITY_SUBMIT_SSE_DELTA, hasCapability } from "./jsplugin-capability.js";
import { asciiFoldModel } from "./plugin-meta.js";
import { MAX_IMAGE_N, MAX_QUOTA, MAX_TASK_DURATION_SECONDS } from "./task-plugin-usage.js";

const API_VERSION_1 = 1;
const PLUGIN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PLUGIN_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const WEBSITE_HOST_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const LOCALE_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const ROUTE_METHOD = /^(GET|POST|PUT|PATCH|DELETE)$/;
const PATH_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATIC_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const MEMBER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_LOCALIZED_TEXT_LOCALES = 16;
const MAX_META_DESCRIPTION_RUNES = 512;
const MAX_USAGE_FIELD_DESCRIPTION_RUNES = 256;
const MAX_USAGE_EXAMPLES = 16;
const MAX_USAGE_EXAMPLE_LABEL_RUNES = 48;
const MAX_META_BASE_URL_LENGTH = 191;
const MIN_INT32 = -2147483648;
const MAX_INT32 = 2147483647;

const HOST_PROTOCOL_MODES: Record<string, string[]> = {
  openai_responses: ["stream", "sync", "background"],
  openai_video: [],
};

const RESERVED_ROUTE_NAMESPACES = [
  "/api",
  "/assets",
  "/setup",
  "/v1/tasks",
  "/console",
  "/login",
  "/forbidden",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/oauth",
  "/otp",
  "/register",
  "/reset",
  "/privacy-policy",
  "/user-agreement",
  "/about",
  "/pricing",
  "/rankings",
  "/user",
  "/401",
  "/403",
  "/404",
  "/500",
  "/503",
  "/chat2link",
  "/system-settings",
  "/channels",
  "/chat",
  "/dashboard",
  "/errors",
  "/keys",
  "/models",
  "/playground",
  "/profile",
  "/redemption-codes",
  "/subscriptions",
  "/system-info",
  "/task-plugins",
  "/usage-logs",
  "/users",
  "/wallet",
];

function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) || 0;
  return (code < 32 && code !== 9) || code === 127;
}

function runeCount(s: string): number {
  return [...s].length;
}

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

function isIPv6(host: string): boolean {
  return host.includes(":");
}

function canonicalLocaleTag(tag: string): string {
  const parts = tag.split("-");
  parts[0] = parts[0].toLowerCase();
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].length === 2) parts[i] = parts[i].toUpperCase();
    else if (parts[i].length === 4) {
      const lowered = parts[i].toLowerCase();
      parts[i] = lowered.slice(0, 1).toUpperCase() + lowered.slice(1);
    } else parts[i] = parts[i].toLowerCase();
  }
  return parts.join("-");
}

function validateLocalizedText(text: Record<string, string> | null | undefined, name: string, maxRunes: number): void {
  if (!text) return;
  const keys = Object.keys(text);
  if (keys.length > MAX_LOCALIZED_TEXT_LOCALES) {
    throw new Error(`plugin meta ${name} must not exceed ${MAX_LOCALIZED_TEXT_LOCALES} locales`);
  }
  const canonical: Record<string, string> = {};
  for (const locale of keys) {
    if (!LOCALE_TAG.test(locale)) throw new Error(`plugin meta ${name} has invalid locale ${JSON.stringify(locale)}`);
    const canonicalLocale = canonicalLocaleTag(locale);
    if (canonical[canonicalLocale] != null) {
      throw new Error(`plugin meta ${name} has duplicate locale ${JSON.stringify(canonicalLocale)}`);
    }
    const trimmed = String(text[locale] || "").trim();
    if (!trimmed) throw new Error(`plugin meta ${name} value for ${JSON.stringify(locale)} must be a non-empty string`);
    for (const character of trimmed) {
      if (isControlChar(character) || (character.charCodeAt(0) < 32 && character !== "\t")) {
        throw new Error(`plugin meta ${name} value for ${JSON.stringify(locale)} must not contain control characters`);
      }
    }
    if (runeCount(trimmed) > maxRunes) {
      throw new Error(`plugin meta ${name} must not exceed ${maxRunes} characters`);
    }
    canonical[canonicalLocale] = trimmed;
  }
  if (!String(canonical.en || "").trim()) {
    throw new Error(`plugin meta ${name} must include a non-empty "en" value`);
  }
}

function readLocalized(raw: unknown, name: string, maxRunes: number): Record<string, string> | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const text = { en: raw };
    validateLocalizedText(text, name, maxRunes);
    return text;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`localized text must be a string or object`);
  const object = raw as Record<string, unknown>;
  const text: Record<string, string> = {};
  for (const [locale, value] of Object.entries(object)) {
    if (typeof value !== "string") throw new Error(`plugin meta ${name} locale ${JSON.stringify(locale)} must be a string`);
    text[locale] = value;
  }
  validateLocalizedText(text, name, maxRunes);
  return text;
}

function quotedJoin(items: string[], sep: string): string {
  return items.map((item) => JSON.stringify(item)).join(sep);
}

function stringSlice(raw: unknown, name: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`plugin meta ${name} must be an array of strings`);
  return raw.map((item, index) => {
    if (typeof item !== "string") throw new Error(`plugin meta ${name} element ${index + 1} must be a string`);
    return item;
  });
}

export function normalizeMetaBaseURL(raw: string): string {
  for (const character of raw) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) throw new Error("plugin meta baseUrl must not contain whitespace or control characters");
  }
  if (/[?#]/.test(raw)) throw new Error("plugin meta baseUrl must not contain a query or fragment");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("plugin meta baseUrl must be an absolute HTTP(S) URL");
  }
  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") throw new Error("plugin meta baseUrl must use the http or https scheme");
  if (parsed.username || parsed.password) throw new Error("plugin meta baseUrl must not contain credentials");
  if (!parsed.hostname) throw new Error("plugin meta baseUrl must be an absolute HTTP(S) URL");
  for (const character of parsed.hostname) {
    if (character.charCodeAt(0) > 127) {
      throw new Error("plugin meta baseUrl host must be ASCII; use punycode for internationalized domains");
    }
  }
  let host = parsed.hostname.toLowerCase();
  if (host.includes(":")) host = `[${host}]`;
  if (parsed.port) host += `:${parsed.port}`;
  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = `${scheme}://${host}${path}`;
  if (normalized.length > MAX_META_BASE_URL_LENGTH) {
    throw new Error(`plugin meta baseUrl must not exceed ${MAX_META_BASE_URL_LENGTH} characters`);
  }
  return normalized;
}

function normalizeAllowedHost(raw: string): string {
  const entry = raw.trim();
  if (!entry || /[/?#@]/.test(entry)) {
    throw new Error("plugin meta allowedHosts must contain hostnames (optionally with a port) without schemes, paths, or credentials");
  }
  let host = entry;
  let port = "";
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (ipv6) {
    host = ipv6[1];
    port = ipv6[2] || "";
  } else if (entry.includes(":") && !isIPv6(entry.split(":").slice(0, -1).join(":") === entry ? "" : entry)) {
    const idx = entry.lastIndexOf(":");
    const maybePort = entry.slice(idx + 1);
    if (/^\d+$/.test(maybePort) && !entry.includes("::") && (entry.match(/:/g) || []).length === 1) {
      host = entry.slice(0, idx);
      port = maybePort;
    }
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) {
    throw new Error("plugin meta allowedHosts must contain hostnames (optionally with a port) without schemes, paths, or credentials");
  }
  for (const character of host) {
    if (character.charCodeAt(0) > 127 || character.charCodeAt(0) <= 32) {
      throw new Error("plugin meta allowedHosts must contain ASCII hostnames; use punycode for internationalized domains");
    }
  }
  host = host.toLowerCase();
  if (host.includes(":")) {
    if (!isIPv6(host)) {
      throw new Error("plugin meta allowedHosts entries must be host or host:port; IPv6 literals must be bracketed");
    }
    host = `[${host}]`;
  }
  if (port) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      throw new Error("plugin meta allowedHosts port must be between 1 and 65535");
    }
    host += `:${port}`;
  }
  return host;
}

function normalizeRoutePath(routePath: string): string {
  if (!routePath || routePath[0] !== "/") throw new Error("plugin route path must start with /");
  if (routePath === "/") throw new Error("plugin route path / is reserved");
  if (/[?#%]/.test(routePath)) {
    throw new Error(`plugin route path ${JSON.stringify(routePath)} must not contain a query, fragment, or percent-encoding`);
  }
  if (routePath.includes("//")) {
    throw new Error(`plugin route path ${JSON.stringify(routePath)} must not contain empty segments`);
  }
  const segments = routePath.slice(1).split("/");
  const seenNames = new Set<string>();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment === "" && index === segments.length - 1) continue;
    if (segment === "." || segment === "..") {
      throw new Error(`plugin route path ${JSON.stringify(routePath)} must not contain dot segments`);
    }
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!PATH_NAME.test(name)) throw new Error(`plugin route path ${JSON.stringify(routePath)} has invalid parameter ${JSON.stringify(segment)}`);
      if (seenNames.has(name)) throw new Error(`plugin route path ${JSON.stringify(routePath)} repeats parameter ${JSON.stringify(name)}`);
      seenNames.add(name);
      continue;
    }
    if (segment.startsWith("*")) {
      const name = segment.slice(1);
      if (index !== segments.length - 1 || !PATH_NAME.test(name)) {
        throw new Error(`plugin route path ${JSON.stringify(routePath)} has an invalid catch-all segment`);
      }
      if (seenNames.has(name)) throw new Error(`plugin route path ${JSON.stringify(routePath)} repeats parameter ${JSON.stringify(name)}`);
      seenNames.add(name);
      continue;
    }
    if (!STATIC_SEGMENT.test(segment)) {
      throw new Error(`plugin route path ${JSON.stringify(routePath)} has invalid segment ${JSON.stringify(segment)}`);
    }
  }
  return routePath;
}

function routePathShape(routePath: string): string {
  const normalized = normalizeRoutePath(routePath);
  const segments = normalized.slice(1).split("/");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith(":")) segments[i] = ":";
    else if (segments[i].startsWith("*")) segments[i] = "*";
  }
  return "/" + segments.join("/");
}

function pathHasParameter(routePath: string, name: string): boolean {
  return routePath.split("/").includes(":" + name);
}

function routePatternIntersectsNamespace(routePath: string, namespace: string): boolean {
  const routeSegments = routePath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const namespaceSegments = namespace.replace(/^\//, "").split("/").filter(Boolean);
  for (let index = 0; index < namespaceSegments.length; index++) {
    if (index >= routeSegments.length) return false;
    const routeSegment = routeSegments[index];
    if (routeSegment.startsWith("*")) return true;
    if (!routeSegment.startsWith(":") && routeSegment !== namespaceSegments[index]) return false;
  }
  return true;
}

function validateModelScope(models: string[], subject: string): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.trim() || model.trim() !== model) {
      throw new Error(`plugin ${subject} models must contain non-empty canonical names`);
    }
    const folded = asciiFoldModel(model);
    if (seen.has(folded)) throw new Error(`plugin ${subject} models must be unique case-insensitively`);
    seen.add(folded);
  }
}

type RouteView = {
  method: string;
  path: string;
  type: string;
  action: string;
  decode: string;
  render: string;
  taskIdParam: string;
  models: string[];
};

function validateRoute(route: RouteView): void {
  if (route.method !== route.method.toUpperCase().trim()) {
    throw new Error(`plugin route method ${JSON.stringify(route.method)} must use canonical uppercase spelling`);
  }
  const method = route.method.toUpperCase().trim();
  if (!ROUTE_METHOD.test(method)) throw new Error(`plugin route method ${JSON.stringify(route.method)} is not supported`);
  route.method = method;
  route.path = normalizeRoutePath(route.path);
  for (const namespace of RESERVED_ROUTE_NAMESPACES) {
    if (routePatternIntersectsNamespace(route.path, namespace)) {
      throw new Error(`plugin route path ${JSON.stringify(route.path)} intersects reserved namespace ${namespace}`);
    }
  }
  switch (route.type) {
    case "submit":
      if (!route.decode || !route.render || route.taskIdParam) {
        throw new Error(`submit route ${route.method} ${route.path} must declare decode and render and must not declare taskIdParam`);
      }
      break;
    case "query":
      if (route.decode || !route.render.trim()) {
        throw new Error(`query route ${route.method} ${route.path} must declare render and must not declare decode`);
      }
      if (route.action) throw new Error(`query route ${route.method} ${route.path} must not declare action`);
      if (!route.taskIdParam) route.taskIdParam = "task_id";
      if (!PATH_NAME.test(route.taskIdParam)) {
        throw new Error(`query route ${route.method} ${route.path} has invalid taskIdParam ${JSON.stringify(route.taskIdParam)}`);
      }
      if (!pathHasParameter(route.path, route.taskIdParam)) {
        throw new Error(`query route ${route.method} ${route.path} must contain :${route.taskIdParam}`);
      }
      break;
    case "dynamic":
      if (!route.decode || !route.render || route.taskIdParam) {
        throw new Error(`dynamic route ${route.method} ${route.path} must declare decode and render and must not declare taskIdParam`);
      }
      break;
    default:
      throw new Error(`plugin route ${route.method} ${route.path} has unsupported type ${JSON.stringify(route.type)}`);
  }
  if (route.decode && !MEMBER_NAME.test(route.decode)) {
    throw new Error(`plugin route ${route.method} ${route.path} has invalid decode ${JSON.stringify(route.decode)}`);
  }
  if (route.render && !MEMBER_NAME.test(route.render)) {
    throw new Error(`plugin route ${route.method} ${route.path} has invalid render ${JSON.stringify(route.render)}`);
  }
  if (route.action.trim() !== route.action) {
    throw new Error(`plugin route ${route.method} ${route.path} action must not have surrounding whitespace`);
  }
  if (route.models.length) {
    if (route.type === "query") throw new Error(`query route ${route.method} ${route.path} must not declare models`);
    validateModelScope(route.models, `route ${route.method} ${route.path}`);
  }
}

type UsageField = {
  type: string;
  unit: string;
  enum?: string[];
  unitLabel?: Record<string, string>;
  description?: Record<string, string>;
  enumLabels?: Record<string, Record<string, string>>;
};

function validateUsageFieldSchema(name: string, field: UsageField): void {
  if (field.unitLabel) {
    if (field.type !== "number" || field.unit !== "count" || field.enum) {
      throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} unitLabel requires a number field with count unit`);
    }
    validateLocalizedText(field.unitLabel, `usageSchema field ${JSON.stringify(name)} unitLabel`, MAX_USAGE_FIELD_DESCRIPTION_RUNES);
  }
  if (field.description) {
    validateLocalizedText(field.description, `usageSchema field ${JSON.stringify(name)} description`, MAX_USAGE_FIELD_DESCRIPTION_RUNES);
  }
  if (field.enumLabels && !field.enum) {
    throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} enumLabels requires enum`);
  }
  if (field.enum) {
    if (field.type || field.unit) {
      throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} cannot combine enum with type or unit`);
    }
    if (!field.enum.length) throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} enum must contain at least one value`);
    const values = new Set<string>();
    for (const value of field.enum) {
      if (values.has(value)) throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} enum values must be unique`);
      values.add(value);
    }
    if (field.enumLabels) {
      for (const [value, label] of Object.entries(field.enumLabels)) {
        if (!values.has(value)) {
          throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} enumLabels has undeclared enum value ${JSON.stringify(value)}`);
        }
        if (!label) {
          throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} enumLabels value ${JSON.stringify(value)} must include a non-empty label`);
        }
        validateLocalizedText(label, `usageSchema field ${JSON.stringify(name)} enumLabels value ${JSON.stringify(value)}`, MAX_USAGE_FIELD_DESCRIPTION_RUNES);
      }
    }
    return;
  }
  if (field.type === "boolean") {
    if (field.unit) throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} cannot combine boolean with unit`);
    return;
  }
  if (field.type !== "number") {
    throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} type must be number or boolean`);
  }
  if (field.unit !== "second" && field.unit !== "count" && field.unit !== "token" && field.unit !== "credit") {
    throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} unit must be second, count, token, or credit`);
  }
}

function decodeUsageSchema(value: unknown): Record<string, UsageField> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plugin meta usageSchema must be an object");
  }
  const object = value as Record<string, unknown>;
  const schema: Record<string, UsageField> = {};
  for (const [name, rawField] of Object.entries(object)) {
    if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) {
      throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} must be an object`);
    }
    const fieldObject = rawField as Record<string, unknown>;
    for (const key of Object.keys(fieldObject)) {
      if (!["type", "unit", "unitLabel", "enum", "description", "enumLabels"].includes(key)) {
        throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} has unknown property ${JSON.stringify(key)}`);
      }
    }
    const field: UsageField = {
      type: typeof fieldObject.type === "string" ? fieldObject.type : fieldObject.type == null ? "" : (() => { throw new Error("plugin meta type must be a string"); })(),
      unit: typeof fieldObject.unit === "string" ? fieldObject.unit : fieldObject.unit == null ? "" : (() => { throw new Error("plugin meta unit must be a string"); })(),
    };
    if (fieldObject.unitLabel != null) field.unitLabel = readLocalized(fieldObject.unitLabel, `usageSchema field ${JSON.stringify(name)} unitLabel`, MAX_USAGE_FIELD_DESCRIPTION_RUNES);
    if (fieldObject.description != null) field.description = readLocalized(fieldObject.description, `usageSchema field ${JSON.stringify(name)} description`, MAX_USAGE_FIELD_DESCRIPTION_RUNES);
    if ("enum" in fieldObject) field.enum = stringSlice(fieldObject.enum, "enum");
    if ("enumLabels" in fieldObject) {
      const rawLabels = fieldObject.enumLabels;
      if (!rawLabels || typeof rawLabels !== "object" || Array.isArray(rawLabels)) {
        throw new Error(`plugin meta usageSchema field ${JSON.stringify(name)} enumLabels must be an object`);
      }
      field.enumLabels = {};
      for (const value of Object.keys(rawLabels as object)) {
        field.enumLabels[value] = readLocalized((rawLabels as Record<string, unknown>)[value], `usageSchema field ${JSON.stringify(name)} enumLabels`, MAX_USAGE_FIELD_DESCRIPTION_RUNES) || {};
      }
    }
    validateUsageFieldSchema(name, field);
    schema[name] = field;
  }
  return schema;
}

function validateUsageExampleValue(value: unknown, field: UsageField): void {
  if (field.enum && field.enum.length) {
    if (typeof value !== "string" || !field.enum.includes(value)) throw new Error("enum is not an allowed value");
    return;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("must be a boolean");
    return;
  }
  const number = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) throw new Error("must be a finite non-negative number");
  let limit = MAX_TASK_DURATION_SECONDS;
  if (field.unit === "count") limit = MAX_IMAGE_N;
  else if (field.unit === "token" || field.unit === "credit") limit = MAX_QUOTA;
  if (number > limit) throw new Error("exceeds the host limit");
}

function validateUsageExamples(schema: Record<string, UsageField>, examples: { label: string; facts: Record<string, unknown> }[]): void {
  if (!examples.length) {
    if (Object.values(schema).some((field) => field.type === "number" && field.unit === "token")) {
      throw new Error("plugin meta usageExamples is required when usageSchema declares a token unit");
    }
    return;
  }
  if (!Object.keys(schema).length) throw new Error("plugin meta usageExamples requires usageSchema");
  if (examples.length > MAX_USAGE_EXAMPLES) {
    throw new Error(`plugin meta usageExamples must not exceed ${MAX_USAGE_EXAMPLES} entries`);
  }
  examples.forEach((example, index) => {
    const label = example.label.trim();
    if (!label) throw new Error(`plugin meta usageExamples[${index}] label is required`);
    if (runeCount(label) > MAX_USAGE_EXAMPLE_LABEL_RUNES) {
      throw new Error(`plugin meta usageExamples[${index}] label must not exceed ${MAX_USAGE_EXAMPLE_LABEL_RUNES} characters`);
    }
    if (!example.facts || typeof example.facts !== "object") {
      throw new Error(`plugin meta usageExamples[${index}] facts must be an object`);
    }
    for (const key of Object.keys(schema)) {
      if (!(key in example.facts)) throw new Error(`plugin meta usageExamples[${index}] facts missing key ${JSON.stringify(key)}`);
    }
    for (const [key, value] of Object.entries(example.facts)) {
      const field = schema[key];
      if (!field) throw new Error(`plugin meta usageExamples[${index}] facts has undeclared key ${JSON.stringify(key)}`);
      try {
        validateUsageExampleValue(value, field);
      } catch (err) {
        throw new Error(`plugin meta usageExamples[${index}] facts field ${JSON.stringify(key)} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

function decodeUsageExamples(value: unknown): { label: string; facts: Record<string, unknown> }[] {
  if (value == null) throw new Error("plugin meta usageExamples must be an array");
  if (!Array.isArray(value)) throw new Error("plugin meta usageExamples must be an array");
  if (value.length > MAX_USAGE_EXAMPLES) {
    throw new Error(`plugin meta usageExamples must not exceed ${MAX_USAGE_EXAMPLES} entries`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`plugin meta usageExamples[${index}] must be an object`);
    }
    const object = item as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (key !== "label" && key !== "facts") throw new Error(`plugin meta usageExamples[${index}] has unknown field ${JSON.stringify(key)}`);
    }
    if (typeof object.label !== "string") throw new Error(`plugin meta usageExamples[${index}] plugin meta label must be a string`);
    if (!object.facts || typeof object.facts !== "object" || Array.isArray(object.facts)) {
      throw new Error(`plugin meta usageExamples[${index}] facts must be an object`);
    }
    return { label: object.label, facts: object.facts as Record<string, unknown> };
  });
}

function hostProtocolKnown(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HOST_PROTOCOL_MODES, name);
}

/** Original `jsplugin.normalizeV1Meta` — mutates meta like CompilePlugin. */
export function normalizeV1Meta(meta: Record<string, unknown>): void {
  const requiredCapabilities = stringSlice(meta.requiredCapabilities, "requiredCapabilities");
  const submitResponseTypes = Array.isArray(meta.submitResponseTypes)
    ? (meta.submitResponseTypes as unknown[]).map(String)
    : ["json"];
  meta.submitResponseTypes = submitResponseTypes;
  const seenCapabilities = new Set<string>();
  for (const name of requiredCapabilities) {
    if (!hasCapability(name) || seenCapabilities.has(name)) {
      throw new Error(`unsupported or duplicate required capability ${JSON.stringify(name)}`);
    }
    if (name === CAPABILITY_SUBMIT_SSE_DELTA && !submitResponseTypes.includes("sse")) {
      throw new Error(`${name} requires submitResponseTypes to include sse`);
    }
    seenCapabilities.add(name);
  }
  const sortPriority = Number(meta.sortPriority || 0);
  if (!Number.isInteger(sortPriority) || sortPriority < MIN_INT32 || sortPriority > MAX_INT32) {
    throw new Error("plugin meta sortPriority must be a signed 32-bit integer");
  }
  const website = String(meta.website || "").trim();
  if (website) {
    let parsed: URL;
    try {
      parsed = new URL(website);
    } catch {
      throw new Error("plugin meta website must be an absolute HTTPS URL without credentials");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("plugin meta website must be an absolute HTTPS URL without credentials");
    }
    for (const character of website) {
      const code = character.charCodeAt(0);
      if (code <= 32 || code === 127 || character === "\\") {
        throw new Error("plugin meta website must not contain whitespace, control characters, or backslashes");
      }
    }
    const host = parsed.hostname.replace(/\.$/, "");
    if (!isIPv4(host) && !isIPv6(host)) {
      if (!host || host.length > 253) throw new Error("plugin meta website must have a valid hostname");
      for (const label of host.split(".")) {
        if (!WEBSITE_HOST_LABEL.test(label)) {
          throw new Error("plugin meta website must have a valid ASCII hostname; use punycode for internationalized domains");
        }
      }
    }
    if (parsed.port) {
      const number = Number(parsed.port);
      if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error("plugin meta website has an invalid port");
    }
  }
  meta.website = website;
  const apiVersion = Number(meta.apiVersion ?? 0);
  if (apiVersion !== API_VERSION_1) throw new Error(`unsupported plugin apiVersion ${apiVersion}`);
  if (!String(meta.name || "").trim()) throw new Error("plugin meta name is required");
  const icon = String(meta.icon || "").trim();
  if (icon.startsWith("data:") || icon.includes("://")) {
    throw new Error("plugin meta icon must be a LobeHub icon name or text; ship an image logo as an icon.svg or icon.png file next to plugin.js instead");
  }
  if (icon) {
    if (runeCount(icon) > 128) throw new Error("plugin meta icon must not exceed 128 characters");
    for (const character of icon) {
      if (isControlChar(character) || character.charCodeAt(0) < 32) {
        throw new Error("plugin meta icon must not contain control characters");
      }
    }
  }
  meta.icon = icon;
  if (meta.description != null) meta.description = readLocalized(meta.description, "description", MAX_META_DESCRIPTION_RUNES);
  const author = meta.author && typeof meta.author === "object" && !Array.isArray(meta.author) ? (meta.author as Record<string, unknown>) : {};
  if (!String(author.name || "").trim()) throw new Error("plugin meta author name is required");
  author.name = String(author.name || "").trim();
  const authorURL = String(author.url || "").trim();
  if (authorURL) {
    let parsedURL: URL;
    try {
      parsedURL = new URL(authorURL);
    } catch {
      throw new Error("plugin meta author url must be an absolute HTTP(S) URL");
    }
    if (!parsedURL.host || (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:")) {
      throw new Error("plugin meta author url must be an absolute HTTP(S) URL");
    }
  }
  if (authorURL) author.url = authorURL;
  else delete author.url;
  meta.author = author;
  const baseURL = String(meta.baseUrl || "").trim();
  if (baseURL) meta.baseUrl = normalizeMetaBaseURL(baseURL);
  else delete meta.baseUrl;
  const key = String(meta.key || "");
  if (key.length > 30) throw new Error("plugin meta key must not exceed 30 characters");
  if (!PLUGIN_KEY_PATTERN.test(key)) throw new Error(`plugin meta key must match ${PLUGIN_KEY_PATTERN.source}`);
  if (!PLUGIN_VERSION_PATTERN.test(String(meta.version || ""))) throw new Error("plugin meta version must be semver");
  const fetchMode = String(meta.fetchMode || "");
  if (fetchMode !== "per_task" && fetchMode !== "batch") {
    throw new Error("plugin meta fetchMode must be per_task or batch");
  }
  const models = stringSlice(meta.models, "models");
  if (!models.length) throw new Error("plugin meta models must contain at least one model");
  meta.models = models;
  const channelTypes = Array.isArray(meta.channelTypes) ? (meta.channelTypes as unknown[]).map((item) => Number(item)) : [];
  const seenChannelTypes = new Set<number>();
  for (const channelType of channelTypes) {
    if (channelType <= 0) throw new Error("plugin meta channelTypes must contain positive channel types");
    if (channelType === CHANNEL_TYPE_TASK_PLUGIN) {
      throw new Error("plugin meta channelTypes must not contain the task plugin channel type");
    }
    if (seenChannelTypes.has(channelType)) throw new Error("plugin meta channelTypes must be unique");
    seenChannelTypes.add(channelType);
  }
  const modelSet = new Set<string>();
  const seenFold = new Set<string>();
  for (const model of models) {
    if (!model.trim() || model.trim() !== model) throw new Error("plugin meta models must contain non-empty canonical names");
    const folded = asciiFoldModel(model);
    if (seenFold.has(folded)) throw new Error("plugin meta models must be unique case-insensitively");
    seenFold.add(folded);
    modelSet.add(model);
  }
  const hosts = new Set<string>();
  const allowedHosts = Array.isArray(meta.allowedHosts) ? (meta.allowedHosts as unknown[]).map(String) : [];
  const normalizedHosts: string[] = [];
  for (const host of allowedHosts) {
    const normalized = normalizeAllowedHost(host);
    if (hosts.has(normalized)) throw new Error("plugin meta allowedHosts must be unique");
    hosts.add(normalized);
    normalizedHosts.push(normalized);
  }
  meta.allowedHosts = normalizedHosts;
  const routes = Array.isArray(meta.routes) ? (meta.routes as unknown[]) : [];
  meta.routes = routes;
  const routeKeys = new Set<string>();
  routes.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`plugin meta route ${index} must be an object`);
    const object = item as Record<string, unknown>;
    if ("renderer" in object) throw new Error(`plugin meta route ${index} field renderer is no longer supported`);
    for (const field of Object.keys(object)) {
      if (!["method", "path", "type", "action", "decode", "render", "taskIdParam", "models"].includes(field)) {
        throw new Error(`plugin meta route ${index} has unknown field ${JSON.stringify(field)}`);
      }
    }
    const route: RouteView = {
      method: String(object.method || ""),
      path: String(object.path || ""),
      type: String(object.type || ""),
      action: String(object.action || ""),
      decode: String(object.decode || ""),
      render: String(object.render || ""),
      taskIdParam: String(object.taskIdParam || ""),
      models: Array.isArray(object.models) ? (object.models as unknown[]).map(String) : [],
    };
    validateRoute(route);
    for (const model of route.models) {
      if (!modelSet.has(model)) {
        throw new Error(`plugin route ${route.method} ${route.path} model ${JSON.stringify(model)} is not declared in plugin meta models`);
      }
    }
    const shape = routePathShape(route.path);
    const keyName = `${route.method} ${shape}`;
    if (routeKeys.has(keyName)) {
      throw new Error(`plugin meta routes contain duplicate route ${route.method} ${route.path}`);
    }
    routeKeys.add(keyName);
  });
  const protocols = Array.isArray(meta.protocols) ? (meta.protocols as unknown[]) : [];
  const protocolNames = new Set<string>();
  protocols.forEach((item, index) => {
    let name = "";
    let supports: string[] | undefined;
    let objectForm = false;
    let claimModels: string[] = [];
    if (typeof item === "string") {
      name = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      objectForm = true;
      const entry = item as Record<string, unknown>;
      for (const field of Object.keys(entry)) {
        if (field !== "name" && field !== "models" && field !== "supports") {
          throw new Error(`plugin meta protocol ${index} has unknown field ${JSON.stringify(field)}`);
        }
      }
      name = String(entry.name || "");
      if ("supports" in entry) supports = Array.isArray(entry.supports) ? entry.supports.map(String) : [];
      if (Array.isArray(entry.models)) claimModels = entry.models.map(String);
    } else {
      throw new Error(`plugin meta protocol ${index} must be a string or an object`);
    }
    const known = hostProtocolKnown(name);
    const modes = HOST_PROTOCOL_MODES[name] || [];
    if (modes.length) {
      const choosingFrom = quotedJoin(modes, ", ");
      if (supports == null) {
        if (objectForm) {
          throw new Error(`plugin ${key} protocol ${JSON.stringify(name)} must declare supports; add supports: [...] choosing from ${choosingFrom}`);
        }
        throw new Error(
          `plugin ${key} protocol ${JSON.stringify(name)} must declare supports; replace the bare string with {name: ${JSON.stringify(name)}, supports: [...]} choosing from ${choosingFrom}`,
        );
      }
      if (!supports.length) {
        throw new Error(`plugin ${key} protocol ${JSON.stringify(name)} supports must contain at least one of ${choosingFrom}`);
      }
      const seenSupports = new Set<string>();
      for (const support of supports) {
        if (seenSupports.has(support)) {
          throw new Error(`plugin ${key} protocol ${JSON.stringify(name)} supports must be unique`);
        }
        seenSupports.add(support);
        if (!modes.includes(support)) {
          if (support === "retrieve") {
            throw new Error(
              `plugin ${key} protocol ${JSON.stringify(name)} has no mode ${JSON.stringify(support)}; retrieval of a created response is always available and is never declared`,
            );
          }
          throw new Error(`plugin ${key} protocol ${JSON.stringify(name)} has no mode ${JSON.stringify(support)}`);
        }
      }
    } else if (supports != null) {
      throw new Error(`plugin ${key} protocol ${JSON.stringify(name)} does not define modes; supports is not allowed`);
    }
    if (!known) throw new Error(`plugin meta protocol ${JSON.stringify(name)} is unknown`);
    if (protocolNames.has(name)) throw new Error("plugin meta protocols must be unique");
    protocolNames.add(name);
    if (claimModels.length) validateModelScope(claimModels, `protocol ${JSON.stringify(name)}`);
    for (const model of claimModels) {
      if (!modelSet.has(model)) {
        throw new Error(`plugin protocol ${JSON.stringify(name)} model ${JSON.stringify(model)} is not declared in plugin meta models`);
      }
    }
  });
  meta.protocols = protocols;
  const usageSchema = meta.usageSchema != null ? decodeUsageSchema(meta.usageSchema) : {};
  if (meta.usageSchema != null) {
    for (const name of Object.keys(usageSchema)) {
      if (!name.trim() || name.trim() !== name) throw new Error("plugin meta usageSchema keys must be non-empty canonical names");
    }
    meta.usageSchema = usageSchema;
  }
  const usageExamples = meta.usageExamples != null ? decodeUsageExamples(meta.usageExamples) : [];
  validateUsageExamples(meta.usageSchema != null ? usageSchema : {}, usageExamples);
  const profiles = Array.isArray(meta.usageProfiles) ? (meta.usageProfiles as unknown[]) : [];
  const profileModels = new Set<string>();
  profiles.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`plugin meta usageProfiles[${index}] must be an object`);
    }
    const object = item as Record<string, unknown>;
    for (const field of Object.keys(object)) {
      if (field !== "models" && field !== "schema" && field !== "examples") {
        throw new Error(`plugin meta usageProfiles[${index}] has unknown field ${JSON.stringify(field)}`);
      }
    }
    const profileModelList = stringSlice(object.models, "models");
    if (!profileModelList.length) throw new Error(`plugin meta usageProfiles[${index}] models must contain at least one model`);
    validateModelScope(profileModelList, `usageProfiles[${index}]`);
    for (const model of profileModelList) {
      if (!modelSet.has(model)) {
        throw new Error(`plugin meta usageProfiles[${index}] model ${JSON.stringify(model)} is not declared in plugin meta models`);
      }
      if (profileModels.has(model)) throw new Error(`plugin meta usageProfiles model ${JSON.stringify(model)} belongs to multiple profiles`);
      profileModels.add(model);
    }
    if (object.schema == null || typeof object.schema !== "object" || Array.isArray(object.schema)) {
      throw new Error(`plugin meta usageProfiles[${index}] schema must be an object`);
    }
    let schema: Record<string, UsageField>;
    try {
      schema = decodeUsageSchema(object.schema);
    } catch (err) {
      throw new Error(`plugin meta usageProfiles[${index}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    const examples = object.examples != null ? decodeUsageExamples(object.examples) : [];
    try {
      validateUsageExamples(schema, examples);
    } catch (err) {
      throw new Error(`plugin meta usageProfiles[${index}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    object.schema = schema;
    if (object.examples != null) object.examples = examples;
  });
  if (meta.usageExamples != null) meta.usageExamples = usageExamples;
  let authType = "";
  const auth = meta.auth;
  if (typeof auth === "string") authType = auth;
  else if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const object = auth as Record<string, unknown>;
    for (const field of Object.keys(object)) {
      if (field !== "type") throw new Error(`plugin meta auth has unknown field ${JSON.stringify(field)}`);
    }
    authType = typeof object.type === "string" ? object.type : "";
  } else if (auth != null) {
    throw new Error("plugin meta auth must be a string or object");
  }
  authType = authType.trim();
  if (authType === "vertex_oauth") authType = "oauth2_jwt";
  if (authType && authType !== "none" && authType !== "api_key" && authType !== "oauth2_jwt") {
    throw new Error(`unsupported plugin auth type ${JSON.stringify(authType)}`);
  }
  meta.auth = { type: authType };
}

/** Original `jsplugin.ValidateV1Meta` — clone then normalizeV1Meta. */
export function validateV1Meta(meta: Record<string, unknown>): void {
  normalizeV1Meta(structuredClone(meta));
}

export function routePathShapeForPreflight(routePath: string): string {
  return routePathShape(routePath);
}
