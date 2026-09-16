/**
 * Original `dto.Request.GetTokenCountMeta` + `service.CountRequestToken` (workerd).
 * Must not import store / relay / convert / query / submit.
 *
 * Extra-OK: OpenAI-text models use `len/4` instead of tiktoken; media files are
 * not fetched (`GetMediaToken`). Transcription/translation duration is 0
 * without a workerd audio decoder.
 */
import {
  RELAY_FORMAT_OPENAI,
  RELAY_FORMAT_OPENAI_REALTIME,
  relayFormatForClient,
} from "./log-info-generate.js";
import { embeddingCombineText, rerankCombineText } from "./valid-request.js";
import { legacyDallePriceRatio } from "./image-billing.js";

export const TOKEN_TYPE_TEXT_NUMBER = "text_number";
export const TOKEN_TYPE_TOKENIZER = "tokenizer";

export type TokenCountMeta = {
  tokenType?: string;
  combineText: string;
  toolsCount: number;
  nameCount: number;
  messagesCount: number;
  maxTokens: number;
  imagePriceRatio?: number;
  billingRatios?: Record<string, number>;
};

type TokenCountOpts = {
  mode: string;
  clientFormat: string;
  path?: string;
  body: unknown;
  model?: string;
};

const OPENAI_TEXT_MODEL_MARKERS = ["gpt-", "o1", "o3", "o4", "chatgpt"];

const MATH_SYMBOLS = new Set([
  ..."∑∫∂√∞≤≥≠≈±×÷∈∉∋∌⊂⊃⊆⊇∪∩∧∨¬∀∃∄∅∆∇∝∟∠∡∢°′″‴⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎²³¹⁴⁵⁶⁷⁸⁹⁰",
]);

const URL_DELIMS = new Set([..."/:?&=;#%"]);

type Provider = "openai" | "gemini" | "claude";

const MULTIPLIERS: Record<Provider, Record<string, number>> = {
  gemini: { word: 1.15, number: 2.8, cjk: 0.68, symbol: 0.38, math: 1.05, url: 1.2, at: 2.5, emoji: 1.08, newline: 1.15, space: 0.2 },
  claude: { word: 1.13, number: 1.63, cjk: 1.21, symbol: 0.4, math: 4.52, url: 1.26, at: 2.82, emoji: 2.6, newline: 0.89, space: 0.39 },
  openai: { word: 1.02, number: 1.55, cjk: 0.85, symbol: 0.4, math: 2.68, url: 1.0, at: 2.0, emoji: 2.12, newline: 0.5, space: 0.42 },
};

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function emptyMeta(): TokenCountMeta {
  return { combineText: "", toolsCount: 0, nameCount: 0, messagesCount: 0, maxTokens: 0 };
}

/** Original `utf8.RuneCountInString`. */
export function runeCount(text: string): number {
  return Array.from(text).length;
}

/** Original `common.IsOpenAITextModel`. */
export function isOpenAITextModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return OPENAI_TEXT_MODEL_MARKERS.some((marker) => lower.includes(marker));
}

function isCJK(r: string): boolean {
  const code = r.codePointAt(0) || 0;
  if (/\p{Script=Han}/u.test(r)) return true;
  if (code >= 0x3040 && code <= 0x30ff) return true;
  if (code >= 0xac00 && code <= 0xd7a3) return true;
  return false;
}

function isEmoji(r: string): boolean {
  const code = r.codePointAt(0) || 0;
  return (
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x2600 && code <= 0x26ff) ||
    (code >= 0x2700 && code <= 0x27bf) ||
    (code >= 0x1f600 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa00 && code <= 0x1faff)
  );
}

function isLatinOrNumber(r: string): boolean {
  return /\p{L}/u.test(r) || /\p{N}/u.test(r);
}

function isMathSymbol(r: string): boolean {
  const code = r.codePointAt(0) || 0;
  if (MATH_SYMBOLS.has(r)) return true;
  if (code >= 0x2200 && code <= 0x22ff) return true;
  if (code >= 0x2a00 && code <= 0x2aff) return true;
  if (code >= 0x1d400 && code <= 0x1d7ff) return true;
  return false;
}

/** Original `service.EstimateToken`. */
export function estimateToken(provider: Provider, text: string): number {
  const m = MULTIPLIERS[provider];
  let count = 0;
  let current: "none" | "latin" | "number" = "none";
  for (const r of text) {
    if (/\s/u.test(r)) {
      current = "none";
      count += r === "\n" || r === "\t" ? m.newline : m.space;
      continue;
    }
    if (isCJK(r)) {
      current = "none";
      count += m.cjk;
      continue;
    }
    if (isEmoji(r)) {
      current = "none";
      count += m.emoji;
      continue;
    }
    if (isLatinOrNumber(r)) {
      const next: "latin" | "number" = /\p{N}/u.test(r) ? "number" : "latin";
      if (current === "none" || current !== next) {
        count += next === "number" ? m.number : m.word;
        current = next;
      }
      continue;
    }
    current = "none";
    if (isMathSymbol(r)) count += m.math;
    else if (r === "@") count += m.at;
    else if (URL_DELIMS.has(r)) count += m.url;
    else count += m.symbol;
  }
  return Math.ceil(count);
}

/** Original `service.EstimateTokenByModel`. */
export function estimateTokenByModel(model: string, text: string): number {
  if (!text) return 0;
  const lower = model.toLowerCase();
  if (lower.includes("gemini")) return estimateToken("gemini", text);
  if (lower.includes("claude")) return estimateToken("claude", text);
  return estimateToken("openai", text);
}

/**
 * Extra-OK stand-in for tiktoken `getTokenNum` on OpenAI text models.
 * Matches existing worker `estimateTokens` (`max(1, ceil(len/4))`).
 */
export function openaiTextTokenEstimate(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Original `service.CountTextToken`. */
export function countTextToken(text: string, model: string): number {
  if (!text) return 0;
  if (isOpenAITextModel(model)) return openaiTextTokenEstimate(text);
  return estimateTokenByModel(model, text);
}

function fmtValue(value: unknown): string {
  if (value == null) return "<nil>";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rawJsonText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function maxUintFields(...values: unknown[]): number {
  let max = 0;
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > max) max = Math.trunc(n);
  }
  return max;
}

function messageTextParts(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
      return [(content as { text: string }).text];
    }
    return [];
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) parts.push(item);
      continue;
    }
    const o = asObj(item);
    const type = String(o.type || "text");
    if (type === "image_url" || type === "input_audio" || type === "file" || type === "video_url") continue;
    if (type === "text" || !o.type) {
      if (typeof o.text === "string" && o.text) parts.push(o.text);
    }
  }
  return parts;
}

function openaiChatMeta(body: Record<string, unknown>): TokenCountMeta {
  const texts: string[] = [];
  const meta = emptyMeta();
  if (body.prompt != null) {
    if (typeof body.prompt === "string") texts.push(body.prompt);
    else if (Array.isArray(body.prompt)) {
      for (const item of body.prompt) if (typeof item === "string") texts.push(item);
    } else texts.push(fmtValue(body.prompt));
  }
  if (body.input != null) {
    if (typeof body.input === "string") texts.push(body.input);
    else if (Array.isArray(body.input)) {
      for (const item of body.input) if (typeof item === "string") texts.push(item);
    }
  }
  meta.maxTokens = maxUintFields(body.max_tokens, body.max_completion_tokens);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const dynamicTools: Record<string, unknown>[] = [];
  for (const message of messages) {
    const m = asObj(message);
    meta.messagesCount++;
    texts.push(String(m.role || ""));
    if (Array.isArray(m.tools)) dynamicTools.push(...m.tools.map(asObj));
    if (m.content != null) {
      if (typeof m.name === "string") {
        meta.nameCount++;
        texts.push(m.name);
      }
      texts.push(...messageTextParts(m.content));
    }
  }
  const tools = [...dynamicTools, ...(Array.isArray(body.tools) ? body.tools.map(asObj) : [])];
  for (const tool of tools) {
    meta.toolsCount++;
    const fn = asObj(tool.function);
    const name = String(fn.name || tool.name || "");
    if (name) texts.push(name);
    const description = String(fn.description || tool.description || "");
    if (description) texts.push(description);
    if (fn.parameters != null) texts.push(fmtValue(fn.parameters));
    else if (tool.parameters != null) texts.push(fmtValue(tool.parameters));
  }
  meta.combineText = texts.join("\n");
  return meta;
}

function geminiMeta(body: Record<string, unknown>): TokenCountMeta {
  const texts: string[] = [];
  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (const content of contents) {
    const parts = Array.isArray(asObj(content).parts) ? (asObj(content).parts as unknown[]) : [];
    for (const part of parts) {
      const text = asObj(part).text;
      if (typeof text === "string" && text) texts.push(text);
    }
  }
  const cfg = { ...asObj(body.generation_config), ...asObj(body.generationConfig) };
  return {
    ...emptyMeta(),
    combineText: texts.join("\n"),
    maxTokens: maxUintFields(cfg.maxOutputTokens, cfg.max_output_tokens),
  };
}

function audioMeta(body: Record<string, unknown>, model: string): TokenCountMeta {
  const input = typeof body.input === "string" ? body.input : "";
  return {
    ...emptyMeta(),
    combineText: input,
    tokenType: model.includes("gpt") ? TOKEN_TYPE_TOKENIZER : TOKEN_TYPE_TEXT_NUMBER,
  };
}

function imageMeta(body: Record<string, unknown>): TokenCountMeta {
  let imageN = 1;
  if (body.n != null && Number(body.n) > 0) imageN = Math.trunc(Number(body.n));
  return {
    ...emptyMeta(),
    combineText: typeof body.prompt === "string" ? body.prompt : "",
    maxTokens: 1584,
    imagePriceRatio: legacyDallePriceRatio(String(body.model || ""), String(body.size || ""), String(body.quality || "")),
    billingRatios: { n: imageN },
  };
}

function claudeMeta(body: Record<string, unknown>): TokenCountMeta {
  const texts: string[] = [];
  const meta = emptyMeta();
  meta.maxTokens = maxUintFields(body.max_tokens);
  if (typeof body.system === "string" && body.system) texts.push(body.system);
  else if (Array.isArray(body.system)) {
    for (const part of body.system) {
      const o = asObj(part);
      if (o.type === "text" && typeof o.text === "string") texts.push(o.text);
      else if (typeof part === "string") texts.push(part);
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const m = asObj(message);
    meta.messagesCount++;
    texts.push(String(m.role || ""));
    if (typeof m.content === "string") {
      if (m.content) texts.push(m.content);
      continue;
    }
    texts.push(...messageTextParts(m.content));
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const o = asObj(part);
        if (o.type === "tool_use") {
          if (typeof o.name === "string" && o.name) texts.push(o.name);
          if (o.input != null) texts.push(fmtValue(o.input));
        } else if (o.type === "tool_result" && o.content != null) {
          texts.push(fmtValue(o.content));
        }
      }
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    const t = asObj(tool);
    meta.toolsCount++;
    if (typeof t.name === "string" && t.name) texts.push(t.name);
    if (typeof t.description === "string" && t.description) texts.push(t.description);
    if (t.input_schema != null) texts.push(fmtValue(t.input_schema));
  }
  meta.combineText = texts.join("\n");
  return meta;
}

function responsesMeta(body: Record<string, unknown>): TokenCountMeta {
  const texts: string[] = [];
  if (typeof body.input === "string") texts.push(body.input);
  else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      const o = asObj(item);
      const type = String(o.type || "input_text");
      if (type === "input_image" || type === "input_file") continue;
      if (typeof o.text === "string") texts.push(o.text);
      if (typeof o.content === "string") texts.push(o.content);
    }
  }
  for (const key of ["instructions", "metadata", "text", "tool_choice", "prompt", "tools"] as const) {
    if (body[key] != null) {
      const raw = rawJsonText(body[key]);
      if (raw) texts.push(raw);
    }
  }
  return {
    ...emptyMeta(),
    combineText: texts.join("\n"),
    maxTokens: maxUintFields(body.max_output_tokens),
  };
}

function responsesCompactMeta(body: Record<string, unknown>): TokenCountMeta {
  const parts: string[] = [];
  if (body.instructions != null) parts.push(rawJsonText(body.instructions));
  if (body.input != null) parts.push(rawJsonText(body.input));
  return { ...emptyMeta(), combineText: parts.filter(Boolean).join("\n") };
}

/** Original DTO `GetTokenCountMeta` by worker relay mode / client format. */
export function getTokenCountMeta(opts: TokenCountOpts): TokenCountMeta {
  const body = asObj(opts.body);
  const model = opts.model || String(body.model || "");
  const format = relayFormatForClient(opts.clientFormat, opts.mode);
  if (format === RELAY_FORMAT_OPENAI_REALTIME) return emptyMeta();
  if (opts.mode === "audio_speech" || opts.mode === "audio_transcription" || opts.mode === "audio_translation") {
    return audioMeta(body, model);
  }
  if (opts.mode === "embeddings" || opts.mode === "engines_embeddings") {
    return { ...emptyMeta(), combineText: embeddingCombineText(body) };
  }
  if (opts.mode === "rerank") {
    return { ...emptyMeta(), combineText: rerankCombineText(body) };
  }
  if (opts.mode === "images") return imageMeta(body);
  if (opts.mode === "gemini" || opts.clientFormat === "gemini") return geminiMeta(body);
  if (opts.mode === "messages" || opts.clientFormat === "anthropic") return claudeMeta(body);
  if (opts.mode === "responses") {
    if ((opts.path || "").includes("/v1/responses/compact")) return responsesCompactMeta(body);
    return responsesMeta(body);
  }
  if (opts.mode === "alpha_search") {
    return { ...emptyMeta(), combineText: JSON.stringify(opts.body ?? {}), tokenType: TOKEN_TYPE_TOKENIZER };
  }
  return openaiChatMeta(body);
}

/**
 * Original `service.CountRequestToken` without media fetches.
 * Transcription/translation return 0 (Extra-OK: no audio duration).
 */
export function countRequestToken(
  meta: TokenCountMeta,
  opts: { relayFormat: string; model: string; relayMode?: string },
): number {
  if (opts.relayFormat === RELAY_FORMAT_OPENAI_REALTIME) return 0;
  if (opts.relayMode === "audio_transcription" || opts.relayMode === "audio_translation") return 0;
  let tkm = 0;
  if (meta.tokenType === TOKEN_TYPE_TEXT_NUMBER) tkm += runeCount(meta.combineText);
  else tkm += countTextToken(meta.combineText, opts.model);
  if (opts.relayFormat === RELAY_FORMAT_OPENAI) {
    tkm += meta.toolsCount * 8;
    tkm += meta.messagesCount * 3;
    tkm += meta.nameCount * 3;
    tkm += 3;
  }
  return tkm;
}

/** Original EstimateRequestToken for the current relay request. */
export function estimateRequestPromptTokens(opts: TokenCountOpts): number {
  const meta = getTokenCountMeta(opts);
  return countRequestToken(meta, {
    relayFormat: relayFormatForClient(opts.clientFormat, opts.mode),
    model: opts.model || String(asObj(opts.body).model || ""),
    relayMode: opts.mode,
  });
}
