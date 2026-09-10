/** Original Volc / xAI / DeepSeek ConvertOpenAIRequest JSON (not the OpenAI adaptor). */

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
