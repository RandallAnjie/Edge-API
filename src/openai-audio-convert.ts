/** Original `relay/channel/openai.Adaptor.ConvertAudioRequest` for transcriptions/translations. */

import { CONVERTER_NONE } from "./advanced-custom-convert.js";
import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_ALI,
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_AWS,
  CHANNEL_TYPE_BAIDU,
  CHANNEL_TYPE_BAIDU_V2,
  CHANNEL_TYPE_CLOUDFLARE,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_COHERE,
  CHANNEL_TYPE_COZE,
  CHANNEL_TYPE_DEEPSEEK,
  CHANNEL_TYPE_DIFY,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_JIMENG,
  CHANNEL_TYPE_JINA,
  CHANNEL_TYPE_MINIMAX,
  CHANNEL_TYPE_MISTRAL,
  CHANNEL_TYPE_MOKA,
  CHANNEL_TYPE_MOONSHOT,
  CHANNEL_TYPE_NEW_API,
  CHANNEL_TYPE_OLLAMA,
  CHANNEL_TYPE_PALM,
  CHANNEL_TYPE_PERPLEXITY,
  CHANNEL_TYPE_REPLICATE,
  CHANNEL_TYPE_SUB2API,
  CHANNEL_TYPE_SUBMODEL,
  CHANNEL_TYPE_TASK_PLUGIN,
  CHANNEL_TYPE_TENCENT,
  CHANNEL_TYPE_VERTEX,
  CHANNEL_TYPE_VOLC,
  CHANNEL_TYPE_XAI,
  CHANNEL_TYPE_XUNFEI,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_TYPE_ZHIPU_V4,
} from "./constants.js";
import { encodeMultipartForm, parseMultipartForm, type EncodedMultipart, type ParsedMultipart } from "./multipart-form.js";

function wrapError(prefix: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${prefix}: ${message}`);
}

/**
 * Original Go `mime.TypeByExtension` builtins used by `multipart.Writer.CreateFormFile`.
 * Unknown extensions become `application/octet-stream`.
 */
export function formFileContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = (dot >= 0 ? filename.slice(dot) : "").toLowerCase();
  switch (ext) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    case ".mpeg":
      return "video/mpeg";
    case ".oga":
    case ".opus":
      return "audio/ogg";
    case ".weba":
      return "audio/webm";
    case ".webm":
      return "video/webm";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Original `openai.Adaptor.ConvertAudioRequest` for non-speech (multipart transcriptions/translations).
 * Speech stays JSON via convertOutbound.
 */
export function convertOpenAIAudioForm(
  rawBody: ArrayBuffer,
  contentType: string,
  upstreamModel: string,
): EncodedMultipart {
  let form: ParsedMultipart;
  try {
    form = parseMultipartForm(rawBody, contentType);
  } catch (err) {
    throw wrapError("error parsing multipart form", err);
  }
  const fields: { name: string; value: string }[] = [{ name: "model", value: upstreamModel }];
  for (const [key, values] of Object.entries(form.values)) {
    if (key === "model") continue;
    for (const value of values) fields.push({ name: key, value });
  }
  const file = form.files.find((part) => part.name === "file");
  if (!file) throw new Error("file is required");
  return encodeMultipartForm(fields, [
    {
      name: "file",
      filename: file.filename,
      mime: formFileContentType(file.filename),
      data: file.data,
    },
  ]);
}

/**
 * Channel types whose GetAdaptor ConvertAudioRequest is openai.Adaptor
 * (OpenAI/Azure/OpenRouter/Xinference/SiliconFlow delegate, AdvancedCustom `none`, unknown→OpenAI fallback).
 */
export function usesOpenAIAudioAdaptor(channelType: number, converter = ""): boolean {
  switch (channelType) {
    case CHANNEL_TYPE_ALI:
    case CHANNEL_TYPE_ANTHROPIC:
    case CHANNEL_TYPE_BAIDU:
    case CHANNEL_TYPE_PALM:
    case CHANNEL_TYPE_ZHIPU:
    case CHANNEL_TYPE_XUNFEI:
    case CHANNEL_TYPE_TENCENT:
    case CHANNEL_TYPE_GEMINI:
    case CHANNEL_TYPE_ZHIPU_V4:
    case CHANNEL_TYPE_OLLAMA:
    case CHANNEL_TYPE_PERPLEXITY:
    case CHANNEL_TYPE_AWS:
    case CHANNEL_TYPE_COHERE:
    case CHANNEL_TYPE_DIFY:
    case CHANNEL_TYPE_JINA:
    case CHANNEL_TYPE_CLOUDFLARE:
    case CHANNEL_TYPE_VERTEX:
    case CHANNEL_TYPE_MISTRAL:
    case CHANNEL_TYPE_DEEPSEEK:
    case CHANNEL_TYPE_MOKA:
    case CHANNEL_TYPE_VOLC:
    case CHANNEL_TYPE_BAIDU_V2:
    case CHANNEL_TYPE_XAI:
    case CHANNEL_TYPE_COZE:
    case CHANNEL_TYPE_JIMENG:
    case CHANNEL_TYPE_MOONSHOT:
    case CHANNEL_TYPE_SUBMODEL:
    case CHANNEL_TYPE_MINIMAX:
    case CHANNEL_TYPE_REPLICATE:
    case CHANNEL_TYPE_CODEX:
    case CHANNEL_TYPE_SUB2API:
    case CHANNEL_TYPE_NEW_API:
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
