/**
 * Original `middleware.beginAdminAudit` / `finishAdminAudit` leftover
 * operation audit-log JSON. Runs after AdminAuth/RootAuth on write methods
 * (POST/PUT/PATCH/DELETE). Handlers that already recorded a log set
 * `ContextKeyAuditLogged` so this fallback is skipped.
 */
import { clientIp } from "./http.js";
import { requestIdFor } from "./request-id.js";
import type { Store } from "./store.js";
import {
  AUDIT_CATEGORY_SECURITY,
  TOKEN_OPERATION_AUDIT_MAX_BODY,
  auditActorRole,
  auditResponseSuccess,
  truncateAuditUserAgent,
} from "./token-operation-audit.js";
import type { SessionUser } from "./types.js";

export { AUDIT_CATEGORY_SECURITY };

/** Original `auditResponseWriter.maxSize`. */
export const ADMIN_OPERATION_AUDIT_MAX_BODY = TOKEN_OPERATION_AUDIT_MAX_BODY;

/** Original `model.AuditCategoryOperation`. */
export const AUDIT_CATEGORY_OPERATION = "operation";

/** Original `model.AuditCategoryLogin`. */
export const AUDIT_CATEGORY_LOGIN = "login";

/** Original `auditRouteActions` (`METHOD + " " + FullPath`). */
export const AUDIT_ROUTE_ACTIONS: Record<string, string> = {
  "POST /api/user/topup/complete": "user.topup_complete",
  "DELETE /api/user/:id/reset_passkey": "user.reset_passkey",
  "DELETE /api/user/:id/oauth/bindings/:provider_id": "user.oauth_unbind",
  "POST /api/option/payment_compliance": "option.payment_compliance",
  "POST /api/option/rest_model_ratio": "option.reset_ratio",
  "DELETE /api/option/channel_affinity_cache": "option.clear_affinity_cache",
  "POST /api/custom-oauth-provider/": "custom_oauth.create",
  "PUT /api/custom-oauth-provider/:id": "custom_oauth.update",
  "DELETE /api/custom-oauth-provider/:id": "custom_oauth.delete",
  "DELETE /api/performance/disk_cache": "performance.clear_disk_cache",
  "POST /api/performance/gc": "performance.gc",
  "DELETE /api/performance/logs": "performance.clear_logs",
  "PUT /api/redemption/": "redemption.update",
  "POST /api/redemption/batch": "redemption.delete_batch",
  "DELETE /api/redemption/:id": "redemption.delete",
  "DELETE /api/redemption/invalid": "redemption.delete_invalid",
  "POST /api/prefill_group/": "prefill_group.create",
  "PUT /api/prefill_group/": "prefill_group.update",
  "DELETE /api/prefill_group/:id": "prefill_group.delete",
  "POST /api/vendors/": "vendor.create",
  "PUT /api/vendors/": "vendor.update",
  "DELETE /api/vendors/:id": "vendor.delete",
  "POST /api/models/": "model.create",
  "PUT /api/models/": "model.update",
  "DELETE /api/models/:id": "model.delete",
  "POST /api/models/sync_upstream": "model.sync_upstream",
  "POST /api/deployments/": "deployment.create",
  "PUT /api/deployments/:id": "deployment.update",
  "DELETE /api/deployments/:id": "deployment.delete",
  "POST /api/subscription/admin/plans": "subscription.plan_create",
  "PUT /api/subscription/admin/plans/:id": "subscription.plan_update",
  "POST /api/subscription/admin/bind": "subscription.bind",
  "POST /api/system-task/log-cleanup": "log.cleanup_start",
};

export type AdminAuditMatch = {
  action: string;
  route: string;
  params: Record<string, string>;
};

type PendingAdminAudit = {
  userId: number;
  username: string;
  actorRole: number;
  authMethod: string;
  action: string;
  route: string;
  method: string;
  params: Record<string, string>;
  marked: boolean;
};

const pendingByReq = new WeakMap<Request, PendingAdminAudit>();

function pathParts(path: string): string[] {
  const endsWithSlash = path.endsWith("/") && path.length > 1;
  const parts = path.split("/").filter(Boolean);
  if (endsWithSlash) parts.push("");
  return parts;
}

function matchParts(pattern: string[], path: string[]): Record<string, string> | null {
  if (pattern.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(":")) {
      if (!path[i]) return null;
      try {
        params[p.slice(1)] = decodeURIComponent(path[i]);
      } catch {
        params[p.slice(1)] = path[i];
      }
    } else if (p !== path[i]) return null;
  }
  return params;
}

function candidatePathParts(pathname: string): string[][] {
  const primary = pathParts(pathname);
  const alts = [primary];
  if (pathname.endsWith("/") && pathname.length > 1) alts.push(pathParts(pathname.slice(0, -1)));
  else if (pathname.length > 1) alts.push(pathParts(pathname + "/"));
  return alts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reconstruct gin `FullPath` from the request path and route params. */
export function reconstructAdminAuditRoute(pathname: string, params: Record<string, string>): string {
  let route = pathname;
  const entries = Object.entries(params)
    .filter(([, value]) => value)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [key, value] of entries) {
    route = route.replace(new RegExp(`/${escapeRegExp(value)}(?=/|$)`), `/:${key}`);
  }
  return route;
}

/**
 * Original `auditRouteActions[method+" "+route]` with static templates preferred
 * over `:param` (gin `/invalid` beats `/:id`). Unmapped writes are `generic`.
 */
export function matchAdminAuditRoute(
  method: string,
  pathname: string,
  routeParams: Record<string, string> = {},
): AdminAuditMatch {
  const candidates = candidatePathParts(pathname);
  let best: (AdminAuditMatch & { score: number }) | null = null;
  for (const [key, action] of Object.entries(AUDIT_ROUTE_ACTIONS)) {
    const split = key.indexOf(" ");
    const mappedMethod = key.slice(0, split);
    const template = key.slice(split + 1);
    if (mappedMethod !== method) continue;
    const pattern = pathParts(template);
    for (const path of candidates) {
      const params = matchParts(pattern, path);
      if (!params) continue;
      const score = Object.keys(params).length;
      if (!best || score < best.score) best = { action, route: template, params, score };
    }
  }
  if (best) return { action: best.action, route: best.route, params: best.params };
  return {
    action: "generic",
    route: reconstructAdminAuditRoute(pathname, routeParams),
    params: { ...routeParams },
  };
}

/** Original write-only gate in `beginAdminAudit`. */
export function isAdminAuditWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function beginAdminAudit(
  req: Request,
  user: SessionUser,
  routeParams: Record<string, string> = {},
): PendingAdminAudit | null {
  if (!isAdminAuditWriteMethod(req.method)) return null;
  const existing = pendingByReq.get(req);
  if (existing) return existing;
  const url = new URL(req.url);
  const matched = matchAdminAuditRoute(req.method, url.pathname, routeParams);
  const pending: PendingAdminAudit = {
    userId: user.id,
    username: user.username,
    actorRole: auditActorRole(user.role),
    authMethod: user.useAccessToken ? "access_token" : "session",
    action: matched.action,
    route: matched.route,
    method: req.method,
    params: matched.params,
    marked: false,
  };
  pendingByReq.set(req, pending);
  return pending;
}

/** Original `controller.markAuditLogged` / `ContextKeyAuditLogged`. */
export function markAuditLogged(req: Request): void {
  const pending = pendingByReq.get(req);
  if (pending) pending.marked = true;
}

function encodeAdminAuditOther(
  action: string,
  opParams: Record<string, unknown>,
  adminInfo: { admin_id: number; admin_username: string; admin_role: number; auth_method: string },
  auditInfo: {
    method: string;
    route: string;
    path: string;
    status: number;
    success: boolean;
    params?: Record<string, string>;
  },
): string {
  const op: { action: string; params?: Record<string, unknown> } = { action };
  if (Object.keys(opParams).length) op.params = opParams;
  const info = { ...auditInfo };
  if (!info.params || !Object.keys(info.params).length) delete info.params;
  return JSON.stringify({ op, admin_info: adminInfo, audit_info: info });
}

export async function finishAdminAudit(
  store: Store,
  req: Request,
  res: Response,
  requestId: string,
): Promise<void> {
  const pending = pendingByReq.get(req);
  if (!pending) return;
  pendingByReq.delete(req);
  if (pending.marked) return;
  const raw = await res.clone().text();
  const body =
    new TextEncoder().encode(raw).length > ADMIN_OPERATION_AUDIT_MAX_BODY
      ? raw.slice(0, ADMIN_OPERATION_AUDIT_MAX_BODY)
      : raw;
  const success = auditResponseSuccess(res.status, body);
  const opParams: Record<string, unknown> = {};
  if (pending.action === "generic") {
    opParams.method = pending.method;
    opParams.route = pending.route;
  }
  const content = pending.method + " " + pending.route;
  await store.audit(pending.userId, pending.username, AUDIT_CATEGORY_OPERATION, content, clientIp(req), {
    actor_role: pending.actorRole,
    category: AUDIT_CATEGORY_OPERATION,
    action: pending.action,
    token_ref: "",
    auth_method: pending.authMethod,
    user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
    method: pending.method,
    route: pending.route,
    status: res.status,
    success,
    request_id: requestId,
    other: encodeAdminAuditOther(
      pending.action,
      opParams,
      {
        admin_id: pending.userId,
        admin_username: pending.username,
        admin_role: pending.actorRole,
        auth_method: pending.authMethod,
      },
      {
        method: pending.method,
        route: pending.route,
        path: pending.route,
        status: res.status,
        success,
        params: pending.params,
      },
    ),
  });
}

/**
 * Original `controller.auditContentTemplates`. Unregistered actions fall back
 * to the action string itself (`auditContentEN`).
 */
export const AUDIT_CONTENT_TEMPLATES: Record<string, string> = {
  "user.create": "Created user ${username} (role ${role})",
  "user.update": "Updated user ${username} (ID: ${id})",
  "user.delete": "Deleted user ${username} (ID: ${id})",
  "user.account_delete": "Account deletion",
  "user.manage": "Performed ${action} on user ${username} (ID: ${id})",
  "user.quota_add": "Increased user quota by ${quota}",
  "user.quota_subtract": "Decreased user quota by ${quota}",
  "user.quota_override": "Overrode user quota from ${from} to ${to}",
  "user.binding_clear": "Cleared ${bindingType} binding for user ${username}",
  "user.2fa_disable": "Force-disabled two-factor authentication for the user",
  "user.passkey_register": "Registered a passkey",
  "access_token.generate": "Generated a system access token",
  "access_token.revoke": "Revoked the system access token",
  "user.2fa_setup": "Started two-factor authentication setup",
  "user.2fa_enable": "Enabled two-factor authentication",
  "user.2fa_disable_self": "Disabled two-factor authentication",
  "user.2fa_backup_codes": "Regenerated two-factor backup codes",
  "user.security_verify": "Completed security verification",
  "user.password_change": "Account password change",
  "user.binding_start": "Account binding request",
  "user.binding_bind": "Account binding",
  "user.binding_unbind": "Account unlinking",
  "user.email_binding_resend": "Email confirmation code resend",
  "user.passkey_delete": "Deleted a passkey",
  "user.reset_passkey": "Reset the user passkey",
  "option.update": "Updated system setting ${key}",
  "option.passkey_domains": "Updated Passkey domains: removed ${domains}; affected ${known}; unknown ${unknown}",
  "option.passkey_domains_confirmed":
    "Confirmed removal of Passkey domains: ${domains}; affected ${known}; unknown ${unknown}",
  "option.passkey_domains_blocked":
    "Passkey domain change blocked: ${domains}; affected ${known}; unknown ${unknown}",
  "option.passkey_domains_failed": "Passkey domain update failed",
  "channel.create": "Created channel ${name} (type ${type}, count ${count})",
  "channel.update": "Updated channel ${name} (ID: ${id})",
  "channel.delete": "Deleted channel ${name} (ID: ${id})",
  "channel.delete_batch": "Batch deleted ${count} channels",
  "channel.delete_disabled": "Deleted all disabled channels (${count})",
  "channel.key_view": "Viewed channel key ${name} (ID: ${id})",
  "channel.tag_disable": "Disabled channels with tag ${tag}",
  "channel.tag_enable": "Enabled channels with tag ${tag}",
  "channel.tag_edit": "Edited channels with tag ${tag}",
  "channel.tag_batch_set": "Batch set tag for ${count} channels",
  "channel.copy": "Copied channel (source ID: ${sourceId}) to ${name} (new ID: ${id})",
  "channel.multi_key_manage": "Multi-key management ${action} on channel (ID: ${id})",
  "channel.upstream_apply": "Applied upstream model changes to channel (ID: ${id})",
  "channel.upstream_apply_all": "Applied upstream model changes to ${count} channels",
  "redemption.create": "Created ${count} redemption codes named ${name} (${quota} each)",
  "redemption.delete_batch": "Batch deleted ${count} redemption codes",
  "subscription.plan_reset": "Reset active subscriptions for plan ${plan_id}",
  "subscription.user_plan_reset": "Reset active plan ${plan_id} subscriptions for user ${target_user_id}",
};

/** Original `controller.auditContentEN` (`os.Expand` `${name}` from params). */
export function auditContentEN(action: string, params: Record<string, unknown> = {}): string {
  const tmpl = AUDIT_CONTENT_TEMPLATES[action];
  if (!tmpl) return action;
  return tmpl.replace(/\$\{([^{}]+)\}/g, (_, key: string) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) return String(params[key]);
    return "";
  });
}

function encodeManageAuditOther(action: string, params: Record<string, unknown>, user: SessionUser): string {
  const op: { action: string; params?: Record<string, unknown> } = { action };
  if (Object.keys(params).length) op.params = params;
  const authMethod = user.useAccessToken ? "access_token" : "session";
  return JSON.stringify({
    op,
    admin_info: {
      admin_id: user.id,
      admin_username: user.username,
      admin_role: auditActorRole(user.role),
      auth_method: authMethod,
    },
  });
}

/**
 * Original `controller.recordManageAudit` / `recordManageAuditFor`.
 * Writes category `operation` with English Content, `other.op` + `other.admin_info`
 * (no `audit_info`), Status 200 / Success true, then `markAuditLogged`.
 */
export async function recordManageAudit(
  store: Store,
  req: Request,
  user: SessionUser,
  action: string,
  params: Record<string, unknown> = {},
  targetUserId = 0,
): Promise<void> {
  const merged: Record<string, unknown> = { ...params };
  if (!("target_user_id" in merged) && targetUserId > 0 && targetUserId !== user.id) {
    merged.target_user_id = targetUserId;
  }
  const pending = pendingByReq.get(req);
  const url = new URL(req.url);
  const matched = pending ?? matchAdminAuditRoute(req.method, url.pathname, {});
  const authMethod = user.useAccessToken ? "access_token" : "session";
  try {
    await store.audit(user.id, user.username, AUDIT_CATEGORY_OPERATION, auditContentEN(action, merged), clientIp(req), {
      actor_role: auditActorRole(user.role),
      category: AUDIT_CATEGORY_OPERATION,
      action,
      token_ref: "",
      auth_method: authMethod,
      user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
      method: req.method,
      route: matched.route,
      status: 200,
      success: true,
      request_id: requestIdFor(req),
      other: encodeManageAuditOther(action, merged, user),
    });
  } catch {
    /* original RecordAuditLog logs and continues */
  }
  markAuditLogged(req);
}

/**
 * Original `controller.manageUserQuota` operation audit (success and failure).
 * English Content from templates on success; failed writes use
 * `Failed user quota adjustment`. Includes `other.audit_info` with empty Path.
 */
export async function recordQuotaManageAudit(
  store: Store,
  req: Request,
  user: SessionUser,
  action: string,
  params: Record<string, unknown>,
  success: boolean,
  status = 200,
): Promise<void> {
  const pending = pendingByReq.get(req);
  const url = new URL(req.url);
  const matched = pending ?? matchAdminAuditRoute(req.method, url.pathname, {});
  const authMethod = user.useAccessToken ? "access_token" : "session";
  const content = success ? auditContentEN(action, params) : "Failed user quota adjustment";
  const op: { action: string; params?: Record<string, unknown> } = { action };
  if (Object.keys(params).length) op.params = params;
  try {
    await store.audit(user.id, user.username, AUDIT_CATEGORY_OPERATION, content, clientIp(req), {
      actor_role: auditActorRole(user.role),
      category: AUDIT_CATEGORY_OPERATION,
      action,
      token_ref: "",
      auth_method: authMethod,
      user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
      method: req.method,
      route: matched.route,
      status,
      success,
      request_id: requestIdFor(req),
      other: JSON.stringify({
        op,
        admin_info: {
          admin_id: user.id,
          admin_username: user.username,
          admin_role: auditActorRole(user.role),
          auth_method: authMethod,
        },
        audit_info: {
          method: req.method,
          route: matched.route,
          path: "",
          status,
          success,
        },
      }),
    });
  } catch {
    /* original RecordAuditLog logs and continues */
  }
  markAuditLogged(req);
}

export type PasskeyDomainAuditChange = {
  removed_rp_ids: string[];
  affected_credentials: number;
  unknown_credentials: number;
  previous_rp_id: string;
  effective_rp_id: string;
};

/** Original `errors.Is(err, model.ErrPasskeyDomainRemovalConfirmation)`. */
function isPasskeyDomainRemovalConfirmation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: string }).code === "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED";
}

const securityErrorCodeByReq = new WeakMap<Request, string>();

/** Original `c.Set("security_error_code")` for `recordUserSecurityAudit`. */
export function setSecurityErrorCode(req: Request, code: string): void {
  if (code) securityErrorCodeByReq.set(req, code);
}

/** Stamp `security_error_code` then return the already-built security error. */
export function withSecurityErrorCode(req: Request, code: string, res: Response): Response {
  setSecurityErrorCode(req, code);
  return res;
}

/**
 * Original `writeSecurityOperationError` / `securityProofError` set
 * `security_error_code` from the JSON `code`. Session
 * `writeAuthSessionError` paths (`AUTH_UNAUTHORIZED` /
 * `AUTH_SESSION_REVOKED`) do not.
 */
export async function attachSecurityErrorCodeFromResponse(req: Request, res: Response): Promise<void> {
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    if (
      typeof body.code === "string" &&
      body.code &&
      body.code !== "AUTH_UNAUTHORIZED" &&
      body.code !== "AUTH_SESSION_REVOKED"
    ) {
      setSecurityErrorCode(req, body.code);
    }
  } catch {
    /* original gin.H omit-data errors have no code */
  }
}

/**
 * Original `controller.recordPasskeyDomainAudit`. Category `operation` with
 * English Content, `other.op` + `other.admin_info` + `other.audit_info`
 * (Method/Route/Path=FullPath, Status=Writer.Status, Success=err==nil),
 * then `markAuditLogged`. Preview callers skip this helper.
 */
export async function recordPasskeyDomainAudit(
  store: Store,
  req: Request,
  user: SessionUser,
  change: PasskeyDomainAuditChange | null | undefined,
  confirmedInput: boolean,
  err: unknown,
  status: number,
): Promise<void> {
  const ok = err == null;
  const confirmed = Boolean(confirmedInput && ok && change && change.removed_rp_ids.length > 0);
  const params: Record<string, unknown> = { success: ok, confirmed };
  if (change) {
    params.domains = change.removed_rp_ids.join(", ");
    params.removed_rp_ids = change.removed_rp_ids;
    params.known = change.affected_credentials;
    params.unknown = change.unknown_credentials;
    params.previous_rp_id = change.previous_rp_id;
    params.effective_rp_id = change.effective_rp_id;
  }
  let action = "option.passkey_domains";
  if (isPasskeyDomainRemovalConfirmation(err)) action = "option.passkey_domains_blocked";
  else if (err != null) action = "option.passkey_domains_failed";
  else if (confirmed) action = "option.passkey_domains_confirmed";
  const pending = pendingByReq.get(req);
  const url = new URL(req.url);
  const matched = pending ?? matchAdminAuditRoute(req.method, url.pathname, {});
  const authMethod = user.useAccessToken ? "access_token" : "session";
  const adminInfo = {
    admin_id: user.id,
    admin_username: user.username,
    admin_role: auditActorRole(user.role),
    auth_method: authMethod,
  };
  const auditInfo = {
    method: req.method,
    route: matched.route,
    path: matched.route,
    status,
    success: ok,
  };
  try {
    await store.audit(user.id, user.username, AUDIT_CATEGORY_OPERATION, auditContentEN(action, params), clientIp(req), {
      actor_role: auditActorRole(user.role),
      category: AUDIT_CATEGORY_OPERATION,
      action,
      token_ref: "",
      auth_method: authMethod,
      user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
      method: req.method,
      route: matched.route,
      status,
      success: ok,
      request_id: requestIdFor(req),
      other: encodeAdminAuditOther(action, params, adminInfo, auditInfo),
    });
  } catch {
    /* original RecordAuditLog logs and continues */
  }
  markAuditLogged(req);
}

/**
 * Original `controller.recordUserSecurityAudit`. Category `security` (adminInfo
 * nil), no `admin_info`. `audit_info` only when params has a bool `success`.
 * `AuditLog.TokenRef` stays empty; fingerprint belongs in `other.op.params`.
 * Does not `markAuditLogged` (UserAuth has no AdminAuth fallback).
 */
export async function recordUserSecurityAudit(
  store: Store,
  req: Request,
  user: { id: number; username: string; role: number; useAccessToken?: boolean },
  action: string,
  params: Record<string, unknown> | null = null,
  routeParams: Record<string, string> = {},
  writerStatus = 200,
): Promise<void> {
  const merged: Record<string, unknown> = params ? { ...params } : {};
  const code = securityErrorCodeByReq.get(req);
  if (code) merged.code = code;
  const pending = pendingByReq.get(req);
  const url = new URL(req.url);
  const matched = pending ?? matchAdminAuditRoute(req.method, url.pathname, routeParams);
  let auditInfo:
    | {
        method: string;
        route: string;
        path: string;
        status: number;
        success: boolean;
      }
    | undefined;
  if (typeof merged.success === "boolean") {
    auditInfo = {
      method: req.method,
      route: matched.route,
      path: matched.route,
      status: writerStatus,
      success: merged.success,
    };
  }
  const authMethod = user.useAccessToken ? "access_token" : "session";
  const op: { action: string; params?: Record<string, unknown> } = { action };
  if (Object.keys(merged).length) op.params = merged;
  const other: Record<string, unknown> = { op };
  if (auditInfo) other.audit_info = auditInfo;
  const success = auditInfo ? auditInfo.success : true;
  const status = auditInfo ? auditInfo.status : 200;
  try {
    await store.audit(user.id, user.username, AUDIT_CATEGORY_SECURITY, auditContentEN(action, merged), clientIp(req), {
      actor_role: auditActorRole(user.role),
      category: AUDIT_CATEGORY_SECURITY,
      action,
      token_ref: "",
      auth_method: authMethod,
      user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
      method: req.method,
      route: matched.route,
      status,
      success,
      request_id: requestIdFor(req),
      other: JSON.stringify(other),
    });
  } catch {
    /* original RecordAuditLog logs and continues */
  }
}

/**
 * Original `controller.loginMethodFromContext`. Prefers an explicit session
 * `login_method` (writeLoginResponse `c.Set`) then gin FullPath mapping.
 */
export function loginMethodFromContext(req: Request, explicit = ""): string {
  if (explicit) return explicit;
  const path = new URL(req.url).pathname;
  switch (path) {
    case "/api/user/login":
      return "password";
    case "/api/user/login/2fa":
      return "2fa";
    case "/api/user/passkey/login/finish":
      return "passkey";
    case "/api/oauth/wechat":
      return "wechat";
    case "/api/oauth/telegram/login":
      return "telegram";
    default: {
      const oauth = path.match(/^\/api\/oauth\/([^/]+)$/);
      if (oauth && oauth[1] !== "wechat") return "oauth:" + oauth[1];
      return "unknown";
    }
  }
}

/**
 * Original gin FullPath for login audit Route. WeChat is a static route;
 * HandleOAuth is `/api/oauth/:provider`.
 */
export function ginLoginAuditRoute(pathname: string, routeParams: Record<string, string> = {}): string {
  const oauth = pathname.match(/^\/api\/oauth\/([^/]+)$/);
  if (oauth && oauth[1] !== "wechat") {
    return reconstructAdminAuditRoute(pathname, { provider: oauth[1], ...routeParams });
  }
  return reconstructAdminAuditRoute(pathname, routeParams);
}

/**
 * Original `controller.recordLoginAudit` / `model.RecordLoginLog`. Category
 * `login`, action `login`, Success true. `other.op` is
 * `{action:"login", params:{method, optional verification_method}}` plus
 * `other.login_method` + `other.user_agent`. No `admin_info` / `audit_info`.
 * `AuditLog.TokenRef` empty; `auth_method` session. Only success (not failures).
 */
export async function recordLoginAudit(
  store: Store,
  req: Request,
  user: { id: number; username: string; role: number },
  loginMethod = "",
  verificationMethod = "",
  routeParams: Record<string, string> = {},
  writerStatus = 200,
): Promise<void> {
  const method = loginMethodFromContext(req, loginMethod);
  const params: Record<string, unknown> = { method };
  if (verificationMethod) params.verification_method = verificationMethod;
  const ua = req.headers.get("user-agent") || "";
  const other: Record<string, unknown> = {
    op: { action: "login", params },
    login_method: method,
  };
  if (ua) other.user_agent = ua;
  const url = new URL(req.url);
  const route = ginLoginAuditRoute(url.pathname, routeParams);
  try {
    await store.audit(user.id, user.username, AUDIT_CATEGORY_LOGIN, `Logged in successfully via ${method}`, clientIp(req), {
      actor_role: auditActorRole(user.role),
      category: AUDIT_CATEGORY_LOGIN,
      action: "login",
      token_ref: "",
      auth_method: "session",
      user_agent: truncateAuditUserAgent(ua),
      method: req.method,
      route,
      status: writerStatus,
      success: true,
      request_id: requestIdFor(req),
      other: JSON.stringify(other),
    });
  } catch {
    /* original RecordAuditLog logs and continues */
  }
}
