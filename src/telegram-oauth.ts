import { randomOpaqueToken, s256ChallengeFromVerifier } from "./crypto.js";
import type { Store } from "./store.js";

/** Original `oauth.TelegramIssuer`. */
export const TELEGRAM_ISSUER = "https://oauth.telegram.org";

/** Original `oauth.ErrTelegramOAuthNotConfigured`. */
export const ERR_TELEGRAM_OAUTH_NOT_CONFIGURED =
  "Telegram OAuth is not configured or enabled. Please contact your administrator.";

/** Original `oauth.ErrTelegramOAuthConflict`. */
export const ERR_TELEGRAM_OAUTH_CONFLICT =
  "The telegram OAuth provider name is reserved. Ask your administrator to rename the conflicting custom provider.";

export type TelegramConfigErrorCode = "TELEGRAM_OAUTH_NOT_CONFIGURED" | "TELEGRAM_OAUTH_CONFLICT";

export interface TelegramOAuthFlow {
  code_verifier: string;
  client_id: string;
  redirect_uri: string;
}

export type TelegramOAuthStart =
  | { ok: true; flow: TelegramOAuthFlow }
  | { ok: false; code: TelegramConfigErrorCode; message: string };

/** Original `system_setting.TelegramSettings.IsConfigured`. */
export async function telegramSettingsConfigured(store: Store): Promise<boolean> {
  const client = (await store.option("telegram.client_id")).trim();
  const secret = (await store.option("telegram.client_secret")).trim();
  return Boolean(client && secret);
}

/**
 * Original `oauth.HasCustomProviderConflict("telegram")` after `LoadCustomProviders`:
 * a custom provider row with slug `telegram` cannot register over the built-in.
 */
export async function telegramCustomProviderConflict(store: Store): Promise<boolean> {
  const providers = (await store.listOAuthProviders()) as { slug?: unknown }[];
  return providers.some((p) => String(p.slug || "").toLowerCase() === "telegram");
}

/** Original `oauth.TelegramConfigurationError`. */
export async function telegramConfigurationError(
  store: Store,
): Promise<{ code: TelegramConfigErrorCode; message: string } | null> {
  if (await telegramCustomProviderConflict(store)) {
    return { code: "TELEGRAM_OAUTH_CONFLICT", message: ERR_TELEGRAM_OAUTH_CONFLICT };
  }
  if (!(await store.optionBool("TelegramOAuthEnabled", false)) || !(await telegramSettingsConfigured(store))) {
    return { code: "TELEGRAM_OAUTH_NOT_CONFIGURED", message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED };
  }
  return null;
}

/** Original `oauth.NewTelegramOAuthFlow`. */
export async function newTelegramOAuthFlow(store: Store): Promise<TelegramOAuthStart> {
  const err = await telegramConfigurationError(store);
  if (err) return { ok: false, ...err };
  const server = (await store.option("ServerAddress")).replace(/\/+$/, "");
  const redirectURI = `${server}/oauth/telegram`;
  let parsed: URL;
  try {
    parsed = new URL(redirectURI);
  } catch {
    return { ok: false, code: "TELEGRAM_OAUTH_NOT_CONFIGURED", message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED };
  }
  if (!parsed.host || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return { ok: false, code: "TELEGRAM_OAUTH_NOT_CONFIGURED", message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED };
  }
  return {
    ok: true,
    flow: {
      code_verifier: randomOpaqueToken(32),
      client_id: (await store.option("telegram.client_id")).trim(),
      redirect_uri: redirectURI,
    },
  };
}

/** Original `oauth.TelegramOAuthFlow.AuthorizationURL`. */
export async function telegramAuthorizationURL(flow: TelegramOAuthFlow, state: string): Promise<string> {
  const values = new URLSearchParams({
    client_id: flow.client_id,
    redirect_uri: flow.redirect_uri,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: await s256ChallengeFromVerifier(flow.code_verifier),
    code_challenge_method: "S256",
  });
  return `${TELEGRAM_ISSUER}/auth?${values.toString()}`;
}
