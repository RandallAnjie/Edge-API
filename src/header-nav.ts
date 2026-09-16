import { parseJson } from "./constants.js";
import { isResponse, tryUserAuth, userAuth } from "./auth.js";
import { json } from "./http.js";
import type { Context } from "./router.js";
import type { Store } from "./store.js";
import type { Env, SessionUser } from "./types.js";

export type HeaderNavAccess = {
  enabled: boolean;
  requireAuth: boolean;
};

const FALLBACK_ACCESS: HeaderNavAccess = { enabled: true, requireAuth: false };

function parseHeaderNavBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "1":
        return true;
      case "false":
      case "0":
        return false;
      default:
        return fallback;
    }
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  return fallback;
}

/** Original `middleware.parseHeaderNavAccess`. */
export function parseHeaderNavAccess(raw: unknown, fallback: HeaderNavAccess = FALLBACK_ACCESS): HeaderNavAccess {
  if (typeof raw === "boolean" || typeof raw === "string" || typeof raw === "number") {
    return { enabled: parseHeaderNavBool(raw, fallback.enabled), requireAuth: fallback.requireAuth };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const access = { ...fallback };
    if ("enabled" in value) access.enabled = parseHeaderNavBool(value.enabled, fallback.enabled);
    if ("requireAuth" in value) access.requireAuth = parseHeaderNavBool(value.requireAuth, fallback.requireAuth);
    return access;
  }
  return fallback;
}

/** Original `middleware.getHeaderNavAccess`. */
export async function getHeaderNavAccess(store: Store, module: string): Promise<HeaderNavAccess> {
  const raw = (await store.option("HeaderNavModules")).trim();
  if (!raw) return { ...FALLBACK_ACCESS };
  const parsed = parseJson<Record<string, unknown>>(raw, null as unknown as Record<string, unknown>);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...FALLBACK_ACCESS };
  return parseHeaderNavAccess(parsed[module], FALLBACK_ACCESS);
}

async function requireDashboardUser(c: Context<Env>, store: Store): Promise<SessionUser | Response> {
  return userAuth(c, store);
}

/**
 * Original `middleware.HeaderNavModuleAuth`.
 * Disabled → 403 `{success:false,message:"{module} is disabled"}`.
 * requireAuth → `UserAuth` JSON. Otherwise `TryUserAuth`.
 */
export async function headerNavModuleAuth(
  c: Context<Env>,
  store: Store,
  module: string,
): Promise<SessionUser | null | Response> {
  const access = await getHeaderNavAccess(store, module);
  if (!access.enabled) return json(403, { success: false, message: `${module} is disabled` });
  if (access.requireAuth) return requireDashboardUser(c, store);
  return tryUserAuth(c, store);
}

/**
 * Original `middleware.HeaderNavModulePublicOrUserAuth`.
 * Disabled or requireAuth → `UserAuth` JSON. Otherwise `TryUserAuth`.
 */
export async function headerNavModulePublicOrUserAuth(
  c: Context<Env>,
  store: Store,
  module: string,
): Promise<SessionUser | null | Response> {
  const access = await getHeaderNavAccess(store, module);
  if (!access.enabled || access.requireAuth) return requireDashboardUser(c, store);
  return tryUserAuth(c, store);
}

export function isHeaderNavDenied(value: SessionUser | null | Response): value is Response {
  return isResponse(value);
}
