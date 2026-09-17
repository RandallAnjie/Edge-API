/** Original `relay/channel/jina` ConvertOpenAIRequest / ConvertEmbeddingRequest / GetRequestURL / DoResponse. */

import { asInt, asObj } from "./openai-usage.js";

export type ConvertJinaOpts = {
  upstreamModelName?: string;
};

/** Original `jina.Adaptor.GetRequestURL`. Chat/other modes error `invalid relay mode`. */
export function jinaRequestURL(base: string, mode: string): string {
  const root = String(base || "").replace(/\/+$/, "");
  if (mode === "rerank") return `${root}/v1/rerank`;
  if (mode === "embeddings") return `${root}/v1/embeddings`;
  throw new Error("invalid relay mode");
}

/** Original Jina ConvertOpenAIRequest: return `request` as-is (keeps extra fields). */
export function convertJinaOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertJinaOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

/** Original `jina.Adaptor.ConvertEmbeddingRequest`: `EncodingFormat = ""` (omitempty drops it). */
export function convertJinaEmbeddingRequest(
  body: Record<string, unknown>,
  opts: ConvertJinaOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  delete out.encoding_format;
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

/** Original `common_handler.RerankHandler` for non-Xinference: `Usage.PromptTokens = Usage.TotalTokens`. */
export function openaiFromJinaRerank(upstream: Record<string, unknown>): Record<string, unknown> {
  const usage = { ...asObj(upstream.usage) };
  usage.prompt_tokens = asInt(usage.total_tokens);
  return {
    results: Array.isArray(upstream.results) ? upstream.results : [],
    usage,
  };
}
