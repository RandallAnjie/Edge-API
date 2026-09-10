/** Shared OpenAI-style usage JSON used by original Claude/Gemini DoResponse hops. */

export type InputTokenDetails = {
  cached_tokens: number;
  cached_creation_tokens?: number;
  cache_write_tokens?: number;
  text_tokens: number;
  audio_tokens: number;
  image_tokens: number;
};

export type OutputTokenDetails = {
  text_tokens: number;
  audio_tokens: number;
  image_tokens: number;
  reasoning_tokens: number;
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  usage_semantic?: string;
  usage_source?: string;
  billing_usage?: Record<string, unknown>;
  prompt_tokens_details: InputTokenDetails;
  completion_tokens_details: OutputTokenDetails;
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: InputTokenDetails | null;
  claude_cache_creation_5_m_tokens: number;
  claude_cache_creation_1_h_tokens: number;
};

export function asInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function emptyInputDetails(): InputTokenDetails {
  return { cached_tokens: 0, text_tokens: 0, audio_tokens: 0, image_tokens: 0 };
}

export function emptyOutputDetails(): OutputTokenDetails {
  return { text_tokens: 0, audio_tokens: 0, image_tokens: 0, reasoning_tokens: 0 };
}

export function emptyOpenAIUsage(): OpenAIUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: emptyInputDetails(),
    completion_tokens_details: emptyOutputDetails(),
    input_tokens: 0,
    output_tokens: 0,
    input_tokens_details: null,
    claude_cache_creation_5_m_tokens: 0,
    claude_cache_creation_1_h_tokens: 0,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** Original `kitutil.Marshal` for tool arguments (encoding/json, sorted map keys). */
export function compactJson(value: unknown): string {
  if (value === undefined) return "null";
  return JSON.stringify(sortKeys(value));
}

export function compactUuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function openAIUsageToJson(usage: OpenAIUsage): Record<string, unknown> {
  const prompt_tokens_details: Record<string, number> = {
    cached_tokens: usage.prompt_tokens_details.cached_tokens,
    text_tokens: usage.prompt_tokens_details.text_tokens,
    audio_tokens: usage.prompt_tokens_details.audio_tokens,
    image_tokens: usage.prompt_tokens_details.image_tokens,
  };
  if (usage.prompt_tokens_details.cached_creation_tokens) {
    prompt_tokens_details.cached_creation_tokens = usage.prompt_tokens_details.cached_creation_tokens;
  }
  if (usage.prompt_tokens_details.cache_write_tokens) {
    prompt_tokens_details.cache_write_tokens = usage.prompt_tokens_details.cache_write_tokens;
  }
  const out: Record<string, unknown> = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details,
    completion_tokens_details: {
      text_tokens: usage.completion_tokens_details.text_tokens,
      audio_tokens: usage.completion_tokens_details.audio_tokens,
      image_tokens: usage.completion_tokens_details.image_tokens,
      reasoning_tokens: usage.completion_tokens_details.reasoning_tokens,
    },
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    input_tokens_details: usage.input_tokens_details,
    claude_cache_creation_5_m_tokens: usage.claude_cache_creation_5_m_tokens,
    claude_cache_creation_1_h_tokens: usage.claude_cache_creation_1_h_tokens,
  };
  if (usage.prompt_cache_hit_tokens) out.prompt_cache_hit_tokens = usage.prompt_cache_hit_tokens;
  if (usage.usage_semantic) out.usage_semantic = usage.usage_semantic;
  if (usage.usage_source) out.usage_source = usage.usage_source;
  if (usage.billing_usage) out.billing_usage = usage.billing_usage;
  return out;
}

export function looksLikeSse(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("data:") || t.startsWith("event:") || t.includes("\ndata:") || t.includes("\rdata:");
}

/** Split `data:` payloads from an SSE body (ignores `[DONE]`). */
export function parseSseDataPayloads(text: string): string[] {
  const payloads: string[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data && data !== "[DONE]") payloads.push(data);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return payloads;
}

export function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
