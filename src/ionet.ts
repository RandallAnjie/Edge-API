import type { Store } from "./store.js";

const ENTERPRISE_BASE = "https://api.io.solutions/enterprise/v1/io-cloud/caas";
const PUBLIC_BASE = "https://api.io.solutions/v1/io-cloud/caas";

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

export async function ionetRequest(
  apiKey: string,
  method: string,
  endpoint: string,
  body?: unknown,
  enterprise = true,
): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  const res = await fetch((enterprise ? ENTERPRISE_BASE : PUBLIC_BASE) + endpoint, {
    method,
    headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (res.status >= 400) {
    const detail =
      parsed && typeof parsed === "object" && "detail" in parsed
        ? String((parsed as { detail?: unknown }).detail || "")
        : "";
    return { ok: false, message: detail || `API request failed with status ${res.status}` };
  }
  if (parsed && typeof parsed === "object" && "data" in (parsed as object)) {
    return { ok: true, json: (parsed as { data: unknown }).data };
  }
  return { ok: true, json: parsed };
}

export function mapIoNetDeployment(d: Record<string, unknown>): Record<string, unknown> {
  const createdRaw = d.created_at;
  let created = Math.floor(Date.now() / 1000);
  if (typeof createdRaw === "number") created = createdRaw > 1e12 ? Math.floor(createdRaw / 1000) : createdRaw;
  else if (typeof createdRaw === "string") {
    const t = Date.parse(createdRaw);
    if (!Number.isNaN(t)) created = Math.floor(t / 1000);
  }
  const remaining = Number(d.compute_minutes_remaining || 0);
  const hours = Math.floor(remaining / 60);
  const mins = remaining % 60;
  let timeRemaining = "completed";
  if (hours > 0) timeRemaining = `${hours} hour ${mins} minutes`;
  else if (mins > 0) timeRemaining = `${mins} minutes`;
  const hardwareName = String(d.hardware_name || "");
  const brandName = String(d.brand_name || "");
  const qty = Number(d.hardware_quantity || d.gpu_count || 1);
  const name = String(d.name || d.deployment_name || "");
  return {
    id: d.id,
    deployment_name: name,
    container_name: name,
    status: String(d.status || "").toLowerCase(),
    type: "Container",
    time_remaining: timeRemaining,
    time_remaining_minutes: remaining,
    hardware_info: `${brandName} ${hardwareName} x${qty}`.trim(),
    hardware_name: hardwareName,
    brand_name: brandName,
    hardware_quantity: qty,
    completed_percent: d.completed_percent || 0,
    compute_minutes_served: d.compute_minutes_served || 0,
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
