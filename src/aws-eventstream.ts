/**
 * Original AWS SDK `application/vnd.amazon.eventstream` used by
 * `InvokeModelWithResponseStream`. Chunk payload is Go-json
 * `{"bytes": <base64 of Claude JSON>}`; `HandleStreamResponseData` consumes
 * the decoded Claude JSON string. No AWS SDK.
 */

export const AWS_EVENTSTREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";
export const AWS_EVENTSTREAM_MESSAGE_TYPE = ":message-type";
export const AWS_EVENTSTREAM_EVENT_TYPE = ":event-type";
export const AWS_EVENTSTREAM_CONTENT_TYPE_HEADER = ":content-type";
export const AWS_EVENTSTREAM_EVENT_MESSAGE = "event";
export const AWS_EVENTSTREAM_CHUNK_EVENT = "chunk";

const HEADER_STRING = 7;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** IEEE CRC32 (ISO 3309), same polynomial as AWS eventstream. */
export function crc32IEEE(data: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
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

function encodeStringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  out[0] = nameBytes.length;
  out.set(nameBytes, 1);
  out[1 + nameBytes.length] = HEADER_STRING;
  const vlenOff = 2 + nameBytes.length;
  out[vlenOff] = (valueBytes.length >> 8) & 0xff;
  out[vlenOff + 1] = valueBytes.length & 0xff;
  out.set(valueBytes, vlenOff + 2);
  return out;
}

/** Original smithy eventstream encoder used by Bedrock `chunk` events. */
export function encodeAwsEventStreamMessage(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const headerParts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    headerParts.push(encodeStringHeader(name, value));
  }
  const headerBytes = concatBytes(headerParts);
  const total = 12 + headerBytes.length + payload.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32IEEE(out.subarray(0, 8)));
  out.set(headerBytes, 12);
  out.set(payload, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32IEEE(out.subarray(0, total - 4)));
  return out;
}

/**
 * Original test helper `writeAwsStreamEvent`: eventstream message whose payload
 * is `{"bytes": <base64 Claude JSON>}` (`[]byte` Go json).
 */
export function encodeAwsBedrockChunk(claudeJson: string): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ bytes: btoa(claudeJson) }));
  return encodeAwsEventStreamMessage(
    {
      [AWS_EVENTSTREAM_MESSAGE_TYPE]: AWS_EVENTSTREAM_EVENT_MESSAGE,
      [AWS_EVENTSTREAM_EVENT_TYPE]: AWS_EVENTSTREAM_CHUNK_EVENT,
      [AWS_EVENTSTREAM_CONTENT_TYPE_HEADER]: "application/json",
    },
    payload,
  );
}

type EventStreamHeader = { name: string; value: string };
type EventStreamMessage = { headers: EventStreamHeader[]; payload: Uint8Array };

function readUint32(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readUint16(data: Uint8Array, offset: number): number {
  return ((data[offset] << 8) | data[offset + 1]) & 0xffff;
}

function decodeHeaders(buf: Uint8Array): EventStreamHeader[] {
  const headers: EventStreamHeader[] = [];
  let off = 0;
  while (off < buf.length) {
    const nameLen = buf[off];
    off += 1;
    const name = new TextDecoder().decode(buf.subarray(off, off + nameLen));
    off += nameLen;
    const type = buf[off];
    off += 1;
    if (type !== HEADER_STRING) {
      throw new Error(`unsupported eventstream header type ${type}`);
    }
    const valueLen = readUint16(buf, off);
    off += 2;
    const value = new TextDecoder().decode(buf.subarray(off, off + valueLen));
    off += valueLen;
    headers.push({ name, value });
  }
  return headers;
}

function headerValue(headers: EventStreamHeader[], name: string): string {
  for (const header of headers) {
    if (header.name === name) return header.value;
  }
  return "";
}

/** Decode one or more eventstream messages. Invalid CRC or truncated frames are skipped. */
export function decodeAwsEventStream(data: Uint8Array): EventStreamMessage[] {
  const messages: EventStreamMessage[] = [];
  let off = 0;
  while (off + 16 <= data.length) {
    const total = readUint32(data, off);
    const headersLength = readUint32(data, off + 4);
    if (total < 16 || off + total > data.length) break;
    const preludeCrc = readUint32(data, off + 8);
    if (preludeCrc !== crc32IEEE(data.subarray(off, off + 8))) {
      off += 1;
      continue;
    }
    const messageCrc = readUint32(data, off + total - 4);
    if (messageCrc !== crc32IEEE(data.subarray(off, off + total - 4))) {
      off += 1;
      continue;
    }
    const headerStart = off + 12;
    const payloadStart = headerStart + headersLength;
    const payloadEnd = off + total - 4;
    if (payloadStart > payloadEnd) break;
    try {
      messages.push({
        headers: decodeHeaders(data.subarray(headerStart, payloadStart)),
        payload: data.subarray(payloadStart, payloadEnd),
      });
    } catch {
      /* skip malformed headers */
    }
    off += total;
  }
  return messages;
}

function claudeJsonFromChunkPayload(payload: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const bytes = (parsed as { bytes?: unknown }).bytes;
  if (typeof bytes !== "string") return null;
  try {
    return atob(bytes);
  } catch {
    return null;
  }
}

/**
 * Original `awsStreamHandler` feeds each chunk's `string(v.Value.Bytes)` into
 * Claude SSE conversion. Emit `data: {json}\n\n` so existing Claude SSE parsers work.
 */
export function eventStreamToClaudeSse(data: Uint8Array): string {
  const chunks: string[] = [];
  for (const message of decodeAwsEventStream(data)) {
    if (headerValue(message.headers, AWS_EVENTSTREAM_MESSAGE_TYPE) !== AWS_EVENTSTREAM_EVENT_MESSAGE) continue;
    if (headerValue(message.headers, AWS_EVENTSTREAM_EVENT_TYPE) !== AWS_EVENTSTREAM_CHUNK_EVENT) continue;
    const json = claudeJsonFromChunkPayload(message.payload);
    if (json == null) continue;
    chunks.push(`data: ${json}\n\n`);
  }
  return chunks.join("");
}

function copyResponseHeaders(res: Response): Headers {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-type" || lower === "content-length") return;
    headers.set(key, value);
  });
  return headers;
}

/** Rewrite Bedrock eventstream HTTP bodies to Claude SSE. No-op otherwise. */
export async function decodeAwsEventStreamResponse(res: Response): Promise<Response> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes(AWS_EVENTSTREAM_CONTENT_TYPE)) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    const sse = eventStreamToClaudeSse(bytes);
    const headers = copyResponseHeaders(res);
    headers.set("content-type", "text/event-stream");
    return new Response(sse, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return new Response(bytes as unknown as BodyInit, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
}
