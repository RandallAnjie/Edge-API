/** Original `relaykit/relayconvert/internal/toolconv` ExtractHostedResponse + AttachHostedResponse JSON. Does not import convert.ts. */

import { asObj, compactJson } from "./openai-usage.js";

export type HostedKind = "web_search" | "mcp" | "web_fetch" | "code_execution" | "native";

export type HostedResponseItem = {
  kind: HostedKind;
  nativeType: string;
  id: string;
  callId: string;
  name: string;
  status: string;
  position: number;
  action?: unknown;
  results?: unknown;
  output?: unknown;
  error?: unknown;
  serverName: string;
  isError?: boolean;
  errorCode: string;
  caller?: unknown;
  arguments?: unknown;
  approvalRequestId?: string;
};

export type HostedResponseSet = {
  source: "claude" | "openai_responses" | "gemini";
  items: HostedResponseItem[];
  sourceLength: number;
  regularPositions: number[];
};

type PositionedResponsesOutput = {
  position: number;
  output: Record<string, unknown>;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function jsonType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  return t;
}

function rawJSONPresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized !== "" && normalized !== "null";
  }
  return true;
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value) return value;
  }
  return "";
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

function isClaudeHostedToolBlock(blockType: string): boolean {
  if (blockType === "server_tool_use" || blockType === "mcp_tool_use" || blockType === "mcp_tool_result") {
    return true;
  }
  return blockType.endsWith("_tool_result");
}

function isClaudeHostedResult(nativeType: string): boolean {
  return nativeType === "mcp_tool_result" || nativeType.endsWith("_tool_result");
}

function hostedKindFromClaudeCall(blockType: string, name: string): HostedKind {
  if (blockType === "mcp_tool_use") return "mcp";
  switch (name.trim()) {
    case "web_search":
      return "web_search";
    case "web_fetch":
      return "web_fetch";
    case "code_execution":
      return "code_execution";
    default:
      return "native";
  }
}

function hostedKindFromClaudeResult(blockType: string): HostedKind {
  switch (blockType.replace(/_tool_result$/, "")) {
    case "web_search":
      return "web_search";
    case "web_fetch":
      return "web_fetch";
    case "code_execution":
      return "code_execution";
    case "mcp":
      return "mcp";
    default:
      return "native";
  }
}

function responsesTypeFromHostedKind(kind: HostedKind): string {
  switch (kind) {
    case "web_search":
      return "web_search_call";
    case "mcp":
      return "mcp_call";
    default:
      return "";
  }
}

function claudeHostedResultFailure(
  blockType: string,
  content: unknown,
  explicitError: unknown,
  explicitCode: string,
): { failed: boolean; errorCode: string } {
  if (explicitError === true) return { failed: true, errorCode: explicitCode.trim() };
  if (explicitCode.trim()) return { failed: true, errorCode: explicitCode.trim() };
  if (!blockType.trim().endsWith("_tool_result") || jsonType(content) !== "object") {
    return { failed: false, errorCode: "" };
  }
  const resultError = asObj(content);
  const type = str(resultError.type).trim();
  const errorCode = str(resultError.error_code).trim();
  if (!type.endsWith("_error") && !errorCode) return { failed: false, errorCode: "" };
  return { failed: true, errorCode: errorCode };
}

function hostedItemFailed(item: HostedResponseItem): boolean {
  return item.status === "failed" || item.errorCode !== "" || rawJSONPresent(item.error) || item.isError === true;
}

function hostedCompletionStatus(item: HostedResponseItem): string {
  if (hostedItemFailed(item)) return "failed";
  if ((item.status !== "" && item.status !== "in_progress") || rawJSONPresent(item.results) || rawJSONPresent(item.output)) {
    return "completed";
  }
  return "in_progress";
}

/** Original `dto.NormalizeResponsesWebSearchAction`. */
export function normalizeResponsesWebSearchAction(raw: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(raw);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decode Responses web-search action: expected object");
  }
  const src = asObj(parsed);
  const type = str(src.type).trim();
  const query = str(src.query).trim();
  const url = str(src.url).trim();
  const pattern = str(src.pattern).trim();
  const queriesRaw = src.queries;
  const queries: string[] = [];
  if (Array.isArray(queriesRaw)) {
    for (let index = 0; index < queriesRaw.length; index++) {
      const item = str(queriesRaw[index]).trim();
      if (!item) throw new Error(`Responses web-search action queries[${index}] must not be empty`);
      queries.push(item);
    }
  } else if (queriesRaw != null) {
    throw new Error("decode Responses web-search action: queries must be an array");
  }
  let actionType = type;
  if (!actionType && (query || queries.length)) actionType = "search";
  switch (actionType) {
    case "search": {
      if (!query && !queries.length) {
        throw new Error(`Responses web-search action "${actionType}" requires query or queries`);
      }
      if (src.sources != null && jsonType(src.sources) !== "array" && jsonType(src.sources) !== "null") {
        throw new Error("Responses web-search action sources must be an array");
      }
      const action: Record<string, unknown> = { type: actionType };
      if (query) action.query = query;
      if (queries.length) action.queries = queries;
      if (src.sources != null && jsonType(src.sources) === "array") action.sources = src.sources;
      return action;
    }
    case "open_page": {
      if (!url) throw new Error(`Responses web-search action "${actionType}" requires url`);
      return { type: actionType, url };
    }
    case "find":
    case "find_in_page": {
      if (!url || !pattern) {
        throw new Error(`Responses web-search action "${actionType}" requires url and pattern`);
      }
      return { type: "find_in_page", url, pattern };
    }
    default:
      throw new Error(`unsupported Responses web-search action type ${JSON.stringify(actionType)}`);
  }
}

/** Original `responsesMCPArgumentsFromClaude`. */
export function responsesMCPArgumentsFromClaude(raw: unknown): string {
  const encoded = typeof raw === "string" ? raw.trim() : compactJson(raw);
  if (!encoded || jsonType(parseJsonValue(encoded)) !== "object") {
    throw new Error("Claude MCP input must be a JSON object");
  }
  return encoded;
}

function responsesMCPStringFromClaudeContent(raw: unknown): { encoded: string; normalized: boolean } {
  switch (jsonType(raw)) {
    case "string":
      return { encoded: str(raw), normalized: false };
    case "array": {
      const blocks = Array.isArray(raw) ? raw : [];
      if (!blocks.length) return { encoded: "", normalized: true };
      if (blocks.length !== 1) {
        throw new Error(`Responses MCP output cannot preserve ${blocks.length} Claude content blocks`);
      }
      const block = asObj(blocks[0]);
      if (str(block.type) !== "text") {
        throw new Error("Responses MCP output can only preserve a Claude text result block");
      }
      return { encoded: str(block.text), normalized: true };
    }
    default:
      throw new Error(`Responses MCP output cannot preserve Claude result type ${JSON.stringify(jsonType(raw))}`);
  }
}

function responsesMCPErrorFromClaudeContent(raw: unknown, errorCode: string): { encoded: string; normalized: boolean } {
  const code = errorCode.trim();
  if (code) return { encoded: code, normalized: false };
  return responsesMCPStringFromClaudeContent(raw);
}

function hostedOutputJson(output: Record<string, unknown>): Record<string, unknown> {
  const type = str(output.type);
  if (type === "web_search_call") {
    const json: Record<string, unknown> = { type, id: str(output.id) };
    if (output.status) json.status = output.status;
    if (output.action != null) json.action = output.action;
    return json;
  }
  if (type === "mcp_call") {
    const json: Record<string, unknown> = {
      type,
      id: str(output.id),
      name: str(output.name),
      server_label: str(output.server_label),
      arguments: output.arguments ?? null,
    };
    if (output.status) json.status = output.status;
    if (output.output != null) json.output = output.output;
    if (output.error != null) json.error = output.error;
    if (output.approval_request_id) json.approval_request_id = output.approval_request_id;
    return json;
  }
  return output;
}

function hostedOutsideRegularRange(hosted: number[], regular: number[]): { before: number[]; after: number[]; exact: boolean } {
  if (!regular.length) {
    return { before: hosted.map((_, index) => index), after: [], exact: true };
  }
  const firstRegular = regular[0];
  const lastRegular = regular[regular.length - 1];
  const before: number[] = [];
  const after: number[] = [];
  for (let index = 0; index < hosted.length; index++) {
    const position = hosted[index];
    if (position < firstRegular) before.push(index);
    else if (position > lastRegular) after.push(index);
    else return { before: [], after: [], exact: false };
  }
  return { before, after, exact: true };
}

function mergeResponsesOutput(
  regular: Record<string, unknown>[],
  hosted: PositionedResponsesOutput[],
  set: HostedResponseSet,
): Record<string, unknown>[] {
  if (!hosted.length) return regular;
  if (regular.length === set.regularPositions.length) {
    const byPosition = new Map<number, Record<string, unknown>[]>();
    for (const item of hosted) {
      const existing = byPosition.get(item.position) || [];
      existing.push(item.output);
      byPosition.set(item.position, existing);
    }
    const regularByPosition = new Map<number, Record<string, unknown>>();
    for (let index = 0; index < set.regularPositions.length; index++) {
      regularByPosition.set(set.regularPositions[index], regular[index]);
    }
    const merged: Record<string, unknown>[] = [];
    for (let position = 0; position < set.sourceLength; position++) {
      merged.push(...(byPosition.get(position) || []));
      const output = regularByPosition.get(position);
      if (output) merged.push(output);
    }
    return merged;
  }
  const { before, after, exact } = hostedOutsideRegularRange(
    hosted.map((item) => item.position),
    set.regularPositions,
  );
  if (exact) {
    const merged: Record<string, unknown>[] = [];
    for (const index of before) merged.push(hosted[index].output);
    merged.push(...regular);
    for (const index of after) merged.push(hosted[index].output);
    return merged;
  }
  return [...hosted.map((item) => item.output), ...regular];
}

/** Original `extractClaudeHostedResponse`. */
export function extractClaudeHostedResponse(response: Record<string, unknown>): {
  remaining: Record<string, unknown>;
  hosted: HostedResponseSet;
} {
  const content = Array.isArray(response.content) ? (response.content as Record<string, unknown>[]) : [];
  const remainingContent: Record<string, unknown>[] = [];
  const hosted: HostedResponseSet = {
    source: "claude",
    items: [],
    sourceLength: content.length,
    regularPositions: [],
  };
  for (let position = 0; position < content.length; position++) {
    const block = content[position] || {};
    const blockType = str(block.type).trim();
    if (blockType === "server_tool_use" || blockType === "mcp_tool_use") {
      hosted.items.push({
        kind: hostedKindFromClaudeCall(blockType, str(block.name)),
        nativeType: blockType,
        id: str(block.id),
        callId: str(block.id),
        name: str(block.name),
        status: "in_progress",
        position,
        action: block.input,
        caller: block.caller,
        serverName: str(block.server_name),
        errorCode: "",
      });
      continue;
    }
    if (isClaudeHostedToolBlock(blockType)) {
      const { failed, errorCode } = claudeHostedResultFailure(
        blockType,
        block.content,
        block.is_error,
        str(block.error_code),
      );
      let isError = typeof block.is_error === "boolean" ? block.is_error : undefined;
      let status = "completed";
      if (failed) {
        status = "failed";
        if (isError == null) isError = true;
      }
      hosted.items.push({
        kind: hostedKindFromClaudeResult(blockType),
        nativeType: blockType,
        id: str(block.tool_use_id),
        callId: str(block.tool_use_id),
        name: "",
        status,
        position,
        results: block.content,
        errorCode,
        isError,
        serverName: "",
      });
      continue;
    }
    remainingContent.push(block);
    hosted.regularPositions.push(position);
  }
  return { remaining: { ...response, content: remainingContent }, hosted };
}

/** Original `attachOpenAIHostedResponse` for Claude → OpenAI Responses JSON. */
export function attachOpenAIHostedResponse(
  response: Record<string, unknown>,
  set: HostedResponseSet,
): Record<string, unknown> {
  if (!set.items.length) return response;
  const hostedOutput: PositionedResponsesOutput[] = [];
  const convertedByID = new Map<string, number>();
  for (let index = 0; index < set.items.length; index++) {
    const item = set.items[index];
    const outputType = responsesTypeFromHostedKind(item.kind);
    if (!outputType) continue;
    if (isClaudeHostedResult(item.nativeType)) {
      const outputIndex = convertedByID.get(item.callId);
      if (outputIndex == null) continue;
      const output = hostedOutput[outputIndex].output;
      output.status = hostedCompletionStatus(item);
      if (item.kind === "mcp") {
        const failed = hostedItemFailed(item);
        let encoded: string;
        try {
          encoded = failed
            ? responsesMCPErrorFromClaudeContent(item.results, item.errorCode).encoded
            : responsesMCPStringFromClaudeContent(item.results).encoded;
        } catch {
          continue;
        }
        if (failed) {
          delete output.output;
          output.error = encoded;
        } else {
          output.output = encoded;
          delete output.error;
        }
      }
      continue;
    }
    const output: Record<string, unknown> = {
      type: outputType,
      id: firstNonEmpty(item.id, item.callId),
      status: hostedCompletionStatus(item),
    };
    if (item.kind === "web_search") {
      try {
        output.action = normalizeResponsesWebSearchAction(item.action);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`hosted_tools[${index}].action: ${message}`);
      }
    } else if (item.kind === "mcp") {
      if (!item.name.trim() || !item.serverName.trim()) continue;
      output.name = item.name;
      output.server_label = item.serverName;
      if (item.approvalRequestId) output.approval_request_id = item.approvalRequestId;
      const argumentsRaw = item.arguments ?? item.action;
      try {
        output.arguments = responsesMCPArgumentsFromClaude(argumentsRaw);
      } catch {
        continue;
      }
    }
    const outputIndex = hostedOutput.length;
    if (item.id) convertedByID.set(item.id, outputIndex);
    if (item.callId) convertedByID.set(item.callId, outputIndex);
    hostedOutput.push({ position: item.position, output: hostedOutputJson(output) });
  }
  const regular = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];
  response.output = mergeResponsesOutput(regular, hostedOutput, set);
  return response;
}
