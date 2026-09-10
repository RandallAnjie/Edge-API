/** Original `relay/channel/siliconflow` ConvertOpenAIRequest / ConvertImageRequest / GetRequestURL / DoResponse. */

import { asInt, asObj } from "./openai-usage.js";

export type ConvertSiliconFlowOpts = {
  upstreamModelName?: string;
};

const SF_IMAGE_EXTRA_KEYS = [
  "negative_prompt",
  "image_size",
  "batch_size",
  "seed",
  "num_inference_steps",
  "guidance_scale",
  "cfg",
  "image",
  "image2",
  "image3",
] as const;

/** Original `siliconflow.Adaptor.GetRequestURL`. Rerank is `{base}/v1/rerank`; else GetFullRequestURL. */
export function siliconflowRequestURL(base: string, mode: string, requestPath: string): string {
  const root = String(base || "").replace(/\/+$/, "");
  if (mode === "rerank") return `${root}/v1/rerank`;
  const path = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `${root}${path}`;
}

/** Original SiliconFlow ConvertOpenAIRequest: FIM with empty messages injects `{role:user, content:""}`; otherwise passthrough (keeps `stream_options`). */
export function convertSiliconFlowOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertSiliconFlowOpts = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  const messages = Array.isArray(out.messages) ? (out.messages as unknown[]) : [];
  if ((out.prefix != null || out.suffix != null) && messages.length === 0) {
    out.messages = [{ role: "user", content: "" }];
  }
  return out;
}

function extraMap(body: Record<string, unknown>): Record<string, unknown> {
  const extra = body.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) return { ...(extra as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  for (const key of SF_IMAGE_EXTRA_KEYS) {
    if (body[key] != null) out[key] = body[key];
  }
  return out;
}

/** Original `siliconflow.Adaptor.ConvertImageRequest` → `SFImageRequest`. */
export function convertSiliconFlowImageRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out = extraMap(body);
  out.model = body.model;
  out.prompt = body.prompt;
  if (!out.image_size && body.size) out.image_size = body.size;
  if (!out.batch_size) {
    const n = Number(body.n ?? 0);
    if (n) out.batch_size = n;
  }
  return out;
}

/** Original `siliconflow.siliconflowRerankHandler`. Usage from `meta.tokens.input_tokens` / `output_tokens`. */
export function openaiFromSiliconFlowRerank(upstream: Record<string, unknown>): Record<string, unknown> {
  const tokens = asObj(asObj(upstream.meta).tokens);
  const prompt = asInt(tokens.input_tokens);
  const completion = asInt(tokens.output_tokens);
  return {
    results: Array.isArray(upstream.results) ? upstream.results : [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}
