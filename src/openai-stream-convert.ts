/** Original `oaichat.StreamResponseOpenAI2Claude` / `ConvertChunk` Gemini stream. Does not import convert.ts or upstream.ts. */

import { openaiFinishReasonToClaudeStopReason, normalizeCacheCreationSplit, chatAnnotationsToClaude } from "./claude-response.js";
import { asInt, asObj, compactUuid, parseSseDataPayloads } from "./openai-usage.js";

type LastMessageType = "" | "text" | "tools" | "thinking";

type OpenAIUsageSnap = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  input_tokens: number;
  output_tokens: number;
  claude_cache_creation_5_m_tokens: number;
  claude_cache_creation_1_h_tokens: number;
  usage_semantic: string;
  prompt_tokens_details: {
    cached_tokens: number;
    cached_creation_tokens: number;
    cache_write_tokens: number;
    text_tokens: number;
    audio_tokens: number;
    image_tokens: number;
  };
  billing_usage?: Record<string, unknown>;
};

type ClaudeStreamToolCall = {
  blockIndex: number;
  id: string;
  name: string;
  started: boolean;
  pendingArguments: string;
};

export type ClaudeConvertInfo = {
  lastMessagesType: LastMessageType;
  index: number;
  toolCallBaseIndex: number;
  toolCallMaxIndexOffset: number;
  toolCalls: ClaudeStreamToolCall[];
  toolCallByIndex: Map<number, ClaudeStreamToolCall>;
  toolCallById: Map<string, ClaudeStreamToolCall>;
  usage?: OpenAIUsageSnap;
  finishReason: string;
  done: boolean;
};

export type ClaudeStreamMeta = {
  sendResponseCount: number;
  estimatePromptTokens: number;
  claude: ClaudeConvertInfo;
};

type GeminiStreamTool = {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
};

type GeminiStreamState = {
  toolsByChoice: Map<number, GeminiStreamTool[]>;
  toolByIndex: Map<string, GeminiStreamTool>;
  toolById: Map<string, GeminiStreamTool>;
  finishedChoices: Set<number>;
  seenChoices: Set<number>;
  usage?: OpenAIUsageSnap;
  usageEmitted: boolean;
  finalized: boolean;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseOpenAIUsage(raw: unknown): OpenAIUsageSnap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = asObj(raw);
  const details = asObj(u.prompt_tokens_details);
  const billing = u.billing_usage && typeof u.billing_usage === "object" && !Array.isArray(u.billing_usage) ? asObj(u.billing_usage) : undefined;
  return {
    prompt_tokens: asInt(u.prompt_tokens),
    completion_tokens: asInt(u.completion_tokens),
    total_tokens: asInt(u.total_tokens),
    prompt_cache_hit_tokens: asInt(u.prompt_cache_hit_tokens),
    input_tokens: asInt(u.input_tokens),
    output_tokens: asInt(u.output_tokens),
    claude_cache_creation_5_m_tokens: asInt(u.claude_cache_creation_5_m_tokens),
    claude_cache_creation_1_h_tokens: asInt(u.claude_cache_creation_1_h_tokens),
    usage_semantic: str(u.usage_semantic),
    prompt_tokens_details: {
      cached_tokens: asInt(details.cached_tokens),
      cached_creation_tokens: asInt(details.cached_creation_tokens),
      cache_write_tokens: asInt(details.cache_write_tokens),
      text_tokens: asInt(details.text_tokens),
      audio_tokens: asInt(details.audio_tokens),
      image_tokens: asInt(details.image_tokens),
    },
    billing_usage: billing,
  };
}

function hasOpenAIUsageTokens(usage: OpenAIUsageSnap | undefined): boolean {
  if (!usage) return false;
  if (
    usage.prompt_tokens ||
    usage.completion_tokens ||
    usage.total_tokens ||
    usage.input_tokens ||
    usage.output_tokens ||
    usage.prompt_cache_hit_tokens ||
    usage.claude_cache_creation_5_m_tokens ||
    usage.claude_cache_creation_1_h_tokens
  ) {
    return true;
  }
  const d = usage.prompt_tokens_details;
  return Boolean(d.cached_tokens || d.cached_creation_tokens || d.cache_write_tokens || d.text_tokens || d.audio_tokens || d.image_tokens);
}

function cloneBilling(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const clone = cloneJson(usage);
  const openai = clone.openai_usage && typeof clone.openai_usage === "object" ? asObj(clone.openai_usage) : undefined;
  if (openai) {
    delete openai.billing_usage;
    clone.openai_usage = openai;
  }
  const claude = clone.claude_usage && typeof clone.claude_usage === "object" ? asObj(clone.claude_usage) : undefined;
  if (claude) {
    delete claude.billing_usage;
    clone.claude_usage = claude;
  }
  const gemini = clone.gemini_usage_metadata && typeof clone.gemini_usage_metadata === "object" ? asObj(clone.gemini_usage_metadata) : undefined;
  if (gemini) {
    delete gemini.billing_usage;
    clone.gemini_usage_metadata = gemini;
  }
  return clone;
}

function openAIUsageJson(usage: OpenAIUsageSnap): Record<string, unknown> {
  const details: Record<string, number> = {
    cached_tokens: usage.prompt_tokens_details.cached_tokens,
    text_tokens: usage.prompt_tokens_details.text_tokens,
    audio_tokens: usage.prompt_tokens_details.audio_tokens,
    image_tokens: usage.prompt_tokens_details.image_tokens,
  };
  if (usage.prompt_tokens_details.cached_creation_tokens) details.cached_creation_tokens = usage.prompt_tokens_details.cached_creation_tokens;
  if (usage.prompt_tokens_details.cache_write_tokens) details.cache_write_tokens = usage.prompt_tokens_details.cache_write_tokens;
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens || usage.prompt_tokens + usage.completion_tokens,
    prompt_tokens_details: details,
    completion_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0, reasoning_tokens: 0 },
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    input_tokens_details: null,
    claude_cache_creation_5_m_tokens: usage.claude_cache_creation_5_m_tokens,
    claude_cache_creation_1_h_tokens: usage.claude_cache_creation_1_h_tokens,
  };
}

function mergeInputDetails(
  current: OpenAIUsageSnap["prompt_tokens_details"],
  incoming: OpenAIUsageSnap["prompt_tokens_details"],
): OpenAIUsageSnap["prompt_tokens_details"] {
  return {
    cached_tokens: incoming.cached_tokens > 0 ? incoming.cached_tokens : current.cached_tokens,
    cached_creation_tokens: incoming.cached_creation_tokens > 0 ? incoming.cached_creation_tokens : current.cached_creation_tokens,
    cache_write_tokens: incoming.cache_write_tokens > 0 ? incoming.cache_write_tokens : current.cache_write_tokens,
    text_tokens: incoming.text_tokens > 0 ? incoming.text_tokens : current.text_tokens,
    audio_tokens: incoming.audio_tokens > 0 ? incoming.audio_tokens : current.audio_tokens,
    image_tokens: incoming.image_tokens > 0 ? incoming.image_tokens : current.image_tokens,
  };
}

function sameBillingDialect(current: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const cs = str(current.source);
  const isrc = str(incoming.source);
  if (cs && isrc && cs.toLowerCase() !== isrc.toLowerCase()) return false;
  const csem = str(current.semantic);
  const isem = str(incoming.semantic);
  if (csem && isem && csem.toLowerCase() !== isem.toLowerCase()) return false;
  return Boolean(
    (current.openai_usage && incoming.openai_usage) ||
      (current.claude_usage && incoming.claude_usage) ||
      (current.gemini_usage_metadata && incoming.gemini_usage_metadata),
  );
}

function mergeBillingNonZero(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!incoming) return current ? cloneBilling(current) : undefined;
  if (!current || !sameBillingDialect(current, incoming)) {
    const replaced = cloneBilling(incoming);
    if (current && replaced) replaced.estimated = Boolean(current.estimated) || Boolean(incoming.estimated);
    return replaced;
  }
  const merged = cloneBilling(current) || {};
  if (incoming.source) merged.source = incoming.source;
  if (incoming.semantic) merged.semantic = incoming.semantic;
  merged.estimated = Boolean(current.estimated) || Boolean(incoming.estimated);
  if (current.openai_usage && incoming.openai_usage) {
    const cur = parseOpenAIUsage(current.openai_usage);
    const inc = parseOpenAIUsage(incoming.openai_usage);
    if (cur && inc) merged.openai_usage = openAIUsageJson(mergeUsageNonZero(cur, inc));
  }
  return merged;
}

function mergeUsageNonZero(current: OpenAIUsageSnap | undefined, incoming: OpenAIUsageSnap | undefined): OpenAIUsageSnap {
  const out: OpenAIUsageSnap = current
    ? {
        ...current,
        prompt_tokens_details: { ...current.prompt_tokens_details },
        billing_usage: current.billing_usage ? cloneBilling(current.billing_usage) : undefined,
      }
    : {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_cache_hit_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        claude_cache_creation_5_m_tokens: 0,
        claude_cache_creation_1_h_tokens: 0,
        usage_semantic: "",
        prompt_tokens_details: {
          cached_tokens: 0,
          cached_creation_tokens: 0,
          cache_write_tokens: 0,
          text_tokens: 0,
          audio_tokens: 0,
          image_tokens: 0,
        },
      };
  if (!incoming) return out;
  if (incoming.prompt_tokens > 0) out.prompt_tokens = incoming.prompt_tokens;
  if (incoming.completion_tokens > 0) out.completion_tokens = incoming.completion_tokens;
  if (incoming.total_tokens > 0) out.total_tokens = incoming.total_tokens;
  if (incoming.prompt_cache_hit_tokens > 0) out.prompt_cache_hit_tokens = incoming.prompt_cache_hit_tokens;
  if (incoming.input_tokens > 0) out.input_tokens = incoming.input_tokens;
  if (incoming.output_tokens > 0) out.output_tokens = incoming.output_tokens;
  if (incoming.claude_cache_creation_5_m_tokens > 0) out.claude_cache_creation_5_m_tokens = incoming.claude_cache_creation_5_m_tokens;
  if (incoming.claude_cache_creation_1_h_tokens > 0) out.claude_cache_creation_1_h_tokens = incoming.claude_cache_creation_1_h_tokens;
  if (incoming.usage_semantic) out.usage_semantic = incoming.usage_semantic;
  out.prompt_tokens_details = mergeInputDetails(out.prompt_tokens_details, incoming.prompt_tokens_details);
  if (incoming.billing_usage) out.billing_usage = mergeBillingNonZero(out.billing_usage, incoming.billing_usage);
  const total = out.prompt_tokens + out.completion_tokens;
  if (total > out.total_tokens) out.total_tokens = total;
  return out;
}

function claudeUsageJson(usage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_tokens: asInt(usage.input_tokens),
    cache_creation_input_tokens: asInt(usage.cache_creation_input_tokens),
    cache_read_input_tokens: asInt(usage.cache_read_input_tokens),
    output_tokens: asInt(usage.output_tokens),
    claude_cache_creation_5_m_tokens: asInt(usage.claude_cache_creation_5_m_tokens),
    claude_cache_creation_1_h_tokens: asInt(usage.claude_cache_creation_1_h_tokens),
  };
  if (usage.cache_creation) out.cache_creation = usage.cache_creation;
  if (usage.server_tool_use) out.server_tool_use = usage.server_tool_use;
  if (usage.billing_usage) out.billing_usage = usage.billing_usage;
  return out;
}

/** Original `shared/claude.UsageFromOpenAI`. */
function buildClaudeUsageFromOpenAI(usage: OpenAIUsageSnap | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const existing = cloneBilling(usage.billing_usage);
  if (
    existing &&
    existing.claude_usage &&
    typeof existing.claude_usage === "object" &&
    (str(existing.source) === "claude_messages" || str(existing.semantic) === "anthropic")
  ) {
    const result = { ...asObj(existing.claude_usage) };
    result.billing_usage = existing;
    return claudeUsageJson(result);
  }
  const details = usage.prompt_tokens_details;
  const cacheCreationTokens = Math.max(details.cache_write_tokens, details.cached_creation_tokens);
  const [cache5m, cache1h] = normalizeCacheCreationSplit(
    details.cached_creation_tokens,
    usage.claude_cache_creation_5_m_tokens,
    usage.claude_cache_creation_1_h_tokens,
  );
  let inputTokens = usage.prompt_tokens;
  if (usage.usage_semantic !== "anthropic") {
    inputTokens = usage.prompt_tokens - details.cached_tokens - cacheCreationTokens;
    if (inputTokens < 0) inputTokens = 0;
  }
  let billingUsage = existing;
  if (!billingUsage && hasOpenAIUsageTokens(usage)) {
    billingUsage = { source: "oai_chat", semantic: "openai", openai_usage: openAIUsageJson(usage) };
  }
  const result: Record<string, unknown> = {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: details.cached_tokens,
    output_tokens: usage.completion_tokens,
    claude_cache_creation_5_m_tokens: 0,
    claude_cache_creation_1_h_tokens: 0,
  };
  if (cache5m > 0 || cache1h > 0) {
    result.cache_creation = {
      ephemeral_5m_input_tokens: cache5m,
      ephemeral_1h_input_tokens: cache1h,
    };
  }
  if (billingUsage) result.billing_usage = billingUsage;
  return claudeUsageJson(result);
}

function mergeClaudeUsageNonZero(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!incoming) return current ? claudeUsageJson(current) : undefined;
  if (!current) return claudeUsageJson(incoming);
  const merged = claudeUsageJson(current);
  if (asInt(incoming.input_tokens) > 0) merged.input_tokens = asInt(incoming.input_tokens);
  if (asInt(incoming.cache_creation_input_tokens) > 0) merged.cache_creation_input_tokens = asInt(incoming.cache_creation_input_tokens);
  if (asInt(incoming.cache_read_input_tokens) > 0) merged.cache_read_input_tokens = asInt(incoming.cache_read_input_tokens);
  if (asInt(incoming.output_tokens) > 0) merged.output_tokens = asInt(incoming.output_tokens);
  if (asInt(incoming.claude_cache_creation_5_m_tokens) > 0) {
    merged.claude_cache_creation_5_m_tokens = asInt(incoming.claude_cache_creation_5_m_tokens);
  }
  if (asInt(incoming.claude_cache_creation_1_h_tokens) > 0) {
    merged.claude_cache_creation_1_h_tokens = asInt(incoming.claude_cache_creation_1_h_tokens);
  }
  if (incoming.cache_creation) merged.cache_creation = incoming.cache_creation;
  if (incoming.billing_usage) merged.billing_usage = cloneBilling(asObj(incoming.billing_usage));
  else if (current.billing_usage) merged.billing_usage = cloneBilling(asObj(current.billing_usage));
  return merged;
}

function clientVisibleClaudeStreamUsage(state: ClaudeConvertInfo, incoming: OpenAIUsageSnap | undefined): Record<string, unknown> | undefined {
  const prior = buildClaudeUsageFromOpenAI(state.usage);
  const converted = buildClaudeUsageFromOpenAI(incoming);
  if (incoming) state.usage = mergeUsageNonZero(state.usage, incoming);
  if (!prior) return converted;
  if (!converted) return prior;
  return mergeClaudeUsageNonZero(prior, converted);
}

function generateStopBlock(index: number): Record<string, unknown> {
  return { type: "content_block_stop", index };
}

function stopOpenBlocks(state: ClaudeConvertInfo): Record<string, unknown>[] {
  switch (state.lastMessagesType) {
    case "text":
    case "thinking":
      return [generateStopBlock(state.index)];
    case "tools":
      if (!state.toolCalls.length) {
        const responses: Record<string, unknown>[] = [];
        for (let offset = 0; offset <= state.toolCallMaxIndexOffset; offset++) {
          responses.push(generateStopBlock(state.toolCallBaseIndex + offset));
        }
        return responses;
      }
      return state.toolCalls.filter((tool) => tool.started).map((tool) => generateStopBlock(tool.blockIndex));
    default:
      return [];
  }
}

function startPendingToolBlocks(state: ClaudeConvertInfo): Record<string, unknown>[] {
  if (state.lastMessagesType !== "tools") return [];
  const responses: Record<string, unknown>[] = [];
  for (const tool of state.toolCalls) {
    if (tool.started || !tool.name) continue;
    if (!tool.id) tool.id = `toolu_${compactUuid()}`;
    responses.push({
      type: "content_block_start",
      index: tool.blockIndex,
      content_block: { id: tool.id, type: "tool_use", name: tool.name, input: {} },
    });
    tool.started = true;
    if (tool.pendingArguments) {
      responses.push({
        type: "content_block_delta",
        index: tool.blockIndex,
        delta: { type: "input_json_delta", partial_json: tool.pendingArguments },
      });
      tool.pendingArguments = "";
    }
  }
  return responses;
}

function emptyClaudeConvertInfo(): ClaudeConvertInfo {
  return {
    lastMessagesType: "",
    index: 0,
    toolCallBaseIndex: 0,
    toolCallMaxIndexOffset: 0,
    toolCalls: [],
    toolCallByIndex: new Map(),
    toolCallById: new Map(),
    finishReason: "",
    done: false,
  };
}

export function newClaudeStreamMeta(opts: { sendResponseCount?: number; estimatePromptTokens?: number } = {}): ClaudeStreamMeta {
  return {
    sendResponseCount: opts.sendResponseCount || 0,
    estimatePromptTokens: opts.estimatePromptTokens || 0,
    claude: emptyClaudeConvertInfo(),
  };
}

function deltaContentString(delta: Record<string, unknown>): string {
  return typeof delta.content === "string" ? delta.content : "";
}

function deltaReasoningContent(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  return "";
}

function toolCallsOfDelta(delta: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : [];
}

function stopReasonOpenAI2Claude(reason: string): string {
  return openaiFinishReasonToClaudeStopReason(reason);
}

/** Original `oaichat.StreamResponseOpenAI2Claude`. */
export function streamResponseOpenAI2Claude(
  openAIResponse: Record<string, unknown>,
  info: ClaudeStreamMeta,
): Record<string, unknown>[] {
  const state = info.claude;
  if (state.done) return [];
  const claudeResponses: Record<string, unknown>[] = [];
  const appendStopOpenBlocks = () => {
    claudeResponses.push(...startPendingToolBlocks(state), ...stopOpenBlocks(state));
  };
  const stopOpenBlocksAndAdvance = () => {
    if (state.lastMessagesType === "") return;
    appendStopOpenBlocks();
    if (state.lastMessagesType === "tools") {
      state.index = state.toolCallBaseIndex + state.toolCalls.length;
      state.toolCallBaseIndex = 0;
      state.toolCallMaxIndexOffset = 0;
      state.toolCalls = [];
      state.toolCallByIndex = new Map();
      state.toolCallById = new Map();
    } else {
      state.index++;
    }
    state.lastMessagesType = "";
  };
  const appendCitationDeltas = (raw: unknown) => {
    const citations = chatAnnotationsToClaude(raw, "");
    if (!citations.length) return;
    if (state.lastMessagesType !== "text") {
      stopOpenBlocksAndAdvance();
      claudeResponses.push({
        type: "content_block_start",
        index: state.index,
        content_block: { type: "text", text: "" },
      });
      state.lastMessagesType = "text";
    }
    for (const citation of citations) {
      claudeResponses.push({
        type: "content_block_delta",
        index: state.index,
        delta: { type: "citations_delta", citation },
      });
    }
  };

  const incomingUsage = parseOpenAIUsage(openAIResponse.usage);
  if (info.sendResponseCount === 1) {
    let startUsage: Record<string, unknown> = {
      input_tokens: info.estimatePromptTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      claude_cache_creation_5_m_tokens: 0,
      claude_cache_creation_1_h_tokens: 0,
    };
    if (incomingUsage && hasOpenAIUsageTokens(incomingUsage)) {
      const real = buildClaudeUsageFromOpenAI(incomingUsage);
      if (real) startUsage = real;
      state.usage = mergeUsageNonZero(state.usage, incomingUsage);
    }
    const message: Record<string, unknown> = {
      type: "message",
      role: "assistant",
      usage: startUsage,
    };
    if (openAIResponse.id) message.id = openAIResponse.id;
    if (openAIResponse.model) message.model = openAIResponse.model;
    claudeResponses.push({ type: "message_start", message });
  }

  const choices = Array.isArray(openAIResponse.choices) ? (openAIResponse.choices as Record<string, unknown>[]) : [];
  if (!choices.length) {
    const oaiUsage = clientVisibleClaudeStreamUsage(state, incomingUsage);
    if (oaiUsage) {
      appendStopOpenBlocks();
      let stopReason = stopReasonOpenAI2Claude(state.finishReason);
      if (!stopReason) stopReason = "end_turn";
      claudeResponses.push({
        type: "message_delta",
        usage: oaiUsage,
        delta: { stop_reason: stopReason },
      });
      claudeResponses.push({ type: "message_stop" });
      state.done = true;
    }
    return claudeResponses;
  }

  const chosenChoice = asObj(choices[0]);
  const finishRaw = chosenChoice.finish_reason;
  const doneChunk = typeof finishRaw === "string" && finishRaw !== "";
  if (doneChunk) state.finishReason = str(finishRaw);
  const delta = asObj(chosenChoice.delta);
  const toolCalls = toolCallsOfDelta(delta);
  let isEmpty = false;
  const claudeResponse: Record<string, unknown> = { type: "content_block_delta" };

  if (toolCalls.length) {
    if (state.lastMessagesType !== "tools") {
      stopOpenBlocksAndAdvance();
      state.toolCallBaseIndex = state.index;
      state.toolCallMaxIndexOffset = 0;
      state.toolCalls = [];
      state.toolCallByIndex = new Map();
      state.toolCallById = new Map();
    }
    state.lastMessagesType = "tools";
    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = asObj(toolCalls[i]);
      let toolIndex = i;
      if (toolCall.index != null && Number.isFinite(Number(toolCall.index))) toolIndex = asInt(toolCall.index);
      const incomingID = str(toolCall.id).trim();
      const fn = asObj(toolCall.function);
      let tool = incomingID ? state.toolCallById.get(incomingID) : undefined;
      if (!tool) tool = state.toolCallByIndex.get(toolIndex);
      if (tool && incomingID && tool.id && tool.id !== incomingID) tool = undefined;
      if (!tool) {
        tool = { blockIndex: state.toolCallBaseIndex + state.toolCalls.length, id: "", name: "", started: false, pendingArguments: "" };
        state.toolCalls.push(tool);
      }
      state.toolCallByIndex.set(toolIndex, tool);
      if (!tool.id && incomingID) {
        tool.id = incomingID;
        state.toolCallById.set(incomingID, tool);
      }
      if (!tool.name && str(fn.name).trim()) tool.name = str(fn.name).trim();
      const argumentsText = typeof fn.arguments === "string" ? fn.arguments : "";
      if (!tool.started) tool.pendingArguments += argumentsText;
      const idx = tool.blockIndex;
      if (!tool.started && tool.id && tool.name) {
        claudeResponses.push({
          type: "content_block_start",
          index: idx,
          content_block: { id: tool.id, type: "tool_use", name: tool.name, input: {} },
        });
        tool.started = true;
        if (tool.pendingArguments) {
          claudeResponses.push({
            type: "content_block_delta",
            index: idx,
            delta: { type: "input_json_delta", partial_json: tool.pendingArguments },
          });
          tool.pendingArguments = "";
        }
        continue;
      }
      if (tool.started && argumentsText) {
        claudeResponses.push({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: argumentsText },
        });
      }
    }
    state.toolCallMaxIndexOffset = state.toolCalls.length - 1;
    if (state.toolCalls.length > 0) state.index = state.toolCallBaseIndex + state.toolCalls.length - 1;
  } else {
    const reasoning = deltaReasoningContent(delta);
    const textContent = deltaContentString(delta);
    if (reasoning || textContent) {
      if (reasoning) {
        if (state.lastMessagesType !== "thinking") {
          stopOpenBlocksAndAdvance();
          claudeResponses.push({
            type: "content_block_start",
            index: state.index,
            content_block: { type: "thinking", thinking: "" },
          });
        }
        state.lastMessagesType = "thinking";
        claudeResponse.delta = { type: "thinking_delta", thinking: reasoning };
      } else {
        if (state.lastMessagesType !== "text") {
          stopOpenBlocksAndAdvance();
          claudeResponses.push({
            type: "content_block_start",
            index: state.index,
            content_block: { type: "text", text: "" },
          });
        }
        state.lastMessagesType = "text";
        claudeResponse.delta = { type: "text_delta", text: textContent };
      }
    } else {
      isEmpty = true;
    }
  }

  claudeResponse.index = state.index;
  if (!isEmpty && claudeResponse.delta) claudeResponses.push(claudeResponse);
  appendCitationDeltas(delta.annotations);

  if (doneChunk || state.done) {
    const oaiUsage = clientVisibleClaudeStreamUsage(state, incomingUsage);
    if (!oaiUsage) return claudeResponses;
    appendStopOpenBlocks();
    claudeResponses.push({
      type: "message_delta",
      usage: oaiUsage,
      delta: { stop_reason: stopReasonOpenAI2Claude(state.finishReason) },
    });
    claudeResponses.push({ type: "message_stop" });
    state.done = true;
    return claudeResponses;
  }
  return claudeResponses;
}

/** Original `oaichat.FinalizeStreamResponseOpenAI2Claude`. */
export function finalizeStreamResponseOpenAI2Claude(info: ClaudeStreamMeta): Record<string, unknown>[] {
  const state = info.claude;
  if (state.done) return [];
  let stopReason = stopReasonOpenAI2Claude(state.finishReason);
  if (!stopReason) stopReason = "end_turn";
  const responses = [...startPendingToolBlocks(state), ...stopOpenBlocks(state)];
  responses.push(
    {
      type: "message_delta",
      usage: clientVisibleClaudeStreamUsage(state, undefined),
      delta: { stop_reason: stopReason },
    },
    { type: "message_stop" },
  );
  state.done = true;
  return responses;
}

function encodeClaudeSse(events: Record<string, unknown>[]): string {
  let out = "";
  for (const ev of events) {
    out += `event: ${str(ev.type)}\n`;
    out += `data: ${JSON.stringify(ev)}\n\n`;
  }
  return out;
}

function parseChatChunk(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* ignore malformed SSE payloads */
  }
  return null;
}

/** Original `OaiStreamHandler` + `HandleStreamFormat` Claude path over a buffered OpenAI chat SSE body. */
export function oaiChatSseToClaudeSse(
  sse: string,
  opts: { estimatePromptTokens?: number } = {},
): { sse: string; usageBody: Record<string, unknown> } {
  const info = newClaudeStreamMeta({ estimatePromptTokens: opts.estimatePromptTokens || 0 });
  const events: Record<string, unknown>[] = [];
  let usageBody: Record<string, unknown> = {};
  for (const payload of parseSseDataPayloads(sse)) {
    const chunk = parseChatChunk(payload);
    if (!chunk) continue;
    if (chunk.usage && typeof chunk.usage === "object") usageBody = asObj(chunk.usage);
    info.sendResponseCount++;
    events.push(...streamResponseOpenAI2Claude(chunk, info));
  }
  if (info.sendResponseCount && !info.claude.done) events.push(...finalizeStreamResponseOpenAI2Claude(info));
  return { sse: encodeClaudeSse(events), usageBody };
}

function geminiFunctionArguments(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
  if (!text || text === "null") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* preserve historically accepted malformed input */
  }
  return { arguments: typeof raw === "string" ? raw : text };
}

function geminiStreamFinishReason(finishReason: string): string {
  switch (finishReason) {
    case "stop":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    case "tool_calls":
      return "STOP";
    default:
      return "STOP";
  }
}

function geminiChunkFinishReason(finishReason: string): string {
  switch (finishReason.trim()) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "STOP";
  }
}

function openAIBillingFromUsage(usage: OpenAIUsageSnap | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  if (usage.billing_usage) return cloneBilling(usage.billing_usage);
  if (!hasOpenAIUsageTokens(usage)) return undefined;
  return { source: "oai_chat", semantic: "openai", openai_usage: openAIUsageJson(usage) };
}

function geminiMetadataFromBilling(billing: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!billing) return undefined;
  const source = str(billing.source);
  const semantic = str(billing.semantic);
  if (source !== "gemini_chat" && semantic !== "gemini") return undefined;
  const metadata = billing.gemini_usage_metadata && typeof billing.gemini_usage_metadata === "object" ? asObj(billing.gemini_usage_metadata) : undefined;
  if (!metadata) return undefined;
  const out = { ...metadata, billing_usage: cloneBilling(billing) };
  return out;
}

function geminiUsageMetadata(usage: OpenAIUsageSnap | undefined, estimatePromptTokens: number): Record<string, unknown> {
  if (!usage) {
    return {
      promptTokenCount: estimatePromptTokens,
      toolUsePromptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: estimatePromptTokens,
      thoughtsTokenCount: 0,
      cachedContentTokenCount: 0,
      promptTokensDetails: null,
      toolUsePromptTokensDetails: null,
      candidatesTokensDetails: null,
    };
  }
  const sidecar = geminiMetadataFromBilling(usage.billing_usage);
  if (sidecar) return sidecar;
  const meta: Record<string, unknown> = {
    promptTokenCount: usage.prompt_tokens,
    toolUsePromptTokenCount: 0,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
    thoughtsTokenCount: 0,
    cachedContentTokenCount: 0,
    promptTokensDetails: null,
    toolUsePromptTokensDetails: null,
    candidatesTokensDetails: null,
  };
  const billing = openAIBillingFromUsage(usage);
  if (billing) meta.billing_usage = billing;
  return meta;
}

function geminiStreamResponse(
  candidates: Record<string, unknown>[],
  usage: OpenAIUsageSnap | undefined,
  estimatePromptTokens: number,
): Record<string, unknown> {
  return {
    candidates,
    usageMetadata: geminiUsageMetadata(usage, estimatePromptTokens),
  };
}

/** Original `oaichat.StreamResponseOpenAI2Gemini`. */
export function streamResponseOpenAI2Gemini(
  openAIResponse: Record<string, unknown>,
  opts: { estimatePromptTokens?: number } = {},
): Record<string, unknown> | null {
  const choices = Array.isArray(openAIResponse.choices) ? (openAIResponse.choices as Record<string, unknown>[]) : [];
  let hasContent = false;
  let hasFinishReason = false;
  for (const choice of choices) {
    const c = asObj(choice);
    const delta = asObj(c.delta);
    if (deltaContentString(delta) || toolCallsOfDelta(delta).length) hasContent = true;
    if (c.finish_reason != null) hasFinishReason = true;
  }
  if (!hasContent && !hasFinishReason) return null;
  const usage = parseOpenAIUsage(openAIResponse.usage);
  const estimatePromptTokens = opts.estimatePromptTokens || 0;
  const geminiResponse: Record<string, unknown> = {
    candidates: [],
    usageMetadata: usage
      ? geminiUsageMetadata(usage, estimatePromptTokens)
      : {
          promptTokenCount: estimatePromptTokens,
          toolUsePromptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: estimatePromptTokens,
          thoughtsTokenCount: 0,
          cachedContentTokenCount: 0,
        },
  };
  const candidates: Record<string, unknown>[] = [];
  for (const choice of choices) {
    const c = asObj(choice);
    const delta = asObj(c.delta);
    const candidate: Record<string, unknown> = {
      index: Number(c.index || 0),
      safetyRatings: [],
    };
    if (c.finish_reason != null) candidate.finishReason = geminiStreamFinishReason(str(c.finish_reason));
    const content: Record<string, unknown> = { role: "model", parts: [] as Record<string, unknown>[] };
    const parts = content.parts as Record<string, unknown>[];
    const tools = toolCallsOfDelta(delta);
    if (tools.length) {
      for (const toolCall of tools) {
        const tc = asObj(toolCall);
        const fn = asObj(tc.function);
        const functionCall: Record<string, unknown> = {
          name: fn.name,
          args: geminiFunctionArguments(fn.arguments),
        };
        if (tc.id) functionCall.id = tc.id;
        parts.push({ functionCall });
      }
    } else {
      const textContent = deltaContentString(delta);
      if (textContent) parts.push({ text: textContent });
    }
    candidate.content = content;
    candidates.push(candidate);
  }
  geminiResponse.candidates = candidates;
  return geminiResponse;
}

function newGeminiStreamState(): GeminiStreamState {
  return {
    toolsByChoice: new Map(),
    toolByIndex: new Map(),
    toolById: new Map(),
    finishedChoices: new Set(),
    seenChoices: new Set(),
    usageEmitted: false,
    finalized: false,
  };
}

function appendGeminiToolCallDelta(state: GeminiStreamState, choiceIndex: number, toolCall: Record<string, unknown>, position: number): void {
  let toolIndex = position;
  if (toolCall.index != null && Number.isFinite(Number(toolCall.index))) toolIndex = asInt(toolCall.index);
  if (toolIndex < 0) throw new Error(`OpenAI chat choice ${choiceIndex} has negative tool-call index ${toolIndex}`);
  const indexKey = `${choiceIndex}:${toolIndex}`;
  const incomingID = str(toolCall.id).trim();
  let tool = incomingID ? state.toolById.get(`${choiceIndex}:${incomingID}`) : undefined;
  if (!tool) tool = state.toolByIndex.get(indexKey);
  if (tool && incomingID && tool.id && tool.id !== incomingID) tool = undefined;
  if (!tool) {
    tool = { id: "", name: "", arguments: "", emitted: false };
    const list = state.toolsByChoice.get(choiceIndex) || [];
    list.push(tool);
    state.toolsByChoice.set(choiceIndex, list);
  }
  state.toolByIndex.set(indexKey, tool);
  if (tool.emitted) {
    throw new Error(`OpenAI chat choice ${choiceIndex} tool-call index ${toolIndex} received data after completion`);
  }
  if (incomingID) {
    if (tool.id && tool.id !== incomingID) {
      throw new Error(`OpenAI chat choice ${choiceIndex} tool-call index ${toolIndex} changed id from "${tool.id}" to "${incomingID}"`);
    }
    tool.id = incomingID;
    state.toolById.set(`${choiceIndex}:${incomingID}`, tool);
  }
  const incomingName = str(asObj(toolCall.function).name).trim();
  if (incomingName) {
    if (tool.name && tool.name !== incomingName) {
      throw new Error(`OpenAI chat choice ${choiceIndex} tool-call index ${toolIndex} changed name from "${tool.name}" to "${incomingName}"`);
    }
    tool.name = incomingName;
  }
  const args = asObj(toolCall.function).arguments;
  tool.arguments += typeof args === "string" ? args : "";
}

function finishGeminiChoice(state: GeminiStreamState, choiceIndex: number): Record<string, unknown>[] {
  const tools = state.toolsByChoice.get(choiceIndex) || [];
  const pending = tools.filter((tool) => !tool.emitted);
  const parts: Record<string, unknown>[] = [];
  for (const tool of pending) {
    if (!tool.name) throw new Error(`OpenAI chat choice ${choiceIndex} has a tool call without a function name`);
    const functionCall: Record<string, unknown> = {
      name: tool.name,
      args: geminiFunctionArguments(tool.arguments),
    };
    if (tool.id) functionCall.id = tool.id;
    parts.push({ functionCall });
  }
  for (const tool of pending) tool.emitted = true;
  return parts;
}

/** Original `ChatToGeminiStreamState.ConvertChunk`. */
export function convertOpenAIChatToGeminiStreamChunk(
  state: GeminiStreamState,
  openAIResponse: Record<string, unknown>,
  opts: { estimatePromptTokens?: number } = {},
): Record<string, unknown>[] {
  if (state.finalized) throw new Error("OpenAI chat to Gemini stream received data after finalization");
  const incomingUsage = parseOpenAIUsage(openAIResponse.usage);
  if (incomingUsage) state.usage = incomingUsage;
  const estimate = opts.estimatePromptTokens || 0;
  const choices = Array.isArray(openAIResponse.choices) ? (openAIResponse.choices as Record<string, unknown>[]) : [];
  const candidates: Record<string, unknown>[] = [];
  for (const choice of choices) {
    const c = asObj(choice);
    const choiceIndex = asInt(c.index);
    state.seenChoices.add(choiceIndex);
    const delta = asObj(c.delta);
    const hasText = deltaContentString(delta) !== "";
    const tools = toolCallsOfDelta(delta);
    const hasToolDelta = tools.length > 0;
    const hasFinish = typeof c.finish_reason === "string" && c.finish_reason.trim() !== "";
    if (state.finishedChoices.has(choiceIndex)) {
      if (hasText || hasToolDelta) throw new Error(`OpenAI chat choice ${choiceIndex} received data after completion`);
      continue;
    }
    tools.forEach((toolCall, position) => appendGeminiToolCallDelta(state, choiceIndex, asObj(toolCall), position));
    const candidate: Record<string, unknown> = {
      index: choiceIndex,
      safetyRatings: [],
      content: { role: "model", parts: [] as Record<string, unknown>[] },
    };
    const parts = (candidate.content as { parts: Record<string, unknown>[] }).parts;
    if (hasText) parts.push({ text: deltaContentString(delta) });
    if (hasFinish) {
      parts.push(...finishGeminiChoice(state, choiceIndex));
      candidate.finishReason = geminiChunkFinishReason(str(c.finish_reason));
      state.finishedChoices.add(choiceIndex);
    } else {
      candidate.finishReason = null;
    }
    if (parts.length > 0 || candidate.finishReason != null) candidates.push(candidate);
  }
  if (!candidates.length) {
    if (incomingUsage && state.finishedChoices.size > 0) {
      state.usageEmitted = true;
      return [geminiStreamResponse([], state.usage, estimate)];
    }
    return [];
  }
  if (incomingUsage) state.usageEmitted = true;
  return [geminiStreamResponse(candidates, incomingUsage, estimate)];
}

/** Original `ChatToGeminiStreamState.Finalize`. */
export function finalizeOpenAIChatToGeminiStream(
  state: GeminiStreamState,
  opts: { estimatePromptTokens?: number } = {},
): Record<string, unknown>[] {
  if (state.finalized) return [];
  const choiceIndexes = new Set<number>();
  for (const [choiceIndex, tools] of state.toolsByChoice) {
    if (tools.some((tool) => !tool.emitted)) choiceIndexes.add(choiceIndex);
  }
  for (const choiceIndex of state.seenChoices) {
    if (!state.finishedChoices.has(choiceIndex)) choiceIndexes.add(choiceIndex);
  }
  const ordered = [...choiceIndexes].sort((a, b) => a - b);
  const estimate = opts.estimatePromptTokens || 0;
  const candidates: Record<string, unknown>[] = [];
  for (const choiceIndex of ordered) {
    const parts = finishGeminiChoice(state, choiceIndex);
    candidates.push({
      index: choiceIndex,
      finishReason: "STOP",
      safetyRatings: [],
      content: { role: "model", parts },
    });
  }
  if (!candidates.length) {
    state.finalized = true;
    if (!state.usage || state.usageEmitted) return [];
    state.usageEmitted = true;
    return [geminiStreamResponse([], state.usage, estimate)];
  }
  state.finalized = true;
  state.usageEmitted = Boolean(state.usage);
  return [geminiStreamResponse(candidates, state.usage, estimate)];
}

function encodeGeminiSse(events: Record<string, unknown>[]): string {
  let out = "";
  for (const ev of events) out += `data: ${JSON.stringify(ev)}\n\n`;
  return out;
}

/** Original `handleGeminiFormat` + `HandleFinalResponse` over a buffered OpenAI chat SSE body. */
export function oaiChatSseToGeminiSse(
  sse: string,
  opts: { estimatePromptTokens?: number } = {},
): { sse: string; usageBody: Record<string, unknown> } {
  const state = newGeminiStreamState();
  const events: Record<string, unknown>[] = [];
  let usageBody: Record<string, unknown> = {};
  const estimate = { estimatePromptTokens: opts.estimatePromptTokens || 0 };
  for (const payload of parseSseDataPayloads(sse)) {
    const chunk = parseChatChunk(payload);
    if (!chunk) continue;
    if (chunk.usage && typeof chunk.usage === "object") usageBody = asObj(chunk.usage);
    events.push(...convertOpenAIChatToGeminiStreamChunk(state, chunk, estimate));
  }
  events.push(...finalizeOpenAIChatToGeminiStream(state, estimate));
  return { sse: encodeGeminiSse(events), usageBody };
}
