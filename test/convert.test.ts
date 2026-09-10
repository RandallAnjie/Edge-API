import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openaiFromAnthropicResponse,
  openaiToAnthropic,
  openaiToGemini,
  usageFromOpenAI,
  applyOpenAIChatCompatibility,
  getOpenAIChatCapabilities,
  convertOpenAIRequest,
  convertOpenAIResponsesRequest,
  convertClaudeRequest,
  convertOpenAIChatToClaude,
} from "../src/convert.js";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER } from "../src/constants.js";
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
