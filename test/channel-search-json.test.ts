import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.Channel` JSON tags returned by SearchChannels. */
const ORIGINAL_CHANNEL_JSON_FIELDS = [
  "id",
  "type",
  "key",
  "openai_organization",
  "test_model",
  "status",
  "name",
  "weight",
  "created_time",
  "test_time",
  "response_time",
  "base_url",
  "other",
  "balance",
  "balance_updated_time",
  "models",
  "group",
  "used_quota",
  "model_mapping",
  "status_code_mapping",
  "priority",
  "auto_ban",
  "other_info",
  "tag",
  "setting",
  "param_override",
  "header_override",
  "remark",
  "channel_info",
  "settings",
] as const;

function assertExactChannelKeys(row: Record<string, unknown>) {
  assert.deepEqual(Object.keys(row).sort(), [...ORIGINAL_CHANNEL_JSON_FIELDS].sort());
  assert.equal("max_input_tokens" in row, false);
}

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

async function addChannel(e: Env, auth: Record<string, string>, channel: Record<string, unknown>) {
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(channel),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return created.body.data as { id: number; count: number };
}

test("original SearchChannels JSON matches Channel tags, type_counts, and filters", async () => {
  const { e, auth } = await boot();
  const openai = await addChannel(e, auth, {
    name: "search-openai",
    type: 1,
    key: "sk-search-openai-unique",
    models: "gpt-4o",
    group: "default",
    base_url: "https://api.openai.com",
    remark: "secret-remark-only",
    tag: "search-tag",
  });
  const claude = await addChannel(e, auth, {
    name: "search-claude",
    type: 14,
    key: "sk-search-claude",
    models: "claude-3-opus",
    group: "vip",
    tag: "search-tag",
  });
  await addChannel(e, auth, {
    name: "search-url-host",
    type: 1,
    key: "sk-search-url",
    models: "gpt-4o-mini",
    group: "default",
    base_url: "https://unique-search-host.example/v1",
  });
  await addChannel(e, auth, {
    name: "search-underscore-group",
    type: 1,
    key: "sk-search-group-a",
    models: "gpt-4o",
    group: "a_b",
  });
  await addChannel(e, auth, {
    name: "search-axb-group",
    type: 1,
    key: "sk-search-group-axb",
    models: "gpt-4o",
    group: "axb",
  });
  const disabled = await addChannel(e, auth, {
    name: "search-disabled",
    type: 1,
    key: "sk-search-disabled",
    models: "gpt-4o",
    group: "default",
  });
  const disable = await json(
    new Request("http://local/api/channel/" + disabled.id + "/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: 2 }),
    }),
    e,
  );
  assert.equal(disable.body.success, true, String(disable.body.message));

  const byName = await json(new Request("http://local/api/channel/search?keyword=search-openai", { headers: auth }), e);
  assert.equal(byName.body.success, true, String(byName.body.message));
  const named = byName.body.data as {
    items: Record<string, unknown>[];
    total: number;
    type_counts: Record<string, number>;
  };
  assert.ok(Array.isArray(named.items));
  assert.equal(typeof named.total, "number");
  assert.equal(typeof named.type_counts, "object");
  assert.equal(named.total, 1);
  const row = named.items[0];
  assert.ok(row);
  for (const k of ORIGINAL_CHANNEL_JSON_FIELDS) {
    assert.ok(k in row, "missing SearchChannels Channel field " + k);
  }
  assertExactChannelKeys(row);
  assert.equal(row.key, "");
  assert.equal(row.name, "search-openai");
  assert.equal(typeof row.channel_info, "object");
  assert.equal(typeof (row.channel_info as { is_multi_key: boolean }).is_multi_key, "boolean");

  const byKey = await json(
    new Request("http://local/api/channel/search?keyword=sk-search-openai-unique", { headers: auth }),
    e,
  );
  assert.equal((byKey.body.data as { total: number }).total, 1);
  assert.equal(((byKey.body.data as { items: { name: string }[] }).items[0] || {}).name, "search-openai");

  const byId = await json(new Request("http://local/api/channel/search?keyword=" + openai.id, { headers: auth }), e);
  assert.ok(((byId.body.data as { items: { name: string }[] }).items || []).some((c) => c.name === "search-openai"));

  const byURL = await json(
    new Request("http://local/api/channel/search?keyword=unique-search-host.example", { headers: auth }),
    e,
  );
  assert.equal(((byURL.body.data as { items: { name: string }[] }).items[0] || {}).name, "search-url-host");

  const remarkOnly = await json(
    new Request("http://local/api/channel/search?keyword=secret-remark-only", { headers: auth }),
    e,
  );
  assert.equal((remarkOnly.body.data as { total: number }).total, 0);

  const byModel = await json(new Request("http://local/api/channel/search?model=claude-3-opus", { headers: auth }), e);
  const modelItems = (byModel.body.data as { items: { name: string }[] }).items;
  assert.ok(modelItems.some((c) => c.name === "search-claude"));
  assert.equal(modelItems.some((c) => c.name === "search-openai"), false);

  const allGroup = await json(
    new Request("http://local/api/channel/search?keyword=search-openai&group=all", { headers: auth }),
    e,
  );
  assert.equal((allGroup.body.data as { total: number }).total, 1);

  const vipGroup = await json(
    new Request("http://local/api/channel/search?keyword=search-&group=vip", { headers: auth }),
    e,
  );
  assert.deepEqual(
    ((vipGroup.body.data as { items: { name: string }[] }).items || []).map((c) => c.name),
    ["search-claude"],
  );

  const underscoreGroup = await json(
    new Request("http://local/api/channel/search?keyword=search-&group=a_b", { headers: auth }),
    e,
  );
  const underscoreNames = ((underscoreGroup.body.data as { items: { name: string }[] }).items || []).map((c) => c.name);
  assert.deepEqual(underscoreNames, ["search-underscore-group"]);

  const typed = await json(
    new Request("http://local/api/channel/search?keyword=search-&type=1", { headers: auth }),
    e,
  );
  const typedData = typed.body.data as { items: { type: number }[]; type_counts: Record<string, number> };
  assert.ok(typedData.items.every((c) => c.type === 1));
  assert.ok((typedData.type_counts["14"] || 0) >= 1, JSON.stringify(typedData.type_counts));
  assert.ok((typedData.type_counts["1"] || 0) >= 1);

  const enabled = await json(
    new Request("http://local/api/channel/search?keyword=search-disabled&status=enabled", { headers: auth }),
    e,
  );
  assert.equal((enabled.body.data as { total: number }).total, 0);
  const disabledHits = await json(
    new Request("http://local/api/channel/search?keyword=search-disabled&status=disabled", { headers: auth }),
    e,
  );
  assert.equal((disabledHits.body.data as { total: number }).total, 1);

  const tagged = await json(
    new Request("http://local/api/channel/search?keyword=search-openai&tag_mode=true", { headers: auth }),
    e,
  );
  const taggedNames = ((tagged.body.data as { items: { name: string }[] }).items || []).map((c) => c.name).sort();
  assert.deepEqual(taggedNames, ["search-claude", "search-openai"]);

  const sorted = await json(
    new Request("http://local/api/channel/search?keyword=search-&sort_by=name&sort_order=asc&page_size=50", {
      headers: auth,
    }),
    e,
  );
  const sortedNames = ((sorted.body.data as { items: { name: string }[] }).items || []).map((c) => c.name);
  const copy = [...sortedNames].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(sortedNames, copy);

  const page1 = await json(
    new Request("http://local/api/channel/search?keyword=search-&sort_by=name&sort_order=asc&p=1&page_size=2", {
      headers: auth,
    }),
    e,
  );
  const page2 = await json(
    new Request("http://local/api/channel/search?keyword=search-&sort_by=name&sort_order=asc&p=2&page_size=2", {
      headers: auth,
    }),
    e,
  );
  const p1 = ((page1.body.data as { items: { name: string }[] }).items || []).map((c) => c.name);
  const p2 = ((page2.body.data as { items: { name: string }[] }).items || []).map((c) => c.name);
  assert.equal(p1.length, 2);
  assert.equal(p2.length, 2);
  assert.equal(p1[0] === p2[0], false);
  assert.equal((page1.body.data as { total: number }).total, (page2.body.data as { total: number }).total);
  void claude;
});

test("original GetAllChannels JSON ignores keyword and keeps Channel list fields", async () => {
  const { e, auth } = await boot();
  await addChannel(e, auth, {
    name: "list-alpha-unique",
    type: 1,
    key: "sk-list-alpha",
    models: "gpt-4o",
    group: "default",
    remark: "list-alpha-remark",
  });
  await addChannel(e, auth, {
    name: "list-beta-other",
    type: 14,
    key: "sk-list-beta",
    models: "claude-3-opus",
    group: "default",
    remark: "list-beta-remark",
  });

  const listed = await json(
    new Request("http://local/api/channel/?keyword=list-alpha-unique&page_size=100", { headers: auth }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  assert.equal(listed.body.message, "");
  const data = listed.body.data as {
    items: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
    type_counts: Record<string, number>;
  };
  assert.ok(Array.isArray(data.items));
  assert.equal(typeof data.total, "number");
  assert.equal(data.page, 1);
  assert.equal(data.page_size, 100);
  assert.equal(typeof data.type_counts, "object");
  const names = data.items.map((c) => String(c.name));
  assert.ok(names.includes("list-alpha-unique"));
  assert.ok(names.includes("list-beta-other"), "GetAllChannels must not apply keyword LIKE");
  assert.ok((data.type_counts["1"] || 0) >= 1);
  assert.ok((data.type_counts["14"] || 0) >= 1);

  const row = data.items.find((c) => c.name === "list-alpha-unique") as Record<string, unknown>;
  for (const k of ORIGINAL_CHANNEL_JSON_FIELDS) {
    assert.ok(k in row, "missing GetAllChannels Channel field " + k);
  }
  assertExactChannelKeys(row);
  assert.equal(row.key, "");
  assert.equal(typeof row.channel_info, "object");

  const typed = await json(new Request("http://local/api/channel/?type=14&page_size=100", { headers: auth }), e);
  const typedData = typed.body.data as { items: { name: string; type: number }[]; type_counts: Record<string, number> };
  assert.ok(typedData.items.some((c) => c.name === "list-beta-other"));
  assert.equal(typedData.items.some((c) => c.name === "list-alpha-unique"), false);
  assert.ok(typedData.items.every((c) => c.type === 14));
  assert.ok((typedData.type_counts["1"] || 0) >= 1, "type_counts ignores the type filter");
  assert.ok((typedData.type_counts["14"] || 0) >= 1);

  const searched = await json(
    new Request("http://local/api/channel/search?keyword=list-alpha-unique", { headers: auth }),
    e,
  );
  const searchNames = ((searched.body.data as { items: { name: string }[] }).items || []).map((c) => c.name);
  assert.deepEqual(searchNames, ["list-alpha-unique"]);
});

test("original GetChannel JSON is Channel tags without max_input_tokens", async () => {
  const { e, auth } = await boot();
  const created = await addChannel(e, auth, {
    name: "get-channel-json",
    type: 1,
    key: "sk-get-channel",
    models: "gpt-4o-mini",
    group: "default",
  });
  const got = await json(new Request("http://local/api/channel/" + created.id, { headers: auth }), e);
  assert.equal(got.body.success, true, String(got.body.message));
  assert.equal(got.body.message, "");
  const row = got.body.data as Record<string, unknown>;
  assertExactChannelKeys(row);
  assert.equal(row.key, "");
  assert.equal(row.name, "get-channel-json");
  assert.equal(row.type, 1);
});
