import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  metadataRecordVersion,
  metadataSyncCatalogVersion,
} from "../src/dto.js";
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

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

test("original MetadataRecordVersion of nil pointers is SHA-256 of [null,null,null]", () => {
  assert.equal(metadataRecordVersion(null, null, null), sha256Hex("[null,null,null]"));
});

test("original fetchMetadataCatalog source.Version sorts map keys like encoding/json", () => {
  const models = {
    zeta: { description: "", icon: "", tags: "", vendor: "Z", endpoints: "", name_rule: 0, status: 1 },
    alpha: { description: "A", icon: "", tags: "", vendor: "A", endpoints: "", name_rule: 0, status: 1 },
  };
  const vendors = {
    Zeta: { name: "Zeta", description: "", icon: "", status: 0, id: 0, created_time: 0, updated_time: 0 },
    Alpha: { name: "Alpha", icon: "A", status: 1, id: 0, created_time: 0, updated_time: 0 },
  };
  const modelJson =
    '{"alpha":{"description":"A","icon":"","tags":"","vendor":"A","endpoints":"","name_rule":0,"status":1},"zeta":{"description":"","icon":"","tags":"","vendor":"Z","endpoints":"","name_rule":0,"status":1}}';
  const vendorJson =
    '{"Alpha":{"model_count":0,"id":0,"name":"Alpha","icon":"A","status":1,"created_time":0,"updated_time":0},"Zeta":{"model_count":0,"id":0,"name":"Zeta","status":0,"created_time":0,"updated_time":0}}';
  const encoded = `["zh",${modelJson},${vendorJson}]`;
  assert.equal(metadataSyncCatalogVersion("zh", models, vendors), sha256Hex(encoded));
});

test("original MetadataRecordVersion hashes Find-shaped Model and Vendor JSON", async () => {
  const { e, auth } = await boot();
  const vendor = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "OpenAI", icon: "OpenAI" }),
    }),
    e,
  );
  assert.equal(vendor.body.success, true, String(vendor.body.message));
  const vd = vendor.body.data as { id: number };
  const created = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "gpt-sync-test", vendor_id: vd.id, status: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const s = new Store(e.DB);
  const local = ((await s.listModelMeta()) as Record<string, unknown>[]).find((m) => m.model_name === "gpt-sync-test");
  const localVendor = await s.getVendor(vd.id);
  assert.ok(local);
  assert.ok(localVendor);
  const modelJson = `{"id":${local.id},"model_name":"gpt-sync-test","vendor_id":${vd.id},"status":${local.status},"sync_official":${local.sync_official},"created_time":${local.created_time},"updated_time":${local.updated_time},"name_rule":0,"has_metadata":false,"configured_channel_count":0,"square_state":""}`;
  const vendorJson = `{"model_count":0,"id":${localVendor.id},"name":"OpenAI","icon":"OpenAI","status":${localVendor.status},"created_time":${localVendor.created_time},"updated_time":${localVendor.updated_time}}`;
  assert.equal(metadataRecordVersion(local, localVendor, localVendor), sha256Hex(`[${modelJson},${vendorJson},${vendorJson}]`));
  assert.match(metadataRecordVersion(local, localVendor, null), /^[0-9a-f]{64}$/);
});
