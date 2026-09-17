/**
 * Original `helper.GetAndValidAudioRequest` / `dto.AudioRequest` (workerd).
 * Must not import store / relay / convert / query / submit.
 */
import { parseMultipartForm } from "./multipart-form.js";

const AUDIO_REQUEST_KEYS = [
  "model",
  "input",
  "voice",
  "instructions",
  "response_format",
  "speed",
  "stream_format",
  "metadata",
  "task_type",
  "language",
  "ref_audio",
  "ref_text",
  "x_vector_only_mode",
  "max_new_tokens",
  "initial_codec_chunk_frames",
] as const;

export function isAudioRelayMode(mode: string): boolean {
  return mode === "audio_speech" || mode === "audio_transcription" || mode === "audio_translation";
}

/** Original `dto.AudioRequest.IsStream` — `StreamFormat == "sse"`. */
export function audioRequestIsStream(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return String((body as { stream_format?: unknown }).stream_format || "") === "sse";
}

function pickAudioRequestFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of AUDIO_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function audioRequestFromMultipart(rawBody: ArrayBuffer, contentType: string): Record<string, unknown> {
  const values = parseMultipartForm(rawBody, contentType).values;
  const formMap: Record<string, unknown> = {};
  for (const [key, vals] of Object.entries(values)) {
    formMap[key] = vals.length === 1 ? vals[0] : vals;
  }
  return pickAudioRequestFields(formMap);
}

function audioRequestFromJson(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return pickAudioRequestFields(source as Record<string, unknown>);
}

/**
 * Original `helper.GetAndValidAudioRequest`.
 * Speech and transcription/translation require `model`.
 * Non-speech empty `response_format` becomes `json`.
 */
export function getAndValidAudioRequest(
  relayMode: string,
  source: unknown,
  contentType = "",
): Record<string, unknown> {
  let audioRequest: Record<string, unknown>;
  if (source instanceof ArrayBuffer) {
    audioRequest = audioRequestFromMultipart(source, contentType);
  } else if (source instanceof Uint8Array) {
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    audioRequest = audioRequestFromMultipart(copy.buffer, contentType);
  } else {
    audioRequest = audioRequestFromJson(source);
  }
  if (typeof audioRequest.model !== "string" || audioRequest.model === "") {
    throw new Error("model is required");
  }
  if (relayMode !== "audio_speech") {
    if (!String(audioRequest.response_format || "")) {
      audioRequest.response_format = "json";
    }
  }
  return audioRequest;
}
