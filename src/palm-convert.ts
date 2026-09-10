/** Original `relay/channel/palm` ConvertOpenAIRequest / GetRequestURL / SetupRequestHeader / DoResponse. */

import { asInt, asObj, sseLine } from "./openai-usage.js";

export type ConvertPalmOpts = {
  upstreamModelName?: string;
  created?: number;
  id?: string;
  fallbackPromptTokens?: number;
};

function estimateCompletionTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Original `palm.Adaptor.GetRequestURL`. Model is hardcoded `chat-bison-001:generateMessage`. */
export function palmRequestURL(base: string): string {
  const root = String(base || "").replace(/\/+$/, "");
  return `${root}/v1beta2/models/chat-bison-001:generateMessage`;
}

/** Original PaLM ConvertOpenAIRequest: return `request` as-is (keeps `stream_options`). */
export function convertPalmOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertPalmOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

function candidateContent(candidate: Record<string, unknown>): string {
  return String(candidate.Content ?? candidate.content ?? "");
}

/** Original `palm.responsePaLM2OpenAI` / `palmHandler`. */
export function openaiFromPalmResponse(
  upstream: Record<string, unknown>,
  opts: ConvertPalmOpts = {},
): Record<string, unknown> {
  const err = asObj(upstream.error);
  const candidates = Array.isArray(upstream.candidates) ? (upstream.candidates as Record<string, unknown>[]) : [];
  if (asInt(err.code) !== 0 || candidates.length === 0) {
    throw new Error(String(err.message || ""));
  }
  const content = candidateContent(candidates[0]);
  const prompt = opts.fallbackPromptTokens || 0;
  const completion = estimateCompletionTokens(content);
  return {
    id: "",
    object: "",
    created: null,
    model: "",
    choices: candidates.map((candidate, index) => ({
      index,
      message: { role: "assistant", content: candidateContent(candidate) },
      finish_reason: "stop",
    })),
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

/** Original `palm.palmStreamHandler`. Reads the whole JSON body (not SSE); stream model is `palm2`. */
export function palmUpstreamToOpenAIChat(
  text: string,
  opts: ConvertPalmOpts = {},
): { json: Record<string, unknown>; sse: string } {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      json: { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
      sse: "data: [DONE]\n\n",
    };
  }
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const id = opts.id || "";
  const candidates = Array.isArray(parsed.candidates) ? (parsed.candidates as Record<string, unknown>[]) : [];
  const content = candidates.length ? candidateContent(candidates[0]) : "";
  const prompt = opts.fallbackPromptTokens || 0;
  const completion = estimateCompletionTokens(content);
  const json: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model: "palm2",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model: "palm2",
    choices: [{ delta: { content }, finish_reason: "stop" }],
  };
  return { json, sse: sseLine(chunk) + "data: [DONE]\n\n" };
}
