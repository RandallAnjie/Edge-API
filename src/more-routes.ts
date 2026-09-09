import {
  ROLE_ROOT,
  nowSec,
  parseJson,
  randomHex,
} from "./constants.js";
import {
  generateBackupCodes,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  verifyBackupCode,
  verifyTotp,
} from "./totp.js";
import { mailConfigured, sendMail, sixDigitCode } from "./mail.js";
import { newChallenge, rpFromRequest, verifyAssertion } from "./passkey.js";
import {
  exchangeCustom,
  exchangeDiscord,
  exchangeGithub,
  exchangeLinuxDO,
  exchangeOidc,
  loginOrBindOAuth,
  newAccessToken,
  oauthAuthorizeUrl,
  verifyTelegramLogin,
} from "./oauth.js";
import { generateTokenKey, displayTokenKey } from "./crypto.js";
import { publicToken, verificationRequirements, publicLog, rankingsResponse, exposedRatioConfig } from "./dto.js";
import { registerParity, sessionViews } from "./parity-routes.js";
import { apiFail, apiFailCode, apiOk, clientIp, json, pageData, pageQuery, readJson } from "./http.js";
import type { Context } from "./router.js";
import type { Router } from "./router.js";
import {
  authenticateApiToken,
  currentSid,
  issueSession,
  isResponse,
  requireAdmin,
  requireRoot,
  requireUser,
  sessionResponse,
} from "./auth.js";
import { httpStats } from "./metrics.js";
import { Store, publicUser } from "./store.js";
import { testChannel } from "./relay.js";
import type { Env, UserRow } from "./types.js";

type C = Context<Env>;

function store(c: C): Store {
  return new Store(c.env.DB);
}

export function registerMore(r: Router<Env>): void {
  r.get("/api/user-agreement", async (c) => apiOk(await store(c).option("UserAgreement")));
  r.get("/api/privacy-policy", async (c) => apiOk(await store(c).option("PrivacyPolicy")));

  r.get("/api/status/test", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return json(200, {
      success: true,
      message: "Server is running",
      http_stats: httpStats(),
      data: {
        d1: true,
        kv: Boolean(c.env.KV),
        r2: Boolean(c.env.R2),
        version: (await import("./constants.js")).VERSION,
        users: (await s.counts()).users,
      },
    });
  });

  r.get("/api/rankings", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("RankingsEnabled", true))) return apiFail("排行榜未启用", null, 400);
    const period = c.url.searchParams.get("period") || "week";
    const days = period === "today" ? 1 : period === "month" ? 30 : period === "year" ? 365 : 7;
    const start = Number(c.url.searchParams.get("start_timestamp") || nowSec() - 86400 * days);
    const end = Number(c.url.searchParams.get("end_timestamp") || nowSec());
    return apiOk(rankingsResponse(await s.rankings(start, end)));
  });

  r.get("/api/ratio_config", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("ExposeRatioEnabled", false))) return json(403, { success: false, message: "倍率配置接口未启用" });
    return apiOk(
      exposedRatioConfig({
        model_ratio: parseJson(await s.option("ModelRatio"), {}),
        completion_ratio: parseJson(await s.option("CompletionRatio"), {}),
        cache_ratio: parseJson(await s.option("CacheRatio"), {}),
        create_cache_ratio: parseJson(await s.option("CreateCacheRatio"), {}),
        model_price: parseJson(await s.option("ModelPrice"), {}),
        billing_mode: parseJson(await s.option("billing_setting.billing_mode"), {}),
        billing_expr: parseJson(await s.option("billing_setting.billing_expr"), {}),
      }),
    );
  });

  r.get("/api/verification", async (c) => {
    const s = store(c);
    const email = (c.url.searchParams.get("email") || "").trim();
    if (!email || !email.includes("@")) return apiFail("无效邮箱");
    if (!(await mailConfigured(s))) return apiFail("邮件未配置");
    const code = sixDigitCode();
    await s.insertEmailCode(email, code, "verify");
    await sendMail(s, email, "Edge API 验证码", `<p>您的验证码是 <b>${code}</b>，10 分钟内有效。</p>`);
    return apiOk(null, "验证码已发送");
  });

  r.get("/api/reset_password", async (c) => {
    const s = store(c);
    const email = (c.url.searchParams.get("email") || "").trim();
    if (!email) return apiFail("无效邮箱");
    if (!(await mailConfigured(s))) return apiFail("邮件未配置");
    const user = await s.getUserByEmail(email);
    if (!user) return apiFail("用户不存在");
    const code = sixDigitCode();
    await s.insertEmailCode(email, code, "reset");
    await sendMail(s, email, "Edge API 重置密码", `<p>重置验证码 <b>${code}</b>，10 分钟内有效。</p>`);
    return apiOk(null, "验证码已发送");
  });

  r.post("/api/user/reset", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { email?: string; code?: string; password?: string };
    if (!body.email || !body.code || !body.password) return apiFail("无效的参数");
    if (body.password.length < 8) return apiFail("密码长度必须在 8 到 128 之间");
    if (!(await s.consumeEmailCode(body.email, body.code, "reset"))) return apiFail("验证码无效或已过期");
    const user = await s.getUserByEmail(body.email);
    if (!user) return apiFail("用户不存在");
    const { hashPassword } = await import("./crypto.js");
    await s.updateUser(user.id, { password: await hashPassword(body.password) });
    return apiOk(null, "密码已重置");
  });

  r.post("/api/user/login/2fa", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { flow_token?: string; code?: string };
    if (!body.flow_token || !body.code) return apiFail("无效的参数");
    const flow = await s.getAuthFlow(body.flow_token);
    if (!flow || (flow.type !== "2fa_login" && flow.type !== "login_verify") || flow.expires_at < nowSec()) return apiFail("登录流程已过期");
    const user = await s.getUserById(flow.user_id);
    if (!user) return apiFail("用户不存在");
    const totpOk = await verifyTotp(user.totp_secret || "", body.code);
    const backup = totpOk ? { ok: false, rest: user.totp_backup || "" } : verifyBackupCode(user.totp_backup || "", body.code);
    if (!totpOk && !backup.ok) return apiFail("验证码错误");
    if (backup.ok) await s.updateUser(user.id, { totp_backup: backup.rest });
    await s.deleteAuthFlow(body.flow_token);
    const issued = await issueSession(s, c.env, user, c.req, "2fa");
    await s.audit(user.id, user.username, "login", "Logged in via 2FA", clientIp(c.req));
    return sessionResponse(issued);
  });

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
    const data: Record<string, unknown> = { enabled, locked: false };
    if (enabled) data.backup_codes_remaining = backup.length;
    return apiOk(data);
  });

  r.post("/api/user/2fa/setup", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
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
    });
    const issuer = (await s.option("SystemName")) || "Edge API";
    const qr = otpauthUrl(secret, u.username, issuer);
    return apiOk({
      secret,
      qr_code_data: qr,
      backup_codes: codes,
      flow_token: flowToken,
      expires_at: expiresAt,
      otpauth_url: qr,
    });
  });

  r.post("/api/user/2fa/enable", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { code?: string; flow_token?: string };
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    if (!body.flow_token) return apiFailCode("The two-factor setup has expired or changed. Start setup again.", "TWOFA_SETUP_INVALID");
    const flow = await s.getAuthFlow(body.flow_token);
    if (!flow || flow.type !== "2fa_setup" || flow.user_id !== u.id || flow.expires_at < nowSec()) {
      return apiFailCode("The two-factor setup has expired or changed. Start setup again.", "TWOFA_SETUP_INVALID");
    }
    const payload = parseJson<{ secret?: string; backup_codes?: string[] }>(flow.payload, {});
    const secret = payload.secret || "";
    const codes = payload.backup_codes;
    await s.deleteAuthFlow(body.flow_token);
    if (!secret) return apiFailCode("The two-factor setup has expired or changed. Start setup again.", "TWOFA_SETUP_INVALID");
    if (!(await verifyTotp(secret, body.code || ""))) return apiFail("验证码错误");
    const backup = codes || generateBackupCodes();
    await s.updateUser(u.id, { totp_secret: secret, totp_enabled: 1, totp_backup: backup.join(",") });
    const fresh = await s.getUserById(u.id);
    const issued = await issueSession(s, c.env, fresh || user, c.req, "twofa_enabled");
    issued.data.backup_codes = backup;
    return sessionResponse(issued);
  });

  r.post("/api/user/2fa/disable", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { code?: string };
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const totpOk = await verifyTotp(user.totp_secret || "", body.code || "");
    const backup = verifyBackupCode(user.totp_backup || "", body.code || "");
    if (!totpOk && !backup.ok) return apiFail("验证码错误");
    await s.updateUser(u.id, { totp_enabled: 0, totp_secret: "", totp_backup: "" });
    const fresh = await s.getUserById(u.id);
    const issued = await issueSession(s, c.env, fresh || user, c.req, "twofa_disabled");
    return sessionResponse(issued, 200, "两步验证已禁用");
  });

  r.post("/api/user/2fa/backup_codes", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { code?: string };
    const user = await s.getUserById(u.id);
    if (!user || !(await verifyTotp(user.totp_secret || "", body.code || ""))) return apiFail("验证码错误");
    const codes = generateBackupCodes();
    await s.updateUser(u.id, { totp_backup: codes.join(",") });
    return apiOk({ backup_codes: codes });
  });

  r.get("/api/user/2fa/stats", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const { results } = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE totp_enabled = 1").all<{ c: number }>();
    return apiOk({ enabled_users: Number(results[0]?.c || 0) });
  });

  r.delete("/api/user/:id/2fa", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.updateUser(Number(c.params.id), { totp_enabled: 0, totp_secret: "", totp_backup: "" });
    return apiOk(null);
  });

  r.get("/api/user/sessions", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const sid = await currentSid(c, s);
    return apiOk(sessionViews(await s.listSessions(u.id), sid));
  });

  r.delete("/api/user/sessions/:sid", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    await s.revokeSession(c.params.sid, u.id);
    return apiOk(null);
  });

  r.post("/api/user/sessions/revoke-others", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const sid = await currentSid(c, s);
    await s.revokeOtherSessions(u.id, sid);
    return apiOk(null);
  });

  r.delete("/api/user/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (u.role >= ROLE_ROOT) return apiFail("无法删除超级管理员");
    await s.deleteUser(u.id);
    return apiOk(null, "账号已删除");
  });

  r.get("/api/user/token", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const token = newAccessToken();
    await s.updateUser(u.id, { access_token: token });
    return apiOk({ access_token: token });
  });

  r.post("/api/user/token", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const token = newAccessToken();
    await s.updateUser(u.id, { access_token: token });
    return apiOk({ access_token: token });
  });

  r.get("/api/user/token/status", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    return apiOk({ enabled: Boolean(user?.access_token) });
  });

  r.delete("/api/user/token", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    await s.updateUser(u.id, { access_token: "" });
    return apiOk(null);
  });

  r.get("/api/user/passkey", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const keys = await s.listPasskeys(u.id);
    return apiOk({ enabled: await s.optionBool("PasskeyEnabled", true), credentials: keys.map((k) => ({ id: k.id, name: k.name, created_at: k.created_at })) });
  });

  r.post("/api/user/passkey/register/begin", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiFail("Passkey 未启用");
    const ch = newChallenge();
    const rp = rpFromRequest(c.req);
    await s.insertAuthFlow({ token: ch.id, type: "passkey_reg", user_id: u.id, expires_at: nowSec() + 300, payload: ch.challenge });
    return apiOk({
      flow_id: ch.id,
      publicKey: {
        challenge: ch.challenge,
        rp: { id: rp.rpId, name: rp.name },
        user: { id: String(u.id), name: u.username, displayName: u.display_name || u.username },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60000,
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      },
    });
  });

  r.post("/api/user/passkey/register/finish", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as {
      flow_id?: string;
      credential_id?: string;
      public_key?: string;
      name?: string;
    };
    const flow = await s.getAuthFlow(body.flow_id || "");
    if (!flow || flow.type !== "passkey_reg" || flow.user_id !== u.id) return apiFail("流程无效");
    if (!body.credential_id || !body.public_key) return apiFail("缺少凭证");
    await s.insertPasskey(u.id, body.credential_id, body.public_key, body.name || "passkey");
    await s.deleteAuthFlow(flow.token);
    return apiOk(null, "已绑定 Passkey");
  });

  r.post("/api/user/passkey/login/begin", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { username?: string };
    if (!body.username) return apiFail("无效的参数");
    const user = await s.getUserByUsername(body.username);
    if (!user) return apiFail("用户不存在");
    const keys = await s.listPasskeys(user.id);
    if (!keys.length) return apiFail("未绑定 Passkey");
    const ch = newChallenge();
    await s.insertAuthFlow({ token: ch.id, type: "passkey_login", user_id: user.id, expires_at: nowSec() + 300, payload: ch.challenge });
    return apiOk({
      flow_id: ch.id,
      publicKey: {
        challenge: ch.challenge,
        allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
        timeout: 60000,
        userVerification: "preferred",
      },
    });
  });

  r.post("/api/user/passkey/login/finish", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as {
      flow_id?: string;
      credential_id?: string;
      clientDataJSON?: string;
      authenticatorData?: string;
      signature?: string;
    };
    const flow = await s.getAuthFlow(body.flow_id || "");
    if (!flow || flow.type !== "passkey_login" || flow.expires_at < nowSec()) return apiFail("流程无效");
    const pk = await s.getPasskeyByCred(body.credential_id || "");
    if (!pk || pk.user_id !== flow.user_id) return apiFail("凭证无效");
    const ok = await verifyAssertion({
      publicKeySpki: pk.public_key,
      clientDataJSON: body.clientDataJSON || "",
      authenticatorData: body.authenticatorData || "",
      signature: body.signature || "",
      expectedChallenge: flow.payload,
      expectedOrigin: new URL(c.req.url).origin,
    });
    if (!ok) return apiFail("Passkey 校验失败");
    const user = await s.getUserById(flow.user_id);
    if (!user) return apiFail("用户不存在");
    await s.deleteAuthFlow(flow.token);
    const issued = await issueSession(s, c.env, user, c.req, "passkey");
    return sessionResponse(issued);
  });

  r.post("/api/user/login/passkey/begin", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { username?: string };
    if (!body.username) return apiFail("无效的参数");
    const user = await s.getUserByUsername(body.username);
    if (!user) return apiFail("用户不存在");
    const keys = await s.listPasskeys(user.id);
    if (!keys.length) return apiFail("未绑定 Passkey");
    const ch = newChallenge();
    await s.insertAuthFlow({ token: ch.id, type: "passkey_login", user_id: user.id, expires_at: nowSec() + 300, payload: ch.challenge });
    return apiOk({
      flow_id: ch.id,
      publicKey: {
        challenge: ch.challenge,
        allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
        timeout: 60000,
        userVerification: "preferred",
      },
    });
  });

  r.post("/api/user/login/passkey/finish", async (c) => {
    const req = new Request(new URL("/api/user/passkey/login/finish", c.req.url), {
      method: "POST",
      headers: c.req.headers,
      body: await c.req.text(),
    });
    const res = await r.dispatch({ ...c, req, url: new URL(req.url) });
    return res ?? apiFail("未找到处理程序");
  });

  r.delete("/api/user/passkey", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    await s.deletePasskeys(u.id);
    return apiOk(null);
  });

  r.delete("/api/user/:id/reset_passkey", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deletePasskeys(Number(c.params.id));
    return apiOk(null);
  });

  r.post("/api/user/aff_transfer", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { quota?: number };
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const q = Math.floor(Number(body.quota || 0));
    if (q <= 0) return apiFail("额度无效");
    if ((user.aff_quota || 0) < q) return apiFail("邀请额度不足");
    await s.updateUser(u.id, { aff_quota: (user.aff_quota || 0) - q });
    await s.addQuota(u.id, q);
    return apiOk({ quota: q }, "划转成功");
  });

  r.put("/api/user/setting", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    await s.updateUser(u.id, { settings: JSON.stringify(body) });
    return apiOk(null, "已保存");
  });


  r.get("/api/user/topup/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTopups(u.id, q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/user/topup", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTopups(null, q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.post("/api/user/topup/complete", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { user_id?: number; quota?: number };
    if (!body.user_id) return apiFail("无效的参数");
    await s.addQuota(body.user_id, Number(body.quota || 0));
    await s.insertTopup({ user_id: body.user_id, amount: Number(body.quota || 0), payment_method: "admin" });
    return apiOk(null);
  });

  r.get("/api/user/oauth/bindings", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    return apiOk({
      github: Boolean(user?.github_id),
      discord: Boolean(user?.discord_id),
      linuxdo: Boolean(user?.linuxdo_id),
      oidc: Boolean(user?.oidc_id),
      wechat: Boolean(user?.wechat_id),
      telegram: Boolean(user?.telegram_id),
    });
  });

  r.delete("/api/user/oauth/bindings/:provider_id", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const map: Record<string, string> = {
      github: "github_id",
      discord: "discord_id",
      linuxdo: "linuxdo_id",
      oidc: "oidc_id",
      wechat: "wechat_id",
      telegram: "telegram_id",
    };
    const col = map[c.params.provider_id];
    if (col) {
      await s.updateUser(u.id, { [col]: "" });
      return apiOk(null);
    }
    return apiFail("未知绑定");
  });

  r.post("/api/oauth/state", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { provider?: string; intent?: string; aff?: string };
    const provider = (body.provider || "").trim();
    const intent = (body.intent || "login").trim();
    if (!provider) return apiFail("无效的参数");
    const flow = randomHex(16);
    const expires = nowSec() + 600;
    await s.insertAuthFlow({
      token: flow,
      type: "oauth",
      user_id: 0,
      expires_at: expires,
      payload: JSON.stringify({ provider, intent, aff: body.aff || "" }),
    });
    const origin = new URL(c.req.url).origin;
    const data: Record<string, unknown> = { flow_token: flow, state: flow, expires_at: expires };
    if (provider === "telegram") {
      const token = await s.option("TelegramBotToken");
      const botId = token.split(":")[0] || "";
      const returnTo = `${origin}/api/oauth/telegram`;
      data.authorization_url = `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(botId)}&origin=${encodeURIComponent(origin)}&request_access=write&return_to=${encodeURIComponent(returnTo)}`;
    } else if (provider === "github") {
      data.authorization_url = oauthAuthorizeUrl("github", await s.option("GitHubClientId"), `${origin}/api/oauth/github`) + `&state=${flow}`;
    } else if (provider === "discord") {
      data.authorization_url = oauthAuthorizeUrl("discord", await s.option("DiscordClientId"), `${origin}/api/oauth/discord`) + `&state=${flow}`;
    } else if (provider === "linuxdo") {
      data.authorization_url = oauthAuthorizeUrl("linuxdo", await s.option("LinuxDOClientId"), `${origin}/api/oauth/linuxdo`) + `&state=${flow}`;
    } else if (provider === "oidc") {
      const authUrl = await s.option("OIDCAuthorizationEndpoint");
      const q = new URLSearchParams({
        client_id: await s.option("OIDCClientId"),
        redirect_uri: `${origin}/api/oauth/oidc`,
        response_type: "code",
        scope: "openid profile email",
        state: flow,
      });
      data.authorization_url = `${authUrl}?${q}`;
    } else {
      const custom = await s.getOAuthProvider(provider);
      if (custom) {
        const q = new URLSearchParams({
          client_id: String(custom.client_id),
          redirect_uri: `${origin}/api/oauth/${provider}`,
          response_type: "code",
          scope: String(custom.scopes || "openid profile email"),
          state: flow,
        });
        data.authorization_url = `${custom.auth_url}?${q}`;
      }
    }
    return apiOk(data);
  });

  r.get("/api/oauth/:provider", async (c) => {
    const s = store(c);
    const provider = c.params.provider;
    const origin = new URL(c.req.url).origin;
    const redirect = `${origin}/api/oauth/${provider}`;
    const code = c.url.searchParams.get("code");
    const u = await requireUser(c, s);
    const existing = isResponse(u) ? null : await s.getUserById(u.id);

    try {
      if (provider === "github") {
        if (!(await s.optionBool("GitHubOAuthEnabled", false))) return apiFail("GitHub OAuth 未启用");
        const clientId = await s.option("GitHubClientId");
        if (!code) return Response.redirect(oauthAuthorizeUrl("github", clientId, redirect), 302);
        const profile = await exchangeGithub(clientId, await s.option("GitHubClientSecret"), code);
        return loginOrBindOAuth(s, c.env, c.req, profile, existing);
      }
      if (provider === "discord") {
        if (!(await s.optionBool("DiscordOAuthEnabled", false))) return apiFail("Discord OAuth 未启用");
        const clientId = await s.option("DiscordClientId");
        if (!code) return Response.redirect(oauthAuthorizeUrl("discord", clientId, redirect), 302);
        const profile = await exchangeDiscord(clientId, await s.option("DiscordClientSecret"), code, redirect);
        return loginOrBindOAuth(s, c.env, c.req, profile, existing);
      }
      if (provider === "linuxdo") {
        if (!(await s.optionBool("LinuxDOOAuthEnabled", false))) return apiFail("LinuxDO OAuth 未启用");
        const clientId = await s.option("LinuxDOClientId");
        if (!code) return Response.redirect(oauthAuthorizeUrl("linuxdo", clientId, redirect), 302);
        const profile = await exchangeLinuxDO(clientId, await s.option("LinuxDOClientSecret"), code, redirect);
        return loginOrBindOAuth(s, c.env, c.req, profile, existing);
      }
      if (provider === "oidc") {
        if (!(await s.optionBool("OIDCAuthEnabled", false))) return apiFail("OIDC 未启用");
        const clientId = await s.option("OIDCClientId");
        const authUrl = await s.option("OIDCAuthorizationEndpoint");
        if (!code) {
          const q = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirect,
            response_type: "code",
            scope: "openid profile email",
          });
          return Response.redirect(`${authUrl}?${q}`, 302);
        }
        const profile = await exchangeOidc({
          tokenUrl: await s.option("OIDCTokenEndpoint"),
          userInfoUrl: await s.option("OIDCUserinfoEndpoint"),
          clientId,
          secret: await s.option("OIDCClientSecret"),
          code,
          redirect,
        });
        return loginOrBindOAuth(s, c.env, c.req, profile, existing);
      }
      if (provider === "telegram") {
        if (!(await s.optionBool("TelegramOAuthEnabled", false))) return apiFail("Telegram 未启用");
        if (!c.url.searchParams.get("hash") && !c.url.searchParams.get("id")) {
          const token = await s.option("TelegramBotToken");
          if (!token) return apiFail("Telegram 未配置");
          const botId = token.split(":")[0] || "";
          const url = `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(botId)}&origin=${encodeURIComponent(origin)}&request_access=write&return_to=${encodeURIComponent(redirect)}`;
          return Response.redirect(url, 302);
        }
        const profile = await verifyTelegramLogin(s, c.url.searchParams);
        return loginOrBindOAuth(s, c.env, c.req, profile, existing);
      }
      if (provider === "wechat") {
        return apiFail("请使用 /api/oauth/wechat");
      }
      const custom = await s.getOAuthProvider(provider);
      if (!custom || !Number(custom.enabled)) return apiFail("未知的 OAuth 提供商");
      if (!code) {
        const q = new URLSearchParams({
          client_id: String(custom.client_id),
          redirect_uri: redirect,
          response_type: "code",
          scope: String(custom.scopes || "openid"),
        });
        return Response.redirect(`${custom.auth_url}?${q}`, 302);
      }
      const profile = await exchangeCustom(custom, code, redirect);
      return loginOrBindOAuth(s, c.env, c.req, profile, existing);
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.get("/api/token/search", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTokens(u.id, q.offset, q.page_size, c.url.searchParams.get("keyword") || "");
    return apiOk(pageData(items.map(publicToken), total, q));
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
    const body = (await readJson(c.req)) as { ids?: number[] };
    const n = await s.deleteTokensBatch(u.id, body.ids || []);
    return apiOk({ count: n });
  });

  r.post("/api/token/batch/keys", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    const keys: { id: number; key: string }[] = [];
    for (const id of body.ids || []) {
      const t = await s.getTokenById(id, u.id);
      if (t) keys.push({ id, key: displayTokenKey(t.key) });
    }
    return apiOk(keys);
  });

  r.get("/api/channel/test", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const channels = await s.enabledChannels();
    const results = [];
    for (const ch of channels) results.push({ id: ch.id, name: ch.name, ...(await testChannel(s, ch)) });
    return apiOk(results);
  });

  r.post("/api/channel/batch", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    const n = await s.deleteChannelsBatch(body.ids || []);
    return apiOk({ count: n });
  });

  r.post("/api/channel/tag/enabled", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { tag?: string; status?: number };
    if (!body.tag) return apiFail("缺少 tag");
    const n = await s.setChannelsByTag(body.tag, Number(body.status ?? 1));
    return apiOk({ count: n });
  });

  r.post("/api/channel/:id/update_balance", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const result = await testChannel(s, ch);
    await s.updateChannel(ch.id, { balance: result.success ? "ok" : result.message.slice(0, 200), test_time: nowSec() });
    return result.success ? apiOk({ balance: "ok", time: result.time }) : apiFail(result.message, result);
  });

  r.get("/api/redemption/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listRedemptions(q.offset, q.page_size, c.url.searchParams.get("keyword") || "");
    return apiOk(pageData(items, total, q));
  });

  r.post("/api/redemption/batch", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    return apiOk({ count: await s.deleteRedemptionsBatch(body.ids || []) });
  });

  r.delete("/api/redemption/invalid", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk({ count: await s.deleteInvalidRedemptions() });
  });

  r.get("/api/usage/token", tokenUsage);
  r.get("/api/usage/token/", tokenUsage);

  r.get("/api/log/token", async (c) => {
    const s = store(c);
    const auth = await authenticateApiToken(c, s);
    if (auth instanceof Response) return auth;
    const q = pageQuery(c.url);
    const { items } = await s.listLogs({
      offset: q.offset,
      limit: q.page_size,
      userId: auth.user.id,
      tokenName: auth.token.name,
    });
    return apiOk(items.map((row) => publicLog(row, 1)));
  });

  r.get("/api/subscription/plans", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listPlans(true));
  });

  r.get("/api/subscription/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listUserSubs(u.id));
  });

  r.put("/api/subscription/self/preference", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { billing_preference?: string };
    await s.updateUser(u.id, { billing_preference: body.billing_preference || "quota" });
    return apiOk(null);
  });

  r.post("/api/subscription/balance/pay", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { plan_id?: number };
    const plan = await s.getPlan(Number(body.plan_id));
    if (!plan || Number(plan.enabled) !== 1) return apiFail("套餐不可用");
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const price = Number(plan.price_quota || 0);
    if (user.quota < price) return apiFail("余额不足");
    await s.addQuota(u.id, -price);
    const grant = Number(plan.grant_quota || 0);
    if (grant) await s.addQuota(u.id, grant);
    const start = nowSec();
    const expire = start + Number(plan.duration_days || 30) * 86400;
    const id = await s.insertUserSub({
      user_id: u.id,
      plan_id: Number(plan.id),
      start_at: start,
      expire_at: expire,
      remaining_quota: grant,
    });
    await s.insertTopup({ user_id: u.id, amount: grant, payment_method: "subscription", trade_no: String(id) });
    return apiOk({ id, expire_at: expire }, "订阅成功");
  });

  r.get("/api/subscription/admin/plans", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listPlans(false));
  });

  r.post("/api/subscription/admin/plans", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const id = await s.insertPlan(body);
    return apiOk({ id }, "创建成功");
  });

  r.put("/api/subscription/admin/plans/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ["title", "description", "price_quota", "duration_days", "grant_quota", "group", "models", "enabled"]) {
      if (body[k] != null) patch[k] = body[k];
    }
    await s.updatePlan(Number(c.params.id), patch);
    return apiOk(null);
  });

  r.patch("/api/subscription/admin/plans/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { enabled?: number };
    await s.updatePlan(Number(c.params.id), { enabled: Number(body.enabled) });
    return apiOk(null);
  });

  r.post("/api/subscription/admin/bind", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { user_id?: number; plan_id?: number };
    const plan = await s.getPlan(Number(body.plan_id));
    if (!plan) return apiFail("套餐不存在");
    const start = nowSec();
    const id = await s.insertUserSub({
      user_id: Number(body.user_id),
      plan_id: Number(plan.id),
      start_at: start,
      expire_at: start + Number(plan.duration_days || 30) * 86400,
      remaining_quota: Number(plan.grant_quota || 0),
    });
    return apiOk({ id });
  });

  r.get("/api/subscription/admin/users/:id/subscriptions", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listUserSubs(Number(c.params.id)));
  });

  r.post("/api/subscription/admin/user_subscriptions/:id/invalidate", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.updateUserSub(Number(c.params.id), { status: 2 });
    return apiOk(null);
  });

  r.delete("/api/subscription/admin/user_subscriptions/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteUserSub(Number(c.params.id));
    return apiOk(null);
  });

  r.get("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listPrefill());
  });

  r.post("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { name?: string; type?: string; items?: string };
    const id = await s.insertPrefill(body.name || "", body.type || "", body.items || "");
    return apiOk({ id });
  });

  r.put("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number };
    if (!body.id) return apiFail("无效的参数");
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "type", "items"]) if (body[k] != null) patch[k] = body[k];
    await s.updatePrefill(body.id, patch);
    return apiOk(null);
  });

  r.delete("/api/prefill_group/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deletePrefill(Number(c.params.id));
    return apiOk(null);
  });

  r.get("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listVendors());
  });

  r.get("/api/vendors/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const kw = (c.url.searchParams.get("keyword") || "").toLowerCase();
    const items = ((await s.listVendors()) as { name: string }[]).filter((v) => !kw || v.name.toLowerCase().includes(kw));
    return apiOk(items);
  });

  r.get("/api/vendors/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const v = await s.getVendor(Number(c.params.id));
    if (!v) return apiFail("不存在");
    return apiOk(v);
  });

  r.post("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { name?: string; description?: string; icon?: string };
    if (!body.name) return apiFail("名称不能为空");
    return apiOk({ id: await s.insertVendor(body.name, body.description, body.icon) });
  });

  r.put("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number };
    if (!body.id) return apiFail("无效的参数");
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "description", "icon"]) if (body[k] != null) patch[k] = body[k];
    await s.updateVendor(body.id, patch);
    return apiOk(null);
  });

  r.delete("/api/vendors/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteVendor(Number(c.params.id));
    return apiOk(null);
  });

  r.get("/api/models/meta", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const meta = await s.listModelMeta();
    if (meta.length) return apiOk(meta);
    return apiOk((await s.enabledModels("default")).map((model_name) => ({ model_name })));
  });

  r.post("/api/models/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { model_name?: string; description?: string; vendor_id?: number };
    if (!body.model_name) return apiFail("无效的参数");
    return apiOk({ id: await s.insertModelMeta(body.model_name, body.description, Number(body.vendor_id || 0)) });
  });

  r.put("/api/models/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number };
    if (!body.id) return apiFail("无效的参数");
    await s.updateModelMeta(body.id, body);
    return apiOk(null);
  });

  r.delete("/api/models/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteModelMeta(Number(c.params.id));
    return apiOk(null);
  });

  r.get("/api/task", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTasks(null, q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/task/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTasks(u.id, q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/conversations", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(await s.listConversations(u.id));
  });

  r.post("/api/conversations", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { title?: string; model?: string };
    const id = await s.insertConversation(u.id, body.title || "新对话", body.model || "");
    return apiOk({ id });
  });

  r.get("/api/conversations/:id", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const conv = await s.getConversation(Number(c.params.id), u.id);
    if (!conv) return apiFail("对话不存在");
    const messages = await s.listMessages(Number(c.params.id));
    return apiOk({ ...conv, messages });
  });

  r.put("/api/conversations/:id", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { title?: string; model?: string };
    const patch: Record<string, unknown> = {};
    if (body.title != null) patch.title = body.title;
    if (body.model != null) patch.model = body.model;
    await s.updateConversation(Number(c.params.id), u.id, patch);
    return apiOk(null);
  });

  r.delete("/api/conversations/:id", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    await s.deleteConversation(Number(c.params.id), u.id);
    return apiOk(null);
  });

  r.post("/api/conversations/:id/messages", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const conv = await s.getConversation(Number(c.params.id), u.id);
    if (!conv) return apiFail("对话不存在");
    const body = (await readJson(c.req)) as { role?: string; content?: string };
    const id = await s.insertMessage(Number(c.params.id), body.role || "user", body.content || "");
    await s.updateConversation(Number(c.params.id), u.id, {});
    return apiOk({ id });
  });

  r.get("/api/custom-oauth-provider/", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const items = (await s.listOAuthProviders()) as Record<string, unknown>[];
    return apiOk(items.map((p) => ({ ...p, client_secret: "" })));
  });

  r.post("/api/custom-oauth-provider/", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    if (!body.slug) return apiFail("缺少 slug");
    return apiOk({ id: await s.insertOAuthProvider(body) });
  });

  r.put("/api/custom-oauth-provider/:id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.updateOAuthProvider(Number(c.params.id), (await readJson(c.req)) as Record<string, unknown>);
    return apiOk(null);
  });

  r.delete("/api/custom-oauth-provider/:id", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.deleteOAuthProvider(Number(c.params.id));
    return apiOk(null);
  });

  r.get("/api/option/model_pricing", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    return apiOk({
      ModelRatio: await s.option("ModelRatio"),
      CompletionRatio: await s.option("CompletionRatio"),
      GroupRatio: await s.option("GroupRatio"),
    });
  });

  r.patch("/api/option/model_pricing", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    for (const k of ["ModelRatio", "CompletionRatio", "GroupRatio"]) {
      if (body[k] != null) await s.setOption(k, typeof body[k] === "string" ? String(body[k]) : JSON.stringify(body[k]));
    }
    return apiOk(null);
  });

  r.post("/api/option/rest_model_ratio", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.setOption("ModelRatio", "{}");
    await s.setOption("CompletionRatio", "{}");
    return apiOk(null, "已重置");
  });

  r.get("/api/verify/methods", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const scope = c.url.searchParams.get("scope") || "";
    const reqs = await verificationRequirements(s, user, scope);
    if (!reqs.ok) return apiFailCode(reqs.message, reqs.code, reqs.status);
    return apiOk(reqs.data);
  });

  r.post("/api/verify", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { method?: string; scope?: string; code?: string; password?: string };
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const method = body.method === "totp" ? "2fa" : body.method || "";
    const scope = body.scope || "";
    const reqs = await verificationRequirements(s, user, scope);
    if (!reqs.ok) return apiFailCode(reqs.message, reqs.code, reqs.status);
    const methods = (reqs.data.methods as { method: string; available: boolean }[]) || [];
    if (!methods.some((m) => m.method === method && m.available)) {
      return apiFailCode("This verification method is not allowed for this action.", "SECURITY_PROOF_METHOD_MISMATCH");
    }
    if (method === "2fa") {
      const totpOk = await verifyTotp(user.totp_secret || "", body.code || "");
      const backup = totpOk ? { ok: false, rest: user.totp_backup || "" } : verifyBackupCode(user.totp_backup || "", body.code || "");
      if (!totpOk && !backup.ok) return apiFailCode("Verification failed.", "SECURITY_VERIFICATION_FAILED");
      if (backup.ok) await s.updateUser(user.id, { totp_backup: backup.rest });
    } else if (method === "password") {
      const { verifyPassword } = await import("./crypto.js");
      if (!(await verifyPassword(body.password || "", user.password))) {
        return apiFailCode("Verification failed.", "SECURITY_VERIFICATION_FAILED");
      }
    } else if (method === "passkey" || method === "oauth") {
      return apiFailCode("Verification flow required.", "SECURITY_VERIFICATION_FLOW_REQUIRED", 400);
    } else {
      return apiFailCode("This verification method is not allowed for this action.", "SECURITY_PROOF_METHOD_MISMATCH");
    }
    const proof = randomHex(24);
    const expires = nowSec() + 300;
    await s.insertAuthFlow({
      token: proof,
      type: "security_proof",
      user_id: u.id,
      expires_at: expires,
      payload: JSON.stringify({ method, scope }),
    });
    return apiOk({ proof_token: proof, expires_at: expires, method, scope, ok: true });
  });

  registerParity(r);

  void totpCode;
  void generateTokenKey;
  void publicUser;
}

async function tokenUsage(c: C): Promise<Response> {
  const s = store(c);
  const auth = await authenticateApiToken(c, s);
  if (auth instanceof Response) return auth;
  const remain = Number(auth.token.remain_quota || 0);
  const used = Number(auth.token.used_quota || 0);
  const expiredAt = auth.token.expired_time === -1 ? 0 : auth.token.expired_time;
  const limits = String(auth.token.model_limits || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const modelLimits: Record<string, boolean> = {};
  for (const m of limits) modelLimits[m] = true;
  return json(200, {
    success: true,
    code: true,
    message: "ok",
    data: {
      object: "token_usage",
      name: auth.token.name,
      total_granted: remain + used,
      total_used: used,
      total_available: remain,
      unlimited_quota: Boolean(auth.token.unlimited_quota),
      model_limits: modelLimits,
      model_limits_enabled: Boolean(auth.token.model_limits_enabled),
      expires_at: expiredAt,
    },
  });
}
