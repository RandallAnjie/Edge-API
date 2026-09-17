import { CHANNEL_ENABLED, nowSec, parseJson } from "./constants.js";
import { sha1Hex } from "./crypto.js";
import { CHANNEL_AFFINITY_RULES } from "./option-defaults.js";
import { routingMatchModelName } from "./ratio-setting.js";
import type { Store } from "./store.js";
import type { ChannelRow, Env } from "./types.js";

export type ChannelAffinityKeySource = {
  type?: string;
  key?: string;
  path?: string;
};

export type ChannelAffinityRule = {
  name?: string;
  model_regex?: string[];
  path_regex?: string[];
  user_agent_include?: string[];
  key_sources?: ChannelAffinityKeySource[];
  value_regex?: string;
  ttl_seconds?: number;
  param_override_template?: Record<string, unknown>;
  skip_retry_on_failure?: boolean;
  include_using_group?: boolean;
  include_model_name?: boolean;
  include_rule_name?: boolean;
};

export type ChannelAffinityCacheStats = {
  enabled: boolean;
  total: number;
  unknown: number;
  by_rule_name: Record<string, number>;
  cache_capacity: number;
  cache_algo: string;
};

export type ChannelAffinityRequest = {
  model: string;
  path: string;
  usingGroup: string;
  userAgent: string;
  headers: Record<string, string>;
  body: unknown;
  userId?: number;
  contextStrings?: Record<string, string>;
};

export type ChannelAffinityMatch = {
  template: Record<string, unknown>;
  cacheKeySuffix: string;
  skipRetryOnFailure: boolean;
  ruleName: string;
  ttlSeconds: number;
  keySourceType: string;
  keySourceKey: string;
  keySourcePath: string;
  affinityValue: string;
};

export type ChannelAffinityResolution = ChannelAffinityMatch & {
  preferredChannelId: number;
  keyHint: string;
  keyFingerprint: string;
  usingGroup: string;
  modelName: string;
  requestPath: string;
};

export type ChannelAffinityLogInfo = {
  reason: string;
  rule_name: string;
  using_group: string;
  selected_group: string;
  model: string;
  request_path: string;
  channel_id: number;
  key_source: string;
  key_key: string;
  key_path: string;
  key_hint: string;
  key_fp: string;
};

export type ChannelAffinityUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  promptCacheHitTokens?: number;
};

type UsageCacheCounters = {
  cached_token_rate_mode: string;
  hit: number;
  total: number;
  window_seconds: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  prompt_cache_hit_tokens: number;
  last_seen_at: number;
  expires_at: number;
};

const CACHE_TOKEN_RATE_CACHED_OVER_PROMPT = "cached_over_prompt";
const CACHE_TOKEN_RATE_CACHED_OVER_PROMPT_PLUS_CACHED = "cached_over_prompt_plus_cached";
const CACHE_TOKEN_RATE_MIXED = "mixed";

const regexCache = new Map<string, RegExp | null>();

export async function loadAffinityCache(store: Store, env: Env): Promise<Record<string, unknown>> {
  const raw = env.KV ? await env.KV.get("channel_affinity") : await store.option("ChannelAffinityCache");
  return pruneExpiredCache(parseJson<Record<string, unknown>>(raw || "{}", {}), nowSec());
}

export async function saveAffinityCache(store: Store, env: Env, cache: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(cache);
  if (env.KV) await env.KV.put("channel_affinity", raw);
  await store.setOption("ChannelAffinityCache", raw);
}

function pruneExpiredCache(cache: Record<string, unknown>, now: number): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cache)) {
    if (cacheChannelId(value, now) > 0) next[key] = value;
  }
  return next;
}

async function loadUsageCache(store: Store, env: Env): Promise<Record<string, UsageCacheCounters>> {
  const raw = env.KV ? await env.KV.get("channel_affinity_usage") : await store.option("ChannelAffinityUsageCache");
  const parsed = parseJson<Record<string, UsageCacheCounters>>(raw || "{}", {});
  const now = nowSec();
  const next: Record<string, UsageCacheCounters> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    if (Number(value.expires_at || 0) > 0 && Number(value.expires_at) < now) continue;
    next[key] = value;
  }
  return next;
}

async function saveUsageCache(store: Store, env: Env, cache: Record<string, UsageCacheCounters>): Promise<void> {
  const raw = JSON.stringify(cache);
  if (env.KV) await env.KV.put("channel_affinity_usage", raw);
  await store.setOption("ChannelAffinityUsageCache", raw);
}

export async function affinityRules(store: Store): Promise<ChannelAffinityRule[]> {
  return parseJson<ChannelAffinityRule[]>(await store.option("channel_affinity_setting.rules"), CHANNEL_AFFINITY_RULES);
}

export async function channelAffinityCacheStats(store: Store, env: Env): Promise<ChannelAffinityCacheStats> {
  const enabled = await store.optionBool("channel_affinity_setting.enabled", true);
  const maxEntries = await store.optionNum("channel_affinity_setting.max_entries", 100000);
  const rules = await affinityRules(store);
  const cache = await loadAffinityCache(store, env);
  const byRuleName: Record<string, number> = {};
  for (const rule of rules) {
    const name = String(rule.name || "").trim();
    if (!name || !rule.include_rule_name) continue;
    byRuleName[name] = 0;
  }
  const keys = Object.keys(cache);
  let unknown = 0;
  for (const key of keys) {
    const parts = key.split(":");
    const ruleName = parts[0] || "";
    if (ruleName in byRuleName) byRuleName[ruleName] += 1;
    else unknown += 1;
  }
  return {
    enabled,
    total: keys.length,
    unknown,
    by_rule_name: byRuleName,
    cache_capacity: maxEntries > 0 ? maxEntries : 100000,
    cache_algo: "lru",
  };
}

export async function clearAffinityCacheAll(store: Store, env: Env): Promise<number> {
  const cache = await loadAffinityCache(store, env);
  const deleted = Object.keys(cache).length;
  await saveAffinityCache(store, env, {});
  return deleted;
}

export async function clearAffinityCacheByRule(store: Store, env: Env, ruleName: string): Promise<number> {
  const name = ruleName.trim();
  if (!name) throw new Error("rule_name 不能为空");
  const rules = await affinityRules(store);
  const matched = rules.find((r) => String(r.name || "").trim() === name);
  if (!matched) throw new Error("未知规则名称");
  if (!matched.include_rule_name) throw new Error("该规则未启用 include_rule_name，无法按规则清空缓存");
  const cache = await loadAffinityCache(store, env);
  let deleted = 0;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cache)) {
    if (key === name || key.startsWith(`${name}:`)) {
      deleted += 1;
      continue;
    }
    next[key] = value;
  }
  await saveAffinityCache(store, env, next);
  return deleted;
}

export async function clearAffinityCacheKey(store: Store, env: Env, cacheKeySuffix: string): Promise<void> {
  const key = cacheKeySuffix.trim();
  if (!key) return;
  const cache = await loadAffinityCache(store, env);
  if (!(key in cache)) return;
  delete cache[key];
  await saveAffinityCache(store, env, cache);
}

/** Original `service.ChannelAffinityUsageCacheStats` when no live window exists. */
export function emptyAffinityUsageStats(ruleName: string, usingGroup: string, keyFp: string) {
  return {
    rule_name: ruleName,
    using_group: usingGroup,
    key_fp: keyFp,
    cached_token_rate_mode: "",
    hit: 0,
    total: 0,
    window_seconds: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    prompt_cache_hit_tokens: 0,
    last_seen_at: 0,
  };
}

/** Original `service.GetChannelAffinityUsageCacheStats`. */
export async function getChannelAffinityUsageCacheStats(
  store: Store,
  env: Env,
  ruleName: string,
  usingGroup: string,
  keyFp: string,
): Promise<ReturnType<typeof emptyAffinityUsageStats>> {
  const empty = emptyAffinityUsageStats(ruleName, usingGroup, keyFp);
  const entryKey = usageCacheEntryKey(ruleName, usingGroup, keyFp);
  if (!entryKey) return empty;
  const cache = await loadUsageCache(store, env);
  const v = cache[entryKey];
  if (!v) return empty;
  return {
    rule_name: ruleName,
    using_group: usingGroup,
    key_fp: keyFp,
    cached_token_rate_mode: v.cached_token_rate_mode || "",
    hit: Number(v.hit || 0),
    total: Number(v.total || 0),
    window_seconds: Number(v.window_seconds || 0),
    prompt_tokens: Number(v.prompt_tokens || 0),
    completion_tokens: Number(v.completion_tokens || 0),
    total_tokens: Number(v.total_tokens || 0),
    cached_tokens: Number(v.cached_tokens || 0),
    prompt_cache_hit_tokens: Number(v.prompt_cache_hit_tokens || 0),
    last_seen_at: Number(v.last_seen_at || 0),
  };
}

function usageCacheEntryKey(ruleName: string, usingGroup: string, keyFp: string): string {
  const name = ruleName.trim();
  const fp = keyFp.trim();
  if (!name || !fp) return "";
  return `${name}\n${usingGroup.trim()}\n${fp}`;
}

function normalizeCachedTokenRateMode(mode: string): string {
  switch (mode) {
    case CACHE_TOKEN_RATE_CACHED_OVER_PROMPT:
    case CACHE_TOKEN_RATE_CACHED_OVER_PROMPT_PLUS_CACHED:
    case CACHE_TOKEN_RATE_MIXED:
      return mode;
    default:
      return "";
  }
}

export function cachedTokenRateModeByClientFormat(format: string): string {
  if (format === "openai" || format === "responses") return CACHE_TOKEN_RATE_CACHED_OVER_PROMPT;
  if (format === "anthropic") return CACHE_TOKEN_RATE_CACHED_OVER_PROMPT_PLUS_CACHED;
  return "";
}

export async function observeChannelAffinityUsageCache(
  store: Store,
  env: Env,
  affinity: ChannelAffinityResolution,
  usingGroup: string,
  usage: ChannelAffinityUsage,
  cachedTokenRateMode: string,
): Promise<void> {
  const entryKey = usageCacheEntryKey(affinity.ruleName, usingGroup, affinity.keyFingerprint);
  if (!entryKey) return;
  const windowSeconds = affinity.ttlSeconds;
  if (windowSeconds <= 0) return;
  const cache = await loadUsageCache(store, env);
  const prev = cache[entryKey];
  const next: UsageCacheCounters = prev
    ? { ...prev }
    : {
        cached_token_rate_mode: "",
        hit: 0,
        total: 0,
        window_seconds: windowSeconds,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        prompt_cache_hit_tokens: 0,
        last_seen_at: 0,
        expires_at: 0,
      };
  const currentMode = normalizeCachedTokenRateMode(cachedTokenRateMode);
  if (currentMode) {
    if (!next.cached_token_rate_mode) next.cached_token_rate_mode = currentMode;
    else if (next.cached_token_rate_mode !== currentMode && next.cached_token_rate_mode !== CACHE_TOKEN_RATE_MIXED) {
      next.cached_token_rate_mode = CACHE_TOKEN_RATE_MIXED;
    }
  }
  next.total += 1;
  const cached = Number(usage.cachedTokens || 0);
  const pcht = Number(usage.promptCacheHitTokens || 0);
  if (cached > 0 || pcht > 0) next.hit += 1;
  next.window_seconds = windowSeconds;
  next.last_seen_at = nowSec();
  next.cached_tokens += cached;
  next.prompt_cache_hit_tokens += pcht;
  next.prompt_tokens += Number(usage.promptTokens || 0);
  next.completion_tokens += Number(usage.completionTokens || 0);
  next.total_tokens +=
    usage.totalTokens != null ? Number(usage.totalTokens) : Number(usage.promptTokens || 0) + Number(usage.completionTokens || 0);
  next.expires_at = nowSec() + windowSeconds;
  cache[entryKey] = next;
  await saveUsageCache(store, env, cache);
}

export function channelAffinityLogInfo(
  affinity: ChannelAffinityResolution,
  selectedGroup: string,
  channelId: number,
): ChannelAffinityLogInfo {
  return {
    reason: affinity.ruleName,
    rule_name: affinity.ruleName,
    using_group: affinity.usingGroup,
    selected_group: selectedGroup,
    model: affinity.modelName,
    request_path: affinity.requestPath,
    channel_id: channelId,
    key_source: affinity.keySourceType,
    key_key: affinity.keySourceKey,
    key_path: affinity.keySourcePath,
    key_hint: affinity.keyHint,
    key_fp: affinity.keyFingerprint,
  };
}

function cloneMap(value: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function extractParamOperations(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => item);
}

/** Original `service.mergeChannelOverride` — template operations prepend channel operations; existing keys win. */
export function mergeChannelOverride(base: Record<string, unknown>, tpl: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(base).length && !Object.keys(tpl).length) return {};
  if (!Object.keys(tpl).length) return cloneMap(base);
  const out = cloneMap(base);
  for (const [k, v] of Object.entries(tpl)) {
    if (k.trim().toLowerCase() === "operations") {
      const baseOps = extractParamOperations(out[k]);
      const tplOps = extractParamOperations(v);
      if (tplOps) {
        out[k] = baseOps ? [...tplOps, ...baseOps] : tplOps;
        continue;
      }
    }
    if (Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = v;
  }
  return out;
}

function matchAnyRegex(patterns: string[] | undefined, s: string): boolean {
  if (!patterns?.length || !s) return false;
  for (const pattern of patterns) {
    if (!pattern) continue;
    let re = regexCache.get(pattern);
    if (re === undefined) {
      try {
        re = new RegExp(pattern);
      } catch {
        re = null;
      }
      regexCache.set(pattern, re);
    }
    if (re && re.test(s)) return true;
  }
  return false;
}

function matchAnyIncludeFold(patterns: string[] | undefined, s: string): boolean {
  if (!patterns?.length || !s) return false;
  const lower = s.toLowerCase();
  for (const p of patterns) {
    const trimmed = String(p || "").trim();
    if (!trimmed) continue;
    if (lower.includes(trimmed.toLowerCase())) return true;
  }
  return false;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const want = name.trim().toLowerCase();
  if (!want) return "";
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(v || "").trim();
  }
  return "";
}

function gjsonString(root: unknown, path: string): string {
  if (!path) return "";
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return "";
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== "object") return "";
    const obj = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) return "";
    cur = obj[seg];
  }
  if (cur == null) return "";
  if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") return String(cur).trim();
  try {
    return JSON.stringify(cur).trim();
  } catch {
    return "";
  }
}

function extractAffinityValue(src: ChannelAffinityKeySource, req: ChannelAffinityRequest): string {
  switch (String(src.type || "").trim()) {
    case "context_int": {
      if (src.key === "id" && req.userId && req.userId > 0) return String(req.userId);
      return "";
    }
    case "context_string": {
      const key = String(src.key || "").trim();
      if (!key) return "";
      return String(req.contextStrings?.[key] || "").trim();
    }
    case "request_header":
      return headerValue(req.headers, String(src.key || ""));
    case "gjson":
      return gjsonString(req.body, String(src.path || ""));
    default:
      return "";
  }
}

/** Original `service.buildChannelAffinityCacheKeySuffix`. */
export function buildChannelAffinityCacheKeySuffix(rule: ChannelAffinityRule, modelName: string, usingGroup: string, affinityValue: string): string {
  const parts: string[] = [];
  if (rule.include_rule_name && rule.name) parts.push(rule.name);
  if (rule.include_model_name && modelName) parts.push(modelName);
  if (rule.include_using_group && usingGroup) parts.push(usingGroup);
  parts.push(affinityValue);
  return parts.join(":");
}

/** Original `GetPreferredChannelByAffinity` rule walk (sets template even on cache miss). */
export function matchChannelAffinity(rules: ChannelAffinityRule[], req: ChannelAffinityRequest): ChannelAffinityMatch | null {
  for (const rule of rules) {
    if (!matchAnyRegex(rule.model_regex, req.model)) continue;
    if ((rule.path_regex || []).length && !matchAnyRegex(rule.path_regex, req.path)) continue;
    if ((rule.user_agent_include || []).length && !matchAnyIncludeFold(rule.user_agent_include, req.userAgent)) continue;
    let affinityValue = "";
    let usedSource: ChannelAffinityKeySource = {};
    for (const src of rule.key_sources || []) {
      affinityValue = extractAffinityValue(src, req);
      if (affinityValue) {
        usedSource = src;
        break;
      }
    }
    if (!affinityValue) continue;
    if (rule.value_regex && !matchAnyRegex([rule.value_regex], affinityValue)) continue;
    const template = cloneMap(rule.param_override_template);
    return {
      template,
      cacheKeySuffix: buildChannelAffinityCacheKeySuffix(rule, req.model, req.usingGroup, affinityValue),
      skipRetryOnFailure: Boolean(rule.skip_retry_on_failure),
      ruleName: String(rule.name || ""),
      ttlSeconds: Number(rule.ttl_seconds || 0),
      keySourceType: String(usedSource.type || "").trim(),
      keySourceKey: String(usedSource.key || "").trim(),
      keySourcePath: String(usedSource.path || "").trim(),
      affinityValue,
    };
  }
  return null;
}

function cacheChannelId(value: unknown, now = nowSec()): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as { id?: unknown; expires_at?: unknown };
    const expires = Number(rec.expires_at || 0);
    if (expires > 0 && expires < now) return 0;
    const id = Number(rec.id);
    if (Number.isInteger(id) && id > 0) return id;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function buildChannelAffinityKeyHint(s: string): string {
  const trimmed = s.replace(/[\n\r]/g, " ").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/** Original `GetPreferredChannelByAffinity` + `ApplyChannelAffinityOverrideTemplate` seed. */
export async function resolveChannelAffinity(store: Store, env: Env, req: ChannelAffinityRequest): Promise<ChannelAffinityResolution | null> {
  if (!(await store.optionBool("channel_affinity_setting.enabled", true))) return null;
  const match = matchChannelAffinity(await affinityRules(store), req);
  if (!match) return null;
  let ttl = match.ttlSeconds;
  if (ttl <= 0) ttl = await store.optionNum("channel_affinity_setting.default_ttl_seconds", 3600);
  if (ttl <= 0) ttl = 3600;
  const cache = await loadAffinityCache(store, env);
  const fp = match.affinityValue ? (await sha1Hex(match.affinityValue)).slice(0, 8) : "";
  return {
    ...match,
    ttlSeconds: ttl,
    preferredChannelId: cacheChannelId(cache[match.cacheKeySuffix]),
    keyHint: buildChannelAffinityKeyHint(match.affinityValue),
    keyFingerprint: fp,
    usingGroup: req.usingGroup,
    modelName: req.model,
    requestPath: req.path,
  };
}

/** Original `service.RecordChannelAffinity`. */
export async function recordChannelAffinity(
  store: Store,
  env: Env,
  cacheKeySuffix: string,
  channelId: number,
  ttlSeconds = 3600,
): Promise<void> {
  if (channelId <= 0 || !cacheKeySuffix) return;
  if (!(await store.optionBool("channel_affinity_setting.enabled", true))) return;
  const cache = await loadAffinityCache(store, env);
  let ttl = ttlSeconds;
  if (ttl <= 0) ttl = await store.optionNum("channel_affinity_setting.default_ttl_seconds", 3600);
  if (ttl <= 0) ttl = 3600;
  cache[cacheKeySuffix] = { id: channelId, expires_at: nowSec() + ttl };
  const maxEntries = await store.optionNum("channel_affinity_setting.max_entries", 100000);
  const keys = Object.keys(cache);
  if (maxEntries > 0 && keys.length > maxEntries) {
    const overflow = keys.length - maxEntries;
    for (let i = 0; i < overflow; i++) delete cache[keys[i]];
  }
  await saveAffinityCache(store, env, cache);
}

export async function preferredAffinityChannel(
  store: Store,
  group: string,
  model: string,
  preferredChannelId: number,
): Promise<ChannelRow | null> {
  if (preferredChannelId <= 0) return null;
  let abilities = await store.abilitiesFor(group, model);
  if (!abilities.some((a) => a.channel_id === preferredChannelId)) {
    const normalized = routingMatchModelName(model);
    if (normalized && normalized !== model) abilities = await store.abilitiesFor(group, normalized);
  }
  if (!abilities.some((a) => a.channel_id === preferredChannelId)) return null;
  const ch = await store.getChannel(preferredChannelId);
  if (!ch || ch.status !== CHANNEL_ENABLED) return null;
  return ch;
}
