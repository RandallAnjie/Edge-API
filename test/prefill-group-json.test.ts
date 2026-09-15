import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.PrefillGroup` JSON tags. `DeletedAt` is `json:"-"`. */
const ORIGINAL_PREFILL_JSON_FIELDS = [
  "id",
  "name",
  "type",
  "items",
  "description",
  "created_time",
  "updated_time",
] as const;

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
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
  return { e, auth };
}

test("original GetPrefillGroups JSON includes PrefillGroup fields and orders by updated_time DESC", async () => {
  const { e, auth } = await boot();
  const older = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "older-group", type: "model", items: ["gpt-4o"], description: "first" }),
    }),
    e,
  );
  assert.equal(older.body.success, true, String(older.body.message));
  const newer = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "newer-group", type: "tag", items: ["vision"], description: "second" }),
    }),
    e,
  );
  assert.equal(newer.body.success, true, String(newer.body.message));
  const created = newer.body.data as Record<string, unknown>;
  for (const k of ORIGINAL_PREFILL_JSON_FIELDS) {
    assert.ok(k in created, `CreatePrefillGroup missing original PrefillGroup field ${k}`);
  }
  assert.equal("DeletedAt" in created, false, "PrefillGroup.DeletedAt is json:\"-\"");
  assert.deepEqual(created.items, ["vision"]);

  const listed = await json(new Request("http://local/api/prefill_group/", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const groups = listed.body.data as Record<string, unknown>[];
  assert.ok(Array.isArray(groups));
  assert.equal(groups[0].name, "newer-group");
  assert.ok(Number(groups[0].updated_time) >= Number(groups[1].updated_time));
  for (const k of ORIGINAL_PREFILL_JSON_FIELDS) {
    assert.ok(k in groups[0], `GetPrefillGroups missing original PrefillGroup field ${k}`);
  }

  const filtered = await json(new Request("http://local/api/prefill_group/?type=model", { headers: auth }), e);
  const models = filtered.body.data as Record<string, unknown>[];
  assert.equal(models.every((g) => g.type === "model"), true);
  assert.equal(models.some((g) => g.name === "older-group"), true);
  assert.equal(models.some((g) => g.name === "newer-group"), false);
});

test("original UpdatePrefillGroup JSON uses GORM Save and returns PrefillGroup fields", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "editable", type: "model", items: ["gpt-4o"], description: "keep-me" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const id = Number((created.body.data as { id: number }).id);
  const createdTime = Number((created.body.data as { created_time: number }).created_time);
  assert.ok(createdTime > 0);

  const missingId = await json(
    new Request("http://local/api/prefill_group/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "no-id" }),
    }),
    e,
  );
  assert.equal(missingId.body.success, false);
  assert.equal(missingId.body.message, "缺少组 ID");

  const saved = await json(
    new Request("http://local/api/prefill_group/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        id,
        name: "editable-renamed",
        type: "tag",
        items: ["vision", "audio"],
        description: "updated",
        created_time: createdTime,
      }),
    }),
    e,
  );
  assert.equal(saved.body.success, true, String(saved.body.message));
  const row = saved.body.data as Record<string, unknown>;
  for (const k of ORIGINAL_PREFILL_JSON_FIELDS) {
    assert.ok(k in row, `UpdatePrefillGroup missing original PrefillGroup field ${k}`);
  }
  assert.equal(row.name, "editable-renamed");
  assert.equal(row.type, "tag");
  assert.deepEqual(row.items, ["vision", "audio"]);
  assert.equal(row.description, "updated");
  assert.equal(row.created_time, createdTime);
  assert.ok(Number(row.updated_time) >= createdTime);

  const zeroed = await json(
    new Request("http://local/api/prefill_group/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id, name: "editable-renamed" }),
    }),
    e,
  );
  assert.equal(zeroed.body.success, true, String(zeroed.body.message));
  const wiped = zeroed.body.data as Record<string, unknown>;
  assert.equal(wiped.type, "");
  assert.equal(wiped.items, null);
  assert.equal(wiped.description, "");
  assert.equal(wiped.created_time, 0);
});

test("original CreatePrefillGroup rejects empty name/type and duplicate names", async () => {
  const { e, auth } = await boot();
  const empty = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "", type: "model" }),
    }),
    e,
  );
  assert.equal(empty.body.success, false);
  assert.equal(empty.body.message, "组名称和类型不能为空");
  const created = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "dup-group", type: "model", items: ["a"] }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const dup = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "dup-group", type: "tag", items: ["b"] }),
    }),
    e,
  );
  assert.equal(dup.body.success, false);
  assert.equal(dup.body.message, "组名称已存在");
});
