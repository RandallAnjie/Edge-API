import {
  applyReasoningModelSuffix,
  convertAliOpenAIRequest,
  convertMoonshotOpenAIRequest,
  convertOpenAIAdaptorReasoning,
  convertOpenAIResponsesAdaptorRequest,
  type ReasoningHostSettings,
} from "./reasoning.js";
import { convertOpenAIChatToClaude } from "./claude-convert.js";
import { convertOpenAIChatToGemini } from "./gemini-convert.js";
import { channelKind } from "./catalog.js";
import { CHANNEL_TYPE_ADVANCED_CUSTOM, CHANNEL_TYPE_ALI, CHANNEL_TYPE_AWS, CHANNEL_TYPE_AZURE, CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_CLOUDFLARE, CHANNEL_TYPE_CODEX, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_COZE, CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_DIFY, CHANNEL_TYPE_MINIMAX, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_OLLAMA, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_PERPLEXITY, CHANNEL_TYPE_TASK_PLUGIN, CHANNEL_TYPE_VERTEX, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI, CHANNEL_TYPE_ZHIPU, CHANNEL_TYPE_ZHIPU_V4 } from "./constants.js";
import { convertAwsOpenAIRequest } from "./aws-convert.js";
import { convertVertexOpenAIRequest } from "./vertex-convert.js";
import { convertOllamaGenerateRequest, convertOllamaOpenAIRequest } from "./ollama-convert.js";
import { convertDeepSeekOpenAIRequest, convertVolcOpenAIRequest, convertXaiOpenAIRequest } from "./vendor-convert.js";
import { convertBaiduEmbeddingRequest, convertBaiduOpenAIRequest } from "./baidu-convert.js";
import { convertCohereOpenAIRequest, convertCohereRerankRequest } from "./cohere-convert.js";
import { convertCozeOpenAIRequest } from "./coze-convert.js";
import { convertDifyOpenAIRequest } from "./dify-convert.js";
import { convertZhipuOpenAIRequest, convertZhipuV4OpenAIRequest } from "./zhipu-convert.js";
import { convertPerplexityOpenAIRequest } from "./perplexity-convert.js";
import { convertCloudflareCompletionsRequest, convertCloudflareOpenAIRequest } from "./cloudflare-convert.js";
import { convertBaiduV2OpenAIRequest } from "./baidu-v2-convert.js";
import { convertMiniMaxImageRequest, convertMiniMaxOpenAIRequest, convertMiniMaxTTSRequest } from "./minimax-convert.js";
import { asObj as usageAsObj, sseLine } from "./openai-usage.js";

export type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
};

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && "text" in (content as object)) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return content == null ? "" : JSON.stringify(content);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimatePromptTokens(messages: ChatMessage[] | undefined, prompt?: string): number {
  if (prompt) return estimateTokens(prompt);
  if (!messages) return 0;
  return messages.reduce((n, m) => n + estimateTokens(messageText(m.content)), 0);
}

/** Original `service.ConvertRequest(..., RelayFormatClaude)` for OpenAI chat. */
export function openaiToAnthropic(body: Record<string, unknown>, settings: ReasoningHostSettings = {}): Record<string, unknown> {
  return convertOpenAIChatToClaude(body, {
    originModelName: String(body.model || ""),
    upstreamModelName: String(body.model || ""),
    settings,
  });
}

export function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  if (typeof body.system === "string" && body.system) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = (body.system as { text?: string }[]).map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
    if (text) messages.push({ role: "system", content: text });
  }
  const src = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  for (const m of src) {
    messages.push({
      role: (m.role || "user") === "assistant" ? "assistant" : "user",
      content: messageText(m.content),
    });
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    top_p: body.top_p,
  };
}

/** Original `service.ConvertRequest(..., RelayFormatGemini)` for OpenAI chat. */
export function openaiToGemini(body: Record<string, unknown>, settings: ReasoningHostSettings = {}): Record<string, unknown> {
  return convertOpenAIChatToGemini(body, {
    originModelName: String(body.model || ""),
    upstreamModelName: String(body.model || ""),
    settings,
  });
}

export function geminiToOpenAIChat(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const contents = Array.isArray(body.contents) ? (body.contents as { role?: string; parts?: { text?: string }[] }[]) : [];
  const messages: ChatMessage[] = [];
  const sys = body.systemInstruction as { parts?: { text?: string }[] } | undefined;
  if (sys?.parts?.length) {
    messages.push({ role: "system", content: sys.parts.map((p) => p.text || "").join("") });
  }
  for (const c of contents) {
    const text = (c.parts || []).map((p) => p.text || "").join("");
    messages.push({
      role: (c.role || "user") === "model" ? "assistant" : "user",
      content: text,
    });
  }
  const gc = (body.generationConfig || {}) as Record<string, unknown>;
  return {
    model,
    messages,
    temperature: gc.temperature,
    top_p: gc.topP,
    max_tokens: gc.maxOutputTokens,
    stream: false,
  };
}

export { openaiFromAnthropicResponse, claudeSseToOpenAIChat, usageFromClaudeAPIUsage } from "./claude-response.js";
export { openaiFromGeminiResponse, geminiSseToOpenAIChat, usageFromGeminiMetadata } from "./gemini-response.js";

export function usageFromOpenAI(body: Record<string, unknown> | null): {
  prompt: number;
  completion: number;
  total: number;
  cachedTokens: number;
  promptCacheHitTokens: number;
} {
  if (!body) return { prompt: 0, completion: 0, total: 0, cachedTokens: 0, promptCacheHitTokens: 0 };
  const usage = (body.usage || {}) as Record<string, unknown>;
  const promptDetails = (usage.prompt_tokens_details || usage.input_tokens_details || {}) as Record<string, unknown>;
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
  return {
    prompt,
    completion,
    total: Number(usage.total_tokens || prompt + completion),
    cachedTokens: Number(promptDetails.cached_tokens || 0),
    promptCacheHitTokens: Number(usage.prompt_cache_hit_tokens || 0),
  };
}

export function sseOpenAIFromText(model: string, text: string): string {
  const id = `chatcmpl-${Date.now()}`;
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const done = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
}

/** Fallback when upstream returned a JSON completion but the client asked for SSE. */
export function sseFromOpenAIChatCompletion(response: Record<string, unknown>): string {
  const id = String(response.id || `chatcmpl-${Date.now()}`);
  const created = Number(response.created || Math.floor(Date.now() / 1000));
  const model = String(response.model || "");
  const choice = Array.isArray(response.choices) ? usageAsObj((response.choices as unknown[])[0]) : {};
  const message = usageAsObj(choice.message);
  const delta: Record<string, unknown> = { role: "assistant" };
  if (message.content != null) delta.content = message.content;
  if (message.reasoning_content != null) delta.reasoning_content = message.reasoning_content;
  if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls;
  const first = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
  };
  const done = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: null,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: choice.finish_reason || "stop" }],
  };
  let out = sseLine(first) + sseLine(done);
  if (response.usage) {
    out += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: null,
      choices: [],
      usage: response.usage,
    });
  }
  return out + "data: [DONE]\n\n";
}

export function extractGeminiModelAction(path: string): { model: string; action: string } | null {
  // /v1beta/models/gemini-2.0-flash:generateContent
  const m = path.match(/\/models\/([^/:]+):([^/?]+)/);
  if (!m) return null;
  return { model: decodeURIComponent(m[1]), action: m[2] };
}

/** Original `dto.IsOpenAIReasoningOModel`. */
export function isOpenAIReasoningOModel(modelName: string): boolean {
  return modelName.startsWith("o1") || modelName.startsWith("o3") || modelName.startsWith("o4");
}

/** Original `dto.IsOpenAIGPT5Model`. */
export function isOpenAIGPT5Model(modelName: string): boolean {
  return modelName === "gpt-5" || modelName.startsWith("gpt-5-") || modelName.startsWith("gpt-5.");
}

/** Original `dto.isOpenAIModelSnapshot`. */
export function isOpenAIModelSnapshot(modelName: string, baseModel: string): boolean {
  if (modelName === baseModel) return true;
  if (!modelName.startsWith(baseModel + "-")) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(modelName.slice(baseModel.length + 1));
}

/** Original `dto.OpenAIChatCapabilities`. */
export type OpenAIChatCapabilities = {
  useMaxCompletionTokens: boolean;
  useDeveloperRole: boolean;
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsLogProbs: boolean;
};

/** Original `dto.GetOpenAIChatCapabilities`. */
export function getOpenAIChatCapabilities(modelName: string, reasoningEffort = ""): OpenAIChatCapabilities {
  const capabilities: OpenAIChatCapabilities = {
    useMaxCompletionTokens: false,
    useDeveloperRole: false,
    supportsTemperature: true,
    supportsTopP: true,
    supportsLogProbs: true,
  };
  if (isOpenAIReasoningOModel(modelName)) {
    capabilities.useMaxCompletionTokens = true;
    capabilities.useDeveloperRole = !modelName.startsWith("o1-mini") && !modelName.startsWith("o1-preview");
    capabilities.supportsTemperature = false;
    return capabilities;
  }
  const isGPT5Model = isOpenAIGPT5Model(modelName);
  if (!isGPT5Model && !isOpenAIModelSnapshot(modelName, "gpt-6-astra")) return capabilities;
  capabilities.useMaxCompletionTokens = true;
  capabilities.useDeveloperRole = true;
  let supportsSampling = false;
  if (isGPT5Model && (reasoningEffort === "" || reasoningEffort === "none")) {
    for (const model of ["gpt-5.1", "gpt-5.2", "gpt-5.4"]) {
      if (isOpenAIModelSnapshot(modelName, model)) {
        supportsSampling = true;
        break;
      }
    }
  }
  capabilities.supportsTemperature = supportsSampling;
  capabilities.supportsTopP = supportsSampling;
  capabilities.supportsLogProbs = supportsSampling;
  return capabilities;
}

/** Original `openai.Adaptor.ConvertOpenAIRequest` chat compatibility (token limit + sampling + developer role + stream_options). */
export function applyOpenAIChatCompatibility(
  body: Record<string, unknown>,
  upstreamModel: string,
  channelType: number,
  reasoningEffort = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model: upstreamModel };
  if (channelType !== CHANNEL_TYPE_OPENAI && channelType !== CHANNEL_TYPE_AZURE) {
    delete out.stream_options;
  }
  const capabilities = getOpenAIChatCapabilities(upstreamModel, reasoningEffort);
  const maxCompletion = Number(out.max_completion_tokens ?? 0);
  const maxTokens = Number(out.max_tokens ?? 0);
  if (capabilities.useMaxCompletionTokens && maxCompletion === 0 && maxTokens !== 0) {
    out.max_completion_tokens = out.max_tokens;
    delete out.max_tokens;
  }
  if (!capabilities.supportsTemperature) delete out.temperature;
  if (!capabilities.supportsTopP) delete out.top_p;
  if (!capabilities.supportsLogProbs) {
    delete out.logprobs;
    delete out.top_logprobs;
  }
  if (capabilities.useDeveloperRole && Array.isArray(out.messages)) {
    const messages = (out.messages as Record<string, unknown>[]).map((m) => ({ ...m }));
    if (messages[0]?.role === "system") {
      messages[0] = { ...messages[0], role: "developer" };
      out.messages = messages;
    }
  }
  return out;
}

export type ConvertOpenAIOpts = {
  channelType: number;
  originModelName: string;
  upstreamModelName: string;
  settings?: ReasoningHostSettings;
  relayMode?: string;
  /** Original Coze `c.GetString("bot_id")` from `channel.Other`. */
  botId?: string;
  /** Original `helper.GetResponseID` (`chatcmpl-${requestId}`). */
  responseId?: string;
  /** Original `common.CohereSafetySetting`; default `NONE`. */
  cohereSafetySetting?: string;
};

export { convertClaudeRequest, convertOpenAIChatToClaude } from "./claude-convert.js";
export { convertGeminiRequest, convertOpenAIChatToGemini } from "./gemini-convert.js";
export {
  convertOllamaEmbeddingRequest,
  convertOllamaGenerateRequest,
  convertOllamaOpenAIRequest,
  openaiFromOllamaChatResponse,
  openaiFromOllamaEmbedding,
} from "./ollama-convert.js";
export {
  convertBaiduEmbeddingRequest,
  convertBaiduOpenAIRequest,
  openaiFromBaiduEmbedding,
  openaiFromBaiduResponse,
} from "./baidu-convert.js";
export { convertCohereOpenAIRequest, convertCohereRerankRequest, openaiFromCohereResponse } from "./cohere-convert.js";
export { convertCozeOpenAIRequest, openaiFromCozeDetailResponse } from "./coze-convert.js";
export { convertDifyOpenAIRequest, openaiFromDifyResponse } from "./dify-convert.js";
export { convertZhipuOpenAIRequest, convertZhipuV4OpenAIRequest, openaiFromZhipuResponse } from "./zhipu-convert.js";
export { convertPerplexityOpenAIRequest } from "./perplexity-convert.js";
export {
  convertCloudflareCompletionsRequest,
  convertCloudflareOpenAIRequest,
  openaiFromCloudflareResponse,
} from "./cloudflare-convert.js";
export { convertBaiduV2OpenAIRequest } from "./baidu-v2-convert.js";
export { convertMiniMaxImageRequest, convertMiniMaxOpenAIRequest, convertMiniMaxTTSRequest } from "./minimax-convert.js";

/** Original TextHelper: ApplyReasoningModelSuffix then adaptor ConvertOpenAIRequest. */
export function convertOpenAIRequest(body: Record<string, unknown>, opts: ConvertOpenAIOpts): Record<string, unknown> {
  const settings = opts.settings || {};
  const suffixed = applyReasoningModelSuffix(body, opts.originModelName, opts.upstreamModelName, settings, "chat");
  if (opts.channelType === CHANNEL_TYPE_AWS) {
    return convertAwsOpenAIRequest(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_VERTEX) {
    return convertVertexOpenAIRequest(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_OLLAMA) {
    if (opts.relayMode === "completions") {
      return convertOllamaGenerateRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
    }
    return convertOllamaOpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  if (opts.channelType === CHANNEL_TYPE_VOLC) {
    return convertVolcOpenAIRequest(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_XAI) {
    return convertXaiOpenAIRequest(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_DEEPSEEK) {
    return convertDeepSeekOpenAIRequest(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_COHERE) {
    if (opts.relayMode === "rerank") {
      return convertCohereRerankRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
    }
    if (opts.relayMode === "embeddings") {
      throw new Error("not implemented");
    }
    return convertCohereOpenAIRequest(suffixed.body, {
      upstreamModelName: suffixed.upstreamModelName,
      safetySetting: opts.cohereSafetySetting,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_DIFY) {
    return convertDifyOpenAIRequest(suffixed.body, { responseId: opts.responseId });
  }
  if (opts.channelType === CHANNEL_TYPE_COZE) {
    return convertCozeOpenAIRequest(suffixed.body, { botId: opts.botId, responseId: opts.responseId });
  }
  if (opts.channelType === CHANNEL_TYPE_BAIDU) {
    if (opts.relayMode === "embeddings") return convertBaiduEmbeddingRequest(suffixed.body);
    return convertBaiduOpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  if (opts.channelType === CHANNEL_TYPE_ZHIPU) {
    return convertZhipuOpenAIRequest(suffixed.body);
  }
  if (opts.channelType === CHANNEL_TYPE_ZHIPU_V4) {
    return convertZhipuV4OpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  if (opts.channelType === CHANNEL_TYPE_PERPLEXITY) {
    return convertPerplexityOpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  if (opts.channelType === CHANNEL_TYPE_CLOUDFLARE) {
    if (opts.relayMode === "completions") return convertCloudflareCompletionsRequest(suffixed.body);
    return convertCloudflareOpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  if (opts.channelType === CHANNEL_TYPE_BAIDU_V2) {
    if (opts.relayMode === "embeddings" || opts.relayMode === "rerank") {
      throw new Error("not implemented");
    }
    return convertBaiduV2OpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  if (opts.channelType === CHANNEL_TYPE_MINIMAX) {
    if (opts.relayMode === "images") return convertMiniMaxImageRequest(suffixed.body);
    if (opts.relayMode === "audio_speech") {
      return convertMiniMaxTTSRequest(suffixed.body, { originModelName: opts.originModelName });
    }
    return convertMiniMaxOpenAIRequest(suffixed.body, { upstreamModelName: suffixed.upstreamModelName });
  }
  const kind = channelKind(opts.channelType);
  if (kind === "anthropic") {
    return convertOpenAIChatToClaude(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (kind === "gemini") {
    return convertOpenAIChatToGemini(suffixed.body, {
      originModelName: opts.originModelName,
      upstreamModelName: suffixed.upstreamModelName,
      settings,
    });
  }
  if (opts.channelType === CHANNEL_TYPE_MOONSHOT) {
    return convertMoonshotOpenAIRequest(suffixed.body, suffixed.upstreamModelName);
  }
  if (opts.channelType === CHANNEL_TYPE_ALI) {
    return convertAliOpenAIRequest(suffixed.body, suffixed.upstreamModelName);
  }
  if (
    opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM ||
    opts.channelType === CHANNEL_TYPE_CODEX ||
    opts.channelType === CHANNEL_TYPE_TASK_PLUGIN
  ) {
    const out = suffixed.body;
    out.model = suffixed.upstreamModelName;
    return out;
  }
  const converted = convertOpenAIAdaptorReasoning(
    suffixed.body,
    opts.channelType,
    opts.originModelName,
    suffixed.upstreamModelName,
    settings,
  );
  return applyOpenAIChatCompatibility(converted.body, converted.upstreamModelName, opts.channelType, converted.reasoningEffort);
}

/** Original `helper.ApplyReasoningModelSuffix` + `openai.Adaptor.ConvertOpenAIResponsesRequest`. */
export function convertOpenAIResponsesRequest(body: Record<string, unknown>, opts: ConvertOpenAIOpts): Record<string, unknown> {
  const settings = opts.settings || {};
  const suffixed = applyReasoningModelSuffix(body, opts.originModelName, opts.upstreamModelName, settings, "responses");
  const converted = convertOpenAIResponsesAdaptorRequest(
    suffixed.body,
    opts.channelType,
    opts.originModelName,
    settings,
  );
  return converted.body;
}

/** Original `relayconvert` OpenAI chat → Responses request used by advanced-custom converters. */
export function openaiChatToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    input: body.messages ?? [{ role: "user", content: "hi" }],
  };
  if (body.stream != null) out.stream = body.stream;
  return out;
}
