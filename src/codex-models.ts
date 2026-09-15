import { CHANNEL_TYPE_CODEX, parseJson } from "./constants.js";
import { parseChannelInfo } from "./channel-info.js";
import { defaultBaseUrl } from "./catalog.js";
import { convertCodexResponsesRequest } from "./codex-convert.js";
import { applyFetchModelsHeaderOverrides, applyModelMapping, joinUrl, type RelayMode, type UpstreamTarget } from "./upstream.js";
import type { Store } from "./store.js";
import type { ChannelRow } from "./types.js";

/** Original `service.codexLatestReleaseURL`. */
export const CODEX_LATEST_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const CODEX_CLIENT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type CodexClientVersionCache = { version: string; expiresAt: number };

let latestCodexClientVersion: CodexClientVersionCache = { version: "", expiresAt: 0 };

/** Test helper — original cache is process-global. */
export function resetCodexClientVersionCache(): void {
  latestCodexClientVersion = { version: "", expiresAt: 0 };
}

export type CodexOAuthKey = {
  id_token: string;
  access_token: string;
  account_id: string;
  refresh_token: string;
  email: string;
  last_refresh: string;
  expired: string;
  type: string;
};

/** Original `codex.ParseOAuthKey` / `service.parseCodexOAuthKey`. */
export function parseCodexOAuthKeyStrict(raw: string): CodexOAuthKey {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("codex channel: empty oauth key");
  const parsed = parseJson<Record<string, unknown> | null>(trimmed, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("codex channel: invalid oauth key json");
  }
  return {
    id_token: String(parsed.id_token || ""),
    access_token: String(parsed.access_token || ""),
    account_id: String(parsed.account_id || parsed.chatgpt_account_id || ""),
    refresh_token: String(parsed.refresh_token || ""),
    email: String(parsed.email || ""),
    last_refresh: String(parsed.last_refresh || ""),
    expired: String(parsed.expired || ""),
    type: String(parsed.type || ""),
  };
}

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type CodexOAuthTokenResult = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

/** Original `service.RefreshCodexOAuthToken`. */
export async function refreshCodexOAuthToken(refreshToken: string, clientId = CODEX_OAUTH_CLIENT_ID): Promise<CodexOAuthTokenResult> {
  const rt = refreshToken.trim();
  if (!rt) throw new Error("empty refresh_token");
  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: clientId,
    }),
  });
  let payload: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`codex oauth refresh failed: status=${res.status}`);
  }
  const accessToken = String(payload.access_token || "").trim();
  const nextRefresh = String(payload.refresh_token || "").trim();
  const expiresIn = payload.expires_in;
  if (!accessToken || !nextRefresh || typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    throw new Error("codex oauth refresh response missing fields");
  }
  return {
    access_token: accessToken,
    refresh_token: nextRefresh,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

function decodeJWTClaims(token: string): Record<string, unknown> | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
    const claims = JSON.parse(atob(payload + pad)) as unknown;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Original `service.ExtractCodexAccountIDFromJWT`. */
export function extractCodexAccountIDFromJWT(token: string): string {
  const claims = decodeJWTClaims(token);
  if (!claims) return "";
  const raw = claims["https://api.openai.com/auth"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  return String((raw as { chatgpt_account_id?: unknown }).chatgpt_account_id || "").trim();
}

/** Original `service.ExtractEmailFromJWT`. */
export function extractEmailFromJWT(token: string): string {
  const claims = decodeJWTClaims(token);
  if (!claims) return "";
  return String(claims.email || "").trim();
}

async function fetchLatestCodexClientVersion(): Promise<string> {
  const res = await fetch(CODEX_LATEST_RELEASE_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "new-api",
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`codex release lookup failed: status=${res.status}`);
  }
  const release = (await res.json()) as { name?: string; draft?: boolean; prerelease?: boolean };
  if (release.draft || release.prerelease) throw new Error("latest codex release is not stable");
  const version = String(release.name || "").trim();
  if (!version) throw new Error("latest codex release has no version name");
  return version;
}

/** Original `service.GetLatestCodexClientVersion`. */
export async function getLatestCodexClientVersion(): Promise<string> {
  const now = Date.now();
  if (latestCodexClientVersion.version && now < latestCodexClientVersion.expiresAt) {
    return latestCodexClientVersion.version;
  }
  try {
    const version = await fetchLatestCodexClientVersion();
    latestCodexClientVersion = { version, expiresAt: now + CODEX_CLIENT_VERSION_CACHE_TTL_MS };
    return version;
  } catch (err) {
    if (latestCodexClientVersion.version) {
      latestCodexClientVersion.expiresAt = now + CODEX_CLIENT_VERSION_CACHE_TTL_MS;
      return latestCodexClientVersion.version;
    }
    throw err;
  }
}

export function codexModelsURL(baseURL: string, clientVersion: string): string {
  const base = baseURL.replace(/\/+$/, "");
  const url = new URL(base + "/backend-api/codex/models");
  url.searchParams.set("client_version", clientVersion);
  return url.toString();
}

/** Original `service.FetchCodexModels`. */
export async function fetchCodexModels(
  baseURL: string,
  oauthKey: { access_token: string; account_id: string },
  clientVersion: string,
): Promise<{ statusCode: number; models: string[] }> {
  const trimmedBase = String(baseURL || "").trim().replace(/\/+$/, "");
  const accessToken = String(oauthKey.access_token || "").trim();
  const accountID = String(oauthKey.account_id || "").trim();
  const version = String(clientVersion || "").trim();
  if (!trimmedBase) throw new Error("empty baseURL");
  if (!accessToken) throw new Error("codex channel: access_token is required");
  if (!accountID) throw new Error("codex channel: account_id is required");
  if (!version) throw new Error("codex channel: client_version is required");
  const res = await fetch(codexModelsURL(trimmedBase, version), {
    method: "GET",
    headers: {
      authorization: "Bearer " + accessToken,
      "chatgpt-account-id": accountID,
      "user-agent": "codex-cli/" + version,
      accept: "application/json",
    },
  });
  if (res.status < 200 || res.status >= 300) return { statusCode: res.status, models: [] };
  const body = (await res.json().catch(() => ({}))) as { models?: { slug?: string }[] };
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of body.models || []) {
    const slug = String(item.slug || "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push(slug);
  }
  return { statusCode: res.status, models };
}

/** Original `common.Marshal` of refreshed `CodexOAuthKey` / `codex.OAuthKey` (`omitempty`). */
export function persistCodexOAuthKey(oauth: CodexOAuthKey, refresh: CodexOAuthTokenResult): string {
  const next: CodexOAuthKey = {
    id_token: oauth.id_token,
    access_token: refresh.access_token,
    refresh_token: refresh.refresh_token,
    account_id: oauth.account_id,
    last_refresh: rfc3339Now(),
    email: oauth.email,
    type: oauth.type.trim() ? oauth.type : "codex",
    expired: refresh.expires_at,
  };
  if (!next.account_id.trim()) {
    const accountId = extractCodexAccountIDFromJWT(next.access_token);
    if (accountId) next.account_id = accountId;
  }
  if (!next.email.trim()) {
    const email = extractEmailFromJWT(next.access_token);
    if (email) next.email = email;
  }
  const encoded: Record<string, string> = {};
  if (next.id_token) encoded.id_token = next.id_token;
  if (next.access_token) encoded.access_token = next.access_token;
  if (next.refresh_token) encoded.refresh_token = next.refresh_token;
  if (next.account_id) encoded.account_id = next.account_id;
  if (next.last_refresh) encoded.last_refresh = next.last_refresh;
  if (next.email) encoded.email = next.email;
  if (next.type) encoded.type = next.type;
  if (next.expired) encoded.expired = next.expired;
  return JSON.stringify(encoded);
}

/** Original `service.RefreshCodexChannelCredential`. */
export async function refreshCodexChannelCredential(
  store: Store,
  channelId: number,
): Promise<{ oauth: CodexOAuthKey; channel: ChannelRow }> {
  const ch = await store.getChannel(channelId);
  if (!ch) throw new Error("channel not found");
  if (ch.type !== CHANNEL_TYPE_CODEX) throw new Error("channel type is not Codex");
  const oauth = parseCodexOAuthKeyStrict(String(ch.key || "").trim());
  if (!oauth.refresh_token.trim()) {
    throw new Error("codex channel: refresh_token is required to refresh credential");
  }
  const refreshed = await refreshCodexOAuthToken(oauth.refresh_token);
  const encoded = persistCodexOAuthKey(oauth, refreshed);
  await store.updateChannel(ch.id, { key: encoded });
  return { oauth: parseCodexOAuthKeyStrict(encoded), channel: { ...ch, key: encoded } };
}

/** Original `service.FetchCodexChannelModels`. */
export async function fetchCodexChannelModels(channel: ChannelRow, store?: Store): Promise<string[]> {
  if (channel.type !== CHANNEL_TYPE_CODEX) throw new Error("channel type is not Codex");
  if (parseChannelInfo(String(channel.channel_info || "")).is_multi_key) {
    throw new Error("codex channel does not support multi-key model discovery");
  }
  let clientVersion: string;
  try {
    clientVersion = await getLatestCodexClientVersion();
  } catch (err) {
    throw new Error(`failed to get Codex client version: ${err instanceof Error ? err.message : String(err)}`);
  }
  const baseURL = String(channel.base_url || "").trim() || defaultBaseUrl(CHANNEL_TYPE_CODEX);
  let oauth = parseCodexOAuthKeyStrict(channel.key);
  let result = await fetchCodexModels(baseURL, oauth, clientVersion);
  if (result.statusCode === 401) {
    if (channel.id <= 0) {
      throw new Error("codex channel credential expired; save the channel before retrying model fetch");
    }
    if (!store) throw new Error("failed to refresh Codex channel credential: store unavailable");
    try {
      const { oauth: next } = await refreshCodexChannelCredential(store, channel.id);
      oauth = next;
      result = await fetchCodexModels(baseURL, oauth, clientVersion);
    } catch (err) {
      throw new Error(`failed to refresh Codex channel credential: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`upstream status: ${result.statusCode}`);
  }
  return result.models;
}

/** Original `codex.Adaptor.GetRequestURL`. */
export function codexRelayPath(mode: RelayMode, requestPath: string): string {
  if (mode === "responses" || requestPath.includes("/v1/responses")) {
    if (requestPath.includes("/compact")) return "/backend-api/codex/responses/compact";
    return "/backend-api/codex/responses";
  }
  if (mode === "alpha_search" || requestPath.includes("/v1/alpha/search")) {
    return "/backend-api/codex/alpha/search";
  }
  throw new Error("codex channel: only /v1/responses, /v1/responses/compact and /v1/alpha/search are supported");
}

export { convertCodexResponsesRequest } from "./codex-convert.js";

/** Original Codex adaptor GetRequestURL + SetupRequestHeader. ConvertOpenAIResponsesRequest JSON is applied by `convertCodexResponsesRequest`. */
export function buildCodexRelayTarget(
  channel: ChannelRow,
  mode: RelayMode,
  requestPath: string,
  model: string,
  body: unknown,
  isStream: boolean,
): UpstreamTarget {
  const rawKey = String(channel.key || "").trim();
  if (!rawKey.startsWith("{")) throw new Error("codex channel: key must be a JSON object");
  const oauth = parseCodexOAuthKeyStrict(rawKey);
  if (!String(oauth.access_token || "").trim()) throw new Error("codex channel: access_token is required");
  if (!String(oauth.account_id || "").trim()) throw new Error("codex channel: account_id is required");
  const path = codexRelayPath(mode, requestPath);
  const compact = path.includes("/compact");
  const isResponses = mode === "responses" || requestPath.includes("/v1/responses");
  const upstreamModel = applyModelMapping(channel, model);
  const payload =
    body && typeof body === "object" && !Array.isArray(body) && isResponses
      ? convertCodexResponsesRequest(
          { ...(body as Record<string, unknown>), model: upstreamModel || (body as { model?: string }).model },
          { compact },
        )
      : body && typeof body === "object" && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: upstreamModel || (body as { model?: string }).model }
        : body;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer " + oauth.access_token,
    "chatgpt-account-id": oauth.account_id,
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: isStream ? "text/event-stream" : "application/json",
  };
  applyFetchModelsHeaderOverrides(channel, oauth.access_token, headers);
  const base = String(channel.base_url || "").trim() || defaultBaseUrl(CHANNEL_TYPE_CODEX);
  return { url: joinUrl(base, path), headers, body: payload, method: "POST" };
}