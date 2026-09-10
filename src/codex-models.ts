import { CHANNEL_TYPE_CODEX, parseJson } from "./constants.js";
import { parseChannelInfo } from "./channel-info.js";
import { defaultBaseUrl } from "./catalog.js";
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

type CodexOAuthKey = {
  access_token: string;
  account_id: string;
  refresh_token: string;
  email: string;
  last_refresh: string;
  expired: string;
  type: string;
};

/** Original `service.parseCodexOAuthKey` used by FetchCodexChannelModels. */
export function parseCodexOAuthKeyStrict(raw: string): CodexOAuthKey {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("codex channel: empty oauth key");
  const parsed = parseJson<Record<string, unknown> | null>(trimmed, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("codex channel: invalid oauth key json");
  }
  return {
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
  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: string;
  };
  if (res.status < 200 || res.status >= 300 || !payload.access_token) {
    throw new Error(`codex oauth refresh failed: status=${res.status}`);
  }
  const expiresAt = payload.expires_in
    ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    : String(payload.expires_at || rfc3339Now());
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || rt,
    expires_at: expiresAt,
  };
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

function persistCodexKey(oauth: CodexOAuthKey, refresh: CodexOAuthTokenResult): string {
  return JSON.stringify({
    access_token: refresh.access_token,
    refresh_token: refresh.refresh_token,
    account_id: oauth.account_id,
    email: oauth.email,
    last_refresh: rfc3339Now(),
    expired: refresh.expires_at,
    type: oauth.type || "codex",
  });
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
    if (!oauth.refresh_token.trim()) {
      throw new Error("failed to refresh Codex channel credential: codex channel: refresh_token is required to refresh credential");
    }
    try {
      const refreshed = await refreshCodexOAuthToken(oauth.refresh_token);
      const encoded = persistCodexKey(oauth, refreshed);
      await store.updateChannel(channel.id, { key: encoded });
      oauth = parseCodexOAuthKeyStrict(encoded);
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

/** Original `codex.Adaptor.ConvertOpenAIResponsesRequest`. */
export function convertCodexResponsesRequest(body: Record<string, unknown>, compact: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (out.instructions == null) out.instructions = "";
  if (!compact) {
    out.store = false;
    delete out.max_output_tokens;
    delete out.temperature;
    delete out.frequency_penalty;
    delete out.presence_penalty;
  }
  return out;
}

/** Original Codex adaptor GetRequestURL + SetupRequestHeader. */
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
  const compact = path.endsWith("/compact");
  const upstreamModel = applyModelMapping(channel, model);
  const payload =
    body && typeof body === "object" && !Array.isArray(body)
      ? convertCodexResponsesRequest({ ...(body as Record<string, unknown>), model: upstreamModel || (body as { model?: string }).model }, compact)
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