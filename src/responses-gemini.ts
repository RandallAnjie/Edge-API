/** Original `relaykit/relayconvert/internal/oai_responses` Responses → Gemini generateContent JSON. */

import {
  applyGeminiThinking,
  attachThoughtSignature,
  cleanFunctionParameters,
  GEMINI_MIME,
  hasFunctionCallContent,
  openAIToolChoiceToConfig,
  removeAdditionalProperties,
  type ConvertGeminiOpts,
} from "./gemini-convert.js";
import {
  applyToOpenAIChat,
  asClientError,
  fromOpenAIResponses,
  GEMINI_SAFETY_CATEGORIES,
  geminiSafetySettingFor,
  geminiSupportsImagine,
  type OpenAIChatBody,
  type ReasoningHostSettings,
} from "./reasoning.js";

/** Original `requestConverterOpenAIResponsesToGemini`. */
export const CONVERTER_RESPONSES_TO_GEMINI_DIRECT = "openai_responses_to_gemini_generate_content";

export type ConvertResponsesToGeminiOpts = ConvertGeminiOpts & {
  originModelName?: string;
  upstreamModelName?: string;
  settings?: ReasoningHostSettings;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  return t;
}

function present(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
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

function decodeDataURL(url: string): { data: string; mime: string } | null {
  const m = String(url).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  return { mime: m[1], data: m[2].replace(/\s+/g, "") };
}

function callID(item: Record<string, unknown>): string {
  const id = str(item.call_id).trim();
  if (id) return id;
  return str(item.id).trim();
}

function objectValue(value: unknown, fallbackKey: string): Record<string, unknown> {
  if (value == null) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      if (Array.isArray(parsed)) return { [fallbackKey]: parsed };
    } catch {
      /* keep raw string */
    }
    return { [fallbackKey]: value };
  }
  if (Array.isArray(value)) return { [fallbackKey]: value };
  return { [fallbackKey]: value };
}

function geminiResponseMap(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      if (Array.isArray(parsed)) return { result: parsed };
    } catch {
      /* keep raw string */
    }
    return { content: value };
  }
  if (Array.isArray(value)) return { result: value };
  return { content: value };
}

function responsesToolChoiceToChat(choice: unknown): unknown {
  if (choice == null || typeof choice === "string") return choice;
  const o = asObj(choice);
  if (str(o.type) === "function") {
    const name = str(o.name).trim();
    if (name) return { type: "function", function: { name } };
  }
  return choice;
}

function validateUnsupportedStatefulFields(req: Record<string, unknown>): void {
  const unsupported: string[] = [];
  if (present(req.conversation)) unsupported.push("conversation");
  if (str(req.previous_response_id).trim()) unsupported.push("previous_response_id");
  if (present(req.prompt)) unsupported.push("prompt");
  if (present(req.context_management)) unsupported.push("context_management");
  if (unsupported.length) {
    throw new Error(`responses to chat conversion does not support stateful fields: ${unsupported.join(", ")}`);
  }
}

/** Original `oairesponses.PrepareOpenAIResponsesRequest`. */
function prepareOpenAIResponsesRequest(body: Record<string, unknown>): Record<string, unknown> {
  const prepared: Record<string, unknown> = { ...body };
  if (Array.isArray(body.tools)) {
    const filtered = (body.tools as unknown[]).filter((raw) => str(asObj(raw).type).trim() === "function");
    prepared.tools = filtered.length ? filtered : undefined;
  }
  if (Array.isArray(body.input)) {
    const skippedCustomCallIDs = new Set<string>();
    for (const raw of body.input as unknown[]) {
      const item = asObj(raw);
      if (str(item.type).trim() !== "custom_tool_call") continue;
      const id = str(item.call_id).trim();
      if (id) skippedCustomCallIDs.add(id);
    }
    prepared.input = (body.input as unknown[]).filter((raw) => {
      const item = asObj(raw);
      const itemType = str(item.type).trim();
      if (itemType === "custom_tool_call" || itemType === "custom_tool_call_output") return false;
      if (itemType === "function_call_output" && skippedCustomCallIDs.has(str(item.call_id).trim())) return false;
      return true;
    });
  }
  return prepared;
}

function inputItems(input: unknown): Record<string, unknown>[] {
  if (input == null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return (input as unknown[]).map((item) => asObj(item));
  throw new Error(`unsupported responses input type ${JSON.stringify(jsonType(input))}`);
}

function contentParts(content: unknown): Record<string, unknown>[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: jsonString(content) }];
  const parts: Record<string, unknown>[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push({ type: "input_text", text: item });
    else parts.push(asObj(item));
  }
  return parts;
}

function partDataAndMime(part: Record<string, unknown>, keys: string[]): { data: string; mime: string } {
  let mime = str(part.mime_type).trim();
  for (const key of keys) {
    if (!(key in part)) continue;
    const value = part[key];
    if (typeof value === "string" && value) return { data: value, mime };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = asObj(value);
      if (!mime) mime = str(nested.mime_type).trim();
      for (const nestedKey of ["url", "file_data", "file_url", "data"]) {
        const data = str(nested[nestedKey]).trim();
        if (data) return { data, mime };
      }
    }
  }
  return { data: "", mime };
}

function contentPartFileSource(part: Record<string, unknown>): { data: string; mime: string } | null {
  const partType = str(part.type).trim();
  let data = "";
  let mime = "";
  switch (partType) {
    case "input_image":
      ({ data, mime } = partDataAndMime(part, ["image_url", "url"]));
      break;
    case "input_file":
      ({ data, mime } = partDataAndMime(part, ["file", "file_data", "file_url", "url"]));
      break;
    case "input_audio": {
      ({ data, mime } = partDataAndMime(part, ["input_audio", "data", "url"]));
      if (!mime) {
        const payload = asObj(part.input_audio);
        const format = str(payload.format).trim();
        if (format) mime = `audio/${format}`;
      }
      break;
    }
    case "input_video":
      ({ data, mime } = partDataAndMime(part, ["video_url", "url"]));
      break;
    default:
      return null;
  }
  if (!data) return null;
  return { data, mime };
}

function resolveGeminiMedia(source: { data: string; mime: string }): { data: string; mime: string } {
  const decoded = decodeDataURL(source.data);
  if (decoded) return { data: decoded.data, mime: decoded.mime || source.mime };
  if (/^[A-Za-z0-9+/=\s]+$/.test(source.data) && source.mime) {
    return { data: source.data.replace(/\s+/g, ""), mime: source.mime };
  }
  return { data: source.data, mime: source.mime };
}

function supportedMimeList(): string[] {
  return Object.keys(GEMINI_MIME);
}

function responsesContentPartToGeminiParts(part: Record<string, unknown>): Record<string, unknown>[] {
  const partType = str(part.type).trim();
  switch (partType) {
    case "input_text":
    case "output_text":
    case "text": {
      const text = str(part.text);
      if (!text) return [];
      return [{ text }];
    }
    case "input_image":
    case "input_file":
    case "input_audio":
    case "input_video": {
      const source = contentPartFileSource(part);
      if (!source) return [];
      const resolved = resolveGeminiMedia(source);
      const mime = resolved.mime.toLowerCase();
      if (!GEMINI_MIME[mime]) {
        throw new Error(
          `mime type is not supported by Gemini: '${resolved.mime}', url: '${source.data}', supported types are: ${supportedMimeList().join(" ")}`,
        );
      }
      return [{ inlineData: { mimeType: resolved.mime, data: resolved.data } }];
    }
    default:
      return [];
  }
}

function responsesInputContentToGeminiParts(content: unknown): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const part of contentParts(content)) {
    parts.push(...responsesContentPartToGeminiParts(part));
  }
  return parts;
}

function requestFunctionDeclarations(tools: unknown): { name: string; description: string; parameters: unknown }[] {
  if (!Array.isArray(tools)) return [];
  const functions: { name: string; description: string; parameters: unknown }[] = [];
  for (const raw of tools) {
    const tool = asObj(raw);
    if (str(tool.type).trim() !== "function") continue;
    const name = str(tool.name).trim();
    if (!name) continue;
    functions.push({
      name,
      description: str(tool.description),
      parameters: tool.parameters,
    });
  }
  return functions;
}

function applyResponsesTextToGemini(text: unknown, generationConfig: Record<string, unknown>): void {
  const format = asObj(asObj(text).format);
  const type = str(format.type).trim();
  if (type !== "json_schema" && type !== "json_object") return;
  generationConfig.responseMimeType = "application/json";
  if (type !== "json_schema") return;
  const schemaObj = format.schema;
  if (schemaObj && typeof schemaObj === "object") {
    generationConfig.responseSchema = removeAdditionalProperties(JSON.parse(JSON.stringify(schemaObj)), 0);
  }
}

function responsesGeminiRole(item: Record<string, unknown>): string {
  switch (str(item.role).trim()) {
    case "assistant":
      return "model";
    case "system":
    case "developer":
      return "system";
    case "model":
      return "model";
    default:
      return "user";
  }
}

function appendGeminiContentPart(contents: Record<string, unknown>[], role: string, part: Record<string, unknown>): void {
  if (contents.length && contents[contents.length - 1].role === role) {
    const last = contents[contents.length - 1];
    const parts = Array.isArray(last.parts) ? [...(last.parts as Record<string, unknown>[])] : [];
    if (role === "model" && part.functionCall) {
      let insertAt = 0;
      while (insertAt < parts.length && parts[insertAt].functionCall) insertAt++;
      parts.splice(insertAt, 0, part);
      last.parts = parts;
      return;
    }
    last.parts = [...parts, part];
    return;
  }
  contents.push({ role, parts: [part] });
}

function shouldAttachThoughtSignature(settings: ReasoningHostSettings | undefined): boolean {
  return (settings || {}).geminiFunctionCallThoughtSignatureEnabled !== false;
}

function attachFunctionCallThoughtSignature(
  settings: ReasoningHostSettings | undefined,
  part: Record<string, unknown>,
): void {
  if (!hasFunctionCallContent(asObj(part.functionCall))) return;
  if (!shouldAttachThoughtSignature(settings)) return;
  attachThoughtSignature(part);
}

/** Original `oairesponses.OpenAIResponsesRequestToGeminiChat`. */
export function convertOpenAIResponsesRequestToGeminiChat(
  body: Record<string, unknown>,
  opts: ConvertResponsesToGeminiOpts = {},
): Record<string, unknown> {
  if (!body) throw new Error("request is nil");
  const prepared = prepareOpenAIResponsesRequest(body);
  const model = str(prepared.model || "").trim();
  if (!model) throw new Error("model is required");
  validateUnsupportedStatefulFields(prepared);

  const settings = opts.settings || {};
  const generationConfig: Record<string, unknown> = {};
  if (prepared.temperature != null) generationConfig.temperature = prepared.temperature;
  if (prepared.top_p != null) generationConfig.topP = prepared.top_p;
  if (prepared.max_output_tokens != null) generationConfig.maxOutputTokens = prepared.max_output_tokens;

  let upstream = opts.upstreamModelName || model;
  if (geminiSupportsImagine(upstream, settings)) generationConfig.responseModalities = ["TEXT", "IMAGE"];
  applyResponsesTextToGemini(prepared.text, generationConfig);

  const geminiRequest: Record<string, unknown> = { contents: [] as Record<string, unknown>[], generationConfig };
  try {
    const sourceReasoning = fromOpenAIResponses(prepared);
    const pivot: OpenAIChatBody = {};
    applyToOpenAIChat(pivot, sourceReasoning);
    pivot.model = model;
    if (prepared.max_output_tokens != null) pivot.max_completion_tokens = prepared.max_output_tokens;
    applyGeminiThinking(geminiRequest, { ...opts, upstreamModelName: upstream, settings }, pivot);
  } catch (err) {
    throw asClientError(err);
  }

  const safetySettings: { category: string; threshold: string }[] = [];
  for (const category of GEMINI_SAFETY_CATEGORIES) {
    const threshold = geminiSafetySettingFor(category, settings);
    if (!threshold) continue;
    safetySettings.push({ category, threshold });
  }
  if (safetySettings.length) geminiRequest.safetySettings = safetySettings;

  const functions: Record<string, unknown>[] = [];
  for (const fn of requestFunctionDeclarations(prepared.tools)) {
    const next: Record<string, unknown> = { name: fn.name };
    if (fn.description) next.description = fn.description;
    const params = fn.parameters;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const props = asObj(asObj(params).properties);
      if ("properties" in (params as object) && Object.keys(props).length === 0) {
        functions.push(next);
        continue;
      }
    }
    if (params != null) next.parameters = cleanFunctionParameters(params);
    functions.push(next);
  }
  if (functions.length) geminiRequest.tools = [{ functionDeclarations: functions }];

  const toolChoice = responsesToolChoiceToChat(prepared.tool_choice);
  if (toolChoice != null) {
    const toolConfig = openAIToolChoiceToConfig(toolChoice);
    if (toolConfig) geminiRequest.toolConfig = toolConfig;
  }

  const systemTexts: string[] = [];
  if (present(prepared.instructions)) {
    const instructions = typeof prepared.instructions === "string" ? prepared.instructions : jsonString(prepared.instructions);
    if (instructions.trim()) systemTexts.push(instructions);
  }

  const contents: Record<string, unknown>[] = [];
  const callNames: Record<string, string> = {};
  for (const item of inputItems(prepared.input)) {
    const itemType = str(item.type).trim();
    if (itemType === "function_call") {
      const name = str(item.name).trim();
      if (!name) throw new Error("function_call item is missing name");
      const id = callID(item);
      const functionCall: Record<string, unknown> = {
        name,
        args: objectValue(item.arguments, "arguments"),
      };
      if (id) functionCall.id = id;
      const part: Record<string, unknown> = { functionCall };
      attachFunctionCallThoughtSignature(settings, part);
      if (id) callNames[id] = name;
      appendGeminiContentPart(contents, "model", part);
      continue;
    }
    if (itemType === "function_call_output") {
      const id = callID(item);
      let name = str(item.name).trim();
      if (!name) name = callNames[id] || "";
      const functionResponse: Record<string, unknown> = {
        name,
        response: geminiResponseMap(item.output),
      };
      if (id) functionResponse.id = id;
      appendGeminiContentPart(contents, "user", { functionResponse });
      continue;
    }
    const role = responsesGeminiRole(item);
    const parts = responsesInputContentToGeminiParts(item.content);
    if (role === "system") {
      for (const part of parts) {
        if (typeof part.text === "string" && part.text) systemTexts.push(part.text);
      }
      continue;
    }
    if (parts.length) contents.push({ role, parts });
  }

  geminiRequest.contents = contents;
  if (systemTexts.length) geminiRequest.systemInstruction = { parts: [{ text: systemTexts.join("\n") }] };
  geminiRequest.generationConfig = generationConfig;
  return geminiRequest;
}

/** Original advanced-custom ConvertOpenAIResponsesRequest ID `openai_responses_to_gemini_generate_content`. */
export function convertResponsesToGeminiRequest(
  body: Record<string, unknown>,
  opts: ConvertResponsesToGeminiOpts = {},
): Record<string, unknown> {
  return convertOpenAIResponsesRequestToGeminiChat(body, opts);
}
