/** Original `relay/channel/mokaai` ConvertOpenAIRequest / GetRequestURL / DoResponse. */

import { asObj } from "./openai-usage.js";

export type ConvertMokaOpts = {
  upstreamModelName?: string;
};

/** Original `mokaai.Adaptor.GetRequestURL`. `m3e*` → `{base}/embeddings`, else `{base}/chat/`. */
export function mokaRequestURL(base: string, upstreamModel: string): string {
  const root = String(base || "").replace(/\/+$/, "");
  const suffix = String(upstreamModel || "").startsWith("m3e") ? "embeddings" : "chat/";
  return `${root}/${suffix}`;
}

function parseInput(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const part of input) {
    if (typeof part === "string") out.push(part);
  }
  return out;
}

/** Original `mokaai.embeddingRequestOpenAI2Moka`. Chat ConvertOpenAIRequest is `"not implemented"`. */
export function convertMokaEmbeddingRequest(
  body: Record<string, unknown>,
  opts: ConvertMokaOpts = {},
): Record<string, unknown> {
  return {
    input: parseInput(body.input),
    model: opts.upstreamModelName || String(body.model || ""),
  };
}

/** Original `mokaai.embeddingResponseMoka2OpenAI`. Model is hardcoded `baidu-embedding`. */
export function openaiFromMokaEmbedding(upstream: Record<string, unknown>): Record<string, unknown> {
  const data = Array.isArray(upstream.data) ? (upstream.data as Record<string, unknown>[]) : [];
  return {
    object: "list",
    data: data.map((item) => ({
      object: item.object,
      index: item.index,
      embedding: item.embedding,
    })),
    model: "baidu-embedding",
    usage: asObj(upstream.usage),
  };
}
