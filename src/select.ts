import type { ChannelRow } from "./types.js";
import { csv } from "./constants.js";

export function channelSupportsModel(channel: Pick<ChannelRow, "models">, model: string): boolean {
  const models = csv(channel.models);
  if (models.length === 0) return true;
  return models.includes(model);
}

export function channelInGroup(channel: Pick<ChannelRow, "group">, group: string): boolean {
  const groups = csv(channel.group);
  if (groups.length === 0) return group === "default";
  return groups.includes(group) || groups.includes("all");
}

export interface AbilityCandidate {
  channel_id: number;
  priority: number;
  weight: number;
}

/** Original GetChannel: unique priorities DESC, retry indexes that tier, weight+10. */
export function pickAbilityChannelId(
  abilities: AbilityCandidate[],
  retry: number,
  random: () => number = Math.random,
): number | null {
  if (!abilities.length) return null;
  const unique = [...new Set(abilities.map((a) => Number(a.priority) || 0))].sort((a, b) => b - a);
  let idx = retry;
  if (idx >= unique.length) idx = unique.length - 1;
  if (idx < 0) idx = 0;
  const target = unique[idx];
  const pool = abilities.filter((a) => (Number(a.priority) || 0) === target);
  if (!pool.length) return null;
  let weightSum = 0;
  for (const a of pool) weightSum += (Number(a.weight) || 0) + 10;
  let weight = Math.floor(random() * weightSum);
  for (const a of pool) {
    weight -= (Number(a.weight) || 0) + 10;
    if (weight <= 0) return a.channel_id;
  }
  return pool[pool.length - 1].channel_id;
}

export function pickWeighted<T extends { weight: number; id: number }>(
  items: T[],
  exclude: Set<number>,
  random: () => number = Math.random,
): T | null {
  const pool = items.filter((i) => !exclude.has(i.id));
  if (pool.length === 0) return null;
  const weights = pool.map((i) => Math.max(1, Number(i.weight) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function orderChannels(
  channels: ChannelRow[],
  model: string,
  group: string,
  random: () => number = Math.random,
): ChannelRow[] {
  const matched = channels.filter(
    (c) => c.status === 1 && channelSupportsModel(c, model) && channelInGroup(c, group),
  );
  const byPri = new Map<number, ChannelRow[]>();
  for (const c of matched) {
    const p = Number(c.priority) || 0;
    const arr = byPri.get(p) ?? [];
    arr.push(c);
    byPri.set(p, arr);
  }
  const pris = [...byPri.keys()].sort((a, b) => b - a);
  const ordered: ChannelRow[] = [];
  for (const p of pris) {
    const groupCh = byPri.get(p)!;
    const exclude = new Set<number>();
    for (let i = 0; i < groupCh.length; i++) {
      const next = pickWeighted(groupCh, exclude, random);
      if (!next) break;
      exclude.add(next.id);
      ordered.push(next);
    }
  }
  return ordered;
}

export function mapModel(mappingJson: string, model: string): string {
  if (!mappingJson) return model;
  try {
    const map = JSON.parse(mappingJson) as Record<string, string>;
    return map[model] || model;
  } catch {
    return model;
  }
}

export function pickChannelKey(key: string, random: () => number = Math.random): string {
  const keys = key
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (keys.length === 0) return "";
  return keys[Math.floor(random() * keys.length)];
}

export function ipAllowed(allowIps: string, ip: string): boolean {
  const list = allowIps
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  if (!ip) return false;
  return list.some((entry) => {
    if (entry.includes("/")) {
      return cidrContains(entry, ip);
    }
    return entry === ip;
  });
}

function cidrContains(cidr: string, ip: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!Number.isFinite(bits)) return false;
  const ipNum = ipv4ToInt(ip);
  const rangeNum = ipv4ToInt(range);
  if (ipNum == null || rangeNum == null) return ip === range;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
}
