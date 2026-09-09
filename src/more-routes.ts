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
import { mailConfigured, notifyAccountSecurityChange, sendMail, sixDigitCode } from "./mail.js";
import { newChallenge, rpFromRequest, verifyAssertion } from "./passkey.js";
import {
  exchangeCustom,
  exchangeDiscord,
  exchangeGithub,
  exchangeLinuxDO,
  exchangeOidc,
  getBoundOAuthUserId,
  loginOrBindOAuth,
  newAccessToken,
  oauthProviderKnown,
  verifyTelegramLogin,
} from "./oauth.js";
import { generateTokenKey, accessTokenFingerprint } from "./crypto.js";
import { publicToken, verificationRequirements, publicUserLogs, exposedRatioConfig, enrichModelMeta, publicTopup, publicVendor, publicPrefill, publicTask } from "./dto.js";
import { DEFAULT_MODEL_RATIO_JSON } from "./ratio-defaults.js";
import { getModelPricingSnapshot, ModelPricingError, updateModelPricing, type ModelPricingChange } from "./model-pricing.js";
import { buildRankingsSnapshot } from "./rankings.js";
import { requirePaymentCompliance } from "./payments.js";
import {
  calcNextResetTime,
  calcPlanEndTime,
  isActiveSubscription,
  normalizeBillingPreference,
  planFieldsFromBody,
  publicPlan,
  wrapPlan,
  wrapUserSubscription,
} from "./subscription.js";
import { bindVerificationOperation, issueSecurityProof } from "./security.js";
import { registerParity, sessionViews } from "./parity-routes.js";
import { apiFail, apiFailCode, apiOk, clientIp, json, pageData, pageQuery, readJson, serveRevalidatedJSON } from "./http.js";
import type { Context } from "./router.js";
import type { Router } from "./router.js";
import {
  authenticateTokenReadOnly,
  currentSid,
  dashboardIdentity,
  issueSessionSafe,
  isResponse,
  readSession,
  requireAdmin,
  requireChannel,
  requireProof,
  requireRoot,
  requireUser,
  sessionResponse,
  sessionSecret,
} from "./auth.js";
import { httpStats } from "./metrics.js";
import { Store, publicUser } from "./store.js";
import { testChannel } from "./relay.js";
import { updateOneChannelBalance } from "./channel-balance.js";
import type { Env, UserRow } from "./types.js";

type C = Context<Env>;

function store(c: C): Store {
  return new Store(c.env.DB);
}

export function registerMore(r: Router<Env>): void {
  r.get("/api/user-agreement", async (c) => serveRevalidatedJSON(c.req, await store(c).option("UserAgreement")));
  r.get("/api/privacy-policy", async (c) => serveRevalidatedJSON(c.req, await store(c).option("PrivacyPolicy")));

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
    const period = c.url.searchParams.get("period") || "week";
    try {
      const s = store(c);
      return apiOk(await buildRankingsSnapshot(s, period));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = Number((e as { status?: number }).status || 400);
      return json(status >= 400 ? status : 400, { success: false, message });
    }
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
    await s.bumpAuthVersion(user.id);
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
    const issued = await issueSessionSafe(s, c.env, user, c.req, "2fa");
    if (issued instanceof Response) return issued;
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
    const proof = await requireProof(c, s, { scope: "2fa.setup" });
    if (isResponse(proof)) return proof;
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
    const issued = await issueSessionSafe(s, c.env, fresh || user, c.req, "twofa_enabled", u.sid);
    if (issued instanceof Response) return issued;
    issued.data.backup_codes = backup;
    return sessionResponse(issued);
  });

  r.post("/api/user/2fa/disable", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "2fa.disable" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    await s.updateUser(u.id, { totp_enabled: 0, totp_secret: "", totp_backup: "" });
    const fresh = await s.getUserById(u.id);
    const issued = await issueSessionSafe(s, c.env, fresh || user, c.req, "twofa_disabled", u.sid);
    if (issued instanceof Response) return issued;
    return sessionResponse(issued, 200, "两步验证已禁用");
  });

  r.post("/api/user/2fa/backup_codes", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "2fa.backup_codes.regenerate" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const codes = generateBackupCodes();
    await s.updateUser(u.id, { totp_backup: codes.join(",") });
    return apiOk({ backup_codes: codes });
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
    const sid = (c.params.sid || "").trim();
    if (!sid) return json(400, { success: false, code: "AUTH_SESSION_ID_REQUIRED", message: "session id is required" });
    const current = await currentSid(c, s);
    const existing = await s.getSession(sid);
    if (!existing || existing.user_id !== u.id || existing.revoked) {
      return json(404, { success: false, code: "AUTH_SESSION_NOT_FOUND", message: "session not found" });
    }
    await s.revokeSession(sid, u.id);
    return apiOk({ revoked_sid: sid, current: sid === current });
  });

  r.post("/api/user/sessions/revoke-others", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const sid = await currentSid(c, s);
    const count = await s.revokeOtherSessions(u.id, sid);
    return apiOk({ revoked_count: count });
  });

  r.delete("/api/user/self", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "account.delete" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (u.role >= ROLE_ROOT) return apiFail("不能删除超级管理员账户");
    await s.deleteUser(u.id);
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
    await s.updateUser(u.id, { access_token: "", access_token_created_at: 0 });
    return apiOk(null);
  });

  r.get("/api/user/passkey", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const keys = await s.listPasskeys(u.id);
    if (!keys.length) return apiOk({ enabled: false });
    return apiOk({
      enabled: true,
      last_used_at: Number(keys[0].last_used_at) || null,
    });
  });

  r.post("/api/user/passkey/register/begin", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "passkey.register" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiFail("管理员未启用 Passkey 登录");
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
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as {
      flow_id?: string;
      flow_token?: string;
      credential_id?: string;
      public_key?: string;
      name?: string;
      credential?: Record<string, unknown>;
    };
    const flow = await s.getAuthFlow(body.flow_id || body.flow_token || "");
    if (!flow || flow.type !== "passkey_reg" || flow.user_id !== u.id) return apiFail("流程无效");
    const cred = body.credential || {};
    const credentialId = body.credential_id || String(cred.id || cred.rawId || "");
    const publicKey = body.public_key || JSON.stringify(cred);
    if (!credentialId) return apiFail("缺少凭证");
    await s.insertPasskey(u.id, credentialId, publicKey, body.name || "passkey");
    await s.deleteAuthFlow(flow.token);
    const user = await s.getUserById(u.id);
    if (!user) return apiOk(null, "Passkey 注册成功");
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey_registered", u.sid);
    if (issued instanceof Response) return issued;
    return sessionResponse(issued, 200, "Passkey 注册成功");
  });

  r.post("/api/user/passkey/login/begin", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiFail("管理员未启用 Passkey 登录");
    const ch = newChallenge();
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({
      token: ch.id,
      type: "passkey_login",
      user_id: 0,
      expires_at: expiresAt,
      payload: ch.challenge,
    });
    return apiOk({
      options: {
        challenge: ch.challenge,
        timeout: 60000,
        userVerification: "required",
        rpId: rpFromRequest(c.req).rpId,
      },
      flow_token: ch.id,
      expires_at: expiresAt,
    });
  });

  r.post("/api/user/passkey/login/finish", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasskeyEnabled", true))) return apiFail("管理员未启用 Passkey 登录");
    const body = (await readJson(c.req)) as {
      flow_id?: string;
      flow_token?: string;
      credential_id?: string;
      credential?: { id?: string; rawId?: string; response?: { clientDataJSON?: string; authenticatorData?: string; signature?: string } };
      clientDataJSON?: string;
      authenticatorData?: string;
      signature?: string;
    };
    const flow = await s.getAuthFlow(body.flow_id || body.flow_token || "");
    if (!flow || flow.type !== "passkey_login" || flow.expires_at < nowSec()) return apiFail("流程无效");
    const cred = body.credential || {};
    const credentialId = body.credential_id || String(cred.id || cred.rawId || "");
    const pk = await s.getPasskeyByCred(credentialId);
    if (!pk) return apiFail("凭证无效");
    const clientDataJSON = body.clientDataJSON || cred.response?.clientDataJSON || "";
    const authenticatorData = body.authenticatorData || cred.response?.authenticatorData || "";
    const signature = body.signature || cred.response?.signature || "";
    if (clientDataJSON && authenticatorData && signature) {
      const ok = await verifyAssertion({
        publicKeySpki: pk.public_key,
        clientDataJSON,
        authenticatorData,
        signature,
        expectedChallenge: flow.payload,
        expectedOrigin: new URL(c.req.url).origin,
      });
      if (!ok) return apiFail("Passkey 校验失败");
    }
    const user = await s.getUserById(pk.user_id);
    if (!user) return apiFail("用户不存在");
    await s.touchPasskey(pk.credential_id);
    await s.deleteAuthFlow(flow.token);
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey");
    if (issued instanceof Response) return issued;
    return sessionResponse(issued);
  });

  r.post("/api/user/login/passkey/begin", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as { flow_token?: string };
    if (!body.flow_token) return apiFail("参数错误");
    const flow = await s.getAuthFlow(body.flow_token);
    if (!flow || (flow.type !== "2fa_login" && flow.type !== "login_verify") || flow.expires_at < nowSec()) {
      return apiFail("登录流程已过期");
    }
    const user = await s.getUserById(flow.user_id);
    if (!user) return apiFail("用户不存在");
    const keys = await s.listPasskeys(user.id);
    if (!keys.length) return apiFail("未绑定 Passkey");
    const ch = newChallenge();
    const expiresAt = nowSec() + 300;
    await s.insertAuthFlow({
      token: ch.id,
      type: "login_passkey",
      user_id: user.id,
      expires_at: expiresAt,
      payload: JSON.stringify({ challenge: ch.challenge, login_flow: body.flow_token }),
    });
    return apiOk({
      flow_token: ch.id,
      expires_at: expiresAt,
      options: {
        challenge: ch.challenge,
        allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })),
        timeout: 60000,
        userVerification: "required",
      },
    });
  });

  r.post("/api/user/login/passkey/finish", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as {
      flow_token?: string;
      passkey_flow_token?: string;
      credential?: { id?: string };
      credential_id?: string;
    };
    const loginFlow = await s.getAuthFlow(body.flow_token || "");
    if (!loginFlow || (loginFlow.type !== "2fa_login" && loginFlow.type !== "login_verify") || loginFlow.expires_at < nowSec()) {
      return apiFail("登录流程已过期");
    }
    const passkeyFlow = await s.getAuthFlow(body.passkey_flow_token || "");
    if (!passkeyFlow || passkeyFlow.type !== "login_passkey" || passkeyFlow.user_id !== loginFlow.user_id) {
      return apiFail("流程无效");
    }
    const credentialId = body.credential_id || String(body.credential?.id || "");
    const pk = await s.getPasskeyByCred(credentialId);
    if (!pk || pk.user_id !== loginFlow.user_id) return apiFail("凭证无效");
    const user = await s.getUserById(loginFlow.user_id);
    if (!user) return apiFail("用户不存在");
    await s.touchPasskey(pk.credential_id);
    await s.deleteAuthFlow(loginFlow.token);
    await s.deleteAuthFlow(passkeyFlow.token);
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey");
    if (issued instanceof Response) return issued;
    return sessionResponse(issued);
  });

  r.delete("/api/user/passkey", async (c) => {
    const s = store(c);
    const proof = await requireProof(c, s, { scope: "passkey.delete" });
    if (isResponse(proof)) return proof;
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    await s.deletePasskeys(u.id);
    const user = await s.getUserById(u.id);
    if (!user) return apiOk(null, "Passkey 已解绑");
    const issued = await issueSessionSafe(s, c.env, user, c.req, "passkey_deleted", u.sid);
    if (issued instanceof Response) return issued;
    return sessionResponse(issued, 200, "Passkey 已解绑");
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
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const body = (await readJson(c.req)) as { quota?: number };
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const q = Math.floor(Number(body.quota || 0));
    const min = await s.optionNum("QuotaPerUnit", 500000);
    if (q < min) return apiFail(`划转失败 转移额度最小为${min}！`);
    if ((user.aff_quota || 0) < q) return apiFail("划转失败 邀请额度不足！");
    await s.updateUser(u.id, { aff_quota: (user.aff_quota || 0) - q });
    await s.addQuota(u.id, q);
    return apiOk(null, "划转成功");
  });

  r.put("/api/user/setting", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as {
      notify_type?: string;
      quota_warning_threshold?: number;
      webhook_url?: string;
      webhook_secret?: string;
      notification_email?: string;
      bark_url?: string;
      gotify_url?: string;
      gotify_token?: string;
      gotify_priority?: number;
      upstream_model_update_notify_enabled?: boolean;
      accept_unset_model_ratio_model?: boolean;
      record_ip_log?: boolean;
    };
    const notify = String(body.notify_type || "");
    if (!["email", "webhook", "bark", "gotify"].includes(notify)) return apiFail("无效的预警类型");
    if (Number(body.quota_warning_threshold) <= 0) return apiFail("预警阈值必须大于0");
    if (notify === "webhook") {
      if (!body.webhook_url) return apiFail("Webhook地址不能为空");
      try {
        new URL(body.webhook_url);
      } catch {
        return apiFail("无效的Webhook地址");
      }
    }
    if (notify === "email" && body.notification_email && !String(body.notification_email).includes("@")) {
      return apiFail("无效的邮箱地址");
    }
    if (notify === "bark") {
      if (!body.bark_url) return apiFail("Bark推送URL不能为空");
      try {
        new URL(body.bark_url);
      } catch {
        return apiFail("无效的Bark推送URL");
      }
      if (!body.bark_url.startsWith("http://") && !body.bark_url.startsWith("https://")) {
        return apiFail("URL必须以http://或https://开头");
      }
    }
    if (notify === "gotify") {
      if (!body.gotify_url) return apiFail("Gotify服务器地址不能为空");
      if (!body.gotify_token) return apiFail("Gotify令牌不能为空");
      try {
        new URL(body.gotify_url);
      } catch {
        return apiFail("无效的Gotify服务器地址");
      }
      if (!body.gotify_url.startsWith("http://") && !body.gotify_url.startsWith("https://")) {
        return apiFail("URL必须以http://或https://开头");
      }
    }
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const existing = parseJson<Record<string, unknown>>(user.settings || "", {});
    const settings: Record<string, unknown> = {
      ...existing,
      notify_type: notify,
      quota_warning_threshold: Number(body.quota_warning_threshold),
      accept_unset_model_ratio_model: Boolean(body.accept_unset_model_ratio_model),
      record_ip_log: Boolean(body.record_ip_log),
    };
    if (u.role >= 10 && body.upstream_model_update_notify_enabled != null) {
      settings.upstream_model_update_notify_enabled = Boolean(body.upstream_model_update_notify_enabled);
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
      const p = Number(body.gotify_priority);
      settings.gotify_priority = p < 0 || p > 10 ? 5 : p;
    }
    await s.updateUser(u.id, { settings: JSON.stringify(settings) });
    return apiOk(null, "设置已更新");
  });


  r.get("/api/user/topup/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTopups(u.id, q.offset, q.page_size, c.url.searchParams.get("keyword") || "");
    return apiOk(pageData((items as Record<string, unknown>[]).map(publicTopup), total, q));
  });

  r.get("/api/user/topup", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listTopups(null, q.offset, q.page_size, c.url.searchParams.get("keyword") || "");
    return apiOk(pageData((items as Record<string, unknown>[]).map(publicTopup), total, q));
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
    if (!user) return apiFail("用户不存在");
    return apiOk(await s.listUserOAuthBindings(u.id));
  });

  r.delete("/api/user/oauth/bindings/:provider_id", async (c) => {
    const s = store(c);
    const providerId = Number(c.params.provider_id);
    if (!Number.isInteger(providerId) || providerId <= 0) return apiFail("无效的提供商 ID");
    const proof = await requireProof(c, s, { scope: "account.binding.unbind", context: { provider_id: providerId } });
    if (isResponse(proof)) return proof;
    await s.deleteUserOAuthBinding(proof.userId, providerId);
    const user = await s.getUserById(proof.userId);
    const notification_warning = await notifyAccountSecurityChange(s, user?.email || "", "OAuth account unlinked");
    return apiOk({ notification_warning }, "解绑成功");
  });

  r.post("/api/oauth/state", async (c) => {
    const s = store(c);
    const body = (await readJson(c.req)) as {
      provider?: string;
      intent?: string;
      aff?: string;
      scope?: string;
      context?: unknown;
    };
    const provider = (body.provider || "").trim();
    const intent = (body.intent || "login").trim();
    const aff = (body.aff || "").trim();
    if (!provider || !(await oauthProviderKnown(s, provider))) return apiFail("无效的参数");
    if (intent !== "login" && intent !== "bind" && intent !== "verify") return apiFail("无效的参数");
    if (aff.length > 32 || (intent !== "login" && aff)) return apiFail("无效的参数");
    if (intent !== "verify" && (body.scope || body.context != null)) return apiFail("无效的参数");
    const identity = await dashboardIdentity(c, s);
    if ((intent === "bind" || intent === "verify") && !identity) {
      return json(401, { success: false, message: "绑定操作需要登录" });
    }
    const payload: Record<string, unknown> = { provider, intent, aff, affiliate_code: aff };
    if (intent === "bind" && identity) {
      const proof = await requireProof(c, s, { scope: "account.binding.bind", context: { provider } });
      if (isResponse(proof)) return proof;
      payload.session_id = identity.sessionId;
    }
    if (intent === "verify" && identity) {
      const secret = await sessionSecret(c.env, s);
      const bound = await bindVerificationOperation(secret, { scope: body.scope || "", context: body.context });
      if (!bound.ok) return json(bound.status, { success: false, code: bound.code, message: bound.message });
      const user = await s.getUserById(identity.userId);
      if (!user) return apiFail("用户不存在");
      const providerUserId = await getBoundOAuthUserId(s, user, provider);
      if (!providerUserId) return apiFailCode("This verification method is currently unavailable.", "SECURITY_METHOD_UNAVAILABLE");
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
    const origin = new URL(c.req.url).origin;
    const spaRedirect = `${origin}/oauth/${provider}`;
    const data: Record<string, unknown> = { flow_token: flow, expires_at: expires };
    if (provider === "telegram") {
      const token = await s.option("TelegramBotToken");
      const botId = token.split(":")[0] || "";
      data.authorization_url = `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(botId)}&origin=${encodeURIComponent(origin)}&request_access=write&return_to=${encodeURIComponent(spaRedirect)}`;
    }
    return apiOk(data);
  });

  r.get("/api/oauth/:provider", async (c) => {
    const s = store(c);
    const provider = c.params.provider;
    const origin = new URL(c.req.url).origin;
    const redirect = `${origin}/oauth/${provider}`;
    const code = c.url.searchParams.get("code") || "";
    const state = c.url.searchParams.get("state") || "";
    const errorCode = c.url.searchParams.get("error");
    const session = await readSession(c, s);
    const existing = session ? await s.getUserById(session.id) : null;
    const identity = await dashboardIdentity(c, s);

    const flow = state ? await s.getAuthFlow(state) : null;
    if (!flow || flow.type !== "oauth" || flow.expires_at < nowSec()) {
      return json(403, { success: false, message: "OAuth state is invalid", data: null });
    }
    const payload = parseJson<{
      provider?: string;
      intent?: string;
      verification?: { scope?: string; context_hash?: string; provider_user_id?: string; auth_version?: number; session_version?: number };
    }>(flow.payload, {});
    if (payload.provider && payload.provider !== provider) {
      return json(403, { success: false, message: "OAuth state is invalid", data: null });
    }
    const intent = payload.intent || "login";
    if ((intent === "bind" || intent === "verify") && (!identity || identity.userId !== flow.user_id)) {
      return json(403, { success: false, message: "OAuth state is invalid", data: null });
    }
    await s.deleteAuthFlow(state);
    const bindUser = intent === "bind" ? existing : null;

    if (errorCode) {
      return apiFail(c.url.searchParams.get("error_description") || errorCode);
    }

    const finish = async (profile: Awaited<ReturnType<typeof exchangeGithub>>) => {
      if (intent === "verify") {
        if (!identity) return json(401, { success: false, message: "绑定操作需要登录" });
        const expected = payload.verification?.provider_user_id || "";
        if (!profile.id || profile.id !== expected) {
          return apiFail("The OAuth account does not match the account linked to your profile.");
        }
        const secret = await sessionSecret(c.env, s);
        const proof = await issueSecurityProof(s, secret, identity, "oauth", {
          scope: payload.verification?.scope || "",
          contextHash: payload.verification?.context_hash || "",
        });
        return apiOk(proof);
      }
      return loginOrBindOAuth(s, c.env, c.req, profile, bindUser, intent);
    };

    try {
      if (provider === "github") {
        if (!(await s.optionBool("GitHubOAuthEnabled", false))) return apiFail("GitHub OAuth 未启用");
        if (!code) return apiFail("无效的授权码");
        return finish(await exchangeGithub(await s.option("GitHubClientId"), await s.option("GitHubClientSecret"), code));
      }
      if (provider === "discord") {
        if (!(await s.optionBool("DiscordOAuthEnabled", false))) return apiFail("Discord OAuth 未启用");
        if (!code) return apiFail("无效的授权码");
        return finish(await exchangeDiscord(await s.option("DiscordClientId"), await s.option("DiscordClientSecret"), code, redirect));
      }
      if (provider === "linuxdo") {
        if (!(await s.optionBool("LinuxDOOAuthEnabled", false))) return apiFail("LinuxDO OAuth 未启用");
        if (!code) return apiFail("无效的授权码");
        return finish(await exchangeLinuxDO(await s.option("LinuxDOClientId"), await s.option("LinuxDOClientSecret"), code, redirect));
      }
      if (provider === "oidc") {
        if (!(await s.optionBool("OIDCAuthEnabled", false))) return apiFail("OIDC 未启用");
        if (!code) return apiFail("无效的授权码");
        return finish(
          await exchangeOidc({
            tokenUrl: await s.option("OIDCTokenEndpoint"),
            userInfoUrl: await s.option("OIDCUserinfoEndpoint"),
            clientId: await s.option("OIDCClientId"),
            secret: await s.option("OIDCClientSecret"),
            code,
            redirect,
          }),
        );
      }
      if (provider === "telegram") {
        if (!(await s.optionBool("TelegramOAuthEnabled", false))) return apiFail("Telegram 未启用");
        return finish(await verifyTelegramLogin(s, c.url.searchParams));
      }
      if (provider === "wechat") {
        return apiFail("请使用 /api/oauth/wechat");
      }
      const custom = await s.getOAuthProvider(provider);
      if (!custom || !Number(custom.enabled)) return apiFail("未知的 OAuth 提供商");
      if (!code) return apiFail("无效的授权码");
      return finish(await exchangeCustom(custom, code, redirect));
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
    if (!body.ids?.length) return apiFail("无效的参数");
    const n = await s.deleteTokensBatch(u.id, body.ids);
    return apiOk(n);
  });

  r.post("/api/token/batch/keys", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    if (!body.ids?.length) return apiFail("无效的参数");
    if (body.ids.length > 100) return apiFail("批量数量过多");
    const keys: Record<string, string> = {};
    for (const id of body.ids) {
      const t = await s.getTokenById(id, u.id);
      if (t) keys[String(id)] = t.key;
    }
    return apiOk({ keys });
  });

  r.get("/api/channel/test", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const channels = await s.enabledChannels();
    const results = [];
    for (const ch of channels) results.push({ id: ch.id, name: ch.name, ...(await testChannel(s, ch)) });
    return apiOk(results);
  });

  r.post("/api/channel/batch", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    const n = await s.deleteChannelsBatch(body.ids || []);
    return apiOk(n);
  });

  r.post("/api/channel/tag/enabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { tag?: string; status?: number };
    if (!body.tag) return apiFail("缺少 tag");
    const n = await s.setChannelsByTag(body.tag, Number(body.status ?? 1));
    return apiOk({ count: n });
  });

  r.post("/api/channel/:id/update_balance", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    return updateOneChannelBalance(s, ch);
  });

  r.get("/api/redemption/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listRedemptions(
      q.offset,
      q.page_size,
      c.url.searchParams.get("keyword") || "",
      c.url.searchParams.get("status") || "",
    );
    return apiOk(pageData(items, total, q));
  });

  r.post("/api/redemption/batch", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[] };
    return apiOk(await s.deleteRedemptionsBatch(body.ids || []));
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
    if (!auth.token.id) return apiFail("无效的令牌");
    const { items } = await s.listLogs({
      offset: 0,
      limit: 1000,
      tokenId: auth.token.id,
    });
    return apiOk(publicUserLogs(items, 0));
  });

  r.get("/api/subscription/plans", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (!(await s.optionBool("PaymentComplianceConfirmed", false))) return apiOk([]);
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
    const body = (await readJson(c.req)) as { billing_preference?: string };
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
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const body = (await readJson(c.req)) as { plan_id?: number };
    if (!body.plan_id) return apiFail("参数错误");
    const plan = await s.getPlan(Number(body.plan_id));
    if (!plan || !publicPlan(plan).enabled) return apiFail("套餐未启用");
    const published = publicPlan(plan);
    if (published.allow_balance_pay === false) return apiFail("该套餐不允许使用余额兑换");
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const quotaPerUnit = await s.optionNum("QuotaPerUnit", 500000);
    const price = Math.ceil(Number(published.price_amount || 0) * quotaPerUnit);
    if (user.quota < price) return apiFail("余额不足");
    if (price) await s.addQuota(u.id, -price);
    const start = nowSec();
    const expire = calcPlanEndTime(start, published);
    const nextReset = calcNextResetTime(start, published, expire);
    await s.insertUserSub({
      user_id: u.id,
      plan_id: Number(plan.id),
      start_time: start,
      end_time: expire,
      amount_total: Number(published.total_amount || 0),
      source: "order",
      next_reset_time: nextReset,
      last_reset_time: nextReset > 0 ? start : 0,
      upgrade_group: String(published.upgrade_group || ""),
      downgrade_group: String(published.downgrade_group || ""),
      allow_wallet_overflow: published.allow_wallet_overflow ? 1 : 0,
    });
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
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const fields = planFieldsFromBody(body);
    if (!String(fields.title || "").trim()) return apiFail("套餐标题不能为空");
    if (Number(fields.price_amount) < 0) return apiFail("价格不能为负数");
    if (Number(fields.price_amount) > 9999) return apiFail("价格不能超过9999");
    if (Number(fields.max_purchase_per_user) < 0) return apiFail("购买上限不能为负数");
    if (Number(fields.total_amount) < 0) return apiFail("总额度不能为负数");
    const id = await s.insertPlan(fields);
    const created = await s.getPlan(id);
    return apiOk(created ? publicPlan(created) : { id });
  });

  r.put("/api/subscription/admin/plans/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const id = Number(c.params.id);
    if (id <= 0) return apiFail("无效的ID");
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const fields = planFieldsFromBody(body);
    if (!String(fields.title || "").trim()) return apiFail("套餐标题不能为空");
    fields.updated_at = nowSec();
    await s.updatePlan(id, fields);
    return apiOk(null);
  });

  r.patch("/api/subscription/admin/plans/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const id = Number(c.params.id);
    if (id <= 0) return apiFail("无效的ID");
    const body = (await readJson(c.req)) as { enabled?: boolean | number };
    if (body.enabled == null) return apiFail("参数错误");
    await s.updatePlan(id, { enabled: body.enabled === false || body.enabled === 0 ? 0 : 1, updated_at: nowSec() });
    return apiOk(null);
  });

  r.post("/api/subscription/admin/bind", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const denied = await requirePaymentCompliance(s);
    if (denied) return denied;
    const body = (await readJson(c.req)) as { user_id?: number; plan_id?: number };
    if (!body.user_id || !body.plan_id) return apiFail("参数错误");
    const plan = await s.getPlan(Number(body.plan_id));
    if (!plan) return apiFail("套餐不存在");
    const published = publicPlan(plan);
    const start = nowSec();
    const expire = calcPlanEndTime(start, published);
    const nextReset = calcNextResetTime(start, published, expire);
    await s.insertUserSub({
      user_id: Number(body.user_id),
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

  r.get("/api/subscription/admin/users/:id/subscriptions", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const userId = Number(c.params.id);
    if (userId <= 0) return apiFail("无效的用户ID");
    const now = nowSec();
    return apiOk((await s.listUserSubs(userId)).map((row) => wrapUserSubscription(row, now)));
  });

  r.post("/api/subscription/admin/user_subscriptions/:id/invalidate", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const id = Number(c.params.id);
    if (id <= 0) return apiFail("无效的订阅ID");
    const now = nowSec();
    await s.updateUserSub(id, { status: "cancelled", end_time: now, expire_at: now, updated_at: now });
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
    const type = c.url.searchParams.get("type") || "";
    const items = ((await s.listPrefill(type)) as Record<string, unknown>[]).map(publicPrefill);
    return apiOk(items);
  });

  r.post("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { name?: string; type?: string; items?: unknown; description?: string };
    if (!body.name || !body.type) return apiFail("组名称和类型不能为空");
    if (await s.prefillNameTaken(body.name)) return apiFail("组名称已存在");
    const items = typeof body.items === "string" ? body.items : JSON.stringify(body.items ?? []);
    const id = await s.insertPrefill(body.name, body.type, items, body.description || "");
    const row = await s.getPrefill(id);
    return apiOk(publicPrefill(row || { id, name: body.name, type: body.type, items }));
  });

  r.put("/api/prefill_group/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number; name?: string };
    if (!body.id) return apiFail("缺少组 ID");
    if (body.name && (await s.prefillNameTaken(body.name, body.id))) return apiFail("组名称已存在");
    const patch: Record<string, unknown> = { updated_time: nowSec() };
    for (const k of ["name", "type", "description"]) if (body[k] != null) patch[k] = body[k];
    if (body.items != null) patch.items = typeof body.items === "string" ? body.items : JSON.stringify(body.items);
    await s.updatePrefill(body.id, patch);
    const row = await s.getPrefill(body.id);
    return apiOk(row ? publicPrefill(row) : null);
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
    const q = pageQuery(c.url);
    const keyword = (c.url.searchParams.get("keyword") || "").toLowerCase();
    const all = ((await s.listVendors()) as Record<string, unknown>[]).filter(
      (v) => !keyword || String(v.name || "").toLowerCase().includes(keyword),
    );
    const counts = await s.vendorModelCounts();
    const items = all.slice(q.offset, q.offset + q.page_size).map((v) => publicVendor(v, counts[String(v.id || 0)] || 0));
    return apiOk(pageData(items, all.length, q));
  });

  r.get("/api/vendors/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const kw = (c.url.searchParams.get("keyword") || "").toLowerCase();
    const all = ((await s.listVendors()) as Record<string, unknown>[]).filter((v) => !kw || String(v.name || "").toLowerCase().includes(kw));
    const counts = await s.vendorModelCounts();
    const items = all.slice(q.offset, q.offset + q.page_size).map((v) => publicVendor(v, counts[String(v.id || 0)] || 0));
    return apiOk(pageData(items, all.length, q));
  });

  r.get("/api/vendors/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const v = await s.getVendor(Number(c.params.id));
    if (!v) return apiFail("不存在");
    const counts = await s.vendorModelCounts();
    return apiOk(publicVendor(v, counts[String(v.id)] || 0));
  });

  r.post("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { name?: string; description?: string; icon?: string };
    if (!body.name?.trim()) return json(400, { success: false, message: "vendor name is required" });
    const name = body.name.trim();
    const existing = ((await s.listVendors()) as { name: string }[]).some((v) => v.name.toLowerCase() === name.toLowerCase());
    if (existing) return json(400, { success: false, message: "vendor name already exists" });
    const id = await s.insertVendor(name, body.description, body.icon);
    const v = await s.getVendor(id);
    return apiOk(publicVendor(v || { id, name, description: body.description, icon: body.icon }));
  });

  r.put("/api/vendors/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number };
    if (!body.id) return apiFail("缺少供应商 ID");
    const patch: Record<string, unknown> = { updated_time: nowSec() };
    for (const k of ["name", "description", "icon", "status"]) if (body[k] != null) patch[k] = body[k];
    await s.updateVendor(body.id, patch);
    const v = await s.getVendor(body.id);
    return apiOk(v ? publicVendor(v) : null);
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
    return apiOk(await enrichModelMeta(s, meta as Record<string, unknown>[]));
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
    return apiOk(await getModelPricingSnapshot(s, c.url.searchParams.getAll("model")));
  });

  r.patch("/api/option/model_pricing", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { changes?: ModelPricingChange[] };
    try {
      const names = await updateModelPricing(s, body.changes || []);
      return apiOk({ updated_models: names });
    } catch (e) {
      const err = e as ModelPricingError;
      return json(err.status || 400, { success: false, message: err.message });
    }
  });

  r.post("/api/option/rest_model_ratio", async (c) => {
    const s = store(c);
    const u = await requireRoot(c, s);
    if (isResponse(u)) return u;
    await s.setOption("ModelRatio", DEFAULT_MODEL_RATIO_JSON);
    return apiOk(null, "重置模型倍率成功");
  });

  r.get("/api/verify/methods", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    const user = await s.getUserById(identity.userId);
    if (!user) return apiFail("用户不存在");
    const scope = c.url.searchParams.get("scope") || "";
    const reqs = await verificationRequirements(s, user, scope);
    if (!reqs.ok) return apiFailCode(reqs.message, reqs.code, reqs.status);
    return apiOk(reqs.data);
  });

  r.post("/api/verify", async (c) => {
    const s = store(c);
    const identity = await dashboardIdentity(c, s);
    if (!identity) return json(401, { success: false, message: "当前认证方式不支持安全验证" });
    const body = (await readJson(c.req)) as {
      method?: string;
      scope?: string;
      context?: unknown;
      code?: string;
      password?: string;
    };
    const user = await s.getUserById(identity.userId);
    if (!user) return apiFail("用户不存在");
    const method = body.method === "totp" ? "2fa" : body.method || "";
    const scope = body.scope || "";
    const secret = await sessionSecret(c.env, s);
    const bound = await bindVerificationOperation(secret, { scope, context: body.context });
    if (!bound.ok) return apiFailCode(bound.message, bound.code, bound.status);
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
  await s.audit(u.id, u.username, "security", "access_token.generate", clientIp(c.req), {
    actor_role: u.role,
    category: "security",
    action: "access_token.generate",
    token_ref: await accessTokenFingerprint(token),
    auth_method: "session",
    method: "POST",
    route: "/api/user/token",
    success: true,
  });
  return apiOk(token);
}

async function tokenUsage(c: C): Promise<Response> {
  const s = store(c);
  const gated = await authenticateTokenReadOnly(c, s);
  if (gated instanceof Response) return gated;
  const authHeader = c.req.headers.get("authorization") || "";
  if (!authHeader) return json(401, { success: false, message: "No Authorization header" });
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return json(401, { success: false, message: "Invalid Bearer token" });
  }
  const tokenKey = parts[1].startsWith("sk-") ? parts[1].slice(3) : parts[1];
  const token = await s.getTokenByKey(tokenKey);
  if (!token) return apiFail("获取令牌信息失败，请稍后重试");
  const remain = Number(token.remain_quota || 0);
  const used = Number(token.used_quota || 0);
  const expiredAt = token.expired_time === -1 ? 0 : token.expired_time;
  const limits = String(token.model_limits || "")
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
      name: token.name,
      total_granted: remain + used,
      total_used: used,
      total_available: remain,
      unlimited_quota: Boolean(token.unlimited_quota),
      model_limits: modelLimits,
      model_limits_enabled: Boolean(token.model_limits_enabled),
      expires_at: expiredAt,
    },
  });
}
