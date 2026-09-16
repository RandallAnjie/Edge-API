import {
  ACCESS_TOKEN_TTL_SEC,
  ROLE_ADMIN,
  ROLE_ROOT,
  SESSION_TTL_SEC,
  TOKEN_DISABLED,
  TOKEN_ENABLED,
  USER_ENABLED,
  USER_SESSION_ACTIVE_LIMIT,
  USER_SESSION_ISSUANCE_LIMIT,
  USER_SESSION_ISSUANCE_WINDOW_SEC,
  nowSec,
  randomHex,
  tokenModelLimitsMap,
} from "./constants.js";
import { canWithPolicies, capabilitiesFromStore, roleKeyForSystemRole, roleSubject, userSubject } from "./authz.js";
import {
  deriveNextRefreshSecret,
  extractRequestApiKeyParts,
  parseApiKey,
  hashRefreshSecret,
  accessTokenFingerprint,
  parseAccessJwt,
  peekDashboardJwt,
  randomCharsKey,
  signAccessJwt,
  splitRefreshToken,
  verifyAccessJwt,
  verifySession,
} from "./crypto.js";
import {
  abortWithOpenAiMessage,
  apiErrorMsg,
  apiFail,
  apiFailCode,
  apiOk,
  authInsufficientPrivilegeMessage,
  clearAuthCookies,
  clientIp,
  cookieGet,
  databaseErrorMessage,
  isSecureRequest,
  json,
  readJson,
  refreshCookie,
  sessionHintCookie,
  withSetCookies,
  writeAuthSessionError,
  invalidChannelIdMessage,
  rememberRequestUserLanguageFromUser,
  tokenInvalidMessage,
  tokenNotProvidedMessage,
  tokenStatusUnavailableMessage,
  userBannedMessage,
  SPECIFIC_CHANNEL_VERSION,
} from "./http.js";
import { twoFAVerificationOption, verifyTwoFactorCode } from "./totp.js";
import { isIpInCIDRList, parseIP, tokenIpLimits } from "./select.js";
import { Store, permissionsFor, publicUser } from "./store.js";
import { containsGroupRatio, userUsableGroups } from "./dto.js";
import { tokenModelLimitAllows } from "./ratio-setting.js";
import type { AuthToken, Env, LoginSessionRow, SessionUser, TokenRow, UserRow } from "./types.js";
import { ginFullPath, type Context } from "./router.js";
import { requireSecurityProof, type AuthIdentity, type VerificationOperation } from "./security.js";
import { beginAdminAudit, recordLoginAudit } from "./admin-operation-audit.js";
import { requestIdFor } from "./request-id.js";
import {
  TOKEN_OPERATION_AUDIT_MAX_BODY,
  auditActorRole,
  auditResponseSuccess,
  truncateAuditUserAgent,
} from "./token-operation-audit.js";

/** Original `model.AuditCategoryAccessToken`. */
export const AUDIT_CATEGORY_ACCESS_TOKEN = "access_token";

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

/** Original `common.CryptoSecret` (`CRYPTO_SECRET` else `SessionSecret`). */
export async function cryptoSecret(env: Env, store: Store): Promise<string> {
  const raw = env.CRYPTO_SECRET;
  if (raw != null && raw !== "") return raw;
  return sessionSecret(env, store);
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
  const expiresAt = Number(sess.expires_at);
  const maxAge = Math.max(expiresAt - now, 1);
  const cookies: string[] = [];
  if (refreshRaw) cookies.push(refreshCookie(refreshRaw, maxAge, secure, expiresAt));
  cookies.push(sessionHintCookie(maxAge, secure, expiresAt));
  const data = {
    access_token: token,
    token_type: "Bearer",
    access_expires_at: accessExp,
    session: sessionView(sess, true),
    user: await publicSelf(store, user),
  };
  return { token, cookie: cookies[0] || "", cookies, data, sid: sess.sid };
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
  return writeAuthSessionError(401, "AUTH_UNAUTHORIZED");
}

export function authTokenExpired(): Response {
  return writeAuthSessionError(401, "AUTH_TOKEN_EXPIRED");
}

export function authSessionRevoked(): Response {
  return writeAuthSessionError(401, "AUTH_SESSION_REVOKED");
}

export function authUserDisabled(): Response {
  return writeAuthSessionError(401, "AUTH_USER_DISABLED");
}

export function authSessionMismatch(): Response {
  return writeAuthSessionError(409, "AUTH_SESSION_MISMATCH");
}

export function authRefreshRace(): Response {
  return writeAuthSessionError(409, "AUTH_REFRESH_RACE");
}

export function authSessionLimit(): Response {
  return writeAuthSessionError(409, "AUTH_SESSION_LIMIT");
}

export function authSessionIssuanceLimit(): Response {
  return writeAuthSessionError(429, "AUTH_SESSION_ISSUANCE_LIMIT");
}

/** Original `controller.dashboardBearer`. */
function dashboardBearer(req: Request): string {
  const parts = (req.headers.get("authorization") || "").trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || !parts[1]) return "";
  return parts[1];
}

/** Original `controller.AuthLogout` JSON + ClearRefreshCookie. */
export async function authLogout(store: Store, env: Env, req: Request): Promise<Response> {
  const expectedSID = (req.headers.get("X-Auth-Session") || "").trim();
  const rawRefresh = cookieGet(req, "new_api_refresh") || "";
  const parsed = splitRefreshToken(rawRefresh);
  const cookieSID = parsed?.sid || "";
  const hasCookieSID = Boolean(cookieSID);
  const secure = isSecureRequest(req);
  const cleared = clearAuthCookies(secure);

  if (expectedSID && rawRefresh && hasCookieSID && cookieSID !== expectedSID) {
    return authSessionMismatch();
  }

  const bearer = dashboardBearer(req);
  if (bearer) {
    const jwt = await verifyAccessJwt(bearer, await sessionSecret(env, store));
    if (jwt) {
      const sessionId = jwt.sid;
      const userId = Number(jwt.sub);
      if (expectedSID && expectedSID !== sessionId) return authSessionMismatch();
      await store.revokeSession(sessionId, userId);
      let cookieCleared = false;
      let cookies: string[] = [];
      if (rawRefresh && hasCookieSID && cookieSID === sessionId) {
        await store.revokeSession(cookieSID, userId);
        cookieCleared = true;
        cookies = cleared;
      }
      return withSetCookies(
        json(200, {
          success: true,
          message: "",
          data: { revoked_sid: sessionId, cookie_cleared: cookieCleared },
        }),
        cookies,
      );
    }
  }

  if (!rawRefresh) {
    return withSetCookies(json(200, { success: true, message: "" }), cleared);
  }
  if (expectedSID && expectedSID !== cookieSID) return authSessionMismatch();
  if (parsed) await store.revokeSession(parsed.sid);
  return withSetCookies(json(200, { success: true, message: "" }), cleared);
}

export function maybeClearRefreshCookie(req: Request, res: Response): Response {
  if (res.status !== 401) return res;
  return withSetCookies(res, clearAuthCookies(isSecureRequest(req)));
}

export function sessionResponse(issued: { data: Record<string, unknown>; cookies: string[] }, status = 200, message = ""): Response {
  return withSetCookies(apiOk(issued.data, message), issued.cookies);
}

/** Original `controller.authRotationData` — omits `user`. */
export function authRotationData(issued: { data: Record<string, unknown> }): Record<string, unknown> {
  return {
    access_token: issued.data.access_token,
    token_type: issued.data.token_type,
    access_expires_at: issued.data.access_expires_at,
    session: issued.data.session,
  };
}

/** Original `common.ApiSuccess(c, authRotationData(bundle))` plus refresh cookies. */
export function authRotationResponse(
  issued: { data: Record<string, unknown>; cookies: string[] },
  message = "",
  extra: Record<string, unknown> = {},
): Response {
  return withSetCookies(apiOk({ ...authRotationData(issued), ...extra }, message), issued.cookies);
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
    return { ok: false, response: authSessionRevoked() };
  }
  const user = await store.getUserById(sess.user_id);
  if (!user || user.status !== USER_ENABLED) return { ok: false, response: authUnauthorized() };
  const authVersion = Number(user.auth_version || 1) || 1;
  if (Number(sess.user_auth_version || 1) !== authVersion) {
    await store.revokeSession(sess.sid, user.id);
    return { ok: false, response: authSessionRevoked() };
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
      return { ok: false, response: authSessionRevoked() };
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
    rememberRequestUserLanguageFromUser(req, user);
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
    rememberRequestUserLanguageFromUser(req, user);
    return toSessionUser(user, payload.sid || "", Number(user.auth_version || 1) || 1, Number(sess?.version || 1) || 1);
  }
  const user = await store.getUserByField("access_token", raw);
  if (!user || user.status !== USER_ENABLED) return null;
  if (req) await beginAccessTokenAudit(store, req, user, raw);
  rememberRequestUserLanguageFromUser(req, user);
  return toSessionUser(user, "", Number(user.auth_version || 1) || 1, 1, true);
}

function toSessionUser(user: UserRow, sid: string, uv = 0, sv = 0, useAccessToken = false): SessionUser {
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
    useAccessToken,
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

/** Original `middleware.authorizationToken`. */
function dashboardAuthorizationToken(header: string): string {
  const trimmed = header.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1] || "";
  if (parts.length !== 1) return "";
  return parts[0];
}

function writeDashboardAuthError(kind: "expired" | "invalid" | "revoked"): Response {
  if (kind === "expired") return authTokenExpired();
  if (kind === "revoked") return authSessionRevoked();
  return authUnauthorized();
}

type DashboardCredential =
  | { kind: "unmatched" }
  | { kind: "user"; user: SessionUser }
  | { kind: "error"; response: Response };

/** Original `middleware.classifyDashboardCredential`. */
async function classifyDashboardCredential(c: Context<Env>, store: Store): Promise<DashboardCredential> {
  const raw = dashboardAuthorizationToken(c.req.headers.get("authorization") || "");
  if (!raw) return { kind: "unmatched" };
  const secret = await sessionSecret(c.env, store);
  if (peekDashboardJwt(raw)) {
    const parsed = await parseAccessJwt(raw, secret);
    if (!parsed.ok) return { kind: "error", response: writeDashboardAuthError(parsed.expired ? "expired" : "invalid") };
    const sess = await store.getSession(parsed.payload.sid);
    const userId = Number(parsed.payload.sub);
    if (
      !sess ||
      sess.revoked ||
      (sess.expires_at > 0 && sess.expires_at < nowSec()) ||
      sess.user_id !== userId ||
      Number(sess.version || 1) !== parsed.payload.sv ||
      Number(sess.user_auth_version || 1) !== parsed.payload.uv
    ) {
      return { kind: "error", response: writeDashboardAuthError("revoked") };
    }
    const user = await store.getUserById(userId);
    if (!user || user.status !== USER_ENABLED || Number(user.auth_version || 1) !== parsed.payload.uv) {
      return { kind: "error", response: writeDashboardAuthError("revoked") };
    }
    await store.touchSession(parsed.payload.sid);
    rememberRequestUserLanguageFromUser(c.req, user);
    return { kind: "user", user: toSessionUser(user, parsed.payload.sid, parsed.payload.uv, parsed.payload.sv) };
  }
  const patUser = await store.getUserByField("access_token", raw);
  if (!patUser || patUser.id <= 0) return { kind: "unmatched" };
  await beginAccessTokenAudit(store, c.req, patUser, raw);
  const user = await store.getUserById(patUser.id);
  if (!user) return { kind: "error", response: writeDashboardAuthError("revoked") };
  rememberRequestUserLanguageFromUser(c.req, user);
  return { kind: "user", user: toSessionUser(user, "", Number(user.auth_version || 1) || 1, 1, true) };
}

/** Original `middleware.TryUserAuth`. */
export async function tryUserAuth(c: Context<Env>, store: Store): Promise<SessionUser | null | Response> {
  const classified = await classifyDashboardCredential(c, store);
  if (classified.kind === "error") return classified.response;
  if (classified.kind === "user") return classified.user;
  return null;
}

/** Original `middleware.UserAuth`. */
export async function userAuth(c: Context<Env>, store: Store): Promise<SessionUser | Response> {
  const classified = await classifyDashboardCredential(c, store);
  if (classified.kind === "error") return classified.response;
  if (classified.kind === "unmatched") return authUnauthorized();
  if (classified.user.status !== USER_ENABLED) return authUserDisabled();
  return classified.user;
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
  beginAdminAudit(c.req, u, c.params);
  return u;
}

export async function requireRoot(c: Context<Env>, store: Store): Promise<SessionUser | Response> {
  const u = await requireUser(c, store);
  if (u instanceof Response) return u;
  if (u.role < ROLE_ROOT) return apiFail("需要超级管理员", null, 403);
  beginAdminAudit(c.req, u, c.params);
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
};

const pendingAccessAudits = new WeakMap<Request, PendingAccessAudit>();

/**
 * Original `middleware.beginAccessTokenAudit`. TokenRef is the generation
 * fingerprint captured before handlers may rotate the PAT.
 */
export async function beginAccessTokenAudit(store: Store, req: Request, user: UserRow, token: string): Promise<void> {
  void store;
  if (pendingAccessAudits.has(req)) return;
  pendingAccessAudits.set(req, {
    userId: user.id,
    username: user.username,
    actorRole: user.role,
    tokenRef: await accessTokenFingerprint(token),
  });
}

/**
 * Original `middleware.AccessTokenAudit`: probe Authorization before route
 * auth. Internal dashboard JWTs (including expired / security-proof) are
 * skipped via `ParseDashboardAccessToken`'s unverified iss/aud/token_use
 * check. `ValidateAccessToken` does not require USER_ENABLED.
 */
export async function maybeBeginAccessTokenAudit(store: Store, req: Request, secret: string): Promise<void> {
  void secret;
  const raw = dashboardAuthorizationToken(req.headers.get("authorization") || "");
  if (!raw) return;
  if (peekDashboardJwt(raw)) return;
  const user = await store.getUserByField("access_token", raw);
  if (!user || user.id <= 0) return;
  await beginAccessTokenAudit(store, req, user, raw);
}

/**
 * Original `middleware.finishAccessTokenAudit` + `model.RecordAuditLog`.
 * Action and Content stay empty; Route is gin FullPath (empty on NoRoute).
 */
export async function finishAccessTokenAudit(store: Store, req: Request, res: Response, requestId = ""): Promise<void> {
  const pending = pendingAccessAudits.get(req);
  if (!pending) return;
  pendingAccessAudits.delete(req);
  let body = "";
  try {
    const buf = await res.clone().arrayBuffer();
    const slice = buf.byteLength > TOKEN_OPERATION_AUDIT_MAX_BODY ? buf.slice(0, TOKEN_OPERATION_AUDIT_MAX_BODY) : buf;
    body = new TextDecoder().decode(slice);
  } catch {
    /* original auditResponseWriter captures bytes written */
  }
  const success = auditResponseSuccess(res.status, body);
  const route = ginFullPath(req.method, new URL(req.url).pathname);
  try {
    await store.audit(pending.userId, pending.username, AUDIT_CATEGORY_ACCESS_TOKEN, "", clientIp(req), {
      actor_role: auditActorRole(pending.actorRole),
      category: AUDIT_CATEGORY_ACCESS_TOKEN,
      action: "",
      token_ref: pending.tokenRef,
      auth_method: "access_token",
      user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
      method: req.method,
      route,
      status: res.status,
      success,
      request_id: requestId || requestIdFor(req),
    });
  } catch {
    /* original RecordAuditLog logs and continues */
  }
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
  if (!user) return json(403, { success: false, message: authInsufficientPrivilegeMessage(c.req) });
  const roleKey = roleKeyForSystemRole(user.role);
  const userPolicies = await store.casbinPolicies(userSubject(user.id));
  const rolePolicies = roleKey ? await store.casbinPolicies(roleSubject(roleKey)) : [];
  if (!canWithPolicies(user, resource, action, userPolicies, rolePolicies)) {
    return json(403, { success: false, message: authInsufficientPrivilegeMessage(c.req) });
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

/** Original `middleware.TokenAuthReadOnly` — gin JSON, not OpenAI errors. */
export async function authenticateTokenReadOnly(
  c: Context<Env>,
  store: Store,
): Promise<{ token: TokenRow; user: UserRow } | Response> {
  const header = c.req.headers.get("authorization") || "";
  if (!header) {
    return json(401, { success: false, message: tokenNotProvidedMessage(c.req) });
  }
  const key = parseApiKey(header);
  const token = await store.getTokenByKey(key);
  if (!token) {
    return json(401, { success: false, message: tokenInvalidMessage(c.req) });
  }
  if (token.status === TOKEN_DISABLED) {
    return json(401, { success: false, message: tokenStatusUnavailableMessage(c.req) });
  }
  const user = await store.getUserById(token.user_id);
  if (!user) {
    return json(500, { success: false, message: databaseErrorMessage(c.req) });
  }
  if (user.status !== USER_ENABLED) {
    return json(403, { success: false, message: userBannedMessage(c.req) });
  }
  rememberRequestUserLanguageFromUser(c.req, user);
  return { token, user };
}

function tokenAuthAbort(
  req: Request,
  status: number,
  message: string,
  code = "",
  extra?: HeadersInit,
): Response {
  return abortWithOpenAiMessage(status, message, code, req.headers.get("x-oneapi-request-id") || "", extra);
}

export async function authenticateApiToken(c: Context<Env>, store: Store): Promise<AuthToken | Response> {
  const parsed = extractRequestApiKeyParts(c.req, c.url);
  const key = parsed.key;
  if (!key) return tokenAuthAbort(c.req, 401, tokenInvalidMessage(c.req));
  const token = await store.getTokenByKey(key);
  if (!token || token.status !== TOKEN_ENABLED) {
    return tokenAuthAbort(c.req, 401, tokenInvalidMessage(c.req));
  }
  if (token.expired_time !== -1 && token.expired_time < nowSec()) {
    return tokenAuthAbort(c.req, 401, tokenInvalidMessage(c.req));
  }
  if (!token.unlimited_quota && token.remain_quota <= 0) {
    return tokenAuthAbort(c.req, 401, tokenInvalidMessage(c.req));
  }
  const allowIps = tokenIpLimits(token.allow_ips);
  if (allowIps.length) {
    const ip = clientIp(c.req);
    if (!parseIP(ip)) {
      return tokenAuthAbort(c.req, 403, "无法解析客户端 IP 地址");
    }
    if (!isIpInCIDRList(ip, allowIps)) {
      return tokenAuthAbort(c.req, 403, "您的 IP 不在令牌允许访问的列表中", "access_denied");
    }
  }
  const user = await store.getUserById(token.user_id);
  if (!user) return tokenAuthAbort(c.req, 500, databaseErrorMessage(c.req));
  rememberRequestUserLanguageFromUser(c.req, user);
  if (user.status !== USER_ENABLED) return tokenAuthAbort(c.req, 403, userBannedMessage(c.req));
  const userGroup = user.group || "default";
  let usingGroup = userGroup;
  const tokenGroup = String(token.group || "");
  if (tokenGroup) {
    const usable = await userUsableGroups(store, userGroup);
    if (usable[tokenGroup] == null) {
      return tokenAuthAbort(c.req, 403, `无权访问 ${tokenGroup} 分组`);
    }
    if (tokenGroup !== "auto" && !(await containsGroupRatio(store, tokenGroup))) {
      return tokenAuthAbort(c.req, 403, `分组 ${tokenGroup} 已被弃用`);
    }
    usingGroup = tokenGroup;
  }
  let pinnedChannelId: number | undefined;
  if (parsed.extra.length) {
    if (user.role < ROLE_ADMIN) {
      return tokenAuthAbort(c.req, 403, "普通用户不支持指定渠道", "", {
        specific_channel_version: SPECIFIC_CHANNEL_VERSION,
      });
    }
    const rawId = parsed.extra[0];
    if (!/^-?\d+$/.test(rawId)) {
      return tokenAuthAbort(c.req, 400, invalidChannelIdMessage(c.req));
    }
    pinnedChannelId = Number(rawId);
  }
  return { token, user, usingGroup, pinnedChannelId };
}

export function tokenAllowsModel(token: TokenRow, model: string): boolean {
  if (!token.model_limits_enabled) return true;
  return tokenModelLimitAllows(tokenModelLimitsMap(String(token.model_limits || "")), model);
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

/** Original `requireBrowserSession` — PAT identities have no sid. */
export function authSessionRequired(): Response {
  return json(403, {
    success: false,
    code: "AUTH_SESSION_REQUIRED",
    message: "a dashboard login session is required",
  });
}

export async function requireBrowserSession(
  c: Context<Env>,
  store: Store,
): Promise<{ user: SessionUser; identity: AuthIdentity } | Response> {
  const u = await requireUser(c, store);
  if (u instanceof Response) return u;
  const identity = await dashboardIdentity(c, store);
  if (!identity) return authSessionRequired();
  return { user: u, identity };
}

export async function requireProof(
  c: Context<Env>,
  store: Store,
  operation: VerificationOperation,
): Promise<(AuthIdentity & { method: string }) | Response> {
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

/** Original `model.AuthFlowPurposeLoginVerification`. */
export const AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION = "login_verification";

/** Original `model.AuthFlowPurposeLoginPasskey`. */
export const AUTH_FLOW_PURPOSE_LOGIN_PASSKEY = "login_passkey";

/** Original `model.AuthFlowPurposePasskeyLogin`. */
export const AUTH_FLOW_PURPOSE_PASSKEY_LOGIN = "passkey_login";

/** Original `service.VerificationMethodTwoFA`. */
export const VERIFICATION_METHOD_TWO_FA = "2fa";

/** Original `service.VerificationMethodPasskey`. */
export const VERIFICATION_METHOD_PASSKEY = "passkey";

/** Original `service.ErrProofMethod` via `writeSecurityOperationError`. */
const ERR_PROOF_METHOD = "This verification method is not allowed for this action.";
/** Original `writeSecurityOperationError` for `ErrAuthFlowInvalid` / Expired / Consumed. */
const ERR_AUTH_FLOW_INVALID = "Verification flow expired";
/** Original `service.ErrVerificationUnavailable`. */
const ERR_VERIFICATION_UNAVAILABLE = "This verification method is currently unavailable.";

/** Original `service.LoginVerificationTTL`. */
export const LOGIN_VERIFICATION_TTL_SEC = 300;

/** Original `service.LoginChallenge`. */
export type LoginChallenge = {
  require_verification: true;
  flow_token: string;
  expires_at: number;
  methods: { method: string; available: boolean; reason?: string }[];
};

export function isLoginVerificationFlow(type: string): boolean {
  return type === AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION;
}

async function loginVerificationMethods(store: Store, user: UserRow): Promise<LoginChallenge["methods"]> {
  const methods: LoginChallenge["methods"] = [];
  if (Number(user.totp_enabled) === 1) methods.push(twoFAVerificationOption(user));
  const hasPasskey = (await store.listPasskeys(user.id)).length > 0;
  if (hasPasskey) {
    if (await store.optionBool("PasskeyEnabled", true)) methods.push({ method: "passkey", available: true });
    else methods.push({ method: "passkey", available: false, reason: "Passkey authentication is disabled." });
  }
  return methods;
}

/**
 * Original `service.StartLoginVerification`.
 * Password login keeps its extra `require_2fa` field; WeChat/OAuth use this envelope as-is.
 */
export async function startLoginVerification(
  store: Store,
  user: UserRow,
  loginMethod: string,
): Promise<{ challenge: LoginChallenge | null } | { error: Response }> {
  const authVersion = Number(user.auth_version || 1) || 1;
  if (!user.id || authVersion <= 0 || !loginMethod) {
    return { error: apiFailCode(ERR_AUTH_FLOW_INVALID, "AUTH_FLOW_INVALID") };
  }
  if (user.status !== USER_ENABLED) {
    return { error: authUnauthorized() };
  }
  const methods = await loginVerificationMethods(store, user);
  if (!methods.length) return { challenge: null };
  if (!methods.some((m) => m.available)) {
    return { error: apiFailCode(ERR_VERIFICATION_UNAVAILABLE, "SECURITY_METHOD_UNAVAILABLE") };
  }
  const flow = randomHex(16);
  const expires_at = nowSec() + LOGIN_VERIFICATION_TTL_SEC;
  await store.insertAuthFlow({
    token: flow,
    type: AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION,
    user_id: user.id,
    expires_at,
    payload: JSON.stringify({ auth_version: authVersion, login_method: loginMethod }),
  });
  return { challenge: { require_verification: true, flow_token: flow, expires_at, methods } };
}

/** Original `controller.setupLogin`. */
export async function setupLogin(
  store: Store,
  env: Env,
  user: UserRow,
  req: Request,
  loginMethod: string,
): Promise<Response> {
  const started = await startLoginVerification(store, user, loginMethod);
  if ("error" in started) return started.error;
  if (started.challenge) return apiOk(started.challenge);
  const issued = await issueSessionSafe(store, env, user, req, loginMethod);
  if (issued instanceof Response) return issued;
  await recordLoginAudit(store, req, user, loginMethod);
  return sessionResponse(issued);
}

type LoginFlowPayload = { auth_version: number; login_method: string };

/** Original `service.RequireLoginVerification`. */
export async function requireLoginVerification(
  store: Store,
  token: string,
  method: string,
): Promise<
  | {
      flow: { token: string; user_id: number; expires_at: number };
      user: UserRow;
      payload: LoginFlowPayload;
    }
  | { error: Response }
> {
  const flow = await store.getAuthFlow(token);
  if (!flow || !isLoginVerificationFlow(flow.type)) {
    return { error: apiFailCode(ERR_AUTH_FLOW_INVALID, "AUTH_FLOW_INVALID") };
  }
  if (Number(flow.consumed_at || 0) > 0 || flow.expires_at < nowSec()) {
    return { error: apiFailCode(ERR_AUTH_FLOW_INVALID, "AUTH_FLOW_INVALID") };
  }
  let payload: LoginFlowPayload | null = null;
  try {
    const parsed = JSON.parse(flow.payload || "{}") as { auth_version?: unknown; login_method?: unknown };
    const authVersion = Number(parsed.auth_version || 0);
    const loginMethod = typeof parsed.login_method === "string" ? parsed.login_method : "";
    if (authVersion > 0 && loginMethod) payload = { auth_version: authVersion, login_method: loginMethod };
  } catch {
    payload = null;
  }
  if (!payload) return { error: apiFailCode(ERR_AUTH_FLOW_INVALID, "AUTH_FLOW_INVALID") };
  const user = await store.getUserById(flow.user_id);
  if (!user || user.status !== USER_ENABLED || Number(user.auth_version || 1) !== payload.auth_version) {
    return { error: authUnauthorized() };
  }
  const methods = await loginVerificationMethods(store, user);
  const option = methods.find((m) => m.method === method);
  if (!option) return { error: apiFailCode(ERR_PROOF_METHOD, "SECURITY_PROOF_METHOD_MISMATCH") };
  if (!option.available) return { error: apiFailCode(ERR_VERIFICATION_UNAVAILABLE, "SECURITY_METHOD_UNAVAILABLE") };
  return { flow, user, payload };
}

/** Original `service.VerifyTwoFactorCode` for login (TOTP or backup code). */
async function verifyLoginTwoFactor(store: Store, user: UserRow, code: string): Promise<Response | null> {
  const result = await verifyTwoFactorCode(store, user, code);
  if (!result.ok) return apiFailCode(result.message, result.code);
  return null;
}

/**
 * Original `service.CompleteLoginVerification` + `controller.completeVerifiedLoginResponse`.
 * Session `login_method` is the primary method stored on the flow (`password`, `oauth:github`, …),
 * not the factor used to complete the challenge.
 */
export async function completeLoginVerification(
  store: Store,
  env: Env,
  req: Request,
  token: string,
  method: string,
): Promise<Response> {
  const loaded = await requireLoginVerification(store, token, method);
  if ("error" in loaded) return loaded.error;
  const consumed = await store.consumeAuthFlow(token, {
    type: AUTH_FLOW_PURPOSE_LOGIN_VERIFICATION,
    user_id: loaded.user.id,
  });
  if (consumed !== "ok") return apiFailCode(ERR_AUTH_FLOW_INVALID, "AUTH_FLOW_INVALID");
  const issued = await issueSessionSafe(store, env, loaded.user, req, loaded.payload.login_method);
  if (issued instanceof Response) return issued;
  await recordLoginAudit(store, req, loaded.user, loaded.payload.login_method, method);
  return sessionResponse(issued);
}

/**
 * Original `controller.VerifyLogin` / `controller.Verify2FALogin`.
 * Empty `method` defaults to `2fa`; any other method is `SECURITY_PROOF_METHOD_MISMATCH`.
 */
export async function verifyLogin(store: Store, env: Env, req: Request, rawBody: unknown): Promise<Response> {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return apiErrorMsg("参数错误");
  const body = rawBody as { flow_token?: unknown; method?: unknown; code?: unknown };
  const flowToken = typeof body.flow_token === "string" ? body.flow_token : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!flowToken || !code) return apiErrorMsg("参数错误");
  const method = typeof body.method === "string" && body.method ? body.method : VERIFICATION_METHOD_TWO_FA;
  if (method !== VERIFICATION_METHOD_TWO_FA) {
    return apiFailCode(ERR_PROOF_METHOD, "SECURITY_PROOF_METHOD_MISMATCH");
  }
  const loaded = await requireLoginVerification(store, flowToken, method);
  if ("error" in loaded) return loaded.error;
  const totpErr = await verifyLoginTwoFactor(store, loaded.user, code);
  if (totpErr) return totpErr;
  return completeLoginVerification(store, env, req, flowToken, method);
}

/** Original `controller.VerifyLogin` request decoding. */
export async function verifyLoginFromRequest(store: Store, env: Env, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return apiErrorMsg("参数错误");
  }
  return verifyLogin(store, env, req, body);
}
