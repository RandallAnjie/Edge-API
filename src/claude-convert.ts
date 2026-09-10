/** Original `relaykit/relayconvert/internal/oai_chat/to_claude_messages_req.go` + `claude.Adaptor.ConvertClaudeRequest`. */

import {
  asClientError,
  claudeDefaultMaxTokensFor,
  claudeUsesManualThinking,
  ERR_MISSING_CLAUDE_MAX_TOKENS,
  fromClaude,
  fromOpenAIChat,
  intentHasStrength,
  isKnownClaudeModel,
  mergeExplicit,
  mergeExplicitAndSuffix,
  parseHostModelModifiers,
  renderClaude,
  shouldPreserveThinkingSuffix,
  type OpenAIChatBody,
  type ReasoningHostSettings,
  type ReasoningIntent,
} from "./reasoning.js";

export type ConvertClaudeOpts = {
  originModelName?: string;
  upstreamModelName?: string;
  settings?: ReasoningHostSettings;
  suffixIntent?: ReasoningIntent;
  resolveMedia?: (url: string) => { data: string; mime: string } | null;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
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

function isStringContent(content: unknown): boolean {
  return typeof content === "string" || content == null;
}

function decodeDataURL(url: string): { data: string; mime: string } | null {
  const m = String(url).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  return { mime: m[1], data: m[2].replace(/\s+/g, "") };
}

function functionParametersToInputSchema(parameters: unknown): Record<string, unknown> {
  const params = parameters && typeof parameters === "object" && !Array.isArray(parameters) ? { ...(parameters as Record<string, unknown>) } : {};
  if (params.type == null) params.type = "object";
  if (params.properties == null) params.properties = {};
  return params;
}

function mapOpenAIToolChoice(toolChoice: unknown, parallelToolCalls: unknown): Record<string, unknown> | undefined {
  let choice: Record<string, unknown> | undefined;
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") choice = { type: "auto" };
    else if (toolChoice === "required") choice = { type: "any" };
    else if (toolChoice === "none") choice = { type: "none" };
  } else if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const fn = asObj(asObj(toolChoice).function);
    if (typeof fn.name === "string") choice = { type: "tool", name: fn.name };
  }
  if (typeof parallelToolCalls === "boolean") {
    if (!choice) choice = { type: "auto" };
    if (choice.type !== "none") choice.disable_parallel_tool_use = !parallelToolCalls;
  }
  return choice;
}

function parseToolCalls(message: Record<string, unknown>): { id: string; name: string; arguments: string }[] {
  const raw = message.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = asObj(item);
    const fn = asObj(o.function);
    return {
      id: String(o.id || ""),
      name: String(fn.name || ""),
      arguments: typeof fn.arguments === "string" ? fn.arguments : fn.arguments != null ? JSON.stringify(fn.arguments) : "",
    };
  });
}

function parseOpenAIParts(content: unknown): { type: string; text?: string; url?: string }[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: { type: string; text?: string; url?: string }[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) parts.push({ type: "text", text: item });
      continue;
    }
    const o = asObj(item);
    const type = String(o.type || "text");
    if (type === "text") {
      if (typeof o.text === "string" && o.text) parts.push({ type: "text", text: o.text });
      continue;
    }
    const image = asObj(o.image_url || o.imageUrl);
    const url = typeof image.url === "string" ? image.url : typeof o.url === "string" ? o.url : "";
    if (url) parts.push({ type, url });
    else if (typeof o.text === "string" && o.text) parts.push({ type: "text", text: o.text });
  }
  return parts;
}

function resolveImage(url: string, opts: ConvertClaudeOpts): { data: string; mime: string } | null {
  const dataURL = decodeDataURL(url);
  if (dataURL) return dataURL;
  if (opts.resolveMedia) return opts.resolveMedia(url);
  return null;
}

function suffixFrom(opts: ConvertClaudeOpts, model: string): ReasoningIntent {
  if (opts.suffixIntent) return opts.suffixIntent;
  const settings = opts.settings || {};
  const origin = opts.originModelName || model;
  const upstream = opts.upstreamModelName || model;
  if (shouldPreserveThinkingSuffix(origin, settings) || shouldPreserveThinkingSuffix(upstream, settings)) {
    return { mode: "", effort: "", source: "", budgetSource: "" };
  }
  const originParsed = parseHostModelModifiers(origin, settings);
  let selected = originParsed;
  if (upstream !== origin) selected = parseHostModelModifiers(upstream, settings);
  return selected.hasThinking ? selected.intent : { mode: "", effort: "", source: "", budgetSource: "" };
}

function applyClaudeReasoning(req: Record<string, unknown>, source: ReasoningIntent, opts: ConvertClaudeOpts, crossProtocol: boolean): void {
  const settings = opts.settings || {};
  const baseModel = String(req.model || "");
  let capabilityModel = baseModel;
  let suffix = suffixFrom(opts, baseModel);
  if (shouldPreserveThinkingSuffix(baseModel, settings) || shouldPreserveThinkingSuffix(opts.originModelName || "", settings)) {
    suffix = { mode: "", effort: "", source: "", budgetSource: "" };
  }
  if (!crossProtocol && !intentHasStrength(source) && !intentHasStrength(suffix)) {
    return;
  }
  const native = fromClaude(req);
  const explicit = mergeExplicit(native, source, String(req.model || ""));
  if (!isKnownClaudeModel(capabilityModel) && isKnownClaudeModel(opts.originModelName || "")) {
    capabilityModel = String(opts.originModelName || "");
  }
  const intent = mergeExplicitAndSuffix(explicit, suffix, String(req.model || ""));
  let working = intent;
  if (!isKnownClaudeModel(capabilityModel) && working.mode === "adaptive") {
    working = { ...working, mode: "enabled", effort: working.effort || "high" };
  }
  let maxTokens = req.max_tokens != null ? Number(req.max_tokens) : undefined;
  if (maxTokens == null && intentHasStrength(working)) {
    let minimum = 1280;
    const configured = claudeDefaultMaxTokensFor(capabilityModel, settings);
    if (configured > 0) minimum = configured;
    if (claudeUsesManualThinking(capabilityModel, working) && working.budgetTokens != null && working.budgetTokens >= 0) {
      const required = working.budgetTokens + 1;
      if (minimum < required) minimum = required;
    }
    maxTokens = minimum;
    req.max_tokens = minimum;
  }
  const percentage = settings.claudeThinkingAdapterBudgetTokensPercentage ?? 0.8;
  const rendered = renderClaude(capabilityModel, working, maxTokens, percentage);
  req.model = baseModel;
  if (rendered.thinking) req.thinking = rendered.thinking;
  if (rendered.outputEffort) {
    const output = req.output_config && typeof req.output_config === "object" && !Array.isArray(req.output_config) ? { ...(req.output_config as Record<string, unknown>) } : {};
    output.effort = rendered.outputEffort;
    req.output_config = output;
  }
  if (rendered.clearSampling) {
    delete req.temperature;
    delete req.top_p;
    delete req.top_k;
  } else if (rendered.constrainThinkingSampling) {
    delete req.temperature;
    delete req.top_k;
    if (req.top_p != null && (Number(req.top_p) < 0.95 || Number(req.top_p) > 1)) delete req.top_p;
  }
}

/** Original `claude.Adaptor.ConvertClaudeRequest`. */
export function convertClaudeRequest(body: Record<string, unknown>, opts: ConvertClaudeOpts = {}): Record<string, unknown> {
  const req: Record<string, unknown> = { ...body };
  if (req.max_tokens != null && Number(req.max_tokens) === 0) delete req.max_tokens;
  const settings = opts.settings || {};
  const origin = opts.originModelName || String(req.model || "");
  const upstream = opts.upstreamModelName || String(req.model || "");
  const parsed = parseHostModelModifiers(origin !== upstream ? upstream : origin, settings);
  if (parsed.hasThinking) {
    delete req.thinking;
    if (req.output_config && typeof req.output_config === "object" && !Array.isArray(req.output_config)) {
      const output = { ...(req.output_config as Record<string, unknown>) };
      delete output.effort;
      req.output_config = Object.keys(output).length ? output : undefined;
      if (req.output_config == null) delete req.output_config;
    }
    if (parsed.hasTemperature) req.temperature = parsed.temperature;
    if (parsed.hasTopP) req.top_p = parsed.topP;
    req.model = parsed.base;
    opts = { ...opts, suffixIntent: parsed.intent, upstreamModelName: parsed.base };
  }
  try {
    applyClaudeReasoning(req, { mode: "", effort: "", source: "", budgetSource: "" }, opts, false);
  } catch (err) {
    throw asClientError(err);
  }
  if (req.max_tokens == null) req.max_tokens = claudeDefaultMaxTokensFor(String(req.model || ""), settings);
  return req;
}

/** Original `OpenAIChatRequestToClaudeMessages`. */
export function convertOpenAIChatToClaude(body: OpenAIChatBody, opts: ConvertClaudeOpts = {}): Record<string, unknown> {
  const settings = opts.settings || {};
  const toolsIn = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const claudeTools: unknown[] = [];
  for (const rawTool of toolsIn) {
    const t = asObj(rawTool);
    const fn = asObj(t.function);
    if (!(fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)) && t.type !== "function") continue;
    const claudeTool: Record<string, unknown> = {
      name: String(fn.name || ""),
      input_schema: functionParametersToInputSchema(fn.parameters),
    };
    if (fn.description) claudeTool.description = String(fn.description);
    claudeTools.push(claudeTool);
  }
  const webSearch = asObj(body.web_search_options);
  if (body.web_search_options != null) {
    const webSearchTool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search" };
    if (webSearch.user_location != null) {
      const location: Record<string, unknown> = { type: "approximate" };
      const loc = asObj(webSearch.user_location);
      const approx = asObj(loc.approximate);
      if (typeof approx.timezone === "string" && approx.timezone) location.timezone = approx.timezone;
      if (typeof approx.country === "string" && approx.country) location.country = approx.country;
      if (typeof approx.region === "string" && approx.region) location.region = approx.region;
      if (typeof approx.city === "string" && approx.city) location.city = approx.city;
      webSearchTool.user_location = location;
    }
    claudeTools.push(webSearchTool);
  }

  const upstream = opts.upstreamModelName || String(body.model || "");
  const claudeRequest: Record<string, unknown> = { model: upstream };
  if (body.temperature != null) claudeRequest.temperature = body.temperature;
  if (claudeTools.length) claudeRequest.tools = claudeTools;
  const maxCompletion = Number(body.max_completion_tokens ?? 0);
  const maxTokens = Number(body.max_tokens ?? 0);
  if (maxCompletion > 0) claudeRequest.max_tokens = maxCompletion;
  else if (maxTokens > 0) claudeRequest.max_tokens = maxTokens;
  if (body.top_p != null) claudeRequest.top_p = body.top_p;
  if (body.top_k != null) claudeRequest.top_k = body.top_k;
  if (body.stream) claudeRequest.stream = true;
  if (body.tool_choice != null || body.parallel_tool_calls != null) {
    const choice = mapOpenAIToolChoice(body.tool_choice, body.parallel_tool_calls);
    if (choice) claudeRequest.tool_choice = choice;
  }

  let sourceReasoning: ReasoningIntent;
  try {
    sourceReasoning = fromOpenAIChat(body);
    applyClaudeReasoning(claudeRequest, sourceReasoning, { ...opts, upstreamModelName: upstream }, true);
  } catch (err) {
    throw asClientError(err);
  }
  if (claudeRequest.max_tokens == null) {
    claudeRequest.max_tokens = claudeDefaultMaxTokensFor(String(claudeRequest.model || ""), settings);
  }

  if (body.stop != null) {
    if (typeof body.stop === "string") claudeRequest.stop_sequences = [body.stop];
    else if (Array.isArray(body.stop)) claudeRequest.stop_sequences = body.stop.map((item) => String(item));
  }

  const messagesIn = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const formatMessages: Record<string, unknown>[] = [];
  let lastMessage: Record<string, unknown> = { role: "tool" };
  for (const raw of messagesIn) {
    const message = { ...raw };
    switch (String(message.role || "")) {
      case "":
        message.role = "user";
        break;
      case "developer":
        message.role = "system";
        break;
      case "function":
        message.role = message.tool_call_id ? "tool" : "user";
        break;
      case "tool":
        if (!message.tool_call_id) message.role = "user";
        break;
      case "system":
      case "user":
      case "assistant":
        break;
      default:
        message.role = "user";
    }
    const fmtMessage: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === "tool") fmtMessage.tool_call_id = message.tool_call_id;
    if (message.role === "assistant" && message.tool_calls != null) fmtMessage.tool_calls = message.tool_calls;
    if (String(lastMessage.role) === String(message.role) && message.role !== "tool") {
      if (isStringContent(lastMessage.content) && isStringContent(message.content)) {
        fmtMessage.content = `${stringContent(lastMessage.content)} ${stringContent(message.content)}`;
        formatMessages.pop();
      }
    }
    if (fmtMessage.content == null || (isStringContent(fmtMessage.content) && stringContent(fmtMessage.content) === "")) {
      fmtMessage.content = "...";
    }
    formatMessages.push(fmtMessage);
    lastMessage = fmtMessage;
  }

  const claudeMessages: Record<string, unknown>[] = [];
  let isFirstMessage = true;
  const systemMessages: Record<string, unknown>[] = [];
  const placeholderUserMessage = { role: "user", content: [{ type: "text", text: "..." }] };

  for (const message of formatMessages) {
    if (message.role === "system") {
      if (isStringContent(message.content)) {
        const text = stringContent(message.content);
        if (text) systemMessages.push({ type: "text", text });
      } else {
        for (const part of parseOpenAIParts(message.content)) {
          if (part.type === "text" && part.text) systemMessages.push({ type: "text", text: part.text });
        }
      }
      continue;
    }
    if (isFirstMessage) {
      isFirstMessage = false;
      if (message.role !== "user") claudeMessages.push(placeholderUserMessage);
    }
    const claudeMessage: Record<string, unknown> = { role: message.role };
    if (message.role === "tool") {
      if (claudeMessages.length && claudeMessages[claudeMessages.length - 1].role === "user") {
        const last = { ...claudeMessages[claudeMessages.length - 1] };
        if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
        const content = Array.isArray(last.content) ? [...(last.content as unknown[])] : [];
        content.push({ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content });
        last.content = content;
        claudeMessages[claudeMessages.length - 1] = last;
        continue;
      }
      claudeMessage.role = "user";
      claudeMessage.content = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }];
    } else if (isStringContent(message.content) && message.tool_calls == null) {
      let text = stringContent(message.content);
      if (!text) text = "...";
      claudeMessage.content = text;
    } else {
      const claudeMedia: Record<string, unknown>[] = [];
      for (const part of parseOpenAIParts(message.content)) {
        if (part.type === "text") {
          if (part.text) claudeMedia.push({ type: "text", text: part.text });
          continue;
        }
        if (!part.url) continue;
        const resolved = resolveImage(part.url, opts);
        if (!resolved) continue;
        const media: Record<string, unknown> = { source: { type: "base64", media_type: resolved.mime, data: resolved.data } };
        media.type = resolved.mime.startsWith("application/pdf") ? "document" : "image";
        claudeMedia.push(media);
      }
      if (message.tool_calls != null) {
        for (const call of parseToolCalls(message)) {
          let inputObj: Record<string, unknown> = {};
          if (call.arguments) {
            try {
              const parsed = JSON.parse(call.arguments);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inputObj = parsed as Record<string, unknown>;
            } catch {
              inputObj = {};
            }
          }
          claudeMedia.push({ type: "tool_use", id: call.id, name: call.name, input: inputObj });
        }
      }
      claudeMessage.content = claudeMedia;
    }
    claudeMessages.push(claudeMessage);
  }
  if (!claudeMessages.length && systemMessages.length) claudeMessages.push(placeholderUserMessage);
  if (systemMessages.length) claudeRequest.system = systemMessages;
  claudeRequest.messages = claudeMessages;
  if (claudeRequest.max_tokens == null) throw asClientError(new Error(ERR_MISSING_CLAUDE_MAX_TOKENS));
  return claudeRequest;
}
