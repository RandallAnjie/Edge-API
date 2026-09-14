/** Original Volc / xAI / DeepSeek ConvertOpenAIRequest JSON (not the OpenAI adaptor). */

import { convertClaudeRequest } from "./claude-convert.js";
import { parseDeepSeekV4ThinkingSuffix, shouldPreserveThinkingSuffix, type ReasoningHostSettings } from "./reasoning.js";

export type VendorConvertOpts = {
  originModelName: string;
  upstreamModelName: string;
  settings?: ReasoningHostSettings;
};

/** Original `volcengine.Adaptor.ConvertOpenAIRequest`. */
export function convertVolcOpenAIRequest(body: Record<string, unknown>, opts: VendorConvertOpts): Record<string, unknown> {
  const settings = opts.settings || {};
  let upstream = opts.upstreamModelName || String(body.model || "");
  const out: Record<string, unknown> = { ...body, model: upstream };
  if (
    !shouldPreserveThinkingSuffix(opts.originModelName, settings) &&
    !shouldPreserveThinkingSuffix(upstream, settings) &&
    upstream.endsWith("-thinking") &&
    upstream.startsWith("deepseek")
  ) {
    upstream = upstream.slice(0, -"-thinking".length);
    out.model = upstream;
    out.thinking = { type: "enabled" };
  }
  return out;
}

/** Original `xai.Adaptor.ConvertOpenAIRequest`. */
export function convertXaiOpenAIRequest(body: Record<string, unknown>, opts: VendorConvertOpts): Record<string, unknown> {
  const settings = opts.settings || {};
  let upstream = opts.upstreamModelName || String(body.model || "");
  const out: Record<string, unknown> = { ...body, model: upstream };
  if (upstream.endsWith("-search")) {
    upstream = upstream.slice(0, -"-search".length);
    out.model = upstream;
    out.search_parameters = { mode: "on" };
    return out;
  }
  if (String(out.model || "").startsWith("grok-3-mini")) {
    const maxCompletion = Number(out.max_completion_tokens ?? 0);
    const maxTokens = Number(out.max_tokens ?? 0);
    if (maxCompletion === 0 && maxTokens !== 0) {
      out.max_completion_tokens = out.max_tokens;
      delete out.max_tokens;
    }
    const preserve =
      shouldPreserveThinkingSuffix(opts.originModelName, settings) || shouldPreserveThinkingSuffix(String(out.model || ""), settings);
    let model = String(out.model || "");
    if (!preserve && model.endsWith("-high")) {
      out.reasoning_effort = "high";
      model = model.slice(0, -"-high".length);
    } else if (!preserve && model.endsWith("-low")) {
      out.reasoning_effort = "low";
      model = model.slice(0, -"-low".length);
    }
    out.model = model;
  }
  return out;
}

/**
 * Original `xai.Adaptor.ConvertImageRequest`.
 * quality, size, and style are not supported; only model/prompt/n/response_format are forwarded.
 * `n` defaults to 1 when omitted (`lo.FromPtrOr(request.N, uint(1))`) and is omitted when 0 (`json:"n,omitempty"`).
 */
export function convertXaiImageRequest(body: Record<string, unknown>): Record<string, unknown> {
  const nRaw = body.n;
  const n = nRaw === undefined || nRaw === null ? 1 : Number(nRaw);
  const out: Record<string, unknown> = {
    model: body.model ?? "",
    prompt: String(body.prompt ?? ""),
  };
  if (n) out.n = n;
  const responseFormat = body.response_format;
  if (typeof responseFormat === "string" && responseFormat) out.response_format = responseFormat;
  return out;
}

/** Original `deepseek.Adaptor.ConvertOpenAIRequest` / `applyDeepSeekV4OpenAIThinkingSuffix`. */
export function convertDeepSeekOpenAIRequest(body: Record<string, unknown>, opts: VendorConvertOpts): Record<string, unknown> {
  const settings = opts.settings || {};
  let model = opts.upstreamModelName || String(body.model || "");
  const out: Record<string, unknown> = { ...body, model };
  if (shouldPreserveThinkingSuffix(model, settings) || shouldPreserveThinkingSuffix(opts.originModelName, settings)) {
    return out;
  }
  const parsed = parseDeepSeekV4ThinkingSuffix(model);
  if (!parsed.ok) return out;
  out.model = parsed.base;
  out.thinking = { type: parsed.thinkingType };
  out.reasoning_effort = parsed.effort;
  if (!parsed.effort) delete out.reasoning_effort;
  return out;
}

/** Original `deepseek.Adaptor.ConvertClaudeRequest` / `applyDeepSeekV4ClaudeThinkingSuffix`. */
export function convertDeepSeekClaudeRequest(body: Record<string, unknown>, opts: VendorConvertOpts): Record<string, unknown> {
  const settings = opts.settings || {};
  const req = convertClaudeRequest(body, {
    originModelName: opts.originModelName,
    upstreamModelName: opts.upstreamModelName,
    settings,
  });
  let modelName = opts.upstreamModelName || String(req.model || "");
  if (shouldPreserveThinkingSuffix(modelName, settings) || shouldPreserveThinkingSuffix(opts.originModelName, settings)) {
    return req;
  }
  const parsed = parseDeepSeekV4ThinkingSuffix(modelName);
  if (!parsed.ok) return req;
  req.model = parsed.base;
  req.thinking = { type: parsed.thinkingType };
  if (!parsed.effort) delete req.output_config;
  else req.output_config = { effort: parsed.effort };
  return req;
}
