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
  parseJson,
} from "./constants.js";
import { capabilities } from "./authz.js";
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
        `INSERT INTO users (username, password, display_name, role, status, email, github_id, discord_id, oidc_id, linuxdo_id, wechat_id, telegram_id, quota, used_quota, request_count, "group", aff_code, inviter_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .bind(
        u.username,
        u.password ?? "",
        u.display_name ?? u.username,
        u.role ?? 1,
        u.status ?? USER_ENABLED,
        u.email ?? "",
        u.github_id ?? "",
        u.discord_id ?? "",
        u.oidc_id ?? "",
        u.linuxdo_id ?? "",
        u.wechat_id ?? "",
        u.telegram_id ?? "",
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
        `INSERT INTO api_tokens (user_id, key, status, name, created_time, expired_time, remain_quota, unlimited_quota, model_limits_enabled, model_limits, allow_ips, "group", auto_groups, cross_group_retry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        t.auto_groups ?? "",
        bool01(t.cross_group_retry),
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
        `INSERT INTO channels (type, key, status, name, weight, created_time, base_url, other, models, "group", model_mapping, status_code_mapping, priority, auto_ban, tag, header_override, param_override, remark, settings, openai_organization, test_model, balance, balance_updated_time, other_info, channel_info, setting)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        c.balance ?? "",
        c.balance_updated_time ?? 0,
        c.other_info ?? "",
        c.channel_info ?? "",
        c.setting ?? "",
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
        `INSERT INTO request_logs (user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id, token_id, "group", ip, request_id, upstream_request_id, other)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        l.upstream_request_id ?? "",
        l.other ?? "",
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
    group?: string;
    upstreamRequestId?: string;
  }): Promise<{ items: LogRow[]; total: number }> {
    const where: string[] = ["1=1"];
    const binds: unknown[] = [];
    if (opts.userId) {
      where.push("request_logs.user_id = ?");
      binds.push(opts.userId);
    }
    if (opts.type) {
      where.push("request_logs.type = ?");
      binds.push(opts.type);
    }
    if (opts.start) {
      where.push("request_logs.created_at >= ?");
      binds.push(opts.start);
    }
    if (opts.end) {
      where.push("request_logs.created_at <= ?");
      binds.push(opts.end);
    }
    if (opts.model) {
      where.push("request_logs.model_name = ?");
      binds.push(opts.model);
    }
    if (opts.username) {
      where.push("request_logs.username = ?");
      binds.push(opts.username);
    }
    if (opts.tokenName) {
      where.push("request_logs.token_name = ?");
      binds.push(opts.tokenName);
    }
    if (opts.channel) {
      where.push("request_logs.channel_id = ?");
      binds.push(opts.channel);
    }
    if (opts.requestId) {
      where.push("request_logs.request_id = ?");
      binds.push(opts.requestId);
    }
    if (opts.group) {
      where.push('request_logs."group" = ?');
      binds.push(opts.group);
    }
    if (opts.upstreamRequestId) {
      where.push("request_logs.upstream_request_id = ?");
      binds.push(opts.upstreamRequestId);
    }
    const w = where.join(" AND ");
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM request_logs WHERE ${w}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(
        `SELECT request_logs.*, channels.name as channel_name FROM request_logs LEFT JOIN channels ON channels.id = request_logs.channel_id WHERE ${w} ORDER BY request_logs.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, opts.limit, opts.offset)
      .all<LogRow>();
    return { items: results, total: num(totalRow?.c) };
  }

  async logStat(opts: {
    userId?: number;
    start?: number;
    end?: number;
    username?: string;
    tokenName?: string;
    model?: string;
    channel?: number;
    group?: string;
    type?: number;
  }): Promise<{
    quota: number;
    rpm: number;
    tpm: number;
  }> {
    const where: string[] = [`type = ${Number(opts.type || 2)}`];
    const binds: unknown[] = [];
    if (opts.userId) {
      where.push("user_id = ?");
      binds.push(opts.userId);
    }
    if (opts.username) {
      where.push("username = ?");
      binds.push(opts.username);
    }
    if (opts.tokenName) {
      where.push("token_name = ?");
      binds.push(opts.tokenName);
    }
    if (opts.model) {
      where.push("model_name = ?");
      binds.push(opts.model);
    }
    if (opts.channel) {
      where.push("channel_id = ?");
      binds.push(opts.channel);
    }
    if (opts.group) {
      where.push('"group" = ?');
      binds.push(opts.group);
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
        "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (?, ?, ?, ?, ?, ?, 1, '', 0, 0, 'workerd')",
      )
      .bind(user.id, user.username, model, day, quota, tokens)
      .run();
  }

  async quotaDates(userId: number | null, start: number, end: number, username = ""): Promise<unknown[]> {
    const where = ["created_at >= ?", "created_at <= ?"];
    const binds: unknown[] = [start, end];
    if (userId) {
      where.push("user_id = ?");
      binds.push(userId);
    }
    if (username) {
      where.push("username = ?");
      binds.push(username);
    }
    const { results } = await this.db
      .prepare(
        `SELECT created_at, model_name, username, use_group, token_id, channel_id, node_name, SUM(quota) as quota, SUM(token_used) as token_used, SUM(count) as count
         FROM quota_data WHERE ${where.join(" AND ")} GROUP BY created_at, model_name, username, use_group, token_id, channel_id, node_name ORDER BY created_at`,
      )
      .bind(...binds)
      .all();
    return results;
  }

  async quotaDatesByUser(start: number, end: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare(
        `SELECT user_id, username, SUM(quota) as quota, SUM(token_used) as token_used, SUM(count) as count
         FROM quota_data WHERE created_at >= ? AND created_at <= ? GROUP BY user_id, username ORDER BY quota DESC`,
      )
      .bind(start, end)
      .all();
    return results;
  }

  async flowQuotaDates(start: number, end: number, userId: number | null, username = ""): Promise<unknown[]> {
    const where = ["created_at >= ?", "created_at <= ?"];
    const binds: unknown[] = [start, end];
    if (userId) {
      where.push("user_id = ?");
      binds.push(userId);
    }
    if (username) {
      where.push("username = ?");
      binds.push(username);
    }
    const { results } = await this.db
      .prepare(
        `SELECT created_at, model_name, username, quota, prompt_tokens, completion_tokens, token_id, channel_id
         FROM request_logs WHERE ${where.join(" AND ")} ORDER BY created_at`,
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
    const ratios = parseJson<Record<string, number>>(await this.option("GroupRatio"), { default: 1 });
    return Object.keys(ratios);
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
    return this.enabledModelsForGroups([group]);
  }

  async enabledModelsAll(): Promise<string[]> {
    const channels = await this.enabledChannels();
    const set = new Set<string>();
    for (const c of channels) {
      for (const m of csv(c.models)) set.add(m);
    }
    return [...set].sort();
  }

  async enabledModelsForGroups(groups: string[]): Promise<string[]> {
    if (!groups.length) return [];
    const channels = await this.enabledChannels();
    const want = new Set(groups.filter(Boolean));
    const set = new Set<string>();
    for (const c of channels) {
      const chGroups = csv(c.group || "default");
      if (want.size && !chGroups.includes("all") && !chGroups.some((g) => want.has(g))) continue;
      for (const m of csv(c.models)) set.add(m);
    }
    return [...set].sort();
  }

  async hasCheckedIn(userId: number, date: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM checkins WHERE user_id = ? AND checkin_date = ?")
      .bind(userId, date)
      .first<{ id: number }>();
    return !!row;
  }

  async insertCheckin(userId: number, date: string, quota: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO checkins (user_id, checkin_date, quota_awarded, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, date, quota, nowSec())
      .run();
  }

  async checkinStats(
    userId: number,
    month: string,
  ): Promise<{
    checked_in_today: boolean;
    total_checkins: number;
    total_quota: number;
    checkin_count: number;
    records: { checkin_date: string; quota_awarded: number }[];
  }> {
    const start = `${month}-01`;
    const end = `${month}-31`;
    const { results } = await this.db
      .prepare(
        "SELECT checkin_date, quota_awarded FROM checkins WHERE user_id = ? AND checkin_date >= ? AND checkin_date <= ? ORDER BY checkin_date DESC",
      )
      .bind(userId, start, end)
      .all<{ checkin_date: string; quota_awarded: number }>();
    const totals = await this.db
      .prepare("SELECT COUNT(*) as c, COALESCE(SUM(quota_awarded),0) as q FROM checkins WHERE user_id = ?")
      .bind(userId)
      .first<{ c: number; q: number }>();
    const today = new Date().toISOString().slice(0, 10);
    return {
      checked_in_today: await this.hasCheckedIn(userId, today),
      total_checkins: num(totals?.c),
      total_quota: num(totals?.q),
      checkin_count: results.length,
      records: results,
    };
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
    login_method?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO login_sessions (sid, user_id, created_at, last_seen, expires_at, ip, ua, revoked, login_method) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .bind(row.sid, row.user_id, nowSec(), nowSec(), row.expires_at, row.ip, row.ua, row.login_method || "password")
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
    login_method?: string;
  } | null> {
    return this.db.prepare("SELECT * FROM login_sessions WHERE sid = ?").bind(sid).first();
  }

  async touchSession(sid: string): Promise<void> {
    await this.db.prepare("UPDATE login_sessions SET last_seen = ? WHERE sid = ?").bind(nowSec(), sid).run();
  }

  async extendSession(sid: string, expiresAt: number, ip: string, ua: string): Promise<void> {
    await this.db
      .prepare("UPDATE login_sessions SET last_seen = ?, expires_at = ?, ip = ?, ua = ? WHERE sid = ?")
      .bind(nowSec(), expiresAt, ip, ua, sid)
      .run();
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

  async listSessions(userId: number): Promise<
    {
      sid: string;
      created_at: number;
      last_seen: number;
      ip: string;
      ua: string;
      revoked: number;
      expires_at: number;
      login_method?: string;
    }[]
  > {
    const { results } = await this.db
      .prepare(
        "SELECT sid, created_at, last_seen, ip, ua, revoked, expires_at, login_method FROM login_sessions WHERE user_id = ? ORDER BY last_seen DESC",
      )
      .bind(userId)
      .all();
    return results as {
      sid: string;
      created_at: number;
      last_seen: number;
      ip: string;
      ua: string;
      revoked: number;
      expires_at: number;
      login_method?: string;
    }[];
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

  async getTopupByTrade(tradeNo: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM topups WHERE trade_no = ?").bind(tradeNo).first();
  }

  async updateTopup(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE topups SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async rankings(start: number, end: number, limit = 50): Promise<{ model_name: string; token_used: number; quota: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT model_name, SUM(token_used) as token_used, SUM(quota) as quota
         FROM quota_data WHERE created_at >= ? AND created_at <= ?
         GROUP BY model_name ORDER BY token_used DESC LIMIT ?`,
      )
      .bind(start, end, limit)
      .all<{ model_name: string; token_used: number; quota: number }>();
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

  async getModelMeta(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM model_meta WHERE id = ?").bind(id).first();
  }

  async searchModelMeta(keyword: string): Promise<unknown[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM model_meta WHERE model_name LIKE ? OR description LIKE ? ORDER BY id")
      .bind(`%${keyword}%`, `%${keyword}%`)
      .all();
    return results;
  }

  async deleteModelMetaBatch(ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const ph = ids.map(() => "?").join(",");
    const r = await this.db.prepare(`DELETE FROM model_meta WHERE id IN (${ph})`).bind(...ids).run();
    return Number(r.meta.changes || 0);
  }

  async listTaskPlugins(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM task_plugins ORDER BY key").all();
    return results;
  }

  async getTaskPlugin(key: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM task_plugins WHERE key = ?").bind(key).first();
  }

  async upsertTaskPlugin(p: Record<string, unknown>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO task_plugins (key, name, version, status, active_version, icon, manifest, routes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name=excluded.name, version=excluded.version, status=excluded.status,
           active_version=excluded.active_version, icon=excluded.icon, manifest=excluded.manifest, routes=excluded.routes, updated_at=excluded.updated_at`,
      )
      .bind(
        String(p.key),
        String(p.name || p.key),
        String(p.version || "1.0.0"),
        String(p.status || "inactive"),
        String(p.active_version || p.version || "1.0.0"),
        String(p.icon || ""),
        typeof p.manifest === "string" ? p.manifest : JSON.stringify(p.manifest || {}),
        typeof p.routes === "string" ? p.routes : JSON.stringify(p.routes || []),
        nowSec(),
        nowSec(),
      )
      .run();
  }

  async deleteTaskPlugin(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM task_plugins WHERE key = ?").bind(key).run();
  }

  async insertSystemTask(row: { id: string; type: string; status?: string; progress?: string; result?: string }): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO system_tasks (id, type, status, progress, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.type, row.status || "running", row.progress ?? "", row.result ?? "", nowSec(), nowSec())
      .run();
  }

  async updateSystemTask(id: string, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = ["updated_at = ?"];
    const vals: unknown[] = [nowSec()];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE system_tasks SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async listSystemTasks(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM system_tasks ORDER BY created_at DESC").all();
    return results;
  }

  async getSystemTask(id: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM system_tasks WHERE id = ?").bind(id).first();
  }

  async currentSystemTask(): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM system_tasks WHERE status = 'running' ORDER BY created_at DESC LIMIT 1").first();
  }

  async listDeployments(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM deployments ORDER BY id DESC").all();
    return results;
  }

  async getDeployment(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM deployments WHERE id = ?").bind(id).first();
  }

  async insertDeployment(p: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        "INSERT INTO deployments (name, model_name, status, hardware, location, replicas, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        String(p.name || ""),
        String(p.model_name || ""),
        String(p.status || "pending"),
        String(p.hardware || ""),
        String(p.location || ""),
        Number(p.replicas || 1),
        typeof p.extra === "string" ? p.extra : JSON.stringify(p.extra || {}),
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateDeployment(id: number, patch: Record<string, unknown>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(id);
    await this.db.prepare(`UPDATE deployments SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteDeployment(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM deployments WHERE id = ?").bind(id).run();
  }

  async cleanupExpired(cutoff: number): Promise<void> {
    await this.db.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(cutoff).run();
    await this.db.prepare("DELETE FROM auth_flows WHERE expires_at < ?").bind(cutoff).run();
    await this.db.prepare("UPDATE login_sessions SET revoked = 1 WHERE expires_at > 0 AND expires_at < ?").bind(nowSec()).run();
    await this.expireSubscriptions();
  }
}

export function publicUser(u: UserRow): Record<string, unknown> {
  const settingRaw = u.settings || "";
  let sidebar_modules = "";
  let stripe_customer = "";
  try {
    const parsed = JSON.parse(settingRaw || "{}") as Record<string, unknown>;
    sidebar_modules = String(parsed.sidebar_modules || parsed.SidebarModules || "");
    stripe_customer = String(parsed.stripe_customer || parsed.stripeCustomer || "");
  } catch {
    /* setting is not JSON */
  }
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    has_password: !!u.password,
    role: u.role,
    status: u.status,
    email: u.email,
    github_id: u.github_id,
    discord_id: u.discord_id || "",
    oidc_id: u.oidc_id || "",
    wechat_id: u.wechat_id || "",
    telegram_id: u.telegram_id || "",
    group: u.group,
    quota: u.quota,
    used_quota: u.used_quota,
    request_count: u.request_count,
    aff_code: u.aff_code,
    aff_count: u.aff_count || 0,
    aff_quota: u.aff_quota || 0,
    aff_history_quota: u.aff_history_quota ?? u.aff_quota ?? 0,
    inviter_id: u.inviter_id,
    linux_do_id: u.linuxdo_id || "",
    setting: settingRaw,
    stripe_customer,
    sidebar_modules,
    permissions: permissionsFor(u.role),
    billing_preference: u.billing_preference || "quota",
    totp_enabled: Number(u.totp_enabled) === 1,
    email_verified: Number(u.email_verified) === 1,
    has_access_token: Boolean(u.access_token),
  };
}

export function permissionsFor(role: number): Record<string, unknown> {
  const admin = role >= 10;
  const root = role >= 100;
  return {
    sidebar_settings: !root,
    sidebar_modules: root ? {} : admin ? { admin: { setting: false } } : { admin: false },
    admin_permissions: capabilities(role),
    is_admin: admin,
    is_root: root,
  };
}

export { publicToken, publicChannel, stripChannelKey } from "./dto.js";
