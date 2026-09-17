/**
 * Original `middleware.TokenOperationAudit` leftover security audit-log JSON.
 * Runs after UserAuth on `/api/token` write routes. Handlers add only
 * allowlisted metadata; neither bodies nor raw errors are persisted.
 */
import { ROLE_ADMIN, ROLE_ROOT, ROLE_USER } from "./constants.js";
import { clientIp, strconvAtoi } from "./http.js";
import type { Store } from "./store.js";
import type { SessionUser, TokenRow } from "./types.js";

/** Original `auditResponseWriter.maxSize`. */
export const TOKEN_OPERATION_AUDIT_MAX_BODY = 64 * 1024;

/** Original `model.AuditCategorySecurity`. */
export const AUDIT_CATEGORY_SECURITY = "security";

export type TokenAuditParams = Record<string, unknown>;

export type TokenOperationAuditMatch = {
  action: string;
  content: string;
  route: string;
  idFromPath?: number;
};

type PendingTokenAudit = {
  userId: number;
  username: string;
  actorRole: number;
  authMethod: string;
  action: string;
  content: string;
  route: string;
  method: string;
  params: TokenAuditParams;
  succeeded: boolean;
};

const pendingByReq = new WeakMap<Request, PendingTokenAudit>();

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function pathIdIfPositive(raw: string): number | undefined {
  const parsed = strconvAtoi(raw);
  if (parsed.ok && parsed.n > 0) return parsed.n;
  return undefined;
}

/**
 * Original `switch c.Request.Method + " " + c.FullPath()`.
 * Trailing slash is ignored like gin `/token` vs `/token/`.
 */
export function matchTokenOperationAudit(
  method: string,
  pathname: string,
  statusOnly = "",
): TokenOperationAuditMatch | null {
  const p = stripTrailingSlash(pathname);
  if (method === "POST" && p === "/api/token") {
    return { action: "token.create", content: "API token creation", route: "/api/token/" };
  }
  if (method === "PUT" && p === "/api/token") {
    if (statusOnly !== "") {
      return { action: "token.status_update", content: "API token status update", route: "/api/token/" };
    }
    return { action: "token.update", content: "API token configuration update", route: "/api/token/" };
  }
  if (method === "POST" && p === "/api/token/batch") {
    return { action: "token.delete_batch", content: "API token batch deletion", route: "/api/token/batch" };
  }
  if (method === "POST" && p === "/api/token/batch/keys") {
    return { action: "token.key_view_batch", content: "API token batch key access", route: "/api/token/batch/keys" };
  }
  const key = p.match(/^\/api\/token\/([^/]+)\/key$/);
  if (method === "POST" && key) {
    return {
      action: "token.key_view",
      content: "API token key access",
      route: "/api/token/:id/key",
      idFromPath: pathIdIfPositive(key[1]),
    };
  }
  const del = p.match(/^\/api\/token\/([^/]+)$/);
  if (method === "DELETE" && del && del[1] !== "batch") {
    return {
      action: "token.delete",
      content: "API token deletion",
      route: "/api/token/:id",
      idFromPath: pathIdIfPositive(del[1]),
    };
  }
  return null;
}

export function tokenOperationAuditApplies(method: string, pathname: string, statusOnly = ""): boolean {
  return matchTokenOperationAudit(method, pathname, statusOnly) != null;
}

/** Original `auditResponseSuccess`. */
export function auditResponseSuccess(status: number, body: string): boolean {
  if (status >= 400) return false;
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const resp = JSON.parse(trimmed) as { success?: unknown };
      if (typeof resp.success === "boolean") return resp.success;
    } catch {
      /* body was not JSON */
    }
  }
  return status < 400;
}

/** Original `[]rune` truncate of `User-Agent` to 512. */
export function truncateAuditUserAgent(ua: string): string {
  return [...ua].slice(0, 512).join("");
}

/** Original `RecordAuditLog` unknown-role fallback. */
export function auditActorRole(role: number): number {
  if (role === ROLE_USER || role === ROLE_ADMIN || role === ROLE_ROOT) return role;
  return 0;
}

/**
 * Original `tokenBatchAuditParams`: `total`, `requested_ids` capped at 100,
 * `requested_ids_truncated` when over 100.
 */
export function tokenBatchAuditFields(ids: number[]): TokenAuditParams {
  const params: TokenAuditParams = {
    total: ids.length,
    requested_ids: ids.slice(0, 100),
  };
  if (ids.length > 100) params.requested_ids_truncated = true;
  return params;
}

/** Original UpdateToken `changed_fields` comparison after applying the write. */
export function tokenUpdateChangedFields(
  previous: {
    name: string;
    expired_time: number;
    remain_quota: number;
    unlimited_quota: number | boolean;
    model_limits_enabled: number | boolean;
    model_limits: string;
    allow_ips: string;
    group: string;
    cross_group_retry: number | boolean;
    auto_groups: string;
  },
  next: {
    name: string;
    expired_time: number;
    remain_quota: number;
    unlimited_quota: number | boolean;
    model_limits_enabled: number | boolean;
    model_limits: string;
    allow_ips: string;
    group: string;
    cross_group_retry: number | boolean;
    auto_groups: string;
  },
): string[] {
  const changed: string[] = [];
  const pairs: [string, unknown, unknown][] = [
    ["name", previous.name, next.name],
    ["expired_time", Number(previous.expired_time), Number(next.expired_time)],
    ["remain_quota", Number(previous.remain_quota), Number(next.remain_quota)],
    ["unlimited_quota", Boolean(previous.unlimited_quota), Boolean(next.unlimited_quota)],
    ["model_limits_enabled", Boolean(previous.model_limits_enabled), Boolean(next.model_limits_enabled)],
    ["model_limits", String(previous.model_limits || ""), String(next.model_limits || "")],
    ["allow_ips", String(previous.allow_ips || ""), String(next.allow_ips || "")],
    ["group", String(previous.group || ""), String(next.group || "")],
    ["cross_group_retry", Boolean(previous.cross_group_retry), Boolean(next.cross_group_retry)],
    ["auto_groups", String(previous.auto_groups || ""), String(next.auto_groups || "")],
  ];
  for (const [name, a, b] of pairs) {
    if (a !== b) changed.push(name);
  }
  return changed;
}

export function snapshotTokenAuditFields(row: TokenRow): {
  name: string;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: number;
  model_limits_enabled: number;
  model_limits: string;
  allow_ips: string;
  group: string;
  cross_group_retry: number;
  auto_groups: string;
} {
  return {
    name: row.name,
    expired_time: Number(row.expired_time),
    remain_quota: Number(row.remain_quota),
    unlimited_quota: Number(row.unlimited_quota) ? 1 : 0,
    model_limits_enabled: Number(row.model_limits_enabled) ? 1 : 0,
    model_limits: String(row.model_limits || ""),
    allow_ips: String(row.allow_ips || ""),
    group: String(row.group || ""),
    cross_group_retry: Number(row.cross_group_retry) ? 1 : 0,
    auto_groups: String(row.auto_groups || ""),
  };
}

export function beginTokenOperationAudit(req: Request, user: SessionUser): PendingTokenAudit | null {
  if (pendingByReq.has(req)) return pendingByReq.get(req) ?? null;
  const url = new URL(req.url);
  const matched = matchTokenOperationAudit(req.method, url.pathname, url.searchParams.get("status_only") || "");
  if (!matched) return null;
  const params: TokenAuditParams = {};
  if (matched.idFromPath != null) params.id = matched.idFromPath;
  const pending: PendingTokenAudit = {
    userId: user.id,
    username: user.username,
    actorRole: auditActorRole(user.role),
    authMethod: user.useAccessToken ? "access_token" : "session",
    action: matched.action,
    content: matched.content,
    route: matched.route,
    method: req.method,
    params,
    succeeded: false,
  };
  pendingByReq.set(req, pending);
  return pending;
}

export function tokenAuditParams(req: Request): TokenAuditParams {
  const pending = pendingByReq.get(req);
  if (!pending) {
    const params: TokenAuditParams = {};
    pendingByReq.set(req, {
      userId: 0,
      username: "",
      actorRole: 0,
      authMethod: "session",
      action: "",
      content: "",
      route: "",
      method: req.method,
      params,
      succeeded: false,
    });
    return params;
  }
  return pending.params;
}

export function setTokenAuditSucceeded(req: Request): void {
  const pending = pendingByReq.get(req);
  if (pending) pending.succeeded = true;
}

export function applyTokenBatchAuditParams(req: Request, ids: number[]): TokenAuditParams {
  const params = tokenAuditParams(req);
  Object.assign(params, tokenBatchAuditFields(ids));
  return params;
}

function encodeAuditOther(action: string, params: TokenAuditParams): string {
  const op: { action: string; params?: TokenAuditParams } = { action };
  if (Object.keys(params).length) op.params = params;
  return JSON.stringify({ op });
}

export async function finishTokenOperationAudit(
  store: Store,
  req: Request,
  res: Response,
  requestId: string,
): Promise<void> {
  const pending = pendingByReq.get(req);
  if (!pending || !pending.action) {
    pendingByReq.delete(req);
    return;
  }
  pendingByReq.delete(req);
  const body = await res.clone().text();
  let success = auditResponseSuccess(res.status, body);
  if (new TextEncoder().encode(body).length >= TOKEN_OPERATION_AUDIT_MAX_BODY) {
    success = res.status < 400 && pending.succeeded;
  }
  await store.audit(pending.userId, pending.username, AUDIT_CATEGORY_SECURITY, pending.content, clientIp(req), {
    actor_role: pending.actorRole,
    category: AUDIT_CATEGORY_SECURITY,
    action: pending.action,
    token_ref: "",
    auth_method: pending.authMethod,
    user_agent: truncateAuditUserAgent(req.headers.get("user-agent") || ""),
    method: pending.method,
    route: pending.route,
    status: res.status,
    success,
    request_id: requestId,
    other: encodeAuditOther(pending.action, pending.params),
  });
}
