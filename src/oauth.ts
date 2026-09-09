import { generateAffCode, generateTokenKey } from "./crypto.js";
import { hmacSha256Hex, sha256Bytes, timingSafeEqualStr } from "./crypto.js";
import { nowSec, randomHex } from "./constants.js";
import { apiFail, apiOk, json } from "./http.js";
import { issueSessionSafe, sessionResponse } from "./auth.js";
import type { Store } from "./store.js";
import type { Env, UserRow } from "./types.js";
import type { Context } from "./router.js";

export interface OAuthProfile {
  id: string;
  username: string;
  display_name: string;
  email?: string;
  field: "github_id" | "discord_id" | "linuxdo_id" | "oidc_id" | "wechat_id" | "telegram_id";
  slug?: string;
  provider_id?: number;
}

export const BUILTIN_OAUTH = new Set(["github", "discord", "linuxdo", "oidc", "telegram"]);

export async function oauthProviderKnown(store: Store, name: string): Promise<boolean> {
  if (BUILTIN_OAUTH.has(name)) return true;
  const custom = await store.getOAuthProvider(name);
  return Boolean(custom);
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
  if (!tokenJson.access_token) throw new Error("GitHub 授权失败");
  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenJson.access_token}`, "user-agent": "edge-api" },
  });
  const gh = (await userRes.json()) as { id?: number; login?: string };
  if (!gh.id) throw new Error("无法读取 GitHub 用户");
  return { id: String(gh.id), username: gh.login || `gh_${gh.id}`, display_name: gh.login || `gh_${gh.id}`, field: "github_id" };
}

export async function exchangeDiscord(clientId: string, secret: string, code: string, redirect: string): Promise<OAuthProfile> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
  });
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("Discord 授权失败");
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const u = (await userRes.json()) as { id?: string; username?: string; global_name?: string; email?: string };
  if (!u.id) throw new Error("无法读取 Discord 用户");
  return {
    id: u.id,
    username: (u.username || `dc_${u.id}`).slice(0, 20),
    display_name: u.global_name || u.username || u.id,
    email: u.email,
    field: "discord_id",
  };
}

export async function exchangeLinuxDO(clientId: string, secret: string, code: string, redirect: string): Promise<OAuthProfile> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
  });
  const tokenRes = await fetch("https://connect.linux.do/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("LinuxDO 授权失败");
  const userRes = await fetch("https://connect.linux.do/api/user", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const u = (await userRes.json()) as { id?: number; username?: string; name?: string };
  if (!u.id) throw new Error("无法读取 LinuxDO 用户");
  return {
    id: String(u.id),
    username: (u.username || `ld_${u.id}`).slice(0, 20),
    display_name: u.name || u.username || String(u.id),
    field: "linuxdo_id",
  };
}

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
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirect,
  });
  const tokenRes = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("OIDC 授权失败");
  const userRes = await fetch(opts.userInfoUrl, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const u = (await userRes.json()) as { sub?: string; preferred_username?: string; name?: string; email?: string };
  if (!u.sub) throw new Error("无法读取 OIDC 用户");
  return {
    id: u.sub,
    username: (u.preferred_username || u.email || `oidc_${u.sub}`).slice(0, 20),
    display_name: u.name || u.preferred_username || u.sub,
    email: u.email,
    field: "oidc_id",
  };
}

export async function exchangeCustom(
  provider: Record<string, unknown>,
  code: string,
  redirect: string,
): Promise<OAuthProfile> {
  const body = new URLSearchParams({
    client_id: String(provider.client_id || ""),
    client_secret: String(provider.client_secret || ""),
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
  });
  const tokenRes = await fetch(String(provider.token_url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("OAuth 授权失败");
  const userRes = await fetch(String(provider.user_info_url), {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const u = (await userRes.json()) as Record<string, unknown>;
  const id = String(u.id || u.sub || u.user_id || "");
  if (!id) throw new Error("无法读取 OAuth 用户");
  return {
    id,
    username: String(u.username || u.login || u.preferred_username || `oauth_${id}`).slice(0, 20),
    display_name: String(u.name || u.display_name || u.username || id),
    email: typeof u.email === "string" ? u.email : undefined,
    field: "oidc_id",
    slug: String(provider.slug || ""),
    provider_id: Number(provider.id) || 0,
  };
}

export async function loginOrBindOAuth(
  store: Store,
  env: Env,
  req: Request,
  profile: OAuthProfile,
  existingUser: UserRow | null,
  intent = existingUser ? "bind" : "login",
): Promise<Response> {
  if (intent === "bind") {
    if (!existingUser) return json(401, { success: false, message: "绑定操作需要登录" });
    if (profile.provider_id) {
      if (await store.oauthBindingTaken(profile.provider_id, profile.id, existingUser.id)) {
        return apiFail("该 OAuth 账号已被绑定");
      }
      await store.upsertUserOAuthBinding(existingUser.id, profile.provider_id, profile.id);
    } else {
      const taken = await store.getUserByField(profile.field, profile.id);
      if (taken && taken.id !== existingUser.id) return apiFail("该 OAuth 账号已被绑定");
      await store.updateUser(existingUser.id, { [profile.field]: profile.id });
    }
    return apiOk({ action: "bind", notification_warning: false });
  }
  let user: UserRow | null = null;
  if (profile.provider_id) {
    user = await store.getUserByOAuthBinding(profile.provider_id, profile.id);
  } else {
    user = await store.getUserByField(profile.field, profile.id);
  }
  if (!user) {
    if (profile.field === "telegram_id") return apiFail("该 Telegram 账号尚未绑定");
    const exists = await store.getUserByUsername(profile.username);
    const finalName = exists ? `${profile.field.slice(0, 2)}_${profile.id}`.slice(0, 20) : profile.username;
    const id = await store.insertUser({
      username: finalName,
      display_name: profile.display_name,
      email: profile.email || "",
      quota: await store.optionNum("QuotaForNewUser", 0),
      aff_code: generateAffCode(),
      [profile.field]: profile.provider_id ? "" : profile.id,
    } as Partial<UserRow>);
    if (!profile.provider_id && profile.field !== "github_id") {
      await store.updateUser(id, { [profile.field]: profile.id });
    }
    if (profile.provider_id) await store.upsertUserOAuthBinding(id, profile.provider_id, profile.id);
    user = await store.getUserById(id);
  }
  const issued = await issueSessionSafe(store, env, user!, req, "oauth:" + (profile.slug || profile.field.replace(/_id$/, "")));
  if (issued instanceof Response) return issued;
  return sessionResponse(issued);
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
  const addr = await store.option("WeChatServerAddress");
  const token = await store.option("WeChatServerToken");
  if (!addr) throw new Error("管理员未开启通过微信登录以及注册");
  const res = await fetch(`${addr.replace(/\/$/, "")}/api/wechat/user?code=${encodeURIComponent(code)}`, {
    headers: { authorization: token },
  });
  const json = (await res.json()) as { success?: boolean; message?: string; data?: string };
  if (!json.success || !json.data) throw new Error(json.message || "验证码错误或已过期");
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
  return apiFail("支付方式未配置。请在系统设置中填写 Stripe / Epay / Creem / Waffo 密钥后启用在线充值。");
}

export function pluginDisabled(): Response {
  return apiFail("该能力需要对应配置；边缘运行时已提供等价接口，请检查插件是否已上传或部署密钥是否已设置");
}

export { apiOk };
