/**
 * Original `relay/channel/vertex` ADC JWT mint + `jsplugin.resolveAuth`
 * (`oauth2_jwt`) on workerd. RS256 JWT + HTTP `oauth2/v4/token`, no Google SDK.
 */
import { parseChannelInfo, channelKeys } from "./channel-info.js";
import { goJSONKind, goJSONSyntaxError, goUnmarshalJSON } from "./channel-validate.js";
import { CHANNEL_TYPE_VERTEX, parseJson } from "./constants.js";
import type { ChannelRow } from "./types.js";

/** Original `vertex.Credentials` JSON fields. */
export type VertexCredentials = {
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
};

export const VERTEX_OAUTH_TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token";
export const VERTEX_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const VERTEX_JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const CHAT_TOKEN_TTL_MS = 30 * 60 * 1000;
const PLUGIN_TOKEN_TTL_MS = 25 * 60 * 1000;
const JWT_TTL_MS = 35 * 60 * 1000;
const RSA_OID = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
const EC_OID = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);

type PluginAuthCacheEntry = { header: string; projectID: string; expiresAt: number };
type ChatTokenCacheEntry = { token: string; expiresAt: number };

const pluginAuthCache = new Map<string, PluginAuthCacheEntry>();
const chatTokenCache = new Map<string, ChatTokenCacheEntry>();

export type PluginAuthResult = { auth: Record<string, unknown>; apiKey?: string; authError?: string };

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function copyBytes(u: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out.buffer;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function jsonFieldString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Original `json.Unmarshal` into `vertex.Credentials`. */
export function parseVertexCredentials(raw: string): VertexCredentials {
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    throw new Error(`json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type vertex.Credentials`);
  }
  const o = parsed.value as Record<string, unknown>;
  return {
    project_id: jsonFieldString(o.project_id),
    private_key_id: jsonFieldString(o.private_key_id),
    private_key: jsonFieldString(o.private_key),
    client_email: jsonFieldString(o.client_email),
    client_id: jsonFieldString(o.client_id),
  };
}

/** Original `vertex.Adaptor.getRequestUrl` ADC `common.Unmarshal` wrap. */
export function decodeVertexCredentialsFile(apiKey: string): VertexCredentials {
  try {
    return parseVertexCredentials(apiKey);
  } catch (err) {
    throw new Error(`failed to decode credentials file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parsePemPkcs8(privateKeyPEM: string): Uint8Array {
  let stripped = privateKeyPEM;
  stripped = stripped.replaceAll("-----BEGIN PRIVATE KEY-----", "");
  stripped = stripped.replaceAll("-----END PRIVATE KEY-----", "");
  stripped = stripped.replaceAll("\r", "");
  stripped = stripped.replaceAll("\n", "");
  stripped = stripped.replaceAll("\\n", "");
  const wrapped = `-----BEGIN PRIVATE KEY-----\n${stripped}\n-----END PRIVATE KEY-----`;
  const inner = wrapped.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s+/g, "");
  if (!inner || inner.length % 4 !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(inner)) {
    throw new Error("failed to parse PEM block containing the private key");
  }
  let der: Uint8Array;
  try {
    const bin = atob(inner);
    der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  } catch {
    throw new Error("failed to parse PEM block containing the private key");
  }
  if (!der.length) throw new Error("failed to parse PEM block containing the private key");
  return der;
}

/** Original `vertex.createSignedJWT` (RS256, typ JWT, 35-minute exp). */
export async function createSignedJWT(email: string, privateKeyPEM: string, now = Date.now()): Promise<string> {
  const der = parsePemPkcs8(privateKeyPEM);
  if (containsBytes(der, EC_OID) && !containsBytes(der, RSA_OID)) {
    throw new Error("not an RSA private key");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      copyBytes(der) as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    if (!containsBytes(der, RSA_OID)) throw new Error("not an RSA private key");
    throw err instanceof Error ? err : new Error(String(err));
  }
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const iat = Math.floor(now / 1000);
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: email,
        scope: VERTEX_OAUTH_SCOPE,
        aud: VERTEX_OAUTH_TOKEN_URL,
        exp: iat + JWT_TTL_MS / 1000,
        iat,
      }),
    ),
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Original `url.Values.Encode` for the JWT bearer token form (keys sorted). */
export function encodeVertexTokenForm(signedJWT: string): string {
  const pairs: [string, string][] = [
    ["grant_type", VERTEX_JWT_BEARER_GRANT],
    ["assertion", signedJWT],
  ];
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, "+")}=${encodeURIComponent(v).replace(/%20/g, "+")}`)
    .join("&");
}

async function defaultExchangeJwtForAccessToken(signedJWT: string, _proxy = ""): Promise<string> {
  const res = await fetch(VERTEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeVertexTokenForm(signedJWT),
  });
  const text = await res.text();
  let result: unknown;
  try {
    result = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(goJSONSyntaxError(text, err));
  }
  if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as { access_token?: unknown }).access_token === "string") {
    return (result as { access_token: string }).access_token;
  }
  throw new Error(`failed to get access token: ${JSON.stringify(result)}`);
}

async function defaultAcquireAccessToken(creds: VertexCredentials, proxy = ""): Promise<string> {
  let signedJWT: string;
  try {
    signedJWT = await createSignedJWT(creds.client_email, creds.private_key);
  } catch (err) {
    throw new Error(`failed to create signed JWT: ${err instanceof Error ? err.message : String(err)}`);
  }
  return exchangeJwtForAccessToken(signedJWT, proxy);
}

/** Original plugin-path `vertex.AcquireAccessToken` (overridable in tests). */
export let acquireAccessToken = defaultAcquireAccessToken;

/** Original `vertex.exchangeJwtForAccessToken` / `exchangeJwtForAccessTokenWithProxy`. */
export let exchangeJwtForAccessToken = defaultExchangeJwtForAccessToken;

function pluginCacheKey(apiKey: string, proxy: string): string {
  return `${apiKey}\x00${proxy}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Original `jsplugin.resolveAuth`. */
export async function resolvePluginAuth(meta: Record<string, unknown>, apiKey: string, proxy = ""): Promise<PluginAuthResult> {
  const authMeta = isPlainObject(meta.auth) ? meta.auth : {};
  const typeName = String(authMeta.type || "").trim();
  if (!typeName || typeName === "none" || typeName === "api_key") {
    return { auth: { authHeader: apiKey }, apiKey };
  }
  const cacheKey = pluginCacheKey(apiKey, proxy);
  const cached = pluginAuthCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { auth: { authHeader: cached.header, projectId: cached.projectID } };
  }
  let credentials: VertexCredentials;
  try {
    credentials = parseVertexCredentials(apiKey);
  } catch (err) {
    return { auth: {}, authError: `decode oauth2_jwt credentials: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const token = await acquireAccessToken(credentials, proxy);
    const entry: PluginAuthCacheEntry = {
      header: `Bearer ${token}`,
      projectID: credentials.project_id,
      expiresAt: Date.now() + PLUGIN_TOKEN_TTL_MS,
    };
    pluginAuthCache.set(cacheKey, entry);
    return { auth: { authHeader: entry.header, projectId: entry.projectID } };
  } catch (err) {
    return { auth: {}, authError: err instanceof Error ? err.message : String(err) };
  }
}

export function expirePluginAuthCache(apiKey: string, proxy = ""): void {
  const key = pluginCacheKey(apiKey, proxy);
  const entry = pluginAuthCache.get(key);
  if (entry) pluginAuthCache.set(key, { ...entry, expiresAt: Date.now() - 1 });
}

function vertexChatCacheKey(channel: Pick<ChannelRow, "id" | "key" | "channel_info">, apiKey: string): string {
  const info = parseChannelInfo(String(channel.channel_info || ""));
  if (!info.is_multi_key) return `access-token-${channel.id}`;
  const keys = channelKeys(channel.key);
  const index = keys.indexOf(apiKey);
  return `access-token-${channel.id}-${index >= 0 ? index : 0}`;
}

/** Original `vertex.getAccessToken` (channel cache, 30-minute expire). */
export async function getVertexAccessToken(
  channel: Pick<ChannelRow, "id" | "key" | "channel_info">,
  credentials: VertexCredentials,
  apiKey: string,
  proxy = "",
): Promise<string> {
  const cacheKey = vertexChatCacheKey(channel, apiKey);
  const cached = chatTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  let signedJWT: string;
  try {
    signedJWT = await createSignedJWT(credentials.client_email, credentials.private_key);
  } catch (err) {
    throw new Error(`failed to create signed JWT: ${err instanceof Error ? err.message : String(err)}`);
  }
  let token: string;
  try {
    token = await exchangeJwtForAccessToken(signedJWT, proxy);
  } catch (err) {
    throw new Error(`failed to exchange JWT for access token: ${err instanceof Error ? err.message : String(err)}`);
  }
  chatTokenCache.set(cacheKey, { token, expiresAt: Date.now() + CHAT_TOKEN_TTL_MS });
  return token;
}

export function channelSettingProxy(setting: string | undefined | null): string {
  return String(parseJson<Record<string, unknown>>(String(setting || ""), {}).proxy || "");
}

function vertexUsesApiKey(channel: Pick<ChannelRow, "settings">): boolean {
  return String(parseJson<Record<string, unknown>>(String(channel.settings || ""), {}).vertex_key_type || "") === "api_key";
}

/** Original `vertex.Adaptor.SetupRequestHeader` ADC `Authorization: Bearer`. */
export async function applyVertexAdcAuth(
  channel: Pick<ChannelRow, "id" | "type" | "key" | "settings" | "setting" | "channel_info">,
  headers: Record<string, string>,
  apiKey: string,
): Promise<void> {
  if (channel.type !== CHANNEL_TYPE_VERTEX) return;
  if (vertexUsesApiKey(channel)) return;
  const credentials = decodeVertexCredentialsFile(apiKey);
  const token = await getVertexAccessToken(channel, credentials, apiKey, channelSettingProxy(channel.setting));
  headers.authorization = `Bearer ${token}`;
  if (credentials.project_id) headers["x-goog-user-project"] = credentials.project_id;
}

export function resetVertexAuthForTests(overrides?: {
  acquireAccessToken?: typeof acquireAccessToken;
  exchangeJwtForAccessToken?: typeof exchangeJwtForAccessToken;
}): void {
  pluginAuthCache.clear();
  chatTokenCache.clear();
  acquireAccessToken = overrides?.acquireAccessToken ?? defaultAcquireAccessToken;
  exchangeJwtForAccessToken = overrides?.exchangeJwtForAccessToken ?? defaultExchangeJwtForAccessToken;
}
