/**
 * Original `pkg/jsplugin.JSONState` — bounded set/append/appendText against
 * `encoding/json` HTML-escaped byte accounting. Failure poisons the state.
 */
import { goJSONByteLength, goJSONMarshal } from "./jsplugin.js";
import { utf8Bytes } from "./jsplugin-sha256.js";

export const MAX_JSON_TOOL_BYTES = 1 << 20;
export const MAX_JSON_TOOL_DEPTH = 32;
export const MAX_JSON_TOOL_NODES = 32768;
const MAX_JSON_CHANGES = 256;

type JSONStateNode = {
  scalar?: unknown;
  object?: Map<string, JSONStateNode>;
  array?: JSONStateNode[];
  text?: string;
  bytes: number;
  nodes: number;
};

type JSONStateBudget = { bytes: number; nodes: number; signal?: AbortSignal };

function asGoRunes(value: string): string {
  return new TextDecoder("utf-8").decode(utf8Bytes(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function spend(budget: JSONStateBudget, bytes: number, nodes: number): void {
  if (budget.signal?.aborted) throw abortError(budget.signal);
  if (bytes > budget.bytes || nodes > budget.nodes) throw new Error("JSON state exceeds size or node limit");
  budget.bytes -= bytes;
  budget.nodes -= nodes;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason == null ? "The operation was aborted" : String(reason));
  err.name = "AbortError";
  return err;
}

function newJSONStateNode(value: unknown, depth: number, budget: JSONStateBudget): JSONStateNode {
  if (depth > MAX_JSON_TOOL_DEPTH) throw new Error("JSON state exceeds depth limit");
  if (value === undefined) throw new Error("undefined is not a JSON value");
  if (typeof value === "function" || typeof value === "bigint" || typeof value === "symbol") {
    throw new Error("value must contain only JSON objects, arrays and scalars");
  }
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
    } else if (!isPlainObject(value)) {
      throw new Error("json.clone accepts only plain objects, arrays and JSON scalars");
    }
  }
  const beforeBytes = budget.bytes;
  const beforeNodes = budget.nodes;
  spend(budget, 0, 1);
  const node: JSONStateNode = { bytes: 0, nodes: 0 };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > budget.nodes) throw new Error("JSON object exceeds node limit");
    spend(budget, 2, 0);
    node.object = new Map();
    for (const key of keys) {
      const normalized = asGoRunes(key);
      if (normalized !== key || utf8Bytes(key).length > budget.bytes) {
        throw new Error("invalid or oversized JSON object key");
      }
      const encoded = goJSONByteLength(key);
      let cost = encoded + 1;
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
      if (utf8Bytes(scalar).length > budget.bytes) throw new Error("JSON string exceeds size limit");
      scalar = asGoRunes(scalar);
    } else if (typeof scalar === "number") {
      if (!Number.isFinite(scalar)) throw new Error("JSON numbers must be finite");
    } else if (scalar !== null && typeof scalar !== "boolean") {
      throw new Error("value must contain only JSON objects, arrays and scalars");
    }
    spend(budget, goJSONByteLength(scalar), 0);
    node.scalar = scalar;
  }
  node.bytes = beforeBytes - budget.bytes;
  node.nodes = beforeNodes - budget.nodes;
  return node;
}

function nodeValue(node: JSONStateNode): unknown {
  if (node.object) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of node.object) result[key] = nodeValue(child);
    return result;
  }
  if (node.array) return node.array.map(nodeValue);
  if (node.text !== undefined) return node.text;
  return node.scalar ?? null;
}

function arrayIndex(segment: unknown, length: number): number {
  let number: number;
  if (typeof segment === "number") number = segment;
  else throw new Error("JSON array paths require integer indices");
  if (!Number.isFinite(number) || number < 0 || number >= length || Math.trunc(number) !== number) {
    throw new Error("JSON array index is out of range");
  }
  return number;
}

export class JSONState {
  private root: JSONStateNode;
  readonly limit: number;
  private failed: Error | null = null;

  constructor(limit: number) {
    this.root = { bytes: 4, nodes: 1, scalar: null };
    this.limit = Math.max(0, Math.min(limit, MAX_JSON_TOOL_BYTES));
  }

  apply(changes: unknown, signal?: AbortSignal): void {
    if (this.failed) throw this.failed;
    try {
      if (signal?.aborted) throw abortError(signal);
      if (!Array.isArray(changes) || changes.length > MAX_JSON_CHANGES) {
        throw new Error(`changes must be an array of at most ${MAX_JSON_CHANGES} operations`);
      }
      for (const item of changes) {
        if (signal?.aborted) throw abortError(signal);
        if (!isPlainObject(item) || Object.keys(item).length !== 3) {
          throw new Error("each change must contain only op, path and value");
        }
        const op = typeof item.op === "string" ? item.op : "";
        const path = item.path;
        const hasValue = Object.prototype.hasOwnProperty.call(item, "value");
        if (!Array.isArray(path) || !hasValue || path.length > MAX_JSON_TOOL_DEPTH) {
          throw new Error(`change requires a JSON value and a path of at most ${MAX_JSON_TOOL_DEPTH} segments`);
        }
        if (op !== "set" && op !== "append" && op !== "appendText") {
          throw new Error(`unsupported JSON change operation ${JSON.stringify(op)}`);
        }
        const ancestors: JSONStateNode[] = [];
        let target: JSONStateNode | undefined = this.root;
        let key = "";
        let index = 0;
        for (let offset = 0; offset < path.length; offset++) {
          if (!target) throw new Error("JSON change parent does not exist");
          ancestors.push(target);
          const segment = path[offset];
          if (target.object) {
            if (typeof segment !== "string") throw new Error("JSON object paths require valid string keys");
            const normalized = asGoRunes(segment);
            if (normalized !== segment || utf8Bytes(segment).length > this.limit) {
              throw new Error("JSON object paths require valid string keys");
            }
            key = segment;
            target = target.object.get(key);
          } else if (target.array) {
            index = arrayIndex(segment, target.array.length);
            target = target.array[index];
          } else {
            throw new Error("JSON change path traverses a scalar");
          }
          if (!target && (offset !== path.length - 1 || op !== "set")) {
            throw new Error("JSON change target does not exist");
          }
        }
        let addedBytes = 0;
        let addedNodes = 0;
        if (op === "set") {
          let oldBytes = 0;
          let oldNodes = 0;
          if (target) {
            oldBytes = target.bytes;
            oldNodes = target.nodes;
          } else {
            addedBytes = goJSONByteLength(key) + 1;
            if ((ancestors[ancestors.length - 1]?.object?.size || 0) !== 0) addedBytes += 1;
          }
          const budget: JSONStateBudget = {
            bytes: this.limit - this.root.bytes + oldBytes - addedBytes,
            nodes: MAX_JSON_TOOL_NODES - this.root.nodes + oldNodes,
            signal,
          };
          const next = newJSONStateNode(item.value, path.length, budget);
          addedBytes += next.bytes - oldBytes;
          addedNodes = next.nodes - oldNodes;
          if (ancestors.length === 0) this.root = next;
          else {
            const parent = ancestors[ancestors.length - 1];
            if (parent.object) parent.object.set(key, next);
            else if (parent.array) parent.array[index] = next;
          }
        } else if (op === "append") {
          if (!target?.array) throw new Error("append requires an array target");
          if (target.array.length !== 0) addedBytes = 1;
          const budget: JSONStateBudget = {
            bytes: this.limit - this.root.bytes - addedBytes,
            nodes: MAX_JSON_TOOL_NODES - this.root.nodes,
            signal,
          };
          const next = newJSONStateNode(item.value, path.length + 1, budget);
          addedBytes += next.bytes;
          addedNodes = next.nodes;
          target.array.push(next);
          target.bytes += addedBytes;
          target.nodes += addedNodes;
        } else {
          const previous = target?.text !== undefined ? target.text : target?.scalar;
          const isText = typeof previous === "string";
          const textRaw = item.value;
          const text = typeof textRaw === "string" ? asGoRunes(textRaw) : "";
          if (!target || !isText || typeof textRaw !== "string" || utf8Bytes(textRaw).length > this.limit - this.root.bytes) {
            throw new Error("appendText requires strings within the state size limit");
          }
          addedBytes = goJSONByteLength(text) - 2;
          if (addedBytes > this.limit - this.root.bytes) throw new Error("JSON state exceeds size limit");
          if (text !== "") {
            if (target.text === undefined) {
              target.text = String(previous);
              target.scalar = "";
            }
            target.text += text;
          }
          target.bytes += addedBytes;
        }
        for (const ancestor of ancestors) {
          ancestor.bytes += addedBytes;
          ancestor.nodes += addedNodes;
        }
      }
    } catch (err) {
      this.failed = err instanceof Error ? err : new Error(String(err));
      throw this.failed;
    }
  }

  value(): unknown {
    if (this.failed) throw this.failed;
    const value = nodeValue(this.root);
    const encoded = goJSONMarshal(value);
    const size = utf8Bytes(encoded).length;
    if (size !== this.root.bytes || size > this.limit) {
      throw new Error("JSON state encoded size does not match its bounded representation");
    }
    return value;
  }
}

export function newJSONState(limit: number): JSONState {
  return new JSONState(limit);
}
