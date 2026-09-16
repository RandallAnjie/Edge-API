import {
  CHANNEL_ENABLED,
  ROLE_ROOT,
  USER_ENABLED,
  MAX_RECENT_ITEMS,
  canManageTargetRole,
  nowSec,
  parseJson,
  randomHex,
  generateVerificationCode,
  tokenModelLimitsMap,
} from "./constants.js";
import {
  generateBackupCodes,
  generateTotpSecret,
  generateQrCodeData,
  totpCode,
  twoFALocked,
  validateNumericCode,
  verifyTotp,
  verifyTwoFactorCode,
  ERR_VERIFICATION_FAILED,
  ERR_TWOFA_ALREADY_ENABLED,
  ERR_TWOFA_CODE_INVALID,
  ERR_TWOFA_NOT_ENABLED,
  ERR_TWOFA_SETUP_INVALID,
} from "./totp.js";
import { notifyAccountSecurityChange, sendMail, sixDigitCode, validateAccountEmail, normalizeEmail } from "./mail.js";
import { newChallenge, rpFromRequest, verifyAssertion } from "./passkey.js";
import {
  exchangeCustom,
  customOAuthRedirectUri,
  exchangeDiscord,
  discordRedirectUri,
  exchangeGithub,
  exchangeLinuxDO,
  exchangeOidc,
  linuxdoRedirectUri,
  oidcRedirectUri,
  getBoundOAuthUserId,
  loginOrBindOAuth,
  newAccessToken,
  oauthInvalidCodeMessage,
  oauthNotEnabledMessage,
  oauthProviderDisplayName,
  oauthProviderIsEnabled,
  oauthProviderKnown,
  OAuthI18nError,
  OAuthAccessDeniedError,
  type OAuthProfile,
} from "./oauth.js";
import { generateTokenKey, accessTokenFingerprint } from "./crypto.js";
import {
  ERR_TELEGRAM_BIND_ALREADY_BOUND,
  ERR_TELEGRAM_OAUTH_FAILED,
  authSessionIdentitiesEqual,
  authSessionIdentityJSON,
  exchangeTelegramOAuth,
  newTelegramOAuthFlow,
  telegramAuthorizationURL,
  telegramConfigurationError,
  TelegramOAuthError,
  type AuthSessionIdentityJSON,
  type TelegramOAuthFlow,
} from "./telegram-oauth.js";
import { publicToken, verificationRequirements, publicUserLogs, exposedRatioConfig, enrichModelMeta, publicModelMeta, publicTopup, publicVendor, publicPrefill, publicTask, publicRedemption, validateMetadataValues, vendorRecordVersion, containsGroupRatio } from "./dto.js";
import { billingCopies } from "./billing-setting.js";
import { DEFAULT_MODEL_RATIO_JSON } from "./ratio-defaults.js";
import { getModelPricingSnapshot, ModelPricingError, previewModelPricingConversion, previewModelPricingDescription, updateModelPricing, type ModelPricingChange } from "./model-pricing.js";
import {
  PasskeyDomainError,
  passkeyDomainHttpError,
  passkeySettingsSnapshot,
  selectPasskeyBeginRpIDs,
  updatePasskeyDomainOptions,
} from "./passkey-domains.js";
import { buildRankingsSnapshot } from "./rankings.js";
import { headerNavModuleAuth, isHeaderNavDenied } from "./header-nav.js";
import { paymentComplianceConfirmed, requirePaymentCompliance } from "./payments.js";
import {
  isActiveSubscription,
  normalizeBillingPreference,
  planFieldsFromBody,
  publicPlan,
  wrapPlan,
  wrapUserSubscription,
} from "./subscription.js";
import { bindVerificationOperation, issueSecurityProof } from "./security.js";
import {
  enqueueSystemTask,
  SYSTEM_TASK_TYPE_CHANNEL_TEST,
  systemTaskIdOf,
} from "./system-task.js";
import {
  createCustomOAuthProvider,
  deleteCustomOAuthProvider,
  publicCustomOAuthProvider,
  updateCustomOAuthProvider,
} from "./custom-oauth.js";
import { registerParity, sessionViews } from "./parity-routes.js";
import { goJSONKind, goUnmarshalJSON, parseChannelBatch, readChannelTagJSON } from "./channel-validate.js";
import { apiErrorMsg, apiFailCode, apiFailInvalidParams, apiOk, clientIp, i18nLang, i18nPair, json, MSG_PASSKEY_DISABLED, MSG_PASSKEY_INVALID_REQUEST, MSG_PASSKEY_NOT_BOUND, pageData, pageQuery, parsePasskeyFinishRequest, passkeyCredentialId, readJson, strconvAtoi, strconvParseBool, userCannotDeleteRootUserMessage, userEmailAlreadyTakenMessage, userNotExistsMessage, userPasswordResetLinkInvalidMessage, writeAuthSessionError, writeSecurityOperationError } from "./http.js";
import { turnstileCheck } from "./turnstile.js";
import { applyTokenBatchAuditParams, setTokenAuditSucceeded, tokenAuditParams } from "./token-operation-audit.js";
import { recordManageAudit, recordPasskeyDomainAudit, recordUserSecurityAudit } from "./admin-operation-audit.js";
import { emailVerificationRateLimit } from "./email-verification-rate-limit.js";
import type { Context } from "./router.js";
import type { Router } from "./router.js";
import {
  authenticateTokenReadOnly,
  dashboardIdentity,
  issueSessionSafe,
  isResponse,
  requireAdmin,
  requireBrowserSession,
  requireChannel,
  requireProof,
  requireRoot,
  requireUser,
  authRotationResponse,
  sessionResponse,
  sessionSecret,
  AUTH_FLOW_PURPOSE_LOGIN_PASSKEY,
  AUTH_FLOW_PURPOSE_PASSKEY_LOGIN,
  completeLoginVerification,
  requireLoginVerification,
  VERIFICATION_METHOD_PASSKEY,
  verifyLoginFromRequest,
} from "./auth.js";
import { httpStats } from "./metrics.js";
import { Store, publicUser } from "./store.js";
import { storeLogQuota } from "./quota.js";
import type { Env, SessionUser, UserRow } from "./types.js";

type C = Context<Env>;

function store(c: C): Store {
  return new Store(c.env.DB);
}

/** Original PrefillGroup `JSONValue` binding: omitted/null → empty (JSON `null`); otherwise raw JSON. */
function encodePrefillItems(items: unknown): string {
  if (items == null) return "";
  if (typeof items === "string") return items;
  return JSON.stringify(items);
}

/** Original `controller.vendorAPIError` HTTP 400 gin.H `{success,message}` (no `data`). */
function vendorAPIError(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  return json(400, { success: false, message });
}

type PrefillGroupBound = {
  id: number;
  name: string;
  type: string;
  items: unknown;
  description: string;
  created_time: number;
  updated_time: number;
};

type VendorBound = {
  id: number;
  name: string;
  description: string;
  icon: string;
  status: number;
  version: string;
  created_time: number;
  updated_time: number;
  rec: Record<string, unknown>;
};

function bindJSONStringField(
  rec: Record<string, unknown>,
  key: string,
  structName: string,
  fail: (message: string) => Response,
): string | Response {
  if (!(key in rec) || rec[key] == null) return "";
  if (typeof rec[key] !== "string") {
    return fail(
      `json: cannot unmarshal ${goJSONKind(rec[key])} into Go struct field ${structName}.${key} of type string`,
    );
  }
  return rec[key] as string;
}

function bindJSONIntField(
  rec: Record<string, unknown>,
  key: string,
  structName: string,
  typeName: string,
  fail: (message: string) => Response,
): number | Response {
  if (!(key in rec) || rec[key] == null) return 0;
  if (typeof rec[key] !== "number" || !Number.isFinite(rec[key]) || !Number.isInteger(rec[key])) {
    return fail(
      `json: cannot unmarshal ${goJSONKind(rec[key])} into Go struct field ${structName}.${key} of type ${typeName}`,
    );
  }
  return rec[key] as number;
}

/** Original `c.ShouldBindJSON` into `model.PrefillGroup`. Empty body is EOF; JSON `null` is a zero struct. */
async function bindPrefillGroup(req: Request): Promise<PrefillGroupBound | Response> {
  const fail = (message: string) => apiErrorMsg(message);
  const raw = await req.text();
  if (!raw.trim()) return fail("EOF");
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return fail(parsed.message);
  const zero: PrefillGroupBound = {
    id: 0,
    name: "",
    type: "",
    items: null,
    description: "",
    created_time: 0,
    updated_time: 0,
  };
  if (parsed.value === null) return zero;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return fail(`json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type model.PrefillGroup`);
  }
  const rec = parsed.value as Record<string, unknown>;
  const id = bindJSONIntField(rec, "id", "PrefillGroup", "int", fail);
  if (id instanceof Response) return id;
  const name = bindJSONStringField(rec, "name", "PrefillGroup", fail);
  if (name instanceof Response) return name;
  const type = bindJSONStringField(rec, "type", "PrefillGroup", fail);
  if (type instanceof Response) return type;
  const description = bindJSONStringField(rec, "description", "PrefillGroup", fail);
  if (description instanceof Response) return description;
  const created_time = bindJSONIntField(rec, "created_time", "PrefillGroup", "int64", fail);
  if (created_time instanceof Response) return created_time;
  const updated_time = bindJSONIntField(rec, "updated_time", "PrefillGroup", "int64", fail);
  if (updated_time instanceof Response) return updated_time;
  return {
    id,
    name,
    type,
    items: "items" in rec ? rec.items : null,
    description,
    created_time,
    updated_time,
  };
}

/** Original `c.ShouldBindJSON` into `model.Vendor`. Empty body is EOF; JSON `null` is a zero struct. */
async function bindVendor(req: Request): Promise<VendorBound | Response> {
  const fail = (message: string) => vendorAPIError(message);
  const raw = await req.text();
  if (!raw.trim()) return fail("EOF");
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return fail(parsed.message);
  const zero: VendorBound = {
    id: 0,
    name: "",
    description: "",
    icon: "",
    status: 0,
    version: "",
    created_time: 0,
    updated_time: 0,
    rec: {},
  };
  if (parsed.value === null) return zero;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return fail(`json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type model.Vendor`);
  }
  const rec = parsed.value as Record<string, unknown>;
  const id = bindJSONIntField(rec, "id", "Vendor", "int", fail);
  if (id instanceof Response) return id;
  const name = bindJSONStringField(rec, "name", "Vendor", fail);
  if (name instanceof Response) return name;
  const description = bindJSONStringField(rec, "description", "Vendor", fail);
  if (description instanceof Response) return description;
  const icon = bindJSONStringField(rec, "icon", "Vendor", fail);
  if (icon instanceof Response) return icon;
  const status = bindJSONIntField(rec, "status", "Vendor", "int", fail);
  if (status instanceof Response) return status;
  const version = bindJSONStringField(rec, "version", "Vendor", fail);
  if (version instanceof Response) return version;
  const created_time = bindJSONIntField(rec, "created_time", "Vendor", "int64", fail);
  if (created_time instanceof Response) return created_time;
  const updated_time = bindJSONIntField(rec, "updated_time", "Vendor", "int64", fail);
  if (updated_time instanceof Response) return updated_time;
  return { id, name, description, icon, status, version, created_time, updated_time, rec };
}

/** Original `AdminCompleteTopUp` ShouldBindJSON fail OR empty `TradeNo` → ApiErrorMsg `参数错误`. */
async function bindAdminCompleteTopup(req: Request): Promise<{ trade_no: string } | Response> {
  const invalid = () => apiErrorMsg("参数错误");
  const raw = await req.text();
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const rec = parsed.value as Record<string, unknown>;
  if ("trade_no" in rec && rec.trade_no != null && typeof rec.trade_no !== "string") return invalid();
  const trade_no = rec.trade_no == null ? "" : String(rec.trade_no);
  if (!trade_no) return invalid();
  return { trade_no };
}

/** Original `AdminCreateSubscriptionPlan` / `AdminUpdateSubscriptionPlan` ApiErrorMsg checks. */
async function subscriptionPlanFieldError(s: Store, fields: Record<string, unknown>): Promise<Response | undefined> {
  if (!String(fields.title || "").trim()) return apiErrorMsg("套餐标题不能为空");
  if (Number(fields.price_amount) < 0) return apiErrorMsg("价格不能为负数");
  if (Number(fields.price_amount) > 9999) return apiErrorMsg("价格不能超过9999");
  if (Number(fields.max_purchase_per_user) < 0) return apiErrorMsg("购买上限不能为负数");
  if (Number(fields.total_amount) < 0) return apiErrorMsg("总额度不能为负数");
  const upgrade = String(fields.upgrade_group || "").trim();
  if (upgrade && !(await containsGroupRatio(s, upgrade))) return apiErrorMsg("升级分组不存在");
  const downgrade = String(fields.downgrade_group || "").trim();
  if (downgrade && !(await containsGroupRatio(s, downgrade))) return apiErrorMsg("降级分组不存在");
  if (String(fields.quota_reset_period) === "custom" && Number(fields.quota_reset_custom_seconds) <= 0) {
    return apiErrorMsg("自定义重置周期需大于0秒");
  }
  return undefined;
}

async function passkeyLoginBeginSelection(
  s: Store,
  req: Request,
  hint: string,
  credentialRpId = "",
) {
  const settings = await passkeySettingsSnapshot(s);
  return selectPasskeyBeginRpIDs(settings, hint, rpFromRequest(req).rpId, credentialRpId);
}

/** Original `LoginPasskeyBegin` / `LoginPasskeyFinish` `common.DecodeJson` → ApiErrorMsg `参数错误`. */
async function decodeLoginPasskeyJSON(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    const raw = await req.text();
    if (!raw.trim()) return { ok: false, response: apiErrorMsg("参数错误") };
    body = JSON.parse(raw);
  } catch {
    return { ok: false, response: apiErrorMsg("参数错误") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, response: apiErrorMsg("参数错误") };
  return { ok: true, body: body as Record<string, unknown> };
}

function loginPasskeyStringField(body: Record<string, unknown>, key: string): { ok: true; value: string } | { ok: false; response: Response } {
  if (key in body && body[key] != null && typeof body[key] !== "string") return { ok: false, response: apiErrorMsg("参数错误") };
  return { ok: true, value: typeof body[key] === "string" ? body[key] : "" };
}

async function handlePasskeyDomainUpdate(
  c: C,
  s: Store,
  u: SessionUser,
  values: Record<string, string>,
  preview: boolean,
  confirmation: string,
): Promise<Response> {
  const secret = await sessionSecret(c.env, s);
  try {
    const change = await updatePasskeyDomainOptions(s, secret, values, preview, confirmation);
    if (!preview) {
      await recordPasskeyDomainAudit(s, c.req, u, change, confirmation !== "", null, 200);
    }
    return apiOk(change);
  } catch (e) {
    const res = passkeyDomainHttpError(e, c.req);
    if (!preview) {
      const change = e instanceof PasskeyDomainError ? e.change : undefined;
      await recordPasskeyDomainAudit(s, c.req, u, change, confirmation !== "", e, res.status);
    }
    return res;
  }
}

/** Original `model.PingDB` leftover HTTP 503 gin.H (no `data`). */
export const MSG_DB_CONNECTION_FAILED = "数据库连接失败";

/** Original `model.PingDB` 10s throttle. */
let lastDbPingMs = 0;

/** Reset PingDB throttle (tests). */
export function resetDbPingThrottle(): void {
  lastDbPingMs = 0;
}

export async function pingDb(db: Env["DB"]): Promise<void> {
  if (Date.now() - lastDbPingMs < 10_000) return;
  await db.prepare("SELECT 1").first();
  lastDbPingMs = Date.now();
}

/** Original `controller.UniversalVerify` DecodeJson into `service.VerificationInput`. */
function bindUniversalVerify(raw: unknown):
  | { ok: true; body: { method: string; scope: string; context?: unknown; code: string; password: string } }
  | { ok: false } {
  const parsed = raw === null ? {} : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const rec = parsed as Record<string, unknown>;
  const strField = (key: string): string | null => {
    if (!(key in rec) || rec[key] == null) return "";
    return typeof rec[key] === "string" ? rec[key] : null;
  };
  const method = strField("method");
  const scope = strField("scope");
  const code = strField("code");
  const password = strField("password");
  const passwordEncrypted = strField("password_encrypted");
  const encryptionKeyId = strField("encryption_key_id");
  if (
    method === null ||
    scope === null ||
    code === null ||
    password === null ||
    passwordEncrypted === null ||
    encryptionKeyId === null
  ) {
    return { ok: false };
  }
  return { ok: true, body: { method, scope, context: rec.context, code, password } };
}

export function registerMore(r: Router<Env>): void {
  r.get("/api/status/test", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    try {
      await pingDb(c.env.DB);
    } catch {
      return json(503, { success: false, message: MSG_DB_CONNECTION_FAILED });
    }
    return json(200, {
      success: true,
      message: "Server is running",
      http_stats: httpStats(),
    });
  });

  r.get("/api/rankings", async (c) => {
    const s = store(c);
    const gate = await headerNavModuleAuth(c, s, "rankings");
    if (isHeaderNavDenied(gate)) return gate;
    const period = c.url.searchParams.get("period") || "week";
    try {
      return json(200, { success: true, data: await buildRankingsSnapshot(s, period) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = Number((e as { status?: number }).status || 400);
      return json(status >= 400 ? status : 400, { success: false, message });
    }
  });

  r.get("/api/ratio_config", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("ExposeRatioEnabled", false))) return json(403, { success: false, message: "倍率配置接口未启用" });
    const modelRatio = parseJson(await s.option("ModelRatio"), {});
    const modelPrice = parseJson(await s.option("ModelPrice"), {});
    const billing = billingCopies({
      billingMode: parseJson(await s.option("billing_setting.billing_mode"), {}),
      billingExpr: parseJson(await s.option("billing_setting.billing_expr"), {}),
      modelRatio,
      modelPrice,
    });
    return apiOk(
      exposedRatioConfig({
        model_ratio: modelRatio,
        completion_ratio: parseJson(await s.option("CompletionRatio"), {}),
        cache_ratio: parseJson(await s.option("CacheRatio"), {}),
        create_cache_ratio: parseJson(await s.option("CreateCacheRatio"), {}),
        model_price: modelPrice,
        billing_mode: billing.billing_mode,
        billing_expr: billing.billing_expr,
      }),
    );
  });

  r.get("/api/verification", async (c) => {
    const limited = await emailVerificationRateLimit(c.env, c.req);
    if (limited) return limited;
    const s = store(c);
    const turnstileDenied = await turnstileCheck(s, c.req);
    if (turnstileDenied) return turnstileDenied;
    const validated = await validateAccountEmail(s, c.url.searchParams.get("email") || "");
    if (!validated.ok) {
      // Original `writeSecurityOperationError` for `ErrAccountEmailInvalid` / Restricted.
      return json(200, { success: false, code: validated.code, message: validated.message });
    }
    if (await s.getUserByEmail(validated.email, { includeDeleted: true })) {
      return apiErrorMsg(userEmailAlreadyTakenMessage(c.req));
    }
    const code = sixDigitCode();
    await s.insertEmailCode(validated.email, code, "verify");
    const systemName = (await s.option("SystemName")) || "New API";
    const subject = `${systemName}邮箱验证邮件`;
    const content =
      `<p>您好，你正在进行${systemName}邮箱验证。</p>` +
      `<p>您的验证码为: <strong>${code}</strong></p>` +
      `<p>验证码 10 分钟内有效，如果不是本人操作，请忽略。</p>`;
    try {
      await sendMail(s, validated.email, subject, content);
    } catch (err) {
      return apiErrorMsg(err instanceof Error ? err.message : String(err));
    }
    return json(200, { success: true, message: "" });
  });

  r.get("/api/reset_password", async (c) => {
    const s = store(c);
    const turnstileDenied = await turnstileCheck(s, c.req);
    if (turnstileDenied) return turnstileDenied;
    const email = normalizeEmail(c.url.searchParams.get("email") || "");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiFailInvalidParams(c.req);
    const user = await s.getUserByEmail(email);
    if (user) {
      const code = generateVerificationCode(0);
      await s.insertEmailCode(email, code, "reset");
      const systemName = (await s.option("SystemName")) || "New API";
      const server = (await s.option("ServerAddress")) || "";
      const link = `${server}/user/reset?email=${encodeURIComponent(email)}&token=${code}`;
      const subject = `${systemName}密码重置`;
      const content =
        `<p>您好，你正在进行${systemName}密码重置。</p>` +
        `<p>点击 <a href='${link}'>此处</a> 进行密码重置。</p>` +
        `<p>如果链接无法点击，请尝试点击下面的链接或将其复制到浏览器中打开：<br> ${link} </p>` +
        `<p>重置链接 10 分钟内有效，如果不是本人操作，请忽略。</p>`;
      try {
        await sendMail(s, email, subject, content);
      } catch {
        /* original logs send errors and still returns success */
      }
    }
    return json(200, { success: true, message: "" });
  });

  r.post("/api/user/reset", async (c) => {
    const s = store(c);
    const body = await bindPasswordResetRequest(c.req);
    if (body instanceof Response) return body;
    const email = normalizeEmail(body.email);
    const token = body.token;
    if (!email || !token) return apiFailInvalidParams(c.req);
    if (!(await s.verifyEmailCode(email, token, "reset"))) {
      return apiErrorMsg(userPasswordResetLinkInvalidMessage(c.req));
    }
    const user = await s.getUserByEmail(email);
    if (!user) return apiErrorMsg(userPasswordResetLinkInvalidMessage(c.req));
    const password = generateVerificationCode(12);
    const { hashPassword } = await import("./crypto.js");
    await s.updateUser(user.id, { password: await hashPassword(password) });
    await s.bumpAuthVersion(user.id);
    await s.consumeEmailCode(email, token, "reset");
    return apiOk(password, "");
  });

  r.post("/api/user/login/2fa", async (c) => verifyLoginFromRequest(store(c), c.env, c.req));

  r.get("/api/user/2fa/status", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    const enabled = Number(user?.totp_enabled) === 1;
    const backup = String(user?.totp_backup || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const data: Record<string, unknown> = { enabled, locked: enabled && twoFALocked(user || {}) };
    if (enabled) data.backup_codes_remaining = backup.length;
    return apiOk(data);
  });

  r.post("/api/user/2fa/setup", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "2fa.setup" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const existing = await s.getUserById(u.id);
    if (Number(existing?.totp_enabled) === 1) {
      return writeSecurityOperationError("TWOFA_ALREADY_ENABLED", ERR_TWOFA_ALREADY_ENABLED);
    }
    const secret = generateTotpSecret();
    const codes = generateBackupCodes();
    const flowToken = randomHex(16);
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({
      token: flowToken,
      type: "2fa_setup",
      user_id: u.id,
      expires_at: expiresAt,
      payload: JSON.stringify({ secret, backup_codes: codes }),
      session_id: proof.sessionId,
    });
    const issuer = (await s.option("SystemName")) || "New API";
    return apiOk({
      secret,
      qr_code_data: generateQrCodeData(secret, u.username, issuer),
      backup_codes: codes,
      flow_token: flowToken,
      expires_at: expiresAt,
    });
  });

  r.post("/api/user/2fa/enable", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return writeAuthSessionError(401, "AUTH_UNAUTHORIZED");
    let body: { code?: unknown; flow_token?: unknown };
    try {
      const raw = await c.req.text();
      if (!raw.trim()) return apiErrorMsg("参数错误");
      body = JSON.parse(raw) as { code?: unknown; flow_token?: unknown };
    } catch {
      return apiErrorMsg("参数错误");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiErrorMsg("参数错误");
    if ("code" in body && body.code != null && typeof body.code !== "string") return apiErrorMsg("参数错误");
    if ("flow_token" in body && body.flow_token != null && typeof body.flow_token !== "string") return apiErrorMsg("参数错误");
    const flowToken = typeof body.flow_token === "string" ? body.flow_token : "";
    const code = typeof body.code === "string" ? body.code : "";
    const twoFASetupInvalid = () => writeSecurityOperationError("TWOFA_SETUP_INVALID", ERR_TWOFA_SETUP_INVALID, 409);
    const flow = flowToken ? await s.getAuthFlow(flowToken) : null;
    if (
      !flow ||
      flow.type !== "2fa_setup" ||
      Number(flow.user_id) !== identity.userId ||
      String(flow.session_id || "") !== identity.sessionId ||
      flow.expires_at < nowSec() ||
      Number(flow.consumed_at || 0) > 0
    ) {
      return twoFASetupInvalid();
    }
    const payload = parseJson<{ secret?: string; backup_codes?: string[] }>(flow.payload, {});
    const secret = payload.secret || "";
    if (!secret) return twoFASetupInvalid();
    const numeric = validateNumericCode(code);
    if (!numeric || !(await verifyTotp(secret, numeric))) {
      return writeSecurityOperationError("TWOFA_CODE_INVALID", ERR_TWOFA_CODE_INVALID);
    }
    const consumed = await s.consumeAuthFlow(flowToken, {
      type: "2fa_setup",
      user_id: identity.userId,
      session_id: identity.sessionId,
    });
    if (consumed !== "ok") return twoFASetupInvalid();
    const user = await s.getUserById(identity.userId);
    if (!user) return writeAuthSessionError(401, "AUTH_UNAUTHORIZED");
    const backup = payload.backup_codes || generateBackupCodes();
    await s.updateUser(identity.userId, {
      totp_secret: secret,
      totp_enabled: 1,
      totp_backup: backup.join(","),
      totp_failed_attempts: 0,
      totp_locked_until: 0,
    });
    const fresh = await s.getUserById(identity.userId);
    const issued = await issueSessionSafe(s, c.env, fresh || user, c.req, "twofa_enabled", identity.sessionId);
    if (issued instanceof Response) return issued;
    return authRotationResponse(issued);
  });

  r.post("/api/user/2fa/disable", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "2fa.disable" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("用户不存在");
    if (Number(user.totp_enabled) !== 1) {
      return writeSecurityOperationError("TWOFA_NOT_ENABLED", ERR_TWOFA_NOT_ENABLED);
    }
    await s.updateUser(u.id, {
      totp_enabled: 0,
      totp_secret: "",
      totp_backup: "",
      totp_failed_attempts: 0,
      totp_locked_until: 0,
    });
    const fresh = await s.getUserById(u.id);
    const issued = await issueSessionSafe(s, c.env, fresh || user, c.req, "twofa_disabled", u.sid);
    if (issued instanceof Response) return issued;
    return authRotationResponse(issued, "两步验证已禁用");
  });

  r.post("/api/user/2fa/backup_codes", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "2fa.backup_codes.regenerate" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("用户不存在");
    if (Number(user.totp_enabled) !== 1) {
      return writeSecurityOperationError("TWOFA_NOT_ENABLED", ERR_TWOFA_NOT_ENABLED);
    }
    const codes = generateBackupCodes();
    await s.updateUser(u.id, { totp_backup: codes.join(",") });
    const issued = await issueSessionSafe(s, c.env, user, c.req, "twofa_backup_codes_regenerated", u.sid);
    if (issued instanceof Response) return issued;
    return authRotationResponse(issued, "备用码重新生成成功", { backup_codes: codes });
  });

  r.get("/api/user/2fa/stats", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const totals = await s.counts();
    const { results } = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE totp_enabled = 1").all<{ c: number }>();
    const enabled_users = Number(results[0]?.c || 0);
    const total_users = totals.users;
    const enabled_rate = `${((total_users > 0 ? (enabled_users / total_users) * 100 : 0).toFixed(1))}%`;
    return apiOk({ total_users, enabled_users, enabled_rate });
  });

  r.delete("/api/user/:id/2fa", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const parsed = strconvAtoi(c.params.id || "");
    if (!parsed.ok || parsed.n <= 0) return apiErrorMsg("用户ID格式错误");
    const target = await s.getUserById(parsed.n);
    if (!target) return apiErrorMsg(userNotExistsMessage(c.req));
    if (!canManageTargetRole(u.role, target.role)) return apiErrorMsg("无权操作同级或更高级用户的2FA设置");
    if (Number(target.totp_enabled) !== 1) return apiErrorMsg("用户未启用2FA");
    await s.updateUser(parsed.n, {
      totp_enabled: 0,
      totp_secret: "",
      totp_backup: "",
      totp_failed_attempts: 0,
      totp_locked_until: 0,
    });
    await s.bumpAuthVersion(parsed.n);
    await recordManageAudit(s, c.req, u, "user.2fa_disable", {}, parsed.n);
    return json(200, { success: true, message: "用户2FA已被强制禁用" });
  });

  r.get("/api/user/sessions", async (c) => {
    const s = store(c);
    const sess = await requireBrowserSession(c, s);
    if (isResponse(sess)) return sess;
    return apiOk(sessionViews(await s.listActiveUserSessions(sess.user.id, sess.identity.sessionId), sess.identity.sessionId));
  });

  r.delete("/api/user/sessions/:sid", async (c) => {
    const s = store(c);
    const sess = await requireBrowserSession(c, s);
    if (isResponse(sess)) return sess;
    const sid = (c.params.sid || "").trim();
    if (!sid) return json(400, { success: false, code: "AUTH_SESSION_ID_REQUIRED", message: "session id is required" });
    const existing = await s.getSession(sid);
    if (!existing || existing.user_id !== sess.user.id || existing.revoked) {
      return json(404, { success: false, code: "AUTH_SESSION_NOT_FOUND", message: "session not found" });
    }
    await s.revokeSession(sid, sess.user.id);
    return apiOk({ revoked_sid: sid, current: sid === sess.identity.sessionId });
  });

  r.post("/api/user/sessions/revoke-others", async (c) => {
    const s = store(c);
    const sess = await requireBrowserSession(c, s);
    if (isResponse(sess)) return sess;
    const count = await s.revokeOtherSessions(sess.user.id, sess.identity.sessionId);
    return apiOk({ revoked_count: count });
  });

  r.delete("/api/user/self", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "account.delete" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (u.role >= ROLE_ROOT) return apiErrorMsg(userCannotDeleteRootUserMessage(c.req));
    await s.softDeleteUser(u.id);
    return apiOk({});
  });

  r.get("/api/user/token", async (c) => generateUserAccessToken(c));
  r.post("/api/user/token", async (c) => generateUserAccessToken(c));

  r.get("/api/user/token/status", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    const token = user?.access_token || "";
    if (!token) return apiOk({ exists: false, token_ref: "", created_at: null, last_used_at: null, last_used_ip: "" });
    const token_ref = await accessTokenFingerprint(token);
    const last = await s.accessTokenLastUsed(u.id, token_ref);
    return apiOk({
      exists: true,
      token_ref,
      created_at: Number((user as { access_token_created_at?: number }).access_token_created_at || 0) || null,
      last_used_at: last.last_used_at,
      last_used_ip: last.last_used_ip,
    });
  });

  r.delete("/api/user/token", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "access_token.revoke" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const existing = await s.getUserById(u.id);
    const ref = await accessTokenFingerprint(existing?.access_token || "");
    await s.updateUser(u.id, { access_token: "", access_token_created_at: 0 });
    if (ref) {
      await recordUserSecurityAudit(s, c.req, u, "access_token.revoke", { token_ref: ref });
    }
    return apiOk(null);
  });

  r.get("/api/user/passkey", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const keys = await s.listPasskeys(u.id);
    if (!keys.length) return apiOk({ enabled: false });
    const last = Number(keys[0].last_used_at) || 0;
    return apiOk({
      enabled: true,
      last_used_at: last ? new Date(last * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    });
  });

  r.post("/api/user/passkey/register/begin", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiErrorMsg(MSG_PASSKEY_DISABLED);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const proof = await requireProof(c, s, { scope: "passkey.register" });
    if (isResponse(proof)) return proof;
    const ch = newChallenge();
    const rp = rpFromRequest(c.req);
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({ token: ch.id, type: "passkey_reg", user_id: u.id, expires_at: expiresAt, payload: ch.challenge });
    const options = {
      challenge: ch.challenge,
      rp: { id: rp.rpId, name: rp.name },
      user: { id: String(u.id), name: u.username, displayName: u.display_name || u.username },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 60000,
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    };
    return apiOk({
      options,
      flow_token: ch.id,
      expires_at: expiresAt,
    });
  });

  r.post("/api/user/passkey/register/finish", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiErrorMsg(MSG_PASSKEY_DISABLED);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const parsed = await parsePasskeyFinishRequest(c.req);
    if (!parsed.ok) return parsed.response;
    const flow = await s.getAuthFlow(parsed.flowToken);
    if (
      !flow ||
      flow.type !== "passkey_reg" ||
      Number(flow.user_id) !== u.id ||
      flow.expires_at < nowSec() ||
      Number(flow.consumed_at || 0) > 0
    ) {
      return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
    }
    const credentialId = passkeyCredentialId(parsed.credential);
    if (!credentialId) return writeAuthSessionError(500, "AUTH_INTERNAL_ERROR");
    const publicKey = JSON.stringify(parsed.credential);
    await s.insertPasskey(u.id, credentialId, publicKey, "passkey", rpFromRequest(c.req).rpId);
    await s.deleteAuthFlow(flow.token);
    const user = await s.getUserById(u.id);
    if (!user) return writeAuthSessionError(500, "AUTH_INTERNAL_ERROR");
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey_registered", u.sid);
    if (issued instanceof Response) return issued;
    return authRotationResponse(issued, "Passkey 注册成功");
  });

  r.post("/api/user/passkey/login/begin", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiErrorMsg(MSG_PASSKEY_DISABLED);
    let body: { rp_id?: string } = {};
    try {
      body = (await readJson(c.req)) as { rp_id?: string };
    } catch {
      return apiErrorMsg(MSG_PASSKEY_INVALID_REQUEST);
    }
    let selected: { rpId: string; rp_ids: string[] };
    try {
      selected = await passkeyLoginBeginSelection(s, c.req, body.rp_id || "");
    } catch (e) {
      return passkeyDomainHttpError(e, c.req);
    }
    const ch = newChallenge();
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({
      token: ch.id,
      type: AUTH_FLOW_PURPOSE_PASSKEY_LOGIN,
      user_id: 0,
      expires_at: expiresAt,
      payload: JSON.stringify({
        challenge: ch.challenge,
        rp_id: selected.rpId,
        user_verification: "required",
      }),
    });
    return apiOk({
      options: {
        challenge: ch.challenge,
        timeout: 60000,
        userVerification: "required",
        rpId: selected.rpId,
      },
      rp_ids: selected.rp_ids,
      flow_token: ch.id,
      expires_at: expiresAt,
    });
  });

  r.post("/api/user/passkey/login/finish", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiErrorMsg(MSG_PASSKEY_DISABLED);
    const parsed = await parsePasskeyFinishRequest(c.req);
    if (!parsed.ok) return parsed.response;
    const credentialId = passkeyCredentialId(parsed.credential);
    if (!credentialId) {
      return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    }
    const consumed = await s.consumeAuthFlow(parsed.flowToken, {
      type: AUTH_FLOW_PURPOSE_PASSKEY_LOGIN,
      user_id: 0,
    });
    if (consumed !== "ok") return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
    const flow = await s.getAuthFlow(parsed.flowToken);
    const session = parseJson<{ challenge?: string; rp_id?: string; user_verification?: string }>(flow?.payload || "", {});
    const challenge = session.challenge || (session.rp_id ? "" : flow?.payload || "");
    if (session.rp_id && session.user_verification !== "required") {
      return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
    }
    const pk = await s.getPasskeyByCred(credentialId);
    if (!pk) return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    const storedRpId = (pk as { rp_id?: string }).rp_id || "";
    if (storedRpId && session.rp_id && storedRpId !== session.rp_id) {
      return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    }
    const cred = parsed.credential as { response?: { clientDataJSON?: string; authenticatorData?: string; signature?: string } };
    const clientDataJSON = cred.response?.clientDataJSON || "";
    const authenticatorData = cred.response?.authenticatorData || "";
    const signature = cred.response?.signature || "";
    if (clientDataJSON && authenticatorData && signature) {
      const ok = await verifyAssertion({
        publicKeySpki: pk.public_key,
        clientDataJSON,
        authenticatorData,
        signature,
        expectedChallenge: challenge,
        expectedOrigin: new URL(c.req.url).origin,
      });
      if (!ok) return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    }
    const user = await s.getUserById(pk.user_id);
    if (!user || user.status !== USER_ENABLED) {
      return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    }
    await s.touchPasskey(pk.credential_id);
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey");
    if (issued instanceof Response) return issued;
    return sessionResponse(issued);
  });

  r.post("/api/user/login/passkey/begin", async (c) => {
    const s = store(c);
    const decoded = await decodeLoginPasskeyJSON(c.req);
    if (!decoded.ok) return decoded.response;
    const flowTokenField = loginPasskeyStringField(decoded.body, "flow_token");
    if (!flowTokenField.ok) return flowTokenField.response;
    const rpIdField = loginPasskeyStringField(decoded.body, "rp_id");
    if (!rpIdField.ok) return rpIdField.response;
    if (!flowTokenField.value) return apiErrorMsg("参数错误");
    const loaded = await requireLoginVerification(s, flowTokenField.value, VERIFICATION_METHOD_PASSKEY);
    if ("error" in loaded) return loaded.error;
    const keys = await s.listPasskeys(loaded.user.id);
    if (!keys.length) return writeSecurityOperationError("PASSKEY_NOT_FOUND", "No Passkey is registered.");
    let selected: { rpId: string; rp_ids: string[] };
    try {
      selected = await passkeyLoginBeginSelection(s, c.req, rpIdField.value, keys[0]?.rp_id || "");
    } catch (e) {
      return passkeyDomainHttpError(e, c.req);
    }
    const ch = newChallenge();
    const expiresAt = Math.min(nowSec() + 300, loaded.flow.expires_at);
    await s.insertAuthFlow({
      token: ch.id,
      type: AUTH_FLOW_PURPOSE_LOGIN_PASSKEY,
      user_id: loaded.user.id,
      expires_at: expiresAt,
      payload: JSON.stringify({
        challenge: ch.challenge,
        login_flow: flowTokenField.value,
        rp_id: selected.rpId,
        user_verification: "required",
      }),
    });
    return apiOk({
      flow_token: ch.id,
      expires_at: expiresAt,
      options: {
        challenge: ch.challenge,
        allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
        timeout: 60000,
        userVerification: "required",
        rpId: selected.rpId,
      },
      rp_ids: selected.rp_ids,
    });
  });

  r.post("/api/user/login/passkey/finish", async (c) => {
    const s = store(c);
    const decoded = await decodeLoginPasskeyJSON(c.req);
    if (!decoded.ok) return decoded.response;
    const flowTokenField = loginPasskeyStringField(decoded.body, "flow_token");
    if (!flowTokenField.ok) return flowTokenField.response;
    const passkeyFlowField = loginPasskeyStringField(decoded.body, "passkey_flow_token");
    if (!passkeyFlowField.ok) return passkeyFlowField.response;
    if (!flowTokenField.value || !passkeyFlowField.value || !("credential" in decoded.body)) {
      return apiErrorMsg("参数错误");
    }
    const loaded = await requireLoginVerification(s, flowTokenField.value, VERIFICATION_METHOD_PASSKEY);
    if ("error" in loaded) return loaded.error;
    const credentialId = passkeyCredentialId(decoded.body.credential);
    if (!credentialId) {
      return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    }
    const consumed = await s.consumeAuthFlow(passkeyFlowField.value, {
      type: AUTH_FLOW_PURPOSE_LOGIN_PASSKEY,
      user_id: loaded.user.id,
    });
    if (consumed !== "ok") return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
    const passkeyFlow = await s.getAuthFlow(passkeyFlowField.value);
    const session = parseJson<{ login_flow?: string; rp_id?: string; user_verification?: string }>(passkeyFlow?.payload || "", {});
    if (
      session.login_flow !== flowTokenField.value ||
      session.user_verification !== "required" ||
      !session.rp_id
    ) {
      return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
    }
    const keys = await s.listPasskeys(loaded.user.id);
    if (!keys.length) return writeSecurityOperationError("PASSKEY_NOT_FOUND", "No Passkey is registered.");
    const pk = keys.find((k) => k.credential_id === credentialId);
    if (!pk) return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    if (pk.rp_id && pk.rp_id !== session.rp_id) {
      return writeSecurityOperationError("SECURITY_VERIFICATION_FAILED", ERR_VERIFICATION_FAILED);
    }
    await s.touchPasskey(pk.credential_id);
    return completeLoginVerification(s, c.env, c.req, flowTokenField.value, VERIFICATION_METHOD_PASSKEY);
  });

  r.delete("/api/user/passkey", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "passkey.delete" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const keys = await s.listPasskeys(u.id);
    if (!keys.length) return writeSecurityOperationError("PASSKEY_NOT_FOUND", "No Passkey is registered.");
    await s.deletePasskeys(u.id);
    const user = await s.getUserById(u.id);
    if (!user) return writeAuthSessionError(500, "AUTH_INTERNAL_ERROR");
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey_deleted", u.sid);
    if (issued instanceof Response) return issued;
    return authRotationResponse(issued, "Passkey 已解绑");
  });

  r.delete("/api/user/:id/reset_passkey", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const parsed = strconvAtoi(c.params.id || "");
    if (!parsed.ok) return apiErrorMsg("无效的用户 ID");
    if (parsed.n === 0) return writeAuthSessionError(500, "AUTH_INTERNAL_ERROR");
    const target = await s.getUserById(parsed.n);
    if (!canManageTargetRole(u.role, target?.role ?? 0)) return apiErrorMsg("no permission");
    const keys = await s.listPasskeys(parsed.n);
    if (!keys.length) return apiErrorMsg(MSG_PASSKEY_NOT_BOUND);
    await s.deletePasskeys(parsed.n);
    await s.bumpAuthVersion(parsed.n);
    await recordManageAudit(
      s,
      c.req,
      u,
      "user.reset_passkey",
      { username: target?.username ?? "", id: parsed.n },
      parsed.n,
    );
    return json(200, { success: true, message: "Passkey 已重置" });
  });

  r.post("/api/user/aff_transfer", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const q = bindTransferAffQuota(c.req, await c.req.text());
    if (q instanceof Response) return q;
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("record not found");
    const min = await s.optionNum("QuotaPerUnit", 500000);
    if (q < min) {
      const inner = `转移额度最小为${await storeLogQuota(s, min)}！`;
      return apiErrorMsg(i18nPair(c.req, `划转失败 ${inner}`, `Transfer failed ${inner}`));
    }
    if ((user.aff_quota || 0) < q) {
      return apiErrorMsg(i18nPair(c.req, "划转失败 邀请额度不足！", "Transfer failed 邀请额度不足！"));
    }
    await s.updateUser(u.id, { aff_quota: (user.aff_quota || 0) - q });
    await s.addQuota(u.id, q);
    return apiOk(null, i18nPair(c.req, "划转成功", "Transfer successful"));
  });

  r.put("/api/user/setting", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = bindUpdateUserSetting(c.req, await c.req.text());
    if (body instanceof Response) return body;
    const notify = body.notify_type;
    if (!["email", "webhook", "bark", "gotify"].includes(notify)) {
      return apiErrorMsg(i18nPair(c.req, "无效的预警类型", "Invalid warning type"));
    }
    if (body.quota_warning_threshold <= 0) {
      return apiErrorMsg(i18nPair(c.req, "预警阈值必须大于0", "Warning threshold must be greater than 0"));
    }
    if (notify === "webhook") {
      if (!body.webhook_url) return apiErrorMsg(i18nPair(c.req, "Webhook地址不能为空", "Webhook URL cannot be empty"));
      if (!parseRequestURI(body.webhook_url)) {
        return apiErrorMsg(i18nPair(c.req, "无效的Webhook地址", "Invalid Webhook URL"));
      }
    }
    if (notify === "email" && body.notification_email && !body.notification_email.includes("@")) {
      return apiErrorMsg(i18nPair(c.req, "无效的邮箱地址", "Invalid email address"));
    }
    if (notify === "bark") {
      if (!body.bark_url) return apiErrorMsg(i18nPair(c.req, "Bark推送URL不能为空", "Bark push URL cannot be empty"));
      if (!parseRequestURI(body.bark_url)) {
        return apiErrorMsg(i18nPair(c.req, "无效的Bark推送URL", "Invalid Bark push URL"));
      }
      if (!body.bark_url.startsWith("http://") && !body.bark_url.startsWith("https://")) {
        return apiErrorMsg(i18nPair(c.req, "URL必须以http://或https://开头", "URL must start with http:// or https://"));
      }
    }
    if (notify === "gotify") {
      if (!body.gotify_url) {
        return apiErrorMsg(i18nPair(c.req, "Gotify服务器地址不能为空", "Gotify server URL cannot be empty"));
      }
      if (!body.gotify_token) return apiErrorMsg(i18nPair(c.req, "Gotify令牌不能为空", "Gotify token cannot be empty"));
      if (!parseRequestURI(body.gotify_url)) {
        return apiErrorMsg(i18nPair(c.req, "无效的Gotify服务器地址", "Invalid Gotify server URL"));
      }
      if (!body.gotify_url.startsWith("http://") && !body.gotify_url.startsWith("https://")) {
        return apiErrorMsg(i18nPair(c.req, "URL必须以http://或https://开头", "URL must start with http:// or https://"));
      }
    }
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("record not found");
    const existing = parseJson<Record<string, unknown>>(user.settings || "", {});
    const settings: Record<string, unknown> = {
      ...existing,
      notify_type: notify,
      quota_warning_threshold: body.quota_warning_threshold,
      accept_unset_model_ratio_model: body.accept_unset_model_ratio_model,
      record_ip_log: body.record_ip_log,
    };
    if (u.role >= 10 && body.upstream_model_update_notify_enabled != null) {
      settings.upstream_model_update_notify_enabled = body.upstream_model_update_notify_enabled;
    }
    if (notify === "webhook") {
      settings.webhook_url = body.webhook_url;
      if (body.webhook_secret) settings.webhook_secret = body.webhook_secret;
    }
    if (notify === "email" && body.notification_email) settings.notification_email = body.notification_email;
    if (notify === "bark") settings.bark_url = body.bark_url;
    if (notify === "gotify") {
      settings.gotify_url = body.gotify_url;
      settings.gotify_token = body.gotify_token;
      const p = body.gotify_priority;
      settings.gotify_priority = p < 0 || p > 10 ? 5 : p;
    }
    await s.updateUser(u.id, { settings: JSON.stringify(settings) });
    return apiOk(null, i18nPair(c.req, "设置已更新", "Settings updated"));
  });


  r.get("/api/user/topup/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    try {
      const { items, total } = await s.listTopups(u.id, q.offset, q.page_size, c.url.searchParams.get("keyword") || "");
      return apiOk(pageData((items as Record<string, unknown>[]).map(publicTopup), total, q));
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/user/topup", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    try {
      const { items, total } = await s.listTopups(null, q.offset, q.page_size, c.url.searchParams.get("keyword") || "");
      return apiOk(pageData((items as Record<string, unknown>[]).map(publicTopup), total, q));
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/user/topup/complete", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = await bindAdminCompleteTopup(c.req);
    if (isResponse(body)) return body;
    try {
      await s.manualCompleteTopUp(body.trade_no, clientIp(c.req));
      return apiOk(null);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/user/oauth/bindings", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("用户不存在");
    return apiOk(await s.listUserOAuthBindings(u.id));
  });

  r.delete("/api/user/oauth/bindings/:provider_id", async (c) => {
    const s = store(c);
    const providerId = strconvAtoi(c.params.provider_id);
    if (!providerId.ok || providerId.n <= 0) return apiErrorMsg("无效的提供商 ID");
    const proof = await requireProof(c, s, { scope: "account.binding.unbind", context: { provider_id: providerId.n } });
    if (isResponse(proof)) return proof;
    await s.deleteUserOAuthBinding(proof.userId, providerId.n);
    const user = await s.getUserById(proof.userId);
    const notification_warning = await notifyAccountSecurityChange(s, user?.email || "", "OAuth account unlinked");
    return apiOk({ notification_warning }, "解绑成功");
  });

  r.post("/api/oauth/state", async (c) => {
    const s = store(c);
    const body = await bindOAuthStateRequest(c.req);
    if (body instanceof Response) return body;
    const provider = body.provider.trim();
    const intent = body.intent.trim();
    const aff = body.aff.trim();
    if (!(await oauthProviderKnown(s, provider))) return apiFailInvalidParams(c.req);
    if (intent !== "login" && intent !== "bind" && intent !== "verify") return apiFailInvalidParams(c.req);
    if (aff.length > 32 || (intent !== "login" && aff)) return apiFailInvalidParams(c.req);
    if (intent !== "verify" && (body.scope !== "" || body.contextPresent)) return apiFailInvalidParams(c.req);
    let telegramFlow: TelegramOAuthFlow | undefined;
    if (provider === "telegram") {
      const started = await newTelegramOAuthFlow(s);
      if (!started.ok) return writeSecurityOperationError(started.code, started.message);
      telegramFlow = started.flow;
    }
    const identity = await dashboardIdentity(c, s);
    if ((intent === "bind" || intent === "verify") && !identity) {
      return json(401, { success: false, message: "绑定操作需要登录" });
    }
    const payload: Record<string, unknown> = { provider, intent, aff, affiliate_code: aff };
    if (telegramFlow) payload.telegram = telegramFlow;
    if (intent === "bind" && identity) {
      const proof = await requireProof(c, s, { scope: "account.binding.bind", context: { provider } });
      if (isResponse(proof)) return proof;
      payload.session_id = identity.sessionId;
      payload.session_identity = authSessionIdentityJSON(identity);
    }
    if (telegramFlow && (intent === "bind" || intent === "verify") && identity) {
      if (!(await s.validateAuthSession(identity))) {
        return json(401, { success: false, code: "AUTH_SESSION_REVOKED", message: "Unauthorized" });
      }
      payload.session_identity = authSessionIdentityJSON(identity);
    }
    if (intent === "verify" && identity) {
      const secret = await sessionSecret(c.env, s);
      const bound = await bindVerificationOperation(secret, { scope: body.scope || "", context: body.context });
      if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
      const user = await s.getUserById(identity.userId);
      if (!user) return apiErrorMsg("用户不存在");
      const providerUserId = await getBoundOAuthUserId(s, user, provider);
      if (!providerUserId) {
        return writeSecurityOperationError(
          "SECURITY_METHOD_UNAVAILABLE",
          "This verification method is currently unavailable.",
        );
      }
      payload.verification = {
        scope: bound.binding.scope,
        context_hash: bound.binding.contextHash,
        provider_user_id: providerUserId,
        auth_version: identity.userAuthVersion,
        session_version: identity.sessionVersion,
      };
    }
    const flow = randomHex(16);
    const expires = nowSec() + 600;
    await s.insertAuthFlow({
      token: flow,
      type: "oauth",
      user_id: identity?.userId || 0,
      expires_at: expires,
      payload: JSON.stringify(payload),
      session_id: identity?.sessionId || "",
    });
    const data: Record<string, unknown> = { flow_token: flow, expires_at: expires };
    if (telegramFlow) data.authorization_url = await telegramAuthorizationURL(telegramFlow, flow);
    return apiOk(data);
  });

  r.get("/api/oauth/:provider", async (c) => {
    const s = store(c);
    const provider = c.params.provider;
    if (!(await oauthProviderKnown(s, provider))) {
      return json(400, { success: false, message: i18nPair(c.req, "未知的 OAuth 提供商", "Unknown OAuth provider") });
    }
    const code = c.url.searchParams.get("code") || "";
    const state = c.url.searchParams.get("state") || "";
    const errorCode = c.url.searchParams.get("error");
    const identity = await dashboardIdentity(c, s);

    const flow = state ? await s.getAuthFlow(state) : null;
    if (!flow || flow.type !== "oauth" || flow.expires_at < nowSec() || Number(flow.consumed_at || 0) > 0) {
      return json(403, { success: false, message: i18nPair(c.req, "state 参数为空或不匹配", "State parameter is empty or mismatched") });
    }
    const payload = parseJson<{
      provider?: string;
      intent?: string;
      aff?: string;
      affiliate_code?: string;
      telegram?: TelegramOAuthFlow;
      session_identity?: AuthSessionIdentityJSON;
      verification?: { scope?: string; context_hash?: string; provider_user_id?: string; auth_version?: number; session_version?: number };
    }>(flow.payload, {});
    if (payload.provider && payload.provider !== provider) {
      return json(403, { success: false, message: i18nPair(c.req, "state 参数为空或不匹配", "State parameter is empty or mismatched") });
    }
    const intent = payload.intent || "login";
    if (
      (intent === "bind" || intent === "verify") &&
      (!identity || identity.userId !== flow.user_id || identity.sessionId !== String(flow.session_id || ""))
    ) {
      return json(403, { success: false, message: i18nPair(c.req, "state 参数为空或不匹配", "State parameter is empty or mismatched") });
    }
    if (provider === "telegram") {
      const configErr = await telegramConfigurationError(s);
      if (configErr) return writeSecurityOperationError(configErr.code, configErr.message);
      if (!payload.telegram?.code_verifier || !payload.telegram.client_id || !payload.telegram.redirect_uri) {
        return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
      }
      if (intent !== "login") {
        if (!identity || !authSessionIdentitiesEqual(payload.session_identity, identity)) {
          return writeSecurityOperationError("AUTH_FLOW_INVALID", "Verification flow expired");
        }
        if (!(await s.validateAuthSession(identity))) {
          return json(401, { success: false, code: "AUTH_SESSION_REVOKED", message: "Unauthorized" });
        }
      }
    }
    const consumeMatch = {
      type: "oauth" as const,
      user_id: Number(flow.user_id || 0),
      ...(intent === "login" ? {} : { session_id: identity?.sessionId || String(flow.session_id || "") }),
    };
    const stateInvalid = () =>
      json(403, { success: false, message: i18nPair(c.req, "state 参数为空或不匹配", "State parameter is empty or mismatched") });
    const consumeOrForbidden = async (): Promise<Response | null> => {
      const consumed = await s.consumeAuthFlow(state, consumeMatch);
      return consumed === "ok" ? null : stateInvalid();
    };

    if (!(await oauthProviderIsEnabled(s, provider))) {
      return apiErrorMsg(oauthNotEnabledMessage(c.req, await oauthProviderDisplayName(s, provider)));
    }
    if (errorCode) {
      const forbidden = await consumeOrForbidden();
      if (forbidden) return forbidden;
      return apiErrorMsg(c.url.searchParams.get("error_description") || errorCode);
    }

    const finishBind = async (profile: OAuthProfile): Promise<Response> => {
      if (!identity) return json(401, { success: false, message: "绑定操作需要登录" });
      const displayName = await oauthProviderDisplayName(s, provider);
      const alreadyBound = i18nPair(
        c.req,
        `该 ${displayName} 账户已被绑定`,
        `This ${displayName} account has already been bound`,
      );
      if (profile.field === "telegram_id") {
        const taken = await s.getUserByField("telegram_id", profile.id, { includeDeleted: true });
        if (taken) return apiErrorMsg(alreadyBound);
        const bound = await s.bindTelegramForSession(identity, profile.id);
        if (bound === "already_claimed") {
          return writeSecurityOperationError("TELEGRAM_BIND_ALREADY_BOUND", ERR_TELEGRAM_BIND_ALREADY_BOUND);
        }
        if (bound === "session_invalid") {
          return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
        }
      } else {
        const includeDeleted = profile.field !== "oidc_id";
        const taken = profile.provider_id
          ? await s.oauthBindingTaken(profile.provider_id, profile.id)
          : await s.getUserByField(profile.field, profile.id, { includeDeleted });
        const legacy = profile.extra?.legacy_id || "";
        const legacyTaken =
          legacy && !profile.provider_id ? await s.getUserByField(profile.field, legacy, { includeDeleted: true }) : null;
        if (taken || legacyTaken) return apiErrorMsg(alreadyBound);
        const bound = profile.provider_id
          ? await s.bindCustomOAuthForSession(identity, profile.provider_id, profile.id)
          : await s.bindUserColumnForSession(identity, profile.field, profile.id);
        if (bound === "already_claimed") {
          return writeSecurityOperationError("ACCOUNT_ALREADY_BOUND", "This external account is already bound.");
        }
        if (bound === "session_invalid") {
          return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
        }
        if (bound === "binding_changed") {
          return json(409, {
            success: false,
            code: "ACCOUNT_SECURITY_STATE_CHANGED",
            message: "Account bindings have changed. Start this operation again.",
          });
        }
      }
      const consumed = await s.consumeAuthFlow(state, consumeMatch);
      if (consumed !== "ok") await s.deleteAuthFlow(state);
      const user = await s.getUserById(identity.userId);
      const notification_warning = await notifyAccountSecurityChange(
        s,
        user?.email || "",
        "Login account linked: " + displayName,
      );
      return apiOk({ action: "bind", notification_warning }, i18nPair(c.req, "绑定成功", "Binding successful"));
    };

    const finish = async (profile: OAuthProfile) => {
      if (intent === "bind") return finishBind(profile);
      const forbidden = await consumeOrForbidden();
      if (forbidden) return forbidden;
      if (intent === "verify") {
        if (!identity) return json(401, { success: false, message: "绑定操作需要登录" });
        const verification = payload.verification;
        // Original `FinishOAuthVerification` → `ErrAuthTokenInvalid` → `writeAuthSessionError`.
        if (
          !verification ||
          !verification.context_hash ||
          verification.auth_version !== identity.userAuthVersion ||
          verification.session_version !== identity.sessionVersion
        ) {
          return writeAuthSessionError(401, "AUTH_UNAUTHORIZED");
        }
        const user = await s.getUserById(identity.userId);
        const expected = user ? await getBoundOAuthUserId(s, user, provider) : "";
        if (!expected) {
          return writeSecurityOperationError(
            "SECURITY_METHOD_UNAVAILABLE",
            "This verification method is currently unavailable.",
          );
        }
        if (!profile.id || profile.id !== expected || profile.id !== (verification.provider_user_id || "")) {
          return writeSecurityOperationError(
            "OAUTH_ACCOUNT_MISMATCH",
            "The OAuth account does not match the account linked to your profile.",
          );
        }
        const secret = await sessionSecret(c.env, s);
        const proof = await issueSecurityProof(s, secret, identity, "oauth", {
          scope: verification.scope || "",
          contextHash: verification.context_hash,
        });
        return apiOk(proof);
      }
      return loginOrBindOAuth(
        s,
        c.env,
        c.req,
        profile,
        null,
        "login",
        String(payload.affiliate_code || payload.aff || ""),
      );
    };

    try {
      if (provider === "github") {
        if (!code) return apiErrorMsg(oauthInvalidCodeMessage(c.req));
        return finish(await exchangeGithub(await s.option("GitHubClientId"), await s.option("GitHubClientSecret"), code));
      }
      if (provider === "discord") {
        if (!code) return apiErrorMsg(oauthInvalidCodeMessage(c.req));
        return finish(
          await exchangeDiscord({
            clientId: await s.option("DiscordClientId"),
            secret: await s.option("DiscordClientSecret"),
            code,
            redirect: discordRedirectUri(await s.option("ServerAddress")),
          }),
        );
      }
      if (provider === "linuxdo") {
        if (!code) return apiErrorMsg(oauthInvalidCodeMessage(c.req));
        return finish(
          await exchangeLinuxDO({
            clientId: await s.option("LinuxDOClientId"),
            secret: await s.option("LinuxDOClientSecret"),
            code,
            redirect: linuxdoRedirectUri(c.req),
            minimumTrustLevel: await s.optionNum("LinuxDOMinimumTrustLevel", 0),
            tokenUrl: c.env.LINUX_DO_TOKEN_ENDPOINT,
            userUrl: c.env.LINUX_DO_USER_ENDPOINT,
          }),
        );
      }
      if (provider === "oidc") {
        if (!code) return apiErrorMsg(oauthInvalidCodeMessage(c.req));
        return finish(
          await exchangeOidc({
            tokenUrl: await s.option("OIDCTokenEndpoint"),
            userInfoUrl: await s.option("OIDCUserinfoEndpoint"),
            clientId: await s.option("OIDCClientId"),
            secret: await s.option("OIDCClientSecret"),
            code,
            redirect: oidcRedirectUri(await s.option("ServerAddress")),
          }),
        );
      }
      if (provider === "telegram") {
        try {
          const telegramUser = await exchangeTelegramOAuth(s, code, payload.telegram!);
          return finish({
            id: telegramUser.id,
            username: telegramUser.username,
            display_name: telegramUser.display_name,
            field: "telegram_id",
          });
        } catch (e) {
          if (e instanceof TelegramOAuthError) return writeSecurityOperationError(e.code, e.message);
          return writeSecurityOperationError("TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);
        }
      }
      if (provider === "wechat") {
        return apiErrorMsg("请使用 /api/oauth/wechat");
      }
      const custom = await s.getOAuthProvider(provider);
      if (!custom) return json(400, { success: false, message: i18nPair(c.req, "未知的 OAuth 提供商", "Unknown OAuth provider") });
      if (!code) return apiErrorMsg(oauthInvalidCodeMessage(c.req));
      return finish(await exchangeCustom(custom, code, customOAuthRedirectUri(await s.option("ServerAddress"), provider)));
    } catch (e) {
      if (e instanceof OAuthAccessDeniedError) return apiErrorMsg(e.message);
      if (e instanceof OAuthI18nError) return apiErrorMsg(i18nPair(c.req, e.zh, e.en));
      // Original `handleOAuthError` default → `writeSecurityOperationError` unknown → `writeAuthSessionError`.
      return writeAuthSessionError(500, "AUTH_INTERNAL_ERROR");
    }
  });

  r.get("/api/token/search", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const maxTokens = await s.optionNum("token_setting.max_user_tokens", 1000);
    try {
      const { items, total } = await s.searchUserTokens(
        u.id,
        c.url.searchParams.get("keyword") || "",
        c.url.searchParams.get("token") || "",
        q.offset,
        q.page_size,
        maxTokens,
      );
      return apiOk(pageData(items.map(publicToken), total, q));
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/token/auto-groups", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const { userAutoGroups } = await import("./dto.js");
    return apiOk({
      groups: await userAutoGroups(s, u.group || "default"),
      max_count: await s.optionNum("MaxTokenAutoGroups", 5),
    });
  });

  r.post("/api/token/batch", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const ids = parseTokenBatchIds(c.req, await c.req.text());
    if (ids instanceof Response) return ids;
    applyTokenBatchAuditParams(c.req, ids);
    if (!ids.length) return apiFailInvalidParams(c.req);
    const n = await s.deleteTokensBatch(u.id, ids);
    tokenAuditParams(c.req).count = n;
    setTokenAuditSucceeded(c.req);
    return apiOk(n);
  });

  r.post("/api/token/batch/keys", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const ids = parseTokenBatchIds(c.req, await c.req.text());
    if (ids instanceof Response) return ids;
    applyTokenBatchAuditParams(c.req, ids);
    if (!ids.length) return apiFailInvalidParams(c.req);
    if (ids.length > 100) {
      return apiErrorMsg(i18nPair(c.req, "批量请求数量过多，最多 100 条", "Too many items in batch request, maximum is 100"));
    }
    const keys: Record<string, string> = {};
    const returnedIds: number[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      const t = await s.getTokenById(id, u.id);
      if (!t) continue;
      seen.add(id);
      keys[String(id)] = t.key;
      returnedIds.push(id);
    }
    const params = tokenAuditParams(c.req);
    params.count = returnedIds.length;
    params.returned_ids = returnedIds;
    setTokenAuditSucceeded(c.req);
    return apiOk({ keys });
  });

  r.get("/api/channel/test", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const { task, created } = await enqueueSystemTask(s, SYSTEM_TASK_TYPE_CHANNEL_TEST, {
      mode: "scheduled_all",
      notify: true,
    });
    if (!created) {
      return json(409, {
        success: false,
        message: "已有通道测试任务正在运行或等待中，不能启动本次手动任务",
        data: {
          task_id: systemTaskIdOf(task),
          status: String(task.status || "pending"),
          type: String(task.type || SYSTEM_TASK_TYPE_CHANNEL_TEST),
        },
      });
    }
    return apiOk({ task_id: systemTaskIdOf(task), status: String(task.status || "pending") });
  });

  r.post("/api/channel/batch", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    let body: unknown;
    try {
      body = await readJson(c.req);
    } catch {
      return apiErrorMsg("参数错误");
    }
    const parsed = parseChannelBatch(body);
    if (!parsed.ok) return apiErrorMsg("参数错误");
    try {
      const count = await s.deleteChannelsBatch(parsed.ids);
      await recordManageAudit(s, c.req, u, "channel.delete_batch", { count });
      return apiOk(count);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/channel/tag/enabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const bound = await readChannelTagJSON(c.req);
    if (!bound.ok) return apiErrorMsg("参数错误");
    await s.setChannelsByTag(bound.tag, CHANNEL_ENABLED);
    await recordManageAudit(s, c.req, u, "channel.tag_enable", { tag: bound.tag });
    return json(200, { success: true, message: "" });
  });

  r.get("/api/redemption/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    try {
      const { items, total } = await s.listRedemptions(
        q.offset,
        q.page_size,
        c.url.searchParams.get("keyword") || "",
        c.url.searchParams.get("status") || "",
      );
      return apiOk(pageData(items.map(publicRedemption), total, q));
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/redemption/batch", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const ids = bindRedemptionBatchIds(c.req, await c.req.text());
    if (ids instanceof Response) return ids;
    const count = await s.deleteRedemptionsBatch(ids);
    await recordManageAudit(s, c.req, u, "redemption.delete_batch", {
      count,
      total: ids.length,
      requested_redemption_ids: ids,
    });
    return apiOk(count);
  });

  r.delete("/api/redemption/invalid", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.deleteInvalidRedemptions());
  });

  r.get("/api/usage/token", tokenUsage);
  r.get("/api/usage/token/", tokenUsage);

  r.get("/api/log/token", async (c) => {
    const s = store(c);
    const auth = await authenticateTokenReadOnly(c, s);
    if (auth instanceof Response) return auth;
    if (!auth.token.id) return apiErrorMsg("无效的令牌");
    try {
      const { items } = await s.listLogs({
        offset: 0,
        limit: MAX_RECENT_ITEMS,
        tokenId: auth.token.id,
        order: "id",
      });
      return apiOk(publicUserLogs(items, 0));
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/subscription/plans", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (!(await paymentComplianceConfirmed(s))) return apiOk([]);
    return apiOk((await s.listPlans(true)).map(wrapPlan));
  });

  r.get("/api/subscription/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    const now = nowSec();
    const all = (await s.listUserSubs(u.id)).map((row) => wrapUserSubscription(row, now));
    const subscriptions = (await s.listUserSubs(u.id))
      .filter((row) => isActiveSubscription(row, now))
      .map((row) => wrapUserSubscription(row, now));
    const setting = parseJson<Record<string, unknown>>(user?.settings || "", {});
    return apiOk({
      billing_preference: normalizeBillingPreference(user?.billing_preference || setting.billing_preference),
      subscriptions,
      all_subscriptions: all,
    });
  });

  r.put("/api/subscription/self/preference", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const parsedPref = goUnmarshalJSON((await c.req.text()) || "");
    if (
      !parsedPref.ok ||
      parsedPref.value === null ||
      typeof parsedPref.value !== "object" ||
      Array.isArray(parsedPref.value)
    ) {
      return apiErrorMsg("参数错误");
    }
    const body = parsedPref.value as { billing_preference?: string };
    const pref = normalizeBillingPreference(body.billing_preference);
    const user = await s.getUserById(u.id);
    const settings = parseJson<Record<string, unknown>>(user?.settings || "", {});
    settings.billing_preference = pref;
    await s.updateUser(u.id, { billing_preference: pref, settings: JSON.stringify(settings) });
    return apiOk({ billing_preference: pref });
  });

  r.post("/api/subscription/balance/pay", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const parsedPay = goUnmarshalJSON((await c.req.text()) || "");
    if (
      !parsedPay.ok ||
      parsedPay.value === null ||
      typeof parsedPay.value !== "object" ||
      Array.isArray(parsedPay.value)
    ) {
      return apiErrorMsg("参数错误");
    }
    const body = parsedPay.value as { plan_id?: number };
    if (typeof body.plan_id !== "number" || !Number.isInteger(body.plan_id) || body.plan_id <= 0) {
      return apiErrorMsg("参数错误");
    }
    const plan = await s.getPlan(body.plan_id);
    if (!plan || !publicPlan(plan).enabled) return apiErrorMsg("套餐未启用");
    const published = publicPlan(plan);
    if (published.allow_balance_pay === false) return apiErrorMsg("该套餐不允许使用余额兑换");
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("用户不存在");
    const quotaPerUnit = await s.optionNum("QuotaPerUnit", 500000);
    const price = Math.ceil(Number(published.price_amount || 0) * quotaPerUnit);
    if (user.quota < price) return apiErrorMsg("余额不足");
    if (price) await s.addQuota(u.id, -price);
    try {
      await s.createUserSubscriptionFromPlan(u.id, plan, "balance");
    } catch (err) {
      if (price) await s.addQuota(u.id, price);
      return apiErrorMsg(err instanceof Error ? err.message : String(err));
    }
    return apiOk(null);
  });

  r.get("/api/subscription/admin/plans", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk((await s.listPlans(false)).map(wrapPlan));
  });

  r.post("/api/subscription/admin/plans", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const parsedPlan = goUnmarshalJSON((await c.req.text()) || "");
    if (
      !parsedPlan.ok ||
      parsedPlan.value === null ||
      typeof parsedPlan.value !== "object" ||
      Array.isArray(parsedPlan.value)
    ) {
      return apiErrorMsg("参数错误");
    }
    const fields = planFieldsFromBody(parsedPlan.value as Record<string, unknown>);
    const fieldErr = await subscriptionPlanFieldError(s, fields);
    if (fieldErr) return fieldErr;
    const id = await s.insertPlan(fields);
    const created = await s.getPlan(id);
    return apiOk(created ? publicPlan(created) : { id });
  });

  r.put("/api/subscription/admin/plans/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const id = strconvAtoi(c.params.id);
    if (!id.ok || id.n <= 0) return apiErrorMsg("无效的ID");
    const parsedPlan = goUnmarshalJSON((await c.req.text()) || "");
    if (
      !parsedPlan.ok ||
      parsedPlan.value === null ||
      typeof parsedPlan.value !== "object" ||
      Array.isArray(parsedPlan.value)
    ) {
      return apiErrorMsg("参数错误");
    }
    const fields = planFieldsFromBody(parsedPlan.value as Record<string, unknown>);
    const fieldErr = await subscriptionPlanFieldError(s, fields);
    if (fieldErr) return fieldErr;
    fields.updated_at = nowSec();
    await s.updatePlan(id.n, fields);
    return apiOk(null);
  });

  r.patch("/api/subscription/admin/plans/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const id = strconvAtoi(c.params.id);
    if (!id.ok || id.n <= 0) return apiErrorMsg("无效的ID");
    const parsedStatus = goUnmarshalJSON((await c.req.text()) || "");
    if (
      !parsedStatus.ok ||
      parsedStatus.value === null ||
      typeof parsedStatus.value !== "object" ||
      Array.isArray(parsedStatus.value) ||
      typeof (parsedStatus.value as { enabled?: unknown }).enabled !== "boolean"
    ) {
      return apiErrorMsg("参数错误");
    }
    const body = parsedStatus.value as { enabled: boolean };
    await s.updatePlan(id.n, { enabled: body.enabled ? 1 : 0, updated_at: nowSec() });
    return apiOk(null);
  });

  r.post("/api/subscription/admin/bind", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const parsedBind = goUnmarshalJSON((await c.req.text()) || "");
    if (
      !parsedBind.ok ||
      parsedBind.value === null ||
      typeof parsedBind.value !== "object" ||
      Array.isArray(parsedBind.value)
    ) {
      return apiErrorMsg("参数错误");
    }
    const body = parsedBind.value as { user_id?: number; plan_id?: number };
    if (
      typeof body.user_id !== "number" ||
      !Number.isInteger(body.user_id) ||
      body.user_id <= 0 ||
      typeof body.plan_id !== "number" ||
      !Number.isInteger(body.plan_id) ||
      body.plan_id <= 0
    ) {
      return apiErrorMsg("参数错误");
    }
    try {
      const result = await s.adminBindSubscription(body.user_id, body.plan_id);
      return apiOk(result.message ? { message: result.message } : null);
    } catch (err) {
      return apiErrorMsg(err instanceof Error ? err.message : String(err));
    }
  });

  r.get("/api/subscription/admin/users/:id/subscriptions", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const userId = strconvAtoi(c.params.id);
    if (!userId.ok || userId.n <= 0) return apiErrorMsg("无效的用户ID");
    const now = nowSec();
    return apiOk((await s.listUserSubs(userId.n)).map((row) => wrapUserSubscription(row, now)));
  });

  r.post("/api/subscription/admin/user_subscriptions/:id/invalidate", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok || id.n <= 0) return apiErrorMsg("无效的订阅ID");
    try {
      const msg = await s.adminInvalidateUserSubscription(id.n);
      return apiOk(msg ? { message: msg } : null);
    } catch (err) {
      return apiErrorMsg(err instanceof Error ? err.message : String(err));
    }
  });
  r.delete("/api/subscription/admin/user_subscriptions/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok || id.n <= 0) return apiErrorMsg("无效的订阅ID");
    try {
      const msg = await s.adminDeleteUserSubscription(id.n);
      return apiOk(msg ? { message: msg } : null);
    } catch (err) {
      return apiErrorMsg(err instanceof Error ? err.message : String(err));
    }
  });

  r.get("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const type = c.url.searchParams.get("type") || "";
    try {
      const items = ((await s.listPrefill(type)) as Record<string, unknown>[]).map(publicPrefill);
      return apiOk(items);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = await bindPrefillGroup(c.req);
    if (isResponse(body)) return body;
    if (!body.name || !body.type) return apiErrorMsg("组名称和类型不能为空");
    try {
      if (await s.prefillNameTaken(body.name)) return apiErrorMsg("组名称已存在");
      const items = encodePrefillItems(body.items);
      const id = await s.insertPrefill(body.name, body.type, items, body.description || "");
      const row = await s.getPrefill(id);
      return apiOk(publicPrefill(row || { id, name: body.name, type: body.type, items }));
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.put("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = await bindPrefillGroup(c.req);
    if (isResponse(body)) return body;
    if (!body.id) return apiErrorMsg("缺少组 ID");
    try {
      if (body.name && (await s.prefillNameTaken(body.name, body.id))) return apiErrorMsg("组名称已存在");
      await s.savePrefill({
        id: body.id,
        name: String(body.name || ""),
        type: String(body.type || ""),
        items: encodePrefillItems(body.items),
        description: String(body.description || ""),
        created_time: Number(body.created_time || 0),
      });
      const row = await s.getPrefill(body.id);
      return apiOk(row ? publicPrefill(row) : null);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.delete("/api/prefill_group/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiErrorMsg(id.message);
    try {
      await s.deletePrefill(id.n);
      return apiOk(null);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  async function searchVendorsResponse(c: C): Promise<Response> {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    try {
      const found = await s.searchVendors({
        keyword: c.url.searchParams.get("keyword") || "",
        association: c.url.searchParams.get("association") || "",
        offset: q.offset,
        limit: q.page_size,
      });
      const counts = await s.vendorModelCounts();
      const items = found.items.map((v) => publicVendor(v, counts[String(v.id || 0)] || 0));
      return apiOk(pageData(items, found.total, q));
    } catch (e) {
      return vendorAPIError(e);
    }
  }

  r.get("/api/vendors/", searchVendorsResponse);
  r.get("/api/vendors/search", searchVendorsResponse);

  r.get("/api/vendors/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return vendorAPIError(id.message);
    try {
      const v = await s.getVendor(id.n);
      if (!v) return vendorAPIError("record not found");
      const counts = await s.vendorModelCounts();
      return apiOk(publicVendor(v, counts[String(v.id)] || 0));
    } catch (e) {
      return vendorAPIError(e);
    }
  });

  r.post("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = await bindVendor(c.req);
    if (isResponse(body)) return body;
    if (!body.name.trim()) return vendorAPIError("vendor name is required");
    const name = body.name.trim();
    try {
      const existing = ((await s.listVendors()) as { name: string }[]).some((v) => v.name.toLowerCase() === name.toLowerCase());
      if (existing) return vendorAPIError("vendor name already exists");
      const id = await s.insertVendor(name, body.description, body.icon);
      const v = await s.getVendor(id);
      return apiOk(publicVendor(v || { id, name, description: body.description, icon: body.icon }));
    } catch (e) {
      return vendorAPIError(e);
    }
  });

  r.put("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = await bindVendor(c.req);
    if (isResponse(body)) return body;
    if (!body.id) return apiErrorMsg("缺少供应商 ID");
    try {
      const existing = await s.getVendor(body.id);
      if (!existing) return vendorAPIError("record not found");
      if (body.version && String(body.version) !== vendorRecordVersion(existing)) {
        return json(409, {
          success: false,
          message: "vendor data changed; preview again before applying",
          code: "VENDOR_CONFLICT",
        });
      }
      const patch: Record<string, unknown> = { updated_time: nowSec() };
      for (const k of ["name", "description", "icon", "status"] as const) {
        if (k in body.rec && body.rec[k] != null) patch[k] = body.rec[k];
      }
      await s.updateVendor(body.id, patch);
      const v = await s.getVendor(body.id);
      return apiOk(v ? publicVendor(v) : null);
    } catch (e) {
      return vendorAPIError(e);
    }
  });

  r.delete("/api/vendors/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return vendorAPIError(id.message);
    if (!(await s.getVendor(id.n))) {
      return json(400, { success: false, message: "vendor data changed; preview again before applying: source vendor does not exist" });
    }
    const counts = await s.vendorModelCounts();
    const n = counts[String(id.n)] || 0;
    if (n > 0) {
      return json(409, {
        success: false,
        message: "vendors are still referenced by models; transfer or clear their assignments first",
        code: "VENDOR_REFERENCED",
        reference_counts: { [String(id.n)]: n },
      });
    }
    await s.deleteVendor(id.n);
    return apiOk(null);
  });

  r.post("/api/models/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { model_name?: string };
    const modelName = String(body.model_name || "").trim();
    if (!modelName) return apiErrorMsg("模型名称不能为空");
    const status = body.status == null ? 0 : Number(body.status);
    const name_rule = Number(body.name_rule || 0);
    const invalid = validateMetadataValues({ endpoints: String(body.endpoints || ""), status, name_rule });
    if (invalid) return apiErrorMsg(invalid);
    if (await s.isModelNameDuplicated(0, modelName)) return apiErrorMsg("模型名称已存在");
    const vendorId = Number(body.vendor_id || 0);
    if (vendorId < 0) return apiErrorMsg("select a saved vendor");
    if (vendorId > 0 && !(await s.getVendor(vendorId))) return apiErrorMsg("vendor does not exist");
    const id = await s.insertModelMeta(modelName, String(body.description || ""), vendorId);
    const t = nowSec();
    await s.updateModelMeta(id, {
      description: String(body.description || ""),
      icon: String(body.icon || ""),
      tags: String(body.tags || ""),
      vendor_id: vendorId,
      endpoints: String(body.endpoints || ""),
      status,
      sync_official: body.sync_official == null ? 0 : Number(body.sync_official),
      name_rule,
      updated_time: t,
    });
    const item = await s.getModelMeta(id);
    return apiOk(item ? publicModelMeta(item) : { id });
  });

  r.put("/api/models/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number };
    if (!body.id) return apiErrorMsg("缺少模型 ID");
    const existing = await s.getModelMeta(body.id);
    if (!existing) return apiErrorMsg("不存在");
    if (c.url.searchParams.get("status_only") === "true") {
      const status = Number(body.status);
      if (status !== 0 && status !== 1) return apiErrorMsg("invalid catalog visibility");
      await s.updateModelMeta(body.id, { status, updated_time: nowSec() });
      const item = await s.getModelMeta(body.id);
      return apiOk(item ? publicModelMeta({ ...item, status }) : null);
    }
    const modelName = String(body.model_name || "").trim();
    if (!modelName) return apiErrorMsg("模型名称不能为空");
    const status = Number(body.status || 0);
    const name_rule = Number(body.name_rule || 0);
    const endpoints = String(body.endpoints ?? existing.endpoints ?? "");
    const invalid = validateMetadataValues({ endpoints, status, name_rule });
    if (invalid) return apiErrorMsg(invalid);
    if (await s.isModelNameDuplicated(body.id, modelName)) return apiErrorMsg("模型名称已存在");
    const vendorId = Number(body.vendor_id || 0);
    if (vendorId < 0) return apiErrorMsg("select a saved vendor");
    if (vendorId > 0 && !(await s.getVendor(vendorId))) return apiErrorMsg("vendor does not exist");
    await s.updateModelMeta(body.id, {
      model_name: modelName,
      description: String(body.description || ""),
      icon: String(body.icon || ""),
      tags: String(body.tags || ""),
      vendor_id: vendorId,
      endpoints: String(body.endpoints ?? existing.endpoints ?? ""),
      status,
      sync_official: body.sync_official == null ? Number(existing.sync_official || 0) : Number(body.sync_official),
      name_rule,
      updated_time: nowSec(),
    });
    const item = await s.getModelMeta(body.id);
    return apiOk(item ? publicModelMeta(item) : null);
  });

  r.delete("/api/models/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiErrorMsg(id.message);
    const fromChannels = strconvParseBool(c.url.searchParams.get("remove_from_channels") ?? "false");
    if (!fromChannels.ok) return apiErrorMsg(fromChannels.message);
    const fromPricing = strconvParseBool(c.url.searchParams.get("remove_pricing") ?? "false");
    if (!fromPricing.ok) return apiErrorMsg(fromPricing.message);
    if (fromPricing.v && u.role !== ROLE_ROOT) {
      return json(403, { success: false, message: "Model pricing is managed by a super administrator." });
    }
    try {
      const result = await s.deleteModelMetadata([id.n], fromChannels.v, fromPricing.v);
      await recordManageAudit(s, c.req, u, "model.delete", {
        model_ids: [id.n],
        remove_from_channels: fromChannels.v,
        remove_pricing: fromPricing.v,
        updated_channels: result.updated_channels,
      });
      return apiOk(result);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/task", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTasks(null, q.offset, q.page_size, {
      platform: c.url.searchParams.get("platform") || "",
      task_id: c.url.searchParams.get("task_id") || "",
      status: c.url.searchParams.get("status") || "",
      action: c.url.searchParams.get("action") || "",
      start_timestamp: Number(c.url.searchParams.get("start_timestamp") || 0) || 0,
      end_timestamp: Number(c.url.searchParams.get("end_timestamp") || 0) || 0,
      channel_id: c.url.searchParams.get("channel_id") || "",
    });
    return apiOk(pageData(items.map((row) => publicTask(row as Record<string, unknown>, true, u.role)), total, q));
  });

  r.get("/api/task/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTasks(u.id, q.offset, q.page_size, {
      platform: c.url.searchParams.get("platform") || "",
      task_id: c.url.searchParams.get("task_id") || "",
      status: c.url.searchParams.get("status") || "",
      action: c.url.searchParams.get("action") || "",
      start_timestamp: Number(c.url.searchParams.get("start_timestamp") || 0) || 0,
      end_timestamp: Number(c.url.searchParams.get("end_timestamp") || 0) || 0,
    });
    return apiOk(pageData(items.map((row) => publicTask(row as Record<string, unknown>, false, 1)), total, q));
  });

  r.get("/api/custom-oauth-provider/", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const items = (await s.listOAuthProviders()) as Record<string, unknown>[];
    return apiOk(items.map(publicCustomOAuthProvider));
  });

  r.post("/api/custom-oauth-provider/", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return createCustomOAuthProvider(s, (await readJson(c.req)) as Record<string, unknown>);
  });

  r.put("/api/custom-oauth-provider/:id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiErrorMsg("无效的 ID");
    return updateCustomOAuthProvider(s, id.n, (await readJson(c.req)) as Record<string, unknown>);
  });

  r.delete("/api/custom-oauth-provider/:id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiErrorMsg("无效的 ID");
    return deleteCustomOAuthProvider(s, id.n);
  });

  r.get("/api/option/model_pricing", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await getModelPricingSnapshot(s, c.url.searchParams.getAll("model")));
  });

  r.patch("/api/option/model_pricing", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { changes?: ModelPricingChange[] };
    try {
      const names = await updateModelPricing(s, body.changes || []);
      await recordManageAudit(s, c.req, u, "model.pricing.update", { models: names });
      return apiOk({ updated_models: names });
    } catch (e) {
      const err = e as ModelPricingError;
      return json(err.status || 400, { success: false, message: err.message });
    }
  });

  r.post("/api/option/model_pricing/convert", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    let body: { model_name?: string; pricing?: Record<string, unknown> };
    try {
      body = (await readJson(c.req)) as { model_name?: string; pricing?: Record<string, unknown> };
    } catch (e) {
      return json(400, { success: false, message: e instanceof Error ? e.message : String(e) });
    }
    try {
      return apiOk(await previewModelPricingConversion(s, String(body.model_name || ""), body.pricing || null));
    } catch (e) {
      const err = e as ModelPricingError;
      return json(err.status || 200, { success: false, message: err.message });
    }
  });

  r.post("/api/option/model_pricing/preview", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    let body: { model_name?: string; pricing?: Record<string, unknown> };
    try {
      body = (await readJson(c.req)) as { model_name?: string; pricing?: Record<string, unknown> };
    } catch (e) {
      return json(400, { success: false, message: e instanceof Error ? e.message : String(e) });
    }
    try {
      return apiOk(await previewModelPricingDescription(s, String(body.model_name || ""), body.pricing || null));
    } catch (e) {
      const err = e as ModelPricingError;
      return json(err.status || 200, { success: false, message: err.message });
    }
  });

  r.put("/api/option/passkey/domains", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    let body: { rp_id?: string; legacy_rp_ids?: string; origins?: string; preview?: boolean; removal_confirmation?: string };
    try {
      body = (await readJson(c.req)) as typeof body;
    } catch {
      return apiFailInvalidParams(c.req);
    }
    if (body.rp_id === undefined || body.legacy_rp_ids === undefined || body.origins === undefined) {
      return apiFailInvalidParams(c.req);
    }
    return handlePasskeyDomainUpdate(
      c,
      s,
      u,
      {
        "passkey.rp_id": body.rp_id,
        "passkey.legacy_rp_ids": body.legacy_rp_ids,
        "passkey.origins": body.origins,
      },
      Boolean(body.preview),
      body.removal_confirmation || "",
    );
  });

  r.post("/api/option/rest_model_ratio", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    try {
      await s.setOption("ModelRatio", DEFAULT_MODEL_RATIO_JSON);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
    return json(200, { success: true, message: "重置模型倍率成功" });
  });

  r.get("/api/verify/methods", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    const user = await s.getUserById(identity.userId);
    if (!user) return apiErrorMsg("用户不存在");
    const scope = c.url.searchParams.get("scope") || "";
    const reqs = await verificationRequirements(s, user, scope);
    if (!reqs.ok) return apiFailCode(reqs.message, reqs.code, reqs.status);
    return apiOk(reqs.data);
  });

  r.post("/api/verify", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    let parsed: unknown;
    try {
      const raw = await c.req.text();
      if (!raw.trim()) return apiErrorMsg("参数错误");
      parsed = JSON.parse(raw);
    } catch {
      return apiErrorMsg("参数错误");
    }
    const boundBody = bindUniversalVerify(parsed);
    if (!boundBody.ok) return apiErrorMsg("参数错误");
    const body = boundBody.body;
    const user = await s.getUserById(identity.userId);
    if (!user) return apiErrorMsg("用户不存在");
    const method = body.method === "totp" ? "2fa" : body.method || "";
    const scope = body.scope || "";
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, { scope, context: body.context });
    if (!bound.ok) return apiFailCode(bound.message, bound.code, bound.status);
    const reqs = await verificationRequirements(s, user, scope);
    if (!reqs.ok) return apiFailCode(reqs.message, reqs.code, reqs.status);
    const methods = (reqs.data.methods as { method: string; available: boolean }[]) || [];
    const option = methods.find((m) => m.method === method);
    if (!option) {
      return apiFailCode("This verification method is not allowed for this action.", "SECURITY_PROOF_METHOD_MISMATCH");
    }
    if (!option.available) {
      return apiFailCode("This verification method is currently unavailable.", "SECURITY_METHOD_UNAVAILABLE");
    }
    if (method === "2fa") {
      if (scope === "2fa.backup_codes.regenerate" && validateNumericCode(body.code || "") === null) {
        return apiFailCode(ERR_VERIFICATION_FAILED, "SECURITY_VERIFICATION_FAILED");
      }
      const result = await verifyTwoFactorCode(s, user, body.code || "");
      if (!result.ok) return apiFailCode(result.message, result.code);
    } else if (method === "password") {
      const { verifyPassword } = await import("./crypto.js");
      if (!(await verifyPassword(body.password || "", user.password))) {
        return apiFailCode(ERR_VERIFICATION_FAILED, "SECURITY_VERIFICATION_FAILED");
      }
    } else if (method === "passkey" || method === "oauth") {
      return apiFailCode("This verification method requires its dedicated verification flow.", "SECURITY_VERIFICATION_FLOW_REQUIRED", 400);
    } else {
      return apiFailCode("This verification method is not allowed for this action.", "SECURITY_PROOF_METHOD_MISMATCH");
    }
    const proof = await issueSecurityProof(s, secret, identity, method, bound.binding);
    return apiOk(proof);
  });

  registerParity(r);

  void totpCode;
  void generateTokenKey;
  void publicUser;
}

async function generateUserAccessToken(c: C): Promise<Response> {
  const s = store(c);
  const proof = await requireProof(c, s, { scope: "access_token.generate" });
  if (isResponse(proof)) return proof;
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const token = newAccessToken();
  await s.updateUser(u.id, { access_token: token, access_token_created_at: nowSec() });
  await recordUserSecurityAudit(s, c.req, u, "access_token.generate", {
    token_ref: await accessTokenFingerprint(token),
  });
  return apiOk(token);
}

/** Original `i18n.MsgTokenGetInfoFailed`. */
function tokenGetInfoFailedMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "獲取令牌資訊失敗，請稍後重試";
    case "zh-CN":
      return "获取令牌信息失败，请稍后重试";
    default:
      return "Failed to get token info, please try again later";
  }
}

/** Original `controller.GetTokenUsage` after `middleware.TokenAuthReadOnly`. */
async function tokenUsage(c: C): Promise<Response> {
  const s = store(c);
  const auth = await authenticateTokenReadOnly(c, s);
  if (auth instanceof Response) return auth;
  const authHeader = c.req.headers.get("authorization") || "";
  if (!authHeader) return json(401, { success: false, message: "No Authorization header" });
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return json(401, { success: false, message: "Invalid Bearer token" });
  }
  const tokenKey = parts[1].startsWith("sk-") ? parts[1].slice(3) : parts[1];
  const token = await s.getTokenByKey(tokenKey);
  if (!token) return apiErrorMsg(tokenGetInfoFailedMessage(c.req));
  const remain = Number(token.remain_quota || 0);
  const used = Number(token.used_quota || 0);
  const expiredAt = token.expired_time === -1 ? 0 : token.expired_time;
  return json(200, {
    code: true,
    message: "ok",
    data: {
      object: "token_usage",
      name: token.name,
      total_granted: remain + used,
      total_used: used,
      total_available: remain,
      unlimited_quota: Boolean(token.unlimited_quota),
      model_limits: tokenModelLimitsMap(String(token.model_limits || "")),
      model_limits_enabled: Boolean(token.model_limits_enabled),
      expires_at: expiredAt,
    },
  });
}

/** Original `common.DecodeJson` into `controller.oauthStateRequest`. Any decode error is `MsgInvalidParams`. */
async function bindOAuthStateRequest(req: Request): Promise<
  | { provider: string; intent: string; aff: string; scope: string; contextPresent: boolean; context: unknown }
  | Response
> {
  const invalid = () => apiFailInvalidParams(req);
  const raw = await req.text();
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const rec = parsed.value as Record<string, unknown>;
  for (const key of ["provider", "intent", "aff", "scope"] as const) {
    if (rec[key] !== undefined && rec[key] !== null && typeof rec[key] !== "string") return invalid();
  }
  return {
    provider: rec.provider == null ? "" : String(rec.provider),
    intent: rec.intent == null ? "" : String(rec.intent),
    aff: rec.aff == null ? "" : String(rec.aff),
    scope: rec.scope == null ? "" : String(rec.scope),
    contextPresent: Object.prototype.hasOwnProperty.call(rec, "context"),
    context: rec.context,
  };
}

/** Original `json.NewDecoder.Decode` into `controller.PasswordResetRequest`. */
async function bindPasswordResetRequest(req: Request): Promise<{ email: string; token: string } | Response> {
  const raw = await req.text();
  if (!raw.trim()) return apiErrorMsg("EOF");
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return apiErrorMsg(parsed.message);
  if (parsed.value === null) return { email: "", token: "" };
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return apiErrorMsg(
      `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type controller.PasswordResetRequest`,
    );
  }
  const rec = parsed.value as Record<string, unknown>;
  if (rec.email !== undefined && rec.email !== null && typeof rec.email !== "string") {
    return apiErrorMsg(
      `json: cannot unmarshal ${goJSONKind(rec.email)} into Go struct field PasswordResetRequest.email of type string`,
    );
  }
  if (rec.token !== undefined && rec.token !== null && typeof rec.token !== "string") {
    return apiErrorMsg(
      `json: cannot unmarshal ${goJSONKind(rec.token)} into Go struct field PasswordResetRequest.token of type string`,
    );
  }
  return {
    email: rec.email == null ? "" : String(rec.email),
    token: rec.token == null ? "" : String(rec.token),
  };
}

/** Original `url.ParseRequestURI`. */
function parseRequestURI(raw: string): boolean {
  if (!raw) return false;
  try {
    if (raw.startsWith("/")) return true;
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

/** Original `controller.TransferAffQuotaRequest` `ShouldBindJSON` `quota` `binding:"required"`. */
function bindTransferAffQuota(req: Request, raw: string): number | Response {
  if (!raw.trim()) return apiErrorMsg("EOF");
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return apiErrorMsg(parsed.message);
  if (parsed.value === null) {
    return apiErrorMsg("Key: 'TransferAffQuotaRequest.Quota' Error:Field validation for 'Quota' failed on the 'required' tag");
  }
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return apiErrorMsg(
      `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type controller.TransferAffQuotaRequest`,
    );
  }
  const rec = parsed.value as Record<string, unknown>;
  if (rec.quota !== undefined && rec.quota !== null && (typeof rec.quota !== "number" || !Number.isInteger(rec.quota))) {
    return apiErrorMsg(
      `json: cannot unmarshal ${goJSONKind(rec.quota)} into Go struct field TransferAffQuotaRequest.quota of type int`,
    );
  }
  const quota = rec.quota == null ? 0 : Number(rec.quota);
  if (quota === 0) {
    return apiErrorMsg("Key: 'TransferAffQuotaRequest.Quota' Error:Field validation for 'Quota' failed on the 'required' tag");
  }
  return quota;
}

type UpdateUserSettingReq = {
  notify_type: string;
  quota_warning_threshold: number;
  webhook_url: string;
  webhook_secret: string;
  notification_email: string;
  bark_url: string;
  gotify_url: string;
  gotify_token: string;
  gotify_priority: number;
  upstream_model_update_notify_enabled?: boolean;
  accept_unset_model_ratio_model: boolean;
  record_ip_log: boolean;
};

/** Original `UpdateUserSetting` `ShouldBindJSON`; any bind error is `MsgInvalidParams`. */
function bindUpdateUserSetting(req: Request, raw: string): UpdateUserSettingReq | Response {
  const invalid = () => apiFailInvalidParams(req);
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  const zero: UpdateUserSettingReq = {
    notify_type: "",
    quota_warning_threshold: 0,
    webhook_url: "",
    webhook_secret: "",
    notification_email: "",
    bark_url: "",
    gotify_url: "",
    gotify_token: "",
    gotify_priority: 0,
    accept_unset_model_ratio_model: false,
    record_ip_log: false,
  };
  if (parsed.value === null) return zero;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const rec = parsed.value as Record<string, unknown>;
  const str = (key: string): string | Response => {
    const v = rec[key];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") return invalid();
    return v;
  };
  const notify = str("notify_type");
  if (notify instanceof Response) return notify;
  const webhookUrl = str("webhook_url");
  if (webhookUrl instanceof Response) return webhookUrl;
  const webhookSecret = str("webhook_secret");
  if (webhookSecret instanceof Response) return webhookSecret;
  const notificationEmail = str("notification_email");
  if (notificationEmail instanceof Response) return notificationEmail;
  const barkUrl = str("bark_url");
  if (barkUrl instanceof Response) return barkUrl;
  const gotifyUrl = str("gotify_url");
  if (gotifyUrl instanceof Response) return gotifyUrl;
  const gotifyToken = str("gotify_token");
  if (gotifyToken instanceof Response) return gotifyToken;
  let threshold = 0;
  if (rec.quota_warning_threshold !== undefined && rec.quota_warning_threshold !== null) {
    if (typeof rec.quota_warning_threshold !== "number") return invalid();
    threshold = rec.quota_warning_threshold;
  }
  let priority = 0;
  if (rec.gotify_priority !== undefined && rec.gotify_priority !== null) {
    if (typeof rec.gotify_priority !== "number" || !Number.isInteger(rec.gotify_priority)) return invalid();
    priority = rec.gotify_priority;
  }
  const boolVal = (key: string, pointer: boolean): boolean | undefined | Response => {
    const v = rec[key];
    if (v === undefined) return pointer ? undefined : false;
    if (v === null) return pointer ? undefined : invalid();
    if (typeof v !== "boolean") return invalid();
    return v;
  };
  const accept = boolVal("accept_unset_model_ratio_model", false);
  if (accept instanceof Response) return accept;
  const recordIp = boolVal("record_ip_log", false);
  if (recordIp instanceof Response) return recordIp;
  const upstream = boolVal("upstream_model_update_notify_enabled", true);
  if (upstream instanceof Response) return upstream;
  return {
    notify_type: notify,
    quota_warning_threshold: threshold,
    webhook_url: webhookUrl,
    webhook_secret: webhookSecret,
    notification_email: notificationEmail,
    bark_url: barkUrl,
    gotify_url: gotifyUrl,
    gotify_token: gotifyToken,
    gotify_priority: priority,
    upstream_model_update_notify_enabled: upstream,
    accept_unset_model_ratio_model: Boolean(accept),
    record_ip_log: Boolean(recordIp),
  };
}

/** Original `controller.TokenBatch` `ShouldBindJSON`; empty/null ids bind then `MsgInvalidParams`. */
function parseTokenBatchIds(req: Request, raw: string): number[] | Response {
  const invalid = () => apiFailInvalidParams(req);
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const ids = (parsed.value as { ids?: unknown }).ids;
  if (ids == null) return [];
  if (!Array.isArray(ids)) return invalid();
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id)) return invalid();
    out.push(id);
  }
  return out;
}

/** Original `DeleteRedemptionBatch` `ShouldBindJSON` `ids` `required,min=1,max=1000,dive,gt=0`. */
function bindRedemptionBatchIds(req: Request, raw: string): number[] | Response {
  const invalid = () => apiFailInvalidParams(req);
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const ids = (parsed.value as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000) return invalid();
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return invalid();
    out.push(id);
  }
  return out;
}
