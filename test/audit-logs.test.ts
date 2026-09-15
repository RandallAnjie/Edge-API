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

const PRIVILEGED_OTHER = JSON.stringify({
  op: { action: "generic" },
  admin_info: { admin_id: 1 },
  root_info: { private: "root-only" },
});

async function insertAudit(
  e: Env,
  row: {
    event_id: string;
    user_id: number;
    username: string;
    actor_role: number;
    created_at: number;
    category?: string;
    request_id?: string;
    success?: number;
    other?: string;
  },
) {
  await e.DB.prepare(
    `INSERT INTO audit_logs (event_id, user_id, username, actor_role, created_at, category, action, request_id, success, other)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.event_id,
      row.user_id,
      row.username,
      row.actor_role,
      row.created_at,
      row.category ?? "security",
      "generic",
      row.request_id ?? row.event_id,
      row.success ?? 0,
      row.other ?? PRIVILEGED_OTHER,
    )
    .run();
}

test("original GetAuditLogs self view strips admin_info and root_info JSON", async () => {
  const { e, auth, store } = await boot();
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "alice", password: "password12", role: 1 }),
    }),
    e,
  );
  const alice = await store.getUserByUsername("alice");
  const other = await store.getUserByUsername("root");
  assert.ok(alice && other);
  await insertAudit(e, {
    event_id: "self-alice",
    user_id: alice.id,
    username: "alice",
    actor_role: 10,
    created_at: 200,
  });
  await insertAudit(e, {
    event_id: "self-other",
    user_id: other.id,
    username: "root",
    actor_role: 10,
    created_at: 210,
  });
  const aliceAuth = await loginAs(e, "alice");
  const res = await json(
    new Request("http://local/api/audit/self?username=root&category=security&success=false&page_size=1", {
      headers: aliceAuth,
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
  const data = res.body.data as { total: number; items: { user_id: number; other: Record<string, unknown> }[] };
  assert.equal(data.total, 1, res.text);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].user_id, alice.id);
  assert.ok("op" in data.items[0].other, res.text);
  assert.equal("admin_info" in data.items[0].other, false);
  assert.equal("root_info" in data.items[0].other, false);
  assert.equal(res.text.includes("admin_info"), false);
  assert.equal(res.text.includes("root-only"), false);
});

test("original GetAuditLogs admin vs root other JSON and actor_role filter", async () => {
  const { e, auth, store } = await boot();
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "siteadmin", password: "password12", role: 10 }),
    }),
    e,
  );
  const admin = await store.getUserByUsername("siteadmin");
  const root = await store.getUserByUsername("root");
  assert.ok(admin && root);
  const roles = [1, 10, 100, 0, -1, 99];
  for (let i = 0; i < roles.length; i++) {
    await insertAudit(e, {
      event_id: `role-${roles[i]}`,
      user_id: admin.id,
      username: admin.username,
      actor_role: roles[i],
      created_at: 100 + i,
      request_id: `role-${roles[i]}`,
    });
  }
  await insertAudit(e, {
    event_id: "root-owned",
    user_id: root.id,
    username: root.username,
    actor_role: 100,
    created_at: 300,
    request_id: "root-owned",
  });
  const adminAuth = await loginAs(e, "siteadmin");
  const denied = await json(new Request("http://local/api/audit?category=security", { headers: adminAuth }), e);
  assert.equal(denied.res.status, 403);
  await store.setUserCasbinPolicies(admin.id, { audit: { read: true } });
  const adminList = await json(
    new Request("http://local/api/audit?category=security&page_size=1", { headers: adminAuth }),
    e,
  );
  assert.equal(adminList.body.success, true, String(adminList.body.message));
  const adminData = adminList.body.data as { total: number; items: { actor_role: number; other: Record<string, unknown> }[] };
  assert.equal(adminData.total, 2, adminList.text);
  assert.equal(adminData.items[0].actor_role, 10);
  assert.ok("admin_info" in adminData.items[0].other, adminList.text);
  assert.equal("root_info" in adminData.items[0].other, false);
  assert.equal(adminList.text.includes("root-only"), false);

  const adminSelf = await json(
    new Request("http://local/api/audit/self?category=security&page_size=1", { headers: adminAuth }),
    e,
  );
  const selfData = adminSelf.body.data as { total: number; items: { actor_role: number; other: Record<string, unknown> }[] };
  assert.equal(selfData.total, 2, adminSelf.text);
  assert.equal("admin_info" in selfData.items[0].other, false);
  assert.equal(adminSelf.text.includes("root-only"), false);

  const hidden = await json(
    new Request("http://local/api/audit?category=security&request_id=role-100", { headers: adminAuth }),
    e,
  );
  assert.equal((hidden.body.data as { total: number }).total, 0, hidden.text);

  const rootSelf = await json(new Request("http://local/api/audit/self?category=security", { headers: auth }), e);
  assert.equal(rootSelf.text.includes(`"actor_role":100`), true, rootSelf.text);
  assert.equal(rootSelf.text.includes("admin_info"), false, rootSelf.text);

  const rootAll = await json(new Request("http://local/api/audit?category=security", { headers: auth }), e);
  assert.equal((rootAll.body.data as { total: number }).total, 7, rootAll.text);
  assert.equal(rootAll.text.includes("root-only"), true, rootAll.text);
});

test("original GetAuditLogs rejects invalid pagination filters and time range JSON", async () => {
  const { e, auth } = await boot();
  for (const query of [
    "success=bad",
    "category=bad",
    "token_ref=secret",
    "start_timestamp=-1",
    "start_timestamp=2&end_timestamp=1",
    "p=-1",
    "page_size=-1",
  ]) {
    const res = await json(new Request("http://local/api/audit/self?" + query, { headers: auth }), e);
    assert.equal(res.body.success, false, query + " " + res.text);
  }
  const paginate = await json(new Request("http://local/api/audit/self?p=-1", { headers: auth }), e);
  assert.equal(paginate.body.message, "Invalid audit pagination");
  const time = await json(new Request("http://local/api/audit/self?start_timestamp=-1", { headers: auth }), e);
  assert.equal(time.body.message, "Invalid audit time range");
  const result = await json(new Request("http://local/api/audit/self?success=bad", { headers: auth }), e);
  assert.equal(result.body.message, "Invalid audit result");
  const filters = await json(new Request("http://local/api/audit/self?category=nope", { headers: auth }), e);
  assert.equal(filters.body.message, "Invalid audit filters");
});
