/** Original `relay/channel/codex` ConvertOpenAIRequest / ConvertOpenAIResponsesRequest. */

export const CODEX_CHAT_UNSUPPORTED = "codex channel: /v1/chat/completions endpoint not supported";
export const CODEX_EMBEDDING_UNSUPPORTED = "codex channel: /v1/embeddings endpoint not supported";
export const CODEX_RERANK_UNSUPPORTED = "codex channel: /v1/rerank endpoint not supported";
export const CODEX_MESSAGES_UNSUPPORTED = "codex channel: /v1/messages endpoint not supported";
export const CODEX_ENDPOINT_UNSUPPORTED = "codex channel: endpoint not supported";

export type ConvertCodexOpts = {
  relayMode?: string;
  upstreamModelName?: string;
};

export type ConvertCodexResponsesOpts = {
  compact?: boolean;
  systemPrompt?: string;
  systemPromptOverride?: boolean;
  upstreamModelName?: string;
};

/** Original Codex ConvertOpenAIRequest / ConvertEmbedding / ConvertRerank / ConvertImage / ConvertAudio / ConvertClaude / ConvertGemini. */
export function convertCodexOpenAIRequest(_body: Record<string, unknown>, opts: ConvertCodexOpts = {}): never {
  const mode = opts.relayMode || "chat";
  if (mode === "embeddings" || mode === "engines_embeddings") throw new Error(CODEX_EMBEDDING_UNSUPPORTED);
  if (mode === "rerank") throw new Error(CODEX_RERANK_UNSUPPORTED);
  if (mode === "messages") throw new Error(CODEX_MESSAGES_UNSUPPORTED);
  if (
    mode === "images" ||
    mode === "audio_speech" ||
    mode === "audio_transcription" ||
    mode === "audio_translation" ||
    mode === "gemini"
  ) {
    throw new Error(CODEX_ENDPOINT_UNSUPPORTED);
  }
  throw new Error(CODEX_CHAT_UNSUPPORTED);
}

function applyCodexSystemPrompt(out: Record<string, unknown>, systemPrompt: string, override: boolean): void {
  if (!systemPrompt) return;
  if (out.instructions == null) {
    out.instructions = systemPrompt;
    return;
  }
  if (!override) return;
  if (typeof out.instructions === "string") {
    const existing = out.instructions.trim();
    out.instructions = existing === "" ? systemPrompt : `${systemPrompt}\n${existing}`;
    return;
  }
  out.instructions = systemPrompt;
}

/** Original `codex.Adaptor.ConvertOpenAIResponsesRequest`. Compact keeps client `store` and sampling fields. */
export function convertCodexResponsesRequest(
  body: Record<string, unknown>,
  opts: ConvertCodexResponsesOpts = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  applyCodexSystemPrompt(out, opts.systemPrompt || "", Boolean(opts.systemPromptOverride));
  if (out.instructions == null) out.instructions = "";
  if (!opts.compact) {
    out.store = false;
    delete out.max_output_tokens;
    delete out.temperature;
    delete out.frequency_penalty;
    delete out.presence_penalty;
  }
  return out;
}

export function isCodexResponsesCompact(requestPath = "", relayMode = ""): boolean {
  return String(requestPath).includes("/compact") || relayMode === "responses_compact";
}
