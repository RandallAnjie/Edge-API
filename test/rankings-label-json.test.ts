import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { rankingBucketLabel, rankingBucketTs } from "../src/rankings.js";
import { resetSchemaFlag } from "../src/schema.js";
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
}

test("original rankingBucketLabel uses Go Jan 2 and 15:04 local Format", () => {
  // 2024-01-05 00:00:00 UTC — Go Format("Jan 2") is "Jan 5" (not space-padded "_2").
  const jan5 = 1704412800;
  const jan15 = 1705276800;
  const jan1 = 1704067200;
  const oneThirty = jan5 + 90 * 60;

  assert.equal(rankingBucketTs(jan5), "2024-01-05T00:00:00Z");
  assert.equal(rankingBucketTs(oneThirty), "2024-01-05T01:30:00Z");

  const jan5Local = new Date(jan5 * 1000);
  const jan1Local = new Date(jan1 * 1000);
  const jan15Local = new Date(jan15 * 1000);
  const oneThirtyLocal = new Date(oneThirty * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  assert.equal(rankingBucketLabel(jan5, "Jan 2"), `${months[jan5Local.getMonth()]} ${jan5Local.getDate()}`);
  assert.equal(rankingBucketLabel(jan1, "Jan 2"), `${months[jan1Local.getMonth()]} ${jan1Local.getDate()}`);
  assert.equal(rankingBucketLabel(jan15, "Jan 2"), `${months[jan15Local.getMonth()]} ${jan15Local.getDate()}`);
  assert.equal(
    rankingBucketLabel(oneThirty, "15:04"),
    `${String(oneThirtyLocal.getHours()).padStart(2, "0")}:${String(oneThirtyLocal.getMinutes()).padStart(2, "0")}`,
  );

  if (jan5Local.getTimezoneOffset() === 0) {
    assert.equal(rankingBucketLabel(jan5, "Jan 2"), "Jan 5");
    assert.notEqual(rankingBucketLabel(jan5, "Jan 2"), "Jan  5");
    assert.equal(rankingBucketLabel(jan1, "Jan 2"), "Jan 1");
    assert.equal(rankingBucketLabel(jan15, "Jan 2"), "Jan 15");
    assert.equal(rankingBucketLabel(jan5, "15:04"), "00:00");
    assert.equal(rankingBucketLabel(oneThirty, "15:04"), "01:30");
  }
});

test("original GetRankings history labels use rankingBucketLabel JSON", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const now = Math.floor(Date.now() / 1000);
  const created = now - 1800;
  await e.DB.prepare(
    "INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name) VALUES (1, 'root', 'gpt-4o-mini', ?, 10, 100, 1, 'default', 1, 1, 'workerd')",
  )
    .bind(created)
    .run();

  const week = await json(new Request("http://local/api/rankings?period=week"), e);
  assert.equal(week.res.status, 200);
  assert.equal(week.body.success, true);
  const weekData = week.body.data as { models_history: { points: { ts: string; label: string }[] } };
  const weekPoint = weekData.models_history.points[0];
  assert.ok(weekPoint);
  const weekBucket = Math.trunc(created / 86400) * 86400;
  assert.equal(weekPoint.ts, rankingBucketTs(weekBucket));
  assert.equal(weekPoint.label, rankingBucketLabel(weekBucket, "Jan 2"));

  const today = await json(new Request("http://local/api/rankings?period=today"), e);
  const todayData = today.body.data as { models_history: { points: { ts: string; label: string }[] } };
  const todayPoint = todayData.models_history.points[0];
  assert.ok(todayPoint);
  const hourBucket = Math.trunc(created / 3600) * 3600;
  assert.equal(todayPoint.ts, rankingBucketTs(hourBucket));
  assert.equal(todayPoint.label, rankingBucketLabel(hourBucket, "15:04"));
});
