import { START_TIME, VERSION, nowSec } from "./constants.js";
import type { Store } from "./store.js";
import type { Env } from "./types.js";

/** Original `model.SystemInstanceStaleAfterSeconds`. */
export const SYSTEM_INSTANCE_STALE_AFTER_SECONDS = 90;
/** Original `model.SystemInstanceStatusOnline`. */
export const SYSTEM_INSTANCE_STATUS_ONLINE = "online";
/** Original `model.SystemInstanceStatusStale`. */
export const SYSTEM_INSTANCE_STATUS_STALE = "stale";
/** Original `common.NodeNameSourceManual`. */
export const NODE_NAME_SOURCE_MANUAL = "manual";
/** Original `common.NodeNameSourceHostname`. */
export const NODE_NAME_SOURCE_HOSTNAME = "hostname";
/** workerd hostname fallback when `NODE_NAME` and OS hostname are unset. */
export const DEFAULT_SYSTEM_INSTANCE_HOSTNAME = "edge-api";

/** Original `common.NodeIdentity`. */
export type NodeIdentity = {
  name: string;
  source: string;
  manually_configured: boolean;
  should_configure_manually: boolean;
};

/** Original `service.SystemInstanceInfo`. */
export type SystemInstanceInfo = {
  schema_version: number;
  node: NodeIdentity;
  role: { is_master: boolean };
  runtime: { version: string; goos: string; goarch: string; started_at: number };
  host: { hostname: string };
  resources: {
    cpu: { usage_percent: number };
    memory: { usage_percent: number };
    storage: { total_bytes: number; used_bytes: number; free_bytes: number; used_percent: number };
  };
  extra?: Record<string, unknown>;
};

/** Original `model.SystemInstanceResponse`. */
export type SystemInstanceResponse = {
  node_name: string;
  status: string;
  stale_after_seconds: number;
  started_at: number;
  last_seen_at: number;
  info: unknown;
};

function isolateStartSec(): number {
  return Math.floor(START_TIME / 1000);
}

/** Original `os.Hostname` fallback used when `NODE_NAME` is unset. workerd has no stable OS hostname. */
export function systemInstanceHostname(): string {
  return DEFAULT_SYSTEM_INSTANCE_HOSTNAME;
}

/** Original `common.GetNodeIdentity` + empty-name hostname fallback from `service.ReportCurrentSystemInstance`. */
export function getNodeIdentity(env: Pick<Env, "NODE_NAME">): NodeIdentity {
  const envName = String(env.NODE_NAME || "").trim();
  if (envName) {
    return {
      name: envName,
      source: NODE_NAME_SOURCE_MANUAL,
      manually_configured: true,
      should_configure_manually: false,
    };
  }
  const hostname = systemInstanceHostname();
  return {
    name: hostname,
    source: NODE_NAME_SOURCE_HOSTNAME,
    manually_configured: false,
    should_configure_manually: true,
  };
}

function memoryUsagePercent(): number {
  const mem =
    typeof performance !== "undefined" && "memory" in performance
      ? (performance as unknown as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }).memory
      : undefined;
  const used = Number(mem?.usedJSHeapSize || 0);
  const total = Number(mem?.totalJSHeapSize || 0);
  if (used <= 0 || total <= 0) return 0;
  return (used / total) * 100;
}

/** Original `service.ReportCurrentSystemInstance` info payload. */
export function buildSystemInstanceInfo(env: Env, identity: NodeIdentity, hostname: string): SystemInstanceInfo {
  const startedAt = isolateStartSec();
  return {
    schema_version: 1,
    node: identity,
    role: { is_master: String(env.NODE_TYPE || "") !== "slave" },
    runtime: {
      version: VERSION,
      goos: "workerd",
      goarch: "wasm",
      started_at: startedAt,
    },
    host: { hostname },
    resources: {
      cpu: { usage_percent: 0 },
      memory: { usage_percent: memoryUsagePercent() },
      storage: { total_bytes: 0, used_bytes: 0, free_bytes: 0, used_percent: 0 },
    },
  };
}

/** Original `model.marshalSystemInstanceInfo`. */
export function marshalSystemInstanceInfo(info: unknown): string {
  if (info == null) return "";
  return JSON.stringify(info);
}

/** Original `model.decodeSystemInstanceInfo`. */
export function decodeSystemInstanceInfo(data: string): unknown {
  if (!data) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

/** Original `model.SystemInstance.ToResponse`. */
export function toSystemInstanceResponse(
  row: { node_name?: unknown; started_at?: unknown; last_seen_at?: unknown; info?: unknown },
  now = nowSec(),
): SystemInstanceResponse {
  const lastSeenAt = Number(row.last_seen_at || 0);
  const status =
    now - lastSeenAt > SYSTEM_INSTANCE_STALE_AFTER_SECONDS ? SYSTEM_INSTANCE_STATUS_STALE : SYSTEM_INSTANCE_STATUS_ONLINE;
  return {
    node_name: String(row.node_name || ""),
    status,
    stale_after_seconds: SYSTEM_INSTANCE_STALE_AFTER_SECONDS,
    started_at: Number(row.started_at || 0),
    last_seen_at: lastSeenAt,
    info: decodeSystemInstanceInfo(typeof row.info === "string" ? row.info : row.info == null ? "" : JSON.stringify(row.info)),
  };
}

/**
 * Original `service.ReportCurrentSystemInstance`.
 * workerd has no background ticker; callers invoke this from GET list and scheduled.
 */
export async function reportCurrentSystemInstance(store: Store, env: Env): Promise<void> {
  const identity = getNodeIdentity(env);
  if (!identity.name.trim()) throw new Error("system instance node name is empty");
  const hostname = systemInstanceHostname();
  const info = buildSystemInstanceInfo(env, identity, hostname);
  await store.upsertSystemInstance(identity.name, marshalSystemInstanceInfo(info), isolateStartSec(), nowSec());
}

export async function listSystemInstanceResponses(store: Store, env: Env): Promise<SystemInstanceResponse[]> {
  try {
    await reportCurrentSystemInstance(store, env);
  } catch {
    /* original GET still lists persisted rows if the reporter fails */
  }
  const now = nowSec();
  return (await store.listSystemInstances()).map((row) => toSystemInstanceResponse(row, now));
}
