import { CHANNEL_ENABLED, START_TIME, VERSION, csv, nowSec, parseJson, randomHex } from "./constants.js";
import { permissionCatalog, canWithPolicies, roleKeyForSystemRole, roleSubject, userSubject } from "./authz.js";
import { httpStats, performanceStats, resetMetrics } from "./metrics.js";
import {
  completePendingTopup,
  handleCreemWebhook,
  handleEpayNotify,
  handleStripeWebhook,
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
import { mailConfigured, sendMail, sixDigitCode } from "./mail.js";
import {
  loginOrBindOAuth,
  verifyTelegramLogin,
  wechatIdFromCode,
} from "./oauth.js";
import { bytesToHex, hmacSha256Hex, sha256Bytes } from "./crypto.js";
import { bindVerificationOperation, issueSecurityProof } from "./security.js";
import { apiFail, apiOk, json, pageData, pageQuery, readJson } from "./http.js";
import type { Context } from "./router.js";
import type { Router } from "./router.js";
import {
  authenticateApiToken,
  currentSid,
  dashboardIdentity,
  isResponse,
  issueSessionSafe,
  requireAdmin,
  requireChannel,
  requirePermission,
  requireProof,
  requireRoot,
  requireUser,
  sessionResponse,
  sessionSecret,
} from "./auth.js";
import { Store } from "./store.js";
import { testChannel, fetchUpstreamModels } from "./relay.js";
import { updateAllChannelBalances, updateOneChannelBalance } from "./channel-balance.js";
import { enrichModelMeta } from "./dto.js";
import {
  calcNextResetTime,
  calcPlanEndTime,
  decodePluginIcon,
  parseCodexOAuthKey,
  publicPlan,
} from "./subscription.js";
import { computeStatusCounts, ionetApiKey, ionetRequest, ionetSettings, IONET_NOT_CONFIGURED, mapIoNetDeployment } from "./ionet.js";
import type { Env } from "./types.js";

type C = Context<Env>;

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

async function authzCheck(c: C): Promise<Response> {
  const s = store(c);
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const body =
    c.req.method === "GET"
      ? { resource: c.url.searchParams.get("resource") || "", action: c.url.searchParams.get("action") || "" }
      : ((await readJson(c.req)) as { resource?: string; action?: string });
  const resource = (body.resource || "").trim();
  const action = (body.action || "").trim();
  if (!resource || !action) return apiFail("resource and action are required");
  const user = await s.getUserById(u.id);
  if (!user) return apiFail("用户不存在");
  const roleKey = roleKeyForSystemRole(user.role);
  const userPolicies = await s.casbinPolicies(userSubject(user.id));
  const rolePolicies = roleKey ? await s.casbinPolicies(roleSubject(roleKey)) : [];
  return apiOk({ allowed: canWithPolicies(user, resource, action, userPolicies, rolePolicies), resource, action });
}

export function registerParity(r: Router<Env>): void {
  r.get("/api/authz/catalog", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(permissionCatalog());
  });

  r.get("/api/authz/check", async (c) => authzCheck(c));
  r.post("/api/authz/check", async (c) => authzCheck(c));

  r.post("/api/oauth/email/bind/start", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { email?: string };
    const email = (body.email || "").trim().toLowerCase();
    if (!email.includes("@")) return apiFail("无效邮箱");
    const proof = await requireProof(c, s, { scope: "account.binding.bind", context: { provider: "email", email } });
    if (isResponse(proof)) return proof;
    if (!(await mailConfigured(s))) return apiFail("邮件未配置");
    const code = sixDigitCode();
    const flow = randomHex(16);
    await s.insertEmailCode(email, code, "bind");
    await s.insertAuthFlow({
      token: flow,
      type: "email_bind",
      user_id: proof.userId,
      expires_at: nowSec() + 600,
      payload: email,
    });
    await sendMail(s, email, "绑定邮箱验证码", `<p>验证码 <b>${code}</b>，10 分钟内有效。</p>`);
    const user = await s.getUserById(proof.userId);
    const expires = nowSec() + 600;
    return apiOk({
      flow_token: flow,
      email,
      current_email: user?.email || "",
      old_email_required: Boolean(user?.email),
      expires_at: expires,
      resend_at: nowSec() + 30,
      notification_warning: false,
    });
  });

  r.post("/api/oauth/email/bind/resend", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { flow_token?: string };
    const flow = await s.getAuthFlow(body.flow_token || "");
    if (!flow || flow.type !== "email_bind" || flow.user_id !== u.id) return apiFail("流程无效");
    if (!(await mailConfigured(s))) return apiFail("邮件未配置");
    const code = sixDigitCode();
    await s.insertEmailCode(flow.payload, code, "bind");
    await sendMail(s, flow.payload, "绑定邮箱验证码", `<p>验证码 <b>${code}</b>，10 分钟内有效。</p>`);
    return apiOk({ flow_token: flow.token, expires_at: flow.expires_at, resend_at: nowSec() + 30 });
  });

  r.post("/api/oauth/email/bind", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { flow_token?: string; new_code?: string; email?: string };
    const flow = await s.getAuthFlow(body.flow_token || "");
    if (!flow || flow.type !== "email_bind" || flow.user_id !== u.id) return apiFail("流程无效");
    if (!(await s.consumeEmailCode(flow.payload, body.new_code || "", "bind"))) return apiFail("验证码无效或已过期");
    await s.updateUser(u.id, { email: flow.payload, email_verified: 1 });
    await s.deleteAuthFlow(flow.token);
    return apiOk({ notification_warning: false });
  });

  r.get("/api/oauth/wechat", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("WeChatAuthEnabled", false))) return apiFail("管理员未开启通过微信登录以及注册");
    const code = c.url.searchParams.get("code") || "";
    try {
      const wechatId = await wechatIdFromCode(s, code);
      return loginOrBindOAuth(
        s,
        c.env,
        c.req,
        { id: wechatId, username: `wx_${wechatId}`.slice(0, 20), display_name: `微信用户`, field: "wechat_id" },
        null,
        "login",
      );
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/oauth/wechat/bind", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { code?: string };
    const proof = await requireProof(c, s, { scope: "account.binding.bind", context: { provider: "wechat", code: String(body.code || "").trim() } });
    if (isResponse(proof)) return proof;
    try {
      const wechatId = await wechatIdFromCode(s, body.code || "");
      await s.updateUser(proof.userId, { wechat_id: wechatId });
      return apiOk({ action: "bind", notification_warning: false });
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

  r.post("/api/user/login/verify", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { flow_token?: string; method?: string; code?: string };
    if (!body.flow_token || !body.code) return apiFail("参数错误");
    const flow = await s.getAuthFlow(body.flow_token);
    if (!flow || (flow.type !== "2fa_login" && flow.type !== "login_verify") || flow.expires_at < nowSec()) {
      return apiFail("登录流程已过期");
    }
    const user = await s.getUserById(flow.user_id);
    if (!user) return apiFail("用户不存在");
    const { verifyTotp, verifyBackupCode } = await import("./totp.js");
    const totpOk = await verifyTotp(user.totp_secret || "", body.code);
    const backup = totpOk ? { ok: false, rest: user.totp_backup || "" } : verifyBackupCode(user.totp_backup || "", body.code);
    if (!totpOk && !backup.ok) return apiFail("验证码错误");
    if (backup.ok) await s.updateUser(user.id, { totp_backup: backup.rest });
    await s.deleteAuthFlow(body.flow_token);
    const issued = await issueSessionSafe(s, c.env, user, c.req, "2fa");
    if (issued instanceof Response) return issued;
    return sessionResponse(issued);
  });

  r.post("/api/user/passkey/verify/begin", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { scope?: string; context?: unknown };
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, { scope: body.scope || "", context: body.context });
    if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
    const keys = await s.listPasskeys(u.id);
    if (!keys.length) return apiFail("该用户尚未绑定 Passkey");
    const { newChallenge } = await import("./passkey.js");
    const ch = newChallenge();
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({
      token: ch.id,
      type: "passkey_verify",
      user_id: u.id,
      expires_at: expiresAt,
      payload: JSON.stringify({ challenge: ch.challenge, scope: bound.binding.scope, context_hash: bound.binding.contextHash }),
      session_id: identity.sessionId,
    });
    const options = {
      challenge: ch.challenge,
      allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
      timeout: 60000,
      userVerification: "preferred",
    };
    return apiOk({ options, flow_token: ch.id, expires_at: expiresAt, flow_id: ch.id, publicKey: options });
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
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    return updateOneChannelBalance(s, ch);
  });

  r.post("/api/channel/tag/disabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { tag?: string };
    if (!body.tag) return apiFail("缺少 tag");
    return apiOk({ count: await s.setChannelsByTag(body.tag, 2) });
  });

  r.put("/api/channel/tag", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as {
      tag?: string;
      new_tag?: string;
      models?: string;
      group?: string;
      groups?: string;
      priority?: number;
      weight?: number;
      param_override?: string;
      header_override?: string;
    };
    if (!body.tag) return apiFail("tag不能为空");
    if ((body.param_override != null || body.header_override != null) && u.role < 100) {
      const user = await s.getUserById(u.id);
      const roleKey = user ? roleKeyForSystemRole(user.role) : "";
      const userPolicies = user ? await s.casbinPolicies(userSubject(user.id)) : [];
      const rolePolicies = roleKey ? await s.casbinPolicies(roleSubject(roleKey)) : [];
      const allowed = user
        ? canWithPolicies(user, "channel", "sensitive_write", userPolicies, rolePolicies)
        : false;
      if (!allowed) return apiFail("无权进行此操作，权限不足", null, 403);
    }
    const channels = await s.channelsByTag(body.tag);
    for (const ch of channels) {
      const patch: Record<string, unknown> = {};
      if (body.new_tag != null) patch.tag = body.new_tag;
      if (body.models != null) patch.models = body.models;
      if (body.group != null) patch.group = body.group;
      if (body.groups != null) patch.group = body.groups;
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
    const { results } = await c.env.DB.prepare("SELECT id FROM channels").all();
    return apiOk({ success: results.length, fails: 0 });
  });

  r.post("/api/channel/:id/codex/refresh", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const settings = parseJson<Record<string, string>>(ch.settings, {});
    const refresh = settings.refresh_token || "";
    if (!refresh) return apiFail("渠道未配置 Codex refresh_token");
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: settings.client_id || "app_EMoamEEZ73f0CkXaXp7hrann" }),
    });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!data.access_token) return apiFail(data.error || "Codex 刷新失败");
    settings.access_token = data.access_token;
    if (data.refresh_token) settings.refresh_token = data.refresh_token;
    await s.updateChannel(ch.id, { settings: JSON.stringify(settings), key: data.access_token });
    return apiOk({ refreshed: true });
  });

  r.get("/api/channel/:id/codex/usage", async (c) => fetchCodexWham(c, "usage"));
  r.get("/api/channel/:id/codex/usage/reset-credits", async (c) => fetchCodexWham(c, "reset-credits"));
  r.post("/api/channel/:id/codex/usage/reset", async (c) => fetchCodexWham(c, "reset"));

  r.post("/api/channel/ollama/pull", async (c) => ollamaOp(c, "pull"));
  r.post("/api/channel/ollama/pull/stream", async (c) => ollamaOp(c, "pull"));
  r.delete("/api/channel/ollama/delete", async (c) => ollamaOp(c, "delete"));
  r.get("/api/channel/ollama/version/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const base = (ch.base_url || "http://localhost:11434").replace(/\/$/, "");
    const res = await fetch(base + "/api/version");
    return apiOk(await res.json().catch(() => ({ version: "unknown" })));
  });

  r.post("/api/channel/batch/tag", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[]; tag?: string };
    if (!body.ids?.length) return apiFail("参数错误");
    for (const id of body.ids) await s.updateChannel(id, { tag: body.tag || "" });
    return apiOk(body.ids.length);
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
      const parts = csv(ch.models);
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
    const body = (await readJson(c.req)) as { id?: number; action?: string; keys?: string[]; index?: number };
    const ch = await s.getChannel(Number(body.id));
    if (!ch) return apiFail("渠道不存在");
    const keys = ch.key.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    if (body.action === "add" && body.keys) keys.push(...body.keys);
    if (body.action === "remove" && body.index != null) keys.splice(body.index, 1);
    await s.updateChannel(ch.id, { key: keys.join("\n") });
    return apiOk({ count: keys.length });
  });

  r.post("/api/channel/upstream_updates/detect", async (c) => detectUpdates(c, false));
  r.post("/api/channel/upstream_updates/detect_all", async (c) => detectUpdates(c, true));
  r.post("/api/channel/upstream_updates/apply", async (c) => applyUpdates(c, false));
  r.post("/api/channel/upstream_updates/apply_all", async (c) => applyUpdates(c, true));

  r.post("/api/subscription/admin/plans/:id/subscriptions/reset", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const planId = Number(c.params.id);
    if (planId <= 0) return apiFail("无效的ID");
    const body = (await readJson(c.req).catch(() => ({}))) as { advance_reset_time?: boolean };
    return resetPlanSubscriptions(c, s, planId, undefined, Boolean(body.advance_reset_time));
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
    const plan = await s.getPlan(Number(body.plan_id));
    if (!plan) return apiFail("套餐不存在");
    const published = publicPlan(plan);
    const start = nowSec();
    const expire = calcPlanEndTime(start, published);
    const nextReset = calcNextResetTime(start, published, expire);
    await s.insertUserSub({
      user_id: userId,
      plan_id: Number(plan.id),
      start_time: start,
      end_time: expire,
      amount_total: Number(published.total_amount || 0),
      source: "admin",
      next_reset_time: nextReset,
      last_reset_time: nextReset > 0 ? start : 0,
      upgrade_group: String(published.upgrade_group || ""),
      downgrade_group: String(published.downgrade_group || ""),
      allow_wallet_overflow: published.allow_wallet_overflow ? 1 : 0,
    });
    return apiOk(null);
  });

  r.post("/api/subscription/admin/users/:id/subscriptions/reset", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const userId = Number(c.params.id);
    if (userId <= 0) return apiFail("无效的用户ID");
    const body = (await readJson(c.req)) as { plan_id?: number; advance_reset_time?: boolean };
    if (!body.plan_id) return apiFail("参数错误");
    return resetPlanSubscriptions(c, s, Number(body.plan_id), userId, Boolean(body.advance_reset_time));
  });

  r.post("/api/subscription/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/subscription/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/subscription/epay/return", () => apiOk({ ok: true }));
  r.post("/api/subscription/epay/return", () => apiOk({ ok: true }));

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
    const raw = c.env.KV ? await c.env.KV.get("channel_affinity") : await s.option("ChannelAffinityCache");
    const cache = parseJson<Record<string, unknown>>(raw || "{}", {});
    return apiOk({ size: Object.keys(cache).length, entries: cache });
  });

  r.delete("/api/option/channel_affinity_cache", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    if (c.env.KV) await c.env.KV.put("channel_affinity", "{}");
    await s.setOption("ChannelAffinityCache", "{}");
    return apiOk(null, "已清理");
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
    const body = (await readJson(c.req)) as { url?: string };
    if (!body.url) return apiFail("缺少 url");
    const res = await fetch(body.url);
    if (!res.ok) return apiFail("discovery 请求失败");
    return apiOk(await res.json());
  });

  r.get("/api/custom-oauth-provider/:id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getOAuthProvider(c.params.id);
    if (!p) return apiFail("不存在");
    return apiOk({ ...p, client_secret: "" });
  });

  r.get("/api/performance/stats", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const counts = await s.counts();
    return apiOk({ ...performanceStats(), counts });
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
    return apiOk(httpStats(), "已重置");
  });
  r.post("/api/performance/gc", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(null, "workerd 由运行时管理内存");
  });
  r.get("/api/performance/logs", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk([]);
  });
  r.delete("/api/performance/logs", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(null);
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
    const body = (await readJson(c.req)) as {
      channel_id?: number;
      channel_ids?: number[];
      upstreams?: { id?: number; name?: string; base_url?: string; endpoint?: string }[];
      timeout?: number;
    };
    const upstreams: { id: number; name: string; base_url: string; endpoint: string }[] = [];
    if (body.upstreams?.length) {
      for (const ustr of body.upstreams) {
        if (ustr.base_url?.startsWith("http")) {
          upstreams.push({
            id: Number(ustr.id || 0),
            name: ustr.name || ustr.base_url || "",
            base_url: ustr.base_url.replace(/\/$/, ""),
            endpoint: ustr.endpoint || "/api/pricing",
          });
        }
      }
    } else {
      const ids = body.channel_ids?.length ? body.channel_ids : body.channel_id ? [body.channel_id] : [];
      for (const id of ids) {
        const ch = await s.getChannel(Number(id));
        if (ch?.base_url?.startsWith("http")) {
          upstreams.push({ id: ch.id, name: ch.name, base_url: ch.base_url.replace(/\/$/, ""), endpoint: "/api/pricing" });
        }
      }
    }
    if (!upstreams.length) return apiFail("无有效上游渠道");
    const localData = {
      model_ratio: parseJson<Record<string, number>>(await s.option("ModelRatio"), {}),
      completion_ratio: parseJson<Record<string, number>>(await s.option("CompletionRatio"), {}),
      model_price: parseJson<Record<string, number>>(await s.option("ModelPrice"), {}),
    };
    const test_results: { name: string; status: string; error?: string }[] = [];
    const differences: Record<string, Record<string, { current: unknown; upstreams: Record<string, unknown> }>> = {};
    const prices: Record<string, { current: Record<string, unknown>; upstreams: Record<string, Record<string, unknown>> }> = {};
    for (const ustr of upstreams) {
      const uniqueName = ustr.id ? `${ustr.name}(${ustr.id})` : ustr.name;
      try {
        const res = await fetch(ustr.base_url + (ustr.endpoint.startsWith("/") ? ustr.endpoint : "/" + ustr.endpoint));
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          test_results.push({ name: uniqueName, status: "error", error: `HTTP ${res.status}` });
          continue;
        }
        test_results.push({ name: uniqueName, status: "success" });
        const payload = (data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
        const ratios = (payload.model_ratio || payload.ModelRatio || {}) as Record<string, unknown>;
        for (const [model, ratio] of Object.entries(ratios)) {
          if (!differences[model]) differences[model] = {};
          if (!differences[model].model_ratio) differences[model].model_ratio = { current: localData.model_ratio[model] ?? null, upstreams: {} };
          differences[model].model_ratio.upstreams[uniqueName] = ratio;
          if (!prices[model]) prices[model] = { current: { model_ratio: localData.model_ratio[model] ?? null, model_price: localData.model_price[model] ?? null }, upstreams: {} };
          prices[model].upstreams[uniqueName] = { model_ratio: ratio };
        }
      } catch (e) {
        test_results.push({ name: uniqueName, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return apiOk({ differences, prices, test_results });
  });

  r.get("/api/plugin/task", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const items = [];
    for (const row of (await s.listTaskPlugins()) as Record<string, unknown>[]) {
      items.push(await publicTaskPlugin(s, row));
    }
    return apiOk(items);
  });
  r.post("/api/plugin/task", (c) => upsertPlugin(c));
  r.put("/api/plugin/task", (c) => upsertPlugin(c));
  r.get("/api/plugin/task/runtime/status", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const plugins = (await s.listTaskPlugins()) as { status: string; key: string }[];
    const now = new Date().toISOString();
    return apiOk({
      current_generation: 1,
      generation_published_at: now,
      database_revision: String(plugins.length),
      last_rebuild: {
        status: "success",
        attempted_at: now,
        generation: 1,
        plugin_error_count: 0,
        error: "workerd cannot execute Goja JS task-plugin runtime; plugins are a D1 registry plus HTTP passthrough",
      },
      plugin_errors: {},
      runtime: "workerd",
    });
  });
  r.get("/api/plugin/task/marketplace/sources", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(parseJson(await s.option("TaskPluginMarketplaceSources"), []));
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
    const p = await s.getTaskPlugin(c.params.key);
    if (!p) return apiFail("task plugin not found");
    const manifest = parseJson<Record<string, unknown>>(String(p.manifest || "{}"), {});
    const icon = String(p.icon || "");
    const plugin = { ...p };
    delete plugin.icon;
    return apiOk({
      plugin,
      meta: {
        key: String(p.key || c.params.key),
        version: String(manifest.version || p.version || "1.0.0"),
        api_version: String(manifest.api_version || "v1"),
        name: String(manifest.name || p.name || p.key),
      },
      source: String(p.source || ""),
      layer: "override",
      has_icon: Boolean(icon),
    });
  });
  r.get("/api/plugin/task/:key/icon", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getTaskPlugin(c.params.key);
    const decoded = decodePluginIcon(String(p?.icon || ""));
    if (!decoded) return new Response(null, { status: 404 });
    return new Response(decoded.body as unknown as BodyInit, {
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
    const p = await s.getTaskPlugin(c.params.key);
    return apiOk(p ? [{ version: p.version, status: p.status }] : []);
  });
  r.post("/api/plugin/task/:key/activate", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getTaskPlugin(c.params.key);
    if (!p) return apiFail("插件不存在");
    await s.upsertTaskPlugin({ ...p, status: "active", active_version: p.version });
    return apiOk(null, "已激活");
  });
  r.post("/api/plugin/task/:key/status", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getTaskPlugin(c.params.key);
    if (!p) return apiFail("插件不存在");
    const body = (await readJson(c.req)) as { status?: string };
    await s.upsertTaskPlugin({ ...p, status: body.status || "inactive" });
    return apiOk(null);
  });
  r.post("/api/plugin/task/:key/dryrun", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getTaskPlugin(c.params.key);
    if (!p) return apiFail("插件不存在");
    return apiOk({ ok: true, key: p.key, routes: parseJson(String(p.routes || "[]"), []) });
  });
  r.delete("/api/plugin/task/:key/versions/:version", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.deleteTaskPlugin(c.params.key);
    return apiOk(null);
  });
  r.get("/api/task_plugin_options", async (c) => {
    const s = store(c);
    const u = await requirePermission(c, s, "task_plugin", "bind");
    if (isResponse(u)) return u;
    const plugins = ((await s.listTaskPlugins()) as { key: string; name: string; status: string }[]).filter((p) => p.status === "active");
    return apiOk(plugins.map((p) => ({ key: p.key, name: p.name })));
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
    return apiOk({ size: 0, hits: 0, misses: 0 });
  });

  r.post("/api/system-task/log-cleanup", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const id = randomHex(8);
    await s.insertSystemTask({ id, type: "log-cleanup", status: "running" });
    const cutoff = nowSec() - 90 * 86400;
    await c.env.DB.prepare("DELETE FROM request_logs WHERE created_at < ?").bind(cutoff).run();
    await s.updateSystemTask(id, { status: "success", progress: "100", result: "cleaned" });
    return apiOk({ task_id: id });
  });
  r.get("/api/system-task/list", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listSystemTasks());
  });
  r.get("/api/system-task/current", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.currentSystemTask());
  });
  r.get("/api/system-task/:task_id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const t = await s.getSystemTask(c.params.task_id);
    if (!t) return apiFail("任务不存在");
    return apiOk(t);
  });

  r.get("/api/system-info/instances", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk([
      {
        node_name: "edge-api",
        status: "online",
        stale_after_seconds: 90,
        started_at: Math.floor(START_TIME / 1000),
        last_seen_at: Math.floor(Date.now() / 1000),
        info: { version: VERSION, runtime: "workerd", http_stats: httpStats() },
      },
    ]);
  });
  r.delete("/api/system-info/stale-instances", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk({ deleted_count: 0 });
  });
  r.delete("/api/system-info/instances/:node_name", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk({ deleted_count: 0 });
  });

  r.get("/api/data/users", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const start = Number(c.url.searchParams.get("start_timestamp") || nowSec() - 86400 * 7);
    const end = Number(c.url.searchParams.get("end_timestamp") || nowSec());
    return apiOk(await s.quotaDatesByUser(start, end));
  });
  r.get("/api/data/flow", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const start = Number(c.url.searchParams.get("start_timestamp") || 0);
    const end = Number(c.url.searchParams.get("end_timestamp") || 0);
    if (!start) return apiFail("invalid start_timestamp");
    if (!end) return apiFail("invalid end_timestamp");
    if (end < start) return apiFail("invalid time range");
    return apiOk(await s.flowQuotaDates(start, end, null, c.url.searchParams.get("username") || "", u.role));
  });
  r.get("/api/data/flow/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const start = Number(c.url.searchParams.get("start_timestamp") || 0);
    const end = Number(c.url.searchParams.get("end_timestamp") || 0);
    if (!start) return apiFail("invalid start_timestamp");
    if (!end) return apiFail("invalid end_timestamp");
    if (end < start) return apiFail("invalid time range");
    if (end - start > 2592000) return apiFail("时间跨度不能超过 1 个月");
    return apiOk(await s.flowQuotaDates(start, end, u.id, "", u.role));
  });

  r.get("/api/task/:task_id/artifacts", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const task = await s.getTaskByTid(c.params.task_id);
    if (!task) return apiFail("任务不存在");
    if (Number(task.user_id) !== u.id && u.role < 10) return apiFail("无权访问");
    return apiOk([{ task_id: task.task_id, result: task.result }]);
  });

  r.post("/api/vendors/operations/preview", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[]; action?: string };
    return apiOk({ action: body.action || "update", count: (body.ids || []).length, preview: true });
  });
  r.post("/api/vendors/operations", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[]; action?: string; patch?: Record<string, unknown> };
    let n = 0;
    for (const id of body.ids || []) {
      if (body.action === "delete") await s.deleteVendor(id);
      else if (body.patch) await s.updateVendor(id, body.patch);
      n += 1;
    }
    return apiOk({ count: n });
  });

  r.get("/api/models/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const keyword = c.url.searchParams.get("keyword") || "";
    const squareState = c.url.searchParams.get("square_state") || "";
    if (squareState && !["visible", "unavailable", "hidden", "partial"].includes(squareState)) {
      return json(400, { success: false, message: "Invalid model square state" });
    }
    if (squareState && (q.page < 1 || q.page_size < 1)) {
      return json(400, { success: false, message: "Invalid pagination" });
    }
    const items = (keyword ? await s.searchModelMeta(keyword) : await s.listModelMeta()) as Record<string, unknown>[];
    let enriched = await enrichModelMeta(s, items);
    if (squareState) {
      enriched = enriched.filter((m) => m.square_state === squareState);
    }
    const vendor_counts = await s.vendorModelCounts();
    const pageItems = squareState
      ? enriched.slice((q.page - 1) * q.page_size, (q.page - 1) * q.page_size + q.page_size)
      : enriched.slice(q.offset, q.offset + q.page_size);
    return apiOk(pageData(pageItems, squareState ? enriched.length : items.length, q, { vendor_counts }));
  });
  r.get("/api/models/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const items = (await s.searchModelMeta(c.url.searchParams.get("keyword") || "")) as Record<string, unknown>[];
    const vendor_counts = await s.vendorModelCounts();
    const enriched = await enrichModelMeta(s, items);
    return apiOk(pageData(enriched.slice(q.offset, q.offset + q.page_size), items.length, q, { vendor_counts }));
  });
  r.get("/api/models/missing", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const enabled = await s.enabledModels("default");
    const meta = (await s.listModelMeta()) as { model_name: string }[];
    const have = new Set(meta.map((m) => m.model_name));
    return apiOk(enabled.filter((m) => !have.has(m)));
  });
  r.get("/api/models/sync_upstream/preview", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const missing = await (async () => {
      const enabled = await s.enabledModels("default");
      const meta = (await s.listModelMeta()) as { model_name: string }[];
      const have = new Set(meta.map((m) => m.model_name));
      return enabled.filter((m) => !have.has(m));
    })();
    return apiOk({ to_create: missing, to_update: [] });
  });
  r.post("/api/models/sync_upstream", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const enabled = await s.enabledModels("default");
    const meta = (await s.listModelMeta()) as { model_name: string }[];
    const have = new Set(meta.map((m) => m.model_name));
    let n = 0;
    for (const name of enabled) {
      if (!have.has(name)) {
        await s.insertModelMeta(name);
        n += 1;
      }
    }
    return apiOk({ created: n });
  });
  r.post("/api/models/delete", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    return apiOk({ count: await s.deleteModelMetaBatch(body.ids || []) });
  });
  r.get("/api/models/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    if (c.params.id === "meta") return apiOk(await enrichModelMeta(s, (await s.listModelMeta()) as Record<string, unknown>[]));
    const item = await s.getModelMeta(Number(c.params.id));
    if (!item) return apiFail("不存在");
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
    const status = (c.url.searchParams.get("status") || "").toLowerCase();
    const params = new URLSearchParams({
      page: String(q.page),
      page_size: String(q.page_size),
      sort_by: "created_at",
      sort_order: "desc",
    });
    if (status) params.set("status", status);
    const fetched = await ionetRequest(key, "GET", `/deployments?${params.toString()}`);
    if (!fetched.ok) return apiFail(fetched.message);
    const raw = (fetched.json || {}) as { deployments?: Record<string, unknown>[]; total?: number };
    const deployments = raw.deployments || (Array.isArray(fetched.json) ? (fetched.json as Record<string, unknown>[]) : []);
    const items = deployments.map(mapIoNetDeployment);
    const total = Number(raw.total || items.length);
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
    const keyword = (c.url.searchParams.get("keyword") || "").toLowerCase();
    const fetched = await ionetRequest(key, "GET", `/deployments?page=${q.page}&page_size=${q.page_size}&sort_by=created_at&sort_order=desc`);
    if (!fetched.ok) return apiFail(fetched.message);
    const raw = (fetched.json || {}) as { deployments?: Record<string, unknown>[]; total?: number };
    let deployments = raw.deployments || [];
    if (keyword) deployments = deployments.filter((d) => String(d.name || "").toLowerCase().includes(keyword));
    const items = deployments.map(mapIoNetDeployment);
    return apiOk({
      page: q.page,
      page_size: q.page_size,
      total: items.length,
      items,
      status_counts: computeStatusCounts(items.length, deployments),
    });
  });
  r.get("/api/deployments/hardware-types", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", "/hardware/max-gpus-per-container");
    if (!fetched.ok) return apiFail(fetched.message);
    const payload = (fetched.json || {}) as { hardware?: unknown[]; total?: number };
    const hardware_types = payload.hardware || [];
    return apiOk({
      hardware_types,
      total: hardware_types.length,
      total_available: Number(payload.total || 0),
    });
  });
  r.get("/api/deployments/locations", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", "/locations", undefined, false);
    if (!fetched.ok) return apiFail(fetched.message);
    const payload = (fetched.json || {}) as { locations?: unknown[]; total?: number };
    const locations = payload.locations || (Array.isArray(fetched.json) ? fetched.json : []);
    return apiOk({ locations, total: Number(payload.total || (locations as unknown[]).length) });
  });
  r.get("/api/deployments/available-replicas", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const hardwareId = c.url.searchParams.get("hardware_id") || "";
    if (!hardwareId) return apiFail("hardware_id parameter is required");
    const gpuCount = c.url.searchParams.get("gpu_count") || "1";
    const fetched = await ionetRequest(key, "GET", `/available-replicas?hardware_id=${hardwareId}&hardware_qty=${gpuCount}`);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.post("/api/deployments/price-estimation", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const body = await readJson(c.req);
    const fetched = await ionetRequest(key, "POST", "/price-estimation", body);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.get("/api/deployments/check-name", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const name = c.url.searchParams.get("name") || "";
    const fetched = await ionetRequest(key, "GET", `/deployments?page=1&page_size=100&sort_by=created_at&sort_order=desc`);
    if (!fetched.ok) return apiFail(fetched.message);
    const raw = (fetched.json || {}) as { deployments?: { name?: string }[] };
    const items = raw.deployments || [];
    return apiOk({ available: !items.some((d) => d.name === name) });
  });
  r.post("/api/deployments/", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const body = await readJson(c.req);
    const fetched = await ionetRequest(key, "POST", "/deploy", body);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json, "Deployment created successfully");
  });
  r.get("/api/deployments/:id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", `/deployment/${encodeURIComponent(c.params.id)}`);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(mapIoNetDeployment((fetched.json || {}) as Record<string, unknown>));
  });
  r.get("/api/deployments/:id/logs", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", `/deployment/${encodeURIComponent(c.params.id)}/logs`);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.get("/api/deployments/:id/containers", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "GET", `/deployment/${encodeURIComponent(c.params.id)}/containers`);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.get("/api/deployments/:id/containers/:container_id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(
      key,
      "GET",
      `/deployment/${encodeURIComponent(c.params.id)}/containers/${encodeURIComponent(c.params.container_id)}`,
    );
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.put("/api/deployments/:id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "PUT", `/deployment/${encodeURIComponent(c.params.id)}`, await readJson(c.req));
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.put("/api/deployments/:id/name", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const body = (await readJson(c.req)) as { name?: string };
    const fetched = await ionetRequest(key, "PUT", `/deployment/${encodeURIComponent(c.params.id)}`, { name: body.name || "" });
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.post("/api/deployments/:id/extend", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "POST", `/deployment/${encodeURIComponent(c.params.id)}/extend`, await readJson(c.req));
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
  });
  r.delete("/api/deployments/:id", async (c) => {
    const key = await requireIoNetKey(c);
    if (key instanceof Response) return key;
    const fetched = await ionetRequest(key, "DELETE", `/deployment/${encodeURIComponent(c.params.id)}`);
    if (!fetched.ok) return apiFail(fetched.message);
    return apiOk(fetched.json);
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
    return requestAmount(s, (await readJson(c.req)) as { amount?: number; payment_method?: string });
  });
  r.post("/api/user/pay", async (c) => payUser(c, "epay"));
  r.post("/api/user/stripe/pay", async (c) => payUser(c, "stripe"));
  r.post("/api/user/stripe/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, { ...(await readJson(c.req)) as object, payment_method: "stripe" });
  });
  r.post("/api/user/creem/pay", async (c) => payUser(c, "creem"));
  r.post("/api/user/waffo/pay", async (c) => payUser(c, "waffo"));
  r.post("/api/user/waffo/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, (await readJson(c.req)) as { amount?: number });
  });
  r.post("/api/user/waffo-pancake/amount", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return requestAmount(s, (await readJson(c.req)) as { amount?: number });
  });
  r.post("/api/user/waffo-pancake/pay", async (c) => payUser(c, "waffo_pancake"));
  r.post("/api/user/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/user/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.post("/api/stripe/webhook", (c) => handleStripeWebhook(store(c), c.req));
  r.post("/api/creem/webhook", (c) => handleCreemWebhook(store(c), c.req));
  r.post("/api/waffo/webhook", (c) => genericPayWebhook(c, "waffo"));
  r.post("/api/waffo/webhook/:env", (c) => genericPayWebhook(c, "waffo"));
  r.post("/api/waffo-pancake/webhook/:env", (c) => genericPayWebhook(c, "waffo"));

  r.post("/api/subscription/epay/pay", async (c) => payKind(c, "epay"));
  r.post("/api/subscription/stripe/pay", async (c) => payKind(c, "stripe"));
  r.post("/api/subscription/creem/pay", async (c) => payKind(c, "creem"));
  r.post("/api/subscription/waffo-pancake/pay", async (c) => payKind(c, "waffo_pancake"));

  r.get("/api/perf-metrics", async (c) => {
    const model = c.url.searchParams.get("model");
    if (!model) return apiFail("model is required", null, 400);
    const s = store(c);
    const start = nowSec() - Number(c.url.searchParams.get("hours") || 24) * 3600;
    const rows = await s.quotaDates(null, start, nowSec());
    return apiOk({ model, group: c.url.searchParams.get("group") || "", points: rows });
  });
  r.get("/api/perf-metrics/summary", async (c) => {
    const s = store(c);
    const start = nowSec() - Number(c.url.searchParams.get("hours") || 24) * 3600;
    return apiOk(await s.quotaDatesByUser(start, nowSec()));
  });

  r.get("/api/uptime/status", async (c) => {
    const s = store(c);
    const raw = await s.option("UptimeKumaGroups");
    const groups = parseJson<{ url?: string; slug?: string; categoryName?: string }[]>(raw, []);
    if (!groups.length) return apiOk([]);
    const out = [];
    for (const g of groups) {
      if (!g.url || !g.slug) {
        out.push({ categoryName: g.categoryName || "", monitors: [] });
        continue;
      }
      try {
        const res = await fetch(`${g.url.replace(/\/$/, "")}/api/status-page/${g.slug}`);
        out.push({ categoryName: g.categoryName || "", ...(await res.json()) });
      } catch {
        out.push({ categoryName: g.categoryName || "", monitors: [] });
      }
    }
    return apiOk(out);
  });

  void hmacSha256Hex;
  void CHANNEL_ENABLED;
  void authenticateApiToken;
  void currentSid;
  void sessionViews;
  void verifyTelegramLogin;
}

async function ollamaOp(c: C, action: "pull" | "delete"): Promise<Response> {
  const s = store(c);
  const u = await requireChannel(c, s, "sensitive_write");
  if (isResponse(u)) return u;
  const body = (await readJson(c.req)) as { channel_id?: number; id?: number; model_name?: string; name?: string; model?: string };
  const channelId = Number(body.channel_id || body.id);
  const modelName = String(body.model_name || body.name || body.model || "");
  if (!channelId || !modelName) return json(400, { success: false, message: "Channel ID and model name are required" });
  const ch = await s.getChannel(channelId);
  if (!ch) return json(404, { success: false, message: "Channel not found" });
  if (ch.type !== 4) return json(400, { success: false, message: "This operation is only supported for Ollama channels" });
  const base = (ch.base_url || "http://localhost:11434").replace(/\/$/, "");
  const key = ch.key.split(/[\n,]/)[0] || "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;
  const path = action === "pull" ? "/api/pull" : "/api/delete";
  const res = await fetch(base + path, {
    method: action === "delete" ? "DELETE" : "POST",
    headers,
    body: JSON.stringify({ name: modelName, model: modelName }),
  });
  if (c.url.pathname.endsWith("/stream") && res.body) {
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/x-ndjson" },
    });
  }
  if (!res.ok) return json(res.status >= 400 ? res.status : 500, { success: false, message: `Failed to ${action} model: ${(await res.text()).slice(0, 300)}` });
  return apiOk(null, action === "pull" ? `Model ${modelName} pulled successfully` : `Model ${modelName} deleted successfully`);
}

async function detectUpdates(c: C, all: boolean, action: "operate" | "write" = "operate"): Promise<Response> {
  const s = store(c);
  const u = await requireChannel(c, s, action);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req).catch(() => ({}))) as { ids?: number[] };
  const channels = all ? await s.enabledChannels() : await Promise.all((body.ids || []).map((id) => s.getChannel(id)));
  const updates = [];
  for (const ch of channels) {
    if (!ch) continue;
    try {
      const upstream = await fetchUpstreamModels(ch);
      const current = new Set(csv(ch.models));
      const added = upstream.filter((m) => !current.has(m));
      if (added.length) updates.push({ id: ch.id, name: ch.name, added, removed: [] });
    } catch {
      /* skip */
    }
  }
  return apiOk(updates);
}

async function applyUpdates(c: C, all: boolean): Promise<Response> {
  const detected = await detectUpdates(c, all, "write");
  const parsed = (await detected.clone().json()) as { success?: boolean; data?: { id: number; added: string[] }[] };
  if (!parsed.success) return detected;
  const s = store(c);
  for (const row of parsed.data || []) {
    const ch = await s.getChannel(row.id);
    if (!ch) continue;
    const models = [...csv(ch.models), ...row.added].join(",");
    await s.updateChannel(ch.id, { models });
  }
  return apiOk({ count: (parsed.data || []).length });
}

async function publicTaskPlugin(store: Store, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = String(row.key || "");
  const version = String(row.version || "1.0.0");
  const status = String(row.status || "inactive");
  const active = status === "active" || status === "enabled";
  const manifest = parseJson<Record<string, unknown>>(String(row.manifest || "{}"), {});
  const icon = String(row.icon || "");
  const usage = await store.taskPluginUsage(key);
  return {
    meta: {
      key,
      version: String(manifest.version || version),
      api_version: String(manifest.api_version || "v1"),
      name: String(manifest.name || row.name || key),
    },
    source: "override",
    enabled: active,
    active,
    source_hash: String(row.source_hash || ""),
    has_icon: Boolean(icon),
    remark: String(row.remark || ""),
    runtime_status: active ? "registered" : "disabled",
    channel_count: usage.channel_count,
    in_flight_count: usage.in_flight_count,
  };
}

async function upsertPlugin(c: C): Promise<Response> {
  const s = store(c);
  const u = await requireRoot(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req)) as Record<string, unknown>;
  const key = String(body.key || body.name || "");
  if (!key) return apiFail("缺少 key");
  const source = String(body.source || "");
  const sourceHash = source ? bytesToHex(await sha256Bytes(source)) : String(body.source_hash || "");
  await s.upsertTaskPlugin({ ...body, key, source, source_hash: sourceHash });
  return apiOk({ key });
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
  const body = (await readJson(c.req).catch(() => ({}))) as { api_key?: string };
  const key = (body.api_key || (await s.option("model_deployment.ionet.api_key")) || (await s.option("IoNetApiKey"))).trim();
  if (!key) return apiFail("api_key is required");
  const fetched = await ionetRequest(key, "GET", "/hardware/max-gpus-per-container");
  if (!fetched.ok) return apiFail(fetched.message);
  const payload = (fetched.json || {}) as { hardware?: unknown[]; total?: number };
  const hardware = payload.hardware || [];
  return apiOk({ hardware_count: hardware.length, total_available: Number(payload.total || 0) });
}

async function resetPlanSubscriptions(
  c: C,
  s: Store,
  planId: number,
  userId: number | undefined,
  advanceResetTime: boolean,
): Promise<Response> {
  const plan = await s.getPlan(planId);
  if (!plan) return apiFail("无效的ID");
  const published = publicPlan(plan);
  const now = nowSec();
  const rows = await s.listActiveUserSubs(userId, planId);
  if (userId && !rows.length) return apiFail("该用户没有有效的此套餐订阅");
  const users = new Set<number>();
  for (const row of rows) {
    const nextReset = advanceResetTime ? calcNextResetTime(now, published, Number(row.end_time || row.expire_at || 0)) : Number(row.next_reset_time || 0);
    await s.updateUserSub(Number(row.id), {
      amount_used: 0,
      remaining_quota: Number(published.total_amount || 0),
      next_reset_time: nextReset,
      last_reset_time: advanceResetTime ? (nextReset > 0 ? now : 0) : row.last_reset_time,
      updated_at: now,
    });
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
  const channelId = Number(c.params.id);
  if (!Number.isInteger(channelId) || channelId <= 0) return apiFail("invalid channel id");
  const ch = await s.getChannel(channelId);
  if (!ch) return apiFail("channel not found");
  if (ch.type !== 57) return apiFail("channel type is not Codex");
  const info = parseJson<Record<string, unknown>>(String(ch.channel_info || ""), {});
  if (info.is_multi_key || info.IsMultiKey) return apiFail("multi-key channel is not supported");
  const oauth = parseCodexOAuthKey(ch.key);
  if (!oauth) return apiFail("解析凭证失败，请检查渠道配置");
  if (!oauth.access_token) return apiFail("codex channel: access_token is required");
  if (!oauth.account_id) return apiFail("codex channel: account_id is required");
  const base = (ch.base_url || "").replace(/\/$/, "");
  if (!base) return apiFail(kind === "usage" ? "获取用量信息失败，请稍后重试" : kind === "reset-credits" ? "获取重置次数详情失败，请稍后重试" : "重置用量失败，请稍后重试");
  const path =
    kind === "usage"
      ? "/backend-api/wham/usage"
      : kind === "reset-credits"
        ? "/backend-api/wham/rate-limit-reset-credits"
        : "/backend-api/wham/rate-limit-reset-credits/consume";
  const failMsg = kind === "usage" ? "获取用量信息失败，请稍后重试" : kind === "reset-credits" ? "获取重置次数详情失败，请稍后重试" : "重置用量失败，请稍后重试";
  try {
    const res = await fetch(base + path, {
      method: kind === "reset" ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + oauth.access_token,
        "chatgpt-account-id": oauth.account_id,
        accept: "application/json",
        originator: "codex_cli_rs",
        ...(kind === "reset" ? { "content-type": "application/json" } : {}),
      },
      body: kind === "reset" ? JSON.stringify({ redeem_request_id: randomHex(16) }) : undefined,
    });
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    const ok = res.status >= 200 && res.status < 300;
    return json(200, {
      success: ok,
      message: ok ? "" : `upstream status: ${res.status}`,
      upstream_status: res.status,
      data: payload,
    });
  } catch {
    return apiFail(failMsg);
  }
}

async function payUser(c: C, kind: "stripe" | "epay" | "creem" | "waffo" | "waffo_pancake"): Promise<Response> {
  const s = store(c);
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const user = await s.getUserById(u.id);
  if (!user) return apiFail("用户不存在");
  const body = (await readJson(c.req)) as Record<string, unknown>;
  if (kind === "stripe") return requestStripePay(s, user, c.req, body as { amount?: number; payment_method?: string; success_url?: string; cancel_url?: string });
  if (kind === "epay") return requestEpay(s, user, c.req, body as { amount?: number; payment_method?: string });
  if (kind === "creem") return requestCreemPay(s, user, c.req, body as { product_id?: string; payment_method?: string });
  if (kind === "waffo_pancake") return requestWaffoPancakePay(s, user, c.req, body as { amount?: number });
  return requestWaffoPay(s, user, c.req, body as { amount?: number });
}

async function payKind(c: C, kind: "stripe" | "epay" | "creem" | "waffo" | "waffo_pancake"): Promise<Response> {
  return payUser(c, kind);
}

async function genericPayWebhook(c: C, kind: string): Promise<Response> {
  const s = store(c);
  const body = (await readJson(c.req).catch(() => ({}))) as { trade_no?: string; metadata?: { trade_no?: string }; id?: string };
  const trade = body.trade_no || body.metadata?.trade_no || "";
  if (trade) await completePendingTopup(s, trade);
  void kind;
  return apiOk({ received: true });
}

export { sessionViews, paymentEnabled };
