import { generateAffCode, generateTokenKey } from "./crypto.js";
import { hmacSha256Hex, sha256Bytes, timingSafeEqualStr } from "./crypto.js";
import { nowSec, randomHex, ROLE_USER, USER_ENABLED } from "./constants.js";
import { apiErrorMsg, apiOk, i18nPair, json, OAuthI18nError, writeSecurityOperationError } from "./http.js";
import { ERR_TELEGRAM_ACCOUNT_NOT_BOUND } from "./telegram-oauth.js";
import { notifyAccountSecurityChange, normalizeEmail } from "./mail.js";
import { authUnauthorized, setupLogin } from "./auth.js";
import { finishInsertUser } from "./user-insert.js";
import type { Store } from "./store.js";
import type { Env, UserRow } from "./types.js";
import type { Context } from "./router.js";

export { OAuthI18nError, OAuthAccessDeniedError } from "./http.js";

/** Original `model.UserNameMaxLength`. */
const USER_NAME_MAX_LENGTH = 20;

/** Original `i18n.MsgOAuthNotEnabled`. */
export function oauthNotEnabledMessage(req: Request, name: string): string {
  return i18nPair(
    req,
    `管理员未开启通过 ${name} 登录以及注册`,
    `${name} login and registration has not been enabled by administrator`,
  );
}

/** Original `i18n.MsgOAuthInvalidCode`. */
export function oauthInvalidCodeMessage(req: Request): string {
  return i18nPair(req, "无效的授权码", "Invalid authorization code");
}

export interface OAuthProfile {
  id: string;
  username: string;
  display_name: string;
  email?: string;
  field: "github_id" | "discord_id" | "linuxdo_id" | "oidc_id" | "wechat_id" | "telegram_id";
  slug?: string;
  provider_id?: number;
  extra?: { legacy_id?: string };
}

/** Original `oauth.Provider.GetName`. */
export async function oauthProviderDisplayName(store: Store, provider: string): Promise<string> {
  if (provider === "github") return "GitHub";
  if (provider === "discord") return "Discord";
  if (provider === "linuxdo") return "Linux DO";
  if (provider === "telegram") return "Telegram";
  if (provider === "oidc") return (await store.option("oidc.display_name")).trim() || "OIDC";
  const custom = await store.getOAuthProvider(provider);
  const name = String((custom as { name?: unknown } | null)?.name || "").trim();
  return name || provider;
}

export const BUILTIN_OAUTH = new Set(["github", "discord", "linuxdo", "oidc", "telegram"]);

export async function oauthProviderKnown(store: Store, name: string): Promise<boolean> {
  if (BUILTIN_OAUTH.has(name)) return true;
  const custom = await store.getOAuthProvider(name);
  return Boolean(custom);
}

/** Original `oauth.Provider.IsEnabled` used by `HandleOAuth` before the provider `error` query. */
export async function oauthProviderIsEnabled(store: Store, name: string): Promise<boolean> {
  if (name === "github") return store.optionBool("GitHubOAuthEnabled", false);
  if (name === "discord") return store.optionBool("DiscordOAuthEnabled", false);
  if (name === "linuxdo") return store.optionBool("LinuxDOOAuthEnabled", false);
  if (name === "oidc") return store.optionBool("OIDCAuthEnabled", false);
  if (name === "telegram") return store.optionBool("TelegramOAuthEnabled", false);
  const custom = await store.getOAuthProvider(name);
  return Boolean(custom && Number(custom.enabled));
}

export async function getBoundOAuthUserId(store: Store, user: UserRow, provider: string): Promise<string> {
  if (provider === "github") return user.github_id || "";
  if (provider === "discord") return user.discord_id || "";
  if (provider === "linuxdo") return user.linuxdo_id || "";
  if (provider === "oidc") return user.oidc_id || "";
  if (provider === "telegram") return user.telegram_id || "";
  if (provider === "wechat") return user.wechat_id || "";
  const custom = await store.getOAuthProvider(provider);
  if (!custom) return "";
  const binding = await store.getUserOAuthBinding(user.id, Number(custom.id));
  return binding?.provider_user_id || "";
}

export async function exchangeGithub(clientId: string, secret: string, code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: secret, code }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new OAuthI18nError("GitHub 获取 Token 失败，请检查设置", "Failed to get token from GitHub, please check settings");
  }
  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userRes.ok) {
    throw new OAuthI18nError("获取用户信息失败", "Failed to get user information");
  }
  const gh = (await userRes.json()) as { id?: number; login?: string; name?: string | null; email?: string | null };
  if (!gh.id || !gh.login) {
    throw new OAuthI18nError("GitHub 获取用户信息为空，请检查设置", "GitHub returned empty user info, please check settings");
  }
  return {
    id: String(gh.id),
    username: gh.login,
    display_name: gh.name || "",
    email: gh.email || undefined,
    field: "github_id",
    extra: { legacy_id: gh.login },
  };
}

/** Original `oauth.DiscordProvider.ExchangeToken` redirect: `ServerAddress + "/oauth/discord"`. */
export function discordRedirectUri(serverAddress: string): string {
  return `${serverAddress}/oauth/discord`;
}

function discordConnectFailed(): OAuthI18nError {
  return new OAuthI18nError(
    "无法连接至 Discord 服务器，请稍后重试",
    "Unable to connect to Discord server, please try again later",
  );
}

/** Original `oauth.DiscordProvider.ExchangeToken` / `GetUserInfo`. */
export async function exchangeDiscord(opts: {
  clientId: string;
  secret: string;
  code: string;
  redirect: string;
}): Promise<OAuthProfile> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.secret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirect,
  });
  let tokenRes: Response;
  try {
    tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
  } catch {
    throw discordConnectFailed();
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new OAuthI18nError(
      "Discord 获取 Token 失败，请检查设置",
      "Failed to get token from Discord, please check settings",
    );
  }
  let userRes: Response;
  try {
    userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bearer ${tokenJson.access_token}` },
    });
  } catch {
    throw discordConnectFailed();
  }
  if (userRes.status !== 200) {
    throw new OAuthI18nError("获取用户信息失败", "Failed to get user information");
  }
  const u = (await userRes.json()) as { id?: string; username?: string; global_name?: string };
  if (!u.id || !u.username) {
    throw new OAuthI18nError(
      "Discord 获取用户信息为空，请检查设置",
      "Discord returned empty user info, please check settings",
    );
  }
  return {
    id: u.id,
    username: u.username,
    display_name: u.global_name || "",
    field: "discord_id",
  };
}

/** Original `LinuxDOProvider.ExchangeToken` redirect: `scheme://host/api/oauth/linuxdo`. */
export function linuxdoRedirectUri(req: Request): string {
  return `${new URL(req.url).origin}/api/oauth/linuxdo`;
}

function linuxDoConnectFailed(): OAuthI18nError {
  return new OAuthI18nError(
    "无法连接至 Linux DO 服务器，请稍后重试",
    "Unable to connect to Linux DO server, please try again later",
  );
}

/** Original `oauth.LinuxDOProvider.ExchangeToken` / `GetUserInfo`. */
export async function exchangeLinuxDO(opts: {
  clientId: string;
  secret: string;
  code: string;
  redirect: string;
  minimumTrustLevel: number;
  tokenUrl?: string;
  userUrl?: string;
}): Promise<OAuthProfile> {
  const tokenUrl = opts.tokenUrl || "https://connect.linux.do/oauth2/token";
  const userUrl = opts.userUrl || "https://connect.linux.do/api/user";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirect,
  });
  let tokenRes: Response;
  try {
    tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${opts.clientId}:${opts.secret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  } catch {
    throw linuxDoConnectFailed();
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new OAuthI18nError(
      "Linux DO 获取 Token 失败，请检查设置",
      "Failed to get token from Linux DO, please check settings",
    );
  }
  let userRes: Response;
  try {
    userRes = await fetch(userUrl, {
      headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json" },
    });
  } catch {
    throw linuxDoConnectFailed();
  }
  const u = (await userRes.json()) as { id?: number; username?: string; name?: string; trust_level?: number };
  if (!u.id) {
    throw new OAuthI18nError(
      "Linux DO 获取用户信息为空，请检查设置",
      "Linux DO returned empty user info, please check settings",
    );
  }
  if ((u.trust_level || 0) < opts.minimumTrustLevel) {
    throw new OAuthI18nError(
      "Linux DO 信任等级未达到管理员设置的最低信任等级",
      "Linux DO trust level does not meet the minimum required by administrator",
    );
  }
  return {
    id: String(u.id),
    username: u.username || "",
    display_name: u.name || "",
    field: "linuxdo_id",
  };
}

/** Original `oauth.OIDCProvider.ExchangeToken` redirect: `ServerAddress + "/oauth/oidc"`. */
export function oidcRedirectUri(serverAddress: string): string {
  return `${serverAddress}/oauth/oidc`;
}

function oidcConnectFailed(): OAuthI18nError {
  return new OAuthI18nError("无法连接至 OIDC 服务器，请稍后重试", "Unable to connect to OIDC server, please try again later");
}

/** Original `oauth.OIDCProvider.ExchangeToken` / `GetUserInfo`. */
export async function exchangeOidc(opts: {
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  secret: string;
  code: string;
  redirect: string;
}): Promise<OAuthProfile> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.secret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirect,
  });
  let tokenRes: Response;
  try {
    tokenRes = await fetch(opts.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
  } catch {
    throw oidcConnectFailed();
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new OAuthI18nError("OIDC 获取 Token 失败，请检查设置", "Failed to get token from OIDC, please check settings");
  }
  let userRes: Response;
  try {
    userRes = await fetch(opts.userInfoUrl, {
      headers: { authorization: `Bearer ${tokenJson.access_token}` },
    });
  } catch {
    throw oidcConnectFailed();
  }
  if (userRes.status !== 200) {
    throw new OAuthI18nError("获取用户信息失败", "Failed to get user information");
  }
  const u = (await userRes.json()) as {
    sub?: string;
    preferred_username?: string;
    name?: string;
    email?: string;
  };
  if (!u.sub || !u.email) {
    throw new OAuthI18nError("OIDC 获取用户信息为空，请检查设置", "OIDC returned empty user info, please check settings");
  }
  return {
    id: u.sub,
    username: u.preferred_username || "",
    display_name: u.name || "",
    email: u.email,
    field: "oidc_id",
  };
}

export { exchangeCustom, customOAuthRedirectUri } from "./custom-oauth.js";

function oauthLoginMethod(profile: OAuthProfile): string {
  return "oauth:" + (profile.slug || profile.field.replace(/_id$/, ""));
}

function oauthUsernamePrefix(profile: OAuthProfile): string {
  if (profile.slug) return `${profile.slug}_`;
  switch (profile.field) {
    case "github_id":
      return "github_";
    case "discord_id":
      return "discord_";
    case "linuxdo_id":
      return "linuxdo_";
    case "oidc_id":
      return "oidc_";
    case "wechat_id":
      return "wechat_";
    case "telegram_id":
      return "telegram_";
    default:
      return "oauth_";
  }
}

/** Original LinuxDO `FillUserByLinuxDOId` and custom `GetUserByOAuthBinding` return `gorm.ErrRecordNotFound`. */
function oauthFillReturnsRecordNotFound(profile: OAuthProfile): boolean {
  return profile.field === "linuxdo_id" || Boolean(profile.provider_id);
}

async function oauthIdTaken(store: Store, profile: OAuthProfile, providerUserId: string): Promise<boolean> {
  if (!providerUserId) return false;
  if (profile.provider_id) return store.oauthBindingTaken(profile.provider_id, providerUserId);
  // Original `IsOidcIdAlreadyTaken` is scoped; GitHub/Discord/LinuxDO/WeChat/Telegram are Unscoped.
  const includeDeleted = profile.field !== "oidc_id";
  return Boolean(await store.getUserByField(profile.field, providerUserId, { includeDeleted }));
}

async function fillLiveOAuthUser(store: Store, profile: OAuthProfile, providerUserId: string): Promise<UserRow | null> {
  if (profile.provider_id) return store.getUserByOAuthBinding(profile.provider_id, providerUserId);
  return store.getUserByField(profile.field, providerUserId);
}

/**
 * Original `controller.findOrCreateOAuthUser`.
 * Telegram never auto-registers. Soft-deleted GitHub/Discord/WeChat IDs return `oauth.user_deleted`
 * because Fill ignores `ErrRecordNotFound` and leaves `Id == 0`.
 */
async function findOrCreateOAuthUser(
  store: Store,
  req: Request,
  profile: OAuthProfile,
  affiliateCode: string,
): Promise<UserRow | Response> {
  if (profile.field === "telegram_id") {
    const user = await store.getUserByField("telegram_id", profile.id);
    if (!user) return writeSecurityOperationError("TELEGRAM_ACCOUNT_NOT_BOUND", ERR_TELEGRAM_ACCOUNT_NOT_BOUND);
    return user;
  }

  if (await oauthIdTaken(store, profile, profile.id)) {
    const user = await fillLiveOAuthUser(store, profile, profile.id);
    if (!user) {
      if (oauthFillReturnsRecordNotFound(profile)) return authUnauthorized();
      return apiErrorMsg(i18nPair(req, "用户已注销", "User has been deleted"));
    }
    return user;
  }

  const legacyId = profile.extra?.legacy_id || "";
  if (legacyId && (await oauthIdTaken(store, profile, legacyId))) {
    const user = await fillLiveOAuthUser(store, profile, legacyId);
    if (user) {
      if (profile.field === "github_id") {
        try {
          await store.updateUser(user.id, { github_id: profile.id });
        } catch {
          // Original continues login even if `UpdateGitHubId` fails.
        }
        return (await store.getUserById(user.id)) || user;
      }
      return user;
    }
  }

  if (!(await store.optionBool("RegisterEnabled", true))) {
    return apiErrorMsg(
      i18nPair(req, "管理员关闭了新用户注册", "New user registration has been disabled by administrator"),
    );
  }

  let username = oauthUsernamePrefix(profile) + String((await store.maxUserId()) + 1);
  if (profile.username) {
    const exists = await store.getUserByUsername(profile.username, { includeDeleted: true });
    if (!exists && profile.username.length <= USER_NAME_MAX_LENGTH) username = profile.username;
  }

  const providerName = await oauthProviderDisplayName(store, profile.slug || profile.field.replace(/_id$/, ""));
  const displayName = profile.display_name || profile.username || `${providerName} User`;

  let email = "";
  if (profile.email) {
    email = normalizeEmail(profile.email);
    if (email && (await store.getUserByEmail(email, { includeDeleted: true }))) {
      return apiErrorMsg(i18nPair(req, "邮箱地址已被占用", "Email address is already in use"));
    }
  }

  let inviterId = 0;
  if (affiliateCode) {
    const inviter = await store.getUserByAff(affiliateCode);
    inviterId = inviter?.id || 0;
  }

  const row: Partial<UserRow> = {
    username,
    display_name: displayName,
    email,
    role: ROLE_USER,
    status: USER_ENABLED,
    quota: await store.optionNum("QuotaForNewUser", 0),
    aff_code: generateAffCode(),
    inviter_id: inviterId,
  };
  if (!profile.provider_id) {
    (row as Record<string, unknown>)[profile.field] = profile.id;
  }
  const id = await store.insertUser(row);
  if (profile.provider_id) await store.upsertUserOAuthBinding(id, profile.provider_id, profile.id);
  await finishInsertUser(store, id, inviterId);
  const created = await store.getUserById(id);
  if (!created) return apiErrorMsg("用户不存在");
  return created;
}

export async function loginOrBindOAuth(
  store: Store,
  env: Env,
  req: Request,
  profile: OAuthProfile,
  existingUser: UserRow | null,
  intent = existingUser ? "bind" : "login",
  affiliateCode = "",
): Promise<Response> {
  if (intent === "bind") {
    if (!existingUser) return json(401, { success: false, message: "绑定操作需要登录" });
    if (profile.provider_id) {
      if (await store.oauthBindingTaken(profile.provider_id, profile.id, existingUser.id)) {
        return apiErrorMsg("该 OAuth 账号已被绑定");
      }
      await store.upsertUserOAuthBinding(existingUser.id, profile.provider_id, profile.id);
    } else {
      const taken = await store.getUserByField(profile.field, profile.id, { includeDeleted: true });
      if (taken && taken.id !== existingUser.id) return apiErrorMsg("该 OAuth 账号已被绑定");
      await store.updateUser(existingUser.id, { [profile.field]: profile.id });
    }
    const notification_warning = await notifyAccountSecurityChange(store, existingUser.email || "", "OAuth account linked");
    return apiOk({ action: "bind", notification_warning });
  }
  const user = await findOrCreateOAuthUser(store, req, profile, affiliateCode);
  if (user instanceof Response) return user;
  if (user.status !== USER_ENABLED) {
    return apiErrorMsg(i18nPair(req, "用户已被封禁", "User has been banned"));
  }
  return setupLogin(store, env, user, req, oauthLoginMethod(profile));
}

export function oauthAuthorizeUrl(provider: string, clientId: string, redirect: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", ...extra });
  if (provider === "github") {
    q.set("scope", "user:email");
    return `https://github.com/login/oauth/authorize?${q}`;
  }
  if (provider === "discord") {
    q.set("scope", "identify email");
    q.set("prompt", "consent");
    return `https://discord.com/api/oauth2/authorize?${q}`;
  }
  if (provider === "linuxdo") {
    q.set("scope", "user");
    return `https://connect.linux.do/oauth2/authorize?${q}`;
  }
  return "";
}

export function newAccessToken(): string {
  return generateTokenKey() + randomHex(8);
}

export async function wechatIdFromCode(store: Store, code: string): Promise<string> {
  if (!code) throw new Error("无效的参数");
  const addr = await store.option("WeChatServerAddress");
  const token = await store.option("WeChatServerToken");
  if (!addr) throw new Error("无效的参数");
  const res = await fetch(`${addr.replace(/\/$/, "")}/api/wechat/user?code=${encodeURIComponent(code)}`, {
    headers: { Authorization: token },
  });
  const json = (await res.json()) as { success?: boolean; message?: string; data?: string };
  if (!json.success) throw new Error(json.message || "");
  if (!json.data) throw new Error("验证码错误或已过期");
  return json.data;
}

export async function verifyTelegramLogin(store: Store, params: URLSearchParams): Promise<OAuthProfile> {
  const botToken = await store.option("TelegramBotToken");
  if (!botToken) throw new Error("Telegram 未配置");
  const hash = params.get("hash") || "";
  const pairs = [...params.entries()]
    .filter(([k]) => k !== "hash")
    .sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheck = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await sha256Bytes(botToken);
  const sig = await hmacSha256Hex(secret, dataCheck);
  if (!timingSafeEqualStr(sig.toLowerCase(), hash.toLowerCase())) throw new Error("Telegram 校验失败");
  const id = params.get("id") || "";
  if (!id) throw new Error("无效的 Telegram 授权");
  return {
    id,
    username: (params.get("username") || `tg_${id}`).slice(0, 20),
    display_name: params.get("first_name") || params.get("username") || id,
    field: "telegram_id",
  };
}

export function paymentDisabled(c: Context<Env>): Response {
  void c;
  return apiErrorMsg("支付方式未配置。请在系统设置中填写 Stripe / Epay / Creem / Waffo 密钥后启用在线充值。");
}

export function pluginDisabled(): Response {
  return apiErrorMsg("该能力需要对应配置；边缘运行时已提供等价接口，请检查插件是否已上传或部署密钥是否已设置");
}

export { apiOk };
