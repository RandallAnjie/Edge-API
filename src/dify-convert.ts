/** Original `relay/channel/dify` ConvertOpenAIRequest / DoResponse. */

import { asObj, parseSseDataPayloads, sseLine } from "./openai-usage.js";

export type ConvertDifyOpts = {
  responseId?: string;
  /** Original `constant.DifyDebug`; env default true. */
  difyDebug?: boolean;
  created?: number;
};

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") out += o.text;
  }
  return out;
}

function imageUrl(part: Record<string, unknown>): { url: string; mime: string } | null {
  const raw = part.image_url;
  if (typeof raw === "string") return { url: raw, mime: "" };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return { url: String(o.url || ""), mime: String(o.mime_type || "") };
  }
  return null;
}

function parseContent(content: unknown): { type: string; text?: string; image?: { url: string; mime: string } }[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: { type: string; text?: string; image?: { url: string; mime: string } }[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      out.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = String(o.type || "");
    if (type === "text") out.push({ type: "text", text: String(o.text || "") });
    else if (type === "image_url") {
      const img = imageUrl(o);
      if (img) out.push({ type: "image_url", image: img });
    }
  }
  return out;
}

function isRemoteImage(url: string): boolean {
  return url.startsWith("http");
}

function difyUser(body: Record<string, unknown>, responseId: string): string {
  if (typeof body.user === "string" && body.user) return body.user;
  return responseId;
}

/** Original `dify.requestOpenAI2Dify`. Local/data-URL images are omitted when upload is not available (same as original upload failure). */
export function convertDifyOpenAIRequest(body: Record<string, unknown>, opts: ConvertDifyOpts = {}): Record<string, unknown> {
  const responseId = opts.responseId || "chatcmpl-dify";
  const user = difyUser(body, responseId);
  const files: Record<string, unknown>[] = [];
  let query = "";
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  for (const message of messages) {
    if (message.role === "system") {
      query += "SYSTEM: \n" + stringContent(message.content) + "\n";
    } else if (message.role === "assistant") {
      query += "ASSISTANT: \n" + stringContent(message.content) + "\n";
    } else {
      for (const media of parseContent(message.content)) {
        if (media.type === "text") {
          query += "USER: \n" + (media.text || "") + "\n";
        } else if (media.type === "image_url" && media.image) {
          if (isRemoteImage(media.image.url)) {
            files.push({
              type: media.image.mime,
              transfer_mode: "remote_url",
              url: media.image.url,
            });
          }
        }
      }
    }
  }
  return {
    inputs: {},
    query,
    response_mode: body.stream ? "streaming" : "blocking",
    user,
    auto_generate_name: false,
    files,
  };
}

function usageFromMeta(meta: Record<string, unknown>): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const usage = asObj(meta.usage);
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

/** Original `dify.difyHandler` OpenAI chat JSON (`model` is the Go zero value). */
export function openaiFromDifyResponse(
  upstream: Record<string, unknown>,
  opts: { created?: number } = {},
): Record<string, unknown> {
  return {
    id: String(upstream.conversation_id || ""),
    model: "",
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    usage: usageFromMeta(asObj(upstream.metadata)),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: upstream.answer ?? "" },
        finish_reason: "stop",
      },
    ],
  };
}

const THINK_OPEN = `<details style="color:gray;background-color: #f8f8f8;padding: 8px;border-radius: 4px;" open> <summary> Thinking... </summary>\n`;

function mapDifyAnswer(answer: string): string {
  if (answer === THINK_OPEN) return "<think>";
  if (answer === "</details>") return "</think>";
  return answer;
}

/** Original `dify.streamResponseDify2OpenAI` + `difyStreamHandler`. */
export function difyUpstreamToOpenAIChat(
  text: string,
  opts: { created?: number; fallbackPromptTokens?: number; difyDebug?: boolean } = {},
): { json: Record<string, unknown>; sse: string } {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const debug = opts.difyDebug !== false;
  const payloads = parseDifyStream(text);
  if (payloads.length === 1 && payloads[0].conversation_id != null && payloads[0].answer != null && !payloads[0].event) {
    const json = openaiFromDifyResponse(payloads[0], { created });
    return { json, sse: sseFromDifyJson(json) };
  }
  let sse = "";
  let responseText = "";
  let nodeToken = 0;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const dify of payloads) {
    const event = String(dify.event || "");
    if (event === "message_end") {
      usage = usageFromMeta(asObj(dify.metadata));
      continue;
    }
    if (event === "error") continue;
    const choice: Record<string, unknown> = {};
    const delta: Record<string, unknown> = {};
    if (event.startsWith("workflow_")) {
      if (debug) {
        const data = asObj(dify.data);
        let reasoning = "Workflow: " + String(data.workflow_id || "");
        if (event === "workflow_finished") reasoning += " " + String(data.status || "");
        delta.reasoning_content = reasoning + "\n";
        nodeToken += 1;
      }
    } else if (event.startsWith("node_")) {
      if (debug) {
        const data = asObj(dify.data);
        let reasoning = "Node: " + String(data.node_type || "");
        if (event === "node_finished") reasoning += " " + String(data.status || "");
        delta.reasoning_content = reasoning + "\n";
        nodeToken += 1;
      }
    } else if (event === "message" || event === "agent_message") {
      const answer = mapDifyAnswer(String(dify.answer || ""));
      delta.content = answer;
      responseText += answer;
    }
    choice.delta = delta;
    sse += sseLine({
      object: "chat.completion.chunk",
      created,
      model: "dify",
      choices: [choice],
    });
  }
  sse += "data: [DONE]\n\n";
  if (!usage.total_tokens) {
    const prompt = opts.fallbackPromptTokens || 0;
    const completion = Math.max(1, Math.ceil(responseText.length / 4));
    usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }
  usage.completion_tokens = Number(usage.completion_tokens || 0) + nodeToken;
  usage.total_tokens = Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0);
  const json: Record<string, unknown> = {
    id: "",
    model: "dify",
    object: "chat.completion",
    created,
    usage,
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
  };
  return { json, sse };
}

function parseDifyStream(text: string): Record<string, unknown>[] {
  const payloads = parseSseDataPayloads(text);
  if (payloads.length) {
    return payloads.map((p) => {
      try {
        return JSON.parse(p) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  }
  try {
    return [JSON.parse(text) as Record<string, unknown>];
  } catch {
    return [];
  }
}

function sseFromDifyJson(json: Record<string, unknown>): string {
  const created = Number(json.created || Math.floor(Date.now() / 1000));
  const choice = Array.isArray(json.choices) ? asObj(json.choices[0]) : {};
  const message = asObj(choice.message);
  return (
    sseLine({
      object: "chat.completion.chunk",
      created,
      model: "dify",
      choices: [{ delta: { content: message.content ?? "" } }],
    }) + "data: [DONE]\n\n"
  );
}
