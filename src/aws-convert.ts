/** Original `relay/channel/aws` ConvertOpenAIRequest (Nova vs Claude) + API-key Converse URL. */

import { convertOpenAIChatToClaude, type ConvertClaudeOpts } from "./claude-convert.js";
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
