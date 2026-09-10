/** Original `relaykit/relayconvert/internal/oai_chat/to_gemini_chat_req.go` + `gemini.Adaptor.ConvertGeminiRequest`. */

import {
  asClientError,
  equivalentGeminiStrength,
  fromGemini,
  fromOpenAIChat,
  GEMINI_SAFETY_CATEGORIES,
  GEMINI_THOUGHT_SIGNATURE_BYPASS,
  geminiSafetySettingFor,
  geminiSupportsImagine,
  intentHasStrength,
  intentIsEmpty,
  mergeExplicit,
  mergeExplicitAndSuffix,
  parseHostModelModifiers,
  renderGemini,
  resolveGeminiEnabledDefault,
  shouldPreserveThinkingSuffix,
  type GeminiThinkingConfig,
  type OpenAIChatBody,
  type ReasoningHostSettings,
  type ReasoningIntent,
} from "./reasoning.js";

export type ConvertGeminiOpts = {
  originModelName?: string;
  upstreamModelName?: string;
  settings?: ReasoningHostSettings;
  suffixIntent?: ReasoningIntent;
  resolveMedia?: (url: string) => { data: string; mime: string } | null;
};

const GEMINI_MIME: Record<string, boolean> = {
  "application/pdf": true,
  "audio/mpeg": true,
  "audio/mp3": true,
  "audio/wav": true,
  "image/png": true,
  "image/jpeg": true,
  "image/jpg": true,
  "image/webp": true,
  "image/heic": true,
  "image/heif": true,
  "text/plain": true,
  "video/mov": true,
  "video/mpeg": true,
  "video/mp4": true,
  "video/mpg": true,
  "video/avi": true,
  "video/wmv": true,
  "video/mpegps": true,
  "video/flv": true,
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function decodeDataURL(url: string): { data: string; mime: string } | null {
  const m = String(url).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  return { mime: m[1], data: m[2].replace(/\s+/g, "") };
}

function resolveImage(url: string, opts: ConvertGeminiOpts): { data: string; mime: string } | null {
  const dataURL = decodeDataURL(url);
  if (dataURL) return dataURL;
  if (opts.resolveMedia) return opts.resolveMedia(url);
  return null;
}

function parseStopSequences(stop: unknown): string[] {
  if (stop == null) return [];
  if (typeof stop === "string") return stop ? [stop] : [];
  if (Array.isArray(stop)) return stop.filter((item): item is string => typeof item === "string" && item !== "");
  return [];
}

const GEMINI_SCHEMA_FIELDS = new Set([
  "anyOf",
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);

function normalizeGeminiSchemaType(schema: Record<string, unknown>): void {
  const rawType = schema.type;
  if (rawType == null) return;
  const normalize = (t: string): { type: string; isNull: boolean } => {
    switch (t.toLowerCase().trim()) {
      case "object":
        return { type: "OBJECT", isNull: false };
      case "array":
        return { type: "ARRAY", isNull: false };
      case "string":
        return { type: "STRING", isNull: false };
      case "integer":
        return { type: "INTEGER", isNull: false };
      case "number":
        return { type: "NUMBER", isNull: false };
      case "boolean":
        return { type: "BOOLEAN", isNull: false };
      case "null":
        return { type: "", isNull: true };
      default:
        return { type: t, isNull: false };
    }
  };
  if (typeof rawType === "string") {
    const n = normalize(rawType);
    if (n.isNull) {
      schema.nullable = true;
      delete schema.type;
      return;
    }
    schema.type = n.type;
    return;
  }
  if (Array.isArray(rawType)) {
    let nullable = false;
    let chosen = "";
    for (const item of rawType) {
      if (typeof item !== "string") continue;
      const n = normalize(item);
      if (n.isNull) {
        nullable = true;
        continue;
      }
      if (!chosen) chosen = n.type;
    }
    if (nullable) schema.nullable = true;
    if (chosen) schema.type = chosen;
    else delete schema.type;
  }
}

function cleanFunctionParameters(params: unknown, depth = 0): unknown {
  if (params == null) return null;
  if (depth >= 64) {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(params as Record<string, unknown>)) {
        if (GEMINI_SCHEMA_FIELDS.has(key)) cleaned[key] = val;
      }
      normalizeGeminiSchemaType(cleaned);
      delete cleaned.properties;
      delete cleaned.items;
      delete cleaned.anyOf;
      return cleaned;
    }
    return Array.isArray(params) ? [] : params;
  }
  if (Array.isArray(params)) return params.map((item) => cleanFunctionParameters(item, depth + 1));
  if (typeof params !== "object") return params;
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params as Record<string, unknown>)) {
    if (GEMINI_SCHEMA_FIELDS.has(key)) cleaned[key] = val;
  }
  normalizeGeminiSchemaType(cleaned);
  if (cleaned.properties && typeof cleaned.properties === "object" && !Array.isArray(cleaned.properties)) {
    const props: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(cleaned.properties as Record<string, unknown>)) {
      props[name] = cleanFunctionParameters(value, depth + 1);
    }
    cleaned.properties = props;
  }
  if (cleaned.items && typeof cleaned.items === "object" && !Array.isArray(cleaned.items)) {
    cleaned.items = cleanFunctionParameters(cleaned.items, depth + 1);
  } else if (Array.isArray(cleaned.items) && cleaned.items.length) {
    cleaned.items = cleanFunctionParameters(cleaned.items[0], depth + 1);
  }
  if (Array.isArray(cleaned.anyOf)) cleaned.anyOf = cleaned.anyOf.map((item) => cleanFunctionParameters(item, depth + 1));
  return cleaned;
}

function removeAdditionalProperties(schema: unknown, depth: number): unknown {
  if (depth >= 5) return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const value = schema as Record<string, unknown>;
  delete value.title;
  delete value.$schema;
  if (value.type !== "object" && value.type !== "array") return schema;
  if (value.type === "object") {
    delete value.additionalProperties;
    if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
      for (const key of Object.keys(value.properties as Record<string, unknown>)) {
        (value.properties as Record<string, unknown>)[key] = removeAdditionalProperties((value.properties as Record<string, unknown>)[key], depth + 1);
      }
    }
    for (const field of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(value[field])) {
        value[field] = (value[field] as unknown[]).map((item) => removeAdditionalProperties(item, depth + 1));
      }
    }
  } else if (value.type === "array" && value.items && typeof value.items === "object" && !Array.isArray(value.items)) {
    value.items = removeAdditionalProperties(value.items, depth + 1);
  }
  return value;
}

function openAIToolChoiceToConfig(toolChoice: unknown): Record<string, unknown> | undefined {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") {
    const mode = toolChoice === "none" ? "NONE" : toolChoice === "required" ? "ANY" : "AUTO";
    return { functionCallingConfig: { mode } };
  }
  const o = asObj(toolChoice);
  if (o.type === "function") {
    const config: Record<string, unknown> = { functionCallingConfig: { mode: "ANY" } };
    const fn = asObj(o.function);
    if (typeof fn.name === "string" && fn.name) {
      (config.functionCallingConfig as Record<string, unknown>).allowedFunctionNames = [fn.name];
    }
    return config;
  }
  return undefined;
}

function suffixFrom(opts: ConvertGeminiOpts, model: string): ReasoningIntent {
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

function applyGeminiThinking(req: Record<string, unknown>, opts: ConvertGeminiOpts, oaiRequest?: OpenAIChatBody): void {
  const settings = opts.settings || {};
  let modelName = opts.upstreamModelName || "";
  let source: ReasoningIntent = { mode: "", effort: "", source: "", budgetSource: "" };
  const crossProtocol = oaiRequest != null;
  if (oaiRequest) {
    if (!modelName) modelName = String(oaiRequest.model || "");
    source = fromOpenAIChat(oaiRequest);
  }
  const baseModel = modelName;
  let suffix = suffixFrom(opts, modelName);
  if (shouldPreserveThinkingSuffix(modelName, settings) || shouldPreserveThinkingSuffix(opts.originModelName || "", settings)) {
    suffix = { mode: "", effort: "", source: "", budgetSource: "" };
  }
  if (!crossProtocol && !intentHasStrength(suffix) && intentIsEmpty(suffix)) {
    return;
  }
  let native = fromGemini(req);
  const maxOutput = Number(asObj(req.generationConfig).maxOutputTokens ?? 0) || undefined;
  source = resolveGeminiEnabledDefault(baseModel, source, maxOutput);
  if (intentHasStrength(native) && intentHasStrength(source)) {
    if (!equivalentGeminiStrength(baseModel, native, source)) {
      throw new Error(
        `reasoning settings conflict for model ${JSON.stringify(modelName)}: Gemini thinking_config effort differs from standard effort`,
      );
    }
    if (native.includeThoughts == null) native = { ...native, includeThoughts: source.includeThoughts };
    source = { mode: "", effort: "", source: "", budgetSource: "" };
  }
  let explicit = mergeExplicit(native, source, modelName);
  if (intentHasStrength(explicit) && intentHasStrength(suffix)) {
    if (equivalentGeminiStrength(baseModel, explicit, suffix)) {
      if (explicit.includeThoughts == null) explicit = { ...explicit, includeThoughts: suffix.includeThoughts };
      suffix = { mode: "", effort: "", source: "", budgetSource: "" };
    }
  }
  let requested = mergeExplicitAndSuffix(explicit, suffix, modelName);
  requested = resolveGeminiEnabledDefault(baseModel, requested, maxOutput);
  if (!req.generationConfig || typeof req.generationConfig !== "object") req.generationConfig = {};
  const gc = req.generationConfig as Record<string, unknown>;
  if (intentHasStrength(native) && !intentHasStrength(suffix)) {
    if (explicit.includeThoughts != null) {
      gc.thinkingConfig = { ...asObj(gc.thinkingConfig), includeThoughts: explicit.includeThoughts };
    }
    return;
  }
  if (intentIsEmpty(requested)) return;
  const percentage = settings.geminiThinkingAdapterBudgetTokensPercentage ?? 0.6;
  const rendered = renderGemini(baseModel, requested, maxOutput, percentage);
  if (rendered.config) gc.thinkingConfig = rendered.config as GeminiThinkingConfig;
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const o = asObj(part);
        return typeof o.text === "string" ? o.text : "";
      })
      .join("");
  }
  return "";
}

function hasFunctionCallContent(call: Record<string, unknown> | undefined): boolean {
  if (!call) return false;
  if (String(call.name || "").trim()) return true;
  const args = call.args;
  if (args == null) return false;
  if (typeof args === "string") return args.trim() !== "";
  if (typeof args === "object") return Object.keys(args as object).length > 0;
  return true;
}

function attachThoughtSignature(part: Record<string, unknown>): boolean {
  if (part.thoughtSignature) return false;
  part.thoughtSignature = GEMINI_THOUGHT_SIGNATURE_BYPASS;
  return true;
}

/** Original `gemini.Adaptor.ConvertGeminiRequest`. */
export function convertGeminiRequest(body: Record<string, unknown>, opts: ConvertGeminiOpts = {}): Record<string, unknown> {
  const req: Record<string, unknown> = { ...body };
  if (req.generationConfig && typeof req.generationConfig === "object") req.generationConfig = { ...asObj(req.generationConfig) };
  const settings = opts.settings || {};
  const origin = opts.originModelName || "";
  const upstream = opts.upstreamModelName || origin;
  const parsed = parseHostModelModifiers(origin || upstream, settings);
  if (parsed.hasThinking) {
    const gc = { ...asObj(req.generationConfig) };
    delete gc.thinkingConfig;
    if (parsed.hasTemperature) gc.temperature = parsed.temperature;
    if (parsed.hasTopP) gc.topP = parsed.topP;
    req.generationConfig = gc;
    opts = { ...opts, suffixIntent: parsed.intent, upstreamModelName: parsed.base || upstream };
  }
  try {
    applyGeminiThinking(req, opts);
  } catch (err) {
    throw asClientError(err);
  }
  const contents = Array.isArray(req.contents) ? (req.contents as Record<string, unknown>[]) : [];
  for (let i = 0; i < contents.length; i++) {
    const content = { ...contents[i] };
    if (i === 0 && !content.role) content.role = "user";
    contents[i] = content;
  }
  if (contents.length) req.contents = contents;
  return req;
}

/** Original `OpenAIChatRequestToGeminiGenerateContent`. */
export function convertOpenAIChatToGemini(body: OpenAIChatBody, opts: ConvertGeminiOpts = {}): Record<string, unknown> {
  const settings = opts.settings || {};
  const generationConfig: Record<string, unknown> = {};
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.top_p != null) generationConfig.topP = body.top_p;
  if (body.max_completion_tokens != null) generationConfig.maxOutputTokens = body.max_completion_tokens;
  else if (body.max_tokens != null) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.seed != null) generationConfig.seed = Number(body.seed);

  let upstream = opts.upstreamModelName || String(body.model || "");
  if (geminiSupportsImagine(upstream, settings)) generationConfig.responseModalities = ["TEXT", "IMAGE"];
  const stops = parseStopSequences(body.stop);
  if (stops.length) generationConfig.stopSequences = stops.slice(0, 5);

  const extra = asObj(body.extra_body);
  const google = asObj(extra.google);
  if (extra.google && typeof extra.google === "object") {
    if ("thinkingConfig" in google) throw asClientError(new Error("extra_body.google.thinkingConfig is not supported, use extra_body.google.thinking_config instead"));
    const thinkingConfig = asObj(google.thinking_config);
    if (google.thinking_config && typeof google.thinking_config === "object") {
      if ("thinkingBudget" in thinkingConfig) {
        throw asClientError(new Error("extra_body.google.thinking_config.thinkingBudget is not supported, use extra_body.google.thinking_config.thinking_budget instead"));
      }
      const temp: GeminiThinkingConfig = {};
      let has = false;
      if ("thinking_budget" in thinkingConfig) {
        const v = Number(thinkingConfig.thinking_budget);
        if (!Number.isInteger(v)) throw asClientError(new Error("extra_body.google.thinking_config.thinking_budget must be an integer"));
        temp.thinkingBudget = v;
        has = true;
      }
      if ("include_thoughts" in thinkingConfig) {
        if (typeof thinkingConfig.include_thoughts !== "boolean") {
          throw asClientError(new Error("extra_body.google.thinking_config.include_thoughts must be a boolean"));
        }
        temp.includeThoughts = thinkingConfig.include_thoughts as boolean;
        has = true;
      }
      if ("thinking_level" in thinkingConfig) {
        if (typeof thinkingConfig.thinking_level !== "string") {
          throw asClientError(new Error("extra_body.google.thinking_config.thinking_level must be a string"));
        }
        temp.thinkingLevel = thinkingConfig.thinking_level as string;
        has = true;
      }
      if (has) generationConfig.thinkingConfig = temp;
    }
    if ("imageConfig" in google) throw asClientError(new Error("extra_body.google.imageConfig is not supported, use extra_body.google.image_config instead"));
    const imageConfig = asObj(google.image_config);
    if (google.image_config && typeof google.image_config === "object") {
      if ("aspectRatio" in imageConfig) throw asClientError(new Error("extra_body.google.image_config.aspectRatio is not supported, use extra_body.google.image_config.aspect_ratio instead"));
      if ("imageSize" in imageConfig) throw asClientError(new Error("extra_body.google.image_config.imageSize is not supported, use extra_body.google.image_config.image_size instead"));
      const geminiImage: Record<string, unknown> = {};
      if ("aspect_ratio" in imageConfig) geminiImage.aspectRatio = imageConfig.aspect_ratio;
      if ("image_size" in imageConfig) geminiImage.imageSize = imageConfig.image_size;
      if (Object.keys(geminiImage).length) generationConfig.imageConfig = geminiImage;
    }
  }

  const geminiRequest: Record<string, unknown> = { contents: [] as unknown[], generationConfig };
  try {
    applyGeminiThinking(geminiRequest, { ...opts, upstreamModelName: upstream }, body);
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

  if (Array.isArray(body.tools)) {
    const functions: Record<string, unknown>[] = [];
    for (const tool of body.tools as unknown[]) {
      const fn = { ...asObj(asObj(tool).function) };
      const params = fn.parameters;
      if (params && typeof params === "object" && !Array.isArray(params)) {
        const props = asObj(asObj(params).properties);
        if ("properties" in (params as object) && Object.keys(props).length === 0) fn.parameters = undefined;
      }
      fn.parameters = cleanFunctionParameters(fn.parameters);
      functions.push(fn);
    }
    const tools: Record<string, unknown>[] = [];
    if (functions.length) tools.push({ functionDeclarations: functions });
    if (tools.length) geminiRequest.tools = tools;
    if (body.tool_choice != null) {
      const toolConfig = openAIToolChoiceToConfig(body.tool_choice);
      if (toolConfig) geminiRequest.toolConfig = toolConfig;
    }
  }

  const responseFormat = asObj(body.response_format);
  if (responseFormat.type === "json_schema" || responseFormat.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
    const schema = responseFormat.json_schema ?? responseFormat.schema;
    const schemaObj = asObj(schema).schema ?? schema;
    if (schemaObj && typeof schemaObj === "object") {
      generationConfig.responseSchema = removeAdditionalProperties(JSON.parse(JSON.stringify(schemaObj)), 0);
    }
  }

  const attachSignatures = settings.geminiFunctionCallThoughtSignatureEnabled !== false;
  const toolCallIDs: Record<string, string> = {};
  const systemContent: string[] = [];
  const contents: Record<string, unknown>[] = [];
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  for (const message of messages) {
    const role = String(message.role || "user");
    if (role === "system" || role === "developer") {
      systemContent.push(stringContent(message.content));
      continue;
    }
    if (role === "tool" || role === "function") {
      if (!contents.length || contents[contents.length - 1].role === "model") contents.push({ role: "user", parts: [] });
      const last = contents[contents.length - 1];
      const parts = Array.isArray(last.parts) ? [...(last.parts as unknown[])] : [];
      let name = typeof message.name === "string" ? message.name : "";
      const toolCallId = String(message.tool_call_id || "");
      if (!name && toolCallId && toolCallIDs[toolCallId]) name = toolCallIDs[toolCallId];
      const contentStr = stringContent(message.content);
      let contentMap: Record<string, unknown>;
      try {
        const parsed = JSON.parse(contentStr);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) contentMap = parsed as Record<string, unknown>;
        else if (Array.isArray(parsed)) contentMap = { result: parsed };
        else contentMap = { content: contentStr };
      } catch {
        contentMap = { content: contentStr };
      }
      const functionResp: Record<string, unknown> = { name, response: contentMap };
      if (toolCallId) functionResp.id = toolCallId;
      parts.push({ functionResponse: functionResp });
      last.parts = parts;
      continue;
    }

    const parts: Record<string, unknown>[] = [];
    const shouldAttach = (role === "assistant" || role === "model") && attachSignatures;
    let signatureAttached = false;
    if (message.tool_calls != null && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as unknown[]) {
        const o = asObj(call);
        const fn = asObj(o.function);
        let args: Record<string, unknown> = {};
        if (typeof fn.arguments === "string" && fn.arguments) {
          try {
            const parsed = JSON.parse(fn.arguments);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
            else throw new Error("invalid");
          } catch {
            throw asClientError(new Error(`invalid arguments for function ${fn.name}, args: ${fn.arguments}`));
          }
        }
        const toolCall: Record<string, unknown> = {
          functionCall: { id: o.id, name: fn.name, args },
        };
        if (shouldAttach && !signatureAttached && hasFunctionCallContent(asObj(toolCall.functionCall)) && attachThoughtSignature(toolCall)) {
          signatureAttached = true;
        }
        parts.push(toolCall);
        toolCallIDs[String(o.id || "")] = String(fn.name || "");
      }
    }

    const openaiContent = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    for (const rawPart of openaiContent) {
      const part = typeof rawPart === "string" ? { type: "text", text: rawPart } : asObj(rawPart);
      if (String(part.type || "text") === "text") {
        const text = String(part.text || "");
        if (!text) continue;
        let remaining = text;
        let hasMarkdownImage = false;
        while (true) {
          const startIdx = remaining.indexOf("![");
          if (startIdx === -1) break;
          const bracketRel = remaining.slice(startIdx).indexOf("](data:");
          if (bracketRel === -1) break;
          const bracketIdx = startIdx + bracketRel;
          const closeRel = remaining.slice(bracketIdx + 2).indexOf(")");
          if (closeRel === -1) break;
          const closeIdx = bracketIdx + 2 + closeRel;
          hasMarkdownImage = true;
          if (startIdx > 0) {
            const before = remaining.slice(0, startIdx);
            if (before) parts.push({ text: before });
          }
          const dataURL = remaining.slice(bracketIdx + 2, closeIdx);
          const decoded = decodeDataURL(dataURL);
          if (!decoded) throw asClientError(new Error("decode markdown base64 image data failed"));
          const imgPart: Record<string, unknown> = { inlineData: { mimeType: decoded.mime, data: decoded.data } };
          if (shouldAttach) attachThoughtSignature(imgPart);
          parts.push(imgPart);
          remaining = remaining.slice(closeIdx + 1);
        }
        if (!hasMarkdownImage) parts.push({ text });
      } else {
        const image = asObj(part.image_url || part.imageUrl);
        const url = typeof image.url === "string" ? image.url : typeof part.url === "string" ? String(part.url) : "";
        if (!url) continue;
        const resolved = resolveImage(url, opts);
        if (!resolved) continue;
        const mime = resolved.mime.toLowerCase();
        if (!GEMINI_MIME[mime]) {
          throw asClientError(new Error(`mime type is not supported by Gemini: '${resolved.mime}', url: '${url}'`));
        }
        parts.push({ inlineData: { mimeType: resolved.mime, data: resolved.data } });
      }
    }
    if (shouldAttach && !signatureAttached) {
      for (const part of parts) {
        if (typeof part.text === "string" && part.text && !part.thoughtSignature) {
          attachThoughtSignature(part);
          break;
        }
      }
    }
    const contentRole = role === "assistant" ? "model" : role;
    if (parts.length) contents.push({ role: contentRole, parts });
  }
  geminiRequest.contents = contents;
  if (systemContent.length) {
    geminiRequest.systemInstruction = { parts: [{ text: systemContent.join("\n") }] };
  }
  geminiRequest.generationConfig = generationConfig;
  return geminiRequest;
}
