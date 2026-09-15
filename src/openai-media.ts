/** Original OpenAI chat/Responses `ToFileSource` HTTP fetch used by ConvertRequest. */

import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_AWS,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_VERTEX,
} from "./constants.js";
import { fileSourceIdentifier, getBase64DataFromUrl } from "./file-source.js";

export type OpenAIHttpMediaDialect = "claude" | "gemini";

export type OpenAIFileSource = { data: string; mime: string };

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function interface2String(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isHttpUrl(data: string): boolean {
  return data.startsWith("http://") || data.startsWith("https://");
}

function nestedMediaData(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = asObj(value);
    for (const key of ["url", "file_data", "file_url", "data"]) {
      const data = typeof nested[key] === "string" ? String(nested[key]).trim() : "";
      if (data) return data;
    }
  }
  return "";
}

/** Original `dto.MediaContent.ToFileSource` + `oairesponses.ContentPartToFileSource` HTTP URLs. */
function partHttpUrl(part: Record<string, unknown>): string {
  const type = String(part.type || "").trim();
  if (type === "text" || type === "input_text" || type === "output_text") return "";
  if (type === "image_url" || type === "input_image") {
    return nestedMediaData(part.image_url ?? part.imageUrl ?? part.url);
  }
  if (type === "input_audio") {
    return nestedMediaData(part.input_audio ?? part.data ?? part.url);
  }
  if (type === "file" || type === "input_file") {
    const file = part.file;
    if (file && typeof file === "object" && !Array.isArray(file)) {
      const nested = asObj(file);
      const fileData = typeof nested.file_data === "string" ? nested.file_data.trim() : "";
      if (fileData) return fileData;
    }
    return nestedMediaData(part.file ?? part.file_data ?? part.file_url ?? part.url);
  }
  if (type === "video_url" || type === "input_video") {
    return nestedMediaData(part.video_url ?? part.url);
  }
  if (type) return nestedMediaData(part.url);
  return "";
}

/**
 * Original `dto.MediaContent.ToFileSource` for OpenAI chat ConvertRequest.
 * Extra-OK: also reads `imageUrl` camelCase used by existing worker tests.
 */
export function openAIChatPartToFileSource(part: Record<string, unknown>): OpenAIFileSource | null {
  const type = String(part.type || "").trim();
  if (type === "image_url") {
    const img = asObj(part.image_url ?? part.imageUrl);
    const url = interface2String(img.url);
    if (!url) return null;
    return { data: url, mime: interface2String(img.mime_type) };
  }
  if (type === "input_audio") {
    const audio = asObj(part.input_audio);
    const data = interface2String(audio.data);
    if (!data) return null;
    const format = interface2String(audio.format).trim();
    return { data, mime: format ? `audio/${format}` : "" };
  }
  if (type === "file") {
    const file = asObj(part.file);
    const fileData = interface2String(file.file_data);
    if (!fileData) return null;
    return { data: fileData, mime: "" };
  }
  if (type === "video_url") {
    const video = asObj(part.video_url);
    const url = interface2String(video.url);
    if (!url) return null;
    return { data: url, mime: "" };
  }
  return null;
}

/**
 * Original `service.loadFromBase64` / `types.NewFileSourceFromData` for non-HTTP sources.
 * HTTP sources use `resolveMedia` populated by prefetch GetBase64Data.
 */
export function resolveOpenAIChatFileSource(
  source: OpenAIFileSource,
  resolveMedia?: (url: string) => { data: string; mime: string } | null,
): { data: string; mime: string } | null {
  const data = String(source.data || "");
  if (isHttpUrl(data)) return resolveMedia?.(data) ?? null;

  let mime = "";
  let clean = data;
  if (data.startsWith("data:")) {
    const idx = data.indexOf(",");
    if (idx !== -1) {
      const header = data.slice(0, idx);
      clean = data.slice(idx + 1);
      if (header.includes(":") && header.includes(";")) {
        const mimeStart = header.indexOf(":") + 1;
        const mimeEnd = header.indexOf(";");
        if (mimeStart < mimeEnd) mime = header.slice(mimeStart, mimeEnd);
      }
    }
  }
  if (source.mime) mime = source.mime;
  try {
    atob(clean);
  } catch (err) {
    throw new Error(`failed to decode base64 data: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { data: clean, mime };
}

export function wrapOpenAIChatFileError(dialect: OpenAIHttpMediaDialect, identifier: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  if (dialect === "claude") return new Error(`get file data failed: ${detail}`);
  return new Error(`get file data from '${identifier}' failed: ${detail}`);
}

/** Original `types.NewFileSourceFromData` HTTP prefix used by OpenAI ConvertRequest. */
export function collectOpenAIHttpMediaUrls(body: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const data = String(raw || "").trim();
    if (!isHttpUrl(data) || seen.has(data)) return;
    seen.add(data);
    urls.push(data);
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const content = asObj(raw).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && !Array.isArray(part)) add(partHttpUrl(asObj(part)));
    }
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const raw of input) {
      const item = asObj(raw);
      add(partHttpUrl(item));
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && !Array.isArray(part)) add(partHttpUrl(asObj(part)));
      }
    }
  }
  return urls;
}

/**
 * Original `helper.ApplyReasoningModelSuffix` stays sync; GetBase64Data for OpenAI HTTP
 * media runs here (convertOutbound) before ConvertRequest JSON rewrite.
 */
export function openAIHttpMediaDialect(opts: {
  client: string;
  channelType: number;
  kind: string;
  mode?: string;
  converter?: string;
  upstreamModel?: string;
}): OpenAIHttpMediaDialect | undefined {
  if (opts.client !== "openai") return undefined;
  const mode = opts.mode || "chat";
  if (mode !== "chat" && mode !== "responses") return undefined;
  const upstream = String(opts.upstreamModel || "");
  if (opts.channelType === CHANNEL_TYPE_AWS) {
    if (upstream.includes("nova-")) return undefined;
    return "claude";
  }
  if (opts.channelType === CHANNEL_TYPE_VERTEX) {
    if (upstream.startsWith("claude")) return "claude";
    if (upstream.includes("llama") || upstream.includes("-maas")) return undefined;
    return "gemini";
  }
  if (opts.channelType === CHANNEL_TYPE_ANTHROPIC) return "claude";
  if (opts.channelType === CHANNEL_TYPE_GEMINI) return "gemini";
  if (opts.kind === "anthropic") return "claude";
  if (opts.kind === "gemini") return "gemini";
  if (opts.channelType === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const converter = String(opts.converter || "");
    if (converter.includes("claude")) return "claude";
    if (converter.includes("gemini")) return "gemini";
  }
  return undefined;
}

/**
 * Original `relaymedia.ResolveBase64Data` for OpenAI HTTP file sources.
 * Claude wrap: `get file data failed: %s`. Gemini wrap: `get file data from '%s' failed: %w`.
 */
export async function prefetchOpenAIHttpMedia(
  body: Record<string, unknown>,
  dialect: OpenAIHttpMediaDialect,
): Promise<Map<string, { data: string; mime: string }>> {
  const map = new Map<string, { data: string; mime: string }>();
  for (const url of collectOpenAIHttpMediaUrls(body)) {
    try {
      const got = await getBase64DataFromUrl(url);
      map.set(url, { data: got.data, mime: got.mimeType });
    } catch (err) {
      throw wrapOpenAIChatFileError(dialect, fileSourceIdentifier(url), err);
    }
  }
  return map;
}

export { fileSourceIdentifier };
