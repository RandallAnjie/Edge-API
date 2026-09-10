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
} from "../src/convert.js";
import { claudeSseToOpenAIChat, claudeStopReasonToOpenAIFinishReason } from "../src/claude-response.js";
import { geminiSseToOpenAIChat } from "../src/gemini-response.js";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_AWS, CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_COHERE, CHANNEL_TYPE_COZE, CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_DIFY, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_OLLAMA, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER, CHANNEL_TYPE_VERTEX, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI } from "../src/constants.js";
import { openaiFromOllamaChatResponse, openaiFromOllamaEmbedding } from "../src/ollama-convert.js";
import { openaiFromNovaResponse } from "../src/aws-convert.js";
import { openaiFromImagenResponse, VERTEX_IMAGE_TOKENS, imagenUsage } from "../src/vertex-convert.js";
import { isClientError } from "../src/reasoning.js";
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
