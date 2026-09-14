/** Original Volc / xAI / DeepSeek ConvertOpenAIRequest JSON (not the OpenAI adaptor). */

import { convertClaudeRequest } from "./claude-convert.js";
import { asInt, asObj, emptyOpenAIUsage, openAIUsageToJson, parseSseDataPayloads, type OpenAIUsage } from "./openai-usage.js";
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

function xaiUsageFromRaw(raw: unknown): OpenAIUsage {
  const rec = asObj(raw);
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = asInt(rec.prompt_tokens);
  usage.completion_tokens = asInt(rec.completion_tokens);
  usage.total_tokens = asInt(rec.total_tokens);
  usage.input_tokens = asInt(rec.input_tokens);
  usage.output_tokens = asInt(rec.output_tokens);
  usage.claude_cache_creation_5_m_tokens = asInt(rec.claude_cache_creation_5_m_tokens);
  usage.claude_cache_creation_1_h_tokens = asInt(rec.claude_cache_creation_1_h_tokens);
  const hit = asInt(rec.prompt_cache_hit_tokens);
  if (hit) usage.prompt_cache_hit_tokens = hit;
  if (typeof rec.usage_semantic === "string" && rec.usage_semantic) usage.usage_semantic = rec.usage_semantic;
  if (typeof rec.usage_source === "string" && rec.usage_source) usage.usage_source = rec.usage_source;
  if (rec.billing_usage && typeof rec.billing_usage === "object") usage.billing_usage = rec.billing_usage as Record<string, unknown>;
  const promptDetails = asObj(rec.prompt_tokens_details);
  usage.prompt_tokens_details = {
    cached_tokens: asInt(promptDetails.cached_tokens),
    text_tokens: asInt(promptDetails.text_tokens),
    audio_tokens: asInt(promptDetails.audio_tokens),
    image_tokens: asInt(promptDetails.image_tokens),
  };
  const cachedCreation = asInt(promptDetails.cached_creation_tokens);
  if (cachedCreation) usage.prompt_tokens_details.cached_creation_tokens = cachedCreation;
  const cacheWrite = asInt(promptDetails.cache_write_tokens);
  if (cacheWrite) usage.prompt_tokens_details.cache_write_tokens = cacheWrite;
  const completionDetails = asObj(rec.completion_tokens_details);
  usage.completion_tokens_details = {
    text_tokens: asInt(completionDetails.text_tokens),
    audio_tokens: asInt(completionDetails.audio_tokens),
    image_tokens: asInt(completionDetails.image_tokens),
    reasoning_tokens: asInt(completionDetails.reasoning_tokens),
  };
  if (rec.input_tokens_details && typeof rec.input_tokens_details === "object") {
    const inputDetails = asObj(rec.input_tokens_details);
    usage.input_tokens_details = {
      cached_tokens: asInt(inputDetails.cached_tokens),
      text_tokens: asInt(inputDetails.text_tokens),
      audio_tokens: asInt(inputDetails.audio_tokens),
      image_tokens: asInt(inputDetails.image_tokens),
    };
  }
  return usage;
}

function xaiUsageJson(raw: unknown, rewriteTextTokens: boolean): Record<string, unknown> {
  const usage = xaiUsageFromRaw(raw);
  usage.completion_tokens = usage.total_tokens - usage.prompt_tokens;
  if (rewriteTextTokens) {
    usage.completion_tokens_details.text_tokens =
      usage.completion_tokens - usage.completion_tokens_details.reasoning_tokens;
  }
  const json = openAIUsageToJson(usage);
  const rec = asObj(raw);
  if (rec.cost != null) json.cost = rec.cost;
  return json;
}

/**
 * Original `xAIHandler` (non-stream chat DoResponse).
 * `CompletionTokens = TotalTokens - PromptTokens`;
 * `CompletionTokenDetails.TextTokens = CompletionTokens - ReasoningTokens`.
 */
export function openaiFromXaiResponse(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid xAI response");
  }
  const parsed = asObj(body);
  return {
    id: parsed.id ?? "",
    object: parsed.object ?? "",
    created: asInt(parsed.created),
    model: parsed.model ?? "",
    choices: parsed.choices ?? null,
    usage: parsed.usage == null ? null : xaiUsageJson(parsed.usage, true),
    system_fingerprint: parsed.system_fingerprint ?? "",
  };
}

/**
 * Original `xAIStreamHandler` / `streamResponseXAI2OpenAI`.
 * Rewrites each chunk `usage.completion_tokens` to `total - prompt` and always appends `[DONE]`.
 * Does not rewrite `completion_tokens_details.text_tokens`.
 */
export function xaiSseToOpenAIChat(text: string): { sse: string; usageBody: Record<string, unknown> } {
  let lastUsage: Record<string, unknown> | undefined;
  const events: string[] = [];
  for (const payload of parseSseDataPayloads(text)) {
    let rec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const usageJson =
      rec.usage != null && typeof rec.usage === "object" ? xaiUsageJson(rec.usage, false) : null;
    if (usageJson) lastUsage = usageJson;
    events.push(
      `data: ${JSON.stringify({
        id: rec.id ?? "",
        object: rec.object ?? "",
        created: asInt(rec.created),
        model: rec.model ?? "",
        system_fingerprint: null,
        choices: rec.choices ?? null,
        usage: usageJson,
      })}\n\n`,
    );
  }
  events.push("data: [DONE]\n\n");
  return { sse: events.join(""), usageBody: lastUsage || {} };
}
