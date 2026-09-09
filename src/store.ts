import {
  CHANNEL_AUTO_DISABLED,
  CHANNEL_ENABLED,
  DEFAULT_OPTIONS,
  LOG_CONSUME,
  TOKEN_ENABLED,
  USER_ENABLED,
  csv,
  dayStartSec,
  nowSec,
} from "./constants.js";
import { SCHEMA_SQL, ensureSchema } from "./schema.js";
import type {
  ChannelRow,
  D1Database,
  LogRow,
  RedemptionRow,
  TokenRow,
  UserRow,
} from "./types.js";

export { SCHEMA_SQL, ensureSchema };

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool01(v: unknown): number {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  return 0;
}

export class Store {
  constructor(private db: D1Database) {}

  async option(key: string): Promise<string> {
    const row = await this.db.prepare("SELECT value FROM options WHERE key = ?").bind(key).first<{ value: string }>();
    if (row?.value != null) return row.value;
    return DEFAULT_OPTIONS[key] ?? "";
  }

  async optionBool(key: string, fallback = false): Promise<boolean> {
    const v = await this.option(key);
    if (!v) return fallback;
    return v === "true" || v === "1";
  }

  async optionNum(key: string, fallback = 0): Promise<number> {
    const v = await this.option(key);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  async setOption(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO options(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }

  async allOptions(): Promise<{ key: string; value: string }[]> {
    const { results } = await this.db.prepare("SELECT key, value FROM options").all<{ key: string; value: string }>();
    const map = new Map(results.map((r) => [r.key, r.value]));
    const out: { key: string; value: string }[] = [];
    const keys = new Set([...Object.keys(DEFAULT_OPTIONS), ...map.keys()]);
    for (const key of keys) {
      const publicId = /ClientId$/i.test(key);
      if (/token$|secret$|key$/i.test(key) && !publicId) continue;
      out.push({ key, value: map.get(key) ?? DEFAULT_OPTIONS[key] ?? "" });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async setupDone(): Promise<boolean> {
    const v = await this.option("Setup");
    if (v === "true" || v === "1") return true;
    const row = await this.db.prepare("SELECT id FROM users WHERE role = 100 LIMIT 1").first();
    return !!row;
  }

  async rootExists(): Promise<boolean> {
    const row = await this.db.prepare("SELECT id FROM users WHERE role = 100 LIMIT 1").first();
    return !!row;
  }

  async getUserById(id: number): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  }

  async getUserByUsername(username: string): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
  }

  async getUserByGithub(githubId: string): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE github_id = ?").bind(githubId).first<UserRow>();
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  }

  async getUserByField(field: string, value: string): Promise<UserRow | null> {
    const allowed = new Set([
      "github_id",
      "discord_id",
      "oidc_id",
      "linuxdo_id",
      "wechat_id",
      "telegram_id",
      "access_token",
      "email",
    ]);
    if (!allowed.has(field)) return null;
    return this.db.prepare(`SELECT * FROM users WHERE ${field} = ?`).bind(value).first<UserRow>();
  }

  async getUserByAff(code: string): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE aff_code = ?").bind(code).first<UserRow>();
  }

  async insertUser(u: Partial<UserRow>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO users (username, password, display_name, role, status, email, github_id, quota, used_quota, request_count, "group", aff_code, inviter_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .bind(
        u.username,
        u.password ?? "",
        u.display_name ?? u.username,
        u.role ?? 1,
        u.status ?? USER_ENABLED,
        u.email ?? "",
        u.github_id ?? "",
        u.quota ?? 0,
        u.group ?? "default",
        u.aff_code ?? "",
        u.inviter_id ?? 0,
        u.created_at ?? nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateUser(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = k === "group" ? `"group"` : k;
      cols.push(`${col} = ?`);
      vals.push(v);
    }
    if (!cols.length) return;
    vals.push(id);
    await this.db.prepare(`UPDATE users SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteUser(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  }

  async listUsers(offset: number, limit: number, keyword = ""): Promise<{ items: UserRow[]; total: number }> {
    let where = "1=1";
    const binds: unknown[] = [];
    if (keyword) {
      where += " AND (username LIKE ? OR display_name LIKE ? OR email LIKE ?)";
      const q = `%${keyword}%`;
      binds.push(q, q, q);
    }
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM users WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM users WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<UserRow>();
    return { items: results, total: num(totalRow?.c) };
  }

  async addQuota(userId: number, delta: number): Promise<void> {
    await this.db.prepare("UPDATE users SET quota = quota + ? WHERE id = ?").bind(delta, userId).run();
  }

  async consumeQuota(userId: number, tokenId: number | null, channelId: number | null, quota: number): Promise<void> {
    await this.db
      .prepare("UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + 1 WHERE id = ?")
      .bind(quota, quota, userId)
      .run();
    if (tokenId) {
      await this.db
        .prepare(
          "UPDATE api_tokens SET used_quota = used_quota + ?, remain_quota = CASE WHEN unlimited_quota = 1 THEN remain_quota ELSE remain_quota - ? END, accessed_time = ? WHERE id = ?",
        )
        .bind(quota, quota, nowSec(), tokenId)
        .run();
    }
    if (channelId) {
      await this.db.prepare("UPDATE channels SET used_quota = used_quota + ? WHERE id = ?").bind(quota, channelId).run();
    }
  }

  async getTokenByKey(key: string): Promise<TokenRow | null> {
    return this.db.prepare("SELECT * FROM api_tokens WHERE key = ?").bind(key).first<TokenRow>();
  }

  async getTokenById(id: number, userId?: number): Promise<TokenRow | null> {
    if (userId != null) {
      return this.db.prepare("SELECT * FROM api_tokens WHERE id = ? AND user_id = ?").bind(id, userId).first<TokenRow>();
    }
    return this.db.prepare("SELECT * FROM api_tokens WHERE id = ?").bind(id).first<TokenRow>();
  }

  async insertToken(t: Partial<TokenRow>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO api_tokens (user_id, key, status, name, created_time, expired_time, remain_quota, unlimited_quota, model_limits_enabled, model_limits, allow_ips, "group")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        t.user_id,
        t.key,
        t.status ?? TOKEN_ENABLED,
        t.name ?? "",
        t.created_time ?? nowSec(),
        t.expired_time ?? -1,
        t.remain_quota ?? 0,
        bool01(t.unlimited_quota),
        bool01(t.model_limits_enabled),
        t.model_limits ?? "",
        t.allow_ips ?? "",
        t.group ?? "",
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateToken(id: number, userId: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = k === "group" ? `"group"` : k;
      cols.push(`${col} = ?`);
      vals.push(v);
    }
    if (!cols.length) return;
    vals.push(id, userId);
    await this.db.prepare(`UPDATE api_tokens SET ${cols.join(", ")} WHERE id = ? AND user_id = ?`).bind(...vals).run();
  }

  async deleteToken(id: number, userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(id, userId).run();
  }

  async listTokens(
    userId: number,
    offset: number,
    limit: number,
    keyword = "",
  ): Promise<{ items: TokenRow[]; total: number }> {
    let where = "user_id = ?";
    const binds: unknown[] = [userId];
    if (keyword) {
      where += " AND (name LIKE ? OR key LIKE ?)";
      const q = `%${keyword}%`;
      binds.push(q, q);
    }
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM api_tokens WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM api_tokens WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<TokenRow>();
    return { items: results, total: num(totalRow?.c) };
  }

  async deleteTokensBatch(userId: number, ids: number[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const r = await this.db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(id, userId).run();
      n += Number(r.meta.changes || 0);
    }
    return n;
  }

  async getChannel(id: number): Promise<ChannelRow | null> {
    return this.db.prepare("SELECT * FROM channels WHERE id = ?").bind(id).first<ChannelRow>();
  }

  async insertChannel(c: Partial<ChannelRow>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO channels (type, key, status, name, weight, created_time, base_url, other, models, "group", model_mapping, status_code_mapping, priority, auto_ban, tag, header_override, param_override, remark, settings, openai_organization, test_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        c.type ?? 1,
        c.key ?? "",
        c.status ?? CHANNEL_ENABLED,
        c.name,
        c.weight ?? 1,
        c.created_time ?? nowSec(),
        c.base_url ?? "",
        c.other ?? "",
        c.models ?? "",
        c.group ?? "default",
        c.model_mapping ?? "",
        c.status_code_mapping ?? "",
        c.priority ?? 0,
        c.auto_ban ?? 1,
        c.tag ?? "",
        c.header_override ?? "",
        c.param_override ?? "",
        c.remark ?? "",
        c.settings ?? "",
        c.openai_organization ?? "",
        c.test_model ?? "",
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateChannel(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = k === "group" ? `"group"` : k;
      cols.push(`${col} = ?`);
      vals.push(v);
    }
    if (!cols.length) return;
    vals.push(id);
    await this.db.prepare(`UPDATE channels SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteChannel(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
  }

  async deleteDisabledChannels(): Promise<number> {
    const r = await this.db.prepare("DELETE FROM channels WHERE status != 1").run();
    return Number(r.meta.changes || 0);
  }

  async deleteChannelsBatch(ids: number[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const r = await this.db.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
      n += Number(r.meta.changes || 0);
    }
    return n;
  }

  async setChannelsByTag(tag: string, status: number): Promise<number> {
    const r = await this.db.prepare("UPDATE channels SET status = ? WHERE tag = ?").bind(status, tag).run();
    return Number(r.meta.changes || 0);
  }

  async channelsByTag(tag: string): Promise<ChannelRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM channels WHERE tag = ?").bind(tag).all<ChannelRow>();
    return results;
  }

  async listChannels(opts: {
    offset: number;
    limit: number;
    keyword?: string;
    group?: string;
    status?: number;
    type?: number;
  }): Promise<{ items: ChannelRow[]; total: number; type_counts: Record<string, number> }> {
    const where: string[] = ["1=1"];
    const binds: unknown[] = [];
    if (opts.keyword) {
      where.push("(name LIKE ? OR models LIKE ? OR remark LIKE ?)");
      const q = `%${opts.keyword}%`;
      binds.push(q, q, q);
    }
    if (opts.group) {
      where.push(`(',' || "group" || ',') LIKE ?`);
      binds.push(`%,${opts.group},%`);
    }
    if (opts.status === CHANNEL_ENABLED) where.push("status = 1");
    else if (opts.status === 0) where.push("status != 1");
    if (opts.type != null && opts.type >= 0) {
      where.push("type = ?");
      binds.push(opts.type);
    }
    const w = where.join(" AND ");
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM channels WHERE ${w}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM channels WHERE ${w} ORDER BY priority DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, opts.limit, opts.offset)
      .all<ChannelRow>();
    const counts = await this.db.prepare("SELECT type, COUNT(*) as c FROM channels GROUP BY type").all<{ type: number; c: number }>();
    const type_counts: Record<string, number> = {};
    for (const r of counts.results) type_counts[String(r.type)] = num(r.c);
    return { items: results, total: num(totalRow?.c), type_counts };
  }

  async enabledChannels(): Promise<ChannelRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM channels WHERE status = 1").all<ChannelRow>();
    return results;
  }

  async autoDisableChannel(id: number): Promise<void> {
    await this.db.prepare("UPDATE channels SET status = ? WHERE id = ? AND auto_ban = 1").bind(CHANNEL_AUTO_DISABLED, id).run();
  }

  async insertLog(l: Partial<LogRow>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO request_logs (user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id, token_id, "group", ip, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        l.user_id ?? 0,
        l.created_at ?? nowSec(),
        l.type ?? LOG_CONSUME,
        l.content ?? "",
        l.username ?? "",
        l.token_name ?? "",
        l.model_name ?? "",
        l.quota ?? 0,
        l.prompt_tokens ?? 0,
        l.completion_tokens ?? 0,
        l.use_time ?? 0,
        l.is_stream ?? 0,
        l.channel_id ?? 0,
        l.token_id ?? 0,
        l.group ?? "",
        l.ip ?? "",
        l.request_id ?? "",
      )
      .run();
  }

  async listLogs(opts: {
    offset: number;
    limit: number;
    userId?: number;
    type?: number;
    start?: number;
    end?: number;
    model?: string;
    username?: string;
    tokenName?: string;
    channel?: number;
    requestId?: string;
  }): Promise<{ items: LogRow[]; total: number }> {
    const where: string[] = ["1=1"];
    const binds: unknown[] = [];
    if (opts.userId) {
      where.push("user_id = ?");
      binds.push(opts.userId);
    }
    if (opts.type) {
      where.push("type = ?");
      binds.push(opts.type);
    }
    if (opts.start) {
      where.push("created_at >= ?");
      binds.push(opts.start);
    }
    if (opts.end) {
      where.push("created_at <= ?");
      binds.push(opts.end);
    }
    if (opts.model) {
      where.push("model_name = ?");
      binds.push(opts.model);
    }
    if (opts.username) {
      where.push("username = ?");
      binds.push(opts.username);
    }
    if (opts.tokenName) {
      where.push("token_name = ?");
      binds.push(opts.tokenName);
    }
    if (opts.channel) {
      where.push("channel_id = ?");
      binds.push(opts.channel);
    }
    if (opts.requestId) {
      where.push("request_id = ?");
      binds.push(opts.requestId);
    }
    const w = where.join(" AND ");
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM request_logs WHERE ${w}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM request_logs WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, opts.limit, opts.offset)
      .all<LogRow>();
    return { items: results, total: num(totalRow?.c) };
  }

  async logStat(opts: { userId?: number; start?: number; end?: number; username?: string }): Promise<{
    quota: number;
    rpm: number;
    tpm: number;
  }> {
    const where: string[] = ["type = 2"];
    const binds: unknown[] = [];
    if (opts.userId) {
      where.push("user_id = ?");
      binds.push(opts.userId);
    }
    if (opts.username) {
      where.push("username = ?");
      binds.push(opts.username);
    }
    if (opts.start) {
      where.push("created_at >= ?");
      binds.push(opts.start);
    }
    if (opts.end) {
      where.push("created_at <= ?");
      binds.push(opts.end);
    }
    const w = where.join(" AND ");
    const row = await this.db
      .prepare(`SELECT COALESCE(SUM(quota),0) as quota FROM request_logs WHERE ${w}`)
      .bind(...binds)
      .first<{ quota: number }>();
    const minuteAgo = nowSec() - 60;
    const rpmRow = await this.db
      .prepare(`SELECT COUNT(*) as c, COALESCE(SUM(prompt_tokens+completion_tokens),0) as t FROM request_logs WHERE ${w} AND created_at >= ?`)
      .bind(...binds, minuteAgo)
      .first<{ c: number; t: number }>();
    return { quota: num(row?.quota), rpm: num(rpmRow?.c), tpm: num(rpmRow?.t) };
  }

  async bumpQuotaData(user: UserRow, model: string, quota: number, tokens: number): Promise<void> {
    const day = dayStartSec();
    const existing = await this.db
      .prepare("SELECT id FROM quota_data WHERE user_id = ? AND model_name = ? AND created_at = ?")
      .bind(user.id, model, day)
      .first<{ id: number }>();
    if (existing) {
      await this.db
        .prepare("UPDATE quota_data SET quota = quota + ?, token_used = token_used + ?, count = count + 1 WHERE id = ?")
        .bind(quota, tokens, existing.id)
        .run();
      return;
    }
    await this.db
      .prepare(
        "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count) VALUES (?, ?, ?, ?, ?, ?, 1)",
      )
      .bind(user.id, user.username, model, day, quota, tokens)
      .run();
  }

  async quotaDates(userId: number | null, start: number, end: number): Promise<unknown[]> {
    const where = userId ? "user_id = ? AND created_at >= ? AND created_at <= ?" : "created_at >= ? AND created_at <= ?";
    const binds = userId ? [userId, start, end] : [start, end];
    const { results } = await this.db
      .prepare(
        `SELECT created_at, model_name, username, SUM(quota) as quota, SUM(token_used) as token_used, SUM(count) as count
         FROM quota_data WHERE ${where} GROUP BY created_at, model_name, username ORDER BY created_at`,
      )
      .bind(...binds)
      .all();
    return results;
  }

  async insertRedemption(r: Partial<RedemptionRow>): Promise<number> {
    const res = await this.db
      .prepare("INSERT INTO redemptions (name, key, status, quota, created_time) VALUES (?, ?, 1, ?, ?)")
      .bind(r.name ?? "", r.key, r.quota ?? 0, nowSec())
      .run();
    return Number(res.meta.last_row_id || 0);
  }

  async getRedemptionByKey(key: string): Promise<RedemptionRow | null> {
    return this.db.prepare("SELECT * FROM redemptions WHERE key = ?").bind(key).first<RedemptionRow>();
  }

  async getRedemption(id: number): Promise<RedemptionRow | null> {
    return this.db.prepare("SELECT * FROM redemptions WHERE id = ?").bind(id).first<RedemptionRow>();
  }

  async listRedemptions(
    offset: number,
    limit: number,
    keyword = "",
  ): Promise<{ items: RedemptionRow[]; total: number }> {
    let where = "1=1";
    const binds: unknown[] = [];
    if (keyword) {
      where += " AND (name LIKE ? OR key LIKE ?)";
      const q = `%${keyword}%`;
      binds.push(q, q);
    }
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM redemptions WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM redemptions WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<RedemptionRow>();
    return { items: results, total: num(totalRow?.c) };
  }

  async deleteRedemptionsBatch(ids: number[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const r = await this.db.prepare("DELETE FROM redemptions WHERE id = ?").bind(id).run();
      n += Number(r.meta.changes || 0);
    }
    return n;
  }

  async deleteInvalidRedemptions(): Promise<number> {
    const r = await this.db.prepare("DELETE FROM redemptions WHERE status != 1").run();
    return Number(r.meta.changes || 0);
  }

  async updateRedemption(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE redemptions SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteRedemption(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM redemptions WHERE id = ?").bind(id).run();
  }

  async uniqueGroups(): Promise<string[]> {
    const { results } = await this.db.prepare(`SELECT DISTINCT "group" as g FROM channels`).all<{ g: string }>();
    const set = new Set<string>(["default"]);
    for (const r of results) for (const g of csv(r.g || "")) set.add(g);
    const { results: ur } = await this.db.prepare(`SELECT DISTINCT "group" as g FROM users`).all<{ g: string }>();
    for (const r of ur) if (r.g) set.add(r.g);
    return [...set];
  }

  async audit(userId: number, username: string, type: string, content: string, ip: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO audit_logs (user_id, username, created_at, type, content, ip) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, username, nowSec(), type, content, ip)
      .run();
  }

  async listAudit(offset: number, limit: number, userId?: number): Promise<{ items: unknown[]; total: number }> {
    const where = userId ? "user_id = ?" : "1=1";
    const binds: unknown[] = userId ? [userId] : [];
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM audit_logs WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return { items: results, total: num(totalRow?.c) };
  }

  async insertMj(task: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO mj_tasks (action, user_id, mj_id, prompt, prompt_en, status, image_url, progress, fail_reason, channel_id, submit_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        task.action ?? "",
        task.user_id ?? 0,
        task.mj_id ?? "",
        task.prompt ?? "",
        task.prompt_en ?? "",
        task.status ?? "SUBMITTED",
        task.image_url ?? "",
        task.progress ?? "0%",
        task.fail_reason ?? "",
        task.channel_id ?? 0,
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async listMj(userId: number | null, offset: number, limit: number): Promise<{ items: unknown[]; total: number }> {
    const where = userId ? "user_id = ?" : "1=1";
    const binds: unknown[] = userId ? [userId] : [];
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM mj_tasks WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM mj_tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return { items: results, total: num(totalRow?.c) };
  }

  async enabledModels(group: string): Promise<string[]> {
    const channels = await this.enabledChannels();
    const set = new Set<string>();
    for (const c of channels) {
      const groups = csv(c.group || "default");
      if (groups.length && !groups.includes(group) && !groups.includes("all")) continue;
      for (const m of csv(c.models)) set.add(m);
    }
    return [...set].sort();
  }

  async counts(): Promise<{ users: number; channels: number; tokens: number; logs: number }> {
    const u = await this.db.prepare("SELECT COUNT(*) as c FROM users").first<{ c: number }>();
    const c = await this.db.prepare("SELECT COUNT(*) as c FROM channels").first<{ c: number }>();
    const t = await this.db.prepare("SELECT COUNT(*) as c FROM api_tokens").first<{ c: number }>();
    const l = await this.db.prepare("SELECT COUNT(*) as c FROM request_logs").first<{ c: number }>();
    return { users: num(u?.c), channels: num(c?.c), tokens: num(t?.c), logs: num(l?.c) };
  }

  async insertSession(row: {
    sid: string;
    user_id: number;
    ip: string;
    ua: string;
    expires_at: number;
  }): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO login_sessions (sid, user_id, created_at, last_seen, expires_at, ip, ua, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .bind(row.sid, row.user_id, nowSec(), nowSec(), row.expires_at, row.ip, row.ua)
      .run();
  }

  async getSession(sid: string): Promise<{
    sid: string;
    user_id: number;
    revoked: number;
    expires_at: number;
    ip: string;
    ua: string;
    created_at: number;
    last_seen: number;
  } | null> {
    return this.db.prepare("SELECT * FROM login_sessions WHERE sid = ?").bind(sid).first();
  }

  async touchSession(sid: string): Promise<void> {
    await this.db.prepare("UPDATE login_sessions SET last_seen = ? WHERE sid = ?").bind(nowSec(), sid).run();
  }

  async revokeSession(sid: string, userId?: number): Promise<void> {
    if (userId != null) {
      await this.db.prepare("UPDATE login_sessions SET revoked = 1 WHERE sid = ? AND user_id = ?").bind(sid, userId).run();
      return;
    }
    await this.db.prepare("UPDATE login_sessions SET revoked = 1 WHERE sid = ?").bind(sid).run();
  }

  async revokeOtherSessions(userId: number, keepSid: string): Promise<void> {
    await this.db
      .prepare("UPDATE login_sessions SET revoked = 1 WHERE user_id = ? AND sid != ?")
      .bind(userId, keepSid)
      .run();
  }

  async listSessions(userId: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare("SELECT sid, created_at, last_seen, ip, ua, revoked, expires_at FROM login_sessions WHERE user_id = ? ORDER BY last_seen DESC")
      .bind(userId)
      .all();
    return results;
  }

  async insertAuthFlow(row: { token: string; type: string; user_id: number; expires_at: number; payload?: string }): Promise<void> {
    await this.db
      .prepare("INSERT INTO auth_flows (token, type, user_id, expires_at, payload) VALUES (?, ?, ?, ?, ?)")
      .bind(row.token, row.type, row.user_id, row.expires_at, row.payload ?? "")
      .run();
  }

  async getAuthFlow(token: string): Promise<{ token: string; type: string; user_id: number; expires_at: number; payload: string } | null> {
    return this.db.prepare("SELECT * FROM auth_flows WHERE token = ?").bind(token).first();
  }

  async deleteAuthFlow(token: string): Promise<void> {
    await this.db.prepare("DELETE FROM auth_flows WHERE token = ?").bind(token).run();
  }

  async insertEmailCode(email: string, code: string, type: string, ttlSec = 600): Promise<void> {
    await this.db
      .prepare("INSERT INTO email_codes (email, code, type, expires_at, used) VALUES (?, ?, ?, ?, 0)")
      .bind(email, code, type, nowSec() + ttlSec)
      .run();
  }

  async consumeEmailCode(email: string, code: string, type: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM email_codes WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at >= ? ORDER BY id DESC LIMIT 1")
      .bind(email, code, type, nowSec())
      .first<{ id: number }>();
    if (!row) return false;
    await this.db.prepare("UPDATE email_codes SET used = 1 WHERE id = ?").bind(row.id).run();
    return true;
  }

  async insertTopup(row: {
    user_id: number;
    amount: number;
    money?: number;
    trade_no?: string;
    payment_method?: string;
    status?: string;
  }): Promise<number> {
    const r = await this.db
      .prepare(
        "INSERT INTO topups (user_id, amount, money, trade_no, payment_method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.user_id,
        row.amount,
        row.money ?? 0,
        row.trade_no ?? "",
        row.payment_method ?? "redemption",
        row.status ?? "success",
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async listTopups(userId: number | null, offset: number, limit: number): Promise<{ items: unknown[]; total: number }> {
    const where = userId ? "user_id = ?" : "1=1";
    const binds: unknown[] = userId ? [userId] : [];
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM topups WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM topups WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return { items: results, total: num(totalRow?.c) };
  }

  async rankings(start: number, end: number, limit = 50): Promise<unknown[]> {
    const { results } = await this.db
      .prepare(
        `SELECT username, user_id, SUM(quota) as quota, SUM(token_used) as token_used, SUM(count) as count
         FROM quota_data WHERE created_at >= ? AND created_at <= ?
         GROUP BY user_id, username ORDER BY quota DESC LIMIT ?`,
      )
      .bind(start, end, limit)
      .all();
    return results;
  }

  async listPlans(enabledOnly = false): Promise<unknown[]> {
    const sql = enabledOnly
      ? "SELECT * FROM subscription_plans WHERE enabled = 1 ORDER BY id"
      : "SELECT * FROM subscription_plans ORDER BY id";
    const { results } = await this.db.prepare(sql).all();
    return results;
  }

  async getPlan(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM subscription_plans WHERE id = ?").bind(id).first();
  }

  async insertPlan(p: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO subscription_plans (title, description, price_quota, duration_days, grant_quota, "group", models, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.title ?? "",
        p.description ?? "",
        Number(p.price_quota || 0),
        Number(p.duration_days || 30),
        Number(p.grant_quota || 0),
        p.group ?? "",
        p.models ?? "",
        p.enabled == null ? 1 : Number(p.enabled),
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updatePlan(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = k === "group" ? `"group"` : k;
      cols.push(`${col} = ?`);
      vals.push(v);
    }
    if (!cols.length) return;
    vals.push(id);
    await this.db.prepare(`UPDATE subscription_plans SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async listUserSubs(userId: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.*, p.title as plan_title FROM user_subscriptions s
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.user_id = ? ORDER BY s.id DESC`,
      )
      .bind(userId)
      .all();
    return results;
  }

  async insertUserSub(row: {
    user_id: number;
    plan_id: number;
    start_at: number;
    expire_at: number;
    remaining_quota: number;
  }): Promise<number> {
    const r = await this.db
      .prepare(
        "INSERT INTO user_subscriptions (user_id, plan_id, start_at, expire_at, status, remaining_quota, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      )
      .bind(row.user_id, row.plan_id, row.start_at, row.expire_at, row.remaining_quota, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateUserSub(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE user_subscriptions SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteUserSub(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM user_subscriptions WHERE id = ?").bind(id).run();
  }

  async expireSubscriptions(): Promise<void> {
    await this.db
      .prepare("UPDATE user_subscriptions SET status = 2 WHERE status = 1 AND expire_at > 0 AND expire_at < ?")
      .bind(nowSec())
      .run();
  }

  async insertTask(row: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO tasks (task_id, user_id, token_id, channel_id, platform, action, status, progress, model_name, prompt, fail_reason, result, properties, submit_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.task_id ?? crypto.randomUUID(),
        row.user_id ?? 0,
        row.token_id ?? 0,
        row.channel_id ?? 0,
        row.platform ?? "",
        row.action ?? "",
        row.status ?? "SUBMITTED",
        row.progress ?? "0%",
        row.model_name ?? "",
        row.prompt ?? "",
        row.fail_reason ?? "",
        typeof row.result === "string" ? row.result : JSON.stringify(row.result ?? ""),
        typeof row.properties === "string" ? row.properties : JSON.stringify(row.properties ?? {}),
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async getTaskByTid(taskId: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").bind(taskId).first();
  }

  async updateTaskByTid(taskId: string, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    if (!cols.length) return;
    vals.push(taskId);
    await this.db.prepare(`UPDATE tasks SET ${cols.join(", ")} WHERE task_id = ?`).bind(...vals).run();
  }

  async listTasks(userId: number | null, offset: number, limit: number): Promise<{ items: unknown[]; total: number }> {
    const where = userId ? "user_id = ?" : "1=1";
    const binds: unknown[] = userId ? [userId] : [];
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return { items: results, total: num(totalRow?.c) };
  }

  async listConversations(userId: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(userId)
      .all();
    return results;
  }

  async getConversation(id: number, userId: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).first();
  }

  async insertConversation(userId: number, title: string, model: string): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO conversations (user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, title, model, nowSec(), nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateConversation(id: number, userId: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    cols.push("updated_at = ?");
    vals.push(nowSec(), id, userId);
    await this.db.prepare(`UPDATE conversations SET ${cols.join(", ")} WHERE id = ? AND user_id = ?`).bind(...vals).run();
  }

  async deleteConversation(id: number, userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).run();
  }

  async listMessages(conversationId: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id")
      .bind(conversationId)
      .all();
    return results;
  }

  async insertMessage(conversationId: number, role: string, content: string): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .bind(conversationId, role, content, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async listVendors(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM vendors ORDER BY id").all();
    return results;
  }

  async getVendor(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM vendors WHERE id = ?").bind(id).first();
  }

  async insertVendor(name: string, description = "", icon = ""): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO vendors (name, description, icon, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, description, icon, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateVendor(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE vendors SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteVendor(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM vendors WHERE id = ?").bind(id).run();
  }

  async listPrefill(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM prefill_groups ORDER BY id").all();
    return results;
  }

  async insertPrefill(name: string, type: string, items: string): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO prefill_groups (name, type, items, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, type, items, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updatePrefill(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE prefill_groups SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deletePrefill(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM prefill_groups WHERE id = ?").bind(id).run();
  }

  async listOAuthProviders(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM oauth_providers ORDER BY id").all();
    return results;
  }

  async getOAuthProvider(idOrSlug: string | number): Promise<Record<string, unknown> | null> {
    if (typeof idOrSlug === "number" || /^\d+$/.test(String(idOrSlug))) {
      return this.db.prepare("SELECT * FROM oauth_providers WHERE id = ?").bind(Number(idOrSlug)).first();
    }
    return this.db.prepare("SELECT * FROM oauth_providers WHERE slug = ?").bind(String(idOrSlug)).first();
  }

  async insertOAuthProvider(p: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        "INSERT INTO oauth_providers (name, slug, client_id, client_secret, auth_url, token_url, user_info_url, scopes, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        p.name ?? "",
        p.slug ?? "",
        p.client_id ?? "",
        p.client_secret ?? "",
        p.auth_url ?? "",
        p.token_url ?? "",
        p.user_info_url ?? "",
        p.scopes ?? "",
        p.enabled == null ? 1 : Number(p.enabled),
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateOAuthProvider(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE oauth_providers SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteOAuthProvider(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM oauth_providers WHERE id = ?").bind(id).run();
  }

  async listPasskeys(userId: number): Promise<{ id: number; credential_id: string; public_key: string; name: string; created_at: number }[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM passkeys WHERE user_id = ?")
      .bind(userId)
      .all<{ id: number; credential_id: string; public_key: string; name: string; created_at: number }>();
    return results;
  }

  async getPasskeyByCred(credentialId: string): Promise<{
    id: number;
    user_id: number;
    credential_id: string;
    public_key: string;
  } | null> {
    return this.db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").bind(credentialId).first();
  }

  async insertPasskey(userId: number, credentialId: string, publicKey: string, name = ""): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, credentialId, publicKey, name, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async deletePasskeys(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId).run();
  }

  async listModelMeta(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM model_meta ORDER BY id").all();
    return results;
  }

  async insertModelMeta(model_name: string, description = "", vendor_id = 0): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO model_meta (model_name, description, vendor_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(model_name, description, vendor_id, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateModelMeta(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE model_meta SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteModelMeta(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM model_meta WHERE id = ?").bind(id).run();
  }

  async cleanupExpired(cutoff: number): Promise<void> {
    await this.db.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(cutoff).run();
    await this.db.prepare("DELETE FROM auth_flows WHERE expires_at < ?").bind(cutoff).run();
    await this.db.prepare("UPDATE login_sessions SET revoked = 1 WHERE expires_at > 0 AND expires_at < ?").bind(nowSec()).run();
    await this.expireSubscriptions();
  }
}

export function publicUser(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
    email: u.email,
    github_id: u.github_id,
    discord_id: u.discord_id || "",
    linuxdo_id: u.linuxdo_id || "",
    oidc_id: u.oidc_id || "",
    group: u.group,
    quota: u.quota,
    used_quota: u.used_quota,
    request_count: u.request_count,
    aff_code: u.aff_code,
    aff_quota: u.aff_quota || 0,
    aff_count: u.aff_count || 0,
    billing_preference: u.billing_preference || "quota",
    totp_enabled: Number(u.totp_enabled) === 1,
    email_verified: Number(u.email_verified) === 1,
    has_password: !!u.password,
    has_access_token: Boolean(u.access_token),
    settings: u.settings || "",
  };
}

export function permissionsFor(role: number): Record<string, unknown> {
  const admin = role >= 10;
  const root = role >= 100;
  return {
    is_admin: admin,
    is_root: root,
    admin_permissions: admin
      ? {
          channel: true,
          user: true,
          redemption: true,
          token: true,
          log: true,
          setting: root,
        }
      : {},
  };
}

export function stripChannelKey(c: ChannelRow): Record<string, unknown> {
  const { key: _k, ...rest } = c;
  return { ...rest, key: "" };
}
