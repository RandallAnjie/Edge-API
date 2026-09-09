import { parseJson } from "./constants.js";
import { CHANNEL_AFFINITY_RULES } from "./option-defaults.js";
import type { Store } from "./store.js";
import type { Env } from "./types.js";

export type ChannelAffinityRule = {
  name?: string;
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

export async function loadAffinityCache(store: Store, env: Env): Promise<Record<string, unknown>> {
  const raw = env.KV ? await env.KV.get("channel_affinity") : await store.option("ChannelAffinityCache");
  return parseJson<Record<string, unknown>>(raw || "{}", {});
}

export async function saveAffinityCache(store: Store, env: Env, cache: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(cache);
  if (env.KV) await env.KV.put("channel_affinity", raw);
  await store.setOption("ChannelAffinityCache", raw);
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
