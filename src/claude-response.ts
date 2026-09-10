/** Original `relaykit/relayconvert/internal/claude_messages/to_oai_chat_resp.go` + Claude OpenAI-format DoResponse. */

import {
  asInt,
  asObj,
  compactJson,
  compactUuid,
  emptyOpenAIUsage,
  looksLikeSse,
  openAIUsageToJson,
  parseSseDataPayloads,
  sseLine,
  type OpenAIUsage,
} from "./openai-usage.js";

export type ClaudeToOpenAIOpts = {
  created?: number;
  includeUsage?: boolean;
  upstreamModel?: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Original `reasonmap.ClaudeStopReasonToOpenAIFinishReason`. */
export function claudeStopReasonToOpenAIFinishReason(stopReason: string): string {
  switch (stopReason.toLowerCase()) {
    case "stop_sequence":
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "pause_turn":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return stopReason;
  }
}

/** Original `shared/claude.NormalizeCacheCreationSplit`. */
export function normalizeCacheCreationSplit(totalTokens: number, tokens5m: number, tokens1h: number): [number, number] {
  let remainder = totalTokens - tokens5m - tokens1h;
  if (remainder < 0) remainder = 0;
  return [tokens5m + remainder, tokens1h];
}

function cacheCreation5m(usage: Record<string, unknown>): number {
  const nested = asObj(usage.cache_creation);
  return asInt(nested.ephemeral_5m_input_tokens);
}

function cacheCreation1h(usage: Record<string, unknown>): number {
  const nested = asObj(usage.cache_creation);
  return asInt(nested.ephemeral_1h_input_tokens);
}

function hasClaudeUsageTokens(usage: Record<string, unknown> | null): boolean {
  if (!usage) return false;
  if (
    asInt(usage.input_tokens) ||
    asInt(usage.output_tokens) ||
    asInt(usage.cache_creation_input_tokens) ||
    asInt(usage.cache_read_input_tokens) ||
    asInt(usage.claude_cache_creation_5_m_tokens) ||
    asInt(usage.claude_cache_creation_1_h_tokens)
  ) {
    return true;
  }
  const nested = asObj(usage.cache_creation);
  return Boolean(asInt(nested.ephemeral_5m_input_tokens) || asInt(nested.ephemeral_1h_input_tokens));
}

function cloneClaudeUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object" ? { ...asObj(usage.cache_creation) } : undefined;
  const serverToolUse = usage.server_tool_use && typeof usage.server_tool_use === "object" ? { ...asObj(usage.server_tool_use) } : undefined;
  const out: Record<string, unknown> = {
    input_tokens: asInt(usage.input_tokens),
    cache_creation_input_tokens: asInt(usage.cache_creation_input_tokens),
    cache_read_input_tokens: asInt(usage.cache_read_input_tokens),
    output_tokens: asInt(usage.output_tokens),
    claude_cache_creation_5_m_tokens: asInt(usage.claude_cache_creation_5_m_tokens),
    claude_cache_creation_1_h_tokens: asInt(usage.claude_cache_creation_1_h_tokens),
  };
  if (cacheCreation) out.cache_creation = cacheCreation;
  if (serverToolUse) out.server_tool_use = serverToolUse;
  return out;
}

/** Original `dto.NewClaudeMessagesBillingUsage`. */
export function newClaudeMessagesBillingUsage(usage: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!hasClaudeUsageTokens(usage)) return undefined;
  return {
    source: "claude_messages",
    semantic: "anthropic",
    claude_usage: cloneClaudeUsage(usage!),
  };
}

function cacheCreationTokensForOpenAIUsage(usage: OpenAIUsage): number {
  const split = usage.claude_cache_creation_5_m_tokens + usage.claude_cache_creation_1_h_tokens;
  const cachedCreation = usage.prompt_tokens_details.cached_creation_tokens || 0;
  if (split === 0) return cachedCreation;
  if (cachedCreation > split) return cachedCreation;
  return split;
}

/** Original `buildOpenAIStyleUsageFromClaudeUsage`. */
export function buildOpenAIStyleUsageFromClaudeUsage(usage: OpenAIUsage): OpenAIUsage {
  const clone: OpenAIUsage = {
    ...usage,
    prompt_tokens_details: { ...usage.prompt_tokens_details },
    completion_tokens_details: { ...usage.completion_tokens_details },
    billing_usage: usage.billing_usage ? { ...usage.billing_usage } : undefined,
  };
  const [cache5m, cache1h] = normalizeCacheCreationSplit(
    usage.prompt_tokens_details.cached_creation_tokens || 0,
    usage.claude_cache_creation_5_m_tokens,
    usage.claude_cache_creation_1_h_tokens,
  );
  clone.claude_cache_creation_5_m_tokens = cache5m;
  clone.claude_cache_creation_1_h_tokens = cache1h;
  const cacheCreationTokens = cacheCreationTokensForOpenAIUsage(usage);
  if (cacheCreationTokens) clone.prompt_tokens_details.cache_write_tokens = cacheCreationTokens;
  const totalInput = usage.prompt_tokens + (usage.prompt_tokens_details.cached_tokens || 0) + cacheCreationTokens;
  clone.prompt_tokens = totalInput;
  clone.input_tokens = totalInput;
  clone.total_tokens = totalInput + usage.completion_tokens;
  clone.usage_semantic = "openai";
  clone.usage_source = "anthropic";
  return clone;
}

function semanticUsageFromClaudeAPI(usage: Record<string, unknown>): OpenAIUsage {
  const out = emptyOpenAIUsage();
  out.prompt_tokens = asInt(usage.input_tokens);
  out.completion_tokens = asInt(usage.output_tokens);
  out.usage_semantic = "anthropic";
  out.usage_source = "anthropic";
  out.billing_usage = newClaudeMessagesBillingUsage(usage);
  out.prompt_tokens_details.cached_tokens = asInt(usage.cache_read_input_tokens);
  const cachedCreation = asInt(usage.cache_creation_input_tokens);
  if (cachedCreation) out.prompt_tokens_details.cached_creation_tokens = cachedCreation;
  out.claude_cache_creation_5_m_tokens = cacheCreation5m(usage);
  out.claude_cache_creation_1_h_tokens = cacheCreation1h(usage);
  return out;
}

/** Original `UsageFromClaudeAPIUsage`. */
export function usageFromClaudeAPIUsage(usage: Record<string, unknown> | null | undefined): OpenAIUsage {
  if (!usage) return emptyOpenAIUsage();
  return buildOpenAIStyleUsageFromClaudeUsage(semanticUsageFromClaudeAPI(usage));
}

function claudeUsageFromResponse(upstream: Record<string, unknown>): Record<string, unknown> | null {
  if (upstream.usage && typeof upstream.usage === "object") return asObj(upstream.usage);
  const message = asObj(upstream.message);
  if (message.usage && typeof message.usage === "object") return asObj(message.usage);
  return null;
}

function blockText(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

function blockThinking(block: Record<string, unknown>): string {
  return typeof block.thinking === "string" ? block.thinking : "";
}

/** Original `ResponseClaude2OpenAI`. */
export function responseClaude2OpenAI(claudeResponse: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(claudeResponse.content) ? (claudeResponse.content as Record<string, unknown>[]) : [];
  let responseText = "";
  let responseThinking = "";
  if (content[0]) responseThinking = blockThinking(content[0]);
  const tools: Record<string, unknown>[] = [];
  let thinkingContent = "";
  for (const message of content) {
    const type = str(message.type);
    if (type === "tool_use") {
      tools.push({
        id: str(message.id),
        type: "function",
        function: {
          name: str(message.name),
          arguments: compactJson(message.input),
        },
      });
    } else if (type === "thinking") {
      thinkingContent = blockThinking(message);
    } else if (type === "text") {
      responseText += blockText(message);
    }
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: responseText,
  };
  if (responseThinking) message.reasoning_content = responseThinking;
  if (tools.length) message.tool_calls = tools;
  if (thinkingContent) message.reasoning_content = thinkingContent;
  return {
    id: str(claudeResponse.id),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: str(claudeResponse.model),
    choices: [
      {
        index: 0,
        message,
        finish_reason: claudeStopReasonToOpenAIFinishReason(str(claudeResponse.stop_reason)),
      },
    ],
  };
}

/** Original Claude OpenAI-format DoResponse (`HandleClaudeResponseData` + `UsageFromClaudeAPIUsage`). */
export function openaiFromAnthropicResponse(upstream: Record<string, unknown>, model = ""): Record<string, unknown> {
  const response = responseClaude2OpenAI(upstream);
  if (!response.model && model) response.model = model;
  const apiUsage = claudeUsageFromResponse(upstream);
  if (apiUsage) {
    response.usage = openAIUsageToJson(usageFromClaudeAPIUsage(apiUsage));
  } else {
    response.usage = openAIUsageToJson(buildOpenAIStyleUsageFromClaudeUsage(emptyOpenAIUsage()));
  }
  return response;
}

type ClaudeStreamState = {
  toolIndexByContentBlock: Map<number, number>;
  blockTypeByContentBlock: Map<number, string>;
  nextToolIndex: number;
};

function isClaudeHostedToolStreamBlock(blockType: string): boolean {
  switch (blockType) {
    case "server_tool_use":
    case "mcp_tool_use":
    case "web_search_tool_result":
    case "mcp_tool_result":
    case "code_execution_tool_result":
    case "web_fetch_tool_result":
      return true;
    default:
      return false;
  }
}

/** Original `StreamResponseClaude2OpenAI`. */
export function streamResponseClaude2OpenAI(claudeResponse: Record<string, unknown>): Record<string, unknown> | null {
  const type = str(claudeResponse.type);
  const choice: Record<string, unknown> = { index: 0, delta: {}, logprobs: null, finish_reason: null };
  const delta = choice.delta as Record<string, unknown>;
  const tools: Record<string, unknown>[] = [];
  const fcIdx = claudeResponse.index == null ? 0 : asInt(claudeResponse.index);
  if (type === "message_start") {
    const message = asObj(claudeResponse.message);
    if (message.id) claudeResponse.id = message.id;
    if (message.model) claudeResponse.model = message.model;
    delta.content = "";
    delta.role = "assistant";
  } else if (type === "content_block_start") {
    const block = claudeResponse.content_block ? asObj(claudeResponse.content_block) : null;
    if (!block) return null;
    if (str(block.type) === "text" && typeof block.text === "string") delta.content = block.text;
    if (str(block.type) === "tool_use") {
      tools.push({
        index: fcIdx,
        id: str(block.id),
        type: "function",
        function: { name: str(block.name), arguments: "" },
      });
    }
  } else if (type === "content_block_delta") {
    const d = claudeResponse.delta ? asObj(claudeResponse.delta) : null;
    if (d) {
      if (typeof d.text === "string") delta.content = d.text;
      const deltaType = str(d.type);
      if (deltaType === "input_json_delta") {
        tools.push({
          type: "function",
          index: fcIdx,
          function: { arguments: typeof d.partial_json === "string" ? d.partial_json : "" },
        });
      } else if (deltaType === "signature_delta") {
        delta.reasoning_content = "\n";
      } else if (deltaType === "thinking_delta") {
        if (typeof d.thinking === "string") delta.reasoning_content = d.thinking;
      }
    }
  } else if (type === "message_delta") {
    const d = claudeResponse.delta ? asObj(claudeResponse.delta) : null;
    if (d && d.stop_reason != null) {
      const finish = claudeStopReasonToOpenAIFinishReason(str(d.stop_reason));
      if (finish !== "null") choice.finish_reason = finish;
    }
  } else {
    return null;
  }
  if (tools.length) {
    delete delta.content;
    delta.tool_calls = tools;
  }
  const chunk: Record<string, unknown> = {
    id: str(claudeResponse.id),
    object: "chat.completion.chunk",
    created: 0,
    model: str(claudeResponse.model),
    system_fingerprint: null,
    choices: [choice],
  };
  return chunk;
}

/** Original `ClaudeToChatStreamState.ConvertChunk`. */
export function convertClaudeStreamChunk(state: ClaudeStreamState, claudeResponse: Record<string, unknown>): Record<string, unknown> | null {
  const type = str(claudeResponse.type);
  const converted = { ...claudeResponse };
  if (type === "content_block_start") {
    const block = claudeResponse.content_block ? asObj(claudeResponse.content_block) : null;
    const blockType = str(block?.type);
    if (block && blockType) {
      if (claudeResponse.index == null) return null;
      const contentBlockIndex = asInt(claudeResponse.index);
      state.blockTypeByContentBlock.set(contentBlockIndex, blockType);
      if (blockType === "tool_use") {
        let toolIndex = state.toolIndexByContentBlock.get(contentBlockIndex);
        if (toolIndex == null) {
          toolIndex = state.nextToolIndex;
          state.nextToolIndex += 1;
          state.toolIndexByContentBlock.set(contentBlockIndex, toolIndex);
        }
        converted.index = toolIndex;
      } else if (isClaudeHostedToolStreamBlock(blockType)) {
        return null;
      }
    }
  } else if (type === "content_block_delta") {
    const d = claudeResponse.delta ? asObj(claudeResponse.delta) : null;
    if (d && str(d.type) === "input_json_delta") {
      if (claudeResponse.index == null) return null;
      const contentBlockIndex = asInt(claudeResponse.index);
      const toolIndex = state.toolIndexByContentBlock.get(contentBlockIndex);
      if (toolIndex == null) {
        if (isClaudeHostedToolStreamBlock(state.blockTypeByContentBlock.get(contentBlockIndex) || "")) return null;
        return null;
      }
      converted.index = toolIndex;
    }
  } else if (type === "content_block_stop") {
    if (claudeResponse.index != null) state.blockTypeByContentBlock.delete(asInt(claudeResponse.index));
  }
  return streamResponseClaude2OpenAI(converted);
}

type ClaudeResponseInfo = {
  responseId: string;
  created: number;
  model: string;
  usage: OpenAIUsage;
  done: boolean;
};

/** Original `FormatClaudeResponseInfo` (id/created/model + semantic usage accumulation). */
function formatClaudeResponseInfo(
  claudeResponse: Record<string, unknown>,
  oaiResponse: Record<string, unknown> | null,
  info: ClaudeResponseInfo,
): boolean {
  const type = str(claudeResponse.type);
  if (type === "message_start") {
    const message = asObj(claudeResponse.message);
    if (message.id) info.responseId = str(message.id);
    if (message.model) info.model = str(message.model);
    const messageUsage = message.usage && typeof message.usage === "object" ? asObj(message.usage) : null;
    if (messageUsage) {
      info.usage.prompt_tokens = asInt(messageUsage.input_tokens);
      info.usage.usage_semantic = "anthropic";
      info.usage.prompt_tokens_details.cached_tokens = asInt(messageUsage.cache_read_input_tokens);
      const cachedCreation = asInt(messageUsage.cache_creation_input_tokens);
      if (cachedCreation) info.usage.prompt_tokens_details.cached_creation_tokens = cachedCreation;
      info.usage.claude_cache_creation_5_m_tokens = cacheCreation5m(messageUsage);
      info.usage.claude_cache_creation_1_h_tokens = cacheCreation1h(messageUsage);
      info.usage.completion_tokens = asInt(messageUsage.output_tokens);
      info.usage.billing_usage = newClaudeMessagesBillingUsage(messageUsage);
    }
  } else if (type === "content_block_delta") {
    /* response text is accumulated by the host for fallback estimates */
  } else if (type === "message_delta") {
    const usage = claudeResponse.usage && typeof claudeResponse.usage === "object" ? asObj(claudeResponse.usage) : null;
    if (usage) {
      info.usage.usage_semantic = "anthropic";
      if (asInt(usage.input_tokens) > 0) info.usage.prompt_tokens = asInt(usage.input_tokens);
      if (asInt(usage.cache_read_input_tokens) > 0) info.usage.prompt_tokens_details.cached_tokens = asInt(usage.cache_read_input_tokens);
      if (asInt(usage.cache_creation_input_tokens) > 0) {
        info.usage.prompt_tokens_details.cached_creation_tokens = asInt(usage.cache_creation_input_tokens);
      }
      const cache5m = cacheCreation5m(usage);
      const cache1h = cacheCreation1h(usage);
      if (cache5m > 0) info.usage.claude_cache_creation_5_m_tokens = cache5m;
      if (cache1h > 0) info.usage.claude_cache_creation_1_h_tokens = cache1h;
      if (asInt(usage.output_tokens) > 0) info.usage.completion_tokens = asInt(usage.output_tokens);
      info.usage.total_tokens = info.usage.prompt_tokens + info.usage.completion_tokens;
      const billing = newClaudeMessagesBillingUsage(usage);
      if (billing) info.usage.billing_usage = billing;
    }
    info.done = true;
  } else if (type === "content_block_start") {
    /* keep */
  } else {
    return false;
  }
  if (oaiResponse) {
    oaiResponse.id = info.responseId;
    oaiResponse.created = info.created;
    oaiResponse.model = info.model;
  }
  return true;
}

function finalUsageChunk(id: string, created: number, model: string, usage: OpenAIUsage): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: null,
    choices: [],
    usage: openAIUsageToJson(usage),
  };
}

/** Original Claude SSE → OpenAI chat SSE (`ClaudeStreamHandler` OpenAI format). */
export function claudeSseToOpenAIChat(sseText: string, opts: ClaudeToOpenAIOpts = {}): { body: string; usage: OpenAIUsage } {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const state: ClaudeStreamState = {
    toolIndexByContentBlock: new Map(),
    blockTypeByContentBlock: new Map(),
    nextToolIndex: 0,
  };
  const info: ClaudeResponseInfo = {
    responseId: `chatcmpl-${compactUuid()}`,
    created,
    model: opts.upstreamModel || "",
    usage: emptyOpenAIUsage(),
    done: false,
  };
  let body = "";
  for (const payload of parseSseDataPayloads(sseText)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const chunk = convertClaudeStreamChunk(state, event);
    if (!formatClaudeResponseInfo(event, chunk, info)) continue;
    if (!chunk) continue;
    body += sseLine(chunk);
  }
  const mapped = buildOpenAIStyleUsageFromClaudeUsage(info.usage);
  if (opts.includeUsage) body += sseLine(finalUsageChunk(info.responseId, created, info.model, mapped));
  body += "data: [DONE]\n\n";
  return { body, usage: mapped };
}

export function claudeUpstreamToOpenAIChat(
  text: string,
  model: string,
  opts: ClaudeToOpenAIOpts = {},
): { json?: Record<string, unknown>; sse?: string; usage: OpenAIUsage } {
  if (looksLikeSse(text)) {
    const converted = claudeSseToOpenAIChat(text, { ...opts, upstreamModel: opts.upstreamModel || model });
    return { sse: converted.body, usage: converted.usage };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { content: [{ type: "text", text }] };
  }
  const json = openaiFromAnthropicResponse(parsed, model);
  const apiUsage = claudeUsageFromResponse(parsed);
  return { json, usage: apiUsage ? usageFromClaudeAPIUsage(apiUsage) : buildOpenAIStyleUsageFromClaudeUsage(emptyOpenAIUsage()) };
}
