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

async function createUser(e: Env, auth: Record<string, string>, username: string, role = 1) {
  const res = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username, password: "password12", role }),
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
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

async function insertQuota(
  e: Env,
  row: {
    user_id: number;
    username: string;
    model_name: string;
    created_at: number;
    quota: number;
    token_used: number;
    count: number;
    use_group?: string;
    token_id?: number;
    channel_id?: number;
    node_name?: string;
  },
) {
  await e.DB.prepare(
    `INSERT INTO quota_data (user_id, username, model_name, created_at, quota, token_used, count, use_group, token_id, channel_id, node_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.user_id,
      row.username,
      row.model_name,
      row.created_at,
      row.quota,
      row.token_used,
      row.count,
      row.use_group ?? "",
      row.token_id ?? 0,
      row.channel_id ?? 0,
      row.node_name ?? "",
    )
    .run();
}

type FlowRow = {
  user_id?: number;
  username?: string;
  node_name?: string;
  token_id?: number;
  token_name?: string;
  use_group?: string;
  channel_id?: number;
  channel_name?: string;
  model_name?: string;
  token_used?: number;
  count?: number;
  quota?: number;
};

async function seedOriginalFlow(e: Env, store: Store, auth: Record<string, string>) {
  await createUser(e, auth, "alice");
  await createUser(e, auth, "bob");
  await createUser(e, auth, "admin1", 10);
  const alice = await store.getUserByUsername("alice");
  const bob = await store.getUserByUsername("bob");
  assert.ok(alice && bob);
  const east = await store.insertChannel({ name: "east", type: 1, key: "east-key" });
  const west = await store.insertChannel({ name: "west", type: 1, key: "west-key" });
  const primaryId = await store.insertToken({ user_id: alice.id, key: "sk-primary", name: "primary" });
  const backupId = await store.insertToken({ user_id: bob.id, key: "sk-backup", name: "backup" });
  await store.deleteToken(primaryId, alice.id);
  await insertQuota(e, {
    user_id: alice.id,
    username: "alice",
    node_name: "node-a",
    token_id: primaryId,
    use_group: "vip",
    model_name: "gpt-a",
    channel_id: east,
    created_at: 1000,
    count: 2,
    quota: 100,
    token_used: 40,
  });
  await insertQuota(e, {
    user_id: alice.id,
    username: "alice",
    node_name: "node-a",
    token_id: primaryId,
    use_group: "vip",
    model_name: "gpt-a",
    channel_id: east,
    created_at: 1100,
    count: 1,
    quota: 50,
    token_used: 20,
  });
  await insertQuota(e, {
    user_id: alice.id,
    username: "alice",
    node_name: "node-a",
    token_id: primaryId,
    use_group: "vip",
    model_name: "gpt-a",
    channel_id: west,
    created_at: 1200,
    count: 1,
    quota: 25,
    token_used: 10,
  });
  await insertQuota(e, {
    user_id: bob.id,
    username: "bob",
    node_name: "node-b",
    token_id: backupId,
    use_group: "default",
    model_name: "gpt-b",
    channel_id: east,
    created_at: 1300,
    count: 3,
    quota: 70,
    token_used: 30,
  });
  await insertQuota(e, {
    user_id: alice.id,
    username: "alice",
    model_name: "legacy",
    created_at: 1400,
    count: 99,
    quota: 999,
    token_used: 999,
  });
  return { alice, bob, east, west, primaryId, backupId };
}

function flowRows(body: Record<string, unknown>): FlowRow[] {
  assert.equal(body.success, true, String(body.message));
  assert.ok(Array.isArray(body.data));
  return body.data as FlowRow[];
}

test("original GetAllFlowQuotaDates root dimensions JSON", async () => {
  const { e, auth, store } = await boot();
  const { alice, primaryId, backupId } = await seedOriginalFlow(e, store, auth);
  const res = await json(
    new Request("http://local/api/data/flow?start_timestamp=900&end_timestamp=2000&username=alice", { headers: auth }),
    e,
  );
  const rows = flowRows(res.body);
  assert.equal(rows.length, 2, res.text);
  assert.equal(rows[0].username, "alice");
  assert.equal(rows[0].user_id, alice.id);
  assert.equal(rows[0].node_name, "node-a");
  assert.equal(rows[0].token_id, primaryId);
  assert.equal(rows[0].token_name, undefined, "deleted tokens must not fabricate token-N");
  assert.equal(rows[0].use_group, "vip");
  assert.equal(rows[0].channel_name, "east");
  assert.equal(rows[0].model_name, "gpt-a");
  assert.equal(rows[0].token_used, 60);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].quota, 150);
  assert.notEqual(rows[0].token_name, `token-${primaryId}`);

  const all = await json(
    new Request("http://local/api/data/flow?start_timestamp=900&end_timestamp=2000", { headers: auth }),
    e,
  );
  const allRows = flowRows(all.body);
  assert.equal(allRows.length, 3, all.text);
  const backup = allRows.find((r) => r.token_id === backupId);
  assert.ok(backup, all.text);
  assert.equal(backup.token_name, "backup");
  assert.equal(backup.username, "bob");
  assert.equal(backup.node_name, "node-b");
  assert.equal(backup.channel_name, "east");
});

test("original GetAllFlowQuotaDates admin dimensions JSON", async () => {
  const { e, auth, store } = await boot();
  await seedOriginalFlow(e, store, auth);
  const adminAuth = await loginAs(e, "admin1");
  const res = await json(
    new Request("http://local/api/data/flow?start_timestamp=900&end_timestamp=2000&username=bob", {
      headers: adminAuth,
    }),
    e,
  );
  const rows = flowRows(res.body);
  assert.equal(rows.length, 1, res.text);
  assert.equal(rows[0].username, "bob");
  assert.equal(rows[0].use_group, "default");
  assert.equal(rows[0].channel_name, "east");
  assert.equal(rows[0].model_name, "gpt-b");
  assert.equal(rows[0].quota, 70);
  assert.equal(rows[0].token_id, undefined);
  assert.equal(rows[0].token_name, undefined);
  assert.equal(rows[0].node_name, undefined);
});

test("original GetUserFlowQuotaDates self dimensions JSON", async () => {
  const { e, auth, store } = await boot();
  const { primaryId } = await seedOriginalFlow(e, store, auth);
  const aliceAuth = await loginAs(e, "alice");
  const res = await json(
    new Request("http://local/api/data/flow/self?start_timestamp=900&end_timestamp=2000", { headers: aliceAuth }),
    e,
  );
  const rows = flowRows(res.body);
  assert.equal(rows.length, 1, res.text);
  assert.equal(rows[0].username, undefined);
  assert.equal(rows[0].channel_id, undefined);
  assert.equal(rows[0].channel_name, undefined);
  assert.equal(rows[0].token_id, primaryId);
  assert.equal(rows[0].token_name, undefined, "deleted token name stays empty for localized deleted (id)");
  assert.equal(rows[0].use_group, "vip");
  assert.equal(rows[0].model_name, "gpt-a");
  assert.equal(rows[0].quota, 175);
  assert.equal(rows[0].count, 4);
  assert.equal(rows[0].token_used, 70);
});

test("original GetUserFlowQuotaDates forces RoleCommonUser even for root", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const { alice } = await seedOriginalFlow(e, store, auth);
  await insertQuota(e, {
    user_id: root.id,
    username: "root",
    node_name: "edge",
    token_id: 0,
    use_group: "default",
    model_name: "gpt-root",
    channel_id: 1,
    created_at: 1500,
    count: 1,
    quota: 9,
    token_used: 3,
  });
  const res = await json(
    new Request("http://local/api/data/flow/self?start_timestamp=900&end_timestamp=2000", { headers: auth }),
    e,
  );
  const rows = flowRows(res.body);
  assert.equal(rows.length, 1, res.text);
  assert.equal(rows[0].model_name, "gpt-root");
  assert.equal(rows[0].username, undefined);
  assert.equal(rows[0].channel_name, undefined);
  assert.equal(rows[0].quota, 9);
  assert.ok(!rows.some((r) => r.user_id === alice.id || r.username === "alice"), res.text);
});

test("original GetUserFlowQuotaDates rejects invalid start_timestamp JSON", async () => {
  const { e, auth } = await boot();
  const res = await json(
    new Request("http://local/api/data/flow/self?start_timestamp=bad&end_timestamp=2000", { headers: auth }),
    e,
  );
  assert.equal(res.res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, "invalid start_timestamp");
});

test("original fillFlowChannelNames missing channel JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await insertQuota(e, {
    user_id: root.id,
    username: "root",
    node_name: "n1",
    token_id: 0,
    use_group: "default",
    model_name: "gpt-x",
    channel_id: 99,
    created_at: 1000,
    count: 1,
    quota: 10,
    token_used: 1,
  });
  const res = await json(
    new Request("http://local/api/data/flow?start_timestamp=900&end_timestamp=2000", { headers: auth }),
    e,
  );
  const rows = flowRows(res.body);
  assert.equal(rows.length, 1, res.text);
  assert.equal(rows[0].channel_id, 99);
  assert.equal(rows[0].channel_name, "channel-99");
});

test("original GetQuotaDatesByUser / GetAllQuotaDates grouping JSON", async () => {
  const { e, auth, store } = await boot();
  await createUser(e, auth, "alice");
  const alice = await store.getUserByUsername("alice");
  assert.ok(alice);
  await insertQuota(e, {
    user_id: alice.id,
    username: "alice",
    model_name: "gpt-a",
    created_at: 1000,
    quota: 100,
    token_used: 40,
    count: 2,
    use_group: "vip",
  });
  await insertQuota(e, {
    user_id: alice.id,
    username: "alice",
    model_name: "gpt-b",
    created_at: 1000,
    quota: 50,
    token_used: 20,
    count: 1,
    use_group: "default",
  });
  const users = await json(
    new Request("http://local/api/data/users?start_timestamp=900&end_timestamp=2000", { headers: auth }),
    e,
  );
  assert.equal(users.body.success, true, String(users.body.message));
  const userRows = users.body.data as Record<string, unknown>[];
  assert.equal(userRows.length, 1, users.text);
  assert.equal(userRows[0].username, "alice");
  assert.equal(userRows[0].created_at, 1000);
  assert.equal(userRows[0].quota, 150);
  assert.equal(userRows[0].count, 3);
  assert.equal(userRows[0].token_used, 60);
  assert.equal(userRows[0].model_name, "");
  for (const k of [
    "id",
    "user_id",
    "username",
    "model_name",
    "created_at",
    "use_group",
    "token_id",
    "channel_id",
    "node_name",
    "token_used",
    "count",
    "quota",
  ]) {
    assert.ok(k in userRows[0], "missing QuotaData " + k);
  }

  const models = await json(
    new Request("http://local/api/data/?start_timestamp=900&end_timestamp=2000", { headers: auth }),
    e,
  );
  const modelRows = models.body.data as Record<string, unknown>[];
  assert.equal(modelRows.length, 2, models.text);
  const names = modelRows.map((r) => String(r.model_name)).sort();
  assert.deepEqual(names, ["gpt-a", "gpt-b"]);
  const byUser = await json(
    new Request("http://local/api/data/?start_timestamp=900&end_timestamp=2000&username=alice", { headers: auth }),
    e,
  );
  const byUserRows = byUser.body.data as Record<string, unknown>[];
  assert.equal(byUserRows.length, 2, byUser.text);
  assert.ok(byUserRows.every((r) => r.username === "alice" && r.user_id === alice.id));
});
