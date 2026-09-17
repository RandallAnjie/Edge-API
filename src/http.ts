import { bytesToHex, sha256Bytes } from "./crypto.js";
import type { PageQuery } from "./types.js";

export function json(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiOk(data: unknown = null, message = ""): Response {
  return json(200, { success: true, message, data });
}

export function apiOkExtra(data: unknown, extra: Record<string, unknown>, message = ""): Response {
  return json(200, { success: true, message, data, ...extra });
}

export function apiFail(message: string, data: unknown = null, status = 200): Response {
  return json(status, { success: false, message, data });
}

/** Original `oauth.OAuthError` / `handleOAuthError` i18n pair. */
export class OAuthI18nError extends Error {
  constructor(
    readonly zh: string,
    readonly en: string,
  ) {
    super(en);
    this.name = "OAuthI18nError";
  }
}

/** Original `oauth.AccessDeniedError`. */
export class OAuthAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthAccessDeniedError";
  }
}

/** Original `strconv.Atoi` error string from `common.ApiError`. */
export function strconvAtoi(raw: string): { ok: true; n: number } | { ok: false; message: string } {
  if (/^-?\d+$/.test(raw)) return { ok: true, n: Number(raw) };
  return { ok: false, message: `strconv.Atoi: parsing "${raw}": invalid syntax` };
}

const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;

/** Original `strconv.ParseInt(s, 10, 64)`. */
export function strconvParseInt(raw: string): { ok: true; n: number } | { ok: false; message: string } {
  if (!/^[+-]?\d+$/.test(raw)) {
    return { ok: false, message: `strconv.ParseInt: parsing "${raw}": invalid syntax` };
  }
  try {
    const n = BigInt(raw);
    if (n > MAX_INT64 || n < MIN_INT64) {
      return { ok: false, message: `strconv.ParseInt: parsing "${raw}": value out of range` };
    }
    return { ok: true, n: Number(n) };
  } catch {
    return { ok: false, message: `strconv.ParseInt: parsing "${raw}": invalid syntax` };
  }
}

/** Original `common.ApiErrorMsg` gin.H (HTTP 200, no `data`). */
export function apiErrorMsg(message: string): Response {
  return json(200, { success: false, message });
}

/** Original Passkey disabled gin.H `{success:false,message}` (no `data`). */
export const MSG_PASSKEY_DISABLED = "管理员未启用 Passkey 登录";
/** Original `parsePasskeyFinishRequest` controller wrapper message. */
export const MSG_PASSKEY_INVALID_REQUEST = "无效的 Passkey 验证请求";
/** Original Passkey not-bound gin.H `{success:false,message}` (no `data`). */
export const MSG_PASSKEY_NOT_BOUND = "该用户尚未绑定 Passkey";

/** Original `controller.parsePasskeyFinishRequest` — every error is `无效的 Passkey 验证请求`. */
export async function parsePasskeyFinishRequest(
  req: Request,
): Promise<{ ok: true; flowToken: string; credential: unknown } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    const raw = await req.text();
    if (!raw.trim()) return { ok: false, response: apiErrorMsg(MSG_PASSKEY_INVALID_REQUEST) };
    body = JSON.parse(raw);
  } catch {
    return { ok: false, response: apiErrorMsg(MSG_PASSKEY_INVALID_REQUEST) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: apiErrorMsg(MSG_PASSKEY_INVALID_REQUEST) };
  }
  const rec = body as Record<string, unknown>;
  const flowToken = typeof rec.flow_token === "string" ? rec.flow_token : "";
  if (!flowToken || rec.credential == null) {
    return { ok: false, response: apiErrorMsg(MSG_PASSKEY_INVALID_REQUEST) };
  }
  return { ok: true, flowToken, credential: rec.credential };
}

/** Original WebAuthn credential `id` / `rawId` from a finish payload. */
export function passkeyCredentialId(credential: unknown): string {
  if (!credential || typeof credential !== "object") return "";
  const rec = credential as Record<string, unknown>;
  return String(rec.id || rec.rawId || "");
}

/** Original `strconv.ParseBool` error string from `common.ApiError`. */
export function strconvParseBool(raw: string): { ok: true; v: boolean } | { ok: false; message: string } {
  switch (raw) {
    case "1":
    case "t":
    case "T":
    case "TRUE":
    case "true":
    case "True":
      return { ok: true, v: true };
    case "0":
    case "f":
    case "F":
    case "FALSE":
    case "false":
    case "False":
      return { ok: true, v: false };
    default:
      return { ok: false, message: `strconv.ParseBool: parsing "${raw}": invalid syntax` };
  }
}

/** Original `i18n.ContextKeyUserSetting.Language` snapshot at auth time. */
const requestUserLanguage = new WeakMap<Request, string>();

/** Original `i18n.normalizeLang`. Unsupported tags (including `"fr"`) become English. */
export function normalizeI18nLang(lang: string): "zh-CN" | "zh-TW" | "en" {
  const n = lang.toLowerCase().trim();
  if (n.startsWith("zh-tw")) return "zh-TW";
  if (n.startsWith("zh")) return "zh-CN";
  if (n.startsWith("en")) return "en";
  return "en";
}

/** Original `i18n.ParseAcceptLanguage`. */
export function parseAcceptLanguage(header: string): "zh-CN" | "zh-TW" | "en" {
  if (!header) return "en";
  const first = header.split(",")[0]?.trim().split(";")[0] || "";
  return normalizeI18nLang(first);
}

function languageFromUserSettings(settingsRaw: string | undefined | null): string {
  if (!settingsRaw) return "";
  try {
    const parsed = JSON.parse(settingsRaw) as { language?: unknown };
    return typeof parsed.language === "string" ? parsed.language : "";
  } catch {
    return "";
  }
}

/**
 * Original `model.UserBase.WriteContext` / `GetUserLanguage` snapshot for
 * `i18n.GetLangFromContext`. Empty language falls through to Accept-Language.
 * UpdateSelf language takes effect on the next request.
 */
export function rememberRequestUserLanguageFromUser(
  req: Request | undefined,
  user: { settings?: string } | null | undefined,
): void {
  if (!req || !user) return;
  requestUserLanguage.set(req, languageFromUserSettings(user.settings));
}

/** Original `i18n.GetLangFromContext` / `i18n.T` language. */
export function i18nLang(req: Request): "zh-CN" | "zh-TW" | "en" {
  const remembered = requestUserLanguage.get(req);
  if (remembered) return normalizeI18nLang(remembered);
  return parseAcceptLanguage(req.headers.get("accept-language") || "");
}

/** Original `i18n.T` with DefaultLang English. */
export function i18nPair(req: Request, zh: string, en: string): string {
  if (i18nLang(req) !== "en") return zh;
  return en;
}

/** Original `i18n.MsgUserEmailAlreadyTaken`. */
export function userEmailAlreadyTakenMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "信箱位址已被占用";
    case "zh-CN":
      return "邮箱地址已被占用";
    default:
      return "Email address is already in use";
  }
}

/** Original `i18n.MsgUserPasswordLoginDisabled`. */
export function userPasswordLoginDisabledMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "管理員關閉了密碼登錄";
    case "zh-CN":
      return "管理员关闭了密码登录";
    default:
      return "Password login has been disabled by administrator";
  }
}

/** Original `i18n.MsgUserRegisterDisabled`. */
export function userRegisterDisabledMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "管理員關閉了新使用者註冊";
    case "zh-CN":
      return "管理员关闭了新用户注册";
    default:
      return "New user registration has been disabled by administrator";
  }
}

/** Original `i18n.MsgUserPasswordRegisterDisabled`. */
export function userPasswordRegisterDisabledMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "管理員關閉了通過密碼進行註冊，請使用第三方帳號驗證的形式進行註冊";
    case "zh-CN":
      return "管理员关闭了通过密码进行注册，请使用第三方账户验证的形式进行注册";
    default:
      return "Password registration has been disabled by administrator, please use third-party account verification";
  }
}

/** Original `i18n.MsgUserUsernameOrPasswordError`. */
export function userUsernameOrPasswordErrorMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "使用者名或密碼錯誤，或使用者已被封禁";
    case "zh-CN":
      return "用户名或密码错误，或用户已被封禁";
    default:
      return "Username or password is incorrect, or user has been banned";
  }
}

/** Original `i18n.MsgUserExists`. */
export function userExistsMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "使用者名已存在，或已註銷";
    case "zh-CN":
      return "用户名已存在，或已注销";
    default:
      return "Username already exists or has been deleted";
  }
}

/** Original `i18n.MsgUserEmailVerificationRequired`. */
export function userEmailVerificationRequiredMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "管理員開啟了信箱驗證，請輸入信箱位址和驗證碼";
    case "zh-CN":
      return "管理员开启了邮箱验证，请输入邮箱地址和验证码";
    default:
      return "Email verification is enabled, please enter email address and verification code";
  }
}

/** Original `i18n.MsgUserVerificationCodeError`. */
export function userVerificationCodeErrorMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "驗證碼錯誤或已過期";
    case "zh-CN":
      return "验证码错误或已过期";
    default:
      return "Verification code is incorrect or has expired";
  }
}

/** Original `i18n.MsgUserInputInvalid` (`{{.Error}}`). */
export function userInputInvalidMessage(req: Request, error: string): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return `輸入不合法 ${error}`;
    case "zh-CN":
      return `输入不合法 ${error}`;
    default:
      return `Invalid input ${error}`;
  }
}

/** Original `i18n.MsgInvalidInput`. */
export function invalidInputMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "輸入不合法";
    case "zh-CN":
      return "输入不合法";
    default:
      return "Invalid input";
  }
}

/** Original `i18n.MsgUpdateSuccess`. */
export function updateSuccessMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
    case "zh-CN":
      return "更新成功";
    default:
      return "Update successful";
  }
}

/** Original `i18n.MsgUserPasswordResetLinkInvalid`. */
export function userPasswordResetLinkInvalidMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "重置連結非法或已過期";
    case "zh-CN":
      return "重置链接非法或已过期";
    default:
      return "Password reset link is invalid or has expired";
  }
}

/** Original `i18n.MsgUserNotExists`. */
export function userNotExistsMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "使用者不存在";
    case "zh-CN":
      return "用户不存在";
    default:
      return "User does not exist";
  }
}

/** Original `i18n.MsgUserNoPermissionSameLevel`. */
export function userNoPermissionSameLevelMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無權獲取同級或更高等級使用者的資訊";
    case "zh-CN":
      return "无权获取同级或更高等级用户的信息";
    default:
      return "No permission to access users of same or higher level";
  }
}

/** Original `i18n.MsgUserNoPermissionHigherLevel`. */
export function userNoPermissionHigherLevelMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無權更新同權限等級或更高權限等級的使用者資訊";
    case "zh-CN":
      return "无权更新同权限等级或更高权限等级的用户信息";
    default:
      return "No permission to update users of same or higher permission level";
  }
}

/** Original `i18n.MsgUserCannotCreateHigherLevel`. */
export function userCannotCreateHigherLevelMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無法建立權限大於等於自己的使用者";
    case "zh-CN":
      return "无法创建权限大于等于自己的用户";
    default:
      return "Cannot create users with permission level equal to or higher than yourself";
  }
}

/** Original `i18n.MsgUserCannotDeleteRootUser`. */
export function userCannotDeleteRootUserMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "不能刪除超級管理員帳號";
    case "zh-CN":
      return "不能删除超级管理员账户";
    default:
      return "Cannot delete super administrator account";
  }
}

/** Original `i18n.MsgUserCannotDisableRootUser`. */
export function userCannotDisableRootUserMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無法禁用超級管理員使用者";
    case "zh-CN":
      return "无法禁用超级管理员用户";
    default:
      return "Cannot disable super administrator user";
  }
}

/** Original `i18n.MsgUserCannotDemoteRootUser`. */
export function userCannotDemoteRootUserMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無法降級超級管理員使用者";
    case "zh-CN":
      return "无法降级超级管理员用户";
    default:
      return "Cannot demote super administrator user";
  }
}

/** Original `i18n.MsgUserAlreadyAdmin`. */
export function userAlreadyAdminMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "該使用者已經是管理員";
    case "zh-CN":
      return "该用户已经是管理员";
    default:
      return "This user is already an administrator";
  }
}

/** Original `i18n.MsgUserAlreadyCommon`. */
export function userAlreadyCommonMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "該使用者已經是普通使用者";
    case "zh-CN":
      return "该用户已经是普通用户";
    default:
      return "This user is already a common user";
  }
}

/** Original `i18n.MsgUserAdminCannotPromote`. */
export function userAdminCannotPromoteMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "普通管理員使用者無法提升其他使用者為管理員";
    case "zh-CN":
      return "普通管理员用户无法提升其他用户为管理员";
    default:
      return "Regular administrators cannot promote other users to administrator";
  }
}

/** Original `i18n.MsgUserQuotaChangeZero`. */
export function userQuotaChangeZeroMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "額度變更量不能為0";
    case "zh-CN":
      return "额度变更量不能为0";
    default:
      return "Quota change amount cannot be zero";
  }
}

/** Original `i18n.MsgPaymentComplianceRequired`. */
export function paymentComplianceRequiredMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "支付、兌換碼、訂閱方案和邀請返利功能已停用。管理員需先確認合規聲明後方可啟用。";
    case "zh-CN":
      return "支付、兑换码、订阅计划和邀请返利功能已禁用。管理员需先确认合规声明后方可启用。";
    default:
      return "Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.";
  }
}

/** Original `i18n.MsgTaskPluginUnknownMetaField`. */
export function taskPluginUnknownMetaFieldMessage(req: Request, field: string): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return `外掛中繼資料包含未知欄位「${field}」。如果外掛來自官方市集，可能需要較新版本的 new-api。請嘗試更新 new-api 後重新安裝外掛。`;
    case "zh-CN":
      return `插件元数据包含未知字段“${field}”。如果插件来自官方市场，可能需要更高版本的 new-api。请尝试更新 new-api 后重新安装插件。`;
    default:
      return `Plugin metadata contains an unknown field "${field}". If this plugin was downloaded from the official marketplace, it may require a newer version of new-api. Try updating new-api and installing the plugin again.`;
  }
}

/** Original `i18n.MsgDistributorNoAvailableChannel`. */
export function noAvailableChannelMessage(req: Request, group: string, model: string): string {
  return i18nPair(
    req,
    `分组 ${group} 下模型 ${model} 无可用渠道（distributor）`,
    `No available channel for model ${model} under group ${group} (distributor)`,
  );
}

/** Original `i18n.MsgDistributorGetChannelFailed`. */
export function getChannelFailedMessage(req: Request, group: string, model: string, error: string): string {
  return i18nPair(
    req,
    `获取分组 ${group} 下模型 ${model} 的可用渠道失败（distributor）：${error}`,
    `Failed to get available channel for model ${model} under group ${group} (distributor): ${error}`,
  );
}

/** Original `controller.getChannel` retry error when `CacheGetRandomSatisfiedChannel` returns err. */
export function getChannelRetryFailedMessage(group: string, model: string, error: string): string {
  return `获取分组 ${group} 下模型 ${model} 的可用渠道失败（retry）: ${error}`;
}

/** Original `controller.getChannel` retry error when the selected channel is nil. */
export function noAvailableChannelRetryMessage(group: string, model: string): string {
  return `分组 ${group} 下模型 ${model} 的可用渠道不存在（retry）`;
}

/** Original `i18n.MsgDistributorGroupAccessDenied`. */
export function groupAccessDeniedMessage(req: Request): string {
  return i18nPair(req, "无权访问该分组", "No permission to access this group");
}

/** Original `i18n.MsgDistributorTokenNoModelAccess`. */
export function tokenNoModelAccessMessage(req: Request): string {
  return i18nPair(req, "该令牌无权访问任何模型", "This token has no access to any models");
}

/** Original `i18n.MsgDistributorTokenModelForbidden`. */
export function tokenModelForbiddenMessage(req: Request, model: string): string {
  return i18nPair(req, `该令牌无权访问模型 ${model}`, `This token has no access to model ${model}`);
}

/** Original `i18n.MsgDistributorInvalidChannelId`. */
export function invalidChannelIdMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無效的管道 Id";
    case "zh-CN":
      return "无效的渠道 Id";
    default:
      return "Invalid channel ID";
  }
}

/** Original `i18n.MsgTokenNotProvided`. */
export function tokenNotProvidedMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "未提供令牌";
    case "zh-CN":
      return "未提供令牌";
    default:
      return "Token not provided";
  }
}

/** Original `i18n.MsgTokenStatusUnavailable`. */
export function tokenStatusUnavailableMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "該令牌狀態不可用";
    case "zh-CN":
      return "该令牌状态不可用";
    default:
      return "This token status is unavailable";
  }
}

/** Original `i18n.MsgTokenInvalid`. */
export function tokenInvalidMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無效的令牌";
    case "zh-CN":
      return "无效的令牌";
    default:
      return "Invalid token";
  }
}

/** Original `i18n.MsgAuthInsufficientPrivilege`. */
export function authInsufficientPrivilegeMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "無權進行此操作，權限不足";
    case "zh-CN":
      return "无权进行此操作，权限不足";
    default:
      return "Unauthorized, insufficient privileges";
  }
}

/** Original `i18n.MsgAuthUserBanned`. */
export function userBannedMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "使用者已被封禁";
    case "zh-CN":
      return "用户已被封禁";
    default:
      return "User has been banned";
  }
}

/** Original `i18n.MsgDatabaseError`. */
export function databaseErrorMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "資料庫出錯，請聯繫管理員";
    case "zh-CN":
      return "数据库出错，请联系管理员";
    default:
      return "Database error, please contact the administrator";
  }
}

/** Original `i18n.MsgDistributorModelNameRequired`. */
export function modelNameRequiredMessage(req: Request): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return "未指定模型名稱，模型名稱不能為空";
    case "zh-CN":
      return "未指定模型名称，模型名称不能为空";
    default:
      return "Model name not specified, model name cannot be empty";
  }
}

/** Original `i18n.MsgDistributorInvalidRequest`. */
export function distributorInvalidRequestMessage(req: Request, error: string): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return `無效的請求，${error}`;
    case "zh-CN":
      return `无效的请求，${error}`;
    default:
      return `Invalid request: ${error}`;
  }
}

/** Original `i18n.MsgDistributorInvalidMidjourney`. */
export function invalidMidjourneyRequestMessage(req: Request, error: string): string {
  switch (i18nLang(req)) {
    case "zh-TW":
      return `無效的midjourney請求，${error}`;
    case "zh-CN":
      return `无效的midjourney请求，${error}`;
    default:
      return `Invalid Midjourney request: ${error}`;
  }
}

/** Original `i18n.MsgDistributorChannelDisabled`. */
export function channelDisabledMessage(req: Request): string {
  return i18nPair(req, "该渠道已被禁用", "This channel has been disabled");
}

/** Original TokenAuth `specific_channel_version` header when a non-admin pins a channel. */
export const SPECIFIC_CHANNEL_VERSION = "701e3ae1dc3f7975556d354e0675168d004891c8";

/** Original `controller.paymentReturnPath`. */
export function paymentReturnPath(serverAddress: string, suffix: string): string {
  return serverAddress.replace(/\/+$/, "") + suffix;
}

export function apiFailCode(message: string, code: string, status = 200): Response {
  return json(status, { success: false, code, message });
}

/** Original `net/http.StatusText` used by `controller.writeAuthSessionError`. */
export function httpStatusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    default:
      return "";
  }
}

/** Original `controller.writeSecurityOperationError` known-code gin.H (omits `data`). */
export function writeSecurityOperationError(code: string, message: string, status = 200): Response {
  return json(status, { success: false, code, message });
}

/** Original `controller.writeAuthSessionError` gin.H (omits `data`). */
export function writeAuthSessionError(status: number, code: string): Response {
  return json(status, { success: false, code, message: httpStatusText(status) });
}

/** Original Stripe/Epay/Creem/Waffo gin.H `{message, data}` (and optional `url`) — omits `success`. */
export function payOk(data: unknown, extra: Record<string, unknown> = {}): Response {
  return json(200, { message: "success", data, ...extra });
}

export function payErr(data: unknown): Response {
  return json(200, { message: "error", data });
}

const PUBLIC_CONTENT_ETAG_NS = "public-content:v1";

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const raw = ifNoneMatch.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const want = etag.replace(/^W\//, "");
  for (const part of raw.split(",")) {
    const candidate = part.trim().replace(/^W\//, "");
    if (candidate === want) return true;
  }
  return false;
}

/**
 * Original `common.Marshal` of `publicContentResponse`.
 * Failure is leftover HTTP 500 gin.H `{success:false,message}` (no `data`).
 */
export const publicContentMarshal = {
  json(body: { success: boolean; message: string; data: string }): string {
    return JSON.stringify(body);
  },
};

/** Original GetNotice/GetAbout/GetHomePageContent/GetUserAgreement/GetPrivacyPolicy. */
export async function serveRevalidatedJSON(req: Request, content: string): Promise<Response> {
  const data = content ?? "";
  let encoded: string;
  try {
    encoded = publicContentMarshal.json({ success: true, message: "", data });
  } catch (e) {
    return json(500, { success: false, message: e instanceof Error ? e.message : String(e) });
  }
  const digest = await sha256Bytes(new TextEncoder().encode(`${PUBLIC_CONTENT_ETAG_NS}\0${data}`));
  const etag = `W/"${bytesToHex(digest)}"`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    etag,
    "cache-control": "no-cache",
    vary: "Accept-Encoding",
  };
  if (etagMatches(req.headers.get("if-none-match") || "", etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(encoded, { status: 200, headers });
}

/** Original `controller.videoProxyError`. */
export function videoProxyError(status: number, type: string, message: string): Response {
  return json(status, { error: { message, type } }, { "cache-control": "private, no-store" });
}

/** Original `controller.writeTaskArtifactError`. */
export function taskArtifactError(status: number, code: string, message: string, apiPath = false): Response {
  const extra = { "cache-control": "private, no-store" };
  if (apiPath) return json(status, { success: false, code, message }, extra);
  return json(status, { error: { message, type: code, code } }, extra);
}

export function openaiError(
  status: number,
  message: string,
  code: string | number = "new_api_error",
  type = "new_api_error",
  extra?: HeadersInit,
): Response {
  return json(
    status,
    {
      error: { message, type, param: "", code },
    },
    extra,
  );
}

/**
 * Original leftover Relay defer `c.JSON` gin.H after `WithOpenAIError`
 * (`ErrorTypeOpenAIError` `ToOpenAIError` uses RelayError.Message, so a client
 * request id is not appended). Empty Type is `upstream_error`. Empty Message is
 * `openai_error` (`string(e.errorType)`). `code` stays the original `any`.
 */
export function leftoverWithOpenAIError(
  status: number,
  message: string,
  code: unknown,
  type = "",
  param = "",
): Response {
  return json(status, {
    error: {
      message: message || "openai_error",
      type: type || "upstream_error",
      param,
      code,
    },
  });
}

/** Original `dto.GetOpenAIError` from `OpenAITextResponse` / `SimpleResponse` / `OpenAIResponsesResponse`. */
export type OpenAIErrorFields = {
  message: string;
  type: string;
  param: string;
  code: unknown;
};

export function getOpenAIError(errorField: unknown): OpenAIErrorFields | null {
  if (errorField == null) return null;
  if (typeof errorField === "string") {
    return { type: "error", message: errorField, param: "", code: undefined };
  }
  if (typeof errorField === "object" && !Array.isArray(errorField)) {
    const err = errorField as Record<string, unknown>;
    return {
      type: typeof err.type === "string" ? err.type : "",
      message: typeof err.message === "string" ? err.message : "",
      param: typeof err.param === "string" ? err.param : "",
      code: Object.prototype.hasOwnProperty.call(err, "code") ? err.code : undefined,
    };
  }
  return { type: "unknown_error", message: String(errorField), param: "", code: undefined };
}

/**
 * Original leftover Relay defer `c.JSON` gin.H after `OpenaiHandler` /
 * `OpenaiImageHandler` / `OaiResponsesHandler` `GetOpenAIError` `WithOpenAIError`
 * (`ErrorTypeOpenAIError`). Chat `ToOpenAIError` uses RelayError.Message (no
 * request id). Claude `ToClaudeError` uses `e.Error()` after `SetMessage`
 * (`MessageWithRequestId`) and `type` is `fmt.Sprintf("%v", OpenAIError.Code)`
 * (`<nil>` when Code is unset). Extra-OK: generated RequestId is not appended
 * (hop 314).
 */
export function writeOpenaiHandlerOpenAIError(req: Request, status: number, oai: OpenAIErrorFields): Response {
  const path = new URL(req.url).pathname;
  if (relayUsesClaudeError(path)) {
    const rid = req.headers.get("x-oneapi-request-id") || "";
    const msg = rid ? messageWithRequestId(oai.message, rid) : oai.message;
    const type = oai.code === undefined || oai.code === null ? "<nil>" : String(oai.code);
    const error: { type?: string; message: string } = { message: msg };
    if (type) error.type = type;
    return json(status, { type: "error", error });
  }
  return leftoverWithOpenAIError(status, oai.message, oai.code ?? null, oai.type, oai.param);
}

/** Original `types.WithOpenAIError` fields on a thrown convert error. */
export function newWithOpenAIError(
  message: string,
  code: string | number,
  type = "",
  param = "",
): Error {
  const err = new Error(message) as Error & {
    withOpenAIError: true;
    type: string;
    code: string | number;
    param?: string;
  };
  err.withOpenAIError = true;
  err.type = type || "upstream_error";
  err.code = code;
  if (param) err.param = param;
  return err;
}

/** Original `types.ErrorCodeInvalidRequest`. */
export const ERROR_CODE_INVALID_REQUEST = "invalid_request";

/** Original `types.ErrorCodeModelPriceError`. */
export const ERROR_CODE_MODEL_PRICE_ERROR = "model_price_error";

/** Original `types.ErrorCodeConvertRequestFailed`. */
export const ERROR_CODE_CONVERT_REQUEST_FAILED = "convert_request_failed";

/** Original `types.ErrorCodeDoRequestFailed`. */
export const ERROR_CODE_DO_REQUEST_FAILED = "do_request_failed";

/** Original `types.ErrorCodeGetChannelFailed`. */
export const ERROR_CODE_GET_CHANNEL_FAILED = "get_channel_failed";

/** Original `types.ErrorCodeChannelInvalidKey`. */
export const ERROR_CODE_CHANNEL_INVALID_KEY = "channel:invalid_key";

/** Original `types.ErrorCodeBadResponseBody`. */
export const ERROR_CODE_BAD_RESPONSE_BODY = "bad_response_body";

/**
 * Original leftover Relay defer `c.JSON` gin.H after `OpenaiHandler` /
 * `OpenaiImageHandler` / `OaiResponsesHandler` / `common_handler.RerankHandler`
 * / `ali.RerankHandler` / `siliconflowRerankHandler` `common.Unmarshal` /
 * `json.Unmarshal` fail (`NewOpenAIError` `ErrorCodeBadResponseBody` HTTP 500,
 * `ErrorTypeOpenAIError`). Chat `ToOpenAIError` uses RelayError.Message (no
 * request id). Claude `ToClaudeError` uses `e.Error()` after `SetMessage`.
 * Extra-OK: generated RequestId is not appended (hop 314). Extra-OK: Cohere
 * `cohereRerankHandler` uses `NewError` + `writeRelayNewAPIError` instead.
 * Extra-OK: OpenRouter enterprise unwrap (`Success=false` /
 * `OpenRouterEnterpriseResponse` unmarshal) also uses this envelope.
 * Extra-OK: chat via-responses `OaiResponsesToChatHandler` unmarshal uses this
 * envelope with type name `dto.OpenAIResponsesResponse`. Extra-OK: compact
 * `OaiResponsesCompactionHandler` unmarshal uses this envelope with type name
 * `dto.OpenAIResponsesCompactionResponse`. Extra-OK: Palm / Tencent native /
 * Zhipu v3 `json.Unmarshal` also uses this envelope. Extra-OK: Baidu
 * `baiduHandler` / `baiduEmbeddingHandler` use `NewError` +
 * `writeRelayNewAPIError` instead. Extra-OK: Coze `cozeChatHandler` uses
 * `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Dify `difyHandler`
 * uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Moka
 * `mokaEmbeddingHandler` uses `NewError` + `writeRelayNewAPIError` instead.
 * Extra-OK: Cloudflare `cfHandler` / `cfSTTHandler` use `NewError` +
 * `writeRelayNewAPIError` instead. Extra-OK: xAI `xAIHandler` uses `NewError` +
 * `writeRelayNewAPIError` instead. Extra-OK: Jimeng `jimengImageHandler`
 * unmarshal uses this envelope. Extra-OK: Jimeng chat / completions
 * `openai.OpenaiHandler` (native adaptor) unmarshal also uses this envelope.
 * Extra-OK: Mistral chat / completions `openai.OpenaiHandler` (native adaptor)
 * unmarshal also uses this envelope. Extra-OK: Submodel chat / completions
 * `openai.OpenaiHandler` (native adaptor) unmarshal also uses this envelope. Extra-OK: Jina embeddings `openai.OpenaiHandler` (native adaptor) unmarshal also uses this envelope. Extra-OK: Vertex RequestModeOpenSource `openai.OpenaiHandler` (native adaptor) unmarshal also uses this envelope. Extra-OK: Perplexity `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Siliconflow non-rerank `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Deepseek OpenAI-format `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Moonshot OpenAI-format `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Baidu V2 `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Ali non-image/rerank `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Ali image `aliImageHandler` unmarshal also uses this envelope. Extra-OK: Volc non-TTS `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: MiniMax OpenAI-format `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: MiniMax image `miniMaxImageHandler` unmarshal also uses this envelope.
 * Extra-OK: Ollama `ollamaEmbeddingHandler` /
 * `ollamaChatHandler` unmarshal also uses this envelope. Extra-OK: Zhipu v4 OpenAI-format `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: newapi OpenAI-format `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: sub2api OpenAI-format `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: advanced-custom OpenAI-shaped `openai.Adaptor.DoResponse` (native adaptor) unmarshal also uses this envelope. Extra-OK: Codex `OaiResponsesHandler` / `OaiResponsesCompactionHandler` unmarshal also uses this envelope. Extra-OK: Claude `HandleClaudeResponseData` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: AWS API-key `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Vertex RequestModeClaude `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Moonshot Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: MiniMax Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Deepseek Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Zhipu v4 Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: newapi Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: sub2api Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Ollama Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Ali anthropic-messages Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Volc special-base Claude-format `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: AWS AKSK non-Nova `awsHandler` `HandleClaudeResponseData` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: advanced-custom chat-to-Claude / ConverterNone+RelayFormatClaude `claude.Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: advanced-custom chat-to-Gemini / ConverterNone+RelayFormatGemini `gemini.Adaptor.DoResponse` unmarshal uses `NewOpenAIError` + `writeGeminiChatUnmarshalError` instead. Extra-OK: advanced-custom responses-to-Gemini `GeminiResponsesHandler` unmarshal uses `NewOpenAIError` + `writeGeminiChatUnmarshalError` instead. Extra-OK: Claude stream `HandleStreamResponseData` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: AWS AKSK `awsStreamHandler` `HandleStreamResponseData` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: AWS API-key stream `claude.Adaptor` `ClaudeStreamHandler` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Vertex RequestModeClaude stream `claude.Adaptor` `ClaudeStreamHandler` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Moonshot Claude-format stream `claude.Adaptor` `ClaudeStreamHandler` unmarshal uses `NewError` + `writeRelayNewAPIError` instead. Extra-OK: Zhipu v4
 * `zhipu4vImageHandler` unmarshal also uses this envelope. Extra-OK: Replicate
 * `Adaptor.DoResponse` unmarshal uses `NewError` + `writeRelayNewAPIError`
 * instead. Extra-OK: MiniMax `handleTTSResponse` unmarshal uses `NewError` +
 * `writeRelayNewAPIError` instead. Extra-OK: AWS Nova `handleNovaRequest`
 * unmarshal uses `NewError` + `writeRelayNewAPIError` instead.
 */
export function writeOpenaiHandlerUnmarshalError(req: Request, message: string): Response {
  return writeOpenaiHandlerOpenAIError(req, 500, {
    message,
    type: ERROR_CODE_BAD_RESPONSE_BODY,
    param: "",
    code: ERROR_CODE_BAD_RESPONSE_BODY,
  });
}

/** Original `types.ErrorCodeBadResponseStatusCode`. */
export const ERROR_CODE_BAD_RESPONSE_STATUS_CODE = "bad_response_status_code";

/** Original `types.ErrorCodeEmptyResponse`. */
export const ERROR_CODE_EMPTY_RESPONSE = "empty_response";

/** Original `types.ErrorCodePromptBlocked`. */
export const ERROR_CODE_PROMPT_BLOCKED = "prompt_blocked";

/** Original `types.ErrorTypeNewAPIError`. */
export const ERROR_TYPE_NEW_API_ERROR = "new_api_error";

/**
 * Original `controller.Relay` `RelayFormatClaude` is POST `/v1/messages`
 * (`httpRouter.POST("/messages")`). Extra-OK: trailing slash.
 */
export function relayUsesClaudeError(path: string): boolean {
  return path === "/v1/messages" || path === "/v1/messages/";
}

/** Original `NewAPIError.ToClaudeError` default branch (omitempty, no param/code). */
export function toClaudeRelayError(message: string): { type: string; message: string } {
  return { type: ERROR_TYPE_NEW_API_ERROR, message };
}

/**
 * Original leftover `GeminiChatHandler` empty-candidates gin.H after `NewOpenAIError`
 * + `ResetStatusCode`. Claude is `{type:"error",error:ToClaudeError()}` with
 * `ErrorTypeOpenAIError` (`fmt.Sprintf("%v", OpenAIError.Code)`). Else
 * `{error:ToOpenAIError()}` (`type`/`code` are the ErrorCode, `param:""`).
 * Extra-OK: no MessageWithRequestId (GeminiChatHandler writes before Relay defer).
 */
export function writeGeminiChatEmptyCandidatesError(
  req: Request,
  status: number,
  message: string,
  code: string,
): Response {
  const path = new URL(req.url).pathname;
  if (relayUsesClaudeError(path)) {
    return json(status, { type: "error", error: { type: code, message } });
  }
  return openaiError(status, message, code, code);
}

/**
 * Original leftover Relay defer `c.JSON` gin.H after `GeminiChatHandler` /
 * `GeminiResponsesHandler` / native `GeminiTextGenerationHandler`
 * `common.Unmarshal` fail (`NewOpenAIError` `ErrorCodeBadResponseBody` HTTP 500).
 * Claude is `{type:"error",error:ToClaudeError()}` with `ErrorTypeOpenAIError`
 * (`fmt.Sprintf("%v", OpenAIError.Code)` = `bad_response_body`). Else
 * `{error:ToOpenAIError()}` (`type`/`code` are `bad_response_body`, `param:""`).
 * Extra-OK: generated RequestId is not appended (hop 314); honor client header.
 * Extra-OK: no `ResetStatusCode` (original unmarshal fail does not call it).
 * Extra-OK: Gemini stream `geminiStreamHandler` wrap
 * `unmarshal Gemini stream response: %w` then `NewOpenAIError` (hop 423).
 */
export function writeGeminiChatUnmarshalError(req: Request, message: string): Response {
  const rid = req.headers.get("x-oneapi-request-id") || "";
  const msg = rid ? messageWithRequestId(message, rid) : message;
  const path = new URL(req.url).pathname;
  if (relayUsesClaudeError(path)) {
    return json(500, { type: "error", error: { type: ERROR_CODE_BAD_RESPONSE_BODY, message: msg } });
  }
  return openaiError(500, msg, ERROR_CODE_BAD_RESPONSE_BODY, ERROR_CODE_BAD_RESPONSE_BODY);
}

/** Original `service.ResetStatusCode` for leftover GeminiChatHandler / GeminiResponsesHandler. */
export function resetNewAPIErrorStatusCode(status: number, statusCodeMapping = ""): number {
  if (status === 200) return status;
  if (!statusCodeMapping || statusCodeMapping === "{}") return status;
  try {
    const mapping = JSON.parse(statusCodeMapping) as Record<string, unknown>;
    const mappedVal = mapping[String(status)];
    if (mappedVal == null) return status;
    const n = typeof mappedVal === "number" ? mappedVal : Number(mappedVal);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  } catch {
    /* invalid mapping */
  }
  return status;
}

/**
 * Original leftover Relay defer `c.JSON` gin.H for `newAPIError`
 * (`GetAndValidateRequest` including handleRelay image-edit/audio/unmarshal leftovers,
 * `ModelPriceHelper`, convert/do_request/bad_response_body,
 * last-loop get_channel_failed / do_request_failed, DoResponse NewError
 * channel:invalid_key / invalid_request / bad_response / image billing):
 * Claude `{type:"error",error:ToClaudeError()}`; else `{error:ToOpenAIError()}`.
 * Extra-OK: generated RequestId is not appended (hop 314); honor client header.
 * Extra-OK: Claude `ToClaudeError` default type stays `new_api_error` (hop 349 envelope)
 * even when OpenAI `error.type` is a `NewOpenAIError` code.
 */
export function writeRelayNewAPIError(
  req: Request,
  status: number,
  message: string,
  code: string,
  type = ERROR_TYPE_NEW_API_ERROR,
): Response {
  const rid = req.headers.get("x-oneapi-request-id") || "";
  const msg = rid ? messageWithRequestId(message, rid) : message;
  const path = new URL(req.url).pathname;
  if (relayUsesClaudeError(path)) {
    return json(status, { type: "error", error: toClaudeRelayError(msg) });
  }
  return openaiError(status, msg, code, type);
}

/** Original `service.RelayErrorHandler` + `ResetStatusCode`.
 * Extra-OK: leftover Relay defer Claude envelope when `req` is POST `/v1/messages`
 * (`ToClaudeError` ErrorTypeOpenAIError uses `fmt.Sprintf("%v", OpenAIError.Code)`).
 * Extra-OK: generated RequestId is not appended (hop 314); honor client header on Claude.
 */
export function relayErrorHandler(status: number, bodyText: string, statusCodeMapping = "", req?: Request): Response {
  let message = `bad response status code ${status}`;
  let type = "bad_response_status_code";
  let code: unknown = "bad_response_status_code";
  let param = "";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const errField = parsed.error;
    if (errField && typeof errField === "object") {
      const err = errField as Record<string, unknown>;
      if (typeof err.message === "string" && err.message) {
        message = err.message;
        if (typeof err.type === "string" && err.type) type = err.type;
        if (err.code != null && err.code !== "") code = err.code;
        if (typeof err.param === "string") param = err.param;
      }
    } else {
      if (typeof errField === "string" && errField) message = errField;
      else {
        const extracted = [parsed.message, parsed.msg, parsed.err, parsed.error_msg, parsed.detail].find(
          (v) => typeof v === "string" && v,
        ) as string | undefined;
        if (extracted) message = extracted;
      }
    }
  } catch {
    /* non-JSON body: original InitOpenAIError + "bad response status code N" */
  }
  let mapped = status;
  if (statusCodeMapping && statusCodeMapping !== "{}") {
    try {
      const mapping = JSON.parse(statusCodeMapping) as Record<string, unknown>;
      const mappedVal = mapping[String(status)];
      if (mappedVal != null) {
        const n = typeof mappedVal === "number" ? mappedVal : Number(mappedVal);
        if (Number.isInteger(n) && n >= 100 && n <= 599) mapped = n;
      }
    } catch {
      /* invalid mapping */
    }
  }
  const rid = req?.headers.get("x-oneapi-request-id") || "";
  const msg = rid && req && relayUsesClaudeError(new URL(req.url).pathname) ? messageWithRequestId(message, rid) : message;
  if (req && relayUsesClaudeError(new URL(req.url).pathname)) {
    return json(mapped, { type: "error", error: { type: String(code), message: msg } });
  }
  return json(mapped, { error: { message: msg, type, param, code } });
}

/** Original `controller.respondPluginProtocolError`. */
export function pluginProtocolError(status: number, code: string, message: string): Response {
  return json(status, { error: { message, type: "new_api_error", code } });
}

/** Original `controller.respondPluginProtocolSubmissionError`. */
export function pluginProtocolSubmissionError(err: { statusCode: number; code: string; message: string }): Response {
  let status = err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 500;
  switch (status) {
    case 400: {
      let message = "Invalid task protocol request";
      if (err.message && (err.code === "invalid_request" || err.code.startsWith("invalid_request"))) {
        message = err.message;
      }
      return pluginProtocolError(status, "invalid_request_error", message);
    }
    case 401:
      return pluginProtocolError(status, "authentication_error", "Authentication failed");
    case 403:
      return pluginProtocolError(status, "permission_denied", "Task protocol request was denied");
    case 429:
      return pluginProtocolError(status, "rate_limit_exceeded", "Too many requests");
    default:
      return pluginProtocolError(status, "task_protocol_error", "Task protocol request failed");
  }
}

/** Original `dto.TaskError` JSON (`code`, `message`, `data`). */
export function taskErrorJson(status: number, code: string, message: string): Response {
  return json(status, { code, message, data: null });
}

/** Original `middleware.sanitizedTaskPluginError`. */
export function sanitizedTaskPluginError(
  status: number,
  detail = "",
): { code: string; message: string; httpStatus: number; retryable: boolean } {
  let httpStatus = status;
  let code = "server_error";
  let message = "Task request failed";
  let retryable = false;
  switch (status) {
    case 400:
      code = "invalid_request";
      message = "Invalid request";
      httpStatus = 400;
      break;
    case 401:
      code = "authentication_error";
      message = "Authentication failed";
      httpStatus = 401;
      break;
    case 403:
      code = "permission_denied";
      message = "Access denied";
      httpStatus = 403;
      break;
    case 404:
      code = "task_not_found";
      message = "Task not found";
      httpStatus = 404;
      break;
    case 409:
      code = "request_conflict";
      message = "Request conflict";
      httpStatus = 409;
      break;
    case 429:
      code = "rate_limit_exceeded";
      message = "Too many requests";
      httpStatus = 429;
      retryable = true;
      break;
    default:
      if (httpStatus < 400 || httpStatus > 599) httpStatus = 500;
      if (httpStatus < 500) {
        code = "invalid_request";
        message = "Invalid request";
      } else {
        code = "server_error";
        message = "Task request failed";
        retryable = httpStatus >= 500;
      }
  }
  if (detail && httpStatus < 500) message = detail;
  return { code, message, httpStatus, retryable };
}

/** Original `common.MessageWithRequestId`. */
export function messageWithRequestId(message: string, requestId: string): string {
  if (!requestId) return message;
  return `${message} (request id: ${requestId})`;
}

/** Original `middleware.abortWithOpenAiMessage` OpenAI envelope (no `param`). */
export function abortWithOpenAiMessage(
  status: number,
  message: string,
  code = "",
  requestId = "",
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);
  if (requestId) headers.set("X-Oneapi-Request-Id", requestId);
  return json(
    status,
    {
      error: {
        message: messageWithRequestId(message, requestId),
        type: "new_api_error",
        code,
      },
    },
    headers,
  );
}

/** Original `middleware.abortTaskPluginRouteErrorDetail` host fallback JSON. */
export function taskPluginRouteError(status: number, detail = "", requestId = ""): Response {
  const taskErr = sanitizedTaskPluginError(status, detail);
  const message = messageWithRequestId(taskErr.message, requestId);
  const extra: HeadersInit = {};
  if (requestId) extra["X-Oneapi-Request-Id"] = requestId;
  return json(taskErr.httpStatus, { code: taskErr.code, message, data: null }, extra);
}

/** Original plugin inner Gin `NoMethod` `AbortWithStatus(405)` empty body. */
export function pluginMethodNotAllowed(): Response {
  return new Response(null, { status: 405 });
}

/** Original `pluginRouteRecovery` panic JSON. */
export function pluginRoutePanicError(): Response {
  return json(500, { error: { message: "internal plugin route error", type: "plugin_route_error" } });
}

/** Original `gin.CustomRecovery` / `RelayPanicRecover` panic type. */
export const NEW_API_PANIC_TYPE = "new_api_panic";

/** Original CustomRecovery issue URL (Calcium-Ion/new-api, including the `a issue` wording). */
export const NEW_API_PANIC_ISSUE_URL = "https://github.com/Calcium-Ion/new-api";

/** Original `fmt.Sprintf("%v", err)` for recover(). */
export function panicValue(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Original `Panic detected, error: %v. Please submit a issue here: https://github.com/Calcium-Ion/new-api`. */
export function panicDetectedMessage(err: unknown): string {
  return `Panic detected, error: ${panicValue(err)}. Please submit a issue here: ${NEW_API_PANIC_ISSUE_URL}`;
}

/** Original `gin.CustomRecovery` leftover HTTP 500 gin.H `{error:{message,type:new_api_panic}}`. */
export function newApiPanicError(err: unknown): Response {
  return json(500, { error: { message: panicDetectedMessage(err), type: NEW_API_PANIC_TYPE } });
}

/** Original `PrepareTaskPluginSubmit` `AbortWithStatusJSON` invalid_request_error (no `code`). */
export function invalidTaskPluginRequestError(message: string): Response {
  return json(400, { error: { message, type: "invalid_request_error" } });
}

/** Original `controller.RelayNotImplemented`. */
export function relayNotImplemented(): Response {
  return json(501, {
    error: { message: "API not implemented", type: "new_api_error", param: "", code: "api_not_implemented" },
  });
}

/** Original `controller.RelayNotFound`. */
export function relayNotFound(method: string, path: string): Response {
  return json(
    404,
    {
      error: {
        message: `Invalid URL (${method} ${path})`,
        type: "invalid_request_error",
        param: "",
        code: "",
      },
    },
    {
      "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
      pragma: "no-cache",
      expires: "0",
    },
  );
}

/** Original `common.ApiErrorI18n(c, i18n.MsgInvalidParams)` gin.H (HTTP 200, no `data`). */
export function apiFailInvalidParams(req: Request): Response {
  return apiErrorMsg(i18nPair(req, "无效的参数", "Invalid parameters"));
}

/** Original `middleware.CORS` `AllowMethods` after `cors.DefaultConfig`. */
export const CORS_ALLOW_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
/** Original `cors.DefaultConfig` `MaxAge` `12 * time.Hour`. */
export const CORS_MAX_AGE_SECONDS = "43200";

function requestHost(req: Request): string {
  return req.headers.get("host") || new URL(req.url).host;
}

/**
 * Original `gin-contrib/cors` v1.7.2 `applyCors`: empty Origin and
 * same-origin `http(s)://`+Host are not CORS requests.
 */
export function corsApplies(req: Request): boolean {
  const origin = req.headers.get("origin") || "";
  if (!origin) return false;
  const host = requestHost(req);
  if (origin === "http://" + host || origin === "https://" + host) return false;
  return true;
}

/**
 * Original `generateNormalHeaders` / `generatePreflightHeaders` for
 * `AllowAllOrigins` + `AllowCredentials` + original AllowMethods/AllowHeaders.
 * AllowAllOrigins does not set `Vary`.
 */
export function corsHeaders(req: Request): Headers {
  const h = new Headers();
  h.set("access-control-allow-credentials", "true");
  h.set("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    h.set("access-control-allow-methods", CORS_ALLOW_METHODS);
    h.set("access-control-allow-headers", "*");
    h.set("access-control-max-age", CORS_MAX_AGE_SECONDS);
  }
  return h;
}

/** Original `middleware.CORS` leftover headers when `applyCors` runs. */
export function withCors(req: Request, res: Response): Response {
  if (!corsApplies(req)) return res;
  const c = corsHeaders(req);
  const ws = (res as Response & { webSocket?: unknown }).webSocket;
  if (res.status === 101 || ws) {
    c.forEach((v, k) => res.headers.set(k, v));
    return res;
  }
  const headers = new Headers(res.headers);
  c.forEach((v, k) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}

/** Original `strconv.ParseInt(c.Query(name), 10, 64)`: missing/invalid → 0. */
export function parseUnixQuery(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  if (!raw) return 0;
  const parsed = strconvParseInt(raw);
  return parsed.ok ? parsed.n : 0;
}

export function pageQuery(url: URL): PageQuery {
  const page = Math.max(1, Number(url.searchParams.get("p") || url.searchParams.get("page") || "1") || 1);
  const page_size = Math.min(
    100,
    Math.max(
      1,
      Number(
        url.searchParams.get("page_size") ||
          url.searchParams.get("ps") ||
          url.searchParams.get("size") ||
          "10",
      ) || 10,
    ),
  );
  return { page, page_size, offset: (page - 1) * page_size };
}

/** Original SearchChannels `DefaultQuery("p","1")` / `page_size` (default 20, no max 100). */
export function searchChannelPageQuery(url: URL): PageQuery {
  const pageRaw = Number.parseInt(url.searchParams.get("p") || "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const sizeRaw = Number.parseInt(url.searchParams.get("page_size") || "20", 10);
  const page_size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : 20;
  return { page, page_size, offset: (page - 1) * page_size };
}

export function pageData(items: unknown, total: number, q: PageQuery, extra: Record<string, unknown> = {}) {
  return { items, total, page: q.page, page_size: q.page_size, ...extra };
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

export { ginClientIP as clientIp, rememberRequestTrustedProxies, carryRequestTrustedProxies } from "./trusted-proxies.js";

export function cookieGet(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const GO_COOKIE_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const GO_COOKIE_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Original `http.SetCookie` clear expiry `time.Unix(1, 0)`. */
export const GO_COOKIE_CLEAR_EXPIRES = new Date(1000);

/** Go `net/http.TimeFormat` (`Mon, 02 Jan 2006 15:04:05 GMT`) used by `Cookie.String`. */
export function formatGoCookieExpires(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${GO_COOKIE_DOW[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${GO_COOKIE_MON[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
}

export type GoCookieAttrs = {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date;
  /** Go `Cookie.MaxAge`: >0 writes Max-Age=N; <0 writes Max-Age=0; 0 omits Max-Age. */
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Default" | "None" | "Lax" | "Strict";
};

/**
 * Original `net/http.Cookie.String` attribute order:
 * Name=Value; Path; Domain; Expires; Max-Age; HttpOnly; Secure; SameSite
 */
export function serializeGoCookie(c: GoCookieAttrs): string {
  const parts = [`${c.name}=${c.value}`];
  if (c.path) parts.push(`Path=${c.path}`);
  if (c.domain) parts.push(`Domain=${c.domain}`);
  if (c.expires && c.expires.getUTCFullYear() >= 1601) {
    parts.push(`Expires=${formatGoCookieExpires(c.expires)}`);
  }
  const maxAge = c.maxAge ?? 0;
  if (maxAge > 0) parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  else if (maxAge < 0) parts.push("Max-Age=0");
  if (c.httpOnly) parts.push("HttpOnly");
  if (c.secure) parts.push("Secure");
  switch (c.sameSite) {
    case "None":
      parts.push("SameSite=None");
      break;
    case "Lax":
      parts.push("SameSite=Lax");
      break;
    case "Strict":
      parts.push("SameSite=Strict");
      break;
  }
  return parts.join("; ");
}

function cookieExpiresFrom(maxAge: number, expiresAtSec?: number): Date | undefined {
  if (expiresAtSec && expiresAtSec > 0) return new Date(expiresAtSec * 1000);
  if (maxAge > 0) return new Date(Date.now() + maxAge * 1000);
  if (maxAge < 0) return GO_COOKIE_CLEAR_EXPIRES;
  return undefined;
}

export function sessionCookie(
  token: string,
  maxAge: number,
  secure: boolean,
  name = "session",
  path = "/",
  sameSite: "Lax" | "Strict" = "Strict",
  expiresAtSec?: number,
): string {
  return serializeGoCookie({
    name,
    value: token,
    path,
    maxAge,
    expires: cookieExpiresFrom(maxAge, expiresAtSec),
    httpOnly: true,
    secure,
    sameSite,
  });
}

export function sessionHintCookie(maxAge: number, secure: boolean, expiresAtSec?: number): string {
  return serializeGoCookie({
    name: "new_api_has_session",
    value: "1",
    path: "/",
    maxAge,
    expires: cookieExpiresFrom(maxAge, expiresAtSec),
    httpOnly: false,
    secure,
    sameSite: "Strict",
  });
}

export function refreshCookie(token: string, maxAge: number, secure: boolean, expiresAtSec?: number): string {
  return sessionCookie(token, maxAge, secure, "new_api_refresh", "/api/user/auth", "Strict", expiresAtSec);
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", -1, secure);
}

/** Original `service.ClearRefreshCookie`: refresh + session-hint only. */
export function clearAuthCookies(secure: boolean): string[] {
  return [
    serializeGoCookie({
      name: "new_api_refresh",
      value: "",
      path: "/api/user/auth",
      maxAge: -1,
      expires: GO_COOKIE_CLEAR_EXPIRES,
      httpOnly: true,
      secure,
      sameSite: "Strict",
    }),
    serializeGoCookie({
      name: "new_api_has_session",
      value: "",
      path: "/",
      maxAge: -1,
      expires: GO_COOKIE_CLEAR_EXPIRES,
      httpOnly: false,
      secure,
      sameSite: "Strict",
    }),
  ];
}

export function withSetCookies(res: Response, cookies: string[]): Response {
  const headers = new Headers(res.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, headers });
}

export function isSecureRequest(req: Request): boolean {
  const url = new URL(req.url);
  return url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}
