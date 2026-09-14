/** Original `relay/channel/advancedcustom` ConvertRequestByID hops. Does not import convert.ts. */

import { convertOpenAIChatToClaude } from "./claude-convert.js";
import { convertOpenAIChatToGemini } from "./gemini-convert.js";
import type { ReasoningHostSettings } from "./reasoning.js";
import { convertOpenAIResponsesRequestToGeminiChat } from "./responses-gemini.js";

export const CONVERTER_NONE = "none";
export const CONVERTER_CHAT_TO_CLAUDE = "openai_chat_completions_to_anthropic_messages";
export const CONVERTER_CHAT_TO_RESPONSES = "openai_chat_completions_to_openai_responses";
export const CONVERTER_CHAT_TO_GEMINI = "openai_chat_completions_to_gemini_generate_content";
export const CONVERTER_RESPONSES_TO_CHAT = "openai_responses_to_openai_chat_completions";
export const CONVERTER_RESPONSES_TO_GEMINI = "openai_responses_to_gemini_generate_content";
export const CONVERTER_CLAUDE_TO_CHAT = "anthropic_messages_to_openai_chat_completions";
export const CONVERTER_GEMINI_TO_CHAT = "gemini_generate_content_to_openai_chat_completions";

export function converterDoesNotSupport(
  converter: string,
  kind: "chat" | "responses" | "claude" | "gemini" | "embedding" | "audio" | "image",
): Error {
  const quoted = JSON.stringify(converter);
  switch (kind) {
    case "chat":
      return new Error(`converter ${quoted} does not support OpenAI chat completions requests`);
    case "responses":
      return new Error(`converter ${quoted} does not support OpenAI Responses requests`);
    case "claude":
      return new Error(`converter ${quoted} does not support Anthropic Messages requests`);
    case "gemini":
      return new Error(`converter ${quoted} does not support Gemini generateContent requests`);
    case "embedding":
      return new Error(`converter ${quoted} does not support embedding requests`);
    case "audio":
      return new Error(`converter ${quoted} does not support audio requests`);
    case "image":
      return new Error(`converter ${quoted} does not support image requests`);
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function isStringContent(content: unknown): boolean {
  return typeof content === "string" || content == null;
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const o = asObj(part);
        if (typeof o.text === "string") return o.text;
        return "";
      })
      .join("");
  }
  return "";
}

function jsonString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeChatImageURL(value: unknown): unknown {
  if (typeof value === "string") return value;
  const o = asObj(value);
  if (typeof o.url === "string" && o.url) return o.url;
  return value;
}

function parseToolCalls(message: Record<string, unknown>): { id: string; type: string; name: string; arguments: string }[] {
  const raw = message.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = asObj(item);
    const fn = asObj(o.function);
    return {
      id: String(o.id || ""),
      type: String(o.type || "function"),
      name: String(fn.name || ""),
      arguments: typeof fn.arguments === "string" ? fn.arguments : fn.arguments != null ? JSON.stringify(fn.arguments) : "",
    };
  });
}

function appendFunctionCalls(inputItems: Record<string, unknown>[], message: Record<string, unknown>): void {
  for (const tc of parseToolCalls(message)) {
    if (!tc.id.trim()) continue;
    if (tc.type && tc.type !== "function") continue;
    if (!tc.name.trim()) continue;
    inputItems.push({
      type: "function_call",
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    });
  }
}

/** Original `oaichat.ChatCompletionsRequestToResponsesRequest`. */
export function convertChatCompletionsToResponsesRequest(body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model || "");
  if (!model) throw new Error("model is required");
  const n = Number(body.n ?? 1);
  if (n > 1) throw new Error("n>1 is not supported in responses compatibility mode");

  const instructionsParts: string[] = [];
  const inputItems: Record<string, unknown>[] = [];
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  for (const msg of messages) {
    const role = String(msg.role || "").trim();
    if (!role) continue;
    if (role === "tool" || role === "function") {
      const callID = String(msg.tool_call_id || "").trim();
      const output = msg.content == null ? "" : isStringContent(msg.content) ? stringContent(msg.content) : jsonString(msg.content);
      if (!callID) {
        inputItems.push({ role: "user", content: `[tool_output_missing_call_id] ${output}` });
        continue;
      }
      inputItems.push({ type: "function_call_output", call_id: callID, output });
      continue;
    }
    if (role === "system" || role === "developer") {
      if (msg.content == null) continue;
      if (isStringContent(msg.content)) {
        const s = stringContent(msg.content).trim();
        if (s) instructionsParts.push(s);
        continue;
      }
      const parts = Array.isArray(msg.content) ? msg.content : [];
      const texts: string[] = [];
      for (const part of parts) {
        const o = typeof part === "string" ? { type: "text", text: part } : asObj(part);
        if ((String(o.type || "text") === "text" || o.type === "input_text") && String(o.text || "").trim()) {
          texts.push(String(o.text));
        }
      }
      const joined = texts.join("\n").trim();
      if (joined) instructionsParts.push(joined);
      continue;
    }

    const item: Record<string, unknown> = { role };
    if (msg.content == null) {
      item.content = "";
      inputItems.push(item);
      if (role === "assistant") appendFunctionCalls(inputItems, msg);
      continue;
    }
    if (isStringContent(msg.content)) {
      item.content = stringContent(msg.content);
      inputItems.push(item);
      if (role === "assistant") appendFunctionCalls(inputItems, msg);
      continue;
    }
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const contentParts: Record<string, unknown>[] = [];
    for (const rawPart of parts) {
      const part = typeof rawPart === "string" ? { type: "text", text: rawPart } : asObj(rawPart);
      const type = String(part.type || "text");
      if (type === "text") {
        contentParts.push({ type: role === "assistant" ? "output_text" : "input_text", text: part.text });
      } else if (type === "image_url") {
        contentParts.push({ type: "input_image", image_url: normalizeChatImageURL(part.image_url) });
      } else if (type === "input_audio") {
        contentParts.push({ type: "input_audio", input_audio: part.input_audio });
      } else if (type === "file") {
        contentParts.push({ type: "input_file", file: part.file });
      } else if (type === "video_url") {
        contentParts.push({ type: "input_video", video_url: part.video_url });
      } else {
        contentParts.push({ type });
      }
    }
    item.content = contentParts;
    inputItems.push(item);
    if (role === "assistant") appendFunctionCalls(inputItems, msg);
  }

  const out: Record<string, unknown> = { model, input: inputItems };
  if (instructionsParts.length) out.instructions = instructionsParts.join("\n\n");
  if (body.stream != null) out.stream = body.stream;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.user != null) out.user = body.user;
  if (body.store != null) out.store = body.store;
  if (body.metadata != null) out.metadata = body.metadata;
  if (body.enable_thinking != null) out.enable_thinking = body.enable_thinking;
  if (body.thinking_budget != null) out.thinking_budget = body.thinking_budget;
  if (body.frequency_penalty != null) out.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty != null) out.presence_penalty = body.presence_penalty;
  if (body.parallel_tool_calls != null) out.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) out.prompt_cache_key = body.prompt_cache_key;
  if (body.max_tokens != null || body.max_completion_tokens != null) {
    out.max_output_tokens = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
  }

  const format = asObj(body.response_format);
  if (typeof format.type === "string" && format.type) {
    const responsesFormat: Record<string, unknown> = { type: format.type };
    if (format.type === "json_schema") {
      const schema = asObj(format.json_schema);
      for (const [key, value] of Object.entries(schema)) {
        if (key === "type") continue;
        responsesFormat[key] = value;
      }
      const nested = asObj(responsesFormat.json_schema);
      if (Object.keys(nested).length) {
        for (const [key, value] of Object.entries(nested)) {
          if (!(key in responsesFormat)) responsesFormat[key] = value;
        }
        delete responsesFormat.json_schema;
      }
    }
    out.text = { format: responsesFormat };
  }

  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as unknown[]).map((tool) => {
      const t = asObj(tool);
      if (t.type === "function") {
        const fn = asObj(t.function);
        return {
          type: "function",
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        };
      }
      return t;
    });
  }
  if (body.tool_choice != null) {
    if (typeof body.tool_choice === "string") out.tool_choice = body.tool_choice;
    else {
      const choice = asObj(body.tool_choice);
      if (choice.type === "function") {
        const name = typeof choice.name === "string" && choice.name ? choice.name : String(asObj(choice.function).name || "");
        out.tool_choice = name ? { type: "function", name } : body.tool_choice;
      } else out.tool_choice = body.tool_choice;
    }
  }
  return out;
}

function responsesCallID(item: Record<string, unknown>): string {
  const callID = String(item.call_id || "").trim();
  if (callID) return callID;
  return String(item.id || "").trim();
}

function responsesArgumentsString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return jsonString(value);
}

function toolOutputContent(value: unknown): unknown {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return jsonString(value);
}

function present(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "object") return true;
  return true;
}

function responsesInputContentToChat(content: unknown): unknown {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const chatParts: unknown[] = [];
  let textOnly = "";
  let onlyText = true;
  for (const raw of content) {
    const part = asObj(raw);
    const type = String(part.type || "").trim();
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = asString(part.text);
      textOnly += text;
      chatParts.push({ type: "text", text });
      continue;
    }
    onlyText = false;
    if (type === "input_image") {
      chatParts.push({ type: "image_url", image_url: part.image_url ?? part });
    } else if (type === "input_file") {
      chatParts.push({ type: "file", file: part.file ?? part });
    } else if (type === "input_audio") {
      chatParts.push({ type: "input_audio", input_audio: part.input_audio });
    } else if (type === "input_video") {
      chatParts.push({ type: "video_url", video_url: part.video_url });
    } else {
      chatParts.push(raw);
    }
  }
  return onlyText ? textOnly : chatParts;
}

function responsesToolsToChat(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => {
    const t = asObj(tool);
    if (String(t.type || "") === "function") {
      return {
        type: "function",
        function: {
          name: String(t.name || "").trim(),
          description: t.description,
          parameters: t.parameters,
        },
      };
    }
    return t;
  });
}

function responsesToolChoiceToChat(choice: unknown): unknown {
  if (choice == null || typeof choice === "string") return choice;
  const o = asObj(choice);
  if (String(o.type || "") === "function") {
    const name = String(o.name || "").trim();
    if (name) return { type: "function", function: { name } };
  }
  return choice;
}

function responsesTextToChatFormat(text: unknown): Record<string, unknown> | undefined {
  const format = asObj(asObj(text).format);
  const type = String(format.type || "").trim();
  if (!type) return undefined;
  const out: Record<string, unknown> = { type };
  if (type === "json_schema") out.json_schema = format;
  return out;
}

/** Original `oairesponses.ResponsesRequestToChatCompletionsRequest`. */
export function convertResponsesToChatCompletionsRequest(body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model || "");
  if (!model) throw new Error("model is required");
  const unsupported: string[] = [];
  if (present(body.conversation)) unsupported.push("conversation");
  if (String(body.previous_response_id || "").trim()) unsupported.push("previous_response_id");
  if (present(body.prompt)) unsupported.push("prompt");
  if (present(body.context_management)) unsupported.push("context_management");
  if (unsupported.length) {
    throw new Error(`responses to chat conversion does not support stateful fields: ${unsupported.join(", ")}`);
  }

  const messages: Record<string, unknown>[] = [];
  const instructions = typeof body.instructions === "string" ? body.instructions : body.instructions != null ? jsonString(body.instructions) : "";
  if (instructions.trim()) messages.push({ role: "system", content: instructions });

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      const item = asObj(raw);
      const itemType = String(item.type || "").trim();
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const name = String(item.name || "").trim();
        if (!name) throw new Error("function_call item is missing name");
        const toolCall = {
          id: responsesCallID(item),
          type: "function",
          function: {
            name,
            arguments: responsesArgumentsString(itemType === "custom_tool_call" ? item.input : item.arguments),
          },
        };
        if (!messages.length || String(messages[messages.length - 1].role) !== "assistant") {
          messages.push({ role: "assistant", content: "", tool_calls: [toolCall] });
        } else {
          const last = { ...messages[messages.length - 1] };
          const existing = Array.isArray(last.tool_calls) ? [...(last.tool_calls as unknown[])] : [];
          last.tool_calls = [...existing, toolCall];
          messages[messages.length - 1] = last;
        }
        continue;
      }
      if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: responsesCallID(item),
          content: toolOutputContent(item.output),
        });
        continue;
      }
      const role = String(item.role || "user").trim() || "user";
      messages.push({ role, content: responsesInputContentToChat(item.content) });
    }
  } else if (body.input != null) {
    throw new Error(`unsupported responses input type ${JSON.stringify(typeof body.input)}`);
  }

  const out: Record<string, unknown> = { model, messages };
  if (body.stream != null) out.stream = body.stream;
  if (body.stream_options != null) out.stream_options = body.stream_options;
  if (body.max_output_tokens != null) out.max_completion_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.top_logprobs != null) out.top_logprobs = body.top_logprobs;
  if (body.user != null) out.user = body.user;
  if (body.store != null) out.store = body.store;
  if (body.metadata != null) out.metadata = body.metadata;
  if (body.safety_identifier != null) out.safety_identifier = body.safety_identifier;
  if (body.prompt_cache_retention != null) out.prompt_cache_retention = body.prompt_cache_retention;
  if (body.enable_thinking != null) out.enable_thinking = body.enable_thinking;
  if (body.thinking_budget != null) out.thinking_budget = body.thinking_budget;
  if (body.frequency_penalty != null) out.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty != null) out.presence_penalty = body.presence_penalty;
  if (typeof body.prompt_cache_key === "string") out.prompt_cache_key = body.prompt_cache_key;
  if (typeof body.parallel_tool_calls === "boolean") out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.service_tier) out.service_tier = body.service_tier;
  const tools = responsesToolsToChat(body.tools);
  if (tools) out.tools = tools;
  if (body.tool_choice != null) out.tool_choice = responsesToolChoiceToChat(body.tool_choice);
  const responseFormat = responsesTextToChatFormat(body.text);
  if (responseFormat) out.response_format = responseFormat;
  return out;
}

/** Original `oairesponses.OpenAIResponsesRequestToGeminiChat`. */
export function convertResponsesToGeminiRequest(
  body: Record<string, unknown>,
  opts: { originModelName?: string; upstreamModelName?: string; settings?: ReasoningHostSettings } = {},
): Record<string, unknown> {
  return convertOpenAIResponsesRequestToGeminiChat(body, opts);
}

/** Original `claudemessages.ClaudeMessagesRequestToOpenAIChat`. */
export function convertClaudeMessagesToOpenAIChat(
  body: Record<string, unknown>,
  upstreamModelName: string,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (typeof body.system === "string" && body.system) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = (body.system as { text?: string }[])
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .join("");
    if (text) messages.push({ role: "system", content: text });
  }
  const src = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  for (const raw of src) {
    const msg = asObj(raw);
    const role = String(msg.role || "user");
    if (isStringContent(msg.content)) {
      messages.push({ role, content: stringContent(msg.content) });
      continue;
    }
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const toolCalls: Record<string, unknown>[] = [];
    const media: Record<string, unknown>[] = [];
    for (const rawPart of parts) {
      const part = typeof rawPart === "string" ? { type: "text", text: rawPart } : asObj(rawPart);
      const type = String(part.type || "text");
      if (type === "text" || type === "input_text") {
        media.push({ type: "text", text: part.text });
      } else if (type === "image") {
        const source = asObj(part.source);
        media.push({
          type: "image_url",
          image_url: { url: `data:${source.media_type || source.mediaType || "image/png"};base64,${source.data || ""}` },
        });
      } else if (type === "tool_use") {
        toolCalls.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: jsonString(part.input) },
        });
      } else if (type === "tool_result") {
        messages.push({
          role: "tool",
          name: part.name || "",
          tool_call_id: part.tool_use_id || part.toolUseId,
          content: isStringContent(part.content) ? stringContent(part.content) : jsonString(part.content),
        });
      }
    }
    const outMsg: Record<string, unknown> = { role };
    if (toolCalls.length) outMsg.tool_calls = toolCalls;
    if (media.length && !toolCalls.length) outMsg.content = media.length === 1 && media[0].type === "text" ? media[0].text : media;
    else if (!toolCalls.length) outMsg.content = "";
    if (toolCalls.length || (outMsg.content != null && outMsg.content !== "")) messages.push(outMsg);
  }

  const out: Record<string, unknown> = { model: upstreamModelName || body.model, messages };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.top_k != null) out.top_k = body.top_k;
  if (body.stream != null) out.stream = body.stream;
  if (Array.isArray(body.stop_sequences)) {
    out.stop = body.stop_sequences.length === 1 ? body.stop_sequences[0] : body.stop_sequences;
  }
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as Record<string, unknown>[]).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? tool.inputSchema,
      },
    }));
  }
  return out;
}

/** Original `geminichat.GeminiGenerateContentRequestToOpenAIChat`. */
export function convertGeminiContentToOpenAIChat(
  body: Record<string, unknown>,
  upstreamModelName: string,
  isStream = false,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const sys = (body.systemInstruction || body.systemInstructions) as { parts?: { text?: string }[] } | undefined;
  if (sys?.parts?.length) {
    messages.push({ role: "system", content: sys.parts.map((p) => p.text || "").join("") });
  }
  const contents = Array.isArray(body.contents) ? (body.contents as Record<string, unknown>[]) : [];
  for (const content of contents) {
    const c = asObj(content);
    const role = String(c.role || "user") === "model" ? "assistant" : String(c.role || "user");
    const parts = Array.isArray(c.parts) ? (c.parts as Record<string, unknown>[]) : [];
    const texts: string[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    for (const part of parts) {
      const p = asObj(part);
      if (p.functionCall || p.function_call) {
        const fc = asObj(p.functionCall || p.function_call);
        toolCalls.push({
          id: fc.id,
          type: "function",
          function: {
            name: fc.name,
            arguments: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args ?? fc.arguments ?? {}),
          },
        });
        continue;
      }
      if (p.functionResponse || p.function_response) {
        const fr = asObj(p.functionResponse || p.function_response);
        messages.push({
          role: "tool",
          name: fr.name,
          tool_call_id: fr.id,
          content: jsonString(fr.response),
        });
        continue;
      }
      if (typeof p.text === "string" && p.text && !p.thought) texts.push(p.text);
    }
    const msg: Record<string, unknown> = { role, content: texts.join("") };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    if (texts.join("") || toolCalls.length) messages.push(msg);
  }
  const gc = asObj(body.generationConfig || body.generation_config);
  const out: Record<string, unknown> = { model: upstreamModelName, messages, stream: isStream };
  if (gc.temperature != null) out.temperature = gc.temperature;
  if (gc.topP != null) out.top_p = gc.topP;
  if (gc.maxOutputTokens != null) out.max_tokens = gc.maxOutputTokens;
  return out;
}

export function convertAdvancedCustomChatToClaude(
  body: Record<string, unknown>,
  opts: { originModelName?: string; upstreamModelName?: string; settings?: ReasoningHostSettings } = {},
): Record<string, unknown> {
  return convertOpenAIChatToClaude(body, opts);
}

export function convertAdvancedCustomChatToGemini(
  body: Record<string, unknown>,
  opts: { originModelName?: string; upstreamModelName?: string; settings?: ReasoningHostSettings } = {},
): Record<string, unknown> {
  return convertOpenAIChatToGemini(body, opts);
}
