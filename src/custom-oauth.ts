import { nowSec } from "./constants.js";
import { apiFail, apiOk, readJson } from "./http.js";
import type { OAuthProfile } from "./oauth.js";
import type { Context } from "./router.js";
import type { Store } from "./store.js";
import type { Env } from "./types.js";

/** Original `oauth.AuthStyle*`. */
export const AUTH_STYLE_AUTO = 0;
export const AUTH_STYLE_PARAMS = 1;
export const AUTH_STYLE_HEADER = 2;

const BUILTIN_SLUGS = new Set(["github", "discord", "linuxdo", "oidc", "telegram", "wechat"]);

const POLICY_OPS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "exists",
  "not_exists",
]);

export interface CustomOAuthProviderResponse {
  id: number;
  name: string;
  slug: string;
  icon: string;
  enabled: boolean;
  client_id: string;
  authorization_endpoint: string;
  token_endpoint: string;
  user_info_endpoint: string;
  scopes: string;
  user_id_field: string;
  username_field: string;
  display_name_field: string;
  email_field: string;
  well_known: string;
  auth_style: number;
  access_policy: string;
  access_denied_message: string;
}

export interface AccessPolicy {
  logic: string;
  conditions: AccessCondition[];
  groups: AccessPolicy[];
}

export interface AccessCondition {
  field: string;
  op: string;
  value: unknown;
}

export interface AccessPolicyFailure {
  field: string;
  op: string;
  expected: unknown;
  current: unknown;
}

export interface GjsonResult {
  exists: boolean;
  value: unknown;
}

/** Original `controller.toCustomOAuthProviderResponse` plus auth_url aliases from older rows. */
export function publicCustomOAuthProvider(row: Record<string, unknown>): CustomOAuthProviderResponse {
  return {
    id: Number(row.id) || 0,
    name: String(row.name || ""),
    slug: String(row.slug || ""),
    icon: String(row.icon || ""),
    enabled: Boolean(Number(row.enabled)),
    client_id: String(row.client_id || ""),
    authorization_endpoint: String(row.authorization_endpoint || row.auth_url || ""),
    token_endpoint: String(row.token_endpoint || row.token_url || ""),
    user_info_endpoint: String(row.user_info_endpoint || row.user_info_url || ""),
    scopes: String(row.scopes || ""),
    user_id_field: String(row.user_id_field || "sub"),
    username_field: String(row.username_field || "preferred_username"),
    display_name_field: String(row.display_name_field || "name"),
    email_field: String(row.email_field || "email"),
    well_known: String(row.well_known || ""),
    auth_style: Number(row.auth_style || 0),
    access_policy: String(row.access_policy || ""),
    access_denied_message: String(row.access_denied_message || ""),
  };
}

/** Original GetStatus `CustomOAuthInfo`. */
export function publicCustomOAuthStatus(row: Record<string, unknown>): Record<string, unknown> {
  const p = publicCustomOAuthProvider(row);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    icon: p.icon,
    client_id: p.client_id,
    authorization_endpoint: p.authorization_endpoint,
    scopes: p.scopes,
  };
}

export function isBuiltinOAuthSlug(slug: string): boolean {
  return BUILTIN_SLUGS.has(slug);
}

function pickStr(...values: unknown[]): string {
  for (const value of values) {
    if (value != null && value !== "") return String(value);
  }
  return "";
}

export function normalizeCustomOAuthWrite(
  body: Record<string, unknown>,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const authorization = pickStr(body.authorization_endpoint, body.auth_url, existing?.authorization_endpoint, existing?.auth_url);
  const token = pickStr(body.token_endpoint, body.token_url, existing?.token_endpoint, existing?.token_url);
  const userInfo = pickStr(body.user_info_endpoint, body.user_info_url, existing?.user_info_endpoint, existing?.user_info_url);
  const enabled = body.enabled == null ? (existing ? Number(existing.enabled) : 0) : Number(Boolean(body.enabled));
  const secret = String(body.client_secret ?? "");
  return {
    name: pickStr(body.name, existing?.name),
    slug: pickStr(body.slug, existing?.slug),
    icon: body.icon == null && existing ? String(existing.icon || "") : String(body.icon ?? ""),
    client_id: pickStr(body.client_id, existing?.client_id),
    client_secret: secret || String(existing?.client_secret || ""),
    authorization_endpoint: authorization,
    token_endpoint: token,
    user_info_endpoint: userInfo,
    auth_url: authorization,
    token_url: token,
    user_info_url: userInfo,
    scopes: pickStr(body.scopes, existing?.scopes),
    user_id_field: pickStr(body.user_id_field, existing?.user_id_field) || "sub",
    username_field: pickStr(body.username_field, existing?.username_field) || "preferred_username",
    display_name_field: pickStr(body.display_name_field, existing?.display_name_field) || "name",
    email_field: pickStr(body.email_field, existing?.email_field) || "email",
    well_known: body.well_known == null && existing ? String(existing.well_known || "") : String(body.well_known ?? ""),
    auth_style: body.auth_style == null && existing ? Number(existing.auth_style || 0) : Number(body.auth_style || 0),
    access_policy: body.access_policy == null && existing ? String(existing.access_policy || "") : String(body.access_policy ?? ""),
    access_denied_message:
      body.access_denied_message == null && existing
        ? String(existing.access_denied_message || "")
        : String(body.access_denied_message ?? ""),
    enabled,
    updated_at: nowSec(),
  };
}

/** Original `tidwall/gjson.Get` dotted-path subset used by custom OAuth field maps and access policy. */
export function gjsonGet(source: unknown, path: string): GjsonResult {
  const raw = typeof source === "string" ? source : JSON.stringify(source ?? null);
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { exists: false, value: undefined };
  }
  const trimmed = path.trim();
  if (!trimmed) return { exists: true, value: root };
  const parts = trimmed.split(".");
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null) return { exists: false, value: undefined };
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { exists: false, value: undefined };
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return { exists: false, value: undefined };
    if (!(part in cur)) return { exists: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { exists: true, value: cur };
}

export function gjsonString(source: unknown, path: string): string {
  const result = gjsonGet(source, path);
  if (!result.exists || result.value == null) return "";
  if (typeof result.value === "string") return result.value;
  if (typeof result.value === "number" || typeof result.value === "boolean") return String(result.value);
  try {
    return JSON.stringify(result.value);
  } catch {
    return String(result.value);
  }
}

export function parseAccessPolicy(raw: string): AccessPolicy {
  const parsed = JSON.parse(raw) as AccessPolicy;
  validateAccessPolicy(parsed);
  return parsed;
}

export function validateAccessPolicy(policy: AccessPolicy): void {
  const logic = String(policy.logic || "and").trim().toLowerCase();
  if (logic !== "and" && logic !== "or") throw new Error(`unsupported policy logic: ${logic}`);
  policy.logic = logic;
  policy.conditions = Array.isArray(policy.conditions) ? policy.conditions : [];
  policy.groups = Array.isArray(policy.groups) ? policy.groups : [];
  if (!policy.conditions.length && !policy.groups.length) throw new Error("policy requires at least one condition or group");
  policy.conditions.forEach((cond, index) => {
    cond.field = String(cond.field || "").trim();
    if (!cond.field) throw new Error(`condition[${index}].field is required`);
    cond.op = String(cond.op || "").trim().toLowerCase();
    if (!POLICY_OPS.has(cond.op)) throw new Error(`condition[${index}].op is unsupported: ${cond.op}`);
    if ((cond.op === "in" || cond.op === "not_in") && !Array.isArray(cond.value)) {
      throw new Error(`condition[${index}].value must be an array for op ${cond.op}`);
    }
  });
  policy.groups.forEach((group, index) => {
    try {
      validateAccessPolicy(group);
    } catch (err) {
      throw new Error(`invalid policy group[${index}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function evaluateAccessPolicy(body: unknown, policy: AccessPolicy): { allowed: boolean; failure: AccessPolicyFailure | null } {
  const logic = (policy.logic || "and").toLowerCase();
  if (logic === "or") {
    let first: AccessPolicyFailure | null = null;
    for (const cond of policy.conditions || []) {
      const { ok, failure } = evaluateAccessCondition(body, cond);
      if (ok) return { allowed: true, failure: null };
      if (!first) first = failure;
    }
    for (const group of policy.groups || []) {
      const nested = evaluateAccessPolicy(body, group);
      if (nested.allowed) return { allowed: true, failure: null };
      if (!first) first = nested.failure;
    }
    return { allowed: false, failure: first };
  }
  for (const cond of policy.conditions || []) {
    const { ok, failure } = evaluateAccessCondition(body, cond);
    if (!ok) return { allowed: false, failure };
  }
  for (const group of policy.groups || []) {
    const nested = evaluateAccessPolicy(body, group);
    if (!nested.allowed) return nested;
  }
  return { allowed: true, failure: null };
}

function evaluateAccessCondition(body: unknown, cond: AccessCondition): { ok: boolean; failure: AccessPolicyFailure } {
  const result = gjsonGet(body, cond.field);
  const current = result.exists ? result.value : undefined;
  const failure: AccessPolicyFailure = { field: cond.field, op: cond.op, expected: cond.value, current };
  switch (cond.op) {
    case "exists":
      return { ok: result.exists, failure };
    case "not_exists":
      return { ok: !result.exists, failure };
    case "eq":
      return { ok: compareAny(current, cond.value) === 0, failure };
    case "ne":
      return { ok: compareAny(current, cond.value) !== 0, failure };
    case "gt":
      return { ok: compareAny(current, cond.value) > 0, failure };
    case "gte":
      return { ok: compareAny(current, cond.value) >= 0, failure };
    case "lt":
      return { ok: compareAny(current, cond.value) < 0, failure };
    case "lte":
      return { ok: compareAny(current, cond.value) <= 0, failure };
    case "in":
      return { ok: valueInSlice(current, cond.value), failure };
    case "not_in":
      return { ok: !valueInSlice(current, cond.value), failure };
    case "contains":
      return { ok: containsValue(current, cond.value), failure };
    case "not_contains":
      return { ok: !containsValue(current, cond.value), failure };
    default:
      return { ok: false, failure };
  }
}

function compareAny(left: unknown, right: unknown): number {
  const lf = toFloat(left);
  const rf = toFloat(right);
  if (lf != null && rf != null) {
    if (lf < rf) return -1;
    if (lf > rf) return 1;
    return 0;
  }
  const ls = String(left ?? "").trim();
  const rs = String(right ?? "").trim();
  if (ls < rs) return -1;
  if (ls > rs) return 1;
  return 0;
}

function toFloat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function valueInSlice(current: unknown, expected: unknown): boolean {
  if (!Array.isArray(expected)) return false;
  return expected.some((item) => compareAny(current, item) === 0);
}

function containsValue(current: unknown, expected: unknown): boolean {
  if (typeof current === "string") return current.includes(String(expected ?? "").trim());
  if (Array.isArray(current)) return current.some((item) => compareAny(item, expected) === 0);
  return false;
}

export function renderAccessDeniedMessage(
  template: string,
  providerName: string,
  body: unknown,
  failure: AccessPolicyFailure | null,
): string {
  const defaultMessage = "Access denied: your account does not meet this provider's access requirements.";
  let message = (template || "").trim();
  if (!message) return defaultMessage;
  const fail = failure || { field: "", op: "", expected: "", current: "" };
  const replacements: Record<string, string> = {
    "{{provider}}": providerName,
    "{{field}}": fail.field,
    "{{op}}": fail.op,
    "{{required}}": String(fail.expected ?? ""),
    "{{current}}": String(fail.current ?? ""),
  };
  for (const [key, value] of Object.entries(replacements)) message = message.split(key).join(value);
  message = message.replace(/\{\{current\.([^}]+)\}\}/g, (_, path: string) => gjsonString(body, path.trim()));
  message = message.replace(/\{\{required\.([^}]+)\}\}/g, (_, path: string) =>
    fail.field === path.trim() ? String(fail.expected ?? "") : "",
  );
  return message.trim();
}

export async function exchangeCustom(
  provider: Record<string, unknown>,
  code: string,
  redirect: string,
): Promise<OAuthProfile> {
  const cfg = publicCustomOAuthProvider(provider);
  if (!code) throw new Error("无效的授权码");
  const values = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  let authStyle = cfg.auth_style;
  if (authStyle === AUTH_STYLE_AUTO) authStyle = AUTH_STYLE_PARAMS;
  if (authStyle === AUTH_STYLE_HEADER) {
    headers.authorization = `Basic ${btoa(`${cfg.client_id}:${String(provider.client_secret || "")}`)}`;
  } else {
    values.set("client_id", cfg.client_id);
    values.set("client_secret", String(provider.client_secret || ""));
  }
  const tokenRes = await fetch(cfg.token_endpoint, { method: "POST", headers, body: values });
  const raw = await tokenRes.text();
  let tokenJson: { access_token?: string; token_type?: string; error?: string; error_description?: string } = {};
  try {
    tokenJson = JSON.parse(raw) as typeof tokenJson;
  } catch {
    const parsed = new URLSearchParams(raw);
    tokenJson = {
      access_token: parsed.get("access_token") || "",
      token_type: parsed.get("token_type") || "",
    };
  }
  if (tokenJson.error) throw new Error(tokenJson.error_description || tokenJson.error);
  if (!tokenJson.access_token) throw new Error("OAuth 授权失败");
  const tokenType = !tokenJson.token_type || tokenJson.token_type.toLowerCase() === "bearer" ? "Bearer" : tokenJson.token_type;
  const userRes = await fetch(cfg.user_info_endpoint, {
    headers: { authorization: `${tokenType} ${tokenJson.access_token}`, accept: "application/json" },
  });
  if (!userRes.ok) throw new Error("无法读取 OAuth 用户");
  const bodyText = await userRes.text();
  let userId = gjsonString(bodyText, cfg.user_id_field);
  if (!userId) {
    const asRaw = gjsonGet(bodyText, cfg.user_id_field);
    if (asRaw.exists && asRaw.value != null) userId = String(asRaw.value).replace(/^"|"$/g, "");
  }
  if (!userId) throw new Error("无法读取 OAuth 用户");
  const policyRaw = cfg.access_policy.trim();
  if (policyRaw) {
    let policy: AccessPolicy;
    try {
      policy = parseAccessPolicy(policyRaw);
    } catch {
      throw new Error("invalid access policy configuration");
    }
    const { allowed, failure } = evaluateAccessPolicy(bodyText, policy);
    if (!allowed) throw new Error(renderAccessDeniedMessage(cfg.access_denied_message, cfg.name, bodyText, failure));
  }
  const username = gjsonString(bodyText, cfg.username_field);
  const displayName = gjsonString(bodyText, cfg.display_name_field);
  const email = gjsonString(bodyText, cfg.email_field);
  return {
    id: userId,
    username: (username || `oauth_${userId}`).slice(0, 20),
    display_name: displayName || username || userId,
    email: email || undefined,
    field: "oidc_id",
    slug: cfg.slug,
    provider_id: cfg.id,
  };
}

export async function fetchCustomOAuthDiscovery(body: { well_known_url?: string; issuer_url?: string; url?: string }): Promise<Response> {
  const wellKnownURL = (body.well_known_url || body.url || "").trim();
  const issuerURL = (body.issuer_url || "").trim();
  if (!wellKnownURL && !issuerURL) return apiFail("请先填写 Discovery URL 或 Issuer URL");
  let targetURL = wellKnownURL || `${issuerURL.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  targetURL = targetURL.trim();
  let parsed: URL;
  try {
    parsed = new URL(targetURL);
  } catch {
    return apiFail("Discovery URL 无效，仅支持 http/https");
  }
  if (!parsed.host || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return apiFail("Discovery URL 无效，仅支持 http/https");
  }
  try {
    const res = await fetch(targetURL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = (await res.text()).trim().slice(0, 512);
      return apiFail(`获取 Discovery 配置失败: ${text || res.statusText}`);
    }
    const discovery = (await res.json()) as Record<string, unknown>;
    return apiOk({ well_known_url: targetURL, discovery });
  } catch (err) {
    return apiFail(`获取 Discovery 配置失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function createCustomOAuthProvider(store: Store, body: Record<string, unknown>): Promise<Response> {
  const name = String(body.name || "").trim();
  const slug = String(body.slug || "").trim();
  const clientId = String(body.client_id || "").trim();
  const clientSecret = String(body.client_secret || "");
  const authorization = String(body.authorization_endpoint || body.auth_url || "").trim();
  const token = String(body.token_endpoint || body.token_url || "").trim();
  const userInfo = String(body.user_info_endpoint || body.user_info_url || "").trim();
  if (!name || !slug || !clientId || !clientSecret || !authorization || !token || !userInfo) {
    return apiFail("无效的请求参数");
  }
  if (await store.isOAuthSlugTaken(slug)) return apiFail("该 Slug 已被使用");
  if (isBuiltinOAuthSlug(slug)) return apiFail("该 Slug 与内置 OAuth 提供商冲突");
  if (body.access_policy) {
    try {
      parseAccessPolicy(String(body.access_policy));
    } catch (err) {
      return apiFail(`access_policy is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const row = normalizeCustomOAuthWrite(body);
  const id = await store.insertOAuthProvider(row);
  const saved = await store.getOAuthProvider(id);
  return apiOk(publicCustomOAuthProvider(saved || { ...row, id }), "创建成功");
}

export async function updateCustomOAuthProvider(store: Store, id: number, body: Record<string, unknown>): Promise<Response> {
  if (!Number.isInteger(id) || id <= 0) return apiFail("无效的 ID");
  const existing = await store.getOAuthProvider(id);
  if (!existing) return apiFail("未找到该 OAuth 提供商");
  const nextSlug = String(body.slug || existing.slug || "");
  if (nextSlug && nextSlug !== existing.slug) {
    if (await store.isOAuthSlugTaken(nextSlug, id)) return apiFail("该 Slug 已被使用");
    if (isBuiltinOAuthSlug(nextSlug)) return apiFail("该 Slug 与内置 OAuth 提供商冲突");
  }
  if (body.access_policy) {
    try {
      parseAccessPolicy(String(body.access_policy));
    } catch (err) {
      return apiFail(`access_policy is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const row = normalizeCustomOAuthWrite(body, existing);
  await store.updateOAuthProvider(id, row);
  const saved = await store.getOAuthProvider(id);
  return apiOk(publicCustomOAuthProvider(saved || { ...existing, ...row, id }), "更新成功");
}

export async function deleteCustomOAuthProvider(store: Store, id: number): Promise<Response> {
  if (!Number.isInteger(id) || id <= 0) return apiFail("无效的 ID");
  const existing = await store.getOAuthProvider(id);
  if (!existing) return apiFail("未找到该 OAuth 提供商");
  const count = await store.countOAuthBindings(id);
  if (count > 0) return apiFail("该 OAuth 提供商还有用户绑定，无法删除。请先解除所有用户绑定。");
  await store.deleteOAuthProvider(id);
  return apiOk(null, "删除成功");
}

export async function handleCustomOAuthDiscovery(c: Context<Env>): Promise<Response> {
  return fetchCustomOAuthDiscovery((await readJson(c.req)) as { well_known_url?: string; issuer_url?: string; url?: string });
}
