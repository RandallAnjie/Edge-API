import {
  CHANNEL_AUTO_DISABLED,
  CHANNEL_ENABLED,
  DEFAULT_GROUP_RATIO,
  DEFAULT_OPTIONS,
  LOG_CONSUME,
  NAME_RULE_EXACT,
  REDEMPTION_DISABLED,
  REDEMPTION_ENABLED,
  REDEMPTION_USED,
  TOKEN_ENABLED,
  USER_ENABLED,
  csv,
  hourStartSec,
  nowSec,
  parseJson,
} from "./constants.js";
import { OPTION_ALIASES } from "./option-defaults.js";
import { capabilities, parsePermissionOverrides } from "./authz.js";
import { pickAbilityChannelId } from "./select.js";
import { routingMatchModelName } from "./ratio-setting.js";
import {
  channelSatisfiesFilters,
  identityFilterRequiresKey,
  type ChannelFilter,
} from "./channel-constraint.js";
import { SCHEMA_SQL, ensureSchema } from "./schema.js";
import { normalizeBillingPreference } from "./subscription.js";
import { MODEL_PRICING_OPTION_KEYS } from "./model-pricing.js";
import type {
  ChannelRow,
  D1Database,
  LogRow,
  LoginSessionRow,
  RedemptionRow,
  TokenRow,
  UserRow,
} from "./types.js";

export { SCHEMA_SQL, ensureSchema };

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Original `model.applyExplicitLogTextFilter` + `sanitizeLikePattern`. */
function applyExplicitLogTextFilter(column: string, value: string | undefined, where: string[], binds: unknown[]): void {
  if (!value) return;
  if (!value.includes("%")) {
    where.push(`${column} = ?`);
    binds.push(value);
    return;
  }
  const pattern = value.replace(/!/g, "!!").replace(/_/g, "!_");
  if (pattern.includes("%%")) throw new Error("搜索模式中不允许包含连续的 % 通配符");
  const count = (pattern.match(/%/g) || []).length;
  if (count > 2) throw new Error("搜索模式中最多允许包含 2 个 % 通配符");
  if (count > 0 && pattern.replace(/%/g, "").length < 2) {
    throw new Error("使用模糊搜索时，关键词长度至少为 2 个字符");
  }
  where.push(`${column} LIKE ? ESCAPE '!'`);
  binds.push(pattern);
}

function bool01(v: unknown): number {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  return 0;
}

const CHANNEL_SORT_COLUMNS = new Set(["id", "name", "priority", "balance", "response_time", "test_time"]);

function channelOrderSql(sortBy?: string, sortOrder?: string, idSort?: boolean): string {
  const col = String(sortBy || "").toLowerCase().trim();
  if (CHANNEL_SORT_COLUMNS.has(col)) {
    const dir = String(sortOrder || "").toLowerCase() === "asc" ? "ASC" : "DESC";
    return `${col} ${dir}`;
  }
  if (idSort) return "id DESC";
  return "priority DESC";
}

export class Store {
  constructor(private db: D1Database) {}

  async option(key: string): Promise<string> {
    const keys = [key, ...(OPTION_ALIASES[key] || [])];
    for (const k of keys) {
      const row = await this.db.prepare("SELECT value FROM options WHERE key = ?").bind(k).first<{ value: string }>();
      if (row?.value != null) return row.value;
    }
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, k)) return DEFAULT_OPTIONS[k];
    }
    return "";
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

  /** Original GORM default scope excludes soft-deleted users. Unscoped uniqueness uses `includeDeleted`. */
  async getRootUser(): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE role = 100 AND deleted_at = 0 LIMIT 1").first<UserRow>();
  }

  async getUserById(id: number, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
    const sql = opts?.includeDeleted
      ? "SELECT * FROM users WHERE id = ?"
      : "SELECT * FROM users WHERE id = ? AND deleted_at = 0";
    return this.db.prepare(sql).bind(id).first<UserRow>();
  }

  async getUserByUsername(username: string, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
    const sql = opts?.includeDeleted
      ? "SELECT * FROM users WHERE username = ?"
      : "SELECT * FROM users WHERE username = ? AND deleted_at = 0";
    return this.db.prepare(sql).bind(username).first<UserRow>();
  }

  async getUserByGithub(githubId: string, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
    const sql = opts?.includeDeleted
      ? "SELECT * FROM users WHERE github_id = ?"
      : "SELECT * FROM users WHERE github_id = ? AND deleted_at = 0";
    return this.db.prepare(sql).bind(githubId).first<UserRow>();
  }

  async getUserByEmail(email: string, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const sql = opts?.includeDeleted
      ? "SELECT * FROM users WHERE LOWER(email) = ?"
      : "SELECT * FROM users WHERE LOWER(email) = ? AND deleted_at = 0";
    return this.db.prepare(sql).bind(normalized).first<UserRow>();
  }

  async getUserByField(field: string, value: string, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
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
    const sql = opts?.includeDeleted
      ? `SELECT * FROM users WHERE ${field} = ?`
      : `SELECT * FROM users WHERE ${field} = ? AND deleted_at = 0`;
    return this.db.prepare(sql).bind(value).first<UserRow>();
  }

  async getUserByAff(code: string, opts?: { includeDeleted?: boolean }): Promise<UserRow | null> {
    const sql = opts?.includeDeleted
      ? "SELECT * FROM users WHERE aff_code = ?"
      : "SELECT * FROM users WHERE aff_code = ? AND deleted_at = 0";
    return this.db.prepare(sql).bind(code).first<UserRow>();
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

  /** Original `model.User.Delete` / `DeleteUserForSession` (GORM soft delete). */
  async softDeleteUser(id: number): Promise<void> {
    await this.db.prepare("UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at = 0").bind(nowSec(), id).run();
    await this.bumpAuthVersion(id);
  }

  /** Original `model.HardDeleteUserById`. */
  async deleteUser(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  }

  async maxUserId(): Promise<number> {
    const row = await this.db.prepare("SELECT COALESCE(MAX(id), 0) as c FROM users").first<{ c: number }>();
    return Number(row?.c || 0);
  }

  async listUsers(
    offset: number,
    limit: number,
    keywordOrOpts:
      | string
      | {
          keyword?: string;
          group?: string;
          role?: number;
          status?: number;
          sortBy?: string;
          sortOrder?: string;
        } = "",
  ): Promise<{ items: UserRow[]; total: number }> {
    const opts = typeof keywordOrOpts === "string" ? { keyword: keywordOrOpts } : keywordOrOpts;
    const keyword = opts.keyword || "";
    let where = "1=1";
    const binds: unknown[] = [];
    if (keyword) {
      const like = `%${keyword}%`;
      const id = Number(keyword);
      if (Number.isInteger(id) && String(id) === keyword) {
        where += " AND (id = ? OR username LIKE ? OR display_name LIKE ? OR email LIKE ?)";
        binds.push(id, like, like, like);
      } else {
        where += " AND (username LIKE ? OR display_name LIKE ? OR email LIKE ?)";
        binds.push(like, like, like);
      }
    }
    if (opts.group) {
      where += ` AND "group" = ?`;
      binds.push(opts.group);
    }
    if (opts.role != null) {
      where += " AND role = ?";
      binds.push(opts.role);
    }
    if (opts.status === -1) {
      where += " AND deleted_at != 0";
    } else if (opts.status != null) {
      where += " AND deleted_at = 0 AND status = ?";
      binds.push(opts.status);
    }
    const sortCols: Record<string, string> = {
      id: "id",
      username: "username",
      quota: "quota",
      group: `"group"`,
      created_at: "created_at",
      last_login_at: "last_login_at",
    };
    const sortBy = sortCols[(opts.sortBy || "").toLowerCase()] || "id";
    const sortOrder = (opts.sortOrder || "").toLowerCase() === "asc" ? "ASC" : "DESC";
    const order = sortBy === "id" ? `${sortBy} ${sortOrder}` : `${sortBy} ${sortOrder}, id DESC`;
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM users WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM users WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
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

  async getChannelsByIds(ids: number[]): Promise<ChannelRow[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    const ph = unique.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT * FROM channels WHERE id IN (${ph})`)
      .bind(...unique)
      .all<ChannelRow>();
    return results;
  }

  async insertChannel(c: Partial<ChannelRow>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO channels (type, key, status, name, weight, created_time, test_time, response_time, base_url, other, models, "group", used_quota, model_mapping, status_code_mapping, priority, auto_ban, tag, header_override, param_override, remark, settings, openai_organization, test_model, balance, balance_updated_time, other_info, channel_info, setting)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        c.type ?? 1,
        c.key ?? "",
        c.status ?? CHANNEL_ENABLED,
        c.name,
        c.weight ?? 1,
        c.created_time ?? nowSec(),
        c.test_time ?? 0,
        c.response_time ?? 0,
        c.base_url ?? "",
        c.other ?? "",
        c.models ?? "",
        c.group ?? "default",
        c.used_quota ?? 0,
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
    const id = Number(r.meta.last_row_id || 0);
    const ch = await this.getChannel(id);
    if (ch) await this.replaceChannelAbilities(ch);
    return id;
  }

  async replaceChannelAbilities(ch: ChannelRow): Promise<void> {
    await this.db.prepare("DELETE FROM abilities WHERE channel_id = ?").bind(ch.id).run();
    const models = csv(ch.models);
    const groups = csv(ch.group || "default");
    const enabled = Number(ch.status) === CHANNEL_ENABLED ? 1 : 0;
    for (const group of groups) {
      for (const model of models) {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO abilities ("group", model, channel_id, enabled, priority, weight, tag) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(group, model, ch.id, enabled, ch.priority || 0, ch.weight || 0, ch.tag || "")
          .run();
      }
    }
  }

  async fixAbilities(): Promise<{ success: number; fails: number }> {
    await this.db.exec("DELETE FROM abilities");
    const { results } = await this.db.prepare("SELECT * FROM channels").all<ChannelRow>();
    let success = 0;
    let fails = 0;
    for (const ch of results) {
      try {
        await this.replaceChannelAbilities(ch);
        success += 1;
      } catch {
        fails += 1;
      }
    }
    return { success, fails };
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
    const ch = await this.getChannel(id);
    if (ch) await this.replaceChannelAbilities(ch);
  }

  async deleteChannel(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM abilities WHERE channel_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
  }

  async deleteDisabledChannels(): Promise<number> {
    await this.db.prepare("DELETE FROM abilities WHERE channel_id IN (SELECT id FROM channels WHERE status != 1)").run();
    const r = await this.db.prepare("DELETE FROM channels WHERE status != 1").run();
    return Number(r.meta.changes || 0);
  }

  async deleteChannelsBatch(ids: number[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      await this.db.prepare("DELETE FROM abilities WHERE channel_id = ?").bind(id).run();
      const r = await this.db.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
      n += Number(r.meta.changes || 0);
    }
    return n;
  }

  async setChannelsByTag(tag: string, status: number): Promise<number> {
    const r = await this.db.prepare("UPDATE channels SET status = ? WHERE tag = ?").bind(status, tag).run();
    const { results } = await this.db.prepare("SELECT * FROM channels WHERE tag = ?").bind(tag).all<ChannelRow>();
    for (const ch of results) await this.replaceChannelAbilities(ch);
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
    tag_mode?: boolean;
    sort_by?: string;
    sort_order?: string;
    id_sort?: boolean;
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
    const countWhere = where.join(" AND ");
    const countBinds = [...binds];
    if (opts.type != null && opts.type >= 0) {
      where.push("type = ?");
      binds.push(opts.type);
    }
    const w = where.join(" AND ");
    const counts = await this.db
      .prepare(`SELECT type, COUNT(*) as c FROM channels WHERE ${countWhere} GROUP BY type`)
      .bind(...countBinds)
      .all<{ type: number; c: number }>();
    const type_counts: Record<string, number> = {};
    for (const r of counts.results) type_counts[String(r.type)] = num(r.c);
    const order = channelOrderSql(opts.sort_by, opts.sort_order, opts.id_sort);
    if (opts.tag_mode) {
      const tagWhere = `${w} AND tag != ''`;
      const totalRow = await this.db
        .prepare(`SELECT COUNT(DISTINCT tag) as c FROM channels WHERE ${tagWhere}`)
        .bind(...binds)
        .first<{ c: number }>();
      const { results: tagRows } = await this.db
        .prepare(`SELECT DISTINCT tag FROM channels WHERE ${tagWhere} ORDER BY tag LIMIT ? OFFSET ?`)
        .bind(...binds, opts.limit, opts.offset)
        .all<{ tag: string }>();
      const tags = tagRows.map((r) => r.tag).filter(Boolean);
      let items: ChannelRow[] = [];
      if (tags.length) {
        const ph = tags.map(() => "?").join(",");
        const { results } = await this.db
          .prepare(`SELECT * FROM channels WHERE ${w} AND tag IN (${ph}) ORDER BY ${order}`)
          .bind(...binds, ...tags)
          .all<ChannelRow>();
        items = results;
      }
      return { items, total: num(totalRow?.c), type_counts };
    }
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM channels WHERE ${w}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM channels WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, opts.limit, opts.offset)
      .all<ChannelRow>();
    return { items: results, total: num(totalRow?.c), type_counts };
  }

  async enabledChannels(): Promise<ChannelRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM channels WHERE status = 1").all<ChannelRow>();
    return results;
  }

  /** All channels including disabled — original `GetConfiguredModelChannels`. */
  async allChannels(): Promise<ChannelRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM channels").all<ChannelRow>();
    return results;
  }

  /** Original abilities JOIN enabled channels — `GetModelConnections`. */
  async listEnabledModelConnections(): Promise<
    {
      model: string;
      group: string;
      channel_id: number;
      channel_name: string;
      channel_type: number;
      channel_settings: string;
    }[]
  > {
    const { results } = await this.db
      .prepare(
        `SELECT abilities.model as model, abilities."group" as "group", abilities.channel_id as channel_id,
                channels.name as channel_name, channels.type as channel_type, channels.settings as channel_settings
         FROM abilities
         JOIN channels ON abilities.channel_id = channels.id
         WHERE abilities.enabled = 1 AND channels.status = 1
         ORDER BY abilities.model, abilities.channel_id`,
      )
      .all<{
        model: string;
        group: string;
        channel_id: number;
        channel_name: string;
        channel_type: number;
        channel_settings: string;
      }>();
    if (results.length) return results;
    const channels = await this.enabledChannels();
    const out: {
      model: string;
      group: string;
      channel_id: number;
      channel_name: string;
      channel_type: number;
      channel_settings: string;
    }[] = [];
    for (const ch of channels) {
      const groups = csv(ch.group || "default");
      for (const model of csv(ch.models)) {
        for (const group of groups) {
          out.push({
            model,
            group,
            channel_id: ch.id,
            channel_name: ch.name,
            channel_type: ch.type,
            channel_settings: ch.settings || "",
          });
        }
      }
    }
    return out;
  }

  async abilitiesFor(group: string, model: string): Promise<{ channel_id: number; priority: number; weight: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT channel_id, priority, weight FROM abilities WHERE "group" = ? AND model = ? AND enabled = 1 ORDER BY priority DESC, weight DESC`,
      )
      .bind(group, model)
      .all<{ channel_id: number; priority: number; weight: number }>();
    return results;
  }

  /** Original `model.filterAbilitiesByConstraints` + `GetChannel`. */
  async filterAbilitiesByConstraints(
    abilities: { channel_id: number; priority: number; weight: number }[],
    modelName: string,
    filters: ChannelFilter[],
  ): Promise<{ channel_id: number; priority: number; weight: number }[]> {
    if (!abilities.length) return [];
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const ability of abilities) {
      if (seen.has(ability.channel_id)) continue;
      seen.add(ability.channel_id);
      ids.push(ability.channel_id);
    }
    let channels: ChannelRow[];
    try {
      channels = await this.getChannelsByIds(ids);
    } catch {
      if (identityFilterRequiresKey(filters)) return [];
      return abilities;
    }
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    return abilities.filter((ability) => channelSatisfiesFilters(channelsById.get(ability.channel_id) ?? null, modelName, filters).ok);
  }

  async getRandomSatisfiedChannel(
    group: string,
    model: string,
    retry: number,
    filters: ChannelFilter[] = [],
  ): Promise<ChannelRow | null> {
    let abilities = await this.abilitiesFor(group, model);
    if (!abilities.length) {
      const normalized = routingMatchModelName(model);
      if (normalized && normalized !== model) abilities = await this.abilitiesFor(group, normalized);
    }
    abilities = await this.filterAbilitiesByConstraints(abilities, model, filters);
    const id = pickAbilityChannelId(abilities, retry);
    if (!id) return null;
    return this.getChannel(id);
  }

  async taskPluginUsage(key: string): Promise<{ channel_count: number; in_flight_count: number; channels: { id: number; name: string }[] }> {
    const { results } = await this.db
      .prepare("SELECT id, name, setting FROM channels WHERE type = 61 AND status = ?")
      .bind(CHANNEL_ENABLED)
      .all<{ id: number; name: string; setting: string }>();
    const channels: { id: number; name: string }[] = [];
    for (const ch of results) {
      const setting = parseJson<Record<string, unknown>>(ch.setting || "", {});
      if (String(setting.task_plugin_key || setting.TaskPluginKey || "") === key) {
        channels.push({ id: Number(ch.id), name: String(ch.name || "") });
      }
    }
    const inflight = await this.db
      .prepare("SELECT COUNT(*) as c FROM tasks WHERE platform = ? AND status NOT IN ('SUCCESS', 'FAILURE')")
      .bind(key)
      .first<{ c: number }>();
    return { channel_count: channels.length, in_flight_count: num(inflight?.c), channels };
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
    tokenId?: number;
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
    applyExplicitLogTextFilter("request_logs.model_name", opts.model, where, binds);
    applyExplicitLogTextFilter("request_logs.username", opts.username, where, binds);
    if (opts.tokenName) {
      where.push("request_logs.token_name = ?");
      binds.push(opts.tokenName);
    }
    if (opts.tokenId) {
      where.push("request_logs.token_id = ?");
      binds.push(opts.tokenId);
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
    return { items: results ?? [], total: num(totalRow?.c) };
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
    const where: string[] = [`type = ${LOG_CONSUME}`];
    const binds: unknown[] = [];
    applyExplicitLogTextFilter("username", opts.username, where, binds);
    if (opts.tokenName) {
      where.push("token_name = ?");
      binds.push(opts.tokenName);
    }
    applyExplicitLogTextFilter("model_name", opts.model, where, binds);
    if (opts.channel) {
      where.push("channel_id = ?");
      binds.push(opts.channel);
    }
    if (opts.group) {
      where.push('"group" = ?');
      binds.push(opts.group);
    }
    const quotaWhere = [...where];
    const quotaBinds = [...binds];
    if (opts.start) {
      quotaWhere.push("created_at >= ?");
      quotaBinds.push(opts.start);
    }
    if (opts.end) {
      quotaWhere.push("created_at <= ?");
      quotaBinds.push(opts.end);
    }
    const w = quotaWhere.join(" AND ");
    const row = await this.db
      .prepare(`SELECT COALESCE(SUM(quota),0) as quota FROM request_logs WHERE ${w}`)
      .bind(...quotaBinds)
      .first<{ quota: number }>();
    const minuteAgo = nowSec() - 60;
    const rpmWhere = [...where, "created_at >= ?"].join(" AND ");
    const rpmRow = await this.db
      .prepare(`SELECT COUNT(*) as c, COALESCE(SUM(prompt_tokens+completion_tokens),0) as t FROM request_logs WHERE ${rpmWhere}`)
      .bind(...binds, minuteAgo)
      .first<{ c: number; t: number }>();
    return { quota: num(row?.quota), rpm: num(rpmRow?.c), tpm: num(rpmRow?.t) };
  }

  async bumpQuotaData(
    user: UserRow,
    model: string,
    quota: number,
    tokens: number,
    extra: { useGroup?: string; tokenId?: number; channelId?: number } = {},
  ): Promise<void> {
    const hour = hourStartSec();
    const useGroup = extra.useGroup || user.group || "default";
    const tokenId = extra.tokenId || 0;
    const channelId = extra.channelId || 0;
    const existing = await this.db
      .prepare(
        "SELECT id FROM quota_data WHERE user_id = ? AND model_name = ? AND created_at = ? AND use_group = ? AND token_id = ? AND channel_id = ?",
      )
      .bind(user.id, model, hour, useGroup, tokenId, channelId)
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
        "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'workerd')",
      )
      .bind(user.id, user.username, model, hour, quota, tokens, useGroup, tokenId, channelId)
      .run();
  }

  async quotaDates(userId: number | null, start: number, end: number, username = ""): Promise<unknown[]> {
    if (userId) {
      const { results } = await this.db
        .prepare(
          `SELECT user_id, username, model_name, created_at, SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
           FROM quota_data WHERE user_id = ? AND created_at >= ? AND created_at <= ?
           GROUP BY user_id, username, model_name, created_at ORDER BY created_at`,
        )
        .bind(userId, start, end)
        .all();
      return results;
    }
    if (username) {
      const { results } = await this.db
        .prepare(
          `SELECT user_id, username, model_name, created_at, SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
           FROM quota_data WHERE username = ? AND created_at >= ? AND created_at <= ?
           GROUP BY user_id, username, model_name, created_at ORDER BY created_at`,
        )
        .bind(username, start, end)
        .all();
      return results;
    }
    const { results } = await this.db
      .prepare(
        `SELECT model_name, created_at, SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
         FROM quota_data WHERE created_at >= ? AND created_at <= ? GROUP BY model_name, created_at ORDER BY created_at`,
      )
      .bind(start, end)
      .all();
    return results;
  }

  async quotaDatesByUser(start: number, end: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare(
        `SELECT username, created_at, SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
         FROM quota_data WHERE created_at >= ? AND created_at <= ? GROUP BY username, created_at ORDER BY created_at`,
      )
      .bind(start, end)
      .all();
    return results;
  }

  async flowQuotaDates(
    start: number,
    end: number,
    userId: number | null,
    username = "",
    role = 0,
  ): Promise<unknown[]> {
    const where = ["use_group <> ''", "created_at >= ?", "created_at <= ?"];
    const binds: unknown[] = [start, end];
    if (userId) {
      where.push("user_id = ?");
      binds.push(userId);
    }
    if (username) {
      where.push("username = ?");
      binds.push(username);
    }
    const w = where.join(" AND ");
    let sql: string;
    if (userId) {
      sql = `SELECT token_id, use_group, model_name, SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
             FROM quota_data WHERE ${w} GROUP BY token_id, use_group, model_name ORDER BY quota DESC`;
    } else if (role >= 100) {
      sql = `SELECT user_id, username, node_name, token_id, use_group, model_name, channel_id,
                    SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
             FROM quota_data WHERE ${w}
             GROUP BY user_id, username, node_name, token_id, use_group, model_name, channel_id ORDER BY quota DESC`;
    } else {
      sql = `SELECT user_id, username, use_group, model_name, channel_id,
                    SUM(count) as count, SUM(quota) as quota, SUM(token_used) as token_used
             FROM quota_data WHERE ${w}
             GROUP BY user_id, username, use_group, model_name, channel_id ORDER BY quota DESC`;
    }
    const { results } = await this.db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    const tokenIds = [...new Set(results.map((r) => Number(r.token_id || 0)).filter(Boolean))];
    const channelIds = [...new Set(results.map((r) => Number(r.channel_id || 0)).filter(Boolean))];
    const tokenNames = new Map<number, string>();
    const channelNames = new Map<number, string>();
    if (tokenIds.length) {
      const ph = tokenIds.map(() => "?").join(",");
      const { results: tokens } = await this.db
        .prepare(`SELECT id, name FROM api_tokens WHERE id IN (${ph})`)
        .bind(...tokenIds)
        .all<{ id: number; name: string }>();
      for (const t of tokens) tokenNames.set(t.id, t.name);
    }
    if (channelIds.length) {
      const ph = channelIds.map(() => "?").join(",");
      const { results: channels } = await this.db
        .prepare(`SELECT id, name FROM channels WHERE id IN (${ph})`)
        .bind(...channelIds)
        .all<{ id: number; name: string }>();
      for (const ch of channels) channelNames.set(ch.id, ch.name);
    }
    return results.map((r) => {
      const tokenId = Number(r.token_id || 0);
      const channelId = Number(r.channel_id || 0);
      const out: Record<string, unknown> = { ...r };
      if (tokenId) out.token_name = tokenNames.get(tokenId) || `token-${tokenId}`;
      if (channelId) out.channel_name = channelNames.get(channelId) || `channel-${channelId}`;
      return out;
    });
  }

  async insertRedemption(r: Partial<RedemptionRow>): Promise<number> {
    const res = await this.db
      .prepare(
        "INSERT INTO redemptions (user_id, name, key, status, quota, created_time, expired_time) VALUES (?, ?, ?, 1, ?, ?, ?)",
      )
      .bind(r.user_id ?? 0, r.name ?? "", r.key, r.quota ?? 0, nowSec(), r.expired_time ?? 0)
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
    status = "",
  ): Promise<{ items: RedemptionRow[]; total: number }> {
    let where = "1=1";
    const binds: unknown[] = [];
    if (keyword) {
      if (/^-?\d+$/.test(keyword)) {
        where += " AND (id = ? OR name LIKE ?)";
        binds.push(Number(keyword), `${keyword}%`);
      } else {
        where += " AND name LIKE ?";
        binds.push(`${keyword}%`);
      }
    }
    if (status) {
      const now = nowSec();
      if (status === "expired") {
        where += " AND status = ? AND expired_time != 0 AND expired_time < ?";
        binds.push(REDEMPTION_ENABLED, now);
      } else if (status === String(REDEMPTION_ENABLED)) {
        where += " AND status = ? AND (expired_time = 0 OR expired_time >= ?)";
        binds.push(REDEMPTION_ENABLED, now);
      } else if (status === String(REDEMPTION_DISABLED) || status === String(REDEMPTION_USED)) {
        where += " AND status = ?";
        binds.push(Number(status));
      }
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
    const r = await this.db
      .prepare(
        "DELETE FROM redemptions WHERE status IN (?, ?) OR (status = ? AND expired_time != 0 AND expired_time < ?)",
      )
      .bind(REDEMPTION_USED, REDEMPTION_DISABLED, REDEMPTION_ENABLED, nowSec())
      .run();
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
    const ratios = parseJson<Record<string, number>>(await this.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
    return Object.keys(ratios);
  }

  async audit(
    userId: number,
    username: string,
    type: string,
    content: string,
    ip: string,
    extra: {
      actor_role?: number;
      category?: string;
      action?: string;
      token_ref?: string;
      auth_method?: string;
      user_agent?: string;
      method?: string;
      route?: string;
      status?: number;
      success?: boolean;
      request_id?: string;
      other?: string;
    } = {},
  ): Promise<void> {
    const category = extra.category || type;
    const action = extra.action || type;
    await this.db
      .prepare(
        `INSERT INTO audit_logs (
          event_id, user_id, username, actor_role, created_at, type, category, action, token_ref,
          auth_method, ip, user_agent, method, route, status, success, request_id, content, other
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        extra.request_id || crypto.randomUUID(),
        userId,
        username,
        extra.actor_role ?? 0,
        nowSec(),
        type,
        category,
        action,
        extra.token_ref || "",
        extra.auth_method || "",
        ip,
        extra.user_agent || "",
        extra.method || "",
        extra.route || "",
        extra.status ?? 0,
        extra.success === false ? 0 : 1,
        extra.request_id || "",
        content,
        extra.other || "",
      )
      .run();
  }

  async listAudit(
    offset: number,
    limit: number,
    opts: {
      userId?: number;
      username?: string;
      category?: string;
      token_ref?: string;
      exclude_token_ref?: string;
      request_id?: string;
      start_timestamp?: number;
      end_timestamp?: number;
      success?: boolean;
    } = {},
  ): Promise<{ items: unknown[]; total: number }> {
    const where: string[] = ["1=1"];
    const binds: unknown[] = [];
    if (opts.userId) {
      where.push("user_id = ?");
      binds.push(opts.userId);
    }
    if (opts.username) {
      where.push("username = ?");
      binds.push(opts.username);
    }
    if (opts.category) {
      where.push("category = ?");
      binds.push(opts.category);
    }
    if (opts.token_ref) {
      where.push("token_ref = ?");
      binds.push(opts.token_ref);
    }
    if (opts.exclude_token_ref) {
      where.push("token_ref != ?");
      binds.push(opts.exclude_token_ref);
    }
    if (opts.request_id) {
      where.push("request_id = ?");
      binds.push(opts.request_id);
    }
    if (opts.start_timestamp) {
      where.push("created_at >= ?");
      binds.push(opts.start_timestamp);
    }
    if (opts.end_timestamp) {
      where.push("created_at <= ?");
      binds.push(opts.end_timestamp);
    }
    if (opts.success === true) where.push("success = 1");
    if (opts.success === false) where.push("success = 0");
    const w = where.join(" AND ");
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM audit_logs WHERE ${w}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM audit_logs WHERE ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<Record<string, unknown>>();
    return { items: results.map(publicAudit), total: num(totalRow?.c) };
  }

  async accessTokenLastUsed(
    userId: number,
    tokenRef: string,
  ): Promise<{ last_used_at: number | null; last_used_ip: string }> {
    const last = await this.db
      .prepare(
        `SELECT created_at, ip FROM audit_logs
         WHERE user_id = ? AND token_ref = ? AND category = 'access_token'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(userId, tokenRef)
      .first<{ created_at?: number; ip?: string }>();
    if (!last) return { last_used_at: null, last_used_ip: "" };
    return { last_used_at: Number(last.created_at) || null, last_used_ip: last.ip || "" };
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

  async listMj(
    userId: number | null,
    offset: number,
    limit: number,
    filters: { channel_id?: string; mj_id?: string; start_timestamp?: string; end_timestamp?: string } = {},
  ): Promise<{ items: unknown[]; total: number }> {
    const where: string[] = [userId ? "user_id = ?" : "1=1"];
    const binds: unknown[] = userId ? [userId] : [];
    if (userId == null && filters.channel_id) {
      where.push("channel_id = ?");
      binds.push(filters.channel_id);
    }
    if (filters.mj_id) {
      where.push("mj_id = ?");
      binds.push(filters.mj_id);
    }
    if (filters.start_timestamp) {
      where.push("submit_time >= ?");
      binds.push(filters.start_timestamp);
    }
    if (filters.end_timestamp) {
      where.push("submit_time <= ?");
      binds.push(filters.end_timestamp);
    }
    const w = where.join(" AND ");
    const totalRow = await this.db.prepare(`SELECT COUNT(*) as c FROM mj_tasks WHERE ${w}`).bind(...binds).first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM mj_tasks WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return { items: results, total: num(totalRow?.c) };
  }

  async enabledModels(group: string): Promise<string[]> {
    return this.enabledModelsForGroups([group]);
  }

  async enabledModelsAll(): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT DISTINCT model FROM abilities WHERE enabled = 1`)
      .all<{ model: string }>();
    if (results.length) return results.map((r) => r.model);
    const channels = await this.enabledChannels();
    const set = new Set<string>();
    for (const c of channels) {
      for (const m of csv(c.models)) set.add(m);
    }
    return [...set];
  }

  async enabledModelsForGroups(groups: string[]): Promise<string[]> {
    if (!groups.length) return [];
    const want = groups.filter(Boolean);
    if (!want.length) return [];
    const ph = want.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT DISTINCT model FROM abilities WHERE enabled = 1 AND "group" IN (${ph})`)
      .bind(...want)
      .all<{ model: string }>();
    if (results.length) return results.map((r) => r.model);
    const channels = await this.enabledChannels();
    const set = new Set<string>();
    const wantSet = new Set(want);
    for (const c of channels) {
      const chGroups = csv(c.group || "default");
      if (wantSet.size && !chGroups.includes("all") && !chGroups.some((g) => wantSet.has(g))) continue;
      for (const m of csv(c.models)) set.add(m);
    }
    return [...set];
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
    refresh_hash?: string;
    version?: number;
    user_auth_version?: number;
  }): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO login_sessions (sid, user_id, created_at, last_seen, expires_at, ip, ua, revoked, login_method, refresh_hash, version, user_auth_version, last_refresh_hash, last_rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '', 0)",
      )
      .bind(
        row.sid,
        row.user_id,
        nowSec(),
        nowSec(),
        row.expires_at,
        row.ip,
        row.ua,
        row.login_method || "password",
        row.refresh_hash || "",
        row.version || 1,
        row.user_auth_version || 1,
      )
      .run();
  }

  async getSession(sid: string): Promise<import("./types.js").LoginSessionRow | null> {
    return this.db.prepare("SELECT * FROM login_sessions WHERE sid = ?").bind(sid).first<LoginSessionRow>();
  }

  async countActiveSessions(userId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as c FROM login_sessions WHERE user_id = ? AND revoked = 0 AND (expires_at = 0 OR expires_at > ?)")
      .bind(userId, nowSec())
      .first<{ c: number }>();
    return num(row?.c);
  }

  async countSessionsCreatedSince(userId: number, since: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as c FROM login_sessions WHERE user_id = ? AND created_at >= ?")
      .bind(userId, since)
      .first<{ c: number }>();
    return num(row?.c);
  }

  async rotateSessionRefresh(
    sid: string,
    currentHash: string,
    nextHash: string,
    now: number,
    ip: string,
    ua: string,
  ): Promise<import("./types.js").LoginSessionRow | null> {
    const r = await this.db
      .prepare(
        "UPDATE login_sessions SET refresh_hash = ?, last_refresh_hash = ?, last_rotated_at = ?, version = version + 1, last_seen = ?, ip = ?, ua = ? WHERE sid = ? AND refresh_hash = ? AND revoked = 0",
      )
      .bind(nextHash, currentHash, now, now, ip, ua, sid, currentHash)
      .run();
    if (!Number(r.meta.changes || 0)) {
      const fallback = await this.db
        .prepare(
          "UPDATE login_sessions SET refresh_hash = ?, last_refresh_hash = ?, last_rotated_at = ?, version = version + 1, last_seen = ?, ip = ?, ua = ? WHERE sid = ? AND (refresh_hash = '' OR refresh_hash IS NULL) AND revoked = 0",
        )
        .bind(nextHash, currentHash, now, now, ip, ua, sid)
        .run();
      if (!Number(fallback.meta.changes || 0)) return null;
    }
    return this.getSession(sid);
  }

  async bumpAuthVersion(userId: number): Promise<void> {
    await this.db.prepare("UPDATE users SET auth_version = COALESCE(auth_version, 1) + 1 WHERE id = ?").bind(userId).run();
    await this.db.prepare("UPDATE login_sessions SET revoked = 1 WHERE user_id = ?").bind(userId).run();
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

  async revokeOtherSessions(userId: number, keepSid: string): Promise<number> {
    const r = await this.db
      .prepare("UPDATE login_sessions SET revoked = 1 WHERE user_id = ? AND sid != ? AND revoked = 0")
      .bind(userId, keepSid)
      .run();
    return Number(r.meta.changes || 0);
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

  async insertAuthFlow(row: {
    token: string;
    type: string;
    user_id: number;
    expires_at: number;
    payload?: string;
    session_id?: string;
  }): Promise<void> {
    await this.db
      .prepare("INSERT INTO auth_flows (token, type, user_id, expires_at, payload, session_id, consumed_at) VALUES (?, ?, ?, ?, ?, ?, 0)")
      .bind(row.token, row.type, row.user_id, row.expires_at, row.payload ?? "", row.session_id ?? "")
      .run();
  }

  async getAuthFlow(token: string): Promise<{
    token: string;
    type: string;
    user_id: number;
    expires_at: number;
    payload: string;
    session_id?: string;
    consumed_at?: number;
  } | null> {
    return this.db.prepare("SELECT * FROM auth_flows WHERE token = ?").bind(token).first<{
      token: string;
      type: string;
      user_id: number;
      expires_at: number;
      payload: string;
      session_id?: string;
      consumed_at?: number;
    }>();
  }

  async consumeAuthFlow(
    token: string,
    match: { type: string; user_id: number; session_id?: string },
  ): Promise<"ok" | "consumed" | "expired" | "invalid"> {
    const now = nowSec();
    const sessionClause = match.session_id ? " AND session_id = ?" : "";
    const binds: unknown[] = [now, token, match.type, match.user_id];
    if (match.session_id) binds.push(match.session_id);
    binds.push(now);
    const r = await this.db
      .prepare(
        `UPDATE auth_flows SET consumed_at = ? WHERE token = ? AND type = ? AND user_id = ?${sessionClause} AND consumed_at = 0 AND expires_at > ?`,
      )
      .bind(...binds)
      .run();
    if (Number(r.meta.changes || 0) === 1) return "ok";
    const row = await this.getAuthFlow(token);
    if (!row) return "invalid";
    if (Number(row.consumed_at || 0) > 0) return "consumed";
    if (Number(row.expires_at) <= now) return "expired";
    return "invalid";
  }

  async deleteAuthFlow(token: string): Promise<void> {
    await this.db.prepare("DELETE FROM auth_flows WHERE token = ?").bind(token).run();
  }

  async casbinPolicies(subject: string): Promise<{ v1: string; v2: string; v3: string }[]> {
    const { results } = await this.db
      .prepare("SELECT v1, v2, v3 FROM casbin_rule WHERE ptype = 'p' AND v0 = ?")
      .bind(subject)
      .all<{ v1: string; v2: string; v3: string }>();
    return results;
  }

  async userPermissionOverrides(userId: number): Promise<Record<string, Record<string, boolean>> | null> {
    const results = await this.casbinPolicies(`user:${userId}`);
    if (!results.length) return null;
    const out: Record<string, Record<string, boolean>> = {};
    for (const row of results) {
      if (!out[row.v1]) out[row.v1] = {};
      out[row.v1][row.v2] = row.v3 !== "deny";
    }
    return out;
  }

  async setUserCasbinPolicies(userId: number, deltas: Record<string, Record<string, boolean>>): Promise<void> {
    const subject = `user:${userId}`;
    await this.db.prepare("DELETE FROM casbin_rule WHERE ptype = 'p' AND v0 = ?").bind(subject).run();
    for (const [resource, actions] of Object.entries(deltas)) {
      for (const [action, allowed] of Object.entries(actions)) {
        await this.db
          .prepare("INSERT OR IGNORE INTO casbin_rule (ptype, v0, v1, v2, v3, v4, v5) VALUES ('p', ?, ?, ?, ?, '', '')")
          .bind(subject, resource, action, allowed ? "allow" : "deny")
          .run();
      }
    }
  }

  async clearUserCasbinPolicies(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM casbin_rule WHERE ptype = 'p' AND v0 = ?").bind(`user:${userId}`).run();
  }

  async insertEmailCode(email: string, code: string, type: string, ttlSec = 600): Promise<void> {
    await this.db
      .prepare("INSERT INTO email_codes (email, code, type, expires_at, used) VALUES (?, ?, ?, ?, 0)")
      .bind(email, code, type, nowSec() + ttlSec)
      .run();
  }

  async verifyEmailCode(email: string, code: string, type: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM email_codes WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at >= ? ORDER BY id DESC LIMIT 1")
      .bind(email, code, type, nowSec())
      .first<{ id: number }>();
    return Boolean(row);
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
    payment_provider?: string;
    status?: string;
    complete_time?: number;
  }): Promise<number> {
    const r = await this.db
      .prepare(
        "INSERT INTO topups (user_id, amount, money, trade_no, payment_method, payment_provider, complete_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.user_id,
        row.amount,
        row.money ?? 0,
        row.trade_no ?? "",
        row.payment_method ?? "redemption",
        row.payment_provider ?? "",
        row.complete_time ?? 0,
        row.status ?? "success",
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async listTopups(
    userId: number | null,
    offset: number,
    limit: number,
    keyword = "",
  ): Promise<{ items: unknown[]; total: number }> {
    const cutoff = nowSec() - 30 * 24 * 60 * 60;
    const where: string[] = ["created_at >= ?"];
    const binds: unknown[] = [cutoff];
    if (userId) {
      where.push("user_id = ?");
      binds.push(userId);
    }
    if (keyword) {
      where.push("trade_no LIKE ?");
      binds.push(`%${keyword}%`);
    }
    const w = where.join(" AND ");
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) as c FROM topups WHERE ${w}`)
      .bind(...binds)
      .first<{ c: number }>();
    const { results } = await this.db
      .prepare(`SELECT * FROM topups WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all();
    return { items: results, total: num(totalRow?.c) };
  }

  async getTopupByTrade(tradeNo: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM topups WHERE trade_no = ?").bind(tradeNo).first<Record<string, unknown>>();
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

  async upsertPerfMetric(row: {
    model_name: string;
    group: string;
    bucket_ts: number;
    request_count: number;
    success_count: number;
    total_latency_ms: number;
    ttft_sum_ms: number;
    ttft_count: number;
    output_tokens: number;
    generation_ms: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO perf_metrics (model_name, "group", bucket_ts, request_count, success_count, total_latency_ms, ttft_sum_ms, ttft_count, output_tokens, generation_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_name, "group", bucket_ts) DO UPDATE SET
           request_count = request_count + excluded.request_count,
           success_count = success_count + excluded.success_count,
           total_latency_ms = total_latency_ms + excluded.total_latency_ms,
           ttft_sum_ms = ttft_sum_ms + excluded.ttft_sum_ms,
           ttft_count = ttft_count + excluded.ttft_count,
           output_tokens = output_tokens + excluded.output_tokens,
           generation_ms = generation_ms + excluded.generation_ms`,
      )
      .bind(
        row.model_name,
        row.group,
        row.bucket_ts,
        row.request_count,
        row.success_count,
        row.total_latency_ms,
        row.ttft_sum_ms,
        row.ttft_count,
        row.output_tokens,
        row.generation_ms,
      )
      .run();
  }

  async listPerfMetrics(modelName: string, group: string, start: number, end: number): Promise<Record<string, unknown>[]> {
    const sql = group
      ? `SELECT model_name, "group", bucket_ts, request_count, success_count, total_latency_ms, ttft_sum_ms, ttft_count, output_tokens, generation_ms
         FROM perf_metrics WHERE model_name = ? AND "group" = ? AND bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`
      : `SELECT model_name, "group", bucket_ts, request_count, success_count, total_latency_ms, ttft_sum_ms, ttft_count, output_tokens, generation_ms
         FROM perf_metrics WHERE model_name = ? AND bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`;
    const stmt = this.db.prepare(sql);
    const { results } = group
      ? await stmt.bind(modelName, group, start, end).all<Record<string, unknown>>()
      : await stmt.bind(modelName, start, end).all<Record<string, unknown>>();
    return results;
  }

  async listPerfMetricBuckets(start: number, end: number, groups: string[]): Promise<Record<string, unknown>[]> {
    if (!groups.length) return [];
    const ph = groups.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(
        `SELECT model_name, "group", bucket_ts, request_count, success_count, total_latency_ms, ttft_sum_ms, ttft_count, output_tokens, generation_ms
         FROM perf_metrics WHERE bucket_ts >= ? AND bucket_ts <= ? AND "group" IN (${ph}) ORDER BY bucket_ts ASC`,
      )
      .bind(start, end, ...groups)
      .all<Record<string, unknown>>();
    return results;
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

  async rankingTotals(start: number, end: number): Promise<{ model_name: string; total_tokens: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT model_name, SUM(token_used) as total_tokens
         FROM quota_data WHERE model_name <> '' AND created_at >= ? AND created_at <= ?
         GROUP BY model_name HAVING SUM(token_used) > 0 ORDER BY total_tokens DESC`,
      )
      .bind(start, end)
      .all<{ model_name: string; total_tokens: number }>();
    return results;
  }

  async rankingBuckets(start: number, end: number, bucketSize: number): Promise<{ model_name: string; bucket: number; tokens: number }[]> {
    const size = bucketSize > 0 ? bucketSize : 3600;
    const { results } = await this.db
      .prepare(
        `SELECT model_name, (created_at / ?) * ? as bucket, SUM(token_used) as tokens
         FROM quota_data WHERE model_name <> '' AND created_at >= ? AND created_at <= ?
         GROUP BY model_name, (created_at / ?) * ?
         HAVING SUM(token_used) > 0 ORDER BY bucket ASC`,
      )
      .bind(size, size, start, end, size, size)
      .all<{ model_name: string; bucket: number; tokens: number }>();
    return results;
  }

  async rankingModelMeta(): Promise<Record<string, { vendor: string; vendor_icon: string }>> {
    const { results } = await this.db
      .prepare(
        `SELECT m.model_name as model_name, COALESCE(v.name, '') as vendor, COALESCE(v.icon, '') as vendor_icon
         FROM model_meta m LEFT JOIN vendors v ON v.id = m.vendor_id`,
      )
      .all<{ model_name: string; vendor: string; vendor_icon: string }>();
    const out: Record<string, { vendor: string; vendor_icon: string }> = {};
    for (const row of results) {
      out[String(row.model_name)] = { vendor: String(row.vendor || "Unknown"), vendor_icon: String(row.vendor_icon || "") };
    }
    return out;
  }

  async listPlans(enabledOnly = false): Promise<Record<string, unknown>[]> {
    const sql = enabledOnly
      ? "SELECT * FROM subscription_plans WHERE enabled = 1 ORDER BY sort_order DESC, id DESC"
      : "SELECT * FROM subscription_plans ORDER BY sort_order DESC, id DESC";
    const { results } = await this.db.prepare(sql).all<Record<string, unknown>>();
    return results;
  }

  async getPlan(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM subscription_plans WHERE id = ?").bind(id).first<Record<string, unknown>>();
  }

  async insertPlan(p: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO subscription_plans (
           title, subtitle, description, price_amount, currency, duration_unit, duration_value, custom_seconds,
           enabled, sort_order, allow_balance_pay, allow_wallet_overflow, stripe_price_id, creem_product_id,
           waffo_pancake_product_id, max_purchase_per_user, upgrade_group, downgrade_group, total_amount,
           quota_reset_period, quota_reset_custom_seconds, price_quota, duration_days, grant_quota, "group", models,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.title ?? "",
        p.subtitle ?? "",
        p.description ?? "",
        Number(p.price_amount || 0),
        p.currency || "USD",
        p.duration_unit ?? "month",
        Number(p.duration_value || 1),
        Number(p.custom_seconds || 0),
        p.enabled == null ? 1 : Number(p.enabled),
        Number(p.sort_order || 0),
        p.allow_balance_pay == null ? 1 : Number(p.allow_balance_pay),
        p.allow_wallet_overflow == null ? 1 : Number(p.allow_wallet_overflow),
        p.stripe_price_id ?? "",
        p.creem_product_id ?? "",
        p.waffo_pancake_product_id ?? "",
        Number(p.max_purchase_per_user || 0),
        p.upgrade_group ?? "",
        p.downgrade_group ?? "",
        Number(p.total_amount || p.grant_quota || 0),
        p.quota_reset_period ?? "never",
        Number(p.quota_reset_custom_seconds || 0),
        Number(p.price_quota || 0),
        Number(p.duration_days || 30),
        Number(p.grant_quota || p.total_amount || 0),
        p.group ?? "",
        p.models ?? "",
        nowSec(),
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

  async listUserSubs(userId: number): Promise<Record<string, unknown>[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.*, p.title as plan_title FROM user_subscriptions s
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.user_id = ? ORDER BY COALESCE(s.end_time, s.expire_at) DESC, s.id DESC`,
      )
      .bind(userId)
      .all<Record<string, unknown>>();
    return results;
  }

  async listActiveUserSubs(userId: number | undefined, planId: number): Promise<Record<string, unknown>[]> {
    const now = nowSec();
    if (userId) {
      const { results } = await this.db
        .prepare(
          `SELECT * FROM user_subscriptions
           WHERE user_id = ? AND plan_id = ? AND (status = 'active' OR status = 1 OR status = '1')
             AND (COALESCE(end_time, expire_at, 0) > ?)
           ORDER BY COALESCE(end_time, expire_at) ASC, id ASC`,
        )
        .bind(userId, planId, now)
        .all<Record<string, unknown>>();
      return results;
    }
    const { results } = await this.db
      .prepare(
        `SELECT * FROM user_subscriptions
         WHERE plan_id = ? AND (status = 'active' OR status = 1 OR status = '1')
           AND (COALESCE(end_time, expire_at, 0) > ?)
         ORDER BY user_id ASC, COALESCE(end_time, expire_at) ASC, id ASC`,
      )
      .bind(planId, now)
      .all<Record<string, unknown>>();
    return results;
  }

  async insertUserSub(row: {
    user_id: number;
    plan_id: number;
    start_at?: number;
    expire_at?: number;
    remaining_quota?: number;
    amount_total?: number;
    amount_used?: number;
    start_time?: number;
    end_time?: number;
    status?: string;
    source?: string;
    last_reset_time?: number;
    next_reset_time?: number;
    upgrade_group?: string;
    prev_user_group?: string;
    downgrade_group?: string;
    allow_wallet_overflow?: number | boolean;
  }): Promise<number> {
    const start = Number(row.start_time || row.start_at || nowSec());
    const end = Number(row.end_time || row.expire_at || 0);
    const total = Number(row.amount_total ?? row.remaining_quota ?? 0);
    const overflow = row.allow_wallet_overflow == null ? 1 : Number(row.allow_wallet_overflow);
    const r = await this.db
      .prepare(
        `INSERT INTO user_subscriptions (
           user_id, plan_id, amount_total, amount_used, start_time, end_time, status, source,
           last_reset_time, next_reset_time, upgrade_group, prev_user_group, downgrade_group, allow_wallet_overflow,
           start_at, expire_at, remaining_quota, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.user_id,
        row.plan_id,
        total,
        Number(row.amount_used || 0),
        start,
        end,
        row.status || "active",
        row.source || "order",
        Number(row.last_reset_time || 0),
        Number(row.next_reset_time || 0),
        row.upgrade_group || "",
        row.prev_user_group || "",
        row.downgrade_group || "",
        overflow,
        start,
        end,
        total,
        nowSec(),
        nowSec(),
      )
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
    const now = nowSec();
    await this.db
      .prepare(
        `UPDATE user_subscriptions SET status = 'expired', updated_at = ?
         WHERE (status = 'active' OR status = 1 OR status = '1')
           AND COALESCE(end_time, expire_at, 0) > 0 AND COALESCE(end_time, expire_at, 0) < ?`,
      )
      .bind(now, now)
      .run();
  }

  async vendorModelCounts(): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare("SELECT vendor_id as vendor_id, COUNT(*) as count FROM model_meta GROUP BY vendor_id")
      .all<{ vendor_id: number; count: number }>();
    const out: Record<string, number> = {};
    for (const row of results) out[String(row.vendor_id || 0)] = Number(row.count || 0);
    return out;
  }

  async insertTask(row: Record<string, unknown>): Promise<number> {
    const r = await this.db
      .prepare(
        `INSERT INTO tasks (task_id, user_id, token_id, channel_id, "group", quota, platform, action, status, progress, model_name, prompt, fail_reason, result, properties, data, private_data, created_at, updated_at, submit_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.task_id ?? crypto.randomUUID(),
        row.user_id ?? 0,
        row.token_id ?? 0,
        row.channel_id ?? 0,
        row.group ?? "",
        row.quota ?? 0,
        row.platform ?? "",
        row.action ?? "",
        row.status ?? "SUBMITTED",
        row.progress ?? "0%",
        row.model_name ?? "",
        row.prompt ?? "",
        row.fail_reason ?? "",
        typeof row.result === "string" ? row.result : JSON.stringify(row.result ?? ""),
        typeof row.properties === "string" ? row.properties : JSON.stringify(row.properties ?? {}),
        typeof row.data === "string" ? row.data : JSON.stringify(row.data ?? null),
        typeof row.private_data === "string" ? row.private_data : JSON.stringify(row.private_data ?? {}),
        nowSec(),
        nowSec(),
        nowSec(),
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async getTaskByTid(taskId: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").bind(taskId).first<Record<string, unknown>>();
  }

  /** Original `model.GetByTaskId` — ownership is `user_id` AND `task_id`. */
  async getTaskByUserAndTid(userId: number, taskId: string): Promise<Record<string, unknown> | null> {
    if (!taskId) return null;
    return this.db
      .prepare("SELECT * FROM tasks WHERE user_id = ? AND task_id = ?")
      .bind(userId, taskId)
      .first<Record<string, unknown>>();
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

  async listTasks(
    userId: number | null,
    offset: number,
    limit: number,
    filters: {
      platform?: string;
      task_id?: string;
      status?: string;
      action?: string;
      start_timestamp?: number;
      end_timestamp?: number;
      channel_id?: string;
    } = {},
  ): Promise<{ items: unknown[]; total: number }> {
    const where: string[] = [userId ? "t.user_id = ?" : "1=1"];
    const binds: unknown[] = userId ? [userId] : [];
    if (filters.platform) {
      where.push("t.platform = ?");
      binds.push(filters.platform);
    }
    if (filters.task_id) {
      where.push("t.task_id = ?");
      binds.push(filters.task_id);
    }
    if (filters.status) {
      where.push("t.status = ?");
      binds.push(filters.status);
    }
    if (filters.action) {
      where.push("t.action = ?");
      binds.push(filters.action);
    }
    if (filters.start_timestamp) {
      where.push("t.submit_time >= ?");
      binds.push(filters.start_timestamp);
    }
    if (filters.end_timestamp) {
      where.push("t.submit_time <= ?");
      binds.push(filters.end_timestamp);
    }
    if (userId == null && filters.channel_id) {
      where.push("t.channel_id = ?");
      binds.push(filters.channel_id);
    }
    const w = where.join(" AND ");
    const totalRow = await this.db.prepare(`SELECT COUNT(*) as c FROM tasks t WHERE ${w}`).bind(...binds).first<{ c: number }>();
    const { results } = await this.db
      .prepare(
        `SELECT t.id, t.created_at, t.updated_at, t.task_id, t.user_id, t.token_id, t.channel_id, t."group" AS "group",
                t.quota, t.platform, t.action, t.status, t.progress, t.model_name, t.prompt, t.fail_reason, t.result,
                t.properties, t.data, t.private_data, t.submit_time, t.start_time, t.finish_time, u.username AS username
         FROM tasks t LEFT JOIN users u ON t.user_id = u.id WHERE ${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all();
    return { items: results ?? [], total: num(totalRow?.c) };
  }

  async listConversations(userId: number): Promise<unknown[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(userId)
      .all();
    return results;
  }

  async getConversation(id: number, userId: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).first<Record<string, unknown>>();
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
    return this.db.prepare("SELECT * FROM vendors WHERE id = ?").bind(id).first<Record<string, unknown>>();
  }

  async insertVendor(name: string, description = "", icon = ""): Promise<number> {
    const t = nowSec();
    const r = await this.db
      .prepare("INSERT INTO vendors (name, description, icon, status, created_at, created_time, updated_time) VALUES (?, ?, ?, 1, ?, ?, ?)")
      .bind(name, description, icon, t, t, t)
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

  async listPrefill(type = ""): Promise<unknown[]> {
    if (type) {
      const { results } = await this.db.prepare("SELECT * FROM prefill_groups WHERE type = ? ORDER BY id").bind(type).all();
      return results;
    }
    const { results } = await this.db.prepare("SELECT * FROM prefill_groups ORDER BY id").all();
    return results;
  }

  async insertPrefill(name: string, type: string, items: string, description = ""): Promise<number> {
    const t = nowSec();
    const r = await this.db
      .prepare("INSERT INTO prefill_groups (name, type, items, description, created_at, created_time, updated_time) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(name, type, items, description, t, t, t)
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
      return this.db.prepare("SELECT * FROM oauth_providers WHERE id = ?").bind(Number(idOrSlug)).first<Record<string, unknown>>();
    }
    return this.db.prepare("SELECT * FROM oauth_providers WHERE slug = ?").bind(String(idOrSlug)).first<Record<string, unknown>>();
  }

  async insertOAuthProvider(p: Record<string, unknown>): Promise<number> {
    const t = nowSec();
    const authorization = String(p.authorization_endpoint || p.auth_url || "");
    const token = String(p.token_endpoint || p.token_url || "");
    const userInfo = String(p.user_info_endpoint || p.user_info_url || "");
    const r = await this.db
      .prepare(
        `INSERT INTO oauth_providers (
          name, slug, icon, client_id, client_secret, auth_url, token_url, user_info_url,
          authorization_endpoint, token_endpoint, user_info_endpoint, scopes,
          user_id_field, username_field, display_name_field, email_field, well_known,
          auth_style, access_policy, access_denied_message, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.name ?? "",
        p.slug ?? "",
        p.icon ?? "",
        p.client_id ?? "",
        p.client_secret ?? "",
        authorization,
        token,
        userInfo,
        authorization,
        token,
        userInfo,
        p.scopes ?? "",
        p.user_id_field || "sub",
        p.username_field || "preferred_username",
        p.display_name_field || "name",
        p.email_field || "email",
        p.well_known ?? "",
        Number(p.auth_style || 0),
        p.access_policy ?? "",
        p.access_denied_message ?? "",
        p.enabled == null ? 0 : Number(p.enabled),
        t,
        t,
      )
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async updateOAuthProvider(id: number, patch: Record<string, unknown>): Promise<void> {
    const allowed = new Set([
      "name",
      "slug",
      "icon",
      "client_id",
      "client_secret",
      "auth_url",
      "token_url",
      "user_info_url",
      "authorization_endpoint",
      "token_endpoint",
      "user_info_endpoint",
      "scopes",
      "user_id_field",
      "username_field",
      "display_name_field",
      "email_field",
      "well_known",
      "auth_style",
      "access_policy",
      "access_denied_message",
      "enabled",
      "updated_at",
    ]);
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k)) continue;
      if (k === "client_secret" && (v == null || v === "")) continue;
      cols.push(`${k} = ?`);
      vals.push(k === "enabled" ? Number(v) : v);
    }
    if (!cols.length) return;
    if (!cols.includes("updated_at = ?")) {
      cols.push("updated_at = ?");
      vals.push(nowSec());
    }
    vals.push(id);
    await this.db.prepare(`UPDATE oauth_providers SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async isOAuthSlugTaken(slug: string, exceptId = 0): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM oauth_providers WHERE slug = ? AND id != ?")
      .bind(slug, exceptId)
      .first<{ id: number }>();
    return Boolean(row);
  }

  async countOAuthBindings(providerId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as c FROM user_oauth_bindings WHERE provider_id = ?")
      .bind(providerId)
      .first<{ c: number }>();
    return Number(row?.c || 0);
  }

  async deleteOAuthProvider(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM oauth_providers WHERE id = ?").bind(id).run();
  }

  async listPasskeys(userId: number): Promise<{ id: number; credential_id: string; public_key: string; name: string; created_at: number; last_used_at?: number }[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM passkeys WHERE user_id = ?")
      .bind(userId)
      .all<{ id: number; credential_id: string; public_key: string; name: string; created_at: number; last_used_at?: number }>();
    return results;
  }

  async getPasskeyByCred(credentialId: string): Promise<{
    id: number;
    user_id: number;
    credential_id: string;
    public_key: string;
    last_used_at?: number;
  } | null> {
    return this.db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").bind(credentialId).first<{ id: number; user_id: number; credential_id: string; public_key: string; last_used_at?: number }>();
  }

  async insertPasskey(userId: number, credentialId: string, publicKey: string, name = ""): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, 0)")
      .bind(userId, credentialId, publicKey, name, nowSec())
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async touchPasskey(credentialId: string): Promise<void> {
    await this.db.prepare("UPDATE passkeys SET last_used_at = ? WHERE credential_id = ?").bind(nowSec(), credentialId).run();
  }

  async deletePasskeys(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId).run();
  }

  async listUserOAuthBindings(userId: number): Promise<
    { provider_id: number; provider_name: string; provider_slug: string; provider_icon: string; provider_user_id: string }[]
  > {
    const { results } = await this.db
      .prepare(
        `SELECT b.provider_id, p.name as provider_name, p.slug as provider_slug, p.icon as provider_icon, b.provider_user_id
         FROM user_oauth_bindings b JOIN oauth_providers p ON p.id = b.provider_id
         WHERE b.user_id = ? ORDER BY b.id`,
      )
      .bind(userId)
      .all<{
        provider_id: number;
        provider_name: string;
        provider_slug: string;
        provider_icon: string;
        provider_user_id: string;
      }>();
    return results;
  }

  async getUserOAuthBinding(userId: number, providerId: number): Promise<{ provider_user_id: string } | null> {
    return this.db
      .prepare("SELECT provider_user_id FROM user_oauth_bindings WHERE user_id = ? AND provider_id = ?")
      .bind(userId, providerId)
      .first<{ provider_user_id: string }>();
  }

  async getUserByOAuthBinding(providerId: number, providerUserId: string): Promise<UserRow | null> {
    const row = await this.db
      .prepare("SELECT user_id FROM user_oauth_bindings WHERE provider_id = ? AND provider_user_id = ?")
      .bind(providerId, providerUserId)
      .first<{ user_id: number }>();
    if (!row) return null;
    return this.getUserById(row.user_id);
  }

  async upsertUserOAuthBinding(userId: number, providerId: number, providerUserId: string): Promise<void> {
    const existing = await this.getUserOAuthBinding(userId, providerId);
    if (existing) {
      await this.db
        .prepare("UPDATE user_oauth_bindings SET provider_user_id = ? WHERE user_id = ? AND provider_id = ?")
        .bind(providerUserId, userId, providerId)
        .run();
      return;
    }
    await this.db
      .prepare("INSERT INTO user_oauth_bindings (user_id, provider_id, provider_user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, providerId, providerUserId, nowSec())
      .run();
  }

  async deleteUserOAuthBinding(userId: number, providerId: number): Promise<void> {
    await this.db.prepare("DELETE FROM user_oauth_bindings WHERE user_id = ? AND provider_id = ?").bind(userId, providerId).run();
  }

  async oauthBindingTaken(providerId: number, providerUserId: string, exceptUserId = 0): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT user_id FROM user_oauth_bindings WHERE provider_id = ? AND provider_user_id = ?")
      .bind(providerId, providerUserId)
      .first<{ user_id: number }>();
    return Boolean(row && row.user_id !== exceptUserId);
  }

  async listModelMeta(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM model_meta ORDER BY id").all();
    return results;
  }

  async insertModelMeta(model_name: string, description = "", vendor_id = 0): Promise<number> {
    const t = nowSec();
    const r = await this.db
      .prepare(
        "INSERT INTO model_meta (model_name, description, vendor_id, icon, tags, endpoints, created_at, created_time, updated_time, status, sync_official, name_rule) VALUES (?, ?, ?, '', '', '', ?, ?, ?, 1, 1, 0)",
      )
      .bind(model_name, description, vendor_id, t, t, t)
      .run();
    return Number(r.meta.last_row_id || 0);
  }

  async isModelNameDuplicated(id: number, name: string): Promise<boolean> {
    if (!name) return false;
    const row = await this.db
      .prepare("SELECT id FROM model_meta WHERE model_name = ? AND id <> ?")
      .bind(name, id)
      .first<{ id: number }>();
    return Boolean(row);
  }

  async updateModelMeta(id: number, patch: Record<string, unknown>): Promise<void> {
    const allowed = new Set([
      "model_name",
      "description",
      "icon",
      "tags",
      "vendor_id",
      "endpoints",
      "status",
      "sync_official",
      "name_rule",
      "updated_time",
      "created_time",
      "created_at",
    ]);
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k) || v === undefined) continue;
      cols.push(`${k} = ?`);
      vals.push(v);
    }
    if (!cols.length) return;
    vals.push(id);
    await this.db.prepare(`UPDATE model_meta SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  async deleteModelMeta(id: number): Promise<void> {
    await this.deleteModelMetadata([id], false, false);
  }

  async getModelMeta(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM model_meta WHERE id = ?").bind(id).first<Record<string, unknown>>();
  }

  async searchModelMeta(keyword: string): Promise<unknown[]> {
    return this.searchModels({ keyword });
  }

  /** Original `model.SearchModels` — `ORDER BY id DESC`. */
  async searchModels(opts: {
    keyword?: string;
    vendor?: string;
    status?: number | null;
    syncOfficial?: number | null;
  }): Promise<Record<string, unknown>[]> {
    const where: string[] = ["1=1"];
    const binds: unknown[] = [];
    const keyword = (opts.keyword || "").trim();
    if (keyword) {
      where.push("(model_meta.model_name LIKE ? OR model_meta.description LIKE ? OR model_meta.tags LIKE ?)");
      const q = `%${keyword}%`;
      binds.push(q, q, q);
    }
    const vendor = opts.vendor ?? "";
    let join = "";
    if (vendor !== "") {
      if (/^-?\d+$/.test(vendor)) {
        where.push("model_meta.vendor_id = ?");
        binds.push(Number(vendor));
      } else {
        join = "JOIN vendors ON vendors.id = model_meta.vendor_id";
        where.push("vendors.name LIKE ?");
        binds.push(`%${vendor}%`);
      }
    }
    if (opts.status != null) {
      where.push("model_meta.status = ?");
      binds.push(opts.status);
    }
    if (opts.syncOfficial != null) {
      where.push("model_meta.sync_official = ?");
      binds.push(opts.syncOfficial);
    }
    const { results } = await this.db
      .prepare(`SELECT model_meta.* FROM model_meta ${join} WHERE ${where.join(" AND ")} ORDER BY model_meta.id DESC`)
      .bind(...binds)
      .all();
    return results as Record<string, unknown>[];
  }

  async deleteModelMetaBatch(ids: number[]): Promise<number> {
    return (await this.deleteModelMetadata(ids, false, false)).deleted_count;
  }

  /** Original `model.DeleteModelMetadata`. */
  async deleteModelMetadata(
    ids: number[],
    removeFromChannels: boolean,
    removePricing: boolean,
  ): Promise<{ deleted_count: number; updated_channels: number }> {
    const result = { deleted_count: 0, updated_channels: 0 };
    if (!ids.length || ids.length > 1000) throw new Error("select between 1 and 1000 models");
    const selected = new Set<number>();
    for (const id of ids) {
      if (id <= 0) throw new Error("invalid model ID");
      selected.add(id);
    }
    const modelIDs = [...selected].sort((a, b) => a - b);
    const records: Record<string, unknown>[] = [];
    for (const id of modelIDs) {
      const row = await this.getModelMeta(id);
      if (!row) throw new Error("selected models changed; reload before deleting");
      records.push(row);
    }
    const names = new Set<string>();
    for (const record of records) {
      if (removeFromChannels && Number(record.name_rule || 0) !== NAME_RULE_EXACT) {
        throw new Error("only exact-match models can be removed from channels");
      }
      names.add(String(record.model_name || ""));
    }
    if (removeFromChannels) {
      const { results } = await this.db
        .prepare(`SELECT id, models FROM channels ORDER BY id`)
        .all<{ id: number; models: string }>();
      for (const channel of results) {
        const models = csv(channel.models);
        const remaining = models.filter((name) => !names.has(name.trim()));
        if (remaining.length === models.length) continue;
        await this.updateChannel(channel.id, { models: remaining.join(",") });
        result.updated_channels += 1;
      }
    }
    if (removePricing) {
      for (const key of MODEL_PRICING_OPTION_KEYS) {
        const map = parseJson<Record<string, unknown>>(await this.option(key), {});
        let changed = false;
        for (const name of names) {
          if (Object.prototype.hasOwnProperty.call(map, name)) {
            delete map[name];
            changed = true;
          }
        }
        if (changed) await this.setOption(key, JSON.stringify(map));
      }
    }
    const ph = modelIDs.map(() => "?").join(",");
    await this.db.prepare(`DELETE FROM model_meta WHERE id IN (${ph})`).bind(...modelIDs).run();
    result.deleted_count = records.length;
    return result;
  }

  async listTaskPlugins(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM task_plugins ORDER BY key").all();
    return results;
  }

  async getTaskPlugin(key: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM task_plugins WHERE key = ?").bind(key).first<Record<string, unknown>>();
  }

  async upsertTaskPlugin(p: Record<string, unknown>): Promise<void> {
    const enabled = p.enabled == null ? 1 : Number(p.enabled) ? 1 : 0;
    const active = p.active == null ? (String(p.status || "") === "active" ? 1 : 0) : Number(p.active) ? 1 : 0;
    await this.db
      .prepare(
        `INSERT INTO task_plugins (key, name, version, status, active_version, icon, manifest, routes, source, source_hash, remark, enabled, active, api_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name=excluded.name, version=excluded.version, status=excluded.status,
           active_version=excluded.active_version, icon=excluded.icon, manifest=excluded.manifest, routes=excluded.routes,
           source=excluded.source, source_hash=excluded.source_hash, remark=excluded.remark, enabled=excluded.enabled,
           active=excluded.active, api_version=excluded.api_version, updated_at=excluded.updated_at`,
      )
      .bind(
        String(p.key),
        String(p.name || p.key),
        String(p.version || "1.0.0"),
        String(p.status || (enabled ? "active" : "inactive")),
        String(p.active_version != null && String(p.active_version) !== "" ? p.active_version : p.version || "1.0.0"),
        String(p.icon || ""),
        typeof p.manifest === "string" ? p.manifest : JSON.stringify(p.manifest || {}),
        typeof p.routes === "string" ? p.routes : JSON.stringify(p.routes || []),
        String(p.source || ""),
        String(p.source_hash || ""),
        String(p.remark || ""),
        enabled,
        active,
        Number(p.api_version || 1),
        nowSec(),
        nowSec(),
      )
      .run();
  }

  async listTaskPluginVersions(key: string): Promise<Record<string, unknown>[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM task_plugin_versions WHERE key = ? ORDER BY created_at DESC, id DESC")
      .bind(key)
      .all();
    if (results.length) return results as Record<string, unknown>[];
    const current = await this.getTaskPlugin(key);
    return current ? [current] : [];
  }

  async getTaskPluginVersion(key: string, version = ""): Promise<Record<string, unknown> | null> {
    if (version) {
      const row = await this.db
        .prepare("SELECT * FROM task_plugin_versions WHERE key = ? AND version = ?")
        .bind(key, version)
        .first<Record<string, unknown>>();
      if (row) return row;
      const current = await this.getTaskPlugin(key);
      if (current && String(current.version) === version) return current;
      return null;
    }
    const active = await this.db
      .prepare("SELECT * FROM task_plugin_versions WHERE key = ? AND active = 1 ORDER BY id DESC LIMIT 1")
      .bind(key)
      .first<Record<string, unknown>>();
    if (active) return active;
    return this.getTaskPlugin(key);
  }

  async saveTaskPluginVersion(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = String(p.key);
    const version = String(p.version || "1.0.0");
    const existing = await this.db
      .prepare("SELECT * FROM task_plugin_versions WHERE key = ? AND version = ?")
      .bind(key, version)
      .first<Record<string, unknown>>();
    const sourceHash = String(p.source_hash || "");
    if (existing && String(existing.source_hash || "") && String(existing.source_hash) !== sourceHash) {
      throw new Error("plugin key and version already exist with different source");
    }
    const others = await this.db
      .prepare("SELECT COUNT(*) as c FROM task_plugin_versions WHERE key = ? AND active = 1")
      .bind(key)
      .first<{ c: number }>();
    const active = existing ? Number(existing.active || 0) : Number(others?.c || 0) === 0 ? 1 : 0;
    const enabled = p.enabled == null ? 1 : Number(p.enabled) ? 1 : 0;
    if (existing) {
      await this.db
        .prepare("UPDATE task_plugin_versions SET enabled = ?, remark = ?, icon = CASE WHEN ? = '' THEN icon ELSE ? END WHERE key = ? AND version = ?")
        .bind(enabled, String(p.remark || ""), String(p.icon || ""), String(p.icon || ""), key, version)
        .run();
      return (await this.getTaskPluginVersion(key, version)) || existing;
    }
    const r = await this.db
      .prepare(
        `INSERT INTO task_plugin_versions (key, api_version, version, source, source_hash, icon, enabled, active, created_at, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        key,
        Number(p.api_version || 1),
        version,
        String(p.source || ""),
        sourceHash,
        String(p.icon || ""),
        enabled,
        active,
        nowSec(),
        String(p.remark || ""),
      )
      .run();
    return {
      id: Number(r.meta.last_row_id || 0),
      key,
      api_version: Number(p.api_version || 1),
      version,
      source: String(p.source || ""),
      source_hash: sourceHash,
      enabled: Boolean(enabled),
      active: Boolean(active),
      created_at: nowSec(),
      remark: String(p.remark || ""),
    };
  }

  async activateTaskPluginVersion(key: string, version: string): Promise<boolean> {
    const target = await this.getTaskPluginVersion(key, version);
    if (!target) return false;
    await this.db.prepare("UPDATE task_plugin_versions SET active = 0 WHERE key = ?").bind(key).run();
    await this.db.prepare("UPDATE task_plugin_versions SET active = 1 WHERE key = ? AND version = ?").bind(key, version).run();
    await this.upsertTaskPlugin({
      ...target,
      key,
      version,
      active_version: version,
      status: Number(target.enabled) ? "active" : "inactive",
      active: 1,
      enabled: Number(target.enabled ?? 1),
    });
    return true;
  }

  async setTaskPluginEnabled(key: string, enabled: boolean): Promise<void> {
    await this.db.prepare("UPDATE task_plugin_versions SET enabled = ? WHERE key = ? AND active = 1").bind(enabled ? 1 : 0, key).run();
    const p = await this.getTaskPlugin(key);
    if (p) {
      await this.upsertTaskPlugin({
        ...p,
        enabled: enabled ? 1 : 0,
        status: enabled ? "active" : "inactive",
        active: enabled ? 1 : 0,
      });
    }
  }

  async deleteTaskPluginVersion(key: string, version: string): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM task_plugin_versions WHERE key = ? AND version = ?").bind(key, version).run();
    const left = await this.db.prepare("SELECT COUNT(*) as c FROM task_plugin_versions WHERE key = ?").bind(key).first<{ c: number }>();
    if (!Number(left?.c || 0)) await this.deleteTaskPlugin(key);
    return Number(r.meta.changes || 0) > 0;
  }

  async deleteTaskPlugin(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM task_plugin_versions WHERE key = ?").bind(key).run();
    await this.db.prepare("DELETE FROM task_plugins WHERE key = ?").bind(key).run();
  }

  async insertSystemTask(row: {
    id: string;
    type: string;
    status?: string;
    progress?: string;
    result?: string;
    payload?: unknown;
    state?: unknown;
    error?: string;
    locked_by?: string;
  }): Promise<void> {
    const payload = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload ?? null);
    const state = typeof row.state === "string" ? row.state : JSON.stringify(row.state ?? null);
    const result = typeof row.result === "string" ? row.result : JSON.stringify(row.result ?? null);
    await this.db
      .prepare(
        "INSERT INTO system_tasks (id, type, status, progress, result, payload, state, error, locked_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.type,
        row.status || "pending",
        row.progress ?? "",
        result,
        payload,
        state,
        row.error ?? "",
        row.locked_by ?? "",
        nowSec(),
        nowSec(),
      )
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

  async listSystemTasks(limit = 20): Promise<Record<string, unknown>[]> {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const { results } = await this.db
      .prepare("SELECT rowid, * FROM system_tasks ORDER BY created_at DESC LIMIT ?")
      .bind(n)
      .all();
    return results as Record<string, unknown>[];
  }

  async getSystemTask(id: string): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT rowid, * FROM system_tasks WHERE id = ?").bind(id).first<Record<string, unknown>>();
  }

  async currentSystemTask(type = ""): Promise<Record<string, unknown> | null> {
    if (type) {
      return this.db
        .prepare("SELECT rowid, * FROM system_tasks WHERE type = ? AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1")
        .bind(type)
        .first<Record<string, unknown>>();
    }
    return this.db.prepare("SELECT rowid, * FROM system_tasks WHERE status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1").first<Record<string, unknown>>();
  }

  async prefillNameTaken(name: string, exceptId = 0): Promise<boolean> {
    const row = await this.db.prepare("SELECT id FROM prefill_groups WHERE name = ? AND id <> ?").bind(name, exceptId).first();
    return Boolean(row);
  }

  async getPrefill(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM prefill_groups WHERE id = ?").bind(id).first<Record<string, unknown>>();
  }

  async listDeployments(): Promise<unknown[]> {
    const { results } = await this.db.prepare("SELECT * FROM deployments ORDER BY id DESC").all();
    return results;
  }

  async getDeployment(id: number): Promise<Record<string, unknown> | null> {
    return this.db.prepare("SELECT * FROM deployments WHERE id = ?").bind(id).first<Record<string, unknown>>();
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

export function publicAudit(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    event_id: row.event_id || "",
    user_id: row.user_id,
    username: row.username,
    actor_role: Number(row.actor_role) || 0,
    created_at: Number(row.created_at),
    category: row.category || row.type || "",
    action: row.action || row.type || "",
    token_ref: row.token_ref || "",
    auth_method: row.auth_method || "",
    ip: row.ip || "",
    user_agent: row.user_agent || "",
    method: row.method || "",
    route: row.route || "",
    status: Number(row.status) || 0,
    success: Number(row.success) !== 0,
    request_id: row.request_id || "",
    content: row.content || "",
    other: parseJson(String(row.other || ""), {}),
  };
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
    remark: u.remark || "",
    created_at: u.created_at || 0,
    last_login_at: u.last_login_at || 0,
    stripe_customer,
    sidebar_modules,
    permissions: permissionsFor(u),
    billing_preference: normalizeBillingPreference(u.billing_preference),
    totp_enabled: Number(u.totp_enabled) === 1,
    email_verified: Number(u.email_verified) === 1,
    has_access_token: Boolean(u.access_token),
    DeletedAt: Number(u.deleted_at || 0) ? new Date(Number(u.deleted_at) * 1000).toISOString() : null,
  };
}

export function permissionsFor(user: { role: number; admin_permissions?: string } | number): Record<string, unknown> {
  const role = typeof user === "number" ? user : user.role;
  const overrides = typeof user === "number" ? null : parsePermissionOverrides(user.admin_permissions);
  const admin = role >= 10;
  const root = role >= 100;
  return {
    sidebar_settings: !root,
    sidebar_modules: root ? {} : admin ? { admin: { setting: false } } : { admin: false },
    admin_permissions: capabilities(role, overrides),
    is_admin: admin,
    is_root: root,
  };
}

export { publicToken, publicChannel, stripChannelKey } from "./dto.js";
