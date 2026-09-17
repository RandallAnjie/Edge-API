import type { Store } from "./store.js";

const ENTERPRISE_BASE = "https://api.io.solutions/enterprise/v1/io-cloud/caas";
const PUBLIC_BASE = "https://api.io.solutions/v1/io-cloud/caas";

/** Original Go `time.Time{}.Unix()`. */
export const IONET_ZERO_UNIX = -62135596800;

export async function ionetSettings(store: Store): Promise<{
  provider: string;
  enabled: boolean;
  configured: boolean;
  can_connect: boolean;
}> {
  const enabledFlag = (await store.option("model_deployment.ionet.enabled")) || (await store.option("IoNetEnabled"));
  const enabled = enabledFlag === "true" || enabledFlag === "1";
  const key = ((await store.option("model_deployment.ionet.api_key")) || (await store.option("IoNetApiKey"))).trim();
  return {
    provider: "io.net",
    enabled,
    configured: Boolean(key),
    can_connect: enabled && Boolean(key),
  };
}

export async function ionetApiKey(store: Store): Promise<string | null> {
  const settings = await ionetSettings(store);
  if (!settings.can_connect) return null;
  return ((await store.option("model_deployment.ionet.api_key")) || (await store.option("IoNetApiKey"))).trim();
}

export const IONET_NOT_CONFIGURED = "io.net model deployment is not enabled or api key missing";

export type IonetRequestOptions = {
  enterprise?: boolean;
  unwrapData?: boolean;
  rawText?: boolean;
};

function ionetOpts(enterpriseOrOpts: boolean | IonetRequestOptions): Required<IonetRequestOptions> {
  if (typeof enterpriseOrOpts === "boolean") {
    return { enterprise: enterpriseOrOpts, unwrapData: true, rawText: false };
  }
  return {
    enterprise: enterpriseOrOpts.enterprise !== false,
    unwrapData: enterpriseOrOpts.unwrapData !== false,
    rawText: Boolean(enterpriseOrOpts.rawText),
  };
}

/** Original `ionet.Client.makeRequest` plus optional `decodeData` unwrap. */
export async function ionetRequest(
  apiKey: string,
  method: string,
  endpoint: string,
  body?: unknown,
  enterpriseOrOpts: boolean | IonetRequestOptions = true,
): Promise<{ ok: true; json: unknown; text: string } | { ok: false; message: string }> {
  const opts = ionetOpts(enterpriseOrOpts);
  const res = await fetch((opts.enterprise ? ENTERPRISE_BASE : PUBLIC_BASE) + endpoint, {
    method,
    headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : opts.rawText ? "" : {};
  } catch {
    parsed = opts.rawText ? text : { raw: text };
  }
  if (res.status >= 400) {
    const detail =
      parsed && typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? String((parsed as { detail?: unknown }).detail || "")
        : "";
    return { ok: false, message: detail || `API request failed with status ${res.status}` };
  }
  if (opts.rawText) return { ok: true, json: text, text };
  if (opts.unwrapData && parsed && typeof parsed === "object" && parsed !== null && "data" in parsed) {
    return { ok: true, json: (parsed as { data: unknown }).data, text };
  }
  return { ok: true, json: parsed, text };
}

export function ionetWrapError(prefix: string, message: string): string {
  return `${prefix}: ${message}`;
}

function isZeroTime(value: unknown): boolean {
  if (value == null || value === "") return true;
  if (typeof value === "number") return value === 0 || value === IONET_ZERO_UNIX;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("0001-01-01")) return true;
    const t = Date.parse(trimmed);
    return Number.isNaN(t) || t === 0;
  }
  return false;
}

/** Original ionet flexible time decode → Unix seconds. */
export function ionetUnix(value: unknown, zero: "now" | "go-zero"): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return zero === "now" ? Math.floor(Date.now() / 1000) : IONET_ZERO_UNIX;
    return value > 1e12 ? Math.floor(value / 1000) : Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return zero === "now" ? Math.floor(Date.now() / 1000) : IONET_ZERO_UNIX;
}

function timeRemainingLabel(remaining: number): string {
  const hours = Math.floor(remaining / 60);
  const mins = remaining % 60;
  if (hours > 0) return `${hours} hour ${mins} minutes`;
  if (mins > 0) return `${mins} minutes`;
  return "completed";
}

/** Original `controller.mapIoNetDeployment`. */
export function mapIoNetDeployment(d: Record<string, unknown>): Record<string, unknown> {
  const created = isZeroTime(d.created_at) ? Math.floor(Date.now() / 1000) : ionetUnix(d.created_at, "now");
  const remaining = Number(d.compute_minutes_remaining || 0);
  const hardwareName = String(d.hardware_name || "");
  const brandName = String(d.brand_name || "");
  const qty = Number(d.hardware_quantity || 0);
  const name = String(d.name || "");
  return {
    id: d.id,
    deployment_name: name,
    container_name: name,
    status: String(d.status || "").toLowerCase(),
    type: "Container",
    time_remaining: timeRemainingLabel(remaining),
    time_remaining_minutes: remaining,
    hardware_info: `${brandName} ${hardwareName} x${qty}`,
    hardware_name: hardwareName,
    brand_name: brandName,
    hardware_quantity: qty,
    completed_percent: Number(d.completed_percent || 0),
    compute_minutes_served: Number(d.compute_minutes_served || 0),
    compute_minutes_remaining: remaining,
    created_at: created,
    updated_at: created,
    model_name: "",
    model_version: "",
    instance_count: qty,
    resource_config: { cpu: "", memory: "", gpu: String(qty) },
    description: "",
    provider: "io.net",
  };
}

/** Original `controller.GetDeployment` gin.H (not list `mapIoNetDeployment`). */
export function mapIoNetDeploymentDetail(d: Record<string, unknown>): Record<string, unknown> {
  const created = ionetUnix(d.created_at, "go-zero");
  const totalGpus = Number(d.total_gpus || 0);
  const totalContainers = Number(d.total_containers || 0);
  return {
    id: d.id,
    deployment_name: d.id,
    model_name: "",
    model_version: "",
    status: String(d.status || "").toLowerCase(),
    instance_count: totalContainers,
    hardware_id: Number(d.hardware_id || 0),
    resource_config: { cpu: "", memory: "", gpu: String(totalGpus) },
    created_at: created,
    updated_at: created,
    description: "",
    amount_paid: Number(d.amount_paid || 0),
    completed_percent: Number(d.completed_percent || 0),
    gpus_per_container: Number(d.gpus_per_container || 0),
    total_gpus: totalGpus,
    total_containers: totalContainers,
    hardware_name: String(d.hardware_name || ""),
    brand_name: String(d.brand_name || ""),
    compute_minutes_served: Number(d.compute_minutes_served || 0),
    compute_minutes_remaining: Number(d.compute_minutes_remaining || 0),
    locations: d.locations || [],
    container_config: d.container_config || {},
  };
}

/** Original `controller.ExtendDeployment` rebuilds a list Deployment from details. */
export function mapIoNetExtendedDeployment(deploymentId: string, details: Record<string, unknown>): Record<string, unknown> {
  return mapIoNetDeployment({
    id: details.id,
    status: details.status,
    name: deploymentId,
    completed_percent: details.completed_percent,
    hardware_quantity: details.total_gpus,
    brand_name: details.brand_name,
    hardware_name: details.hardware_name,
    compute_minutes_served: details.compute_minutes_served,
    compute_minutes_remaining: details.compute_minutes_remaining,
    created_at: details.created_at,
  });
}

function mapContainerEvents(events: unknown): { time: number; message: string }[] {
  if (!Array.isArray(events)) return [];
  return events.map((event) => {
    const row = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    return {
      time: ionetUnix(row.time, "go-zero"),
      message: String(row.message || ""),
    };
  });
}

/** Original `controller.ListDeploymentContainers` worker gin.H. */
export function mapIoNetContainer(ctr: Record<string, unknown>): Record<string, unknown> {
  return {
    container_id: String(ctr.container_id || ""),
    device_id: String(ctr.device_id || ""),
    status: String(ctr.status || "").toLowerCase().trim(),
    hardware: ctr.hardware ?? "",
    brand_name: String(ctr.brand_name || ""),
    created_at: ionetUnix(ctr.created_at, "go-zero"),
    uptime_percent: Number(ctr.uptime_percent || 0),
    gpus_per_container: Number(ctr.gpus_per_container || 0),
    public_url: String(ctr.public_url || ""),
    events: mapContainerEvents(ctr.container_events),
  };
}

/** Original `controller.GetContainerDetails` gin.H. */
export function mapIoNetContainerDetails(deploymentId: string, details: Record<string, unknown>): Record<string, unknown> {
  return {
    deployment_id: deploymentId,
    ...mapIoNetContainer(details),
  };
}

export function mapIoNetContainerList(payload: Record<string, unknown> | null | undefined): {
  total: number;
  containers: Record<string, unknown>[];
} {
  if (!payload) return { total: 0, containers: [] };
  const workers = Array.isArray(payload.workers) ? payload.workers : [];
  return {
    total: Number(payload.total || 0),
    containers: workers.map((row) => mapIoNetContainer((row || {}) as Record<string, unknown>)),
  };
}

/** Original `ionet.Client.ListHardwareTypes` HardwareType JSON (omitempty zeros). */
export function mapIoNetHardwareTypes(payload: { hardware?: Record<string, unknown>[]; total?: number }): {
  hardware_types: Record<string, unknown>[];
  total: number;
  total_available: number;
} {
  const hardware = payload.hardware || [];
  const hardware_types = hardware.map((hw) => {
    const id = Number(hw.hardware_id || 0);
    const name = String(hw.hardware_name || "").trim() || `Hardware ${id}`;
    const brand = String(hw.brand_name || "").trim();
    const availableCount = Number(hw.available || 0);
    const out: Record<string, unknown> = {
      id,
      name,
      gpu_type: "",
      gpu_memory: 0,
      max_gpus: Number(hw.max_gpus_per_container || 0),
      hourly_rate: 0,
      available: availableCount > 0,
    };
    if (brand) out.brand_name = brand;
    if (availableCount) out.available_count = availableCount;
    return out;
  });
  let totalAvailable = Number(payload.total || 0);
  if (totalAvailable === 0) {
    totalAvailable = hardware.reduce((sum, hw) => sum + Number(hw.available || 0), 0);
  }
  return { hardware_types, total: hardware_types.length, total_available: totalAvailable };
}

export function mapIoNetLocations(payload: { locations?: Record<string, unknown>[]; total?: number } | unknown[]): {
  locations: Record<string, unknown>[];
  total: number;
} {
  const raw = Array.isArray(payload) ? payload : payload.locations || [];
  const locations = raw.map((loc) => {
    const row = { ...(loc as Record<string, unknown>) };
    if (row.iso2 != null) row.iso2 = String(row.iso2).trim().toUpperCase();
    return row;
  });
  let total = Array.isArray(payload) ? 0 : Number(payload.total || 0);
  if (total === 0) {
    total = locations.reduce((sum, loc) => sum + Number(loc.available || 0), 0);
  }
  if (total === 0) total = locations.length;
  return { locations, total };
}

/** Original `ionet.Client.GetAvailableReplicas` mapped `AvailableReplicasResponse`. */
export function mapIoNetAvailableReplicas(
  payload: unknown,
  hardwareId: number,
  gpuCount: number,
): { replicas: Record<string, unknown>[] } {
  const rows = Array.isArray(payload) ? payload : [];
  return {
    replicas: rows.map((item) => {
      const row = (item || {}) as Record<string, unknown>;
      return {
        location_id: Number(row.id || 0),
        location_name: String(row.name || ""),
        hardware_id: hardwareId,
        hardware_name: "",
        available_count: Number(row.available_replicas || 0),
        max_gpus: gpuCount,
      };
    }),
  };
}

function durationHoursForRate(durationType: string, durationQty: number, durationHours: number): { hours: number; apiType: string } {
  const qty = durationQty;
  switch (durationType) {
    case "hour":
    case "hours":
    case "hourly":
      return { hours: qty, apiType: "hourly" };
    case "day":
    case "days":
    case "daily":
      return { hours: qty * 24, apiType: "daily" };
    case "week":
    case "weeks":
    case "weekly":
      return { hours: qty * 24 * 7, apiType: "weekly" };
    case "month":
    case "months":
    case "monthly":
      return { hours: qty * 24 * 30, apiType: "monthly" };
    default:
      return { hours: durationHours > 0 ? durationHours : qty, apiType: "hourly" };
  }
}

function encodeIonetQuery(params: Record<string, unknown>): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      values.set(key, JSON.stringify(value));
      continue;
    }
    if (typeof value === "number") {
      if (value === 0) continue;
      values.set(key, String(value));
      continue;
    }
    if (typeof value === "boolean") {
      values.set(key, value ? "true" : "false");
      continue;
    }
    const text = String(value);
    if (!text) continue;
    values.set(key, text);
  }
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}

export function validatePriceEstimationRequest(req: Record<string, unknown>): { ok: true; query: string } | { ok: false; message: string } {
  const locationIds = Array.isArray(req.location_ids) ? req.location_ids.map((n) => Number(n)) : [];
  if (!locationIds.length) return { ok: false, message: "location_ids is required" };
  const hardwareId = Number(req.hardware_id || 0);
  if (!hardwareId) return { ok: false, message: "hardware_id is required" };
  const replicaCount = Number(req.replica_count || 0);
  if (replicaCount < 1) return { ok: false, message: "replica_count must be at least 1" };
  let currency = String(req.currency || "").trim();
  if (!currency) currency = "usdc";
  let durationType = String(req.duration_type || "").trim().toLowerCase();
  if (!durationType) durationType = "hour";
  let durationQty = Number(req.duration_qty || 0);
  if (durationQty < 1) durationQty = Number(req.duration_hours || 0);
  if (durationQty < 1) return { ok: false, message: "duration_qty must be at least 1" };
  let hardwareQty = Number(req.hardware_qty || 0);
  const gpusPerContainer = Number(req.gpus_per_container || 0);
  if (hardwareQty < 1) hardwareQty = gpusPerContainer;
  if (hardwareQty < 1) return { ok: false, message: "hardware_qty must be at least 1" };
  let durationHours = Number(req.duration_hours || 0);
  if (durationHours < 1) durationHours = durationQty;
  const rate = durationHoursForRate(durationType, durationQty, durationHours);
  if (rate.hours < 1) rate.hours = 1;
  const query = encodeIonetQuery({
    location_ids: locationIds,
    hardware_id: hardwareId,
    hardware_qty: hardwareQty,
    gpus_per_container: gpusPerContainer,
    duration_type: rate.apiType,
    duration_qty: durationQty,
    duration_hours: durationHours,
    replica_count: replicaCount,
    currency,
  });
  return { ok: true, query };
}

/** Original `ionet.Client.GetPriceEstimation` mapped `PriceEstimationResponse`. */
export function mapIoNetPriceEstimation(payload: Record<string, unknown>, currency: string, durationHours: number): Record<string, unknown> {
  const total = Number(payload.total_cost_usdc || 0);
  const ionetFee = Number(payload.ionet_fee || 0);
  const conversionFee = Number(payload.currency_conversion_fee || 0);
  const hours = durationHours > 0 ? durationHours : 1;
  return {
    estimated_cost: total,
    currency: currency.toUpperCase(),
    price_breakdown: {
      compute_cost: total - ionetFee - conversionFee,
      total_cost: total,
      hourly_rate: total / hours,
    },
    estimation_valid: true,
  };
}

export function priceEstimationDurationHours(req: Record<string, unknown>): number {
  let durationType = String(req.duration_type || "").trim().toLowerCase();
  if (!durationType) durationType = "hour";
  let durationQty = Number(req.duration_qty || 0);
  if (durationQty < 1) durationQty = Number(req.duration_hours || 0);
  let durationHours = Number(req.duration_hours || 0);
  if (durationHours < 1) durationHours = durationQty;
  return durationHoursForRate(durationType, durationQty, durationHours).hours || 1;
}

export function priceEstimationCurrency(req: Record<string, unknown>): string {
  const currency = String(req.currency || "").trim();
  return currency || "usdc";
}

export function validateDeployRequest(req: Record<string, unknown>): string | null {
  if (!String(req.resource_private_name || "").trim()) return "resource_private_name is required";
  if (!Array.isArray(req.location_ids) || !req.location_ids.length) return "location_ids is required";
  if (Number(req.hardware_id || 0) <= 0) return "hardware_id is required";
  const registry = (req.registry_config || {}) as Record<string, unknown>;
  if (!String(registry.image_url || "").trim()) return "registry_config.image_url is required";
  if (Number(req.gpus_per_container || 0) < 1) return "gpus_per_container must be at least 1";
  if (Number(req.duration_hours || 0) < 1) return "duration_hours must be at least 1";
  const container = (req.container_config || {}) as Record<string, unknown>;
  if (Number(container.replica_count || 0) < 1) return "container_config.replica_count must be at least 1";
  return null;
}

export function computeStatusCounts(total: number, deployments: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = { all: total };
  for (const status of ["running", "completed", "failed", "deployment requested", "termination requested", "destroyed"]) {
    counts[status] = 0;
  }
  for (const d of deployments) {
    const status = String(d.status || "").toLowerCase().trim();
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

export function testIoNetTotals(payload: { hardware?: { available?: number }[]; total?: number }): {
  hardware_count: number;
  total_available: number;
} {
  const hardware = payload.hardware || [];
  let totalAvailable = Number(payload.total || 0);
  if (totalAvailable === 0) {
    totalAvailable = hardware.reduce((sum, hw) => sum + Number(hw.available || 0), 0);
  }
  return { hardware_count: hardware.length, total_available: totalAvailable };
}

export function logsEndpoint(deploymentId: string, url: URL): { ok: true; path: string } | { ok: false; message: string } {
  const containerId = (url.searchParams.get("container_id") || "").trim();
  if (!containerId) return { ok: false, message: "container_id parameter is required" };
  const params: Record<string, unknown> = {};
  const level = url.searchParams.get("level") || "";
  const stream = url.searchParams.get("stream") || "";
  const cursor = url.searchParams.get("cursor") || "";
  if (level) params.level = level;
  if (stream) params.stream = stream;
  if (cursor) params.cursor = cursor;
  if (url.searchParams.get("follow") === "true") params.follow = true;
  let limit = 100;
  const limitStr = url.searchParams.get("limit") || "";
  if (limitStr) {
    const parsed = Number.parseInt(limitStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 1000);
  }
  params.limit = limit;
  const startTime = url.searchParams.get("start_time") || "";
  const endTime = url.searchParams.get("end_time") || "";
  if (startTime && !Number.isNaN(Date.parse(startTime))) params.start_time = startTime;
  if (endTime && !Number.isNaN(Date.parse(endTime))) params.end_time = endTime;
  return { ok: true, path: `/deployment/${encodeURIComponent(deploymentId)}/log/${encodeURIComponent(containerId)}${encodeIonetQuery(params)}` };
}
