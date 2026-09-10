/** Original `relay/channel/vertex` ConvertOpenAIRequest (Claude wrap, Gemini, imagen) + URL builders. */

import { convertOpenAIChatToClaude, type ConvertClaudeOpts } from "./claude-convert.js";
import { convertOpenAIChatToGemini } from "./gemini-convert.js";
import type { ReasoningHostSettings } from "./reasoning.js";

/** Original `vertex.RequestMode*`. */
export type VertexRequestMode = "claude" | "gemini" | "opensource";

/** Original `vertex.anthropicVersion`. */
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

/** Original `vertex.claudeModelMap`. */
export const VERTEX_CLAUDE_MODEL_MAP: Record<string, string> = {
  "claude-3-sonnet-20240229": "claude-3-sonnet@20240229",
  "claude-3-opus-20240229": "claude-3-opus@20240229",
  "claude-3-haiku-20240307": "claude-3-haiku@20240307",
  "claude-3-5-sonnet-20240620": "claude-3-5-sonnet@20240620",
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet-v2@20241022",
  "claude-3-7-sonnet-20250219": "claude-3-7-sonnet@20250219",
  "claude-sonnet-4-20250514": "claude-sonnet-4@20250514",
  "claude-opus-4-20250514": "claude-opus-4@20250514",
  "claude-opus-4-1-20250805": "claude-opus-4-1@20250805",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5@20250929",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5@20251001",
  "claude-opus-4-5-20251101": "claude-opus-4-5@20251101",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-8": "claude-opus-4-8",
};

export const VERTEX_IMAGE_TOKENS = 258;

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const o = asObj(part);
        if (typeof o.text === "string") return o.text;
        return "";
      })
      .join("");
  }
  return "";
}

/** Original `vertex.Adaptor.Init` RequestMode. */
export function vertexRequestMode(upstreamModelName: string): VertexRequestMode {
  if (upstreamModelName.startsWith("claude")) return "claude";
  if (upstreamModelName.includes("llama") || upstreamModelName.includes("-maas")) return "opensource";
  return "gemini";
}

/** Original `vertex.copyRequest`. */
export function wrapVertexClaude(claudeReq: Record<string, unknown>, version = VERTEX_ANTHROPIC_VERSION): Record<string, unknown> {
  const out: Record<string, unknown> = { anthropic_version: version, messages: claudeReq.messages ?? [] };
  if (claudeReq.system != null) out.system = claudeReq.system;
  if (claudeReq.max_tokens != null) out.max_tokens = claudeReq.max_tokens;
  if (claudeReq.stream != null) out.stream = claudeReq.stream;
  if (claudeReq.temperature != null) out.temperature = claudeReq.temperature;
  if (claudeReq.top_p != null) out.top_p = claudeReq.top_p;
  if (claudeReq.top_k != null) out.top_k = claudeReq.top_k;
  if (claudeReq.stop_sequences != null) out.stop_sequences = claudeReq.stop_sequences;
  if (claudeReq.tools != null) out.tools = claudeReq.tools;
  if (claudeReq.tool_choice != null) out.tool_choice = claudeReq.tool_choice;
  if (claudeReq.thinking != null) out.thinking = claudeReq.thinking;
  if (claudeReq.output_config != null) out.output_config = claudeReq.output_config;
  return out;
}

/** Original `vertex.removeFunctionCallIDs`. */
export function removeFunctionCallIDs(request: Record<string, unknown>): void {
  const stripParts = (parts: unknown) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      const p = asObj(part);
      const call = p.functionCall || p.function_call;
      if (call && typeof call === "object") {
        delete (call as Record<string, unknown>).id;
      }
      const resp = p.functionResponse || p.function_response;
      if (resp && typeof resp === "object") {
        delete (resp as Record<string, unknown>).id;
      }
    }
  };
  for (const content of Array.isArray(request.contents) ? (request.contents as Record<string, unknown>[]) : []) {
    stripParts(content.parts);
  }
  for (const nested of Array.isArray(request.requests) ? (request.requests as Record<string, unknown>[]) : []) {
    removeFunctionCallIDs(nested);
  }
}

function sizeToAspectRatio(size: string): string {
  const trimmed = size.trim();
  if (!trimmed) return "1:1";
  if (trimmed.includes(":")) return trimmed;
  switch (trimmed) {
    case "256x256":
    case "512x512":
    case "1024x1024":
      return "1:1";
    case "1536x1024":
      return "3:2";
    case "1024x1536":
      return "2:3";
    case "1024x1792":
      return "9:16";
    case "1792x1024":
      return "16:9";
    default:
      return "1:1";
  }
}

function qualityToImageSize(quality: string): string {
  switch (quality) {
    case "hd":
    case "high":
    case "2K":
      return "2K";
    default:
      return "1K";
  }
}

/** Original `gemini.Adaptor.ConvertImageRequest` for imagen models. */
export function convertGeminiImageRequest(request: {
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
}): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    sampleCount: request.n && request.n > 0 ? request.n : 1,
    aspectRatio: sizeToAspectRatio(request.size || ""),
    personGeneration: "allow_adult",
  };
  if (request.quality) parameters.imageSize = qualityToImageSize(request.quality);
  return {
    instances: [{ prompt: request.prompt }],
    parameters,
  };
}

function openaiChatToImagen(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  let prompt = "";
  for (const m of messages) {
    if (m.role === "user") {
      prompt = messageText(m.content);
      if (prompt) break;
    }
  }
  if (!prompt && typeof body.prompt === "string") prompt = body.prompt;
  if (!prompt) throw new Error("prompt is required for image generation");
  let n = Number(body.n ?? 1) || 1;
  let size = typeof body.size === "string" ? body.size : "1024x1024";
  const extra = asObj(body.extra_body);
  if (typeof extra.n === "number" && extra.n > 0) n = extra.n;
  if (typeof extra.size === "string") size = extra.size;
  if (typeof extra.aspectRatio === "string" && extra.aspectRatio) size = extra.aspectRatio;
  const params = asObj(extra.parameters);
  if (typeof params.aspectRatio === "string" && extra.parameters) size = params.aspectRatio;
  return convertGeminiImageRequest({
    prompt,
    n,
    size,
    quality: typeof body.quality === "string" ? body.quality : undefined,
  });
}

export type ConvertVertexOpts = ConvertClaudeOpts & { settings?: ReasoningHostSettings };

/** Original `vertex.Adaptor.ConvertOpenAIRequest`. */
export function convertVertexOpenAIRequest(body: Record<string, unknown>, opts: ConvertVertexOpts): Record<string, unknown> {
  const upstream = opts.upstreamModelName || String(body.model || "");
  const mode = vertexRequestMode(upstream);
  if (mode === "gemini" && upstream.startsWith("imagen")) return openaiChatToImagen(body);
  if (mode === "claude") {
    const claudeReq = convertOpenAIChatToClaude(body, opts);
    return wrapVertexClaude(claudeReq);
  }
  if (mode === "opensource") {
    return { ...body, model: upstream };
  }
  const geminiReq = convertOpenAIChatToGemini(body, opts);
  if (opts.settings?.removeFunctionResponseIdEnabled !== false) removeFunctionCallIDs(geminiReq);
  return geminiReq;
}

/** Original `GeminiImageHandler` OpenAI image JSON. */
export function openaiFromImagenResponse(upstream: Record<string, unknown>, opts: { created?: number } = {}): Record<string, unknown> {
  const predictions = Array.isArray(upstream.predictions) ? (upstream.predictions as Record<string, unknown>[]) : [];
  const data: Record<string, string>[] = [];
  for (const prediction of predictions) {
    if (prediction.raiFilteredReason) continue;
    data.push({
      url: "",
      b64_json: String(prediction.bytesBase64Encoded || ""),
      revised_prompt: "",
    });
  }
  return {
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data,
  };
}

export function imagenUsage(imageCount: number): { prompt: number; completion: number; total: number; cachedTokens: number; promptCacheHitTokens: number } {
  const prompt = VERTEX_IMAGE_TOKENS * Math.max(0, imageCount);
  return { prompt, completion: 0, total: prompt, cachedTokens: 0, promptCacheHitTokens: 0 };
}

/** Original `vertex.GetModelRegion`. */
export function getModelRegion(other: string, localModelName: string): string {
  const trimmed = String(other || "").trim();
  if (trimmed.startsWith("{")) {
    try {
      const m = JSON.parse(trimmed) as Record<string, unknown>;
      if (m[localModelName] != null) return String(m[localModelName]);
      if (m.default != null) return String(m.default);
      return "global";
    } catch {
      return other;
    }
  }
  return other;
}

function normalizeVertexBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

function normalizeVertexRegion(region: string): string {
  const trimmed = region.trim();
  return trimmed || "global";
}

function appendVertexAPIVersion(baseURL: string, version: string): string {
  const v = version.replace(/^\/+|\/+$/g, "");
  if (!v) return baseURL;
  if (baseURL.endsWith("/" + v)) return baseURL;
  return baseURL + "/" + v;
}

/** Original `vertex.BuildAPIBaseURL`. */
export function buildVertexAPIBaseURL(baseURL: string, version: string, projectID: string, region: string): string {
  const normalizedBase = normalizeVertexBaseURL(baseURL);
  if (normalizedBase) {
    let normalized = appendVertexAPIVersion(normalizedBase, version);
    region = normalizeVertexRegion(region);
    if (projectID.trim()) normalized = `${normalized}/projects/${projectID}/locations/${region}`;
    return normalized;
  }
  region = normalizeVertexRegion(region);
  if (!projectID.trim()) {
    if (region === "global") return `https://aiplatform.googleapis.com/${version}`;
    return `https://${region}-aiplatform.googleapis.com/${version}`;
  }
  if (region === "global") return `https://aiplatform.googleapis.com/${version}/projects/${projectID}/locations/global`;
  return `https://${region}-aiplatform.googleapis.com/${version}/projects/${projectID}/locations/${region}`;
}

export function buildPublisherModelURL(
  baseURL: string,
  version: string,
  projectID: string,
  region: string,
  publisher: string,
  modelName: string,
  action: string,
): string {
  return `${buildVertexAPIBaseURL(baseURL, version, projectID, region)}/publishers/${publisher}/models/${modelName}:${action}`;
}

export function buildGoogleModelURL(baseURL: string, version: string, projectID: string, region: string, modelName: string, action: string): string {
  return buildPublisherModelURL(baseURL, version, projectID, region, "google", modelName, action);
}

export function buildAnthropicModelURL(baseURL: string, version: string, projectID: string, region: string, modelName: string, action: string): string {
  return buildPublisherModelURL(baseURL, version, projectID, region, "anthropic", modelName, action);
}

export function buildOpenSourceChatCompletionsURL(baseURL: string, projectID: string, region: string): string {
  return `${buildVertexAPIBaseURL(baseURL, "v1beta1", projectID, region)}/endpoints/openapi/chat/completions`;
}

export function vertexClaudeURLModel(upstreamModel: string): string {
  return VERTEX_CLAUDE_MODEL_MAP[upstreamModel] || upstreamModel;
}

export function vertexActionSuffix(mode: VertexRequestMode, upstreamModel: string, stream: boolean): string {
  if (mode === "gemini") {
    if (upstreamModel.startsWith("imagen")) return "predict";
    return stream ? "streamGenerateContent?alt=sse" : "generateContent";
  }
  if (mode === "claude") return stream ? "streamRawPredict?alt=sse" : "rawPredict";
  return "";
}

export function vertexProjectIdFromKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed.startsWith("{")) return "";
  try {
    const creds = JSON.parse(trimmed) as { project_id?: string };
    return String(creds.project_id || "");
  } catch {
    return "";
  }
}
