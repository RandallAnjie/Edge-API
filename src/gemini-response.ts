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
