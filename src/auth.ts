import {
  RATE_LIMIT_PER_MIN,
  ROLE_ADMIN,
  ROLE_ROOT,
  SESSION_TTL_SEC,
  TOKEN_ENABLED,
  USER_ENABLED,
  csv,
  nowSec,
} from "./constants.js";
import { extractRequestApiKey, signSession, verifySession } from "./crypto.js";
import { apiFail, cookieGet, isSecureRequest, openaiError, sessionCookie } from "./http.js";
import { ipAllowed } from "./select.js";
import { Store, permissionsFor, publicUser } from "./store.js";
import type { AuthToken, Env, SessionUser, TokenRow, UserRow } from "./types.js";
import type { Context } from "./router.js";

export async function sessionSecret(env: Env, store: Store): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let s = await store.option("SessionSecret");
  if (!s) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    s = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
    await store.setOption("SessionSecret", s);
  }
  return s;
}

export async function issueSession(store: Store, env: Env, user: UserRow, req: Request): Promise<{
  token: string;
  cookie: string;
  data: Record<string, unknown>;
}> {
  const secret = await sessionSecret(env, store);
  const token = await signSession(
    { uid: user.id, role: user.role, username: user.username, exp: nowSec() + SESSION_TTL_SEC },
    secret,
  );
  await store.updateUser(user.id, { last_login_at: nowSec() });
  const cookie = sessionCookie(token, SESSION_TTL_SEC, isSecureRequest(req));
  const data = {
    access_token: token,
    token_type: "Bearer",
    user: { ...publicUser(user), permissions: permissionsFor(user.role) },
  };
  return { token, cookie, data };
}

export async function readSession(c: Context<Env>, store: Store): Promise<SessionUser | null> {
  const secret = await sessionSecret(c.env, store);
  let raw = cookieGet(c.req, "session");
  const auth = c.req.headers.get("authorization") || "";
  if (!raw && auth.toLowerCase().startsWith("bearer ") && !auth.slice(7).trim().startsWith("sk-")) {
    raw = auth.slice(7).trim();
  }
  if (!raw) return null;
  const payload = await verifySession(raw, secret);
  if (!payload) return null;
  const user = await store.getUserById(payload.uid);
  if (!user || user.status !== USER_ENABLED) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    group: user.group,
    quota: user.quota,
    used_quota: user.used_quota,
    request_count: user.request_count,
    email: user.email,
  };
}

export async function requireUser(c: Context<Env>, store: Store): Promise<SessionUser | Response> {
  const u = await readSession(c, store);
  if (!u) return apiFail("未登录", null, 401);
  return u;
}

export async function requireAdmin(c: Context<Env>, store: Store): Promise<SessionUser | Response> {
  const u = await requireUser(c, store);
  if (u instanceof Response) return u;
  if (u.role < ROLE_ADMIN) return apiFail("无权访问", null, 403);
  return u;
}

export async function requireRoot(c: Context<Env>, store: Store): Promise<SessionUser | Response> {
  const u = await requireUser(c, store);
  if (u instanceof Response) return u;
  if (u.role < ROLE_ROOT) return apiFail("需要超级管理员", null, 403);
  return u;
}

export function isResponse(v: SessionUser | Response): v is Response {
  return v instanceof Response;
}

export async function authenticateApiToken(c: Context<Env>, store: Store): Promise<AuthToken | Response> {
  const key = extractRequestApiKey(c.req, c.url);
  if (!key) return openaiError(401, "未提供令牌", "invalid_api_key");
  const token = await store.getTokenByKey(key);
  if (!token) return openaiError(401, "令牌无效", "invalid_api_key");
  if (token.status !== TOKEN_ENABLED) return openaiError(403, "令牌已禁用", "token_disabled");
  if (token.expired_time > 0 && token.expired_time < nowSec()) {
    return openaiError(403, "令牌已过期", "token_expired");
  }
  const user = await store.getUserById(token.user_id);
  if (!user || user.status !== USER_ENABLED) return openaiError(403, "用户已被封禁", "user_disabled");
  const ip = c.req.headers.get("cf-connecting-ip") || c.req.headers.get("x-real-ip") || "";
  if (!ipAllowed(token.allow_ips, ip)) return openaiError(403, "您的 IP 不在令牌允许访问的列表中", "access_denied");
  const usingGroup = token.group || user.group || "default";
  return { token, user, usingGroup };
}

export function tokenAllowsModel(token: TokenRow, model: string): boolean {
  if (!token.model_limits_enabled) return true;
  const allowed = csv(token.model_limits);
  if (allowed.length === 0) return true;
  return allowed.includes(model);
}

export async function rateLimit(env: Env, tokenId: number): Promise<boolean> {
  if (!env.KV) return true;
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${tokenId}:${minute}`;
  const cur = Number((await env.KV.get(key)) || "0");
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await env.KV.put(key, String(cur + 1), { expirationTtl: 120 });
  return true;
}
