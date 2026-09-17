/** Original `relaykit/relayconvert/internal/gemini_chat/to_oai_chat_resp.go` + Gemini OpenAI-format DoResponse. */

import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";
import {
  asInt,
  asObj,
  compactJson,
  compactUuid,
  emptyOpenAIUsage,
  looksLikeSse,
  openAIUsageToJson,
  parseSseDataPayloads,
  sseLine,
  type OpenAIUsage,
} from "./openai-usage.js";

export type GeminiToOpenAIOpts = {
  id?: string;
  created?: number;
  upstreamModel?: string;
  fallbackPromptTokens?: number;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asArr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function geminiFinishReason(reason: string): string {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "OTHER":
      return "content_filter";
    default:
      return reason ? "content_filter" : "stop";
  }
}

function normalizeGeminiModality(modality: string): string {
  return modality.toUpperCase();
}

function hasGeminiUsageMetadataTokens(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  if (
    asInt(metadata.promptTokenCount) ||
    asInt(metadata.toolUsePromptTokenCount) ||
    asInt(metadata.candidatesTokenCount) ||
    asInt(metadata.totalTokenCount) ||
    asInt(metadata.thoughtsTokenCount) ||
    asInt(metadata.cachedContentTokenCount)
  ) {
    return true;
  }
  for (const key of ["promptTokensDetails", "toolUsePromptTokensDetails", "candidatesTokensDetails"] as const) {
    for (const detail of asArr(metadata[key])) {
      if (asInt(detail.tokenCount)) return true;
    }
  }
  return false;
}

function cloneGeminiUsageMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    promptTokenCount: asInt(metadata.promptTokenCount),
    toolUsePromptTokenCount: asInt(metadata.toolUsePromptTokenCount),
    candidatesTokenCount: asInt(metadata.candidatesTokenCount),
    totalTokenCount: asInt(metadata.totalTokenCount),
    thoughtsTokenCount: asInt(metadata.thoughtsTokenCount),
    cachedContentTokenCount: asInt(metadata.cachedContentTokenCount),
    promptTokensDetails: asArr(metadata.promptTokensDetails),
    toolUsePromptTokensDetails: asArr(metadata.toolUsePromptTokensDetails),
    candidatesTokensDetails: asArr(metadata.candidatesTokensDetails),
  };
}

/** Original `dto.NewGeminiChatBillingUsage`. */
export function newGeminiChatBillingUsage(metadata: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!hasGeminiUsageMetadataTokens(metadata)) return undefined;
  return {
    source: "gemini_chat",
    semantic: "gemini",
    gemini_usage_metadata: cloneGeminiUsageMetadata(metadata!),
  };
}

function addGeminiInputDetail(details: OpenAIUsage["prompt_tokens_details"], detail: Record<string, unknown>): void {
  const count = asInt(detail.tokenCount);
  switch (normalizeGeminiModality(str(detail.modality))) {
    case "AUDIO":
      details.audio_tokens += count;
      break;
    case "IMAGE":
      details.image_tokens += count;
      break;
    case "TEXT":
      details.text_tokens += count;
      break;
  }
}

/** Original `UsageFromGeminiMetadata`. */
export function usageFromGeminiMetadata(
  metadata: Record<string, unknown> | null | undefined,
  fallbackPromptTokens = 0,
): OpenAIUsage | null {
  if (!metadata) {
    if (fallbackPromptTokens <= 0) return null;
    const usage = emptyOpenAIUsage();
    usage.prompt_tokens = fallbackPromptTokens;
    usage.prompt_tokens_details.text_tokens = fallbackPromptTokens;
    return usage;
  }
  let promptTokens = asInt(metadata.promptTokenCount) + asInt(metadata.toolUsePromptTokenCount);
  if (promptTokens <= 0 && fallbackPromptTokens > 0) promptTokens = fallbackPromptTokens;
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = promptTokens;
  usage.completion_tokens = asInt(metadata.candidatesTokenCount) + asInt(metadata.thoughtsTokenCount);
  usage.total_tokens = asInt(metadata.totalTokenCount);
  usage.billing_usage = newGeminiChatBillingUsage(metadata);
  usage.completion_tokens_details.reasoning_tokens = asInt(metadata.thoughtsTokenCount);
  usage.prompt_tokens_details.cached_tokens = asInt(metadata.cachedContentTokenCount);
  for (const detail of asArr(metadata.promptTokensDetails)) addGeminiInputDetail(usage.prompt_tokens_details, detail);
  for (const detail of asArr(metadata.toolUsePromptTokensDetails)) addGeminiInputDetail(usage.prompt_tokens_details, detail);
  for (const detail of asArr(metadata.candidatesTokensDetails)) {
    const count = asInt(detail.tokenCount);
    switch (normalizeGeminiModality(str(detail.modality))) {
      case "IMAGE":
        usage.completion_tokens_details.image_tokens += count;
        break;
      case "AUDIO":
        usage.completion_tokens_details.audio_tokens += count;
        break;
      case "TEXT":
        usage.completion_tokens_details.text_tokens += count;
        break;
    }
  }
  if (usage.total_tokens > 0 && usage.completion_tokens <= 0) {
    usage.completion_tokens = usage.total_tokens - usage.prompt_tokens;
  }
  if (usage.prompt_tokens > 0 && usage.prompt_tokens_details.text_tokens === 0 && usage.prompt_tokens_details.audio_tokens === 0) {
    usage.prompt_tokens_details.text_tokens = usage.prompt_tokens;
  }
  return usage;
}

function usageMetadataFromResponse(response: Record<string, unknown>): Record<string, unknown> | null {
  const meta = response.usageMetadata || response.usage_metadata;
  if (meta && typeof meta === "object") return asObj(meta);
  return null;
}

function groundingMetadataFromCandidate(candidate: Record<string, unknown>): Record<string, unknown> | null {
  const meta = candidate.groundingMetadata || candidate.grounding_metadata;
  if (meta && typeof meta === "object") return asObj(meta);
  return null;
}

function parseJsonArray(raw: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
    } catch {
      return null;
    }
  }
  if (raw == null) return [];
  return null;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(bytes: Uint8Array, fatal = false): string {
  return new TextDecoder("utf-8", { fatal }).decode(bytes);
}

function utf8ValidPrefix(s: string, byteLen: number): boolean {
  const bytes = utf8Bytes(s);
  if (byteLen < 0 || byteLen > bytes.length) return false;
  try {
    utf8Decode(bytes.subarray(0, byteLen), true);
    return true;
  } catch {
    return false;
  }
}

function utf8Slice(s: string, startByte: number, endByte: number): string {
  return utf8Decode(utf8Bytes(s).subarray(startByte, endByte));
}

function utf8IndexOf(haystack: string, needle: string, fromByte: number): number {
  const hay = utf8Bytes(haystack);
  const nee = utf8Bytes(needle);
  if (fromByte > hay.length) return -1;
  outer: for (let i = fromByte; i <= hay.length - nee.length; i++) {
    for (let j = 0; j < nee.length; j++) {
      if (hay[i + j] !== nee[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function runeCount(s: string): number {
  return Array.from(s).length;
}

function optionalInt(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

type RenderedGeminiPart = { text: string; startByte: number };

function locateRenderedGeminiParts(content: Record<string, unknown>, rendered: string): RenderedGeminiPart[] {
  const parts = asArr(content.parts);
  const located: RenderedGeminiPart[] = [];
  let cursor = 0;
  for (const part of parts) {
    const text = str(part.text);
    const item: RenderedGeminiPart = { text, startByte: -1 };
    located.push(item);
    if (!text || part.thought === true || cursor > utf8Bytes(rendered).length) continue;
    const start = utf8IndexOf(rendered, text, cursor);
    if (start < 0) continue;
    item.startByte = start;
    cursor = start + utf8Bytes(text).length;
  }
  return located;
}

function groundingRuneRange(
  rendered: string,
  part: RenderedGeminiPart,
  startByte: number,
  endByte: number,
): { start: number; end: number } | null {
  if (startByte < 0 || endByte <= startByte || endByte > utf8Bytes(part.text).length) return null;
  if (!utf8ValidPrefix(part.text, startByte) || !utf8ValidPrefix(part.text, endByte)) return null;
  const partStartRunes = runeCount(utf8Slice(rendered, 0, part.startByte));
  const start = partStartRunes + runeCount(utf8Slice(part.text, 0, startByte));
  const end = partStartRunes + runeCount(utf8Slice(part.text, 0, endByte));
  return { start, end };
}

function groundingSource(chunk: Record<string, unknown>): { uri: string; title: string } | null {
  const web = chunk.web && typeof chunk.web === "object" ? asObj(chunk.web) : null;
  const retrieved =
    (chunk.retrievedContext || chunk.retrieved_context) && typeof (chunk.retrievedContext || chunk.retrieved_context) === "object"
      ? asObj(chunk.retrievedContext || chunk.retrieved_context)
      : null;
  const source = web || retrieved;
  if (!source) return null;
  const uri = str(source.uri || source.URI).trim();
  if (!uri) return null;
  return { uri, title: str(source.title) };
}

function appendGroundingAnnotations(
  annotations: Record<string, unknown>[],
  chunks: Record<string, unknown>[],
  support: Record<string, unknown>,
  start: number,
  end: number,
  keyPrefix: string,
  seen: Set<string>,
): void {
  const indices = parseJsonArray(support.groundingChunkIndices || support.grounding_chunk_indices);
  if (!indices) return;
  for (const rawIndex of indices) {
    const chunkIndex = asInt(rawIndex);
    if (chunkIndex < 0 || chunkIndex >= chunks.length) continue;
    const source = groundingSource(chunks[chunkIndex]);
    if (!source) continue;
    const key = `${keyPrefix}${start}:${end}:${source.uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    annotations.push({
      type: "url_citation",
      url_citation: {
        start_index: start,
        end_index: end,
        url: source.uri,
        title: source.title,
      },
    });
  }
}

/** Original `geminichat.groundingAnnotationsToChat`. */
export function groundingAnnotationsToChat(
  metadata: Record<string, unknown> | null | undefined,
  content: Record<string, unknown>,
  rendered: string,
): Record<string, unknown>[] | undefined {
  if (!metadata) return undefined;
  const rawChunks = metadata.groundingChunks || metadata.grounding_chunks;
  const rawSupports = metadata.groundingSupports || metadata.grounding_supports;
  if (rawChunks == null || rawSupports == null) return undefined;
  const chunks = parseJsonArray(rawChunks);
  const supports = parseJsonArray(rawSupports);
  if (!chunks || !supports || !chunks.length || !supports.length) return undefined;
  const parts = locateRenderedGeminiParts(content, rendered);
  let textPartCount = 0;
  let soleTextPart = -1;
  for (let index = 0; index < parts.length; index++) {
    if (parts[index].startByte < 0) continue;
    textPartCount += 1;
    soleTextPart = index;
  }
  const annotations: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const support of supports) {
    const segment = asObj(support.segment);
    const explicitPart = optionalInt(segment.partIndex ?? segment.part_index);
    let partIndex = soleTextPart;
    if (explicitPart != null) partIndex = explicitPart;
    else if (textPartCount !== 1) continue;
    if (partIndex < 0 || partIndex >= parts.length || parts[partIndex].startByte < 0) continue;
    const part = parts[partIndex];
    const startByte = asInt(segment.startIndex ?? segment.start_index);
    const endByte = asInt(segment.endIndex ?? segment.end_index);
    const range = groundingRuneRange(rendered, part, startByte, endByte);
    if (!range) continue;
    const segmentText = str(segment.text);
    if (segmentText) {
      try {
        if (utf8Slice(part.text, startByte, endByte) !== segmentText) continue;
      } catch {
        continue;
      }
    }
    appendGroundingAnnotations(annotations, chunks, support, range.start, range.end, "", seen);
  }
  return annotations.length ? annotations : undefined;
}

/** Original `geminichat.GroundingWebSearchQueries`. */
export function groundingWebSearchQueries(response: Record<string, unknown>): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of asArr(response.candidates)) {
    const metadata = groundingMetadataFromCandidate(candidate);
    if (!metadata) continue;
    const raw = metadata.webSearchQueries || metadata.web_search_queries;
    const list = Array.isArray(raw) ? raw : [];
    for (const item of list) {
      const query = str(item).trim();
      if (!query || seen.has(query)) continue;
      seen.add(query);
      queries.push(query);
    }
  }
  return queries;
}

function partInline(part: Record<string, unknown>): { mime: string; data: string } | null {
  const inline = part.inlineData || part.inline_data;
  if (!inline || typeof inline !== "object") return null;
  const o = asObj(inline);
  const mime = str(o.mimeType || o.mime_type);
  const data = str(o.data);
  if (!mime && !data) return null;
  return { mime, data };
}

function partFunctionCall(part: Record<string, unknown>): Record<string, unknown> | null {
  const call = part.functionCall || part.function_call;
  if (!call || typeof call !== "object") return null;
  return asObj(call);
}

function geminiResponseToolCall(part: Record<string, unknown>): Record<string, unknown> | null {
  const call = partFunctionCall(part);
  if (!call) return null;
  let callId = str(call.id).trim();
  if (!callId) callId = `call_${compactUuid()}`;
  return {
    id: callId,
    type: "function",
    function: {
      name: str(call.name),
      arguments: compactJson(call.args ?? call.arguments),
    },
  };
}

function executableCode(part: Record<string, unknown>): { language: string; code: string } | null {
  const code = part.executableCode || part.executable_code;
  if (!code || typeof code !== "object") return null;
  const o = asObj(code);
  return { language: str(o.language), code: str(o.code) };
}

function codeExecutionResult(part: Record<string, unknown>): string | null {
  const result = part.codeExecutionResult || part.code_execution_result;
  if (!result || typeof result !== "object") return null;
  return str(asObj(result).output);
}

function writeGeminiInline(parts: Record<string, unknown>[]): { content: string; toolCalls: Record<string, unknown>[]; reasoning?: string } {
  let content = "";
  let appended = 0;
  const writeSep = () => {
    if (appended > 0) content += "\n";
    appended += 1;
  };
  const toolCalls: Record<string, unknown>[] = [];
  let reasoning: string | undefined;
  for (const part of parts) {
    const inline = partInline(part);
    if (inline) {
      writeSep();
      if (inline.mime.startsWith("image")) {
        content += `![image](data:${inline.mime};base64,${inline.data})`;
      } else {
        content += `[media](data:${inline.mime};base64,${inline.data})`;
      }
      continue;
    }
    if (partFunctionCall(part)) {
      const tool = geminiResponseToolCall(part);
      if (tool) toolCalls.push(tool);
      continue;
    }
    if (part.thought === true) {
      reasoning = str(part.text);
      continue;
    }
    const exec = executableCode(part);
    if (exec) {
      writeSep();
      content += "```" + exec.language + "\n" + exec.code + "\n```";
      continue;
    }
    if (part.codeExecutionResult || part.code_execution_result) {
      writeSep();
      content += "```output\n" + (codeExecutionResult(part) || "") + "\n```";
      continue;
    }
    const text = str(part.text);
    if (text !== "\n") {
      writeSep();
      content += text;
    }
  }
  return { content, toolCalls, reasoning };
}

/** Original `ResponseGeminiChat2OpenAI`. */
export function responseGeminiChat2OpenAI(id: string, created: number, response: Record<string, unknown>): Record<string, unknown> {
  const choices: Record<string, unknown>[] = [];
  let isToolCall = false;
  for (const candidate of asArr(response.candidates)) {
    const parts = asArr(asObj(candidate.content).parts);
    const rendered = writeGeminiInline(parts);
    const message: Record<string, unknown> = {
      role: "assistant",
      content: rendered.content,
    };
    if (rendered.reasoning) message.reasoning_content = rendered.reasoning;
    if (rendered.toolCalls.length) {
      message.tool_calls = rendered.toolCalls;
      isToolCall = true;
    }
    const annotations = groundingAnnotationsToChat(
      groundingMetadataFromCandidate(candidate),
      asObj(candidate.content),
      rendered.content,
    );
    if (annotations) message.annotations = annotations;
    let finishReason = "stop";
    const rawFinish = candidate.finishReason ?? candidate.finish_reason;
    if (rawFinish != null && str(rawFinish) !== "") finishReason = geminiFinishReason(str(rawFinish));
    if (isToolCall) finishReason = "tool_calls";
    choices.push({
      index: asInt(candidate.index),
      message,
      finish_reason: finishReason,
    });
  }
  return {
    id,
    object: "chat.completion",
    created,
    model: "",
    choices,
  };
}

/** Original Gemini OpenAI-format DoResponse (`GeminiChatHandler`). */
export function openaiFromGeminiResponse(upstream: Record<string, unknown>, model: string, opts: GeminiToOpenAIOpts = {}): Record<string, unknown> {
  const id = opts.id || `chatcmpl-${compactUuid()}`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const response = responseGeminiChat2OpenAI(id, created, upstream);
  response.model = opts.upstreamModel || model;
  const usage = usageFromGeminiMetadata(usageMetadataFromResponse(upstream), opts.fallbackPromptTokens || 0);
  response.usage = openAIUsageToJson(usage || emptyOpenAIUsage());
  return response;
}

function streamWriteGeminiParts(parts: Record<string, unknown>[]): {
  content: string;
  toolCalls: Record<string, unknown>[];
  thought: boolean;
} {
  let content = "";
  let appended = 0;
  const writeSep = () => {
    if (appended > 0) content += "\n";
    appended += 1;
  };
  const toolCalls: Record<string, unknown>[] = [];
  let isThought = false;
  for (const part of parts) {
    const inline = partInline(part);
    if (inline) {
      if (inline.mime.startsWith("image")) {
        writeSep();
        content += `![image](data:${inline.mime};base64,${inline.data})`;
      }
      continue;
    }
    if (partFunctionCall(part)) {
      const tool = geminiResponseToolCall(part);
      if (tool) {
        tool.index = toolCalls.length;
        toolCalls.push(tool);
      }
      continue;
    }
    if (part.thought === true) {
      isThought = true;
      writeSep();
      content += str(part.text);
      continue;
    }
    const exec = executableCode(part);
    if (exec) {
      writeSep();
      content += "```" + exec.language + "\n" + exec.code + "\n```\n";
      continue;
    }
    if (part.codeExecutionResult || part.code_execution_result) {
      writeSep();
      content += "```output\n" + (codeExecutionResult(part) || "") + "\n```\n";
      continue;
    }
    const text = str(part.text);
    if (text !== "\n") {
      writeSep();
      content += text;
    }
  }
  return { content, toolCalls, thought: isThought };
}

/** Original `StreamResponseGeminiChat2OpenAI`. */
export function streamResponseGeminiChat2OpenAI(geminiResponse: Record<string, unknown>): { chunk: Record<string, unknown>; isStop: boolean } {
  const choices: Record<string, unknown>[] = [];
  let isStop = false;
  for (const candidate of asArr(geminiResponse.candidates)) {
    let finish = candidate.finishReason ?? candidate.finish_reason;
    if (finish != null && str(finish) === "STOP") {
      isStop = true;
      finish = null;
    }
    const parts = asArr(asObj(candidate.content).parts);
    const rendered = streamWriteGeminiParts(parts);
    const delta: Record<string, unknown> = {};
    if (rendered.thought) delta.reasoning_content = rendered.content;
    else delta.content = rendered.content;
    if (rendered.toolCalls.length) delta.tool_calls = rendered.toolCalls;
    const annotations = groundingAnnotationsToChat(
      groundingMetadataFromCandidate(candidate),
      asObj(candidate.content),
      rendered.content,
    );
    if (annotations) delta.annotations = annotations;
    let finishReason: string | null = null;
    if (finish != null && str(finish) !== "") finishReason = geminiFinishReason(str(finish));
    if (rendered.toolCalls.length) finishReason = "tool_calls";
    choices.push({
      index: asInt(candidate.index),
      delta,
      logprobs: null,
      finish_reason: finishReason,
    });
  }
  const chunk: Record<string, unknown> = {
    object: "chat.completion.chunk",
    choices,
  };
  const usage = usageFromGeminiMetadata(usageMetadataFromResponse(geminiResponse), 0);
  if (usage) chunk.usage = openAIUsageToJson(usage);
  return { chunk, isStop };
}

type StreamedGeminiPartSpan = {
  partStartByte: number;
  partEndByte: number;
  renderedStartByte: number;
};

type StreamedGeminiPart = {
  text: string;
  spans: StreamedGeminiPartSpan[];
};

/** Original `geminiGroundingStreamCandidate`. */
class GeminiGroundingStreamCandidate {
  rendered = "";
  parts = new Map<number, StreamedGeminiPart>();
  chunks: Record<string, unknown>[] = [];

  appendContent(content: Record<string, unknown>, rendered: string): void {
    const renderedParts = locateRenderedGeminiParts(content, rendered);
    const renderedBase = utf8Bytes(this.rendered).length;
    const parts = asArr(content.parts);
    for (let index = 0; index < parts.length; index++) {
      const partContent = parts[index];
      const text = str(partContent.text);
      if (!text || partContent.thought === true) continue;
      let part = this.parts.get(index);
      if (!part) {
        part = { text: "", spans: [] };
        this.parts.set(index, part);
      }
      const partStart = utf8Bytes(part.text).length;
      part.text += text;
      if (text === "\n" || index >= renderedParts.length || renderedParts[index].startByte < 0) continue;
      part.spans.push({
        partStartByte: partStart,
        partEndByte: partStart + utf8Bytes(text).length,
        renderedStartByte: renderedBase + renderedParts[index].startByte,
      });
    }
    this.rendered += rendered;
  }

  appendGroundingChunks(metadata: Record<string, unknown> | null): void {
    if (!metadata) return;
    const chunks = parseJsonArray(metadata.groundingChunks || metadata.grounding_chunks);
    if (!chunks || !chunks.length) return;
    this.chunks.push(...chunks);
  }

  groundingAnnotations(
    metadata: Record<string, unknown> | null,
    candidateIndex: number,
    seen: Set<string>,
  ): Record<string, unknown>[] | undefined {
    if (!metadata) return undefined;
    this.appendGroundingChunks(metadata);
    const supports = parseJsonArray(metadata.groundingSupports || metadata.grounding_supports);
    if (!this.chunks.length || !supports || !supports.length) return undefined;
    const annotations: Record<string, unknown>[] = [];
    const keyPrefix = `${candidateIndex}:`;
    for (const support of supports) {
      const partIndex = this.groundingPartIndex(support);
      if (partIndex == null) continue;
      const segment = asObj(support.segment);
      const startByte = asInt(segment.startIndex ?? segment.start_index);
      const endByte = asInt(segment.endIndex ?? segment.end_index);
      const range = this.groundingRuneRange(partIndex, startByte, endByte);
      if (!range) continue;
      const part = this.parts.get(partIndex);
      if (!part) continue;
      const segmentText = str(segment.text);
      if (segmentText) {
        try {
          if (utf8Slice(part.text, startByte, endByte) !== segmentText) continue;
        } catch {
          continue;
        }
      }
      appendGroundingAnnotations(annotations, this.chunks, support, range.start, range.end, keyPrefix, seen);
    }
    return annotations.length ? annotations : undefined;
  }

  private groundingPartIndex(support: Record<string, unknown>): number | undefined {
    const segment = asObj(support.segment);
    const explicit = optionalInt(segment.partIndex ?? segment.part_index);
    if (explicit != null) {
      const part = this.parts.get(explicit);
      return part && part.spans.length ? explicit : undefined;
    }
    let sole = -1;
    for (const [partIndex, part] of this.parts) {
      if (!part.spans.length) continue;
      if (sole >= 0) return undefined;
      sole = partIndex;
    }
    return sole >= 0 ? sole : undefined;
  }

  private groundingRuneRange(partIndex: number, startByte: number, endByte: number): { start: number; end: number } | null {
    const part = this.parts.get(partIndex);
    if (!part) return null;
    const partBytes = utf8Bytes(part.text);
    if (startByte < 0 || endByte <= startByte || endByte > partBytes.length) return null;
    if (!utf8ValidPrefix(part.text, startByte) || !utf8ValidPrefix(part.text, endByte)) return null;
    let renderedStart = -1;
    let renderedEnd = -1;
    for (const span of part.spans) {
      if (renderedStart < 0 && startByte >= span.partStartByte && startByte < span.partEndByte) {
        renderedStart = span.renderedStartByte + startByte - span.partStartByte;
      }
      if (endByte > span.partStartByte && endByte <= span.partEndByte) {
        renderedEnd = span.renderedStartByte + endByte - span.partStartByte;
      }
    }
    if (renderedStart < 0 || renderedEnd <= renderedStart) return null;
    const renderedBytes = utf8Bytes(this.rendered);
    if (renderedEnd > renderedBytes.length) return null;
    try {
      if (utf8Slice(this.rendered, renderedStart, renderedEnd) !== utf8Slice(part.text, startByte, endByte)) return null;
    } catch {
      return null;
    }
    if (!utf8ValidPrefix(this.rendered, renderedStart) || !utf8ValidPrefix(this.rendered, renderedEnd)) return null;
    return {
      start: runeCount(utf8Slice(this.rendered, 0, renderedStart)),
      end: runeCount(utf8Slice(this.rendered, 0, renderedEnd)),
    };
  }
}

type GeminiPartialArgPathSegment = { member: string; index: number; isIndex: boolean };

type GeminiPartialToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

const MAX_GEMINI_PARTIAL_ARG_ARRAY_INDEX = 4095;

function choiceHasToolCalls(choice: Record<string, unknown>): boolean {
  const tools = asObj(choice.delta).tool_calls;
  return Array.isArray(tools) && tools.length > 0;
}

function choiceContentString(choice: Record<string, unknown>): string {
  const content = asObj(choice.delta).content;
  return typeof content === "string" ? content : "";
}

function boolFlag(v: unknown): boolean {
  return v === true;
}

function geminiPartialArgValue(partial: Record<string, unknown>): { value: unknown; present: boolean } {
  if (partial.stringValue != null || partial.string_value != null) {
    return { value: str(partial.stringValue ?? partial.string_value), present: true };
  }
  if (partial.numberValue != null || partial.number_value != null) {
    return { value: Number(partial.numberValue ?? partial.number_value), present: true };
  }
  if (partial.boolValue != null || partial.bool_value != null) {
    return { value: Boolean(partial.boolValue ?? partial.bool_value), present: true };
  }
  if (partial.nullValue != null || partial.null_value != null) return { value: null, present: true };
  return { value: null, present: false };
}

function parseGeminiPartialArgMember(path: string, offset: number): { member: string; next: number } {
  const quote = path[offset];
  const start = offset;
  offset += 1;
  while (offset < path.length) {
    if (path[offset] === "\\") {
      offset += 2;
      continue;
    }
    if (path[offset] === quote) {
      let raw = path.slice(start, offset + 1);
      if (quote === "'") {
        raw = `"${raw.slice(1, -1).replace(/"/g, '\\"').replace(/\\'/g, "'")}"`;
      }
      return { member: JSON.parse(raw) as string, next: offset + 1 };
    }
    offset += 1;
  }
  throw new Error("unterminated quoted member");
}

function parseGeminiPartialArgPath(jsonPath: string): GeminiPartialArgPathSegment[] {
  const path = jsonPath.trim();
  if (!path || path[0] !== "$") throw new Error(`unsupported Gemini partial argument path ${JSON.stringify(jsonPath)}`);
  const segments: GeminiPartialArgPathSegment[] = [];
  for (let offset = 1; offset < path.length; ) {
    switch (path[offset]) {
      case ".": {
        offset += 1;
        const start = offset;
        while (offset < path.length && path[offset] !== "." && path[offset] !== "[") offset += 1;
        if (start === offset) throw new Error(`empty member in Gemini partial argument path ${JSON.stringify(jsonPath)}`);
        const member = path.slice(start, offset);
        if (/[\]*?]/.test(member)) throw new Error(`unsupported member ${JSON.stringify(member)} in Gemini partial argument path`);
        segments.push({ member, index: 0, isIndex: false });
        break;
      }
      case "[": {
        offset += 1;
        if (offset >= path.length) throw new Error(`unterminated selector in Gemini partial argument path ${JSON.stringify(jsonPath)}`);
        if (path[offset] === "'" || path[offset] === '"') {
          const parsed = parseGeminiPartialArgMember(path, offset);
          offset = parsed.next;
          if (offset >= path.length || path[offset] !== "]") {
            throw new Error(`unterminated member selector in Gemini partial argument path ${JSON.stringify(jsonPath)}`);
          }
          offset += 1;
          segments.push({ member: parsed.member, index: 0, isIndex: false });
          break;
        }
        const start = offset;
        while (offset < path.length && path[offset] >= "0" && path[offset] <= "9") offset += 1;
        if (start === offset || offset >= path.length || path[offset] !== "]") {
          throw new Error(`unsupported selector in Gemini partial argument path ${JSON.stringify(jsonPath)}`);
        }
        const index = Number(path.slice(start, offset));
        if (!Number.isInteger(index)) {
          throw new Error(`invalid array index in Gemini partial argument path ${JSON.stringify(jsonPath)}`);
        }
        if (index > MAX_GEMINI_PARTIAL_ARG_ARRAY_INDEX) {
          throw new Error(`array index ${index} exceeds Gemini partial argument materialization limit ${MAX_GEMINI_PARTIAL_ARG_ARRAY_INDEX}`);
        }
        offset += 1;
        segments.push({ member: "", index, isIndex: true });
        break;
      }
      default:
        throw new Error(`unsupported selector at offset ${offset} in Gemini partial argument path ${JSON.stringify(jsonPath)}`);
    }
  }
  if (!segments.length) throw new Error(`Gemini partial argument path ${JSON.stringify(jsonPath)} targets the arguments root`);
  return segments;
}

function setGeminiPartialArgValue(current: unknown, path: GeminiPartialArgPathSegment[], value: unknown, appendString: boolean): unknown {
  if (!path.length) {
    if (appendString && typeof current === "string" && typeof value === "string") return current + value;
    return value;
  }
  const segment = path[0];
  if (segment.isIndex) {
    let array: unknown[];
    if (current == null) array = new Array(segment.index + 1);
    else if (Array.isArray(current)) {
      array = current;
      if (array.length <= segment.index) array = array.concat(new Array(segment.index - array.length + 1));
    } else {
      throw new Error(`array index ${segment.index} traverses ${typeof current}`);
    }
    array[segment.index] = setGeminiPartialArgValue(array[segment.index], path.slice(1), value, appendString);
    return array;
  }
  let object: Record<string, unknown>;
  if (current == null) object = {};
  else if (current && typeof current === "object" && !Array.isArray(current)) object = current as Record<string, unknown>;
  else throw new Error(`member ${JSON.stringify(segment.member)} traverses ${typeof current}`);
  object[segment.member] = setGeminiPartialArgValue(object[segment.member], path.slice(1), value, appendString);
  return object;
}

function cloneGeminiChatResponse(response: Record<string, unknown>): Record<string, unknown> {
  return {
    ...response,
    candidates: asArr(response.candidates).map((candidate) => {
      const content = asObj(candidate.content);
      return {
        ...candidate,
        content: {
          ...content,
          parts: asArr(content.parts).map((part) => {
            const next = { ...part };
            const camel = part.functionCall;
            const snake = part.function_call;
            if (camel && typeof camel === "object") next.functionCall = { ...asObj(camel) };
            if (snake && typeof snake === "object") next.function_call = { ...asObj(snake) };
            return next;
          }),
        },
      };
    }),
  };
}

/** Original `GeminiToChatStreamState` used by Gemini→Responses ConvertStreamResponseChunk. */
export class GeminiToChatStreamState {
  id: string;
  created: number;
  private sawToolCall = false;
  private finishEmitted = false;
  private latestUsage: OpenAIUsage | null = null;
  private nextToolIndexByCandidate = new Map<number, number>();
  private toolIndexByCandidateID = new Map<number, Map<string, number>>();
  private partialToolByCandidate = new Map<number, GeminiPartialToolCall>();
  private groundingByCandidate = new Map<number, GeminiGroundingStreamCandidate>();
  private sentGroundingAnnotations = new Set<string>();

  constructor(id: string, created: number) {
    this.id = id.trim() || `chatcmpl-${compactUuid()}`;
    this.created = created || Math.floor(Date.now() / 1000);
  }

  convertChunk(
    geminiResponse: Record<string, unknown>,
    model: string,
    usage: OpenAIUsage | null,
  ): Record<string, unknown>[] {
    const prepared = this.preparePartialFunctionCalls(geminiResponse);
    let hasNonStopFinish = false;
    for (const candidate of asArr(prepared.candidates)) {
      const finish = str(candidate.finishReason ?? candidate.finish_reason).trim();
      if (finish && finish !== "STOP") {
        hasNonStopFinish = true;
        break;
      }
    }
    const { chunk, isStop } = streamResponseGeminiChat2OpenAI(prepared);
    chunk.id = this.id;
    chunk.created = this.created;
    chunk.model = model;
    if (usage) chunk.usage = openAIUsageToJson(usage);
    else delete chunk.usage;
    const candidates = asArr(prepared.candidates);
    const choices = asArr(chunk.choices);
    for (let index = 0; index < candidates.length && index < choices.length; index++) {
      const candidate = candidates[index];
      const choice = choices[index];
      const delta = asObj(choice.delta);
      const tools = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : [];
      const candidateIndex = asInt(candidate.index);
      for (const tool of tools) {
        const callID = str(tool.id).trim();
        let indexesByID = this.toolIndexByCandidateID.get(candidateIndex);
        if (!indexesByID) {
          indexesByID = new Map();
          this.toolIndexByCandidateID.set(candidateIndex, indexesByID);
        }
        let stableIndex = callID ? indexesByID.get(callID) : undefined;
        if (stableIndex == null) {
          stableIndex = this.nextToolIndexByCandidate.get(candidateIndex) || 0;
          this.nextToolIndexByCandidate.set(candidateIndex, stableIndex + 1);
          if (callID) indexesByID.set(callID, stableIndex);
        }
        tool.index = stableIndex;
      }
      let grounding = this.groundingByCandidate.get(candidateIndex);
      if (!grounding) {
        grounding = new GeminiGroundingStreamCandidate();
        this.groundingByCandidate.set(candidateIndex, grounding);
      }
      grounding.appendContent(asObj(candidate.content), choiceContentString(choice));
      const annotations = grounding.groundingAnnotations(
        groundingMetadataFromCandidate(candidate),
        candidateIndex,
        this.sentGroundingAnnotations,
      );
      if (annotations) delta.annotations = annotations;
      else delete delta.annotations;
    }
    if (choices.some((choice) => choiceHasToolCalls(choice))) {
      this.sawToolCall = true;
      if (!hasNonStopFinish) {
        for (const choice of choices) {
          if (str(choice.finish_reason) === "tool_calls") choice.finish_reason = null;
        }
      }
    }
    if (usage) this.latestUsage = usage;
    for (const choice of choices) {
      if (str(choice.finish_reason).trim()) {
        this.finishEmitted = true;
        break;
      }
    }
    const chunks = [chunk];
    if (isStop && !this.finishEmitted) chunks.push(this.terminalChunk(model));
    return chunks;
  }

  finalize(model: string): Record<string, unknown>[] {
    if (this.partialToolByCandidate.size) {
      const candidateIndex = [...this.partialToolByCandidate.keys()].sort((a, b) => a - b)[0];
      const partial = this.partialToolByCandidate.get(candidateIndex)!;
      throw new Error(
        `Gemini stream ended with an incomplete function call for candidate ${candidateIndex} (id ${JSON.stringify(partial.id)}, name ${JSON.stringify(partial.name)})`,
      );
    }
    if (this.finishEmitted) return [];
    return [this.terminalChunk(model)];
  }

  private preparePartialFunctionCalls(response: Record<string, unknown>): Record<string, unknown> {
    const prepared = cloneGeminiChatResponse(response);
    for (const candidate of asArr(prepared.candidates)) {
      const content = asObj(candidate.content);
      const parts: Record<string, unknown>[] = [];
      for (const part of asArr(content.parts)) {
        const call = partFunctionCall(part);
        const partialArgs = call
          ? Array.isArray(call.partialArgs)
            ? call.partialArgs
            : Array.isArray(call.partial_args)
              ? call.partial_args
              : []
          : [];
        if (
          !call ||
          (!this.partialToolByCandidate.has(asInt(candidate.index)) &&
            call.willContinue == null &&
            call.will_continue == null &&
            partialArgs.length === 0)
        ) {
          parts.push(part);
          continue;
        }
        const completed = this.appendPartialFunctionCall(asInt(candidate.index), call);
        if (completed) {
          part.functionCall = completed;
          delete part.function_call;
          parts.push(part);
        }
      }
      content.parts = parts;
    }
    return prepared;
  }

  private appendPartialFunctionCall(candidateIndex: number, call: Record<string, unknown>): Record<string, unknown> | null {
    let current = this.partialToolByCandidate.get(candidateIndex);
    if (!current) {
      current = { id: "", name: "", arguments: {} };
      this.partialToolByCandidate.set(candidateIndex, current);
    }
    const id = str(call.id).trim();
    if (id) {
      if (current.id && current.id !== id) {
        throw new Error(`candidate ${candidateIndex} function call changed id from ${JSON.stringify(current.id)} to ${JSON.stringify(id)}`);
      }
      current.id = id;
    }
    const name = str(call.name).trim();
    if (name) {
      if (current.name && current.name !== name) {
        throw new Error(`candidate ${candidateIndex} function call changed name from ${JSON.stringify(current.name)} to ${JSON.stringify(name)}`);
      }
      current.name = name;
    }
    const partialArgs = Array.isArray(call.partialArgs) ? call.partialArgs : Array.isArray(call.partial_args) ? call.partial_args : [];
    for (const raw of partialArgs) {
      const partial = asObj(raw);
      const path = parseGeminiPartialArgPath(str(partial.jsonPath || partial.json_path));
      const parsed = geminiPartialArgValue(partial);
      if (!parsed.present) continue;
      const updated = setGeminiPartialArgValue(current.arguments, path, parsed.value, partial.stringValue != null || partial.string_value != null);
      if (!updated || typeof updated !== "object" || Array.isArray(updated)) {
        throw new Error(`partial argument path ${JSON.stringify(partial.jsonPath || partial.json_path)} replaced the arguments object`);
      }
      current.arguments = updated as Record<string, unknown>;
    }
    if (boolFlag(call.willContinue) || boolFlag(call.will_continue)) return null;
    if (!current.name) throw new Error(`candidate ${candidateIndex} completed a partial function call without a name`);
    const completed = { id: current.id, name: current.name, args: current.arguments };
    this.partialToolByCandidate.delete(candidateIndex);
    return completed;
  }

  private terminalChunk(model: string): Record<string, unknown> {
    this.finishEmitted = true;
    const chunk: Record<string, unknown> = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: this.sawToolCall ? "tool_calls" : "stop" }],
    };
    if (this.latestUsage) chunk.usage = openAIUsageToJson(this.latestUsage);
    return chunk;
  }
}

function remapGeminiChatHandlerToolIndexes(
  chunk: Record<string, unknown>,
  toolCallIndexByChoice: Map<number, Map<string, number>>,
  nextToolCallIndexByChoice: Map<number, number>,
): void {
  for (const choice of asArr(chunk.choices)) {
    const choiceKey = asInt(choice.index);
    const tools = Array.isArray(asObj(choice.delta).tool_calls) ? (asObj(choice.delta).tool_calls as Record<string, unknown>[]) : [];
    for (const tool of tools) {
      const id = str(tool.id).trim();
      if (!id) continue;
      let byID = toolCallIndexByChoice.get(choiceKey);
      if (!byID) {
        byID = new Map();
        toolCallIndexByChoice.set(choiceKey, byID);
      }
      const existing = byID.get(id);
      if (existing != null) {
        tool.index = existing;
        continue;
      }
      const idx = nextToolCallIndexByChoice.get(choiceKey) || 0;
      nextToolCallIndexByChoice.set(choiceKey, idx + 1);
      byID.set(id, idx);
      tool.index = idx;
    }
  }
}

function startEmptyChunk(id: string, created: number, model: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: null,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
  };
}

function stopChunk(id: string, created: number, model: string, finishReason: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: null,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }],
  };
}

function finalUsageChunk(id: string, created: number, model: string, usage: OpenAIUsage): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: null,
    choices: [],
    usage: openAIUsageToJson(usage),
  };
}

/** Original `GeminiChatStreamHandler` OpenAI-format SSE. */
export function geminiSseToOpenAIChat(sseText: string, opts: GeminiToOpenAIOpts = {}): { body: string; usage: OpenAIUsage } {
  const id = opts.id || `chatcmpl-${compactUuid()}`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const model = opts.upstreamModel || "";
  let finishReason = "stop";
  let sentFirst = false;
  let latestUsage = emptyOpenAIUsage();
  let body = "";
  const toolCallIndexByChoice = new Map<number, Map<string, number>>();
  const nextToolCallIndexByChoice = new Map<number, number>();
  const payloads = looksLikeSse(sseText) ? parseSseDataPayloads(sseText) : [sseText];
  for (const payload of payloads) {
    let geminiResponse: Record<string, unknown>;
    try {
      geminiResponse = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const { chunk, isStop } = streamResponseGeminiChat2OpenAI(geminiResponse);
    chunk.id = id;
    chunk.created = created;
    chunk.model = model;
    chunk.system_fingerprint = null;
    remapGeminiChatHandlerToolIndexes(chunk, toolCallIndexByChoice, nextToolCallIndexByChoice);
    const choices = asArr(chunk.choices);
    const isToolCall = choices.some((c) => asArr(asObj(c.delta).tool_calls).length > 0);
    if (isToolCall) finishReason = "tool_calls";
    const usage = usageFromGeminiMetadata(usageMetadataFromResponse(geminiResponse), opts.fallbackPromptTokens || 0);
    if (usage) {
      latestUsage = usage;
      chunk.usage = openAIUsageToJson(usage);
    }
    if (!sentFirst) {
      sentFirst = true;
      const empty = startEmptyChunk(id, created, model);
      if (chunk.usage) empty.usage = chunk.usage;
      if (isToolCall && choices[0]) {
        const toolCalls = asArr(asObj(choices[0].delta).tool_calls).map((call) => {
          const copy = { ...call, function: { ...asObj(asObj(call).function), arguments: "" } };
          return copy;
        });
        (empty.choices as Record<string, unknown>[])[0] = {
          index: 0,
          delta: { role: "assistant", content: "", tool_calls: toolCalls },
          logprobs: null,
          finish_reason: null,
        };
      }
      body += sseLine(empty);
      if (isToolCall && choices[0]) {
        const delta = asObj(choices[0].delta);
        const tools = asArr(delta.tool_calls).map((call) => ({
          ...call,
          id: "",
          type: null,
          function: { name: "", arguments: str(asObj(asObj(call).function).arguments) },
        }));
        delta.tool_calls = tools;
        if (choices[0].finish_reason) choices[0].finish_reason = null;
      }
    }
    body += sseLine(chunk);
    if (isStop) body += sseLine(stopChunk(id, created, model, finishReason));
  }
  if (!sentFirst) body += sseLine(startEmptyChunk(id, created, model));
  body += sseLine(finalUsageChunk(id, created, model, latestUsage));
  body += "data: [DONE]\n\n";
  return { body, usage: latestUsage };
}

export type GeminiChatEmptyCandidatesError = {
  status: number;
  message: string;
  code: string;
  rejectReason: string;
};

/**
 * Original `GeminiChatHandler` / `GeminiResponsesHandler` leftover when
 * `len(Candidates)==0` after HTTP 200 unmarshal (`promptFeedback.blockReason`
 * → `prompt_blocked` HTTP 400; else `empty_response` HTTP 500).
 * Extra-OK: non-array `candidates` is left to convert (original Unmarshal fails).
 */
export function geminiChatEmptyCandidatesError(
  parsed: Record<string, unknown>,
): GeminiChatEmptyCandidatesError | null {
  const candidates = parsed.candidates;
  if (candidates != null && !Array.isArray(candidates)) return null;
  if (Array.isArray(candidates) && candidates.length > 0) return null;
  const feedback =
    parsed.promptFeedback && typeof parsed.promptFeedback === "object" && !Array.isArray(parsed.promptFeedback)
      ? (parsed.promptFeedback as Record<string, unknown>)
      : null;
  const blockReason = feedback ? feedback.blockReason : undefined;
  if (typeof blockReason === "string") {
    return {
      status: 400,
      message: "request blocked by Gemini API: " + blockReason,
      code: "prompt_blocked",
      rejectReason: `gemini_block_reason=${blockReason}`,
    };
  }
  return {
    status: 500,
    message: "empty response from Gemini API",
    code: "empty_response",
    rejectReason: "gemini_empty_candidates",
  };
}

/**
 * Original `common.Unmarshal` into `dto.GeminiChatResponse` (`GeminiChatHandler`
 * / `GeminiResponsesHandler` / `GeminiTextGenerationHandler`). Syntax errors
 * match `encoding/json`. JSON `null` succeeds as a zero-value struct. Non-object
 * JSON is `json: cannot unmarshal … into Go value of type dto.GeminiChatResponse`.
 * Extra-OK: the original UnmarshalJSON aux type name is an anonymous struct.
 * Extra-OK: nested field type mismatches are left to convert (original fails).
 */
export function geminiChatResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return parsed.message;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type dto.GeminiChatResponse`;
  }
  return null;
}

export function geminiUpstreamToOpenAIChat(
  text: string,
  model: string,
  opts: GeminiToOpenAIOpts = {},
): { json?: Record<string, unknown>; sse?: string; usage: OpenAIUsage } {
  if (looksLikeSse(text)) {
    const converted = geminiSseToOpenAIChat(text, { ...opts, upstreamModel: opts.upstreamModel || model });
    return { sse: converted.body, usage: converted.usage };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { candidates: [{ content: { parts: [{ text }] } }] };
  }
  const json = openaiFromGeminiResponse(parsed, model, opts);
  const usage = usageFromGeminiMetadata(usageMetadataFromResponse(parsed), opts.fallbackPromptTokens || 0);
  return { json, usage: usage || emptyOpenAIUsage() };
}
