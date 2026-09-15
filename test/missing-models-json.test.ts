import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
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
  return { token, auth, login };
}

async function insertAbility(
  e: Env,
  group: string,
  model: string,
  channelId: number,
  enabled: number,
): Promise<void> {
  await e.DB.prepare(
    `INSERT INTO abilities ("group", model, channel_id, enabled, priority, weight, tag) VALUES (?, ?, ?, ?, 0, 0, '')`,
  )
    .bind(group, model, channelId, enabled)
    .run();
}

test("original GetMissingModels JSON: empty enabled is [], none missing is null", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);

  await e.DB.prepare("DELETE FROM abilities").run();

  const empty = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.equal(empty.body.success, true);
  assert.deepEqual(empty.body.data, []);
  assert.ok(Array.isArray(empty.body.data));
  assert.equal(JSON.parse(empty.text).data.length, 0);

  await insertAbility(e, "default", "zz-missing-a", 1, 1);
  await insertAbility(e, "default", "zz-missing-b", 1, 1);
  await insertAbility(e, "default", "zz-disabled-meta", 1, 0);

  const someMissing = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.equal(someMissing.body.success, true);
  const some = someMissing.body.data as string[];
  assert.ok(Array.isArray(some));
  assert.equal(some.includes("zz-missing-a"), true);
  assert.equal(some.includes("zz-missing-b"), true);
  assert.equal(some.includes("zz-disabled-meta"), false);

  await store.insertModelMeta("zz-missing-a");
  const stillMissing = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.deepEqual(stillMissing.body.data, ["zz-missing-b"]);

  await store.insertModelMeta("zz-missing-b");
  const noneMissing = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.equal(noneMissing.body.success, true);
  assert.equal(noneMissing.body.data, null);
  assert.equal(JSON.parse(noneMissing.text).data, null);

  await e.DB.prepare("UPDATE model_meta SET deleted_at = 1 WHERE model_name = ?").bind("zz-missing-b").run();
  const afterSoftDelete = await json(new Request("http://local/api/models/missing", { headers: auth }), e);
  assert.deepEqual(afterSoftDelete.body.data, ["zz-missing-b"]);
});
