import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_ENABLED, CHANNEL_MANUAL_DISABLED, CHANNEL_TYPE_CODEX } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

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

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original EditTagChannels / GetTagModels / EnableTagChannels JSON fields", async () => {
  const { e, auth, store } = await boot();
  const shortId = await addChannel(e, auth, {
    name: "tag-short",
    type: 1,
    key: "sk-short",
    models: "a,b",
    group: "default",
    tag: "prod",
  });
  const longId = await addChannel(e, auth, {
    name: "tag-long",
    type: 1,
    key: "sk-long",
    models: "x,y,z,",
    group: "default",
    tag: "prod",
  });

  const models = await json(new Request("http://local/api/channel/tag/models?tag=prod", { headers: auth }), e);
  assert.equal(models.body.success, true);
  assert.equal(models.body.message, "");
  assert.equal(models.body.data, "x,y,z,");

  const emptyModelsTag = await json(new Request("http://local/api/channel/tag/models", { headers: auth }), e);
  assert.equal(emptyModelsTag.res.status, 400);
  assert.equal(emptyModelsTag.body.success, false);
  assert.equal(emptyModelsTag.body.message, "tag不能为空");
  assert.equal(emptyModelsTag.body.data, undefined);

  const emptyTag = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ models: "gpt-4o" }),
    }),
    e,
  );
  assert.equal(emptyTag.body.success, false);
  assert.equal(emptyTag.body.message, "tag不能为空");
  assert.equal("data" in emptyTag.body, false);
  assert.deepEqual(Object.keys(emptyTag.body).sort(), ["message", "success"]);

  const edited = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        tag: "prod",
        model_mapping: JSON.stringify({ "gpt-alias": "gpt-4o" }),
        models: "",
        groups: "",
      }),
    }),
    e,
  );
  assert.equal(edited.body.success, true, String(edited.body.message));
  assert.equal(edited.body.message, "");
  assert.equal("data" in edited.body, false);
  assert.deepEqual(Object.keys(edited.body).sort(), ["message", "success"]);
  const savedLong = await store.getChannel(longId);
  assert.equal(savedLong?.model_mapping, JSON.stringify({ "gpt-alias": "gpt-4o" }));
  assert.equal(savedLong?.models, "x,y,z,");
  assert.equal((await store.getChannel(shortId))?.models, "a,b");

  await store.updateChannel(shortId, { status: CHANNEL_MANUAL_DISABLED });
  await store.updateChannel(longId, { status: CHANNEL_MANUAL_DISABLED });
  const enabled = await json(
    new Request("http://local/api/channel/tag/enabled", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ tag: "prod", status: CHANNEL_MANUAL_DISABLED }),
    }),
    e,
  );
  assert.equal(enabled.body.success, true);
  assert.equal(enabled.body.message, "");
  assert.equal("data" in enabled.body, false);
  assert.deepEqual(Object.keys(enabled.body).sort(), ["message", "success"]);
  assert.equal(Number((await store.getChannel(shortId))?.status), CHANNEL_ENABLED);
  assert.equal(Number((await store.getChannel(longId))?.status), CHANNEL_ENABLED);
});

test("original fetchCodexChannelWhamData JSON refreshes on 401 and returns upstream_status", async () => {
  const { e, auth, store } = await boot();
  const id = await addChannel(e, auth, {
    name: "codex-wham",
    type: CHANNEL_TYPE_CODEX,
    key: JSON.stringify({
      access_token: "expired-at",
      account_id: "acct-1",
      refresh_token: "rt-wham",
      email: "codex@example.com",
      type: "codex",
    }),
    models: "gpt-5",
    group: "default",
    base_url: "https://chatgpt.com",
  });

  const invalidId = await addChannel(e, auth, {
    name: "codex-bad-key",
    type: CHANNEL_TYPE_CODEX,
    key: JSON.stringify({ access_token: "tok", account_id: "acct-bad" }),
    models: "gpt-5",
    group: "default",
    base_url: "https://chatgpt.com",
  });
  await store.updateChannel(invalidId, { key: "not-json" });
  const badKey = await json(new Request("http://local/api/channel/" + invalidId + "/codex/usage", { headers: auth }), e);
  assert.equal(badKey.body.success, false);
  assert.equal(badKey.body.message, "解析凭证失败，请检查渠道配置");
  assert.equal(badKey.body.upstream_status, undefined);
  assert.equal("data" in badKey.body, false);
  assert.deepEqual(Object.keys(badKey.body).sort(), ["message", "success"]);

  let usageAuth = "";
  let refreshGrant = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    if (url === "https://auth.openai.com/oauth/token") {
      refreshGrant = await req.text();
      return new Response(
        JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      usageAuth = req.headers.get("authorization") || "";
      if (usageAuth === "Bearer expired-at") {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return new Response(JSON.stringify({ object: "wham_usage", used: 3 }), { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  try {
    const usage = await json(new Request("http://local/api/channel/" + id + "/codex/usage", { headers: auth }), e);
    assert.equal(usage.res.status, 200, usage.text);
    assert.equal(usage.body.success, true);
    assert.equal(usage.body.message, "");
    assert.equal(usage.body.upstream_status, 200);
    assert.deepEqual(usage.body.data, { object: "wham_usage", used: 3 });
    assert.match(refreshGrant, /grant_type=refresh_token/);
    assert.match(refreshGrant, /refresh_token=rt-wham/);
    assert.equal(usageAuth, "Bearer new-at");
    const saved = JSON.parse(String((await store.getChannel(id))?.key || "")) as {
      access_token: string;
      refresh_token: string;
      account_id: string;
      email: string;
      type: string;
    };
    assert.equal(saved.access_token, "new-at");
    assert.equal(saved.refresh_token, "new-rt");
    assert.equal(saved.account_id, "acct-1");
    assert.equal(saved.email, "codex@example.com");
    assert.equal(saved.type, "codex");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original fetchCodexChannelWhamData keeps first upstream JSON when refresh fails", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, {
    name: "codex-wham-keep",
    type: CHANNEL_TYPE_CODEX,
    key: JSON.stringify({
      access_token: "expired-at",
      account_id: "acct-keep",
      refresh_token: "rt-keep",
      type: "codex",
    }),
    models: "gpt-5",
    group: "default",
    base_url: "https://chatgpt.com",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    if (url === "https://auth.openai.com/oauth/token") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const usage = await json(new Request("http://local/api/channel/" + id + "/codex/usage", { headers: auth }), e);
    assert.equal(usage.res.status, 200);
    assert.equal(usage.body.success, false);
    assert.equal(usage.body.message, "upstream status: 401");
    assert.equal(usage.body.upstream_status, 401);
    assert.deepEqual(usage.body.data, { error: "expired" });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original RefreshCodexChannelCredential JSON fields", async () => {
  const { e, auth, store } = await boot();
  const id = await addChannel(e, auth, {
    name: "codex-refresh",
    type: CHANNEL_TYPE_CODEX,
    key: JSON.stringify({
      access_token: "old-at",
      account_id: "acct-refresh",
      refresh_token: "rt-refresh",
      email: "refresh@example.com",
      type: "codex",
    }),
    models: "gpt-5",
    group: "default",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://auth.openai.com/oauth/token") {
      const form = await req.text();
      assert.match(form, /grant_type=refresh_token/);
      assert.match(form, /refresh_token=rt-refresh/);
      assert.match(form, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
      return new Response(
        JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
        { status: 200 },
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const refreshed = await json(
      new Request("http://local/api/channel/" + id + "/codex/refresh", { method: "POST", headers: auth }),
      e,
    );
    assert.equal(refreshed.res.status, 200);
    assert.equal(refreshed.body.success, true);
    assert.equal(refreshed.body.message, "refreshed");
    const data = refreshed.body.data as {
      expires_at: string;
      last_refresh: string;
      account_id: string;
      email: string;
      channel_id: number;
      channel_type: number;
      channel_name: string;
    };
    assert.equal(data.account_id, "acct-refresh");
    assert.equal(data.email, "refresh@example.com");
    assert.equal(data.channel_id, id);
    assert.equal(data.channel_type, CHANNEL_TYPE_CODEX);
    assert.equal(data.channel_name, "codex-refresh");
    assert.match(data.expires_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(data.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
    const saved = JSON.parse(String((await store.getChannel(id))?.key || "")) as {
      access_token: string;
      refresh_token: string;
    };
    assert.equal(saved.access_token, "new-at");
    assert.equal(saved.refresh_token, "new-rt");

    const missing = await json(
      new Request("http://local/api/channel/999999/codex/refresh", { method: "POST", headers: auth }),
      e,
    );
    assert.equal(missing.body.success, false);
    assert.equal(missing.body.message, "刷新凭证失败，请稍后重试");
    assert.equal("data" in missing.body, false);
    assert.deepEqual(Object.keys(missing.body).sort(), ["message", "success"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original DisableTagChannels / EnableTagChannels / EditTagChannels leftover gin.H omit data", async () => {
  const { e, auth, store } = await boot();
  const id = await addChannel(e, auth, {
    name: "tag-omit",
    type: 1,
    key: "sk-omit",
    models: "gpt-4o",
    group: "default",
    tag: "prod",
  });

  const omitData = (body: Record<string, unknown>, message: string) => {
    assert.equal(body.success, false);
    assert.equal(body.message, message);
    assert.equal("data" in body, false);
    assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
  };

  for (const path of ["/api/channel/tag/disabled", "/api/channel/tag/enabled"] as const) {
    for (const c of [
      { body: "not-json" },
      { body: JSON.stringify([]) },
      { body: JSON.stringify({}) },
      { body: JSON.stringify({ tag: 1 }) },
      { body: JSON.stringify({ tag: null }) },
      { body: JSON.stringify({ tag: "" }) },
      { body: JSON.stringify(null) },
      { body: "" },
    ]) {
      const res = await json(
        new Request("http://local" + path, {
          method: "POST",
          headers: auth,
          body: c.body,
        }),
        e,
      );
      assert.equal(res.res.status, 200, path + " " + String(c.body));
      omitData(res.body, "参数错误");
    }
  }

  const putNull = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(null),
    }),
    e,
  );
  omitData(putNull.body, "tag不能为空");

  const putType = await json(
    new Request("http://local/api/channel/tag", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ tag: 1 }),
    }),
    e,
  );
  omitData(putType.body, "参数错误");

  const putEmpty = await json(
    new Request("http://local/api/channel/tag", { method: "PUT", headers: auth, body: "" }),
    e,
  );
  omitData(putEmpty.body, "参数错误");

  const putBadJson = await json(
    new Request("http://local/api/channel/tag", { method: "PUT", headers: auth, body: "not-json" }),
    e,
  );
  omitData(putBadJson.body, "参数错误");

  const disabled = await json(
    new Request("http://local/api/channel/tag/disabled", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ tag: "prod" }),
    }),
    e,
  );
  assert.equal(disabled.res.status, 200);
  assert.equal(disabled.body.success, true);
  assert.equal(disabled.body.message, "");
  assert.equal("data" in disabled.body, false);
  assert.deepEqual(Object.keys(disabled.body).sort(), ["message", "success"]);
  assert.equal(Number((await store.getChannel(id))?.status), CHANNEL_MANUAL_DISABLED);
});

test("original fetchCodexChannelWhamData leftover gin.H omit data", async () => {
  const { e, auth } = await boot();
  const openaiId = await addChannel(e, auth, {
    name: "not-codex",
    type: 1,
    key: "sk-openai",
    models: "gpt-4o",
    group: "default",
  });

  const omitData = (body: Record<string, unknown>, message: string) => {
    assert.equal(body.success, false);
    assert.equal(body.message, message);
    assert.equal("data" in body, false);
    assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
  };

  const invalidId = await json(new Request("http://local/api/channel/abc/codex/usage", { headers: auth }), e);
  omitData(invalidId.body, 'invalid channel id: strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/channel/999999/codex/usage", { headers: auth }), e);
  omitData(missing.body, "record not found");

  const wrongType = await json(new Request("http://local/api/channel/" + openaiId + "/codex/usage", { headers: auth }), e);
  omitData(wrongType.body, "channel type is not Codex");

  const refreshInvalid = await json(
    new Request("http://local/api/channel/abc/codex/refresh", { method: "POST", headers: auth }),
    e,
  );
  omitData(refreshInvalid.body, 'invalid channel id: strconv.Atoi: parsing "abc": invalid syntax');
});
