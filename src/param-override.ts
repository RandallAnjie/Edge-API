/** Original `relay/common.ApplyParamOverride` + header override context. */

import { mergeChannelOverride } from "./channel-affinity.js";
import type { ChannelRow } from "./types.js";

export const PARAM_OVERRIDE_REQUEST_HEADERS = "request_headers";
export const PARAM_OVERRIDE_HEADER_OVERRIDE = "header_override";

const NEGATIVE_INDEX = /\.(-\d+)/g;

export class ParamOverrideReturnError extends Error {
  statusCode: number;
  code: string;
  type: string;
  skipRetry: boolean;
  constructor(message: string, statusCode = 400, code = "invalid_request", type = "invalid_request_error", skipRetry = true) {
    super(message || "param override return error");
    this.name = "ParamOverrideReturnError";
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.skipRetry = skipRetry;
  }
}

export function asParamOverrideReturnError(err: unknown): ParamOverrideReturnError | null {
  return err instanceof ParamOverrideReturnError ? err : null;
}

type ConditionOperation = {
  path: string;
  mode: string;
  value?: unknown;
  invert?: boolean;
  pass_missing_key?: boolean;
};

type ParamOperation = {
  path: string;
  mode: string;
  value?: unknown;
  keep_origin?: boolean;
  from?: string;
  to?: string;
  conditions?: ConditionOperation[];
  logic?: string;
};

type SyncTarget = { kind: "json" | "header"; key: string };

export type ParamOverrideContext = Record<string, unknown>;

export type ParamOverrideRelayInfo = {
  requestHeaders?: Record<string, string>;
  userId?: number;
  userGroup?: string;
  tokenGroup?: string;
  usingGroup?: string;
  originalModel?: string;
  upstreamModel?: string;
  requestPath?: string;
  isChannelTest?: boolean;
  retryIndex?: number;
  affinityTemplate?: Record<string, unknown>;
  /** Original `relaycommon.RelayInfo.IsStream`. */
  isStream?: boolean;
  /** Original `relaycommon.RelayInfo.RelayFormat` (NewAPI/Sub2API SetupRequestHeader). */
  relayFormat?: "openai" | "claude" | "gemini";
};

type JsonType = 0 | 1 | 2 | 3 | 4 | 5;

const T_NULL = 0;
const T_FALSE = 1;
const T_NUMBER = 2;
const T_STRING = 3;
const T_TRUE = 4;
const T_JSON = 5;

type PathHit = { exists: boolean; type: JsonType; value: unknown };

function cloneJson<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function goSprint(value: unknown): string {
  if (value == null) return "<nil>";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function uniq<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function jsonType(value: unknown): JsonType {
  if (value === null || value === undefined) return T_NULL;
  if (value === false) return T_FALSE;
  if (value === true) return T_TRUE;
  if (typeof value === "number" && Number.isFinite(value)) return T_NUMBER;
  if (typeof value === "string") return T_STRING;
  return T_JSON;
}

function splitPath(path: string): string[] {
  const segs: string[] = [];
  let buf = "";
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === "\\" && i + 1 < path.length) {
      buf += path[++i];
      continue;
    }
    if (ch === ".") {
      segs.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segs.push(buf);
  return segs;
}

function getAt(root: unknown, path: string): PathHit {
  if (!path) return { exists: true, type: jsonType(root), value: root };
  let cur: unknown = root;
  for (const seg of splitPath(path)) {
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { exists: false, type: T_NULL, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== "object") return { exists: false, type: T_NULL, value: undefined };
    const obj = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) return { exists: false, type: T_NULL, value: undefined };
    cur = obj[seg];
  }
  return { exists: true, type: jsonType(cur), value: cur };
}

function isIndexSeg(seg: string): boolean {
  return /^\d+$/.test(seg);
}

function setAt(root: unknown, path: string, value: unknown): unknown {
  if (!path) return value;
  const segs = splitPath(path);
  let working: unknown = root;
  if (working == null || typeof working !== "object") working = isIndexSeg(segs[0]) ? [] : {};
  const top = working;
  let cur: unknown = working;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const nextIndex = !last && isIndexSeg(segs[i + 1]);
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return top;
      while (cur.length <= idx) cur.push(null);
      if (last) {
        cur[idx] = value;
        return top;
      }
      if (cur[idx] == null || typeof cur[idx] !== "object") cur[idx] = nextIndex ? [] : {};
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== "object") return top;
    const obj = cur as Record<string, unknown>;
    if (last) {
      obj[seg] = value;
      return top;
    }
    if (obj[seg] == null || typeof obj[seg] !== "object") obj[seg] = nextIndex ? [] : {};
    cur = obj[seg];
  }
  return top;
}

function deleteAt(root: unknown, path: string): unknown {
  if (!path) return root;
  const segs = splitPath(path);
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return root;
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== "object") return root;
    cur = (cur as Record<string, unknown>)[seg];
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) cur.splice(idx, 1);
    return root;
  }
  if (cur && typeof cur === "object") delete (cur as Record<string, unknown>)[last];
  return root;
}

function collectWildcardPaths(node: unknown, segments: string[], prefix: string[]): string[] {
  if (!segments.length) return [prefix.join(".")];
  const segment = segments[0].trim();
  if (!segment) return [];
  const rest = segments.slice(1);
  const isLast = segments.length === 1;
  if (segment === "*") {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const keys = Object.keys(node as object).sort();
      return keys.flatMap((key) => collectWildcardPaths((node as Record<string, unknown>)[key], rest, [...prefix, key]));
    }
    if (Array.isArray(node)) {
      return node.flatMap((item, index) => collectWildcardPaths(item, rest, [...prefix, String(index)]));
    }
    return [];
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    if (isLast) return [[...prefix, segment].join(".")];
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return [];
    return collectWildcardPaths((node as Record<string, unknown>)[segment], rest, [...prefix, segment]);
  }
  if (Array.isArray(node)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) return [];
    if (isLast) return [[...prefix, segment].join(".")];
    return collectWildcardPaths(node[index], rest, [...prefix, segment]);
  }
  return [];
}

function resolveOperationPaths(data: unknown, path: string): string[] {
  if (!path.includes("*")) return [path];
  return uniq(collectWildcardPaths(data, splitPath(path), []));
}

function processNegativeIndex(data: unknown, path: string): string {
  const matches = [...path.matchAll(NEGATIVE_INDEX)];
  if (!matches.length) return path;
  let result = path;
  for (const match of matches) {
    const negIndex = match[1];
    const index = Number(negIndex);
    let arrayPath = path.split(negIndex)[0];
    if (arrayPath.endsWith(".")) arrayPath = arrayPath.slice(0, -1);
    const hit = getAt(data, arrayPath);
    if (Array.isArray(hit.value)) {
      const actual = hit.value.length + index;
      if (actual >= 0 && actual < hit.value.length) {
        result = result.replace(match[0], "." + String(actual));
      }
    }
  }
  return result;
}

function compareEqual(left: PathHit, right: PathHit): { ok: boolean; error?: string } {
  if (left.type === T_NULL || right.type === T_NULL) {
    return { ok: left.type === T_NULL && right.type === T_NULL };
  }
  if ((left.type === T_TRUE || left.type === T_FALSE) && (right.type === T_TRUE || right.type === T_FALSE)) {
    return { ok: left.value === right.value };
  }
  if (left.type !== right.type) {
    return { ok: false, error: `compare for different types, got ${left.type} and ${right.type}` };
  }
  if (left.type === T_NUMBER) return { ok: left.value === right.value };
  if (left.type === T_STRING) return { ok: left.value === right.value };
  return { ok: JSON.stringify(left.value) === JSON.stringify(right.value) };
}

function compareNumeric(left: PathHit, right: PathHit, operator: string): { ok: boolean; error?: string } {
  if (left.type !== T_NUMBER || right.type !== T_NUMBER) {
    return { ok: false, error: `numeric comparison requires both values to be numbers, got ${left.type} and ${right.type}` };
  }
  const a = Number(left.value);
  const b = Number(right.value);
  if (operator === "gt") return { ok: a > b };
  if (operator === "gte") return { ok: a >= b };
  if (operator === "lt") return { ok: a < b };
  if (operator === "lte") return { ok: a <= b };
  return { ok: false, error: `unsupported numeric operator: ${operator}` };
}

function compareValues(left: PathHit, right: PathHit, mode: string): { ok: boolean; error?: string } {
  switch (mode) {
    case "full":
      return compareEqual(left, right);
    case "prefix":
      return { ok: String(left.value ?? "").startsWith(String(right.value ?? "")) };
    case "suffix":
      return { ok: String(left.value ?? "").endsWith(String(right.value ?? "")) };
    case "contains":
      return { ok: String(left.value ?? "").includes(String(right.value ?? "")) };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareNumeric(left, right, mode);
    default:
      return { ok: false, error: `unsupported comparison mode: ${mode}` };
  }
}

function parseConditionOperations(raw: unknown): ConditionOperation[] {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const conditions: ConditionOperation[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const path = key.trim();
      if (!path) continue;
      conditions.push({ path, mode: "full", value });
    }
    if (!conditions.length) throw new Error("conditions object must contain at least one key");
    return conditions;
  }
  if (!Array.isArray(raw)) throw new Error("conditions must be an array or object");
  const result: ConditionOperation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("condition must be object");
    const itemMap = item as Record<string, unknown>;
    const path = typeof itemMap.path === "string" ? itemMap.path : "";
    const mode = typeof itemMap.mode === "string" ? itemMap.mode : "";
    if (!path.trim() || !mode.trim()) throw new Error("condition path/mode is required");
    result.push({
      path,
      mode,
      value: itemMap.value,
      invert: Boolean(itemMap.invert),
      pass_missing_key: Boolean(itemMap.pass_missing_key),
    });
  }
  return result;
}

function checkSingleCondition(data: unknown, context: unknown, condition: ConditionOperation): boolean {
  const path = processNegativeIndex(data, condition.path);
  let hit = getAt(data, path);
  if (!hit.exists && context != null) hit = getAt(context, condition.path);
  if (!hit.exists) return Boolean(condition.pass_missing_key);
  const target: PathHit = { exists: true, type: jsonType(condition.value), value: condition.value };
  const compared = compareValues(hit, target, (condition.mode || "full").toLowerCase());
  if (compared.error) throw new Error(`comparison failed for path ${condition.path}: ${compared.error}`);
  return condition.invert ? !compared.ok : compared.ok;
}

function checkConditions(data: unknown, context: unknown, conditions: ConditionOperation[] | undefined, logic: string): boolean {
  if (!conditions?.length) return true;
  const results = conditions.map((condition) => checkSingleCondition(data, context, condition));
  if (logic.toUpperCase() === "AND") return results.every(Boolean);
  return results.some(Boolean);
}

function tryParseOperations(paramOverride: Record<string, unknown>): ParamOperation[] | null {
  if (!Object.prototype.hasOwnProperty.call(paramOverride, "operations")) return null;
  const opsValue = paramOverride.operations;
  if (!Array.isArray(opsValue)) return null;
  const operations: ParamOperation[] = [];
  for (const op of opsValue) {
    if (!op || typeof op !== "object" || Array.isArray(op)) return null;
    const opMap = op as Record<string, unknown>;
    if (typeof opMap.mode !== "string") return null;
    let conditions: ConditionOperation[] | undefined;
    if (Object.prototype.hasOwnProperty.call(opMap, "conditions")) {
      try {
        conditions = parseConditionOperations(opMap.conditions);
      } catch {
        return null;
      }
    }
    operations.push({
      path: typeof opMap.path === "string" ? opMap.path : "",
      mode: opMap.mode,
      value: opMap.value,
      keep_origin: Boolean(opMap.keep_origin),
      from: typeof opMap.from === "string" ? opMap.from : "",
      to: typeof opMap.to === "string" ? opMap.to : "",
      conditions,
      logic: typeof opMap.logic === "string" ? opMap.logic : "OR",
    });
  }
  return operations;
}

function isPathBasedOperation(mode: string): boolean {
  switch (mode) {
    case "delete":
    case "set":
    case "prepend":
    case "append":
    case "trim_prefix":
    case "trim_suffix":
    case "ensure_prefix":
    case "ensure_suffix":
    case "trim_space":
    case "to_lower":
    case "to_upper":
    case "replace":
    case "regex_replace":
    case "prune_objects":
      return true;
    default:
      return false;
  }
}

function requireString(hit: PathHit): string {
  if (hit.type !== T_STRING) throw new Error(`operation not supported for type: ${hit.type}`);
  return String(hit.value);
}

function modifyValue(data: unknown, path: string, value: unknown, keepOrigin: boolean, isPrepend: boolean): unknown {
  const current = getAt(data, path);
  if (Array.isArray(current.value)) {
    const add = Array.isArray(value) ? value : [value];
    const next = isPrepend ? [...add, ...current.value] : [...current.value, ...add];
    return setAt(data, path, next);
  }
  if (current.type === T_STRING) {
    const valueStr = goSprint(value);
    return setAt(data, path, isPrepend ? valueStr + current.value : String(current.value) + valueStr);
  }
  if (current.type === T_JSON && current.value && typeof current.value === "object" && !Array.isArray(current.value)) {
    return mergeObjects(data, path, value, keepOrigin);
  }
  throw new Error(`operation not supported for type: ${current.type}`);
}

function mergeObjects(data: unknown, path: string, value: unknown, keepOrigin: boolean): unknown {
  const current = getAt(data, path);
  const currentMap = cloneJson((current.value && typeof current.value === "object" && !Array.isArray(current.value) ? current.value : {}) as Record<string, unknown>);
  let newMap: Record<string, unknown>;
  if (value && typeof value === "object" && !Array.isArray(value)) newMap = value as Record<string, unknown>;
  else throw new Error("merge value must be object");
  const result = { ...currentMap };
  for (const [k, v] of Object.entries(newMap)) {
    if (!keepOrigin || result[k] == null) result[k] = v;
  }
  return setAt(data, path, result);
}

function trimStringValue(data: unknown, path: string, value: unknown, isPrefix: boolean): unknown {
  const current = requireString(getAt(data, path));
  if (value == null) throw new Error("trim value is required");
  const valueStr = goSprint(value);
  if (isPrefix) return setAt(data, path, current.startsWith(valueStr) ? current.slice(valueStr.length) : current);
  return setAt(data, path, current.endsWith(valueStr) ? current.slice(0, current.length - valueStr.length) : current);
}

function ensureStringAffix(data: unknown, path: string, value: unknown, isPrefix: boolean): unknown {
  const current = requireString(getAt(data, path));
  if (value == null) throw new Error("ensure value is required");
  const valueStr = goSprint(value);
  if (!valueStr) throw new Error("ensure value is required");
  if (isPrefix) return current.startsWith(valueStr) ? data : setAt(data, path, valueStr + current);
  return current.endsWith(valueStr) ? data : setAt(data, path, current + valueStr);
}

function transformStringValue(data: unknown, path: string, transform: (s: string) => string): unknown {
  return setAt(data, path, transform(requireString(getAt(data, path))));
}

function replaceStringValue(data: unknown, path: string, from: string, to: string): unknown {
  const current = requireString(getAt(data, path));
  if (!from) throw new Error("replace from is required");
  return setAt(data, path, current.split(from).join(to));
}

function regexReplaceStringValue(data: unknown, path: string, pattern: string, replacement: string): unknown {
  requireString(getAt(data, path));
  if (!pattern) throw new Error("regex pattern is required");
  const re = new RegExp(pattern, "g");
  return setAt(data, path, requireString(getAt(data, path)).replace(re, replacement));
}

function parsePruneObjectsOptions(value: unknown): { conditions: ConditionOperation[]; logic: string; recursive: boolean } {
  const opts = { conditions: [] as ConditionOperation[], logic: "AND", recursive: true };
  if (value == null) throw new Error("prune_objects value is required");
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) throw new Error("prune_objects value is required");
    opts.conditions = [{ path: "type", mode: "full", value: v }];
    return opts;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("prune_objects value must be string or object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.logic === "string" && raw.logic.trim()) opts.logic = raw.logic;
  if (typeof raw.recursive === "boolean") opts.recursive = raw.recursive;
  if (Object.prototype.hasOwnProperty.call(raw, "conditions")) {
    opts.conditions.push(...parseConditionOperations(raw.conditions));
  }
  if (Object.prototype.hasOwnProperty.call(raw, "where")) {
    if (!raw.where || typeof raw.where !== "object" || Array.isArray(raw.where)) throw new Error("prune_objects where must be object");
    for (const [key, val] of Object.entries(raw.where as Record<string, unknown>)) {
      const path = key.trim();
      if (path) opts.conditions.push({ path, mode: "full", value: val });
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, "type")) {
    opts.conditions.push({ path: "type", mode: "full", value: raw.type });
  }
  if (!opts.conditions.length) throw new Error("prune_objects conditions are required");
  return opts;
}

function pruneObjectsNode(
  node: unknown,
  options: { conditions: ConditionOperation[]; logic: string; recursive: boolean },
  context: unknown,
  isRoot: boolean,
): { node: unknown; drop: boolean } {
  if (Array.isArray(node)) {
    const result: unknown[] = [];
    for (const item of node) {
      const next = pruneObjectsNode(item, options, context, false);
      if (!next.drop) result.push(next.node);
    }
    return { node: result, drop: false };
  }
  if (node && typeof node === "object") {
    const shouldDrop = checkConditions(node, context, options.conditions, options.logic);
    if (shouldDrop && !isRoot) return { node: null, drop: true };
    if (!options.recursive) return { node, drop: false };
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const next = pruneObjectsNode(obj[key], options, context, false);
      if (next.drop) delete obj[key];
      else obj[key] = next.node;
    }
    return { node: obj, drop: false };
  }
  return { node, drop: false };
}

function pruneObjects(data: unknown, path: string, context: unknown, value: unknown): unknown {
  const options = parsePruneObjectsOptions(value);
  if (!path) {
    return pruneObjectsNode(cloneJson(data), options, context, true).node;
  }
  const target = getAt(data, path);
  if (!target.exists) return data;
  const cleaned = pruneObjectsNode(cloneJson(target.value), options, context, true).node;
  return setAt(data, path, cleaned);
}

function parseOverrideInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "number" && v === Math.trunc(v)) return v;
  return null;
}

function parseParamOverrideReturnError(value: unknown): ParamOverrideReturnError {
  let message = "";
  let statusCode = 400;
  let code = "invalid_request";
  let type = "invalid_request_error";
  let skipRetry = true;
  if (value == null) throw new Error("return_error value is required");
  if (typeof value === "string") {
    message = value.trim();
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (!message && typeof raw.msg === "string") message = raw.msg.trim();
    if (Object.prototype.hasOwnProperty.call(raw, "code")) {
      const codeStr = goSprint(raw.code).trim();
      if (codeStr) code = codeStr;
    }
    if (typeof raw.type === "string" && raw.type.trim()) type = raw.type.trim();
    if (typeof raw.skip_retry === "boolean") skipRetry = raw.skip_retry;
    if (Object.prototype.hasOwnProperty.call(raw, "status_code")) {
      const n = parseOverrideInt(raw.status_code);
      if (n == null) throw new Error("return_error status_code must be an integer");
      statusCode = n;
    } else if (Object.prototype.hasOwnProperty.call(raw, "status")) {
      const n = parseOverrideInt(raw.status);
      if (n == null) throw new Error("return_error status must be an integer");
      statusCode = n;
    }
  } else {
    throw new Error("return_error value must be string or object");
  }
  if (!message) throw new Error("return_error message is required");
  if (statusCode < 100 || statusCode > 599) throw new Error(`return_error status code out of range: ${statusCode}`);
  return new ParamOverrideReturnError(message, statusCode, code, type, skipRetry);
}

function normalizeHeaderContextKey(key: string): string {
  return key.trim().toLowerCase();
}

function ensureMapKey(context: ParamOverrideContext, key: string): Record<string, unknown> {
  const existing = context[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  context[key] = next;
  return next;
}

function splitHeaderListValue(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseHeaderReplacementTokens(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return splitHeaderListValue(value);
  if (Array.isArray(value)) {
    const tokens: string[] = [];
    for (const item of value) tokens.push(...parseHeaderReplacementTokens(item));
    return uniq(tokens);
  }
  if (typeof value === "object") throw new Error("header replacement value must be string, array or null");
  const token = goSprint(value).trim();
  return token ? [token] : [];
}

function parseHeaderAppendTokens(mapping: Record<string, unknown>): string[] {
  if (!Object.prototype.hasOwnProperty.call(mapping, "$append")) return [];
  return parseHeaderReplacementTokens(mapping.$append);
}

function parseHeaderKeepOnlyDeclared(mapping: Record<string, unknown>): boolean {
  return mapping.$keep_only_declared === true;
}

function getHeaderValueFromContext(context: ParamOverrideContext, headerName: string): { ok: boolean; value: string } {
  const name = normalizeHeaderContextKey(headerName);
  if (!name) return { ok: false, value: "" };
  for (const key of [PARAM_OVERRIDE_HEADER_OVERRIDE, PARAM_OVERRIDE_REQUEST_HEADERS]) {
    const source = ensureMapKey(context, key);
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const value = goSprint(source[name]).trim();
    if (value) return { ok: true, value };
  }
  return { ok: false, value: "" };
}

function resolveHeaderOverrideValueByMapping(context: ParamOverrideContext, headerName: string, mapping: Record<string, unknown>): { hasValue: boolean; value: string } {
  if (!Object.keys(mapping).length) throw new Error("header value mapping cannot be empty");
  const appendTokens = parseHeaderAppendTokens(mapping);
  const keepOnlyDeclared = parseHeaderKeepOnlyDeclared(mapping);
  const source = getHeaderValueFromContext(context, headerName);
  const sourceTokens = source.ok ? splitHeaderListValue(source.value) : [];
  const hasWildcard = Object.prototype.hasOwnProperty.call(mapping, "*");
  const resultTokens: string[] = [];
  for (const token of sourceTokens) {
    let replacementRaw = mapping[token];
    let hasReplacement = Object.prototype.hasOwnProperty.call(mapping, token);
    if (!hasReplacement && hasWildcard && !keepOnlyDeclared) {
      replacementRaw = mapping["*"];
      hasReplacement = true;
    }
    if (!hasReplacement) {
      if (!keepOnlyDeclared) resultTokens.push(token);
      continue;
    }
    resultTokens.push(...parseHeaderReplacementTokens(replacementRaw));
  }
  resultTokens.push(...appendTokens);
  const unique = uniq(resultTokens);
  if (!unique.length) return { hasValue: false, value: "" };
  return { hasValue: true, value: unique.join(",") };
}

function resolveHeaderOverrideValue(context: ParamOverrideContext, headerName: string, value: unknown): { hasValue: boolean; value: string } {
  if (value == null) throw new Error("header value is required");
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return resolveHeaderOverrideValueByMapping(context, headerName, value as Record<string, unknown>);
  }
  const headerValue = goSprint(value).trim();
  if (!headerValue) return { hasValue: false, value: "" };
  return { hasValue: true, value: headerValue };
}

function setHeaderOverrideInContext(context: ParamOverrideContext, headerName: string, value: unknown, keepOrigin: boolean): void {
  const name = normalizeHeaderContextKey(headerName);
  if (!name) throw new Error("header name is required");
  const rawHeaders = ensureMapKey(context, PARAM_OVERRIDE_HEADER_OVERRIDE);
  if (keepOrigin) {
    const existing = goSprint(rawHeaders[name] ?? "").trim();
    if (existing) return;
  }
  const resolved = resolveHeaderOverrideValue(context, name, value);
  if (!resolved.hasValue) {
    delete rawHeaders[name];
    return;
  }
  rawHeaders[name] = resolved.value;
}

function deleteHeaderOverrideInContext(context: ParamOverrideContext, headerName: string): void {
  const name = normalizeHeaderContextKey(headerName);
  if (!name) throw new Error("header name is required");
  delete ensureMapKey(context, PARAM_OVERRIDE_HEADER_OVERRIDE)[name];
}

const SOURCE_HEADER_NOT_FOUND = "source header does not exist";

function copyHeaderInContext(context: ParamOverrideContext, fromHeader: string, toHeader: string, keepOrigin: boolean): void {
  const from = normalizeHeaderContextKey(fromHeader);
  const to = normalizeHeaderContextKey(toHeader);
  if (!from || !to) throw new Error("copy_header from/to is required");
  const value = getHeaderValueFromContext(context, from);
  if (!value.ok) throw new Error(`${SOURCE_HEADER_NOT_FOUND}: ${from}`);
  setHeaderOverrideInContext(context, to, value.value, keepOrigin);
}

function moveHeaderInContext(context: ParamOverrideContext, fromHeader: string, toHeader: string, keepOrigin: boolean): void {
  const from = normalizeHeaderContextKey(fromHeader);
  const to = normalizeHeaderContextKey(toHeader);
  if (!from || !to) throw new Error("move_header from/to is required");
  copyHeaderInContext(context, from, to, keepOrigin);
  if (from === to) return;
  deleteHeaderOverrideInContext(context, from);
}

function parseHeaderPassThroughNames(value: unknown): string[] {
  const normalizeNames = (values: string[]) => uniq(values.map(normalizeHeaderContextKey).filter(Boolean));
  if (value == null) throw new Error("pass_headers value is required");
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("pass_headers value is required");
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return parseHeaderPassThroughNames(JSON.parse(trimmed));
      } catch {
        /* fall through */
      }
    }
    const names = normalizeNames(trimmed.split(","));
    if (!names.length) throw new Error("pass_headers value is invalid");
    return names;
  }
  if (Array.isArray(value)) {
    const names = normalizeNames(value.map((item) => goSprint(item)));
    if (!names.length) throw new Error("pass_headers value is invalid");
    return names;
  }
  throw new Error("pass_headers value is invalid");
}

function parseSyncTarget(spec: string): SyncTarget {
  const raw = spec.trim();
  if (!raw) throw new Error("sync_fields target is required");
  const cut = raw.indexOf(":");
  if (cut < 0) return { kind: "json", key: raw };
  const kind = raw.slice(0, cut).trim().toLowerCase();
  const key = raw.slice(cut + 1).trim();
  if (!key) throw new Error(`sync_fields target key is required: ${raw}`);
  if (kind === "json" || kind === "body") return { kind: "json", key };
  if (kind === "header") return { kind: "header", key };
  throw new Error(`sync_fields target prefix is invalid: ${raw}`);
}

function readSyncTargetValue(data: unknown, context: ParamOverrideContext, target: SyncTarget): { exists: boolean; value: unknown } {
  if (target.kind === "json") {
    const path = processNegativeIndex(data, target.key);
    const hit = getAt(data, path);
    if (!hit.exists || hit.type === T_NULL) return { exists: false, value: undefined };
    if (hit.type === T_STRING && !String(hit.value).trim()) return { exists: false, value: undefined };
    return { exists: true, value: hit.value };
  }
  const header = getHeaderValueFromContext(context, target.key);
  if (!header.ok || !header.value.trim()) return { exists: false, value: undefined };
  return { exists: true, value: header.value };
}

function writeSyncTargetValue(data: unknown, context: ParamOverrideContext, target: SyncTarget, value: unknown): unknown {
  if (target.kind === "json") return setAt(data, processNegativeIndex(data, target.key), value);
  setHeaderOverrideInContext(context, target.key, value, false);
  return data;
}

function syncFieldsBetweenTargets(data: unknown, context: ParamOverrideContext, fromSpec: string, toSpec: string): unknown {
  const fromTarget = parseSyncTarget(fromSpec);
  const toTarget = parseSyncTarget(toSpec);
  const from = readSyncTargetValue(data, context, fromTarget);
  const to = readSyncTargetValue(data, context, toTarget);
  if (from.exists && !to.exists) return writeSyncTargetValue(data, context, toTarget, from.value);
  if (to.exists && !from.exists) return writeSyncTargetValue(data, context, fromTarget, to.value);
  return data;
}

function moveValue(data: unknown, fromPath: string, toPath: string): unknown {
  const source = getAt(data, fromPath);
  if (!source.exists) throw new Error(`source path does not exist: ${fromPath}`);
  return deleteAt(setAt(data, toPath, source.value), fromPath);
}

function copyValue(data: unknown, fromPath: string, toPath: string): unknown {
  const source = getAt(data, fromPath);
  if (!source.exists) throw new Error(`source path does not exist: ${fromPath}`);
  return setAt(data, toPath, source.value);
}

function applyOperationsLegacy(jsonData: unknown, paramOverride: Record<string, unknown>): unknown {
  let result = jsonData;
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    result = {};
  }
  const obj = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(paramOverride)) {
    obj[key] = value;
  }
  return result;
}

function applyOperations(jsonData: unknown, operations: ParamOperation[], conditionContext: ParamOverrideContext): unknown {
  const context = conditionContext;
  let result = jsonData;
  for (const op of operations) {
    if (!checkConditions(result, context, op.conditions, op.logic || "OR")) continue;
    const opPath = processNegativeIndex(result, op.path);
    let opPaths: string[] = [];
    if (isPathBasedOperation(op.mode)) {
      opPaths = resolveOperationPaths(result, opPath);
      if (!opPaths.length) continue;
    }
    try {
      switch (op.mode) {
        case "delete":
          for (const path of opPaths) result = deleteAt(result, path);
          break;
        case "set":
          for (const path of opPaths) {
            if (op.keep_origin && getAt(result, path).exists) continue;
            result = setAt(result, path, op.value);
          }
          break;
        case "move":
          result = moveValue(result, processNegativeIndex(result, op.from || ""), processNegativeIndex(result, op.to || ""));
          break;
        case "copy":
          if (!op.from || !op.to) throw new Error("copy from/to is required");
          result = copyValue(result, processNegativeIndex(result, op.from), processNegativeIndex(result, op.to));
          break;
        case "prepend":
          for (const path of opPaths) result = modifyValue(result, path, op.value, Boolean(op.keep_origin), true);
          break;
        case "append":
          for (const path of opPaths) result = modifyValue(result, path, op.value, Boolean(op.keep_origin), false);
          break;
        case "trim_prefix":
          for (const path of opPaths) result = trimStringValue(result, path, op.value, true);
          break;
        case "trim_suffix":
          for (const path of opPaths) result = trimStringValue(result, path, op.value, false);
          break;
        case "ensure_prefix":
          for (const path of opPaths) result = ensureStringAffix(result, path, op.value, true);
          break;
        case "ensure_suffix":
          for (const path of opPaths) result = ensureStringAffix(result, path, op.value, false);
          break;
        case "trim_space":
          for (const path of opPaths) result = transformStringValue(result, path, (s) => s.trim());
          break;
        case "to_lower":
          for (const path of opPaths) result = transformStringValue(result, path, (s) => s.toLowerCase());
          break;
        case "to_upper":
          for (const path of opPaths) result = transformStringValue(result, path, (s) => s.toUpperCase());
          break;
        case "replace":
          for (const path of opPaths) result = replaceStringValue(result, path, op.from || "", op.to || "");
          break;
        case "regex_replace":
          for (const path of opPaths) result = regexReplaceStringValue(result, path, op.from || "", op.to || "");
          break;
        case "return_error":
          throw parseParamOverrideReturnError(op.value);
        case "prune_objects":
          for (const path of opPaths) result = pruneObjects(result, path, context, op.value);
          break;
        case "set_header":
          setHeaderOverrideInContext(context, op.path, op.value, Boolean(op.keep_origin));
          break;
        case "delete_header":
          deleteHeaderOverrideInContext(context, op.path);
          break;
        case "copy_header": {
          const sourceHeader = (op.from || op.path).trim();
          const targetHeader = (op.to || op.path).trim();
          try {
            copyHeaderInContext(context, sourceHeader, targetHeader, Boolean(op.keep_origin));
          } catch (err) {
            if (err instanceof Error && err.message.startsWith(SOURCE_HEADER_NOT_FOUND)) break;
            throw err;
          }
          break;
        }
        case "move_header": {
          const sourceHeader = (op.from || op.path).trim();
          const targetHeader = (op.to || op.path).trim();
          try {
            moveHeaderInContext(context, sourceHeader, targetHeader, Boolean(op.keep_origin));
          } catch (err) {
            if (err instanceof Error && err.message.startsWith(SOURCE_HEADER_NOT_FOUND)) break;
            throw err;
          }
          break;
        }
        case "pass_headers":
          for (const headerName of parseHeaderPassThroughNames(op.value)) {
            try {
              copyHeaderInContext(context, headerName, headerName, Boolean(op.keep_origin));
            } catch (err) {
              if (err instanceof Error && err.message.startsWith(SOURCE_HEADER_NOT_FOUND)) continue;
              throw err;
            }
          }
          break;
        case "sync_fields":
          result = syncFieldsBetweenTargets(result, context, op.from || "", op.to || "");
          break;
        default:
          throw new Error(`unknown operation: ${op.mode}`);
      }
    } catch (err) {
      if (err instanceof ParamOverrideReturnError) throw err;
      if (err instanceof Error && err.message.startsWith("unknown operation:")) throw err;
      if (err instanceof Error && err.message.startsWith("return_error")) throw err;
      throw new Error(`operation ${op.mode} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Original `ApplyParamOverride`. Mutates `conditionContext` header override map. */
export function applyParamOverride(
  jsonData: unknown,
  paramOverride: Record<string, unknown>,
  conditionContext: ParamOverrideContext | null = {},
): unknown {
  if (!paramOverride || !Object.keys(paramOverride).length) return jsonData;
  const context = conditionContext || {};
  const operations = tryParseOperations(paramOverride);
  if (operations) {
    const legacy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(paramOverride)) {
      if (key.toLowerCase() === "operations") continue;
      legacy[key] = value;
    }
    let working = cloneJson(jsonData);
    if (Object.keys(legacy).length) working = applyOperationsLegacy(working, legacy);
    return applyOperations(working, operations, context);
  }
  return applyOperationsLegacy(cloneJson(jsonData), paramOverride);
}

function isHeaderPassthroughRuleKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return k === "*" || k.startsWith("re:") || k.startsWith("regex:");
}

export function sanitizeHeaderOverrideMap(source: Record<string, unknown>): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source || {})) {
    const normalizedKey = normalizeHeaderContextKey(key);
    if (!normalizedKey) continue;
    const normalizedValue = goSprint(value).trim();
    if (!normalizedValue) {
      if (isHeaderPassthroughRuleKey(normalizedKey)) target[normalizedKey] = "";
      continue;
    }
    target[normalizedKey] = normalizedValue;
  }
  return target;
}

export function buildRequestHeadersContext(headers: Record<string, string> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = normalizeHeaderContextKey(key);
    const trimmed = String(value || "").trim();
    if (!normalized || !trimmed) continue;
    out[normalized] = trimmed;
  }
  return out;
}

export function requestHeadersFrom(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function buildParamOverrideContext(info: ParamOverrideRelayInfo, headerOverride: Record<string, unknown>): ParamOverrideContext {
  const ctx: ParamOverrideContext = {};
  if (info.userId != null) ctx.user_id = info.userId;
  if (info.userGroup != null) ctx.user_group = info.userGroup;
  if (info.tokenGroup != null) ctx.token_group = info.tokenGroup;
  if (info.usingGroup != null) ctx.using_group = info.usingGroup;
  if (info.upstreamModel) {
    ctx.model = info.upstreamModel;
    ctx.upstream_model = info.upstreamModel;
  }
  if (info.originalModel) {
    ctx.original_model = info.originalModel;
    if (ctx.model == null) ctx.model = info.originalModel;
  }
  if (info.requestPath) ctx.request_path = info.requestPath;
  ctx[PARAM_OVERRIDE_REQUEST_HEADERS] = buildRequestHeadersContext(info.requestHeaders);
  ctx[PARAM_OVERRIDE_HEADER_OVERRIDE] = sanitizeHeaderOverrideMap(headerOverride);
  const retryIndex = info.retryIndex || 0;
  ctx.retry_index = retryIndex;
  ctx.is_retry = retryIndex > 0;
  ctx.retry = { index: retryIndex, is_retry: retryIndex > 0 };
  ctx.is_channel_test = Boolean(info.isChannelTest);
  return ctx;
}

function substituteHeaderValue(value: string, apiKey: string, model: string): string {
  return value.replace(/\{api_key\}/g, apiKey).replace(/\{model\}/g, model);
}

/** Original `model.Channel.GetParamOverride` — JSON text, already-parsed object, or double-encoded JSON. */
export function parseParamOverrideMap(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else text = String(raw);
  text = text.trim();
  if (!text) return {};
  try {
    let parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (inner.startsWith("{") || inner.startsWith("[")) parsed = JSON.parse(inner);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

/** Apply original param_override operations and header_override onto an outbound target. */
export function applyChannelParamOverride(
  channel: ChannelRow,
  body: unknown,
  headers: Record<string, string>,
  info: ParamOverrideRelayInfo = {},
  apiKey = "",
  model = "",
): unknown {
  const rawHeader = parseParamOverrideMap(channel.header_override);
  const seeded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawHeader)) {
    seeded[k] = substituteHeaderValue(String(v ?? ""), apiKey, model || String(info.upstreamModel || info.originalModel || ""));
  }
  let paramOverride = parseParamOverrideMap(channel.param_override);
  if (info.affinityTemplate && Object.keys(info.affinityTemplate).length) {
    paramOverride = mergeChannelOverride(paramOverride, info.affinityTemplate);
  }
  const ctx = buildParamOverrideContext(
    { ...info, upstreamModel: info.upstreamModel || model, originalModel: info.originalModel || model, requestPath: info.requestPath },
    seeded,
  );
  let nextBody = body;
  if (Object.keys(paramOverride).length) {
    if (typeof body === "string") {
      let parsed: unknown;
      let isJson = false;
      try {
        parsed = JSON.parse(body);
        isJson = true;
      } catch {
        /* keep raw string body */
      }
      if (isJson) nextBody = applyParamOverride(parsed, paramOverride, ctx);
    } else if (body != null && typeof body === "object") {
      nextBody = applyParamOverride(body, paramOverride, ctx);
    }
  }
  const finalHeaders = sanitizeHeaderOverrideMap((ctx[PARAM_OVERRIDE_HEADER_OVERRIDE] as Record<string, unknown>) || {});
  for (const [k, v] of Object.entries(finalHeaders)) {
    headers[k] = String(v);
  }
  return nextBody;
}
