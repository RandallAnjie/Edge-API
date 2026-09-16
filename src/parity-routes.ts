import { billingCopies } from "./billing-setting.js";
import { CHANNEL_MANUAL_DISABLED, CHANNEL_TYPE_OLLAMA, ROLE_ROOT, ROLE_USER, USER_ENABLED, nowSec, parseJson, randomHex } from "./constants.js";
import { permissionCatalog, canWithPolicies, roleKeyForSystemRole, roleSubject, userSubject } from "./authz.js";
import { loadPerformanceSetting, performanceStats, resetMetrics } from "./metrics.js";
import {
  handleCreemWebhook,
  handleEpayNotify,
  handleStripeWebhook,
  handleWaffoPancakeWebhook,
  handleWaffoWebhook,
  paymentEnabled,
  requestAmount,
  requestCreemPay,
  requestEpay,
  requestStripePay,
  requestWaffoPancakePay,
  requestWaffoPay,
  requirePaymentCompliance,
  topupInfo,
} from "./payments.js";
import {
  handleSubscriptionEpayNotify,
  handleSubscriptionEpayReturn,
  requestSubscriptionCreemPay,
  requestSubscriptionEpay,
  requestSubscriptionStripePay,
  requestSubscriptionWaffoPancakePay,
} from "./subscription-payment.js";
import { notifyAccountSecurityChange, validateAccountEmail } from "./mail.js";
import { verifyTelegramLogin, wechatIdFromCode } from "./oauth.js";
import { bytesToHex, generateAffCode, sha256Bytes } from "./crypto.js";
import { finishInsertUser } from "./user-insert.js";
import {
  EMAIL_BIND_FLOW_TYPE,
  EMAIL_BINDING_MAX_ATTEMPTS,
  EMAIL_BINDING_RESEND_DELAY_SEC,
  EMAIL_BINDING_TTL_SEC,
  authFlowInvalid,
  emailAlreadyTaken,
  emailBindingAuthorization,
  emailBindingCodeInvalid,
  emailBindingCodesValid,
  emailBindingLocked,
  emailBindingResendWait,
  emailBindingView,
  emailDeliveryFailed,
  emailTakenByOther,
  generateEmailBindingCodes,
  loadEmailBinding,
  notifyEmailBound,
  sendEmailBindingCodes,
  validateStoredEmailBinding,
  type EmailBindingState,
} from "./email-binding.js";
import { fetchCustomOAuthDiscovery, publicCustomOAuthProvider } from "./custom-oauth.js";
import { manageMultiKeys } from "./channel-info.js";
import { bindVerificationOperation, issueSecurityProof, securityProofError } from "./security.js";
import { applyAllChannelUpstreamModelUpdates, applyChannelUpstreamModelUpdatesForId, detectChannelUpstreamModelUpdates } from "./channel-upstream-update.js";
import { enqueueSystemTask, SYSTEM_TASK_TYPE_MODEL_UPDATE, systemTaskIdOf } from "./system-task.js";
import { headerNavModulePublicOrUserAuth, isHeaderNavDenied } from "./header-nav.js";
import { apiFail, apiFailCode, apiOk, clientIp, i18nPair, json, pageData, pageQuery, parseUnixQuery, payErr, readJson, strconvAtoi, taskArtifactError, taskPluginUnknownMetaFieldMessage } from "./http.js";
import type { Context } from "./router.js";
import type { Router } from "./router.js";
import {
  authenticateApiToken,
  currentSid,
  dashboardIdentity,
  isResponse,
  issueSessionSafe,
  setupLogin,
  requireAdmin,
  requireChannel,
  requirePermission,
  requireProof,
  requireRoot,
  requireUser,
  sessionResponse,
  sessionSecret,
  verifyLoginFromRequest,
} from "./auth.js";
import { Store } from "./store.js";
import { updateAllChannelBalances, updateOneChannelBalance } from "./channel-balance.js";
import { enrichModelMeta, extractPluginMeta, listAdminModels, metadataRecordVersion, publicFlowQuotaData, publicQuotaData, publicSystemTask, publicTaskPluginRecord, publicVendor, taskArtifactsView, taskPluginMetaView, vendorOperationPreviewVersion } from "./dto.js";
import {
  factoryPluginHasIcon,
  factoryPluginIcon,
  factoryPluginSource,
  hasFactoryPlugin,
  listTaskPluginListItems,
  listTaskPluginOptions,
  resolveTaskPluginSource,
  setTaskPluginDisabledFactoryKeys,
  getTaskPluginDisabledFactoryKeys,
} from "./task-plugin-factory.js";
import { channelAffinityCacheStats, clearAffinityCacheAll, clearAffinityCacheByRule, getChannelAffinityUsageCacheStats } from "./channel-affinity.js";
import { applyMetadataSync, previewMetadataSync } from "./model-sync.js";
import { DEFAULT_MARKETPLACE_SOURCES } from "./option-defaults.js";
import { queryPerfMetrics, queryPerfMetricsSummary } from "./perf-metrics.js";
import { SYSTEM_INSTANCE_STALE_AFTER_SECONDS, listSystemInstanceResponses } from "./system-instance.js";
import { lazySystemTaskRun, runPendingLogCleanupSystemTask, startLogCleanupTask } from "./system-task.js";
import { fetchUpstreamRatios, validateFetchRequest } from "./ratio-sync.js";
import { compilePlugin, dryRunPlugin, UnknownMetaFieldError } from "./jsplugin.js";
import { decodeIconDataURI } from "./jsplugin-icon.js";
import { currentRoutingGeneration, preflightRoutingConflict, routingMetaFromRecord } from "./jsplugin-preflight.js";
import { validateV1Meta } from "./jsplugin-validate.js";
import { getTaskPluginListRuntime, getTaskPluginRuntimeStatus, syncTaskPluginsOnce } from "./task-plugin-sync.js";
import { goJSONKind, goUnmarshalJSON, parseChannelBatch } from "./channel-validate.js";
import { rpFromRequest } from "./passkey.js";
import { passkeyDomainHttpError, passkeySettingsSnapshot, selectPasskeyBeginRpIDs } from "./passkey-domains.js";
import { calcNextResetTime, publicPlan } from "./subscription.js";
import { parseCodexOAuthKeyStrict, persistCodexOAuthKey, refreshCodexChannelCredential, refreshCodexOAuthToken } from "./codex-models.js";
import {
  deleteOllamaModel,
  fetchOllamaVersion,
  ollamaChannelBaseURL,
  ollamaFirstKey,
  pullOllamaModel,
  pullOllamaModelStream,
} from "./ollama-admin.js";
import {
  computeStatusCounts,
  ionetApiKey,
  ionetRequest,
  ionetSettings,
  ionetWrapError,
  IONET_NOT_CONFIGURED,
  logsEndpoint,
  mapIoNetAvailableReplicas,
  mapIoNetContainerDetails,
  mapIoNetContainerList,
  mapIoNetDeployment,
  mapIoNetDeploymentDetail,
  mapIoNetExtendedDeployment,
  mapIoNetHardwareTypes,
  mapIoNetLocations,
  mapIoNetPriceEstimation,
  priceEstimationCurrency,
  priceEstimationDurationHours,
  testIoNetTotals,
  validateDeployRequest,
  validatePriceEstimationRequest,
} from "./ionet.js";
import type { Env } from "./types.js";

type C = Context<Env>;
type VendorOp = { action?: string; vendor_ids?: number[]; model_ids?: number[]; target_vendor_id?: number; expected_version?: string };

function vendorOpError(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("vendor data changed")) {
    return json(409, { success: false, message, code: "VENDOR_CONFLICT" });
  }
  if (e && typeof e === "object" && "reference_counts" in (e as object)) {
    const counts = (e as { reference_counts: Record<string, number> }).reference_counts;
    return json(409, { success: false, message: "vendors are still referenced by models; transfer or clear their assignments first", code: "VENDOR_REFERENCED", reference_counts: counts });
  }
  return json(400, { success: false, message });
}

async function vendorOperationPreview(s: Store, operation: VendorOp): Promise<Record<string, unknown>> {
  const action = String(operation.action || "");
  if (action !== "assign" && action !== "merge" && action !== "delete") throw new Error("unsupported vendor operation");
  const ids = action === "assign" ? [...(operation.model_ids || [])] : [...(operation.vendor_ids || [])];
  if (ids.length < 1 || ids.length > 1000) throw new Error("select between 1 and 1000 records");
  const sorted = [...ids].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= 0 || (i > 0 && sorted[i] === sorted[i - 1])) throw new Error("invalid or duplicate selection");
  }
  const vendors = ((await s.listVendors()) as Record<string, unknown>[]).map((v) => publicVendor(v));
  const byId = new Map(vendors.map((v) => [Number(v.id), v]));
  let target: Record<string, unknown> | null = null;
  if (action !== "delete") {
    if ((operation.target_vendor_id ?? -1) < 0 || (action === "merge" && !operation.target_vendor_id)) {
      throw new Error("select a saved target vendor");
    }
    if (operation.target_vendor_id) {
      target = byId.get(Number(operation.target_vendor_id)) || null;
      if (!target) throw new Error("vendor data changed; preview again before applying: target vendor does not exist");
    }
  }
  const sources: Record<string, unknown>[] = [];
  const modelsOut: Record<string, unknown>[] = [];
  const modelRows: Record<string, unknown>[] = [];
  const meta = (await s.listModelMeta()) as Record<string, unknown>[];
  if (action === "assign") {
    const selected = new Set(ids);
    for (const m of meta) {
      if (!selected.has(Number(m.id))) continue;
      const vendor = byId.get(Number(m.vendor_id || 0));
      modelsOut.push({
        id: Number(m.id),
        model_name: String(m.model_name || ""),
        name_rule: Number(m.name_rule || 0),
        vendor_id: Number(m.vendor_id || 0),
        vendor_name: String(vendor?.name || ""),
        updated_time: Number(m.updated_time || 0),
      });
      modelRows.push(m);
      if (vendor && !sources.some((x) => x.id === vendor.id)) sources.push(vendor);
    }
    if (modelsOut.length !== ids.length) throw new Error("vendor data changed; preview again before applying: a selected model no longer exists");
  } else {
    for (const id of ids) {
      const vendor = byId.get(id);
      if (!vendor) throw new Error("vendor data changed; preview again before applying: source vendor does not exist");
      if (action === "merge" && id === Number(operation.target_vendor_id)) throw new Error("target vendor cannot also be a source");
      sources.push(vendor);
    }
    const sourceSet = new Set(ids);
    for (const m of meta) {
      if (!sourceSet.has(Number(m.vendor_id || 0))) continue;
      const vendor = byId.get(Number(m.vendor_id || 0));
      modelsOut.push({
        id: Number(m.id),
        model_name: String(m.model_name || ""),
        name_rule: Number(m.name_rule || 0),
        vendor_id: Number(m.vendor_id || 0),
        vendor_name: String(vendor?.name || ""),
        updated_time: Number(m.updated_time || 0),
      });
      modelRows.push(m);
    }
  }
  if (action === "delete" && modelsOut.length > 0) {
    const counts: Record<string, number> = {};
    for (const m of modelsOut) {
      const vendorId = String(m.vendor_id || 0);
      counts[vendorId] = (counts[vendorId] || 0) + 1;
    }
    throw Object.assign(new Error("vendors are still referenced by models; transfer or clear their assignments first"), {
      reference_counts: counts,
    });
  }
  sources.sort((a, b) => Number(a.id) - Number(b.id));
  const modelVersions = modelRows.map((row) => metadataRecordVersion(row, null, null));
  const version = vendorOperationPreviewVersion({ action, sources, target, models: modelsOut }, modelVersions);
  return { action, sources, target, models: modelsOut, version };
}

function originalPageInfo(url: URL): { page: number; pageSize: number } {
  const p = url.searchParams.get("p");
  let page = p != null && /^-?\d+$/.test(p) ? Number(p) : 0;
  let pageSize = 0;
  const size = url.searchParams.get("page_size");
  if (size != null && /^-?\d+$/.test(size)) pageSize = Number(size);
  if (page < 1) {
    if (p != null && /^-?\d+$/.test(p) && Number(p) !== 0) page = Number(p);
    else page = 1;
  }
  if (pageSize === 0) {
    const fallback = url.searchParams.get("ps") || url.searchParams.get("size");
    if (fallback && /^-?\d+$/.test(fallback)) pageSize = Number(fallback);
    if (pageSize === 0) pageSize = 10;
  }
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize };
}

async function serveModelsMeta(c: C, keyword: string, vendor: string): Promise<Response> {
  const s = store(c);
  const u = await requireAdmin(c, s);
  if (isResponse(u)) return u;
  const squareState = c.url.searchParams.get("square_state") || "";
  if (squareState && !["visible", "unavailable", "hidden", "partial"].includes(squareState)) {
    return json(400, { success: false, message: "Invalid model square state" });
  }
  const q = originalPageInfo(c.url);
  if (squareState && (q.page < 1 || q.pageSize < 1)) {
    return json(400, { success: false, message: "Invalid pagination" });
  }
  const listed = await listAdminModels(s, {
    keyword,
    vendor,
    status: c.url.searchParams.get("status") || "",
    syncOfficial: c.url.searchParams.get("sync_official") || "",
    includeChannelModels: c.url.searchParams.get("include_channel_models") === "true",
    squareState,
    page: q.page,
    pageSize: q.pageSize,
  });
  return apiOk(pageData(listed.items, listed.total, { page: q.page, page_size: q.pageSize, offset: 0 }, { vendor_counts: listed.vendor_counts }));
}

function store(c: C): Store {
  return new Store(c.env.DB);
}

function sessionViews(
  items: {
    sid: string;
    created_at: number;
    last_seen: number;
    ip: string;
    ua: string;
    revoked: number;
    expires_at: number;
    login_method?: string;
  }[],
  currentSid: string,
) {
  return items
    .filter((x) => !x.revoked)
    .map((x) => ({
      sid: x.sid,
      current: x.sid === currentSid,
      login_method: x.login_method || "password",
      ip: x.ip,
      user_agent: x.ua,
      created_at: x.created_at,
      last_active_at: x.last_seen,
      expires_at: x.expires_at,
    }));
}

export function registerParity(r: Router<Env>): void {
  r.get("/api/authz/catalog", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(permissionCatalog());
  });

  r.post("/api/oauth/email/bind/start", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
    let body: { email?: unknown };
    try {
      body = (await readJson(c.req)) as { email?: unknown };
    } catch {
      return securityProofError("SECURITY_CONTEXT_INVALID", "The action details are invalid.", 400);
    }
    if (!body || typeof body !== "object") {
      return securityProofError("SECURITY_CONTEXT_INVALID", "The action details are invalid.", 400);
    }
    const validated = await validateAccountEmail(s, String(body.email || ""));
    if (!validated.ok) return apiFailCode(validated.message, validated.code);
    const email = validated.email;
    const proof = await requireProof(c, s, { scope: "account.binding.bind", context: { provider: "email", email } });
    if (isResponse(proof)) return proof;
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, { scope: "account.binding.bind", context: { provider: "email", email } });
    if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
    if (await emailTakenByOther(s, email, proof.userId)) return emailAlreadyTaken();
    const user = await s.getUserById(proof.userId);
    if (!user) return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
    const currentEmail = (user.email || "").trim().toLowerCase();
    const requireOld = Boolean(currentEmail) && proof.method !== "2fa" && proof.method !== "passkey";
    const codes = await generateEmailBindingCodes(requireOld);
    const now = nowSec();
    const state: EmailBindingState = {
      authorization: emailBindingAuthorization(proof, proof.method, bound.binding.contextHash),
      current_email: currentEmail,
      email,
      new_code_hash: codes.NewHash,
      ...(codes.OldHash ? { old_code_hash: codes.OldHash } : {}),
      failed_attempts: 0,
      resend_at: now + EMAIL_BINDING_RESEND_DELAY_SEC,
    };
    const flow = randomHex(16);
    const expiresAt = now + EMAIL_BINDING_TTL_SEC;
    await s.insertAuthFlow({
      token: flow,
      type: EMAIL_BIND_FLOW_TYPE,
      user_id: proof.userId,
      expires_at: expiresAt,
      payload: JSON.stringify(state),
      session_id: proof.sessionId,
    });
    try {
      await sendEmailBindingCodes(s, state, codes);
    } catch {
      await s.consumeAuthFlow(flow, { type: EMAIL_BIND_FLOW_TYPE, user_id: proof.userId, session_id: proof.sessionId });
      return emailDeliveryFailed();
    }
    let notification_warning = false;
    if (currentEmail && !requireOld) {
      notification_warning = await notifyAccountSecurityChange(s, currentEmail, "A change of your email address was requested");
    }
    return apiOk(emailBindingView(flow, expiresAt, state, notification_warning));
  });

  r.post("/api/oauth/email/bind/resend", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
    let body: { flow_token?: unknown };
    try {
      body = (await readJson(c.req)) as { flow_token?: unknown };
    } catch {
      return authFlowInvalid();
    }
    const token = String(body?.flow_token || "");
    if (!token) return authFlowInvalid();
    const loaded = await loadEmailBinding(s, identity, token);
    if ("error" in loaded) return loaded.error;
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, {
      scope: "account.binding.bind",
      context: { provider: "email", email: loaded.state.email },
    });
    if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
    const invalid = await validateStoredEmailBinding(s, identity, loaded.state, bound.binding.contextHash);
    if (invalid) return invalid;
    if (loaded.state.resend_at > nowSec()) return emailBindingResendWait();
    const codes = await generateEmailBindingCodes(Boolean(loaded.state.old_code_hash));
    const next: EmailBindingState = {
      ...loaded.state,
      new_code_hash: codes.NewHash,
      old_code_hash: loaded.state.old_code_hash ? codes.OldHash : undefined,
      resend_at: nowSec() + EMAIL_BINDING_RESEND_DELAY_SEC,
    };
    if (!next.old_code_hash) delete next.old_code_hash;
    await s.updateAuthFlowPayload(token, JSON.stringify(next));
    try {
      await sendEmailBindingCodes(s, next, codes);
    } catch {
      await s.consumeAuthFlow(token, { type: EMAIL_BIND_FLOW_TYPE, user_id: identity.userId, session_id: identity.sessionId });
      return emailDeliveryFailed();
    }
    return apiOk(emailBindingView(token, loaded.flow.expires_at, next));
  });

  r.post("/api/oauth/email/bind", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
    let body: { flow_token?: unknown; new_code?: unknown; old_code?: unknown };
    try {
      body = (await readJson(c.req)) as { flow_token?: unknown; new_code?: unknown; old_code?: unknown };
    } catch {
      return authFlowInvalid();
    }
    const token = String(body?.flow_token || "");
    if (!token) return authFlowInvalid();
    const loaded = await loadEmailBinding(s, identity, token);
    if ("error" in loaded) return loaded.error;
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, {
      scope: "account.binding.bind",
      context: { provider: "email", email: loaded.state.email },
    });
    if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
    const invalid = await validateStoredEmailBinding(s, identity, loaded.state, bound.binding.contextHash);
    if (invalid) return invalid;
    if (await emailTakenByOther(s, loaded.state.email, identity.userId)) return emailAlreadyTaken();
    if (!(await emailBindingCodesValid(loaded.state, String(body.new_code || ""), String(body.old_code || "")))) {
      const failed = Number(loaded.state.failed_attempts || 0) + 1;
      const next = { ...loaded.state, failed_attempts: failed };
      await s.updateAuthFlowPayload(token, JSON.stringify(next));
      if (failed >= EMAIL_BINDING_MAX_ATTEMPTS) return emailBindingLocked();
      return emailBindingCodeInvalid();
    }
    await s.updateUser(identity.userId, { email: loaded.state.email });
    await s.consumeAuthFlow(token, { type: EMAIL_BIND_FLOW_TYPE, user_id: identity.userId, session_id: identity.sessionId });
    const notification_warning = await notifyEmailBound(s, loaded.state.current_email, loaded.state.email);
    return apiOk({ notification_warning });
  });

  r.get("/api/oauth/wechat", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("WeChatAuthEnabled", false))) return apiFail("管理员未开启通过微信登录以及注册");
    const code = c.url.searchParams.get("code") || "";
    try {
      const wechatId = await wechatIdFromCode(s, code);
      const taken = await s.getUserByField("wechat_id", wechatId, { includeDeleted: true });
      let user = taken && Number(taken.deleted_at || 0) === 0 ? taken : null;
      if (taken && !user) return apiFail("用户已注销");
      if (!user) {
        if (!(await s.optionBool("RegisterEnabled", true))) return apiFail("管理员关闭了新用户注册");
        const id = await s.insertUser({
          username: `wechat_${(await s.maxUserId()) + 1}`,
          display_name: "WeChat User",
          role: ROLE_USER,
          status: USER_ENABLED,
          wechat_id: wechatId,
          quota: await s.optionNum("QuotaForNewUser", 0),
          aff_code: generateAffCode(),
        });
        await finishInsertUser(s, id, 0);
        user = await s.getUserById(id);
        if (!user) return apiFail("用户不存在");
      }
      if (user.status !== USER_ENABLED) return apiFail("用户已被封禁");
      return setupLogin(s, c.env, user, c.req, "wechat");
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/oauth/wechat/bind", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
    if (!(await s.optionBool("WeChatAuthEnabled", false))) return apiFail("管理员未开启通过微信登录以及注册");
    let body: { code?: unknown };
    try {
      body = (await readJson(c.req)) as { code?: unknown };
    } catch {
      return apiFail("无效的请求");
    }
    if (!body || typeof body !== "object") return apiFail("无效的请求");
    const code = String(body.code || "").trim();
    const proof = await requireProof(c, s, { scope: "account.binding.bind", context: { provider: "wechat", code } });
    if (isResponse(proof)) return proof;
    try {
      const wechatId = await wechatIdFromCode(s, code);
      if (await s.getUserByField("wechat_id", wechatId, { includeDeleted: true })) {
        return apiFail("该微信账号已被绑定");
      }
      const bound = await s.bindUserColumnForSession(proof, "wechat_id", wechatId);
      if (bound === "already_claimed") {
        return apiFailCode("This external account is already bound.", "ACCOUNT_ALREADY_BOUND");
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
      const user = await s.getUserById(proof.userId);
      const notification_warning = await notifyAccountSecurityChange(s, user?.email || "", "WeChat account linked");
      return apiOk({ notification_warning });
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/oauth/telegram/login", () =>
    json(410, {
      success: false,
      code: "TELEGRAM_LEGACY_AUTH_REMOVED",
      message: "Telegram login has changed. Reload the page and start Telegram OAuth again.",
    }),
  );
  r.post("/api/oauth/telegram/bind/start", () =>
    json(410, {
      success: false,
      code: "TELEGRAM_LEGACY_AUTH_REMOVED",
      message: "Telegram login has changed. Reload the page and start Telegram OAuth again.",
    }),
  );
  r.get("/api/oauth/telegram/bind/:flow_token", () =>
    json(410, {
      success: false,
      code: "TELEGRAM_LEGACY_AUTH_REMOVED",
      message: "Telegram login has changed. Reload the page and start Telegram OAuth again.",
    }),
  );

  r.post("/api/user/login/verify", async (c) => verifyLoginFromRequest(store(c), c.env, c.req));

  r.post("/api/user/passkey/verify/begin", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { scope?: string; context?: unknown; rp_id?: string };
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, { scope: body.scope || "", context: body.context });
    if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
    const keys = await s.listPasskeys(u.id);
    if (!keys.length) return apiFail("该用户尚未绑定 Passkey");
    let selected: { rpId: string; rp_ids: string[] };
    try {
      selected = selectPasskeyBeginRpIDs(
        await passkeySettingsSnapshot(s),
        body.rp_id || "",
        rpFromRequest(c.req).rpId,
        keys[0]?.rp_id || "",
      );
    } catch (e) {
      return passkeyDomainHttpError(e, c.req);
    }
    const { newChallenge } = await import("./passkey.js");
    const ch = newChallenge();
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({
      token: ch.id,
      type: "passkey_verify",
      user_id: u.id,
      expires_at: expiresAt,
      payload: JSON.stringify({
        challenge: ch.challenge,
        scope: bound.binding.scope,
        context_hash: bound.binding.contextHash,
        rp_id: selected.rpId,
      }),
      session_id: identity.sessionId,
    });
    const options = {
      challenge: ch.challenge,
      allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
      timeout: 60000,
      userVerification: "preferred",
      rpId: selected.rpId,
    };
    return apiOk({ options, rp_ids: selected.rp_ids, flow_token: ch.id, expires_at: expiresAt, flow_id: ch.id, publicKey: options });
  });

  r.post("/api/user/passkey/verify/finish", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { flow_id?: string; flow_token?: string; credential_id?: string };
    const flow = await s.getAuthFlow(body.flow_id || body.flow_token || "");
    if (!flow || flow.type !== "passkey_verify" || flow.user_id !== u.id) return apiFail("流程无效");
    const payload = parseJson<{ scope?: string; context_hash?: string }>(flow.payload, {});
    await s.deleteAuthFlow(flow.token);
    const secret = await sessionSecret(c.env, s);
    const proof = await issueSecurityProof(s, secret, identity, "passkey", {
      scope: payload.scope || "",
      contextHash: payload.context_hash || "",
    });
    return apiOk(proof);
  });

  r.get("/api/user/:id/oauth/bindings", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(Number(c.params.id));
    if (!user) return apiFail("用户不存在");
    return apiOk(await s.listUserOAuthBindings(user.id));
  });

  r.delete("/api/user/:id/oauth/bindings/:provider_id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteUserOAuthBinding(Number(c.params.id), Number(c.params.provider_id));
    return apiOk(null);
  });

  r.delete("/api/user/:id/bindings/:binding_type", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const map: Record<string, string> = {
      github: "github_id",
      discord: "discord_id",
      linuxdo: "linuxdo_id",
      oidc: "oidc_id",
      wechat: "wechat_id",
      telegram: "telegram_id",
      email: "email",
    };
    const col = map[c.params.binding_type];
    if (!col) return apiFail("未知绑定类型");
    await s.updateUser(Number(c.params.id), { [col]: "" });
    return apiOk(null);
  });

  r.get("/api/channel/update_balance", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    return updateAllChannelBalances(s);
  });

  r.get("/api/channel/update_balance/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const ch = await s.getChannel(id.n);
    if (!ch) return apiFail("record not found");
    return updateOneChannelBalance(s, ch);
  });

  r.post("/api/channel/tag/disabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { tag?: string };
    if (!body.tag) return apiFail("参数错误");
    await s.setChannelsByTag(body.tag, CHANNEL_MANUAL_DISABLED);
    return apiOk(null);
  });

  r.put("/api/channel/tag", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    let body: {
      tag?: string;
      new_tag?: string;
      model_mapping?: string;
      models?: string;
      group?: string;
      groups?: string;
      priority?: number;
      weight?: number;
      param_override?: string;
      header_override?: string;
    };
    try {
      body = (await readJson(c.req)) as typeof body;
    } catch {
      return apiFail("参数错误");
    }
    if (!body.tag) return apiFail("tag不能为空");
    if ((body.param_override != null || body.header_override != null) && u.role < 100) {
      const user = await s.getUserById(u.id);
      const roleKey = user ? roleKeyForSystemRole(user.role) : "";
      const userPolicies = user ? await s.casbinPolicies(userSubject(user.id)) : [];
      const rolePolicies = roleKey ? await s.casbinPolicies(roleSubject(roleKey)) : [];
      const allowed = user
        ? canWithPolicies(user, "channel", "sensitive_write", userPolicies, rolePolicies)
        : false;
      if (!allowed) {
        return apiFail(i18nPair(c.req, "无权进行此操作，权限不足", "Unauthorized, insufficient privileges"));
      }
    }
    if (body.param_override != null) {
      const trimmed = String(body.param_override).trim();
      if (trimmed && !isJsonValue(trimmed)) return apiFail("参数覆盖必须是合法的 JSON 格式");
      body.param_override = trimmed;
    }
    if (body.header_override != null) {
      const trimmed = String(body.header_override).trim();
      if (trimmed && !isJsonValue(trimmed)) return apiFail("请求头覆盖必须是合法的 JSON 格式");
      body.header_override = trimmed;
    }
    const channels = await s.channelsByTag(body.tag);
    for (const ch of channels) {
      const patch: Record<string, unknown> = {};
      if (body.new_tag != null && body.new_tag !== body.tag) patch.tag = body.new_tag;
      if (body.model_mapping != null) patch.model_mapping = body.model_mapping;
      if (body.models != null && body.models !== "") patch.models = body.models;
      if (body.group != null && body.group !== "") patch.group = body.group;
      if (body.groups != null && body.groups !== "") patch.group = body.groups;
      if (body.priority != null) patch.priority = body.priority;
      if (body.weight != null) patch.weight = body.weight;
      if (body.param_override != null) patch.param_override = body.param_override;
      if (body.header_override != null) patch.header_override = body.header_override;
      if (Object.keys(patch).length) await s.updateChannel(ch.id, patch);
    }
    return apiOk(null);
  });

  r.post("/api/channel/fix", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    try {
      return apiOk(await s.fixAbilities());
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/channel/:id/codex/refresh", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(`invalid channel id: ${id.message}`);
    try {
      const { oauth, channel } = await refreshCodexChannelCredential(s, id.n);
      return json(200, {
        success: true,
        message: "refreshed",
        data: {
          expires_at: oauth.expired,
          last_refresh: oauth.last_refresh,
          account_id: oauth.account_id,
          email: oauth.email,
          channel_id: channel.id,
          channel_type: channel.type,
          channel_name: channel.name,
        },
      });
    } catch {
      return apiFail("刷新凭证失败，请稍后重试");
    }
  });

  r.get("/api/channel/:id/codex/usage", async (c) => fetchCodexWham(c, "usage"));
  r.get("/api/channel/:id/codex/usage/reset-credits", async (c) => fetchCodexWham(c, "reset-credits"));
  r.post("/api/channel/:id/codex/usage/reset", async (c) => fetchCodexWham(c, "reset"));

  r.post("/api/channel/ollama/pull", async (c) => ollamaOp(c, "pull"));
  r.post("/api/channel/ollama/pull/stream", async (c) => ollamaOp(c, "stream"));
  r.delete("/api/channel/ollama/delete", async (c) => ollamaOp(c, "delete"));
  r.get("/api/channel/ollama/version/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return json(400, { success: false, message: "Invalid channel id" });
    const ch = await s.getChannel(id.n);
    if (!ch) return json(404, { success: false, message: "Channel not found" });
    if (ch.type !== CHANNEL_TYPE_OLLAMA) {
      return json(400, { success: false, message: "This operation is only supported for Ollama channels" });
    }
    try {
      const version = await fetchOllamaVersion(ollamaChannelBaseURL(ch), ollamaFirstKey(ch));
      return apiOk({ version });
    } catch (err) {
      return apiFail(`获取Ollama版本失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  r.post("/api/channel/batch/tag", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    let body: unknown;
    try {
      body = await readJson(c.req);
    } catch {
      return apiFail("参数错误");
    }
    const parsed = parseChannelBatch(body);
    if (!parsed.ok) return apiFail("参数错误");
    try {
      await s.batchSetChannelTag(parsed.ids, parsed.tag);
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
    return apiOk(parsed.ids.length);
  });

  r.get("/api/channel/tag/models", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const tag = c.url.searchParams.get("tag") || "";
    if (!tag) return json(400, { success: false, message: "tag不能为空" });
    const channels = await s.channelsByTag(tag);
    let longest = "";
    let maxLen = 0;
    for (const ch of channels) {
      if (!ch.models) continue;
      const parts = String(ch.models).split(",");
      if (parts.length > maxLen) {
        maxLen = parts.length;
        longest = ch.models;
      }
    }
    return apiOk(longest);
  });

  r.post("/api/channel/multi_key/manage", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as {
      channel_id?: number;
      action?: string;
      key_index?: number;
      page?: number;
      page_size?: number;
      status?: number;
    };
    const ch = await s.getChannel(Number(body.channel_id));
    if (!ch) return apiFail("渠道不存在");
    if (body.action === "delete_key" || body.action === "delete_disabled_keys") {
      const allowed = await requirePermission(c, s, "channel", "sensitive_write");
      if (isResponse(allowed)) return allowed;
    }
    const result = manageMultiKeys(ch, body);
    if (result instanceof Response) return result;
    await s.updateChannel(ch.id, result.patch);
    return result.response;
  });

  r.post("/api/channel/upstream_updates/detect", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    let body: { id?: number };
    try {
      body = (await readJson(c.req)) as { id?: number };
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const id = Number(body.id || 0);
    if (id <= 0) return apiFail("invalid channel id");
    const ch = await s.getChannel(id);
    if (!ch) return apiFail("record not found");
    try {
      return apiOk(await detectChannelUpstreamModelUpdates(s, ch));
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  });
  r.post("/api/channel/upstream_updates/detect_all", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const { task, created } = await enqueueSystemTask(s, SYSTEM_TASK_TYPE_MODEL_UPDATE, { manual: true });
    if (!created) {
      return json(409, {
        success: false,
        message: "已有模型更新任务正在运行或等待中，不能启动本次手动任务",
        data: {
          task_id: systemTaskIdOf(task),
          status: String(task.status || "pending"),
          type: String(task.type || SYSTEM_TASK_TYPE_MODEL_UPDATE),
        },
      });
    }
    return apiOk({ task_id: systemTaskIdOf(task), status: String(task.status || "pending") });
  });
  r.post("/api/channel/upstream_updates/apply", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    let body: { id?: number; add_models?: string[]; remove_models?: string[]; ignore_models?: string[] };
    try {
      body = (await readJson(c.req)) as typeof body;
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const id = Number(body.id || 0);
    if (id <= 0) return apiFail("invalid channel id");
    const ch = await s.getChannel(id);
    if (!ch) return apiFail("record not found");
    try {
      return apiOk(await applyChannelUpstreamModelUpdatesForId(s, ch, body.add_models, body.ignore_models, body.remove_models));
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  });
  r.post("/api/channel/upstream_updates/apply_all", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    try {
      return apiOk(await applyAllChannelUpstreamModelUpdates(s));
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  });

  r.post("/api/subscription/admin/plans/:id/subscriptions/reset", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const planId = strconvAtoi(c.params.id);
    if (!planId.ok || planId.n <= 0) return apiFail("无效的ID");
    const parsed = await readAdminResetSubscriptionBody(c.req);
    if (parsed instanceof Response) return parsed;
    return resetPlanSubscriptions(c, s, planId.n, undefined, parsed.advanceResetTime);
  });

  r.post("/api/subscription/admin/users/:id/subscriptions", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const userId = Number(c.params.id);
    const body = (await readJson(c.req)) as { plan_id?: number };
    if (userId <= 0 || !body.plan_id) return apiFail("参数错误");
    try {
      const result = await s.adminBindSubscription(userId, Number(body.plan_id));
      return apiOk(result.message ? { message: result.message } : null);
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  });

  r.post("/api/subscription/admin/users/:id/subscriptions/reset", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const userId = strconvAtoi(c.params.id);
    if (!userId.ok || userId.n <= 0) return apiFail("无效的用户ID");
    const parsed = await readAdminResetSubscriptionBody(c.req);
    if (parsed instanceof Response) return parsed;
    if (parsed.planId <= 0) return apiFail("参数错误");
    return resetPlanSubscriptions(c, s, parsed.planId, userId.n, parsed.advanceResetTime);
  });

  r.post("/api/subscription/epay/notify", (c) => handleSubscriptionEpayNotify(c));
  r.get("/api/subscription/epay/notify", (c) => handleSubscriptionEpayNotify(c));
  r.get("/api/subscription/epay/return", (c) => handleSubscriptionEpayReturn(c));
  r.post("/api/subscription/epay/return", (c) => handleSubscriptionEpayReturn(c));

  r.post("/api/option/payment_compliance", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.setOption("PaymentComplianceConfirmed", "true");
    return apiOk({ confirmed: true });
  });

  r.get("/api/option/channel_affinity_cache", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await channelAffinityCacheStats(s, c.env));
  });

  r.delete("/api/option/channel_affinity_cache", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const all = (c.url.searchParams.get("all") || "").trim();
    const ruleName = (c.url.searchParams.get("rule_name") || "").trim();
    if (all === "true") {
      return apiOk({ deleted: await clearAffinityCacheAll(s, c.env) });
    }
    if (!ruleName) {
      return json(400, { success: false, message: "缺少参数：rule_name，或使用 all=true 清空全部" });
    }
    try {
      return apiOk({ deleted: await clearAffinityCacheByRule(s, c.env, ruleName) });
    } catch (e) {
      return json(400, { success: false, message: (e as Error).message });
    }
  });

  r.get("/api/option/waffo-pancake/catalog", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(parseJson(await s.option("WaffoPancakeCatalog"), []));
  });
  r.post("/api/option/waffo-pancake/pair", async (c) => waffoSave(c, "pair"));
  r.post("/api/option/waffo-pancake/save", async (c) => waffoSave(c, "save"));
  r.post("/api/option/waffo-pancake/subscription-product", async (c) => waffoSave(c, "product"));
  r.get("/api/option/waffo-pancake/subscription-product-options", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(parseJson(await s.option("WaffoPancakeProducts"), []));
  });

  r.post("/api/custom-oauth-provider/discovery", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return fetchCustomOAuthDiscovery((await readJson(c.req)) as { well_known_url?: string; issuer_url?: string; url?: string });
  });

  r.get("/api/custom-oauth-provider/:id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const id = Number(c.params.id);
    if (!Number.isInteger(id)) return apiFail("无效的 ID");
    const p = await s.getOAuthProvider(id);
    if (!p) return apiFail("未找到该 OAuth 提供商");
    return apiOk(publicCustomOAuthProvider(p));
  });

  r.get("/api/performance/stats", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(performanceStats(await loadPerformanceSetting(s)));
  });
  r.delete("/api/performance/disk_cache", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(null, "不活跃的磁盘缓存已清理");
  });
  r.post("/api/performance/reset_stats", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    resetMetrics();
    return apiOk(null, "统计信息已重置");
  });
  r.post("/api/performance/gc", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(null, "GC 已执行");
  });
  r.get("/api/performance/logs", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk({
      log_dir: "",
      enabled: false,
      file_count: 0,
      total_size: 0,
      files: null,
    });
  });
  r.delete("/api/performance/logs", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const mode = c.url.searchParams.get("mode") || "";
    const value = Number(c.url.searchParams.get("value") || 0);
    if (mode !== "by_count" && mode !== "by_days") return apiFail("invalid mode, must be by_count or by_days");
    if (!Number.isInteger(value) || value < 1) return apiFail("invalid value, must be a positive integer");
    return apiFail("log directory not configured");
  });

  r.get("/api/ratio_sync/channels", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const channels = await s.allChannels();
    const data = channels
      .filter((ch) => ch.base_url)
      .map((ch) => ({ id: ch.id, name: ch.name, base_url: ch.base_url, status: ch.status, type: ch.type }));
    data.push({ id: -100, name: "官方倍率预设", base_url: "https://basellm.github.io", status: 1, type: 0 });
    data.push({ id: -101, name: "models.dev 价格预设", base_url: "https://models.dev", status: 1, type: 0 });
    return apiOk(data);
  });
  r.post("/api/ratio_sync/fetch", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    let raw: unknown;
    try {
      raw = await readJson(c.req);
    } catch {
      return json(400, { success: false, message: "请求参数格式错误" });
    }
    let req;
    try {
      req = validateFetchRequest(raw);
    } catch (err) {
      const status = Number((err as { status?: number }).status || 400);
      return json(status, { success: false, message: err instanceof Error ? err.message : "请求参数格式错误" });
    }
    const ids = [...(req.channel_ids || [])];
    if (req.channel_id) ids.push(req.channel_id);
    for (const ustr of req.upstreams || []) if (ustr.id) ids.push(Number(ustr.id));
    const channels = [];
    try {
      for (const id of ids) {
        const ch = await s.getChannel(Number(id));
        if (ch) channels.push(ch);
      }
    } catch {
      return json(500, { success: false, message: "查询渠道失败" });
    }
    const modelRatio = parseJson(await s.option("ModelRatio"), {});
    const modelPrice = parseJson(await s.option("ModelPrice"), {});
    const billing = billingCopies({
      billingMode: parseJson(await s.option("billing_setting.billing_mode"), {}),
      billingExpr: parseJson(await s.option("billing_setting.billing_expr"), {}),
      modelRatio,
      modelPrice,
    });
    const localData = {
      model_ratio: modelRatio,
      completion_ratio: parseJson(await s.option("CompletionRatio"), {}),
      cache_ratio: parseJson(await s.option("CacheRatio"), {}),
      create_cache_ratio: parseJson(await s.option("CreateCacheRatio"), {}),
      image_ratio: parseJson(await s.option("ImageRatio"), {}),
      audio_ratio: parseJson(await s.option("AudioRatio"), {}),
      audio_completion_ratio: parseJson(await s.option("AudioCompletionRatio"), {}),
      model_price: modelPrice,
      billing_mode: billing.billing_mode,
      billing_expr: billing.billing_expr,
    };
    const result = await fetchUpstreamRatios({ req, channels, localData });
    if (!result.ok) return json(result.status, { success: false, message: result.message });
    return apiOk(result.data);
  });

  r.get("/api/plugin/task", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await listTaskPluginListItems(s, await getTaskPluginListRuntime(s)));
  });
  r.post("/api/plugin/task", (c) => upsertPlugin(c));
  r.put("/api/plugin/task", (c) => upsertPlugin(c));
  r.get("/api/plugin/task/runtime/status", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await getTaskPluginRuntimeStatus(s));
  });
  r.get("/api/plugin/task/marketplace/sources", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const raw = await s.option("TaskPluginMarketplaceSources");
    const parsed = parseJson<{ name?: string; index_url?: string }[] | null>(raw, null);
    return apiOk(parsed && parsed.length ? parsed : DEFAULT_MARKETPLACE_SOURCES);
  });
  r.put("/api/plugin/task/marketplace/sources", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.setOption("TaskPluginMarketplaceSources", JSON.stringify(await readJson(c.req)));
    return apiOk(null);
  });
  r.get("/api/plugin/task/:key", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const version = c.url.searchParams.get("version") || "";
    const p = await s.getTaskPluginVersion(c.params.key, version);
    if (p) {
      let loaded!: ReturnType<typeof compilePlugin>;
      const compileErr = taskPluginCompileError(c, () => {
        loaded = compilePlugin(String(p.source || ""), { key: String(p.key || c.params.key), version: String(p.version || "") });
      });
      if (compileErr) return compileErr;
      return apiOk({
        plugin: publicTaskPluginRecord(p),
        meta: taskPluginMetaView(loaded.meta, {
          key: String(p.key || loaded.meta.key || ""),
          version: String(p.version || loaded.meta.version || ""),
          name: String(loaded.meta.name || ""),
        }),
        source: String(p.source || ""),
        layer: "override",
        has_icon: String(p.icon || "") !== "",
      });
    }
    if (version) return apiFail("record not found");
    const factorySource = factoryPluginSource(c.params.key);
    if (factorySource == null) return apiFail("task plugin not found");
    let factoryLoaded!: ReturnType<typeof compilePlugin>;
    const factoryCompileErr = taskPluginCompileError(c, () => {
      factoryLoaded = compilePlugin(factorySource, { key: c.params.key });
    });
    if (factoryCompileErr) return factoryCompileErr;
    return apiOk({
      meta: taskPluginMetaView(factoryLoaded.meta, {
        key: c.params.key,
        version: String(factoryLoaded.meta.version || ""),
        name: String(factoryLoaded.meta.name || ""),
      }),
      source: factorySource,
      layer: "factory",
      has_icon: factoryPluginHasIcon(c.params.key),
    });
  });
  r.get("/api/plugin/task/:key/icon", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getTaskPluginVersion(c.params.key, c.url.searchParams.get("version") || "");
    let icon = String(p?.icon || "");
    if (!icon && !c.url.searchParams.get("version")) {
      icon = factoryPluginIcon(c.params.key)?.dataUri || "";
    }
    if (!icon) return new Response(null, { status: 404 });
    let decoded: ReturnType<typeof decodeIconDataURI>;
    try {
      decoded = decodeIconDataURI(icon);
    } catch {
      return new Response(null, { status: 404 });
    }
    return new Response(decoded.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": decoded.mediaType,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });
  r.get("/api/plugin/task/:key/versions", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const versions = await s.listTaskPluginVersions(c.params.key);
    return apiOk(versions.map(publicTaskPluginRecord));
  });
  r.post("/api/plugin/task/:key/activate", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { version?: string };
    if (!body.version) return apiFail("Key: 'taskPluginActivateRequest.Version' Error:Field validation for 'Version' failed on the 'required' tag");
    const versions = await s.listTaskPluginVersions(c.params.key);
    const target = versions.find((row) => String(row.version) === body.version);
    if (!target) return apiFail("plugin version not found");
    const compileErr = taskPluginCompileError(c, () =>
      compilePlugin(String(target.source || ""), { key: String(target.key || c.params.key), version: String(target.version || body.version) }),
    );
    if (compileErr) return compileErr;
    const ok = await s.activateTaskPluginVersion(c.params.key, body.version);
    if (!ok) return apiFail("plugin version not found");
    const syncErr = await syncTaskPluginsAfterMutation(s);
    if (syncErr) return syncErr;
    return apiOk(null);
  });
  r.post("/api/plugin/task/:key/status", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") return apiFail("enabled is required");
    const key = c.params.key;
    let disabledChannels = 0;
    if (!body.enabled) {
      const usage = await s.taskPluginUsage(key);
      const cascade = c.url.searchParams.get("cascade") === "true";
      const force = c.url.searchParams.get("force") === "true";
      if ((usage.channels.length > 0 && !cascade) || (usage.in_flight_count > 0 && !force)) {
        return json(200, {
          success: false,
          message: "task plugin is still in use",
          data: { channels: usage.channels, in_flight_count: usage.in_flight_count },
        });
      }
      if (cascade) {
        for (const ch of usage.channels) {
          await s.updateChannel(ch.id, { status: CHANNEL_MANUAL_DISABLED });
          disabledChannels += 1;
        }
      }
    }
    const p = await s.getTaskPluginVersion(key, "");
    const factory = hasFactoryPlugin(key);
    if (factory) {
      const keys = await getTaskPluginDisabledFactoryKeys(s);
      const next = body.enabled ? keys.filter((item) => item !== key) : [...keys, key];
      await setTaskPluginDisabledFactoryKeys(s, next);
      if (!p) return apiOk({ plugin_enabled: body.enabled, disabled_channels: disabledChannels });
    }
    try {
      await s.setTaskPluginEnabled(key, body.enabled);
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const syncErr = await syncTaskPluginsAfterMutation(s);
    if (syncErr) return syncErr;
    return apiOk({ plugin_enabled: body.enabled, disabled_channels: disabledChannels });
  });
  r.post("/api/plugin/task/:key/dryrun", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const raw = await c.req.text();
    const parsed = goUnmarshalJSON(raw || "{}");
    if (!parsed.ok) return apiFail(parsed.message);
    if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return apiFail(`json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type controller.taskPluginDryRunRequest`);
    }
    const body = parsed.value as { hook?: string; member?: string; args?: unknown[] };
    if (!body.hook) {
      return apiFail("Key: 'taskPluginDryRunRequest.Hook' Error:Field validation for 'Hook' failed on the 'required' tag");
    }
    if (body.args != null && !Array.isArray(body.args)) {
      return apiFail(`json: cannot unmarshal ${goJSONKind(body.args)} into Go value of type []json.RawMessage`);
    }
    const resolved = await resolveTaskPluginSource(s, c.params.key);
    if (!resolved) return apiFail("task plugin not found");
    const result = dryRunPlugin(resolved.source, { hook: body.hook, member: body.member, args: body.args }, { key: c.params.key });
    if (!result.ok) return apiFail(result.message);
    return apiOk(result.data);
  });
  r.delete("/api/plugin/task/:key/versions/:version", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const key = c.params.key;
    const version = c.params.version;
    const target = await s.getTaskPluginVersion(key, version);
    if (!target) return apiFail("override plugin version not found; factory plugins cannot be deleted");
    if (Number(target.active) && !hasFactoryPlugin(key) && c.url.searchParams.get("force") !== "true") {
      const usage = await s.taskPluginUsage(key);
      if (usage.channels.length > 0 || usage.in_flight_count > 0) {
        return json(200, {
          success: false,
          message: "task plugin is still in use",
          data: { channels: usage.channels, in_flight_count: usage.in_flight_count },
        });
      }
    }
    await s.deleteTaskPluginVersion(key, version);
    const syncErr = await syncTaskPluginsAfterMutation(s);
    if (syncErr) return syncErr;
    return apiOk(null);
  });
  r.get("/api/task_plugin_options", async (c) => {
    const s = store(c);
    const u = await requirePermission(c, s, "task_plugin", "bind");
    if (isResponse(u)) return u;
    return apiOk(await listTaskPluginOptions(s));
  });

  r.get("/api/log/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return json(200, { success: false, message: "该接口已废弃" });
  });
  r.get("/api/log/self/search", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return json(200, { success: false, message: "该接口已废弃" });
  });
  r.get("/api/log/channel_affinity_usage_cache", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const ruleName = (c.url.searchParams.get("rule_name") || "").trim();
    const usingGroup = (c.url.searchParams.get("using_group") || "").trim();
    const keyFp = (c.url.searchParams.get("key_fp") || "").trim();
    if (!ruleName) return json(400, { success: false, message: "missing param: rule_name" });
    if (!keyFp) return json(400, { success: false, message: "missing param: key_fp" });
    return apiOk(await getChannelAffinityUsageCacheStats(s, c.env, ruleName, usingGroup, keyFp));
  });

  r.post("/api/system-task/log-cleanup", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const targetTimestamp = Number(c.url.searchParams.get("target_timestamp") || 0);
    if (!targetTimestamp) return apiFail("target timestamp is required");
    try {
      const task = await startLogCleanupTask(s, targetTimestamp);
      c.waitUntil(lazySystemTaskRun(() => runPendingLogCleanupSystemTask(s).catch(() => undefined)));
      return apiOk(publicSystemTask(task, Number(task.rowid || 0)));
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  });
  r.get("/api/system-task/list", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const limit = Number(c.url.searchParams.get("limit") || 20);
    const items = await s.listSystemTasks(limit);
    return apiOk(items.map((t) => publicSystemTask(t, Number(t.rowid || 0))));
  });
  r.get("/api/system-task/current", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const taskType = c.url.searchParams.get("type") || "";
    if (!taskType) return apiFail("type is required");
    const t = await s.currentSystemTask(taskType);
    return apiOk(t ? publicSystemTask(t, Number(t.rowid || 0)) : null);
  });
  r.get("/api/system-task/:task_id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    if (!c.params.task_id) return apiFail("task id is required");
    const t = await s.getSystemTask(c.params.task_id);
    if (!t) return json(404, { success: false, message: "task not found" });
    return apiOk(publicSystemTask(t, Number(t.rowid || 0)));
  });

  r.get("/api/system-info/instances", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await listSystemInstanceResponses(s, c.env));
  });
  r.delete("/api/system-info/stale-instances", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const deletedCount = await s.deleteStaleSystemInstances(nowSec(), SYSTEM_INSTANCE_STALE_AFTER_SECONDS);
    return apiOk({ deleted_count: deletedCount });
  });
  r.delete("/api/system-info/instances/:node_name", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const nodeName = String(c.params.node_name || "").trim();
    if (!nodeName) return apiFail("node name is required");
    const deleted = await s.deleteStaleSystemInstance(nodeName, nowSec(), SYSTEM_INSTANCE_STALE_AFTER_SECONDS);
    if (!deleted) return apiFail("instance is not stale or no longer exists");
    return apiOk({ deleted_count: 1 });
  });

  r.get("/api/data/users", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const start = parseUnixQuery(c.url, "start_timestamp");
    const end = parseUnixQuery(c.url, "end_timestamp");
    return apiOk((await s.quotaDatesByUser(start, end)).map((row) => publicQuotaData(row as Record<string, unknown>)));
  });
  r.get("/api/data/flow", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const start = parseUnixQuery(c.url, "start_timestamp");
    const end = parseUnixQuery(c.url, "end_timestamp");
    if (start <= 0) return apiFail("invalid start_timestamp");
    if (end <= 0) return apiFail("invalid end_timestamp");
    if (end < start) return apiFail("invalid time range");
    return apiOk(
      (await s.flowQuotaDates(start, end, 0, c.url.searchParams.get("username") || "", u.role)).map(publicFlowQuotaData),
    );
  });
  r.get("/api/data/flow/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const start = parseUnixQuery(c.url, "start_timestamp");
    const end = parseUnixQuery(c.url, "end_timestamp");
    if (start <= 0) return apiFail("invalid start_timestamp");
    if (end <= 0) return apiFail("invalid end_timestamp");
    if (end < start) return apiFail("invalid time range");
    if (end - start > 2592000) return apiFail("时间跨度不能超过 1 个月");
    return apiOk((await s.flowQuotaDates(start, end, u.id, "", ROLE_USER)).map(publicFlowQuotaData));
  });

  r.get("/api/task/:task_id/artifacts", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const task = await s.getTaskByTid(c.params.task_id);
    if (!task) return taskArtifactError(404, "artifact_not_found", "Task or artifact not found", true);
    if (Number(task.user_id) !== u.id && u.role < 10) return taskArtifactError(404, "artifact_not_found", "Task or artifact not found", true);
    try {
      return apiOk(await taskArtifactsView(s, task));
    } catch {
      return taskArtifactError(500, "artifact_url_error", "Failed to build artifact content URL", true);
    }
  });

  r.post("/api/vendors/operations/preview", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    try {
      return apiOk(await vendorOperationPreview(s, (await readJson(c.req)) as VendorOp));
    } catch (e) {
      return vendorOpError(e);
    }
  });
  r.post("/api/vendors/operations", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as VendorOp;
    try {
      if (!body.expected_version) {
        return json(409, { success: false, message: "vendor data changed; preview again before applying", code: "VENDOR_CONFLICT" });
      }
      const preview = await vendorOperationPreview(s, body);
      if (preview.version !== body.expected_version) {
        return json(409, { success: false, message: "vendor data changed; preview again before applying", code: "VENDOR_CONFLICT" });
      }
      const updated_models: number[] = [];
      const deleted_vendors: number[] = [];
      const targetId = Number(body.target_vendor_id || 0);
      for (const m of preview.models as { id: number; vendor_id: number }[]) {
        if (body.action !== "delete" && m.vendor_id !== targetId) {
          await s.updateModelMeta(m.id, { vendor_id: targetId, updated_time: nowSec() });
          updated_models.push(m.id);
        }
      }
      if (body.action === "merge" || body.action === "delete") {
        for (const v of preview.sources as { id: number }[]) {
          await s.deleteVendor(v.id);
          deleted_vendors.push(v.id);
        }
      }
      return apiOk({ updated_models, deleted_vendors });
    } catch (e) {
      return vendorOpError(e);
    }
  });

  r.get("/api/models/", async (c) => serveModelsMeta(c, "", ""));
  r.get("/api/models/search", async (c) =>
    serveModelsMeta(c, c.url.searchParams.get("keyword") || "", c.url.searchParams.get("vendor") || ""),
  );
  r.get("/api/models/missing", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.getMissingModels());
  });
  r.get("/api/models/sync_upstream/preview", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    try {
      return apiOk(await previewMetadataSync(s, c.url.searchParams.get("locale") || ""));
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });
  r.post("/api/models/sync_upstream", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { locale?: string; source_version?: string; selections?: { model_name: string; record_version: string; create?: boolean; fields?: string[] }[] };
    try {
      return apiOk(await applyMetadataSync(s, body));
    } catch (e) {
      const status = Number((e as { status?: number }).status || 200);
      const message = e instanceof Error ? e.message : String(e);
      return json(status >= 400 ? status : 200, { success: false, message });
    }
  });
  r.post("/api/models/delete", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    let body: { model_ids?: number[]; ids?: number[]; remove_from_channels?: boolean; remove_pricing?: boolean };
    try {
      body = (await readJson(c.req)) as { model_ids?: number[]; ids?: number[]; remove_from_channels?: boolean; remove_pricing?: boolean };
    } catch {
      return apiFail("无效的参数");
    }
    if (body.remove_pricing && u.role !== ROLE_ROOT) {
      return json(403, { success: false, message: "Model pricing is managed by a super administrator." });
    }
    try {
      const result = await s.deleteModelMetadata(body.model_ids || body.ids || [], Boolean(body.remove_from_channels), Boolean(body.remove_pricing));
      await s.audit(u.id, u.username, "model.delete_batch", `delete models`, clientIp(c.req), {
        action: "model.delete_batch",
        actor_role: u.role,
        method: "POST",
        route: "/api/models/delete",
        other: JSON.stringify({
          model_ids: body.model_ids || body.ids || [],
          remove_from_channels: Boolean(body.remove_from_channels),
          remove_pricing: Boolean(body.remove_pricing),
          updated_channels: result.updated_channels,
        }),
      });
      return apiOk(result);
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });
  r.get("/api/models/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = strconvAtoi(c.params.id);
    if (!id.ok) return apiFail(id.message);
    const item = await s.getModelMeta(id.n);
    if (!item) return apiFail("record not found");
    const [enriched] = await enrichModelMeta(s, [item]);
    return apiOk(enriched);
  });

  r.get("/api/deployments/settings", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await ionetSettings(s));
  });
  r.post("/api/deployments/settings/test-connection", (c) => testIoNet(c));
  r.post("/api/deployments/test-connection", (c) => testIoNet(c));
  r.get("/api/deployments/", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const q = pageQuery(c.url);
    const status = (c.url.searchParams.get("status") || "").toLowerCase().trim();
    const params = new URLSearchParams({
      page: String(q.page),
      page_size: String(q.page_size),
      sort_by: "created_at",
      sort_order: "desc",
    });
    if (status) params.set("status", status);
    const fetched = await ionetRequest(key, "GET", `/deployments?${params.toString()}`);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to list deployments", fetched.message));
    const raw = (fetched.json || {}) as { deployments?: Record<string, unknown>[]; total?: number };
    const deployments = raw.deployments || [];
    const items = deployments.map(mapIoNetDeployment);
    const total = Number(raw.total || 0);
    return apiOk({
      page: q.page,
      page_size: q.page_size,
      total,
      items,
      status_counts: computeStatusCounts(total, deployments),
    });
  });
  r.get("/api/deployments/search", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const q = pageQuery(c.url);
    const status = (c.url.searchParams.get("status") || "").toLowerCase().trim();
    const keyword = (c.url.searchParams.get("keyword") || "").trim();
    const params = new URLSearchParams({
      page: String(q.page),
      page_size: String(q.page_size),
      sort_by: "created_at",
      sort_order: "desc",
    });
    if (status) params.set("status", status);
    const fetched = await ionetRequest(key, "GET", `/deployments?${params.toString()}`);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to list deployments", fetched.message));
    const raw = (fetched.json || {}) as { deployments?: Record<string, unknown>[]; total?: number };
    let deployments = raw.deployments || [];
    if (keyword) {
      const kw = keyword.toLowerCase();
      deployments = deployments.filter((d) => String(d.name || "").toLowerCase().includes(kw));
    }
    const items = deployments.map(mapIoNetDeployment);
    const total = keyword ? items.length : Number(raw.total || 0);
    return apiOk({
      page: q.page,
      page_size: q.page_size,
      total,
      items,
    });
  });
  r.get("/api/deployments/hardware-types", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", "/hardware/max-gpus-per-container");
    if (!fetched.ok) return apiFail(ionetWrapError("failed to list hardware types", ionetWrapError("failed to get max GPUs per container", fetched.message)));
    return apiOk(mapIoNetHardwareTypes((fetched.json || {}) as { hardware?: Record<string, unknown>[]; total?: number }));
  });
  r.get("/api/deployments/locations", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", "/locations", undefined, false);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to list locations", fetched.message));
    return apiOk(mapIoNetLocations((fetched.json || {}) as { locations?: Record<string, unknown>[]; total?: number }));
  });
  r.get("/api/deployments/available-replicas", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const hardwareIdStr = c.url.searchParams.get("hardware_id") || "";
    if (!hardwareIdStr) return apiFail("hardware_id parameter is required");
    const hardwareId = Number.parseInt(hardwareIdStr, 10);
    if (!Number.isFinite(hardwareId) || hardwareId <= 0) return apiFail("invalid hardware_id parameter");
    let gpuCount = 1;
    const gpuCountStr = c.url.searchParams.get("gpu_count") || "";
    if (gpuCountStr) {
      const parsed = Number.parseInt(gpuCountStr, 10);
      if (Number.isFinite(parsed) && parsed > 0) gpuCount = parsed;
    }
    const fetched = await ionetRequest(key, "GET", `/available-replicas?hardware_id=${hardwareId}&hardware_qty=${gpuCount}`);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to get available replicas", fetched.message));
    return apiOk(mapIoNetAvailableReplicas(fetched.json, hardwareId, gpuCount));
  });
  r.post("/api/deployments/price-estimation", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    let body: Record<string, unknown>;
    try {
      body = (await readJson(c.req)) as Record<string, unknown>;
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const validated = validatePriceEstimationRequest(body);
    if (!validated.ok) return apiFail(validated.message);
    const fetched = await ionetRequest(key, "GET", `/price${validated.query}`);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to get price estimation", fetched.message));
    return apiOk(
      mapIoNetPriceEstimation(
        (fetched.json || {}) as Record<string, unknown>,
        priceEstimationCurrency(body),
        priceEstimationDurationHours(body),
      ),
    );
  });
  r.get("/api/deployments/check-name", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const clusterName = (c.url.searchParams.get("name") || "").trim();
    if (!clusterName) return apiFail("name parameter is required");
    const fetched = await ionetRequest(
      key,
      "GET",
      `/clusters/check_cluster_name_availability?cluster_name=${encodeURIComponent(clusterName)}`,
      undefined,
      { unwrapData: false },
    );
    if (!fetched.ok) return apiFail(ionetWrapError("failed to check cluster name availability", fetched.message));
    return apiOk({ available: fetched.json === true, name: clusterName });
  });
  r.post("/api/deployments/", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    let body: Record<string, unknown>;
    try {
      body = (await readJson(c.req)) as Record<string, unknown>;
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const invalid = validateDeployRequest(body);
    if (invalid) return apiFail(ionetWrapError("failed to deploy container", invalid));
    const fetched = await ionetRequest(key, "POST", "/deploy", body, { unwrapData: false });
    if (!fetched.ok) return apiFail(ionetWrapError("failed to deploy container", fetched.message));
    const resp = (fetched.json || {}) as { deployment_id?: string; status?: string };
    return apiOk({
      deployment_id: String(resp.deployment_id || ""),
      status: String(resp.status || ""),
      message: "Deployment created successfully",
    });
  });
  r.get("/api/deployments/:id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    const fetched = await ionetRequest(key, "GET", `/deployment/${encodeURIComponent(deploymentId)}`);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to get deployment details", fetched.message));
    return apiOk(mapIoNetDeploymentDetail((fetched.json || {}) as Record<string, unknown>));
  });
  r.get("/api/deployments/:id/logs", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    const path = logsEndpoint(deploymentId, c.url);
    if (!path.ok) return apiFail(path.message);
    const fetched = await ionetRequest(key, "GET", path.path, undefined, { enterprise: false, unwrapData: false, rawText: true });
    if (!fetched.ok) return apiFail(ionetWrapError("failed to get container logs", fetched.message));
    return apiOk(fetched.text);
  });
  r.get("/api/deployments/:id/containers", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    const fetched = await ionetRequest(key, "GET", `/deployment/${encodeURIComponent(deploymentId)}/containers`);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to list containers", fetched.message));
    return apiOk(mapIoNetContainerList((fetched.json || {}) as Record<string, unknown>));
  });
  r.get("/api/deployments/:id/containers/:container_id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    const containerId = c.params.container_id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    if (!containerId) return apiFail("container ID is required");
    const fetched = await ionetRequest(
      key,
      "GET",
      `/deployment/${encodeURIComponent(deploymentId)}/container/${encodeURIComponent(containerId)}`,
      undefined,
      { unwrapData: false },
    );
    if (!fetched.ok) return apiFail(ionetWrapError("failed to get container details", fetched.message));
    if (fetched.json == null || typeof fetched.json !== "object") return apiFail("container details not found");
    return apiOk(mapIoNetContainerDetails(deploymentId, fetched.json as Record<string, unknown>));
  });
  r.put("/api/deployments/:id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    let body: Record<string, unknown>;
    try {
      body = (await readJson(c.req)) as Record<string, unknown>;
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const fetched = await ionetRequest(key, "PATCH", `/deployment/${encodeURIComponent(deploymentId)}`, body, { unwrapData: false });
    if (!fetched.ok) return apiFail(ionetWrapError("failed to update deployment", fetched.message));
    const resp = (fetched.json || {}) as { status?: string; deployment_id?: string };
    return apiOk({ status: String(resp.status || ""), deployment_id: String(resp.deployment_id || "") });
  });
  r.put("/api/deployments/:id/name", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    let body: { name?: string };
    try {
      body = (await readJson(c.req)) as { name?: string };
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    const name = String(body.name ?? "").trim();
    if (!Object.prototype.hasOwnProperty.call(body, "name") || body.name == null || String(body.name) === "") {
      return apiFail("Key: 'Name' Error:Field validation for 'Name' failed on the 'required' tag");
    }
    if (!name) return apiFail("deployment name cannot be empty");
    const available = await ionetRequest(
      key,
      "GET",
      `/clusters/check_cluster_name_availability?cluster_name=${encodeURIComponent(name)}`,
      undefined,
      { unwrapData: false },
    );
    if (!available.ok) return apiFail(ionetWrapError("failed to check name availability", ionetWrapError("failed to check cluster name availability", available.message)));
    if (available.json !== true) return apiFail("deployment name is not available, please choose a different name");
    const fetched = await ionetRequest(
      key,
      "PUT",
      `/clusters/${encodeURIComponent(deploymentId)}/update-name`,
      { cluster_name: name },
      { unwrapData: false },
    );
    if (!fetched.ok) return apiFail(ionetWrapError("failed to update cluster name", fetched.message));
    const resp = (fetched.json || {}) as { status?: string; message?: string };
    return apiOk({
      status: String(resp.status || ""),
      message: String(resp.message || ""),
      id: deploymentId,
      name,
    });
  });
  r.post("/api/deployments/:id/extend", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    let body: { duration_hours?: number };
    try {
      body = (await readJson(c.req)) as { duration_hours?: number };
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
    if (Number(body.duration_hours || 0) < 1) return apiFail(ionetWrapError("failed to extend deployment", "duration_hours must be at least 1"));
    const fetched = await ionetRequest(key, "POST", `/deployment/${encodeURIComponent(deploymentId)}/extend`, body);
    if (!fetched.ok) return apiFail(ionetWrapError("failed to extend deployment", fetched.message));
    return apiOk(mapIoNetExtendedDeployment(deploymentId, (fetched.json || {}) as Record<string, unknown>));
  });
  r.delete("/api/deployments/:id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const deploymentId = c.params.id.trim();
    if (!deploymentId) return apiFail("deployment ID is required");
    const fetched = await ionetRequest(key, "DELETE", `/deployment/${encodeURIComponent(deploymentId)}`, undefined, { unwrapData: false });
    if (!fetched.ok) return apiFail(ionetWrapError("failed to delete deployment", fetched.message));
    const resp = (fetched.json || {}) as { status?: string; deployment_id?: string };
    return apiOk({
      status: String(resp.status || ""),
      deployment_id: String(resp.deployment_id || ""),
      message: "Deployment termination requested successfully",
    });
  });

  r.get("/api/user/topup/info", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(await topupInfo(s));
  });

  r.post("/api/user/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, u, (await readJson(c.req)) as { amount?: number }, "epay");
  });
  r.post("/api/user/pay", async (c) => payUser(c, "epay"));
  r.post("/api/user/stripe/pay", async (c) => payUser(c, "stripe"));
  r.post("/api/user/stripe/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, u, (await readJson(c.req)) as { amount?: number }, "stripe");
  });
  r.post("/api/user/creem/pay", async (c) => payUser(c, "creem"));
  r.post("/api/user/waffo/pay", async (c) => payUser(c, "waffo"));
  r.post("/api/user/waffo/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, u, (await readJson(c.req)) as { amount?: number }, "waffo");
  });
  r.post("/api/user/waffo-pancake/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, u, (await readJson(c.req)) as { amount?: number }, "waffo_pancake");
  });
  r.post("/api/user/waffo-pancake/pay", async (c) => payUser(c, "waffo_pancake"));
  r.post("/api/user/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/user/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.post("/api/stripe/webhook", (c) => handleStripeWebhook(store(c), c.req));
  r.post("/api/creem/webhook", (c) => handleCreemWebhook(store(c), c.req));
  r.post("/api/waffo/webhook", (c) => handleWaffoWebhook(store(c), c.req));
  r.post("/api/waffo-pancake/webhook/:env", (c) => handleWaffoPancakeWebhook(store(c), c.req, c.params.env, c.env));

  r.post("/api/subscription/epay/pay", (c) => requestSubscriptionEpay(c));
  r.post("/api/subscription/stripe/pay", (c) => requestSubscriptionStripePay(c));
  r.post("/api/subscription/creem/pay", (c) => requestSubscriptionCreemPay(c));
  r.post("/api/subscription/waffo-pancake/pay", (c) => requestSubscriptionWaffoPancakePay(c));

  r.get("/api/perf-metrics", async (c) => {
    const s = store(c);
    const gate = await headerNavModulePublicOrUserAuth(c, s, "pricing");
    if (isHeaderNavDenied(gate)) return gate;
    const model = c.url.searchParams.get("model");
    if (!model) return json(400, { success: false, message: "model is required" });
    const hours = Number(c.url.searchParams.get("hours") || 24);
    return json(200, { success: true, data: await queryPerfMetrics(s, model, c.url.searchParams.get("group") || "", hours) });
  });
  r.get("/api/perf-metrics/summary", async (c) => {
    const s = store(c);
    const gate = await headerNavModulePublicOrUserAuth(c, s, "pricing");
    if (isHeaderNavDenied(gate)) return gate;
    const hours = Number(c.url.searchParams.get("hours") || 24);
    return json(200, { success: true, data: await queryPerfMetricsSummary(s, hours) });
  });

  r.get("/api/uptime/status", async (c) => {
    const s = store(c);
    const raw = (await s.option("console_setting.uptime_kuma_groups")) || (await s.option("UptimeKumaGroups"));
    const groups = parseJson<{ url?: string; slug?: string; categoryName?: string }[]>(raw, []);
    if (!groups.length) return apiOk([]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const out = await Promise.all(groups.map((g) => fetchUptimeGroup(g, controller.signal)));
      return apiOk(out);
    } finally {
      clearTimeout(timer);
    }
  });

  void authenticateApiToken;
  void currentSid;
  void sessionViews;
  void verifyTelegramLogin;
}

async function fetchUptimeGroup(
  group: { url?: string; slug?: string; categoryName?: string },
  signal: AbortSignal,
): Promise<{ categoryName: string; monitors: { name: string; uptime: number; status: number; group?: string }[] }> {
  const result = { categoryName: group.categoryName || "", monitors: [] as { name: string; uptime: number; status: number; group?: string }[] };
  if (!group.url || !group.slug) return result;
  const base = group.url.replace(/\/$/, "");
  const timeout = AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : signal;
  try {
    const [statusRes, heartbeatRes] = await Promise.all([
      fetch(`${base}/api/status-page/${group.slug}`, { signal: timeout }),
      fetch(`${base}/api/status-page/heartbeat/${group.slug}`, { signal: timeout }),
    ]);
    if (!statusRes.ok || !heartbeatRes.ok) return result;
    const statusData = (await statusRes.json()) as {
      publicGroupList?: { id?: number; name?: string; monitorList?: { id?: number; name?: string }[] }[];
    };
    const heartbeatData = (await heartbeatRes.json()) as {
      heartbeatList?: Record<string, { status?: number }[]>;
      uptimeList?: Record<string, number>;
    };
    for (const pg of statusData.publicGroupList || []) {
      for (const m of pg.monitorList || []) {
        const monitor: { name: string; uptime: number; status: number; group?: string } = {
          name: String(m.name || ""),
          uptime: 0,
          status: 0,
        };
        if (pg.name) monitor.group = pg.name;
        const id = String(m.id ?? "");
        const uptime = heartbeatData.uptimeList?.[id + "_24"];
        if (uptime != null) monitor.uptime = Number(uptime);
        const beats = heartbeatData.heartbeatList?.[id];
        if (beats?.length) monitor.status = Number(beats[0].status || 0);
        result.monitors.push(monitor);
      }
    }
  } catch {
    return result;
  }
  return result;
}

async function ollamaOp(c: C, action: "pull" | "stream" | "delete"): Promise<Response> {
  const s = store(c);
  const u = await requireChannel(c, s, "sensitive_write");
  if (isResponse(u)) return u;
  let body: { channel_id?: unknown; model_name?: unknown };
  try {
    const text = await c.req.text();
    if (!text) return json(400, { success: false, message: "Invalid request parameters" });
    body = JSON.parse(text) as typeof body;
  } catch {
    return json(400, { success: false, message: "Invalid request parameters" });
  }
  if (
    (body.channel_id != null && (typeof body.channel_id !== "number" || !Number.isInteger(body.channel_id))) ||
    (body.model_name != null && typeof body.model_name !== "string")
  ) {
    return json(400, { success: false, message: "Invalid request parameters" });
  }
  const channelId = typeof body.channel_id === "number" ? body.channel_id : 0;
  const modelName = typeof body.model_name === "string" ? body.model_name : "";
  if (!channelId || !modelName) return json(400, { success: false, message: "Channel ID and model name are required" });
  const ch = await s.getChannel(channelId);
  if (!ch) return json(404, { success: false, message: "Channel not found" });
  if (ch.type !== CHANNEL_TYPE_OLLAMA) {
    return json(400, { success: false, message: "This operation is only supported for Ollama channels" });
  }
  const base = ollamaChannelBaseURL(ch);
  const key = ollamaFirstKey(ch);
  if (action === "stream") return ollamaPullStreamResponse(base, key, modelName);
  try {
    if (action === "pull") await pullOllamaModel(base, key, modelName);
    else await deleteOllamaModel(base, key, modelName);
    return json(200, {
      success: true,
      message: action === "pull" ? `Model ${modelName} pulled successfully` : `Model ${modelName} deleted successfully`,
    });
  } catch (err) {
    const wrapped = action === "pull" ? "Failed to pull model" : "Failed to delete model";
    return json(500, { success: false, message: `${wrapped}: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function ollamaSseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  };
}

function ollamaPullStreamResponse(base: string, key: string, modelName: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        for await (const event of pullOllamaModelStream(base, key, modelName)) {
          if (event.type === "progress") send(event.progress);
          else if (event.type === "error") send({ error: event.error });
          else send({ message: `Model ${modelName} pulled successfully` });
        }
      } catch (err) {
        send({ error: err instanceof Error ? err.message : String(err) });
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: ollamaSseHeaders() });
}

function isJsonValue(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function publicTaskPlugin(store: Store, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = String(row.key || "");
  const extracted = extractPluginMeta(String(row.source || ""));
  const manifest = parseJson<Record<string, unknown>>(String(row.manifest || "{}"), {});
  const enabled = row.enabled != null ? Boolean(Number(row.enabled) || row.enabled === true) : String(row.status || "") === "active";
  const active = row.active != null ? Boolean(Number(row.active) || row.active === true) : enabled;
  const usage = await store.taskPluginUsage(key);
  return {
    meta: taskPluginMetaView({ ...manifest, ...extracted }, { key, version: String(row.version || ""), name: String(row.name || "") }),
    source: "override",
    enabled,
    active,
    source_hash: String(row.source_hash || ""),
    has_icon: Boolean(row.icon),
    remark: String(row.remark || ""),
    runtime_status: enabled ? "registered" : "disabled",
    channel_count: usage.channel_count,
    in_flight_count: usage.in_flight_count,
  };
}

async function syncTaskPluginsAfterMutation(s: Store): Promise<Response | undefined> {
  try {
    await syncTaskPluginsOnce(s);
  } catch (err) {
    return apiFail(err instanceof Error ? err.message : String(err));
  }
}

function taskPluginCompileError(c: C, run: () => unknown): Response | undefined {
  try {
    run();
    return undefined;
  } catch (err) {
    if (err instanceof UnknownMetaFieldError) return apiFail(taskPluginUnknownMetaFieldMessage(c.req, err.field));
    return apiFail(err instanceof Error ? err.message : String(err));
  }
}

async function upsertPlugin(c: C): Promise<Response> {
  const s = store(c);
  const u = await requireRoot(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req)) as Record<string, unknown> & {
    source?: string;
    sourceSha256?: string;
    enabled?: boolean;
    remark?: string;
    icon?: string;
    force?: boolean;
  };
  const source = String(body.source || "");
  if (!source) return apiFail("Key: 'taskPluginUploadRequest.Source' Error:Field validation for 'Source' failed on the 'required' tag");
  if (new TextEncoder().encode(source).length > 1024 * 1024) return apiFail("plugin source exceeds 1 MiB");
  const sourceHash = bytesToHex(await sha256Bytes(source));
  const expected = String(body.sourceSha256 || "").trim();
  if (expected && expected.toLowerCase() !== sourceHash.toLowerCase()) return apiFail("plugin source sha256 mismatch");
  let loaded!: ReturnType<typeof compilePlugin>;
  const compileErr = taskPluginCompileError(c, () => {
    loaded = compilePlugin(source);
  });
  if (compileErr) return compileErr;
  try {
    validateV1Meta(loaded.meta);
  } catch (err) {
    return apiFail(err instanceof Error ? err.message : String(err));
  }
  const icon = String(body.icon || "").trim();
  if (icon) {
    try {
      decodeIconDataURI(icon);
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  }
  const enabled = body.enabled == null ? true : Boolean(body.enabled);
  const force = Boolean(body.force);
  if (enabled && !force) {
    try {
      const current = await currentRoutingGeneration(s);
      preflightRoutingConflict(current, routingMetaFromRecord(loaded.meta));
    } catch (err) {
      return apiFail(err instanceof Error ? err.message : String(err));
    }
  }
  const meta = taskPluginMetaView(loaded.meta, {
    key: String(loaded.meta.key || ""),
    version: String(loaded.meta.version || ""),
    name: String(loaded.meta.name || ""),
  });
  const key = String(meta.key || "");
  try {
    const saved = await s.saveTaskPluginVersion({
      key,
      version: String(meta.version),
      api_version: Number(meta.apiVersion || 1),
      source,
      source_hash: sourceHash,
      icon,
      enabled: enabled ? 1 : 0,
      remark: String(body.remark || ""),
      name: String(meta.name),
      manifest: meta,
    });
    const existing = await s.getTaskPlugin(key);
    await s.upsertTaskPlugin({
      key,
      name: meta.name,
      version: meta.version,
      status: enabled ? "active" : "inactive",
      active_version: saved.active ? meta.version : String(existing?.active_version || existing?.version || meta.version),
      icon,
      manifest: meta,
      routes: meta.routes,
      source,
      source_hash: sourceHash,
      remark: body.remark || "",
      enabled: enabled ? 1 : 0,
      active: saved.active ? 1 : 0,
      api_version: meta.apiVersion,
    });
    const syncErr = await syncTaskPluginsAfterMutation(s);
    if (syncErr) return syncErr;
    return apiOk({
      plugin: publicTaskPluginRecord(saved),
      meta,
      source,
      layer: "override",
      has_icon: Boolean(icon),
    });
  } catch (e) {
    return apiFail(e instanceof Error ? e.message : String(e));
  }
}

async function waffoSave(c: C, kind: string): Promise<Response> {
  const s = store(c);
  const u = await requireRoot(c, s);
  if (isResponse(u)) return u;
  const body = await readJson(c.req);
  const key = kind === "product" ? "WaffoPancakeProducts" : "WaffoPancakeCatalog";
  const cur = parseJson<unknown[]>(await s.option(key), []);
  cur.push(body);
  await s.setOption(key, JSON.stringify(cur));
  return apiOk(body);
}

async function requireIoNetKey(c: C): Promise<string | Response> {
  const s = store(c);
  const u = await requireAdmin(c, s);
  if (isResponse(u)) return u;
  const key = await ionetApiKey(s);
  if (!key) return apiFail(IONET_NOT_CONFIGURED);
  return key;
}

async function testIoNet(c: C): Promise<Response> {
  const s = store(c);
  const u = await requireAdmin(c, s);
  if (isResponse(u)) return u;
  const raw = await c.req.text();
  let body: { api_key?: string } = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as { api_key?: string };
    } catch {
      return apiFail("invalid request payload");
    }
  }
  const key = String(body.api_key || (await s.option("model_deployment.ionet.api_key")) || (await s.option("IoNetApiKey"))).trim();
  if (!key) return apiFail("api_key is required");
  const fetched = await ionetRequest(key, "GET", "/hardware/max-gpus-per-container");
  if (!fetched.ok) return apiFail(fetched.message);
  return apiOk(testIoNetTotals((fetched.json || {}) as { hardware?: { available?: number }[]; total?: number }));
}

async function readAdminResetSubscriptionBody(
  req: Request,
): Promise<{ planId: number; advanceResetTime: boolean } | Response> {
  let body: { plan_id?: unknown; advance_reset_time?: unknown };
  try {
    const text = await req.text();
    if (!text) return apiFail("参数错误");
    body = JSON.parse(text) as typeof body;
  } catch {
    return apiFail("参数错误");
  }
  if (body.advance_reset_time != null && typeof body.advance_reset_time !== "boolean") return apiFail("参数错误");
  if (body.plan_id != null && (typeof body.plan_id !== "number" || !Number.isInteger(body.plan_id))) {
    return apiFail("参数错误");
  }
  return {
    planId: typeof body.plan_id === "number" ? body.plan_id : 0,
    advanceResetTime: body.advance_reset_time == null ? true : body.advance_reset_time,
  };
}

async function resetPlanSubscriptions(
  c: C,
  s: Store,
  planId: number,
  userId: number | undefined,
  advanceResetTime: boolean,
): Promise<Response> {
  const plan = await s.getPlan(planId);
  if (!plan) return apiFail("record not found");
  const published = publicPlan(plan);
  const now = nowSec();
  const rows = await s.listActiveUserSubs(userId, planId);
  if (userId && !rows.length) return apiFail("该用户没有有效的此套餐订阅");
  const users = new Set<number>();
  for (const row of rows) {
    const patch: Record<string, unknown> = { amount_used: 0, updated_at: now };
    if (advanceResetTime) {
      const nextReset = calcNextResetTime(now, published, Number(row.end_time || row.expire_at || 0));
      patch.next_reset_time = nextReset;
      patch.last_reset_time = nextReset > 0 ? now : 0;
    }
    await s.updateUserSub(Number(row.id), patch);
    users.add(Number(row.user_id));
  }
  return apiOk({
    plan_id: planId,
    matched_count: rows.length,
    reset_count: rows.length,
    user_count: users.size,
    advance_reset_time: advanceResetTime,
  });
}

async function fetchCodexWham(c: C, kind: "usage" | "reset-credits" | "reset"): Promise<Response> {
  const s = store(c);
  const permission = kind === "reset" ? "operate" : "read";
  const u = await requireChannel(c, s, permission);
  if (isResponse(u)) return u;
  const id = strconvAtoi(c.params.id);
  if (!id.ok) return apiFail(`invalid channel id: ${id.message}`);
  const ch = await s.getChannel(id.n);
  if (!ch) return apiFail("channel not found");
  if (ch.type !== 57) return apiFail("channel type is not Codex");
  const info = parseJson<Record<string, unknown>>(String(ch.channel_info || ""), {});
  if (info.is_multi_key || info.IsMultiKey) return apiFail("multi-key channel is not supported");
  let oauth: ReturnType<typeof parseCodexOAuthKeyStrict>;
  try {
    oauth = parseCodexOAuthKeyStrict(ch.key);
  } catch {
    return apiFail("解析凭证失败，请检查渠道配置");
  }
  let accessToken = String(oauth.access_token || "").trim();
  const accountID = String(oauth.account_id || "").trim();
  if (!accessToken) return apiFail("codex channel: access_token is required");
  if (!accountID) return apiFail("codex channel: account_id is required");
  const failMsg =
    kind === "usage" ? "获取用量信息失败，请稍后重试" : kind === "reset-credits" ? "获取重置次数详情失败，请稍后重试" : "重置用量失败，请稍后重试";
  const base = String(ch.base_url || "").trim().replace(/\/+$/, "");
  if (!base) return apiFail(failMsg);
  const path =
    kind === "usage"
      ? "/backend-api/wham/usage"
      : kind === "reset-credits"
        ? "/backend-api/wham/rate-limit-reset-credits"
        : "/backend-api/wham/rate-limit-reset-credits/consume";

  const callWham = async (token: string) => {
    const res = await fetch(base + path, {
      method: kind === "reset" ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        "chatgpt-account-id": accountID,
        accept: "application/json",
        originator: "codex_cli_rs",
        ...(kind === "reset" ? { "content-type": "application/json" } : {}),
      },
      body: kind === "reset" ? JSON.stringify({ redeem_request_id: crypto.randomUUID() }) : undefined,
    });
    return { status: res.status, text: await res.text() };
  };

  let fetched: { status: number; text: string };
  try {
    fetched = await callWham(accessToken);
  } catch {
    return apiFail(failMsg);
  }

  if ((fetched.status === 401 || fetched.status === 403) && String(oauth.refresh_token || "").trim()) {
    let refreshedToken = "";
    try {
      const refreshed = await refreshCodexOAuthToken(oauth.refresh_token);
      refreshedToken = refreshed.access_token;
      try {
        await s.updateChannel(ch.id, { key: persistCodexOAuthKey(oauth, refreshed) });
      } catch {
        /* original ignores persist errors and still retries with the new token */
      }
    } catch {
      refreshedToken = "";
    }
    if (refreshedToken) {
      try {
        fetched = await callWham(refreshedToken);
      } catch {
        return apiFail(failMsg);
      }
    }
  }

  let payload: unknown = fetched.text;
  try {
    payload = JSON.parse(fetched.text) as unknown;
  } catch {
    payload = fetched.text;
  }
  const ok = fetched.status >= 200 && fetched.status < 300;
  return json(200, {
    success: ok,
    message: ok ? "" : `upstream status: ${fetched.status}`,
    upstream_status: fetched.status,
    data: payload,
  });
}

async function payUser(c: C, kind: "stripe" | "epay" | "creem" | "waffo" | "waffo_pancake"): Promise<Response> {
  const s = store(c);
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const user = await s.getUserById(u.id);
  let body: Record<string, unknown> = {};
  let bindError = false;
  try {
    const text = await c.req.text();
    if (!text.trim()) {
      if (kind === "stripe" || kind === "epay" || kind === "creem") return payErr("参数错误");
      if (kind === "waffo" || kind === "waffo_pancake") bindError = true;
      else body = {};
    } else {
      body = JSON.parse(text) as Record<string, unknown>;
    }
  } catch {
    if (kind === "stripe" || kind === "epay" || kind === "creem") return payErr("参数错误");
    if (kind === "waffo" || kind === "waffo_pancake") bindError = true;
    else body = {};
  }
  if (!user) {
    if (kind === "stripe" || kind === "creem" || kind === "waffo" || kind === "waffo_pancake") return payErr("用户不存在");
    return apiFail("用户不存在");
  }
  if (kind === "stripe") {
    return requestStripePay(
      s,
      user,
      c.req,
      body as { amount?: number; payment_method?: string; success_url?: string; cancel_url?: string },
      c.env.TRUSTED_REDIRECT_DOMAINS,
    );
  }
  if (kind === "epay") return requestEpay(s, user, c.req, body as { amount?: number; payment_method?: string });
  if (kind === "creem") return requestCreemPay(s, user, c.req, body as { product_id?: string; payment_method?: string });
  if (kind === "waffo_pancake") return requestWaffoPancakePay(s, user, c.req, body as { amount?: number }, bindError);
  return requestWaffoPay(
    s,
    user,
    c.req,
    body as { amount?: number; pay_method_index?: number; pay_method_type?: string; pay_method_name?: string },
    bindError,
  );
}

export { sessionViews, paymentEnabled };
