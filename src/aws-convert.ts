/** Original `relay/channel/aws` ConvertOpenAIRequest, ConvertClaudeRequest URL→base64, API-key Converse URL, and AKSK InvokeModel helpers. */

import { convertClaudeRequest, convertOpenAIChatToClaude, type ConvertClaudeOpts } from "./claude-convert.js";
import { getBase64DataFromUrl } from "./file-source.js";
import { emptyOpenAIUsage, openAIUsageToJson } from "./openai-usage.js";

/** Original `aws.awsModelIDMap`. */
export const AWS_MODEL_ID_MAP: Record<string, string> = {
  "claude-3-sonnet-20240229": "anthropic.claude-3-sonnet-20240229-v1:0",
  "claude-3-opus-20240229": "anthropic.claude-3-opus-20240229-v1:0",
  "claude-3-haiku-20240307": "anthropic.claude-3-haiku-20240307-v1:0",
  "claude-3-5-sonnet-20240620": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "claude-3-5-sonnet-20241022": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "claude-3-5-haiku-20241022": "anthropic.claude-3-5-haiku-20241022-v1:0",
  "claude-3-7-sonnet-20250219": "anthropic.claude-3-7-sonnet-20250219-v1:0",
  "claude-sonnet-4-20250514": "anthropic.claude-sonnet-4-20250514-v1:0",
  "claude-opus-4-20250514": "anthropic.claude-opus-4-20250514-v1:0",
  "claude-opus-4-1-20250805": "anthropic.claude-opus-4-1-20250805-v1:0",
  "claude-sonnet-4-5-20250929": "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-sonnet-4-6": "anthropic.claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-opus-4-5-20251101": "anthropic.claude-opus-4-5-20251101-v1:0",
  "claude-opus-4-6": "anthropic.claude-opus-4-6-v1",
  "claude-opus-4-7": "anthropic.claude-opus-4-7",
  "claude-opus-4-8": "anthropic.claude-opus-4-8",
  "nova-micro-v1:0": "amazon.nova-micro-v1:0",
  "nova-lite-v1:0": "amazon.nova-lite-v1:0",
  "nova-pro-v1:0": "amazon.nova-pro-v1:0",
  "nova-premier-v1:0": "amazon.nova-premier-v1:0",
  "nova-canvas-v1:0": "amazon.nova-canvas-v1:0",
  "nova-reel-v1:0": "amazon.nova-reel-v1:0",
  "nova-reel-v1:1": "amazon.nova-reel-v1:1",
  "nova-sonic-v1:0": "amazon.nova-sonic-v1:0",
};

/** Original `aws.isNovaModel`. */
export function isNovaModel(modelId: string): boolean {
  return modelId.includes("nova-");
}

/** Original `aws.getAwsModelID`. */
export function getAwsModelID(requestModel: string): string {
  return AWS_MODEL_ID_MAP[requestModel] || requestModel;
}

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
  return content == null ? "" : String(content);
}

function parseStopSequences(stop: unknown): string[] {
  if (stop == null) return [];
  if (typeof stop === "string") return stop ? [stop] : [];
  if (Array.isArray(stop)) return stop.filter((item): item is string => typeof item === "string" && item !== "");
  return [];
}

/** Original `aws.convertToNovaRequest`. */
export function convertToNovaRequest(req: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(req.messages) ? (req.messages as Record<string, unknown>[]) : [];
  const novaMessages = messages.map((msg) => ({
    role: String(msg.role || "user"),
    content: [{ text: messageText(msg.content) }],
  }));
  const novaReq: Record<string, unknown> = {
    schemaVersion: "messages-v1",
    messages: novaMessages,
  };
  const maxTokens = Number(req.max_tokens ?? 0);
  const temperature = Number(req.temperature ?? 0);
  const topP = Number(req.top_p ?? 0);
  const topK = Number(req.top_k ?? 0);
  const stops = parseStopSequences(req.stop);
  if (maxTokens || temperature || topP || topK || req.stop != null) {
    const inferenceConfig: Record<string, unknown> = {};
    if (maxTokens) inferenceConfig.maxTokens = Math.trunc(maxTokens);
    if (temperature) inferenceConfig.temperature = temperature;
    if (topP) inferenceConfig.topP = topP;
    if (topK) inferenceConfig.topK = Math.trunc(topK);
    if (stops.length) inferenceConfig.stopSequences = stops;
    novaReq.inferenceConfig = inferenceConfig;
  }
  return novaReq;
}

/** Original `aws.Adaptor.ConvertOpenAIRequest`. */
export function convertAwsOpenAIRequest(body: Record<string, unknown>, opts: ConvertClaudeOpts): Record<string, unknown> {
  if (isNovaModel(String(body.model || ""))) {
    return convertToNovaRequest(body);
  }
  return convertOpenAIChatToClaude(body, opts);
}

function jsonGoKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "boolean":
      return "bool";
    case "string":
      return "string";
    case "number":
      return "number";
    case "object":
      return "object";
    default:
      return typeof v;
  }
}

/**
 * Original `dto.ClaudeMessage.ParseContent` via `kitutil.Any2Type[[]ClaudeMediaMessage]`.
 */
function parseClaudeMessageContent(content: unknown): Record<string, unknown>[] {
  if (content == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(content)) as unknown;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`json: cannot unmarshal ${jsonGoKind(parsed)} into Go value of type []dto.ClaudeMediaMessage`);
  }
  const out: Record<string, unknown>[] = [];
  for (const item of parsed) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`json: cannot unmarshal ${jsonGoKind(item)} into Go value of type dto.ClaudeMediaMessage`);
    }
    out.push(item as Record<string, unknown>);
  }
  return out;
}

/**
 * Original `aws.Adaptor.ConvertClaudeRequest`: `claude.Adaptor.ConvertClaudeRequest`
 * then rewrite `source.type == "url"` via `service.GetBase64Data`.
 */
export async function convertAwsClaudeRequest(body: Record<string, unknown>, opts: ConvertClaudeOpts = {}): Promise<Record<string, unknown>> {
  const req = convertClaudeRequest(body, opts);
  const messages = Array.isArray(req.messages) ? [...(req.messages as unknown[])] : [];
  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i];
    const message = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    let updated = false;
    if (typeof message.content !== "string" && message.content != null) {
      let content: Record<string, unknown>[];
      try {
        content = parseClaudeMessageContent(message.content);
      } catch (err) {
        throw new Error(`failed to parse message content: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (let i2 = 0; i2 < content.length; i2++) {
        const media = { ...content[i2] };
        const src = media.source;
        if (!src || typeof src !== "object" || Array.isArray(src)) continue;
        const source = { ...(src as Record<string, unknown>) };
        if (source.type !== "url") continue;
        try {
          const got = await getBase64DataFromUrl(String(source.url || ""));
          source.media_type = got.mimeType;
          source.data = got.data;
          delete source.url;
          source.type = "base64";
        } catch (err) {
          throw new Error(`get file base64 from url failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        media.source = source;
        content[i2] = media;
        updated = true;
      }
      if (updated) message.content = content;
    }
    if (updated) messages[i] = message;
  }
  req.messages = messages;
  return req;
}

/** Original `handleNovaRequest` OpenAI chat JSON. */
export function openaiFromNovaResponse(upstream: Record<string, unknown>, model: string, opts: { id?: string; created?: number } = {}): Record<string, unknown> {
  const output = asObj(asObj(upstream.output).message);
  const content = Array.isArray(output.content) ? (output.content as { text?: string }[]) : [];
  const text = content[0]?.text || "";
  const usageIn = asObj(upstream.usage);
  const usage = emptyOpenAIUsage();
  usage.prompt_tokens = Number(usageIn.inputTokens || 0);
  usage.completion_tokens = Number(usageIn.outputTokens || 0);
  usage.total_tokens = Number(usageIn.totalTokens || usage.prompt_tokens + usage.completion_tokens);
  return {
    id: opts.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: openAIUsageToJson(usage),
  };
}

/** Original `aws.Adaptor.GetRequestURL` API-key Converse URL (`fmt.Sprintf` argument order). */
export function awsConverseUrl(modelId: string, region: string): string {
  return `https://bedrock-runtime.${modelId}.amazonaws.com/model/${region}/converse`;
}

export function parseAwsApiKey(key: string): { apiKey: string; region: string } {
  const parts = key.split("|");
  if (parts.length !== 2) throw new Error("invalid aws api key, should be in format of <api-key>|<region>");
  return { apiKey: parts[0], region: parts[1] };
}

/** Original `aws.AwsClaudeRequest.AnthropicVersion`. */
export const AWS_BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/** Original `aws.awsModelCanCrossRegionMap`. */
export const AWS_MODEL_CAN_CROSS_REGION: Record<string, Record<string, boolean>> = {
  "anthropic.claude-3-sonnet-20240229-v1:0": { us: true, eu: true, ap: true },
  "anthropic.claude-3-opus-20240229-v1:0": { us: true },
  "anthropic.claude-3-haiku-20240307-v1:0": { us: true, eu: true, ap: true },
  "anthropic.claude-3-5-sonnet-20240620-v1:0": { us: true, eu: true, ap: true },
  "anthropic.claude-3-5-sonnet-20241022-v2:0": { us: true, ap: true },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { us: true },
  "anthropic.claude-3-7-sonnet-20250219-v1:0": { us: true, ap: true, eu: true },
  "anthropic.claude-sonnet-4-20250514-v1:0": { us: true, ap: true, eu: true },
  "anthropic.claude-opus-4-20250514-v1:0": { us: true },
  "anthropic.claude-opus-4-1-20250805-v1:0": { us: true },
  "anthropic.claude-sonnet-4-5-20250929-v1:0": { us: true, ap: true, eu: true },
  "anthropic.claude-sonnet-4-6": { us: true, ap: true, eu: true },
  "anthropic.claude-opus-4-5-20251101-v1:0": { us: true, ap: true, eu: true },
  "anthropic.claude-opus-4-6-v1": { us: true, ap: true, eu: true },
  "anthropic.claude-opus-4-7": { us: true, ap: true, eu: true },
  "anthropic.claude-opus-4-8": { us: true, ap: true, eu: true },
  "anthropic.claude-haiku-4-5-20251001-v1:0": { us: true, ap: true, eu: true },
  "amazon.nova-micro-v1:0": { us: true, eu: true, apac: true },
  "amazon.nova-lite-v1:0": { us: true, eu: true, apac: true },
  "amazon.nova-pro-v1:0": { us: true, eu: true, apac: true },
  "amazon.nova-premier-v1:0": { us: true },
  "amazon.nova-canvas-v1:0": { us: true, eu: true, apac: true },
  "amazon.nova-reel-v1:0": { us: true, eu: true, apac: true },
  "amazon.nova-reel-v1:1": { us: true },
  "amazon.nova-sonic-v1:0": { us: true, eu: true, apac: true },
};

/** Original `aws.awsRegionCrossModelPrefixMap`. */
export const AWS_REGION_CROSS_MODEL_PREFIX: Record<string, string> = {
  us: "us",
  eu: "eu",
  ap: "apac",
};

/** Original `aws.getAwsRegionPrefix`. */
export function getAwsRegionPrefix(awsRegionId: string): string {
  const parts = String(awsRegionId || "").split("-");
  return parts.length > 0 ? parts[0] : "";
}

/** Original `aws.awsModelCanCrossRegion`. */
export function awsModelCanCrossRegion(awsModelId: string, awsRegionPrefix: string): boolean {
  const regionSet = AWS_MODEL_CAN_CROSS_REGION[awsModelId];
  return Boolean(regionSet && regionSet[awsRegionPrefix]);
}

/** Original `aws.awsModelCrossRegion`. */
export function awsModelCrossRegion(awsModelId: string, awsRegionPrefix: string): string {
  const modelPrefix = AWS_REGION_CROSS_MODEL_PREFIX[awsRegionPrefix];
  if (!modelPrefix) return awsModelId;
  return `${modelPrefix}.${awsModelId}`;
}

/** Original `doAwsClientRequest` model-id rewrite. */
export function resolveAwsInvokeModelId(requestModel: string, region: string): string {
  let awsModelId = getAwsModelID(requestModel);
  const prefix = getAwsRegionPrefix(region);
  if (awsModelCanCrossRegion(awsModelId, prefix)) awsModelId = awsModelCrossRegion(awsModelId, prefix);
  return awsModelId;
}

export type AwsAkskCredentials =
  | { mode: "bearer"; token: string; region: string }
  | { mode: "aksk"; accessKey: string; secretKey: string; region: string };

/** Original `newAwsClient` 2-part bearer vs 3-part AK/SK. */
export function parseAwsAkskKey(key: string): AwsAkskCredentials {
  const parts = String(key || "").split("|");
  if (parts.length === 2) return { mode: "bearer", token: parts[0], region: parts[1] };
  if (parts.length === 3) return { mode: "aksk", accessKey: parts[0], secretKey: parts[1], region: parts[2] };
  throw new Error("invalid aws secret key");
}

/** Original smithy URI encoding of the InvokeModel `modelId` path segment. */
export function encodeAwsModelIdPath(modelId: string): string {
  return encodeURIComponent(modelId);
}

/** Original Bedrock Runtime InvokeModel / InvokeModelWithResponseStream URL. */
export function awsInvokeUrl(region: string, modelId: string, stream = false): string {
  const action = stream ? "invoke-with-response-stream" : "invoke";
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeAwsModelIdPath(modelId)}/${action}`;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return String(value || "");
  }
  return "";
}

function copyIfPresent(out: Record<string, unknown>, src: Record<string, unknown>, key: string): void {
  if (src[key] == null) return;
  if (Array.isArray(src[key]) && (src[key] as unknown[]).length === 0) return;
  out[key] = src[key];
}

/**
 * Original `aws.formatRequest` JSON: `anthropic_version=bedrock-2023-05-31`,
 * `anthropic_beta` from `anthropic-beta` header (comma split, no trim), unknown
 * fields such as `model`/`stream` dropped.
 */
export function formatAwsClaudeRequest(body: unknown, headers: Record<string, string> = {}): Record<string, unknown> {
  const src = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { anthropic_version: AWS_BEDROCK_ANTHROPIC_VERSION };
  const betaHeader = headerValue(headers, "anthropic-beta");
  if (betaHeader.length > 0) out.anthropic_beta = betaHeader.split(",");
  else copyIfPresent(out, src, "anthropic_beta");
  copyIfPresent(out, src, "system");
  out.messages = Array.isArray(src.messages) ? src.messages : [];
  if (src.max_tokens != null && Number(src.max_tokens) !== 0) out.max_tokens = src.max_tokens;
  if (src.temperature != null && Number(src.temperature) !== 0) out.temperature = src.temperature;
  if (src.top_p != null && Number(src.top_p) !== 0) out.top_p = src.top_p;
  if (src.top_k != null && Number(src.top_k) !== 0) out.top_k = src.top_k;
  copyIfPresent(out, src, "stop_sequences");
  copyIfPresent(out, src, "tools");
  copyIfPresent(out, src, "tool_choice");
  copyIfPresent(out, src, "context_management");
  copyIfPresent(out, src, "thinking");
  copyIfPresent(out, src, "output_config");
  return out;
}

/**
 * Original `doAwsClientRequest` body: Nova keeps ConvertOpenAIRequest JSON;
 * Claude uses `formatRequest` then optional pass-through (drop `model`/`stream`).
 */
export function prepareAwsInvokeBody(
  payload: unknown,
  headers: Record<string, string>,
  opts: { nova: boolean; passThrough: boolean },
): unknown {
  if (opts.nova) return payload;
  formatAwsClaudeRequest(payload, headers);
  if (opts.passThrough) return awsPassThroughInvokeBody(payload);
  return formatAwsClaudeRequest(payload, headers);
}

/** Original `buildAwsRequestBody` pass-through: drop `model` and `stream`. */
export function awsPassThroughInvokeBody(body: unknown): Record<string, unknown> {
  const src = body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  delete src.model;
  delete src.stream;
  return src;
}
