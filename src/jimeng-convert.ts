/** Original `relay/channel/jimeng` ConvertOpenAIRequest / ConvertImageRequest / GetRequestURL / Sign / DoResponse. */

import { bytesToHex, hmacSha256Raw, sha256Bytes } from "./crypto.js";
import { asInt, asObj } from "./openai-usage.js";

export const JIMENG_INVALID_KEY = "invalid api key format for jimeng: expected 'ak|sk'";

export type ConvertJimengOpts = {
  upstreamModelName?: string;
  created?: number;
};

function goQueryEscape(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function extraFieldsObject(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.extra_fields;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}

/** Original Jimeng ConvertOpenAIRequest: return `request` as-is (keeps `stream_options`). */
export function convertJimengOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertJimengOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

/** Original `jimeng.Adaptor.ConvertImageRequest`. */
export function convertJimengImageRequest(body: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    req_key: body.model,
    prompt: body.prompt,
  };
  const format = String(body.response_format ?? "");
  if (format === "" || format === "url") payload.return_url = true;
  Object.assign(payload, extraFieldsObject(body));
  return payload;
}

/** Original `jimeng.Adaptor.GetRequestURL`. */
export function jimengRequestURL(base: string): string {
  return `${String(base || "").replace(/\/+$/, "")}/?Action=CVProcess&Version=2022-08-31`;
}

export function parseJimengKey(apiKey: string): { accessKey: string; secretKey: string } {
  const parts = String(apiKey || "").split("|");
  if (parts.length !== 2) throw new Error(JIMENG_INVALID_KEY);
  return { accessKey: parts[0].trim(), secretKey: parts[1].trim() };
}

function formatXDate(date: Date): { xDate: string; shortDate: string } {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return { xDate: `${y}${mo}${d}T${h}${mi}${s}Z`, shortDate: `${y}${mo}${d}` };
}

function canonicalQueryString(url: URL): string {
  const keys = [...url.searchParams.keys()].sort();
  const parts: string[] = [];
  for (const key of keys) {
    const values = url.searchParams.getAll(key).sort();
    for (const value of values) parts.push(`${goQueryEscape(key)}=${goQueryEscape(value)}`);
  }
  return parts.join("&");
}

/** Original `jimeng.Sign`. HMAC-SHA256 over the exact JSON payload bytes. */
export async function applyJimengAuthorization(
  headers: Record<string, string>,
  url: string,
  method: string,
  body: unknown,
  apiKey: string,
  now = new Date(),
): Promise<string> {
  const { accessKey, secretKey } = parseJimengKey(apiKey);
  const payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const hexPayloadHash = bytesToHex(await sha256Bytes(payload));
  const parsed = new URL(url);
  const host = parsed.host;
  const { xDate, shortDate } = formatXDate(now);
  const contentType = headers["content-type"] || headers["Content-Type"] || "application/json";
  headers["content-type"] = contentType;
  headers.Host = host;
  headers["X-Date"] = xDate;
  headers["X-Content-Sha256"] = hexPayloadHash;
  const headersToSign: Record<string, string> = {
    host,
    "x-date": xDate,
    "x-content-sha256": hexPayloadHash,
    "content-type": contentType,
  };
  const signedHeaderKeys = Object.keys(headersToSign).sort();
  let canonicalHeaders = "";
  for (const key of signedHeaderKeys) {
    canonicalHeaders += `${key}:${String(headersToSign[key]).trim()}\n`;
  }
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalRequest = `${method}\n${parsed.pathname}\n${canonicalQueryString(parsed)}\n${canonicalHeaders}\n${signedHeaders}\n${hexPayloadHash}`;
  const hexHashedCanonicalRequest = bytesToHex(await sha256Bytes(canonicalRequest));
  const region = "cn-north-1";
  const serviceName = "cv";
  const credentialScope = `${shortDate}/${region}/${serviceName}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${hexHashedCanonicalRequest}`;
  const kDate = await hmacSha256Raw(secretKey, shortDate);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, serviceName);
  const kSigning = await hmacSha256Raw(kService, "request");
  const signature = bytesToHex(await hmacSha256Raw(kSigning, stringToSign));
  headers.authorization = `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.Authorization;
  return payload;
}

/** Original `responseJimeng2OpenAIImage` / `jimengImageHandler`. */
export function openaiFromJimengImage(
  upstream: Record<string, unknown>,
  opts: ConvertJimengOpts = {},
): Record<string, unknown> {
  const code = asInt(upstream.code);
  if (code !== 10000) {
    const err = new Error(String(upstream.message || ""));
    (err as Error & { type?: string; code?: string }).type = "jimeng_error";
    (err as Error & { type?: string; code?: string }).code = String(code);
    throw err;
  }
  const data = asObj(upstream.data);
  const images: Record<string, unknown>[] = [];
  const b64 = Array.isArray(data.binary_data_base64) ? (data.binary_data_base64 as unknown[]) : [];
  for (const item of b64) images.push({ b64_json: String(item) });
  const urls = Array.isArray(data.image_urls) ? (data.image_urls as unknown[]) : [];
  for (const item of urls) images.push({ url: String(item) });
  return {
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data: images,
  };
}
