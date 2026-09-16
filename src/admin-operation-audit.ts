/**
 * Original `middleware.beginAdminAudit` / `finishAdminAudit` leftover
 * operation audit-log JSON. Runs after AdminAuth/RootAuth on write methods
 * (POST/PUT/PATCH/DELETE). Handlers that already recorded a log set
 * `ContextKeyAuditLogged` so this fallback is skipped.
 */
import { clientIp } from "./http.js";
import type { Store } from "./store.js";
import {
  TOKEN_OPERATION_AUDIT_MAX_BODY,
  auditActorRole,
  auditResponseSuccess,
  truncateAuditUserAgent,
} from "./token-operation-audit.js";
import type { SessionUser } from "./types.js";

/** Original `auditResponseWriter.maxSize`. */
export const ADMIN_OPERATION_AUDIT_MAX_BODY = TOKEN_OPERATION_AUDIT_MAX_BODY;

/** Original `model.AuditCategoryOperation`. */
export const AUDIT_CATEGORY_OPERATION = "operation";

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
