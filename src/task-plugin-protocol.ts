/**
 * Original `relay.PluginResponsesMachine` + `DecodePluginProtocolEventResult`.
 * IO-free host Responses envelope used by claimed openai_responses create.
 */

export const PLUGIN_RESPONSE_STATUS_IN_PROGRESS = "in_progress";
export const PLUGIN_RESPONSE_STATUS_COMPLETED = "completed";
export const PLUGIN_RESPONSE_STATUS_FAILED = "failed";
export const PLUGIN_RESPONSE_STATUS_INCOMPLETE = "incomplete";
export const PLUGIN_RESPONSE_STATUS_QUEUED = "queued";

export type PluginProtocolLimits = {
  maxEventsPerTick: number;
  maxEventsBytes: number;
  maxEventBytes: number;
  maxEventDepth: number;
  maxStateBytes: number;
  maxStateDepth: number;
  maxOutputs: number;
  maxTotalOutputBytes: number;
  maxMessageBytes: number;
  maxMetadataValueBytes: number;
  maxCodeBytes: number;
};

export function defaultPluginProtocolLimits(): PluginProtocolLimits {
  return {
    maxEventsPerTick: 16,
    maxEventsBytes: 64 << 10,
    maxEventBytes: 32 << 10,
    maxEventDepth: 16,
    maxStateBytes: 16 << 10,
    maxStateDepth: 16,
    maxOutputs: 64,
    maxTotalOutputBytes: 1 << 20,
    maxMessageBytes: 4 << 10,
    maxMetadataValueBytes: 512,
    maxCodeBytes: 128,
  };
}

function withLimitDefaults(limits: Partial<PluginProtocolLimits> = {}): PluginProtocolLimits {
  const defaults = defaultPluginProtocolLimits();
  return {
    maxEventsPerTick: limits.maxEventsPerTick && limits.maxEventsPerTick > 0 ? limits.maxEventsPerTick : defaults.maxEventsPerTick,
    maxEventsBytes: limits.maxEventsBytes && limits.maxEventsBytes > 0 ? limits.maxEventsBytes : defaults.maxEventsBytes,
    maxEventBytes: limits.maxEventBytes && limits.maxEventBytes > 0 ? limits.maxEventBytes : defaults.maxEventBytes,
    maxEventDepth: limits.maxEventDepth && limits.maxEventDepth > 0 ? limits.maxEventDepth : defaults.maxEventDepth,
    maxStateBytes: limits.maxStateBytes && limits.maxStateBytes > 0 ? limits.maxStateBytes : defaults.maxStateBytes,
    maxStateDepth: limits.maxStateDepth && limits.maxStateDepth > 0 ? limits.maxStateDepth : defaults.maxStateDepth,
    maxOutputs: limits.maxOutputs && limits.maxOutputs > 0 ? limits.maxOutputs : defaults.maxOutputs,
    maxTotalOutputBytes: limits.maxTotalOutputBytes && limits.maxTotalOutputBytes > 0 ? limits.maxTotalOutputBytes : defaults.maxTotalOutputBytes,
    maxMessageBytes: limits.maxMessageBytes && limits.maxMessageBytes > 0 ? limits.maxMessageBytes : defaults.maxMessageBytes,
    maxMetadataValueBytes: limits.maxMetadataValueBytes && limits.maxMetadataValueBytes > 0 ? limits.maxMetadataValueBytes : defaults.maxMetadataValueBytes,
    maxCodeBytes: limits.maxCodeBytes && limits.maxCodeBytes > 0 ? limits.maxCodeBytes : defaults.maxCodeBytes,
  };
}

export type ProtocolState = {
  present: boolean;
  null: boolean;
  value: unknown;
};

export type ProtocolSemanticEvent = {
  type: string;
  progress?: number;
  message?: string;
  data?: unknown;
  code?: string;
};

export type ProtocolEventResult = {
  events: ProtocolSemanticEvent[];
  state: ProtocolState;
  done: boolean;
};

export type PluginResponsesError = { code: string; message: string };
export type PluginResponsesIncompleteDetail = { reason: string };
export type PluginResponsesUsage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};
export type PluginResponsesContent = {
  id: string;
  type: string;
  text: string;
  annotations: unknown[];
  logprobs: unknown[];
  refusal?: string;
};
export type PluginResponsesOutput = {
  id: string;
  type: string;
  status: string;
  role: string;
  content: PluginResponsesContent[];
};
export type PluginResponsesResponse = {
  id: string;
  object: string;
  created_at: number;
  status: string;
  error: PluginResponsesError | null;
  incomplete_details: PluginResponsesIncompleteDetail | null;
  instructions: unknown;
  model: string;
  output: PluginResponsesOutput[];
  parallel_tool_calls: boolean;
  temperature: number;
  tool_choice: unknown;
  tools: unknown[];
  top_p: number;
  metadata: Record<string, string>;
  usage: PluginResponsesUsage | null;
};

export type PluginResponsesStreamEvent = {
  type: string;
  sequence_number: number;
  response?: PluginResponsesResponse;
  output_index?: number;
  content_index?: number;
  item_id?: string;
  item?: PluginResponsesOutput;
  part?: PluginResponsesContent;
  delta?: string;
  text?: string;
  logprobs?: unknown[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

function marshalJSON(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

function pluginJSONDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let maxChild = 0;
    for (const child of value) maxChild = Math.max(maxChild, pluginJSONDepth(child));
    return 1 + maxChild;
  }
  if (isPlainObject(value)) {
    let maxChild = 0;
    for (const child of Object.values(value)) maxChild = Math.max(maxChild, pluginJSONDepth(child));
    return 1 + maxChild;
  }
  return 1;
}

function decodeBoundedProtocolString(raw: unknown, field: string, maxBytes: number, required: boolean): string {
  if (typeof raw !== "string") throw new Error(`${field} must be a string`);
  if (required && !raw.trim()) throw new Error(`${field} is required`);
  if (utf8Len(raw) > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes`);
  return raw;
}

function rejectUnknownProtocolFields(fields: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(fields)) {
    if (!allowedSet.has(name)) throw new Error(`protocol event contains unknown field ${JSON.stringify(name)}`);
  }
}

function decodePluginSemanticEvent(raw: unknown, limits: PluginProtocolLimits): ProtocolSemanticEvent {
  const encoded = marshalJSON(raw);
  if (utf8Len(encoded) > limits.maxEventBytes) throw new Error(`protocol event exceeds ${limits.maxEventBytes} bytes`);
  const parsed = JSON.parse(encoded) as unknown;
  if (!isPlainObject(parsed)) throw new Error("protocol event must be a JSON object");
  if (pluginJSONDepth(parsed) > limits.maxEventDepth) {
    throw new Error(`protocol event exceeds depth limit of ${limits.maxEventDepth}`);
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "type") || parsed.type == null) {
    throw new Error("protocol event type is required");
  }
  if (typeof parsed.type !== "string") throw new Error("protocol event type must be a string");
  const event: ProtocolSemanticEvent = { type: parsed.type };
  switch (parsed.type) {
    case "progress": {
      rejectUnknownProtocolFields(parsed, ["type", "progress", "message"]);
      if (Object.prototype.hasOwnProperty.call(parsed, "progress")) {
        if (typeof parsed.progress !== "number" || !Number.isFinite(parsed.progress)) {
          throw new Error("progress event progress must be a number");
        }
        if (parsed.progress < 0 || parsed.progress > 100) {
          throw new Error("progress event progress must be between 0 and 100");
        }
        event.progress = parsed.progress;
      }
      if (Object.prototype.hasOwnProperty.call(parsed, "message")) {
        event.message = decodeBoundedProtocolString(parsed.message, "progress event message", limits.maxMetadataValueBytes, false);
      }
      return event;
    }
    case "output": {
      rejectUnknownProtocolFields(parsed, ["type", "data"]);
      if (!Object.prototype.hasOwnProperty.call(parsed, "data")) throw new Error("output event data is required");
      const dataEncoded = marshalJSON(parsed.data);
      if (utf8Len(dataEncoded) > limits.maxEventBytes) throw new Error(`output event data exceeds ${limits.maxEventBytes} bytes`);
      event.data = parsed.data;
      return event;
    }
    case "error": {
      rejectUnknownProtocolFields(parsed, ["type", "code", "message"]);
      if (!Object.prototype.hasOwnProperty.call(parsed, "message")) throw new Error("error event message is required");
      event.message = decodeBoundedProtocolString(parsed.message, "error event message", limits.maxMessageBytes, true);
      if (Object.prototype.hasOwnProperty.call(parsed, "code")) {
        event.code = decodeBoundedProtocolString(parsed.code, "error event code", limits.maxCodeBytes, false);
      }
      return event;
    }
    default:
      throw new Error(`unsupported protocol event type ${JSON.stringify(parsed.type)}`);
  }
}

/** Original `DecodePluginProtocolEventResult`. */
export function decodePluginProtocolEventResult(value: unknown, limits: Partial<PluginProtocolLimits> = {}): ProtocolEventResult {
  const resolved = withLimitDefaults(limits);
  let encoded: string;
  try {
    encoded = marshalJSON(value);
  } catch (err) {
    throw new Error(`protocol event result is not JSON-compatible: ${err instanceof Error ? err.message : String(err)}`);
  }
  const maxResultBytes = resolved.maxEventsBytes + resolved.maxStateBytes + 4096;
  if (utf8Len(encoded) > maxResultBytes) throw new Error(`protocol event result exceeds ${maxResultBytes} bytes`);
  const parsed = JSON.parse(encoded) as unknown;
  if (!isPlainObject(parsed)) throw new Error("protocol event result must be an object");
  for (const name of Object.keys(parsed)) {
    if (name !== "events" && name !== "state" && name !== "done") {
      throw new Error(`protocol event result contains unknown field ${JSON.stringify(name)}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "events") || parsed.events == null) {
    throw new Error("protocol event result events must be an array");
  }
  const eventsEncoded = marshalJSON(parsed.events);
  if (utf8Len(eventsEncoded) > resolved.maxEventsBytes) throw new Error(`protocol events exceed ${resolved.maxEventsBytes} bytes`);
  if (!Array.isArray(parsed.events)) throw new Error("protocol event result events must be an array");
  if (parsed.events.length > resolved.maxEventsPerTick) {
    throw new Error(`protocol events exceed limit of ${resolved.maxEventsPerTick}`);
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "done") || parsed.done == null || typeof parsed.done !== "boolean") {
    throw new Error("protocol event result done must be a boolean");
  }
  const result: ProtocolEventResult = { events: [], done: parsed.done, state: { present: false, null: false, value: undefined } };
  for (const rawEvent of parsed.events) result.events.push(decodePluginSemanticEvent(rawEvent, resolved));
  if (Object.prototype.hasOwnProperty.call(parsed, "state")) {
    const stateEncoded = marshalJSON(parsed.state);
    if (utf8Len(stateEncoded) > resolved.maxStateBytes) throw new Error(`protocol state exceeds ${resolved.maxStateBytes} bytes`);
    if (pluginJSONDepth(parsed.state) > resolved.maxStateDepth) {
      throw new Error(`protocol state exceeds depth limit of ${resolved.maxStateDepth}`);
    }
    result.state = { present: true, null: parsed.state === null, value: parsed.state };
  }
  return result;
}

export function pluginTaskStatus(taskStatus: string): string {
  switch (String(taskStatus || "").trim().toUpperCase()) {
    case "SUCCESS":
      return PLUGIN_RESPONSE_STATUS_COMPLETED;
    case "FAILURE":
      return PLUGIN_RESPONSE_STATUS_FAILED;
    case "IN_PROGRESS":
      return PLUGIN_RESPONSE_STATUS_IN_PROGRESS;
    case "NOT_START":
    case "SUBMITTED":
    case "QUEUED":
    case "UNKNOWN":
    case "":
      return PLUGIN_RESPONSE_STATUS_QUEUED;
    default:
      return PLUGIN_RESPONSE_STATUS_QUEUED;
  }
}

function pluginOutputText(data: unknown): string {
  if (data === undefined) throw new Error("output event data is required");
  if (typeof data === "string") return data;
  try {
    return marshalJSON(data);
  } catch {
    throw new Error("output event data must be JSON-compatible");
  }
}

function zeroPluginResponsesUsage(): PluginResponsesUsage {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

function cloneOutput(output: PluginResponsesOutput): PluginResponsesOutput {
  return { ...output, content: output.content.map((part) => ({ ...part, annotations: [...part.annotations], logprobs: [...part.logprobs] })) };
}

function formatGoFloat(value: number): string {
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function normalizeFinalResponseNumber(response: Record<string, unknown>, field: string, defaultValue: number, minimum: number, maximum: number): void {
  if (!Object.prototype.hasOwnProperty.call(response, field)) {
    response[field] = defaultValue;
    return;
  }
  const number = response[field];
  if (typeof number !== "number" || !Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`final response ${field} must be between ${minimum} and ${maximum}`);
  }
}

function normalizeFinalResponseDefaults(response: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(response, "instructions")) {
    const instructions = response.instructions;
    if (instructions !== null && typeof instructions !== "string" && !Array.isArray(instructions)) {
      throw new Error("final response instructions must be null, a string, or an array");
    }
  } else {
    response.instructions = null;
  }
  if (Object.prototype.hasOwnProperty.call(response, "parallel_tool_calls")) {
    if (typeof response.parallel_tool_calls !== "boolean") throw new Error("final response parallel_tool_calls must be a boolean");
  } else {
    response.parallel_tool_calls = true;
  }
  normalizeFinalResponseNumber(response, "temperature", 1, 0, 2);
  if (Object.prototype.hasOwnProperty.call(response, "tool_choice")) {
    const toolChoice = response.tool_choice;
    if (typeof toolChoice !== "string" && !isPlainObject(toolChoice)) {
      throw new Error("final response tool_choice must be a string or object");
    }
  } else {
    response.tool_choice = "auto";
  }
  if (Object.prototype.hasOwnProperty.call(response, "tools")) {
    if (!Array.isArray(response.tools)) throw new Error("final response tools must be an array");
  } else {
    response.tools = [];
  }
  normalizeFinalResponseNumber(response, "top_p", 1, 0, 1);
}

/** Original `relay.PluginResponsesMachine`. */
export class PluginResponsesMachine {
  taskID: string;
  responseID: string;
  model: string;
  createdAt: number;
  limits: PluginProtocolLimits;
  nextSequence = 0;
  started = false;
  terminal = false;
  status = PLUGIN_RESPONSE_STATUS_IN_PROGRESS;
  metadata: Record<string, string>;
  outputs: PluginResponsesOutput[] = [];
  totalOutputBytes = 0;
  usage: PluginResponsesUsage | null = null;
  background = false;

  constructor(taskID: string, model: string, createdAt: number, limits: Partial<PluginProtocolLimits> = {}) {
    this.taskID = String(taskID || "").trim();
    this.responseID = "resp_" + this.taskID.replace(/^task_/, "");
    this.model = model;
    this.createdAt = createdAt;
    this.limits = withLimitDefaults(limits);
    this.metadata = {
      task_id: this.taskID,
      task_status: PLUGIN_RESPONSE_STATUS_QUEUED,
      retrieval_path: "/v1/responses/" + this.responseID,
    };
  }

  setBackground(background: boolean): void {
    this.background = background;
  }

  /** Original `PendingResponse`. */
  pendingResponse(taskStatus: string): Record<string, unknown> {
    let status = pluginTaskStatus(taskStatus);
    if (status !== PLUGIN_RESPONSE_STATUS_QUEUED && status !== PLUGIN_RESPONSE_STATUS_IN_PROGRESS) {
      status = PLUGIN_RESPONSE_STATUS_IN_PROGRESS;
    }
    return {
      id: this.responseID,
      object: "response",
      created_at: this.createdAt,
      status,
      background: this.background,
      completed_at: null,
      error: null,
      incomplete_details: null,
      model: this.model,
      output: [],
      usage: null,
      metadata: {
        task_id: this.taskID,
        task_status: status,
        retrieval_path: "/v1/responses/" + this.responseID,
      },
    };
  }

  createdEvent(): PluginResponsesStreamEvent {
    if (this.started) throw new Error("response.created was already emitted");
    if (this.terminal) throw new Error("response is already terminal");
    this.started = true;
    return this.responseEvent("response.created");
  }

  applyTick(result: ProtocolEventResult, taskStatus: string): PluginResponsesStreamEvent[] {
    if (!this.started) throw new Error("response.created must be emitted before applying events");
    if (this.terminal) throw new Error("response is already terminal");
    if (String(taskStatus || "").trim().toUpperCase() === "FAILURE") {
      this.metadata.task_status = PLUGIN_RESPONSE_STATUS_FAILED;
      return [this.fail("server_error", "The task failed.")];
    }
    const outputTexts = new Map<number, string>();
    let additionalBytes = 0;
    let additionalOutputs = 0;
    for (const [index, event] of result.events.entries()) {
      switch (event.type) {
        case "progress":
          if (event.progress != null && (!Number.isFinite(event.progress) || event.progress < 0 || event.progress > 100)) {
            throw new Error("progress event progress must be between 0 and 100");
          }
          if (event.message != null && utf8Len(event.message) > this.limits.maxMetadataValueBytes) {
            throw new Error(`progress event message exceeds ${this.limits.maxMetadataValueBytes} bytes`);
          }
          break;
        case "output": {
          const text = pluginOutputText(event.data);
          if (utf8Len(text) > this.limits.maxEventBytes) throw new Error(`output event data exceeds ${this.limits.maxEventBytes} bytes`);
          outputTexts.set(index, text);
          additionalBytes += utf8Len(text);
          additionalOutputs += 1;
          break;
        }
        case "error":
          if (!event.message || !event.message.trim()) throw new Error("error event message is required");
          break;
        default:
          throw new Error(`unsupported protocol event type ${JSON.stringify(event.type)}`);
      }
    }
    if (this.outputs.length + additionalOutputs > this.limits.maxOutputs) {
      throw new Error(`response outputs exceed limit of ${this.limits.maxOutputs}`);
    }
    if (this.totalOutputBytes + additionalBytes > this.limits.maxTotalOutputBytes) {
      throw new Error(`response output exceeds cumulative limit of ${this.limits.maxTotalOutputBytes} bytes`);
    }
    this.metadata.task_status = pluginTaskStatus(taskStatus);
    const events: PluginResponsesStreamEvent[] = [];
    for (const [index, semantic] of result.events.entries()) {
      switch (semantic.type) {
        case "progress":
          if (semantic.progress != null) this.metadata.task_progress = formatGoFloat(semantic.progress);
          if (semantic.message != null) this.metadata.task_message = semantic.message;
          if (!this.outputs.length) events.push(this.progressEvent());
          break;
        case "output":
          events.push(...this.appendOutput(outputTexts.get(index) || ""));
          break;
        case "error":
          events.push(this.fail("server_error", "The task failed."));
          return events;
      }
    }
    switch (String(taskStatus || "").trim().toUpperCase()) {
      case "SUCCESS":
        events.push(this.complete());
        break;
      case "FAILURE":
        events.push(this.fail("server_error", "The task failed."));
        break;
      default:
        if (result.done) events.push(this.incomplete());
    }
    return events;
  }

  failureEvent(taskStatus?: string): PluginResponsesStreamEvent {
    if (!this.started) throw new Error("response.created must be emitted before response.failed");
    if (this.terminal) throw new Error("response is already terminal");
    this.setPersistedTaskStatus(taskStatus);
    return this.fail("server_error", "The task could not be observed.");
  }

  timeoutEvent(taskStatus?: string): PluginResponsesStreamEvent {
    if (!this.started) throw new Error("response.created must be emitted before response.incomplete");
    if (this.terminal) throw new Error("response is already terminal");
    this.setPersistedTaskStatus(taskStatus);
    return this.incomplete();
  }

  finalResponse(payload: unknown, taskStatus: string): Record<string, unknown> {
    if (this.started || this.terminal) throw new Error("response state machine has already started");
    switch (String(taskStatus || "").trim().toUpperCase()) {
      case "SUCCESS": {
        const response = this.canonicalFinalResponse(payload);
        this.status = PLUGIN_RESPONSE_STATUS_COMPLETED;
        this.metadata.task_status = PLUGIN_RESPONSE_STATUS_COMPLETED;
        response.id = this.responseID;
        response.object = "response";
        response.created_at = this.createdAt;
        response.status = PLUGIN_RESPONSE_STATUS_COMPLETED;
        response.error = null;
        response.incomplete_details = null;
        response.model = this.model;
        response.metadata = this.finalMetadata(response.metadata);
        response.usage = zeroPluginResponsesUsage();
        delete response.sequence_number;
        this.terminal = true;
        return response;
      }
      case "FAILURE":
        this.status = PLUGIN_RESPONSE_STATUS_FAILED;
        this.metadata.task_status = PLUGIN_RESPONSE_STATUS_FAILED;
        break;
      default:
        throw new Error("final response requires a terminal task");
    }
    this.terminal = true;
    return this.responseSnapshotJSON({ code: "server_error", message: "The task failed." });
  }

  finalFromEvents(result: ProtocolEventResult, taskStatus: string): Record<string, unknown> {
    if (this.started || this.terminal) throw new Error("response state machine has already started");
    const scratch = new PluginResponsesMachine(this.taskID, this.model, this.createdAt, this.limits);
    scratch.background = this.background;
    scratch.started = true;
    scratch.applyTick(result, taskStatus);
    if (!scratch.terminal) throw new Error("renderEvents did not terminate at terminal task status");
    if (scratch.status !== PLUGIN_RESPONSE_STATUS_COMPLETED) {
      throw new Error("renderEvents reported failure at terminal task status");
    }
    this.copyFrom(scratch);
    return this.responseSnapshotJSON(null);
  }

  failureResponse(taskStatus?: string): PluginResponsesResponse {
    if (this.started || this.terminal) throw new Error("response state machine has already started");
    this.status = PLUGIN_RESPONSE_STATUS_FAILED;
    this.setPersistedTaskStatus(taskStatus);
    this.terminal = true;
    return this.responseSnapshot({ code: "server_error", message: "The task could not be observed." });
  }

  timeoutResponse(taskStatus?: string): PluginResponsesResponse {
    if (this.started || this.terminal) throw new Error("response state machine has already started");
    this.status = PLUGIN_RESPONSE_STATUS_QUEUED;
    const lastStatus = taskStatus || "";
    let persisted = pluginTaskStatus(lastStatus);
    if (!persisted) persisted = PLUGIN_RESPONSE_STATUS_QUEUED;
    this.metadata.task_status = persisted;
    this.terminal = true;
    return this.responseSnapshot(null);
  }

  private copyFrom(other: PluginResponsesMachine): void {
    this.taskID = other.taskID;
    this.responseID = other.responseID;
    this.model = other.model;
    this.createdAt = other.createdAt;
    this.limits = other.limits;
    this.nextSequence = other.nextSequence;
    this.started = other.started;
    this.terminal = other.terminal;
    this.status = other.status;
    this.metadata = { ...other.metadata };
    this.outputs = other.outputs.map(cloneOutput);
    this.totalOutputBytes = other.totalOutputBytes;
    this.usage = other.usage ? { ...other.usage, input_tokens_details: { ...other.usage.input_tokens_details }, output_tokens_details: { ...other.usage.output_tokens_details } } : null;
    this.background = other.background;
  }

  private canonicalFinalResponse(payload: unknown): Record<string, unknown> {
    let encoded: string;
    try {
      encoded = marshalJSON(payload);
    } catch (err) {
      throw new Error(`final response is not JSON-compatible: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (utf8Len(encoded) > this.limits.maxTotalOutputBytes + (64 << 10)) {
      throw new Error(`final response exceeds ${this.limits.maxTotalOutputBytes + (64 << 10)} bytes`);
    }
    const decoded = JSON.parse(encoded) as unknown;
    if (pluginJSONDepth(decoded) > this.limits.maxEventDepth) {
      throw new Error(`final response exceeds depth limit of ${this.limits.maxEventDepth}`);
    }
    if (!isPlainObject(decoded)) throw new Error("final response must be an object");
    let output: unknown[] = [];
    if (Object.prototype.hasOwnProperty.call(decoded, "output")) {
      if (!Array.isArray(decoded.output)) throw new Error("final response output must be an array");
      output = decoded.output;
    }
    if (output.length > this.limits.maxOutputs) throw new Error(`response outputs exceed limit of ${this.limits.maxOutputs}`);
    for (const [outputIndex, rawItem] of output.entries()) {
      if (!isPlainObject(rawItem)) throw new Error("final response output items must be objects");
      if (rawItem.type !== "message") throw new Error("final response output items must be message objects");
      if (rawItem.role !== "assistant") throw new Error("final response message role must be assistant");
      rawItem.id = `item_${this.taskID}_${outputIndex}`;
      rawItem.status = PLUGIN_RESPONSE_STATUS_COMPLETED;
      if (!Object.prototype.hasOwnProperty.call(rawItem, "content")) {
        throw new Error("final response message content must be an array");
      }
      const content = rawItem.content;
      if (!Array.isArray(content) || content.length > this.limits.maxOutputs) {
        throw new Error(`final response output content must contain at most ${this.limits.maxOutputs} objects`);
      }
      for (const [contentIndex, rawPart] of content.entries()) {
        if (!isPlainObject(rawPart)) throw new Error("final response output content parts must be objects");
        if (typeof rawPart.type !== "string") throw new Error("final response content part type is required");
        switch (rawPart.type) {
          case "output_text":
            if (typeof rawPart.text !== "string") throw new Error("final response output_text text must be a string");
            if (!Array.isArray(rawPart.annotations)) throw new Error("final response output_text annotations must be an array");
            if (!Array.isArray(rawPart.logprobs)) throw new Error("final response output_text logprobs must be an array");
            break;
          case "refusal":
            if (typeof rawPart.refusal !== "string") throw new Error("final response refusal must be a string");
            break;
          default:
            throw new Error(`unsupported final response content part type ${JSON.stringify(rawPart.type)}`);
        }
        rawPart.id = `content_${this.taskID}_${outputIndex}_${contentIndex}`;
      }
    }
    const encodedOutput = marshalJSON(output);
    if (utf8Len(encodedOutput) > this.limits.maxTotalOutputBytes) {
      throw new Error(`final response output exceeds ${this.limits.maxTotalOutputBytes} bytes`);
    }
    decoded.output = output;
    normalizeFinalResponseDefaults(decoded);
    return decoded;
  }

  private finalMetadata(pluginValue: unknown): Record<string, string> {
    const metadata: Record<string, string> = {};
    if (isPlainObject(pluginValue)) {
      const keys = Object.keys(pluginValue).sort();
      const pluginLimit = Math.max(0, 16 - Object.keys(this.metadata).length);
      for (const key of keys) {
        if (Object.keys(metadata).length >= pluginLimit) break;
        if (Object.prototype.hasOwnProperty.call(this.metadata, key)) continue;
        const rawValue = pluginValue[key];
        if (typeof rawValue !== "string" || utf8Len(key) > 64 || utf8Len(rawValue) > this.limits.maxMetadataValueBytes) continue;
        metadata[key] = rawValue;
      }
    }
    return { ...metadata, ...this.metadata };
  }

  private appendOutput(text: string): PluginResponsesStreamEvent[] {
    const outputIndex = this.outputs.length;
    const itemID = `msg_${this.taskID}_${outputIndex}`;
    const contentID = `content_${this.taskID}_${outputIndex}`;
    const emptyLogprobs: unknown[] = [];
    const addedItem: PluginResponsesOutput = {
      id: itemID,
      type: "message",
      status: PLUGIN_RESPONSE_STATUS_IN_PROGRESS,
      role: "assistant",
      content: [],
    };
    const partAdded: PluginResponsesContent = {
      id: contentID,
      type: "output_text",
      text: "",
      annotations: [],
      logprobs: [],
    };
    const completedItem = this.newCompletedOutputWithIDs(itemID, contentID, text);
    this.outputs.push(completedItem);
    this.totalOutputBytes += utf8Len(text);
    return [
      this.event({ type: "response.output_item.added", output_index: outputIndex, item: addedItem }),
      this.event({ type: "response.content_part.added", output_index: outputIndex, content_index: 0, item_id: itemID, part: partAdded }),
      this.event({ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, item_id: itemID, delta: text, logprobs: emptyLogprobs }),
      this.event({ type: "response.output_text.done", output_index: outputIndex, content_index: 0, item_id: itemID, text, logprobs: emptyLogprobs }),
      this.event({ type: "response.content_part.done", output_index: outputIndex, content_index: 0, item_id: itemID, part: completedItem.content[0] }),
      this.event({ type: "response.output_item.done", output_index: outputIndex, item: completedItem }),
    ];
  }

  private newCompletedOutputWithIDs(itemID: string, contentID: string, text: string): PluginResponsesOutput {
    return {
      id: itemID,
      type: "message",
      status: PLUGIN_RESPONSE_STATUS_COMPLETED,
      role: "assistant",
      content: [{ id: contentID, type: "output_text", text, annotations: [], logprobs: [] }],
    };
  }

  private complete(): PluginResponsesStreamEvent {
    this.status = PLUGIN_RESPONSE_STATUS_COMPLETED;
    this.metadata.task_status = PLUGIN_RESPONSE_STATUS_COMPLETED;
    this.usage = zeroPluginResponsesUsage();
    this.terminal = true;
    return this.responseEvent("response.completed");
  }

  private incomplete(): PluginResponsesStreamEvent {
    this.status = PLUGIN_RESPONSE_STATUS_INCOMPLETE;
    this.usage = zeroPluginResponsesUsage();
    this.terminal = true;
    return this.responseEvent("response.incomplete");
  }

  private fail(code: string, message: string): PluginResponsesStreamEvent {
    this.status = PLUGIN_RESPONSE_STATUS_FAILED;
    this.terminal = true;
    return this.event({ type: "response.failed", response: this.responseSnapshot({ code, message }) });
  }

  private responseEvent(eventType: string): PluginResponsesStreamEvent {
    return this.event({ type: eventType, response: this.responseSnapshot(null) });
  }

  private progressEvent(): PluginResponsesStreamEvent {
    const response = this.responseSnapshot(null);
    response.output = [];
    return this.event({ type: "response.in_progress", response });
  }

  private setPersistedTaskStatus(taskStatus?: string): void {
    if (taskStatus == null) return;
    const status = pluginTaskStatus(taskStatus);
    if (status) this.metadata.task_status = status;
  }

  private event(event: Omit<PluginResponsesStreamEvent, "sequence_number">): PluginResponsesStreamEvent {
    const numbered = { ...event, sequence_number: this.nextSequence };
    this.nextSequence += 1;
    return numbered;
  }

  responseSnapshot(responseError: PluginResponsesError | null): PluginResponsesResponse {
    return {
      id: this.responseID,
      object: "response",
      created_at: this.createdAt,
      status: this.status,
      error: responseError,
      incomplete_details: null,
      instructions: null,
      model: this.model,
      output: this.outputs.map(cloneOutput),
      parallel_tool_calls: true,
      temperature: 1,
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      metadata: { ...this.metadata },
      usage: this.usage
        ? {
            ...this.usage,
            input_tokens_details: { ...this.usage.input_tokens_details },
            output_tokens_details: { ...this.usage.output_tokens_details },
          }
        : null,
    };
  }

  responseSnapshotJSON(responseError: PluginResponsesError | null): Record<string, unknown> {
    return this.responseSnapshot(responseError) as unknown as Record<string, unknown>;
  }
}

export function encodePluginResponsesStreamEvent(event: PluginResponsesStreamEvent): Record<string, unknown> {
  const encoded: Record<string, unknown> = { type: event.type, sequence_number: event.sequence_number };
  if (event.response !== undefined) encoded.response = event.response;
  if (event.output_index !== undefined) encoded.output_index = event.output_index;
  if (event.content_index !== undefined) encoded.content_index = event.content_index;
  if (event.item_id) encoded.item_id = event.item_id;
  if (event.item) encoded.item = event.item;
  if (event.part) encoded.part = event.part;
  if (event.delta !== undefined) encoded.delta = event.delta;
  if (event.text !== undefined) encoded.text = event.text;
  if (event.logprobs !== undefined) encoded.logprobs = event.logprobs;
  return encoded;
}

export function pluginProtocolEventsTerminal(events: PluginResponsesStreamEvent[]): boolean {
  return events.some((event) => event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete");
}

export function protocolStatePluginValue(state: ProtocolState): unknown {
  if (!state.present || state.null) return null;
  return state.value;
}
