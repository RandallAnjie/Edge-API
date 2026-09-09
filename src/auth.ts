import {
  RATE_LIMIT_PER_MIN,
  ROLE_ADMIN,
  ROLE_ROOT,
  SESSION_TTL_SEC,
  TOKEN_ENABLED,
  USER_ENABLED,
  csv,
  nowSec,
  randomHex,
} from "./constants.js";
import { extractRequestApiKey, signSession, verifySession } from "./crypto.js";
import { apiFail, apiOk, cookieGet, isSecureRequest, sessionCookie, sessionHintCookie, openaiError } from "./http.js";
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

export async function issueSession(
  store: Store,
  env: Env,
  user: UserRow,
  req: Request,
  loginMethod = "password",
): Promise<{
  token: string;
  cookie: string;
  cookies: string[];
  data: Record<string, unknown>;
  sid: string;
}> {
  const secret = await sessionSecret(env, store);
  const sid = randomHex(16);
  const exp = nowSec() + SESSION_TTL_SEC;
  const token = await signSession(
    { uid: user.id, role: user.role, username: user.username, exp, sid },
    secret,
  );
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  const ua = (req.headers.get("user-agent") || "").slice(0, 200);
  const created = nowSec();
  await store.insertSession({
    sid,
    user_id: user.id,
    ip,
    ua,
    expires_at: exp,
    login_method: loginMethod,
  });
  await store.updateUser(user.id, { last_login_at: created });
  const secure = isSecureRequest(req);
  const cookie = sessionCookie(token, SESSION_TTL_SEC, secure);
  const cookies = [
    cookie,
    sessionCookie(token, SESSION_TTL_SEC, secure, "new_api_refresh"),
    sessionHintCookie(SESSION_TTL_SEC, secure),
  ];
  const session = {
    sid,
    current: true,
    login_method: loginMethod,
    ip,
    user_agent: ua,
    created_at: created,
    last_active_at: created,
    expires_at: exp,
  };
  const data = {
    access_token: token,
    token_type: "Bearer",
    access_expires_at: exp,
    session,
    user: { ...publicUser(user), permissions: permissionsFor(user.role) },
  };
  return { token, cookie, cookies, data, sid };
}

export function sessionResponse(issued: { data: Record<string, unknown>; cookies: string[] }, status = 200): Response {
  const res = apiOk(issued.data);
  const headers = new Headers(res.headers);
  for (const c of issued.cookies) headers.append("set-cookie", c);
  return new Response(res.body, { status, headers });
}

export async function readSession(c: Context<Env>, store: Store): Promise<SessionUser | null> {
  const secret = await sessionSecret(c.env, store);
  let raw = cookieGet(c.req, "session") || cookieGet(c.req, "new_api_refresh");
  const auth = c.req.headers.get("authorization") || "";
  if (!raw && auth.toLowerCase().startsWith("bearer ") && !auth.slice(7).trim().startsWith("sk-")) {
    raw = auth.slice(7).trim();
  }
  if (!raw) return null;

  let user: UserRow | null = null;
  let sid = "";

  if (raw.includes(".")) {
    const payload = await verifySession(raw, secret);
    if (!payload) return null;
    if (payload.sid) {
      const sess = await store.getSession(payload.sid);
      if (!sess || sess.revoked || (sess.expires_at > 0 && sess.expires_at < nowSec())) return null;
      sid = payload.sid;
      await store.touchSession(sid);
    }
    user = await store.getUserById(payload.uid);
  } else {
    user = await store.getUserByField("access_token", raw);
  }

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
    sid,
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

export async function currentSid(c: Context<Env>, store: Store): Promise<string> {
  const secret = await sessionSecret(c.env, store);
  let raw = cookieGet(c.req, "session") || cookieGet(c.req, "new_api_refresh");
  const auth = c.req.headers.get("authorization") || "";
  if (!raw && auth.toLowerCase().startsWith("bearer ") && !auth.slice(7).trim().startsWith("sk-")) {
    raw = auth.slice(7).trim();
  }
  if (!raw || !raw.includes(".")) return "";
  const payload = await verifySession(raw, secret);
  return payload?.sid || "";
}
