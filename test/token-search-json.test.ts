import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.Token` JSON tags plus `tokenResponse.auto_groups`. */
const ORIGINAL_TOKEN_JSON_FIELDS = [
  "id",
  "user_id",
  "key",
  "status",
  "name",
  "created_time",
  "accessed_time",
  "expired_time",
  "remain_quota",
  "unlimited_quota",
  "model_limits_enabled",
  "model_limits",
  "allow_ips",
  "used_quota",
  "group",
  "cross_group_retry",
  "DeletedAt",
  "auto_groups",
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

async function addToken(e: Env, auth: Record<string, string>, name: string) {
  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const data = created.body.data as { id: number; key: string };
  const keyRes = await json(new Request("http://local/api/token/" + data.id + "/key", { method: "POST", headers: auth }), e);
  assert.equal(keyRes.body.success, true, String(keyRes.body.message));
  const rawKey = String((keyRes.body.data as { key: string }).key || "");
  return { id: data.id, rawKey, createdKey: String(data.key || "") };
}

function searchItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return ((body.data as { items?: Record<string, unknown>[] })?.items || []);
}

test("original SearchUserTokens JSON includes Token fields and masked key", async () => {
  const { e, auth } = await boot();
  const tok = await addToken(e, auth, "searchable-token");
  const searched = await json(
    new Request("http://local/api/token/search?keyword=searchable-token&p=1&size=10", { headers: auth }),
    e,
  );
  assert.equal(searched.body.success, true, String(searched.body.message));
  const items = searchItems(searched.body);
  assert.equal(items.length, 1);
  const item = items[0];
  for (const k of ORIGINAL_TOKEN_JSON_FIELDS) {
    assert.ok(k in item, `SearchTokens missing original Token field ${k}`);
  }
  assert.equal(item.name, "searchable-token");
  assert.equal(item.DeletedAt, null);
  assert.equal(item.auto_groups, null);
  assert.notEqual(item.key, tok.rawKey);
  assert.equal(String(searched.text).includes(tok.rawKey), false, "search response leaked raw token key");
  assert.equal(typeof item.key, "string");
  assert.ok(String(item.key).includes("*"));
});

test("original SearchUserTokens keyword is name LIKE without wrapping %", async () => {
  const { e, auth } = await boot();
  await addToken(e, auth, "searchme");
  await addToken(e, auth, "other");
  const exact = await json(new Request("http://local/api/token/search?keyword=searchme", { headers: auth }), e);
  assert.equal(exact.body.success, true, String(exact.body.message));
  assert.deepEqual(searchItems(exact.body).map((t) => t.name), ["searchme"]);

  const prefix = await json(new Request("http://local/api/token/search?keyword=search", { headers: auth }), e);
  assert.equal(prefix.body.success, true, String(prefix.body.message));
  assert.equal(searchItems(prefix.body).length, 0, "keyword without % is exact name match");

  const fuzzy = await json(new Request("http://local/api/token/search?keyword=%search%", { headers: auth }), e);
  assert.equal(fuzzy.body.success, true, String(fuzzy.body.message));
  assert.deepEqual(searchItems(fuzzy.body).map((t) => t.name), ["searchme"]);
});

test("original SearchUserTokens token query trims sk- and does not search name", async () => {
  const { e, auth } = await boot();
  const tok = await addToken(e, auth, "named-key");
  await addToken(e, auth, "other");

  const byNameAsToken = await json(
    new Request("http://local/api/token/search?token=" + encodeURIComponent("named-key"), { headers: auth }),
    e,
  );
  assert.equal(byNameAsToken.body.success, true, String(byNameAsToken.body.message));
  assert.equal(searchItems(byNameAsToken.body).length, 0);

  const byKey = await json(
    new Request("http://local/api/token/search?token=" + encodeURIComponent(tok.rawKey), { headers: auth }),
    e,
  );
  assert.equal(byKey.body.success, true, String(byKey.body.message));
  assert.equal(searchItems(byKey.body).length, 1);
  assert.equal(searchItems(byKey.body)[0].name, "named-key");

  const bySk = await json(
    new Request("http://local/api/token/search?token=" + encodeURIComponent("sk-" + tok.rawKey), { headers: auth }),
    e,
  );
  assert.equal(bySk.body.success, true, String(bySk.body.message));
  assert.equal(searchItems(bySk.body).length, 1);
  assert.equal(searchItems(bySk.body)[0].id, tok.id);
});

test("original SearchUserTokens sanitizeLikePattern rejects invalid % and escapes _", async () => {
  const { e, auth } = await boot();
  await addToken(e, auth, "hello_world");
  await addToken(e, auth, "helloXworld");

  const literal = await json(new Request("http://local/api/token/search?keyword=hello_world", { headers: auth }), e);
  assert.equal(literal.body.success, true, String(literal.body.message));
  assert.deepEqual(searchItems(literal.body).map((t) => t.name), ["hello_world"]);

  const consecutive = await json(new Request("http://local/api/token/search?keyword=" + encodeURIComponent("a%%b"), { headers: auth }), e);
  assert.equal(consecutive.body.success, false);
  assert.equal(consecutive.body.message, "搜索模式中不允许包含连续的 % 通配符");

  const tooMany = await json(new Request("http://local/api/token/search?keyword=" + encodeURIComponent("%a%b%"), { headers: auth }), e);
  assert.equal(tooMany.body.success, false);
  assert.equal(tooMany.body.message, "搜索模式中最多允许包含 2 个 % 通配符");

  const shortFuzzy = await json(new Request("http://local/api/token/search?keyword=" + encodeURIComponent("%a%"), { headers: auth }), e);
  assert.equal(shortFuzzy.body.success, false);
  assert.equal(shortFuzzy.body.message, "使用模糊搜索时，关键词长度至少为 2 个字符");
});

test("original SearchUserTokens bans fuzzy search when token count exceeds max_user_tokens", async () => {
  const { e, auth } = await boot();
  await addToken(e, auth, "alpha");
  await addToken(e, auth, "beta");
  const put = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "token_setting.max_user_tokens", value: "1" }),
    }),
    e,
  );
  assert.equal(put.body.success, true, String(put.body.message));

  const fuzzy = await json(new Request("http://local/api/token/search?keyword=" + encodeURIComponent("%al%"), { headers: auth }), e);
  assert.equal(fuzzy.body.success, false);
  assert.equal(fuzzy.body.message, "令牌数量超过上限，仅允许精确搜索，请勿使用 % 通配符");

  const exact = await json(new Request("http://local/api/token/search?keyword=alpha", { headers: auth }), e);
  assert.equal(exact.body.success, true, String(exact.body.message));
  assert.deepEqual(searchItems(exact.body).map((t) => t.name), ["alpha"]);
});
