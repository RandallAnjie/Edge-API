import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openaiFromAnthropicResponse,
  openaiFromGeminiResponse,
  openaiToAnthropic,
  openaiToGemini,
  usageFromOpenAI,
  applyOpenAIChatCompatibility,
  getOpenAIChatCapabilities,
  convertOpenAIRequest,
  convertOpenAIResponsesRequest,
  convertClaudeRequest,
  convertOpenAIChatToClaude,
  convertOllamaEmbeddingRequest,
  convertBaiduEmbeddingRequest,
  convertCohereRerankRequest,
  openaiFromBaiduResponse,
  openaiFromCohereResponse,
  openaiFromDifyResponse,
  openaiFromZhipuResponse,
  convertMiniMaxImageRequest,
  convertMistralOpenAIRequest,
  convertMokaEmbeddingRequest,
  convertSiliconFlowImageRequest,
  convertJinaEmbeddingRequest,
  convertReplicateImageRequest,
  convertJimengImageRequest,
  requestOpenAI2Xunfei,
} from "../src/convert.js";
import { claudeSseToOpenAIChat, claudeStopReasonToOpenAIFinishReason } from "../src/claude-response.js";
import { geminiSseToOpenAIChat } from "../src/gemini-response.js";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_AWS, CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_CLOUDFLARE, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_COZE, CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_DIFY, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_JIMENG, CHANNEL_TYPE_JINA, CHANNEL_TYPE_MINIMAX, CHANNEL_TYPE_MISTRAL, CHANNEL_TYPE_MOKA, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_NEW_API, CHANNEL_TYPE_OLLAMA, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER, CHANNEL_TYPE_PALM, CHANNEL_TYPE_PERPLEXITY, CHANNEL_TYPE_REPLICATE, CHANNEL_TYPE_SILICONFLOW, CHANNEL_TYPE_SUB2API, CHANNEL_TYPE_SUBMODEL, CHANNEL_TYPE_TENCENT, CHANNEL_TYPE_VERTEX, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI, CHANNEL_TYPE_XUNFEI, CHANNEL_TYPE_ZHIPU, CHANNEL_TYPE_ZHIPU_V4 } from "../src/constants.js";
import { openaiFromOllamaChatResponse, openaiFromOllamaEmbedding } from "../src/ollama-convert.js";
import { openaiFromNovaResponse } from "../src/aws-convert.js";
import { openaiFromImagenResponse, VERTEX_IMAGE_TOKENS, imagenUsage } from "../src/vertex-convert.js";
import { isClientError } from "../src/reasoning.js";
import { getZhipuToken, clearZhipuTokenCache } from "../src/zhipu-convert.js";
import { applyTencentTc3Authorization, getTencentSign, tencentTokenHubBase, TENCENT_TOKENHUB_BASE } from "../src/tencent-convert.js";
import { buildXunfeiAuthUrl, xunfeiDomain, xunfeiHostUrl } from "../src/xunfei-convert.js";
import { applyJimengAuthorization, jimengRequestURL } from "../src/jimeng-convert.js";
import { mapOpenAISizeToFlux } from "../src/replicate-convert.js";
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
});

test("original Cohere, Dify, Coze, and Baidu ConvertOpenAIRequest JSON and URLs", () => {
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
