import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openaiFromAnthropicResponse,
  openaiFromGeminiResponse,
  openaiFromGeminiEmbedding,
  openaiToAnthropic,
  openaiToGemini,
  usageFromOpenAI,
  applyOpenAIChatCompatibility,
  getOpenAIChatCapabilities,
  convertOpenAIRequest,
  convertOpenAIResponsesRequest,
  convertOpenAIAdaptorClaudeRequest,
  convertOpenAIAdaptorGeminiRequest,
  convertVolcClaudeRequest,
  convertDeepSeekClaudeRequest,
  convertXaiImageRequest,
  openaiFromXaiResponse,
  xaiSseToOpenAIChat,
  nativeClaudeGeminiConvertError,
  nativeOpenAIConvertEndpointError,
  usesClaudeAdaptorForClaudeRequest,
  openaiChatToClaudeResponse,
  openaiChatToGeminiResponse,
  usesOpenAIAdaptor,
  applyTextHelperStreamOptions,
  usesTextHelperStreamOptions,
  FORCE_STREAM_OPTION,
  convertClaudeRequest,
  convertVertexClaudeRequest,
  convertVertexGeminiRequest,
  VERTEX_ANTHROPIC_VERSION,
  convertAdvancedCustomClaudeRequest,
  convertAdvancedCustomGeminiRequest,
  convertAdvancedCustomInbound,
  geminiResponseToResponsesResponse,
  claudeResponseToResponsesResponse,
  responsesResponseToChatCompletion,
  chatCompletionToResponsesResponse,
  convertOpenAIChatToClaude,
  convertOllamaEmbeddingRequest,
  convertBaiduEmbeddingRequest,
  convertCohereRerankRequest,
  openaiFromBaiduResponse,
  openaiFromCohereResponse,
  openaiFromDifyResponse,
  convertDifyOpenAIRequestWithUploads,
  openaiFromZhipuResponse,
  convertMiniMaxImageRequest,
  openaiFromMiniMaxImage,
  miniMaxTTSDoResponse,
  convertMistralOpenAIRequest,
  convertMokaEmbeddingRequest,
  convertSiliconFlowImageRequest,
  convertJinaEmbeddingRequest,
  convertReplicateImageRequest,
  convertJimengImageRequest,
  requestOpenAI2Xunfei,
  convertAliImageRequest,
  convertAliFormEditFromRaw,
  convertAliRerankRequest,
  parseAliImageEditForm,
  aliImageRequestFromEditForm,
  openaiFromAliImage,
  openaiFromAliRerank,
  aliRequestURL,
  applyAliHeaders,
  supportsAliAnthropicMessages,
  isAliSyncImageModel,
  chatCompletionsStreamChunkToResponsesEvents,
  finalizeChatCompletionsStreamToResponses,
  newChatToResponsesStreamState,
  responsesStreamEventToChatChunks,
  finalizeResponsesToChatStream,
  newResponsesToChatStreamState,
  oaiChatSseToResponsesSse,
  claudeSseToResponsesSse,
  geminiSseToResponsesSse,
  GeminiToChatStreamState,
  oaiResponsesSseToChatSse,
  convertOpenAIResponsesRequestToClaudeMessages,
  convertOpenAIResponsesRequestToGeminiChat,
  responsesResponseToClaudeMessagesResponse,
  ResponsesToClaudeStreamState,
  oaiResponsesSseToClaudeSse,
  streamResponseOpenAI2Claude,
  oaiChatSseToClaudeSse,
  streamResponseOpenAI2Gemini,
  oaiChatSseToGeminiSse,
  convertClaudeMessagesToGeminiGenerateContent,
  convertGeminiGenerateContentToClaudeMessages,
  geminiResponseToClaudeMessages,
  claudeResponseToGeminiChat,
  geminiSseToClaudeSse,
  claudeSseToGeminiSse,
  CONVERTER_CLAUDE_TO_GEMINI,
  CONVERTER_GEMINI_TO_CLAUDE,
  CONVERTER_GEMINI_TO_RESPONSES,
  convertGeminiGenerateContentToOpenAIResponses,
  convertChatCompletionsToResponsesRequest,
  newClaudeStreamMeta,
  delegatesClaudeToOpenAIAdaptor,
  convertClaudeMessagesToOpenAIResponses,
  convertTextRequestViaResponses,
  CONVERTER_CLAUDE_TO_RESPONSES,
  shouldChatCompletionsUseResponsesPolicy,
  applyGeminiChannelSystemPrompt,
  applyClaudeChannelSystemPrompt,
  applyChatChannelSystemPrompt,
  getOpenAISystemRoleName,
  convertGeminiRequest,
} from "../src/convert.js";
import { claudeSseToOpenAIChat, claudeStopReasonToOpenAIFinishReason, openaiFinishReasonToClaudeStopReason } from "../src/claude-response.js";
import { geminiSseToOpenAIChat } from "../src/gemini-response.js";
import { CHANNEL_TYPE_ADVANCED_CUSTOM, CHANNEL_TYPE_ALI, CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_AWS, CHANNEL_TYPE_AZURE, CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_CLOUDFLARE, CHANNEL_TYPE_CODEX, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_COZE, CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_DIFY, CHANNEL_TYPE_DOUBAO_VIDEO, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_JIMENG, CHANNEL_TYPE_JINA, CHANNEL_TYPE_KLING, CHANNEL_TYPE_MINIMAX, CHANNEL_TYPE_MISTRAL, CHANNEL_TYPE_MOKA, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_NEW_API, CHANNEL_TYPE_OLLAMA, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER, CHANNEL_TYPE_PALM, CHANNEL_TYPE_PERPLEXITY, CHANNEL_TYPE_REPLICATE, CHANNEL_TYPE_SILICONFLOW, CHANNEL_TYPE_SORA, CHANNEL_TYPE_SUB2API, CHANNEL_TYPE_SUBMODEL, CHANNEL_TYPE_TASK_PLUGIN, CHANNEL_TYPE_TENCENT, CHANNEL_TYPE_VERTEX, CHANNEL_TYPE_VIDU, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI, CHANNEL_TYPE_XINFERENCE, CHANNEL_TYPE_XUNFEI, CHANNEL_TYPE_ZHIPU, CHANNEL_TYPE_ZHIPU_V4 } from "../src/constants.js";
import { openaiFromOllamaChatResponse, openaiFromOllamaEmbedding } from "../src/ollama-convert.js";
import { openaiFromNovaResponse } from "../src/aws-convert.js";
import { openaiFromImagenResponse, VERTEX_IMAGE_TOKENS, imagenUsage } from "../src/vertex-convert.js";
import { isClientError, getGeminiVersionSetting, GEMINI_THOUGHT_SIGNATURE_BYPASS } from "../src/reasoning.js";
import { getZhipuToken, clearZhipuTokenCache, openaiFromZhipuV4Image } from "../src/zhipu-convert.js";
import { applyTencentTc3Authorization, getTencentSign, tencentTokenHubBase, TENCENT_TOKENHUB_BASE } from "../src/tencent-convert.js";
import { buildXunfeiAuthUrl, xunfeiDomain, xunfeiHostUrl } from "../src/xunfei-convert.js";
import { applyJimengAuthorization, jimengRequestURL } from "../src/jimeng-convert.js";
import { buildCodexRelayTarget } from "../src/codex-models.js";
import { mapOpenAISizeToFlux, openaiFromReplicatePrediction } from "../src/replicate-convert.js";
import { mapModel } from "../src/select.js";
import { buildUpstream } from "../src/upstream.js";
import type { ChannelRow } from "../src/types.js";

test("original OpenAI→Claude ConvertRequest system is a text block list", () => {
  const out = openaiToAnthropic({
    model: "claude-3-5-sonnet",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    max_tokens: 10,
  });
  assert.deepEqual(out.system, [{ type: "text", text: "sys" }]);
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
  assert.equal(out.max_tokens, 10);
});

test("openaiToGemini maps roles", () => {
  const out = openaiToGemini({
    model: "gemini-2.0-flash",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ],
  });
  const contents = out.contents as { role: string }[];
  assert.equal(contents[0].role, "user");
  assert.equal(contents[1].role, "model");
  assert.deepEqual(out.systemInstruction, { parts: [{ text: "s" }] });
  const safety = out.safetySettings as { category: string; threshold: string }[];
  assert.equal(safety.length, 4);
  assert.equal(safety[0].threshold, "OFF");
});

test("anthropic response to openai usage", () => {
  const o = openaiFromAnthropicResponse(
    {
      id: "msg_1",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
    "claude",
  );
  assert.equal(usageFromOpenAI(o).prompt, 3);
  assert.equal((o.choices as { message: { content: string } }[])[0].message.content, "hello");
});

test("original Claude DoResponse JSON matches claude_to_openai golden fields", () => {
  const o = openaiFromAnthropicResponse(
    {
      id: "msg_fixed",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "The answer is 42." },
        { type: "tool_use", id: "toolu_abc", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    },
    "ignored",
  );
  assert.equal(o.id, "msg_fixed");
  assert.equal(o.object, "chat.completion");
  assert.equal(o.model, "claude-test");
  const choice = (o.choices as { index: number; message: Record<string, unknown>; finish_reason: string }[])[0];
  assert.equal(choice.index, 0);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.role, "assistant");
  assert.equal(choice.message.content, "The answer is 42.");
  const tools = choice.message.tool_calls as { id: string; type: string; function: { name: string; arguments: string } }[];
  assert.equal(tools[0].id, "toolu_abc");
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "get_weather");
  assert.equal(tools[0].function.arguments, '{"city":"Paris"}');
  const usage = o.usage as Record<string, unknown>;
  assert.equal(usage.prompt_tokens, 15);
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 20);
  assert.equal(usage.usage_semantic, "openai");
  assert.equal(usage.usage_source, "anthropic");
  assert.equal(usage.input_tokens, 15);
  assert.equal(usage.output_tokens, 0);
  assert.equal(usage.input_tokens_details, null);
  assert.equal(usage.claude_cache_creation_5_m_tokens, 2);
  assert.equal(usage.claude_cache_creation_1_h_tokens, 0);
  const billing = usage.billing_usage as { source: string; semantic: string; claude_usage: Record<string, number> };
  assert.equal(billing.source, "claude_messages");
  assert.equal(billing.semantic, "anthropic");
  assert.equal(billing.claude_usage.input_tokens, 10);
  assert.equal(billing.claude_usage.cache_creation_input_tokens, 2);
  assert.equal(billing.claude_usage.cache_read_input_tokens, 3);
  assert.equal(billing.claude_usage.output_tokens, 5);
  assert.equal(billing.claude_usage.claude_cache_creation_5_m_tokens, 0);
  assert.equal(billing.claude_usage.claude_cache_creation_1_h_tokens, 0);
  const details = usage.prompt_tokens_details as Record<string, number>;
  assert.equal(details.cached_tokens, 3);
  assert.equal(details.cached_creation_tokens, 2);
  assert.equal(details.cache_write_tokens, 2);
  assert.equal(details.text_tokens, 0);
  assert.equal(details.audio_tokens, 0);
  assert.equal(details.image_tokens, 0);
  const completionDetails = usage.completion_tokens_details as Record<string, number>;
  assert.equal(completionDetails.reasoning_tokens, 0);
  assert.equal(completionDetails.text_tokens, 0);
  assert.equal(claudeStopReasonToOpenAIFinishReason("end_turn"), "stop");
  assert.equal(claudeStopReasonToOpenAIFinishReason("max_tokens"), "length");
  assert.equal(claudeStopReasonToOpenAIFinishReason("pause_turn"), "length");
  assert.equal(claudeStopReasonToOpenAIFinishReason("refusal"), "content_filter");
});

test("original Claude Messages → OpenAI Responses composed JSON fields", () => {
  const chat = openaiFromAnthropicResponse(
    {
      id: "msg_fixed",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "The answer is 42." },
        { type: "tool_use", id: "toolu_abc", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    },
    "ignored",
  );
  const o = chatCompletionToResponsesResponse(chat, "msg_fixed");
  assert.equal(o.id, "msg_fixed");
  assert.equal(o.object, "response");
  assert.equal(o.status, "completed");
  assert.equal(o.model, "claude-test");
  assert.equal(o.instructions, null);
  assert.equal(o.max_output_tokens, 0);
  assert.equal(o.parallel_tool_calls, false);
  assert.equal(o.previous_response_id, null);
  assert.equal(o.reasoning, null);
  assert.equal(o.store, false);
  assert.equal(o.temperature, 0);
  assert.equal(o.tool_choice, null);
  assert.equal(o.tools, null);
  assert.equal(o.top_p, 0);
  assert.equal(o.truncation, null);
  assert.equal(o.user, null);
  assert.equal(o.metadata, null);
  const output = o.output as {
    type: string;
    id: string;
    status: string;
    role: string;
    quality: string;
    size: string;
    content?: { type: string; text?: string; annotations?: unknown[] }[] | null;
    call_id?: string;
    name?: string;
    arguments?: string;
  }[];
  assert.equal(output[0].type, "message");
  assert.equal(output[0].id, "msg_fixed_msg_0");
  assert.equal(output[0].status, "completed");
  assert.equal(output[0].role, "assistant");
  assert.equal(output[0].quality, "");
  assert.equal(output[0].size, "");
  assert.equal(output[0].content?.[0].type, "output_text");
  assert.equal(output[0].content?.[0].text, "The answer is 42.");
  assert.deepEqual(output[0].content?.[0].annotations, []);
  assert.equal(output[1].type, "function_call");
  assert.equal(output[1].id, "toolu_abc");
  assert.equal(output[1].call_id, "toolu_abc");
  assert.equal(output[1].name, "get_weather");
  assert.equal(output[1].arguments, '{"city":"Paris"}');
  assert.equal(output[1].content, null);
  const usage = o.usage as {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    usage_semantic: string;
    usage_source: string;
    input_tokens: number;
    output_tokens: number;
    claude_cache_creation_5_m_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    input_tokens_details: { cached_tokens: number; cached_creation_tokens: number; cache_write_tokens: number };
    billing_usage: { source: string; semantic: string; claude_usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number } };
  };
  assert.equal(usage.prompt_tokens, 15);
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 20);
  assert.equal(usage.usage_semantic, "openai");
  assert.equal(usage.usage_source, "anthropic");
  assert.equal(usage.input_tokens, 15);
  assert.equal(usage.output_tokens, 5);
  assert.equal(usage.claude_cache_creation_5_m_tokens, 2);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(usage.input_tokens_details.cached_tokens, 3);
  assert.equal(usage.input_tokens_details.cached_creation_tokens, 2);
  assert.equal(usage.input_tokens_details.cache_write_tokens, 2);
  assert.equal(usage.billing_usage.source, "claude_messages");
  assert.equal(usage.billing_usage.semantic, "anthropic");
  assert.equal(usage.billing_usage.claude_usage.input_tokens, 10);
  assert.equal(usage.billing_usage.claude_usage.cache_creation_input_tokens, 2);
  assert.equal(usage.billing_usage.claude_usage.cache_read_input_tokens, 3);
  assert.equal(usage.billing_usage.claude_usage.output_tokens, 5);

  const thinkingChat = openaiFromAnthropicResponse({
    id: "msg_think",
    model: "claude-3-7-sonnet",
    content: [
      { type: "thinking", thinking: "Deep thought." },
      { type: "text", text: "42" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const thinkingResp = chatCompletionToResponsesResponse(thinkingChat, "msg_think");
  const thinkingOut = thinkingResp.output as { type: string; summary?: { text: string }[]; content?: { text?: string }[] }[];
  assert.equal(thinkingOut[0].type, "reasoning");
  assert.equal(thinkingOut[0].summary?.[0].text, "Deep thought.");
  assert.equal(thinkingOut[1].type, "message");
  assert.equal(thinkingOut[1].content?.[0].text, "42");

  const stream = oaiChatSseToResponsesSse(
    [
      `data: ${JSON.stringify({ id: "stream_fixed", object: "chat.completion.chunk", created: 0, model: "stream-model", choices: [{ index: 0, delta: { role: "assistant", content: "Hello world" } }] })}`,
      `data: ${JSON.stringify({ id: "stream_fixed", object: "chat.completion.chunk", created: 0, model: "stream-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ id: "stream_fixed", object: "chat.completion.chunk", created: 0, model: "stream-model", choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}`,
      `data: [DONE]`,
      ``,
    ].join("\n"),
    { id: "stream_fixed", model: "stream-model", created: 0 },
  );
  assert.match(stream.sse, /event: response\.created/);
  assert.match(stream.sse, /"object":"response"/);
  assert.match(stream.sse, /event: response\.output_text\.delta/);
  assert.match(stream.sse, /"delta":"Hello world"/);
  assert.match(stream.sse, /event: response\.completed/);
  assert.match(stream.sse, /"sequence_number"/);
});

test("original Claude hosted ConvertResponse JSON emits web_search_call and mcp_call", () => {
  const chat = openaiFromAnthropicResponse(
    {
      id: "msg_hosted",
      model: "claude-test",
      content: [
        { type: "text", text: "The answer is 42." },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "answer 42" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", url: "https://example.com/42", title: "The Hitchhiker" }],
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "ignored",
  );
  const chatMessage = (chat.choices as { message: { content: string; tool_calls?: unknown[] } }[])[0].message;
  assert.equal(chatMessage.content, "The answer is 42.");
  assert.equal("tool_calls" in chatMessage, false);

  const converted = claudeResponseToResponsesResponse(
    {
      id: "msg_hosted",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "The answer is 42." },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "answer 42" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [{ type: "web_search_result", url: "https://example.com/42", title: "The Hitchhiker" }],
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    },
    "ignored",
  );
  assert.equal(converted.object, "response");
  assert.equal(converted.id, "msg_hosted");
  assert.equal(converted.model, "claude-test");
  const output = converted.output as {
    type: string;
    id?: string;
    status?: string;
    role?: string;
    content?: { type: string; text?: string }[] | null;
    action?: { type: string; query?: string; queries?: string[] };
    name?: string;
    server_label?: string;
    arguments?: string;
    output?: string;
    call_id?: string;
  }[];
  assert.equal(output[0].type, "message");
  assert.equal(output[0].content?.[0].text, "The answer is 42.");
  assert.equal(output[1].type, "web_search_call");
  assert.equal(output[1].id, "srvtoolu_1");
  assert.equal(output[1].status, "completed");
  assert.equal(output[1].action?.type, "search");
  assert.equal(output[1].action?.query, "answer 42");
  assert.equal("queries" in (output[1].action || {}), false);
  assert.equal("role" in output[1], false);
  assert.equal("content" in output[1], false);
  assert.equal("quality" in output[1], false);
  assert.equal("size" in output[1], false);
  assert.equal("name" in output[1], false);
  const usage = converted.usage as {
    billing_usage: { source: string; semantic: string; claude_usage: { input_tokens: number; output_tokens: number } };
  };
  assert.equal(usage.billing_usage.source, "claude_messages");
  assert.equal(usage.billing_usage.semantic, "anthropic");
  assert.equal(usage.billing_usage.claude_usage.input_tokens, 10);
  assert.equal(usage.billing_usage.claude_usage.output_tokens, 5);

  const pending = claudeResponseToResponsesResponse({
    id: "msg_pending",
    model: "claude-test",
    content: [{ type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "deep thought" } }],
    stop_reason: "pause_turn",
  });
  const pendingOut = pending.output as { type: string; status?: string; action?: { query?: string } }[];
  assert.equal(pendingOut[0].type, "web_search_call");
  assert.equal(pendingOut[0].status, "in_progress");
  assert.equal(pendingOut[0].action?.query, "deep thought");

  const mcp = claudeResponseToResponsesResponse({
    id: "msg_mcp",
    model: "claude-test",
    content: [
      { type: "text", text: "looked up" },
      {
        type: "mcp_tool_use",
        id: "mcptoolu_1",
        name: "lookup",
        server_name: "docs",
        input: { q: "pricing" },
      },
      { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: [{ type: "text", text: "ok" }] },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const mcpOut = mcp.output as {
    type: string;
    id?: string;
    name?: string;
    server_label?: string;
    arguments?: string;
    output?: string;
    status?: string;
    call_id?: string;
    content?: { text?: string }[];
  }[];
  assert.equal(mcpOut[0].type, "message");
  assert.equal(mcpOut[0].content?.[0].text, "looked up");
  assert.equal(mcpOut[1].type, "mcp_call");
  assert.equal(mcpOut[1].id, "mcptoolu_1");
  assert.equal(mcpOut[1].name, "lookup");
  assert.equal(mcpOut[1].server_label, "docs");
  assert.equal(mcpOut[1].arguments, '{"q":"pricing"}');
  assert.equal(mcpOut[1].status, "completed");
  assert.equal(mcpOut[1].output, "ok");
  assert.equal("call_id" in mcpOut[1], false);
  assert.equal("role" in mcpOut[1], false);
  assert.equal("content" in mcpOut[1], false);

  const mixed = claudeResponseToResponsesResponse({
    id: "msg_mixed",
    model: "claude-test",
    content: [
      { type: "text", text: "The answer is 42." },
      { type: "server_tool_use", id: "srvtoolu_3", name: "web_search", input: { query: "answer 42" } },
      { type: "tool_use", id: "toolu_abc", name: "get_weather", input: { city: "Paris" } },
    ],
    stop_reason: "tool_use",
  });
  const mixedOut = mixed.output as { type: string; id?: string; name?: string; arguments?: string }[];
  assert.equal(mixedOut[0].type, "message");
  assert.equal(mixedOut[1].type, "web_search_call");
  assert.equal(mixedOut[1].id, "srvtoolu_3");
  assert.equal(mixedOut[2].type, "function_call");
  assert.equal(mixedOut[2].id, "toolu_abc");
  assert.equal(mixedOut[2].name, "get_weather");
  assert.equal(mixedOut[2].arguments, '{"city":"Paris"}');

  const skipped = claudeResponseToResponsesResponse({
    id: "msg_skip",
    model: "claude-test",
    content: [
      { type: "text", text: "ok" },
      { type: "server_tool_use", id: "code_1", name: "code_execution", input: { code: "print(1)" } },
      { type: "mcp_tool_use", id: "mcp_skip", name: "lookup", input: { q: "x" } },
    ],
    stop_reason: "end_turn",
  });
  const skippedOut = skipped.output as { type: string }[];
  assert.equal(skippedOut.length, 1);
  assert.equal(skippedOut[0].type, "message");

  const advanced = convertAdvancedCustomInbound(
    "openai_chat_completions_to_anthropic_messages",
    "openai",
    {
      id: "msg_adv_hosted",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "The answer is 42." },
        { type: "server_tool_use", id: "srvtoolu_adv", name: "web_search", input: { query: "answer 42" } },
      ],
      stop_reason: "pause_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    },
    "claude-test",
    { relayMode: "responses", requestId: "msg_adv_hosted" },
  );
  assert.equal(advanced.object, "response");
  const advOut = advanced.output as { type: string; id?: string; status?: string; action?: { query?: string } }[];
  assert.equal(advOut[0].type, "message");
  assert.equal(advOut[1].type, "web_search_call");
  assert.equal(advOut[1].id, "srvtoolu_adv");
  assert.equal(advOut[1].status, "in_progress");
  assert.equal(advOut[1].action?.query, "answer 42");
});

test("original Claude hosted ConvertResponse stream JSON emits web_search_call and mcp_call SSE", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_hosted","model":"claude-test","usage":{"input_tokens":10,"output_tokens":0}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The answer is 42."}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"answer 42\\"}"}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.com/42","title":"The Hitchhiker"}]}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":2}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const converted = claudeSseToResponsesSse(sse, { id: "msg_hosted", model: "claude-test", created: 0 });
  assert.match(converted.sse, /event: response\.created/);
  assert.match(converted.sse, /event: response\.output_text\.delta/);
  assert.match(converted.sse, /"delta":"The answer is 42\."/);
  assert.match(converted.sse, /event: response\.output_item\.added/);
  assert.match(converted.sse, /"type":"web_search_call"/);
  assert.match(converted.sse, /"id":"srvtoolu_1"/);
  assert.match(converted.sse, /event: response\.web_search_call\.in_progress/);
  assert.match(converted.sse, /event: response\.web_search_call\.searching/);
  assert.match(converted.sse, /event: response\.web_search_call\.completed/);
  assert.match(converted.sse, /event: response\.output_item\.done/);
  assert.match(converted.sse, /"query":"answer 42"/);
  assert.equal(converted.sse.includes('"type":"function_call"'), false);
  assert.match(converted.sse, /event: response\.completed/);
  assert.match(converted.sse, /"sequence_number"/);
  const added = [...converted.sse.matchAll(/event: response\.output_item\.added\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    item?: { type?: string; id?: string; status?: string; action?: { type?: string; query?: string }; role?: string; content?: unknown; quality?: string };
  });
  const searchAdded = added.find((event) => event.item?.type === "web_search_call");
  assert.equal(searchAdded?.item?.id, "srvtoolu_1");
  assert.equal(searchAdded?.item?.status, "in_progress");
  assert.equal(searchAdded?.item?.action?.type, "search");
  assert.equal(searchAdded?.item?.action?.query, "answer 42");
  assert.equal("role" in (searchAdded?.item || {}), false);
  assert.equal("content" in (searchAdded?.item || {}), false);
  assert.equal("quality" in (searchAdded?.item || {}), false);
  const done = [...converted.sse.matchAll(/event: response\.output_item\.done\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    item?: { type?: string; id?: string; status?: string };
  });
  const searchDone = done.find((event) => event.item?.type === "web_search_call");
  assert.equal(searchDone?.item?.status, "completed");
  assert.equal(searchDone?.item?.id, "srvtoolu_1");

  const mcpSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_mcp","model":"claude-test","usage":{"input_tokens":4,"output_tokens":0}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"mcp_tool_use","id":"mcptoolu_1","name":"lookup","server_name":"docs","input":{}}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"pricing\\"}"}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"mcp_tool_result","tool_use_id":"mcptoolu_1","content":[{"type":"text","text":"ok"}]}}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    "",
  ].join("\n");
  const mcp = claudeSseToResponsesSse(mcpSse, { id: "msg_mcp", model: "claude-test", created: 0 });
  assert.match(mcp.sse, /"type":"mcp_call"/);
  assert.match(mcp.sse, /"name":"lookup"/);
  assert.match(mcp.sse, /"server_label":"docs"/);
  assert.match(mcp.sse, /event: response\.mcp_call\.in_progress/);
  assert.match(mcp.sse, /event: response\.mcp_call_arguments\.delta/);
  assert.match(mcp.sse, /"delta":"{\\"q\\":\\"pricing\\"}"/);
  assert.match(mcp.sse, /event: response\.mcp_call_arguments\.done/);
  assert.match(mcp.sse, /event: response\.mcp_call\.completed/);
  const mcpAdded = [...mcp.sse.matchAll(/event: response\.output_item\.added\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    item?: { type?: string; arguments?: string; call_id?: string; role?: string };
  });
  const mcpItem = mcpAdded.find((event) => event.item?.type === "mcp_call");
  assert.equal(mcpItem?.item?.arguments, "");
  assert.equal("call_id" in (mcpItem?.item || {}), false);
  assert.equal("role" in (mcpItem?.item || {}), false);
  const mcpDone = [...mcp.sse.matchAll(/event: response\.output_item\.done\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    item?: { type?: string; output?: string; status?: string; arguments?: string };
  });
  const mcpDoneItem = mcpDone.find((event) => event.item?.type === "mcp_call");
  assert.equal(mcpDoneItem?.item?.status, "completed");
  assert.equal(mcpDoneItem?.item?.arguments, '{"q":"pricing"}');
  assert.equal(mcpDoneItem?.item?.output, '[{"text":"ok","type":"text"}]');

  const chat = claudeSseToOpenAIChat(sse, { created: 0, includeUsage: true, upstreamModel: "claude-test" });
  assert.equal(chat.body.includes("web_search_call"), false);
  assert.equal(chat.body.includes("srvtoolu_1"), false);
});

test("original Claude thinking block becomes message.reasoning_content", () => {
  const o = openaiFromAnthropicResponse({
    id: "msg_think",
    model: "claude-3-7-sonnet",
    content: [
      { type: "thinking", thinking: "Deep thought." },
      { type: "text", text: "42" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const choice = (o.choices as { message: { content: string; reasoning_content?: string }; finish_reason: string }[])[0];
  assert.equal(choice.message.content, "42");
  assert.equal(choice.message.reasoning_content, "Deep thought.");
  assert.equal(choice.finish_reason, "stop");
});

test("original Gemini DoResponse JSON matches gemini_to_openai golden fields", () => {
  const o = openaiFromGeminiResponse(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [{ text: "The answer is 42." }, { functionCall: { name: "get_weather", args: { city: "Paris" } } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 15 },
    },
    "upstream-model",
    { id: "chatcmpl-fixed", created: 0, upstreamModel: "upstream-model" },
  );
  assert.equal(o.id, "chatcmpl-fixed");
  assert.equal(o.model, "upstream-model");
  assert.equal(o.object, "chat.completion");
  assert.equal(o.created, 0);
  const choice = (o.choices as { index: number; message: Record<string, unknown>; finish_reason: string }[])[0];
  assert.equal(choice.index, 0);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.role, "assistant");
  assert.equal(choice.message.content, "The answer is 42.");
  const tools = choice.message.tool_calls as { id: string; type: string; function: { name: string; arguments: string } }[];
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "get_weather");
  assert.equal(tools[0].function.arguments, '{"city":"Paris"}');
  assert.match(tools[0].id, /^call_/);
  const usage = o.usage as Record<string, unknown>;
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 7);
  assert.equal(usage.total_tokens, 15);
  assert.equal(usage.input_tokens, 0);
  assert.equal(usage.output_tokens, 0);
  assert.equal(usage.input_tokens_details, null);
  assert.equal(usage.claude_cache_creation_5_m_tokens, 0);
  assert.equal(usage.claude_cache_creation_1_h_tokens, 0);
  assert.equal("usage_semantic" in usage, false);
  const billing = usage.billing_usage as { source: string; semantic: string; gemini_usage_metadata: Record<string, unknown> };
  assert.equal(billing.source, "gemini_chat");
  assert.equal(billing.semantic, "gemini");
  assert.equal(billing.gemini_usage_metadata.promptTokenCount, 10);
  assert.equal(billing.gemini_usage_metadata.toolUsePromptTokenCount, 0);
  assert.equal(billing.gemini_usage_metadata.candidatesTokenCount, 5);
  assert.equal(billing.gemini_usage_metadata.totalTokenCount, 15);
  assert.equal(billing.gemini_usage_metadata.thoughtsTokenCount, 2);
  assert.equal(billing.gemini_usage_metadata.cachedContentTokenCount, 0);
  assert.deepEqual(billing.gemini_usage_metadata.promptTokensDetails, []);
  assert.deepEqual(billing.gemini_usage_metadata.toolUsePromptTokensDetails, []);
  assert.deepEqual(billing.gemini_usage_metadata.candidatesTokensDetails, []);
  const details = usage.prompt_tokens_details as Record<string, number>;
  assert.equal(details.cached_tokens, 0);
  assert.equal(details.text_tokens, 10);
  assert.equal(details.audio_tokens, 0);
  assert.equal(details.image_tokens, 0);
  assert.equal("cached_creation_tokens" in details, false);
  const completionDetails = usage.completion_tokens_details as Record<string, number>;
  assert.equal(completionDetails.reasoning_tokens, 2);
  assert.equal(completionDetails.text_tokens, 0);

  const length = openaiFromGeminiResponse(
    {
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
    "m",
  );
  assert.equal((length.choices as { finish_reason: string }[])[0].finish_reason, "length");
  const img = openaiFromGeminiResponse(
    { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "abc" } }] } }] },
    "m",
  );
  assert.equal((img.choices as { message: { content: string } }[])[0].message.content, "![image](data:image/png;base64,abc)");
  const thought = openaiFromGeminiResponse(
    { candidates: [{ content: { parts: [{ thought: true, text: "why" }, { text: "ans" }] } }] },
    "m",
  );
  const thoughtChoice = (thought.choices as { message: { content: string; reasoning_content?: string } }[])[0];
  assert.equal(thoughtChoice.message.content, "ans");
  assert.equal(thoughtChoice.message.reasoning_content, "why");
});

test("original Claude stream DoResponse emits OpenAI chunks with tool_calls finish_reason", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_fixed","model":"claude-test","usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"output_tokens":0}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The answer is 42."}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather"}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const converted = claudeSseToOpenAIChat(sse, { created: 0, includeUsage: true, upstreamModel: "claude-test" });
  assert.match(converted.body, /"object":"chat.completion.chunk"/);
  assert.match(converted.body, /"finish_reason":"tool_calls"/);
  assert.match(converted.body, /data: \[DONE\]/);
  assert.equal(converted.usage.prompt_tokens, 15);
  assert.equal(converted.usage.completion_tokens, 5);
  assert.equal(converted.usage.usage_semantic, "openai");
  assert.equal(converted.usage.usage_source, "anthropic");
});

test("original Gemini stream DoResponse emits OpenAI chunks with usage.reasoning_tokens", () => {
  const sse = [
    'data: {"candidates":[{"finishReason":"STOP","content":{"role":"model","parts":[{"text":"The answer is 42."}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":2,"totalTokenCount":15}}',
    "",
  ].join("\n");
  const converted = geminiSseToOpenAIChat(sse, { id: "chatcmpl-fixed", created: 0, upstreamModel: "upstream-model" });
  assert.match(converted.body, /"role":"assistant"/);
  assert.match(converted.body, /The answer is 42\./);
  assert.match(converted.body, /"finish_reason":"stop"/);
  assert.equal(converted.usage.prompt_tokens, 10);
  assert.equal(converted.usage.completion_tokens, 7);
  assert.equal(converted.usage.completion_tokens_details.reasoning_tokens, 2);
});

test("original Gemini ConvertResponse to OpenAI Responses JSON matches golden fields", () => {
  const converted = geminiResponseToResponsesResponse(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [{ text: "The answer is 42." }, { functionCall: { name: "get_weather", args: { city: "Paris" } } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 15 },
    },
    "upstream-model",
    { id: "chatcmpl-fixed", created: 0 },
  );
  assert.equal(converted.id, "chatcmpl-fixed");
  assert.equal(converted.object, "response");
  assert.equal(converted.created_at, 0);
  assert.equal(converted.status, "completed");
  assert.equal(converted.instructions, null);
  assert.equal(converted.max_output_tokens, 0);
  assert.equal(converted.model, "upstream-model");
  assert.equal(converted.parallel_tool_calls, false);
  assert.equal(converted.previous_response_id, null);
  assert.equal(converted.reasoning, null);
  assert.equal(converted.store, false);
  assert.equal(converted.temperature, 0);
  assert.equal(converted.tool_choice, null);
  assert.equal(converted.tools, null);
  assert.equal(converted.top_p, 0);
  assert.equal(converted.truncation, null);
  assert.equal(converted.user, null);
  assert.equal(converted.metadata, null);
  const output = converted.output as {
    type: string;
    id: string;
    status: string;
    role: string;
    quality: string;
    size: string;
    content?: { type: string; text?: string; annotations?: unknown[] }[] | null;
    call_id?: string;
    name?: string;
    arguments?: string;
  }[];
  assert.equal(output.length, 2);
  assert.equal(output[0].type, "message");
  assert.equal(output[0].id, "chatcmpl-fixed_msg_0");
  assert.equal(output[0].status, "completed");
  assert.equal(output[0].role, "assistant");
  assert.equal(output[0].quality, "");
  assert.equal(output[0].size, "");
  assert.equal(output[0].content?.[0].type, "output_text");
  assert.equal(output[0].content?.[0].text, "The answer is 42.");
  assert.deepEqual(output[0].content?.[0].annotations, []);
  assert.equal(output[1].type, "function_call");
  assert.match(output[1].id, /^call_/);
  assert.equal(output[1].call_id, output[1].id);
  assert.equal(output[1].status, "completed");
  assert.equal(output[1].role, "");
  assert.equal(output[1].content, null);
  assert.equal(output[1].quality, "");
  assert.equal(output[1].size, "");
  assert.equal(output[1].name, "get_weather");
  assert.equal(output[1].arguments, '{"city":"Paris"}');
  const usage = converted.usage as {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    prompt_tokens_details: { cached_tokens: number; text_tokens: number; audio_tokens: number; image_tokens: number };
    completion_tokens_details: { reasoning_tokens: number; text_tokens: number };
    input_tokens_details: { cached_tokens: number; text_tokens: number; audio_tokens: number; image_tokens: number } | null;
    claude_cache_creation_5_m_tokens: number;
    claude_cache_creation_1_h_tokens: number;
    billing_usage: { source: string; semantic: string; gemini_usage_metadata: Record<string, unknown> };
  };
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 7);
  assert.equal(usage.total_tokens, 15);
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 7);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(usage.prompt_tokens_details.text_tokens, 0);
  assert.equal(usage.prompt_tokens_details.audio_tokens, 0);
  assert.equal(usage.prompt_tokens_details.image_tokens, 0);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 2);
  assert.equal(usage.completion_tokens_details.text_tokens, 0);
  assert.equal(usage.input_tokens_details?.cached_tokens, 0);
  assert.equal(usage.input_tokens_details?.text_tokens, 10);
  assert.equal(usage.input_tokens_details?.audio_tokens, 0);
  assert.equal(usage.input_tokens_details?.image_tokens, 0);
  assert.equal(usage.claude_cache_creation_5_m_tokens, 0);
  assert.equal(usage.claude_cache_creation_1_h_tokens, 0);
  assert.equal("usage_semantic" in usage, false);
  assert.equal(usage.billing_usage.source, "gemini_chat");
  assert.equal(usage.billing_usage.semantic, "gemini");
  assert.equal(usage.billing_usage.gemini_usage_metadata.promptTokenCount, 10);
  assert.equal(usage.billing_usage.gemini_usage_metadata.toolUsePromptTokenCount, 0);
  assert.equal(usage.billing_usage.gemini_usage_metadata.candidatesTokenCount, 5);
  assert.equal(usage.billing_usage.gemini_usage_metadata.totalTokenCount, 15);
  assert.equal(usage.billing_usage.gemini_usage_metadata.thoughtsTokenCount, 2);
  assert.equal(usage.billing_usage.gemini_usage_metadata.cachedContentTokenCount, 0);
  assert.deepEqual(usage.billing_usage.gemini_usage_metadata.promptTokensDetails, []);
  assert.deepEqual(usage.billing_usage.gemini_usage_metadata.toolUsePromptTokensDetails, []);
  assert.deepEqual(usage.billing_usage.gemini_usage_metadata.candidatesTokensDetails, []);
});

test("original Gemini grounding ConvertResponse JSON emits url_citation and web_search_call", () => {
  const chat = openaiFromGeminiResponse(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: "The answer is 42." }] },
          groundingMetadata: {
            webSearchQueries: ["answer 42", "answer 42", " deep thought "],
            groundingChunks: [
              { web: { uri: "https://example.com/42", title: "The Hitchhiker" } },
              { retrievedContext: { uri: "https://example.com/retrieved", title: "Notes" } },
            ],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: 17, text: "The answer is 42." },
                groundingChunkIndices: [0, 1, 0],
              },
            ],
          },
        },
      ],
    },
    "upstream-model",
    { id: "chatcmpl-ground", created: 0, upstreamModel: "upstream-model" },
  );
  const message = (chat.choices as { message: { content: string; annotations?: { type: string; url_citation: Record<string, unknown> }[] } }[])[0]
    .message;
  assert.equal(message.content, "The answer is 42.");
  assert.equal(message.annotations?.length, 2);
  assert.equal(message.annotations?.[0].type, "url_citation");
  assert.equal(message.annotations?.[0].url_citation.start_index, 0);
  assert.equal(message.annotations?.[0].url_citation.end_index, 17);
  assert.equal(message.annotations?.[0].url_citation.url, "https://example.com/42");
  assert.equal(message.annotations?.[0].url_citation.title, "The Hitchhiker");
  assert.equal(message.annotations?.[1].url_citation.url, "https://example.com/retrieved");
  assert.equal(message.annotations?.[1].url_citation.title, "Notes");

  const mismatch = openaiFromGeminiResponse(
    {
      candidates: [
        {
          content: { parts: [{ text: "The answer is 42." }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://example.com/42", title: "The Hitchhiker" } }],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 17, text: "wrong" }, groundingChunkIndices: [0] },
            ],
          },
        },
      ],
    },
    "m",
  );
  assert.equal("annotations" in (mismatch.choices as { message: object }[])[0].message, false);

  const converted = geminiResponseToResponsesResponse(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: "The answer is 42." }] },
          groundingMetadata: {
            webSearchQueries: ["answer 42", " deep thought "],
            groundingChunks: [{ web: { uri: "https://example.com/42", title: "The Hitchhiker" } }],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 17, text: "The answer is 42." }, groundingChunkIndices: [0] },
            ],
          },
        },
      ],
    },
    "upstream-model",
    { id: "chatcmpl-ground", created: 0 },
  );
  const responsesOutput = converted.output as {
    type: string;
    id: string;
    status?: string;
    content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string; start_index?: number; end_index?: number }[] }[];
    action?: { type: string; queries?: string[] };
  }[];
  assert.equal(responsesOutput[0].type, "message");
  const citations = responsesOutput[0].content?.[0].annotations;
  assert.equal(citations?.[0].type, "url_citation");
  assert.equal(citations?.[0].url, "https://example.com/42");
  assert.equal(citations?.[0].title, "The Hitchhiker");
  assert.equal(citations?.[0].start_index, 0);
  assert.equal(citations?.[0].end_index, 17);
  assert.equal("url_citation" in (citations?.[0] || {}), false);
  assert.equal(responsesOutput[1].type, "web_search_call");
  assert.match(responsesOutput[1].id, /^ws_/);
  assert.equal(responsesOutput[1].status, "completed");
  assert.equal(responsesOutput[1].action?.type, "search");
  assert.deepEqual(responsesOutput[1].action?.queries, ["answer 42", "deep thought"]);
  assert.equal("role" in responsesOutput[1], false);
  assert.equal("content" in responsesOutput[1], false);
  assert.equal("quality" in responsesOutput[1], false);

  const cafe = openaiFromGeminiResponse(
    {
      candidates: [
        {
          content: { parts: [{ text: "café ok" }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://example.com/cafe", title: "Café" } }],
            groundingSupports: [{ segment: { startIndex: 0, endIndex: 5, text: "café" }, groundingChunkIndices: [0] }],
          },
        },
      ],
    },
    "m",
  );
  const cafeCite = (cafe.choices as { message: { annotations: { url_citation: { start_index: number; end_index: number } }[] } }[])[0]
    .message.annotations[0].url_citation;
  assert.equal(cafeCite.start_index, 0);
  assert.equal(cafeCite.end_index, 4);

  const stream = geminiSseToOpenAIChat(
    [
      'data: {"candidates":[{"finishReason":"STOP","content":{"role":"model","parts":[{"text":"The answer is 42."}]},"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.com/42","title":"The Hitchhiker"}}],"groundingSupports":[{"segment":{"startIndex":0,"endIndex":17,"text":"The answer is 42."},"groundingChunkIndices":[0]}]}}]}',
      "",
    ].join("\n"),
    { id: "chatcmpl-stream", created: 0, upstreamModel: "upstream-model" },
  );
  assert.match(stream.body, /"type":"url_citation"/);
  assert.match(stream.body, /"url":"https:\/\/example.com\/42"/);
  assert.match(stream.body, /"title":"The Hitchhiker"/);
});

test("original Gemini hosted ConvertResponse stream JSON emits web_search_call SSE", () => {
  const first = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "The answer is 42." }],
        },
        groundingMetadata: {
          webSearchQueries: ["answer 42", "answer 42", " deep thought "],
          groundingChunks: [{ web: { uri: "https://example.com/42", title: "The Hitchhiker" } }],
          groundingSupports: [
            { segment: { startIndex: 0, endIndex: 17, text: "The answer is 42." }, groundingChunkIndices: [0] },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  };
  const final = {
    candidates: [
      {
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: "" }] },
        groundingMetadata: { webSearchQueries: ["answer 42"] },
      },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  };
  const sse = ["data: " + JSON.stringify(first), "", "data: " + JSON.stringify(final), "", "data: [DONE]", ""].join("\n");
  const converted = geminiSseToResponsesSse(sse, { id: "gemini-responses-stream-test", model: "gemini-test", created: 0 });
  assert.match(converted.sse, /event: response\.created/);
  assert.match(converted.sse, /event: response\.output_text\.delta/);
  assert.match(converted.sse, /"delta":"The answer is 42\."/);
  assert.match(converted.sse, /event: response\.output_text\.annotation\.added/);
  assert.match(converted.sse, /"type":"url_citation"/);
  assert.match(converted.sse, /"url":"https:\/\/example.com\/42"/);
  assert.match(converted.sse, /event: response\.web_search_call\.in_progress/);
  assert.match(converted.sse, /event: response\.web_search_call\.searching/);
  assert.match(converted.sse, /event: response\.web_search_call\.completed/);
  assert.match(converted.sse, /event: response\.completed/);
  assert.match(converted.sse, /"input_tokens":2/);
  assert.match(converted.sse, /"output_tokens":3/);
  assert.match(converted.sse, /"sequence_number"/);
  assert.equal(converted.sse.includes('"choices"'), false);
  assert.equal(converted.sse.includes('"candidates"'), false);
  let orderOffset = 0;
  for (const part of [
    "event: response.created",
    "event: response.output_item.added",
    "event: response.output_text.delta",
    "event: response.output_text.done",
    '"type":"web_search_call"',
    "event: response.web_search_call.in_progress",
    "event: response.web_search_call.searching",
    "event: response.web_search_call.completed",
    "event: response.completed",
  ]) {
    const idx = converted.sse.indexOf(part, orderOffset);
    assert.notEqual(idx, -1, `missing ${part}`);
    orderOffset = idx + part.length;
  }
  const added = [...converted.sse.matchAll(/event: response\.output_item\.added\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    item?: {
      type?: string;
      id?: string;
      status?: string;
      action?: { type?: string; queries?: string[]; query?: string };
      role?: string;
      content?: unknown;
      quality?: string;
    };
  });
  const searchAdded = added.find((event) => event.item?.type === "web_search_call");
  assert.match(searchAdded?.item?.id || "", /^ws_/);
  assert.equal(searchAdded?.item?.status, "in_progress");
  assert.equal(searchAdded?.item?.action?.type, "search");
  assert.deepEqual(searchAdded?.item?.action?.queries, ["answer 42", "deep thought"]);
  assert.equal("query" in (searchAdded?.item?.action || {}), false);
  assert.equal("role" in (searchAdded?.item || {}), false);
  assert.equal("content" in (searchAdded?.item || {}), false);
  assert.equal("quality" in (searchAdded?.item || {}), false);
  const done = [...converted.sse.matchAll(/event: response\.output_item\.done\ndata: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    item?: { type?: string; id?: string; status?: string; action?: { queries?: string[] } };
  });
  const searchDone = done.find((event) => event.item?.type === "web_search_call");
  assert.equal(searchDone?.item?.status, "completed");
  assert.equal(searchDone?.item?.id, searchAdded?.item?.id);
  assert.deepEqual(searchDone?.item?.action?.queries, ["answer 42", "deep thought"]);
  assert.equal((converted.usageBody.usage as { prompt_tokens: number; completion_tokens: number }).prompt_tokens, 2);
  assert.equal((converted.usageBody.usage as { prompt_tokens: number; completion_tokens: number }).completion_tokens, 3);

  const noQuery = geminiSseToResponsesSse(
    'data: {"candidates":[{"finishReason":"STOP","content":{"role":"model","parts":[{"text":"hello"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}\n\n',
    { id: "gemini-no-search", model: "gemini-test", created: 0 },
  );
  assert.match(noQuery.sse, /"delta":"hello"/);
  assert.match(noQuery.sse, /event: response\.completed/);
  assert.equal(noQuery.sse.includes("web_search_call"), false);

  const chat = geminiSseToOpenAIChat(sse, { id: "chatcmpl-stream", created: 0, upstreamModel: "gemini-test" });
  assert.equal(chat.body.includes("web_search_call"), false);
  assert.match(chat.body, /"type":"url_citation"/);
});

test("original GeminiToChatStreamState ConvertChunk JSON emits delayed grounding and reconstructed partial tools", () => {
  const textChunk = {
    candidates: [{ index: 0, content: { role: "model", parts: [{ text: "The answer is 42." }] } }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  };
  const groundingChunk = {
    candidates: [
      {
        index: 0,
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: "" }] },
        groundingMetadata: {
          webSearchQueries: ["answer 42"],
          groundingChunks: [{ web: { uri: "https://example.com/42", title: "The Hitchhiker" } }],
          groundingSupports: [
            { segment: { startIndex: 0, endIndex: 17, text: "The answer is 42." }, groundingChunkIndices: [0] },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  };
  const delayedSse = ["data: " + JSON.stringify(textChunk), "", "data: " + JSON.stringify(groundingChunk), ""].join("\n");
  const delayed = geminiSseToResponsesSse(delayedSse, { id: "gemini-delayed-ground", model: "gemini-test", created: 0 });
  let orderOffset = 0;
  for (const part of [
    '"delta":"The answer is 42."',
    "event: response.output_text.annotation.added",
    '"type":"url_citation"',
    '"url":"https://example.com/42"',
    "event: response.output_text.done",
    '"type":"web_search_call"',
    "event: response.completed",
  ]) {
    const idx = delayed.sse.indexOf(part, orderOffset);
    assert.notEqual(idx, -1, `missing ${part}`);
    orderOffset = idx + part.length;
  }
  const annotation = [...delayed.sse.matchAll(/event: response\.output_text\.annotation\.added\ndata: (\{.*\})/g)].map(
    (m) => JSON.parse(m[1]) as { annotation?: { type?: string; url?: string; title?: string; start_index?: number; end_index?: number } },
  )[0];
  assert.equal(annotation.annotation?.type, "url_citation");
  assert.equal(annotation.annotation?.url, "https://example.com/42");
  assert.equal(annotation.annotation?.title, "The Hitchhiker");
  assert.equal(annotation.annotation?.start_index, 0);
  assert.equal(annotation.annotation?.end_index, 17);

  const state = new GeminiToChatStreamState("chatcmpl-partial", 0);
  const continuing = state.convertChunk(
    {
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              {
                functionCall: {
                  id: "call_1",
                  name: "lookup",
                  willContinue: true,
                  partialArgs: [{ jsonPath: "$.q", stringValue: "pri" }],
                },
              },
            ],
          },
        },
      ],
    },
    "gemini-test",
    null,
  );
  assert.equal(
    continuing.some((chunk) =>
      (chunk.choices as { delta?: { tool_calls?: unknown[] } }[] | undefined)?.some((choice) => choice.delta?.tool_calls?.length),
    ),
    false,
  );
  const completed = state.convertChunk(
    {
      candidates: [
        {
          index: 0,
          finishReason: "STOP",
          content: {
            parts: [
              {
                functionCall: {
                  id: "call_1",
                  name: "lookup",
                  willContinue: false,
                  partialArgs: [{ jsonPath: "$.q", stringValue: "cing" }],
                },
              },
            ],
          },
        },
      ],
    },
    "gemini-test",
    null,
  );
  const toolChunk = completed.find((chunk) =>
    (chunk.choices as { delta?: { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] | undefined)?.some(
      (choice) => choice.delta?.tool_calls?.length,
    ),
  );
  const tool = (toolChunk?.choices as { delta: { tool_calls: { index: number; id: string; function: { name: string; arguments: string } }[] } }[])[0]
    .delta.tool_calls[0];
  assert.equal(tool.index, 0);
  assert.equal(tool.id, "call_1");
  assert.equal(tool.function.name, "lookup");
  assert.equal(tool.function.arguments, '{"q":"pricing"}');
  const second = state.convertChunk(
    {
      candidates: [
        {
          index: 0,
          content: { parts: [{ functionCall: { id: "call_2", name: "other", args: { z: 1 } } }] },
        },
      ],
    },
    "gemini-test",
    null,
  );
  const secondTool = (second[0].choices as { delta: { tool_calls: { index: number; id: string }[] } }[])[0].delta.tool_calls[0];
  assert.equal(secondTool.index, 1);
  assert.equal(secondTool.id, "call_2");

  const incomplete = new GeminiToChatStreamState("chatcmpl-incomplete", 0);
  incomplete.convertChunk(
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { id: "call_x", name: "lookup", willContinue: true, partialArgs: [{ jsonPath: "$.q", stringValue: "x" }] } }],
          },
        },
      ],
    },
    "gemini-test",
    null,
  );
  assert.throws(() => incomplete.finalize("gemini-test"), /incomplete function call for candidate 0/);

  const incompleteSse = geminiSseToResponsesSse(
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_x","name":"lookup","willContinue":true,"partialArgs":[{"jsonPath":"$.q","stringValue":"x"}]}}]}}]}\n\n',
    { id: "gemini-incomplete", model: "gemini-test", created: 0 },
  );
  assert.match(incompleteSse.sse, /incomplete function call for candidate 0/);

  const chatTools = geminiSseToOpenAIChat(
    [
      'data: {"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"id":"call_1","name":"lookup","args":{"q":"a"}}}]}}]}',
      "",
      'data: {"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"id":"call_1","name":"lookup","args":{"q":"b"}}}]}}]}',
      "",
      'data: {"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"id":"call_2","name":"other","args":{"z":1}}}]}}]}',
      "",
    ].join("\n"),
    { id: "chatcmpl-tools", created: 0, upstreamModel: "gemini-test" },
  );
  const chatChunks = [...chatTools.body.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]) as {
    choices?: { delta?: { tool_calls?: { id?: string; index?: number }[] } }[];
  });
  const indexed = chatChunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []).filter((tool) => tool.id);
  assert.equal(indexed[0].id, "call_1");
  assert.equal(indexed[0].index, 0);
  assert.equal(indexed[1].id, "call_1");
  assert.equal(indexed[1].index, 0);
  assert.equal(indexed[2].id, "call_2");
  assert.equal(indexed[2].index, 1);
});

test("azure upstream url uses deployment and api-version", () => {
  const ch = {
    id: 1,
    type: 3,
    key: "ak",
    status: 1,
    name: "az",
    weight: 1,
    created_time: 0,
    test_time: 0,
    response_time: 0,
    base_url: "https://demo.openai.azure.com",
    other: "2025-04-01-preview",
    models: "gpt-4o",
    group: "default",
    used_quota: 0,
    model_mapping: "",
    status_code_mapping: "",
    priority: 0,
    auto_ban: 1,
    tag: "",
    header_override: "",
    param_override: "",
    remark: "",
    settings: "",
    openai_organization: "",
    test_model: "",
  } satisfies ChannelRow;
  const t = buildUpstream(ch, "chat", "/v1/chat/completions", "gpt-4o", { model: "gpt-4o" });
  assert.match(t.url, /\/openai\/deployments\/gpt-4o\/chat\/completions/);
  assert.equal(t.headers["api-key"], "ak");
});

test("original GetOpenAIChatCapabilities and ConvertOpenAIRequest token limits", () => {
  assert.equal(getOpenAIChatCapabilities("gpt-4.1").useMaxCompletionTokens, false);
  assert.equal(getOpenAIChatCapabilities("o3-mini").useMaxCompletionTokens, true);
  assert.equal(getOpenAIChatCapabilities("gpt-6-astra").useMaxCompletionTokens, true);
  assert.equal(getOpenAIChatCapabilities("gpt-5.6-luna").useMaxCompletionTokens, true);
  const gpt6 = applyOpenAIChatCompatibility({ model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 16, stream_options: { include_usage: true } }, "gpt-6-astra", 1);
  assert.equal(gpt6.max_completion_tokens, 16);
  assert.equal("max_tokens" in gpt6, false);
  assert.deepEqual(gpt6.stream_options, { include_usage: true });
  const azure = applyOpenAIChatCompatibility({ model: "o3-mini", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 16 }, "o3-mini", 3);
  assert.equal(azure.max_completion_tokens, 16);
  assert.equal("max_tokens" in azure, false);
  const azureStream = convertOpenAIRequest(
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_AZURE, originModelName: "gpt-4o", upstreamModelName: "gpt-4o" },
  );
  assert.deepEqual(azureStream.stream_options, { include_usage: true });
});

test("original TextHelper ForceStreamOption stream_options JSON fields", () => {
  assert.equal(FORCE_STREAM_OPTION, true);
  assert.equal(usesTextHelperStreamOptions("openai", "chat"), true);
  assert.equal(usesTextHelperStreamOptions("openai", "completions"), true);
  assert.equal(usesTextHelperStreamOptions("openai", "responses"), false);
  assert.equal(usesTextHelperStreamOptions("openai", "embeddings"), false);
  assert.equal(usesTextHelperStreamOptions("anthropic", "messages"), false);
  assert.equal(usesTextHelperStreamOptions("gemini", "gemini"), false);
  assert.equal(usesTextHelperStreamOptions("openai", "chat", true), true);

  const nonStream = applyTextHelperStreamOptions(
    {
      model: "gpt-4o",
      stream_options: { include_usage: false, include_obfuscation: false },
      messages: [{ role: "user", content: "hi" }],
    },
    CHANNEL_TYPE_OPENAI,
  );
  assert.equal("stream_options" in nonStream, false);

  const forced = applyTextHelperStreamOptions(
    {
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: false, include_obfuscation: false },
      messages: [{ role: "user", content: "hi" }],
    },
    CHANNEL_TYPE_OPENAI,
  );
  assert.deepEqual(forced.stream_options, { include_usage: true });

  const unsupported = applyTextHelperStreamOptions(
    {
      model: "sonar",
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: "user", content: "hi" }],
    },
    CHANNEL_TYPE_PERPLEXITY,
  );
  assert.equal("stream_options" in unsupported, false);

  const disabledForce = applyTextHelperStreamOptions(
    {
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: false, include_obfuscation: false },
    },
    CHANNEL_TYPE_OPENAI,
    false,
  );
  assert.deepEqual(disabledForce.stream_options, { include_usage: false, include_obfuscation: false });
});

test("original openai.Adaptor ConvertClaudeRequest / ConvertGeminiRequest / ConvertResponse JSON fields", () => {
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_OPENAI), true);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_AZURE), true);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_OPENROUTER), true);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_XINFERENCE), true);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_GEMINI), false);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_ANTHROPIC), false);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_ALI), false);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_TASK_PLUGIN), false);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_ADVANCED_CUSTOM), false);
  assert.equal(openaiFinishReasonToClaudeStopReason("stop"), "end_turn");
  assert.equal(openaiFinishReasonToClaudeStopReason("length"), "max_tokens");
  assert.equal(openaiFinishReasonToClaudeStopReason("tool_calls"), "tool_use");
  assert.equal(openaiFinishReasonToClaudeStopReason("content_filter"), "refusal");

  const claudeReq = {
    model: "customer-claude",
    max_tokens: 32,
    temperature: 0.2,
    stop_sequences: ["END"],
    stream: true,
    tools: [
      {
        name: "lookup",
        description: "find",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "YWE=" } },
        ],
      },
    ],
  };
  const openaiClaude = convertOpenAIAdaptorClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_OPENAI,
    originModelName: "customer-claude",
    upstreamModelName: "gpt-4o-mini",
    isStream: true,
  });
  assert.equal(openaiClaude.model, "gpt-4o-mini");
  assert.equal(openaiClaude.stream, true);
  assert.deepEqual(openaiClaude.stream_options, { include_usage: true });
  assert.equal(openaiClaude.stop, "END");
  assert.equal(openaiClaude.max_tokens, 32);
  const claudeMsgs = openaiClaude.messages as Record<string, unknown>[];
  assert.deepEqual(claudeMsgs[0].content, [
    { type: "text", text: "hi" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
  ]);
  assert.deepEqual(openaiClaude.tools, [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "find",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
  ]);

  const azureClaude = convertOpenAIAdaptorClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_AZURE,
    originModelName: "customer-claude",
    upstreamModelName: "gpt-4o",
    isStream: true,
  });
  assert.deepEqual(azureClaude.stream_options, { include_usage: true });

  const openRouterClaude = convertOpenAIAdaptorClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_OPENROUTER,
    originModelName: "customer-claude",
    upstreamModelName: "openai/gpt-4o-mini",
    isStream: true,
  });
  assert.equal(openRouterClaude.stream, true);
  assert.equal("stream_options" in openRouterClaude, false);

  const geminiReq = {
    contents: [{ role: "user", parts: [{ text: "hello gemini" }] }],
    generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 64 },
  };
  const openaiGemini = convertOpenAIAdaptorGeminiRequest(geminiReq, {
    channelType: CHANNEL_TYPE_OPENAI,
    originModelName: "gemini-client",
    upstreamModelName: "gpt-4o-mini",
    isStream: false,
  });
  assert.equal(openaiGemini.model, "gpt-4o-mini");
  assert.equal(openaiGemini.stream, false);
  assert.equal(openaiGemini.temperature, 0.4);
  assert.equal(openaiGemini.top_p, 0.9);
  assert.equal(openaiGemini.max_tokens, 64);
  assert.deepEqual(openaiGemini.messages, [{ role: "user", content: "hello gemini" }]);

  const claudeOut = openaiChatToClaudeResponse({
    id: "chatcmpl_1",
    model: "gpt-4o-mini",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "considering the request",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
            { id: "call_2", type: "function", function: { name: "broken", arguments: "{" } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  });
  assert.equal(claudeOut.type, "message");
  assert.equal(claudeOut.role, "assistant");
  assert.equal(claudeOut.id, "chatcmpl_1");
  assert.equal(claudeOut.model, "gpt-4o-mini");
  assert.equal(claudeOut.stop_reason, "tool_use");
  assert.deepEqual(claudeOut.content, [
    { type: "thinking", thinking: "considering the request" },
    { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    { type: "tool_use", id: "call_2", name: "broken", input: {} },
  ]);
  assert.equal((claudeOut.usage as { input_tokens: number }).input_tokens, 11);
  assert.equal((claudeOut.usage as { output_tokens: number }).output_tokens, 5);

  const citedOut = openaiChatToClaudeResponse({
    id: "chatcmpl_cite",
    model: "gpt-4o-mini",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "see this",
          annotations: [
            {
              type: "url_citation",
              url_citation: {
                url: "https://example.com/a",
                title: "Example",
                start_index: 0,
                end_index: 3,
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  });
  assert.deepEqual(citedOut.content, [
    {
      type: "text",
      text: "see this",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://example.com/a",
          title: "Example",
          cited_text: "see",
        },
      ],
    },
  ]);

  const geminiOut = openaiChatToGeminiResponse({
    id: "chatcmpl_2",
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "hello" },
      },
      {
        index: 1,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
  });
  const candidates = geminiOut.candidates as Record<string, unknown>[];
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].finishReason, "STOP");
  assert.deepEqual(candidates[0].safetyRatings, []);
  assert.deepEqual(candidates[0].content, { role: "model", parts: [{ text: "hello" }] });
  assert.equal(candidates[1].finishReason, "STOP");
  assert.deepEqual((candidates[1].content as { parts: unknown[] }).parts, [
    { functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } },
  ]);
  assert.deepEqual(geminiOut.usageMetadata, {
    promptTokenCount: 3,
    toolUsePromptTokenCount: 0,
    candidatesTokenCount: 7,
    totalTokenCount: 10,
    thoughtsTokenCount: 0,
    cachedContentTokenCount: 0,
  });

  const openaiCh = testChannel({ type: CHANNEL_TYPE_OPENAI, base_url: "https://api.openai.com", models: "gpt-4o-mini" });
  assert.equal(
    buildUpstream(openaiCh, "messages", "/v1/messages", "gpt-4o-mini", { model: "gpt-4o-mini" }, {}, "POST", {
      relayFormat: "claude",
    }).url,
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildUpstream(openaiCh, "gemini", "/v1beta/models/gpt-4o-mini:generateContent", "gpt-4o-mini", { contents: [] }, {}, "POST", {
      relayFormat: "gemini",
    }).url,
    "https://api.openai.com/v1/chat/completions",
  );

  const azureCh = testChannel({
    type: CHANNEL_TYPE_AZURE,
    key: "ak",
    base_url: "https://demo.openai.azure.com",
    other: "2025-04-01-preview",
    models: "gpt-4o",
  });
  assert.equal(
    buildUpstream(azureCh, "messages", "/v1/messages", "gpt-4o", { model: "gpt-4o" }, {}, "POST", { relayFormat: "claude" }).url,
    "https://demo.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-04-01-preview",
  );
});

test("original openai.Adaptor StreamResponseOpenAI2Claude / StreamResponseOpenAI2Gemini JSON fields", () => {
  const info = newClaudeStreamMeta();
  info.sendResponseCount = 1;
  const textResponses = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ delta: { content: "hello" } }],
    },
    info,
  );
  assert.equal(textResponses.length, 3);
  assert.equal(textResponses[0].type, "message_start");
  assert.equal(textResponses[1].type, "content_block_start");
  assert.equal(textResponses[1].index, 0);
  assert.equal(textResponses[2].type, "content_block_delta");

  info.sendResponseCount = 2;
  const thinkingResponses = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ delta: { reasoning_content: "thinking" } }],
    },
    info,
  );
  assert.equal(thinkingResponses.length, 3);
  assert.equal(thinkingResponses[0].type, "content_block_stop");
  assert.equal(thinkingResponses[0].index, 0);
  assert.equal(thinkingResponses[1].type, "content_block_start");
  assert.equal(thinkingResponses[1].index, 1);
  assert.equal((thinkingResponses[1].content_block as { type: string }).type, "thinking");
  assert.equal(thinkingResponses[2].type, "content_block_delta");

  info.sendResponseCount = 3;
  const toolResponses = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
          },
        },
      ],
    },
    info,
  );
  assert.equal(toolResponses.length, 3);
  assert.equal(toolResponses[0].type, "content_block_stop");
  assert.equal(toolResponses[0].index, 1);
  assert.equal(toolResponses[1].type, "content_block_start");
  assert.equal(toolResponses[1].index, 2);
  assert.equal((toolResponses[1].content_block as { type: string }).type, "tool_use");
  assert.equal(toolResponses[2].type, "content_block_delta");

  info.sendResponseCount = 4;
  const finishResponses = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
    info,
  );
  assert.equal(finishResponses.length, 3);
  assert.equal(finishResponses[0].type, "content_block_stop");
  assert.equal(finishResponses[0].index, 2);
  assert.equal(finishResponses[1].type, "message_delta");
  assert.equal((finishResponses[1].delta as { stop_reason: string }).stop_reason, "tool_use");
  const finishUsage = finishResponses[1].usage as {
    input_tokens: number;
    output_tokens: number;
    billing_usage: { openai_usage: { prompt_tokens: number; completion_tokens: number } };
  };
  assert.equal(finishUsage.input_tokens, 7);
  assert.equal(finishUsage.output_tokens, 3);
  assert.equal(finishUsage.billing_usage.openai_usage.prompt_tokens, 7);
  assert.equal(finishUsage.billing_usage.openai_usage.completion_tokens, 3);
  assert.equal(finishResponses[2].type, "message_stop");

  const firstFrame = newClaudeStreamMeta({ sendResponseCount: 1, estimatePromptTokens: 32 });
  const firstWithUsage = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ delta: { content: "hello" } }],
      usage: { prompt_tokens: 29, completion_tokens: 0, total_tokens: 29 },
    },
    firstFrame,
  );
  assert.equal(firstWithUsage[0].type, "message_start");
  assert.equal(((firstWithUsage[0].message as { usage: { input_tokens: number } }).usage).input_tokens, 29);

  const estimated = newClaudeStreamMeta({ sendResponseCount: 1, estimatePromptTokens: 32 });
  const firstEstimated = streamResponseOpenAI2Claude(
    { id: "chatcmpl_1", model: "gpt-test", choices: [{ delta: { content: "hello" } }] },
    estimated,
  );
  assert.equal(((firstEstimated[0].message as { usage: { input_tokens: number } }).usage).input_tokens, 32);
  estimated.sendResponseCount = 2;
  const corrected = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 29, completion_tokens: 4, total_tokens: 33 },
    },
    estimated,
  );
  const delta = corrected.find((ev) => ev.type === "message_delta");
  assert.ok(delta);
  assert.equal((delta?.usage as { input_tokens: number }).input_tokens, 29);
  assert.equal((delta?.usage as { output_tokens: number }).output_tokens, 4);

  const cacheInfo = newClaudeStreamMeta({ sendResponseCount: 1, estimatePromptTokens: 8 });
  streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ delta: { content: "hello" } }],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 0,
        total_tokens: 40,
        prompt_tokens_details: { cached_tokens: 20, cached_creation_tokens: 10 },
      },
    },
    cacheInfo,
  );
  cacheInfo.sendResponseCount = 2;
  const cacheFinish = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_1",
      model: "gpt-test",
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 29, completion_tokens: 4, total_tokens: 33 },
    },
    cacheInfo,
  );
  const cacheDelta = cacheFinish.find((ev) => ev.type === "message_delta");
  assert.ok(cacheDelta);
  const cacheUsage = cacheDelta?.usage as {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  assert.equal(cacheUsage.input_tokens, 29);
  assert.equal(cacheUsage.cache_read_input_tokens, 20);
  assert.equal(cacheUsage.cache_creation_input_tokens, 10);

  const geminiStream = streamResponseOpenAI2Gemini({
    choices: [
      {
        index: 1,
        finish_reason: "tool_calls",
        delta: { tool_calls: [{ type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
      },
    ],
    usage: { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 },
  });
  assert.ok(geminiStream);
  const geminiUsage = geminiStream?.usageMetadata as {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    billing_usage: { openai_usage: { prompt_tokens: number; completion_tokens: number } };
  };
  assert.equal(geminiUsage.promptTokenCount, 13);
  assert.equal(geminiUsage.candidatesTokenCount, 8);
  assert.equal(geminiUsage.totalTokenCount, 21);
  assert.equal(geminiUsage.billing_usage.openai_usage.prompt_tokens, 13);
  assert.equal(geminiUsage.billing_usage.openai_usage.completion_tokens, 8);
  const geminiCandidates = geminiStream?.candidates as Record<string, unknown>[];
  assert.equal(geminiCandidates[0].index, 1);
  assert.equal(geminiCandidates[0].finishReason, "STOP");
  assert.deepEqual((geminiCandidates[0].content as { parts: unknown[] }).parts, [
    { functionCall: { name: "lookup", args: { q: "x" } } },
  ]);
  assert.equal(streamResponseOpenAI2Gemini({ choices: [{ delta: {}, finish_reason: null }] }), null);

  const citeInfo = newClaudeStreamMeta();
  citeInfo.sendResponseCount = 1;
  const citedStream = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_cite",
      model: "gpt-test",
      choices: [
        {
          delta: {
            content: "see this",
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://example.com/a", title: "Example", cited_text: "see" },
              },
            ],
          },
        },
      ],
    },
    citeInfo,
  );
  const citeDelta = citedStream.find((ev) => (ev.delta as { type?: string } | undefined)?.type === "citations_delta");
  assert.ok(citeDelta);
  assert.equal(citeDelta?.type, "content_block_delta");
  assert.equal(citeDelta?.index, 0);
  assert.deepEqual((citeDelta?.delta as { citation: unknown }).citation, {
    type: "web_search_result_location",
    url: "https://example.com/a",
    title: "Example",
    cited_text: "see",
  });

  const annotOnly = newClaudeStreamMeta();
  annotOnly.sendResponseCount = 1;
  const annotOnlyStream = streamResponseOpenAI2Claude(
    {
      id: "chatcmpl_cite2",
      model: "gpt-test",
      choices: [
        {
          delta: {
            annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/b" } }],
          },
        },
      ],
    },
    annotOnly,
  );
  assert.equal(
    annotOnlyStream.some((ev) => ev.type === "content_block_start" && (ev.content_block as { type?: string })?.type === "text"),
    true,
  );
  const annotDelta = annotOnlyStream.find((ev) => (ev.delta as { type?: string } | undefined)?.type === "citations_delta");
  assert.deepEqual((annotDelta?.delta as { citation: unknown }).citation, {
    type: "web_search_result_location",
    url: "https://example.com/b",
  });

  const sse = [
    'data: {"id":"chatcmpl_1","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl_1","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const claudeSse = oaiChatSseToClaudeSse(sse, { estimatePromptTokens: 8 });
  assert.match(claudeSse.sse, /event: message_start/);
  assert.match(claudeSse.sse, /"type":"text_delta"/);
  assert.match(claudeSse.sse, /event: message_stop/);
  assert.equal((claudeSse.usageBody as { prompt_tokens: number }).prompt_tokens, 5);

  const geminiSse = oaiChatSseToGeminiSse(sse, { estimatePromptTokens: 8 });
  assert.match(geminiSse.sse, /"text":"hello"/);
  assert.match(geminiSse.sse, /"finishReason":"STOP"/);
  assert.match(geminiSse.sse, /"promptTokenCount":5/);
});

test("original SiliconFlow/Perplexity ConvertClaudeRequest delegates to openai.Adaptor JSON", () => {
  assert.equal(delegatesClaudeToOpenAIAdaptor(CHANNEL_TYPE_SILICONFLOW), true);
  assert.equal(delegatesClaudeToOpenAIAdaptor(CHANNEL_TYPE_PERPLEXITY), true);
  assert.equal(delegatesClaudeToOpenAIAdaptor(CHANNEL_TYPE_BAIDU_V2), true);
  assert.equal(delegatesClaudeToOpenAIAdaptor(CHANNEL_TYPE_OPENAI), false);
  assert.equal(usesOpenAIAdaptor(CHANNEL_TYPE_SILICONFLOW), false);

  const claudeReq = {
    model: "customer-claude",
    max_tokens: 32,
    stop_sequences: ["END"],
    stream: true,
    tools: [
      {
        name: "lookup",
        description: "find",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "YWE=" } },
        ],
      },
    ],
  };
  const sf = convertOpenAIAdaptorClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_SILICONFLOW,
    originModelName: "customer-claude",
    upstreamModelName: "Qwen/Qwen2-7B-Instruct",
    isStream: true,
  });
  assert.equal(sf.model, "Qwen/Qwen2-7B-Instruct");
  assert.equal(sf.stream, true);
  assert.equal("stream_options" in sf, false);
  assert.equal(sf.stop, "END");
  assert.deepEqual((sf.messages as Record<string, unknown>[])[0].content, [
    { type: "text", text: "hi" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
  ]);
  assert.deepEqual(sf.tools, [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "find",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
  ]);

  const pplx = convertOpenAIAdaptorClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_PERPLEXITY,
    originModelName: "customer-claude",
    upstreamModelName: "sonar",
    isStream: true,
  });
  assert.equal(pplx.model, "sonar");
  assert.equal(pplx.stream, true);
  assert.equal("stream_options" in pplx, false);
  assert.equal(Array.isArray(pplx.tools), true);

  const sfCh = testChannel({ type: CHANNEL_TYPE_SILICONFLOW, key: "sfk", base_url: "https://api.siliconflow.cn", models: "Qwen/Qwen2-7B-Instruct" });
  assert.equal(
    buildUpstream(sfCh, "messages", "/v1/messages", "Qwen/Qwen2-7B-Instruct", sf, {}, "POST", { relayFormat: "claude" }).url,
    "https://api.siliconflow.cn/v1/messages",
  );
  const pplxCh = testChannel({ type: CHANNEL_TYPE_PERPLEXITY, key: "pplx", base_url: "https://api.perplexity.ai", models: "sonar" });
  assert.equal(
    buildUpstream(pplxCh, "messages", "/v1/messages", "sonar", pplx, {}, "POST", { relayFormat: "claude" }).url,
    "https://api.perplexity.ai/chat/completions",
  );
  const baiduV2Ch = testChannel({ type: CHANNEL_TYPE_BAIDU_V2, key: "tok|app", base_url: "https://qianfan.baidubce.com", models: "ernie" });
  assert.throws(
    () => buildUpstream(baiduV2Ch, "messages", "/v1/messages", "ernie", {}, {}, "POST", { relayFormat: "claude" }),
    /unsupported relay mode/,
  );
});

test("original VolcEngine ConvertClaudeRequest special-plan vs openai.Adaptor JSON", () => {
  const claudeReq = {
    model: "customer-claude",
    max_tokens: 32,
    stop_sequences: ["END"],
    stream: true,
    tools: [
      {
        name: "lookup",
        description: "find",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "YWE=" } },
        ],
      },
    ],
  };
  const chat = convertVolcClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_VOLC,
    originModelName: "customer-claude",
    upstreamModelName: "doubao-pro",
    isStream: true,
    channelBase: "https://ark.cn-beijing.volces.com",
  });
  assert.equal(chat.model, "doubao-pro");
  assert.equal(chat.stream, true);
  assert.equal("stream_options" in chat, false);
  assert.equal(chat.stop, "END");
  assert.deepEqual((chat.messages as Record<string, unknown>[])[0].content, [
    { type: "text", text: "hi" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
  ]);
  assert.deepEqual(chat.tools, [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "find",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
  ]);

  const thinking = convertVolcClaudeRequest(
    { model: "deepseek-v3-thinking", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    {
      channelType: CHANNEL_TYPE_VOLC,
      originModelName: "deepseek-v3-thinking",
      upstreamModelName: "deepseek-v3-thinking",
    },
  );
  assert.equal(thinking.model, "deepseek-v3");
  assert.deepEqual(thinking.thinking, { type: "enabled" });

  const special = convertVolcClaudeRequest(claudeReq, {
    channelType: CHANNEL_TYPE_VOLC,
    originModelName: "customer-claude",
    upstreamModelName: "doubao-pro",
    isStream: true,
    channelBase: "doubao-coding-plan",
  });
  assert.equal(special.model, "customer-claude");
  assert.equal(special.max_tokens, 32);
  assert.equal(Array.isArray(special.messages), true);
  assert.equal(Array.isArray((special.messages as Record<string, unknown>[])[0].content), true);
  assert.equal(((special.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[1].type, "image");
  assert.equal("tools" in special, true);
  assert.equal((special.tools as { name: string }[])[0].name, "lookup");
  assert.equal("function" in (special.tools as Record<string, unknown>[])[0], false);
});

test("original Moonshot/MiniMax/DeepSeek ConvertClaudeRequest uses claude.Adaptor JSON", () => {
  assert.equal(usesClaudeAdaptorForClaudeRequest(CHANNEL_TYPE_MOONSHOT), true);
  assert.equal(usesClaudeAdaptorForClaudeRequest(CHANNEL_TYPE_MINIMAX), true);
  assert.equal(usesClaudeAdaptorForClaudeRequest(CHANNEL_TYPE_DEEPSEEK), true);
  assert.equal(usesClaudeAdaptorForClaudeRequest(CHANNEL_TYPE_ZHIPU_V4), true);
  assert.equal(usesClaudeAdaptorForClaudeRequest(CHANNEL_TYPE_VOLC), false);

  const claudeReq = {
    model: "kimi-k2.5",
    max_tokens: 32,
    tools: [
      {
        name: "lookup",
        description: "find",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "YWE=" } },
        ],
      },
    ],
  };
  const moonshot = convertClaudeRequest(claudeReq, {
    originModelName: "kimi-k2.5",
    upstreamModelName: "kimi-k2.5",
  });
  assert.equal(moonshot.max_tokens, 32);
  assert.equal(((moonshot.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[1].type, "image");
  assert.equal((moonshot.tools as { name: string }[])[0].name, "lookup");
  assert.equal("function" in (moonshot.tools as Record<string, unknown>[])[0], false);

  const dsMax = convertDeepSeekClaudeRequest(
    { model: "deepseek-v4-pro-max", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    { originModelName: "deepseek-v4-pro-max", upstreamModelName: "deepseek-v4-pro-max" },
  );
  assert.equal(dsMax.model, "deepseek-v4-pro");
  assert.deepEqual(dsMax.thinking, { type: "enabled" });
  assert.deepEqual(dsMax.output_config, { effort: "max" });

  const dsNone = convertDeepSeekClaudeRequest(
    { model: "deepseek-v4-flash-none", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    { originModelName: "deepseek-v4-flash-none", upstreamModelName: "deepseek-v4-flash-none" },
  );
  assert.equal(dsNone.model, "deepseek-v4-flash");
  assert.deepEqual(dsNone.thinking, { type: "disabled" });
  assert.equal("output_config" in dsNone, false);

  const moonshotCh = testChannel({ type: CHANNEL_TYPE_MOONSHOT, key: "mk", base_url: "", models: "kimi-k2.5" });
  assert.equal(
    buildUpstream(moonshotCh, "messages", "/v1/messages", "kimi-k2.5", moonshot, {}, "POST", { relayFormat: "claude" }).url,
    "https://api.moonshot.cn/anthropic/v1/messages",
  );
  const kimiPlan = testChannel({ type: CHANNEL_TYPE_MOONSHOT, key: "mk", base_url: "kimi-coding-plan", models: "kimi-k2.5" });
  assert.equal(
    buildUpstream(kimiPlan, "messages", "/v1/messages", "kimi-k2.5", moonshot, {}, "POST", { relayFormat: "claude" }).url,
    "https://api.kimi.com/coding/v1/messages",
  );
  assert.equal(
    buildUpstream(kimiPlan, "chat", "/v1/chat/completions", "kimi-k2.5", { model: "kimi-k2.5" }).url,
    "https://api.kimi.com/coding/v1/chat/completions",
  );
});

test("original ConvertOpenAIRequest sampling, suffixes, OpenRouter, Moonshot, and Ali JSON", () => {
  const settings = { thinkingModelBlacklist: [] as string[], effortTailModelIDs: ["gpt-5.1-codex-max"] };
  const sampling = { temperature: 0.2, top_p: 0.8, logprobs: true, top_logprobs: 5 };
  const messages = [
    { role: "system", content: "first instruction" },
    { role: "system", content: "second instruction" },
    { role: "user", content: "hi" },
  ];
  const convert = (model: string, extra: Record<string, unknown> = {}, mapping?: Record<string, string>, type = CHANNEL_TYPE_OPENAI) => {
    const origin = model;
    const mapped = mapping ? mapModel(JSON.stringify(mapping), origin) : origin;
    return JSON.parse(
      JSON.stringify(
        convertOpenAIRequest(
          { model, messages, ...sampling, ...extra },
          { channelType: type, originModelName: origin, upstreamModelName: mapped, settings },
        ),
      ),
    ) as Record<string, unknown>;
  };

  const gpt51 = convert("gpt-5.1", { reasoning_effort: "none" });
  assert.equal(gpt51.model, "gpt-5.1");
  assert.equal((gpt51.messages as { role: string }[])[0].role, "developer");
  assert.equal((gpt51.messages as { role: string }[])[1].role, "system");
  assert.equal(gpt51.reasoning_effort, "none");
  assert.equal(gpt51.temperature, 0.2);

  const gpt52 = convert("gpt-5.2");
  assert.equal((gpt52.messages as { role: string }[])[0].role, "developer");
  assert.equal(gpt52.temperature, 0.2);
  assert.equal("reasoning_effort" in gpt52, false);

  const gpt54 = convert("gpt-5.4", { reasoning_effort: "high" });
  assert.equal(gpt54.reasoning_effort, "high");
  assert.equal("temperature" in gpt54, false);
  assert.equal("top_p" in gpt54, false);

  const suffix = convert("gpt-6-astra-high");
  assert.equal(suffix.model, "gpt-6-astra");
  assert.equal(suffix.reasoning_effort, "high");
  assert.equal("temperature" in suffix, false);

  const noneSuffix = convert("gpt-5.2-none");
  assert.equal(noneSuffix.model, "gpt-5.2");
  assert.equal(noneSuffix.reasoning_effort, "none");
  assert.equal(noneSuffix.temperature, 0.2);

  const modifier = convert("gpt-5.2@thinking:off", { reasoning_effort: "high" });
  assert.equal(modifier.model, "gpt-5.2");
  assert.equal(modifier.reasoning_effort, "none");
  assert.equal(modifier.temperature, 0.2);

  const mapped = convert("customer-model@thinking:off", {}, { "customer-model": "gpt-5.2@effort:high" });
  assert.equal(mapped.model, "gpt-5.2");
  assert.equal(mapped.reasoning_effort, "high");
  assert.equal("temperature" in mapped, false);

  const nested = convert("gpt-5.2", { reasoning: { enabled: false } });
  assert.equal(nested.reasoning_effort, "none");
  assert.equal("reasoning" in nested, false);
  assert.equal(nested.temperature, 0.2);

  const o1 = convert("o1-mini");
  assert.equal((o1.messages as { role: string }[])[0].role, "system");
  assert.equal("temperature" in o1, false);
  assert.equal(o1.top_p, 0.8);

  const gpt4 = convert("gpt-4.1");
  assert.equal((gpt4.messages as { role: string }[])[0].role, "system");
  assert.equal(gpt4.temperature, 0.2);

  const codex = convert("gpt-5.1-codex-max");
  assert.equal(codex.model, "gpt-5.1-codex-max");
  assert.equal("temperature" in codex, false);

  const openrouter = JSON.parse(
    JSON.stringify(
      convertOpenAIRequest(
        { model: "gpt-5.2-high", messages: [{ role: "user", content: "hi" }] },
        { channelType: CHANNEL_TYPE_OPENROUTER, originModelName: "gpt-5.2-high", upstreamModelName: "gpt-5.2-high", settings },
      ),
    ),
  ) as Record<string, unknown>;
  assert.equal(openrouter.model, "gpt-5.2");
  assert.equal("reasoning_effort" in openrouter, false);
  assert.deepEqual(openrouter.usage, { include: true });
  assert.deepEqual(openrouter.reasoning, { enabled: true, effort: "high" });

  const moonshotForced = convertOpenAIRequest(
    { model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }], temperature: 0.7 },
    { channelType: CHANNEL_TYPE_MOONSHOT, originModelName: "kimi-k2.6", upstreamModelName: "kimi-k2.6" },
  );
  assert.equal(moonshotForced.temperature, 1.0);
  const moonshotOmitted = convertOpenAIRequest(
    { model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_MOONSHOT, originModelName: "kimi-k2.6", upstreamModelName: "kimi-k2.6" },
  );
  assert.equal("temperature" in moonshotOmitted, false);
  const moonshotOther = convertOpenAIRequest(
    { model: "kimi-k2.5", messages: [{ role: "user", content: "hi" }], temperature: 0.7 },
    { channelType: CHANNEL_TYPE_MOONSHOT, originModelName: "kimi-k2.5", upstreamModelName: "kimi-k2.5" },
  );
  assert.equal(moonshotOther.temperature, 0.7);

  const aliKeep = convertOpenAIRequest(
    { model: "qwen-plus", enable_thinking: true, thinking_budget: 128, top_p: 1 },
    { channelType: CHANNEL_TYPE_ALI, originModelName: "qwen-plus", upstreamModelName: "qwen-plus" },
  );
  assert.equal(aliKeep.thinking_budget, 128);
  assert.equal(aliKeep.top_p, 0.99);
  const aliDrop = convertOpenAIRequest(
    { model: "qwen-plus", enable_thinking: true, thinking_budget: 128 },
    { channelType: CHANNEL_TYPE_ALI, originModelName: "qwen-plus", upstreamModelName: "deepseek-r1" },
  );
  assert.equal("thinking_budget" in aliDrop, false);
  assert.equal(aliDrop.enable_thinking, true);

  let threw = false;
  try {
    convertOpenAIRequest(
      { model: "m@thinkin:on", messages: [{ role: "user", content: "hi" }] },
      { channelType: CHANNEL_TYPE_OPENAI, originModelName: "m@thinkin:on", upstreamModelName: "m@thinkin:on", settings },
    );
  } catch (err) {
    threw = true;
    assert.equal(isClientError(err), true);
    assert.match(String(err), /unsupported model modifier "thinkin"/);
    assert.match(String(err), /re:/);
  }
  assert.equal(threw, true);

  const responses = convertOpenAIResponsesRequest(
    {
      model: "gpt-6-astra",
      input: "hi",
      max_output_tokens: 100,
      temperature: 0.2,
      top_p: 0.8,
      top_logprobs: 5,
      include: ["message.output_text.logprobs"],
      reasoning: { effort: "high" },
    },
    { channelType: CHANNEL_TYPE_OPENAI, originModelName: "gpt-6-astra", upstreamModelName: "gpt-6-astra", settings },
  );
  assert.equal(responses.model, "gpt-6-astra");
  assert.deepEqual(responses.reasoning, { effort: "high" });
  assert.equal(responses.max_output_tokens, 100);
});

test("original ConvertOpenAIRequest token limit pointer semantics", () => {
  const settings = { thinkingModelBlacklist: [] as string[], effortTailModelIDs: ["gpt-5.1-codex-max"] };
  for (const modelName of ["gpt-5", "o3-mini", "gpt-6-astra"]) {
    const run = (input: Record<string, unknown>) =>
      JSON.parse(
        JSON.stringify(
          convertOpenAIRequest(
            { model: modelName, messages: [{ role: "user", content: "hi" }], ...input },
            { channelType: CHANNEL_TYPE_OPENAI, originModelName: modelName, upstreamModelName: modelName, settings },
          ),
        ),
      ) as Record<string, unknown>;
    const omitted = run({});
    assert.equal("max_tokens" in omitted, false);
    assert.equal("max_completion_tokens" in omitted, false);
    const legacy = run({ max_tokens: 100 });
    assert.equal(legacy.max_completion_tokens, 100);
    assert.equal("max_tokens" in legacy, false);
    const both = run({ max_tokens: 100, max_completion_tokens: 50 });
    assert.equal(both.max_tokens, 100);
    assert.equal(both.max_completion_tokens, 50);
    const zeroCompletion = run({ max_tokens: 100, max_completion_tokens: 0 });
    assert.equal(zeroCompletion.max_completion_tokens, 100);
    assert.equal("max_tokens" in zeroCompletion, false);
    const bothZero = run({ max_tokens: 0, max_completion_tokens: 0 });
    assert.equal(bothZero.max_tokens, 0);
    assert.equal(bothZero.max_completion_tokens, 0);
  }
});

test("original OpenAI→Claude ConvertRequest golden JSON fields", () => {
  const out = JSON.parse(
    JSON.stringify(
      convertOpenAIChatToClaude(
        {
          model: "gpt-test",
          max_tokens: 1024,
          stream: true,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            {
              role: "user",
              content: [
                { type: "text", text: "What is in this image?" },
                { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "high" } },
              ],
            },
            {
              role: "assistant",
              tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
            },
            { role: "tool", tool_call_id: "call_abc", content: "15 degrees" },
            { role: "user", content: "Summarize." },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather by city",
                parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              },
            },
          ],
          tool_choice: "auto",
        },
        {
          originModelName: "gpt-test",
          upstreamModelName: "gpt-test",
          resolveMedia: () => ({ data: "aGVsbG8=", mime: "image/png" }),
        },
      ),
    ),
  ) as Record<string, unknown>;
  assert.equal(out.model, "gpt-test");
  assert.deepEqual(out.system, [{ type: "text", text: "You are a helpful assistant." }]);
  assert.equal(out.max_tokens, 1024);
  assert.equal(out.stream, true);
  assert.deepEqual(out.tool_choice, { type: "auto" });
  const tools = out.tools as { name: string; description: string; input_schema: Record<string, unknown> }[];
  assert.equal(tools[0].name, "get_weather");
  assert.equal(tools[0].description, "Get weather by city");
  assert.equal(tools[0].input_schema.type, "object");
  assert.deepEqual(tools[0].input_schema.required, ["city"]);
  const messages = out.messages as { role: string; content: unknown }[];
  assert.equal(messages.length, 4);
  const user0 = messages[0].content as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[];
  assert.equal(user0[0].type, "text");
  assert.equal(user0[0].text, "What is in this image?");
  assert.equal(user0[1].type, "image");
  assert.deepEqual(user0[1].source, { type: "base64", media_type: "image/png", data: "aGVsbG8=" });
  const assistant = messages[1].content as { type: string; text?: string; id?: string; name?: string; input?: { city: string } }[];
  assert.equal(assistant[0].type, "text");
  assert.equal(assistant[0].text, "...");
  assert.equal(assistant[1].type, "tool_use");
  assert.equal(assistant[1].id, "call_abc");
  assert.equal(assistant[1].name, "get_weather");
  assert.deepEqual(assistant[1].input, { city: "Paris" });
  const toolResult = messages[2].content as { type: string; content: unknown; tool_use_id: string }[];
  assert.equal(messages[2].role, "user");
  assert.equal(toolResult[0].type, "tool_result");
  assert.equal(toolResult[0].tool_use_id, "call_abc");
  assert.equal(toolResult[0].content, "15 degrees");
  assert.deepEqual(messages[3], { role: "user", content: "Summarize." });
});

test("original Claude ConvertOpenAIRequest injects default max_tokens and thinking adapter JSON", () => {
  const missing = convertOpenAIRequest(
    { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_ANTHROPIC, originModelName: "claude-3-5-sonnet", upstreamModelName: "claude-3-5-sonnet" },
  );
  assert.equal(missing.max_tokens, 8192);
  const thinking = convertOpenAIRequest(
    { model: "claude-3-7-sonnet-thinking", messages: [{ role: "user", content: "hi" }], max_tokens: 4096 },
    { channelType: CHANNEL_TYPE_ANTHROPIC, originModelName: "claude-3-7-sonnet-thinking", upstreamModelName: "claude-3-7-sonnet-thinking" },
  );
  assert.equal(thinking.model, "claude-3-7-sonnet");
  const rendered = thinking.thinking as { type: string; budget_tokens: number };
  assert.equal(rendered.type, "enabled");
  assert.equal(rendered.budget_tokens, Math.max(Math.trunc((4096 * 80) / 100), 1024));
  const native = convertClaudeRequest({ model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }], max_tokens: 0 });
  assert.equal(native.max_tokens, 8192);
});

test("original OpenAI→Gemini ConvertRequest JSON fields", () => {
  const out = convertOpenAIRequest(
    {
      model: "gemini-2.0-flash",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ],
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 1024,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather by city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
      tool_choice: "auto",
    },
    { channelType: CHANNEL_TYPE_GEMINI, originModelName: "gemini-2.0-flash", upstreamModelName: "gemini-2.0-flash" },
  );
  assert.deepEqual(out.systemInstruction, { parts: [{ text: "You are a helpful assistant." }] });
  const contents = out.contents as { role: string; parts: { text: string }[] }[];
  assert.equal(contents[0].role, "user");
  assert.equal(contents[0].parts[0].text, "hi");
  const gc = out.generationConfig as { temperature: number; topP: number; maxOutputTokens: number };
  assert.equal(gc.temperature, 0.2);
  assert.equal(gc.topP, 0.8);
  assert.equal(gc.maxOutputTokens, 1024);
  const tools = out.tools as { functionDeclarations: { name: string }[] }[];
  assert.equal(tools[0].functionDeclarations[0].name, "get_weather");
  assert.deepEqual(out.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
});

function testChannel(partial: Partial<ChannelRow>): ChannelRow {
  return {
    id: 1,
    type: 1,
    key: "k",
    status: 1,
    name: "ch",
    weight: 1,
    created_time: 0,
    test_time: 0,
    response_time: 0,
    base_url: "",
    other: "",
    models: "m",
    group: "default",
    used_quota: 0,
    model_mapping: "",
    status_code_mapping: "",
    priority: 0,
    auto_ban: 1,
    tag: "",
    header_override: "",
    param_override: "",
    remark: "",
    settings: "",
    openai_organization: "",
    test_model: "",
    ...partial,
  };
}

test("original AWS ConvertOpenAIRequest Nova JSON and Converse URL sprintf order", () => {
  const nova = convertOpenAIRequest(
    {
      model: "nova-lite-v1:0",
      messages: [{ role: "user", content: "hi nova" }],
      max_tokens: 32,
      temperature: 0.4,
      top_p: 0.9,
      stop: ["END"],
    },
    { channelType: CHANNEL_TYPE_AWS, originModelName: "nova-lite-v1:0", upstreamModelName: "nova-lite-v1:0" },
  );
  assert.equal(nova.schemaVersion, "messages-v1");
  assert.deepEqual(nova.messages, [{ role: "user", content: [{ text: "hi nova" }] }]);
  assert.deepEqual(nova.inferenceConfig, { maxTokens: 32, temperature: 0.4, topP: 0.9, stopSequences: ["END"] });
  assert.equal("model" in nova, false);
  assert.equal("anthropic_version" in nova, false);

  const omitted = convertOpenAIRequest(
    { model: "nova-lite-v1:0", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_AWS, originModelName: "nova-lite-v1:0", upstreamModelName: "nova-lite-v1:0" },
  );
  assert.equal("inferenceConfig" in omitted, false);

  const claude = convertOpenAIRequest(
    {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    },
    { channelType: CHANNEL_TYPE_AWS, originModelName: "claude-3-5-sonnet-20241022", upstreamModelName: "claude-3-5-sonnet-20241022" },
  );
  assert.equal("schemaVersion" in claude, false);
  assert.equal(claude.model, "claude-3-5-sonnet-20241022");
  assert.deepEqual(claude.system, [{ type: "text", text: "sys" }]);
  assert.equal(claude.max_tokens, 8192);
  assert.equal("anthropic_version" in claude, false);

  const aws = testChannel({
    type: CHANNEL_TYPE_AWS,
    key: "ak|us-east-1",
    settings: JSON.stringify({ aws_key_type: "api_key" }),
    models: "nova-lite-v1:0,claude-3-5-sonnet-20241022",
  });
  const novaUrl = buildUpstream(aws, "chat", "/v1/chat/completions", "nova-lite-v1:0", nova);
  assert.equal(novaUrl.url, "https://bedrock-runtime.amazon.nova-lite-v1:0.amazonaws.com/model/us-east-1/converse");
  assert.equal(novaUrl.headers.authorization, "Bearer ak|us-east-1");
  const claudeUrl = buildUpstream(aws, "chat", "/v1/chat/completions", "claude-3-5-sonnet-20241022", claude);
  assert.equal(
    claudeUrl.url,
    "https://bedrock-runtime.anthropic.claude-3-5-sonnet-20241022-v2:0.amazonaws.com/model/us-east-1/converse",
  );

  const aksk = testChannel({
    type: CHANNEL_TYPE_AWS,
    key: "AKID|secret|us-east-1",
    settings: JSON.stringify({ aws_key_type: "ak_sk" }),
    models: "nova-lite-v1:0,claude-3-5-sonnet-20241022",
  });
  const akskNova = buildUpstream(aksk, "chat", "/v1/chat/completions", "nova-lite-v1:0", nova);
  assert.equal(akskNova.url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-lite-v1%3A0/invoke");
  assert.equal((akskNova.body as { schemaVersion?: string }).schemaVersion, "messages-v1");
  const akskClaude = buildUpstream(aksk, "chat", "/v1/chat/completions", "claude-3-5-sonnet-20241022", claude, {
    "anthropic-beta": "computer-use-2025-01-24",
  });
  assert.equal(
    akskClaude.url,
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
  );
  const akskClaudeBody = akskClaude.body as Record<string, unknown>;
  assert.equal(akskClaudeBody.anthropic_version, "bedrock-2023-05-31");
  assert.deepEqual(akskClaudeBody.anthropic_beta, ["computer-use-2025-01-24"]);
  assert.equal("model" in akskClaudeBody, false);
  assert.equal("stream" in akskClaudeBody, false);
  const aksk2 = testChannel({
    type: CHANNEL_TYPE_AWS,
    key: "bedrock-token|us-east-1",
    settings: JSON.stringify({ aws_key_type: "ak_sk" }),
    models: "claude-3-5-sonnet-20241022",
  });
  const akskBearer = buildUpstream(aksk2, "chat", "/v1/chat/completions", "claude-3-5-sonnet-20241022", claude);
  assert.equal(akskBearer.headers.authorization, "Bearer bedrock-token");
  assert.equal(
    akskBearer.url,
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
  );
  assert.throws(
    () =>
      buildUpstream(
        testChannel({ type: CHANNEL_TYPE_AWS, key: "onlyone", settings: JSON.stringify({ aws_key_type: "ak_sk" }) }),
        "chat",
        "/v1/chat/completions",
        "claude-3-5-sonnet-20241022",
        claude,
      ),
    /invalid aws secret key/,
  );

  const mapped = openaiFromNovaResponse(
    {
      output: { message: { content: [{ text: "hello nova" }] } },
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    },
    "nova-lite-v1:0",
    { id: "chatcmpl-nova", created: 1 },
  );
  assert.equal(mapped.object, "chat.completion");
  assert.equal(mapped.model, "nova-lite-v1:0");
  assert.equal((mapped.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello nova");
  assert.equal((mapped.choices as { finish_reason: string }[])[0].finish_reason, "stop");
  assert.equal(usageFromOpenAI(mapped).prompt, 4);
  assert.equal(usageFromOpenAI(mapped).completion, 6);
  assert.equal(usageFromOpenAI(mapped).total, 10);
});

test("original Vertex ConvertOpenAIRequest Claude wrap, Gemini id strip, imagen, and publisher URLs", () => {
  const claude = convertOpenAIRequest(
    {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 1024,
    },
    { channelType: CHANNEL_TYPE_VERTEX, originModelName: "claude-3-5-sonnet-20241022", upstreamModelName: "claude-3-5-sonnet-20241022" },
  );
  assert.equal(claude.anthropic_version, "vertex-2023-10-16");
  assert.equal("model" in claude, false);
  assert.deepEqual(claude.system, [{ type: "text", text: "sys" }]);
  assert.equal(claude.max_tokens, 1024);
  assert.deepEqual(claude.messages, [{ role: "user", content: "hi" }]);

  const gemini = convertOpenAIRequest(
    {
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "15 degrees" },
      ],
    },
    { channelType: CHANNEL_TYPE_VERTEX, originModelName: "gemini-2.0-flash", upstreamModelName: "gemini-2.0-flash" },
  );
  const contents = gemini.contents as { role: string; parts: Record<string, unknown>[] }[];
  const modelParts = contents.find((c) => c.role === "model")?.parts || [];
  const call = modelParts.find((p) => p.functionCall) as { functionCall: { id?: string; name: string } };
  assert.equal(call.functionCall.name, "get_weather");
  assert.equal("id" in call.functionCall, false);
  const userParts = contents.find((c) => c.role === "user" && c.parts.some((p) => p.functionResponse))?.parts || [];
  const resp = userParts.find((p) => p.functionResponse) as { functionResponse: { id?: string; name: string } };
  assert.equal(resp.functionResponse.name, "get_weather");
  assert.equal("id" in resp.functionResponse, false);

  const keepIds = convertOpenAIRequest(
    {
      model: "gemini-2.0-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "15 degrees" },
      ],
    },
    {
      channelType: CHANNEL_TYPE_VERTEX,
      originModelName: "gemini-2.0-flash",
      upstreamModelName: "gemini-2.0-flash",
      settings: { removeFunctionResponseIdEnabled: false },
    },
  );
  const keepContents = keepIds.contents as { role: string; parts: Record<string, unknown>[] }[];
  const keepCall = keepContents.find((c) => c.role === "model")?.parts.find((p) => p.functionCall) as { functionCall: { id?: string } };
  assert.equal(keepCall.functionCall.id, "call_1");

  const imagen = convertOpenAIRequest(
    {
      model: "imagen-3.0-generate-001",
      messages: [{ role: "user", content: "a cat" }],
      n: 2,
      size: "1792x1024",
      extra_body: { aspectRatio: "16:9" },
    },
    { channelType: CHANNEL_TYPE_VERTEX, originModelName: "imagen-3.0-generate-001", upstreamModelName: "imagen-3.0-generate-001" },
  );
  assert.deepEqual(imagen.instances, [{ prompt: "a cat" }]);
  const parameters = imagen.parameters as { sampleCount: number; aspectRatio: string; personGeneration: string };
  assert.equal(parameters.sampleCount, 2);
  assert.equal(parameters.aspectRatio, "16:9");
  assert.equal(parameters.personGeneration, "allow_adult");

  const vertex = testChannel({
    type: CHANNEL_TYPE_VERTEX,
    key: "vkey",
    other: JSON.stringify({ default: "us-central1" }),
    settings: JSON.stringify({ vertex_key_type: "api_key" }),
    models: "claude-3-5-sonnet-20241022,gemini-2.0-flash,imagen-3.0-generate-001,meta/llama3-405b-instruct-maas",
  });
  const claudeUrl = buildUpstream(vertex, "chat", "/v1/chat/completions", "claude-3-5-sonnet-20241022", claude);
  assert.equal(
    claudeUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict?key=vkey",
  );
  const geminiUrl = buildUpstream(vertex, "chat", "/v1/chat/completions", "gemini-2.0-flash", gemini);
  assert.equal(
    geminiUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash:generateContent?key=vkey",
  );
  const imagenUrl = buildUpstream(vertex, "chat", "/v1/chat/completions", "imagen-3.0-generate-001", imagen);
  assert.equal(
    imagenUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/imagen-3.0-generate-001:predict?key=vkey",
  );
  const jsonCreds = testChannel({
    type: CHANNEL_TYPE_VERTEX,
    key: JSON.stringify({ project_id: "proj-1" }),
    other: JSON.stringify({ default: "us-east1" }),
    models: "claude-3-5-sonnet-20241022",
  });
  const jsonUrl = buildUpstream(jsonCreds, "chat", "/v1/chat/completions", "claude-3-5-sonnet-20241022", claude);
  assert.equal(
    jsonUrl.url,
    "https://us-east1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-east1/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict",
  );
  assert.equal(jsonUrl.headers["x-goog-user-project"], "proj-1");

  let decodeThrew = false;
  try {
    buildUpstream(
      testChannel({
        type: CHANNEL_TYPE_VERTEX,
        key: "not-json",
        other: JSON.stringify({ default: "us-central1" }),
        models: "claude-3-5-sonnet-20241022",
      }),
      "chat",
      "/v1/chat/completions",
      "claude-3-5-sonnet-20241022",
      claude,
    );
  } catch (err) {
    decodeThrew = true;
    assert.match(String(err), /failed to decode credentials file:/);
  }
  assert.equal(decodeThrew, true);

  let threw = false;
  try {
    buildUpstream(
      testChannel({
        type: CHANNEL_TYPE_VERTEX,
        key: "vkey",
        other: JSON.stringify({ default: "us-central1" }),
        settings: JSON.stringify({ vertex_key_type: "api_key" }),
        models: "meta/llama3-405b-instruct-maas",
      }),
      "chat",
      "/v1/chat/completions",
      "meta/llama3-405b-instruct-maas",
      { model: "meta/llama3-405b-instruct-maas", messages: [{ role: "user", content: "hi" }] },
    );
  } catch (err) {
    threw = true;
    assert.equal(String(err), "Error: unsupported request mode");
  }
  assert.equal(threw, true);

  const imageJson = openaiFromImagenResponse(
    {
      predictions: [
        { bytesBase64Encoded: "YWE=", raiFilteredReason: "" },
        { bytesBase64Encoded: "YmI=", raiFilteredReason: "blocked" },
      ],
    },
    { created: 9 },
  );
  assert.equal(imageJson.created, 9);
  assert.deepEqual(imageJson.data, [{ url: "", b64_json: "YWE=", revised_prompt: "" }]);
  assert.equal(imagenUsage(1).prompt, VERTEX_IMAGE_TOKENS);
  assert.equal(imagenUsage(1).completion, 0);
  assert.equal(imagenUsage(1).total, VERTEX_IMAGE_TOKENS);
  assert.throws(() => openaiFromImagenResponse({ predictions: [] }), /no images generated/);
  assert.throws(() => openaiFromImagenResponse({}), /no images generated/);
});

test("original Vertex ConvertClaudeRequest always wraps Vertex Claude JSON", () => {
  assert.equal(VERTEX_ANTHROPIC_VERSION, "vertex-2023-10-16");

  const claudeBody = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    system: "You are a helpful assistant.",
    temperature: 0.2,
    top_p: 0.9,
    top_k: 20,
    stop_sequences: ["END"],
    thinking: { type: "enabled", budget_tokens: 1024 },
    tools: [
      {
        name: "lookup",
        description: "Lookup data",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' }],
      },
    ],
  };

  const claude = convertVertexClaudeRequest(claudeBody, {
    originModelName: "claude-3-5-sonnet-20241022",
    upstreamModelName: "claude-3-5-sonnet-20241022",
  });
  assert.equal(claude.anthropic_version, "vertex-2023-10-16");
  assert.equal("model" in claude, false);
  assert.equal("contents" in claude, false);
  assert.equal(claude.system, "You are a helpful assistant.");
  assert.equal(claude.max_tokens, 1024);
  assert.equal(claude.temperature, 0.2);
  assert.equal(claude.top_p, 0.9);
  assert.equal(claude.top_k, 20);
  assert.deepEqual(claude.stop_sequences, ["END"]);
  assert.deepEqual(claude.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal((claude.tools as { name: string }[])[0].name, "lookup");
  assert.deepEqual(claude.tool_choice, { type: "auto" });
  const claudeMessages = claude.messages as { role: string; content: { type: string }[] }[];
  assert.equal(claudeMessages[0].content[1].type, "image");
  assert.equal(claudeMessages[1].content[0].type, "tool_use");
  assert.equal((claudeMessages[1].content[0] as { type: string; id?: string }).id, "toolu_1");

  const geminiNamed = convertVertexClaudeRequest(
    {
      model: "gemini-2.0-flash",
      max_tokens: 1024,
      system: "You are a helpful assistant.",
      tools: [
        {
          name: "lookup",
          description: "Lookup data",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
    },
    { originModelName: "gemini-2.0-flash", upstreamModelName: "gemini-2.0-flash" },
  );
  assert.equal(geminiNamed.anthropic_version, "vertex-2023-10-16");
  assert.equal("model" in geminiNamed, false);
  assert.equal("contents" in geminiNamed, false);
  assert.equal("generationConfig" in geminiNamed, false);
  assert.equal("systemInstruction" in geminiNamed, false);
  assert.equal(geminiNamed.system, "You are a helpful assistant.");
  assert.equal(geminiNamed.max_tokens, 1024);
  assert.equal((geminiNamed.tools as { name: string }[])[0].name, "lookup");
  const geminiMessages = geminiNamed.messages as { role: string; content: { type: string }[] }[];
  assert.equal(geminiMessages[0].content[0].type, "text");
  assert.equal(geminiMessages[0].content[1].type, "image");

  const llama = convertVertexClaudeRequest(
    { model: "meta/llama3-405b-instruct-maas", messages: [{ role: "user", content: "hi" }] },
    { originModelName: "meta/llama3-405b-instruct-maas", upstreamModelName: "meta/llama3-405b-instruct-maas" },
  );
  assert.equal(llama.anthropic_version, "vertex-2023-10-16");
  assert.equal("model" in llama, false);
  assert.equal(llama.max_tokens, 8192);
  assert.deepEqual(llama.messages, [{ role: "user", content: "hi" }]);

  const inbound = geminiResponseToClaudeMessages(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { text: "hello from gemini" },
              { functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
    },
    "gemini-2.0-flash",
  );
  assert.equal(inbound.type, "message");
  assert.equal(inbound.role, "assistant");
  const inboundBlocks = inbound.content as { type: string; text?: string; name?: string }[];
  assert.ok(inboundBlocks.some((block) => block.type === "text" && block.text === "hello from gemini"));
  assert.ok(inboundBlocks.some((block) => block.type === "tool_use" && block.name === "lookup"));

  const vertex = testChannel({
    type: CHANNEL_TYPE_VERTEX,
    key: "vkey",
    other: JSON.stringify({ default: "us-central1" }),
    settings: JSON.stringify({ vertex_key_type: "api_key" }),
    models: "claude-3-5-sonnet-20241022,gemini-2.0-flash",
  });
  const claudeUrl = buildUpstream(vertex, "messages", "/v1/messages", "claude-3-5-sonnet-20241022", claude);
  assert.equal(
    claudeUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict?key=vkey",
  );
  const geminiUrl = buildUpstream(vertex, "messages", "/v1/messages", "gemini-2.0-flash", geminiNamed);
  assert.equal(
    geminiUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash:generateContent?key=vkey",
  );
  const geminiStreamUrl = buildUpstream(vertex, "messages", "/v1/messages", "gemini-2.0-flash", { ...geminiNamed, stream: true });
  assert.equal(
    geminiStreamUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=vkey",
  );
});

test("original Vertex ConvertGeminiRequest always uses Gemini generateContent JSON", () => {
  const geminiBody = () => ({
    contents: [
      { role: "user", parts: [{ text: "What is in this image?" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "call_1", name: "lookup", response: { ok: true } } }] },
    ],
    systemInstruction: { parts: [{ text: "You are a helpful assistant." }] },
    tools: [
      {
        functionDeclarations: [
          { name: "lookup", description: "Lookup data", parameters: { type: "object", properties: { q: { type: "string" } } } },
        ],
      },
    ],
  });

  const claudeNamed = convertVertexGeminiRequest(geminiBody(), {
    originModelName: "claude-3-5-sonnet-20241022",
    upstreamModelName: "claude-3-5-sonnet-20241022",
  });
  assert.equal("anthropic_version" in claudeNamed, false);
  assert.equal("messages" in claudeNamed, false);
  assert.equal((claudeNamed.systemInstruction as { parts: { text: string }[] }).parts[0].text, "You are a helpful assistant.");
  const contents = claudeNamed.contents as { role: string; parts: Record<string, unknown>[] }[];
  assert.equal(contents[0].role, "user");
  assert.equal(contents[0].parts[0].text, "What is in this image?");
  assert.deepEqual(contents[0].parts[1].inlineData, { mimeType: "image/png", data: "aGVsbG8=" });
  const call = contents[1].parts[0].functionCall as { id?: string; name: string };
  assert.equal(call.name, "lookup");
  assert.equal("id" in call, false);
  const resp = contents[2].parts[0].functionResponse as { id?: string; name: string };
  assert.equal(resp.name, "lookup");
  assert.equal("id" in resp, false);

  const keepIds = convertVertexGeminiRequest(geminiBody(), {
    originModelName: "claude-3-5-sonnet-20241022",
    upstreamModelName: "claude-3-5-sonnet-20241022",
    settings: { removeFunctionResponseIdEnabled: false },
  });
  const keepContents = keepIds.contents as { role: string; parts: Record<string, unknown>[] }[];
  const keepCall = keepContents[1].parts[0].functionCall as { id?: string };
  assert.equal(keepCall.id, "call_1");

  const geminiNamed = convertVertexGeminiRequest(geminiBody(), {
    originModelName: "gemini-2.0-flash",
    upstreamModelName: "gemini-2.0-flash",
  });
  assert.equal("anthropic_version" in geminiNamed, false);
  const geminiContents = geminiNamed.contents as { role: string }[];
  assert.equal(geminiContents[0].role, "user");

  const inbound = claudeResponseToGeminiChat(
    {
      id: "msg_vertex",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "ok vertex claude" },
        { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "y" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 5 },
    },
    "claude-3-5-sonnet-20241022",
  );
  const candidates = inbound.candidates as { content: { role: string; parts: Record<string, unknown>[] } }[];
  assert.equal(candidates[0].content.role, "model");
  assert.ok(candidates[0].content.parts.some((part) => part.text === "ok vertex claude"));
  assert.ok(candidates[0].content.parts.some((part) => (part.functionCall as { name?: string } | undefined)?.name === "lookup"));

  const vertex = testChannel({
    type: CHANNEL_TYPE_VERTEX,
    key: "vkey",
    other: JSON.stringify({ default: "us-central1" }),
    settings: JSON.stringify({ vertex_key_type: "api_key" }),
    models: "claude-3-5-sonnet-20241022,gemini-2.0-flash",
  });
  const claudeUrl = buildUpstream(vertex, "gemini", "/v1beta/models/claude-3-5-sonnet-20241022:generateContent", "claude-3-5-sonnet-20241022", claudeNamed);
  assert.equal(
    claudeUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict?key=vkey",
  );
  const geminiUrl = buildUpstream(vertex, "gemini", "/v1beta/models/gemini-2.0-flash:generateContent", "gemini-2.0-flash", geminiNamed);
  assert.equal(
    geminiUrl.url,
    "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash:generateContent?key=vkey",
  );
});

test("original Gemini ConvertImageRequest JSON, :predict URL, and GeminiImageHandler fields", () => {
  const imagen = convertOpenAIRequest(
    { model: "imagen-3.0-generate-001", prompt: "a cat", n: 2, size: "1792x1024", quality: "hd" },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "imagen-3.0-generate-001",
      upstreamModelName: "imagen-3.0-generate-001",
      relayMode: "images",
    },
  );
  assert.deepEqual(imagen.instances, [{ prompt: "a cat" }]);
  assert.deepEqual(imagen.parameters, {
    sampleCount: 2,
    aspectRatio: "16:9",
    personGeneration: "allow_adult",
    imageSize: "2K",
  });

  const ratios = [
    ["256x256", "1:1"],
    ["512x512", "1:1"],
    ["1024x1024", "1:1"],
    ["1536x1024", "3:2"],
    ["1024x1536", "2:3"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
    ["9:16", "9:16"],
    ["", "1:1"],
    ["2048x2048", "1:1"],
  ] as const;
  for (const [size, aspectRatio] of ratios) {
    const converted = convertOpenAIRequest(
      { model: "imagen-4.0-generate-001", prompt: "sky", size },
      {
        channelType: CHANNEL_TYPE_GEMINI,
        originModelName: "imagen-4.0-generate-001",
        upstreamModelName: "imagen-4.0-generate-001",
        relayMode: "images",
      },
    );
    const parameters = converted.parameters as { sampleCount: number; aspectRatio: string; personGeneration: string; imageSize?: string };
    assert.equal(parameters.sampleCount, 1, size);
    assert.equal(parameters.aspectRatio, aspectRatio, size);
    assert.equal(parameters.personGeneration, "allow_adult");
    assert.equal("imageSize" in parameters, false, size);
  }

  const high = convertOpenAIRequest(
    { model: "imagen-3.0-generate-001", prompt: "a dog", quality: "high" },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "imagen-3.0-generate-001",
      upstreamModelName: "imagen-3.0-generate-001",
      relayMode: "images",
    },
  );
  assert.equal((high.parameters as { imageSize: string }).imageSize, "2K");
  const twoK = convertOpenAIRequest(
    { model: "imagen-3.0-generate-001", prompt: "a dog", quality: "2K" },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "imagen-3.0-generate-001",
      upstreamModelName: "imagen-3.0-generate-001",
      relayMode: "images",
    },
  );
  assert.equal((twoK.parameters as { imageSize: string }).imageSize, "2K");
  for (const quality of ["standard", "medium", "low", "auto", "1K", "unknown"]) {
    const converted = convertOpenAIRequest(
      { model: "imagen-3.0-generate-001", prompt: "a dog", quality },
      {
        channelType: CHANNEL_TYPE_GEMINI,
        originModelName: "imagen-3.0-generate-001",
        upstreamModelName: "imagen-3.0-generate-001",
        relayMode: "images",
      },
    );
    assert.equal((converted.parameters as { imageSize: string }).imageSize, "1K", quality);
  }

  const vertexImage = convertOpenAIRequest(
    { model: "imagen-3.0-generate-001", prompt: "vertex cat", n: 3, size: "1024x1536" },
    {
      channelType: CHANNEL_TYPE_VERTEX,
      originModelName: "imagen-3.0-generate-001",
      upstreamModelName: "imagen-3.0-generate-001",
      relayMode: "images",
    },
  );
  assert.deepEqual(vertexImage.instances, [{ prompt: "vertex cat" }]);
  assert.deepEqual(vertexImage.parameters, { sampleCount: 3, aspectRatio: "2:3", personGeneration: "allow_adult" });

  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gemini-2.0-flash", prompt: "a cat" },
        {
          channelType: CHANNEL_TYPE_GEMINI,
          originModelName: "gemini-2.0-flash",
          upstreamModelName: "gemini-2.0-flash",
          relayMode: "images",
        },
      ),
    /not supported model for image generation, only imagen models are supported/,
  );

  const geminiCh = testChannel({
    type: CHANNEL_TYPE_GEMINI,
    key: "gkey",
    models: "imagen-3.0-generate-001,gemini-2.0-flash",
  });
  const imagenUrl = buildUpstream(
    geminiCh,
    "images",
    "/v1/images/generations",
    "imagen-3.0-generate-001",
    imagen,
  );
  assert.equal(
    imagenUrl.url,
    "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=gkey",
  );
  assert.equal(imagenUrl.headers["x-goog-api-key"], "gkey");
  const chatUrl = buildUpstream(
    geminiCh,
    "chat",
    "/v1/chat/completions",
    "gemini-2.0-flash",
    { model: "gemini-2.0-flash", contents: [] },
  );
  assert.equal(
    chatUrl.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gkey",
  );
  assert.equal(getGeminiVersionSetting("gemini-1.0-pro"), "v1");
  assert.equal(getGeminiVersionSetting("gemini-2.0-flash"), "v1beta");
  assert.equal(
    getGeminiVersionSetting("gemini-1.0-pro", { geminiVersionSettings: { default: "v1beta", "gemini-1.0-pro": "v1alpha" } }),
    "v1alpha",
  );
  const proUrl = buildUpstream(
    geminiCh,
    "chat",
    "/v1/chat/completions",
    "gemini-1.0-pro",
    { model: "gemini-1.0-pro", contents: [] },
  );
  assert.equal(
    proUrl.url,
    "https://generativelanguage.googleapis.com/v1/models/gemini-1.0-pro:generateContent?key=gkey",
  );
});

test("original Gemini ConvertEmbeddingRequest JSON, batchEmbedContents URL, and GeminiEmbeddingHandler fields", () => {
  const batch = convertOpenAIRequest(
    { model: "text-embedding-004", input: ["hello", "world"], dimensions: 768 },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "text-embedding-004",
      upstreamModelName: "text-embedding-004",
      relayMode: "embeddings",
    },
  );
  assert.deepEqual(batch.requests, [
    {
      model: "models/text-embedding-004",
      content: { parts: [{ text: "hello" }] },
      outputDimensionality: 768,
    },
    {
      model: "models/text-embedding-004",
      content: { parts: [{ text: "world" }] },
      outputDimensionality: 768,
    },
  ]);

  const single = convertOpenAIRequest(
    { model: "gemini-embedding-001", input: "one string", dimensions: 256 },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "gemini-embedding-001",
      upstreamModelName: "gemini-embedding-001",
      relayMode: "embeddings",
    },
  );
  assert.deepEqual(single.requests, [
    {
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "one string" }] },
      outputDimensionality: 256,
    },
  ]);

  const preview = convertOpenAIRequest(
    { model: "gemini-embedding-2-preview", input: "x", dimensions: 768 },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "gemini-embedding-2-preview",
      upstreamModelName: "gemini-embedding-2-preview",
      relayMode: "embeddings",
    },
  );
  assert.deepEqual(preview.requests, [
    { model: "models/gemini-embedding-2-preview", content: { parts: [{ text: "x" }] } },
  ]);

  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "text-embedding-004" },
        {
          channelType: CHANNEL_TYPE_GEMINI,
          originModelName: "text-embedding-004",
          upstreamModelName: "text-embedding-004",
          relayMode: "embeddings",
        },
      ),
    /input is required/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "text-embedding-004", input: [] },
        {
          channelType: CHANNEL_TYPE_GEMINI,
          originModelName: "text-embedding-004",
          upstreamModelName: "text-embedding-004",
          relayMode: "embeddings",
        },
      ),
    /input is empty/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gemini-embedding-001", input: "hi" },
        {
          channelType: CHANNEL_TYPE_VERTEX,
          originModelName: "gemini-embedding-001",
          upstreamModelName: "gemini-embedding-001",
          relayMode: "embeddings",
        },
      ),
    /not implemented/,
  );

  const mapped = openaiFromGeminiEmbedding(
    { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] },
    "text-embedding-004",
    { fallbackPromptTokens: 7 },
  );
  assert.equal(mapped.object, "list");
  assert.equal(mapped.model, "text-embedding-004");
  assert.deepEqual(mapped.data, [
    { object: "embedding", embedding: [0.1, 0.2], index: 0 },
    { object: "embedding", embedding: [0.3, 0.4], index: 1 },
  ]);
  assert.deepEqual(mapped.usage, { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 });

  const geminiCh = testChannel({
    type: CHANNEL_TYPE_GEMINI,
    key: "gkey",
    models: "text-embedding-004,gemini-2.0-flash",
  });
  assert.equal(
    buildUpstream(geminiCh, "embeddings", "/v1/embeddings", "text-embedding-004", batch).url,
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=gkey",
  );
  assert.equal(
    buildUpstream(geminiCh, "chat", "/v1/chat/completions", "gemini-2.0-flash", { model: "gemini-2.0-flash" }).url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gkey",
  );
  assert.equal(
    buildUpstream(geminiCh, "gemini", "/v1beta/models/text-embedding-004:embedContent", "text-embedding-004", {
      model: "models/text-embedding-004",
    }).url,
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=gkey",
  );
});

test("original Ollama ConvertOpenAIRequest is /api/chat JSON not OpenAI chat completions", () => {
  const chat = convertOpenAIRequest(
    {
      model: "llama3",
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } }] },
        {
          role: "assistant",
          content: "",
          reasoning_content: "think",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "15" },
      ],
      temperature: 0,
      max_tokens: 32,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      tools: [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object" } } }],
    },
    { channelType: CHANNEL_TYPE_OLLAMA, originModelName: "llama3", upstreamModelName: "llama3" },
  );
  assert.equal(chat.model, "llama3");
  assert.equal(chat.stream, false);
  assert.equal("max_tokens" in chat, false);
  assert.equal("messages" in chat, true);
  assert.equal(chat.think, "high");
  assert.equal(chat.format, "json");
  assert.deepEqual(chat.options, { temperature: 0, num_predict: 32 });
  const messages = chat.messages as Record<string, unknown>[];
  assert.equal(messages[0].content, "hi");
  assert.deepEqual(messages[0].images, ["YWE="]);
  assert.equal(messages[1].thinking, "think");
  const calls = messages[1].tool_calls as { function: { name: string; arguments: Record<string, unknown> } }[];
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(calls[0].function.arguments, { city: "Paris" });
  assert.equal(messages[2].tool_call_id, "call_1");
  assert.equal(messages[2].tool_name, "get_weather");
  const tools = chat.tools as { type: string; function: { name: string } }[];
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "get_weather");

  const none = convertOpenAIRequest(
    { model: "llama3", messages: [{ role: "user", content: "hi" }], reasoning: { effort: "none" } },
    { channelType: CHANNEL_TYPE_OLLAMA, originModelName: "llama3", upstreamModelName: "llama3" },
  );
  assert.equal(none.think, false);

  let threw = false;
  try {
    convertOpenAIRequest(
      { model: "llama3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "xhigh" },
      { channelType: CHANNEL_TYPE_OLLAMA, originModelName: "llama3", upstreamModelName: "llama3" },
    );
  } catch (err) {
    threw = true;
    assert.equal(String(err), 'Error: unsupported ollama reasoning effort "xhigh"');
  }
  assert.equal(threw, true);

  const generate = convertOpenAIRequest(
    { model: "llama3", prompt: "complete this", max_tokens: 8, temperature: 0.2, suffix: "!" },
    { channelType: CHANNEL_TYPE_OLLAMA, originModelName: "llama3", upstreamModelName: "llama3", relayMode: "completions" },
  );
  assert.equal(generate.model, "llama3");
  assert.equal(generate.prompt, "complete this");
  assert.equal(generate.suffix, "!");
  assert.equal(generate.stream, false);
  assert.equal("messages" in generate, false);
  assert.deepEqual(generate.options, { temperature: 0.2, num_predict: 8 });
  assert.equal("think" in generate, false);

  const embed = convertOllamaEmbeddingRequest(
    { model: "llama3", input: "hello", dimensions: 3, temperature: 0.1 },
    { upstreamModelName: "llama3" },
  );
  assert.equal(embed.input, "hello");
  assert.equal(embed.dimensions, 3);
  assert.deepEqual(embed.options, { temperature: 0.1, dimensions: 3 });

  const ollama = testChannel({
    type: CHANNEL_TYPE_OLLAMA,
    key: "ollama-key",
    base_url: "http://localhost:11434",
    models: "llama3",
  });
  assert.equal(buildUpstream(ollama, "chat", "/v1/chat/completions", "llama3", chat).url, "http://localhost:11434/api/chat");
  assert.equal(buildUpstream(ollama, "chat", "/v1/chat/completions", "llama3", chat).headers.authorization, "Bearer ollama-key");
  assert.equal(buildUpstream(ollama, "completions", "/v1/completions", "llama3", generate).url, "http://localhost:11434/api/generate");
  assert.equal(buildUpstream(ollama, "embeddings", "/v1/embeddings", "llama3", embed).url, "http://localhost:11434/api/embed");
  assert.equal(
    buildUpstream(ollama, "responses", "/v1/responses/compact", "llama3", { model: "llama3" }).url,
    "http://localhost:11434/v1/responses/compact",
  );
  const ollamaClaude = buildUpstream(ollama, "messages", "/v1/messages", "llama3", { model: "llama3", messages: [] });
  assert.equal(ollamaClaude.url, "http://localhost:11434/v1/messages");
  assert.equal(ollamaClaude.headers.authorization, "Bearer ollama-key");
  assert.equal(ollamaClaude.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    buildUpstream(ollama, "messages", "/v1/messages", "llama3", { model: "llama3" }, {}, "POST", { isClaudeBetaQuery: true }).url,
    "http://localhost:11434/v1/messages?beta=true",
  );
  const ollamaBetaSetting = testChannel({
    type: CHANNEL_TYPE_OLLAMA,
    key: "ollama-key",
    base_url: "http://localhost:11434",
    models: "llama3",
    settings: JSON.stringify({ claude_beta_query: true }),
  });
  assert.equal(
    buildUpstream(ollamaBetaSetting, "messages", "/v1/messages", "llama3", { model: "llama3" }).url,
    "http://localhost:11434/v1/messages?beta=true",
  );

  const compact = openaiFromOllamaChatResponse(
    '{"model":"llama3.1","created_at":"2026-05-27T12:00:00Z","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_upstream","function":{"name":"get_weather","arguments":{"city":"Paris","days":0}}}]},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":7}',
    "fallback-model",
  );
  assert.equal((compact.choices as { finish_reason: string }[])[0].finish_reason, "tool_calls");
  assert.equal((compact.usage as { total_tokens: number }).total_tokens, 12);
  const compactCalls = (compact.choices as { message: { tool_calls: { id: string; type: string; function: { name: string; arguments: string }; index?: number }[] } }[])[0]
    .message.tool_calls;
  assert.equal(compactCalls[0].id, "call_upstream");
  assert.equal(compactCalls[0].type, "function");
  assert.equal(compactCalls[0].function.name, "get_weather");
  assert.equal("index" in compactCalls[0], false);
  assert.deepEqual(JSON.parse(compactCalls[0].function.arguments), { city: "Paris", days: 0 });
  assert.equal((compact.choices as { message: { content: unknown } }[])[0].message.content, null);

  const pretty = openaiFromOllamaChatResponse(
    `{
  "model": "llama3.1",
  "created_at": "2026-05-27T12:00:00Z",
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      {
        "function": {
          "name": "get_weather",
          "arguments": {
            "city": "Paris",
            "days": 0
          }
        }
      }
    ]
  },
  "done": true,
  "done_reason": "stop",
  "prompt_eval_count": 5,
  "eval_count": 7
}`,
    "fallback-model",
  );
  assert.equal((pretty.choices as { message: { tool_calls: { id: string }[] } }[])[0].message.tool_calls[0].id, "call_0");

  const embedJson = openaiFromOllamaEmbedding(
    { embeddings: [[0.1, 0.2]], prompt_eval_count: 4, model: "nomic" },
    "llama3",
  );
  assert.equal(embedJson.object, "list");
  assert.equal(embedJson.model, "llama3");
  assert.deepEqual(embedJson.data, [{ index: 0, object: "embedding", embedding: [0.1, 0.2] }]);
  assert.deepEqual(
    { prompt_tokens: (embedJson.usage as { prompt_tokens: number }).prompt_tokens, completion_tokens: (embedJson.usage as { completion_tokens: number }).completion_tokens, total_tokens: (embedJson.usage as { total_tokens: number }).total_tokens },
    { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
  );
});

test("original Volc, xAI, and DeepSeek ConvertOpenAIRequest JSON and URLs", () => {
  const volcThinking = convertOpenAIRequest(
    { model: "deepseek-v3-thinking", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_VOLC, originModelName: "deepseek-v3-thinking", upstreamModelName: "deepseek-v3-thinking" },
  );
  assert.equal(volcThinking.model, "deepseek-v3");
  assert.deepEqual(volcThinking.thinking, { type: "enabled" });
  assert.deepEqual(volcThinking.stream_options, { include_usage: true });

  const volcPlain = convertOpenAIRequest(
    { model: "doubao-pro", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_VOLC, originModelName: "doubao-pro", upstreamModelName: "doubao-pro" },
  );
  assert.equal(volcPlain.model, "doubao-pro");
  assert.equal("thinking" in volcPlain, false);

  const xaiSearch = convertOpenAIRequest(
    { model: "grok-2-search", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_XAI, originModelName: "grok-2-search", upstreamModelName: "grok-2-search" },
  );
  assert.equal(xaiSearch.model, "grok-2");
  assert.deepEqual(xaiSearch.search_parameters, { mode: "on" });

  const grokMini = convertOpenAIRequest(
    { model: "grok-3-mini-high", messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
    { channelType: CHANNEL_TYPE_XAI, originModelName: "grok-3-mini-high", upstreamModelName: "grok-3-mini-high" },
  );
  assert.equal(grokMini.model, "grok-3-mini");
  assert.equal(grokMini.reasoning_effort, "high");
  assert.equal(grokMini.max_completion_tokens, 16);
  assert.equal("max_tokens" in grokMini, false);

  const xaiImage = convertOpenAIRequest(
    {
      model: "grok-2-image",
      prompt: "a cat",
      n: 2,
      size: "1024x1024",
      quality: "hd",
      style: "vivid",
      user: "alice",
      response_format: "b64_json",
    },
    {
      channelType: CHANNEL_TYPE_XAI,
      originModelName: "grok-2-image",
      upstreamModelName: "grok-2-image",
      relayMode: "images",
    },
  );
  assert.deepEqual(xaiImage, { model: "grok-2-image", prompt: "a cat", n: 2, response_format: "b64_json" });
  assert.deepEqual(
    convertXaiImageRequest({ model: "grok-2-image", prompt: "a cat", size: "1024x1024", quality: "hd" }),
    { model: "grok-2-image", prompt: "a cat", n: 1 },
  );
  assert.deepEqual(convertXaiImageRequest({ model: "grok-2-image", prompt: "a cat", n: 0 }), {
    model: "grok-2-image",
    prompt: "a cat",
  });
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "grok-2-image", input: "hi" },
        { channelType: CHANNEL_TYPE_XAI, originModelName: "grok-2-image", upstreamModelName: "grok-2-image", relayMode: "embeddings" },
      ),
    /not available/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "grok-2-image", input: "hi" },
        { channelType: CHANNEL_TYPE_XAI, originModelName: "grok-2-image", upstreamModelName: "grok-2-image", relayMode: "audio_speech" },
      ),
    /not available/,
  );
  const xaiCh = testChannel({ type: CHANNEL_TYPE_XAI, key: "xk", models: "grok-2-image" });
  assert.equal(
    buildUpstream(xaiCh, "images", "/v1/images/generations", "grok-2-image", xaiImage).url,
    "https://api.x.ai/v1/images/generations",
  );

  const dsNone = convertOpenAIRequest(
    { model: "deepseek-v4-flash-none", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_DEEPSEEK, originModelName: "deepseek-v4-flash-none", upstreamModelName: "deepseek-v4-flash-none" },
  );
  assert.equal(dsNone.model, "deepseek-v4-flash");
  assert.deepEqual(dsNone.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in dsNone, false);

  const dsMax = convertOpenAIRequest(
    { model: "deepseek-v4-pro-max", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_DEEPSEEK, originModelName: "deepseek-v4-pro-max", upstreamModelName: "deepseek-v4-pro-max" },
  );
  assert.equal(dsMax.model, "deepseek-v4-pro");
  assert.deepEqual(dsMax.thinking, { type: "enabled" });
  assert.equal(dsMax.reasoning_effort, "max");

  const dsRespNone = convertOpenAIResponsesRequest(
    { model: "deepseek-v4-flash-none", input: "hi" },
    {
      channelType: CHANNEL_TYPE_DEEPSEEK,
      originModelName: "deepseek-v4-flash-none",
      upstreamModelName: "deepseek-v4-flash-none",
    },
  );
  assert.equal(dsRespNone.model, "deepseek-v4-flash");
  assert.deepEqual(dsRespNone.reasoning, { effort: "none" });
  assert.equal("thinking" in dsRespNone, false);

  const dsRespMax = convertOpenAIResponsesRequest(
    { model: "deepseek-v4-pro-max", input: "hi", reasoning: { summary: "auto" } },
    {
      channelType: CHANNEL_TYPE_DEEPSEEK,
      originModelName: "deepseek-v4-pro-max",
      upstreamModelName: "deepseek-v4-pro-max",
    },
  );
  assert.equal(dsRespMax.model, "deepseek-v4-pro");
  assert.deepEqual(dsRespMax.reasoning, { summary: "auto", effort: "max" });

  const volc = testChannel({ type: CHANNEL_TYPE_VOLC, key: "vk", base_url: "", models: "doubao-pro,bot-1,deepseek-v3-thinking" });
  assert.equal(
    buildUpstream(volc, "chat", "/v1/chat/completions", "doubao-pro", volcPlain).url,
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  assert.equal(
    buildUpstream(volc, "chat", "/v1/chat/completions", "bot-1", { model: "bot-1" }).url,
    "https://ark.cn-beijing.volces.com/api/v3/bots/chat/completions",
  );
  assert.equal(
    buildUpstream(volc, "images", "/v1/images/edits", "doubao-seedream-4.0", { model: "doubao-seedream-4.0" }).url,
    "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  );
  const plan = testChannel({ type: CHANNEL_TYPE_VOLC, key: "vk", base_url: "doubao-coding-plan", models: "doubao-pro" });
  assert.equal(
    buildUpstream(plan, "chat", "/v1/chat/completions", "doubao-pro", volcPlain).url,
    "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  );
  assert.equal(
    buildUpstream(volc, "messages", "/v1/messages", "doubao-pro", { model: "doubao-pro" }, {}, "POST", { relayFormat: "claude" }).url,
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  assert.equal(
    buildUpstream(volc, "messages", "/v1/messages", "bot-1", { model: "bot-1" }, {}, "POST", { relayFormat: "claude" }).url,
    "https://ark.cn-beijing.volces.com/api/v3/bots/chat/completions",
  );
  assert.equal(
    buildUpstream(plan, "messages", "/v1/messages", "doubao-pro", { model: "doubao-pro" }, {}, "POST", { relayFormat: "claude" }).url,
    "https://ark.cn-beijing.volces.com/api/coding/v1/messages",
  );

  const volcTts = convertOpenAIRequest(
    { model: "tts-1", input: "hello spark", voice: "alloy", response_format: "opus", speed: 1.2 },
    {
      channelType: CHANNEL_TYPE_VOLC,
      originModelName: "tts-1",
      upstreamModelName: "tts-1",
      relayMode: "audio_speech",
      channelKey: "appid|access",
    },
  );
  assert.deepEqual(volcTts.app, { appid: "appid", token: "access", cluster: "volcano_tts" });
  assert.deepEqual(volcTts.user, { uid: "openai_relay_user" });
  assert.deepEqual(volcTts.audio, {
    voice_type: "zh_male_M392_conversation_wvae_bigtts",
    encoding: "ogg_opus",
    speed_ratio: 1.2,
    rate: 24000,
  });
  assert.equal((volcTts.request as { text: string; operation: string; model: string }).text, "hello spark");
  assert.equal((volcTts.request as { operation: string }).operation, "submit");
  assert.equal((volcTts.request as { model: string }).model, "tts-1");
  assert.match(String((volcTts.request as { reqid: string }).reqid), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const volcTtsChannel = testChannel({
    type: CHANNEL_TYPE_VOLC,
    key: "appid|access",
    base_url: "",
    models: "tts-1",
  });
  const volcTtsUp = buildUpstream(volcTtsChannel, "audio_speech", "/v1/audio/speech", "tts-1", volcTts);
  assert.equal(volcTtsUp.url, "wss://openspeech.bytedance.com/api/v1/tts/ws_binary");
  assert.equal(volcTtsUp.headers.authorization, "Bearer;access");
  assert.equal(volcTtsUp.headers["content-type"], "application/json");
  const volcTtsCustom = testChannel({
    type: CHANNEL_TYPE_VOLC,
    key: "appid|access",
    base_url: "https://tts.example",
    models: "tts-1",
  });
  assert.equal(
    buildUpstream(volcTtsCustom, "audio_speech", "/v1/audio/speech", "tts-1", volcTts).url,
    "https://tts.example/v1/audio/speech",
  );

  const deepseek = testChannel({ type: CHANNEL_TYPE_DEEPSEEK, key: "sk-ds", base_url: "", models: "deepseek-chat" });
  assert.equal(
    buildUpstream(deepseek, "chat", "/v1/chat/completions", "deepseek-chat", dsMax).url,
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.equal(
    buildUpstream(deepseek, "completions", "/v1/completions", "deepseek-chat", { model: "deepseek-chat", prompt: "hi" }).url,
    "https://api.deepseek.com/beta/completions",
  );
  assert.equal(
    buildUpstream(deepseek, "messages", "/v1/messages", "deepseek-chat", { model: "deepseek-chat" }).url,
    "https://api.deepseek.com/anthropic/v1/messages",
  );
  assert.equal(
    buildUpstream(deepseek, "responses", "/v1/responses", "deepseek-chat", { model: "deepseek-chat", input: "hi" }).url,
    "https://api.deepseek.com/responses",
  );
  const moonshotCh = testChannel({ type: CHANNEL_TYPE_MOONSHOT, key: "mk", base_url: "", models: "kimi-k2.5" });
  assert.equal(
    buildUpstream(moonshotCh, "chat", "/v1/chat/completions", "kimi-k2.5", { model: "kimi-k2.5" }).url,
    "https://api.moonshot.cn/v1/chat/completions",
  );
});

test("original xAI/Jimeng/Replicate/Submodel/Coze ConvertClaudeRequest and ConvertGeminiRequest error strings", () => {
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_XAI, "anthropic"), "not available");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_XAI, "gemini"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_XAI, "openai"), undefined);
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_JIMENG, "anthropic"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_JIMENG, "gemini"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_COZE, "anthropic"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_COZE, "gemini"), "not implemented");
  assert.equal(
    nativeClaudeGeminiConvertError(CHANNEL_TYPE_REPLICATE, "anthropic"),
    "replicate adaptor: ConvertClaudeRequest is not implemented",
  );
  assert.equal(
    nativeClaudeGeminiConvertError(CHANNEL_TYPE_REPLICATE, "gemini"),
    "replicate adaptor: ConvertGeminiRequest is not implemented",
  );
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_SUBMODEL, "anthropic"), "submodel channel: endpoint not supported");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_SUBMODEL, "gemini"), "submodel channel: endpoint not supported");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_MOONSHOT, "anthropic"), undefined);
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_MISTRAL, "anthropic"), "implement me");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_MISTRAL, "gemini"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_PALM, "anthropic"), "implement me");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_BAIDU, "anthropic"), "implement me");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_ALI, "gemini"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_OLLAMA, "gemini"), "not implemented");
  assert.equal(nativeClaudeGeminiConvertError(CHANNEL_TYPE_AWS, "gemini"), "not implemented");
});

test("original Coze/Dify/Moonshot ConvertImage/Audio/Embedding/Responses error strings", () => {
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "embeddings"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "audio_speech"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "audio_transcription"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "rerank"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_COZE, "chat"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DIFY, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DIFY, "embeddings"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DIFY, "audio_translation"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DIFY, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DIFY, "rerank"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DIFY, "chat"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MOONSHOT, "audio_speech"), "not supported");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MOONSHOT, "audio_transcription"), "not supported");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MOONSHOT, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MOONSHOT, "images"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MOONSHOT, "embeddings"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MOONSHOT, "chat"), undefined);

  const cozeOpts = {
    channelType: CHANNEL_TYPE_COZE,
    originModelName: "moonshot-v1-8k",
    upstreamModelName: "moonshot-v1-8k",
  };
  assert.throws(
    () => convertOpenAIRequest({ model: "moonshot-v1-8k", prompt: "a cat" }, { ...cozeOpts, relayMode: "images" }),
    /not implemented/,
  );
  assert.throws(
    () => convertOpenAIRequest({ model: "moonshot-v1-8k", input: "hi" }, { ...cozeOpts, relayMode: "embeddings" }),
    /not implemented/,
  );
  assert.throws(
    () => convertOpenAIRequest({ model: "moonshot-v1-8k", input: "hi" }, { ...cozeOpts, relayMode: "audio_speech" }),
    /not implemented/,
  );
  assert.throws(
    () => convertOpenAIRequest({ model: "moonshot-v1-8k", query: "q", documents: ["a"] }, { ...cozeOpts, relayMode: "rerank" }),
    /not implemented/,
  );
  assert.throws(
    () => convertOpenAIResponsesRequest({ model: "moonshot-v1-8k", input: "hi" }, cozeOpts),
    /not implemented/,
  );

  const difyOpts = { channelType: CHANNEL_TYPE_DIFY, originModelName: "dify-bot", upstreamModelName: "dify-bot" };
  assert.throws(
    () => convertOpenAIRequest({ model: "dify-bot", prompt: "a cat" }, { ...difyOpts, relayMode: "images" }),
    /not implemented/,
  );
  assert.throws(
    () => convertOpenAIRequest({ model: "dify-bot", input: "hi" }, { ...difyOpts, relayMode: "embeddings" }),
    /not implemented/,
  );
  assert.throws(
    () => convertOpenAIRequest({ model: "dify-bot", input: "hi" }, { ...difyOpts, relayMode: "audio_speech" }),
    /not implemented/,
  );
  assert.throws(() => convertOpenAIResponsesRequest({ model: "dify-bot", input: "hi" }, difyOpts), /not implemented/);
  const difyRerank = convertOpenAIRequest(
    { model: "dify-bot", query: "q", documents: ["a"] },
    { ...difyOpts, relayMode: "rerank" },
  );
  assert.equal(difyRerank.query, "q");
  assert.deepEqual(difyRerank.documents, ["a"]);

  const moonshotOpts = { channelType: CHANNEL_TYPE_MOONSHOT, originModelName: "kimi-k2.5", upstreamModelName: "kimi-k2.5" };
  assert.throws(
    () => convertOpenAIRequest({ model: "kimi-k2.5", input: "hi" }, { ...moonshotOpts, relayMode: "audio_speech" }),
    /not supported/,
  );
  assert.throws(
    () => convertOpenAIRequest({ model: "kimi-k2.5", input: "hi" }, { ...moonshotOpts, relayMode: "audio_transcription" }),
    /not supported/,
  );
  assert.throws(() => convertOpenAIResponsesRequest({ model: "kimi-k2.5", input: "hi" }, moonshotOpts), /not implemented/);
  const moonshotImage = convertOpenAIRequest(
    { model: "kimi-k2.5", prompt: "a cat" },
    { ...moonshotOpts, relayMode: "images" },
  );
  assert.equal(moonshotImage.model, "kimi-k2.5");
  assert.equal(moonshotImage.prompt, "a cat");

  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ZHIPU, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ZHIPU, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ZHIPU, "rerank"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ZHIPU_V4, "audio_speech"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ZHIPU_V4, "images"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ZHIPU_V4, "responses"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_PERPLEXITY, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_PERPLEXITY, "embeddings"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_PERPLEXITY, "responses"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_JINA, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_JINA, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_JINA, "embeddings"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DEEPSEEK, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DEEPSEEK, "embeddings"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_DEEPSEEK, "responses"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_SILICONFLOW, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_SILICONFLOW, "images"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MINIMAX, "responses"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MINIMAX, "audio_transcription"), "unsupported audio relay mode");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_MINIMAX, "audio_speech"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_VOLC, "audio_speech"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_VOLC, "audio_transcription"), "unsupported audio relay mode");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_VOLC, "audio_translation"), "unsupported audio relay mode");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_CLOUDFLARE, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_CLOUDFLARE, "embeddings"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_BAIDU, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_BAIDU, "embeddings"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_OLLAMA, "images"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_OLLAMA, "embeddings"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ALI, "audio_speech"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_ALI, "images"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_VERTEX, "embeddings"), "not implemented");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_VERTEX, "images"), undefined);
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_XAI, "audio_speech"), "not available");
  assert.equal(nativeOpenAIConvertEndpointError(CHANNEL_TYPE_XAI, "responses"), undefined);

  const zhipuOpts = { channelType: CHANNEL_TYPE_ZHIPU, originModelName: "chatglm_std", upstreamModelName: "chatglm_std" };
  assert.throws(
    () => convertOpenAIRequest({ model: "chatglm_std", prompt: "a cat" }, { ...zhipuOpts, relayMode: "images" }),
    /not implemented/,
  );
  assert.throws(() => convertOpenAIResponsesRequest({ model: "chatglm_std", input: "hi" }, zhipuOpts), /not implemented/);
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "glm-4", input: "hi" },
        { channelType: CHANNEL_TYPE_ZHIPU_V4, originModelName: "glm-4", upstreamModelName: "glm-4", relayMode: "audio_speech" },
      ),
    /not implemented/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "sonar", prompt: "a cat" },
        { channelType: CHANNEL_TYPE_PERPLEXITY, originModelName: "sonar", upstreamModelName: "sonar", relayMode: "images" },
      ),
    /not implemented/,
  );
  assert.throws(
    () =>
      convertOpenAIResponsesRequest(
        { model: "Qwen/Qwen2-7B-Instruct", input: "hi" },
        { channelType: CHANNEL_TYPE_SILICONFLOW, originModelName: "Qwen/Qwen2-7B-Instruct", upstreamModelName: "Qwen/Qwen2-7B-Instruct" },
      ),
    /not implemented/,
  );
  assert.throws(
    () =>
      convertOpenAIResponsesRequest(
        { model: "abab6.5s-chat", input: "hi" },
        { channelType: CHANNEL_TYPE_MINIMAX, originModelName: "abab6.5s-chat", upstreamModelName: "abab6.5s-chat" },
      ),
    /not implemented/,
  );
});

test("original xAIHandler and xAIStreamHandler usage JSON", () => {
  const out = openaiFromXaiResponse({
    id: "chatcmpl-x",
    object: "chat.completion",
    created: 1,
    model: "grok-3",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 25,
      completion_tokens_details: {
        reasoning_tokens: 5,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    extra_dropped: true,
  });
  assert.equal(out.id, "chatcmpl-x");
  assert.equal(out.object, "chat.completion");
  assert.equal(out.created, 1);
  assert.equal(out.model, "grok-3");
  assert.equal(out.system_fingerprint, "");
  assert.equal("extra_dropped" in out, false);
  const usage = out.usage as Record<string, unknown>;
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 15);
  assert.equal(usage.total_tokens, 25);
  assert.equal(usage.input_tokens, 0);
  assert.equal(usage.output_tokens, 0);
  assert.equal(usage.claude_cache_creation_5_m_tokens, 0);
  assert.equal(usage.claude_cache_creation_1_h_tokens, 0);
  assert.equal(usage.input_tokens_details, null);
  const details = usage.completion_tokens_details as Record<string, unknown>;
  assert.equal(details.text_tokens, 10);
  assert.equal(details.reasoning_tokens, 5);
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown>;
  assert.equal(promptDetails.cached_tokens, 0);
  assert.equal(promptDetails.text_tokens, 0);

  const missingUsage = openaiFromXaiResponse({
    id: "chatcmpl-empty",
    object: "chat.completion",
    created: 2,
    model: "grok-3",
    choices: [],
  });
  assert.equal(missingUsage.usage, null);
  assert.equal(missingUsage.system_fingerprint, "");

  const stream = xaiSseToOpenAIChat(
    [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"grok-3","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
      "",
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"grok-3","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":25,"completion_tokens_details":{"reasoning_tokens":5,"text_tokens":1,"audio_tokens":0,"image_tokens":0}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
  assert.match(stream.sse, /data: \[DONE\]/);
  const payloads = [...stream.sse.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].system_fingerprint, null);
  assert.equal(payloads[0].usage, null);
  const streamUsage = payloads[1].usage as Record<string, unknown>;
  assert.equal(streamUsage.completion_tokens, 15);
  assert.equal((streamUsage.completion_tokens_details as Record<string, unknown>).text_tokens, 1);
  assert.equal(stream.usageBody.completion_tokens, 15);
  assert.equal(stream.usageBody.prompt_tokens, 10);
});

test("original Cohere, Dify, Coze, and Baidu ConvertOpenAIRequest JSON and URLs", async () => {
  const cohere = convertOpenAIRequest(
    {
      model: "command-r",
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "prior" },
        { role: "user", content: "first" },
        { role: "user", content: "hi cohere" },
      ],
      max_tokens: 0,
      stream: false,
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_COHERE, originModelName: "command-r", upstreamModelName: "command-r" },
  );
  assert.equal(cohere.model, "command-r");
  assert.equal(cohere.message, "hi cohere");
  assert.deepEqual(cohere.chat_history, [
    { role: "SYSTEM", message: "sys" },
    { role: "CHATBOT", message: "prior" },
  ]);
  assert.equal(cohere.stream, false);
  assert.equal(cohere.max_tokens, 4000);
  assert.equal("safety_mode" in cohere, false);
  assert.equal("stream_options" in cohere, false);
  assert.equal("messages" in cohere, false);

  const safety = convertOpenAIRequest(
    { model: "command-r", messages: [{ role: "user", content: "hi" }] },
    {
      channelType: CHANNEL_TYPE_COHERE,
      originModelName: "command-r",
      upstreamModelName: "command-r",
      cohereSafetySetting: "CONTEXTUAL",
    },
  );
  assert.equal(safety.safety_mode, "CONTEXTUAL");

  const rerank = convertCohereRerankRequest(
    { model: "rerank-english-v3.0", query: "q", documents: ["a", "b"], top_n: 0 },
    { upstreamModelName: "rerank-english-v3.0" },
  );
  assert.deepEqual(rerank, {
    query: "q",
    documents: ["a", "b"],
    model: "rerank-english-v3.0",
    top_n: 1,
    return_documents: true,
  });

  const mapped = openaiFromCohereResponse(
    {
      response_id: "resp-1",
      text: "hello cohere",
      finish_reason: "COMPLETE",
      meta: { billed_units: { input_tokens: 3, output_tokens: 5 } },
    },
    "command-r",
    { created: 1 },
  );
  assert.equal(mapped.id, "resp-1");
  assert.equal(mapped.object, "chat.completion");
  assert.equal(mapped.model, "command-r");
  assert.equal((mapped.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello cohere");
  assert.equal((mapped.choices as { finish_reason: string }[])[0].finish_reason, "stop");
  assert.deepEqual(mapped.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });

  const dify = convertOpenAIRequest(
    {
      model: "dify-bot",
      user: "alice",
      stream: true,
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "prior" },
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "https://example.com/a.png", mime_type: "image" } },
          ],
        },
      ],
    },
    { channelType: CHANNEL_TYPE_DIFY, originModelName: "dify-bot", upstreamModelName: "dify-bot", responseId: "chatcmpl-fallback" },
  );
  assert.deepEqual(dify.inputs, {});
  assert.equal(dify.query, "SYSTEM: \nsys\nASSISTANT: \nprior\nUSER: \nsee\n");
  assert.equal(dify.response_mode, "streaming");
  assert.equal(dify.user, "alice");
  assert.equal(dify.auto_generate_name, false);
  assert.deepEqual(dify.files, [{ type: "image", transfer_mode: "remote_url", url: "https://example.com/a.png" }]);
  assert.equal("model" in dify, false);

  const difyNoUser = convertOpenAIRequest(
    { model: "dify-bot", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_DIFY, originModelName: "dify-bot", upstreamModelName: "dify-bot", responseId: "chatcmpl-rid" },
  );
  assert.equal(difyNoUser.user, "chatcmpl-rid");
  assert.equal(difyNoUser.response_mode, "blocking");
  assert.deepEqual(difyNoUser.files, []);

  const dataUrl = "data:image/png;base64,YWE=";
  const difyLocal = await convertDifyOpenAIRequestWithUploads(
    {
      model: "dify-bot",
      user: "alice",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl, mime_type: "image/png" } }] }],
    },
    {
      responseId: "chatcmpl-dify",
      channelBase: "https://api.dify.ai",
      channelKey: "dk",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "https://api.dify.ai/v1/files/upload");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dk");
        assert.equal(init?.body instanceof FormData, true);
        const form = init?.body as FormData;
        assert.equal(form.get("user"), "alice");
        const file = form.get("file");
        assert.equal(file instanceof Blob, true);
        return new Response(JSON.stringify({ id: "file-1" }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    },
  );
  assert.deepEqual(difyLocal.files, [{ upload_file_id: "file-1", type: "image", transfer_mode: "local_file" }]);
  assert.equal("url" in (difyLocal.files as { url?: string }[])[0], false);

  const difyMapped = openaiFromDifyResponse(
    {
      conversation_id: "conv-1",
      answer: "ok dify",
      metadata: { usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } },
    },
    { created: 2 },
  );
  assert.equal(difyMapped.id, "conv-1");
  assert.equal(difyMapped.model, "");
  assert.equal(difyMapped.object, "chat.completion");
  assert.equal((difyMapped.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "ok dify");
  assert.equal((difyMapped.choices as { finish_reason: string }[])[0].finish_reason, "stop");

  const coze = convertOpenAIRequest(
    {
      model: "moonshot-v1-8k",
      user: "u1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi coze" },
        { role: "assistant", content: "prior" },
        { role: "user", content: "again" },
      ],
    },
    { channelType: CHANNEL_TYPE_COZE, originModelName: "moonshot-v1-8k", upstreamModelName: "moonshot-v1-8k", botId: "bot-xyz", responseId: "chatcmpl-coze" },
  );
  assert.equal(coze.bot_id, "bot-xyz");
  assert.equal(coze.user_id, "u1");
  assert.equal("stream" in coze, false);
  assert.deepEqual(coze.additional_messages, [
    { role: "user", content: "hi coze", content_type: "text" },
    { role: "user", content: "again", content_type: "text" },
  ]);

  const baidu = convertOpenAIRequest(
    {
      model: "ERNIE-4.0",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi baidu" },
      ],
      max_tokens: 1,
      temperature: 0,
      top_p: 0.9,
      frequency_penalty: 0.2,
      user: "u-baidu",
    },
    { channelType: CHANNEL_TYPE_BAIDU, originModelName: "ERNIE-4.0", upstreamModelName: "ERNIE-4.0" },
  );
  assert.equal(baidu.system, "sys");
  assert.deepEqual(baidu.messages, [{ role: "user", content: "hi baidu" }]);
  assert.equal(baidu.max_output_tokens, 2);
  assert.equal(baidu.temperature, 0);
  assert.equal(baidu.top_p, 0.9);
  assert.equal(baidu.penalty_score, 0.2);
  assert.equal(baidu.user_id, "u-baidu");
  assert.equal("disable_search" in baidu, false);
  assert.equal("enable_citation" in baidu, false);
  assert.equal("stream" in baidu, false);
  assert.equal("model" in baidu, false);

  const embed = convertBaiduEmbeddingRequest({ model: "Embedding-V1", input: "hello" });
  assert.deepEqual(embed, { input: ["hello"] });

  const baiduMapped = openaiFromBaiduResponse(
    {
      id: "as-1",
      created: 9,
      result: "hello baidu",
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    },
    { created: 9 },
  );
  assert.equal(baiduMapped.id, "as-1");
  assert.equal(baiduMapped.model, "");
  assert.equal((baiduMapped.choices as { message: { content: string } }[])[0].message.content, "hello baidu");
  assert.equal((baiduMapped.choices as { finish_reason: string }[])[0].finish_reason, "stop");

  const cohereCh = testChannel({ type: CHANNEL_TYPE_COHERE, key: "ck", base_url: "", models: "command-r" });
  assert.equal(buildUpstream(cohereCh, "chat", "/v1/chat/completions", "command-r", cohere).url, "https://api.cohere.ai/v1/chat");
  assert.equal(buildUpstream(cohereCh, "rerank", "/v1/rerank", "rerank-english-v3.0", rerank).url, "https://api.cohere.ai/v1/rerank");

  const difyCh = testChannel({ type: CHANNEL_TYPE_DIFY, key: "dk", base_url: "", models: "dify-bot" });
  assert.equal(buildUpstream(difyCh, "chat", "/v1/chat/completions", "dify-bot", dify).url, "https://api.dify.ai/v1/chat-messages");

  const cozeCh = testChannel({ type: CHANNEL_TYPE_COZE, key: "zk", base_url: "", models: "moonshot-v1-8k", other: "bot-xyz" });
  assert.equal(buildUpstream(cozeCh, "chat", "/v1/chat/completions", "moonshot-v1-8k", coze).url, "https://api.coze.cn/v3/chat");

  const baiduCh = testChannel({ type: CHANNEL_TYPE_BAIDU, key: "ak|sk", base_url: "", models: "ERNIE-4.0,Embedding-V1" });
  assert.equal(
    buildUpstream(baiduCh, "chat", "/v1/chat/completions", "ERNIE-4.0", baidu).url,
    "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro",
  );
  assert.equal(
    buildUpstream(baiduCh, "embeddings", "/v1/embeddings", "Embedding-V1", embed).url,
    "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/embeddings/embedding-v1",
  );
});

test("original Zhipu, ZhipuV4, Perplexity, Cloudflare, BaiduV2, and MiniMax ConvertOpenAIRequest JSON and URLs", async () => {
  const zhipu = convertOpenAIRequest(
    {
      model: "chatglm_std",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi zhipu" },
      ],
      temperature: 0.7,
      top_p: 1,
      stream: true,
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_ZHIPU, originModelName: "chatglm_std", upstreamModelName: "chatglm_std" },
  );
  assert.deepEqual(zhipu.prompt, [
    { role: "system", content: "sys" },
    { role: "user", content: "Okay" },
    { role: "user", content: "hi zhipu" },
  ]);
  assert.equal(zhipu.temperature, 0.7);
  assert.equal(zhipu.top_p, 0.99);
  assert.equal("incremental" in zhipu, false);
  assert.equal("messages" in zhipu, false);
  assert.equal("model" in zhipu, false);
  assert.equal("stream" in zhipu, false);
  assert.equal("stream_options" in zhipu, false);

  const zhipuMapped = openaiFromZhipuResponse(
    {
      success: true,
      data: {
        task_id: "task-1",
        choices: [{ role: "assistant", content: '"hello glm"' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    },
    { created: 11 },
  );
  assert.equal(zhipuMapped.id, "task-1");
  assert.equal(zhipuMapped.object, "chat.completion");
  assert.equal((zhipuMapped.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello glm");
  assert.equal((zhipuMapped.choices as { finish_reason: string }[])[0].finish_reason, "stop");
  assert.deepEqual(zhipuMapped.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  assert.throws(() => openaiFromZhipuResponse({ success: false, msg: "quota", code: 1 }));

  const zhipuV4 = convertOpenAIRequest(
    {
      model: "glm-4",
      messages: [
        { role: "user", name: "alice", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      ],
      top_p: 1,
      stop: "END",
      thinking: { type: "enabled" },
      max_completion_tokens: 64,
      stream_options: { include_usage: true },
      frequency_penalty: 0.5,
    },
    { channelType: CHANNEL_TYPE_ZHIPU_V4, originModelName: "glm-4", upstreamModelName: "glm-4" },
  );
  assert.equal(zhipuV4.model, "glm-4");
  assert.equal(zhipuV4.top_p, 0.99);
  assert.deepEqual(zhipuV4.stop, ["END"]);
  assert.deepEqual(zhipuV4.thinking, { type: "enabled" });
  assert.equal(zhipuV4.max_tokens, 64);
  assert.equal("stream_options" in zhipuV4, false);
  assert.equal("frequency_penalty" in zhipuV4, false);
  assert.equal("name" in (zhipuV4.messages as Record<string, unknown>[])[0], false);
  assert.equal(
    ((zhipuV4.messages as { content: { image_url: { url: string } }[] }[])[0].content[0].image_url.url),
    "AAA",
  );

  const pplx = convertOpenAIRequest(
    {
      model: "sonar",
      messages: [{ role: "user", name: "bob", content: "hi pplx", tool_calls: [{ id: "x" }] }],
      top_p: 1,
      temperature: 0.2,
      max_tokens: 32,
      search_mode: "web",
      stream_options: { include_usage: true },
      tools: [{ type: "function" }],
    },
    { channelType: CHANNEL_TYPE_PERPLEXITY, originModelName: "sonar", upstreamModelName: "sonar" },
  );
  assert.equal(pplx.model, "sonar");
  assert.equal(pplx.top_p, 0.99);
  assert.equal(pplx.max_tokens, 32);
  assert.equal(pplx.search_mode, "web");
  assert.deepEqual(pplx.messages, [{ role: "user", content: "hi pplx" }]);
  assert.equal("stream_options" in pplx, false);
  assert.equal("tools" in pplx, false);

  const cfChat = convertOpenAIRequest(
    {
      model: "llama-3",
      messages: [{ role: "user", content: "hi cf" }],
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_CLOUDFLARE, originModelName: "llama-3", upstreamModelName: "llama-3" },
  );
  assert.equal(cfChat.model, "llama-3");
  assert.deepEqual(cfChat.stream_options, { include_usage: true });

  const cfComp = convertOpenAIRequest(
    { model: "llama-3", prompt: "complete me", max_tokens: 8, stream: true, temperature: 0.1 },
    { channelType: CHANNEL_TYPE_CLOUDFLARE, originModelName: "llama-3", upstreamModelName: "llama-3", relayMode: "completions" },
  );
  assert.deepEqual(cfComp, { prompt: "complete me", max_tokens: 8, stream: true, temperature: 0.1 });
  assert.equal("model" in cfComp, false);

  const baiduV2 = convertOpenAIRequest(
    {
      model: "ernie-4.0-8k-search",
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_BAIDU_V2, originModelName: "ernie-4.0-8k-search", upstreamModelName: "ernie-4.0-8k-search" },
  );
  assert.equal(baiduV2.model, "ernie-4.0-8k");
  assert.deepEqual(baiduV2.web_search, {
    enable: true,
    enable_citation: true,
    enable_trace: true,
    enable_status: false,
  });
  assert.deepEqual(baiduV2.stream_options, { include_usage: true });

  const minimax = convertOpenAIRequest(
    {
      model: "abab6.5s-chat",
      messages: [{ role: "user", content: "hi mm" }],
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_MINIMAX, originModelName: "abab6.5s-chat", upstreamModelName: "abab6.5s-chat" },
  );
  assert.equal(minimax.model, "abab6.5s-chat");
  assert.deepEqual(minimax.stream_options, { include_usage: true });

  const mmImage = convertMiniMaxImageRequest({
    model: "image-01",
    prompt: "a red fox in snowfall",
    size: "1536x1024",
    response_format: "url",
    n: 2,
  });
  assert.equal(mmImage.model, "image-01");
  assert.equal(mmImage.prompt, "a red fox in snowfall");
  assert.equal(mmImage.n, 2);
  assert.equal(mmImage.aspect_ratio, "3:2");
  assert.equal(mmImage.response_format, "url");

  const mmImageOut = openaiFromMiniMaxImage(
    { data: { image_urls: ["https://example.com/minimax.png"] } },
    { created: 1700000000 },
  );
  assert.equal(mmImageOut.created, 1700000000);
  assert.deepEqual(mmImageOut.data, [{ url: "https://example.com/minimax.png" }]);
  assert.equal(JSON.stringify(mmImageOut).includes("image_urls"), false);

  const mmTts = miniMaxTTSDoResponse({
    data: { audio: "48656c6c6f", status: 2 },
    extra_info: { usage_characters: 5 },
    base_resp: { status_code: 0 },
  });
  assert.equal(mmTts.kind, "audio");
  if (mmTts.kind === "audio") {
    assert.equal(new TextDecoder().decode(mmTts.body), "Hello");
    assert.equal(mmTts.contentType, "audio/mpeg");
  }

  clearZhipuTokenCache();
  const jwt = await getZhipuToken("id.secret", 1_700_000_000_000);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const pad = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const header = JSON.parse(Buffer.from(pad(parts[0]), "base64").toString()) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(pad(parts[1]), "base64").toString()) as Record<string, unknown>;
  assert.equal(header.alg, "HS256");
  assert.equal(header.sign_type, "SIGN");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.api_key, "id");
  assert.equal(payload.exp, 1_700_000_000_000 + 24 * 3600 * 1000);
  assert.equal(payload.timestamp, 1_700_000_000_000);
  assert.equal(await getZhipuToken("not-a-jwt"), "");

  const zhipuCh = testChannel({ type: CHANNEL_TYPE_ZHIPU, key: "id.secret", base_url: "", models: "chatglm_std" });
  assert.equal(
    buildUpstream(zhipuCh, "chat", "/v1/chat/completions", "chatglm_std", zhipu).url,
    "https://open.bigmodel.cn/api/paas/v3/model-api/chatglm_std/invoke",
  );
  assert.equal(
    buildUpstream(zhipuCh, "chat", "/v1/chat/completions", "chatglm_std", zhipu, {}, "POST", { isStream: true }).url,
    "https://open.bigmodel.cn/api/paas/v3/model-api/chatglm_std/sse-invoke",
  );
  assert.equal("authorization" in buildUpstream(zhipuCh, "chat", "/v1/chat/completions", "chatglm_std", zhipu).headers, false);

  const zhipuV4Ch = testChannel({ type: CHANNEL_TYPE_ZHIPU_V4, key: "sk-z", base_url: "", models: "glm-4" });
  assert.equal(
    buildUpstream(zhipuV4Ch, "chat", "/v1/chat/completions", "glm-4", zhipuV4).url,
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  assert.equal(
    buildUpstream(zhipuV4Ch, "messages", "/v1/messages", "glm-4", zhipuV4).url,
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
  );
  assert.equal(
    buildUpstream(zhipuV4Ch, "responses", "/v1/responses", "glm-4", zhipuV4).url,
    "https://open.bigmodel.cn/api/v1/responses",
  );
  assert.equal(
    buildUpstream(zhipuV4Ch, "images", "/v1/images/generations", "cogview-3", { model: "cogview-3", prompt: "a cat" }).url,
    "https://open.bigmodel.cn/api/paas/v4/images/generations",
  );
  const zhipuImageB64 = await openaiFromZhipuV4Image(
    {
      created: 1700000000,
      data: [{ url: "https://example.com/zhipu.png", image_url: "https://hidden.example/z.png", b64_json: "YWE=" }],
    },
    { created: 1 },
  );
  assert.equal(zhipuImageB64.created, 1700000000);
  assert.deepEqual(zhipuImageB64.data, [{ b64_json: "YWE=" }]);
  assert.equal(JSON.stringify(zhipuImageB64).includes("image_url"), false);
  assert.equal(JSON.stringify(zhipuImageB64).includes("https://example.com"), false);
  const zhipuImageAlias = await openaiFromZhipuV4Image(
    { data: [{ image_url: "https://example.com/zhipu.png", b64_image: "YWI=" }] },
    { created: 2 },
  );
  assert.deepEqual(zhipuImageAlias.data, [{ b64_json: "YWI=" }]);
  const zhipuImageSkip = await openaiFromZhipuV4Image({ data: [{ b64_json: "YWE=" }] }, { created: 3 });
  assert.equal(zhipuImageSkip.data, null);
  await assert.rejects(
    () => openaiFromZhipuV4Image({ error: { code: "1234", message: "sensitive content" } }),
    (err: unknown) => {
      assert.equal(err instanceof Error ? err.message : "", "sensitive content");
      assert.equal((err as Error & { type?: string }).type, "zhipu_image_error");
      assert.equal((err as Error & { code?: string }).code, "1234");
      return true;
    },
  );
  const origImageFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://example.com/zhipu-dl.png");
    return new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const downloaded = await openaiFromZhipuV4Image({ data: [{ url: "https://example.com/zhipu-dl.png" }] }, { created: 4 });
    assert.deepEqual(downloaded.data, [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }]);
  } finally {
    globalThis.fetch = origImageFetch;
  }
  const glmPlan = testChannel({ type: CHANNEL_TYPE_ZHIPU_V4, key: "sk-z", base_url: "glm-coding-plan", models: "glm-4" });
  assert.equal(
    buildUpstream(glmPlan, "chat", "/v1/chat/completions", "glm-4", zhipuV4).url,
    "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
  );

  const pplxCh = testChannel({ type: CHANNEL_TYPE_PERPLEXITY, key: "pk", base_url: "", models: "sonar" });
  assert.equal(buildUpstream(pplxCh, "chat", "/v1/chat/completions", "sonar", pplx).url, "https://api.perplexity.ai/chat/completions");
  assert.equal(buildUpstream(pplxCh, "responses", "/v1/responses", "sonar", pplx).url, "https://api.perplexity.ai/v1/responses");

  const cfCh = testChannel({ type: CHANNEL_TYPE_CLOUDFLARE, key: "cfk", base_url: "", other: "acct-1", models: "llama-3" });
  assert.equal(
    buildUpstream(cfCh, "chat", "/v1/chat/completions", "llama-3", cfChat).url,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions",
  );
  assert.equal(
    buildUpstream(cfCh, "completions", "/v1/completions", "llama-3", cfComp).url,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/llama-3",
  );
  assert.equal(
    buildUpstream(cfCh, "audio_transcription", "/v1/audio/transcriptions", "whisper-1", { model: "whisper-1" }).url,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/whisper-1",
  );
  assert.equal(
    buildUpstream(cfCh, "audio_translation", "/v1/audio/translations", "whisper-1", { model: "whisper-1" }).url,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/whisper-1",
  );

  const baiduV2Ch = testChannel({ type: CHANNEL_TYPE_BAIDU_V2, key: "tok|app-1", base_url: "", models: "ernie-4.0-8k-search" });
  const baiduV2Up = buildUpstream(baiduV2Ch, "chat", "/v1/chat/completions", "ernie-4.0-8k", baiduV2);
  assert.equal(baiduV2Up.url, "https://qianfan.baidubce.com/v2/chat/completions");
  assert.equal(baiduV2Up.headers.authorization, "Bearer tok");
  assert.equal(baiduV2Up.headers.appid, "app-1");

  const mmCh = testChannel({ type: CHANNEL_TYPE_MINIMAX, key: "mk", base_url: "", models: "abab6.5s-chat,image-01" });
  assert.equal(
    buildUpstream(mmCh, "chat", "/v1/chat/completions", "abab6.5s-chat", minimax).url,
    "https://api.minimax.chat/v1/text/chatcompletion_v2",
  );
  assert.equal(
    buildUpstream(mmCh, "images", "/v1/images/generations", "image-01", mmImage).url,
    "https://api.minimax.chat/v1/image_generation",
  );
  assert.equal(
    buildUpstream(mmCh, "messages", "/v1/messages", "abab6.5s-chat", minimax).url,
    "https://api.minimax.chat/anthropic/v1/messages",
  );
  assert.equal(
    buildUpstream(mmCh, "audio_speech", "/v1/audio/speech", "speech-01", { model: "speech-01", input: "hi" }).url,
    "https://api.minimax.chat/v1/t2a_v2",
  );
});

test("original Tencent, Mistral, Moka, Jina, SiliconFlow, and PaLM ConvertOpenAIRequest JSON and URLs", async () => {
  const nativeKey = "1300000000|AKIDxxxxxxxx|secretxxxxxxxx";
  const tencent = convertOpenAIRequest(
    {
      model: "hunyuan-lite",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi hunyuan" }] },
      ],
      stream: false,
      temperature: 0.7,
      top_p: 0.8,
      stream_options: { include_usage: true },
      max_tokens: 32,
    },
    {
      channelType: CHANNEL_TYPE_TENCENT,
      originModelName: "hunyuan-lite",
      upstreamModelName: "hunyuan-lite",
      channelKey: nativeKey,
    },
  );
  assert.deepEqual(tencent, {
    Model: "hunyuan-lite",
    Messages: [
      { Role: "system", Content: "sys" },
      { Role: "user", Content: "hi hunyuan" },
    ],
    Stream: false,
    TopP: 0.8,
    Temperature: 0.7,
  });
  assert.equal("stream_options" in tencent, false);
  assert.equal("max_tokens" in tencent, false);
  assert.equal("model" in tencent, false);

  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "hunyuan-lite", messages: [{ role: "user", content: "hi" }] },
        { channelType: CHANNEL_TYPE_TENCENT, originModelName: "hunyuan-lite", upstreamModelName: "hunyuan-lite", channelKey: "only|two" },
      ),
    /invalid tencent config/,
  );

  const tokenHub = convertOpenAIRequest(
    {
      model: "hunyuan-lite",
      messages: [{ role: "user", content: "hi tokenhub" }],
      stream_options: { include_usage: true },
    },
    {
      channelType: CHANNEL_TYPE_TENCENT,
      originModelName: "hunyuan-lite",
      upstreamModelName: "hunyuan-lite",
      channelKey: "sk-tokenhub",
    },
  );
  assert.equal(tokenHub.model, "hunyuan-lite");
  assert.equal("stream_options" in tokenHub, false);
  assert.deepEqual(tokenHub.messages, [{ role: "user", content: "hi tokenhub" }]);
  assert.equal(tencentTokenHubBase(""), TENCENT_TOKENHUB_BASE);
  assert.equal(tencentTokenHubBase("https://hunyuan.tencentcloudapi.com"), TENCENT_TOKENHUB_BASE);
  assert.equal(tencentTokenHubBase("https://proxy.example.com"), "https://proxy.example.com");

  const payload = JSON.stringify(tencent);
  const signed = await getTencentSign(payload, "AKIDxxxxxxxx", "secretxxxxxxxx", 1_700_000_000);
  assert.match(signed, /^TC3-HMAC-SHA256 Credential=AKIDxxxxxxxx\/2023-11-14\/hunyuan\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const frozen = await applyTencentTc3Authorization(headers, tencent, nativeKey, 1_700_000_000);
  assert.equal(frozen, payload);
  assert.equal(headers.authorization, signed);
  assert.equal(headers["X-TC-Action"], "ChatCompletions");
  assert.equal(headers["X-TC-Version"], "2023-09-01");
  assert.equal(headers["X-TC-Timestamp"], "1700000000");

  const mistral = convertOpenAIRequest(
    {
      model: "mistral-small-latest",
      messages: [
        { role: "user", name: "alice", content: "hi mistral" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "toolu_long_id", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "toolu_long_id", content: "ok" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://img.example/a.png", detail: "high" } }],
        },
      ],
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 64,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "f" } }],
      frequency_penalty: 0.4,
    },
    { channelType: CHANNEL_TYPE_MISTRAL, originModelName: "mistral-small-latest", upstreamModelName: "mistral-small-latest" },
  );
  assert.equal(mistral.model, "mistral-small-latest");
  assert.equal(mistral.stream, true);
  assert.equal(mistral.temperature, 0.2);
  assert.equal(mistral.top_p, 0.9);
  assert.equal(mistral.max_tokens, 64);
  assert.equal("stream_options" in mistral, false);
  assert.equal("frequency_penalty" in mistral, false);
  const mistralMsgs = mistral.messages as Record<string, unknown>[];
  assert.equal("name" in mistralMsgs[0], false);
  assert.deepEqual(mistralMsgs[0].content, [{ type: "text", text: "hi mistral" }]);
  assert.deepEqual(mistralMsgs[1].content, []);
  const remapped = String((mistralMsgs[1].tool_calls as { id: string }[])[0].id);
  assert.match(remapped, /^[a-zA-Z0-9]{9}$/);
  assert.equal(mistralMsgs[2].tool_call_id, remapped);
  assert.deepEqual(mistralMsgs[3].content, [{ type: "image_url", image_url: "https://img.example/a.png" }]);
  const kept = convertMistralOpenAIRequest(
    { model: "mistral-small-latest", messages: [{ role: "assistant", tool_calls: [{ id: "abc123XYZ", type: "function" }] }] },
    { upstreamModelName: "mistral-small-latest" },
  );
  assert.equal((kept.messages as { tool_calls: { id: string }[] }[])[0].tool_calls[0].id, "abc123XYZ");

  const moka = convertOpenAIRequest(
    { model: "m3e-base", input: ["hello", 1, "world"], encoding_format: "float" },
    { channelType: CHANNEL_TYPE_MOKA, originModelName: "m3e-base", upstreamModelName: "m3e-base", relayMode: "embeddings" },
  );
  assert.deepEqual(moka, { input: ["hello", "world"], model: "m3e-base" });
  assert.deepEqual(convertMokaEmbeddingRequest({ model: "m3e-base", input: "solo" }), { input: ["solo"], model: "m3e-base" });
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "m3e-base", messages: [{ role: "user", content: "hi" }] },
        { channelType: CHANNEL_TYPE_MOKA, originModelName: "m3e-base", upstreamModelName: "m3e-base" },
      ),
    /not implemented/,
  );

  const jinaEmbed = convertOpenAIRequest(
    { model: "jina-clip-v1", input: ["hi"], encoding_format: "float", dimensions: 768 },
    { channelType: CHANNEL_TYPE_JINA, originModelName: "jina-clip-v1", upstreamModelName: "jina-clip-v1", relayMode: "embeddings" },
  );
  assert.equal(jinaEmbed.model, "jina-clip-v1");
  assert.equal("encoding_format" in jinaEmbed, false);
  assert.equal(jinaEmbed.dimensions, 768);
  assert.deepEqual(
    convertJinaEmbeddingRequest({ model: "jina-clip-v1", input: ["hi"], encoding_format: "base64" }),
    { model: "jina-clip-v1", input: ["hi"] },
  );
  const jinaChat = convertOpenAIRequest(
    { model: "jina-clip-v1", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_JINA, originModelName: "jina-clip-v1", upstreamModelName: "jina-clip-v1" },
  );
  assert.deepEqual(jinaChat.stream_options, { include_usage: true });

  const sfFim = convertOpenAIRequest(
    { model: "Qwen/Qwen2-7B-Instruct", prefix: "def ", suffix: ":", stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_SILICONFLOW, originModelName: "Qwen/Qwen2-7B-Instruct", upstreamModelName: "Qwen/Qwen2-7B-Instruct" },
  );
  assert.deepEqual(sfFim.messages, [{ role: "user", content: "" }]);
  assert.equal(sfFim.prefix, "def ");
  assert.equal(sfFim.suffix, ":");
  assert.deepEqual(sfFim.stream_options, { include_usage: true });
  const sfChat = convertOpenAIRequest(
    { model: "Qwen/Qwen2-7B-Instruct", messages: [{ role: "user", content: "hi sf" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_SILICONFLOW, originModelName: "Qwen/Qwen2-7B-Instruct", upstreamModelName: "Qwen/Qwen2-7B-Instruct" },
  );
  assert.deepEqual(sfChat.stream_options, { include_usage: true });
  const sfImage = convertSiliconFlowImageRequest({
    model: "black-forest-labs/FLUX.1-schnell",
    prompt: "a cat",
    size: "1024x1024",
    n: 2,
    extra: { negative_prompt: "blur", seed: 7 },
  });
  assert.equal(sfImage.model, "black-forest-labs/FLUX.1-schnell");
  assert.equal(sfImage.prompt, "a cat");
  assert.equal(sfImage.image_size, "1024x1024");
  assert.equal(sfImage.batch_size, 2);
  assert.equal(sfImage.negative_prompt, "blur");
  assert.equal(sfImage.seed, 7);

  const palm = convertOpenAIRequest(
    {
      model: "PaLM-2",
      messages: [{ role: "user", content: "hi palm" }],
      stream_options: { include_usage: true },
      temperature: 0.5,
    },
    { channelType: CHANNEL_TYPE_PALM, originModelName: "PaLM-2", upstreamModelName: "PaLM-2" },
  );
  assert.equal(palm.model, "PaLM-2");
  assert.deepEqual(palm.stream_options, { include_usage: true });
  assert.deepEqual(palm.messages, [{ role: "user", content: "hi palm" }]);

  const tencentCh = testChannel({ type: CHANNEL_TYPE_TENCENT, key: nativeKey, base_url: "", models: "hunyuan-lite" });
  assert.equal(buildUpstream(tencentCh, "chat", "/v1/chat/completions", "hunyuan-lite", tencent).url, "https://hunyuan.tencentcloudapi.com/");
  assert.equal("authorization" in buildUpstream(tencentCh, "chat", "/v1/chat/completions", "hunyuan-lite", tencent).headers, false);

  const tokenHubCh = testChannel({ type: CHANNEL_TYPE_TENCENT, key: "sk-tokenhub", base_url: "", models: "hunyuan-lite" });
  const tokenHubUp = buildUpstream(tokenHubCh, "chat", "/v1/chat/completions", "hunyuan-lite", tokenHub);
  assert.equal(tokenHubUp.url, "https://tokenhub.tencentmaas.com/v1/chat/completions");
  assert.equal(tokenHubUp.headers.authorization, "Bearer sk-tokenhub");
  const customHub = testChannel({ type: CHANNEL_TYPE_TENCENT, key: "sk-tokenhub", base_url: "https://proxy.example.com", models: "hunyuan-lite" });
  assert.equal(
    buildUpstream(customHub, "chat", "/v1/chat/completions", "hunyuan-lite", tokenHub).url,
    "https://proxy.example.com/v1/chat/completions",
  );

  const mistralCh = testChannel({ type: CHANNEL_TYPE_MISTRAL, key: "ms", base_url: "", models: "mistral-small-latest" });
  assert.equal(
    buildUpstream(mistralCh, "chat", "/v1/chat/completions", "mistral-small-latest", mistral).url,
    "https://api.mistral.ai/v1/chat/completions",
  );

  const mokaCh = testChannel({ type: CHANNEL_TYPE_MOKA, key: "mk", base_url: "", models: "m3e-base" });
  assert.equal(buildUpstream(mokaCh, "embeddings", "/v1/embeddings", "m3e-base", moka).url, "https://api.moka.ai/embeddings");
  assert.equal(buildUpstream(mokaCh, "chat", "/v1/chat/completions", "other", { model: "other" }).url, "https://api.moka.ai/chat/");

  const jinaCh = testChannel({ type: CHANNEL_TYPE_JINA, key: "jk", base_url: "", models: "jina-clip-v1" });
  assert.equal(buildUpstream(jinaCh, "embeddings", "/v1/embeddings", "jina-clip-v1", jinaEmbed).url, "https://api.jina.ai/v1/embeddings");
  assert.equal(buildUpstream(jinaCh, "rerank", "/v1/rerank", "jina-reranker-v2-base-multilingual", { model: "jina-reranker-v2-base-multilingual" }).url, "https://api.jina.ai/v1/rerank");
  assert.throws(
    () => buildUpstream(jinaCh, "chat", "/v1/chat/completions", "jina-clip-v1", jinaChat),
    /invalid relay mode/,
  );

  const sfCh = testChannel({ type: CHANNEL_TYPE_SILICONFLOW, key: "sfk", base_url: "", models: "Qwen/Qwen2-7B-Instruct" });
  assert.equal(
    buildUpstream(sfCh, "chat", "/v1/chat/completions", "Qwen/Qwen2-7B-Instruct", sfChat).url,
    "https://api.siliconflow.cn/v1/chat/completions",
  );
  assert.equal(
    buildUpstream(sfCh, "rerank", "/v1/rerank", "BAAI/bge-reranker-v2-m3", { model: "BAAI/bge-reranker-v2-m3" }).url,
    "https://api.siliconflow.cn/v1/rerank",
  );
  assert.equal(
    buildUpstream(sfCh, "images", "/v1/images/generations", "black-forest-labs/FLUX.1-schnell", sfImage).url,
    "https://api.siliconflow.cn/v1/images/generations",
  );

  const palmCh = testChannel({ type: CHANNEL_TYPE_PALM, key: "palm-key", base_url: "", models: "PaLM-2" });
  const palmUp = buildUpstream(palmCh, "chat", "/v1/chat/completions", "PaLM-2", palm);
  assert.equal(palmUp.url, "/v1beta2/models/chat-bison-001:generateMessage");
  assert.equal(palmUp.headers["x-goog-api-key"], "palm-key");
  assert.equal("authorization" in palmUp.headers, false);
  const palmBase = testChannel({ type: CHANNEL_TYPE_PALM, key: "palm-key", base_url: "https://generativelanguage.googleapis.com", models: "PaLM-2" });
  assert.equal(
    buildUpstream(palmBase, "chat", "/v1/chat/completions", "PaLM-2", palm).url,
    "https://generativelanguage.googleapis.com/v1beta2/models/chat-bison-001:generateMessage",
  );
});

test("original Xunfei, Submodel, Replicate, Sub2API, NewAPI, and Jimeng ConvertOpenAIRequest JSON", async () => {
  const xunfei = convertOpenAIRequest(
    {
      model: "SparkDesk-v3.1",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi spark" },
      ],
      temperature: 0.4,
      n: 2,
      max_tokens: 128,
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_XUNFEI, originModelName: "SparkDesk-v3.1", upstreamModelName: "SparkDesk-v3.1" },
  );
  assert.deepEqual(xunfei.stream_options, { include_usage: true });
  assert.equal(xunfei.model, "SparkDesk-v3.1");
  const xfNative = requestOpenAI2Xunfei(xunfei, "appid", xunfeiDomain("v3.1"));
  assert.deepEqual(xfNative.header, { app_id: "appid" });
  assert.deepEqual((xfNative.parameter as { chat: Record<string, unknown> }).chat, {
    domain: "generalv3",
    temperature: 0.4,
    top_k: 2,
    max_tokens: 128,
  });
  assert.deepEqual((xfNative.payload as { message: { text: unknown } }).message.text, [
    { role: "user", content: "be helpful" },
    { role: "assistant", content: "Okay" },
    { role: "user", content: "hi spark" },
  ]);
  const spark35 = requestOpenAI2Xunfei(
    { model: "SparkDesk-v3.5", messages: [{ role: "system", content: "keep" }] },
    "appid",
    "generalv3.5",
  );
  assert.deepEqual((spark35.payload as { message: { text: unknown } }).message.text, [{ role: "system", content: "keep" }]);
  const authUrl = await buildXunfeiAuthUrl(xunfeiHostUrl("v1.1"), "apiKey", "apiSecret", "Wed, 10 Sep 2026 09:50:00 UTC");
  assert.equal(authUrl.startsWith("wss://spark-api.xf-yun.com/v1.1/chat?"), true);
  assert.match(authUrl, /authorization=/);
  assert.match(authUrl, /date=Wed%2C\+10\+Sep\+2026\+09%3A50%3A00\+UTC/);
  assert.match(authUrl, /host=spark-api\.xf-yun\.com/);

  const xfCh = testChannel({ type: CHANNEL_TYPE_XUNFEI, key: "app|secret|key", models: "SparkDesk-v3.1" });
  assert.equal(buildUpstream(xfCh, "chat", "/v1/chat/completions", "SparkDesk-v3.1", xunfei).url, "");
  assert.equal("authorization" in buildUpstream(xfCh, "chat", "/v1/chat/completions", "SparkDesk-v3.1", xunfei).headers, false);

  const submodel = convertOpenAIRequest(
    { model: "sub-1", messages: [{ role: "user", content: "hi sub" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_SUBMODEL, originModelName: "sub-1", upstreamModelName: "sub-1" },
  );
  assert.deepEqual(submodel.stream_options, { include_usage: true });
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "sub-1", input: "hi" },
        { channelType: CHANNEL_TYPE_SUBMODEL, originModelName: "sub-1", upstreamModelName: "sub-1", relayMode: "embeddings" },
      ),
    /submodel channel: endpoint not supported/,
  );
  const subCh = testChannel({ type: CHANNEL_TYPE_SUBMODEL, key: "sk-sub", models: "sub-1" });
  assert.equal(buildUpstream(subCh, "chat", "/v1/chat/completions", "sub-1", submodel).url, "https://llm.submodel.ai/v1/chat/completions");
  assert.equal(buildUpstream(subCh, "chat", "/v1/chat/completions", "sub-1", submodel).headers.authorization, "Bearer sk-sub");

  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "black-forest-labs/flux-1.1-pro", messages: [{ role: "user", content: "hi" }] },
        { channelType: CHANNEL_TYPE_REPLICATE, originModelName: "black-forest-labs/flux-1.1-pro", upstreamModelName: "black-forest-labs/flux-1.1-pro" },
      ),
    /replicate adaptor: ConvertOpenAIRequest is not implemented/,
  );
  const repImage = convertOpenAIRequest(
    { model: "black-forest-labs/flux-1.1-pro", prompt: "a cat", size: "1024x1024", n: 2, quality: "hd" },
    {
      channelType: CHANNEL_TYPE_REPLICATE,
      originModelName: "black-forest-labs/flux-1.1-pro",
      upstreamModelName: "black-forest-labs/flux-1.1-pro",
      relayMode: "images",
    },
  );
  assert.deepEqual(repImage, { input: { prompt: "a cat", aspect_ratio: "1:1", num_outputs: 2, prompt_upsampling: true } });
  assert.deepEqual(
    convertReplicateImageRequest({ prompt: "wide", size: "1792x1024", extra_fields: { seed: 9 } }),
    { input: { prompt: "wide", aspect_ratio: "16:9", seed: 9 } },
  );
  assert.deepEqual(mapOpenAISizeToFlux("1024x1792"), { aspect: "9:16", width: 0, height: 0 });
  const repCh = testChannel({ type: CHANNEL_TYPE_REPLICATE, key: "r8_key", models: "black-forest-labs/flux-1.1-pro" });
  const repUp = buildUpstream(repCh, "images", "/v1/images/generations", "black-forest-labs/flux-1.1-pro", repImage);
  assert.equal(repUp.url, "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions");
  assert.equal(repUp.headers.authorization, "Bearer r8_key");
  assert.equal(repUp.headers.Prefer, "wait");
  const repUrlOut = await openaiFromReplicatePrediction(
    { status: "succeeded", output: ["https://example.com/replicate.png"] },
    { created: 5 },
  );
  assert.deepEqual(repUrlOut.data, [{ url: "https://example.com/replicate.png" }]);
  const origRepFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://example.com/replicate.png");
    return new Response(Uint8Array.from([65]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const repB64 = await openaiFromReplicatePrediction(
      { status: "succeeded", output: ["https://example.com/replicate.png"] },
      { created: 5, responseFormat: "b64_json" },
    );
    assert.deepEqual(repB64.data, [{ b64_json: Buffer.from([65]).toString("base64") }]);
    assert.equal(JSON.stringify(repB64).includes("https://example.com"), false);
  } finally {
    globalThis.fetch = origRepFetch;
  }

  const newApi = convertOpenAIRequest(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi new" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_NEW_API, originModelName: "gpt-4o-mini", upstreamModelName: "gpt-4o-mini" },
  );
  assert.deepEqual(newApi.stream_options, { include_usage: true });
  const sub2 = convertOpenAIRequest(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi sub2" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_SUB2API, originModelName: "gpt-4o-mini", upstreamModelName: "gpt-4o-mini" },
  );
  assert.deepEqual(sub2.stream_options, { include_usage: true });
  const compact = convertOpenAIResponsesRequest(
    { model: "gpt-4o-mini", input: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_SUB2API, originModelName: "gpt-4o-mini", upstreamModelName: "gpt-4o-mini" },
  );
  assert.deepEqual(compact.stream_options, { include_usage: true });
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-4o-mini", query: "q", documents: ["a"] },
        { channelType: CHANNEL_TYPE_NEW_API, originModelName: "gpt-4o-mini", upstreamModelName: "gpt-4o-mini", relayMode: "rerank" },
      ),
    /endpoint not supported/,
  );
  const newCh = testChannel({ type: CHANNEL_TYPE_NEW_API, key: "sk-new", base_url: "https://newapi.example", models: "gpt-4o-mini" });
  assert.equal(buildUpstream(newCh, "chat", "/v1/chat/completions", "gpt-4o-mini", newApi).url, "https://newapi.example/v1/chat/completions");
  assert.equal(buildUpstream(newCh, "chat", "/v1/chat/completions", "gpt-4o-mini", newApi).headers.authorization, "Bearer sk-new");
  const claudeUp = buildUpstream(newCh, "messages", "/v1/messages", "gpt-5.6-sol", { model: "gpt-5.6-sol" }, { "anthropic-version": "" }, "POST", {
    relayFormat: "claude",
  });
  assert.equal(claudeUp.url, "https://newapi.example/v1/messages");
  assert.equal(claudeUp.headers.authorization, "Bearer sk-new");
  assert.equal(claudeUp.headers["x-api-key"], "sk-new");
  assert.equal(claudeUp.headers["anthropic-version"], "2023-06-01");
  const geminiUp = buildUpstream(newCh, "gemini", "/v1beta/models/gemini-2.0-flash:generateContent", "gemini-2.0-flash", { model: "gemini-2.0-flash" }, {}, "POST", {
    relayFormat: "gemini",
  });
  assert.equal(geminiUp.headers.authorization, "Bearer sk-new");
  assert.equal(geminiUp.headers["x-goog-api-key"], "sk-new");
  const sub2Ch = testChannel({ type: CHANNEL_TYPE_SUB2API, key: "sk-sub2", base_url: "https://sub2api.example", models: "gpt-4o-mini" });
  assert.equal(buildUpstream(sub2Ch, "alpha_search", "/v1/alpha/search", "gpt-4o-mini", { model: "gpt-4o-mini" }).url, "https://sub2api.example/v1/alpha/search");
  assert.equal(
    buildUpstream(sub2Ch, "responses", "/v1/responses/compact", "gpt-4o-mini", compact).url,
    "https://sub2api.example/v1/responses/compact",
  );
  const claudeKept = convertClaudeRequest(
    {
      model: "gpt-5.6-sol",
      max_tokens: 8192,
      temperature: 0.2,
      top_p: 0.99,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh", provider_option: true },
      messages: [{ role: "user", content: "hello" }],
    },
    { originModelName: "gpt-5.6-sol", upstreamModelName: "gpt-5.6-sol" },
  );
  assert.equal((claudeKept.thinking as { type: string }).type, "adaptive");
  assert.equal((claudeKept.thinking as { display: string }).display, "summarized");
  assert.deepEqual(claudeKept.output_config, { effort: "xhigh", provider_option: true });
  assert.equal(claudeKept.temperature, 0.2);
  assert.equal(claudeKept.top_p, 0.99);

  const jimeng = convertOpenAIRequest(
    { model: "doubao-seed", messages: [{ role: "user", content: "hi jimeng" }], stream_options: { include_usage: true } },
    { channelType: CHANNEL_TYPE_JIMENG, originModelName: "jimeng_high_aes_general_v21_L", upstreamModelName: "jimeng_high_aes_general_v21_L" },
  );
  assert.deepEqual(jimeng.stream_options, { include_usage: true });
  assert.equal(jimeng.model, "jimeng_high_aes_general_v21_L");
  const jimengImage = convertJimengImageRequest({
    model: "jimeng_high_aes_general_v21_L",
    prompt: "a mountain",
    extra_fields: { seed: 42, width: 512, height: 512 },
  });
  assert.equal(jimengImage.req_key, "jimeng_high_aes_general_v21_L");
  assert.equal(jimengImage.prompt, "a mountain");
  assert.equal(jimengImage.return_url, true);
  assert.equal(jimengImage.seed, 42);
  const jimengCh = testChannel({ type: CHANNEL_TYPE_JIMENG, key: "ak|sk", models: "jimeng_high_aes_general_v21_L" });
  assert.equal(jimengRequestURL("https://visual.volcengineapi.com"), "https://visual.volcengineapi.com/?Action=CVProcess&Version=2022-08-31");
  assert.equal(
    buildUpstream(jimengCh, "images", "/v1/images/generations", "jimeng_high_aes_general_v21_L", jimengImage).url,
    "https://visual.volcengineapi.com/?Action=CVProcess&Version=2022-08-31",
  );
  const headers: Record<string, string> = { "content-type": "application/json" };
  const frozen = new Date(Date.UTC(2026, 8, 10, 9, 50, 0));
  const signed = await applyJimengAuthorization(
    headers,
    "https://visual.volcengineapi.com/?Action=CVProcess&Version=2022-08-31",
    "POST",
    jimengImage,
    "ak|sk",
    frozen,
  );
  assert.equal(signed, JSON.stringify(jimengImage));
  assert.equal(headers["X-Date"], "20260910T095000Z");
  assert.match(headers.authorization, /^HMAC-SHA256 Credential=ak\/20260910\/cn-north-1\/cv\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=/);
  assert.equal("authorization" in buildUpstream(jimengCh, "chat", "/v1/chat/completions", "jimeng_high_aes_general_v21_L", jimeng).headers, false);
});

test("original Codex ConvertOpenAIRequest throw and ConvertOpenAIResponsesRequest JSON", () => {
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-5.1-codex", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
        { channelType: CHANNEL_TYPE_CODEX, originModelName: "gpt-5.1-codex", upstreamModelName: "gpt-5.1-codex" },
      ),
    /codex channel: \/v1\/chat\/completions endpoint not supported/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-5.1-codex", input: "hi" },
        { channelType: CHANNEL_TYPE_CODEX, originModelName: "gpt-5.1-codex", upstreamModelName: "gpt-5.1-codex", relayMode: "embeddings" },
      ),
    /codex channel: \/v1\/embeddings endpoint not supported/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-5.1-codex", query: "q", documents: ["a"] },
        { channelType: CHANNEL_TYPE_CODEX, originModelName: "gpt-5.1-codex", upstreamModelName: "gpt-5.1-codex", relayMode: "rerank" },
      ),
    /codex channel: \/v1\/rerank endpoint not supported/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-5.1-codex", prompt: "a cat" },
        { channelType: CHANNEL_TYPE_CODEX, originModelName: "gpt-5.1-codex", upstreamModelName: "gpt-5.1-codex", relayMode: "images" },
      ),
    /codex channel: endpoint not supported/,
  );

  const responses = convertOpenAIResponsesRequest(
    {
      model: "gpt-5-codex",
      input: "hello",
      max_output_tokens: 128,
      temperature: 1,
      frequency_penalty: 1.5,
      presence_penalty: 1.5,
      stream_options: { include_usage: true },
    },
    { channelType: CHANNEL_TYPE_CODEX, originModelName: "gpt-5-codex", upstreamModelName: "gpt-5-codex" },
  );
  assert.equal(responses.model, "gpt-5-codex");
  assert.equal(responses.store, false);
  assert.equal(responses.instructions, "");
  assert.equal(responses.input, "hello");
  assert.equal("max_output_tokens" in responses, false);
  assert.equal("temperature" in responses, false);
  assert.equal("frequency_penalty" in responses, false);
  assert.equal("presence_penalty" in responses, false);
  assert.deepEqual(responses.stream_options, { include_usage: true });

  const compact = convertOpenAIResponsesRequest(
    {
      model: "gpt-5-codex",
      input: "hello",
      max_output_tokens: 128,
      temperature: 1,
      store: true,
      frequency_penalty: 1.5,
      presence_penalty: 1.5,
    },
    {
      channelType: CHANNEL_TYPE_CODEX,
      originModelName: "gpt-5-codex",
      upstreamModelName: "gpt-5-codex",
      requestPath: "/v1/responses/compact",
    },
  );
  assert.equal(compact.store, true);
  assert.equal(compact.max_output_tokens, 128);
  assert.equal(compact.temperature, 1);
  assert.equal(compact.frequency_penalty, 1.5);
  assert.equal(compact.presence_penalty, 1.5);
  assert.equal(compact.instructions, "");

  const prepended = convertOpenAIResponsesRequest(
    { model: "gpt-5-codex", input: "hello", instructions: "be brief" },
    {
      channelType: CHANNEL_TYPE_CODEX,
      originModelName: "gpt-5-codex",
      upstreamModelName: "gpt-5-codex",
      systemPrompt: "Answer in English.",
      systemPromptOverride: true,
    },
  );
  assert.equal(prepended.instructions, "Answer in English.\nbe brief");
  assert.equal(prepended.store, false);

  const missing = convertOpenAIResponsesRequest(
    { model: "gpt-5-codex", input: "hello" },
    {
      channelType: CHANNEL_TYPE_CODEX,
      originModelName: "gpt-5-codex",
      upstreamModelName: "gpt-5-codex",
      systemPrompt: "Answer in English.",
    },
  );
  assert.equal(missing.instructions, "Answer in English.");

  const kept = convertOpenAIResponsesRequest(
    { model: "gpt-5-codex", input: "hello", instructions: "keep me" },
    {
      channelType: CHANNEL_TYPE_CODEX,
      originModelName: "gpt-5-codex",
      upstreamModelName: "gpt-5-codex",
      systemPrompt: "Answer in English.",
    },
  );
  assert.equal(kept.instructions, "keep me");

  const oauthKey = JSON.stringify({ access_token: "codex-at", account_id: "acct-1", type: "codex" });
  const ch = testChannel({ type: CHANNEL_TYPE_CODEX, key: oauthKey, models: "gpt-5.1-codex" });
  const up = buildCodexRelayTarget(ch, "responses", "/v1/responses", "gpt-5.1-codex", responses, false);
  assert.equal(up.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(up.headers.authorization, `Bearer ${"codex-at"}`);
  assert.equal(up.headers["chatgpt-account-id"], "acct-1");
  assert.equal(up.headers["openai-beta"], "responses=experimental");
  assert.equal(up.headers.originator, "codex_cli_rs");
  assert.equal((up.body as { store?: boolean }).store, false);
  const compactUp = buildCodexRelayTarget(ch, "responses", "/v1/responses/compact", "gpt-5.1-codex", compact, false);
  assert.equal(compactUp.url, "https://chatgpt.com/backend-api/codex/responses/compact");
  assert.equal((compactUp.body as { store?: boolean }).store, true);
  assert.equal((compactUp.body as { temperature?: number }).temperature, 1);
  const alpha = buildCodexRelayTarget(ch, "alpha_search", "/v1/alpha/search", "gpt-5.1-codex", { model: "gpt-5.1-codex", query: "q" }, false);
  assert.equal(alpha.url, "https://chatgpt.com/backend-api/codex/alpha/search");
  assert.equal("store" in (alpha.body as object), false);
});

test("original AdvancedCustom ConvertOpenAIRequest converter JSON", () => {
  const none = convertOpenAIRequest(
    {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gpt-test",
      upstreamModelName: "gpt-test",
      converter: "none",
    },
  );
  assert.equal(none.model, "gpt-test");
  assert.deepEqual(none.stream_options, { include_usage: true });
  assert.deepEqual(none.messages, [{ role: "user", content: "hello" }]);

  const chatToResponses = convertOpenAIRequest(
    {
      model: "gpt-test",
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "hello" },
      ],
      prompt_cache_key: "session-1",
      frequency_penalty: 0.5,
      presence_penalty: 1.5,
    },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gpt-test",
      upstreamModelName: "gpt-test",
      converter: "openai_chat_completions_to_openai_responses",
    },
  );
  assert.equal(chatToResponses.model, "gpt-test");
  assert.equal(chatToResponses.instructions, "system rules");
  assert.ok(Array.isArray(chatToResponses.input) && (chatToResponses.input as unknown[]).length > 0);
  assert.equal((chatToResponses.input as { role?: string; content?: string }[])[0].role, "user");
  assert.equal((chatToResponses.input as { role?: string; content?: string }[])[0].content, "hello");
  assert.equal(chatToResponses.prompt_cache_key, "session-1");
  assert.equal(chatToResponses.frequency_penalty, 0.5);
  assert.equal(chatToResponses.presence_penalty, 1.5);

  const chatToClaude = convertOpenAIRequest(
    { model: "claude-test", messages: [{ role: "user", content: "hello" }] },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "claude-test",
      upstreamModelName: "claude-test",
      converter: "openai_chat_completions_to_anthropic_messages",
    },
  );
  assert.equal(chatToClaude.model, "claude-test");
  const claudeMessages = chatToClaude.messages as { role: string }[];
  assert.equal(claudeMessages.length, 1);
  assert.equal(claudeMessages[0].role, "user");

  const chatToGemini = convertOpenAIRequest(
    { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hello" }] },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gemini-2.5-flash",
      upstreamModelName: "gemini-2.5-flash",
      converter: "openai_chat_completions_to_gemini_generate_content",
    },
  );
  const contents = chatToGemini.contents as { role: string }[];
  assert.equal(contents.length, 1);
  assert.equal(contents[0].role, "user");

  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-test", messages: [{ role: "user", content: "hello" }] },
        {
          channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
          originModelName: "gpt-test",
          upstreamModelName: "gpt-test",
          converter: "openai_responses_to_openai_chat_completions",
        },
      ),
    /converter "openai_responses_to_openai_chat_completions" does not support OpenAI chat completions requests/,
  );
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "gpt-test", input: ["hello"] },
        {
          channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
          originModelName: "gpt-test",
          upstreamModelName: "gpt-test",
          converter: "openai_chat_completions_to_openai_responses",
          relayMode: "embeddings",
        },
      ),
    /converter "openai_chat_completions_to_openai_responses" does not support embedding requests/,
  );

  const responsesToChat = convertOpenAIResponsesRequest(
    { model: "gpt-test", instructions: "system rules", input: "hello" },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gpt-test",
      upstreamModelName: "gpt-test",
      converter: "openai_responses_to_openai_chat_completions",
    },
  );
  assert.equal(responsesToChat.model, "gpt-test");
  const chatMessages = responsesToChat.messages as { role: string; content: string }[];
  assert.equal(chatMessages.length, 2);
  assert.equal(chatMessages[0].role, "system");
  assert.equal(chatMessages[0].content, "system rules");
  assert.equal(chatMessages[1].role, "user");
  assert.equal(chatMessages[1].content, "hello");

  const responsesToGemini = convertOpenAIResponsesRequest(
    {
      model: "gemini-test",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", call_id: "call_1", name: "glob", arguments: { query: "*" } },
        { type: "function_call_output", call_id: "call_1", output: [{ path: "report.md" }] },
      ],
      tools: [{ type: "function", name: "glob", parameters: { type: "object" } }],
    },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gemini-test",
      upstreamModelName: "gemini-test",
      converter: "openai_responses_to_gemini_generate_content",
    },
  );
  const geminiContents = responsesToGemini.contents as { role: string; parts: Record<string, unknown>[] }[];
  assert.equal(geminiContents.length, 3);
  assert.ok(geminiContents[1].parts[0].functionCall);
  assert.ok(geminiContents[1].parts[0].thoughtSignature);
  assert.ok(geminiContents[2].parts[0].functionResponse);
  assert.equal(geminiContents[2].parts[0].thoughtSignature, undefined);

  const claudeToChat = convertAdvancedCustomClaudeRequest(
    { model: "gpt-test", messages: [{ role: "user", content: "hello" }] },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gpt-test",
      upstreamModelName: "gpt-test",
      converter: "anthropic_messages_to_openai_chat_completions",
    },
  );
  assert.equal(claudeToChat.model, "gpt-test");
  const fromClaude = claudeToChat.messages as { role: string }[];
  assert.equal(fromClaude.length, 1);
  assert.equal(fromClaude[0].role, "user");

  const geminiToChat = convertAdvancedCustomGeminiRequest(
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    {
      channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
      originModelName: "gpt-test",
      upstreamModelName: "gpt-test",
      converter: "gemini_generate_content_to_openai_chat_completions",
    },
  );
  assert.equal(geminiToChat.model, "gpt-test");
  const fromGemini = geminiToChat.messages as { role: string }[];
  assert.equal(fromGemini.length, 1);
  assert.equal(fromGemini[0].role, "user");
});

test("original AdvancedCustom DoResponse converter JSON", () => {
  const claude = convertAdvancedCustomInbound(
    "openai_chat_completions_to_anthropic_messages",
    "openai",
    {
      id: "msg_adv",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    },
    "claude-test",
  );
  assert.equal(claude.object, "chat.completion");
  const claudeChoice = (claude.choices as { message: { content: string }; finish_reason: string }[])[0];
  assert.equal(claudeChoice.message.content, "ok");
  assert.equal(claudeChoice.finish_reason, "stop");

  const gemini = convertAdvancedCustomInbound(
    "openai_chat_completions_to_gemini_generate_content",
    "openai",
    {
      candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    },
    "gemini-2.5-flash",
  );
  assert.equal(gemini.object, "chat.completion");
  const geminiChoice = (gemini.choices as { message: { content: string } }[])[0];
  assert.equal(geminiChoice.message.content, "hello");

  const chatFromResponses = convertAdvancedCustomInbound(
    "openai_chat_completions_to_openai_responses",
    "openai",
    {
      id: "resp_1",
      object: "response",
      created_at: 123,
      status: "completed",
      model: "gpt-responses",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
    "gpt-responses",
    { requestId: "adv-chat" },
  );
  assert.equal(chatFromResponses.object, "chat.completion");
  const chatChoice = (chatFromResponses.choices as { message: { content: string }; finish_reason: string }[])[0];
  assert.equal(chatChoice.message.content, "hello");
  assert.equal(chatChoice.finish_reason, "stop");

  const responsesFromChat = convertAdvancedCustomInbound(
    "openai_responses_to_openai_chat_completions",
    "openai",
    {
      id: "chatcmpl-adv",
      object: "chat.completion",
      created: 123,
      model: "gpt-from-responses",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
    "gpt-from-responses",
    { requestId: "resp-adv", relayMode: "responses" },
  );
  assert.equal(responsesFromChat.object, "response");
  assert.equal(responsesFromChat.status, "completed");
  const output = responsesFromChat.output as { type: string; content?: { type: string; text: string }[] }[];
  const messageOut = output.find((item) => item.type === "message");
  if (!messageOut) throw new Error("missing responses message output");
  assert.equal(messageOut.content?.[0].type, "output_text");
  assert.equal(messageOut.content?.[0].text, "ok");

  const geminiResponses = convertAdvancedCustomInbound(
    "openai_responses_to_gemini_generate_content",
    "openai",
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "hello" }] },
        },
      ],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    },
    "gemini-test",
    { relayMode: "responses" },
  );
  assert.equal(geminiResponses.object, "response");
  const geminiOut = JSON.stringify(geminiResponses);
  assert.equal(geminiOut.includes('"type":"output_text"'), true);
  assert.equal(geminiOut.includes('"text":"hello"'), true);
  assert.equal(geminiOut.includes('"candidates"'), false);

  const none = convertAdvancedCustomInbound(
    "none",
    "openai",
    {
      id: "chatcmpl-adv",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    },
    "gpt-test",
  );
  assert.equal(none.object, "chat.completion");
  assert.equal((none.choices as { message: { content: string } }[])[0].message.content, "ok");

  assert.throws(
    () => convertAdvancedCustomInbound("not-a-converter", "openai", {}, "gpt-test"),
    /unsupported advanced custom converter: not-a-converter/,
  );

  const directGemini = geminiResponseToResponsesResponse(
    {
      candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    },
    "gemini-test",
    { id: "resp_gemini" },
  );
  assert.equal(directGemini.object, "response");
  assert.equal(JSON.stringify(directGemini).includes('"candidates"'), false);

  const chatRoundTrip = responsesResponseToChatCompletion(
    chatCompletionToResponsesResponse(
      {
        id: "chatcmpl_1",
        model: "gpt-test",
        created: 123,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      },
      "resp_1",
    ),
    "chatcmpl_1",
  );
  assert.equal(chatRoundTrip.object, "chat.completion");
  assert.equal((chatRoundTrip.choices as { message: { content: string } }[])[0].message.content, "hello");
});

test("original TaskPlugin ConvertOpenAIRequest is invalid api type -1", () => {
  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "doc-parse-v1", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
        { channelType: CHANNEL_TYPE_TASK_PLUGIN, originModelName: "doc-parse-v1", upstreamModelName: "doc-parse-v1" },
      ),
    /invalid api type: -1/,
  );
  assert.throws(
    () =>
      convertOpenAIResponsesRequest(
        { model: "doc-parse-v1", input: "hi" },
        { channelType: CHANNEL_TYPE_TASK_PLUGIN, originModelName: "doc-parse-v1", upstreamModelName: "doc-parse-v1" },
      ),
    /invalid api type: -1/,
  );
});

test("original Kling Vidu Sora DoubaoVideo ConvertOpenAIRequest uses OpenAI adaptor ChannelType", () => {
  for (const channelType of [CHANNEL_TYPE_KLING, CHANNEL_TYPE_VIDU, CHANNEL_TYPE_SORA, CHANNEL_TYPE_DOUBAO_VIDEO]) {
    const out = convertOpenAIRequest(
      {
        model: "video-model",
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true },
      },
      { channelType, originModelName: "video-model", upstreamModelName: "video-model" },
    );
    assert.equal(out.model, "video-model");
    assert.equal("stream_options" in out, false, `channel type ${channelType} must drop stream_options like openai.Adaptor`);
    assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
  }
});

test("original Ali GetRequestURL ConvertImageRequest image DoResponse rerank JSON and DashScope headers", async () => {
  assert.equal(isAliSyncImageModel("qwen-image-3.0-pro"), true);
  assert.equal(isAliSyncImageModel("wanx-v1"), false);
  assert.equal(supportsAliAnthropicMessages("qwen-plus"), true);
  assert.equal(supportsAliAnthropicMessages("deepseek-r1"), false);

  const base = "https://dashscope.aliyuncs.com";
  assert.equal(
    aliRequestURL(base, "images", "/v1/images/generations", "qwen-image-3.0-pro"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
  assert.equal(
    aliRequestURL(base, "images", "/v1/images/generations", "wanx-v1"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis",
  );
  assert.equal(
    aliRequestURL(base, "images", "/v1/images/edits", "wanx-v1"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis",
  );
  assert.equal(
    aliRequestURL(base, "images", "/v1/images/edits", "wan2.6"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation",
  );
  assert.equal(
    aliRequestURL(base, "rerank", "/v1/rerank", "gte-rerank-v2"),
    "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
  );
  assert.equal(
    aliRequestURL(base, "messages", "/v1/messages", "qwen-plus"),
    "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages",
  );
  assert.equal(
    aliRequestURL(base, "messages", "/v1/messages", "deepseek-r1"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(
    aliRequestURL(base, "responses", "/v1/responses", "qwen-plus"),
    "https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1/responses",
  );
  assert.equal(
    aliRequestURL(base, "chat", "/v1/chat/completions", "qwen-plus"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );

  const syncHeaders: Record<string, string> = {};
  applyAliHeaders(syncHeaders, {
    upstreamModel: "qwen-image-3.0-pro",
    requestPath: "/v1/images/generations",
    mode: "images",
  });
  assert.equal("X-DashScope-Async" in syncHeaders, false);
  const asyncHeaders: Record<string, string> = {};
  applyAliHeaders(asyncHeaders, {
    upstreamModel: "wanx-v1",
    requestPath: "/v1/images/generations",
    mode: "images",
  });
  assert.equal(asyncHeaders["X-DashScope-Async"], "enable");
  const streamHeaders: Record<string, string> = {};
  applyAliHeaders(streamHeaders, { isStream: true, upstreamModel: "qwen-plus", mode: "chat" });
  assert.equal(streamHeaders["X-DashScope-SSE"], "enable");

  const aliCh = testChannel({ type: CHANNEL_TYPE_ALI, key: "sk-ali", base_url: "", models: "qwen-image-3.0-pro" });
  const mappedImage = buildUpstream(
    aliCh,
    "images",
    "/v1/images/generations",
    "customer-image-model",
    { model: "customer-image-model", prompt: "poster" },
    {},
    "POST",
    { upstreamModel: "qwen-image-3.0-pro" },
  );
  assert.equal(
    mappedImage.url,
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
  assert.equal("X-DashScope-Async" in mappedImage.headers, false);
  assert.equal(mappedImage.headers.authorization, "Bearer sk-ali");

  const syncImage = convertOpenAIRequest(
    { model: "qwen-image-3.0-pro", prompt: "poster", size: "1024x1024" },
    {
      channelType: CHANNEL_TYPE_ALI,
      originModelName: "qwen-image-3.0-pro",
      upstreamModelName: "qwen-image-3.0-pro",
      relayMode: "images",
      requestPath: "/v1/images/generations",
    },
  );
  assert.equal(syncImage.model, "qwen-image-3.0-pro");
  assert.deepEqual(syncImage.input, { messages: [{ role: "user", content: [{ text: "poster" }] }] });
  assert.equal((syncImage.parameters as { n: number; size: string }).n, 1);
  assert.equal((syncImage.parameters as { size: string }).size, "1024*1024");

  const providerN = convertAliImageRequest(
    { model: "z-image", n: 2, parameters: { n: 4 }, prompt: "poster" },
    { upstreamModelName: "z-image", requestPath: "/v1/images/generations" },
  );
  assert.equal((providerN.parameters as { n: number }).n, 4);
  const inheritN = convertAliImageRequest(
    { model: "z-image", n: 2, parameters: {}, prompt: "poster" },
    { upstreamModelName: "z-image", requestPath: "/v1/images/generations" },
  );
  assert.equal((inheritN.parameters as { n: number }).n, 2);
  const asyncImage = convertAliImageRequest(
    { model: "wanx-v1", prompt: "poster" },
    { upstreamModelName: "wanx-v1", requestPath: "/v1/images/generations" },
  );
  assert.deepEqual(asyncImage.input, { prompt: "poster" });

  const rerank = convertAliRerankRequest(
    { model: "gte-rerank-v2", query: "q", documents: ["a", "b"], top_n: 2 },
    { upstreamModelName: "gte-rerank-v2" },
  );
  assert.deepEqual(rerank, {
    model: "gte-rerank-v2",
    input: { query: "q", documents: ["a", "b"] },
    parameters: { return_documents: true, top_n: 2 },
  });
  const rerankOut = openaiFromAliRerank({
    output: { results: [{ index: 0, relevance_score: 0.9 }] },
    usage: { total_tokens: 11 },
  });
  assert.deepEqual(rerankOut, {
    results: [{ index: 0, relevance_score: 0.9 }],
    usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 },
  });

  const imageUrl = "https://example.com/ali.png";
  const urlOut = await openaiFromAliImage(
    { output: { results: [{ url: imageUrl }] } },
    { created: 1, responseFormat: "url", isSync: true },
  );
  assert.equal(urlOut.created, 1);
  assert.deepEqual(urlOut.data, [{ url: imageUrl, b64_json: "", revised_prompt: "" }]);
  assert.deepEqual((urlOut.metadata as { output: unknown }).output, { results: [{ url: imageUrl }] });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), imageUrl);
    return new Response(Uint8Array.from([97, 108, 105]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const b64Out = await openaiFromAliImage(
      { output: { results: [{ url: imageUrl }] } },
      { created: 1, responseFormat: "b64_json", isSync: true },
    );
    assert.equal((b64Out.data as { url: string; b64_json: string }[])[0].url, imageUrl);
    assert.equal((b64Out.data as { b64_json: string }[])[0].b64_json, Buffer.from("ali").toString("base64"));
  } finally {
    globalThis.fetch = origFetch;
  }

  const pollOut = await openaiFromAliImage(
    { output: { task_id: "task-1" } },
    {
      created: 2,
      isSync: false,
      channelBase: base,
      channelKey: "sk-ali",
      sleep: async () => {},
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), `${base}/api/v1/tasks/task-1`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-ali");
        return new Response(
          JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{ url: imageUrl, b64_image: "YWE=" }] } }),
        );
      }) as typeof fetch,
    },
  );
  assert.deepEqual(pollOut.data, [{ url: imageUrl, b64_json: "YWE=", revised_prompt: "" }]);
});

test("original Ali multipart edits ConvertImageRequest uses validated provider quantity JSON", () => {
  const boundary = "----AliFormBoundary";
  const fixture = "fixture image";
  const expectedImage = `data:text/plain; charset=utf-8;base64,${Buffer.from(fixture).toString("base64")}`;
  function form(extraFields: Record<string, string>, fileField = "image") {
    const fields = {
      model: "fixture-image",
      n: "2",
      parameters: `{"n":3,"prompt_extend":false}`,
      ...extraFields,
    };
    const parts = Object.entries(fields).map(
      ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    );
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="input.png"\r\nContent-Type: application/octet-stream\r\n\r\n${fixture}\r\n`,
    );
    parts.push(`--${boundary}--\r\n`);
    const raw = parts.join("");
    return {
      buf: Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer,
      ct: `multipart/form-data; boundary=${boundary}`,
    };
  }
  for (const [name, model] of [
    ["multimodal edit", "qwen-image-edit-plus"],
    ["legacy Wan edit", "wanx-v1"],
  ] as const) {
    const { buf, ct } = form({});
    const request = aliImageRequestFromEditForm(parseAliImageEditForm(buf, ct).values);
    const converted = convertAliFormEditFromRaw(buf, ct, { upstreamModelName: model });
    assert.equal((converted.parameters as { n: number }).n, 3, name);
    assert.equal((converted.parameters as { prompt_extend: boolean }).prompt_extend, false, name);
    assert.equal(request.n, 2, "conversion must preserve the incoming request");
    if (model === "wanx-v1") {
      assert.deepEqual(converted.input, { prompt: "", images: [expectedImage] });
    } else {
      assert.deepEqual(converted.input, {
        messages: [{ role: "user", content: [{ image: expectedImage }, {}] }],
      });
    }
    assert.equal(converted.model, model);
  }

  const withPrompt = form({ prompt: "edit poster" });
  const multimodal = convertAliFormEditFromRaw(withPrompt.buf, withPrompt.ct, {
    upstreamModelName: "qwen-image-edit-plus",
  });
  assert.deepEqual((multimodal.input as { messages: { content: unknown }[] }).messages[0].content, [
    { image: expectedImage },
    { text: "edit poster" },
  ]);

  const arrayField = form({}, "image[]");
  const fromArray = convertAliFormEditFromRaw(arrayField.buf, arrayField.ct, {
    upstreamModelName: "qwen-image-edit-plus",
  });
  assert.equal(
    (fromArray.input as { messages: { content: { image?: string }[] }[] }).messages[0].content[0].image,
    expectedImage,
  );

  const indexed = form({}, "image[0]");
  const fromIndexed = convertAliFormEditFromRaw(indexed.buf, indexed.ct, {
    upstreamModelName: "qwen-image-edit-plus",
  });
  assert.equal(
    (fromIndexed.input as { messages: { content: { image?: string }[] }[] }).messages[0].content[0].image,
    expectedImage,
  );

  const noImage =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nfixture-image\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n2\r\n` +
    `--${boundary}--\r\n`;
  const emptyBuf = Uint8Array.from(noImage, (c) => c.charCodeAt(0)).buffer;
  const emptyCt = `multipart/form-data; boundary=${boundary}`;
  assert.throws(
    () => convertAliFormEditFromRaw(emptyBuf, emptyCt, { upstreamModelName: "qwen-image-edit-plus" }),
    /convert image edit form request failed: get image base64s from form failed: image is required/,
  );
  assert.throws(
    () => convertAliFormEditFromRaw(emptyBuf, emptyCt, { upstreamModelName: "wanx-v1" }),
    (err: unknown) => {
      assert.equal((err as Error).message, "get image base64s from form failed: image is required");
      return true;
    },
  );
});

test("original ChatCompletionsStreamToResponsesEvents aggregates usage and tool args", () => {
  const state = newChatToResponsesStreamState("resp_1", "gpt-test", { created: 123 });
  const events = [
    ...chatCompletionsStreamChunkToResponsesEvents(
      { id: "chatcmpl_1", model: "gpt-test", created: 123, choices: [{ index: 0, delta: { role: "assistant" } }] },
      state,
    ),
    ...chatCompletionsStreamChunkToResponsesEvents(
      { choices: [{ index: 0, delta: { content: "hello" } }] },
      state,
    ),
    ...chatCompletionsStreamChunkToResponsesEvents(
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup" } }] },
          },
        ],
      },
      state,
    ),
    ...chatCompletionsStreamChunkToResponsesEvents(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] } }] },
      state,
    ),
    ...chatCompletionsStreamChunkToResponsesEvents(
      { choices: [{ index: 0, finish_reason: "tool_calls" }] },
      state,
    ),
    ...chatCompletionsStreamChunkToResponsesEvents(
      { usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } },
      state,
    ),
    ...finalizeChatCompletionsStreamToResponses(state),
  ];
  assert.equal(events.length, 10);
  assert.equal(events[0].type, "response.created");
  assert.equal(events[2].type, "response.output_text.delta");
  assert.equal(events[2].payload.delta, "hello");
  assert.equal(events[4].type, "response.function_call_arguments.delta");
  assert.equal(events[4].payload.delta, '{"q":"x"}');
  assert.equal(events[9].type, "response.completed");
  const completed = events[9].payload.response as { usage: { total_tokens: number }; output: { content?: { text: string }[]; arguments?: string }[] };
  assert.equal(completed.usage.total_tokens, 6);
  assert.equal(completed.output.length, 2);
  assert.equal((completed.output[0].content as { text: string }[])[0].text, "hello");
  assert.equal(completed.output[1].arguments, '{"q":"x"}');
});

test("original ResponsesStreamEventToChatChunks uses output_index for tool arguments", () => {
  const state = newResponsesToChatStreamState("gpt-test", false, { id: "chatcmpl_test", created: 123 });
  const chunks = [
    ...responsesStreamEventToChatChunks({ type: "response.created" }, state),
    ...responsesStreamEventToChatChunks({ type: "response.output_text.delta", delta: "text before tool" }, state),
    ...responsesStreamEventToChatChunks({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '{"cmd":"ls"}',
    }, state),
    ...responsesStreamEventToChatChunks(
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec" },
      },
      state,
    ),
    ...responsesStreamEventToChatChunks(
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      },
      state,
    ),
  ];
  assert.equal(chunks.length, 4);
  assert.equal((chunks[0].choices as { delta: { role: string } }[])[0].delta.role, "assistant");
  assert.equal((chunks[1].choices as { delta: { content: string } }[])[0].delta.content, "text before tool");
  const tool = (chunks[2].choices as { delta: { tool_calls: { index: number; id: string; function: { name: string; arguments: string } }[] } }[])[0].delta.tool_calls[0];
  assert.equal(tool.index, 0);
  assert.equal(tool.id, "call_1");
  assert.equal(tool.function.name, "exec");
  assert.equal(tool.function.arguments, '{"cmd":"ls"}');
  assert.equal((chunks[3].choices as { finish_reason: string }[])[0].finish_reason, "tool_calls");
  assert.equal(state.usage.total_tokens, 3);
  void finalizeResponsesToChatStream(state);
});

test("original ResponsesStreamEventToChatChunks does not duplicate pending args with output_index and item_id", () => {
  const state = newResponsesToChatStreamState("gpt-test", false, { id: "chatcmpl_test" });
  const chunks = [
    ...responsesStreamEventToChatChunks({ type: "response.created" }, state),
    ...responsesStreamEventToChatChunks({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc_1",
      delta: '{"q":"x"}',
    }, state),
    ...responsesStreamEventToChatChunks(
      {
        type: "response.output_item.added",
        output_index: 1,
        item_id: "fc_1",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" },
      },
      state,
    ),
  ];
  assert.equal(chunks.length, 2);
  const tool = (chunks[1].choices as { delta: { tool_calls: { id: string; function: { name: string; arguments: string } }[] } }[])[0].delta.tool_calls[0];
  assert.equal(tool.id, "call_1");
  assert.equal(tool.function.name, "lookup");
  assert.equal(tool.function.arguments, '{"q":"x"}');
  assert.equal(state.pendingArgsByOutputIndexForTest.size, 0);
  assert.equal(state.pendingArgsByItemIdForTest.size, 0);
});

test("original OaiResponsesToChatStreamHandler SSE order and usage JSON", () => {
  const body = [
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-test","created_at":1710000000}}`,
    `data: {"type":"response.output_text.delta","delta":"hello"}`,
    `data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup"}}`,
    `data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"q\\":\\"x\\"}"}`,
    `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`,
    `data: [DONE]`,
    ``,
  ].join("\n");
  const out = oaiResponsesSseToChatSse(body, {
    id: "chatcmpl-responses-test",
    model: "gpt-test",
    created: 1710000000,
    includeUsage: true,
  });
  assert.ok(out.sse.includes('"role":"assistant"'));
  assert.ok(out.sse.includes('"content":"hello"'));
  assert.ok(out.sse.includes('"name":"lookup"'));
  assert.ok(out.sse.includes('"arguments":"{\\"q\\":\\"x\\"}"'));
  assert.ok(out.sse.includes('"finish_reason":"tool_calls"'));
  assert.ok(out.sse.includes('"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5'));
  assert.ok(out.sse.includes("data: [DONE]"));
  const order = [
    '"role":"assistant"',
    '"content":"hello"',
    '"name":"lookup"',
    '"arguments":"{\\"q\\":\\"x\\"}"',
    '"finish_reason":"tool_calls"',
    '"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5',
    "data: [DONE]",
  ];
  let from = 0;
  for (const part of order) {
    const at = out.sse.indexOf(part, from);
    assert.notEqual(at, -1, `missing ${part}`);
    from = at + part.length;
  }
  assert.equal((out.usageBody.usage as { prompt_tokens: number }).prompt_tokens, 2);
});

test("original OaiChatToResponsesStreamHandler SSE events include sequence_number", () => {
  const body = [
    `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [{ index: 0, delta: { content: "ok" } }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}`,
    `data: [DONE]`,
    ``,
  ].join("\n");
  const out = oaiChatSseToResponsesSse(body, { id: "chatcmpl-responses-test", model: "gpt-from-responses", created: 123 });
  assert.match(out.sse, /event: response\.created/);
  assert.match(out.sse, /"sequence_number":0/);
  assert.match(out.sse, /"delta":"ok"/);
  assert.match(out.sse, /event: response\.output_text\.delta/);
  assert.match(out.sse, /event: response\.completed/);
  assert.match(out.sse, /"status":"completed"/);
  assert.match(out.sse, /"text":"ok"/);
  assert.equal((out.usageBody.usage as { total_tokens: number }).total_tokens, 3);
});

test("original OpenAI Responses → Claude Messages request/response/stream JSON fields", () => {
  assert.throws(
    () => convertOpenAIResponsesRequestToClaudeMessages({ input: "hello", max_output_tokens: 16 }),
    /model is required/,
  );
  assert.throws(
    () =>
      convertOpenAIResponsesRequestToClaudeMessages({
        model: "gpt-test",
        input: "hello",
        max_output_tokens: 16,
        previous_response_id: "resp_prev",
      }),
    /responses to chat conversion does not support stateful fields: previous_response_id/,
  );

  const converted = convertOpenAIResponsesRequest(
    {
      model: "gpt-test",
      stream: true,
      max_output_tokens: 1024,
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is in this image?" }],
        },
        { type: "function_call", call_id: "call_abc", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
        { type: "function_call_output", call_id: "call_abc", output: "15 degrees" },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather by city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    },
    {
      channelType: CHANNEL_TYPE_ANTHROPIC,
      originModelName: "gpt-test",
      upstreamModelName: "gpt-test",
    },
  );
  assert.equal(converted.model, "gpt-test");
  assert.equal(converted.max_tokens, 1024);
  assert.equal(converted.stream, true);
  const system = converted.system as { type: string; text: string }[];
  assert.equal(system.length, 1);
  assert.equal(system[0].type, "text");
  assert.equal(system[0].text, "You are a helpful assistant.");
  const messages = converted.messages as { role: string; content: Record<string, unknown>[] }[];
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content[0].type, "text");
  assert.equal(messages[0].content[0].text, "What is in this image?");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content[0].type, "tool_use");
  assert.equal(messages[1].content[0].id, "call_abc");
  assert.equal(messages[1].content[0].name, "get_weather");
  assert.deepEqual(messages[1].content[0].input, { city: "Paris" });
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content[0].type, "tool_result");
  assert.equal(messages[2].content[0].tool_use_id, "call_abc");
  assert.equal(messages[2].content[0].content, "15 degrees");
  const tools = converted.tools as { name: string; description: string; input_schema: Record<string, unknown> }[];
  assert.equal(tools[0].name, "get_weather");
  assert.equal(tools[0].description, "Get weather by city");
  assert.equal(tools[0].input_schema.type, "object");

  const withImage = convertOpenAIResponsesRequestToClaudeMessages(
    {
      model: "gpt-test",
      max_output_tokens: 1024,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "What is in this image?" },
            { type: "input_image", image_url: "https://example.com/cat.png" },
          ],
        },
      ],
    },
    { resolveMedia: () => ({ data: "aGVsbG8=", mime: "image/png" }) },
  );
  const userParts = (withImage.messages as { content: Record<string, unknown>[] }[])[0].content;
  assert.equal(userParts[1].type, "image");
  assert.deepEqual(userParts[1].source, { type: "base64", media_type: "image/png", data: "aGVsbG8=" });

  const prepended = convertOpenAIResponsesRequestToClaudeMessages({
    model: "gpt-test",
    max_output_tokens: 32,
    input: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" }],
  });
  const prependedMessages = prepended.messages as { role: string; content: { type: string; text?: string }[] }[];
  assert.equal(prependedMessages[0].role, "user");
  assert.equal(prependedMessages[0].content[0].text, "...");
  assert.equal(prependedMessages[1].role, "assistant");
  assert.equal(prependedMessages[1].content[0].type, "tool_use");

  const claudeResp = responsesResponseToClaudeMessagesResponse({
    id: "resp_fixed",
    object: "response",
    model: "gpt-test",
    status: "completed",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Deep thought." }] },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "The answer is 42.",
            annotations: [{ type: "url_citation", url: "https://example.com", title: "Doc", start_index: 4, end_index: 10 }],
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: "{\"city\":\"Paris\"}",
        status: "completed",
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
  assert.equal(claudeResp.id, "resp_fixed");
  assert.equal(claudeResp.type, "message");
  assert.equal(claudeResp.role, "assistant");
  assert.equal(claudeResp.model, "gpt-test");
  assert.equal(claudeResp.stop_reason, "tool_use");
  const content = claudeResp.content as {
    type: string;
    thinking?: string;
    text?: string;
    citations?: { type: string; url: string; cited_text?: string }[];
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }[];
  assert.equal(content[0].type, "thinking");
  assert.equal(content[0].thinking, "Deep thought.");
  assert.equal(content[1].type, "text");
  assert.equal(content[1].text, "The answer is 42.");
  assert.equal(content[1].citations?.[0].type, "web_search_result_location");
  assert.equal(content[1].citations?.[0].url, "https://example.com");
  assert.equal(content[1].citations?.[0].cited_text, "answer");
  assert.equal(content[2].type, "tool_use");
  assert.equal(content[2].id, "call_abc");
  assert.equal(content[2].name, "get_weather");
  assert.deepEqual(content[2].input, { city: "Paris" });
  const usage = claudeResp.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    billing_usage: { source: string; semantic: string; openai_usage: { prompt_tokens: number; input_tokens: number; output_tokens: number; total_tokens: number } };
  };
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 5);
  assert.equal(usage.cache_creation_input_tokens, 0);
  assert.equal(usage.cache_read_input_tokens, 0);
  assert.equal(usage.billing_usage.source, "oai_responses");
  assert.equal(usage.billing_usage.semantic, "openai");
  assert.equal(usage.billing_usage.openai_usage.prompt_tokens, 0);
  assert.equal(usage.billing_usage.openai_usage.input_tokens, 10);
  assert.equal(usage.billing_usage.openai_usage.output_tokens, 5);
  assert.equal(usage.billing_usage.openai_usage.total_tokens, 15);

  const state = new ResponsesToClaudeStreamState("", "");
  const argumentsText = "{\"q\":\"x\"}";
  const reasoningItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }] };
  const messageItem = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: "hello" }],
  };
  const toolItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: argumentsText };
  const events = [
    { type: "response.created", response: { id: "resp_1", model: "gpt-test" } },
    { type: "response.output_item.added", output_index: 0, item_id: "rs_1", item: { type: "reasoning", id: "rs_1" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_1", delta: "plan" },
    { type: "response.reasoning_summary_text.done", output_index: 0, item_id: "rs_1", text: "plan" },
    { type: "response.output_item.done", output_index: 0, item_id: "rs_1", item: reasoningItem },
    { type: "response.output_item.added", output_index: 1, item_id: "msg_1", item: { type: "message", id: "msg_1", role: "assistant" } },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", delta: "hello" },
    { type: "response.output_text.done", output_index: 1, item_id: "msg_1", text: "hello" },
    { type: "response.output_item.done", output_index: 1, item_id: "msg_1", item: messageItem },
    { type: "response.output_item.added", output_index: 2, item_id: "fc_1", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" } },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: "{\"q\":" },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: "\"x\"}" },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_1", arguments: argumentsText },
    { type: "response.output_item.done", output_index: 2, item_id: "fc_1", item: toolItem },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-test",
        status: "completed",
        output: [reasoningItem, messageItem, toolItem],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    },
  ];
  const output: Record<string, unknown>[] = [];
  for (const event of events) output.push(...state.convertChunk(event, 9));
  const ofType = (type: string) => output.filter((item) => item.type === type);
  assert.equal(ofType("message_start").length, 1);
  assert.equal(ofType("content_block_start").length, 3);
  assert.equal(ofType("content_block_stop").length, 3);
  assert.equal(ofType("message_delta").length, 1);
  assert.equal(ofType("message_stop").length, 1);
  assert.deepEqual(
    ofType("content_block_start").map((item) => item.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    ofType("content_block_start").map((item) => (item.content_block as { type: string }).type),
    ["thinking", "text", "tool_use"],
  );
  const joined = (deltaType: string) =>
    ofType("content_block_delta")
      .filter((item) => (item.delta as { type?: string }).type === deltaType)
      .map((item) => {
        const delta = item.delta as { thinking?: string; text?: string; partial_json?: string };
        return delta.thinking || delta.text || delta.partial_json || "";
      })
      .join("");
  assert.equal(joined("thinking_delta"), "plan");
  assert.equal(joined("text_delta"), "hello");
  assert.equal(joined("input_json_delta"), argumentsText);
  assert.equal((ofType("message_delta")[0].delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.deepEqual(state.finalize(9), []);
  assert.deepEqual(state.convertChunk(events[events.length - 1], 9), []);

  const sse = oaiResponsesSseToClaudeSse(
    [
      `data: {"type":"response.output_text.delta","delta":"Hello"}`,
      `data: {"type":"response.output_text.delta","delta":" world"}`,
      `data: {"type":"response.completed","response":{"id":"resp_fixed","object":"response","status":"completed","model":"gpt-test","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}`,
      ``,
    ].join("\n\n"),
    { id: "stream_fixed", model: "stream-model" },
  );
  assert.equal(sse.events[0].type, "message_start");
  assert.equal((sse.events[0].message as { id: string; role: string; content: unknown[] }).id, "stream_fixed");
  assert.equal((sse.events[0].message as { model: string }).model, "stream-model");
  assert.equal((sse.events[0].message as { role: string }).role, "assistant");
  assert.equal((sse.events[0].message as { usage: { input_tokens: number; output_tokens: number } }).usage.input_tokens, 0);
  assert.equal(sse.events.some((item) => item.type === "content_block_start"), true);
  assert.equal(sse.events.some((item) => item.type === "content_block_delta" && (item.delta as { type: string }).type === "text_delta"), true);
  assert.equal(sse.events.some((item) => item.type === "message_delta"), true);
  assert.equal(sse.events[sse.events.length - 1].type, "message_stop");
  const streamDelta = sse.events.find((item) => item.type === "message_delta") as {
    usage: { input_tokens: number; output_tokens: number; billing_usage: { source: string; openai_usage: { prompt_tokens: number; input_tokens: number } } };
    delta: { stop_reason: string };
  };
  assert.equal(streamDelta.delta.stop_reason, "end_turn");
  assert.equal(streamDelta.usage.input_tokens, 4);
  assert.equal(streamDelta.usage.output_tokens, 2);
  assert.equal(streamDelta.usage.billing_usage.source, "oai_responses");
  assert.equal(streamDelta.usage.billing_usage.openai_usage.prompt_tokens, 0);
  assert.equal(streamDelta.usage.billing_usage.openai_usage.input_tokens, 4);
  assert.match(sse.sse, /event: message_start/);
  assert.match(sse.sse, /"stop_reason":"end_turn"/);

  const anthropicUp = buildUpstream(
    testChannel({ type: CHANNEL_TYPE_ANTHROPIC, key: "sk-ant", base_url: "https://api.anthropic.com", models: "gpt-test" }),
    "responses",
    "/v1/responses",
    "gpt-test",
    converted,
  );
  assert.equal(anthropicUp.url, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropicUp.headers["x-api-key"], "sk-ant");
  assert.equal(anthropicUp.headers["anthropic-version"], "2023-06-01");

  assert.throws(
    () =>
      convertOpenAIResponsesRequest(
        { model: "gpt-test", input: "hello" },
        {
          channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
          originModelName: "gpt-test",
          upstreamModelName: "gpt-test",
          converter: "openai_responses_to_claude_messages",
        },
      ),
    /converter "openai_responses_to_claude_messages" does not support OpenAI Responses requests/,
  );
});

test("original Claude Messages → OpenAI Responses request JSON fields", () => {
  assert.throws(() => convertClaudeMessagesToOpenAIResponses({ messages: [{ role: "user", content: "hello" }] }), /model is required/);
  assert.throws(
    () =>
      convertAdvancedCustomClaudeRequest(
        { model: "gpt-test", messages: [{ role: "user", content: "hello" }] },
        {
          channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
          originModelName: "gpt-test",
          upstreamModelName: "gpt-test",
          converter: CONVERTER_CLAUDE_TO_RESPONSES,
        },
      ),
    /converter "claude_messages_to_openai_responses" does not support Anthropic Messages requests/,
  );

  const mixed = convertClaudeMessagesToOpenAIResponses(
    {
      model: "gpt-test",
      system: [
        { type: "text", text: "system " },
        { type: "text", text: "rules" },
      ],
      max_tokens: 4096,
      stream: true,
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
          strict: true,
        },
      ],
      tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
      messages: [
        { role: "user", content: [{ type: "text", text: "question" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
            { type: "text", text: "after" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "result" },
            { type: "text", text: "continue" },
          ],
        },
      ],
    },
    { originModelName: "gpt-test", upstreamModelName: "gpt-test" },
  );
  assert.equal(mixed.model, "gpt-test");
  assert.equal(mixed.max_output_tokens, 4096);
  assert.equal(mixed.stream, true);
  assert.equal(mixed.instructions, "system rules");
  assert.equal(mixed.context_management, undefined);
  assert.deepEqual(mixed.tools, [
    {
      type: "function",
      name: "lookup",
      description: "Look up a value",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      strict: true,
    },
  ]);
  assert.deepEqual(mixed.tool_choice, { type: "function", name: "lookup" });
  assert.equal(mixed.parallel_tool_calls, false);
  const input = mixed.input as Record<string, unknown>[];
  assert.equal(input.length, 6);
  assert.equal(input[0].role, "user");
  assert.deepEqual(input[0].content, [{ type: "input_text", text: "question" }]);
  assert.equal(input[1].role, "assistant");
  assert.deepEqual(input[1].content, [{ type: "output_text", text: "before" }]);
  assert.equal(input[2].type, "function_call");
  assert.equal(input[2].call_id, "call_1");
  assert.equal(input[2].name, "lookup");
  assert.equal(input[2].arguments, '{"q":"x"}');
  assert.equal(input[3].role, "assistant");
  assert.deepEqual(input[3].content, [{ type: "output_text", text: "after" }]);
  assert.equal(input[4].type, "function_call_output");
  assert.equal(input[4].call_id, "call_1");
  assert.equal(input[4].output, "result");
  assert.equal(input[5].role, "user");
  assert.deepEqual(input[5].content, [{ type: "input_text", text: "continue" }]);

  const stringUser = convertClaudeMessagesToOpenAIResponses({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    metadata: { user_id: "u1" },
    temperature: 0.2,
    top_p: 0.9,
    service_tier: "default",
  });
  assert.deepEqual((stringUser.input as Record<string, unknown>[])[0], { role: "user", content: "hello" });
  assert.equal(stringUser.tool_choice, "required");
  assert.equal(stringUser.parallel_tool_calls, false);
  assert.deepEqual(stringUser.metadata, { user_id: "u1" });
  assert.equal(stringUser.temperature, 0.2);
  assert.equal(stringUser.top_p, 0.9);
  assert.equal(stringUser.service_tier, "default");

  const media = convertClaudeMessagesToOpenAIResponses({
    model: "gpt-test",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAA" } },
          { type: "tool_result", tool_use_id: "call_img", content: [{ type: "text", text: "ok" }] },
        ],
      },
    ],
  });
  const mediaInput = media.input as Record<string, unknown>[];
  assert.equal(mediaInput[0].role, "user");
  assert.deepEqual(mediaInput[0].content, [
    { type: "input_image", image_url: "https://example.com/a.png" },
    { type: "input_file", file_data: "data:application/pdf;base64,AAA" },
  ]);
  assert.equal(mediaInput[1].type, "function_call_output");
  assert.deepEqual(mediaInput[1].output, [{ type: "input_text", text: "ok" }]);

  const thinking = convertClaudeMessagesToOpenAIResponses(
    {
      model: "gpt-5.6-sol",
      thinking: { type: "adaptive", display: "summarized" },
      messages: [{ role: "user", content: "hello" }],
    },
    { originModelName: "gpt-5.6-sol", upstreamModelName: "gpt-5.6-sol" },
  );
  const reasoning = thinking.reasoning as { effort: string; summary: string };
  assert.equal(reasoning.effort, "high");
  assert.equal(reasoning.summary, "detailed");

  const explicitLow = convertClaudeMessagesToOpenAIResponses(
    {
      model: "gpt-5.6-sol",
      output_config: { effort: "low" },
      thinking: { type: "adaptive", display: "summarized" },
      messages: [{ role: "user", content: "hello" }],
    },
    { originModelName: "gpt-5.6-sol", upstreamModelName: "gpt-5.6-sol" },
  );
  assert.equal((explicitLow.reasoning as { effort: string }).effort, "low");

  const suffixed = convertClaudeMessagesToOpenAIResponses(
    { model: "gpt-test", messages: [{ role: "user", content: "hello" }] },
    { originModelName: "gpt-test-thinking", upstreamModelName: "gpt-test" },
  );
  assert.equal(suffixed.model, "gpt-test-thinking");
  const openRouter = convertClaudeMessagesToOpenAIResponses(
    { model: "gpt-test", messages: [{ role: "user", content: "hello" }] },
    { originModelName: "gpt-test-thinking", upstreamModelName: "gpt-test", openRouterDialect: true },
  );
  assert.equal(openRouter.model, "gpt-test");

  const via = convertTextRequestViaResponses(
    {
      model: "gpt-5.6-sol",
      thinking: { type: "adaptive", display: "summarized" },
      messages: [{ role: "user", content: "hello" }],
    },
    "anthropic",
    {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-5.6-sol",
      upstreamModelName: "gpt-5.6-sol",
    },
  );
  assert.equal(via.messages, undefined);
  assert.equal((via.input as Record<string, unknown>[])[0].content, "hello");
  assert.equal((via.reasoning as { effort: string; summary: string }).effort, "high");
  assert.equal((via.reasoning as { effort: string; summary: string }).summary, "detailed");

  const viaTier = convertTextRequestViaResponses(
    {
      model: "gpt-5.6-sol",
      service_tier: "flex",
      messages: [{ role: "user", content: "hello" }],
    },
    "anthropic",
    {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-5.6-sol",
      upstreamModelName: "gpt-5.6-sol",
    },
  );
  assert.equal("service_tier" in viaTier, false);

  const viaStore = convertTextRequestViaResponses(
    {
      model: "gpt-4o",
      store: true,
      safety_identifier: "user-123",
      messages: [{ role: "user", content: "hi" }],
    },
    "openai",
    {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-4o",
      upstreamModelName: "gpt-4o",
    },
  );
  assert.equal(viaStore.store, true);
  assert.equal("safety_identifier" in viaStore, false);

  const viaDisableStore = convertTextRequestViaResponses(
    {
      model: "gpt-4o",
      store: true,
      messages: [{ role: "user", content: "hi" }],
    },
    "openai",
    {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-4o",
      upstreamModelName: "gpt-4o",
      channelOtherSettings: { disable_store: true },
    },
  );
  assert.equal("store" in viaDisableStore, false);

  const viaChatOverride = convertTextRequestViaResponses(
    {
      model: "gpt-4o",
      max_tokens: 16,
      temperature: 0.9,
      messages: [{ role: "user", content: "hello" }],
    },
    "openai",
    {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-4o",
      upstreamModelName: "gpt-4o",
      applyViaResponsesChatParamOverride: (chat) => {
        const messages = [...((chat.messages as Record<string, unknown>[]) || [])];
        messages[0] = { ...messages[0], content: "overridden-chat" };
        return { ...chat, messages, max_tokens: 32, temperature: 0.1 };
      },
    },
  );
  assert.equal(viaChatOverride.messages, undefined);
  assert.equal((viaChatOverride.input as { content?: string }[])[0].content, "overridden-chat");
  assert.equal(viaChatOverride.max_output_tokens, 32);
  assert.equal("max_tokens" in viaChatOverride, false);
  assert.equal(viaChatOverride.temperature, 0.1);

  assert.doesNotThrow(() =>
    convertTextRequestViaResponses(
      { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
      "anthropic",
      {
        channelType: CHANNEL_TYPE_OPENAI,
        originModelName: "gpt-4o",
        upstreamModelName: "gpt-4o",
        applyViaResponsesChatParamOverride: () => {
          throw new Error("claude via-responses must not apply chat param override");
        },
      },
    ),
  );
  const viaClaudeSkip = convertTextRequestViaResponses(
    { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
    "anthropic",
    {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-4o",
      upstreamModelName: "gpt-4o",
      applyViaResponsesChatParamOverride: (chat) => ({ ...chat, messages: [{ role: "user", content: "should-not-apply" }] }),
    },
  );
  assert.equal((viaClaudeSkip.input as { content?: string }[])[0].content, "hello");
  assert.equal(viaClaudeSkip.max_output_tokens, 16);

  const openaiUp = buildUpstream(
    testChannel({ type: CHANNEL_TYPE_OPENAI, key: "sk-test", base_url: "https://api.openai.com", models: "gpt-5.6-sol" }),
    "responses",
    "/v1/responses",
    "gpt-5.6-sol",
    via,
    {},
    "POST",
    { relayFormat: "claude" },
  );
  assert.equal(openaiUp.url, "https://api.openai.com/v1/responses");

  assert.equal(
    shouldChatCompletionsUseResponsesPolicy({ enabled: false, all_channels: true, model_patterns: [".*"] }, 1, CHANNEL_TYPE_OPENAI, "gpt-5.6-sol"),
    false,
  );
  assert.equal(
    shouldChatCompletionsUseResponsesPolicy(
      { enabled: true, all_channels: true, model_patterns: ["gpt-5\\.6-sol"] },
      1,
      CHANNEL_TYPE_OPENAI,
      "gpt-5.6-sol",
    ),
    true,
  );
  assert.equal(
    shouldChatCompletionsUseResponsesPolicy(
      { enabled: true, all_channels: false, channel_ids: [9], model_patterns: [".*"] },
      1,
      CHANNEL_TYPE_OPENAI,
      "gpt-5.6-sol",
    ),
    false,
  );
  assert.equal(
    shouldChatCompletionsUseResponsesPolicy(
      { enabled: true, all_channels: false, channel_types: [CHANNEL_TYPE_OPENAI], model_patterns: ["gpt-.*"] },
      1,
      CHANNEL_TYPE_OPENAI,
      "gpt-5.6-sol",
    ),
    true,
  );
});

test("original OpenAI Responses → Gemini generateContent request JSON fields", () => {
  assert.throws(() => convertOpenAIResponsesRequestToGeminiChat({ input: "hello" }), /model is required/);
  assert.throws(
    () =>
      convertOpenAIResponsesRequestToGeminiChat({
        model: "gemini-test",
        input: "hello",
        previous_response_id: "resp_prev",
      }),
    /responses to chat conversion does not support stateful fields: previous_response_id/,
  );

  const instructions = convertOpenAIResponsesRequestToGeminiChat({
    model: "gemini-test",
    instructions: "system rules",
    input: "hello",
  });
  assert.deepEqual(instructions.systemInstruction, { parts: [{ text: "system rules" }] });
  const instructionContents = instructions.contents as { role: string; parts: { text: string }[] }[];
  assert.equal(instructionContents.length, 1);
  assert.equal(instructionContents[0].role, "user");
  assert.equal(instructionContents[0].parts[0].text, "hello");

  const toolsAndChoice = convertOpenAIResponsesRequestToGeminiChat({
    model: "gemini-test",
    input: "lookup weather",
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Lookup data",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
      { type: "custom", name: "freeform" },
    ],
    tool_choice: { type: "function", name: "lookup" },
  });
  const geminiTools = toolsAndChoice.tools as { functionDeclarations: { name: string; description: string }[] }[];
  assert.equal(geminiTools.length, 1);
  assert.equal(geminiTools[0].functionDeclarations[0].name, "lookup");
  assert.equal(geminiTools[0].functionDeclarations[0].description, "Lookup data");
  assert.deepEqual(toolsAndChoice.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
  });

  const conversation = convertOpenAIResponsesRequest(
    {
      model: "gemini-test",
      max_output_tokens: 256,
      instructions: "system rules",
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "I will call." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: { q: "x" },
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: { ok: true },
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup data",
          parameters: {
            type: "object",
            additionalProperties: false,
            propertyNames: { pattern: "^[a-z]+$" },
            properties: {
              q: { type: "string", exclusiveMinimum: 0 },
              filters: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        },
      ],
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    },
    {
      channelType: CHANNEL_TYPE_GEMINI,
      originModelName: "gemini-test",
      upstreamModelName: "gemini-test",
    },
  );
  assert.deepEqual(conversation.systemInstruction, { parts: [{ text: "system rules" }] });
  const gc = conversation.generationConfig as { responseMimeType: string; maxOutputTokens: number };
  assert.equal(gc.responseMimeType, "application/json");
  assert.equal(gc.maxOutputTokens, 256);
  const lookupParams = (conversation.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[])[0]
    .functionDeclarations[0].parameters;
  assert.equal(lookupParams.type, "OBJECT");
  assert.equal("additionalProperties" in lookupParams, false);
  assert.equal("propertyNames" in lookupParams, false);
  const queryParam = (lookupParams.properties as Record<string, Record<string, unknown>>).q;
  assert.equal(queryParam.type, "STRING");
  assert.equal("exclusiveMinimum" in queryParam, false);
  const filterItems = ((lookupParams.properties as Record<string, Record<string, unknown>>).filters.items as Record<string, unknown>);
  assert.equal("additionalProperties" in filterItems, false);

  const convoContents = conversation.contents as {
    role: string;
    parts: { functionCall?: { name: string; args: Record<string, unknown>; id?: string }; text?: string; thoughtSignature?: string; functionResponse?: { name: string; response: Record<string, unknown> } }[];
  }[];
  assert.equal(convoContents.length, 2);
  assert.equal(convoContents[0].role, "model");
  assert.equal(convoContents[0].parts.length, 2);
  assert.equal(convoContents[0].parts[0].functionCall?.name, "lookup");
  assert.deepEqual(convoContents[0].parts[0].functionCall?.args, { q: "x" });
  assert.equal(convoContents[0].parts[0].functionCall?.id, "call_1");
  assert.equal(convoContents[0].parts[0].thoughtSignature, GEMINI_THOUGHT_SIGNATURE_BYPASS);
  assert.equal(convoContents[0].parts[1].text, "I will call.");
  assert.equal(convoContents[1].role, "user");
  assert.equal(convoContents[1].parts[0].functionResponse?.name, "lookup");
  assert.deepEqual(convoContents[1].parts[0].functionResponse?.response, { ok: true });
  assert.equal(convoContents[1].parts[0].thoughtSignature, undefined);

  const skipped = convertOpenAIResponsesRequestToGeminiChat({
    model: "gemini-test",
    input: [
      { role: "assistant", content: [{ type: "output_text", text: "before custom" }] },
      { type: "custom_tool_call", call_id: "call_custom", name: "apply_patch", input: "patch body" },
      { type: "custom_tool_call_output", call_id: "call_custom", output: "ok" },
      { type: "function_call_output", call_id: "call_custom", output: "legacy custom output" },
      { role: "user", content: "next turn" },
    ],
    tools: [
      { type: "custom", name: "apply_patch" },
      { type: "unknown", name: "unknown" },
    ],
  });
  assert.equal(skipped.tools, undefined);
  const skippedContents = skipped.contents as { role: string; parts: { text?: string; functionCall?: unknown; functionResponse?: unknown }[] }[];
  assert.equal(skippedContents.length, 2);
  assert.equal(skippedContents[0].role, "model");
  assert.equal(skippedContents[0].parts.length, 1);
  assert.equal(skippedContents[0].parts[0].text, "before custom");
  assert.equal(skippedContents[0].parts[0].functionCall, undefined);
  assert.equal(skippedContents[1].role, "user");
  assert.equal(skippedContents[1].parts[0].text, "next turn");
  assert.equal(skippedContents[1].parts[0].functionResponse, undefined);

  const noSignature = convertOpenAIResponsesRequestToGeminiChat(
    {
      model: "gemini-test",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: { q: "x" } }],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    },
    { settings: { geminiFunctionCallThoughtSignatureEnabled: false } },
  );
  const noSigParts = (noSignature.contents as { parts: { thoughtSignature?: string }[] }[])[0].parts;
  assert.equal(noSigParts[0].thoughtSignature, undefined);

  const inbound = geminiResponseToResponsesResponse(
    {
      candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    },
    "gemini-test",
    { id: "resp_gemini" },
  );
  assert.equal(inbound.object, "response");
  assert.equal(inbound.model, "gemini-test");
  assert.equal(JSON.stringify(inbound).includes('"candidates"'), false);
  assert.equal(JSON.stringify(inbound).includes('"type":"output_text"'), true);

  const geminiSse = [
    'data: {"candidates":[{"finishReason":"STOP","content":{"role":"model","parts":[{"text":"Hello world"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}',
    "",
  ].join("\n");
  const chatSse = geminiSseToOpenAIChat(geminiSse, { id: "resp_stream", created: 0, upstreamModel: "gemini-test" });
  const responsesSse = oaiChatSseToResponsesSse(chatSse.body, {
    id: "resp_stream",
    model: "gemini-test",
    created: 0,
    fallbackPromptTokens: 4,
  });
  assert.match(responsesSse.sse, /event: response\.created/);
  assert.match(responsesSse.sse, /"delta":"Hello world"/);
  assert.match(responsesSse.sse, /event: response\.completed/);
  assert.equal((responsesSse.usageBody.usage as { prompt_tokens: number; completion_tokens: number }).prompt_tokens, 4);

  const geminiCh = testChannel({
    type: CHANNEL_TYPE_GEMINI,
    key: "gkey",
    models: "gemini-test",
  });
  const responsesUrl = buildUpstream(geminiCh, "responses", "/v1/responses", "gemini-test", conversation);
  assert.equal(
    responsesUrl.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=gkey",
  );
});

test("original Gemini ConvertClaudeRequest and Claude ConvertGeminiRequest composed JSON fields", () => {
  assert.equal(CONVERTER_CLAUDE_TO_GEMINI, "claude_messages_to_gemini_generate_content");
  assert.equal(CONVERTER_GEMINI_TO_CLAUDE, "gemini_generate_content_to_claude_messages");

  const geminiFromClaude = convertClaudeMessagesToGeminiGenerateContent(
    {
      model: "gemini-2.0-flash",
      system: "You are a helpful assistant.",
      max_tokens: 1024,
      tools: [
        {
          name: "lookup",
          description: "Lookup data",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' }],
        },
      ],
    },
    { originModelName: "gemini-2.0-flash", upstreamModelName: "gemini-2.0-flash" },
  );
  const sys = geminiFromClaude.systemInstruction as { parts: { text: string }[] };
  assert.equal(sys.parts[0].text, "You are a helpful assistant.");
  assert.equal((geminiFromClaude.generationConfig as { maxOutputTokens: number }).maxOutputTokens, 1024);
  const geminiTools = geminiFromClaude.tools as { functionDeclarations: { name: string }[] }[];
  assert.equal(geminiTools[0].functionDeclarations[0].name, "lookup");
  const contents = geminiFromClaude.contents as { role: string; parts: Record<string, unknown>[] }[];
  assert.equal(contents[0].role, "user");
  assert.equal(contents[0].parts[0].text, "What is in this image?");
  assert.deepEqual(contents[0].parts[1].inlineData, { mimeType: "image/png", data: "aGVsbG8=" });
  assert.equal(contents[1].role, "model");
  const call = contents[1].parts[0].functionCall as { id: string; name: string; args: { q: string } };
  assert.equal(call.id, "toolu_1");
  assert.equal(call.name, "lookup");
  assert.deepEqual(call.args, { q: "x" });
  assert.equal(typeof contents[1].parts[0].thoughtSignature, "string");
  const responsePart = contents[2].parts[0].functionResponse as { id: string; name: string; response: Record<string, unknown> };
  assert.equal(responsePart.id, "toolu_1");
  assert.equal(responsePart.name, "lookup");

  const claudeFromGemini = convertGeminiGenerateContentToClaudeMessages(
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: "What is in this image?" },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
      systemInstruction: { parts: [{ text: "You are a helpful assistant." }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "Lookup data",
              parameters: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
        },
      ],
    },
    { originModelName: "claude-3-7-sonnet", upstreamModelName: "claude-3-7-sonnet" },
  );
  const claudeSystem = claudeFromGemini.system as { type: string; text: string }[];
  assert.ok(claudeSystem[0].text.includes("You are a helpful assistant."));
  assert.equal((claudeFromGemini.messages as { role: string }[])[0].role, "user");
  const userBlocks = (claudeFromGemini.messages as { content: { type: string; source?: { type: string } }[] }[])[0].content;
  assert.ok(userBlocks.some((block) => block.type === "image" || block.source?.type === "base64"));
  const claudeTools = JSON.stringify(claudeFromGemini.tools);
  assert.ok(claudeTools.includes("lookup"));
  assert.ok(Number(claudeFromGemini.max_tokens) > 0);

  const thinkingBudget = convertGeminiGenerateContentToClaudeMessages(
    {
      contents: [{ role: "user", parts: [{ text: "think" }] }],
      generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 1024 } },
    },
    { originModelName: "claude-3-7-sonnet", upstreamModelName: "claude-3-7-sonnet" },
  );
  const thinking = thinkingBudget.thinking as { type: string; budget_tokens: number };
  assert.equal(thinking.type, "enabled");
  assert.equal(thinking.budget_tokens, 1024);

  assert.throws(() => convertGeminiGenerateContentToClaudeMessages(null), /request is nil/);

  const claudeInbound = geminiResponseToClaudeMessages(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { text: "hello" },
              { functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
    },
    "gemini-2.0-flash",
    { id: "chatcmpl_g", created: 1 },
  );
  assert.equal(claudeInbound.type, "message");
  assert.equal(claudeInbound.role, "assistant");
  assert.equal(claudeInbound.model, "gemini-2.0-flash");
  const inboundBlocks = claudeInbound.content as { type: string; text?: string; name?: string; id?: string }[];
  assert.ok(inboundBlocks.some((block) => block.type === "text" && block.text === "hello"));
  assert.ok(inboundBlocks.some((block) => block.type === "tool_use" && block.name === "lookup" && block.id === "call_1"));
  assert.equal((claudeInbound.usage as { input_tokens: number }).input_tokens, 4);

  const geminiInbound = claudeResponseToGeminiChat(
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-7-sonnet",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "y" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 5 },
    },
    "claude-3-7-sonnet",
  );
  const candidates = geminiInbound.candidates as { content: { role: string; parts: Record<string, unknown>[] }; finishReason: string }[];
  assert.equal(candidates[0].content.role, "model");
  assert.ok(candidates[0].content.parts.some((part) => part.text === "ok"));
  const inboundCall = candidates[0].content.parts.find((part) => part.functionCall) as { functionCall: { id: string; name: string } };
  assert.equal(inboundCall.functionCall.id, "toolu_9");
  assert.equal(inboundCall.functionCall.name, "lookup");

  const geminiSse = [
    'data: {"candidates":[{"finishReason":"STOP","content":{"role":"model","parts":[{"text":"Hello Claude"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}',
    "",
  ].join("\n");
  const claudeSse = geminiSseToClaudeSse(geminiSse, { estimatePromptTokens: 4, id: "chatcmpl_s", created: 0, upstreamModel: "gemini-2.0-flash" });
  assert.match(claudeSse.sse, /event: message_start/);
  assert.match(claudeSse.sse, /Hello Claude/);
  assert.match(claudeSse.sse, /event: message_stop/);

  const anthropicSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello Gemini"}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const geminiOutSse = claudeSseToGeminiSse(anthropicSse, { estimatePromptTokens: 4, upstreamModel: "claude-3-7-sonnet", created: 0 });
  assert.match(geminiOutSse.sse, /"role":"model"/);
  assert.match(geminiOutSse.sse, /Hello Gemini/);
});

test("original GeminiHelper ClaudeHelper TextHelper channel SystemPrompt JSON fields", () => {
  assert.equal(getOpenAISystemRoleName("gpt-4o"), "system");
  assert.equal(getOpenAISystemRoleName("o1"), "developer");
  assert.equal(getOpenAISystemRoleName("o1-mini"), "system");
  assert.equal(getOpenAISystemRoleName("gpt-5"), "developer");

  const missing = applyGeminiChannelSystemPrompt(
    { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    "Answer in English.",
    false,
  );
  assert.deepEqual(missing.systemInstruction, { parts: [{ text: "Answer in English." }] });

  const emptyParts = applyGeminiChannelSystemPrompt(
    { systemInstruction: { parts: [] }, contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    "Answer in English.",
    false,
  );
  assert.deepEqual(emptyParts.systemInstruction, { parts: [{ text: "Answer in English." }] });

  const kept = applyGeminiChannelSystemPrompt(
    {
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
    "Answer in English.",
    false,
  );
  assert.deepEqual(kept.systemInstruction, { parts: [{ text: "be brief" }] });

  const prepended = applyGeminiChannelSystemPrompt(
    {
      systemInstruction: { parts: [{ inlineData: { mimeType: "image/png", data: "YWE=" } }, { text: "be brief" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
    "Answer in English.",
    true,
  );
  assert.deepEqual((prepended.systemInstruction as { parts: { text?: string }[] }).parts[1], {
    text: "Answer in English.\nbe brief",
  });

  const unshift = applyGeminiChannelSystemPrompt(
    {
      systemInstruction: { parts: [{ inlineData: { mimeType: "image/png", data: "YWE=" } }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
    "Answer in English.",
    true,
  );
  assert.equal((unshift.systemInstruction as { parts: { text?: string }[] }).parts[0].text, "Answer in English.");

  const snake = applyGeminiChannelSystemPrompt(
    {
      system_instruction: { parts: [{ text: "be brief" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
    "Answer in English.",
    true,
  );
  assert.deepEqual(snake.systemInstruction, { parts: [{ text: "Answer in English.\nbe brief" }] });
  assert.equal("system_instruction" in snake, false);

  const cleaned = applyGeminiChannelSystemPrompt(
    { systemInstruction: { parts: [{ text: "" }, { inlineData: { mimeType: "image/png", data: "YWE=" } }] } },
    undefined,
    false,
  );
  assert.equal("systemInstruction" in cleaned, false);

  const nativeGemini = convertGeminiRequest(
    applyGeminiChannelSystemPrompt(
      { contents: [{ parts: [{ text: "hi" }] }] },
      "Answer in English.",
      false,
    ),
    { originModelName: "gemini-2.0-flash", upstreamModelName: "gemini-2.0-flash" },
  );
  assert.deepEqual(nativeGemini.systemInstruction, { parts: [{ text: "Answer in English." }] });
  assert.equal((nativeGemini.contents as { role?: string }[])[0].role, "user");

  const claudeMissing = applyClaudeChannelSystemPrompt(
    { model: "claude-3-7-sonnet", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    "Answer in English.",
    false,
  );
  assert.equal(claudeMissing.system, "Answer in English.");

  const claudeKept = applyClaudeChannelSystemPrompt(
    { model: "claude-3-7-sonnet", system: "be brief", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    "Answer in English.",
    false,
  );
  assert.equal(claudeKept.system, "be brief");

  const claudePrepend = applyClaudeChannelSystemPrompt(
    { model: "claude-3-7-sonnet", system: "be brief", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    "Answer in English.",
    true,
  );
  assert.equal(claudePrepend.system, "Answer in English.\nbe brief");

  const claudeBlocks = applyClaudeChannelSystemPrompt(
    {
      model: "claude-3-7-sonnet",
      system: [{ type: "text", text: "be brief" }],
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    },
    "Answer in English.",
    true,
  );
  assert.deepEqual(claudeBlocks.system, [
    { type: "text", text: "Answer in English." },
    { type: "text", text: "be brief" },
  ]);

  const wrapped = convertVertexClaudeRequest(
    applyClaudeChannelSystemPrompt(
      { model: "claude-3-7-sonnet", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      "Answer in English.",
      false,
    ),
    { originModelName: "claude-3-7-sonnet", upstreamModelName: "claude-3-7-sonnet" },
  );
  assert.equal(wrapped.system, "Answer in English.");
  assert.equal(wrapped.anthropic_version, VERTEX_ANTHROPIC_VERSION);
  assert.equal("model" in wrapped, false);

  const chatMissing = applyChatChannelSystemPrompt(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    "Answer in English.",
    false,
  );
  assert.deepEqual((chatMissing.messages as { role: string; content: string }[])[0], {
    role: "system",
    content: "Answer in English.",
  });

  const chatKept = applyChatChannelSystemPrompt(
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    },
    "Answer in English.",
    false,
  );
  assert.equal((chatKept.messages as { content: string }[])[0].content, "be brief");

  const chatPrepend = applyChatChannelSystemPrompt(
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    },
    "Answer in English.",
    true,
  );
  assert.equal((chatPrepend.messages as { content: string }[])[0].content, "Answer in English.\nbe brief");

  const toolsSkip = applyChatChannelSystemPrompt(
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", tools: [{ type: "function", function: { name: "lookup" } }] },
        { role: "user", content: "hi" },
      ],
    },
    "Answer in English.",
    true,
  );
  assert.equal((toolsSkip.messages as { role: string; content?: string }[])[0].role, "system");
  assert.equal((toolsSkip.messages as { content?: string }[])[0].content, "Answer in English.");

  const developer = applyChatChannelSystemPrompt(
    { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
    "Answer in English.",
    false,
    "developer",
  );
  assert.equal((developer.messages as { role: string }[])[0].role, "developer");
  assert.equal((developer.messages as { content: string }[])[0].content, "Answer in English.");

  const stillChat = convertOpenAIRequest(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    { channelType: CHANNEL_TYPE_OPENAI, originModelName: "gpt-4o-mini", upstreamModelName: "gpt-4o-mini" },
  );
  const afterConvert = applyChatChannelSystemPrompt(stillChat, "Answer in English.", false, getOpenAISystemRoleName(String(stillChat.model || "")));
  assert.equal((afterConvert.messages as { role: string }[])[0].role, "system");

  const geminiFromOpenAI = convertOpenAIRequest(
    {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
    },
    { channelType: CHANNEL_TYPE_GEMINI, originModelName: "gemini-2.0-flash", upstreamModelName: "gemini-2.0-flash" },
  );
  assert.equal("messages" in geminiFromOpenAI, false);
  assert.ok(Array.isArray(geminiFromOpenAI.contents));
  assert.equal("systemInstruction" in geminiFromOpenAI, false);
});

test("original Gemini ConvertRequest to OpenAI Responses composed JSON fields", () => {
  assert.equal(CONVERTER_GEMINI_TO_RESPONSES, "gemini_generate_content_to_openai_responses");
  assert.throws(
    () =>
      convertAdvancedCustomGeminiRequest(
        { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
        {
          channelType: CHANNEL_TYPE_ADVANCED_CUSTOM,
          originModelName: "gpt-test",
          upstreamModelName: "gpt-test",
          converter: CONVERTER_GEMINI_TO_RESPONSES,
        },
      ),
    /converter "gemini_generate_content_to_openai_responses" does not support Gemini generateContent requests/,
  );
  assert.throws(() => convertGeminiGenerateContentToOpenAIResponses(null), /request is nil/);
  assert.throws(() => convertChatCompletionsToResponsesRequest(null), /request is nil/);
  assert.throws(
    () =>
      convertChatCompletionsToResponsesRequest({
        model: "gpt-test",
        n: 2,
        messages: [{ role: "user", content: "hello" }],
      }),
    /n>1 is not supported in responses compatibility mode/,
  );

  const chatReasoning = convertChatCompletionsToResponsesRequest({
    model: "gpt-test",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(chatReasoning.model, "gpt-test");
  assert.equal((chatReasoning.input as { content: string }[])[0].content, "hello");
  assert.equal((chatReasoning.reasoning as { effort: string; summary: string }).effort, "high");
  assert.equal((chatReasoning.reasoning as { effort: string; summary: string }).summary, "detailed");
  assert.equal("reasoning_effort" in chatReasoning, false);
  assert.equal("messages" in chatReasoning, false);

  const converted = convertGeminiGenerateContentToOpenAIResponses(
    {
      systemInstruction: { parts: [{ text: "You are a helpful assistant." }] },
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1024 },
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather by city",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
          ],
        },
      ],
      contents: [
        {
          role: "user",
          parts: [
            { text: "What is in this image?" },
            { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
          ],
        },
        {
          role: "model",
          parts: [{ functionCall: { id: "call_abc", name: "get_weather", args: { city: "Paris" } } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { id: "call_abc", name: "get_weather", response: { temp: "15 degrees" } } }],
        },
        { role: "user", parts: [{ text: "Summarize." }] },
      ],
    },
    { originModelName: "gpt-test", upstreamModelName: "gpt-test", isStream: true },
  );
  assert.equal(converted.model, "gpt-test");
  assert.equal(converted.instructions, "You are a helpful assistant.");
  assert.equal(converted.max_output_tokens, 1024);
  assert.equal(converted.temperature, 0.2);
  assert.equal(converted.top_p, 0.9);
  assert.equal(converted.stream, true);
  assert.equal("contents" in converted, false);
  assert.equal("generationConfig" in converted, false);
  assert.equal("systemInstruction" in converted, false);
  assert.equal("messages" in converted, false);
  assert.equal("max_tokens" in converted, false);
  const input = converted.input as Record<string, unknown>[];
  assert.equal(input[0].role, "user");
  const userParts = input[0].content as { type: string; text?: string; image_url?: string }[];
  assert.equal(userParts[0].type, "input_text");
  assert.equal(userParts[0].text, "What is in this image?");
  assert.equal(userParts[1].type, "input_image");
  assert.equal(userParts[1].image_url, "data:image/png;base64,aGVsbG8=");
  assert.equal(input[1].role, "assistant");
  assert.equal(input[1].content, "");
  assert.equal(input[2].type, "function_call");
  assert.equal(input[2].call_id, "call_abc");
  assert.equal(input[2].name, "get_weather");
  assert.equal(input[2].arguments, '{"city":"Paris"}');
  assert.equal(input[3].type, "function_call_output");
  assert.equal(input[3].call_id, "call_abc");
  assert.equal(input[3].output, '{"temp":"15 degrees"}');
  assert.equal(input[4].role, "user");
  assert.equal(input[4].content, "Summarize.");
  const tools = converted.tools as { type: string; name: string; description: string; parameters: unknown }[];
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].name, "get_weather");
  assert.equal(tools[0].description, "Get weather by city");
  assert.equal("function" in tools[0], false);

  assert.throws(
    () =>
      convertGeminiGenerateContentToOpenAIResponses(
        {
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          generationConfig: { candidateCount: 2 },
        },
        { originModelName: "gpt-test", upstreamModelName: "gpt-test" },
      ),
    /n>1 is not supported in responses compatibility mode/,
  );

  const thinking = convertGeminiGenerateContentToOpenAIResponses(
    {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    { originModelName: "gemini-2.5-flash", upstreamModelName: "gemini-2.5-flash" },
  );
  assert.equal(thinking.model, "gemini-2.5-flash");
  assert.equal((thinking.input as { content: string }[])[0].content, "hello");
  assert.equal((thinking.reasoning as { effort: string; summary: string }).effort, "high");
  assert.equal((thinking.reasoning as { effort: string; summary: string }).summary, "detailed");
  assert.equal("thinkingConfig" in thinking, false);
  assert.equal("generationConfig" in thinking, false);
});



