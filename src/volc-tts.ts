/** Original `relay/channel/volcengine` ConvertAudioRequest / GetRequestURL / TTS WebSocket JSON. */

import { CHANNEL_TYPE_VOLC } from "./constants.js";
import { defaultBaseUrl } from "./catalog.js";
import { goUnmarshalJSON } from "./channel-validate.js";

export const VOLC_TTS_WS_URL = "wss://openspeech.bytedance.com/api/v1/tts/ws_binary";
export const VOLC_TTS_INVALID_KEY = "invalid api key format, expected: appid|access_token";
export const VOLC_TTS_UNSUPPORTED_AUDIO = "unsupported audio relay mode";
export const VOLC_TTS_CLUSTER = "volcano_tts";
export const VOLC_TTS_USER_UID = "openai_relay_user";
export const VOLC_TTS_SUCCESS_CODE = 3000;
/** Original leftover `handleTTSResponse` unmarshal message (discards encoding/json details). */
export const VOLC_TTS_PARSE_ERROR = "failed to parse volcengine response";

export const MSG_TYPE_FLAG_NO_SEQ = 0;
export const MSG_TYPE_FLAG_POSITIVE_SEQ = 0b1;
export const MSG_TYPE_FLAG_NEGATIVE_SEQ = 0b11;
export const MSG_TYPE_FLAG_WITH_EVENT = 0b100;

export const MSG_TYPE_FULL_CLIENT_REQUEST = 0b1;
export const MSG_TYPE_AUDIO_ONLY_CLIENT = 0b10;
export const MSG_TYPE_FULL_SERVER_RESPONSE = 0b1001;
export const MSG_TYPE_AUDIO_ONLY_SERVER = 0b1011;
export const MSG_TYPE_FRONT_END_RESULT_SERVER = 0b1100;
export const MSG_TYPE_ERROR = 0b1111;

const VERSION1 = 1;
const HEADER_SIZE4 = 1;
const SERIALIZATION_JSON = 0b1;
const COMPRESSION_NONE = 0;

const OPENAI_TO_VOLC_VOICE: Record<string, string> = {
  alloy: "zh_male_M392_conversation_wvae_bigtts",
  echo: "zh_male_wenhao_mars_bigtts",
  fable: "zh_female_tianmei_mars_bigtts",
  onyx: "zh_male_zhibei_mars_bigtts",
  nova: "zh_female_shuangkuaisisi_mars_bigtts",
  shimmer: "zh_female_cancan_mars_bigtts",
};

const RESPONSE_FORMAT_TO_ENCODING: Record<string, string> = {
  mp3: "mp3",
  opus: "ogg_opus",
  aac: "mp3",
  flac: "mp3",
  wav: "wav",
  pcm: "pcm",
};

const ENCODING_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg_opus: "audio/ogg",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

export type VolcTtsAuth = { appId: string; token: string };

export type VolcBinaryMessage = {
  version: number;
  headerSize: number;
  msgType: number;
  msgTypeFlag: number;
  serialization: number;
  compression: number;
  eventType: number;
  sessionId: string;
  connectId: string;
  sequence: number;
  errorCode: number;
  payload: Uint8Array;
};

export type ConvertVolcTtsOpts = {
  originModelName?: string;
  apiKey?: string;
  reqId?: string;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const part of parts) n += part.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function i32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, n, false);
  return out;
}

function readU32(buf: Uint8Array, offset: number): number {
  if (offset + 4 > buf.length) throw new Error("unexpected EOF");
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, false);
}

function readI32(buf: Uint8Array, offset: number): number {
  if (offset + 4 > buf.length) throw new Error("unexpected EOF");
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(offset, false);
}

/** Original `parseVolcengineAuth`. */
export function parseVolcengineAuth(apiKey: string): VolcTtsAuth {
  const parts = String(apiKey || "").split("|");
  if (parts.length !== 2) throw new Error(VOLC_TTS_INVALID_KEY);
  return { appId: parts[0], token: parts[1] };
}

/** Original `mapVoiceType`. */
export function mapVolcVoiceType(openAIVoice: string): string {
  return OPENAI_TO_VOLC_VOICE[openAIVoice] || openAIVoice;
}

/** Original `mapEncoding`. */
export function mapVolcEncoding(responseFormat: string): string {
  return RESPONSE_FORMAT_TO_ENCODING[responseFormat] || "mp3";
}

/** Original `getContentTypeByEncoding`. */
export function volcTtsContentType(encoding: string): string {
  return ENCODING_CONTENT_TYPE[encoding] || "application/octet-stream";
}

export function volcEngineDefaultBase(): string {
  return defaultBaseUrl(CHANNEL_TYPE_VOLC).replace(/\/+$/, "");
}

/**
 * Original `volcengine.Adaptor.GetRequestURL` for RelayModeAudioSpeech.
 * Empty ChannelBaseUrl fills GetChannelBaseURL(ChannelTypeVolcEngine).
 */
export function volcTtsRequestURL(channelBaseUrl: string): string {
  const baseUrl = (channelBaseUrl || volcEngineDefaultBase()).replace(/\/+$/, "");
  if (baseUrl === volcEngineDefaultBase()) return VOLC_TTS_WS_URL;
  return `${baseUrl}/v1/audio/speech`;
}

/** Original TTS `SetupRequestHeader`: `Bearer;` + token when key has two parts. */
export function applyVolcTtsHeaders(headers: Record<string, string>, apiKey: string): void {
  headers["content-type"] = "application/json";
  const parts = String(apiKey || "").split("|");
  if (parts.length === 2) headers.authorization = `Bearer;${parts[1]}`;
  else delete headers.authorization;
}

function jsonMerge(dest: unknown, src: unknown): unknown {
  if (src === undefined) return dest;
  if (src === null || typeof src !== "object" || Array.isArray(src)) return src;
  const base = dest && typeof dest === "object" && !Array.isArray(dest) ? { ...asObj(dest) } : {};
  for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
    base[key] = jsonMerge(base[key], value);
  }
  return base;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return asObj(parsed);
    } catch (err) {
      throw new Error(`error unmarshalling metadata to volcengine request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return asObj(raw);
  throw new Error("error unmarshalling metadata to volcengine request: json: cannot unmarshal into Go value");
}

function omitEmptyBool(v: unknown): boolean {
  return v === true;
}

function omitEmptyNumber(v: unknown): boolean {
  return typeof v === "number" && v !== 0 && Number.isFinite(v);
}

function omitEmptyString(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

function serializeExtraParam(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (omitEmptyBool(raw.disable_markdown_filter)) out.disable_markdown_filter = true;
  if (omitEmptyBool(raw.enable_latex_tn)) out.enable_latex_tn = true;
  if (omitEmptyString(raw.mute_cut_threshold)) out.mute_cut_threshold = raw.mute_cut_threshold;
  if (omitEmptyString(raw.mute_cut_remain_ms)) out.mute_cut_remain_ms = raw.mute_cut_remain_ms;
  if (omitEmptyBool(raw.disable_emoji_filter)) out.disable_emoji_filter = true;
  if (omitEmptyNumber(raw.unsupported_char_ratio_thresh)) out.unsupported_char_ratio_thresh = raw.unsupported_char_ratio_thresh;
  if (omitEmptyBool(raw.aigc_watermark)) out.aigc_watermark = true;
  const cache = asObj(raw.cache_config);
  const cacheOut: Record<string, unknown> = {};
  if (omitEmptyNumber(cache.text_type)) cacheOut.text_type = cache.text_type;
  if (omitEmptyBool(cache.use_cache)) cacheOut.use_cache = true;
  if (Object.keys(cacheOut).length) out.cache_config = cacheOut;
  return Object.keys(out).length ? out : undefined;
}

/** Go `json.Marshal` of `VolcengineTTSRequest` (omitempty as tagged). */
export function serializeVolcTtsRequest(req: Record<string, unknown>): Record<string, unknown> {
  const app = asObj(req.app);
  const user = asObj(req.user);
  const audioIn = asObj(req.audio);
  const requestIn = asObj(req.request);
  const audio: Record<string, unknown> = {
    voice_type: String(audioIn.voice_type ?? ""),
    encoding: String(audioIn.encoding ?? ""),
    speed_ratio: Number(audioIn.speed_ratio ?? 0),
    rate: Number(audioIn.rate ?? 0),
  };
  if (omitEmptyNumber(audioIn.bitrate)) audio.bitrate = audioIn.bitrate;
  if (omitEmptyNumber(audioIn.loudness_ratio)) audio.loudness_ratio = audioIn.loudness_ratio;
  if (omitEmptyBool(audioIn.enable_emotion)) audio.enable_emotion = true;
  if (omitEmptyString(audioIn.emotion)) audio.emotion = audioIn.emotion;
  if (omitEmptyNumber(audioIn.emotion_scale)) audio.emotion_scale = audioIn.emotion_scale;
  if (omitEmptyString(audioIn.explicit_language)) audio.explicit_language = audioIn.explicit_language;
  if (omitEmptyString(audioIn.context_language)) audio.context_language = audioIn.context_language;
  const request: Record<string, unknown> = {
    reqid: String(requestIn.reqid ?? ""),
    text: String(requestIn.text ?? ""),
    operation: String(requestIn.operation ?? ""),
  };
  if (omitEmptyString(requestIn.model)) request.model = requestIn.model;
  if (omitEmptyString(requestIn.text_type)) request.text_type = requestIn.text_type;
  if (omitEmptyNumber(requestIn.silence_duration)) request.silence_duration = requestIn.silence_duration;
  if (requestIn.with_timestamp != null) request.with_timestamp = requestIn.with_timestamp;
  const extra = serializeExtraParam(asObj(requestIn.extra_param));
  if (extra) request.extra_param = extra;
  return {
    app: {
      appid: String(app.appid ?? ""),
      token: String(app.token ?? ""),
      cluster: String(app.cluster ?? ""),
    },
    user: { uid: String(user.uid ?? "") },
    audio,
    request,
  };
}

/** Original `volcengine.Adaptor.ConvertAudioRequest` for RelayModeAudioSpeech. */
export function convertVolcTTSRequest(body: Record<string, unknown>, opts: ConvertVolcTtsOpts = {}): Record<string, unknown> {
  const { appId, token } = parseVolcengineAuth(opts.apiKey || "");
  let req: Record<string, unknown> = {
    app: { appid: appId, token, cluster: VOLC_TTS_CLUSTER },
    user: { uid: VOLC_TTS_USER_UID },
    audio: {
      voice_type: mapVolcVoiceType(String(body.voice || "")),
      encoding: mapVolcEncoding(String(body.response_format || "")),
      speed_ratio: Number(body.speed ?? 0),
      rate: 24000,
    },
    request: {
      reqid: opts.reqId || crypto.randomUUID(),
      text: String(body.input || ""),
      operation: "submit",
      model: opts.originModelName || String(body.model || ""),
    },
  };
  if (body.metadata != null && body.metadata !== "") {
    try {
      req = asObj(jsonMerge(req, parseMetadata(body.metadata)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("error unmarshalling metadata")) throw err;
      throw new Error(`error unmarshalling metadata to volcengine request: ${message}`);
    }
  }
  return serializeVolcTtsRequest(req);
}

export function volcTtsEncodingFromRequest(body: Record<string, unknown>): string {
  return String(asObj(body.audio).encoding || "mp3");
}

/** Original ConvertAudioRequest sets `info.IsStream` when `operation == "submit"`. */
export function volcTtsIsStream(body: Record<string, unknown>): boolean {
  return String(asObj(body.request).operation || "") === "submit";
}

/**
 * Original `volcengine.Adaptor.DoResponse` audio speech non-stream uses
 * `handleTTSResponse` (`json.Unmarshal` `NewErrorWithStatusCode`
 * `ErrorCodeBadResponseBody` HTTP 500, generic `"failed to parse volcengine
 * response"` — discards encoding/json details). Stream uses
 * `handleTTSWebSocketResponse` (not leftover Unmarshal gin.H). Chat /
 * embeddings / images / responses stay hop 398 `openai.Adaptor`. Extra-OK:
 * hop 384 MiniMax TTS wrap stays. Extra-OK: `code != 3000` / decode fail stay
 * convert after successful Unmarshal.
 */
export function usesVolcTTSUnmarshal(channelType: number, mode: string): boolean {
  return channelType === CHANNEL_TYPE_VOLC && mode === "audio_speech";
}

/** Original `json.Unmarshal` target type name for Volc TTS. Extra-OK: leftover message discards this type name. */
export function volcTtsUnmarshalTypeName(): string {
  return "volcengine.VolcengineTTSResponse";
}

/**
 * Original `json.Unmarshal` into `volcengine.VolcengineTTSResponse`. Syntax
 * and type mismatches both become generic `"failed to parse volcengine
 * response"` (original `errors.New`, not `%w`). JSON `null` succeeds as a
 * zero-value struct. Extra-OK: nested field type mismatches are left to
 * convert (original fails).
 */
export function volcTtsResponseUnmarshalError(text: string): string | null {
  const parsed = goUnmarshalJSON(text);
  if (!parsed.ok) return VOLC_TTS_PARSE_ERROR;
  if (parsed.value === null) return null;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return VOLC_TTS_PARSE_ERROR;
  }
  return null;
}

export function newVolcBinaryMessage(msgType: number, flag: number): VolcBinaryMessage {
  return {
    version: VERSION1,
    headerSize: HEADER_SIZE4,
    msgType,
    msgTypeFlag: flag,
    serialization: SERIALIZATION_JSON,
    compression: COMPRESSION_NONE,
    eventType: 0,
    sessionId: "",
    connectId: "",
    sequence: 0,
    errorCode: 0,
    payload: new Uint8Array(0),
  };
}

/** Original `Message.Marshal`. */
export function marshalVolcBinaryMessage(msg: VolcBinaryMessage): Uint8Array {
  const header = [
    (msg.version << 4) | msg.headerSize,
    (msg.msgType << 4) | msg.msgTypeFlag,
    (msg.serialization << 4) | msg.compression,
  ];
  const headerSize = 4 * msg.headerSize;
  while (header.length < headerSize) header.push(0);
  const parts: Uint8Array[] = [Uint8Array.from(header)];
  if (msg.msgTypeFlag === MSG_TYPE_FLAG_WITH_EVENT) {
    parts.push(i32be(msg.eventType));
    if (
      msg.eventType !== 1 &&
      msg.eventType !== 2 &&
      msg.eventType !== 50 &&
      msg.eventType !== 51
    ) {
      const session = new TextEncoder().encode(msg.sessionId);
      parts.push(u32be(session.length), session);
    }
  }
  switch (msg.msgType) {
    case MSG_TYPE_FULL_CLIENT_REQUEST:
    case MSG_TYPE_FULL_SERVER_RESPONSE:
    case MSG_TYPE_FRONT_END_RESULT_SERVER:
    case MSG_TYPE_AUDIO_ONLY_CLIENT:
    case MSG_TYPE_AUDIO_ONLY_SERVER:
      if (msg.msgTypeFlag === MSG_TYPE_FLAG_POSITIVE_SEQ || msg.msgTypeFlag === MSG_TYPE_FLAG_NEGATIVE_SEQ) {
        parts.push(i32be(msg.sequence));
      }
      break;
    case MSG_TYPE_ERROR:
      parts.push(u32be(msg.errorCode));
      break;
    default:
      throw new Error(`unsupported message type: ${msg.msgType}`);
  }
  parts.push(u32be(msg.payload.length), msg.payload);
  return concatBytes(parts);
}

/** Original `NewMessageFromBytes` + `Message.Unmarshal`. */
export function unmarshalVolcBinaryMessage(data: Uint8Array): VolcBinaryMessage {
  if (data.length < 3) throw new Error(`data too short: expected at least 3 bytes, got ${data.length}`);
  const typeAndFlag = data[1];
  const msg = newVolcBinaryMessage(typeAndFlag >> 4, typeAndFlag & 0b00001111);
  msg.version = data[0] >> 4;
  msg.headerSize = data[0] & 0b00001111;
  msg.serialization = data[2] & 0b11110000;
  msg.compression = data[2] & 0b00001111;
  const headerSize = 4 * msg.headerSize;
  let offset = 3;
  if (headerSize - 3 > 0) {
    if (offset + (headerSize - 3) > data.length) {
      throw new Error(`insufficient header bytes: expected ${headerSize - 3}, got ${data.length - offset}`);
    }
    offset = headerSize;
  }
  const readSeq = msg.msgTypeFlag === MSG_TYPE_FLAG_POSITIVE_SEQ || msg.msgTypeFlag === MSG_TYPE_FLAG_NEGATIVE_SEQ;
  switch (msg.msgType) {
    case MSG_TYPE_FULL_CLIENT_REQUEST:
    case MSG_TYPE_FULL_SERVER_RESPONSE:
    case MSG_TYPE_FRONT_END_RESULT_SERVER:
    case MSG_TYPE_AUDIO_ONLY_CLIENT:
    case MSG_TYPE_AUDIO_ONLY_SERVER:
      if (readSeq) {
        msg.sequence = readI32(data, offset);
        offset += 4;
      }
      break;
    case MSG_TYPE_ERROR:
      msg.errorCode = readU32(data, offset);
      offset += 4;
      break;
    default:
      throw new Error(`unsupported message type: ${msg.msgType}`);
  }
  if (msg.msgTypeFlag === MSG_TYPE_FLAG_WITH_EVENT) {
    msg.eventType = readI32(data, offset);
    offset += 4;
    const skipSession =
      msg.eventType === 1 || msg.eventType === 2 || msg.eventType === 50 || msg.eventType === 51 || msg.eventType === 52;
    if (!skipSession) {
      const size = readU32(data, offset);
      offset += 4;
      msg.sessionId = new TextDecoder().decode(data.subarray(offset, offset + size));
      offset += size;
    }
    if (msg.eventType === 50 || msg.eventType === 51 || msg.eventType === 52) {
      const size = readU32(data, offset);
      offset += 4;
      msg.connectId = new TextDecoder().decode(data.subarray(offset, offset + size));
      offset += size;
    }
  }
  const payloadSize = readU32(data, offset);
  offset += 4;
  msg.payload = data.subarray(offset, offset + payloadSize);
  offset += payloadSize;
  if (offset !== data.length) throw new Error("unexpected data after message: extra bytes");
  return msg;
}

/** Original `FullClientRequest`. */
export function marshalVolcFullClientRequest(payload: Uint8Array): Uint8Array {
  const msg = newVolcBinaryMessage(MSG_TYPE_FULL_CLIENT_REQUEST, MSG_TYPE_FLAG_NO_SEQ);
  msg.payload = payload;
  return marshalVolcBinaryMessage(msg);
}

export function marshalVolcAudioOnlyServer(payload: Uint8Array, sequence: number): Uint8Array {
  const flag = sequence < 0 ? MSG_TYPE_FLAG_NEGATIVE_SEQ : MSG_TYPE_FLAG_POSITIVE_SEQ;
  const msg = newVolcBinaryMessage(MSG_TYPE_AUDIO_ONLY_SERVER, flag);
  msg.sequence = sequence;
  msg.payload = payload;
  return marshalVolcBinaryMessage(msg);
}

export function marshalVolcErrorMessage(errorCode: number, payload: Uint8Array): Uint8Array {
  const msg = newVolcBinaryMessage(MSG_TYPE_ERROR, MSG_TYPE_FLAG_NO_SEQ);
  msg.errorCode = errorCode;
  msg.payload = payload;
  return marshalVolcBinaryMessage(msg);
}

type WsLike = {
  readyState?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  accept?(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
};

async function wsDataToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof data === "string") return new TextEncoder().encode(data);
  throw new Error("unexpected Websocket message type: unknown");
}

async function dialVolcTtsWebSocket(url: string, token: string): Promise<WsLike> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer;${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new Error(`failed to connect to websocket: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ws = (res as Response & { webSocket?: WsLike }).webSocket;
  if (!ws) {
    throw new Error(`failed to connect to websocket: server didn't accept WebSocket, status: ${res.status}`);
  }
  if (typeof ws.accept === "function") ws.accept();
  return ws;
}

/** Original `handleTTSResponse` non-stream JSON (code 3000 + base64 `data`). */
export function volcTtsHttpDoResponse(upstream: Record<string, unknown>, encoding: string): { body: Uint8Array; contentType: string } {
  const code = Number(upstream.code ?? 0);
  if (code !== VOLC_TTS_SUCCESS_CODE) {
    throw Object.assign(new Error(String(upstream.message || "")), { status: 400, code: "bad_response" });
  }
  const raw = String(upstream.data || "");
  let bin: Uint8Array;
  try {
    const decoded = atob(raw);
    bin = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bin[i] = decoded.charCodeAt(i);
  } catch {
    throw Object.assign(new Error("failed to decode audio data"), { status: 500, code: "bad_response_body" });
  }
  return { body: bin, contentType: volcTtsContentType(encoding) };
}

export async function wrapVolcTtsHttpResponse(res: Response, encoding: string): Promise<Response> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw Object.assign(new Error("failed to read volcengine response"), { status: 500, code: "read_response_body_failed" });
  }
  const unmarshalErr = volcTtsResponseUnmarshalError(text);
  if (unmarshalErr) {
    throw Object.assign(new Error(unmarshalErr), { status: 500, code: "bad_response_body" });
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      parsed = {};
    }
  } catch {
    parsed = {};
  }
  const audio = volcTtsHttpDoResponse(parsed, encoding);
  return new Response(audio.body as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": audio.contentType },
  });
}

/** Original `handleTTSWebSocketResponse`. */
export async function runVolcTtsWebSocket(
  url: string,
  apiKey: string,
  request: Record<string, unknown>,
  encoding: string,
): Promise<Response> {
  const { token } = parseVolcengineAuth(apiKey);
  const ws = await dialVolcTtsWebSocket(url, token);
  const payload = new TextEncoder().encode(JSON.stringify(serializeVolcTtsRequest(request)));
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    };
    ws.addEventListener("error", () => finish(new Error("failed to receive message: websocket error")));
    ws.addEventListener("close", () => finish());
    ws.addEventListener("message", (ev) => {
      void (async () => {
        try {
          const bytes = await wsDataToBytes(ev.data);
          const msg = unmarshalVolcBinaryMessage(bytes);
          if (msg.msgType === MSG_TYPE_ERROR) {
            finish(
              Object.assign(new Error(`received error from server: code=${msg.errorCode}, ${new TextDecoder().decode(msg.payload)}`), {
                status: 400,
                code: "bad_response",
              }),
            );
            return;
          }
          if (msg.msgType === MSG_TYPE_FRONT_END_RESULT_SERVER) return;
          if (msg.msgType === MSG_TYPE_AUDIO_ONLY_SERVER) {
            if (msg.payload.length) chunks.push(msg.payload);
            if (msg.sequence < 0) finish();
          }
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
    try {
      ws.send(marshalVolcFullClientRequest(payload));
    } catch (err) {
      finish(Object.assign(new Error(`failed to send request: ${err instanceof Error ? err.message : String(err)}`), { status: 500, code: "bad_request_body" }));
    }
  });
  return new Response(concatBytes(chunks) as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": volcTtsContentType(encoding) },
  });
}
