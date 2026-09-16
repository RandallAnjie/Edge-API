import {
  ROLE_ADMIN,
  ROLE_GUEST,
  ROLE_ROOT,
  ROLE_USER,
  ROOT_QUOTA,
  TOKEN_ENABLED,
  TOKEN_EXPIRED,
  TOKEN_EXHAUSTED,
  USER_DISABLED,
  USER_ENABLED,
  DEFAULT_GROUP_RATIO,
  DEFAULT_TOKEN_QUOTA,
  MAX_WALLET_QUOTA,
  canManageTargetRole,
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  CHANNEL_TYPE_TASK_PLUGIN,
  CHANNEL_ENABLED,
  isManageableChannelStatus,
  nowSec,
  parseGoBool,
  parseJson,
} from "./constants.js";
import { canWithPolicies, permissionDeltas, roleKeyForSystemRole, roleSubject, userSubject } from "./authz.js";
import { channelDefaultBaseURLs, defaultBaseUrl } from "./catalog.js";
import {
  appendChannelKeys,
  channelHasSensitiveChanges,
  CHANNEL_READ_ONLY_FIELDS,
  channelKeys,
  multiKeyInfoFromKeys,
  parseChannelInfo,
  stringifyChannelInfo,
} from "./channel-info.js";
import {
  buildAdvancedCustomModelPreviewChannel,
  channelFieldsFromBody,
  expandAddChannelKeys,
  previewNonCustomChannel,
  goJSONKind,
  goUnmarshalJSON,
  validateChannel,
  validateChannelSettings,
  type AddChannelMode,
} from "./channel-validate.js";
import {
  generateAffCode,
  generateRedemptionKey,
  generateTokenKey,
  displayTokenKey,
  hashPassword,
  validateNewAccountPassword,
  verifyPassword,
  decryptPassword,
  utf8RuneCount,
} from "./crypto.js";
import {
  apiErrorMsg,
  apiFail,
  apiFailInvalidParams,
  apiOk,
  apiOkExtra,
  clientIp,
  databaseErrorMessage,
  i18nPair,
  json,
  pageData,
  pageQuery,
  parseUnixQuery,
  paymentComplianceRequiredMessage,
  readJson,
  searchChannelPageQuery,
  serveRevalidatedJSON,
  strconvAtoi,
  strconvParseBool,
  userEmailAlreadyTakenMessage,
  userEmailVerificationRequiredMessage,
  userExistsMessage,
  userInputInvalidMessage,
  userPasswordLoginDisabledMessage,
  userPasswordRegisterDisabledMessage,
  userRegisterDisabledMessage,
  userUsernameOrPasswordErrorMessage,
  userVerificationCodeErrorMessage,
} from "./http.js";
import { ERR_TELEGRAM_OAUTH_NOT_CONFIGURED, telegramSettingsConfigured } from "./telegram-oauth.js";
import type { Context } from "./router.js";
import { Router } from "./router.js";
import {
  authLogout,
  issueSessionSafe,
  isResponse,
  maybeClearRefreshCookie,
  readSession,
  refreshLoginSession,
  requireAdmin,
  requireChannel,
  requirePermission,
  requireProof,
  requireRoot,
  requireUser,
  publicSelf,
  sessionResponse,
  sessionSecret,
  startLoginVerification,
} from "./auth.js";
import { Store, publicUser, stripChannelKey, parseChannelStatusFilter } from "./store.js";
import { publicToken, buildPricing, userGroupsView, userUsableGroups, userAutoGroups, publicLog, publicUserLogs, dashboardListModels, channelListModels, publicOptions, publicQuotaData, manageUserView, publicMj, publicChannel, publicRedemption } from "./dto.js";
import { fetchUpstreamModels, playgroundRelay, testChannel } from "./relay.js";
import { registerMore } from "./more-routes.js";
import { buildStatus } from "./status.js";
import { headerNavModuleAuth, isHeaderNavDenied } from "./header-nav.js";
import { paymentComplianceConfirmed, requirePaymentCompliance } from "./payments.js";
import { storeLogQuota } from "./quota.js";
import { finishInsertUser } from "./user-insert.js";
import { notifyAccountSecurityChange, normalizeEmail } from "./mail.js";
import { isPasskeyDomainOption, PasskeyDomainError, passkeyDomainHttpError, updatePasskeyDomainOptions } from "./passkey-domains.js";
import { checkModelRequestRateLimitGroup } from "./model-rate-limit.js";
import { parseHTTPStatusCodeRanges } from "./status-code-ranges.js";
import { TOOL_PRICE_OPTION_KEY, validateToolPricesJSON } from "./tool-price.js";
import { PLUGIN_BILLING_EXPR_OPTION, validateBillingExprOption, validatePluginBillingExprOption } from "./model-pricing.js";
import { validateConsoleSettings } from "./console-setting.js";
import type { Env, RedemptionRow, TokenRow, UserRow } from "./types.js";

type C = Context<Env>;

function store(c: C): Store {
  return new Store(c.env.DB);
}

/** Original `strconv.ParseBool(c.Query(name))` with `_` error ignore. */
function queryParseBool(url: URL, name: string): boolean {
  const parsed = strconvParseBool(url.searchParams.get(name) || "");
  return parsed.ok ? parsed.v : false;
}

async function canTaskPluginBind(s: Store, u: { id: number }): Promise<boolean> {
  const user = await s.getUserById(u.id);
  if (!user) return false;
  const roleKey = roleKeyForSystemRole(user.role);
  const userPolicies = await s.casbinPolicies(userSubject(user.id));
  const rolePolicies = roleKey ? await s.casbinPolicies(roleSubject(roleKey)) : [];
  return canWithPolicies(user, "task_plugin", "bind", userPolicies, rolePolicies);
}

async function canChannelSensitiveWrite(s: Store, u: { id: number }): Promise<boolean> {
  const user = await s.getUserById(u.id);
  if (!user) return false;
  const roleKey = roleKeyForSystemRole(user.role);
  const userPolicies = await s.casbinPolicies(userSubject(user.id));
  const rolePolicies = roleKey ? await s.casbinPolicies(roleSubject(roleKey)) : [];
  return canWithPolicies(user, "channel", "sensitive_write", userPolicies, rolePolicies);
}

/** Original `controller.AddToken` / `UpdateToken` i18n + AutoGroups checks. */
async function tokenWriteError(
  req: Request,
  s: Store,
  user: { id: number; group?: string },
  body: { name?: string; remain_quota?: number; unlimited_quota?: boolean; group?: string; auto_groups?: string[] },
  creating: boolean,
): Promise<Response | null> {
  if (String(body.name || "").length > 50) {
    return apiErrorMsg(i18nPair(req, "令牌名称过长", "Token name is too long"));
  }
  const unlimited = Boolean(body.unlimited_quota);
  const remain = Number(body.remain_quota || 0);
  if (!unlimited) {
    if (remain < 0) return apiErrorMsg(i18nPair(req, "额度值不能为负数", "Quota value cannot be negative"));
    const quotaPerUnit = await s.optionNum("QuotaPerUnit", 500000);
    const maxQuota = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(1_000_000_000 * quotaPerUnit));
    if (remain > maxQuota) {
      return apiErrorMsg(i18nPair(req, `额度值超出有效范围，最大值为 ${maxQuota}`, `Quota value exceeds valid range, maximum is ${maxQuota}`));
    }
  }
  if (creating) {
    const maxTokens = await s.optionNum("token_setting.max_user_tokens", 1000);
    const total = await s.countUserTokens(user.id);
    if (total >= maxTokens) return apiErrorMsg(`已达到最大令牌数量限制 (${maxTokens})`);
  }
  if (body.group === "auto" && Array.isArray(body.auto_groups) && body.auto_groups.length) {
    const maxCount = await s.optionNum("MaxTokenAutoGroups", 5);
    if (body.auto_groups.length > maxCount) {
      return apiErrorMsg(i18nPair(req, `每个令牌最多可选择 ${maxCount} 个 Auto 分组`, `A token can select at most ${maxCount} Auto groups`));
    }
    const seen = new Set<string>();
    const usable = await userUsableGroups(s, user.group || "default");
    const ratios = parseJson<Record<string, number>>(await s.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
    for (const g of body.auto_groups) {
      if (seen.has(g)) return apiErrorMsg(i18nPair(req, `Auto 分组 ${g} 重复`, `Auto group ${g} is duplicated`));
      seen.add(g);
      if (!g || g === "auto" || usable[g] == null || ratios[g] == null) {
        return apiErrorMsg(i18nPair(req, `Auto 分组 ${g} 不可用或无权访问`, `Auto group ${g} is unavailable or unauthorized`));
      }
    }
  }
  return null;
}

/** Original `model.GetTokenByIds` error strings via `common.ApiError`. */
function tokenByIdsError(id: number, userId: number, token: TokenRow | null): Response | null {
  if (id === 0 || userId === 0) return apiErrorMsg("id 或 userId 为空！");
  if (!token) return apiErrorMsg("record not found");
  return null;
}

/** Original `strconv.Atoi` then `GetTokenByIds` for `GetToken` / `GetTokenKey`. */
async function loadDashboardToken(s: Store, userId: number, rawId: string): Promise<TokenRow | Response> {
  const id = strconvAtoi(rawId);
  if (!id.ok) return apiErrorMsg(id.message);
  const t = await s.getTokenById(id.n, userId);
  const err = tokenByIdsError(id.n, userId, t);
  if (err) return err;
  return t!;
}

/** Original `common.GetPageQuery` then `GetAuditLogs` pagination checks. */
function auditPageQuery(url: URL): { page: number; page_size: number; offset: number } | Response {
  const pRaw = url.searchParams.get("p") || "";
  const parsedPage = pRaw === "" ? NaN : Number.parseInt(pRaw, 10);
  let page = Number.isFinite(parsedPage) ? parsedPage : 0;
  if (page < 1) {
    page = Number.isFinite(parsedPage) && parsedPage !== 0 ? parsedPage : 1;
  }
  const sizeRaw = url.searchParams.get("page_size") || url.searchParams.get("ps") || url.searchParams.get("size") || "";
  const parsedSize = sizeRaw === "" ? NaN : Number.parseInt(sizeRaw, 10);
  let page_size = Number.isFinite(parsedSize) ? parsedSize : 0;
  if (page_size === 0) page_size = 10;
  if (page_size > 100) page_size = 100;
  if (page < 1 || page_size < 1 || page > 100000000) return apiFail("Invalid audit pagination");
  return { page, page_size, offset: (page - 1) * page_size };
}

function parseAuditUnix(raw: string | null): number | "invalid" {
  if (!raw) return 0;
  if (!/^-?\d+$/.test(raw)) return "invalid";
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return "invalid";
  return n;
}

function auditListFilter(c: C): Response | {
  category: string;
  token_ref: string;
  exclude_token_ref: string;
  request_id: string;
  start_timestamp: number;
  end_timestamp: number;
  success?: boolean;
  username: string;
} {
  const category = c.url.searchParams.get("category") || "";
  const tokenRef = c.url.searchParams.get("token_ref") || "";
  const exclude = c.url.searchParams.get("exclude_token_ref") || "";
  if (category && !["login", "security", "operation", "access_token"].includes(category)) return apiFail("Invalid audit filters");
  if ((tokenRef && !/^[0-9a-f]{64}$/.test(tokenRef)) || (exclude && !/^[0-9a-f]{64}$/.test(exclude))) {
    return apiFail("Invalid audit filters");
  }
  const start = parseAuditUnix(c.url.searchParams.get("start_timestamp"));
  const end = parseAuditUnix(c.url.searchParams.get("end_timestamp"));
  if (start === "invalid" || end === "invalid" || (typeof start === "number" && typeof end === "number" && end > 0 && end < start)) {
    return apiFail("Invalid audit time range");
  }
  const successRaw = c.url.searchParams.get("success") || "";
  if (successRaw && successRaw !== "true" && successRaw !== "false") return apiFail("Invalid audit result");
  return {
    category,
    token_ref: tokenRef,
    exclude_token_ref: exclude,
    request_id: c.url.searchParams.get("request_id") || "",
    start_timestamp: start,
    end_timestamp: end,
    success: successRaw === "" ? undefined : successRaw === "true",
    username: c.url.searchParams.get("username") || "",
  };
}

export function adminRouter(): Router<Env> {
  const r = new Router<Env>();

  r.get("/api/setup", async (c) => {
    const s = store(c);
    const done = await s.setupDone();
    if (done) return json(200, { success: true, data: { status: true, root_init: false, database_type: "" } });
    return json(200, { success: true, data: { status: false, root_init: await s.rootExists(), database_type: "sqlite" } });
  });

  r.post("/api/setup", async (c) => {
    const s = store(c);
    if (await s.setupDone()) return json(200, { success: false, message: "系统已经初始化完成" });
    let body: {
      username?: unknown;
      password?: unknown;
      confirmPassword?: unknown;
      SelfUseModeEnabled?: unknown;
      DemoSiteEnabled?: unknown;
    };
    try {
      const text = await c.req.text();
      if (!text) return json(200, { success: false, message: "请求参数有误" });
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(200, { success: false, message: "请求参数有误" });
      }
      body = parsed as typeof body;
    } catch {
      return json(200, { success: false, message: "请求参数有误" });
    }
    if (!(await s.rootExists())) {
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
      if (new TextEncoder().encode(username).length > 12) {
        return json(200, { success: false, message: "用户名长度不能超过12个字符" });
      }
      if (password !== confirmPassword) return json(200, { success: false, message: "两次输入的密码不一致" });
      const passwordErr = validateNewAccountPassword(password);
      if (passwordErr) return json(200, { success: false, message: passwordErr });
      const hashed = await hashPassword(password);
      await s.insertUser({
        username,
        password: hashed,
        display_name: "Root User",
        role: ROLE_ROOT,
        status: USER_ENABLED,
        quota: ROOT_QUOTA,
        group: "default",
        aff_code: generateAffCode(),
      });
    }
    await s.setOption("SelfUseModeEnabled", String(Boolean(body.SelfUseModeEnabled ?? false)));
    await s.setOption("DemoSiteEnabled", String(Boolean(body.DemoSiteEnabled ?? false)));
    await s.setOption("Setup", "true");
    return json(200, { success: true, message: "系统初始化成功" });
  });

  r.get("/api/status", async (c) => apiOk(await buildStatus(store(c), c.env)));

  r.get("/api/notice", async (c) => serveRevalidatedJSON(c.req, await store(c).option("Notice")));
  r.get("/api/about", async (c) => serveRevalidatedJSON(c.req, await store(c).option("About")));
  r.get("/api/home_page_content", async (c) => serveRevalidatedJSON(c.req, await store(c).option("HomePageContent")));
  r.get("/api/user-agreement", async (c) => serveRevalidatedJSON(c.req, await store(c).option("UserAgreement")));
  r.get("/api/privacy-policy", async (c) => serveRevalidatedJSON(c.req, await store(c).option("PrivacyPolicy")));

  r.get("/api/pricing", async (c) => {
    const s = store(c);
    const gate = await headerNavModuleAuth(c, s, "pricing");
    if (isHeaderNavDenied(gate)) return gate;
    const pricing = await buildPricing(s, gate?.group || "");
    return json(200, {
      success: true,
      data: pricing.data,
      vendors: pricing.vendors,
      group_ratio: pricing.group_ratio,
      usable_group: pricing.usable_group,
      supported_endpoint: pricing.supported_endpoint,
      auto_groups: pricing.auto_groups,
      pricing_version: pricing.pricing_version,
    });
  });

  r.post("/api/user/login", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasswordLoginEnabled", true))) {
      return apiErrorMsg(userPasswordLoginDisabledMessage(c.req));
    }
    const body = bindLoginRequest(c.req, await c.req.text());
    if (body instanceof Response) return body;
    let password = body.password;
    if (await s.optionBool("PasswordLoginEncryptionEnabled", false)) {
      if (!body.password_encrypted || !body.encryption_key_id) return apiFailInvalidParams(c.req);
      const decrypted = await decryptPassword(
        body.password_encrypted,
        body.encryption_key_id,
        await s.option("PasswordEncryptionPrivateKey"),
        await s.option("PasswordEncryptionKid"),
      );
      if (!decrypted) return apiErrorMsg(userUsernameOrPasswordErrorMessage(c.req));
      password = decrypted;
    }
    if (!body.username || !password) return apiFailInvalidParams(c.req);
    const ident = body.username.trim();
    if (!ident) return apiFailInvalidParams(c.req);
    let user = await s.getUserByUsername(ident);
    if (!user) user = await s.getUserByField("email", ident);
    if (!user || !(await verifyPassword(password, user.password)) || user.status !== USER_ENABLED) {
      return apiErrorMsg(userUsernameOrPasswordErrorMessage(c.req));
    }
    const started = await startLoginVerification(s, user, "password");
    if ("error" in started) return started.error;
    if (started.challenge) {
      return apiOk({
        ...started.challenge,
        require_2fa: started.challenge.methods.some((m) => m.method === "2fa"),
      });
    }
    const issued = await issueSessionSafe(s, c.env, user, c.req, "password");
    if (issued instanceof Response) return issued;
    await s.audit(user.id, user.username, "login", "Logged in successfully via password", clientIp(c.req));
    return sessionResponse(issued);
  });

  r.post("/api/user/auth/logout", async (c) => {
    return authLogout(store(c), c.env, c.req);
  });

  r.post("/api/user/auth/refresh", async (c) => {
    const s = store(c);
    const expected = (c.req.headers.get("X-Auth-Session") || "").trim();
    const result = await refreshLoginSession(s, c.env, c.req, expected);
    if (!result.ok) return maybeClearRefreshCookie(c.req, result.response);
    return sessionResponse(result.issued);
  });

  r.get("/api/user/login/encryption-key", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasswordLoginEncryptionEnabled", false))) return apiOk({ enabled: false });
    const kid = await s.option("PasswordEncryptionKid");
    const publicKey = await s.option("PasswordEncryptionPublicKey");
    if (!kid || !publicKey) return apiErrorMsg(databaseErrorMessage(c.req));
    return apiOk({
      enabled: true,
      kid,
      public_key: publicKey,
    });
  });

  r.post("/api/user/register", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("RegisterEnabled", true))) {
      return apiErrorMsg(userRegisterDisabledMessage(c.req));
    }
    if (!(await s.optionBool("PasswordRegisterEnabled", true))) {
      return apiErrorMsg(userPasswordRegisterDisabledMessage(c.req));
    }
    const body = bindRegisterUser(c.req, await c.req.text());
    if (body instanceof Response) return body;
    const username = body.username.trim();
    const email = normalizeEmail(body.email);
    if (!username) return apiFailInvalidParams(c.req);
    const inputErr = validateRegisterUser({ ...body, username, email });
    if (inputErr) return apiErrorMsg(userInputInvalidMessage(c.req, inputErr));
    const emailVerification = await s.optionBool("EmailVerificationEnabled", false);
    let registerEmail = "";
    if (emailVerification) {
      if (!email || !body.verification_code) return apiErrorMsg(userEmailVerificationRequiredMessage(c.req));
      if (!(await s.consumeEmailCode(email, body.verification_code, "verify"))) {
        return apiErrorMsg(userVerificationCodeErrorMessage(c.req));
      }
      if (await s.getUserByEmail(email, { includeDeleted: true })) {
        return apiErrorMsg(userEmailAlreadyTakenMessage(c.req));
      }
      registerEmail = email;
    }
    if (await s.getUserByUsername(username, { includeDeleted: true })) {
      return apiErrorMsg(userExistsMessage(c.req));
    }
    let inviter = 0;
    if (body.aff_code) {
      const inv = await s.getUserByAff(body.aff_code);
      if (inv) inviter = inv.id;
    }
    const quota = await s.optionNum("QuotaForNewUser", 0);
    const id = await s.insertUser({
      username,
      password: await hashPassword(body.password),
      display_name: username,
      role: ROLE_USER,
      quota,
      email: registerEmail,
      aff_code: generateAffCode(),
      inviter_id: inviter,
    });
    if (registerEmail) await s.updateUser(id, { email: registerEmail, email_verified: 1 });
    await finishInsertUser(s, id, inviter);
    if (c.env.GENERATE_DEFAULT_TOKEN === "true" || (await s.optionBool("GenerateDefaultToken", false))) {
      await s.insertToken({
        user_id: id,
        key: generateTokenKey(),
        name: `${username}的初始令牌`,
        expired_time: -1,
        remain_quota: DEFAULT_TOKEN_QUOTA,
        unlimited_quota: 1,
        group: (await s.optionBool("DefaultUseAutoGroup", false)) ? "auto" : "",
      });
    }
    return json(200, { success: true, message: "" });
  });

  r.get("/api/user/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    return apiOk(await publicSelf(s, user));
  });

  r.put("/api/user/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const passwordValue = body.password;
    const passwordRequested = passwordValue != null && (typeof passwordValue !== "string" || passwordValue !== "");
    if ("sidebar_modules" in body && !passwordRequested) {
      const user = await s.getUserById(u.id);
      if (!user) return apiFail("用户不存在");
      const settings = parseJson<Record<string, unknown>>(user.settings || "", {});
      if (typeof body.sidebar_modules === "string") settings.sidebar_modules = body.sidebar_modules;
      await s.updateUser(u.id, { settings: JSON.stringify(settings) });
      return apiOk(null, "更新成功");
    }
    if ("language" in body && !passwordRequested) {
      const user = await s.getUserById(u.id);
      if (!user) return apiFail("用户不存在");
      const settings = parseJson<Record<string, unknown>>(user.settings || "", {});
      if (typeof body.language === "string") settings.language = body.language;
      await s.updateUser(u.id, { settings: JSON.stringify(settings) });
      return apiOk(null, "更新成功");
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.username === "string" && body.username.trim()) patch.username = body.username.trim();
    if (body.display_name != null) patch.display_name = body.display_name;
    if (passwordRequested) {
      const user = await s.getUserById(u.id);
      if (!user) return apiFail("用户不存在");
      const firstPassword = !user.password;
      const scope = firstPassword ? "account.password.set" : "account.password.change";
      const proof = await requireProof(c, s, { scope });
      if (isResponse(proof)) return proof;
      const password = String(passwordValue);
      if (password.length < 8) return apiFail("密码长度必须在 8 到 128 之间");
      patch.password = await hashPassword(password);
      await s.updateUser(u.id, patch);
      await s.bumpAuthVersion(u.id);
      const fresh = await s.getUserById(u.id);
      const issued = await issueSessionSafe(s, c.env, fresh || user, c.req, "password_changed", u.sid);
      if (issued instanceof Response) return issued;
      issued.data.has_password = true;
      issued.data.notification_warning = await notifyAccountSecurityChange(s, user.email || "", "Password updated");
      return sessionResponse(issued);
    }
    await s.updateUser(u.id, patch);
    return apiOk(null);
  });

  r.get("/api/user/models", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const usable = await userUsableGroups(s, u.group || "default");
    const group = c.url.searchParams.get("group") || "";
    let groups: string[] = [];
    if (!group) groups = Object.keys(usable);
    else if (group === "auto") {
      if (usable.auto) groups = await userAutoGroups(s, u.group || "default");
    } else if (usable[group] != null) groups = [group];
    return apiOk(await s.enabledModelsForGroups(groups));
  });

  r.get("/api/user/groups", async (c) => {
    const s = store(c);
    const session = await readSession(c, s);
    return apiOk(await userGroupsView(s, session?.group || ""));
  });

  r.get("/api/user/self/groups", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(await userGroupsView(s, u.group || "default"));
  });

  r.get("/api/user/aff", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    let code = user?.aff_code || "";
    if (!code) {
      code = generateAffCode();
      await s.updateUser(u.id, { aff_code: code });
    }
    return apiOk(code);
  });

  r.get("/api/user/checkin", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const enabled = await s.optionBool("checkin_setting.enabled", false);
    if (!enabled) return apiErrorMsg("签到功能未启用");
    const month = c.url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const stats = await s.checkinStats(u.id, month);
    return json(200, {
      success: true,
      data: {
        enabled: true,
        min_quota: await s.optionNum("checkin_setting.min_quota", 1000),
        max_quota: await s.optionNum("checkin_setting.max_quota", 10000),
        stats,
      },
    });
  });

  r.post("/api/user/checkin", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (!(await s.optionBool("checkin_setting.enabled", false))) return apiErrorMsg("签到功能未启用");
    const user = await s.getUserById(u.id);
    if (!user) return apiErrorMsg("record not found");
    const today = new Date().toISOString().slice(0, 10);
    if (await s.hasCheckedIn(u.id, today)) return apiErrorMsg("今日已签到");
    const minQ = await s.optionNum("checkin_setting.min_quota", 1000);
    const maxQ = await s.optionNum("checkin_setting.max_quota", 10000);
    const quota = minQ + (maxQ > minQ ? Math.floor(Math.random() * (maxQ - minQ + 1)) : 0);
    await s.insertCheckin(u.id, today, quota);
    await s.addQuota(u.id, quota);
    await s.updateUser(u.id, { checkin_at: nowSec() });
    await s.insertLog({ user_id: u.id, type: 4, content: `用户签到，获得额度 ${await storeLogQuota(s, quota)}`, username: u.username, quota });
    return apiOk({ quota_awarded: quota, checkin_date: today }, "签到成功");
  });

  r.slash("GET", "/api/user/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listUsers(q.offset, q.page_size, {
      sortBy: c.url.searchParams.get("sort_by") || "",
      sortOrder: c.url.searchParams.get("sort_order") || "",
    });
    return apiOk(pageData(items.map(publicUser), total, q));
  });

  r.get("/api/user/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const roleRaw = c.url.searchParams.get("role") || "";
    const statusRaw = c.url.searchParams.get("status") || "";
    const role = roleRaw === "" ? undefined : Number(roleRaw);
    const status = statusRaw === "" ? undefined : Number(statusRaw);
    const { items, total } = await s.listUsers(q.offset, q.page_size, {
      keyword: c.url.searchParams.get("keyword") || "",
      group: c.url.searchParams.get("group") || "",
      role: Number.isInteger(role) ? role : undefined,
      status: Number.isInteger(status) ? status : undefined,
      sortBy: c.url.searchParams.get("sort_by") || "",
      sortOrder: c.url.searchParams.get("sort_order") || "",
    });
    return apiOk(pageData(items.map(publicUser), total, q));
  });

  r.get("/api/user/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const user = await s.getUserById(id.n);
    if (!user) return apiFail("用户不存在");
    if (!canManageTargetRole(u.role, user.role)) return apiFail("无权获取同级或更高等级用户的信息");
    const data = await publicSelf(s, user);
    return apiOk({ ...data, admin_permissions: (data.permissions as { admin_permissions?: unknown }).admin_permissions });
  });

  r.slash("POST", "/api/user/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Partial<UserRow> & { password?: string };
    const username = String(body.username || "").trim();
    if (!username || !body.password) return apiFail("无效的参数");
    if (await s.getUserByUsername(username, { includeDeleted: true })) return apiFail("用户已存在");
    const role = Number(body.role || ROLE_USER);
    if (role >= u.role) return apiFail("无法创建权限大于等于自己的用户");
    const id = await s.insertUser({
      username,
      password: await hashPassword(body.password),
      display_name: body.display_name || username,
      role,
      quota: await s.optionNum("QuotaForNewUser", 0),
      aff_code: generateAffCode(),
    });
    await finishInsertUser(s, id, 0);
    return apiOk(null);
  });

  r.slash("PUT", "/api/user/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Partial<UserRow> & {
      id?: number;
      username?: string;
      password?: string;
      admin_permissions?: Record<string, Record<string, boolean>>;
    };
    const username = String(body.username || "").trim();
    if (!body.id || !username) return apiFail("无效的参数");
    const target = await s.getUserById(body.id);
    if (!target) return apiFail("用户不存在");
    if (body.role != null && body.role !== ROLE_GUEST && body.role !== target.role) return apiFail("无效的参数");
    if (!canManageTargetRole(u.role, target.role)) return apiFail("无权更新同权限等级或更高权限等级的用户信息");
    const patch: Record<string, unknown> = { username };
    for (const k of ["display_name", "email", "quota", "group", "status"] as const) {
      if (body[k] != null) patch[k] = body[k];
    }
    if (body.password) patch.password = await hashPassword(body.password);
    if (body.admin_permissions) {
      if (u.role < ROLE_ROOT) return apiFail("only root can update admin permissions");
      const targetRole = target.role;
      if (targetRole < ROLE_ADMIN) {
        await s.clearUserCasbinPolicies(body.id);
        patch.admin_permissions = "";
      } else {
        const deltas = permissionDeltas(targetRole, body.admin_permissions);
        await s.setUserCasbinPolicies(body.id, deltas);
        patch.admin_permissions = JSON.stringify(deltas);
      }
    }
    await s.updateUser(body.id, patch);
    if (body.password) await s.bumpAuthVersion(body.id);
    return apiOk(null);
  });

  r.post("/api/user/manage", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { id?: number; action?: string; quota?: number; value?: number; mode?: string };
    if (!body.id || !body.action) return apiFail("无效的参数");
    const target = await s.getUserById(body.id, { includeDeleted: true });
    if (!target) return apiFail("用户不存在");
    if (!canManageTargetRole(u.role, target.role)) return apiFail("无权更新同权限等级或更高权限等级的用户信息");
    if (body.action === "add_quota") {
      const mode = body.mode || "add";
      const value = Number(body.value ?? body.quota ?? 0);
      if (mode !== "add" && mode !== "subtract" && mode !== "override") return apiFail("无效的参数");
      if (mode !== "override" && value <= 0) return apiFail("额度变更量不能为0");
      if (mode === "override") await s.updateUser(target.id, { quota: value });
      else await s.addQuota(target.id, mode === "subtract" ? -value : value);
      await s.audit(u.id, u.username, "user.manage", `${body.action} user ${target.username}`, clientIp(c.req));
      return apiOk(null);
    }
    switch (body.action) {
      case "disable":
        if (target.role === ROLE_ROOT) return apiFail("无法禁用超级管理员用户");
        await s.updateUser(target.id, { status: USER_DISABLED });
        break;
      case "enable":
        await s.updateUser(target.id, { status: USER_ENABLED });
        break;
      case "delete":
        if (target.role === ROLE_ROOT) return apiFail("不能删除超级管理员账户");
        await s.softDeleteUser(target.id);
        await s.audit(u.id, u.username, "user.manage", `${body.action} user ${target.username}`, clientIp(c.req));
        return apiOk(null);
      case "promote":
        if (u.role < ROLE_ROOT) return apiFail("普通管理员用户无法提升其他用户为管理员");
        if (target.role >= ROLE_ADMIN) return apiFail("该用户已经是管理员");
        await s.updateUser(target.id, { role: ROLE_ADMIN });
        break;
      case "demote":
        if (target.role === ROLE_ROOT) return apiFail("无法降级超级管理员用户");
        if (target.role === ROLE_USER) return apiFail("该用户已经是普通用户");
        await s.updateUser(target.id, { role: ROLE_USER });
        break;
      default:
        return apiFail("无效的参数");
    }
    await s.audit(u.id, u.username, "user.manage", `${body.action} user ${target.username}`, clientIp(c.req));
    const fresh = await s.getUserById(target.id);
    return apiOk(manageUserView(fresh?.role ?? target.role, fresh?.status ?? target.status));
  });

  r.delete("/api/user/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const target = await s.getUserById(id.n);
    if (!target) return apiFail("用户不存在");
    if (!canManageTargetRole(u.role, target.role)) return apiFail("无权更新同权限等级或更高权限等级的用户信息");
    if (target.role === ROLE_ROOT) return apiFail("不能删除超级管理员账户");
    await s.deleteUser(target.id);
    return apiOk(null);
  });

  r.slash("GET", "/api/token/", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTokens(u.id, q.offset, q.page_size);
    return apiOk(pageData(items.map(publicToken), total, q));
  });

  r.get("/api/token/:id", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const t = await loadDashboardToken(s, u.id, c.params.id);
    if (isResponse(t)) return t;
    return apiOk(publicToken(t));
  });

  r.post("/api/token/:id/key", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const t = await loadDashboardToken(s, u.id, c.params.id);
    if (isResponse(t)) return t;
    return apiOk({ key: t.key });
  });

  r.slash("POST", "/api/token/", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as {
      name?: string;
      remain_quota?: number;
      unlimited_quota?: boolean;
      expired_time?: number;
      model_limits_enabled?: boolean;
      model_limits?: string;
      allow_ips?: string;
      group?: string;
      auto_groups?: string[];
      cross_group_retry?: boolean;
    };
    const writeErr = await tokenWriteError(c.req, s, u, body, true);
    if (writeErr) return writeErr;
    let autoGroups = Array.isArray(body.auto_groups) ? body.auto_groups : [];
    let crossGroupRetry = body.cross_group_retry ? 1 : 0;
    if (body.group !== "auto") {
      autoGroups = [];
      crossGroupRetry = 0;
    }
    const key = generateTokenKey();
    const id = await s.insertToken({
      user_id: u.id,
      key,
      name: body.name || "default",
      remain_quota: Number(body.remain_quota || 0),
      unlimited_quota: body.unlimited_quota ? 1 : 0,
      expired_time: body.expired_time ?? -1,
      model_limits_enabled: body.model_limits_enabled ? 1 : 0,
      model_limits: body.model_limits || "",
      allow_ips: body.allow_ips || "",
      group: body.group || "",
      auto_groups: autoGroups.length ? JSON.stringify(autoGroups) : "",
      cross_group_retry: crossGroupRetry,
      status: TOKEN_ENABLED,
    });
    return apiOk({ id, key: displayTokenKey(key) });
  });

  r.slash("PUT", "/api/token/", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    let raw: unknown;
    try {
      raw = await readJson(c.req);
    } catch (e) {
      return apiErrorMsg(e instanceof Error ? e.message : String(e));
    }
    const body = (
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    ) as Record<string, unknown> & {
      id?: number;
      status?: number;
      name?: string;
      remain_quota?: number;
      unlimited_quota?: boolean;
      group?: string;
      auto_groups?: string[];
    };
    const writeErr = await tokenWriteError(c.req, s, u, body, false);
    if (writeErr) return writeErr;
    const id = typeof body.id === "number" && Number.isInteger(body.id) ? body.id : 0;
    const existing = await s.getTokenById(id, u.id);
    const byIds = tokenByIdsError(id, u.id, existing);
    if (byIds) return byIds;
    if (body.status === TOKEN_ENABLED) {
      if (existing!.status === TOKEN_EXPIRED && existing!.expired_time !== -1 && existing!.expired_time <= nowSec()) {
        return apiErrorMsg(i18nPair(c.req, "令牌已过期，无法启用，请先修改令牌过期时间，或者设置为永不过期", "Token has expired and cannot be enabled. Please modify the expiration time or set it to never expire"));
      }
      if (existing!.status === TOKEN_EXHAUSTED && existing!.remain_quota <= 0 && !existing!.unlimited_quota) {
        return apiErrorMsg(i18nPair(c.req, "令牌可用额度已用尽，无法启用，请先修改令牌剩余额度，或者设置为无限额度", "Token quota is exhausted and cannot be enabled. Please modify the remaining quota or set it to unlimited"));
      }
    }
    const statusOnly = c.url.searchParams.get("status_only");
    if (statusOnly) {
      await s.updateToken(id, u.id, { status: Number(body.status) });
      return apiOk(null);
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "status", "remain_quota", "expired_time", "model_limits", "allow_ips", "group"] as const) {
      if (body[k] != null) patch[k] = body[k];
    }
    if (body.unlimited_quota != null) patch.unlimited_quota = body.unlimited_quota ? 1 : 0;
    if (body.model_limits_enabled != null) patch.model_limits_enabled = body.model_limits_enabled ? 1 : 0;
    const nextGroup = body.group != null ? String(body.group) : existing!.group;
    if (nextGroup === "auto") {
      if (body.cross_group_retry != null) patch.cross_group_retry = body.cross_group_retry ? 1 : 0;
      if (body.auto_groups != null) patch.auto_groups = Array.isArray(body.auto_groups) ? JSON.stringify(body.auto_groups) : String(body.auto_groups);
    } else {
      patch.cross_group_retry = 0;
      patch.auto_groups = "";
    }
    await s.updateToken(id, u.id, patch);
    return apiOk(null, "更新成功");
  });

  r.slash("DELETE", "/api/token/:id/", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const parsed = strconvAtoi(c.params.id);
    const id = parsed.ok ? parsed.n : 0;
    const existing = await s.getTokenById(id, u.id);
    const byIds = tokenByIdsError(id, u.id, existing);
    if (byIds) return byIds;
    await s.deleteToken(id, u.id);
    return json(200, { success: true, message: "" });
  });

  r.slash("GET", "/api/channel/", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const statusFilter = parseChannelStatusFilter(c.url.searchParams.get("status") || "");
    const typeParsed = strconvAtoi(c.url.searchParams.get("type") || "");
    const typeFilter = c.url.searchParams.get("type") && typeParsed.ok ? typeParsed.n : undefined;
    const { items, total, type_counts } = await s.listChannels({
      offset: q.offset,
      limit: q.page_size,
      group: c.url.searchParams.get("group") || undefined,
      status: statusFilter < 0 ? undefined : statusFilter,
      type: typeFilter,
      tag_mode: queryParseBool(c.url, "tag_mode"),
      sort_by: c.url.searchParams.get("sort_by") || undefined,
      sort_order: c.url.searchParams.get("sort_order") || undefined,
      id_sort: queryParseBool(c.url, "id_sort"),
    });
    return apiOk(pageData(items.map(stripChannelKey), total, q, { type_counts }));
  });

  r.get("/api/channel/search", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const q = searchChannelPageQuery(c.url);
    const statusFilter = parseChannelStatusFilter(c.url.searchParams.get("status") || "");
    const typeParsed = strconvAtoi(c.url.searchParams.get("type") || "");
    const typeFilter = c.url.searchParams.get("type") && typeParsed.ok ? typeParsed.n : -1;
    let channelData = await s.searchChannels({
      keyword: c.url.searchParams.get("keyword") || "",
      group: c.url.searchParams.get("group") || "",
      model: c.url.searchParams.get("model") || "",
      id_sort: queryParseBool(c.url, "id_sort"),
      sort_by: c.url.searchParams.get("sort_by") || undefined,
      sort_order: c.url.searchParams.get("sort_order") || undefined,
      tag_mode: queryParseBool(c.url, "tag_mode"),
    });
    if (statusFilter === CHANNEL_ENABLED) {
      channelData = channelData.filter((ch) => Number(ch.status) === CHANNEL_ENABLED);
    } else if (statusFilter === 0) {
      channelData = channelData.filter((ch) => Number(ch.status) !== CHANNEL_ENABLED);
    }
    const type_counts: Record<string, number> = {};
    for (const ch of channelData) {
      const key = String(ch.type);
      type_counts[key] = (type_counts[key] || 0) + 1;
    }
    if (typeFilter >= 0) {
      channelData = channelData.filter((ch) => Number(ch.type) === typeFilter);
    }
    const total = channelData.length;
    const start = Math.min(q.offset, total);
    const paged = channelData.slice(start, start + q.page_size);
    return apiOk(pageData(paged.map((ch) => stripChannelKey(ch)), total, q, { type_counts }));
  });

  r.get("/api/channel/models", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    return apiOk(channelListModels());
  });

  r.get("/api/channel/models_enabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    return apiOk(await s.enabledModelsAll());
  });

  r.get("/api/channel/default_base_urls", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    return apiOk(channelDefaultBaseURLs());
  });

  r.get("/api/channel/ops", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    return apiOk({ retry_times: await s.optionNum("RetryTimes", 0) });
  });

  r.get("/api/channel/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const ch = await s.getChannel(id.n);
    if (!ch) return apiFail("record not found");
    return apiOk(stripChannelKey(ch));
  });

  r.post("/api/channel/:id/key", async (c) => {
    const s = store(c);
    const channelId = Number(c.params.id);
    if (!Number.isInteger(channelId) || channelId <= 0) {
      return json(400, { success: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid." });
    }
    const proof = await requireProof(c, s, { scope: "channel.key.read", context: { channel_id: channelId } });
    if (isResponse(proof)) return proof;
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const ch = await s.getChannel(channelId);
    if (!ch) return apiFail(i18nPair(c.req, "渠道不存在", "Channel does not exist"));
    await s.audit(u.id, u.username, "channel.key_view", `view channel key ${ch.name}`, clientIp(c.req));
    return apiOk({ key: ch.key }, "获取成功");
  });

  r.slash("POST", "/api/channel/", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const ch = (body.channel || body) as Record<string, unknown>;
    if (!ch.name) return apiFail("渠道名称不能为空");
    const type = Number(ch.type || 1);
    const wrapped = body.channel != null;
    const originalShaped = wrapped || "mode" in body;
    const modeRaw = String(body.mode || "");
    if (originalShaped && modeRaw !== "single" && modeRaw !== "batch" && modeRaw !== "multi_to_single") {
      return apiFail("不支持的添加模式");
    }
    const mode = (modeRaw || "single") as AddChannelMode;
    if (type === CHANNEL_TYPE_TASK_PLUGIN && !(await canTaskPluginBind(s, u))) {
      return apiFail("task plugin channels require the task_plugin.bind permission");
    }
    const fields = channelFieldsFromBody(ch);
    const err = validateChannel(fields, true);
    if (err) return apiFail(err.message);
    let expanded;
    try {
      expanded = expandAddChannelKeys(
        { type: Number(fields.type || 1), key: String(fields.key || ""), settings: fields.settings },
        mode,
      );
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
    const prefixName = Boolean(body.batch_add_set_key_prefix_2_name) && expanded.keys.length > 1;
    let id = 0;
    let count = 0;
    for (const key of expanded.keys) {
      if (!key) continue;
      let name = String(fields.name || "");
      if (prefixName) {
        const keyPrefix = key.length > 8 ? key.slice(0, 8) : key;
        name = `${name} ${keyPrefix}`;
      }
      id = await s.insertChannel({
        ...fields,
        name,
        key: mode === "multi_to_single" ? expanded.key : key,
        channel_info: expanded.multiKey
          ? stringifyChannelInfo(multiKeyInfoFromKeys(expanded.key.split("\n").filter(Boolean), String(body.multi_key_mode || "random")))
          : "",
      });
      count += 1;
    }
    await s.audit(u.id, u.username, "channel.create", `create channel ${fields.name}`, clientIp(c.req));
    return apiOk({ id, count });
  });

  r.slash("PUT", "/api/channel/", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    let body: Record<string, unknown>;
    try {
      body = (await readJson(c.req)) as Record<string, unknown>;
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const requestData = body;
    const ch = ((body.channel && typeof body.channel === "object" ? body.channel : body) as Record<string, unknown>);
    if ("status" in requestData || "status" in ch) return apiFail("无效的参数");
    const id = Number(ch.id);
    if (!id) return apiFail("无效的参数");
    const origin = await s.getChannel(id);
    if (!origin) return apiFail("record not found");
    if (Number(ch.type) === 61 && !(await canTaskPluginBind(s, u))) {
      return apiFail("task plugin channels require the task_plugin.bind permission");
    }
    if (channelHasSensitiveChanges(ch, origin, requestData) && !(await canChannelSensitiveWrite(s, u))) {
      return apiFail("无权进行此操作，权限不足");
    }
    const info = parseChannelInfo(String(origin.channel_info || ""));
    const multiKeyMode = String(ch.multi_key_mode || "");
    if (multiKeyMode) info.multi_key_mode = multiKeyMode;
    let key = origin.key;
    const keyMode = String(ch.key_mode || "");
    if (keyMode === "append" && info.is_multi_key) {
      key = appendChannelKeys(origin.key, String(ch.key || ""));
    } else if (String(ch.key || "") !== "") {
      key = String(ch.key);
    }
    if (info.is_multi_key) {
      const keys = channelKeys(key);
      info.multi_key_size = keys.length;
      if (info.multi_key_status_list) {
        for (const idx of Object.keys(info.multi_key_status_list)) {
          if (Number(idx) >= info.multi_key_size) delete info.multi_key_status_list[idx];
        }
      }
    }
    const patch: Record<string, unknown> = { channel_info: stringifyChannelInfo(info) };
    if (key !== origin.key) patch.key = key;
    for (const k of [
      "type",
      "name",
      "weight",
      "base_url",
      "other",
      "models",
      "group",
      "model_mapping",
      "priority",
      "auto_ban",
      "tag",
      "header_override",
      "param_override",
      "remark",
      "settings",
      "openai_organization",
      "test_model",
      "setting",
      "other_info",
      "status_code_mapping",
    ]) {
      if (k in ch && ch[k] != null && !CHANNEL_READ_ONLY_FIELDS.has(k)) {
        patch[k] = typeof ch[k] === "object" ? JSON.stringify(ch[k]) : ch[k];
      }
    }
    await s.updateChannel(id, patch);
    const updated = await s.getChannel(id);
    return apiOk(updated ? publicChannel(updated, false) : null);
  });

  r.slash("DELETE", "/api/channel/:id/", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    await s.deleteChannel(Number(c.params.id));
    return apiOk(null);
  });

  r.post("/api/channel/:id/status", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFailInvalidParams(c.req);
    let body: { status?: number };
    try {
      body = (await readJson(c.req)) as { status?: number };
    } catch {
      return apiFailInvalidParams(c.req);
    }
    const status = Number(body.status);
    if (!Number.isInteger(status) || !isManageableChannelStatus(status)) return apiFailInvalidParams(c.req);
    const ch = await s.getChannel(id.n);
    const changed = Boolean(ch) && Number(ch!.status) !== status;
    if (changed) await s.updateChannel(id.n, { status });
    return apiOk(changed);
  });

  r.post("/api/channel/status/batch", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    let body: { ids?: number[]; status?: number };
    try {
      body = (await readJson(c.req)) as { ids?: number[]; status?: number };
    } catch {
      return apiFailInvalidParams(c.req);
    }
    const status = Number(body.status);
    if (!body.ids?.length || !Number.isInteger(status) || !isManageableChannelStatus(status)) {
      return apiFailInvalidParams(c.req);
    }
    let changedCount = 0;
    for (const id of body.ids) {
      const ch = await s.getChannel(id);
      if (!ch || Number(ch.status) === status) continue;
      await s.updateChannel(id, { status });
      changedCount += 1;
    }
    return apiOk(changedCount);
  });

  r.delete("/api/channel/disabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const n = await s.deleteDisabledChannels();
    return apiOk(n);
  });

  r.post("/api/channel/copy/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const id = Number(c.params.id);
    if (!Number.isInteger(id)) return apiFail("invalid id");
    const origin = await s.getChannel(id);
    if (!origin) return apiFail("获取渠道信息失败，请稍后重试");
    if (origin.type === CHANNEL_TYPE_TASK_PLUGIN && !(await canTaskPluginBind(s, u))) {
      return apiFail("task plugin channels require the task_plugin.bind permission");
    }
    const suffix = c.url.searchParams.get("suffix") ?? "_复制";
    const resetBalance = parseGoBool(c.url.searchParams.get("reset_balance"), true);
    const settingsErr = validateChannelSettings(origin);
    if (settingsErr) return apiFail("Failed to copy channel: invalid channel settings");
    try {
      const cloneId = await s.insertChannel({
        ...origin,
        id: undefined as unknown as number,
        name: origin.name + suffix,
        created_time: nowSec(),
        test_time: 0,
        response_time: 0,
        balance: resetBalance ? "0" : origin.balance,
        used_quota: resetBalance ? 0 : origin.used_quota,
      });
      await s.audit(u.id, u.username, "channel.copy", `copy channel ${origin.name}`, clientIp(c.req));
      return apiOk({ id: cloneId });
    } catch {
      return apiFail("复制渠道失败，请稍后重试");
    }
  });

  r.get("/api/channel/test/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const ch = await s.getChannel(id.n);
    if (!ch) return apiFail("record not found");
    const result = await testChannel(s, ch, {
      model: c.url.searchParams.get("model") || "",
      endpointType: c.url.searchParams.get("endpoint_type") || "",
      stream: parseGoBool(c.url.searchParams.get("stream"), false),
      userId: u.id,
      username: u.username,
      group: u.group || "default",
    });
    const body: Record<string, unknown> = { success: result.success, message: result.message, time: result.time };
    if (result.error_code) body.error_code = result.error_code;
    return json(200, body);
  });

  r.get("/api/channel/fetch_models/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const ch = await s.getChannel(id.n);
    if (!ch) return apiFail("record not found");
    try {
      const models = await fetchUpstreamModels(ch, s);
      return apiOk(models);
    } catch (e) {
      return apiFail(`获取模型列表失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  r.post("/api/channel/fetch_models", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    let body: {
      type?: number;
      key?: string;
      base_url?: string;
      channel_id?: number;
      advanced_custom?: string;
      header_override?: string;
      proxy?: string;
    };
    try {
      const text = await c.req.text();
      if (!text) return json(400, { success: false, message: "Invalid request" });
      body = JSON.parse(text) as typeof body;
    } catch {
      return json(400, { success: false, message: "Invalid request" });
    }
    try {
      const type = Number(body.type || 0);
      const channelId = Number(body.channel_id || 0);
      let channel;
      if (type === CHANNEL_TYPE_ADVANCED_CUSTOM || channelId > 0) {
        try {
          channel = await buildAdvancedCustomModelPreviewChannel(body, (id) => s.getChannel(id));
        } catch (e) {
          return apiFail(e instanceof Error ? e.message : String(e));
        }
      } else {
        channel = previewNonCustomChannel(body, defaultBaseUrl(type));
      }
      const models = await fetchUpstreamModels(channel, s);
      return apiOk(models);
    } catch (e) {
      return apiFail(`获取模型列表失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  r.slash("GET", "/api/log/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    try {
      const { items, total } = await s.listLogs({
        offset: q.offset,
        limit: q.page_size,
        type: Number(c.url.searchParams.get("type") || 0) || undefined,
        start: Number(c.url.searchParams.get("start_timestamp") || 0) || undefined,
        end: Number(c.url.searchParams.get("end_timestamp") || 0) || undefined,
        model: c.url.searchParams.get("model_name") || undefined,
        username: c.url.searchParams.get("username") || undefined,
        tokenName: c.url.searchParams.get("token_name") || undefined,
        channel: Number(c.url.searchParams.get("channel") || 0) || undefined,
        requestId: c.url.searchParams.get("request_id") || undefined,
        group: c.url.searchParams.get("group") || undefined,
        upstreamRequestId: c.url.searchParams.get("upstream_request_id") || undefined,
        order: "created_at_id",
        fillChannelNames: true,
      });
      return apiOk(pageData(items.map((row) => publicLog(row, u.role)), total, q));
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/log/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    try {
      const { items, total } = await s.listLogs({
        offset: q.offset,
        limit: q.page_size,
        userId: u.id,
        type: Number(c.url.searchParams.get("type") || 0) || undefined,
        start: Number(c.url.searchParams.get("start_timestamp") || 0) || undefined,
        end: Number(c.url.searchParams.get("end_timestamp") || 0) || undefined,
        model: c.url.searchParams.get("model_name") || undefined,
        tokenName: c.url.searchParams.get("token_name") || undefined,
        requestId: c.url.searchParams.get("request_id") || undefined,
        group: c.url.searchParams.get("group") || undefined,
        upstreamRequestId: c.url.searchParams.get("upstream_request_id") || undefined,
        order: "id",
      });
      return apiOk(pageData(publicUserLogs(items, q.offset), total, q));
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/log/stat", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    try {
      return apiOk(
        await s.logStat({
          type: Number(c.url.searchParams.get("type") || 0) || undefined,
          start: Number(c.url.searchParams.get("start_timestamp") || 0) || undefined,
          end: Number(c.url.searchParams.get("end_timestamp") || 0) || undefined,
          username: c.url.searchParams.get("username") || undefined,
          tokenName: c.url.searchParams.get("token_name") || undefined,
          model: c.url.searchParams.get("model_name") || undefined,
          channel: Number(c.url.searchParams.get("channel") || 0) || undefined,
          group: c.url.searchParams.get("group") || undefined,
        }),
      );
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/log/self/stat", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    try {
      return apiOk(
        await s.logStat({
          username: u.username,
          type: Number(c.url.searchParams.get("type") || 0) || undefined,
          start: Number(c.url.searchParams.get("start_timestamp") || 0) || undefined,
          end: Number(c.url.searchParams.get("end_timestamp") || 0) || undefined,
          tokenName: c.url.searchParams.get("token_name") || undefined,
          model: c.url.searchParams.get("model_name") || undefined,
          channel: Number(c.url.searchParams.get("channel") || 0) || undefined,
          group: c.url.searchParams.get("group") || undefined,
        }),
      );
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.slash("GET", "/api/data/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const start = parseUnixQuery(c.url, "start_timestamp");
    const end = parseUnixQuery(c.url, "end_timestamp");
    return apiOk((await s.quotaDates(null, start, end, c.url.searchParams.get("username") || "")).map((row) => publicQuotaData(row as Record<string, unknown>)));
  });

  r.get("/api/data/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const start = parseUnixQuery(c.url, "start_timestamp");
    const end = parseUnixQuery(c.url, "end_timestamp");
    if (end - start > 2592000) return apiErrorMsg("时间跨度不能超过 1 个月");
    return apiOk((await s.quotaDates(u.id, start, end)).map((row) => publicQuotaData(row as Record<string, unknown>)));
  });

  r.slash("GET", "/api/group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.uniqueGroups());
  });

  r.slash("GET", "/api/option/", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(publicOptions(await s.allOptions()));
  });

  r.slash("PUT", "/api/option/", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const bound = bindOptionUpdate(await c.req.text());
    if (bound instanceof Response) return bound;
    if (!bound.key) return apiFail("无效的参数");
    const { key, value } = bound;
    if (key === "QuotaForInviter" || key === "QuotaForInvitee") {
      if (isPositiveOptionValue(value) && !(await paymentComplianceConfirmed(s))) {
        return apiErrorMsg(paymentComplianceRequiredMessage(c.req));
      }
    } else if (isPaymentComplianceOptionKey(key)) {
      return apiErrorMsg("合规确认字段不允许通过通用设置接口修改");
    }
    if (key === "TaskPublicAddress" && value !== "") {
      const err = validateTaskArtifactBaseURL(value);
      if (err) return apiErrorMsg(err);
    }
    switch (key) {
      case "GitHubOAuthEnabled":
        if (value === "true" && !(await s.option("GitHubClientId"))) {
          return apiErrorMsg("无法启用 GitHub OAuth，请先填入 GitHub Client Id 以及 GitHub Client Secret！");
        }
        break;
      case "discord.enabled":
        if (value === "true" && !(await s.option("discord.client_id"))) {
          return apiErrorMsg("无法启用 Discord OAuth，请先填入 Discord Client Id 以及 Discord Client Secret！");
        }
        break;
      case "oidc.enabled":
        if (value === "true" && !(await s.option("oidc.client_id"))) {
          return apiErrorMsg("无法启用 OIDC 登录，请先填入 OIDC Client Id 以及 OIDC Client Secret！");
        }
        break;
      case "LinuxDOOAuthEnabled":
        if (value === "true" && !(await s.option("LinuxDOClientId"))) {
          return apiErrorMsg("无法启用 LinuxDO OAuth，请先填入 LinuxDO Client Id 以及 LinuxDO Client Secret！");
        }
        break;
      case "EmailDomainRestrictionEnabled":
        if (value === "true" && (await s.option("EmailDomainWhitelist")).split(",").length === 0) {
          return apiErrorMsg("无法启用邮箱域名限制，请先填入限制的邮箱域名！");
        }
        break;
      case "WeChatAuthEnabled":
        if (value === "true" && !(await s.option("WeChatServerAddress"))) {
          return apiErrorMsg("无法启用微信登录，请先填入微信登录相关配置信息！");
        }
        break;
      case "TurnstileCheckEnabled":
        if (value === "true" && !(await s.option("TurnstileSiteKey"))) {
          return apiErrorMsg("无法启用 Turnstile 校验，请先填入 Turnstile 校验相关配置信息！");
        }
        break;
      case "theme.frontend":
        if (value !== "default") {
          return apiErrorMsg("Classic 前端已移除，主题只能设置为 default");
        }
        break;
      case "GroupRatio": {
        const err = checkGroupRatio(value);
        if (err) return apiErrorMsg(err);
        break;
      }
      case "ImageRatio": {
        const parsed = parseFloat64Map(value);
        if (!parsed.ok) return apiErrorMsg("图片倍率设置失败: " + parsed.message);
        break;
      }
      case "AudioRatio": {
        const parsed = parseFloat64Map(value);
        if (!parsed.ok) return apiErrorMsg("音频倍率设置失败: " + parsed.message);
        break;
      }
      case "AudioCompletionRatio": {
        const parsed = parseFloat64Map(value);
        if (!parsed.ok) return apiErrorMsg("音频补全倍率设置失败: " + parsed.message);
        break;
      }
      case "CreateCacheRatio": {
        const parsed = parseFloat64Map(value);
        if (!parsed.ok) return apiErrorMsg("缓存创建倍率设置失败: " + parsed.message);
        break;
      }
      case "gemini.safety_settings": {
        const err = validateGeminiSafetySettings(value);
        if (err) return apiErrorMsg(err);
        break;
      }
      case "claude.default_max_tokens": {
        const err = validateClaudeDefaultMaxTokens(value);
        if (err) return apiErrorMsg(err);
        break;
      }
      case TOOL_PRICE_OPTION_KEY: {
        const err = validateToolPricesJSON(value);
        if (err) return apiErrorMsg(err);
        break;
      }
      case "AutomaticDisableStatusCodes":
      case "AutomaticRetryStatusCodes": {
        const parsed = parseHTTPStatusCodeRanges(value);
        if (!parsed.ok) return apiErrorMsg(parsed.message);
        break;
      }
      case "billing_setting.billing_expr": {
        const err = await validateBillingExprOption(s, value);
        if (err) return apiErrorMsg(err);
        break;
      }
      case PLUGIN_BILLING_EXPR_OPTION: {
        const err = await validatePluginBillingExprOption(s, value);
        if (err) return apiErrorMsg(err);
        break;
      }
      case "console_setting.api_info": {
        const err = validateConsoleSettings(value, "ApiInfo");
        if (err) return apiErrorMsg(err);
        break;
      }
      case "console_setting.announcements": {
        const err = validateConsoleSettings(value, "Announcements");
        if (err) return apiErrorMsg(err);
        break;
      }
      case "console_setting.faq": {
        const err = validateConsoleSettings(value, "FAQ");
        if (err) return apiErrorMsg(err);
        break;
      }
      case "console_setting.uptime_kuma_groups": {
        const err = validateConsoleSettings(value, "UptimeKumaGroups");
        if (err) return apiErrorMsg(err);
        break;
      }
    }
    if (isPasskeyDomainOption(key)) {
      try {
        const change = await updatePasskeyDomainOptions(s, await sessionSecret(c.env, s), { [key]: value }, false, "");
        return apiOk(change);
      } catch (e) {
        if (e instanceof PasskeyDomainError) {
          await s.audit(u.id, u.username, "option", e.code === "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED" ? "option.passkey_domains_blocked" : "option.passkey_domains_failed", clientIp(c.req), {
            actor_role: u.role,
            category: "operation",
            action: e.code === "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED" ? "option.passkey_domains_blocked" : "option.passkey_domains_failed",
            method: "PUT",
            route: "/api/option/",
            status: e.status,
            success: false,
          });
        }
        return passkeyDomainHttpError(e, c.req);
      }
    }
    if (key === "TelegramOAuthEnabled" && value === "true" && !(await telegramSettingsConfigured(s))) {
      return json(200, {
        success: false,
        code: "TELEGRAM_OAUTH_NOT_CONFIGURED",
        message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED,
      });
    }
    if (key === "ModelRequestRateLimitGroup") {
      const err = checkModelRequestRateLimitGroup(value);
      if (err) return apiErrorMsg(err);
    }
    await s.setOption(key, value);
    return json(200, { success: true, message: "" });
  });

  r.slash("GET", "/api/redemption/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listRedemptions(q.offset, q.page_size);
    return apiOk(pageData(items.map(publicRedemption), total, q));
  });

  r.get("/api/redemption/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiErrorMsg(id.message);
    const found = await redemptionById(s, id.n);
    if (found instanceof Response) return found;
    return apiOk(publicRedemption(found));
  });

  r.slash("POST", "/api/redemption/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const body = await bindRedemption(c.req);
    if (body instanceof Response) return body;
    const name = String(body.name || "");
    if (Array.from(name).length < 1 || Array.from(name).length > 20) {
      return apiErrorMsg(redemptionNameLengthMessage(c.req));
    }
    const count = Number(body.count || 0);
    if (count <= 0) return apiErrorMsg(redemptionCountPositiveMessage(c.req));
    if (count > 100) return apiErrorMsg(redemptionCountMaxMessage(c.req));
    const quotaErr = redemptionQuotaError(Number(body.quota || 0));
    if (quotaErr) return quotaErr;
    const expiredTime = Number(body.expired_time || 0);
    const expiredErr = redemptionExpiredError(c.req, expiredTime);
    if (expiredErr) return expiredErr;
    const quota = Number(body.quota || 0);
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
      const key = generateRedemptionKey();
      await s.insertRedemption({
        name,
        key,
        quota,
        user_id: u.id,
        expired_time: expiredTime,
      });
      keys.push(key);
    }
    return apiOk(keys);
  });

  r.slash("PUT", "/api/redemption/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const statusOnly = c.url.searchParams.get("status_only") || "";
    const body = await bindRedemption(c.req);
    if (body instanceof Response) return body;
    const found = await redemptionById(s, Number(body.id || 0));
    if (found instanceof Response) return found;
    const patch: Record<string, unknown> = {};
    if (statusOnly === "") {
      const quota = Number(body.quota ?? 0);
      const quotaErr = redemptionQuotaError(quota);
      if (quotaErr) return quotaErr;
      const expiredTime = Number(body.expired_time ?? 0);
      const expiredErr = redemptionExpiredError(c.req, expiredTime);
      if (expiredErr) return expiredErr;
      patch.name = body.name ?? found.name;
      patch.quota = quota;
      patch.expired_time = expiredTime;
    }
    if (statusOnly !== "") patch.status = body.status;
    if (Object.keys(patch).length) await s.updateRedemption(found.id, patch);
    const updated = await s.getRedemption(found.id);
    return apiOk(updated ? publicRedemption(updated) : null);
  });

  r.slash("DELETE", "/api/redemption/:id/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const parsed = strconvAtoi(c.params.id);
    const id = parsed.ok ? parsed.n : 0;
    const found = await redemptionById(s, id);
    if (found instanceof Response) return found;
    await s.deleteRedemption(found.id);
    return json(200, { success: true, message: "" });
  });

  r.post("/api/user/topup", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s, c.req);
    if (denied) return denied;
    const body = await bindTopUpRequest(c.req);
    if (body instanceof Response) return body;
    const key = String(body.key || "").trim();
    try {
      const red = await s.getRedemptionByKey(key);
      if (!red || red.status !== 1) throw new Error("redeem");
      if (Number(red.expired_time || 0) > 0 && Number(red.expired_time) < nowSec()) throw new Error("redeem");
      await s.updateRedemption(red.id, { status: 3, redeemed_time: nowSec(), used_user_id: u.id });
      await s.addQuota(u.id, red.quota);
      await s.insertTopup({ user_id: u.id, amount: red.quota, payment_method: "redemption", trade_no: red.key });
      await s.insertLog({
        user_id: u.id,
        type: 1,
        content: `通过兑换码充值 ${await storeLogQuota(s, red.quota)}，兑换码ID ${red.id}`,
        username: u.username,
        quota: red.quota,
      });
      return apiOk(red.quota);
    } catch {
      return apiErrorMsg(redeemFailedMessage(c.req));
    }
  });

  r.get("/api/audit", async (c) => {
    const s = store(c);
    const u = await requirePermission(c, s, "audit", "read");
    if (isResponse(u)) return u;
    const q = auditPageQuery(c.url);
    if (isResponse(q)) return q;
    const filters = auditListFilter(c);
    if (isResponse(filters)) return filters;
    const { items, total } = await s.listAudit(q.offset, q.page_size, { ...filters, viewerRole: u.role });
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/audit/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = auditPageQuery(c.url);
    if (isResponse(q)) return q;
    const filters = auditListFilter(c);
    if (isResponse(filters)) return filters;
    const { items, total } = await s.listAudit(q.offset, q.page_size, {
      ...filters,
      userId: u.id,
      username: "",
      viewerRole: u.role,
      selfView: true,
    });
    return apiOk(pageData(items, total, q));
  });

  r.slash("GET", "/api/mj/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listMj(null, q.offset, q.page_size, {
      channel_id: c.url.searchParams.get("channel_id") || "",
      mj_id: c.url.searchParams.get("mj_id") || "",
      start_timestamp: c.url.searchParams.get("start_timestamp") || "",
      end_timestamp: c.url.searchParams.get("end_timestamp") || "",
    });
    const forward = await s.optionBool("MjForwardUrlEnabled", true);
    const server = await s.option("ServerAddress");
    return apiOk(pageData(items.map((row) => publicMj(row as Record<string, unknown>, server, forward)), total, q));
  });

  r.get("/api/mj/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listMj(u.id, q.offset, q.page_size, {
      mj_id: c.url.searchParams.get("mj_id") || "",
      start_timestamp: c.url.searchParams.get("start_timestamp") || "",
      end_timestamp: c.url.searchParams.get("end_timestamp") || "",
    });
    const forward = await s.optionBool("MjForwardUrlEnabled", true);
    const server = await s.option("ServerAddress");
    return apiOk(pageData(items.map((row) => publicMj(row as Record<string, unknown>, server, forward)), total, q));
  });

  r.get("/api/models", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(await dashboardListModels(s));
  });

  r.post("/pg/chat/completions", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const body = await readJson(c.req);
    return playgroundRelay(c.req, c.env, s, user, body, { waitUntil: c.waitUntil });
  });

  r.get("/dashboard/billing/subscription", billingSub);
  r.get("/v1/dashboard/billing/subscription", billingSub);
  r.get("/dashboard/billing/usage", billingUsage);
  r.get("/v1/dashboard/billing/usage", billingUsage);

  registerMore(r);

  return r;
}

/** Original `common.DecodeJson` into `controller.OptionUpdateRequest`. Empty/invalid JSON is HTTP 400 gin.H omit `data`. */
function bindOptionUpdate(raw: string): { key: string; value: string } | Response {
  const invalid = () => json(400, { success: false, message: "无效的参数" });
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const rec = parsed.value as { key?: unknown; value?: unknown };
  return { key: rec.key == null ? "" : String(rec.key), value: optionInterface2String(rec.value) };
}

type LoginRequest = {
  username: string;
  password: string;
  password_encrypted: string;
  encryption_key_id: string;
};

type RegisterUser = {
  username: string;
  password: string;
  display_name: string;
  email: string;
  verification_code: string;
  aff_code: string;
  remark: string;
};

/** Original `encoding/json` string field: omitted/null → ""; wrong kind → type error. */
function bindJSONStringOn(req: Request, rec: Record<string, unknown>, key: string): string | Response {
  if (!(key in rec) || rec[key] == null) return "";
  if (typeof rec[key] !== "string") return apiFailInvalidParams(req);
  return rec[key] as string;
}

/** Original `common.DecodeJson` into `controller.LoginRequest`. Any decode error is `MsgInvalidParams`. JSON `null` is a zero struct. */
function bindLoginRequest(req: Request, raw: string): LoginRequest | Response {
  const invalid = () => apiFailInvalidParams(req);
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  const zero: LoginRequest = { username: "", password: "", password_encrypted: "", encryption_key_id: "" };
  if (parsed.value === null) return zero;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const rec = parsed.value as Record<string, unknown>;
  const username = bindJSONStringOn(req, rec, "username");
  if (username instanceof Response) return username;
  const password = bindJSONStringOn(req, rec, "password");
  if (password instanceof Response) return password;
  const passwordEncrypted = bindJSONStringOn(req, rec, "password_encrypted");
  if (passwordEncrypted instanceof Response) return passwordEncrypted;
  const encryptionKeyId = bindJSONStringOn(req, rec, "encryption_key_id");
  if (encryptionKeyId instanceof Response) return encryptionKeyId;
  return {
    username,
    password,
    password_encrypted: passwordEncrypted,
    encryption_key_id: encryptionKeyId,
  };
}

/** Original `common.DecodeJson` into `model.User` for `Register`. */
function bindRegisterUser(req: Request, raw: string): RegisterUser | Response {
  const invalid = () => apiFailInvalidParams(req);
  if (!raw.trim()) return invalid();
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return invalid();
  const zero: RegisterUser = {
    username: "",
    password: "",
    display_name: "",
    email: "",
    verification_code: "",
    aff_code: "",
    remark: "",
  };
  if (parsed.value === null) return zero;
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) return invalid();
  const rec = parsed.value as Record<string, unknown>;
  const username = bindJSONStringOn(req, rec, "username");
  if (username instanceof Response) return username;
  const password = bindJSONStringOn(req, rec, "password");
  if (password instanceof Response) return password;
  const displayName = bindJSONStringOn(req, rec, "display_name");
  if (displayName instanceof Response) return displayName;
  const email = bindJSONStringOn(req, rec, "email");
  if (email instanceof Response) return email;
  const verificationCode = bindJSONStringOn(req, rec, "verification_code");
  if (verificationCode instanceof Response) return verificationCode;
  const affCode = bindJSONStringOn(req, rec, "aff_code");
  if (affCode instanceof Response) return affCode;
  const remark = bindJSONStringOn(req, rec, "remark");
  if (remark instanceof Response) return remark;
  return {
    username,
    password,
    display_name: displayName,
    email,
    verification_code: verificationCode,
    aff_code: affCode,
    remark,
  };
}

/** Original `go-playground/validator` `Error()` for `common.Validate.Struct(&user)`. */
function validatorFieldError(field: string, tag: string): string {
  return `Key: 'User.${field}' Error:Field validation for '${field}' failed on the '${tag}' tag`;
}

/** Original Register `common.Validate.Struct(&user)` tags on `model.User`. */
function validateRegisterUser(user: RegisterUser): string | null {
  const errors: string[] = [];
  if (utf8RuneCount(user.username) > 20) errors.push(validatorFieldError("Username", "max"));
  const passwordRunes = utf8RuneCount(user.password);
  if (passwordRunes < 8) errors.push(validatorFieldError("Password", "min"));
  else if (passwordRunes > 128) errors.push(validatorFieldError("Password", "max"));
  if (utf8RuneCount(user.display_name) > 20) errors.push(validatorFieldError("DisplayName", "max"));
  if (utf8RuneCount(user.email) > 50) errors.push(validatorFieldError("Email", "max"));
  if (user.remark !== "" && utf8RuneCount(user.remark) > 255) errors.push(validatorFieldError("Remark", "max"));
  return errors.length ? errors.join("\n") : null;
}

/** Original `common.Interface2String` used by `UpdateOption`. */
function optionInterface2String(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value == null) return "";
  return String(value);
}

/** Original `controller.isPaymentComplianceOptionKey`. */
function isPaymentComplianceOptionKey(key: string): boolean {
  return key.startsWith("payment_setting.compliance_");
}

/** Original `controller.isPositiveOptionValue` (`strconv.Atoi` then `ParseFloat`). */
function isPositiveOptionValue(value: string): boolean {
  const trimmed = value.trim();
  if (/^[+-]?\d+$/.test(trimmed)) {
    try {
      return BigInt(trimmed) > 0n;
    } catch {
      return false;
    }
  }
  if (/^[+-]?0[xX]/.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}

/** Original `service.ValidateTaskArtifactBaseURL`. */
function validateTaskArtifactBaseURL(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "task artifact base URL is empty";
  if (raw !== trimmed) return "task artifact base URL must not contain surrounding whitespace";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "task artifact base URL is invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "task artifact base URL must use http or https";
  }
  if (!parsed.host || parsed.username || parsed.password) {
    return "task artifact base URL must contain a host and no userinfo";
  }
  if (parsed.search || parsed.hash || raw.includes("?") || raw.includes("#")) {
    return "task artifact base URL must not contain a query or fragment";
  }
  return null;
}

/** Original `types.LoadFromJsonString` into `map[string]float64`. */
function parseFloat64Map(jsonStr: string): { ok: true; value: Record<string, number> } | { ok: false; message: string } {
  const parsed = goUnmarshalJSON(jsonStr);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: true, value: {} };
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, message: `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type map[string]float64` };
  }
  const out: Record<string, number> = {};
  for (const [name, ratio] of Object.entries(parsed.value as Record<string, unknown>)) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
      return { ok: false, message: `json: cannot unmarshal ${goJSONKind(ratio)} into Go value of type float64` };
    }
    out[name] = ratio;
  }
  return { ok: true, value: out };
}

/** Original `ratio_setting.CheckGroupRatio`. */
function checkGroupRatio(jsonStr: string): string | null {
  const parsed = parseFloat64Map(jsonStr);
  if (!parsed.ok) return parsed.message;
  for (const [name, ratio] of Object.entries(parsed.value)) {
    if (ratio < 0) return "group ratio must be not less than 0: " + name;
  }
  return null;
}

const VALID_GEMINI_SAFETY_SETTINGS = new Set([
  "OFF",
  "BLOCK_NONE",
  "BLOCK_ONLY_HIGH",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_LOW_AND_ABOVE",
  "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
]);

/** Original `model_setting.ValidateGeminiSafetySettings`. */
function validateGeminiSafetySettings(value: string): string | null {
  const parsed = goUnmarshalJSON(value);
  if (!parsed.ok) return "Gemini safety settings must be a JSON string map: " + parsed.message;
  if (parsed.value === null) return "Gemini safety settings must be a JSON string map";
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `Gemini safety settings must be a JSON string map: json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type map[string]string`;
  }
  for (const [category, threshold] of Object.entries(parsed.value as Record<string, unknown>)) {
    if (typeof threshold !== "string") {
      return `Gemini safety settings must be a JSON string map: json: cannot unmarshal ${goJSONKind(threshold)} into Go value of type string`;
    }
    if (!threshold) continue;
    if (!VALID_GEMINI_SAFETY_SETTINGS.has(threshold)) {
      return `invalid Gemini safety threshold "${threshold}" for "${category}"`;
    }
  }
  return null;
}

/** Original `model_setting.ValidateClaudeDefaultMaxTokens`. */
function validateClaudeDefaultMaxTokens(value: string): string | null {
  const parsed = goUnmarshalJSON(value);
  if (!parsed.ok) return "Claude default max tokens must be a JSON map of model to integer: " + parsed.message;
  if (parsed.value === null) return "Claude default max tokens must be a JSON map of model to integer";
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return `Claude default max tokens must be a JSON map of model to integer: json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type map[string]int`;
  }
  for (const [model, maxTokens] of Object.entries(parsed.value as Record<string, unknown>)) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens)) {
      if (typeof maxTokens === "number") {
        return `Claude default max tokens must be a JSON map of model to integer: json: cannot unmarshal number ${maxTokens} into Go value of type int`;
      }
      return `Claude default max tokens must be a JSON map of model to integer: json: cannot unmarshal ${goJSONKind(maxTokens)} into Go value of type int`;
    }
    if (maxTokens < 0) return `negative Claude default max_tokens ${maxTokens} for "${model}"`;
  }
  return null;
}

/** Original `c.ShouldBindJSON` into `model.Redemption`. */
async function bindRedemption(req: Request): Promise<Record<string, unknown> | Response> {
  const raw = await req.text();
  if (!raw.trim()) return apiErrorMsg("EOF");
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return apiErrorMsg(parsed.message);
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return apiErrorMsg(`json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type model.Redemption`);
  }
  return parsed.value as Record<string, unknown>;
}

/** Original `c.ShouldBindJSON` into `controller.topUpRequest`. */
async function bindTopUpRequest(req: Request): Promise<Record<string, unknown> | Response> {
  const raw = await req.text();
  if (!raw.trim()) return apiErrorMsg("EOF");
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return apiErrorMsg(parsed.message);
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return apiErrorMsg(`json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type controller.topUpRequest`);
  }
  return parsed.value as Record<string, unknown>;
}

/** Original `model.GetRedemptionById` / `DeleteRedemptionById`. */
async function redemptionById(s: Store, id: number): Promise<RedemptionRow | Response> {
  if (id === 0) return apiErrorMsg("id 为空！");
  const item = await s.getRedemption(id);
  if (!item) return apiErrorMsg("record not found");
  return item;
}

/** Original `i18n.MsgRedemptionNameLength`. */
function redemptionNameLengthMessage(req: Request): string {
  return i18nPair(req, "兑换码名称长度必须在1-20之间", "Redemption code name length must be between 1-20");
}

/** Original `i18n.MsgRedemptionCountPositive`. */
function redemptionCountPositiveMessage(req: Request): string {
  return i18nPair(req, "兑换码个数必须大于0", "Redemption code count must be greater than 0");
}

/** Original `i18n.MsgRedemptionCountMax`. */
function redemptionCountMaxMessage(req: Request): string {
  return i18nPair(req, "一次兑换码批量生成的个数不能大于 100", "Maximum 100 redemption codes can be generated at once");
}

/** Original `i18n.MsgRedemptionExpireTimeInvalid`. */
function redemptionExpiredError(req: Request, expired: number): Response | null {
  if (expired !== 0 && expired < nowSec()) {
    return apiErrorMsg(i18nPair(req, "过期时间不能早于当前时间", "Expiration time cannot be earlier than current time"));
  }
  return null;
}

/** Original `redemption.Quota <= 0` / `common.ValidateWalletQuota`. */
function redemptionQuotaError(quota: number): Response | null {
  if (quota <= 0) return apiErrorMsg("redemption quota must be positive");
  if (quota > MAX_WALLET_QUOTA) return apiErrorMsg(`wallet quota exceeds ${MAX_WALLET_QUOTA}`);
  return null;
}

/** Original `i18n.MsgRedeemFailed`. */
function redeemFailedMessage(req: Request): string {
  return i18nPair(req, "兑换失败，请稍后重试", "Redemption failed, please try again later");
}

async function quotaDisplayAmount(s: Store, quota: number): Promise<number> {
  const display = (await s.option("general_setting.quota_display_type")) || "USD";
  if (display === "TOKENS") return quota;
  const quotaPerUnit = await s.optionNum("QuotaPerUnit", 500000);
  const usd = quota / quotaPerUnit;
  if (display === "CNY") return usd * (await s.optionNum("USDExchangeRate", 1));
  return usd;
}

async function billingSub(c: C): Promise<Response> {
  const s = store(c);
  const { authenticateApiToken } = await import("./auth.js");
  const auth = await authenticateApiToken(c, s);
  if (auth instanceof Response) return auth;
  const tokenStat = await s.optionBool("DisplayTokenStatEnabled", true);
  let remain = auth.user.quota;
  let used = auth.user.used_quota;
  let expiredTime = 0;
  let unlimited = false;
  if (tokenStat) {
    remain = auth.token.remain_quota;
    used = auth.token.used_quota;
    expiredTime = auth.token.expired_time;
    unlimited = Boolean(auth.token.unlimited_quota);
  }
  let amount = await quotaDisplayAmount(s, remain + used);
  if (unlimited) amount = 100000000;
  return json(200, {
    object: "billing_subscription",
    has_payment_method: true,
    soft_limit_usd: amount,
    hard_limit_usd: amount,
    system_hard_limit_usd: amount,
    access_until: expiredTime > 0 ? expiredTime : 0,
  });
}

async function billingUsage(c: C): Promise<Response> {
  const s = store(c);
  const { authenticateApiToken } = await import("./auth.js");
  const auth = await authenticateApiToken(c, s);
  if (auth instanceof Response) return auth;
  const tokenStat = await s.optionBool("DisplayTokenStatEnabled", true);
  const quota = tokenStat ? auth.token.used_quota : auth.user.used_quota;
  const amount = await quotaDisplayAmount(s, quota);
  return json(200, {
    object: "list",
    total_usage: amount * 100,
  });
}
