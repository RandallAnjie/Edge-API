/** Original `relaykit/relayconvert/internal/gemini_chat/to_oai_chat_resp.go` + Gemini OpenAI-format DoResponse. */

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
