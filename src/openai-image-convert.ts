/** Original `relay/channel/openai.Adaptor.ConvertImageRequest` for `RelayModeImagesEdits`. */

import { CHANNEL_TYPE_ADVANCED_CUSTOM, CHANNEL_TYPE_ALI, CHANNEL_TYPE_BAIDU, CHANNEL_TYPE_BAIDU_V2, CHANNEL_TYPE_CODEX, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_JIMENG, CHANNEL_TYPE_MINIMAX, CHANNEL_TYPE_REPLICATE, CHANNEL_TYPE_SILICONFLOW, CHANNEL_TYPE_TASK_PLUGIN, CHANNEL_TYPE_VERTEX, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI, CHANNEL_TYPE_ZHIPU, CHANNEL_TYPE_ZHIPU_V4 } from "./constants.js";
import { CONVERTER_NONE } from "./advanced-custom-convert.js";
import { encodeMultipartForm, parseMultipartForm, type MultipartFilePart, type ParsedMultipart } from "./multipart-form.js";

export type OpenAIImageEditForm = {
  body: Uint8Array;
  contentType: string;
};

function wrapError(prefix: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${prefix}: ${message}`);
}

/** Original `openai.detectImageMimeType`. */
export function detectImageMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = (dot >= 0 ? filename.slice(dot) : "").toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      if (ext.startsWith(".jp")) return "image/jpeg";
      return "image/png";
  }
}

function collectImageFiles(files: MultipartFilePart[]): MultipartFilePart[] {
  let imageFiles = files.filter((file) => file.name === "image");
  if (imageFiles.length === 0) imageFiles = files.filter((file) => file.name === "image[]");
  if (imageFiles.length === 0) imageFiles = files.filter((file) => file.name.startsWith("image["));
  if (imageFiles.length === 0) throw new Error("image is required");
  return imageFiles;
}

/**
 * Original `openai.Adaptor.ConvertImageRequest` for multipart image edits.
 * JSON edits return the ImageRequest as-is (handled by convertOutbound).
 */
export function convertOpenAIImageEditForm(
  rawBody: ArrayBuffer,
  contentType: string,
  upstreamModel: string,
): OpenAIImageEditForm {
  let form: ParsedMultipart;
  try {
    form = parseMultipartForm(rawBody, contentType);
  } catch (err) {
    throw wrapError("failed to parse multipart form", err);
  }
  const fields: { name: string; value: string }[] = [{ name: "model", value: upstreamModel }];
  for (const [key, values] of Object.entries(form.values)) {
    if (key === "model") continue;
    for (const value of values) fields.push({ name: key, value });
  }
  const imageFiles = collectImageFiles(form.files);
  const fieldName = imageFiles.length > 1 ? "image[]" : "image";
  const outFiles = imageFiles.map((file) => ({
    name: fieldName,
    filename: file.filename || "image.png",
    mime: detectImageMimeType(file.filename),
    data: file.data,
  }));
  const mask = form.files.find((file) => file.name === "mask");
  if (mask) {
    outFiles.push({
      name: "mask",
      filename: mask.filename || "mask.png",
      mime: detectImageMimeType(mask.filename),
      data: mask.data,
    });
  }
  return encodeMultipartForm(fields, outFiles);
}

/**
 * Channel types whose GetAdaptor ConvertImageRequest is the OpenAI multipart rewriter
 * (including AdvancedCustom `none`, Moonshot/NewAPI/Sub2API delegates, and unknown→OpenAI fallback).
 */
export function usesOpenAIImageEditAdaptor(channelType: number, converter = ""): boolean {
  switch (channelType) {
    case CHANNEL_TYPE_ALI:
    case CHANNEL_TYPE_GEMINI:
    case CHANNEL_TYPE_VERTEX:
    case CHANNEL_TYPE_MINIMAX:
    case CHANNEL_TYPE_SILICONFLOW:
    case CHANNEL_TYPE_ZHIPU_V4:
    case CHANNEL_TYPE_ZHIPU:
    case CHANNEL_TYPE_JIMENG:
    case CHANNEL_TYPE_REPLICATE:
    case CHANNEL_TYPE_XAI:
    case CHANNEL_TYPE_CODEX:
    case CHANNEL_TYPE_VOLC:
    case CHANNEL_TYPE_BAIDU:
    case CHANNEL_TYPE_BAIDU_V2:
    case CHANNEL_TYPE_TASK_PLUGIN:
      return false;
    case CHANNEL_TYPE_ADVANCED_CUSTOM: {
      const id = String(converter || CONVERTER_NONE).trim() || CONVERTER_NONE;
      return id === CONVERTER_NONE;
    }
    default:
      return true;
  }
}
