import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { parseHeaderNavAccess } from "../src/header-nav.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
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

async function setNav(e: Env, raw: string) {
  await new Store(e.DB).setOption("HeaderNavModules", raw);
}

test("original parseHeaderNavAccess accepts bool string number and object", () => {
  const fallback = { enabled: true, requireAuth: false };
  assert.deepEqual(parseHeaderNavAccess(false, fallback), { enabled: false, requireAuth: false });
  assert.deepEqual(parseHeaderNavAccess("false", fallback), { enabled: false, requireAuth: false });
  assert.deepEqual(parseHeaderNavAccess("0", fallback), { enabled: false, requireAuth: false });
  assert.deepEqual(parseHeaderNavAccess(0, fallback), { enabled: false, requireAuth: false });
  assert.deepEqual(parseHeaderNavAccess(true, fallback), { enabled: true, requireAuth: false });
  assert.deepEqual(parseHeaderNavAccess("true", fallback), { enabled: true, requireAuth: false });
  assert.deepEqual(parseHeaderNavAccess(1, fallback), { enabled: true, requireAuth: false });
  assert.deepEqual(
    parseHeaderNavAccess({ enabled: false, requireAuth: true }, fallback),
    { enabled: false, requireAuth: true },
  );
  assert.deepEqual(parseHeaderNavAccess({ requireAuth: "1" }, fallback), { enabled: true, requireAuth: true });
  assert.deepEqual(parseHeaderNavAccess(undefined, fallback), fallback);
  assert.deepEqual(parseHeaderNavAccess(null, fallback), fallback);
  assert.deepEqual(parseHeaderNavAccess([], fallback), fallback);
});

test("original HeaderNavModuleAuth JSON on rankings and pricing", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const ranks = await json(new Request("http://local/api/rankings"), e);
  assert.equal(ranks.res.status, 200);
  assert.equal(ranks.body.success, true);
  assert.equal("message" in ranks.body, false);
  assert.deepEqual(Object.keys(ranks.body).sort(), ["data", "success"]);

  const pricing = await json(new Request("http://local/api/pricing"), e);
  assert.equal(pricing.res.status, 200);
  assert.equal(pricing.body.success, true);
  assert.equal("message" in pricing.body, false);
  assert.deepEqual(Object.keys(pricing.body).sort(), [
    "auto_groups",
    "data",
    "group_ratio",
    "pricing_version",
    "success",
    "supported_endpoint",
    "usable_group",
    "vendors",
  ]);

  await setNav(e, JSON.stringify({ rankings: { enabled: false, requireAuth: false } }));
  const disabledRanks = await json(new Request("http://local/api/rankings"), e);
  assert.equal(disabledRanks.res.status, 403);
  assert.equal(disabledRanks.body.success, false);
  assert.equal(disabledRanks.body.message, "rankings is disabled");
  assert.equal("data" in disabledRanks.body, false);
  assert.equal("code" in disabledRanks.body, false);

  await setNav(e, JSON.stringify({ pricing: { enabled: false, requireAuth: false } }));
  const disabledPricing = await json(new Request("http://local/api/pricing"), e);
  assert.equal(disabledPricing.res.status, 403);
  assert.equal(disabledPricing.body.success, false);
  assert.equal(disabledPricing.body.message, "pricing is disabled");
  assert.equal("data" in disabledPricing.body, false);

  await setNav(e, JSON.stringify({ rankings: { enabled: true, requireAuth: true } }));
  const ranksNeedAuth = await json(new Request("http://local/api/rankings"), e);
  assert.equal(ranksNeedAuth.res.status, 401);
  assert.equal(ranksNeedAuth.body.success, false);
  assert.equal(ranksNeedAuth.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(ranksNeedAuth.body.message, "Unauthorized");

  const ranksAuthed = await json(new Request("http://local/api/rankings", { headers: auth }), e);
  assert.equal(ranksAuthed.res.status, 200);
  assert.equal(ranksAuthed.body.success, true);
  assert.equal("message" in ranksAuthed.body, false);

  await setNav(e, JSON.stringify({ pricing: { enabled: true, requireAuth: true } }));
  const pricingNeedAuth = await json(new Request("http://local/api/pricing"), e);
  assert.equal(pricingNeedAuth.res.status, 401);
  assert.equal(pricingNeedAuth.body.code, "AUTH_UNAUTHORIZED");

  const pricingAuthed = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  assert.equal(pricingAuthed.res.status, 200);
  assert.equal(pricingAuthed.body.success, true);
  assert.equal("message" in pricingAuthed.body, false);

  await setNav(e, JSON.stringify({ rankings: false }));
  const legacyRanks = await json(new Request("http://local/api/rankings"), e);
  assert.equal(legacyRanks.res.status, 403);
  assert.equal(legacyRanks.body.message, "rankings is disabled");
  assert.equal("data" in legacyRanks.body, false);
});

test("original HeaderNavModulePublicOrUserAuth JSON on perf-metrics", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const missing = await json(new Request("http://local/api/perf-metrics"), e);
  assert.equal(missing.res.status, 400);
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "model is required");
  assert.equal("data" in missing.body, false);

  const summary = await json(new Request("http://local/api/perf-metrics/summary"), e);
  assert.equal(summary.res.status, 200);
  assert.equal(summary.body.success, true);
  assert.equal("message" in summary.body, false);
  assert.deepEqual(Object.keys(summary.body).sort(), ["data", "success"]);

  await setNav(e, JSON.stringify({ pricing: { enabled: false, requireAuth: false } }));
  const disabled = await json(new Request("http://local/api/perf-metrics?model=gpt-4o-mini"), e);
  assert.equal(disabled.res.status, 401);
  assert.equal(disabled.body.success, false);
  assert.equal(disabled.body.code, "AUTH_UNAUTHORIZED");
  assert.notEqual(disabled.res.status, 403);

  const disabledSummary = await json(new Request("http://local/api/perf-metrics/summary"), e);
  assert.equal(disabledSummary.res.status, 401);
  assert.equal(disabledSummary.body.code, "AUTH_UNAUTHORIZED");

  const loggedIn = await json(new Request("http://local/api/perf-metrics?model=gpt-4o-mini", { headers: auth }), e);
  assert.equal(loggedIn.res.status, 200);
  assert.equal(loggedIn.body.success, true);
  assert.equal("message" in loggedIn.body, false);

  await setNav(e, JSON.stringify({ pricing: { enabled: true, requireAuth: true } }));
  const requireAuth = await json(new Request("http://local/api/perf-metrics/summary"), e);
  assert.equal(requireAuth.res.status, 401);
  assert.equal(requireAuth.body.code, "AUTH_UNAUTHORIZED");

  const requireAuthOk = await json(new Request("http://local/api/perf-metrics/summary", { headers: auth }), e);
  assert.equal(requireAuthOk.res.status, 200);
  assert.equal(requireAuthOk.body.success, true);

  await setNav(e, JSON.stringify({ pricing: false }));
  const legacy = await json(new Request("http://local/api/perf-metrics?model=gpt-4o-mini"), e);
  assert.equal(legacy.res.status, 401);
  assert.equal(legacy.body.code, "AUTH_UNAUTHORIZED");
});

test("original GetRankings uses Unknown vendor and omits data on invalid period", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const now = Math.floor(Date.now() / 1000);
  await e.DB.prepare(
    "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (1, 'root', 'openai/gpt-4o', ?, 10, 100, 1, 'default', 1, 1, 'workerd')",
  )
    .bind(now - 3600)
    .run();

  const ranked = await json(new Request("http://local/api/rankings?period=week"), e);
  assert.equal(ranked.res.status, 200);
  assert.equal(ranked.body.success, true);
  assert.equal("message" in ranked.body, false);
  const data = ranked.body.data as {
    models: { model_name: string; vendor: string }[];
    vendors: { vendor: string }[];
    models_history: { points: { vendor: string; model: string }[] };
  };
  const slash = data.models.find((m) => m.model_name === "openai/gpt-4o");
  assert.ok(slash);
  assert.equal(slash.vendor, "Unknown");
  assert.equal(data.vendors.some((v) => v.vendor === "openai"), false);
  assert.equal(data.vendors.some((v) => v.vendor === "Unknown"), true);
  const hist = data.models_history.points.find((p) => p.model === "openai/gpt-4o");
  if (hist) assert.equal(hist.vendor, "Unknown");

  const bad = await json(new Request("http://local/api/rankings?period=decade"), e);
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.success, false);
  assert.equal(bad.body.message, "invalid ranking period: decade");
  assert.equal("data" in bad.body, false);
});
