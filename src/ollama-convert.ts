/** Original `relay/channel/ollama` ConvertOpenAIRequest (`/api/chat`, `/api/generate`, `/api/embed`) + DoResponse. */

import { compactUuid, emptyOpenAIUsage, openAIUsageToJson, sseLine } from "./openai-usage.js";

export type ConvertOllamaOpts = {
  upstreamModelName?: string;
  resolveMedia?: (url: string) => { data: string; mime: string } | null;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function decodeDataURL(url: string): string | null {
  const m = String(url).match(/^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function imageBase64(url: string, opts: ConvertOllamaOpts): string | null {
  const dataURL = decodeDataURL(url);
  if (dataURL) return dataURL;
  if (opts.resolveMedia) {
    const media = opts.resolveMedia(url);
    if (media?.data) return media.data;
  }
  return null;
}

function getMaxTokens(req: Record<string, unknown>): number {
  const maxCompletion = Number(req.max_completion_tokens ?? 0);
  if (maxCompletion) return Math.trunc(maxCompletion);
  return Math.trunc(Number(req.max_tokens ?? 0));
}

function samplingOptions(req: Record<string, unknown>): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (req.temperature != null) options.temperature = req.temperature;
  if (req.top_p != null) options.top_p = req.top_p;
  if (req.top_k != null) options.top_k = req.top_k;
  if (req.frequency_penalty != null) options.frequency_penalty = req.frequency_penalty;
  if (req.presence_penalty != null) options.presence_penalty = req.presence_penalty;
  if (req.seed != null) options.seed = Math.trunc(Number(req.seed));
  const maxTokens = getMaxTokens(req);
  if (maxTokens) options.num_predict = maxTokens;
  if (req.stop != null) {
    if (typeof req.stop === "string") options.stop = [req.stop];
    else if (Array.isArray(req.stop)) {
      const arr = req.stop.filter((item): item is string => typeof item === "string");
      if (arr.length) options.stop = arr;
    }
  }
  return Object.keys(options).length ? options : undefined;
}

/** Original `ollama.toOllamaResponseFormat`. */
export function toOllamaResponseFormat(responseFormat: unknown): unknown {
  if (responseFormat == null) return undefined;
  const fmt = asObj(responseFormat);
  const type = String(fmt.type || "");
  if (type === "json" || type === "json_object") return "json";
  if (type === "json_schema") {
    const schema = fmt.json_schema;
    if (schema == null || schema === "") return undefined;
    try {
      const parsed = typeof schema === "string" ? (JSON.parse(schema) as Record<string, unknown>) : asObj(schema);
      return parsed.schema ?? undefined;
    } catch (err) {
      throw new Error(`invalid ollama response format: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

/** Original `openAIChatToOllamaChat` think mapping from `think` / `reasoning.effort` / `reasoning_effort`. */
export function thinkValue(req: Record<string, unknown>): unknown {
  if (req.think != null && req.think !== "") return req.think;
  let effort = String(req.reasoning_effort || "");
  if (req.reasoning != null && req.reasoning !== "") {
    if (typeof req.reasoning === "string") {
      try {
        const parsed = JSON.parse(req.reasoning) as Record<string, unknown>;
        effort = String(parsed.effort || effort);
      } catch (err) {
        throw new Error(`invalid ollama reasoning: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      effort = String(asObj(req.reasoning).effort || effort);
    }
  }
  if (!effort) return undefined;
  if (effort === "none") return false;
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") return effort;
  throw new Error(`unsupported ollama reasoning effort ${JSON.stringify(effort)}`);
}

function messageImages(content: unknown, opts: ConvertOllamaOpts): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? "" : String(content), images: [] };
  const images: string[] = [];
  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const o = asObj(part);
    const type = String(o.type || "text");
    if (type === "text") text += String(o.text || "");
    if (type === "image_url") {
      const image = asObj(o.image_url);
      const url = String(image.url || o.url || "");
      const data = imageBase64(url, opts);
      if (data) images.push(data);
    }
  }
  return { text, images };
}

function parseToolCallArguments(raw: unknown): unknown {
  if (raw == null || raw === "") return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Original `ollama.openAIChatToOllamaChat`. */
export function convertOllamaOpenAIRequest(req: Record<string, unknown>, opts: ConvertOllamaOpts = {}): Record<string, unknown> {
  const model = opts.upstreamModelName || String(req.model || "");
  const think = thinkValue(req);
  const out: Record<string, unknown> = {
    model,
    messages: [],
    stream: Boolean(req.stream),
  };
  const format = toOllamaResponseFormat(req.response_format);
  if (format != null) out.format = format;
  const options = samplingOptions(req);
  if (options) out.options = options;
  if (think != null) out.think = think;

  const tools = Array.isArray(req.tools) ? (req.tools as Record<string, unknown>[]) : [];
  if (tools.length) {
    out.tools = tools.map((tool) => {
      const fn = asObj(tool.function);
      return {
        type: "function",
        function: {
          name: String(fn.name || ""),
          ...(fn.description ? { description: fn.description } : {}),
          ...(fn.parameters != null ? { parameters: fn.parameters } : {}),
        },
      };
    });
  }

  const messages: Record<string, unknown>[] = [];
  const toolNamesByCallID: Record<string, string> = {};
  for (const m of Array.isArray(req.messages) ? (req.messages as Record<string, unknown>[]) : []) {
    const { text, images } = messageImages(m.content, opts);
    const cm: Record<string, unknown> = { role: String(m.role || "user") };
    if (text) cm.content = text;
    if (images.length) cm.images = images;
    if (m.role === "assistant") {
      const reasoning = m.reasoning_content ?? m.reasoning;
      if (typeof reasoning === "string" && reasoning) cm.thinking = reasoning;
    }
    if (m.role === "tool") {
      cm.tool_call_id = String(m.tool_call_id || "");
      cm.tool_name = String(m.name || toolNamesByCallID[String(m.tool_call_id || "")] || "");
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls: Record<string, unknown>[] = [];
      for (const tc of m.tool_calls as Record<string, unknown>[]) {
        const fn = asObj(tc.function);
        const oc: Record<string, unknown> = {};
        if (tc.id) oc.id = tc.id;
        oc.function = { name: String(fn.name || ""), arguments: parseToolCallArguments(fn.arguments) };
        calls.push(oc);
        if (tc.id) toolNamesByCallID[String(tc.id)] = String(fn.name || "");
      }
      if (calls.length) cm.tool_calls = calls;
    }
    messages.push(cm);
  }
  out.messages = messages;
  return out;
}

function promptFrom(req: Record<string, unknown>): string {
  const prompt = req.prompt;
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((item) => (typeof item === "string" ? item : ""))
      .join("");
  }
  return prompt == null ? "" : String(prompt);
}

/** Original `ollama.openAIToGenerate`. */
export function convertOllamaGenerateRequest(req: Record<string, unknown>, opts: ConvertOllamaOpts = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: opts.upstreamModelName || String(req.model || ""),
    stream: Boolean(req.stream),
  };
  const prompt = promptFrom(req);
  if (prompt) out.prompt = prompt;
  if (typeof req.suffix === "string") out.suffix = req.suffix;
  if (req.think != null && req.think !== "") out.think = req.think;
  const format = toOllamaResponseFormat(req.response_format);
  if (format != null) out.format = format;
  const options = samplingOptions(req);
  if (options) out.options = options;
  return out;
}

function parseEmbeddingInput(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === "string");
  return [];
}

/** Original `ollama.requestOpenAI2Embeddings`. */
export function convertOllamaEmbeddingRequest(req: Record<string, unknown>, opts: ConvertOllamaOpts = {}): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (req.temperature != null) options.temperature = req.temperature;
  if (req.top_p != null) options.top_p = req.top_p;
  if (req.frequency_penalty != null) options.frequency_penalty = req.frequency_penalty;
  if (req.presence_penalty != null) options.presence_penalty = req.presence_penalty;
  if (req.seed != null) options.seed = Math.trunc(Number(req.seed));
  const dimensions = Number(req.dimensions ?? 0);
  if (req.dimensions != null) options.dimensions = dimensions;
  const parsed = parseEmbeddingInput(req.input);
  const out: Record<string, unknown> = {
    model: opts.upstreamModelName || String(req.model || ""),
    input: parsed.length === 1 ? parsed[0] : parsed,
  };
  if (Object.keys(options).length) out.options = options;
  if (dimensions) out.dimensions = dimensions;
  return out;
}

function toUnix(ts: string): number {
  if (!ts) return Math.floor(Date.now() / 1000);
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

function thinkingText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "null") return "";
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  return "";
}

function ollamaToolCallsToOpenAI(toolCalls: unknown[], startIndex: number, includeIndex: boolean): { calls: Record<string, unknown>[]; next: number } {
  const result: Record<string, unknown>[] = [];
  let index = startIndex;
  for (const tc of toolCalls) {
    const o = asObj(tc);
    const fn = asObj(o.function);
    let args = "{}";
    try {
      args = JSON.stringify(fn.arguments ?? {});
    } catch {
      args = "{}";
    }
    if (!args) args = "{}";
    const id = String(o.id || `call_${index}`);
    const call: Record<string, unknown> = {
      id,
      type: "function",
      function: { name: String(fn.name || ""), arguments: args },
    };
    if (includeIndex) call.index = index;
    result.push(call);
    index += 1;
  }
  return { calls: result, next: index };
}

function parseOllamaChunks(textOrJson: string | Record<string, unknown>): Record<string, unknown>[] {
  if (typeof textOrJson !== "string") return [textOrJson];
  const trimmed = textOrJson.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return [parsed as Record<string, unknown>];
  } catch {
    /* NDJSON */
  }
  const chunks: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const ln = line.trim();
    if (!ln) continue;
    try {
      chunks.push(JSON.parse(ln) as Record<string, unknown>);
    } catch {
      /* skip bad lines when aggregating non-stream, matching ollamaChatHandler */
    }
  }
  return chunks;
}

function streamChoice(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { delta, logprobs: null, finish_reason: null, index: 0, ...extra };
}

/** Original `ollama.ollamaChatHandler` OpenAI chat JSON. */
export function openaiFromOllamaChatResponse(
  textOrJson: string | Record<string, unknown>,
  model: string,
  opts: { id?: string; created?: number } = {},
): Record<string, unknown> {
  const chunks = parseOllamaChunks(textOrJson);
  if (!chunks.length) throw new Error("bad_response_body");
  let aggContent = "";
  let reasoning = "";
  let last: Record<string, unknown> = {};
  let toolCallIndex = 0;
  const toolCalls: Record<string, unknown>[] = [];
  for (const ck of chunks) {
    last = ck;
    const message = ck.message != null && typeof ck.message === "object" ? asObj(ck.message) : null;
    if (message) {
      const think = thinkingText(message.thinking);
      if (think) reasoning += think;
      if (typeof message.content === "string" && message.content) aggContent += message.content;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const converted = ollamaToolCallsToOpenAI(message.tool_calls as unknown[], toolCallIndex, false);
        toolCallIndex = converted.next;
        toolCalls.push(...converted.calls);
      }
    } else if (typeof ck.response === "string" && ck.response) {
      aggContent += ck.response;
    }
  }
  const upstreamModel = String(last.model || model);
  const created = opts.created ?? toUnix(String(last.created_at || ""));
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = Number(last.prompt_eval_count || 0);
  usage.completion_tokens = Number(last.eval_count || 0);
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  usage.input_tokens = usage.prompt_tokens;
  usage.output_tokens = usage.completion_tokens;
  let finishReason = String(last.done_reason || "stop") || "stop";
  if (toolCalls.length) finishReason = "tool_calls";
  const message: Record<string, unknown> = { role: "assistant", content: aggContent || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: opts.id || compactUuid(),
    model: upstreamModel,
    object: "chat.completion",
    created,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: openAIUsageToJson(usage),
  };
}

/** Original `ollama.ollamaEmbeddingHandler`. */
export function openaiFromOllamaEmbedding(upstream: Record<string, unknown>, model: string): Record<string, unknown> {
  if (upstream.error) throw new Error(`ollama error: ${String(upstream.error)}`);
  const embeddings = Array.isArray(upstream.embeddings) ? (upstream.embeddings as number[][]) : [];
  const prompt = Number(upstream.prompt_eval_count || 0);
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = prompt;
  usage.completion_tokens = 0;
  usage.total_tokens = prompt;
  usage.input_tokens = prompt;
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({ index, object: "embedding", embedding })),
    model,
    usage: openAIUsageToJson(usage),
  };
}

/** Original `ollama.ollamaStreamHandler` OpenAI SSE. */
export function ollamaNdjsonToOpenAIChat(
  text: string,
  model: string,
  opts: { id?: string; created?: number } = {},
): { body: string; json: Record<string, unknown>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } {
  const id = opts.id || compactUuid();
  let created = opts.created ?? Math.floor(Date.now() / 1000);
  let streamModel = model;
  let toolCallIndex = 0;
  const chunks = parseOllamaChunks(text);
  const sse: string[] = [];
  sse.push(
    sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model: streamModel,
      system_fingerprint: null,
      choices: [streamChoice({ role: "assistant", content: "" })],
      usage: null,
    }),
  );
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason = "stop";
  for (const chunk of chunks) {
    if (chunk.model) streamModel = String(chunk.model);
    created = toUnix(String(chunk.created_at || "")) || created;
    if (!chunk.done) {
      const hasMessage = chunk.message != null && typeof chunk.message === "object";
      const message = hasMessage ? asObj(chunk.message) : {};
      const content = hasMessage ? String(message.content || "") : String(chunk.response || "");
      const delta: Record<string, unknown> = { role: "assistant" };
      if (content) delta.content = content;
      const think = thinkingText(message.thinking);
      if (think) delta.reasoning_content = think;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const converted = ollamaToolCallsToOpenAI(message.tool_calls as unknown[], toolCallIndex, true);
        toolCallIndex = converted.next;
        delta.tool_calls = converted.calls;
      }
      sse.push(
        sseLine({
          id,
          object: "chat.completion.chunk",
          created,
          model: streamModel,
          system_fingerprint: null,
          choices: [streamChoice(delta)],
          usage: null,
        }),
      );
      continue;
    }
    usage = {
      prompt_tokens: Number(chunk.prompt_eval_count || 0),
      completion_tokens: Number(chunk.eval_count || 0),
      total_tokens: Number(chunk.prompt_eval_count || 0) + Number(chunk.eval_count || 0),
    };
    finishReason = String(chunk.done_reason || "stop") || "stop";
    if (toolCallIndex > 0) finishReason = "tool_calls";
    sse.push(
      sseLine({
        id,
        object: "chat.completion.chunk",
        created,
        model: streamModel,
        system_fingerprint: null,
        choices: [{ finish_reason: finishReason, index: 0, delta: {}, logprobs: null }],
        usage: null,
      }),
    );
    sse.push(
      sseLine({
        id,
        object: "chat.completion.chunk",
        created,
        model: streamModel,
        system_fingerprint: null,
        choices: [],
        usage,
      }),
    );
    sse.push("data: [DONE]\n\n");
    break;
  }
  const json = chunks.length
    ? openaiFromOllamaChatResponse(text, model, { id, created })
    : {
        id,
        model: streamModel,
        object: "chat.completion",
        created,
        choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
  return { body: sse.join(""), json, usage };
}

export function ollamaUpstreamToOpenAIChat(
  text: string,
  model: string,
  opts: { id?: string; created?: number } = {},
): { json: Record<string, unknown>; sse: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } {
  const stream = ollamaNdjsonToOpenAIChat(text, model, opts);
  return { json: stream.json, sse: stream.body, usage: stream.usage };
}
