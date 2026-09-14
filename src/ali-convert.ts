/** Original `relay/channel/ali` GetRequestURL / ConvertImageRequest / ConvertRerankRequest / DoResponse. */

import { getImageFromUrl } from "./image-download.js";
import { asInt, asObj } from "./openai-usage.js";

export const DEFAULT_ALI_ANTHROPIC_MESSAGES_MODELS = "qwen,deepseek-v4,kimi,glm,minimax-m";

/** Original `setting/model_setting` default `qwen.sync_image_models`. */
export const DEFAULT_QWEN_SYNC_IMAGE_MODELS = [
  "z-image",
  "qwen-image",
  "wan2.6",
  "wan2.7",
  "qwen-image-edit",
  "qwen-image-edit-max",
  "qwen-image-edit-max-2026-01-16",
  "qwen-image-edit-plus",
  "qwen-image-edit-plus-2025-12-15",
  "qwen-image-edit-plus-2025-10-30",
];

const MAX_IMAGE_N = 128;
const ALI_ASYNC_FIRST_WAIT_MS = 5_000;
const ALI_ASYNC_STEP_WAIT_MS = 10_000;
const ALI_ASYNC_MAX_STEP = 20;

export type ConvertAliImageOpts = {
  upstreamModelName?: string;
  requestPath?: string;
};

export type ConvertAliRerankOpts = {
  upstreamModelName?: string;
};

export type AliHeaderOpts = {
  isStream?: boolean;
  upstreamModel: string;
  requestPath?: string;
  mode?: string;
  plugin?: string;
};

export type AliImageInboundOpts = {
  created?: number;
  responseFormat?: string;
  channelBase?: string;
  channelKey?: string;
  isSync?: boolean;
  originBody?: unknown;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  upstreamStatus?: number;
};

type AliRelayError = Error & {
  type?: string;
  code?: string;
  param?: string;
  status?: number;
  aliHandler?: "image" | "rerank";
};

function envAliAnthropicModels(): string {
  try {
    const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ALI_ANTHROPIC_MESSAGES_MODELS;
    if (typeof raw === "string" && raw.trim()) return raw;
  } catch {
    /* workerd has no process */
  }
  return DEFAULT_ALI_ANTHROPIC_MESSAGES_MODELS;
}

function aliAnthropicMessagesModelPatterns(): string[] {
  return envAliAnthropicModels()
    .split(",")
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean);
}

/** Original `ali.supportsAliAnthropicMessages`. */
export function supportsAliAnthropicMessages(modelName: string): boolean {
  const normalized = String(modelName || "").toLowerCase().trim();
  if (!normalized) return false;
  return aliAnthropicMessagesModelPatterns().some((pattern) => normalized.includes(pattern));
}

/** Original `model_setting.IsSyncImageModel`. */
export function isAliSyncImageModel(modelName: string): boolean {
  const model = String(modelName || "");
  return DEFAULT_QWEN_SYNC_IMAGE_MODELS.some((m) => model.includes(m));
}

/** Original `ali.isWanModel`. */
export function isWanModel(modelName: string): boolean {
  return String(modelName || "").includes("wan");
}

/** Original `ali.isOldWanModel`. */
export function isOldWanModel(modelName: string): boolean {
  const model = String(modelName || "");
  if (!model.includes("wan")) return false;
  return !model.includes("wan2.6") && !model.includes("wan2.7");
}

export function isAliImageEdits(requestPath: string): boolean {
  return String(requestPath || "").includes("/edits");
}

/**
 * Original `Adaptor.IsSyncImageModel` after ConvertImageRequest.
 * Generations: `IsSyncImageModel(upstream)`. Edits: sync list unless the model is Wan.
 */
export function aliImageIsSync(upstreamModel: string, requestPath = ""): boolean {
  if (!isAliSyncImageModel(upstreamModel)) return false;
  if (isAliImageEdits(requestPath) && isWanModel(upstreamModel)) return false;
  return true;
}

function aliRoot(base: string): string {
  return String(base || "").replace(/\/+$/, "");
}

/**
 * Original `ali.Adaptor.GetRequestURL`.
 * Claude format is checked before RelayMode. Image generations vs edits follow `info.RelayMode`.
 */
export function aliRequestURL(
  base: string,
  mode: string,
  requestPath: string,
  upstreamModel: string,
  relayFormat?: string,
): string {
  const root = aliRoot(base);
  if (mode === "messages" || relayFormat === "claude") {
    if (supportsAliAnthropicMessages(upstreamModel)) return `${root}/apps/anthropic/v1/messages`;
    return `${root}/compatible-mode/v1/chat/completions`;
  }
  switch (mode) {
    case "embeddings":
      return `${root}/compatible-mode/v1/embeddings`;
    case "rerank":
      return `${root}/api/v1/services/rerank/text-rerank/text-rerank`;
    case "responses":
      return `${root}/api/v2/apps/protocols/compatible-mode/v1/responses`;
    case "images":
      if (isAliImageEdits(requestPath)) {
        if (isOldWanModel(upstreamModel)) return `${root}/api/v1/services/aigc/image2image/image-synthesis`;
        if (isWanModel(upstreamModel)) return `${root}/api/v1/services/aigc/image-generation/generation`;
        return `${root}/api/v1/services/aigc/multimodal-generation/generation`;
      }
      if (isAliSyncImageModel(upstreamModel)) {
        return `${root}/api/v1/services/aigc/multimodal-generation/generation`;
      }
      return `${root}/api/v1/services/aigc/text2image/image-synthesis`;
    case "completions":
      return `${root}/compatible-mode/v1/completions`;
    default:
      return `${root}/compatible-mode/v1/chat/completions`;
  }
}

/** Original `ali.Adaptor.SetupRequestHeader`. */
export function applyAliHeaders(headers: Record<string, string>, opts: AliHeaderOpts): void {
  if (opts.isStream) headers["X-DashScope-SSE"] = "enable";
  const plugin = String(opts.plugin || "").trim();
  if (plugin) headers["X-DashScope-Plugin"] = plugin;
  const mode = opts.mode || "";
  const path = opts.requestPath || "";
  if (mode === "images" && !isAliImageEdits(path)) {
    if (!isAliSyncImageModel(opts.upstreamModel)) headers["X-DashScope-Async"] = "enable";
  }
  if (mode === "images" && isAliImageEdits(path)) {
    if (isWanModel(opts.upstreamModel)) headers["X-DashScope-Async"] = "enable";
    headers["content-type"] = "application/json";
  }
}

function extraParameters(body: Record<string, unknown>): Record<string, unknown> | null {
  const raw = body.parameters;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

function extraInput(body: Record<string, unknown>): unknown {
  return body.input;
}

/** Original `dto.ImageRequest.ImageCount(true)` for Ali. */
export function aliImageCount(body: Record<string, unknown>): number {
  let n = 1;
  const top = Number(body.n);
  if (Number.isFinite(top) && top !== 0) n = Math.trunc(top);
  if (n > MAX_IMAGE_N) throw new Error(`n must be an integer between 1 and ${MAX_IMAGE_N}`);
  const parameters = extraParameters(body);
  if (parameters && parameters.n != null) {
    const pn = Number(parameters.n);
    if (!Number.isFinite(pn) || pn > MAX_IMAGE_N || pn === 0) {
      throw new Error(`parameters.n must be an integer between 1 and ${MAX_IMAGE_N}`);
    }
    n = Math.trunc(pn);
  }
  return n;
}

/** Original `oaiImage2AliImageRequest`. */
export function convertAliImageRequest(body: Record<string, unknown>, opts: ConvertAliImageOpts = {}): Record<string, unknown> {
  const upstream = String(opts.upstreamModelName || body.model || "");
  const extraParams = extraParameters(body);
  let parameters: Record<string, unknown> = {};
  const size = String(body.size || "").replace(/x/g, "*");
  if (size) parameters.size = size;
  if (typeof body.watermark === "boolean") parameters.watermark = body.watermark;
  if (extraParams) {
    parameters = { ...extraParams };
  }
  const count = aliImageCount(body);
  parameters.n = count;
  if (extraParams && "prompt_extend" in extraParams) parameters.prompt_extend = extraParams.prompt_extend;

  const providedInput = extraInput(body);
  let input: unknown;
  if (providedInput != null) {
    input = providedInput;
  } else if (aliImageIsSync(upstream, opts.requestPath || "")) {
    input = {
      messages: [{ role: "user", content: [{ text: String(body.prompt || "") }] }],
    };
  } else {
    input = { prompt: String(body.prompt || "") };
  }

  const out: Record<string, unknown> = { model: upstream, input, parameters };
  const format = String(body.response_format || "");
  if (format) out.response_format = format;
  return out;
}

type AliFormFile = { name: string; data: Uint8Array };

export type AliParsedMultipart = {
  values: Record<string, string>;
  files: AliFormFile[];
};

function wrapError(prefix: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${prefix}: ${message}`);
}

function multipartBoundary(contentType: string): string {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return (match?.[1] || match?.[2] || "").trim();
}

/** Original `net/http.DetectContentType` for image-edit file bytes. */
export function aliDetectContentType(data: Uint8Array): string {
  const b = data.length > 512 ? data.subarray(0, 512) : data;
  const at = (i: number): number => (i < b.length ? b[i] : -1);
  const starts = (sig: number[]): boolean => sig.every((v, i) => at(i) === v);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (starts([0x42, 0x4d])) return "image/bmp";
  if (starts([0x52, 0x49, 0x46, 0x46]) && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return "image/webp";
  }
  if (starts([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c <= 0x08 || c === 0x0b || (c >= 0x0e && c <= 0x1a) || (c >= 0x1c && c <= 0x1f)) {
      return "application/octet-stream";
    }
  }
  return "text/plain; charset=utf-8";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Original gin multipart File vs Value split for `oaiFormEdit2AliImageEdit`. */
export function parseAliImageEditForm(rawBody: ArrayBuffer, contentType: string): AliParsedMultipart {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error("multipart boundary is required");
  const text = new TextDecoder("latin1").decode(rawBody);
  const delim = `--${boundary}`;
  const start = text.indexOf(delim);
  if (start < 0) throw new Error("multipart boundary not found");
  const values: Record<string, string> = {};
  const files: AliFormFile[] = [];
  let pos = start + delim.length;
  while (pos < text.length) {
    if (text.startsWith("--", pos)) break;
    if (text.startsWith("\r\n", pos)) pos += 2;
    const next = text.indexOf(`\r\n${delim}`, pos);
    if (next < 0) break;
    const part = text.slice(pos, next);
    pos = next + 2 + delim.length;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4);
    const disp = /^content-disposition:\s*(.+)$/im.exec(headers)?.[1] || "";
    const name = /(?:^|;)\s*name="([^"]*)"/.exec(disp)?.[1] || /(?:^|;)\s*name=([^;]+)/.exec(disp)?.[1]?.trim() || "";
    if (!name) continue;
    const hasFilename = /(?:^|;)\s*filename=/i.test(disp);
    const data = Uint8Array.from(bodyText, (c) => c.charCodeAt(0));
    if (hasFilename) files.push({ name, data });
    else values[name] = new TextDecoder("utf-8").decode(data);
  }
  return { values, files };
}

/**
 * Original `GetAndValidOpenAIImageRequest` multipart edits branch + Ali `ImageCount(true)`.
 * Does not mutate the parsed form; `n` stays the incoming top-level value.
 */
export function aliImageRequestFromEditForm(values: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: values.prompt || "",
    model: values.model || "",
  };
  if (Object.prototype.hasOwnProperty.call(values, "n") && String(values.n).trim() !== "") {
    const nValue = String(values.n).trim();
    const n = Number(nValue);
    if (!Number.isInteger(n) || n < 0 || n > MAX_IMAGE_N) {
      throw new Error(`n must be an integer between 1 and ${MAX_IMAGE_N}`);
    }
    body.n = n;
  }
  if (values.quality) body.quality = values.quality;
  if (values.size) body.size = values.size;
  if (Object.prototype.hasOwnProperty.call(values, "parameters") && values.parameters !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.parameters);
    } catch (err) {
      throw wrapError("invalid image parameters", err);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid image parameters: json: cannot unmarshal non-object into ImageBillingParameters");
    }
    body.parameters = parsed;
  }
  if (body.n == null || body.n === 0) body.n = 1;
  if (Object.prototype.hasOwnProperty.call(values, "watermark")) {
    body.watermark = values.watermark === "true";
  }
  return body;
}

/** Original `getImageBase64sFromForm`. */
function getImageBase64sFromForm(form: AliParsedMultipart): string[] {
  let imageFiles = form.files.filter((file) => file.name === "image");
  if (imageFiles.length === 0) {
    imageFiles = form.files.filter((file) => file.name === "image[]");
  }
  if (imageFiles.length === 0) {
    imageFiles = form.files.filter((file) => file.name.startsWith("image["));
  }
  if (imageFiles.length === 0) throw new Error("image is required");
  return imageFiles.map((file) => {
    const mimeType = aliDetectContentType(file.data);
    return `data:${mimeType};base64,${bytesToBase64(file.data)}`;
  });
}

function formImageBase64s(form: AliParsedMultipart): string[] {
  try {
    return getImageBase64sFromForm(form);
  } catch (err) {
    throw wrapError("get image base64s from form failed", err);
  }
}

function formEditParameters(body: Record<string, unknown>, includeWatermark: boolean): Record<string, unknown> {
  const parameters: Record<string, unknown> = { n: aliImageCount(body) };
  if (includeWatermark && typeof body.watermark === "boolean") parameters.watermark = body.watermark;
  const extraParams = extraParameters(body);
  if (extraParams && "prompt_extend" in extraParams) parameters.prompt_extend = extraParams.prompt_extend;
  return parameters;
}

/** Original `oaiFormEdit2AliImageEdit`. */
function oaiFormEdit2AliImageEdit(
  form: AliParsedMultipart,
  request: Record<string, unknown>,
  upstream: string,
): Record<string, unknown> {
  const imageBase64s = formImageBase64s(form);
  const mediaContents: Record<string, string>[] = imageBase64s.map((image) => ({ image }));
  const textPart: Record<string, string> = {};
  const prompt = String(request.prompt || "");
  if (prompt) textPart.text = prompt;
  mediaContents.push(textPart);
  const out: Record<string, unknown> = {
    model: upstream,
    input: { messages: [{ role: "user", content: mediaContents }] },
    parameters: formEditParameters(request, true),
  };
  const format = String(request.response_format || "");
  if (format) out.response_format = format;
  return out;
}

/** Original `oaiFormEdit2WanxImageEdit`. */
function oaiFormEdit2WanxImageEdit(
  form: AliParsedMultipart,
  request: Record<string, unknown>,
  upstream: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: Object.prototype.hasOwnProperty.call(form.values, "prompt") ? form.values.prompt : String(request.prompt || ""),
    images: formImageBase64s(form),
  };
  if (Object.prototype.hasOwnProperty.call(form.values, "negative_prompt") && form.values.negative_prompt) {
    input.negative_prompt = form.values.negative_prompt;
  }
  const out: Record<string, unknown> = {
    model: upstream,
    input,
    parameters: formEditParameters(request, false),
  };
  const format = String(request.response_format || "");
  if (format) out.response_format = format;
  return out;
}

/**
 * Original `Adaptor.ConvertImageRequest` for `RelayModeImagesEdits` + multipart/form-data.
 * Old Wan models use `oaiFormEdit2WanxImageEdit`; others use `oaiFormEdit2AliImageEdit`.
 */
export function convertAliFormEditFromRaw(
  rawBody: ArrayBuffer,
  contentType: string,
  opts: ConvertAliImageOpts = {},
): Record<string, unknown> {
  const upstream = String(opts.upstreamModelName || "");
  let form: AliParsedMultipart;
  try {
    form = parseAliImageEditForm(rawBody, contentType);
  } catch (err) {
    const parseErr = wrapError("failed to parse image edit form request", err);
    if (isOldWanModel(upstream)) throw parseErr;
    throw wrapError("convert image edit form request failed", wrapError("get image base64s from form failed", parseErr));
  }
  const request = aliImageRequestFromEditForm(form.values);
  if (!upstream) request.model = String(request.model || "");
  const model = upstream || String(request.model || "");
  if (isOldWanModel(model)) return oaiFormEdit2WanxImageEdit(form, request, model);
  try {
    return oaiFormEdit2AliImageEdit(form, request, model);
  } catch (err) {
    throw wrapError("convert image edit form request failed", err);
  }
}

/** Original `ali.ConvertRerankRequest`. */
export function convertAliRerankRequest(body: Record<string, unknown>, opts: ConvertAliRerankOpts = {}): Record<string, unknown> {
  const returnDocuments = body.return_documents == null ? true : Boolean(body.return_documents);
  const parameters: Record<string, unknown> = { return_documents: returnDocuments };
  if (body.top_n != null) parameters.top_n = body.top_n;
  return {
    model: opts.upstreamModelName || body.model,
    input: {
      query: body.query,
      documents: Array.isArray(body.documents) ? body.documents : [],
    },
    parameters,
  };
}

function typedAliError(
  message: string,
  fields: { type: string; code: string; param?: string; status?: number; aliHandler?: "image" | "rerank" },
): AliRelayError {
  const err = new Error(message) as AliRelayError;
  err.type = fields.type;
  err.code = fields.code;
  if (fields.param != null) err.param = fields.param;
  if (fields.status != null) err.status = fields.status;
  if (fields.aliHandler) err.aliHandler = fields.aliHandler;
  return err;
}

function imageDataItem(url: string, b64Json: string, revisedPrompt: string): Record<string, string> {
  return { url, b64_json: b64Json, revised_prompt: revisedPrompt };
}

async function resultToOpenAIImageData(
  results: unknown[],
  responseFormat: string,
): Promise<Record<string, string>[]> {
  const imageData: Record<string, string>[] = [];
  for (const raw of results) {
    const data = asObj(raw);
    const url = String(data.url || "");
    let b64Json = "";
    if (responseFormat === "b64_json") {
      try {
        b64Json = (await getImageFromUrl(url)).data;
      } catch {
        continue;
      }
    } else {
      b64Json = String(data.b64_image || "");
    }
    imageData.push(imageDataItem(url, b64Json, ""));
  }
  return imageData;
}

async function choicesToOpenAIImageData(
  choices: unknown[],
  responseFormat: string,
): Promise<Record<string, string>[]> {
  const imageData: Record<string, string>[] = [];
  for (const rawChoice of choices) {
    const choice = asObj(rawChoice);
    const message = asObj(choice.message);
    const content = Array.isArray(message.content) ? message.content : [];
    let url = "";
    let b64Json = "";
    let revisedPrompt = "";
    for (const rawPart of content) {
      const part = asObj(rawPart);
      const image = String(part.image || "");
      if (image) {
        if (image.startsWith("http")) {
          if (responseFormat === "b64_json") {
            try {
              b64Json = (await getImageFromUrl(image)).data;
            } catch {
              continue;
            }
          }
          url = image;
        } else {
          b64Json = image;
        }
      } else if (String(part.text || "")) {
        revisedPrompt = String(part.text || "");
      }
    }
    imageData.push(imageDataItem(url, b64Json, revisedPrompt));
  }
  return imageData;
}

async function responseAli2OpenAIImage(
  response: Record<string, unknown>,
  originBody: unknown,
  created: number,
  responseFormat: string,
): Promise<Record<string, unknown>> {
  const output = asObj(response.output);
  const results = Array.isArray(output.results) ? output.results : [];
  const choices = Array.isArray(output.choices) ? output.choices : [];
  let data: Record<string, string>[] | null = null;
  if (results.length > 0) data = await resultToOpenAIImageData(results, responseFormat);
  else if (choices.length > 0) data = await choicesToOpenAIImageData(choices, responseFormat);
  return {
    created,
    data,
    metadata: originBody,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateAliTask(
  channelBase: string,
  apiKey: string,
  taskId: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const url = `${aliRoot(channelBase)}/api/v1/tasks/${taskId}`;
  try {
    const resp = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${apiKey}` } });
    const text = await resp.text();
    try {
      return { ok: true, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { ok: false, body: {} };
    }
  } catch {
    return { ok: false, body: {} };
  }
}

async function asyncTaskWait(
  channelBase: string,
  apiKey: string,
  taskId: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  let step = 0;
  await sleep(ALI_ASYNC_FIRST_WAIT_MS);
  for (;;) {
    step += 1;
    const rsp = await updateAliTask(channelBase, apiKey, taskId, fetchImpl);
    if (!rsp.ok) {
      await sleep(ALI_ASYNC_STEP_WAIT_MS);
      continue;
    }
    const taskStatus = String(asObj(rsp.body.output).task_status || "");
    if (!taskStatus) return {};
    if (taskStatus === "FAILED" || taskStatus === "CANCELED" || taskStatus === "SUCCEEDED" || taskStatus === "UNKNOWN") {
      return rsp.body;
    }
    if (step >= ALI_ASYNC_MAX_STEP) break;
    await sleep(ALI_ASYNC_STEP_WAIT_MS);
  }
  throw typedAliError("aliAsyncTaskWait timeout", { type: "new_api_error", code: "bad_response", status: 500, aliHandler: "image" });
}

/** Original `ali.aliImageHandler` + `responseAli2OpenAIImage`. */
export async function openaiFromAliImage(
  upstream: Record<string, unknown>,
  opts: AliImageInboundOpts = {},
): Promise<Record<string, unknown>> {
  const message = String(upstream.message || "");
  if (message) {
    throw typedAliError(message, { type: "new_api_error", code: "bad_response", status: 500, aliHandler: "image" });
  }
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const responseFormat = String(opts.responseFormat || "");
  const originFirst = opts.originBody != null ? opts.originBody : upstream;
  let aliResponse = upstream;
  let originBody: unknown = originFirst;
  if (!opts.isSync) {
    const taskId = String(asObj(upstream.output).task_id || "");
    const fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
    const sleep = opts.sleep || defaultSleep;
    aliResponse = await asyncTaskWait(String(opts.channelBase || ""), String(opts.channelKey || ""), taskId, fetchImpl, sleep);
    originBody = aliResponse;
    const status = String(asObj(aliResponse.output).task_status || "");
    if (status !== "SUCCEEDED") {
      const output = asObj(aliResponse.output);
      throw typedAliError(String(output.message || ""), {
        type: "ali_error",
        code: String(output.code || ""),
        status: opts.upstreamStatus || 200,
        aliHandler: "image",
      });
    }
  }
  return responseAli2OpenAIImage(aliResponse, originBody, created, responseFormat);
}

/** Original `ali.RerankHandler`. */
export function openaiFromAliRerank(upstream: Record<string, unknown>, opts: { upstreamStatus?: number } = {}): Record<string, unknown> {
  const code = String(upstream.code || "");
  if (code) {
    throw typedAliError(String(upstream.message || ""), {
      type: code,
      code,
      param: String(upstream.request_id || ""),
      status: opts.upstreamStatus || 200,
      aliHandler: "rerank",
    });
  }
  const output = asObj(upstream.output);
  const total = asInt(asObj(upstream.usage).total_tokens);
  return {
    results: Array.isArray(output.results) ? output.results : [],
    usage: {
      prompt_tokens: total,
      completion_tokens: 0,
      total_tokens: total,
    },
  };
}
