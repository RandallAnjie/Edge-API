/**
 * Original `relay/channel/aws` AKSK `InvokeModel` SigV4 (no AWS SDK).
 * 2-part keys use `Authorization: Bearer {token}`; 3-part keys use AWS4-HMAC-SHA256.
 */
import { CHANNEL_TYPE_AWS, parseJson } from "./constants.js";
import { bytesToHex, hmacSha256Raw, sha256Bytes } from "./crypto.js";
import { parseAwsAkskKey } from "./aws-convert.js";
import type { ChannelRow } from "./types.js";

export const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
export const AWS_SIGV4_SERVICE = "bedrock";
export const AWS_SIGV4_REQUEST = "aws4_request";

const SIGNED_HEADER_NAMES = ["accept", "content-type", "host", "x-amz-content-sha256", "x-amz-date"] as const;

function awsUsesApiKey(channel: Pick<ChannelRow, "settings">): boolean {
  return String(parseJson<Record<string, unknown>>(String(channel.settings || ""), {}).aws_key_type || "") === "api_key";
}

/** Original AWS `X-Amz-Date` / credential date. */
export function formatAwsAmzDate(date: Date): { amzDate: string; shortDate: string } {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return { amzDate: `${y}${mo}${d}T${h}${mi}${s}Z`, shortDate: `${y}${mo}${d}` };
}

/** AWS SigV4 URI encode (unreserved A-Z a-z 0-9 - . _ ~). */
export function awsUriEncode(value: string): string {
  const utf8 = new TextEncoder().encode(value);
  let out = "";
  for (const b of utf8) {
    const ch = String.fromCharCode(b);
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "~"
    ) {
      out += ch;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

function awsCanonicalUri(url: URL): string {
  const raw = url.pathname || "/";
  const segments = raw.split("/");
  return segments.map((seg) => (seg === "" ? "" : awsUriEncode(seg))).join("/") || "/";
}

function awsCanonicalQuery(url: URL): string {
  const keys = [...url.searchParams.keys()].sort();
  const parts: string[] = [];
  for (const key of keys) {
    const values = url.searchParams.getAll(key).sort();
    for (const value of values) parts.push(`${awsUriEncode(key)}=${awsUriEncode(value)}`);
  }
  return parts.join("&");
}

function payloadString(body: unknown): string {
  if (typeof body === "string") return body;
  if (body == null) return "";
  return JSON.stringify(body);
}

function headerLookup(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return String(value || "").trim();
  }
  return "";
}

/**
 * Sign an AWS SigV4 request. Mutates `headers` with `x-amz-date`,
 * `x-amz-content-sha256`, and `authorization`. Returns the exact payload bytes
 * that were hashed (so `fetch` must send this string, not re-stringify).
 */
export async function signAwsSigV4(
  headers: Record<string, string>,
  url: string,
  method: string,
  body: unknown,
  accessKey: string,
  secretKey: string,
  region: string,
  now = new Date(),
): Promise<string> {
  const payload = payloadString(body);
  const parsed = new URL(url);
  const host = parsed.host;
  const { amzDate, shortDate } = formatAwsAmzDate(now);
  const contentSha256 = bytesToHex(await sha256Bytes(payload));
  const accept = headerLookup(headers, "accept") || "application/json";
  const contentType = headerLookup(headers, "content-type") || "application/json";
  headers.accept = accept;
  headers["content-type"] = contentType;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = contentSha256;
  delete headers.Authorization;

  const headerMap: Record<string, string> = {
    accept,
    "content-type": contentType,
    host,
    "x-amz-content-sha256": contentSha256,
    "x-amz-date": amzDate,
  };
  let canonicalHeaders = "";
  for (const name of SIGNED_HEADER_NAMES) {
    canonicalHeaders += `${name}:${headerMap[name]}\n`;
  }
  const signedHeaders = SIGNED_HEADER_NAMES.join(";");
  const canonicalRequest = `${method.toUpperCase()}\n${awsCanonicalUri(parsed)}\n${awsCanonicalQuery(parsed)}\n${canonicalHeaders}\n${signedHeaders}\n${contentSha256}`;
  const hashedCanonicalRequest = bytesToHex(await sha256Bytes(canonicalRequest));
  const credentialScope = `${shortDate}/${region}/${AWS_SIGV4_SERVICE}/${AWS_SIGV4_REQUEST}`;
  const stringToSign = `${AWS_SIGV4_ALGORITHM}\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;
  const kDate = await hmacSha256Raw("AWS4" + secretKey, shortDate);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, AWS_SIGV4_SERVICE);
  const kSigning = await hmacSha256Raw(kService, AWS_SIGV4_REQUEST);
  const signature = bytesToHex(await hmacSha256Raw(kSigning, stringToSign));
  headers.authorization = `${AWS_SIGV4_ALGORITHM} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return payload;
}

/**
 * Original `newAwsClient` + SDK signing. Skip API-key Converse (`aws_key_type=api_key`).
 * 2-part AKSK: `Authorization: Bearer {first segment}`. 3-part: SigV4.
 */
export async function applyAwsAkskAuth(
  channel: Pick<ChannelRow, "type" | "settings">,
  headers: Record<string, string>,
  url: string,
  method: string,
  body: unknown,
  apiKey: string,
  now = new Date(),
): Promise<unknown> {
  if (channel.type !== CHANNEL_TYPE_AWS) return body;
  if (awsUsesApiKey(channel)) return body;
  const creds = parseAwsAkskKey(apiKey);
  if (creds.mode === "bearer") {
    headers.authorization = `Bearer ${creds.token}`;
    delete headers.Authorization;
    return body;
  }
  return signAwsSigV4(headers, url, method, body, creds.accessKey, creds.secretKey, creds.region, now);
}
