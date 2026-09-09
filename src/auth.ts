import {
  ACCESS_TOKEN_TTL_SEC,
  RATE_LIMIT_PER_MIN,
  ROLE_ADMIN,
  ROLE_ROOT,
  SESSION_TTL_SEC,
  TOKEN_DISABLED,
  TOKEN_ENABLED,
  USER_ENABLED,
  USER_SESSION_ACTIVE_LIMIT,
  USER_SESSION_ISSUANCE_LIMIT,
  USER_SESSION_ISSUANCE_WINDOW_SEC,
  csv,
  nowSec,
} from "./constants.js";
import { canWithPolicies, capabilitiesFromStore, roleKeyForSystemRole, roleSubject, userSubject } from "./authz.js";
import {
  deriveNextRefreshSecret,
  extractRequestApiKey,
  parseApiKey,
  hashRefreshSecret,
  randomCharsKey,
  signAccessJwt,
  splitRefreshToken,
  verifyAccessJwt,
  verifySession,
} from "./crypto.js";
import {
  apiFail,
  apiOk,
  clientIp,
  cookieGet,
  isSecureRequest,
  json,
  refreshCookie,
  sessionCookie,
  sessionHintCookie,
  openaiError,
} from "./http.js";
import { ipAllowed } from "./select.js";
import { Store, permissionsFor, publicUser } from "./store.js";
import type { AuthToken, Env, LoginSessionRow, SessionUser, TokenRow, UserRow } from "./types.js";
import type { Context } from "./router.js";
import { requireSecurityProof, type AuthIdentity, type VerificationOperation } from "./security.js";

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

function sessionView(
  sess: {
    sid: string;
    login_method?: string;
    ip: string;
    ua: string;
    created_at: number;
    last_seen: number;
    expires_at: number;
  },
  current: boolean,
  fallback?: { ip: string; ua: string; method: string },
) {
  return {
    sid: sess.sid,
    current,
    login_method: sess.login_method || fallback?.method || "password",
    ip: sess.ip || fallback?.ip || "",
    user_agent: sess.ua || fallback?.ua || "",
    created_at: Number(sess.created_at),
    last_active_at: Number(sess.last_seen) || nowSec(),
    expires_at: Number(sess.expires_at),
  };
}

async function bundleFor(
  store: Store,
  env: Env,
  user: UserRow,
  sess: LoginSessionRow,
  refreshRaw: string,
  req: Request,
): Promise<{
  token: string;
  cookie: string;
  cookies: string[];
  data: Record<string, unknown>;
  sid: string;
}> {
  const secret = await sessionSecret(env, store);
  const now = nowSec();
  const accessExp = now + ACCESS_TOKEN_TTL_SEC;
  const token = await signAccessJwt(
    secret,
    {
      userId: user.id,
      sid: sess.sid,
      userAuthVersion: Number(sess.user_auth_version || user.auth_version || 1),
      sessionVersion: Number(sess.version || 1),
    },
    now,
    accessExp,
  );
  const secure = isSecureRequest(req);
  const maxAge = Math.max(Number(sess.expires_at) - now, 1);
  const cookie = sessionCookie(token, ACCESS_TOKEN_TTL_SEC, secure);
  const cookies = [cookie, sessionHintCookie(maxAge, secure)];
  if (refreshRaw) cookies.splice(1, 0, refreshCookie(refreshRaw, maxAge, secure));
  const data = {
    access_token: token,
    token_type: "Bearer",
    access_expires_at: accessExp,
    session: sessionView(sess, true),
    user: await publicSelf(store, user),
  };
  return { token, cookie, cookies, data, sid: sess.sid };
}

export async function issueSession(
  store: Store,
  env: Env,
  user: UserRow,
  req: Request,
  loginMethod = "password",
  existingSid?: string,
): Promise<{
  token: string;
  cookie: string;
  cookies: string[];
  data: Record<string, unknown>;
  sid: string;
}> {
  const secret = await sessionSecret(env, store);
  const existing = existingSid ? await store.getSession(existingSid) : null;
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "").slice(0, 64);
  const ua = (req.headers.get("user-agent") || "").slice(0, 512);
  const exp = nowSec() + SESSION_TTL_SEC;
  const authVersion = Number(user.auth_version || 1) || 1;

  if (existing && !existing.revoked) {
    await store.extendSession(existing.sid, exp, ip, ua);
    const sess = (await store.getSession(existing.sid))!;
    const keep = cookieGet(req, "new_api_refresh") || "";
    const parsed = splitRefreshToken(keep);
    const refreshValue = parsed?.sid === sess.sid ? keep : "";
    return bundleFor(store, env, user, sess, refreshValue, req);
  }

  const active = await store.countActiveSessions(user.id);
  if (active >= USER_SESSION_ACTIVE_LIMIT) {
    throw Object.assign(new Error("AUTH_SESSION_LIMIT"), { code: "AUTH_SESSION_LIMIT" });
  }
  const issuedRecent = await store.countSessionsCreatedSince(user.id, nowSec() - USER_SESSION_ISSUANCE_WINDOW_SEC);
  if (issuedRecent >= USER_SESSION_ISSUANCE_LIMIT) {
    throw Object.assign(new Error("AUTH_SESSION_ISSUANCE_LIMIT"), { code: "AUTH_SESSION_ISSUANCE_LIMIT" });
  }

  const sid = crypto.randomUUID();
  const refreshSecret = randomCharsKey(64);
  const refreshHash = await hashRefreshSecret(secret, refreshSecret);
  await store.insertSession({
    sid,
    user_id: user.id,
    ip,
    ua,
    expires_at: exp,
    login_method: loginMethod,
    refresh_hash: refreshHash,
    version: 1,
    user_auth_version: authVersion,
  });
  await store.updateUser(user.id, { last_login_at: nowSec() });
  const sess = (await store.getSession(sid))!;
  return bundleFor(store, env, user, sess, `${sid}.${refreshSecret}`, req);
}

export function authUnauthorized(): Response {
  return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized", data: null });
}

export function authSessionMismatch(): Response {
  return json(409, { success: false, code: "AUTH_SESSION_MISMATCH", message: "Conflict", data: null });
}

export function authRefreshRace(): Response {
  return json(409, { success: false, code: "AUTH_REFRESH_RACE", message: "Conflict", data: null });
}

export function authSessionLimit(): Response {
  return json(409, { success: false, code: "AUTH_SESSION_LIMIT", message: "Conflict", data: null });
}

export function authSessionIssuanceLimit(): Response {
  return json(429, { success: false, code: "AUTH_SESSION_ISSUANCE_LIMIT", message: "Too Many Requests", data: null });
}

export function sessionResponse(issued: { data: Record<string, unknown>; cookies: string[] }, status = 200, message = ""): Response {
  const res = apiOk(issued.data, message);
  const headers = new Headers(res.headers);
  for (const c of issued.cookies) headers.append("set-cookie", c);
  return new Response(res.body, { status, headers });
}

export async function refreshLoginSession(
  store: Store,
  env: Env,
  req: Request,
  expectedSid: string,
): Promise<
  | { ok: true; issued: Awaited<ReturnType<typeof issueSession>> }
  | { ok: false; response: Response }
> {
  const raw = cookieGet(req, "new_api_refresh") || "";
  const parsed = splitRefreshToken(raw);
  if (!parsed) return { ok: false, response: authUnauthorized() };
  if (expectedSid && expectedSid !== parsed.sid) return { ok: false, response: authSessionMismatch() };

  const secret = await sessionSecret(env, store);
  const sess = await store.getSession(parsed.sid);
  if (!sess || sess.revoked || (sess.expires_at > 0 && sess.expires_at < nowSec())) {
    return { ok: false, response: json(401, { success: false, code: "AUTH_SESSION_REVOKED", message: "Unauthorized", data: null }) };
  }
  const user = await store.getUserById(sess.user_id);
  if (!user || user.status !== USER_ENABLED) return { ok: false, response: authUnauthorized() };
  const authVersion = Number(user.auth_version || 1) || 1;
  if (Number(sess.user_auth_version || 1) !== authVersion) {
    await store.revokeSession(sess.sid, user.id);
    return { ok: false, response: json(401, { success: false, code: "AUTH_SESSION_REVOKED", message: "Unauthorized", data: null }) };
  }

  const currentHash = await hashRefreshSecret(secret, parsed.secret);
  const nextSecret = await deriveNextRefreshSecret(secret, parsed.sid, parsed.secret);
  const nextHash = await hashRefreshSecret(secret, nextSecret);
  const now = nowSec();
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "").slice(0, 64);
  const ua = (req.headers.get("user-agent") || "").slice(0, 512);

  if (sess.refresh_hash && sess.refresh_hash === nextHash) {
    const age = now - Number(sess.last_rotated_at || 0);
    if (age <= 30) {
      const rotated = (await store.getSession(sess.sid))!;
      return { ok: true, issued: await bundleFor(store, env, user, rotated, `${parsed.sid}.${nextSecret}`, req) };
    }
    return { ok: false, response: authRefreshRace() };
  }
  if (sess.refresh_hash && sess.refresh_hash !== currentHash) {
    if (sess.last_refresh_hash === currentHash) {
      await store.revokeSession(sess.sid, user.id);
      return { ok: false, response: json(401, { success: false, code: "AUTH_SESSION_REVOKED", message: "Unauthorized", data: null }) };
    }
    return { ok: false, response: authUnauthorized() };
  }

  const rotated = await store.rotateSessionRefresh(sess.sid, currentHash, nextHash, now, ip, ua);
  if (!rotated) return { ok: false, response: authRefreshRace() };
  return { ok: true, issued: await bundleFor(store, env, user, rotated, `${parsed.sid}.${nextSecret}`, req) };
}

async function sessionUserFromAccess(store: Store, secret: string, raw: string, req?: Request): Promise<SessionUser | null> {
  const jwt = await verifyAccessJwt(raw, secret);
  if (jwt) {
    const sess = await store.getSession(jwt.sid);
    if (!sess || sess.revoked || (sess.expires_at > 0 && sess.expires_at < nowSec())) return null;
    if (Number(sess.version || 1) !== jwt.sv) return null;
    const user = await store.getUserById(Number(jwt.sub));
    if (!user || user.status !== USER_ENABLED) return null;
    if (Number(user.auth_version || 1) !== jwt.uv) return null;
    await store.touchSession(jwt.sid);
    return toSessionUser(user, jwt.sid, jwt.uv, jwt.sv);
  }
  if (splitRefreshToken(raw)) return null;
  if (raw.split(".").length === 2) {
    const payload = await verifySession(raw, secret);
    if (!payload) return null;
    const sess = payload.sid ? await store.getSession(payload.sid) : null;
    if (payload.sid && (!sess || sess.revoked || (sess.expires_at > 0 && sess.expires_at < nowSec()))) return null;
    const user = await store.getUserById(payload.uid);
    if (!user || user.status !== USER_ENABLED) return null;
    if (payload.sid) await store.touchSession(payload.sid);
    return toSessionUser(user, payload.sid || "", Number(user.auth_version || 1) || 1, Number(sess?.version || 1) || 1);
  }
  const user = await store.getUserByField("access_token", raw);
  if (!user || user.status !== USER_ENABLED) return null;
  if (req) await beginAccessTokenAudit(store, req, user, raw);
  return toSessionUser(user, "");
}

function toSessionUser(user: UserRow, sid: string, uv = 0, sv = 0): SessionUser {
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
    userAuthVersion: uv || Number(user.auth_version || 1) || 1,
    sessionVersion: sv || 1,
  };
}

function bearerCredential(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const raw = auth.slice(7).trim();
    if (raw && !raw.toLowerCase().startsWith("sk-")) return raw;
  }
  return "";
}

export async function readSession(c: Context<Env>, store: Store): Promise<SessionUser | null> {
  const secret = await sessionSecret(c.env, store);
  const bearer = bearerCredential(c.req);
  const cookieTok = cookieGet(c.req, "session") || "";
  const raw = bearer || cookieTok;
  if (!raw) return null;
  return sessionUserFromAccess(store, secret, raw, c.req);
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

export async function publicSelf(store: Store, user: UserRow): Promise<Record<string, unknown>> {
  const permissions = permissionsFor(user);
  permissions.admin_permissions = await capabilitiesFromStore(store, user);
  return { ...publicUser(user), permissions };
}

type PendingAccessAudit = {
  userId: number;
  username: string;
  actorRole: number;
  tokenRef: string;
  ip: string;
  userAgent: string;
  method: string;
  route: string;
};

const pendingAccessAudits = new WeakMap<Request, PendingAccessAudit>();

export async function beginAccessTokenAudit(store: Store, req: Request, user: UserRow, token: string): Promise<void> {
  if (pendingAccessAudits.has(req)) return;
  const { accessTokenFingerprint } = await import("./crypto.js");
  const url = new URL(req.url);
  pendingAccessAudits.set(req, {
    userId: user.id,
    username: user.username,
    actorRole: user.role,
    tokenRef: await accessTokenFingerprint(token),
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") || "",
    method: req.method,
    route: url.pathname,
  });
}

export async function maybeBeginAccessTokenAudit(store: Store, req: Request, secret: string): Promise<void> {
  const raw = bearerCredential(req);
  if (!raw) return;
  if (await verifyAccessJwt(raw, secret)) return;
  if (splitRefreshToken(raw)) return;
  if (raw.split(".").length === 2 && (await verifySession(raw, secret))) return;
  const user = await store.getUserByField("access_token", raw);
  if (!user || user.status !== USER_ENABLED) return;
  await beginAccessTokenAudit(store, req, user, raw);
}

export async function finishAccessTokenAudit(store: Store, req: Request, res: Response): Promise<void> {
  const pending = pendingAccessAudits.get(req);
  if (!pending) return;
  pendingAccessAudits.delete(req);
  let success = res.status < 400;
  const ct = res.headers.get("content-type") || "";
  if (success && ct.includes("json")) {
    try {
      const body = (await res.clone().json()) as { success?: boolean };
      if (typeof body.success === "boolean") success = body.success && res.status < 400;
    } catch {
      /* body was not JSON */
    }
  }
  await store.audit(pending.userId, pending.username, "access_token", pending.route, pending.ip, {
    actor_role: pending.actorRole,
    category: "access_token",
    action: pending.route,
    token_ref: pending.tokenRef,
    auth_method: "access_token",
    user_agent: pending.userAgent,
    method: pending.method,
    route: pending.route,
    status: res.status,
    success,
  });
}

export async function requirePermission(
  c: Context<Env>,
  store: Store,
  resource: string,
  action: string,
): Promise<SessionUser | Response> {
  const u = await requireAdmin(c, store);
  if (u instanceof Response) return u;
  const user = await store.getUserById(u.id);
  if (!user) return json(403, { success: false, message: "无权进行此操作，权限不足" });
  const roleKey = roleKeyForSystemRole(user.role);
  const userPolicies = await store.casbinPolicies(userSubject(user.id));
  const rolePolicies = roleKey ? await store.casbinPolicies(roleSubject(roleKey)) : [];
  if (!canWithPolicies(user, resource, action, userPolicies, rolePolicies)) {
    return json(403, { success: false, message: "无权进行此操作，权限不足" });
  }
  return u;
}

export async function requireChannel(
  c: Context<Env>,
  store: Store,
  action: "read" | "operate" | "write" | "sensitive_write" | "secret_view",
): Promise<SessionUser | Response> {
  return requirePermission(c, store, "channel", action);
}

export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

function tokenAuthReadOnlyMessage(req: Request, zh: string, en: string): string {
  const lang = (req.headers.get("accept-language") || "").toLowerCase();
  if (lang.startsWith("zh")) return zh;
  return en;
}

/** Original `middleware.TokenAuthReadOnly` — gin JSON, not OpenAI errors. */
export async function authenticateTokenReadOnly(
  c: Context<Env>,
  store: Store,
): Promise<{ token: TokenRow; user: UserRow } | Response> {
  const header = c.req.headers.get("authorization") || "";
  if (!header) {
    return json(401, { success: false, message: tokenAuthReadOnlyMessage(c.req, "未提供令牌", "Token not provided") });
  }
  const key = parseApiKey(header);
  const token = await store.getTokenByKey(key);
  if (!token) {
    return json(401, { success: false, message: tokenAuthReadOnlyMessage(c.req, "无效的令牌", "Invalid token") });
  }
  if (token.status === TOKEN_DISABLED) {
    return json(401, { success: false, message: tokenAuthReadOnlyMessage(c.req, "该令牌状态不可用", "This token status is unavailable") });
  }
  const user = await store.getUserById(token.user_id);
  if (!user) {
    return json(500, { success: false, message: tokenAuthReadOnlyMessage(c.req, "数据库错误", "Database error") });
  }
  if (user.status !== USER_ENABLED) {
    return json(403, { success: false, message: tokenAuthReadOnlyMessage(c.req, "用户已被封禁", "User has been banned") });
  }
  return { token, user };
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
  const u = await readSession(c, store);
  if (u?.sid) return u.sid;
  const parsed = splitRefreshToken(cookieGet(c.req, "new_api_refresh") || "");
  return parsed?.sid || "";
}

export async function dashboardIdentity(c: Context<Env>, store: Store): Promise<AuthIdentity | null> {
  const u = await readSession(c, store);
  if (!u?.sid || !u.userAuthVersion || !u.sessionVersion) return null;
  return {
    userId: u.id,
    sessionId: u.sid,
    userAuthVersion: u.userAuthVersion,
    sessionVersion: u.sessionVersion,
  };
}

export async function requireProof(
  c: Context<Env>,
  store: Store,
  operation: VerificationOperation,
): Promise<AuthIdentity | Response> {
  const identity = await dashboardIdentity(c, store);
  const user = identity ? await store.getUserById(identity.userId) : null;
  const secret = await sessionSecret(c.env, store);
  return requireSecurityProof(c, store, secret, identity, user, operation);
}

export async function issueSessionSafe(
  store: Store,
  env: Env,
  user: UserRow,
  req: Request,
  loginMethod = "password",
  existingSid?: string,
): Promise<Awaited<ReturnType<typeof issueSession>> | Response> {
  try {
    return await issueSession(store, env, user, req, loginMethod, existingSid);
  } catch (e) {
    const code = e instanceof Error ? (e as Error & { code?: string }).code : "";
    if (code === "AUTH_SESSION_LIMIT") return authSessionLimit();
    if (code === "AUTH_SESSION_ISSUANCE_LIMIT") return authSessionIssuanceLimit();
    throw e;
  }
}
