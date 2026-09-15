import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

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

test("original Model.Delete is a GORM soft delete that reuses the live unique name", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "soft-del-model", status: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const row = created.body.data as Record<string, unknown>;
  assert.equal("DeletedAt" in row, false, "Model.DeletedAt is json:\"-\"");
  const id = Number(row.id);
  const deleted = await json(new Request("http://local/api/models/" + id, { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.deepEqual(deleted.body.data, { deleted_count: 1, updated_channels: 0 });
  const got = await json(new Request("http://local/api/models/" + id, { headers: auth }), e);
  assert.equal(got.body.success, false);
  const listed = await json(new Request("http://local/api/models/", { headers: auth }), e);
  const items = ((listed.body.data as { items: { id: number }[] }).items || []);
  assert.equal(items.some((m) => m.id === id), false);
  const reused = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "soft-del-model", status: 1 }),
    }),
    e,
  );
  assert.equal(reused.body.success, true, String(reused.body.message));
  const reusedRow = reused.body.data as { id: number };
  assert.notEqual(reusedRow.id, id);
  const s = new Store(e.DB);
  await assert.rejects(() => s.insertModelMeta("soft-del-model"));
});

test("original Vendor.Delete is a GORM soft delete that reuses the live unique name", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "SoftDelVendor", icon: "OpenAI" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const row = created.body.data as Record<string, unknown>;
  assert.equal("DeletedAt" in row, false, "Vendor.DeletedAt is json:\"-\"");
  const id = Number(row.id);
  const deleted = await json(new Request("http://local/api/vendors/" + id, { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const got = await json(new Request("http://local/api/vendors/" + id, { headers: auth }), e);
  assert.equal(got.body.success, false);
  const listed = await json(new Request("http://local/api/vendors/", { headers: auth }), e);
  const items = ((listed.body.data as { items: { id: number }[] }).items || []);
  assert.equal(items.some((v) => v.id === id), false);
  const reused = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "SoftDelVendor", icon: "OpenAI" }),
    }),
    e,
  );
  assert.equal(reused.body.success, true, String(reused.body.message));
  assert.notEqual(Number((reused.body.data as { id: number }).id), id);
});

test("original PrefillGroup.Delete is a GORM soft delete that reuses the live unique name", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "soft-del-group", type: "model", items: ["gpt-4o"] }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const row = created.body.data as Record<string, unknown>;
  assert.equal("DeletedAt" in row, false, "PrefillGroup.DeletedAt is json:\"-\"");
  const id = Number(row.id);
  const deleted = await json(new Request("http://local/api/prefill_group/" + id, { method: "DELETE", headers: auth }), e);
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  const listed = await json(new Request("http://local/api/prefill_group/", { headers: auth }), e);
  const items = (listed.body.data as { id: number }[]) || [];
  assert.equal(items.some((g) => g.id === id), false);
  const reused = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "soft-del-group", type: "model", items: ["gpt-4o"] }),
    }),
    e,
  );
  assert.equal(reused.body.success, true, String(reused.body.message));
  assert.notEqual(Number((reused.body.data as { id: number }).id), id);
});
