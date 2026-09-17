import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { mapIoNetDeployment, mapIoNetDeploymentDetail, mapIoNetHardwareTypes } from "../src/ionet.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function boot(e: Env) {
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { token, auth };
}

const CREATED = "2026-01-02T03:04:05Z";
const CREATED_UNIX = Math.floor(Date.parse(CREATED) / 1000);

const LIST_DEPLOYMENT = {
  id: "dep-1",
  status: "Running",
  name: "alpha-box",
  completed_percent: 40,
  hardware_quantity: 2,
  brand_name: "NVIDIA",
  hardware_name: "H100",
  compute_minutes_served: 10,
  compute_minutes_remaining: 125,
  created_at: CREATED,
};

const DETAIL_DEPLOYMENT = {
  id: "dep-1",
  status: "Running",
  created_at: CREATED,
  amount_paid: 12.5,
  completed_percent: 40,
  total_gpus: 4,
  gpus_per_container: 2,
  total_containers: 2,
  hardware_name: "H100",
  hardware_id: 9,
  brand_name: "NVIDIA",
  compute_minutes_served: 10,
  compute_minutes_remaining: 125,
  locations: [{ id: 1, iso2: "us", name: "US" }],
  container_config: { image_url: "ghcr.io/demo", traffic_port: 8080, entrypoint: ["/bin"], env_variables: {} },
};

test("original mapIoNetDeployment and GetDeployment gin.H JSON fields", () => {
  const listed = mapIoNetDeployment(LIST_DEPLOYMENT);
  for (const k of [
    "id",
    "deployment_name",
    "container_name",
    "status",
    "type",
    "time_remaining",
    "time_remaining_minutes",
    "hardware_info",
    "hardware_name",
    "brand_name",
    "hardware_quantity",
    "completed_percent",
    "compute_minutes_served",
    "compute_minutes_remaining",
    "created_at",
    "updated_at",
    "model_name",
    "model_version",
    "instance_count",
    "resource_config",
    "description",
    "provider",
  ]) {
    assert.ok(k in listed, "missing list field " + k);
  }
  assert.equal(listed.deployment_name, "alpha-box");
  assert.equal(listed.hardware_info, "NVIDIA H100 x2");
  assert.equal(listed.time_remaining, "2 hour 5 minutes");
  assert.equal(listed.instance_count, 2);
  assert.deepEqual(listed.resource_config, { cpu: "", memory: "", gpu: "2" });

  const detail = mapIoNetDeploymentDetail(DETAIL_DEPLOYMENT);
  for (const k of [
    "id",
    "deployment_name",
    "model_name",
    "model_version",
    "status",
    "instance_count",
    "hardware_id",
    "resource_config",
    "created_at",
    "updated_at",
    "description",
    "amount_paid",
    "completed_percent",
    "gpus_per_container",
    "total_gpus",
    "total_containers",
    "hardware_name",
    "brand_name",
    "compute_minutes_served",
    "compute_minutes_remaining",
    "locations",
    "container_config",
  ]) {
    assert.ok(k in detail, "missing GetDeployment field " + k);
  }
  assert.equal(detail.deployment_name, "dep-1");
  assert.equal(detail.instance_count, 2);
  assert.equal(detail.hardware_id, 9);
  assert.deepEqual(detail.resource_config, { cpu: "", memory: "", gpu: "4" });
  assert.equal(detail.amount_paid, 12.5);
  assert.ok(!("type" in detail));
  assert.ok(!("provider" in detail));
  assert.ok(!("time_remaining" in detail));

  const hw = mapIoNetHardwareTypes({
    hardware: [{ max_gpus_per_container: 8, available: 3, hardware_id: 9, hardware_name: "H100", brand_name: "NVIDIA" }],
    total: 0,
  });
  assert.equal(hw.total_available, 3);
  assert.equal(hw.total, 1);
  assert.equal(hw.hardware_types[0].id, 9);
  assert.equal(hw.hardware_types[0].name, "H100");
  assert.equal(hw.hardware_types[0].max_gpus, 8);
  assert.equal(hw.hardware_types[0].available, true);
  assert.equal(hw.hardware_types[0].gpu_type, "");
  assert.equal(hw.hardware_types[0].hourly_rate, 0);
  assert.ok(!("description" in hw.hardware_types[0]));
});

test("original deployments HTTP JSON fields", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "model_deployment.ionet.enabled", value: "true" }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "model_deployment.ionet.api_key", value: "io-key" }),
    }),
    e,
  );

  const seen: { method: string; url: string; body: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = req.url;
    seen.push({ method: req.method, url, body: req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text() });
    const jsonBody = (data: unknown, unwrap = true) =>
      new Response(JSON.stringify(unwrap ? { data } : data), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/enterprise/v1/io-cloud/caas/deployments")) {
      return jsonBody({ deployments: [LIST_DEPLOYMENT], total: 7 });
    }
    if (url.includes("/enterprise/v1/io-cloud/caas/hardware/max-gpus-per-container")) {
      return jsonBody({
        hardware: [{ max_gpus_per_container: 8, available: 3, hardware_id: 9, hardware_name: "H100", brand_name: "NVIDIA" }],
        total: 0,
      });
    }
    if (url.includes("/v1/io-cloud/caas/locations")) {
      return jsonBody({ locations: [{ id: 4, name: "Iowa", iso2: "us", available: 0 }], total: 0 });
    }
    if (url.includes("/available-replicas")) {
      return jsonBody([{ id: 11, iso2: "us", name: "Iowa", available_replicas: 5 }]);
    }
    if (url.includes("/enterprise/v1/io-cloud/caas/price")) {
      return jsonBody({ total_cost_usdc: 10, ionet_fee: 1, currency_conversion_fee: 0 });
    }
    if (url.includes("check_cluster_name_availability")) {
      return jsonBody(true, false);
    }
    if (url.endsWith("/deploy") && req.method === "POST") {
      return jsonBody({ status: "requested", deployment_id: "dep-9" }, false);
    }
    if (url.includes("/deployment/dep-1/extend")) {
      return jsonBody(DETAIL_DEPLOYMENT);
    }
    if (url.includes("/deployment/dep-1/containers") && req.method === "GET") {
      return jsonBody({
        total: 1,
        workers: [
          {
            container_id: "ctr-1",
            device_id: "dev-1",
            status: "Running",
            hardware: "H100",
            brand_name: "NVIDIA",
            created_at: CREATED,
            uptime_percent: 99,
            gpus_per_container: 2,
            public_url: "https://ctr.example",
            container_events: [{ time: CREATED, message: "booted" }],
          },
        ],
      });
    }
    if (url.includes("/deployment/dep-1/container/ctr-1")) {
      return jsonBody(
        {
          container_id: "ctr-1",
          device_id: "dev-1",
          status: "Running",
          hardware: "H100",
          brand_name: "NVIDIA",
          created_at: CREATED,
          uptime_percent: 99,
          gpus_per_container: 2,
          public_url: "https://ctr.example",
          container_events: [{ time: CREATED, message: "booted" }],
        },
        false,
      );
    }
    if (url.includes("/v1/io-cloud/caas/deployment/dep-1/log/ctr-1")) {
      return new Response("line-a\nline-b\n", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("/clusters/dep-1/update-name")) {
      return jsonBody({ status: "ok", message: "renamed" }, false);
    }
    if (url.includes("/deployment/dep-1") && req.method === "PATCH") {
      return jsonBody({ status: "updated", deployment_id: "dep-1" }, false);
    }
    if (url.includes("/deployment/dep-1") && req.method === "DELETE") {
      return jsonBody({ status: "terminating", deployment_id: "dep-1" }, false);
    }
    if (url.includes("/deployment/dep-1") && req.method === "GET") {
      return jsonBody(DETAIL_DEPLOYMENT);
    }
    return new Response("unhandled " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const list = await json(new Request("http://local/api/deployments/", { headers: auth }), e);
    assert.equal(list.body.success, true, String(list.body.message));
    const listData = list.body.data as Record<string, unknown>;
    assert.equal(listData.page, 1);
    assert.equal(listData.page_size, 10);
    assert.equal(listData.total, 7);
    const items = listData.items as Record<string, unknown>[];
    assert.equal(items[0].deployment_name, "alpha-box");
    assert.equal(items[0].hardware_info, "NVIDIA H100 x2");
    assert.equal(items[0].created_at, CREATED_UNIX);
    const counts = listData.status_counts as Record<string, number>;
    assert.equal(counts.all, 7);
    assert.equal(counts.running, 1);
    assert.equal(counts.completed, 0);
    assert.equal(counts["deployment requested"], 0);

    const searchEmpty = await json(new Request("http://local/api/deployments/search", { headers: auth }), e);
    const searchEmptyData = searchEmpty.body.data as Record<string, unknown>;
    assert.equal(searchEmptyData.total, 7);
    assert.ok(!("status_counts" in searchEmptyData));

    const searchKw = await json(new Request("http://local/api/deployments/search?keyword=alpha", { headers: auth }), e);
    const searchKwData = searchKw.body.data as Record<string, unknown>;
    assert.equal(searchKwData.total, 1);

    const detail = await json(new Request("http://local/api/deployments/dep-1", { headers: auth }), e);
    const d = detail.body.data as Record<string, unknown>;
    assert.equal(d.deployment_name, "dep-1");
    assert.equal(d.instance_count, 2);
    assert.equal(d.hardware_id, 9);
    assert.equal(d.amount_paid, 12.5);
    assert.equal(d.gpus_per_container, 2);
    assert.equal(d.total_gpus, 4);
    assert.ok(Array.isArray(d.locations));
    assert.equal(typeof d.container_config, "object");

    const hardware = await json(new Request("http://local/api/deployments/hardware-types", { headers: auth }), e);
    const hw = hardware.body.data as Record<string, unknown>;
    assert.equal(hw.total, 1);
    assert.equal(hw.total_available, 3);
    const types = hw.hardware_types as Record<string, unknown>[];
    assert.equal(types[0].id, 9);
    assert.equal(types[0].max_gpus, 8);
    assert.equal(types[0].gpu_type, "");

    const locations = await json(new Request("http://local/api/deployments/locations", { headers: auth }), e);
    const loc = locations.body.data as Record<string, unknown>;
    assert.equal(loc.total, 1);
    assert.equal((loc.locations as Record<string, unknown>[])[0].iso2, "US");
    assert.ok(seen.some((s) => s.url.includes("https://api.io.solutions/v1/io-cloud/caas/locations")));

    const replicas = await json(new Request("http://local/api/deployments/available-replicas?hardware_id=9&gpu_count=2", { headers: auth }), e);
    const rep = replicas.body.data as { replicas: Record<string, unknown>[] };
    assert.equal(rep.replicas[0].location_id, 11);
    assert.equal(rep.replicas[0].location_name, "Iowa");
    assert.equal(rep.replicas[0].hardware_id, 9);
    assert.equal(rep.replicas[0].available_count, 5);
    assert.equal(rep.replicas[0].max_gpus, 2);

    const badHw = await json(new Request("http://local/api/deployments/available-replicas?hardware_id=abc", { headers: auth }), e);
    assert.equal(badHw.body.success, false);
    assert.equal(badHw.body.message, "invalid hardware_id parameter");
    assert.equal("data" in badHw.body, false);

    const price = await json(
      new Request("http://local/api/deployments/price-estimation", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          location_ids: [1],
          hardware_id: 9,
          gpus_per_container: 2,
          duration_hours: 3,
          replica_count: 1,
        }),
      }),
      e,
    );
    const pd = price.body.data as Record<string, unknown>;
    assert.equal(pd.estimated_cost, 10);
    assert.equal(pd.currency, "USDC");
    assert.equal(pd.estimation_valid, true);
    const breakdown = pd.price_breakdown as Record<string, unknown>;
    assert.equal(breakdown.total_cost, 10);
    assert.equal(breakdown.compute_cost, 9);
    assert.ok(seen.some((s) => s.method === "GET" && s.url.includes("/enterprise/v1/io-cloud/caas/price?")));

    const check = await json(new Request("http://local/api/deployments/check-name?name=alpha-box", { headers: auth }), e);
    assert.deepEqual(check.body.data, { available: true, name: "alpha-box" });
    assert.ok(seen.some((s) => s.url.includes("/clusters/check_cluster_name_availability?cluster_name=alpha-box")));

    const created = await json(
      new Request("http://local/api/deployments/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          resource_private_name: "alpha-box",
          duration_hours: 1,
          gpus_per_container: 1,
          hardware_id: 9,
          location_ids: [1],
          container_config: { replica_count: 1 },
          registry_config: { image_url: "ghcr.io/demo" },
        }),
      }),
      e,
    );
    assert.deepEqual(created.body.data, {
      deployment_id: "dep-9",
      status: "requested",
      message: "Deployment created successfully",
    });
    assert.equal(created.body.message, "");

    const missingCreate = await json(
      new Request("http://local/api/deployments/", { method: "POST", headers: auth, body: "{}" }),
      e,
    );
    assert.equal(missingCreate.body.success, false);
    assert.match(String(missingCreate.body.message), /failed to deploy container: resource_private_name is required/);

    const renamed = await json(
      new Request("http://local/api/deployments/dep-1/name", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "beta-box" }),
      }),
      e,
    );
    assert.deepEqual(renamed.body.data, { status: "ok", message: "renamed", id: "dep-1", name: "beta-box" });
    assert.ok(seen.some((s) => s.method === "PUT" && s.url.includes("/clusters/dep-1/update-name") && s.body.includes("cluster_name")));

    const updated = await json(
      new Request("http://local/api/deployments/dep-1", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ image_url: "ghcr.io/demo:2" }),
      }),
      e,
    );
    assert.deepEqual(updated.body.data, { status: "updated", deployment_id: "dep-1" });
    assert.ok(seen.some((s) => s.method === "PATCH" && s.url.endsWith("/deployment/dep-1")));

    const extended = await json(
      new Request("http://local/api/deployments/dep-1/extend", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ duration_hours: 2 }),
      }),
      e,
    );
    const ext = extended.body.data as Record<string, unknown>;
    assert.equal(ext.deployment_name, "dep-1");
    assert.equal(ext.hardware_quantity, 4);
    assert.equal(ext.provider, "io.net");

    const deleted = await json(new Request("http://local/api/deployments/dep-1", { method: "DELETE", headers: auth }), e);
    assert.deepEqual(deleted.body.data, {
      status: "terminating",
      deployment_id: "dep-1",
      message: "Deployment termination requested successfully",
    });

    const logsMissing = await json(new Request("http://local/api/deployments/dep-1/logs", { headers: auth }), e);
    assert.equal(logsMissing.body.success, false);
    assert.equal(logsMissing.body.message, "container_id parameter is required");
    assert.equal("data" in logsMissing.body, false);

    const logs = await json(new Request("http://local/api/deployments/dep-1/logs?container_id=ctr-1", { headers: auth }), e);
    assert.equal(logs.body.success, true, String(logs.body.message));
    assert.equal(logs.body.data, "line-a\nline-b\n");
    assert.ok(seen.some((s) => s.url.includes("https://api.io.solutions/v1/io-cloud/caas/deployment/dep-1/log/ctr-1")));

    const containers = await json(new Request("http://local/api/deployments/dep-1/containers", { headers: auth }), e);
    const cl = containers.body.data as Record<string, unknown>;
    assert.equal(cl.total, 1);
    const ctrs = cl.containers as Record<string, unknown>[];
    assert.equal(ctrs[0].container_id, "ctr-1");
    assert.equal(ctrs[0].status, "running");
    assert.equal(ctrs[0].created_at, CREATED_UNIX);
    const events = ctrs[0].events as Record<string, unknown>[];
    assert.equal(events[0].message, "booted");
    assert.equal(events[0].time, CREATED_UNIX);

    const one = await json(new Request("http://local/api/deployments/dep-1/containers/ctr-1", { headers: auth }), e);
    const cd = one.body.data as Record<string, unknown>;
    assert.equal(cd.deployment_id, "dep-1");
    assert.equal(cd.container_id, "ctr-1");
    assert.equal(cd.public_url, "https://ctr.example");
    assert.ok(seen.some((s) => s.url.includes("/deployment/dep-1/container/ctr-1")));

    const testConn = await json(
      new Request("http://local/api/deployments/test-connection", { method: "POST", headers: auth, body: "{}" }),
      e,
    );
    assert.deepEqual(testConn.body.data, { hardware_count: 1, total_available: 3 });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original deployment getIoAPIKey and ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const list = await json(new Request("http://local/api/deployments/", { headers: auth }), e);
  assert.equal(list.res.status, 200);
  assert.equal(list.body.success, false);
  assert.equal(list.body.message, "io.net model deployment is not enabled or api key missing");
  assert.equal("data" in list.body, false);
  assert.deepEqual(Object.keys(list.body).sort(), ["message", "success"]);

  const hardware = await json(new Request("http://local/api/deployments/hardware-types", { headers: auth }), e);
  assert.equal(hardware.body.message, "io.net model deployment is not enabled or api key missing");
  assert.equal("data" in hardware.body, false);

  const badPayload = await json(
    new Request("http://local/api/deployments/test-connection", { method: "POST", headers: auth, body: "{" }),
    e,
  );
  assert.equal(badPayload.res.status, 200);
  assert.equal(badPayload.body.message, "invalid request payload");
  assert.equal("data" in badPayload.body, false);

  const noKey = await json(
    new Request("http://local/api/deployments/test-connection", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  assert.equal(noKey.body.message, "api_key is required");
  assert.equal("data" in noKey.body, false);
});
