import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { formatLogOtherJSON } from "../src/dto.js";
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
  return { e, auth, store: new Store(e.DB) };
}

async function loginAs(e: Env, username: string) {
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "password12" }),
    }),
    e,
  );
  assert.equal(login.body.success, true, String(login.body.message));
  return {
    authorization: "Bearer " + (login.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
}

function parseOther(raw: unknown): Record<string, unknown> {
  assert.equal(typeof raw, "string", "original Log.other is a JSON string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

test("original formatLogOtherJSON role projection and legacy reject_reason", () => {
  const other = JSON.stringify({
    request_path: "/v1/chat/completions",
    channel_id: 202,
    channel_name: "legacy-secret-channel",
    channel_type: 1,
    reject_reason: "legacy-policy-rejection",
    admin_info: { existing_admin_field: "preserved" },
    root_info: { upstream_request_id: "upstream-private" },
    audit_info: { method: "POST" },
  });

  const user = JSON.parse(formatLogOtherJSON(other, "user")) as Record<string, unknown>;
  assert.equal(user.request_path, "/v1/chat/completions");
  for (const key of [
    "channel_id",
    "channel_name",
    "channel_type",
    "reject_reason",
    "admin_info",
    "root_info",
    "audit_info",
  ]) {
    assert.equal(key in user, false, "user still has " + key);
  }

  const admin = JSON.parse(formatLogOtherJSON(other, "admin")) as Record<string, unknown>;
  assert.equal(admin.channel_name, "legacy-secret-channel");
  assert.equal("reject_reason" in admin, false);
  assert.equal("root_info" in admin, false);
  assert.equal("audit_info" in admin, true);
  const adminInfo = admin.admin_info as Record<string, unknown>;
  assert.equal(adminInfo.existing_admin_field, "preserved");
  assert.equal(adminInfo.reject_reason, "legacy-policy-rejection");

  const root = JSON.parse(formatLogOtherJSON(other, "root")) as Record<string, unknown>;
  assert.equal(root.channel_name, "legacy-secret-channel");
  assert.equal("reject_reason" in root, false);
  assert.equal("root_info" in root, true);
  assert.equal("audit_info" in root, true);
  const rootAdmin = root.admin_info as Record<string, unknown>;
  assert.equal(rootAdmin.existing_admin_field, "preserved");
  assert.equal(rootAdmin.reject_reason, "legacy-policy-rejection");

  const scoped = formatLogOtherJSON(
    JSON.stringify({
      reject_reason: "legacy-value",
      admin_info: { reject_reason: "scoped-value" },
    }),
    "root",
  );
  const scopedParsed = JSON.parse(scoped) as Record<string, unknown>;
  assert.equal("reject_reason" in scopedParsed, false);
  assert.equal((scopedParsed.admin_info as Record<string, unknown>).reject_reason, "scoped-value");

  const nullAdmin = JSON.parse(formatLogOtherJSON(`{"reject_reason":"legacy-value","admin_info":null}`, "admin")) as Record<
    string,
    unknown
  >;
  assert.equal("reject_reason" in nullAdmin, false);
  assert.equal((nullAdmin.admin_info as Record<string, unknown>).reject_reason, "legacy-value");
});

test("original formatLogOtherJSON preserves large integer lexemes", () => {
  const other =
    '{"public_id":9007199254740993,"admin_info":{"admin_id":9007199254740995},"root_info":{"generation":18446744073709551615}}';

  const user = formatLogOtherJSON(other, "user");
  assert.match(user, /"public_id":9007199254740993/);
  assert.equal(user.includes("admin_id"), false);
  assert.equal(user.includes("generation"), false);

  const admin = formatLogOtherJSON(other, "admin");
  assert.match(admin, /"public_id":9007199254740993/);
  assert.match(admin, /"admin_id":9007199254740995/);
  assert.equal(admin.includes("generation"), false);

  assert.equal(formatLogOtherJSON(other, "root"), other);

  const unprivileged = '{"public_id":9007199254740993,"model_price":0.004}';
  assert.equal(formatLogOtherJSON(unprivileged, "user"), unprivileged);
  assert.equal(formatLogOtherJSON(unprivileged, "admin"), unprivileged);
});

test("original GetAllLogs / GetUserLogs other JSON fields", async () => {
  const { e, auth, store } = await boot();
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "alice", password: "password12", role: 1 }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "siteadmin", password: "password12", role: 10 }),
    }),
    e,
  );
  const alice = await store.getUserByUsername("alice");
  const admin = await store.getUserByUsername("siteadmin");
  assert.ok(alice && admin);

  const other = JSON.stringify({
    request_path: "/v1/chat/completions",
    model_price: 0.004,
    channel_id: 202,
    channel_name: "legacy-secret-channel",
    channel_type: 1,
    reject_reason: "legacy-policy-rejection",
    admin_info: {
      existing_admin_field: "preserved",
      quota_saturation: { op: "QuotaFromDecimal", kind: "overflow" },
      task_plugin: { key: "document-parser", name: "Document Parser", version: "1.2.3" },
    },
    root_info: { upstream_task_id: "upstream-private", generation: 42 },
    audit_info: { method: "POST" },
  });
  await store.insertLog({
    user_id: alice.id,
    username: "alice",
    type: 2,
    content: "consume",
    channel_id: 77,
    other,
  });

  const rootLogs = await json(new Request("http://local/api/log/", { headers: auth }), e);
  assert.equal(rootLogs.body.success, true, String(rootLogs.body.message));
  const rootItems = (rootLogs.body.data as { items: Record<string, unknown>[] }).items;
  assert.equal(rootItems.length, 1);
  const rootOther = parseOther(rootItems[0].other);
  assert.equal(rootItems[0].channel, 77);
  assert.equal("reject_reason" in rootOther, false);
  assert.equal("root_info" in rootOther, true);
  assert.equal("audit_info" in rootOther, true);
  assert.equal((rootOther.admin_info as Record<string, unknown>).reject_reason, "legacy-policy-rejection");
  assert.equal((rootOther.admin_info as Record<string, unknown>).existing_admin_field, "preserved");
  assert.equal(rootOther.channel_name, "legacy-secret-channel");

  const adminAuth = await loginAs(e, "siteadmin");
  const adminLogs = await json(new Request("http://local/api/log/", { headers: adminAuth }), e);
  assert.equal(adminLogs.body.success, true, String(adminLogs.body.message));
  const adminItems = (adminLogs.body.data as { items: Record<string, unknown>[] }).items;
  const adminOther = parseOther(adminItems[0].other);
  assert.equal("reject_reason" in adminOther, false);
  assert.equal("root_info" in adminOther, false);
  assert.equal("audit_info" in adminOther, true);
  assert.equal((adminOther.admin_info as Record<string, unknown>).reject_reason, "legacy-policy-rejection");
  assert.equal((adminOther.admin_info as Record<string, unknown>).existing_admin_field, "preserved");
  assert.equal(adminLogs.text.includes("upstream-private"), false);

  const aliceAuth = await loginAs(e, "alice");
  const selfLogs = await json(new Request("http://local/api/log/self", { headers: aliceAuth }), e);
  assert.equal(selfLogs.body.success, true, String(selfLogs.body.message));
  const selfItems = (selfLogs.body.data as { items: Record<string, unknown>[] }).items;
  assert.equal(selfItems.length, 1);
  assert.equal(selfItems[0].id, 1);
  assert.equal(selfItems[0].channel_name, "");
  assert.equal(selfItems[0].channel, 77);
  const selfOther = parseOther(selfItems[0].other);
  assert.equal(selfOther.request_path, "/v1/chat/completions");
  assert.equal(selfOther.model_price, 0.004);
  for (const key of [
    "channel_id",
    "channel_name",
    "channel_type",
    "reject_reason",
    "admin_info",
    "root_info",
    "audit_info",
  ]) {
    assert.equal(key in selfOther, false, "self other still has " + key);
  }
  assert.equal(selfLogs.text.includes("admin_info"), false);
  assert.equal(selfLogs.text.includes("legacy-secret-channel"), false);
  assert.equal(selfLogs.text.includes("upstream-private"), false);

  const rootSelf = await json(new Request("http://local/api/log/self", { headers: auth }), e);
  const rootSelfItems = (rootSelf.body.data as { items: Record<string, unknown>[] }).items;
  assert.equal(rootSelfItems.length, 0, "root self logs must not include alice rows");
});
