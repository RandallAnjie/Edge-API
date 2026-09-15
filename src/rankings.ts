import { nowSec } from "./constants.js";
import type { Store } from "./store.js";

const LEADERBOARD_LIMIT = 20;
const HISTORY_LIMIT = 10;
const VENDOR_LIMIT = 5;
const MOVER_LIMIT = 6;
const OTHERS = "Others";
const UNKNOWN = "Unknown";

type PeriodId = "week" | "today" | "month" | "year";

type PeriodConfig = {
  id: PeriodId;
  durationSec: number;
  bucketSize: number;
  labelLayout: "hour" | "day";
};

type Total = { model_name: string; total_tokens: number };
type Bucket = { model_name: string; bucket: number; tokens: number };
type Meta = { vendor: string; vendor_icon: string };

function periodConfig(period: string): PeriodConfig {
  switch (period) {
    case "":
    case "week":
      return { id: "week", durationSec: 7 * 86400, bucketSize: 86400, labelLayout: "day" };
    case "today":
      return { id: "today", durationSec: 86400, bucketSize: 3600, labelLayout: "hour" };
    case "month":
      return { id: "month", durationSec: 30 * 86400, bucketSize: 86400, labelLayout: "day" };
    case "year":
      return { id: "year", durationSec: 365 * 86400, bucketSize: 7 * 86400, labelLayout: "day" };
    default:
      throw Object.assign(new Error(`invalid ranking period: ${period}`), { status: 400 });
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function share(value: number, total: number): number {
  if (total <= 0 || value <= 0) return 0;
  return round4(value / total);
}

function growthPct(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return round4(((current - previous) / previous) * 100);
}

function bucketTs(bucket: number): string {
  return new Date(bucket * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function bucketLabel(bucket: number, layout: "hour" | "day"): string {
  const d = new Date(bucket * 1000);
  if (layout === "hour") {
    return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function modelMeta(name: string, meta: Record<string, Meta>): Meta {
  const item = meta[name];
  if (item?.vendor) return item;
  const slash = name.indexOf("/");
  if (slash > 0) return { vendor: name.slice(0, slash), vendor_icon: "" };
  return { vendor: UNKNOWN, vendor_icon: "" };
}

export async function buildRankingsSnapshot(store: Store, period: string): Promise<Record<string, unknown>> {
  const config = periodConfig(period);
  const end = nowSec();
  const start = end - config.durationSec;
  const previousEnd = start - 1;
  const previousStart = start - config.durationSec;
  const [currentTotals, previousTotals, buckets, meta] = await Promise.all([
    store.rankingTotals(start, end),
    store.rankingTotals(previousStart, previousEnd),
    store.rankingBuckets(start, end, config.bucketSize),
    store.rankingModelMeta(),
  ]);
  const previousRank = new Map(previousTotals.map((row, i) => [row.model_name, i + 1]));
  const previousTokens = new Map(previousTotals.map((row) => [row.model_name, row.total_tokens]));
  const totalTokens = currentTotals.reduce((s, r) => s + r.total_tokens, 0);
  const models = currentTotals.map((item, idx) => {
    const info = modelMeta(item.model_name, meta);
    const prev = previousRank.get(item.model_name);
    return {
      rank: idx + 1,
      ...(prev != null ? { previous_rank: prev } : {}),
      model_name: item.model_name,
      vendor: info.vendor,
      ...(info.vendor_icon ? { vendor_icon: info.vendor_icon } : {}),
      category: "all",
      total_tokens: item.total_tokens,
      share: share(item.total_tokens, totalTokens),
      growth_pct: growthPct(item.total_tokens, previousTokens.get(item.model_name) || 0),
    };
  });
  const vendors = buildVendors(currentTotals, previousTotals, totalTokens, meta);
  const models_history = buildModelHistory(buckets, currentTotals, meta, config);
  const vendor_share_history = buildVendorHistory(buckets, vendors, totalTokens, meta, config);
  const { top_movers, top_droppers } = buildMovers(models);
  return {
    models: models.slice(0, LEADERBOARD_LIMIT),
    vendors,
    top_movers,
    top_droppers,
    models_history,
    vendor_share_history,
  };
}

function buildVendors(
  current: Total[],
  previous: Total[],
  totalTokens: number,
  meta: Record<string, Meta>,
): Record<string, unknown>[] {
  const aggregates = new Map<
    string,
    { icon: string; total: number; previous: number; models: Set<string>; top: string; topTokens: number }
  >();
  const ensure = (name: string, icon: string) => {
    const key = name || UNKNOWN;
    let agg = aggregates.get(key);
    if (!agg) {
      agg = { icon, total: 0, previous: 0, models: new Set(), top: "", topTokens: 0 };
      aggregates.set(key, agg);
    }
    if (!agg.icon && icon) agg.icon = icon;
    return agg;
  };
  for (const item of current) {
    const info = modelMeta(item.model_name, meta);
    const agg = ensure(info.vendor, info.vendor_icon);
    agg.total += item.total_tokens;
    agg.models.add(item.model_name);
    if (item.total_tokens > agg.topTokens) {
      agg.top = item.model_name;
      agg.topTokens = item.total_tokens;
    }
  }
  for (const item of previous) {
    const info = modelMeta(item.model_name, meta);
    ensure(info.vendor, info.vendor_icon).previous += item.total_tokens;
  }
  return [...aggregates.entries()]
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([vendor, v], i) => ({
      rank: i + 1,
      vendor,
      ...(v.icon ? { vendor_icon: v.icon } : {}),
      total_tokens: v.total,
      share: share(v.total, totalTokens),
      growth_pct: growthPct(v.total, v.previous),
      models_count: v.models.size,
      top_model: v.top,
    }));
}

function buildModelHistory(
  buckets: Bucket[],
  totals: Total[],
  meta: Record<string, Meta>,
  config: PeriodConfig,
): Record<string, unknown> {
  const top = new Set<string>();
  const models: { name: string; vendor: string; total: number }[] = [];
  let otherTotal = 0;
  for (let i = 0; i < totals.length; i++) {
    const item = totals[i];
    if (i < HISTORY_LIMIT) {
      top.add(item.model_name);
      models.push({ name: item.model_name, vendor: modelMeta(item.model_name, meta).vendor, total: item.total_tokens });
    } else otherTotal += item.total_tokens;
  }
  if (otherTotal > 0) models.push({ name: OTHERS, vendor: "Various", total: otherTotal });
  const bucketSet = new Set<number>();
  const byBucket = new Map<number, Map<string, number>>();
  for (const item of buckets) {
    const name = top.has(item.model_name) ? item.model_name : OTHERS;
    bucketSet.add(item.bucket);
    const row = byBucket.get(item.bucket) || new Map();
    row.set(name, (row.get(name) || 0) + item.tokens);
    byBucket.set(item.bucket, row);
  }
  const sorted = [...bucketSet].sort((a, b) => a - b);
  const points: Record<string, unknown>[] = [];
  for (const bucket of sorted) {
    for (const model of models) {
      const tokens = byBucket.get(bucket)?.get(model.name) || 0;
      if (tokens <= 0) continue;
      points.push({
        ts: bucketTs(bucket),
        label: bucketLabel(bucket, config.labelLayout),
        model: model.name,
        vendor: model.vendor,
        tokens,
      });
    }
  }
  return { points, models, buckets: sorted.length };
}

function buildVendorHistory(
  buckets: Bucket[],
  vendors: Record<string, unknown>[],
  totalTokens: number,
  meta: Record<string, Meta>,
  config: PeriodConfig,
): Record<string, unknown> {
  const top = new Set<string>();
  const rows: { name: string; total: number; share: number }[] = [];
  let otherTotal = 0;
  for (let i = 0; i < vendors.length; i++) {
    const vendor = vendors[i];
    const name = String(vendor.vendor);
    const total = Number(vendor.total_tokens || 0);
    if (i < VENDOR_LIMIT) {
      top.add(name);
      rows.push({ name, total, share: Number(vendor.share || 0) });
    } else otherTotal += total;
  }
  if (otherTotal > 0) rows.push({ name: OTHERS, total: otherTotal, share: share(otherTotal, totalTokens) });
  const bucketSet = new Set<number>();
  const byBucket = new Map<number, Map<string, number>>();
  const totalsByBucket = new Map<number, number>();
  for (const item of buckets) {
    let name = modelMeta(item.model_name, meta).vendor;
    if (!top.has(name)) name = OTHERS;
    bucketSet.add(item.bucket);
    const row = byBucket.get(item.bucket) || new Map();
    row.set(name, (row.get(name) || 0) + item.tokens);
    byBucket.set(item.bucket, row);
    totalsByBucket.set(item.bucket, (totalsByBucket.get(item.bucket) || 0) + item.tokens);
  }
  const sorted = [...bucketSet].sort((a, b) => a - b);
  const points: Record<string, unknown>[] = [];
  for (const bucket of sorted) {
    for (const vendor of rows) {
      const tokens = byBucket.get(bucket)?.get(vendor.name) || 0;
      if (tokens <= 0) continue;
      points.push({
        ts: bucketTs(bucket),
        label: bucketLabel(bucket, config.labelLayout),
        vendor: vendor.name,
        share: share(tokens, totalsByBucket.get(bucket) || 0),
        tokens,
      });
    }
  }
  return { points, vendors: rows, buckets: sorted.length };
}

function buildMovers(models: { rank: number; previous_rank?: number; model_name: string; vendor: string; vendor_icon?: string; growth_pct: number }[]): {
  top_movers: Record<string, unknown>[];
  top_droppers: Record<string, unknown>[];
} {
  const movers: Record<string, unknown>[] = [];
  const droppers: Record<string, unknown>[] = [];
  for (const item of models) {
    if (item.previous_rank == null) continue;
    const delta = item.previous_rank - item.rank;
    if (delta === 0) continue;
    const row = {
      model_name: item.model_name,
      vendor: item.vendor,
      ...(item.vendor_icon ? { vendor_icon: item.vendor_icon } : {}),
      rank_delta: delta,
      current_rank: item.rank,
      growth_pct: item.growth_pct,
    };
    if (delta > 0) movers.push(row);
    else droppers.push(row);
  }
  movers.sort((a, b) => Number(b.rank_delta) - Number(a.rank_delta) || Number(b.growth_pct) - Number(a.growth_pct));
  droppers.sort((a, b) => Number(a.rank_delta) - Number(b.rank_delta) || Number(a.growth_pct) - Number(b.growth_pct));
  return { top_movers: movers.slice(0, MOVER_LIMIT), top_droppers: droppers.slice(0, MOVER_LIMIT) };
}
