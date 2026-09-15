/** Original `relay/channel/mistral` ConvertOpenAIRequest / GetRequestURL. */

import { randomCharsKey } from "./crypto.js";
import { asObj } from "./openai-usage.js";

const MISTRAL_TOOL_CALL_ID = /^[a-zA-Z0-9]{9}$/;

export type ConvertMistralOpts = {
  upstreamModelName?: string;
};

function getMaxTokens(req: Record<string, unknown>): number {
  const maxCompletion = Number(req.max_completion_tokens ?? 0);
  if (maxCompletion) return Math.trunc(maxCompletion);
  return Math.trunc(Number(req.max_tokens ?? 0));
}

function imageUrlString(imageUrl: unknown): string {
  if (typeof imageUrl === "string") return imageUrl;
  return String(asObj(imageUrl).url || "");
}

function parseMedia(content: unknown): Record<string, unknown>[] | null {
  if (content == null) return null;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type === "text") {
      out.push({ type: "text", text: String(o.text || "") });
      continue;
    }
    if (o.type === "image_url") {
      out.push({ type: "image_url", image_url: imageUrlString(o.image_url) });
      continue;
    }
    out.push({ ...o });
  }
  return out;
}

function remapToolCallId(id: string, idMap: Map<string, string>): string {
  if (!id) return id;
  if (MISTRAL_TOOL_CALL_ID.test(id)) return id;
  const existing = idMap.get(id);
  if (existing) return existing;
  const next = randomCharsKey(9);
  idMap.set(id, next);
  return next;
}

/** Original `mistral.requestOpenAI2Mistral`. Drops extra fields including `stream_options`. */
export function convertMistralOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertMistralOpts = {},
): Record<string, unknown> {
  const idMap = new Map<string, string>();
  const src = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const messages: Record<string, unknown>[] = [];
  for (const message of src) {
    let toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : null;
    if (toolCalls) {
      toolCalls = toolCalls.map((call) => {
        const id = String(call.id || "");
        return { ...call, id: remapToolCallId(id, idMap) };
      });
    }
    let toolCallId = String(message.tool_call_id || "");
    if (toolCallId) {
      const mapped = idMap.get(toolCallId);
      if (mapped) toolCallId = mapped;
      else if (!MISTRAL_TOOL_CALL_ID.test(toolCallId)) {
        const next = randomCharsKey(9);
        idMap.set(toolCallId, next);
        toolCallId = next;
      }
    }
    let media =
      message.role === "assistant" && toolCalls != null && message.content === ""
        ? []
        : parseMedia(message.content);
    const outMsg: Record<string, unknown> = {
      role: message.role,
      content: media,
    };
    if (toolCalls) outMsg.tool_calls = toolCalls;
    if (toolCallId) outMsg.tool_call_id = toolCallId;
    messages.push(outMsg);
  }
  const out: Record<string, unknown> = {
    model: opts.upstreamModelName || String(body.model || ""),
    messages,
  };
  if (typeof body.stream === "boolean") out.stream = body.stream;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools;
  if (body.tool_choice != null) out.tool_choice = body.tool_choice;
  if (body.max_tokens != null || body.max_completion_tokens != null) out.max_tokens = getMaxTokens(body);
  return out;
}
