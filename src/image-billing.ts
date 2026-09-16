/**
 * Original `dto.ImageRequest.ImageCount`, `helper.GetAndValidOpenAIImageRequest`
 * multipart edits, `helper.ResolveImageBillingRequestInput`, and
 * `RelayInfo.UpdateImageCount` (workerd).
 */
import type { BillingRequestInput } from "./billing-expr.js";
import { CHANNEL_TYPE_ALI } from "./constants.js";
import { parseMultipartForm } from "./multipart-form.js";
import { MAX_IMAGE_N } from "./task-plugin-usage.js";

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Original `common.ZImagePromptExtendMultiplier`. */
export const Z_IMAGE_PROMPT_EXTEND_MULTIPLIER = 2;

/** Original `dto.ImageRequest.legacyDallePriceRatio`. */
export function legacyDallePriceRatio(model: string, size = "", quality = ""): number {
  if (!model.startsWith("dall-e")) return 1;
  let sizeRatio = 1;
  let qualityRatio = 1;
  if (size === "256x256") sizeRatio = 0.4;
  else if (size === "512x512") sizeRatio = 0.45;
  else if (size === "1024x1792" || size === "1792x1024") sizeRatio = 2;
  if (model === "dall-e-3" && quality === "hd") {
    qualityRatio = 2;
    if (size === "1024x1792" || size === "1792x1024") qualityRatio = 1.5;
  }
  return sizeRatio * qualityRatio;
}

/** Original `dto.ImageRequest.ImageCount`. */
export function imageRequestCount(body: Record<string, unknown>, useProviderParameters: boolean): number {
  let n = 1;
  const top = body.n;
  if (top != null && top !== "" && Number(top) !== 0) n = Math.trunc(Number(top));
  if (!Number.isFinite(n) || n > MAX_IMAGE_N) {
    throw new Error(`n must be an integer between 1 and ${MAX_IMAGE_N}`);
  }
  const parameters = asObj(body.parameters);
  if (Object.prototype.hasOwnProperty.call(parameters, "n") && parameters.n != null) {
    const pn = Number(parameters.n);
    if (!Number.isFinite(pn) || pn > MAX_IMAGE_N || (useProviderParameters && pn === 0)) {
      throw new Error(`parameters.n must be an integer between 1 and ${MAX_IMAGE_N}`);
    }
    if (useProviderParameters) n = Math.trunc(pn);
  }
  return n;
}

/** Original `helper.ResolveImageBillingRequestInput`. */
export function resolveImageBillingRequestInput(
  body: Record<string, unknown>,
  channelType: number,
  input: BillingRequestInput = {},
): BillingRequestInput {
  const count = imageRequestCount(body, channelType === CHANNEL_TYPE_ALI);
  const topLevelCount = imageRequestCount(body, false);
  const frozen: Record<string, unknown> = {
    model: body.model,
    n: topLevelCount,
    size: body.size,
    quality: body.quality,
  };
  if (body.parameters != null) frozen.parameters = body.parameters;
  return { ...input, body: frozen, imageCount: count };
}

/** Original `gjson.GetBytes(responseBody, "data.#")`. */
export function openaiImageDataCount(body: Record<string, unknown>): number {
  return Array.isArray(body.data) ? body.data.length : 0;
}

/** Original `RelayInfo.UpdateImageCount` for tiered_expr snapshots. */
export function updateBillingImageCount(count: number, estimatedImageCount: number | undefined): number | undefined {
  if (count <= 0 || count > MAX_IMAGE_N) return undefined;
  if (estimatedImageCount == null) return undefined;
  return Math.trunc(count);
}

/** Original ImageHelper outbound JSON body used for per-attempt quantity. */
export function jsonObjectFromRelayBody(body: unknown): { obj: Record<string, unknown> } | { error: string } | null {
  if (body == null) return null;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { obj: parsed as Record<string, unknown> };
      return { error: "invalid image billing parameters: json: cannot unmarshal" };
    } catch (err) {
      return { error: `invalid image billing parameters: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return null;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) return null;
  if (typeof body === "object" && !Array.isArray(body)) return { obj: body as Record<string, unknown> };
  return null;
}

/**
 * Original ImageHelper: when outbound `n` is nil, keep the previous ImageCount;
 * otherwise `dto.ImageRequest.ImageCount` on the converted/overridden body.
 */
export function outboundImageQuantity(
  outbound: Record<string, unknown>,
  previousCount: number,
  useProviderParameters: boolean,
): { count: number; promptExtend: boolean } {
  const n = outbound.n;
  const body: Record<string, unknown> = {
    n: n == null ? previousCount : n,
    parameters: outbound.parameters,
  };
  const parameters = asObj(outbound.parameters);
  return {
    count: imageRequestCount(body, useProviderParameters),
    promptExtend: parameters.prompt_extend === true,
  };
}

/** Original ImageHelper `sjson.SetBytes(..., "parameters.n", imageCount)` for Ali. */
export function applyAliImageParametersN(body: Record<string, unknown>, count: number): Record<string, unknown> {
  return { ...body, parameters: { ...asObj(body.parameters), n: count } };
}

/**
 * Original ImageHelper convert/param-override quantity refresh + Ali `parameters.n`.
 * Multipart/binary bodies keep the previous count (jsonData == nil).
 */
export function refreshOutboundImageQuantity(
  target: { body: unknown },
  previousCount: number,
  channelType: number,
): { count: number; promptExtend: boolean; error?: string } {
  const parsed = jsonObjectFromRelayBody(target.body);
  if (parsed && "error" in parsed) {
    return { count: previousCount, promptExtend: false, error: parsed.error };
  }
  if (!parsed) return { count: previousCount, promptExtend: false };
  let quantity: { count: number; promptExtend: boolean };
  try {
    quantity = outboundImageQuantity(parsed.obj, previousCount, channelType === CHANNEL_TYPE_ALI);
  } catch (err) {
    return { count: previousCount, promptExtend: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (channelType === CHANNEL_TYPE_ALI) {
    const next = applyAliImageParametersN(parsed.obj, quantity.count);
    target.body = typeof target.body === "string" ? JSON.stringify(next) : next;
  }
  return quantity;
}

/** Original `strconv.ParseBool`. */
export function parseGoBool(value: string): boolean {
  switch (value) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      throw new Error(`strconv.ParseBool: parsing "${value}": invalid syntax`);
  }
}

function formGet(values: Record<string, string[]>, key: string): string {
  return values[key]?.[0] ?? "";
}

function formHas(values: Record<string, string[]>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

function parseAtoi(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * Original `helper.GetAndValidOpenAIImageRequest` multipart `RelayModeImagesEdits` branch.
 * Channel-type ImageCount(Ali) is applied later after distributor channel select.
 */
export function getAndValidOpenAIImageEditMultipart(
  rawBody: ArrayBuffer,
  contentType: string,
): Record<string, unknown> {
  let values: Record<string, string[]>;
  try {
    values = parseMultipartForm(rawBody, contentType).values;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse image edit form request: ${message}`);
  }
  const imageRequest: Record<string, unknown> = {
    prompt: formGet(values, "prompt"),
    model: formGet(values, "model"),
  };
  const nValue = formGet(values, "n").trim();
  if (nValue) {
    const n = parseAtoi(nValue);
    if (n == null || n < 0 || n > MAX_IMAGE_N) {
      throw new Error(`n must be an integer between 1 and ${MAX_IMAGE_N}`);
    }
    imageRequest.n = n;
  }
  const quality = formGet(values, "quality");
  if (quality) imageRequest.quality = quality;
  const size = formGet(values, "size");
  if (size) imageRequest.size = size;
  const parameters = formGet(values, "parameters");
  if (parameters) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(parameters);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid image parameters: ${message}`);
    }
    imageRequest.parameters = parsed;
  }
  const streamValue = formGet(values, "stream").trim();
  if (streamValue) {
    try {
      imageRequest.stream = parseGoBool(streamValue);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid stream value: ${message}`);
    }
  }
  const imageValue = formGet(values, "image");
  if (imageValue) imageRequest.image = imageValue;
  if (imageRequest.model === "gpt-image-1" && !imageRequest.quality) imageRequest.quality = "standard";
  if (imageRequest.n == null || imageRequest.n === 0) imageRequest.n = 1;
  if (formHas(values, "watermark")) imageRequest.watermark = formGet(values, "watermark") === "true";
  imageRequestCount(imageRequest, false);
  return imageRequest;
}
