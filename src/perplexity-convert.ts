/** Original `relay/channel/perplexity` ConvertOpenAIRequest / GetRequestURL. */

export type ConvertPerplexityOpts = {
  upstreamModelName?: string;
};

function getMaxTokens(req: Record<string, unknown>): number {
  const maxCompletion = Number(req.max_completion_tokens ?? 0);
  if (maxCompletion) return Math.trunc(maxCompletion);
  return Math.trunc(Number(req.max_tokens ?? 0));
}

function clampTopP(body: Record<string, unknown>): number | undefined {
  if (!("top_p" in body) || body.top_p == null) return undefined;
  const v = Number(body.top_p);
  return v >= 1 ? 0.99 : (body.top_p as number);
}

/** Original `perplexity.Adaptor.GetRequestURL`. Chat is `{base}/chat/completions` (no `/v1`). */
export function perplexityRequestURL(base: string, mode: string): string {
  const root = base.replace(/\/+$/, "");
  if (mode === "responses") return `${root}/v1/responses`;
  return `${root}/chat/completions`;
}

/** Original `perplexity.requestOpenAI2Perplexity`. Messages keep Role+Content only. */
export function convertPerplexityOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertPerplexityOpts = {},
): Record<string, unknown> {
  const messages = (Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : []).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const out: Record<string, unknown> = {
    model: opts.upstreamModelName || String(body.model || ""),
    messages,
  };
  if (body.stream) out.stream = true;
  if (body.temperature != null && Number(body.temperature) !== 0) out.temperature = body.temperature;
  const topP = clampTopP(body);
  if (topP) out.top_p = topP;
  if (body.frequency_penalty != null && Number(body.frequency_penalty) !== 0) out.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty != null && Number(body.presence_penalty) !== 0) out.presence_penalty = body.presence_penalty;
  if (body.search_domain_filter != null) out.search_domain_filter = body.search_domain_filter;
  if (body.search_recency_filter != null) out.search_recency_filter = body.search_recency_filter;
  if (body.return_images) out.return_images = body.return_images;
  if (body.return_related_questions) out.return_related_questions = body.return_related_questions;
  if (body.search_mode != null) out.search_mode = body.search_mode;
  if ("max_tokens" in body || "max_completion_tokens" in body) {
    const maxTokens = getMaxTokens(body);
    if (maxTokens) out.max_tokens = maxTokens;
  }
  return out;
}
