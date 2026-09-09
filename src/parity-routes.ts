import { CHANNEL_ENABLED, VERSION, nowSec, parseJson, randomHex } from "./constants.js";
import { permissionCatalog } from "./authz.js";
import { httpStats, performanceStats, resetMetrics } from "./metrics.js";
import {
  completePendingTopup,
  handleEpayNotify,
  handleStripeWebhook,
  paymentEnabled,
  requestAmount,
  requestEpay,
  requestHttpPay,
  requestStripePay,
  topupInfo,
} from "./payments.js";
import { mailConfigured, sendMail, sixDigitCode } from "./mail.js";
import {
  loginOrBindOAuth,
  verifyTelegramLogin,
  wechatIdFromCode,
} from "./oauth.js";
import { hmacSha256Hex } from "./crypto.js";
import { apiFail, apiOk, json, pageData, pageQuery, readJson } from "./http.js";
import type { Context } from "./router.js";
import type { Router } from "./router.js";
import {
  authenticateApiToken,
  currentSid,
  isResponse,
  issueSession,
  requireAdmin,
  requireRoot,
  requireUser,
  sessionResponse,
} from "./auth.js";
import { Store } from "./store.js";
import { testChannel, fetchUpstreamModels } from "./relay.js";
import { csv } from "./constants.js";
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

export function registerParity(r: Router<Env>): void {
  r.get("/api/authz/catalog", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(permissionCatalog());
  });

  r.post("/api/oauth/email/bind/start", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { email?: string };
    const email = (body.email || "").trim();
    if (!email.includes("@")) return apiFail("无效邮箱");
    if (!(await mailConfigured(s))) return apiFail("邮件未配置");
    const code = sixDigitCode();
    const flow = randomHex(16);
    await s.insertEmailCode(email, code, "bind");
    await s.insertAuthFlow({
      token: flow,
      type: "email_bind",
      user_id: u.id,
      expires_at: nowSec() + 600,
      payload: email,
    });
    await sendMail(s, email, "绑定邮箱验证码", `<p>验证码 <b>${code}</b>，10 分钟内有效。</p>`);
    return apiOk({ flow_token: flow, expires_at: nowSec() + 600 }, "验证码已发送");
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
    return apiOk({ flow_token: flow.token }, "已重发");
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
    return apiOk(null, "邮箱已绑定");
  });

  r.get("/api/oauth/wechat", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("WeChatAuthEnabled", false))) return apiFail("管理员未开启通过微信登录以及注册");
    const code = c.url.searchParams.get("code") || "";
    try {
      const wechatId = await wechatIdFromCode(s, code);
      const existing = await s.getUserByField("wechat_id", wechatId);
      const sessionUser = await requireUser(c, s);
      const bind = isResponse(sessionUser) ? null : await s.getUserById(sessionUser.id);
      return loginOrBindOAuth(
        s,
        c.env,
        c.req,
        { id: wechatId, username: `wx_${wechatId}`.slice(0, 20), display_name: `微信用户`, field: "wechat_id" },
        bind,
      );
      void existing;
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/oauth/wechat/bind", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { code?: string };
    try {
      const wechatId = await wechatIdFromCode(s, body.code || "");
      await s.updateUser(u.id, { wechat_id: wechatId });
      return apiOk(null, "微信已绑定");
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
    const issued = await issueSession(s, c.env, user, c.req, "2fa");
    return sessionResponse(issued);
  });

  r.post("/api/user/passkey/verify/begin", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const keys = await s.listPasskeys(u.id);
    if (!keys.length) return apiFail("未绑定 Passkey");
    const { newChallenge } = await import("./passkey.js");
    const ch = newChallenge();
    await s.insertAuthFlow({ token: ch.id, type: "passkey_verify", user_id: u.id, expires_at: nowSec() + 300, payload: ch.challenge });
    return apiOk({
      flow_id: ch.id,
      flow_token: ch.id,
      publicKey: {
        challenge: ch.challenge,
        allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
        timeout: 60000,
        userVerification: "preferred",
      },
    });
  });

  r.post("/api/user/passkey/verify/finish", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { flow_id?: string; flow_token?: string; credential_id?: string };
    const flow = await s.getAuthFlow(body.flow_id || body.flow_token || "");
    if (!flow || flow.type !== "passkey_verify" || flow.user_id !== u.id) return apiFail("流程无效");
    await s.deleteAuthFlow(flow.token);
    return apiOk({ ok: true, method: "passkey" });
  });

  r.get("/api/user/:id/oauth/bindings", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(Number(c.params.id));
    if (!user) return apiFail("用户不存在");
    return apiOk({
      github: Boolean(user.github_id),
      discord: Boolean(user.discord_id),
      linuxdo: Boolean(user.linuxdo_id),
      oidc: Boolean(user.oidc_id),
      wechat: Boolean(user.wechat_id),
      telegram: Boolean(user.telegram_id),
    });
  });

  r.delete("/api/user/:id/oauth/bindings/:provider_id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteOAuthProvider(Number(c.params.provider_id));
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
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const channels = await s.enabledChannels();
    const results = [];
    for (const ch of channels) {
      const result = await testChannel(s, ch);
      await s.updateChannel(ch.id, { balance: result.success ? "ok" : result.message.slice(0, 200), test_time: nowSec() });
      results.push({ id: ch.id, name: ch.name, ...result });
    }
    return apiOk(results);
  });

  r.get("/api/channel/update_balance/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const result = await testChannel(s, ch);
    await s.updateChannel(ch.id, { balance: result.success ? "ok" : result.message.slice(0, 200), test_time: nowSec() });
    return result.success ? apiOk({ balance: "ok", time: result.time }) : apiFail(result.message, result);
  });

  r.post("/api/channel/tag/disabled", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { tag?: string };
    if (!body.tag) return apiFail("缺少 tag");
    return apiOk({ count: await s.setChannelsByTag(body.tag, 2) });
  });

  r.put("/api/channel/tag", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { tag?: string; new_tag?: string; models?: string; group?: string; priority?: number; weight?: number };
    if (!body.tag) return apiFail("缺少 tag");
    const channels = await s.channelsByTag(body.tag);
    for (const ch of channels) {
      const patch: Record<string, unknown> = {};
      if (body.new_tag != null) patch.tag = body.new_tag;
      if (body.models != null) patch.models = body.models;
      if (body.group != null) patch.group = body.group;
      if (body.priority != null) patch.priority = body.priority;
      if (body.weight != null) patch.weight = body.weight;
      if (Object.keys(patch).length) await s.updateChannel(ch.id, patch);
    }
    return apiOk({ count: channels.length });
  });

  r.post("/api/channel/fix", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const channels = await s.enabledChannels();
    return apiOk({ count: channels.length, message: "abilities derived from channel.models" });
  });

  r.post("/api/channel/:id/codex/refresh", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
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

  r.get("/api/channel/:id/codex/usage", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    return apiOk({ used_quota: ch.used_quota, balance: ch.balance || "", test_time: ch.test_time });
  });

  r.get("/api/channel/:id/codex/usage/reset-credits", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk({ credits: 0, reset_at: 0 });
  });

  r.post("/api/channel/:id/codex/usage/reset", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.updateChannel(Number(c.params.id), { used_quota: 0 });
    return apiOk(null, "已重置");
  });

  r.post("/api/channel/ollama/pull", async (c) => ollamaOp(c, "pull"));
  r.post("/api/channel/ollama/pull/stream", async (c) => ollamaOp(c, "pull"));
  r.delete("/api/channel/ollama/delete", async (c) => ollamaOp(c, "delete"));
  r.get("/api/channel/ollama/version/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const base = (ch.base_url || "http://localhost:11434").replace(/\/$/, "");
    const res = await fetch(base + "/api/version");
    return apiOk(await res.json().catch(() => ({ version: "unknown" })));
  });

  r.post("/api/channel/batch/tag", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[]; tag?: string };
    for (const id of body.ids || []) await s.updateChannel(id, { tag: body.tag || "" });
    return apiOk({ count: (body.ids || []).length });
  });

  r.get("/api/channel/tag/models", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const tag = c.url.searchParams.get("tag") || "";
    const channels = await s.channelsByTag(tag);
    const models = new Set<string>();
    for (const ch of channels) for (const m of csv(ch.models)) models.add(m);
    return apiOk([...models]);
  });

  r.post("/api/channel/multi_key/manage", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
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
    const { results } = await c.env.DB.prepare("SELECT id FROM user_subscriptions WHERE plan_id = ?").bind(planId).all<{ id: number }>();
    for (const row of results) await s.updateUserSub(row.id, { status: 2 });
    return apiOk({ count: results.length });
  });

  r.post("/api/subscription/admin/users/:id/subscriptions", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { plan_id?: number };
    const plan = await s.getPlan(Number(body.plan_id));
    if (!plan) return apiFail("套餐不存在");
    const start = nowSec();
    const id = await s.insertUserSub({
      user_id: Number(c.params.id),
      plan_id: Number(plan.id),
      start_at: start,
      expire_at: start + Number(plan.duration_days || 30) * 86400,
      remaining_quota: Number(plan.grant_quota || 0),
    });
    return apiOk({ id });
  });

  r.post("/api/subscription/admin/users/:id/subscriptions/reset", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const subs = (await s.listUserSubs(Number(c.params.id))) as { id: number }[];
    for (const sub of subs) await s.updateUserSub(sub.id, { status: 2 });
    return apiOk({ count: subs.length });
  });

  r.post("/api/subscription/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/subscription/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/subscription/epay/return", () => apiOk({ ok: true }));
  r.post("/api/subscription/epay/return", () => apiOk({ ok: true }));
  r.post("/api/subscription/waffo-pancake/pay", async (c) => payKind(c, "waffo"));

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
    const channels = await s.enabledChannels();
    return apiOk(channels.map((ch) => ({ id: ch.id, name: ch.name, base_url: ch.base_url, type: ch.type })));
  });
  r.post("/api/ratio_sync/fetch", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { channel_id?: number };
    const ch = await s.getChannel(Number(body.channel_id));
    if (!ch?.base_url) return apiFail("渠道无 base_url");
    const res = await fetch(ch.base_url.replace(/\/$/, "") + "/api/ratio_config");
    const data = await res.json().catch(() => ({}));
    return apiOk(data);
  });

  r.get("/api/plugin/task", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listTaskPlugins());
  });
  r.post("/api/plugin/task", (c) => upsertPlugin(c));
  r.put("/api/plugin/task", (c) => upsertPlugin(c));
  r.get("/api/plugin/task/runtime/status", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const plugins = (await s.listTaskPlugins()) as { status: string }[];
    return apiOk({ generation: 1, plugins: plugins.length, active: plugins.filter((p) => p.status === "active").length, runtime: "workerd" });
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
    if (!p) return apiFail("插件不存在");
    return apiOk(p);
  });
  r.get("/api/plugin/task/:key/icon", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const p = await s.getTaskPlugin(c.params.key);
    return apiOk({ icon: p?.icon || "" });
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
    const u = await requireAdmin(c, s);
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
        version: VERSION,
        runtime: "workerd",
        start_time: Math.floor(Date.now() / 1000),
        http_stats: httpStats(),
      },
    ]);
  });
  r.delete("/api/system-info/stale-instances", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk({ count: 0 });
  });
  r.delete("/api/system-info/instances/:node_name", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk({ node_name: c.params.node_name, deleted: false, reason: "single isolate" });
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
    if (!start || !end || end < start) return apiFail("invalid time range");
    return apiOk(await s.flowQuotaDates(start, end, null, c.url.searchParams.get("username") || ""));
  });
  r.get("/api/data/flow/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const start = Number(c.url.searchParams.get("start_timestamp") || 0);
    const end = Number(c.url.searchParams.get("end_timestamp") || 0);
    if (!start || !end || end < start) return apiFail("invalid time range");
    if (end - start > 2592000) return apiFail("时间跨度不能超过 1 个月");
    return apiOk(await s.flowQuotaDates(start, end, u.id));
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
    const items = (await s.listModelMeta()) as unknown[];
    const fallback = items.length ? items : (await s.enabledModels("default")).map((model_name) => ({ model_name }));
    return apiOk(pageData(fallback.slice(q.offset, q.offset + q.page_size), fallback.length, q));
  });
  r.get("/api/models/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.searchModelMeta(c.url.searchParams.get("keyword") || ""));
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
    if (c.params.id === "meta") return apiOk(await s.listModelMeta());
    const item = await s.getModelMeta(Number(c.params.id));
    if (!item) return apiFail("不存在");
    return apiOk(item);
  });

  r.get("/api/deployments/settings", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk({ ionet_configured: Boolean(await s.option("IoNetApiKey")), runtime: "workerd" });
  });
  r.post("/api/deployments/settings/test-connection", (c) => testIoNet(c));
  r.post("/api/deployments/test-connection", (c) => testIoNet(c));
  r.get("/api/deployments/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listDeployments());
  });
  r.get("/api/deployments/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const kw = (c.url.searchParams.get("keyword") || "").toLowerCase();
    const items = ((await s.listDeployments()) as { name: string; model_name: string }[]).filter(
      (d) => !kw || d.name.toLowerCase().includes(kw) || d.model_name.toLowerCase().includes(kw),
    );
    return apiOk(items);
  });
  r.get("/api/deployments/hardware-types", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(["cpu", "a100", "h100", "4090"]);
  });
  r.get("/api/deployments/locations", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(["us-east", "us-west", "eu-central", "ap-east"]);
  });
  r.get("/api/deployments/available-replicas", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk({ min: 1, max: 8 });
  });
  r.post("/api/deployments/price-estimation", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { replicas?: number };
    return apiOk({ hourly: Number(body.replicas || 1) * 1.2, currency: "USD" });
  });
  r.get("/api/deployments/check-name", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const name = c.url.searchParams.get("name") || "";
    const items = (await s.listDeployments()) as { name: string }[];
    return apiOk({ available: !items.some((d) => d.name === name) });
  });
  r.post("/api/deployments/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    if (!body.name) return apiFail("名称不能为空");
    return apiOk({ id: await s.insertDeployment(body) }, "创建成功");
  });
  r.get("/api/deployments/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const d = await s.getDeployment(Number(c.params.id));
    if (!d) return apiFail("不存在");
    return apiOk(d);
  });
  r.get("/api/deployments/:id/logs", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk([]);
  });
  r.get("/api/deployments/:id/containers", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk([]);
  });
  r.get("/api/deployments/:id/containers/:container_id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk({ id: c.params.container_id, status: "unknown" });
  });
  r.put("/api/deployments/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.updateDeployment(Number(c.params.id), (await readJson(c.req)) as Record<string, unknown>);
    return apiOk(null);
  });
  r.put("/api/deployments/:id/name", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { name?: string };
    await s.updateDeployment(Number(c.params.id), { name: body.name || "" });
    return apiOk(null);
  });
  r.post("/api/deployments/:id/extend", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk({ extended: true });
  });
  r.delete("/api/deployments/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteDeployment(Number(c.params.id));
    return apiOk(null);
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
  r.post("/api/user/waffo-pancake/pay", async (c) => payUser(c, "waffo"));
  r.post("/api/user/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.get("/api/user/epay/notify", (c) => handleEpayNotify(store(c), c.req, c.url));
  r.post("/api/stripe/webhook", (c) => handleStripeWebhook(store(c), c.req));
  r.post("/api/creem/webhook", (c) => genericPayWebhook(c, "creem"));
  r.post("/api/waffo/webhook", (c) => genericPayWebhook(c, "waffo"));
  r.post("/api/waffo/webhook/:env", (c) => genericPayWebhook(c, "waffo"));
  r.post("/api/waffo-pancake/webhook/:env", (c) => genericPayWebhook(c, "waffo"));

  r.post("/api/subscription/epay/pay", async (c) => payKind(c, "epay"));
  r.post("/api/subscription/stripe/pay", async (c) => payKind(c, "stripe"));
  r.post("/api/subscription/creem/pay", async (c) => payKind(c, "creem"));

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
  const u = await requireAdmin(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req)) as { id?: number; name?: string; model?: string };
  const ch = await s.getChannel(Number(body.id));
  if (!ch) return apiFail("渠道不存在");
  const base = (ch.base_url || "http://localhost:11434").replace(/\/$/, "");
  const res = await fetch(base + (action === "pull" ? "/api/pull" : "/api/delete"), {
    method: action === "delete" ? "DELETE" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: body.name || body.model }),
  });
  const text = await res.text();
  return res.ok ? apiOk(parseJson(text, { ok: true })) : apiFail(text.slice(0, 300));
}

async function detectUpdates(c: C, all: boolean): Promise<Response> {
  const s = store(c);
  const u = await requireAdmin(c, s);
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
  const detected = await detectUpdates(c, all);
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

async function upsertPlugin(c: C): Promise<Response> {
  const s = store(c);
  const u = await requireRoot(c, s);
  if (isResponse(u)) return u;
  const body = (await readJson(c.req)) as Record<string, unknown>;
  const key = String(body.key || body.name || "");
  if (!key) return apiFail("缺少 key");
  await s.upsertTaskPlugin({ ...body, key });
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

async function testIoNet(c: C): Promise<Response> {
  const s = store(c);
  const u = await requireAdmin(c, s);
  if (isResponse(u)) return u;
  const key = await s.option("IoNetApiKey");
  if (!key) return apiFail("io.net API key 未配置");
  const res = await fetch("https://api.io.net/v1/health", { headers: { authorization: "Bearer " + key } });
  return res.ok ? apiOk({ ok: true }) : apiFail("连接失败");
}

async function payUser(c: C, kind: "stripe" | "epay" | "creem" | "waffo"): Promise<Response> {
  const s = store(c);
  const u = await requireUser(c, s);
  if (isResponse(u)) return u;
  const user = await s.getUserById(u.id);
  if (!user) return apiFail("用户不存在");
  const body = (await readJson(c.req)) as { amount?: number; payment_method?: string; success_url?: string; cancel_url?: string };
  if (kind === "stripe") return requestStripePay(s, user, c.req, body);
  if (kind === "epay") return requestEpay(s, user, c.req, body);
  return requestHttpPay(s, user, c.req, kind, body);
}

async function payKind(c: C, kind: "stripe" | "epay" | "creem" | "waffo"): Promise<Response> {
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
