import { DEFAULT_GROUP_RATIO, PERF_SERIES_SCHEMA, hourStartSec, nowSec, parseJson } from "./constants.js";
import type { Store } from "./store.js";

export type PerfRow = {
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
};

type Counters = {
  requestCount: number;
  successCount: number;
  totalLatencyMs: number;
  ttftSumMs: number;
  ttftCount: number;
  outputTokens: number;
  generationMs: number;
};

function emptyCounters(): Counters {
  return { requestCount: 0, successCount: 0, totalLatencyMs: 0, ttftSumMs: 0, ttftCount: 0, outputTokens: 0, generationMs: 0 };
}

function add(a: Counters, b: Counters): Counters {
  return {
    requestCount: a.requestCount + b.requestCount,
    successCount: a.successCount + b.successCount,
    totalLatencyMs: a.totalLatencyMs + b.totalLatencyMs,
    ttftSumMs: a.ttftSumMs + b.ttftSumMs,
    ttftCount: a.ttftCount + b.ttftCount,
    outputTokens: a.outputTokens + b.outputTokens,
    generationMs: a.generationMs + b.generationMs,
  };
}

function fromRow(row: Record<string, unknown>): Counters {
  return {
    requestCount: Number(row.request_count || 0),
    successCount: Number(row.success_count || 0),
    totalLatencyMs: Number(row.total_latency_ms || 0),
    ttftSumMs: Number(row.ttft_sum_ms || 0),
    ttftCount: Number(row.ttft_count || 0),
    outputTokens: Number(row.output_tokens || 0),
    generationMs: Number(row.generation_ms || 0),
  };
}

function avg(sum: number, count: number): number {
  if (count <= 0) return 0;
  return Math.trunc(sum / count);
}

function successRate(value: Counters): number {
  if (value.requestCount <= 0) return 0;
  return (value.successCount / value.requestCount) * 100;
}

function avgTps(value: Counters): number {
  if (value.outputTokens <= 0 || value.generationMs <= 0) return 0;
  return value.outputTokens / (value.generationMs / 1000);
}

function clampHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 24;
  if (hours > 24 * 30) return 24 * 30;
  return hours;
}

export async function recordRelayPerf(
  store: Store,
  sample: { model: string; group: string; latencyMs: number; success: boolean; outputTokens: number; stream?: boolean },
): Promise<void> {
  const model = String(sample.model || "").trim();
  if (!model) return;
  const group = sample.group || "default";
  const latencyMs = Math.max(0, Math.round(sample.latencyMs));
  const generationMs = Math.max(1, latencyMs);
  await store.upsertPerfMetric({
    model_name: model,
    group,
    bucket_ts: hourStartSec(),
    request_count: 1,
    success_count: sample.success ? 1 : 0,
    total_latency_ms: latencyMs,
    ttft_sum_ms: sample.stream ? latencyMs : 0,
    ttft_count: sample.stream ? 1 : 0,
    output_tokens: sample.success ? Math.max(0, sample.outputTokens) : 0,
    generation_ms: sample.success && sample.outputTokens > 0 ? generationMs : 0,
  });
}

export async function queryPerfMetrics(
  store: Store,
  modelName: string,
  group: string,
  hours: number,
): Promise<Record<string, unknown>> {
  const h = clampHours(hours);
  const endTs = nowSec();
  const startTs = endTs - h * 3600;
  const rows = await store.listPerfMetrics(modelName, group, startTs, endTs);
  const groupBuckets = new Map<string, Map<number, Counters>>();
  for (const row of rows) {
    const value = fromRow(row);
    if (value.requestCount <= 0) continue;
    const g = String(row.group || "default");
    if (!groupBuckets.has(g)) groupBuckets.set(g, new Map());
    const buckets = groupBuckets.get(g)!;
    buckets.set(Number(row.bucket_ts), add(buckets.get(Number(row.bucket_ts)) || emptyCounters(), value));
  }
  const groups = [...groupBuckets.keys()].sort();
  const results = groups.map((g) => {
    const buckets = groupBuckets.get(g)!;
    const timestamps = [...buckets.keys()].sort((a, b) => a - b);
    let total = emptyCounters();
    const series = timestamps.map((ts) => {
      const value = buckets.get(ts)!;
      total = add(total, value);
      return {
        ts,
        avg_ttft_ms: avg(value.ttftSumMs, value.ttftCount),
        avg_latency_ms: avg(value.totalLatencyMs, value.requestCount),
        success_rate: successRate(value),
        avg_tps: avgTps(value),
      };
    });
    return {
      group: g,
      avg_ttft_ms: avg(total.ttftSumMs, total.ttftCount),
      avg_latency_ms: avg(total.totalLatencyMs, total.requestCount),
      success_rate: successRate(total),
      avg_tps: avgTps(total),
      series,
    };
  });
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  const filtered = results.filter((g) => g.group === "auto" || ratios[g.group] != null);
  return { model_name: modelName, series_schema: PERF_SERIES_SCHEMA, groups: filtered };
}

export async function queryPerfMetricsSummary(store: Store, hours: number): Promise<Record<string, unknown>> {
  const h = clampHours(hours);
  const endTs = nowSec();
  const startTs = endTs - h * 3600;
  const ratios = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
  const activeGroups = [...Object.keys(ratios), "auto"];
  const rows = await store.listPerfMetricBuckets(startTs, endTs, activeGroups);
  const totals = new Map<string, Counters>();
  const modelBuckets = new Map<string, Map<number, Counters>>();
  for (const row of rows) {
    const value = fromRow(row);
    if (value.requestCount <= 0) continue;
    const name = String(row.model_name || "");
    totals.set(name, add(totals.get(name) || emptyCounters(), value));
    if (!modelBuckets.has(name)) modelBuckets.set(name, new Map());
    const buckets = modelBuckets.get(name)!;
    const hourTs = Number(row.bucket_ts) - (Number(row.bucket_ts) % 3600);
    buckets.set(hourTs, add(buckets.get(hourTs) || emptyCounters(), value));
  }
  const models = [...totals.entries()]
    .filter(([, total]) => total.requestCount > 0)
    .sort((a, b) => b[1].requestCount - a[1].requestCount)
    .map(([name, total]) => {
      const hourly = modelBuckets.get(name) || new Map();
      const timestamps = [...hourly.keys()].sort((a, b) => a - b);
      const recent_success_series = timestamps
        .filter((ts) => (hourly.get(ts)?.requestCount || 0) > 0)
        .map((ts) => {
          const value = hourly.get(ts)!;
          return { ts, success_rate: Math.round(successRate(value) * 100) / 100 };
        });
      return {
        model_name: name,
        avg_latency_ms: avg(total.totalLatencyMs, total.requestCount),
        success_rate: Math.round(successRate(total) * 100) / 100,
        avg_tps: Math.round(avgTps(total) * 100) / 100,
        ...(recent_success_series.length ? { recent_success_series } : {}),
      };
    });
  return { models };
}
