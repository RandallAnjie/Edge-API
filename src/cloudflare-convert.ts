/** Original `relay/channel/cloudflare` ConvertOpenAIRequest / ConvertAudioRequest / GetRequestURL / DoResponse. */

import { parseMultipartForm } from "./multipart-form.js";
import { asObj, sseLine } from "./openai-usage.js";
import { estimateTokenByModel } from "./openai-realtime-usage.js";

export type ConvertCloudflareOpts = {
  upstreamModelName?: string;
  id?: string;
  created?: number;
  fallbackPromptTokens?: number;
  includeUsage?: boolean;
};

function getMaxTokens(req: Record<string, unknown>): number {
  const maxCompletion = Number(req.max_completion_tokens ?? 0);
  if (maxCompletion) return Math.trunc(maxCompletion);
  return Math.trunc(Number(req.max_tokens ?? 0));
}

function estimateCompletionTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.text === "string") out += o.text;
    else if (typeof o.content === "string") out += o.content;
  }
  return out;
}

/** Original `cloudflare.Adaptor.GetRequestURL`. Completions use `/ai/run/{model}`, not `/ai/v1/completions`. */
export function cloudflareRequestURL(base: string, account: string, mode: string, upstreamModel: string): string {
  const root = base.replace(/\/+$/, "");
  const prefix = `${root}/client/v4/accounts/${account}`;
  if (mode === "chat") return `${prefix}/ai/v1/chat/completions`;
  if (mode === "embeddings") return `${prefix}/ai/v1/embeddings`;
  if (mode === "responses") return `${prefix}/ai/v1/responses`;
  return `${prefix}/ai/run/${upstreamModel}`;
}

/** Original `RelayModeAudioTranscription` / `RelayModeAudioTranslation` (cfSTTHandler). */
export function isCloudflareSTTRelayMode(mode?: string): boolean {
  return mode === "audio_transcription" || mode === "audio_translation";
}

/**
 * Original `cloudflare.Adaptor.ConvertAudioRequest`.
 * `FormFile("file")` errors become `"file is required"`; the upstream body is the raw file bytes
 * (not rewritten multipart). `SetupApiRequestHeader` does not copy Content-Type for STT.
 */
export function convertCloudflareAudioRequest(rawBody: ArrayBuffer, contentType: string): Uint8Array {
  let form;
  try {
    form = parseMultipartForm(rawBody, contentType);
  } catch {
    throw new Error("file is required");
  }
  const file = form.files.find((part) => part.name === "file");
  if (!file) throw new Error("file is required");
  return file.data;
}

/**
 * Original `cloudflare.cfSTTHandler` client JSON (`dto.AudioResponse`).
 * Upstream `{ result: { text } }` → `{ text }`. Invalid JSON shape is `ErrorCodeBadResponseBody`.
 */
export function openaiFromCloudflareSTT(upstream: unknown): { text: string } {
  if (upstream == null || typeof upstream !== "object" || Array.isArray(upstream)) {
    throw new Error("bad_response_body");
  }
  const result = (upstream as Record<string, unknown>).result;
  if (result == null) return { text: "" };
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new Error("bad_response_body");
  }
  const text = (result as Record<string, unknown>).text;
  if (text == null) return { text: "" };
  if (typeof text !== "string") throw new Error("bad_response_body");
  return { text };
}

/**
 * Original `service.ResponseText2Usage` used by `cfSTTHandler`.
 * Extra-OK: STT `GetEstimatePromptTokens` does not run original `GetAudioDuration` (prompt stays the
 * worker estimate, 0 for multipart with empty JSON body).
 */
export function cloudflareSTTUsage(
  text: string,
  upstreamModelName: string,
  promptTokens: number,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const completion = estimateTokenByModel(upstreamModelName, text);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
  };
}

/** Original Cloudflare chat ConvertOpenAIRequest: passthrough `request`. */
export function convertCloudflareOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertCloudflareOpts = {},
): Record<string, unknown> {
  return { ...body, model: opts.upstreamModelName || String(body.model || "") };
}

/** Original `cloudflare.convertCf2CompletionsRequest`. Stream/max_tokens 0 are omitempty. */
export function convertCloudflareCompletionsRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (prompt) out.prompt = prompt;
  const maxTokens = getMaxTokens(body);
  if (maxTokens) out.max_tokens = maxTokens;
  if (body.stream) out.stream = true;
  if (body.temperature != null && Number(body.temperature) !== 0) out.temperature = body.temperature;
  return out;
}

function usageFromText(responseText: string, promptTokens: number): Record<string, unknown> {
  const completion = estimateCompletionTokens(responseText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
  };
}

function choiceContent(choice: Record<string, unknown>): string {
  const message = asObj(choice.message);
  if (message.content != null) return stringContent(message.content);
  return stringContent(asObj(choice.delta).content);
}

/** Original `cloudflare.cfHandler`. Rewrites `model`, `id` (`chatcmpl-${rid}`), and usage from text estimate. */
export function openaiFromCloudflareResponse(
  upstream: Record<string, unknown>,
  opts: ConvertCloudflareOpts = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...upstream };
  const model = opts.upstreamModelName || String(upstream.model || "");
  out.model = model;
  out.id = opts.id || String(upstream.id || "");
  const choices = Array.isArray(out.choices) ? (out.choices as Record<string, unknown>[]) : [];
  let responseText = "";
  for (const choice of choices) responseText += choiceContent(choice);
  out.usage = usageFromText(responseText, opts.fallbackPromptTokens || 0);
  return out;
}

/** Original `cloudflare.cfStreamHandler`. Forces `delta.role = assistant`, rewrites id/model, optional usage chunk, then `[DONE]`. */
export function cloudflareUpstreamToOpenAIChat(
  text: string,
  opts: ConvertCloudflareOpts = {},
): { json: Record<string, unknown>; sse: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("data:")) {
    const json = openaiFromCloudflareResponse(JSON.parse(trimmed) as Record<string, unknown>, opts);
    return { json, sse: sseFromCloudflareJson(json, opts) };
  }
  const id = opts.id || "";
  const model = opts.upstreamModelName || "";
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  let sse = "";
  let responseText = "";
  for (const raw of text.split(/\r?\n/)) {
    let data = raw.replace(/\r$/, "");
    if (data.length < "data: ".length) continue;
    if (!data.startsWith("data: ")) continue;
    data = data.slice("data: ".length);
    if (data === "[DONE]") break;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
    for (const choice of choices) {
      const delta: Record<string, unknown> = { ...asObj(choice.delta), role: "assistant" };
      choice.delta = delta;
      responseText += stringContent(delta.content);
    }
    chunk.id = id;
    chunk.model = model;
    sse += sseLine(chunk);
  }
  const usage = usageFromText(responseText, opts.fallbackPromptTokens || 0);
  if (opts.includeUsage) {
    sse += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: null,
      choices: [],
      usage,
    });
  }
  sse += "data: [DONE]\n\n";
  const json: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
    usage,
  };
  return { json, sse };
}

function sseFromCloudflareJson(json: Record<string, unknown>, opts: ConvertCloudflareOpts): string {
  const choice = asObj((json.choices as unknown[])?.[0]);
  const message = asObj(choice.message);
  const created = Number(json.created || Math.floor(Date.now() / 1000));
  const first = {
    id: json.id,
    object: "chat.completion.chunk",
    created,
    model: json.model,
    choices: [{ index: 0, delta: { role: "assistant", content: message.content ?? "" }, finish_reason: null }],
  };
  const done = {
    id: json.id,
    object: "chat.completion.chunk",
    created,
    model: json.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: choice.finish_reason || "stop" }],
  };
  let out = sseLine(first) + sseLine(done);
  if (opts.includeUsage) {
    out += sseLine({
      id: json.id,
      object: "chat.completion.chunk",
      created,
      model: json.model,
      system_fingerprint: null,
      choices: [],
      usage: json.usage,
    });
  }
  return out + "data: [DONE]\n\n";
}
