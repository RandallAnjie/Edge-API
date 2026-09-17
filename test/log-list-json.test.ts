import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.Log` JSON tags from GetAllLogs / GetUserLogs. */
const ORIGINAL_LOG_JSON_FIELDS = [
  "id",
  "user_id",
  "created_at",
  "type",
  "content",
  "username",
  "token_name",
  "model_name",
  "quota",
  "prompt_tokens",
  "completion_tokens",
  "use_time",
  "is_stream",
  "channel",
  "channel_name",
  "token_id",
  "group",
  "ip",
  "other",
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

function pageItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return ((body.data as { items?: Record<string, unknown>[] })?.items || []);
}

test("original GetAllLogs orders by created_at DESC, id DESC and fills Channel JSON", async () => {
  const { e, auth, store } = await boot();
  const live = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "log-live-channel",
        type: 1,
        key: "sk-log-live",
        models: "gpt-4o",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(live.body.success, true, String(live.body.message));
  const liveId = (live.body.data as { id: number }).id;

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "loguser", password: "password12", role: 1 }),
    }),
    e,
  );
  const user = await store.getUserByUsername("loguser");
  assert.ok(user);

  await store.insertLog({
    user_id: user.id,
    username: "loguser",
    type: 2,
    content: "older-created-newer-id",
    created_at: 1_000,
    channel_id: liveId,
    token_name: "alpha",
    model_name: "gpt-4o",
    quota: 11,
    prompt_tokens: 2,
    completion_tokens: 3,
    use_time: 4,
    is_stream: 1,
    token_id: 8,
    group: "default",
    ip: "10.0.0.1",
    request_id: "req-old",
    upstream_request_id: "up-old",
    other: JSON.stringify({ request_path: "/v1/chat/completions" }),
  });
  await store.insertLog({
    user_id: user.id,
    username: "loguser",
    type: 2,
    content: "newer-created-older-id-slot",
    created_at: 3_000,
    channel_id: 40404,
    token_name: "beta",
    model_name: "gpt-4o-mini",
    quota: 22,
    group: "vip",
    ip: "10.0.0.2",
    request_id: "req-new",
  });
  await store.insertLog({
    user_id: user.id,
    username: "loguser",
    type: 4,
    content: "same-created-higher-id",
    created_at: 3_000,
    channel_id: liveId,
    token_name: "gamma",
    model_name: "gpt-4o",
    quota: 33,
    group: "default",
    ip: "10.0.0.3",
    request_id: "req-tie",
  });

  const listed = await json(
    new Request("http://local/api/log/?username=loguser&start_timestamp=1&end_timestamp=4000&page_size=100", { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  const data = listed.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(data.page, 1);
  assert.equal(data.page_size, 100);
  assert.equal(data.total, 3);
  const items = data.items;
  assert.equal(items.length, 3);
  assert.equal(items[0].content, "same-created-higher-id");
  assert.equal(items[1].content, "newer-created-older-id-slot");
  assert.equal(items[2].content, "older-created-newer-id");
  assert.ok(Number(items[0].id) > Number(items[1].id));
  assert.ok(Number(items[2].id) < Number(items[1].id));

  const newest = items[0];
  for (const field of ORIGINAL_LOG_JSON_FIELDS) {
    assert.ok(field in newest, "missing original Log field " + field);
  }
  assert.equal("channel_id" in newest, false, "original json tag is channel, not channel_id");
  assert.equal(newest.user_id, user.id);
  assert.equal(newest.type, 4);
  assert.equal(newest.username, "loguser");
  assert.equal(newest.token_name, "gamma");
  assert.equal(newest.model_name, "gpt-4o");
  assert.equal(newest.quota, 33);
  assert.equal(newest.channel, liveId);
  assert.equal(newest.channel_name, "log-live-channel");
  assert.equal(newest.group, "default");
  assert.equal(newest.ip, "10.0.0.3");
  assert.equal(newest.request_id, "req-tie");
  assert.equal(typeof newest.other, "string");
  assert.equal(typeof newest.is_stream, "boolean");

  const missingChannel = items[1];
  assert.equal(missingChannel.channel, 40404);
  assert.equal(missingChannel.channel_name, "", "GetAllLogs missing channel stays empty, not channel-%d");

  const oldest = items[2];
  assert.equal(oldest.channel, liveId);
  assert.equal(oldest.channel_name, "log-live-channel");
  assert.equal(oldest.is_stream, true);
  assert.equal(oldest.prompt_tokens, 2);
  assert.equal(oldest.completion_tokens, 3);
  assert.equal(oldest.use_time, 4);
  assert.equal(oldest.token_id, 8);
  assert.equal(oldest.upstream_request_id, "up-old");

  const page1 = await json(
    new Request("http://local/api/log/?username=loguser&start_timestamp=1&end_timestamp=4000&p=1&page_size=1", { headers: auth }),
    e,
  );
  assert.equal(pageItems(page1.body)[0].content, "same-created-higher-id");
  const page2 = await json(
    new Request("http://local/api/log/?username=loguser&start_timestamp=1&end_timestamp=4000&p=2&page_size=1", { headers: auth }),
    e,
  );
  assert.equal(pageItems(page2.body)[0].content, "newer-created-older-id-slot");
  const page3 = await json(
    new Request("http://local/api/log/?username=loguser&start_timestamp=1&end_timestamp=4000&p=3&page_size=1", { headers: auth }),
    e,
  );
  assert.equal(pageItems(page3.body)[0].content, "older-created-newer-id");

  const byChannel = await json(
    new Request(
      "http://local/api/log/?username=loguser&start_timestamp=1&end_timestamp=4000&channel=" + liveId + "&page_size=100",
      { headers: auth },
    ),
    e,
  );
  assert.equal(pageItems(byChannel.body).length, 2);
  assert.ok(pageItems(byChannel.body).every((row) => row.channel === liveId));

  const byType = await json(
    new Request("http://local/api/log/?username=loguser&start_timestamp=1&end_timestamp=4000&type=4&page_size=100", {
      headers: auth,
    }),
    e,
  );
  assert.equal(pageItems(byType.body).length, 1);
  assert.equal(pageItems(byType.body)[0].content, "same-created-higher-id");

  const userAuth = await loginAs(e, "loguser");
  const self = await json(new Request("http://local/api/log/self?page_size=100", { headers: userAuth }), e);
  assert.equal(self.body.success, true, String(self.body.message));
  const selfItems = pageItems(self.body);
  assert.equal(selfItems.length, 3);
  assert.equal(selfItems[0].id, 1);
  assert.equal(selfItems[1].id, 2);
  assert.equal(selfItems[2].id, 3);
  assert.equal(selfItems[0].content, "same-created-higher-id");
  assert.equal(selfItems[1].content, "newer-created-older-id-slot");
  assert.equal(selfItems[2].content, "older-created-newer-id");
  for (const row of selfItems) {
    assert.equal(row.channel_name, "");
    for (const field of ORIGINAL_LOG_JSON_FIELDS) {
      assert.ok(field in row, "self missing original Log field " + field);
    }
  }
  assert.equal(selfItems[2].channel, liveId);
});

test("original GetUserLogs orders by id DESC even when created_at is inverted", async () => {
  const { e, auth, store } = await boot();
  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "orderuser", password: "password12", role: 1 }),
    }),
    e,
  );
  const user = await store.getUserByUsername("orderuser");
  assert.ok(user);

  await store.insertLog({
    user_id: user.id,
    username: "orderuser",
    type: 2,
    content: "first-insert-later-created",
    created_at: 9_000,
    channel_id: 12,
  });
  await store.insertLog({
    user_id: user.id,
    username: "orderuser",
    type: 2,
    content: "second-insert-earlier-created",
    created_at: 100,
    channel_id: 12,
  });

  const admin = await json(new Request("http://local/api/log/?username=orderuser&page_size=100", { headers: auth }), e);
  const adminItems = pageItems(admin.body);
  assert.equal(adminItems[0].content, "first-insert-later-created");
  assert.equal(adminItems[1].content, "second-insert-earlier-created");

  const userAuth = await loginAs(e, "orderuser");
  const self = await json(new Request("http://local/api/log/self?page_size=100", { headers: userAuth }), e);
  const selfItems = pageItems(self.body);
  assert.equal(selfItems[0].content, "second-insert-earlier-created");
  assert.equal(selfItems[1].content, "first-insert-later-created");
  assert.equal(selfItems[0].id, 1);
  assert.equal(selfItems[1].id, 2);

  const token = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: userAuth,
      body: JSON.stringify({ name: "log-key", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(token.body.success, true, String(token.body.message));
  const createdToken = token.body.data as { id: number; key: string };
  const sk = String(createdToken.key);
  const tokenId = Number(createdToken.id);
  assert.ok(tokenId);

  await store.insertLog({
    user_id: user.id,
    username: "orderuser",
    type: 2,
    content: "token-first-later-created",
    created_at: 8_000,
    token_id: tokenId,
    token_name: "log-key",
  });
  await store.insertLog({
    user_id: user.id,
    username: "orderuser",
    type: 2,
    content: "token-second-earlier-created",
    created_at: 50,
    token_id: tokenId,
    token_name: "log-key",
  });

  const byKey = await json(new Request("http://local/api/log/token", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(byKey.body.success, true, String(byKey.body.message));
  const keyed = byKey.body.data as Record<string, unknown>[];
  assert.ok(Array.isArray(keyed));
  assert.equal(keyed[0].content, "token-second-earlier-created");
  assert.equal(keyed[1].content, "token-first-later-created");
  assert.equal(keyed[0].id, 1);
  assert.equal(keyed[1].id, 2);
  assert.equal(keyed[0].channel_name, "");
});
