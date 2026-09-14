/**
 * Original QuantumNous `pkg/jsplugin` contract on workerd.
 * Not Goja/sobek: the same plugin.js hooks, host `utils`, Call/CallMember JSON,
 * forbidden syntax, and HookError sanitization. Tight-loop Interrupt is the
 * isolate CPU limit rather than Sobek Interrupt.
 */
import { CHANNEL_TYPE_TASK_PLUGIN } from "./constants.js";
import {
  bytesToHex,
  bytesToRawURLBase64,
  bytesToStdBase64,
  hmacSha256BytesSync,
  rawURLBase64ToBytes,
  sha256BytesSync,
  utf8Bytes,
} from "./jsplugin-sha256.js";

export const DEFAULT_CALL_TIMEOUT_MS = 5000;
export const CAPABILITY_JSON_CLONE = "json-clone@1";
export const CAPABILITY_SUBMIT_SSE_DELTA = "submit-sse-delta@1";
const MAX_JSON_TOOL_BYTES = 1 << 20;
const MAX_JSON_TOOL_DEPTH = 32;
const MAX_JSON_TOOL_NODES = 32768;
const HOOK_ERROR_MESSAGE_LIMIT = 512;
const PLUGIN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PLUGIN_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SYNTAX = /(^|[^A-Za-z0-9_$])(async|await|import)([^A-Za-z0-9_$]|$)/m;
const ALLOWED_META_FIELDS = new Set([
  "requiredCapabilities",
  "submitResponseTypes",
  "sortPriority",
  "website",
  "apiVersion",
  "key",
  "name",
  "icon",
  "description",
  "version",
  "author",
  "baseUrl",
  "channelTypes",
  "channelType",
  "compatibleChannelTypes",
  "models",
  "fetchMode",
  "allowedHosts",
  "routes",
  "protocols",
  "usageSchema",
  "usageExamples",
  "usageProfiles",
  "auth",
  "endpoints",
  "submitPaths",
  "actions",
]);

type ProtocolMode = { name: string; hook: string };
type HostProtocolOperation = {
  requiredProtocolMembers: string[];
  modes: ProtocolMode[];
  requiredDriverHooks: string[];
};
type HostProtocolDefinition = { name: string; operations: HostProtocolOperation[] };

const HOST_PROTOCOLS: HostProtocolDefinition[] = [
  {
    name: "openai_responses",
    operations: [
      {
        requiredProtocolMembers: ["decodeRequest"],
        modes: [
          { name: "stream", hook: "renderEvents" },
          { name: "sync", hook: "renderFinal" },
          { name: "background", hook: "renderFinal" },
        ],
        requiredDriverHooks: [],
      },
      { requiredProtocolMembers: [], modes: [], requiredDriverHooks: [] },
    ],
  },
  {
    name: "openai_video",
    operations: [
      { requiredProtocolMembers: ["decodeRequest"], modes: [], requiredDriverHooks: [] },
      { requiredProtocolMembers: ["render"], modes: [], requiredDriverHooks: [] },
      { requiredProtocolMembers: [], modes: [], requiredDriverHooks: ["listArtifacts", "buildContentRequest"] },
    ],
  },
];

export type CompileOptions = {
  key?: string;
  version?: string;
  now?: () => Date;
  log?: (message: string) => void;
};

export class HookError extends Error {
  hook: string;
  jsMessage: string;
  constructor(hook: string, jsMessage: string, wrapped: Error) {
    super(wrapped.message);
    this.name = "HookError";
    this.hook = hook;
    this.jsMessage = jsMessage;
  }
}

export class UnknownMetaFieldError extends Error {
  field: string;
  constructor(field: string) {
    super(`plugin meta has unknown field ${JSON.stringify(field)}`);
    this.name = "UnknownMetaFieldError";
    this.field = field;
  }
}

export function hasCapability(name: string): boolean {
  return name === CAPABILITY_JSON_CLONE || name === CAPABILITY_SUBMIT_SSE_DELTA;
}

export function sourceWithoutCommentsAndStrings(source: string): string {
  let output = "";
  let quote = 0;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const current = source.charCodeAt(i);
    const next = i + 1 < source.length ? source.charCodeAt(i + 1) : 0;
    if (lineComment) {
      if (current === 10) {
        lineComment = false;
        output += "\n";
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (current === 42 && next === 47) {
        blockComment = false;
        output += "  ";
        i++;
      } else output += " ";
      continue;
    }
    if (quote !== 0) {
      output += " ";
      if (escaped) escaped = false;
      else if (current === 92) escaped = true;
      else if (current === quote) quote = 0;
      continue;
    }
    if (current === 47 && next === 47) {
      lineComment = true;
      output += "  ";
      i++;
      continue;
    }
    if (current === 47 && next === 42) {
      blockComment = true;
      output += "  ";
      i++;
      continue;
    }
    if (current === 39 || current === 34 || current === 96) {
      quote = current;
      output += " ";
      continue;
    }
    output += source[i];
  }
  return output;
}

function newHookError(hook: string, rawMessage: string, wrapped: Error): HookError {
  let message = "";
  let count = 0;
  for (const rune of rawMessage) {
    if (count >= HOOK_ERROR_MESSAGE_LIMIT) break;
    const cp = rune.codePointAt(0) || 0;
    message += cp < 0x20 || (cp >= 0x80 && cp <= 0x9f) ? " " : rune;
    count += 1;
  }
  if (!message) message = "plugin hook failed";
  return new HookError(hook, message, wrapped);
}

function hookErrorFromException(hook: string, err: unknown, wrapped: Error): HookError {
  try {
    if (typeof err === "string") return newHookError(hook, err, wrapped);
    if (err && typeof err === "object") {
      const obj = err as { message?: unknown };
      if (Object.prototype.hasOwnProperty.call(err, "message") || "message" in obj) {
        const msg = obj.message;
        if (typeof msg === "string") return newHookError(hook, msg, wrapped);
        if (msg != null && msg !== undefined) return newHookError(hook, String(msg), wrapped);
      }
      if (typeof err === "object") return newHookError(hook, String(err), wrapped);
    }
    return newHookError(hook, err == null ? "" : String(err), wrapped);
  } catch {
    return newHookError(hook, "", wrapped);
  }
}

function encodeGoJSONString(value: string): string {
  let out = "\"";
  for (const rune of value) {
    const cp = rune.codePointAt(0) || 0;
    if (cp === 0x22) out += "\\\"";
    else if (cp === 0x5c) out += "\\\\";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0d) out += "\\r";
    else if (cp === 0x09) out += "\\t";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else if (cp === 0x3c) out += "\\u003c";
    else if (cp === 0x3e) out += "\\u003e";
    else if (cp === 0x26) out += "\\u0026";
    else if (cp === 0x2028) out += "\\u2028";
    else if (cp === 0x2029) out += "\\u2029";
    else out += rune;
  }
  return out + "\"";
}

function encodeGoJSONNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error("JSON numbers must be finite");
  if (Object.is(n, -0) || n === 0) return "0";
  return JSON.stringify(n);
}

function asGoRunes(value: string): string {
  return new TextDecoder("utf-8").decode(utf8Bytes(value));
}

type JSONNode = {
  scalar?: unknown;
  object?: Map<string, JSONNode>;
  array?: JSONNode[];
  bytes: number;
  nodes: number;
};

type JSONBudget = { bytes: number; nodes: number };

function spend(budget: JSONBudget, bytes: number, nodes: number): void {
  if (bytes > budget.bytes || nodes > budget.nodes) throw new Error("JSON state exceeds size or node limit");
  budget.bytes -= bytes;
  budget.nodes -= nodes;
}

function objectTag(value: object): string {
  return Object.prototype.toString.call(value);
}

function newJSONStateNode(value: unknown, depth: number, budget: JSONBudget): JSONNode {
  if (depth > MAX_JSON_TOOL_DEPTH) throw new Error("JSON state exceeds depth limit");
  if (value === undefined) throw new Error("undefined is not a JSON value");
  if (typeof value === "function") throw new Error("value must contain only JSON objects, arrays and scalars");
  if (typeof value === "bigint") throw new Error("value must contain only JSON objects, arrays and scalars");
  if (typeof value === "symbol") throw new Error("value must contain only JSON objects, arrays and scalars");
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      const length = value.length;
      if (length > budget.nodes) throw new Error("JSON array exceeds node limit");
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error("sparse arrays are not JSON values");
        items.push(value[i]);
      }
      value = items;
    } else if (objectTag(value) !== "[object Object]") {
      throw new Error("json.clone accepts only plain objects, arrays and JSON scalars");
    }
  }
  const beforeBytes = budget.bytes;
  const beforeNodes = budget.nodes;
  spend(budget, 0, 1);
  const node: JSONNode = { bytes: 0, nodes: 0 };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(obj).filter((key) => Object.getOwnPropertyDescriptor(obj, key)?.enumerable);
    if (keys.length > budget.nodes) throw new Error("JSON object exceeds node limit");
    spend(budget, 2, 0);
    node.object = new Map();
    for (const key of keys) {
      if (key.length > budget.bytes) throw new Error("invalid or oversized JSON object key");
      const encoded = encodeGoJSONString(key);
      let cost = encoded.length + 1;
      if (node.object.size !== 0) cost += 1;
      spend(budget, cost, 0);
      node.object.set(key, newJSONStateNode(obj[key], depth + 1, budget));
    }
  } else if (Array.isArray(value)) {
    if (value.length > budget.nodes) throw new Error("JSON array exceeds node limit");
    spend(budget, 2 + Math.max(0, value.length - 1), 0);
    node.array = [];
    for (const child of value) node.array.push(newJSONStateNode(child, depth + 1, budget));
  } else {
    let scalar: unknown = value;
    if (typeof scalar === "string") {
      if (scalar.length > budget.bytes) throw new Error("JSON string exceeds size limit");
      scalar = asGoRunes(scalar);
    } else if (typeof scalar === "number") {
      if (!Number.isFinite(scalar)) throw new Error("JSON numbers must be finite");
    } else if (scalar !== null && typeof scalar !== "boolean") {
      throw new Error("value must contain only JSON objects, arrays and scalars");
    }
    const encoded = typeof scalar === "string" ? encodeGoJSONString(scalar) : typeof scalar === "number" ? encodeGoJSONNumber(scalar) : scalar === null ? "null" : scalar ? "true" : "false";
    spend(budget, encoded.length, 0);
    node.scalar = scalar;
  }
  node.bytes = beforeBytes - budget.bytes;
  node.nodes = beforeNodes - budget.nodes;
  return node;
}

function jsonNodeToValue(node: JSONNode): unknown {
  if (node.object) {
    const result = Object.create(Object.prototype) as Record<string, unknown>;
    for (const [key, child] of node.object) {
      Object.defineProperty(result, key, {
        value: jsonNodeToValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  if (node.array) return node.array.map(jsonNodeToValue);
  return node.scalar;
}

function jsonClone(value: unknown): unknown {
  if (value === undefined) throw new TypeError("json.clone requires a JSON value");
  try {
    const budget: JSONBudget = { bytes: MAX_JSON_TOOL_BYTES, nodes: MAX_JSON_TOOL_NODES };
    return jsonNodeToValue(newJSONStateNode(value, 0, budget));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("json.clone")) throw new TypeError(message);
    throw new TypeError("json.clone: " + message);
  }
}

function goJSONMarshal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeGoJSONNumber(value);
  if (typeof value === "string") return encodeGoJSONString(value);
  if (Array.isArray(value)) return "[" + value.map(goJSONMarshal).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      parts.push(encodeGoJSONString(key) + ":" + goJSONMarshal(item));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error("jwt claims must be JSON");
}

function jwtSignHS256(claims: Record<string, unknown>, secret: string): string {
  const header = bytesToRawURLBase64(utf8Bytes('{"alg":"HS256","typ":"JWT"}'));
  const payload = bytesToRawURLBase64(utf8Bytes(goJSONMarshal(claims)));
  const signing = utf8Bytes(header + "." + payload);
  const sig = bytesToRawURLBase64(hmacSha256BytesSync(utf8Bytes(secret), signing));
  return header + "." + payload + "." + sig;
}

type VolcSignRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  timestamp: number;
};

function pickVolc(request: Record<string, unknown>): VolcSignRequest {
  const headersRaw = (request.headers ?? request.Headers) as Record<string, unknown> | undefined;
  const headers: Record<string, string> = {};
  if (headersRaw && typeof headersRaw === "object") {
    for (const [name, value] of Object.entries(headersRaw)) headers[name] = String(value);
  }
  return {
    method: String((request.method ?? request.Method) || ""),
    url: String((request.url ?? request.URL) || ""),
    headers,
    body: String((request.body ?? request.Body) || ""),
    accessKey: String((request.accessKey ?? request.AccessKey) || ""),
    secretKey: String((request.secretKey ?? request.SecretKey) || ""),
    region: String((request.region ?? request.Region) || ""),
    service: String((request.service ?? request.Service) || ""),
    timestamp: Number((request.timestamp ?? request.Timestamp) || 0) || 0,
  };
}

function signVolcV4(raw: Record<string, unknown>, now: () => Date): Record<string, string> {
  const request = pickVolc(raw);
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    throw new Error("invalid Volcengine signing URL");
  }
  if (!parsed.host) throw new Error("invalid Volcengine signing URL");
  const region = request.region || "cn-north-1";
  const service = request.service || "cv";
  let timestamp = now();
  if (request.timestamp) timestamp = new Date(request.timestamp * 1000);
  const utc = new Date(timestamp.getTime());
  const pad = (n: number) => String(n).padStart(2, "0");
  const xDate =
    utc.getUTCFullYear().toString() +
    pad(utc.getUTCMonth() + 1) +
    pad(utc.getUTCDate()) +
    "T" +
    pad(utc.getUTCHours()) +
    pad(utc.getUTCMinutes()) +
    pad(utc.getUTCSeconds()) +
    "Z";
  const shortDate = xDate.slice(0, 8);
  const bodyHash = bytesToHex(sha256BytesSync(utf8Bytes(request.body)));
  let requestPath = parsed.pathname || "/";
  if (!requestPath) requestPath = "/";
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = String(value).trim();
  headers.host = parsed.host;
  headers["x-date"] = xDate;
  headers["x-content-sha256"] = bodyHash;
  const keys = Object.keys(headers).sort();
  let canonicalHeaders = "";
  for (const name of keys) canonicalHeaders += name + ":" + headers[name] + "\n";
  const signedHeaders = keys.join(";");
  const canonicalRequest = [request.method.toUpperCase(), requestPath, parsed.searchParams.toString(), canonicalHeaders, signedHeaders, bodyHash].join(
    "\n",
  );
  const canonicalHash = bytesToHex(sha256BytesSync(utf8Bytes(canonicalRequest)));
  const scope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${canonicalHash}`;
  const sign = (key: Uint8Array, value: string) => hmacSha256BytesSync(key, utf8Bytes(value));
  let signingKey = sign(utf8Bytes(request.secretKey), shortDate);
  signingKey = sign(signingKey, region);
  signingKey = sign(signingKey, service);
  signingKey = sign(signingKey, "request");
  const signature = bytesToHex(sign(signingKey, stringToSign));
  return {
    Authorization: `HMAC-SHA256 Credential=${request.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "X-Date": xDate,
    "X-Content-Sha256": bodyHash,
  };
}

function isIdentChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;
}

function readIdent(source: string, i: number): { name: string; next: number } | null {
  if (!isIdentStart(source.charCodeAt(i))) return null;
  let j = i + 1;
  while (j < source.length && isIdentChar(source.charCodeAt(j))) j++;
  return { name: source.slice(i, j), next: j };
}

function skipWsAndComments(source: string, i: number): number {
  while (i < source.length) {
    const c = source.charCodeAt(i);
    const n = i + 1 < source.length ? source.charCodeAt(i + 1) : 0;
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
      i++;
      continue;
    }
    if (c === 47 && n === 47) {
      i += 2;
      while (i < source.length && source.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 47 && n === 42) {
      i += 2;
      while (i + 1 < source.length && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "else",
  "do",
  "in",
  "of",
  "new",
  "typeof",
  "void",
  "delete",
  "yield",
  "await",
  "instanceof",
]);

function canStartRegex(out: string): boolean {
  let j = out.length - 1;
  while (j >= 0 && (out.charCodeAt(j) === 32 || out.charCodeAt(j) === 9 || out.charCodeAt(j) === 10 || out.charCodeAt(j) === 13)) j--;
  if (j < 0) return true;
  const ch = out[j];
  if ("=(,;:!&|?~+-*%^<>[{".includes(ch)) return true;
  if (ch === ")" || ch === "]" || ch === "}" || ch === "\"" || ch === "'" || ch === "`") return false;
  if (ch >= "0" && ch <= "9") return false;
  if (isIdentChar(out.charCodeAt(j))) {
    let i = j;
    while (i >= 0 && isIdentChar(out.charCodeAt(i))) i--;
    return REGEX_PREFIX_KEYWORDS.has(out.slice(i + 1, j + 1));
  }
  return true;
}

function transformEsmToScript(source: string): { code: string; exported: { name: string; expr: string }[] } {
  const exported: { name: string; expr: string }[] = [];
  let out = "";
  let i = 0;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let quote = 0;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let templateExpr = 0;

  const atCode = () => quote === 0 && !lineComment && !blockComment;

  while (i < source.length) {
    const current = source.charCodeAt(i);
    const next = i + 1 < source.length ? source.charCodeAt(i + 1) : 0;
    if (lineComment) {
      out += source[i];
      if (current === 10) lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      out += source[i];
      if (current === 42 && next === 47) {
        out += source[i + 1];
        blockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote === 96) {
      out += source[i];
      if (escaped) escaped = false;
      else if (current === 92) escaped = true;
      else if (current === 36 && next === 123) {
        out += source[i + 1];
        templateExpr++;
        quote = 0;
        i += 2;
        continue;
      } else if (current === 96) quote = 0;
      i++;
      continue;
    }
    if (quote !== 0) {
      out += source[i];
      if (escaped) escaped = false;
      else if (current === 92) escaped = true;
      else if (current === quote) quote = 0;
      i++;
      continue;
    }
    if (current === 47 && next === 47) {
      out += "//";
      lineComment = true;
      i += 2;
      continue;
    }
    if (current === 47 && next === 42) {
      out += "/*";
      blockComment = true;
      i += 2;
      continue;
    }
    if (current === 47 && canStartRegex(out)) {
      out += "/";
      i++;
      let reEsc = false;
      let inClass = false;
      while (i < source.length) {
        const ch = source.charCodeAt(i);
        out += source[i];
        if (reEsc) reEsc = false;
        else if (ch === 92) reEsc = true;
        else if (ch === 91 && !inClass) inClass = true;
        else if (ch === 93 && inClass) inClass = false;
        else if (ch === 47 && !inClass) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (current === 39 || current === 34 || current === 96) {
      quote = current;
      out += source[i];
      i++;
      continue;
    }
    if (current === 123) {
      if (templateExpr && brace === 0 && quote === 0) {
        /* already counted */
      }
      brace++;
      out += source[i];
      i++;
      continue;
    }
    if (current === 125) {
      brace--;
      if (templateExpr && brace < 0) {
        templateExpr--;
        brace = 0;
        quote = 96;
      }
      out += source[i];
      i++;
      continue;
    }
    if (current === 40) {
      paren++;
      out += source[i];
      i++;
      continue;
    }
    if (current === 41) {
      paren--;
      out += source[i];
      i++;
      continue;
    }
    if (current === 91) {
      bracket++;
      out += source[i];
      i++;
      continue;
    }
    if (current === 93) {
      bracket--;
      out += source[i];
      i++;
      continue;
    }
    if (atCode() && brace === 0 && paren === 0 && bracket === 0 && source.startsWith("export", i) && (i === 0 || !isIdentChar(source.charCodeAt(i - 1))) && (i + 6 >= source.length || !isIdentChar(source.charCodeAt(i + 6)))) {
      i += 6;
      i = skipWsAndComments(source, i);
      if (source.startsWith("function", i)) {
        out += "function";
        i += 8;
        i = skipWsAndComments(source, i);
        if (source.charCodeAt(i) === 42) {
          out += "*";
          i++;
          i = skipWsAndComments(source, i);
        }
        out += " ";
        const ident = readIdent(source, i);
        if (ident) {
          exported.push({ name: ident.name, expr: ident.name });
          out += ident.name;
          i = ident.next;
        }
        continue;
      }
      if (source.startsWith("const", i) || source.startsWith("let", i) || source.startsWith("var", i)) {
        const kw = source.startsWith("const", i) ? "const" : source.startsWith("let", i) ? "let" : "var";
        out += kw + " ";
        i += kw.length;
        let depth = 0;
        let sawName = false;
        let declQuote = 0;
        let declEsc = false;
        let declLine = false;
        let declBlock = false;
        while (i < source.length) {
          const c = source.charCodeAt(i);
          const n = i + 1 < source.length ? source.charCodeAt(i + 1) : 0;
          if (declLine) {
            out += source[i];
            if (c === 10) declLine = false;
            i++;
            continue;
          }
          if (declBlock) {
            out += source[i];
            if (c === 42 && n === 47) {
              out += source[i + 1];
              declBlock = false;
              i += 2;
              continue;
            }
            i++;
            continue;
          }
          if (declQuote) {
            out += source[i];
            if (declEsc) declEsc = false;
            else if (c === 92) declEsc = true;
            else if (c === declQuote) declQuote = 0;
            i++;
            continue;
          }
          if (c === 47 && n === 47) {
            out += "//";
            declLine = true;
            i += 2;
            continue;
          }
          if (c === 47 && n === 42) {
            out += "/*";
            declBlock = true;
            i += 2;
            continue;
          }
          if (c === 39 || c === 34 || c === 96) {
            declQuote = c;
            out += source[i];
            i++;
            continue;
          }
          if (c === 123 || c === 91 || c === 40) {
            depth++;
            out += source[i];
            i++;
            continue;
          }
          if (c === 125 || c === 93 || c === 41) {
            depth--;
            out += source[i];
            i++;
            continue;
          }
          if (depth === 0 && !sawName) {
            const ident = readIdent(source, i);
            if (ident) {
              exported.push({ name: ident.name, expr: ident.name });
              out += ident.name;
              i = ident.next;
              sawName = true;
              continue;
            }
          }
          if (depth === 0 && c === 44) {
            sawName = false;
            out += source[i];
            i++;
            continue;
          }
          if (depth === 0 && (c === 59 || c === 10)) {
            out += source[i];
            i++;
            break;
          }
          out += source[i];
          i++;
        }
        continue;
      }
      if (source.charCodeAt(i) === 123) {
        i++;
        while (i < source.length) {
          i = skipWsAndComments(source, i);
          if (source.charCodeAt(i) === 125) {
            i++;
            break;
          }
          const ident = readIdent(source, i);
          if (!ident) {
            i++;
            continue;
          }
          i = ident.next;
          i = skipWsAndComments(source, i);
          let exportedAs = ident.name;
          let expr = ident.name;
          if (source.startsWith("as", i) && !isIdentChar(source.charCodeAt(i + 2) || 0)) {
            i += 2;
            i = skipWsAndComments(source, i);
            const alias = readIdent(source, i);
            if (alias) {
              exportedAs = alias.name;
              i = alias.next;
            }
          }
          exported.push({ name: exportedAs, expr });
          i = skipWsAndComments(source, i);
          if (source.charCodeAt(i) === 44) i++;
        }
        i = skipWsAndComments(source, i);
        if (source.charCodeAt(i) === 59) i++;
        continue;
      }
      out += "export ";
      continue;
    }
    out += source[i];
    i++;
  }
  return { code: out, exported };
}

function injectUtils(now: () => Date, identity: () => string, log?: (message: string) => void): { utils: Record<string, unknown>; console: { log: (...args: unknown[]) => void } } {
  const utils: Record<string, unknown> = {
    hasCapability,
    json: {
      clone: jsonClone,
    },
    unixNow: () => Math.floor(now().getTime() / 1000),
    jwtSignHS256: (claims: Record<string, unknown>, secret: string) => jwtSignHS256(claims, secret),
    hmacSHA256: (message: string, secret: string) => bytesToHex(hmacSha256BytesSync(utf8Bytes(secret), utf8Bytes(message))),
    base64: (value: string) => bytesToStdBase64(utf8Bytes(value)),
    base64URL: (value: string) => bytesToRawURLBase64(utf8Bytes(value)),
    base64URLDecode: (value: string) => {
      try {
        return new TextDecoder().decode(rawURLBase64ToBytes(value));
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    },
    uuid: () => crypto.randomUUID(),
    volcSignV4: (request: Record<string, unknown>) => signVolcV4(request, now),
  };
  const consoleObj = {
    log: (...args: unknown[]) => {
      if (log) log(identity() + " " + args.map((item) => String(item)).join(" "));
    },
  };
  return { utils, console: consoleObj };
}

function ownNames(value: unknown): string[] {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return [];
  return Object.getOwnPropertyNames(value);
}

function resolveExportPath(exportsObj: Record<string, unknown>, exportName: string, members: string[]): { value: unknown; hookName: string; found: boolean } {
  let value: unknown = Object.prototype.hasOwnProperty.call(exportsObj, exportName) ? exportsObj[exportName] : undefined;
  let hookName = exportName;
  if (value === undefined || value === null) return { value: null, hookName, found: false };
  for (const member of members) {
    hookName += "." + member;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return { value: null, hookName, found: false };
    if (!ownNames(value).includes(member)) return { value: null, hookName, found: false };
    value = (value as Record<string, unknown>)[member];
    if (value === undefined || value === null) return { value: null, hookName, found: false };
  }
  return { value, hookName, found: true };
}

export class PluginEngine {
  timeout: number;
  private identity: { key: string; version: string };
  private exportsObj: Record<string, unknown>;

  constructor(exportsObj: Record<string, unknown>, identity: { key: string; version: string }, timeout = DEFAULT_CALL_TIMEOUT_MS) {
    this.identity = identity;
    this.timeout = timeout > 0 ? timeout : DEFAULT_CALL_TIMEOUT_MS;
    this.exportsObj = exportsObj;
  }

  get key(): string {
    return this.identity.key;
  }
  set key(value: string) {
    this.identity.key = value;
  }
  get version(): string {
    return this.identity.version;
  }
  set version(value: string) {
    this.identity.version = value;
  }

  hasExport(exportName: string): boolean {
    const value = Object.prototype.hasOwnProperty.call(this.exportsObj, exportName) ? this.exportsObj[exportName] : undefined;
    return value !== undefined;
  }

  hasCallablePath(exportName: string, ...members: string[]): boolean {
    const resolved = resolveExportPath(this.exportsObj, exportName, members);
    return resolved.found && typeof resolved.value === "function";
  }

  live(exportName: string): unknown {
    return this.exportsObj[exportName];
  }

  export(exportName: string): unknown {
    if (!this.hasExport(exportName)) throw new Error(`plugin export ${JSON.stringify(exportName)} not found`);
    return this.exportsObj[exportName];
  }

  call(exportName: string, ...args: unknown[]): unknown {
    return this.callPath(exportName, [], args);
  }

  callMember(exportName: string, memberName: string, ...args: unknown[]): unknown {
    return this.callPath(exportName, [memberName], args);
  }

  callPath(exportName: string, members: string[], args: unknown[] = []): unknown {
    let hookName = [exportName, ...members].join(".");
    const resolved = resolveExportPath(this.exportsObj, exportName, members);
    hookName = resolved.hookName;
    if (!resolved.found) {
      if (members.length === 0) throw new Error(`plugin export ${JSON.stringify(exportName)} not found`);
      throw new Error(`plugin hook ${JSON.stringify(hookName)} not found`);
    }
    if (resolved.value === undefined) throw new Error(`plugin export ${JSON.stringify(exportName)} not found`);
    if (typeof resolved.value !== "function") throw new Error(`plugin hook ${JSON.stringify(hookName)} is not a function`);
    try {
      return (resolved.value as (...callArgs: unknown[]) => unknown)(...args);
    } catch (err) {
      const wrapped = new Error(`plugin ${this.key}@${this.version} hook ${hookName} failed: ${err instanceof Error ? err : String(err)}`);
      throw hookErrorFromException(hookName, err, wrapped);
    }
  }
}

export function compile(source: string, options: CompileOptions = {}): PluginEngine {
  const stripped = sourceWithoutCommentsAndStrings(source);
  const match = stripped.match(FORBIDDEN_SYNTAX);
  if (match) {
    throw new Error(`unsupported plugin syntax ${JSON.stringify(match[0].trim())}: plugins must be synchronous and cannot import modules`);
  }
  const transformed = transformEsmToScript(source);
  const bindings = transformed.exported
    .map((item) => `__export(${JSON.stringify(item.name)}, function(){ return ${item.expr}; });`)
    .join("\n");
  const body = `"use strict";
var __exports = Object.create(null);
function __export(name, get) {
  Object.defineProperty(__exports, name, { enumerable: true, configurable: true, get: get });
}
${transformed.code}
${bindings}
return __exports;`;
  let factory: (utils: unknown, consoleObj: unknown) => Record<string, unknown>;
  try {
    factory = new Function("utils", "console", body) as (utils: unknown, consoleObj: unknown) => Record<string, unknown>;
  } catch (err) {
    throw new Error(`compile plugin: ${err instanceof Error ? err.message : String(err)}`);
  }
  const identity = { key: options.key || "", version: options.version || "" };
  const now = options.now || (() => new Date());
  const injected = injectUtils(now, () => `[plugin:${identity.key}@${identity.version}]`, options.log);
  let exportsObj: Record<string, unknown>;
  try {
    exportsObj = factory(injected.utils, injected.console);
  } catch (err) {
    throw new Error(`evaluate plugin: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new PluginEngine(exportsObj, identity, DEFAULT_CALL_TIMEOUT_MS);
}

function stringMeta(object: Record<string, unknown>, name: string): string {
  if (!(name in object)) return "";
  if (typeof object[name] !== "string") throw new Error(`plugin meta ${name} must be a string`);
  return object[name] as string;
}

function integerMeta(object: Record<string, unknown>, name: string): number {
  if (!(name in object)) return 0;
  const value = object[name];
  if (typeof value !== "number" || !Number.isFinite(value) || Math.trunc(value) !== value) {
    throw new Error(`plugin meta ${name} must be an integer`);
  }
  return value;
}

function stringSlice(object: Record<string, unknown>, name: string): string[] {
  if (!(name in object)) return [];
  const items = object[name];
  if (!Array.isArray(items)) throw new Error(`plugin meta ${name} must be an array of strings`);
  return items.map((item, index) => {
    if (typeof item !== "string") throw new Error(`plugin meta ${name} element ${index + 1} must be a string`);
    return item;
  });
}

function quotedJoin(items: string[], sep: string): string {
  return items.map((item) => JSON.stringify(item)).join(sep);
}

function hostProtocol(name: string): HostProtocolDefinition | undefined {
  return HOST_PROTOCOLS.find((item) => item.name === name);
}

function protocolClaims(meta: Record<string, unknown>): { name: string; supports: string[] }[] {
  const value = meta.protocols;
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("plugin meta protocols must be an array");
  return value.map((item, index) => {
    if (typeof item === "string") return { name: item, supports: [] };
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`plugin meta protocol ${index} must be a string or an object`);
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "models" && key !== "supports") throw new Error(`plugin meta protocol ${index} has unknown field ${JSON.stringify(key)}`);
    }
    return {
      name: stringMeta(entry, "name"),
      supports: Array.isArray(entry.supports) ? entry.supports.map(String) : [],
    };
  });
}

function routeViews(meta: Record<string, unknown>): { method: string; path: string; decode: string; render: string }[] {
  const value = meta.routes;
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("plugin meta routes must be an array");
  return value.map((item) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      method: String(row.method || ""),
      path: String(row.path || ""),
      decode: String(row.decode || ""),
      render: String(row.render || ""),
    };
  });
}

export type LoadedPlugin = { meta: Record<string, unknown>; engine: PluginEngine };

export function compilePlugin(source: string, options: CompileOptions = {}): LoadedPlugin {
  const engine = compile(source, options);
  const metaValue = engine.export("meta");
  if (!metaValue || typeof metaValue !== "object" || Array.isArray(metaValue)) throw new Error("plugin meta must be an object");
  const object = metaValue as Record<string, unknown>;
  for (const field of Object.keys(object)) {
    if (!ALLOWED_META_FIELDS.has(field)) throw new UnknownMetaFieldError(field);
  }
  if ("channelType" in object) throw new Error("plugin meta channelType is no longer supported; declare channelTypes instead");
  if ("compatibleChannelTypes" in object) throw new Error("plugin meta compatibleChannelTypes is no longer supported; declare channelTypes instead");
  if ("endpoints" in object) throw new Error("plugin meta endpoints is no longer supported; declare protocols by name");
  for (const removed of ["submitPaths", "actions"]) {
    if (removed in object) throw new Error(`plugin meta ${removed} is no longer supported; declare routes instead`);
  }
  const apiVersion = integerMeta(object, "apiVersion");
  if (apiVersion !== 1) throw new Error(`unsupported plugin apiVersion ${apiVersion}`);
  const key = stringMeta(object, "key");
  const name = stringMeta(object, "name");
  const version = stringMeta(object, "version");
  const fetchMode = stringMeta(object, "fetchMode");
  const author = object.author;
  if (!author || typeof author !== "object" || Array.isArray(author)) throw new Error("plugin meta author must be an object");
  const authorName = stringMeta(author as Record<string, unknown>, "name");
  if (!key.trim() || !name.trim() || !version.trim()) throw new Error("plugin meta key, name, and version are required");
  if (key.length > 30) throw new Error("plugin meta key must not exceed 30 characters");
  if (!PLUGIN_KEY_PATTERN.test(key)) throw new Error(`plugin meta key must match ${PLUGIN_KEY_PATTERN}`);
  if (!PLUGIN_VERSION_PATTERN.test(version)) throw new Error("plugin meta version must be semver");
  if (fetchMode !== "per_task" && fetchMode !== "batch") throw new Error("plugin meta fetchMode must be per_task or batch");
  if (!authorName.trim()) throw new Error("plugin meta author name is required");
  const models = stringSlice(object, "models");
  if (!models.length) throw new Error("plugin meta models must contain at least one model");
  const icon = stringMeta(object, "icon").trim();
  if (icon.startsWith("data:") || icon.includes("://")) {
    throw new Error("plugin meta icon must be a LobeHub icon name or text; ship an image logo as an icon.svg or icon.png file next to plugin.js instead");
  }
  const channelTypes = Array.isArray(object.channelTypes) ? object.channelTypes.map((item) => Number(item)) : [];
  for (const channelType of channelTypes) {
    if (!channelType) throw new Error("plugin meta channelTypes must contain positive channel types");
    if (channelType === CHANNEL_TYPE_TASK_PLUGIN) throw new Error("plugin meta channelTypes must not contain the task plugin channel type");
  }
  let submitResponseTypes = ["json"];
  if ("submitResponseTypes" in object) {
    submitResponseTypes = stringSlice(object, "submitResponseTypes");
    if (!submitResponseTypes.length) throw new Error("submitResponseTypes must not be empty");
  }
  const requiredCapabilities = stringSlice(object, "requiredCapabilities");
  engine.key = key;
  engine.version = version;
  const requiredHooks = ["buildSubmitRequest", "parseSubmitResponse", "parseTaskResult"];
  if (submitResponseTypes.includes("sse")) {
    if (requiredCapabilities.includes(CAPABILITY_SUBMIT_SSE_DELTA)) requiredHooks.push("parseSubmitEventDelta");
    else requiredHooks.push("parseSubmitEvent");
  }
  if (fetchMode === "batch") {
    requiredHooks.push("buildBatchQueryRequest", "parseBatchResult");
  } else {
    requiredHooks.push("buildQueryRequest");
  }
  for (const hook of requiredHooks) {
    if (!engine.hasCallablePath(hook)) throw new Error(`plugin ${key} is missing required export ${JSON.stringify(hook)}`);
  }
  const artifactHooks = { listArtifacts: false, buildContentRequest: false };
  for (const hook of ["listArtifacts", "buildContentRequest"] as const) {
    if (!engine.hasExport(hook)) continue;
    if (!engine.hasCallablePath(hook)) throw new Error(`plugin ${key} export ${JSON.stringify(hook)} is not a function`);
    artifactHooks[hook] = true;
  }
  if (artifactHooks.listArtifacts !== artifactHooks.buildContentRequest) {
    throw new Error(`plugin ${key} must export listArtifacts and buildContentRequest together`);
  }
  for (const route of routeViews(object)) {
    for (const [kind, member] of [
      ["decode", route.decode],
      ["render", route.render],
    ] as const) {
      if (!member) continue;
      if (!engine.hasCallablePath("native", member)) {
        throw new Error(`plugin ${key} route ${route.method} ${route.path} ${kind} references missing native ${kind} ${JSON.stringify(member)}`);
      }
    }
  }
  const claims = protocolClaims(object);
  for (const claim of claims) {
    const protocol = claim.name;
    const definition = hostProtocol(protocol) || { name: protocol, operations: [] };
    const required = new Set<string>();
    const allowed = new Set<string>();
    const modeHookUsers: Record<string, string[]> = {};
    for (const operation of definition.operations) {
      for (const hook of operation.requiredProtocolMembers) {
        required.add(hook);
        allowed.add(hook);
      }
      for (const mode of operation.modes) {
        allowed.add(mode.hook);
        if (!modeHookUsers[mode.hook]?.includes(mode.name)) {
          modeHookUsers[mode.hook] = [...(modeHookUsers[mode.hook] || []), mode.name];
        }
        if (claim.supports.includes(mode.name)) required.add(mode.hook);
      }
      for (const hook of operation.requiredDriverHooks) {
        if (!engine.hasCallablePath(hook)) throw new Error(`plugin ${key} protocol ${JSON.stringify(protocol)} is missing driver hook ${JSON.stringify(hook)}`);
      }
    }
    const requiredList = [...required].sort();
    for (const hook of requiredList) {
      if (!engine.hasCallablePath("protocols", protocol, hook)) {
        const users = modeHookUsers[hook] || [];
        if (users.length) {
          const mentioned = claim.supports.find((name) => users.includes(name)) || "";
          const suggested: string[] = [];
          for (const operation of definition.operations) {
            for (const mode of operation.modes) {
              if (engine.hasCallablePath("protocols", protocol, mode.hook) && !suggested.includes(mode.name)) suggested.push(mode.name);
            }
          }
          let message = `plugin ${key} protocol ${JSON.stringify(protocol)} supports ${JSON.stringify(mentioned)} but does not export protocols.${protocol}.${hook}; implement it`;
          if (suggested.length) message += ` or declare supports: [${quotedJoin(suggested, ", ")}]`;
          throw new Error(message);
        }
        throw new Error(`plugin ${key} protocol ${JSON.stringify(protocol)} is missing hook ${JSON.stringify(hook)}`);
      }
    }
    const seenModeHook = new Set<string>();
    for (const operation of definition.operations) {
      for (const mode of operation.modes) {
        if (seenModeHook.has(mode.hook)) continue;
        seenModeHook.add(mode.hook);
        if (required.has(mode.hook)) continue;
        if (engine.hasCallablePath("protocols", protocol, mode.hook)) {
          throw new Error(
            `plugin ${key} protocol ${JSON.stringify(protocol)} exports protocols.${protocol}.${mode.hook} but no supported mode uses it; add ${quotedJoin(modeHookUsers[mode.hook] || [], " or ")} to supports or remove the hook`,
          );
        }
      }
    }
    const protocolsValue = engine.export("protocols");
    if (!protocolsValue || typeof protocolsValue !== "object" || Array.isArray(protocolsValue)) {
      throw new Error(`plugin ${key} export protocols must be an object`);
    }
    const implementation = (protocolsValue as Record<string, unknown>)[protocol];
    if (!implementation || typeof implementation !== "object" || Array.isArray(implementation)) {
      throw new Error(`plugin ${key} protocol ${JSON.stringify(protocol)} must be an object`);
    }
    for (const member of Object.keys(implementation as object)) {
      if (!allowed.has(member)) throw new Error(`plugin ${key} protocol ${JSON.stringify(protocol)} has unsupported member ${JSON.stringify(member)}`);
    }
  }
  if (engine.hasExport("protocols")) {
    const protocolsObject = engine.export("protocols");
    if (protocolsObject && typeof protocolsObject === "object" && !Array.isArray(protocolsObject)) {
      const claimed = new Set(claims.map((item) => item.name));
      for (const name of Object.keys(protocolsObject as object)) {
        if (!claimed.has(name)) throw new Error(`plugin ${key} implements unclaimed protocol ${JSON.stringify(name)}`);
      }
    }
  }
  for (const removed of ["resolveRequest", "renderError", "renderers"]) {
    if (engine.hasExport(removed)) throw new Error(`plugin ${key} export ${JSON.stringify(removed)} is no longer supported`);
  }
  return { meta: object, engine };
}

export function validateRequestURL(requestURL: string, baseURL: string, allowedHosts: string[] = []): void {
  let request: URL;
  let base: URL;
  try {
    request = new URL(requestURL);
  } catch {
    throw new Error("plugin request URL must be absolute");
  }
  if (!request.protocol || !request.host) throw new Error("plugin request URL must be absolute");
  try {
    base = new URL(baseURL);
  } catch {
    throw new Error("channel base URL is invalid");
  }
  if (!base.host) throw new Error("channel base URL is invalid");
  const canonical = (value: URL) => {
    const host = value.hostname.toLowerCase();
    const port = value.port;
    const scheme = value.protocol.replace(":", "");
    if (!port || (port === "80" && scheme === "http") || (port === "443" && scheme === "https")) return host;
    return `${host}:${port}`;
  };
  if (canonical(request) === canonical(base)) return;
  for (const allowed of allowedHosts) {
    try {
      const allowedURL = new URL(request.protocol + "//" + String(allowed).trim());
      if (canonical(request) === canonical(allowedURL)) return;
    } catch {
      /* ignore */
    }
  }
  throw new Error(`plugin request host ${JSON.stringify(request.host)} is not allowed`);
}

export type DryRunRequest = { hook?: string; member?: string; args?: unknown[] };

export function dryRunPlugin(source: string, request: DryRunRequest, options: CompileOptions = {}): { ok: true; data: unknown } | { ok: false; message: string } {
  if (!request.hook) {
    return { ok: false, message: "Key: 'taskPluginDryRunRequest.Hook' Error:Field validation for 'Hook' failed on the 'required' tag" };
  }
  let loaded: LoadedPlugin;
  try {
    loaded = compilePlugin(source, { ...options, key: options.key || "" });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const args = Array.isArray(request.args) ? request.args : [];
  try {
    const output = request.member ? loaded.engine.callMember(request.hook, request.member, ...args) : loaded.engine.call(request.hook, ...args);
    return { ok: true, data: output === undefined ? null : output };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
