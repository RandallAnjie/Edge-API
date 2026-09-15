/**
 * Original `openai.OpenaiRealtimeHandler` token counting + `service.CountTokenRealtime`
 * / `EstimateToken` / `calculateAudioQuota` / `GenerateWssOtherInfo` public JSON.
 * Must not import store / relay / upstream / convert / openai-realtime.ts.
 *
 * Extra-OK: OpenAI-model `CountTextToken` uses `EstimateToken` (tiktoken-go is not bundled).
 */

import { quotaFromDecimalChecked, quotaFromFloat } from "./task-plugin-usage.js";
import { generateTextOtherInfo, RELAY_FORMAT_OPENAI_REALTIME } from "./log-info-generate.js";

/** Original `dto.RealtimeEventType*` client events. */
export const REALTIME_EVENT_SESSION_UPDATE = "session.update";
export const REALTIME_EVENT_CONVERSATION_CREATE = "conversation.item.create";
export const REALTIME_EVENT_RESPONSE_CREATE = "response.create";
export const REALTIME_EVENT_INPUT_AUDIO_BUFFER_APPEND = "input_audio_buffer.append";

/** Original `dto.RealtimeEventType*` upstream events. */
export const REALTIME_EVENT_RESPONSE_DONE = "response.done";
export const REALTIME_EVENT_SESSION_UPDATED = "session.updated";
export const REALTIME_EVENT_SESSION_CREATED = "session.created";
export const REALTIME_EVENT_RESPONSE_AUDIO_DELTA = "response.audio.delta";
export const REALTIME_EVENT_RESPONSE_AUDIO_TRANSCRIPT_DELTA = "response.audio_transcript.delta";
export const REALTIME_EVENT_RESPONSE_FUNCTION_CALL_ARGUMENTS_DELTA = "response.function_call_arguments.delta";
export const REALTIME_EVENT_RESPONSE_FUNCTION_CALL_ARGUMENTS_DONE = "response.function_call_arguments.done";
export const REALTIME_EVENT_CONVERSATION_ITEM_CREATED = "conversation.item.created";

/** Original `common.OpenAITextModels` substrings. */
const OPENAI_TEXT_MODELS = ["gpt-", "o1", "o3", "o4", "chatgpt"];

const MATH_SYMBOLS = "∑∫∂√∞≤≥≠≈±×÷∈∉∋∌⊂⊃⊆⊇∪∩∧∨¬∀∃∄∅∆∇∝∟∠∡∢°′″‴⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎²³¹⁴⁵⁶⁷⁸⁹⁰";
const URL_DELIMS = "/:?&=;#%";

type TokenProvider = "openai" | "gemini" | "claude" | "unknown";

type TokenMultipliers = {
  word: number;
  number: number;
  cjk: number;
  symbol: number;
  mathSymbol: number;
  urlDelim: number;
  atSign: number;
  emoji: number;
  newline: number;
  space: number;
  basePad: number;
};

const MULTIPLIERS: Record<Exclude<TokenProvider, "unknown">, TokenMultipliers> = {
  gemini: {
    word: 1.15,
    number: 2.8,
    cjk: 0.68,
    symbol: 0.38,
    mathSymbol: 1.05,
    urlDelim: 1.2,
    atSign: 2.5,
    emoji: 1.08,
    newline: 1.15,
    space: 0.2,
    basePad: 0,
  },
  claude: {
    word: 1.13,
    number: 1.63,
    cjk: 1.21,
    symbol: 0.4,
    mathSymbol: 4.52,
    urlDelim: 1.26,
    atSign: 2.82,
    emoji: 2.6,
    newline: 0.89,
    space: 0.39,
    basePad: 0,
  },
  openai: {
    word: 1.02,
    number: 1.55,
    cjk: 0.85,
    symbol: 0.4,
    mathSymbol: 2.68,
    urlDelim: 1.0,
    atSign: 2.0,
    emoji: 2.12,
    newline: 0.5,
    space: 0.42,
    basePad: 0,
  },
};

/** Original `dto.InputTokenDetails` WSS fields. */
export type RealtimeInputTokenDetails = {
  audio_tokens: number;
  cached_tokens: number;
  text_tokens: number;
};

/** Original `dto.OutputTokenDetails` WSS fields. */
export type RealtimeOutputTokenDetails = {
  audio_tokens: number;
  text_tokens: number;
};

/** Original `dto.RealtimeUsage` JSON. */
export type RealtimeUsage = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_token_details: RealtimeInputTokenDetails;
  output_token_details: RealtimeOutputTokenDetails;
};

export type RealtimeTool = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
};

export type RealtimeContent = {
  type?: string;
  text?: string;
  audio?: string;
  transcript?: string;
};

export type RealtimeItem = {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  content?: RealtimeContent[];
  name?: string;
  tool_calls?: unknown;
  call_id?: string;
};

export type RealtimeSession = {
  modalities?: string[];
  instructions?: string;
  voice?: string;
  input_audio_format?: string;
  output_audio_format?: string;
  tools?: RealtimeTool[] | null;
};

export type RealtimeEvent = {
  event_id?: string;
  type?: string;
  session?: RealtimeSession | null;
  item?: RealtimeItem | null;
  response?: { usage?: RealtimeUsage | null } | null;
  delta?: string;
  audio?: string;
};

/** Original `relaycommon.RelayInfo` WSS token-count fields. */
export type RealtimeCountInfo = {
  inputAudioFormat: string;
  outputAudioFormat: string;
  realtimeTools: RealtimeTool[];
  isFirstRequest: boolean;
};

export type OpenaiRealtimeHandlerState = RealtimeCountInfo & {
  usage: RealtimeUsage;
  localUsage: RealtimeUsage;
  sumUsage: RealtimeUsage;
};

export type AudioQuotaInfo = {
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  modelName: string;
  usePrice: boolean;
  modelPrice: number;
  modelRatio: number;
  groupRatio: number;
  completionRatio: number;
  audioRatio: number;
  audioCompletionRatio: number;
  quotaPerUnit: number;
};

export function emptyRealtimeUsage(): RealtimeUsage {
  return {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    input_token_details: { audio_tokens: 0, cached_tokens: 0, text_tokens: 0 },
    output_token_details: { audio_tokens: 0, text_tokens: 0 },
  };
}

export function emptyOpenaiRealtimeHandlerState(): OpenaiRealtimeHandlerState {
  return {
    usage: emptyRealtimeUsage(),
    localUsage: emptyRealtimeUsage(),
    sumUsage: emptyRealtimeUsage(),
    inputAudioFormat: "pcm16",
    outputAudioFormat: "pcm16",
    realtimeTools: [],
    isFirstRequest: true,
  };
}

/** Original `common.GetStringIfEmpty`. */
export function getStringIfEmpty(str: string, defaultValue: string): string {
  return str === "" ? defaultValue : str;
}

/** Original `common.IsOpenAITextModel`. */
export function isOpenAITextModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return OPENAI_TEXT_MODELS.some((m) => lower.includes(m));
}

function isSpaceCode(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x20 || cp === 0x85) return true;
  try {
    return /^\p{Z}$/u.test(String.fromCodePoint(cp));
  } catch {
    return false;
  }
}

function isLetterOrNumberCode(cp: number): boolean {
  try {
    const ch = String.fromCodePoint(cp);
    return /^\p{L}$/u.test(ch) || /^\p{N}$/u.test(ch);
  } catch {
    return false;
  }
}

function isNumberCode(cp: number): boolean {
  try {
    return /^\p{N}$/u.test(String.fromCodePoint(cp));
  } catch {
    return false;
  }
}

/** Original `service.isCJK`. */
export function isCJK(cp: number): boolean {
  if (cp >= 0x3040 && cp <= 0x30ff) return true;
  if (cp >= 0xac00 && cp <= 0xd7a3) return true;
  try {
    return /^\p{Script=Han}$/u.test(String.fromCodePoint(cp));
  } catch {
    return false;
  }
}

/** Original `service.isEmoji`. */
export function isEmoji(cp: number): boolean {
  return (
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x2600 && cp <= 0x26ff) ||
    (cp >= 0x2700 && cp <= 0x27bf) ||
    (cp >= 0x1f600 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa00 && cp <= 0x1faff)
  );
}

/** Original `service.isMathSymbol`. */
export function isMathSymbol(cp: number): boolean {
  if (MATH_SYMBOLS.includes(String.fromCodePoint(cp))) return true;
  if (cp >= 0x2200 && cp <= 0x22ff) return true;
  if (cp >= 0x2a00 && cp <= 0x2aff) return true;
  if (cp >= 0x1d400 && cp <= 0x1d7ff) return true;
  return false;
}

/** Original `service.isURLDelim`. */
export function isURLDelim(cp: number): boolean {
  return URL_DELIMS.includes(String.fromCodePoint(cp));
}

function multipliersFor(provider: TokenProvider): TokenMultipliers {
  if (provider === "gemini") return MULTIPLIERS.gemini;
  if (provider === "claude") return MULTIPLIERS.claude;
  return MULTIPLIERS.openai;
}

/** Original `service.EstimateToken`. */
export function estimateToken(provider: TokenProvider, text: string): number {
  const m = multipliersFor(provider);
  let count = 0;
  let currentWordType: "none" | "latin" | "number" = "none";
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if (isSpaceCode(cp)) {
      currentWordType = "none";
      count += cp === 0x0a || cp === 0x09 ? m.newline : m.space;
      continue;
    }
    if (isCJK(cp)) {
      currentWordType = "none";
      count += m.cjk;
      continue;
    }
    if (isEmoji(cp)) {
      currentWordType = "none";
      count += m.emoji;
      continue;
    }
    if (isLetterOrNumberCode(cp)) {
      const newType = isNumberCode(cp) ? "number" : "latin";
      if (currentWordType === "none" || currentWordType !== newType) {
        count += newType === "number" ? m.number : m.word;
        currentWordType = newType;
      }
      continue;
    }
    currentWordType = "none";
    if (isMathSymbol(cp)) count += m.mathSymbol;
    else if (cp === 0x40) count += m.atSign;
    else if (isURLDelim(cp)) count += m.urlDelim;
    else count += m.symbol;
  }
  return Math.ceil(count) + m.basePad;
}

/** Original `service.EstimateTokenByModel`. */
export function estimateTokenByModel(model: string, text: string): number {
  if (text === "") return 0;
  const lower = model.toLowerCase();
  if (lower.includes("gemini")) return estimateToken("gemini", text);
  if (lower.includes("claude")) return estimateToken("claude", text);
  return estimateToken("openai", text);
}

/**
 * Original `service.CountTextToken`.
 * Extra-OK: OpenAI models use `EstimateToken` instead of tiktoken-go.
 */
export function countTextToken(text: string, model: string): number {
  if (text === "") return 0;
  return estimateTokenByModel(model, text);
}

function goFmtV(value: unknown): string {
  if (value == null) return "<nil>";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => goFmtV(item)).join(" ")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("type" in o && "name" in o) {
      return `{${goFmtV(o.type)} ${goFmtV(o.name)} ${goFmtV(o.description ?? "")} ${goFmtV(o.parameters ?? null)}}`;
    }
    const parts = Object.keys(o)
      .sort()
      .map((key) => `${key}:${goFmtV(o[key])}`);
    return `map[${parts.join(" ")}]`;
  }
  return String(value);
}

/** Original `service.CountTokenInput`. */
export function countTokenInput(input: unknown, model: string): number {
  if (typeof input === "string") return countTextToken(input, model);
  if (Array.isArray(input)) {
    if (input.every((item) => typeof item === "string")) return countTextToken(input.join(""), model);
    return countTextToken(input.map((item) => goFmtV(item)).join(""), model);
  }
  return countTokenInput(goFmtV(input), model);
}

function decodeStdBase64(audioBase64: string): Uint8Array {
  const bin = atob(audioBase64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Original `service.parseAudio`. */
export function parseAudio(audioBase64: string, format: string): number {
  const audioData = decodeStdBase64(audioBase64);
  let samplesCount: number;
  let sampleRate: number;
  switch (format) {
    case "pcm16":
      samplesCount = Math.floor(audioData.length / 2);
      sampleRate = 24000;
      break;
    case "g711_ulaw":
    case "g711_alaw":
      samplesCount = audioData.length;
      sampleRate = 8000;
      break;
    default:
      samplesCount = audioData.length;
      sampleRate = 8000;
      break;
  }
  return samplesCount / sampleRate;
}

/** Original `service.CountAudioTokenInput`. */
export function countAudioTokenInput(audioBase64: string, audioFormat: string): number {
  if (audioBase64 === "") return 0;
  const duration = parseAudio(audioBase64, audioFormat);
  return quotaFromFloat((duration / 60) * 100 / 0.06);
}

/** Original `service.CountAudioTokenOutput`. */
export function countAudioTokenOutput(audioBase64: string, audioFormat: string): number {
  if (audioBase64 === "") return 0;
  const duration = parseAudio(audioBase64, audioFormat);
  return quotaFromFloat((duration / 60) * 200 / 0.24);
}

/** Original `service.CountTokenRealtime`. */
export function countTokenRealtime(
  info: RealtimeCountInfo,
  request: RealtimeEvent,
  model: string,
): { textToken: number; audioToken: number } {
  let audioToken = 0;
  let textToken = 0;
  switch (request.type) {
    case REALTIME_EVENT_SESSION_UPDATE:
      if (request.session) textToken += countTextToken(String(request.session.instructions || ""), model);
      break;
    case REALTIME_EVENT_RESPONSE_AUDIO_DELTA:
      audioToken += countAudioTokenOutput(String(request.delta || ""), info.outputAudioFormat);
      break;
    case REALTIME_EVENT_RESPONSE_AUDIO_TRANSCRIPT_DELTA:
    case REALTIME_EVENT_RESPONSE_FUNCTION_CALL_ARGUMENTS_DELTA:
      textToken += countTextToken(String(request.delta || ""), model);
      break;
    case REALTIME_EVENT_INPUT_AUDIO_BUFFER_APPEND:
      audioToken += countAudioTokenInput(String(request.audio || ""), info.inputAudioFormat);
      break;
    case REALTIME_EVENT_CONVERSATION_ITEM_CREATED:
      if (request.item?.type === "message") {
        for (const content of request.item.content || []) {
          if (content.type === "input_text") textToken += countTextToken(String(content.text || ""), model);
        }
      }
      break;
    case REALTIME_EVENT_RESPONSE_DONE:
      if (!info.isFirstRequest && info.realtimeTools.length > 0) {
        for (const tool of info.realtimeTools) {
          textToken += 8;
          textToken += countTokenInput(tool, model);
        }
      }
      break;
    default:
      break;
  }
  return { textToken, audioToken };
}

export function addRealtimeUsage(target: RealtimeUsage, add: RealtimeUsage): void {
  target.total_tokens += add.total_tokens;
  target.input_tokens += add.input_tokens;
  target.output_tokens += add.output_tokens;
  target.input_token_details.cached_tokens += add.input_token_details.cached_tokens;
  target.input_token_details.text_tokens += add.input_token_details.text_tokens;
  target.input_token_details.audio_tokens += add.input_token_details.audio_tokens;
  target.output_token_details.text_tokens += add.output_token_details.text_tokens;
  target.output_token_details.audio_tokens += add.output_token_details.audio_tokens;
}

function numField(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Original `dto.RealtimeUsage` JSON object (snake_case fields). */
export function realtimeUsageFromJSON(raw: unknown): RealtimeUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const input = (o.input_token_details && typeof o.input_token_details === "object" ? o.input_token_details : {}) as Record<
    string,
    unknown
  >;
  const output = (o.output_token_details && typeof o.output_token_details === "object" ? o.output_token_details : {}) as Record<
    string,
    unknown
  >;
  return {
    total_tokens: numField(o.total_tokens),
    input_tokens: numField(o.input_tokens),
    output_tokens: numField(o.output_tokens),
    input_token_details: {
      audio_tokens: numField(input.audio_tokens),
      cached_tokens: numField(input.cached_tokens),
      text_tokens: numField(input.text_tokens),
    },
    output_token_details: {
      audio_tokens: numField(output.audio_tokens),
      text_tokens: numField(output.text_tokens),
    },
  };
}

export function parseRealtimeEvent(message: string): RealtimeEvent | null {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const session = o.session && typeof o.session === "object" && !Array.isArray(o.session) ? (o.session as RealtimeSession) : undefined;
    const item = o.item && typeof o.item === "object" && !Array.isArray(o.item) ? (o.item as RealtimeItem) : undefined;
    const response = o.response && typeof o.response === "object" && !Array.isArray(o.response) ? (o.response as { usage?: unknown }) : undefined;
    return {
      event_id: o.event_id != null ? String(o.event_id) : undefined,
      type: o.type != null ? String(o.type) : undefined,
      session,
      item,
      response: response ? { usage: realtimeUsageFromJSON(response.usage) } : undefined,
      delta: o.delta != null ? String(o.delta) : undefined,
      audio: o.audio != null ? String(o.audio) : undefined,
    };
  } catch {
    return null;
  }
}

function addLocalInput(local: RealtimeUsage, textToken: number, audioToken: number): void {
  local.total_tokens += textToken + audioToken;
  local.input_tokens += textToken + audioToken;
  local.input_token_details.text_tokens += textToken;
  local.input_token_details.audio_tokens += audioToken;
}

function addLocalOutput(local: RealtimeUsage, textToken: number, audioToken: number): void {
  local.total_tokens += textToken + audioToken;
  local.output_tokens += textToken + audioToken;
  local.output_token_details.text_tokens += textToken;
  local.output_token_details.audio_tokens += audioToken;
}

/** Original client-reader half of `OpenaiRealtimeHandler`. */
export function applyClientRealtimeEvent(state: OpenaiRealtimeHandlerState, event: RealtimeEvent, model: string): void {
  if (event.type === REALTIME_EVENT_SESSION_UPDATE && event.session && event.session.tools != null) {
    state.realtimeTools = Array.isArray(event.session.tools) ? event.session.tools : [];
  }
  const counted = countTokenRealtime(state, event, model);
  addLocalInput(state.localUsage, counted.textToken, counted.audioToken);
}

export type UpstreamRealtimeApply = { preConsume: RealtimeUsage | null };

/** Original target-reader half of `OpenaiRealtimeHandler`. */
export function applyUpstreamRealtimeEvent(state: OpenaiRealtimeHandlerState, event: RealtimeEvent, model: string): UpstreamRealtimeApply {
  if (event.type === REALTIME_EVENT_RESPONSE_DONE) {
    const realtimeUsage = event.response?.usage ?? null;
    if (realtimeUsage) {
      addRealtimeUsage(state.usage, realtimeUsage);
      const billed = state.usage;
      state.usage = emptyRealtimeUsage();
      state.localUsage = emptyRealtimeUsage();
      return { preConsume: billed };
    }
    const counted = countTokenRealtime(state, event, model);
    addLocalInput(state.localUsage, counted.textToken, counted.audioToken);
    state.isFirstRequest = false;
    const billed = state.localUsage;
    state.localUsage = emptyRealtimeUsage();
    return { preConsume: billed };
  }
  if (event.type === REALTIME_EVENT_SESSION_UPDATED || event.type === REALTIME_EVENT_SESSION_CREATED) {
    if (event.session) {
      state.inputAudioFormat = getStringIfEmpty(String(event.session.input_audio_format || ""), state.inputAudioFormat);
      state.outputAudioFormat = getStringIfEmpty(String(event.session.output_audio_format || ""), state.outputAudioFormat);
    }
    return { preConsume: null };
  }
  const counted = countTokenRealtime(state, event, model);
  addLocalOutput(state.localUsage, counted.textToken, counted.audioToken);
  return { preConsume: null };
}

/**
 * Original close-path remainder: if `usage.TotalTokens != 0` or
 * `localUsage.TotalTokens != 0`, `preConsumeUsage` those buckets.
 */
export function remainingRealtimePreConsume(state: OpenaiRealtimeHandlerState): RealtimeUsage[] {
  const out: RealtimeUsage[] = [];
  if (state.usage.total_tokens !== 0) out.push(state.usage);
  if (state.localUsage.total_tokens !== 0) out.push(state.localUsage);
  return out;
}

/** Original `service.calculateAudioQuota`. */
export function calculateAudioQuota(info: AudioQuotaInfo): { quota: number; clamp: { op: string; kind: string; original: number; clamped: number } | null } {
  if (info.usePrice) {
    return quotaFromDecimalChecked(info.modelPrice * info.quotaPerUnit * info.groupRatio);
  }
  const ratio = info.groupRatio * info.modelRatio;
  let quota =
    info.inputTextTokens +
    info.outputTextTokens * info.completionRatio +
    info.inputAudioTokens * info.audioRatio +
    info.outputAudioTokens * info.audioRatio * info.audioCompletionRatio;
  quota *= ratio;
  if (ratio !== 0 && quota <= 0) quota = 1;
  return quotaFromDecimalChecked(quota);
}

/** Original `service.GenerateWssOtherInfo` public JSON fields. */
export function generateWssOtherInfo(opts: {
  usage: RealtimeUsage;
  modelRatio: number;
  groupRatio: number;
  completionRatio: number;
  audioRatio: number;
  audioCompletionRatio: number;
  modelPrice: number;
  userGroupRatio: number;
  frtMs: number;
  requestPath: string;
  isModelMapped: boolean;
  upstreamModelName: string;
  billingSource?: string;
}): Record<string, unknown> {
  const other = generateTextOtherInfo({
    modelRatio: opts.modelRatio,
    groupRatio: opts.groupRatio,
    completionRatio: opts.completionRatio,
    cacheTokens: 0,
    cacheRatio: 0,
    modelPrice: opts.modelPrice,
    userGroupRatio: opts.userGroupRatio,
    frt: opts.frtMs,
    requestPath: opts.requestPath,
    isModelMapped: opts.isModelMapped,
    upstreamModelName: opts.upstreamModelName,
    billingSource: opts.billingSource || "wallet",
    requestConversion: [RELAY_FORMAT_OPENAI_REALTIME],
  });
  other.ws = true;
  other.audio_input = opts.usage.input_token_details.audio_tokens;
  other.audio_output = opts.usage.output_token_details.audio_tokens;
  other.text_input = opts.usage.input_token_details.text_tokens;
  other.text_output = opts.usage.output_token_details.text_tokens;
  other.audio_ratio = opts.audioRatio;
  other.audio_completion_ratio = opts.audioCompletionRatio;
  return other;
}

/** Original `preConsumeUsage` field copy into `sumUsage`. */
export function accumulateRealtimeUsage(totalUsage: RealtimeUsage, usage: RealtimeUsage): void {
  addRealtimeUsage(totalUsage, usage);
}

export function websocketMessageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return String(data ?? "");
}
