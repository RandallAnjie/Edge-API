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
