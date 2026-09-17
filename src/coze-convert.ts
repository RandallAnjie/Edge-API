/** Original `relay/channel/coze` ConvertOpenAIRequest / DoRequest poll / DoResponse. */

import { asObj, sseLine } from "./openai-usage.js";

export type ConvertCozeOpts = {
  botId?: string;
  responseId?: string;
};

export type CozeUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** Original `coze.convertCozeChatRequest`. `bot_id` is `c.GetString("bot_id")` from `channel.Other`. */
export function convertCozeOpenAIRequest(body: Record<string, unknown>, opts: ConvertCozeOpts = {}): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const src = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (const message of src) {
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content,
        content_type: "text",
      });
    }
  }
  const responseId = opts.responseId || "chatcmpl-coze";
  const userId = body.user === undefined || body.user === null || body.user === "" ? responseId : body.user;
  const out: Record<string, unknown> = {
    bot_id: opts.botId || "",
    user_id: userId,
  };
  if (messages.length) out.additional_messages = messages;
  if (body.stream) out.stream = true;
  return out;
}

function parseCozeContent(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Original `coze.cozeChatHandler` OpenAI chat JSON. */
export function openaiFromCozeDetailResponse(
  upstream: Record<string, unknown>,
  model: string,
  opts: { id?: string; usage?: CozeUsage } = {},
): Record<string, unknown> {
  if (asInt(upstream.code) !== 0 && upstream.code != null) {
    throw new Error(String(upstream.msg || "bad_response_body"));
  }
  const usage = opts.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let content: unknown = "";
  let created = Math.floor(Date.now() / 1000);
  const data = Array.isArray(upstream.data) ? (upstream.data as Record<string, unknown>[]) : [];
  for (const item of data) {
    if (item.type === "answer") {
      content = parseCozeContent(item.content);
      if (item.created_at != null) created = Number(item.created_at);
    }
  }
  return {
    id: opts.id || "",
    object: "chat.completion",
    created,
    model,
    usage,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

function asInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function usageFromCoze(raw: Record<string, unknown>): CozeUsage {
  return {
    prompt_tokens: asInt(raw.input_count),
    completion_tokens: asInt(raw.output_count),
    total_tokens: asInt(raw.token_count),
  };
}

/** Original `coze.Adaptor.DoRequest` non-stream: create chat, poll retrieve, then message list. */
export async function completeCozeNonStreamChat(
  createRes: Response,
  base: string,
  headers: Record<string, string>,
): Promise<{ response: Response; usage: CozeUsage }> {
  const createText = await createRes.text();
  let created: Record<string, unknown>;
  try {
    created = JSON.parse(createText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (asInt(created.code) !== 0) {
    throw new Error(String(created.msg || "coze create chat failed"));
  }
  const data = asObj(created.data);
  const conversationId = String(data.conversation_id || "");
  const chatId = String(data.id || "");
  const root = base.replace(/\/+$/, "");
  let usage: CozeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (;;) {
    const retrieveUrl = `${root}/v3/chat/retrieve?conversation_id=${conversationId}&chat_id=${chatId}`;
    const retrieveRes = await fetch(retrieveUrl, { method: "GET", headers });
    const retrieveText = await retrieveRes.text();
    let retrieve: Record<string, unknown>;
    try {
      retrieve = JSON.parse(retrieveText) as Record<string, unknown>;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    const status = String(asObj(retrieve.data).status || "");
    if (status === "completed") {
      usage = usageFromCoze(asObj(asObj(retrieve.data).usage));
      break;
    }
    if (status === "failed" || status === "canceled" || status === "requires_action") {
      throw new Error(`chat status: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const listUrl = `${root}/v3/chat/message/list?conversation_id=${conversationId}&chat_id=${chatId}`;
  const listRes = await fetch(listUrl, { method: "GET", headers });
  return { response: listRes, usage };
}

function parseCozeSse(text: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = [];
  let currentEvent = "";
  let currentData = "";
  const flush = () => {
    if (currentEvent && currentData) events.push({ event: currentEvent, data: currentData });
    currentEvent = "";
    currentData = "";
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      currentData = line.slice(5).trim();
    }
  }
  flush();
  return events;
}

/** Original `coze.cozeChatStreamHandler`. */
export function cozeUpstreamToOpenAIChat(
  text: string,
  model: string,
  opts: { id?: string; created?: number; fallbackPromptTokens?: number } = {},
): { json: Record<string, unknown>; sse: string } {
  const id = opts.id || `chatcmpl-${Date.now()}`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(parsed.data) || parsed.code != null) {
      const json = openaiFromCozeDetailResponse(parsed, model, { id });
      return { json, sse: sseFromCozeJson(json, id, created, model) };
    }
  } catch {
    /* SSE */
  }
  const events = parseCozeSse(text);
  let sse = "";
  let responseText = "";
  let usage: CozeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const ev of events) {
    if (ev.event === "conversation.chat.completed") {
      try {
        const chatData = JSON.parse(ev.data) as Record<string, unknown>;
        usage = usageFromCoze(asObj(chatData.usage));
      } catch {
        /* original logs */
      }
      sse += sseLine({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      continue;
    }
    if (ev.event === "conversation.message.delta") {
      let content = "";
      try {
        const messageData = JSON.parse(ev.data) as Record<string, unknown>;
        const parsed = parseCozeContent(messageData.content);
        content = typeof parsed === "string" ? parsed : String(parsed ?? "");
      } catch {
        continue;
      }
      responseText += content;
      sse += sseLine({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content } }],
      });
    }
  }
  sse += "data: [DONE]\n\n";
  if (!usage.total_tokens) {
    const prompt = opts.fallbackPromptTokens || 0;
    const completion = Math.max(1, Math.ceil(responseText.length / 4));
    usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }
  const json: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    usage,
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
  };
  return { json, sse };
}

function sseFromCozeJson(json: Record<string, unknown>, id: string, created: number, model: string): string {
  const choice = Array.isArray(json.choices) ? asObj(json.choices[0]) : {};
  const message = asObj(choice.message);
  return (
    sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: message.content ?? "" } }],
    }) +
    sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    "data: [DONE]\n\n"
  );
}
