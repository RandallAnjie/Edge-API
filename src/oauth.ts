import { generateAffCode, generateTokenKey } from "./crypto.js";
import { nowSec, randomHex } from "./constants.js";
import { apiFail, apiOk } from "./http.js";
import { issueSession } from "./auth.js";
import type { Store } from "./store.js";
import type { Env, UserRow } from "./types.js";
import type { Context } from "./router.js";

export interface OAuthProfile {
  id: string;
  username: string;
  display_name: string;
  email?: string;
  field: "github_id" | "discord_id" | "linuxdo_id" | "oidc_id";
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
  };
}

export async function loginOrBindOAuth(
  store: Store,
  env: Env,
  req: Request,
  profile: OAuthProfile,
  existingUser: UserRow | null,
): Promise<Response> {
  if (existingUser) {
    await store.updateUser(existingUser.id, { [profile.field]: profile.id });
    const issued = await issueSession(store, env, existingUser, req);
    const origin = new URL(req.url).origin;
    const headers = new Headers({ location: origin + "/#/dashboard" });
    headers.append("set-cookie", issued.cookie);
    return new Response(null, { status: 302, headers });
  }
  let user = await store.getUserByField(profile.field, profile.id);
  if (!user) {
    const exists = await store.getUserByUsername(profile.username);
    const finalName = exists ? `${profile.field.slice(0, 2)}_${profile.id}`.slice(0, 20) : profile.username;
    const id = await store.insertUser({
      username: finalName,
      display_name: profile.display_name,
      email: profile.email || "",
      quota: await store.optionNum("QuotaForNewUser", 0),
      aff_code: generateAffCode(),
      [profile.field]: profile.id,
    } as Partial<UserRow>);
    if (profile.field !== "github_id") {
      await store.updateUser(id, { [profile.field]: profile.id });
    }
    user = await store.getUserById(id);
  }
  const issued = await issueSession(store, env, user!, req);
  const origin = new URL(req.url).origin;
  const headers = new Headers({ location: origin + "/#/dashboard" });
  headers.append("set-cookie", issued.cookie);
  return new Response(null, { status: 302, headers });
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

export function paymentDisabled(c: Context<Env>): Response {
  void c;
  return apiFail("支付收银台未在边缘运行时启用（Stripe / Epay / Creem / Waffo）。请使用兑换码或余额购买订阅。");
}

export function pluginDisabled(): Response {
  return apiFail("任务插件 / 性能诊断 / 部署集群不在 workerd 内运行");
}

export { apiOk };
