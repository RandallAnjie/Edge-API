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

export function openaiToAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const systemParts: string[] = [];
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    const role = (m.role || "user").toLowerCase();
    const text = messageText(m.content);
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    out.push({ role: role === "assistant" ? "assistant" : "user", content: text });
  }
  const max = Number(body.max_tokens ?? body.max_completion_tokens ?? 4096) || 4096;
  const req: Record<string, unknown> = {
    model: body.model,
    max_tokens: max,
    messages: out,
    stream: Boolean(body.stream),
  };
  if (systemParts.length) req.system = systemParts.join("\n");
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stop != null) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return req;
}

export function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  if (typeof body.system === "string" && body.system) {
    messages.push({ role: "system", content: body.system });
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

export function openaiToGemini(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const contents: { role: string; parts: { text: string }[] }[] = [];
  const systemParts: string[] = [];
  for (const m of messages) {
    const role = (m.role || "user").toLowerCase();
    const text = messageText(m.content);
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    contents.push({
      role: role === "assistant" ? "model" : "user",
      parts: [{ text }],
    });
  }
  const generationConfig: Record<string, unknown> = {};
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.top_p != null) generationConfig.topP = body.top_p;
  if (body.max_tokens != null || body.max_output_tokens != null) {
    generationConfig.maxOutputTokens = body.max_tokens ?? body.max_output_tokens;
  }
  const req: Record<string, unknown> = { contents };
  if (Object.keys(generationConfig).length) req.generationConfig = generationConfig;
  if (systemParts.length) {
    req.systemInstruction = { parts: [{ text: systemParts.join("\n") }] };
  }
  return req;
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

export function openaiFromAnthropicResponse(upstream: Record<string, unknown>, model: string): Record<string, unknown> {
  const content = Array.isArray(upstream.content) ? (upstream.content as { type?: string; text?: string }[]) : [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text || "").join("");
  const usage = (upstream.usage || {}) as { input_tokens?: number; output_tokens?: number };
  return {
    id: String(upstream.id || `chatcmpl-${Date.now()}`),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: upstream.stop_reason || "stop",
      },
    ],
    usage: {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0),
    },
  };
}

export function openaiFromGeminiResponse(upstream: Record<string, unknown>, model: string): Record<string, unknown> {
  const cands = Array.isArray(upstream.candidates) ? (upstream.candidates as { content?: { parts?: { text?: string }[] } }[]) : [];
  const text = (cands[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const usage = (upstream.usageMetadata || {}) as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: Number(usage.promptTokenCount || 0),
      completion_tokens: Number(usage.candidatesTokenCount || 0),
      total_tokens: Number(usage.totalTokenCount || 0),
    },
  };
}

export function usageFromOpenAI(body: Record<string, unknown> | null): { prompt: number; completion: number } {
  if (!body) return { prompt: 0, completion: 0 };
  const usage = (body.usage || {}) as Record<string, unknown>;
  return {
    prompt: Number(usage.prompt_tokens || usage.input_tokens || 0),
    completion: Number(usage.completion_tokens || usage.output_tokens || 0),
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

const CHANNEL_TYPE_OPENAI = 1;
const CHANNEL_TYPE_AZURE = 3;

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

/** Original `relayconvert` OpenAI chat → Responses request used by advanced-custom converters. */
export function openaiChatToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    input: body.messages ?? [{ role: "user", content: "hi" }],
  };
  if (body.stream != null) out.stream = body.stream;
  return out;
}
