import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.Vendor` JSON tags. `DeletedAt` is `json:"-"`. */
const ORIGINAL_VENDOR_JSON_FIELDS = [
  "model_count",
  "version",
  "id",
  "name",
  "description",
  "icon",
  "status",
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

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Independent of worker SHA-256: Go `encoding/json.Marshal` of ASCII strings matches JSON.stringify. */
function goVendorVersion(
  id: number,
  name: string,
  description: string,
  icon: string,
  status: number,
  created: number,
  updated: number,
): string {
  return sha256Hex(`[${id},${JSON.stringify(name)},${JSON.stringify(description)},${JSON.stringify(icon)},${status},${created},${updated}]`);
}

function assertVendorJson(row: Record<string, unknown>, label: string) {
  for (const k of ORIGINAL_VENDOR_JSON_FIELDS) {
    assert.ok(k in row, `${label} missing original Vendor field ${k}`);
  }
  assert.equal("DeletedAt" in row, false, `${label} DeletedAt is json:"-"`);
  assert.match(String(row.version), /^[0-9a-f]{64}$/, `${label} version must be SHA-256 hex`);
  assert.equal(typeof row.model_count, "number");
  assert.equal(typeof row.id, "number");
  assert.equal(typeof row.status, "number");
  assert.equal(typeof row.created_time, "number");
  assert.equal(typeof row.updated_time, "number");
}

async function createVendor(
  e: Env,
  auth: Record<string, string>,
  body: { name: string; description?: string; icon?: string },
) {
  const created = await json(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return created.body.data as Record<string, unknown>;
}

test("original Vendor JSON version is SHA-256 of encoding/json tuple", async () => {
  const { e, auth } = await boot();
  const vd = await createVendor(e, auth, { name: "OpenAI", icon: "OpenAI" });
  assertVendorJson(vd, "CreateVendor");
  assert.equal(
    vd.version,
    goVendorVersion(
      Number(vd.id),
      String(vd.name),
      String(vd.description),
      String(vd.icon),
      Number(vd.status),
      Number(vd.created_time),
      Number(vd.updated_time),
    ),
  );

  const got = await json(new Request("http://local/api/vendors/" + vd.id, { headers: auth }), e);
  assert.equal(got.body.success, true, String(got.body.message));
  const row = got.body.data as Record<string, unknown>;
  assertVendorJson(row, "GetVendor");
  assert.equal(row.version, vd.version);
  assert.equal(row.model_count, 0);
});

test("original VendorRecordVersion HTML-escapes & < > like encoding/json", async () => {
  const { e, auth } = await boot();
  const vd = await createVendor(e, auth, { name: "A&B<C>", description: "x>y&z" });
  const encoded = `[${vd.id},"A\\u0026B\\u003cC\\u003e","x\\u003ey\\u0026z","",${vd.status},${vd.created_time},${vd.updated_time}]`;
  assert.equal(vd.version, sha256Hex(encoded));
});

test("original SearchVendors orders by id DESC and matches description", async () => {
  const { e, auth } = await boot();
  const first = await createVendor(e, auth, { name: "Vendor Alpha", description: "unique-vendor-desc-token" });
  const second = await createVendor(e, auth, { name: "Vendor Beta", icon: "Beta" });
  assert.ok(Number(second.id) > Number(first.id));

  const listed = await json(new Request("http://local/api/vendors/?p=1&page_size=20", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const page = listed.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(page.page, 1);
  assert.ok(page.total >= 2);
  assertVendorJson(page.items[0], "GetAllVendors");
  const ids = page.items.map((v) => Number(v.id));
  assert.equal(ids[0], Number(second.id), "SearchVendors ORDER BY id DESC");
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1] >= ids[i]);

  const searched = await json(
    new Request("http://local/api/vendors/search?keyword=unique-vendor-desc-token&page_size=20", { headers: auth }),
    e,
  );
  assert.equal(searched.body.success, true, String(searched.body.message));
  const found = (searched.body.data as { items: Record<string, unknown>[] }).items;
  assert.equal(found.length, 1);
  assert.equal(found[0].id, first.id);
  assert.equal(found[0].name, "Vendor Alpha");
  assertVendorJson(found[0], "SearchVendors");
});

test("original SearchVendors association=linked|unlinked filters model assignments", async () => {
  const { e, auth } = await boot();
  const linked = await createVendor(e, auth, { name: "Linked Vendor" });
  const unlinked = await createVendor(e, auth, { name: "Unlinked Vendor" });
  const model = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "gpt-linked-test", vendor_id: linked.id, status: 1 }),
    }),
    e,
  );
  assert.equal(model.body.success, true, String(model.body.message));

  const linkedPage = await json(
    new Request("http://local/api/vendors/search?association=linked&page_size=20", { headers: auth }),
    e,
  );
  assert.equal(linkedPage.body.success, true, String(linkedPage.body.message));
  const linkedItems = (linkedPage.body.data as { items: Record<string, unknown>[] }).items;
  assert.ok(linkedItems.some((v) => v.id === linked.id));
  assert.equal(linkedItems.some((v) => v.id === unlinked.id), false);
  const linkedRow = linkedItems.find((v) => v.id === linked.id)!;
  assert.equal(linkedRow.model_count, 1);
  assertVendorJson(linkedRow, "SearchVendors linked");

  const unlinkedPage = await json(
    new Request("http://local/api/vendors/?association=unlinked&page_size=20", { headers: auth }),
    e,
  );
  assert.equal(unlinkedPage.body.success, true, String(unlinkedPage.body.message));
  const unlinkedItems = (unlinkedPage.body.data as { items: Record<string, unknown>[] }).items;
  assert.ok(unlinkedItems.some((v) => v.id === unlinked.id));
  assert.equal(unlinkedItems.some((v) => v.id === linked.id), false);
  assert.equal(unlinkedItems.find((v) => v.id === unlinked.id)?.model_count, 0);
});

test("original UpdateVendor rejects a stale VendorRecordVersion", async () => {
  const { e, auth } = await boot();
  const vd = await createVendor(e, auth, { name: "Versioned Vendor", description: "orig" });
  const conflict = await json(
    new Request("http://local/api/vendors/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: vd.id, name: "Versioned Vendor", description: "new", version: "deadbeef" }),
    }),
    e,
  );
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.success, false);
  assert.equal(conflict.body.code, "VENDOR_CONFLICT");
  assert.equal(conflict.body.message, "vendor data changed; preview again before applying");

  const updated = await json(
    new Request("http://local/api/vendors/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        id: vd.id,
        name: "Versioned Vendor",
        description: "new",
        version: vd.version,
      }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  const row = updated.body.data as Record<string, unknown>;
  assertVendorJson(row, "UpdateVendor");
  assert.equal(row.description, "new");
  assert.notEqual(row.version, vd.version);
  assert.equal(
    row.version,
    goVendorVersion(
      Number(row.id),
      String(row.name),
      String(row.description),
      String(row.icon),
      Number(row.status),
      Number(row.created_time),
      Number(row.updated_time),
    ),
  );
});
