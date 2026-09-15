/**
 * Original `helper.GetAndValidate*` request DTOs (workerd).
 * Must not import store / relay / convert / query / submit.
 */

/** Original `maxTokensLimit` (`math.MaxInt32 / 2`). */
export const MAX_TOKENS_LIMIT = 1073741823;

const EMBEDDING_REQUEST_KEYS = [
  "model",
  "input",
  "encoding_format",
  "dimensions",
  "user",
  "seed",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
] as const;

const RERANK_REQUEST_KEYS = [
  "documents",
  "query",
  "model",
  "top_n",
  "return_documents",
  "max_chunk_per_doc",
  "overlap_tokens",
] as const;

const SEARCH_CONTEXT_SIZES: Record<string, boolean> = {
  high: true,
  medium: true,
  low: true,
};

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pickKeys(raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function enginesPathModel(path: string): string {
  if (path.startsWith("/v1/engines/") && path.endsWith("/embeddings")) {
    return decodeURIComponent(path.slice("/v1/engines/".length, -"/embeddings".length));
  }
  return "";
}

/** Original `exceedsMaxTokensLimit` on `*uint` (nil → 0). */
export function exceedsMaxTokensLimit(...values: unknown[]): boolean {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    if (n > MAX_TOKENS_LIMIT) return true;
  }
  return false;
}

/** Original `dto.EmbeddingRequest.ParseInput`. */
export function parseEmbeddingInput(input: unknown): string[] {
  if (input == null) return [];
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/** Original `dto.EmbeddingRequest.GetTokenCountMeta.CombineText`. */
export function embeddingCombineText(body: unknown): string {
  return parseEmbeddingInput(asObj(body).input).join("\n");
}

/** Original `dto.RerankRequest.GetTokenCountMeta.CombineText` (`fmt.Sprintf("%v")`). */
export function rerankCombineText(body: unknown): string {
  const o = asObj(body);
  const texts: string[] = [];
  const documents = Array.isArray(o.documents) ? o.documents : [];
  for (const document of documents) texts.push(fmtGoValue(document));
  if (typeof o.query === "string" && o.query) texts.push(o.query);
  return texts.join("\n");
}

function fmtGoValue(value: unknown): string {
  if (value == null) return "<nil>";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Original `helper.GetAndValidateEmbeddingRequest`.
 * `input == nil` is empty; `""` and `[]` pass. Empty model on embeddings uses the
 * engines path param; empty model on moderations becomes `omni-moderation-latest`.
 */
export function getAndValidateEmbeddingRequest(
  relayMode: string,
  source: unknown,
  path = "",
): Record<string, unknown> {
  const embeddingRequest = pickKeys(asObj(source), EMBEDDING_REQUEST_KEYS);
  if (!Object.prototype.hasOwnProperty.call(embeddingRequest, "input") || embeddingRequest.input == null) {
    throw new Error("input is empty");
  }
  const model = typeof embeddingRequest.model === "string" ? embeddingRequest.model : "";
  if (relayMode === "moderations" && model === "") {
    embeddingRequest.model = "omni-moderation-latest";
  }
  if ((relayMode === "embeddings" || relayMode === "engines_embeddings") && model === "") {
    const pathModel = enginesPathModel(path);
    if (pathModel) embeddingRequest.model = pathModel;
  }
  return embeddingRequest;
}

/**
 * Original `helper.GetAndValidateRerankRequest`.
 * Empty `query` / empty `documents` are invalid_request.
 */
export function getAndValidateRerankRequest(source: unknown): Record<string, unknown> {
  const rerankRequest = pickKeys(asObj(source), RERANK_REQUEST_KEYS);
  if (typeof rerankRequest.query !== "string" || rerankRequest.query === "") {
    throw new Error("query is empty");
  }
  if (!Array.isArray(rerankRequest.documents) || rerankRequest.documents.length === 0) {
    throw new Error("documents is empty");
  }
  return rerankRequest;
}

function geminiMaxOutputTokens(body: Record<string, unknown>): unknown {
  const camel = asObj(body.generationConfig);
  const snake = asObj(body.generation_config);
  if (Object.prototype.hasOwnProperty.call(camel, "maxOutputTokens")) return camel.maxOutputTokens;
  if (Object.prototype.hasOwnProperty.call(camel, "max_output_tokens")) return camel.max_output_tokens;
  if (Object.prototype.hasOwnProperty.call(snake, "maxOutputTokens")) return snake.maxOutputTokens;
  if (Object.prototype.hasOwnProperty.call(snake, "max_output_tokens")) return snake.max_output_tokens;
  return undefined;
}

/**
 * Original `helper.GetAndValidateGeminiRequest`.
 * Empty `contents` and `requests` → `contents is required`.
 */
export function getAndValidateGeminiRequest(source: unknown): Record<string, unknown> {
  const request = asObj(source);
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const requests = Array.isArray(request.requests) ? request.requests : [];
  if (contents.length === 0 && requests.length === 0) {
    throw new Error("contents is required");
  }
  if (exceedsMaxTokensLimit(geminiMaxOutputTokens(request))) {
    throw new Error("maxOutputTokens is invalid");
  }
  return request;
}

/** Original `helper.GetAndValidateGeminiEmbeddingRequest` (unmarshal only). */
export function getAndValidateGeminiEmbeddingRequest(source: unknown): Record<string, unknown> {
  return asObj(source);
}

/** Original `helper.GetAndValidateGeminiBatchEmbeddingRequest` (unmarshal only). */
export function getAndValidateGeminiBatchEmbeddingRequest(source: unknown): Record<string, unknown> {
  return asObj(source);
}

/**
 * Original `helper.GetAndValidateTextRequest` after distributor already filled
 * `model`. Does not emit `model is required` (distributor i18n runs first).
 */
export function getAndValidateTextRequest(relayMode: string, source: unknown): Record<string, unknown> {
  const textRequest = asObj(source);
  const model = typeof textRequest.model === "string" ? textRequest.model : "";
  if (relayMode === "moderations" && model === "") {
    textRequest.model = "text-moderation-latest";
  }
  if (relayMode === "embeddings" && model === "") {
    /* path param fill lives on GetAndValidateEmbeddingRequest */
  }
  if (exceedsMaxTokensLimit(textRequest.max_tokens, textRequest.max_completion_tokens)) {
    throw new Error("max_tokens is invalid");
  }
  if (textRequest.web_search_options != null) {
    const options = asObj(textRequest.web_search_options);
    const size = typeof options.search_context_size === "string" ? options.search_context_size : "";
    if (size) {
      if (!SEARCH_CONTEXT_SIZES[size]) {
        throw new Error("invalid search_context_size, must be one of: high, medium, low");
      }
    } else {
      options.search_context_size = "medium";
      textRequest.web_search_options = options;
    }
  }
  switch (relayMode) {
    case "completions":
      if (textRequest.prompt === "") {
        throw new Error("field prompt is required");
      }
      break;
    case "chat":
      if (
        (!Array.isArray(textRequest.messages) || textRequest.messages.length === 0) &&
        textRequest.prefix == null &&
        textRequest.suffix == null
      ) {
        throw new Error("field messages is required");
      }
      break;
    case "moderations":
      if (textRequest.input == null || textRequest.input === "") {
        throw new Error("field input is required");
      }
      break;
    case "edits":
      if (typeof textRequest.instruction !== "string" || textRequest.instruction === "") {
        throw new Error("field instruction is required");
      }
      break;
    default:
      break;
  }
  return textRequest;
}

/** Original `helper.GetAndValidateClaudeRequest` after distributor filled model. */
export function getAndValidateClaudeRequest(source: unknown): Record<string, unknown> {
  const textRequest = asObj(source);
  if (!Array.isArray(textRequest.messages) || textRequest.messages.length === 0) {
    throw new Error("field messages is required");
  }
  if (exceedsMaxTokensLimit(textRequest.max_tokens, textRequest.max_tokens_to_sample)) {
    throw new Error("max_tokens is invalid");
  }
  return textRequest;
}

/**
 * Original `helper.GetAndValidateResponsesRequest` after distributor filled model.
 * Compact compaction only requires model (already checked).
 */
export function getAndValidateResponsesRequest(source: unknown): Record<string, unknown> {
  const request = asObj(source);
  if (!Object.prototype.hasOwnProperty.call(request, "input") || request.input == null) {
    throw new Error("input is required");
  }
  if (exceedsMaxTokensLimit(request.max_output_tokens)) {
    throw new Error("max_output_tokens is invalid");
  }
  return request;
}

function geminiPathIsBatchEmbed(path: string): boolean {
  return path.includes(":batchEmbedContents");
}

function geminiPathIsEmbed(path: string): boolean {
  return path.includes(":embedContent");
}

/**
 * Original `helper.GetAndValidateRequest` by worker relay mode / path.
 * Audio and image GetAndValid stay in their modules; this covers embedding,
 * rerank, Gemini, OpenAI text, Claude, and Responses.
 */
export function applyGetAndValidateRequest(mode: string, path: string, source: unknown): unknown {
  switch (mode) {
    case "embeddings":
    case "engines_embeddings":
      return getAndValidateEmbeddingRequest(mode, source, path);
    case "rerank":
      return getAndValidateRerankRequest(source);
    case "gemini":
      if (geminiPathIsBatchEmbed(path)) return getAndValidateGeminiBatchEmbeddingRequest(source);
      if (geminiPathIsEmbed(path)) return getAndValidateGeminiEmbeddingRequest(source);
      return getAndValidateGeminiRequest(source);
    case "chat":
    case "completions":
    case "moderations":
      return getAndValidateTextRequest(mode, source);
    case "messages":
      return getAndValidateClaudeRequest(source);
    case "responses":
      if (path.includes("/v1/responses/compact")) return asObj(source);
      return getAndValidateResponsesRequest(source);
    default:
      return source;
  }
}
