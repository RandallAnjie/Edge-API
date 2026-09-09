import {
  ROLE_ADMIN,
  ROLE_ROOT,
  ROLE_USER,
  ROOT_QUOTA,
  START_TIME,
  TOKEN_ENABLED,
  TOKEN_EXPIRED,
  TOKEN_EXHAUSTED,
  USER_DISABLED,
  USER_ENABLED,
  VERSION,
  nowSec,
  parseBool,
} from "./constants.js";
import { permissionDeltas } from "./authz.js";
import { CHANNEL_TYPES } from "./catalog.js";
import {
  generateAffCode,
  generateRedemptionKey,
  generateTokenKey,
  displayTokenKey,
  hashPassword,
  verifyPassword,
} from "./crypto.js";
import { apiFail, apiOk, apiOkExtra, clientIp, clearAuthCookies, isSecureRequest, json, pageData, pageQuery, readJson } from "./http.js";
import type { Context } from "./router.js";
import { Router } from "./router.js";
import {
  issueSessionSafe,
  isResponse,
  readSession,
  refreshLoginSession,
  requireAdmin,
  requireChannel,
  requirePermission,
  requireProof,
  requireRoot,
  requireUser,
  sessionResponse,
} from "./auth.js";
import { Store, permissionsFor, publicUser, stripChannelKey } from "./store.js";
import { publicToken, buildPricing, userGroupsView, userUsableGroups, userAutoGroups, publicLog, dashboardListModels, channelListModels, publicOptions } from "./dto.js";
import { fetchUpstreamModels, playgroundRelay, testChannel } from "./relay.js";
import { registerMore } from "./more-routes.js";
import { buildStatus } from "./status.js";
import type { Env, UserRow } from "./types.js";

type C = Context<Env>;

function store(c: C): Store {
  return new Store(c.env.DB);
}

export function adminRouter(): Router<Env> {
  const r = new Router<Env>();

  r.get("/health", () => apiOk({ ok: true, version: VERSION, start_time: START_TIME }));

  r.get("/api/setup", async (c) => {
    const s = store(c);
    const done = await s.setupDone();
    const root = await s.rootExists();
    return apiOk({ status: done, root_init: root, database_type: "d1" });
  });

  r.post("/api/setup", async (c) => {
    const s = store(c);
    if (await s.setupDone()) return apiFail("系统已经初始化完成");
    const body = (await readJson(c.req)) as {
      username?: string;
      password?: string;
      confirmPassword?: string;
      SelfUseModeEnabled?: boolean;
      DemoSiteEnabled?: boolean;
    };
    if (!(await s.rootExists())) {
      const username = (body.username || "").trim();
      const password = body.password || "";
      if (username.length < 1 || username.length > 12) return apiFail("用户名长度不能超过12个字符");
      if (password !== (body.confirmPassword || password)) return apiFail("两次输入的密码不一致");
      if (password.length < 8 || password.length > 128) return apiFail("密码长度必须在 8 到 128 之间");
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
    await s.setOption("SelfUseModeEnabled", String(Boolean(body.SelfUseModeEnabled ?? true)));
    await s.setOption("DemoSiteEnabled", String(Boolean(body.DemoSiteEnabled ?? false)));
    await s.setOption("Setup", "true");
    return apiOk(null, "系统初始化成功");
  });

  r.get("/api/status", async (c) => apiOk(await buildStatus(store(c), c.env)));

  r.get("/api/notice", async (c) => apiOk(await store(c).option("Notice")));
  r.get("/api/about", async (c) => apiOk(await store(c).option("About")));
  r.get("/api/home_page_content", async (c) => apiOk(await store(c).option("HomePageContent")));
  r.get("/api/user-agreement", async (c) => apiOk(await store(c).option("UserAgreement")));
  r.get("/api/privacy-policy", async (c) => apiOk(await store(c).option("PrivacyPolicy")));

  r.get("/api/pricing", async (c) => {
    const s = store(c);
    const session = await readSession(c, s);
    const pricing = await buildPricing(s, session?.group || "");
    return apiOkExtra(pricing.data, {
      vendors: pricing.vendors,
      group_ratio: pricing.group_ratio,
      usable_group: pricing.usable_group,
      supported_endpoint: pricing.supported_endpoint,
      auto_groups: pricing.auto_groups,
      pricing_version: pricing.pricing_version,
    });
  });

  r.get("/api/channel/types", () => apiOk(CHANNEL_TYPES.filter((t) => t.id > 0)));

  r.post("/api/user/login", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasswordLoginEnabled", true))) return apiFail("密码登录已禁用");
    const body = (await readJson(c.req)) as { username?: string; password?: string };
    if (!body.username || !body.password) return apiFail("无效的参数");
    const user = await s.getUserByUsername(body.username);
    if (!user || !(await verifyPassword(body.password, user.password))) return apiFail("用户名或密码错误");
    if (user.status !== USER_ENABLED) return apiFail("用户已被封禁");
    const passkeys = (await s.listPasskeys(user.id)).length > 0;
    const totp = Number(user.totp_enabled) === 1;
    if (totp || passkeys) {
      const { randomHex } = await import("./constants.js");
      const flow = randomHex(16);
      const expires = nowSec() + 300;
      await s.insertAuthFlow({
        token: flow,
        type: totp ? "2fa_login" : "login_verify",
        user_id: user.id,
        expires_at: expires,
        payload: JSON.stringify({ login_method: "password", auth_version: Number(user.auth_version || 1) || 1 }),
      });
      const methods = [];
      if (totp) methods.push({ method: "2fa", available: true });
      if (passkeys) methods.push({ method: "passkey", available: true });
      return apiOk({
        require_verification: true,
        require_2fa: totp,
        flow_token: flow,
        expires_at: expires,
        methods,
      });
    }
    const issued = await issueSessionSafe(s, c.env, user, c.req, "password");
    if (issued instanceof Response) return issued;
    await s.audit(user.id, user.username, "login", "Logged in successfully via password", clientIp(c.req));
    return sessionResponse(issued);
  });

  r.post("/api/user/auth/logout", async (c) => {
    const s = store(c);
    const { authSessionMismatch, currentSid } = await import("./auth.js");
    const expected = (c.req.headers.get("X-Auth-Session") || "").trim();
    const sid = await currentSid(c, s);
    if (expected && sid && expected !== sid) return authSessionMismatch();
    if (sid) await s.revokeSession(sid);
    const res = apiOk({ revoked_sid: sid || "", cookie_cleared: true });
    const headers = new Headers(res.headers);
    for (const cookie of clearAuthCookies(isSecureRequest(c.req))) headers.append("set-cookie", cookie);
    return new Response(res.body, { status: 200, headers });
  });

  r.post("/api/user/auth/refresh", async (c) => {
    const s = store(c);
    const expected = (c.req.headers.get("X-Auth-Session") || "").trim();
    const result = await refreshLoginSession(s, c.env, c.req, expected);
    if (!result.ok) return result.response;
    return sessionResponse(result.issued);
  });

  r.get("/api/user/login/encryption-key", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("PasswordLoginEncryptionEnabled", false))) return apiOk({ enabled: false });
    return apiOk({
      enabled: true,
      kid: await s.option("PasswordEncryptionKid"),
      public_key: await s.option("PasswordEncryptionPublicKey"),
    });
  });

  r.post("/api/user/register", async (c) => {
    const s = store(c);
    if (!(await s.optionBool("RegisterEnabled", true))) return apiFail("注册已禁用");
    if (!(await s.optionBool("PasswordRegisterEnabled", true))) return apiFail("密码注册已禁用");
    const body = (await readJson(c.req)) as {
      username?: string;
      password?: string;
      display_name?: string;
      aff_code?: string;
      email?: string;
      verification_code?: string;
    };
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (username.length < 1 || username.length > 20) return apiFail("用户名长度不合法");
    if (password.length < 8 || password.length > 128) return apiFail("密码长度必须在 8 到 128 之间");
    if (await s.getUserByUsername(username)) return apiFail("用户已存在");
    if (await s.optionBool("EmailVerificationEnabled", false)) {
      if (!body.email || !body.verification_code) return apiFail("请填写邮箱验证码");
      if (!(await s.consumeEmailCode(body.email, body.verification_code, "verify"))) return apiFail("验证码无效或已过期");
    }
    let inviter = 0;
    if (body.aff_code) {
      const inv = await s.getUserByAff(body.aff_code);
      if (inv) inviter = inv.id;
    }
    const quota = await s.optionNum("QuotaForNewUser", 0);
    const id = await s.insertUser({
      username,
      password: await hashPassword(password),
      display_name: body.display_name || username,
      role: ROLE_USER,
      quota,
      email: body.email || "",
      aff_code: generateAffCode(),
      inviter_id: inviter,
    });
    if (body.email) await s.updateUser(id, { email: body.email, email_verified: 1 });
    if (inviter) {
      const bonus = await s.optionNum("QuotaForInviter", 0);
      const invitee = await s.optionNum("QuotaForInvitee", 0);
      if (bonus) await s.addQuota(inviter, bonus);
      if (invitee) await s.addQuota(id, invitee);
      const inv = await s.getUserById(inviter);
      if (inv) {
        await s.updateUser(inviter, {
          aff_count: (inv.aff_count || 0) + 1,
          aff_quota: (inv.aff_quota || 0) + bonus,
          aff_history_quota: (inv.aff_history_quota || 0) + bonus,
        });
      }
    }
    const user = await s.getUserById(id);
    const issued = await issueSessionSafe(s, c.env, user!, c.req, "password");
    if (issued instanceof Response) return issued;
    return sessionResponse(issued);
  });

  r.get("/api/user/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    return apiOk({
      ...publicUser(user),
      permissions: permissionsFor(user),
    });
  });

  r.put("/api/user/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { display_name?: string; password?: string; original_password?: string };
    const patch: Record<string, unknown> = {};
    if (body.display_name != null) patch.display_name = body.display_name;
    if (body.password) {
      const user = await s.getUserById(u.id);
      if (!user) return apiFail("用户不存在");
      const firstPassword = !user.password;
      const scope = firstPassword ? "account.password.set" : "account.password.change";
      const proof = await requireProof(c, s, { scope });
      if (isResponse(proof)) return proof;
      if (body.password.length < 8) return apiFail("密码长度必须在 8 到 128 之间");
      patch.password = await hashPassword(body.password);
      await s.updateUser(u.id, patch);
      await s.bumpAuthVersion(u.id);
      const fresh = await s.getUserById(u.id);
      const issued = await issueSessionSafe(s, c.env, fresh || user, c.req, "password_changed", u.sid);
      if (issued instanceof Response) return issued;
      issued.data.has_password = true;
      return sessionResponse(issued);
    }
    await s.updateUser(u.id, patch);
    return apiOk(null, "更新成功");
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
    const enabled = await s.optionBool("CheckinEnabled", true);
    if (!enabled) return apiFail("签到功能未启用");
    const month = c.url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const stats = await s.checkinStats(u.id, month);
    return apiOk({
      enabled: true,
      min_quota: await s.optionNum("CheckinMinQuota", 1000),
      max_quota: await s.optionNum("CheckinMaxQuota", await s.optionNum("CheckinQuota", 5000)),
      stats,
    });
  });

  r.post("/api/user/checkin", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    if (!(await s.optionBool("CheckinEnabled", true))) return apiFail("签到功能未启用");
    const user = await s.getUserById(u.id);
    if (!user) return apiFail("用户不存在");
    const today = new Date().toISOString().slice(0, 10);
    if (await s.hasCheckedIn(u.id, today)) return apiFail("今日已签到");
    const minQ = await s.optionNum("CheckinMinQuota", 1000);
    const maxQ = await s.optionNum("CheckinMaxQuota", await s.optionNum("CheckinQuota", 5000));
    const quota = minQ + (maxQ > minQ ? Math.floor(Math.random() * (maxQ - minQ + 1)) : 0);
    await s.insertCheckin(u.id, today, quota);
    await s.addQuota(u.id, quota);
    await s.updateUser(u.id, { checkin_at: nowSec() });
    await s.insertLog({ user_id: u.id, type: 4, content: `用户签到，获得额度 ${quota}`, username: u.username, quota });
    return apiOk({ quota_awarded: quota, checkin_date: today }, "签到成功");
  });

  r.slash("GET", "/api/user/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const keyword = c.url.searchParams.get("keyword") || "";
    const { items, total } = await s.listUsers(q.offset, q.page_size, keyword);
    return apiOk(pageData(items.map(publicUser), total, q));
  });

  r.get("/api/user/search", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const keyword = c.url.searchParams.get("keyword") || "";
    const { items, total } = await s.listUsers(q.offset, q.page_size, keyword);
    return apiOk(pageData(items.map(publicUser), total, q));
  });

  r.get("/api/user/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const user = await s.getUserById(Number(c.params.id));
    if (!user) return apiFail("用户不存在");
    return apiOk(publicUser(user));
  });

  r.slash("POST", "/api/user/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Partial<UserRow> & { password?: string };
    if (!body.username || !body.password) return apiFail("无效的参数");
    if (await s.getUserByUsername(body.username)) return apiFail("用户已存在");
    const role = Number(body.role || ROLE_USER);
    if (role >= u.role) return apiFail("无法创建同级或更高等级用户");
    await s.insertUser({
      username: body.username,
      password: await hashPassword(body.password),
      display_name: body.display_name || body.username,
      role,
      quota: Number(body.quota || 0),
      group: body.group || "default",
      aff_code: generateAffCode(),
    });
    return apiOk(null, "创建成功");
  });

  r.slash("PUT", "/api/user/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Partial<UserRow> & {
      id?: number;
      password?: string;
      admin_permissions?: Record<string, Record<string, boolean>>;
    };
    if (!body.id) return apiFail("无效的参数");
    const target = await s.getUserById(body.id);
    if (!target) return apiFail("用户不存在");
    if (target.role >= u.role && target.id !== u.id) return apiFail("无权修改更高等级用户");
    const patch: Record<string, unknown> = {};
    for (const k of ["display_name", "email", "quota", "group", "status"] as const) {
      if (body[k] != null) patch[k] = body[k];
    }
    if (body.password) patch.password = await hashPassword(body.password);
    if (body.role != null && body.role < u.role) patch.role = body.role;
    if (body.admin_permissions) {
      if (u.role < ROLE_ROOT) return apiFail("only root can update admin permissions");
      const targetRole = Number(patch.role ?? target.role);
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
    return apiOk(null, "更新成功");
  });

  r.post("/api/user/manage", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { id?: number; action?: string; quota?: number };
    if (!body.id || !body.action) return apiFail("无效的参数");
    const target = await s.getUserById(body.id);
    if (!target) return apiFail("用户不存在");
    if (target.role >= u.role && target.id !== u.id) return apiFail("无权操作更高等级用户");
    switch (body.action) {
      case "disable":
        if (target.role === ROLE_ROOT) return apiFail("无法禁用超级管理员");
        await s.updateUser(target.id, { status: USER_DISABLED });
        break;
      case "enable":
        await s.updateUser(target.id, { status: USER_ENABLED });
        break;
      case "delete":
        if (target.role === ROLE_ROOT) return apiFail("无法删除超级管理员");
        await s.deleteUser(target.id);
        break;
      case "promote":
        if (u.role < ROLE_ROOT) return apiFail("只有超级管理员可以提升管理员");
        if (target.role >= ROLE_ADMIN) return apiFail("已经是管理员");
        await s.updateUser(target.id, { role: ROLE_ADMIN });
        break;
      case "demote":
        if (target.role === ROLE_ROOT) return apiFail("无法降级超级管理员");
        await s.updateUser(target.id, { role: ROLE_USER });
        break;
      case "add_quota":
        await s.addQuota(target.id, Number(body.quota || 0));
        break;
      default:
        return apiFail("未知操作");
    }
    await s.audit(u.id, u.username, "user.manage", `${body.action} user ${target.username}`, clientIp(c.req));
    return apiOk(null);
  });

  r.delete("/api/user/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const target = await s.getUserById(Number(c.params.id));
    if (!target) return apiFail("用户不存在");
    if (target.role === ROLE_ROOT) return apiFail("无法删除超级管理员");
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
    const t = await s.getTokenById(Number(c.params.id), u.id);
    if (!t) return apiFail("令牌不存在");
    return apiOk(publicToken(t));
  });

  r.post("/api/token/:id/key", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const t = await s.getTokenById(Number(c.params.id), u.id);
    if (!t) return apiFail("令牌不存在");
    return apiOk({ key: displayTokenKey(t.key) });
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
      auto_groups: Array.isArray(body.auto_groups) ? JSON.stringify(body.auto_groups) : "",
      cross_group_retry: body.cross_group_retry ? 1 : 0,
      status: TOKEN_ENABLED,
    });
    return apiOk({ id, key: displayTokenKey(key) }, "创建成功");
  });

  r.slash("PUT", "/api/token/", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown> & { id?: number; status?: number };
    if (!body.id) return apiFail("无效的参数");
    const existing = await s.getTokenById(Number(body.id), u.id);
    if (!existing) return apiFail("令牌不存在");
    const statusOnly = c.url.searchParams.get("status_only");
    if (statusOnly) {
      if (body.status === TOKEN_ENABLED) {
        if (existing.status === TOKEN_EXPIRED && existing.expired_time !== -1 && existing.expired_time <= nowSec()) {
          return apiFail("令牌已过期，无法启用");
        }
        if (existing.status === TOKEN_EXHAUSTED && existing.remain_quota <= 0 && !existing.unlimited_quota) {
          return apiFail("令牌额度已用尽，无法启用");
        }
      }
      await s.updateToken(Number(body.id), u.id, { status: Number(body.status) });
      return apiOk(null);
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "status", "remain_quota", "expired_time", "model_limits", "allow_ips", "group"] as const) {
      if (body[k] != null) patch[k] = body[k];
    }
    if (body.unlimited_quota != null) patch.unlimited_quota = body.unlimited_quota ? 1 : 0;
    if (body.model_limits_enabled != null) patch.model_limits_enabled = body.model_limits_enabled ? 1 : 0;
    if (body.cross_group_retry != null) patch.cross_group_retry = body.cross_group_retry ? 1 : 0;
    if (body.auto_groups != null) patch.auto_groups = Array.isArray(body.auto_groups) ? JSON.stringify(body.auto_groups) : String(body.auto_groups);
    await s.updateToken(Number(body.id), u.id, patch);
    return apiOk(null, "更新成功");
  });

  r.slash("DELETE", "/api/token/:id/", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    await s.deleteToken(Number(c.params.id), u.id);
    return apiOk(null);
  });

  r.slash("GET", "/api/channel/", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const statusParam = c.url.searchParams.get("status");
    let status: number | undefined;
    if (statusParam === "1" || statusParam === "enabled") status = 1;
    else if (statusParam === "0" || statusParam === "disabled") status = 0;
    const typeStr = c.url.searchParams.get("type");
    const { items, total, type_counts } = await s.listChannels({
      offset: q.offset,
      limit: q.page_size,
      keyword: c.url.searchParams.get("keyword") || undefined,
      group: c.url.searchParams.get("group") || undefined,
      status,
      type: typeStr ? Number(typeStr) : undefined,
      tag_mode: c.url.searchParams.get("tag_mode") === "true",
      sort_by: c.url.searchParams.get("sort_by") || undefined,
      sort_order: c.url.searchParams.get("sort_order") || undefined,
      id_sort: c.url.searchParams.get("id_sort") === "true",
    });
    return apiOk(pageData(items.map(stripChannelKey), total, q, { type_counts }));
  });

  r.get("/api/channel/search", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total, type_counts } = await s.listChannels({
      offset: q.offset,
      limit: q.page_size,
      keyword: c.url.searchParams.get("keyword") || undefined,
    });
    return apiOk(pageData(items.map(stripChannelKey), total, q, { type_counts }));
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

  r.get("/api/channel/ops", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    return apiOk({ retry_times: await s.optionNum("RetryTimes", 3) });
  });

  r.get("/api/channel/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "read");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
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
    if (!ch) return apiFail("渠道不存在");
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
    const id = await s.insertChannel({
      type: Number(ch.type || 1),
      key: String(ch.key || ""),
      name: String(ch.name),
      weight: Number(ch.weight ?? 1),
      base_url: String(ch.base_url || ""),
      other: String(ch.other || ""),
      models: String(ch.models || ""),
      group: String(ch.group || "default"),
      model_mapping: typeof ch.model_mapping === "string" ? ch.model_mapping : JSON.stringify(ch.model_mapping || ""),
      priority: Number(ch.priority || 0),
      auto_ban: ch.auto_ban == null ? 1 : Number(ch.auto_ban),
      tag: String(ch.tag || ""),
      header_override: typeof ch.header_override === "string" ? ch.header_override : JSON.stringify(ch.header_override || ""),
      param_override: typeof ch.param_override === "string" ? ch.param_override : JSON.stringify(ch.param_override || ""),
      remark: String(ch.remark || ""),
      openai_organization: String(ch.openai_organization || ""),
      test_model: String(ch.test_model || ""),
      settings: typeof ch.settings === "string" ? ch.settings : JSON.stringify(ch.settings || ""),
      setting: typeof ch.setting === "string" ? ch.setting : JSON.stringify(ch.setting || ch.settings || ""),
      other_info: String(ch.other_info || ""),
      channel_info: typeof ch.channel_info === "string" ? ch.channel_info : JSON.stringify(ch.channel_info || ""),
      balance: String(ch.balance ?? ""),
    });
    await s.audit(u.id, u.username, "channel.create", `create channel ${ch.name}`, clientIp(c.req));
    return apiOk({ id }, "创建成功");
  });

  r.slash("PUT", "/api/channel/", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "write");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as Record<string, unknown>;
    const ch = (body.channel || body) as Record<string, unknown>;
    const id = Number(ch.id);
    if (!id) return apiFail("无效的参数");
    const patch: Record<string, unknown> = {};
    for (const k of [
      "type",
      "key",
      "status",
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
      "channel_info",
      "balance",
    ]) {
      if (ch[k] != null) patch[k] = typeof ch[k] === "object" ? JSON.stringify(ch[k]) : ch[k];
    }
    await s.updateChannel(id, patch);
    return apiOk(null, "更新成功");
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
    const body = (await readJson(c.req)) as { status?: number };
    await s.updateChannel(Number(c.params.id), { status: Number(body.status) });
    return apiOk(null);
  });

  r.post("/api/channel/status/batch", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { ids?: number[]; status?: number };
    for (const id of body.ids || []) await s.updateChannel(id, { status: Number(body.status) });
    return apiOk(null);
  });

  r.delete("/api/channel/disabled", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const n = await s.deleteDisabledChannels();
    return apiOk({ count: n });
  });

  r.post("/api/channel/copy/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const id = await s.insertChannel({ ...ch, name: ch.name + " Copy", id: undefined as unknown as number });
    return apiOk({ id });
  });

  r.get("/api/channel/test/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    const result = await testChannel(s, ch);
    return result.success ? apiOk(result, result.message) : apiFail(result.message, result);
  });

  r.get("/api/channel/fetch_models/:id", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "operate");
    if (isResponse(u)) return u;
    const ch = await s.getChannel(Number(c.params.id));
    if (!ch) return apiFail("渠道不存在");
    try {
      const models = await fetchUpstreamModels(ch);
      return apiOk(models);
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.post("/api/channel/fetch_models", async (c) => {
    const s = store(c);
    const u = await requireChannel(c, s, "sensitive_write");
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { type?: number; key?: string; base_url?: string };
    try {
      const models = await fetchUpstreamModels({
        id: 0,
        type: Number(body.type || 1),
        key: String(body.key || ""),
        base_url: String(body.base_url || ""),
        status: 1,
        name: "tmp",
        weight: 1,
        created_time: 0,
        test_time: 0,
        response_time: 0,
        other: "",
        models: "",
        group: "default",
        used_quota: 0,
        model_mapping: "",
        status_code_mapping: "",
        priority: 0,
        auto_ban: 1,
        tag: "",
        header_override: "",
        param_override: "",
        remark: "",
        settings: "",
        openai_organization: "",
        test_model: "",
      });
      return apiOk(models);
    } catch (e) {
      return apiFail(e instanceof Error ? e.message : String(e));
    }
  });

  r.slash("GET", "/api/log/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
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
    });
    return apiOk(pageData(items.map((row) => publicLog(row, u.role)), total, q));
  });

  r.get("/api/log/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
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
    });
    return apiOk(pageData(items.map((row) => publicLog(row, u.role)), total, q));
  });

  r.get("/api/log/stat", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
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
  });

  r.get("/api/log/self/stat", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(
      await s.logStat({
        userId: u.id,
        username: u.username,
        type: Number(c.url.searchParams.get("type") || 0) || undefined,
        start: Number(c.url.searchParams.get("start_timestamp") || 0) || undefined,
        end: Number(c.url.searchParams.get("end_timestamp") || 0) || undefined,
        tokenName: c.url.searchParams.get("token_name") || undefined,
        model: c.url.searchParams.get("model_name") || undefined,
        group: c.url.searchParams.get("group") || undefined,
      }),
    );
  });

  r.slash("GET", "/api/data/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const start = Number(c.url.searchParams.get("start_timestamp") || nowSec() - 86400 * 7);
    const end = Number(c.url.searchParams.get("end_timestamp") || nowSec());
    return apiOk(await s.quotaDates(null, start, end, c.url.searchParams.get("username") || ""));
  });

  r.get("/api/data/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const start = Number(c.url.searchParams.get("start_timestamp") || nowSec() - 86400 * 7);
    const end = Number(c.url.searchParams.get("end_timestamp") || nowSec());
    if (end - start > 2592000) return apiFail("时间跨度不能超过 1 个月");
    return apiOk(await s.quotaDates(u.id, start, end));
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
    const body = (await readJson(c.req)) as { key?: string; value?: unknown };
    if (!body.key) return apiFail("无效的参数");
    await s.setOption(body.key, String(body.value ?? ""));
    return apiOk(null, "更新成功");
  });

  r.slash("GET", "/api/redemption/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listRedemptions(q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/redemption/:id", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const item = await s.getRedemption(Number(c.params.id));
    if (!item) return apiFail("兑换码不存在");
    return apiOk(item);
  });

  r.slash("POST", "/api/redemption/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { name?: string; quota?: number; count?: number };
    const count = Math.min(100, Math.max(1, Number(body.count || 1)));
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
      const key = generateRedemptionKey();
      await s.insertRedemption({ name: body.name || "default", key, quota: Number(body.quota || 0) });
      keys.push(key);
    }
    return apiOk(keys, "创建成功");
  });

  r.slash("PUT", "/api/redemption/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { id?: number; name?: string; quota?: number; status?: number };
    if (!body.id) return apiFail("无效的参数");
    const patch: Record<string, unknown> = {};
    if (body.name != null) patch.name = body.name;
    if (body.quota != null) patch.quota = body.quota;
    if (body.status != null) patch.status = body.status;
    await s.updateRedemption(body.id, patch);
    return apiOk(null);
  });

  r.slash("DELETE", "/api/redemption/:id/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    await s.deleteRedemption(Number(c.params.id));
    return apiOk(null);
  });

  r.post("/api/user/topup", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const body = (await readJson(c.req)) as { key?: string };
    if (!body.key) return apiFail("请输入兑换码");
    const red = await s.getRedemptionByKey(body.key.trim());
    if (!red) return apiFail("兑换码无效");
    if (red.status !== 1) return apiFail("兑换码不可用");
    await s.updateRedemption(red.id, { status: 3, redeemed_time: nowSec(), used_user_id: u.id });
    await s.addQuota(u.id, red.quota);
    await s.insertTopup({ user_id: u.id, amount: red.quota, payment_method: "redemption", trade_no: red.key });
    await s.insertLog({ user_id: u.id, type: 1, content: `redeem ${red.key}`, username: u.username, quota: red.quota });
    return apiOk({ quota: red.quota }, "兑换成功");
  });

  r.get("/api/audit", async (c) => {
    const s = store(c);
    const u = await requirePermission(c, s, "audit", "read");
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    if (q.page < 1 || q.page_size < 1 || q.page > 100000000) return apiFail("Invalid audit pagination");
    const category = c.url.searchParams.get("category") || "";
    const tokenRef = c.url.searchParams.get("token_ref") || "";
    const exclude = c.url.searchParams.get("exclude_token_ref") || "";
    if (category && !["login", "security", "operation", "access_token"].includes(category)) return apiFail("Invalid audit filters");
    if ((tokenRef && !/^[0-9a-f]{64}$/.test(tokenRef)) || (exclude && !/^[0-9a-f]{64}$/.test(exclude))) {
      return apiFail("Invalid audit filters");
    }
    const start = Number(c.url.searchParams.get("start_timestamp") || 0);
    const end = Number(c.url.searchParams.get("end_timestamp") || 0);
    if ((c.url.searchParams.get("start_timestamp") && start < 0) || (c.url.searchParams.get("end_timestamp") && end < 0) || (end > 0 && end < start)) {
      return apiFail("Invalid audit time range");
    }
    const successRaw = c.url.searchParams.get("success") || "";
    if (successRaw && successRaw !== "true" && successRaw !== "false") return apiFail("Invalid audit result");
    const { items, total } = await s.listAudit(q.offset, q.page_size, {
      username: c.url.searchParams.get("username") || "",
      category,
      token_ref: tokenRef,
      exclude_token_ref: exclude,
      request_id: c.url.searchParams.get("request_id") || "",
      start_timestamp: start,
      end_timestamp: end,
      success: successRaw === "" ? undefined : successRaw === "true",
    });
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/audit/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    if (q.page < 1 || q.page_size < 1 || q.page > 100000000) return apiFail("Invalid audit pagination");
    const { items, total } = await s.listAudit(q.offset, q.page_size, { userId: u.id });
    return apiOk(pageData(items, total, q));
  });

  r.slash("GET", "/api/mj/", async (c) => {
    const s = store(c);
    const u = await requireAdmin(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listMj(null, q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/mj/self", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    const q = pageQuery(c.url);
    const { items, total } = await s.listMj(u.id, q.offset, q.page_size);
    return apiOk(pageData(items, total, q));
  });

  r.get("/api/models", async (c) => {
    const s = store(c);
    const u = await requireUser(c, s);
    if (isResponse(u)) return u;
    return apiOk(dashboardListModels());
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

async function billingSub(c: C): Promise<Response> {
  const s = store(c);
  const { authenticateApiToken } = await import("./auth.js");
  const auth = await authenticateApiToken(c, s);
  if (auth instanceof Response) return auth;
  const quotaPerUnit = await s.optionNum("QuotaPerUnit", 500000);
  const tokenStat = await s.optionBool("DisplayTokenStatEnabled", true);
  let remain = auth.user.quota;
  let used = auth.user.used_quota;
  let expiredTime = auth.token.expired_time;
  if (tokenStat) {
    remain = auth.token.remain_quota;
    used = auth.token.used_quota;
  }
  let amount: number = remain + used;
  if (auth.token.unlimited_quota) amount = 100000000;
  else amount = amount / quotaPerUnit;
  return new Response(
    JSON.stringify({
      object: "billing_subscription",
      has_payment_method: true,
      soft_limit_usd: amount,
      hard_limit_usd: amount,
      system_hard_limit_usd: amount,
      access_until: expiredTime > 0 ? expiredTime : 0,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

async function billingUsage(c: C): Promise<Response> {
  const s = store(c);
  const { authenticateApiToken } = await import("./auth.js");
  const auth = await authenticateApiToken(c, s);
  if (auth instanceof Response) return auth;
  const quotaPerUnit = await s.optionNum("QuotaPerUnit", 500000);
  const tokenStat = await s.optionBool("DisplayTokenStatEnabled", true);
  const quota = tokenStat ? auth.token.used_quota : auth.user.used_quota;
  return new Response(
    JSON.stringify({
      object: "list",
      total_usage: (quota / quotaPerUnit) * 100,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

void parseBool;
