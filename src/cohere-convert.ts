/** Original `relay/channel/cohere` ConvertOpenAIRequest / ConvertRerankRequest / DoResponse. */

import { asInt, asObj, sseLine } from "./openai-usage.js";

export type ConvertCohereOpts = {
  upstreamModelName?: string;
  /** Original `common.CohereSafetySetting`; default `NONE` omits `safety_mode`. */
  safetySetting?: string;
  id?: string;
  created?: number;
};

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") out += o.text;
  }
  return out;
}

function getMaxTokens(req: Record<string, unknown>): number {
  const maxCompletion = Number(req.max_completion_tokens ?? 0);
  if (maxCompletion) return Math.trunc(maxCompletion);
  return Math.trunc(Number(req.max_tokens ?? 0));
}

function historyRole(role: string): string {
  if (role === "assistant") return "CHATBOT";
  if (role === "system") return "SYSTEM";
  return "USER";
}

/** Original `cohere.stopReasonCohere2OpenAI`. */
export function stopReasonCohere2OpenAI(reason: string): string {
  if (reason === "COMPLETE") return "stop";
  if (reason === "MAX_TOKENS") return "max_tokens";
  return reason;
}

/** Original `cohere.requestOpenAI2Cohere`. */
export function convertCohereOpenAIRequest(body: Record<string, unknown>, opts: ConvertCohereOpts = {}): Record<string, unknown> {
  const model = opts.upstreamModelName || String(body.model || "");
  let maxTokens = getMaxTokens(body);
  if (maxTokens === 0) maxTokens = 4000;
  const chatHistory: { role: string; message: string }[] = [];
  let message = "";
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (const msg of messages) {
    if (msg.role === "user") {
      message = stringContent(msg.content);
    } else {
      chatHistory.push({
        role: historyRole(String(msg.role || "")),
        message: stringContent(msg.content),
      });
    }
  }
  const out: Record<string, unknown> = {
    model,
    chat_history: chatHistory,
    message,
    stream: Boolean(body.stream),
    max_tokens: maxTokens,
  };
  const safety = opts.safetySetting ?? "NONE";
  if (safety !== "NONE") out.safety_mode = safety;
  return out;
}

/** Original `cohere.requestConvertRerank2Cohere`. */
export function convertCohereRerankRequest(body: Record<string, unknown>, opts: ConvertCohereOpts = {}): Record<string, unknown> {
  let topN = asInt(body.top_n);
  if (topN <= 0) topN = 1;
  return {
    query: String(body.query || ""),
    documents: Array.isArray(body.documents) ? body.documents : [],
    model: opts.upstreamModelName || String(body.model || ""),
    top_n: topN,
    return_documents: true,
  };
}

function billedUsage(meta: Record<string, unknown>): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const billed = asObj(asObj(meta).billed_units);
  const prompt = asInt(billed.input_tokens);
  const completion = asInt(billed.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Original `cohere.cohereHandler` OpenAI chat JSON. */
export function openaiFromCohereResponse(
  upstream: Record<string, unknown>,
  model: string,
  opts: { id?: string; created?: number } = {},
): Record<string, unknown> {
  const usage = billedUsage(asObj(upstream.meta));
  return {
    id: String(upstream.response_id || opts.id || ""),
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model,
    usage,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: upstream.text ?? "" },
        finish_reason: stopReasonCohere2OpenAI(String(upstream.finish_reason || "")),
      },
    ],
  };
}

/** Original `cohere.cohereRerankHandler`. */
export function openaiFromCohereRerank(
  upstream: Record<string, unknown>,
  opts: { estimatePromptTokens?: number } = {},
): Record<string, unknown> {
  const billed = billedUsage(asObj(upstream.meta));
  const usage =
    billed.prompt_tokens === 0
      ? {
          prompt_tokens: opts.estimatePromptTokens || 0,
          completion_tokens: 0,
          total_tokens: opts.estimatePromptTokens || 0,
        }
      : billed;
  return {
    results: Array.isArray(upstream.results) ? upstream.results : [],
    usage,
  };
}

function parseCohereStreamLines(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (looksLikeJsonObject(trimmed)) {
    try {
      return [JSON.parse(trimmed) as Record<string, unknown>];
    } catch {
      /* NDJSON */
    }
  }
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ln = line.trim();
    if (!ln) continue;
    try {
      chunks.push(JSON.parse(ln) as Record<string, unknown>);
    } catch {
      /* original logs and continues */
    }
  }
  return chunks;
}

function looksLikeJsonObject(text: string): boolean {
  return text.startsWith("{");
}

/** Original `cohere.cohereStreamHandler` OpenAI SSE. */
export function cohereUpstreamToOpenAIChat(
  text: string,
  model: string,
  opts: { id?: string; created?: number; fallbackPromptTokens?: number } = {},
): { json: Record<string, unknown>; sse: string } {
  const id = opts.id || `chatcmpl-${Date.now()}`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const lines = parseCohereStreamLines(text);
  if (lines.length === 1 && (lines[0].response_id != null || asObj(lines[0].meta).billed_units)) {
    const json = openaiFromCohereResponse(lines[0], model, { id, created });
    return { json, sse: sseFromChat(json) };
  }
  let sse = "";
  let responseText = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason = "stop";
  for (const cohereResp of lines) {
    const payload: Record<string, unknown> = {
      id,
      created,
      object: "chat.completion.chunk",
      model,
    };
    if (cohereResp.is_finished) {
      finishReason = stopReasonCohere2OpenAI(String(cohereResp.finish_reason || ""));
      payload.choices = [{ delta: {}, index: 0, finish_reason: finishReason }];
      const nested = asObj(cohereResp.response);
      if (Object.keys(nested).length) usage = billedUsage(asObj(nested.meta));
    } else {
      const content = String(cohereResp.text || "");
      responseText += content;
      payload.choices = [{ delta: { role: "assistant", content }, index: 0 }];
    }
    sse += sseLine(payload);
  }
  sse += "data: [DONE]\n\n";
  if (usage.prompt_tokens === 0) {
    const prompt = opts.fallbackPromptTokens || 0;
    const completion = Math.max(1, Math.ceil(responseText.length / 4));
    usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }
  const json: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    usage,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: responseText },
        finish_reason: finishReason,
      },
    ],
  };
  return { json, sse };
}

function sseFromChat(json: Record<string, unknown>): string {
  const id = String(json.id || "");
  const created = Number(json.created || Math.floor(Date.now() / 1000));
  const model = String(json.model || "");
  const choice = Array.isArray(json.choices) ? asObj(json.choices[0]) : {};
  const message = asObj(choice.message);
  const first = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: message.content ?? "" }, finish_reason: null }],
  };
  const done = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
  };
  return sseLine(first) + sseLine(done) + "data: [DONE]\n\n";
}
