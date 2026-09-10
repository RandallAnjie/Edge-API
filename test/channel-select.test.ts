import assert from "node:assert/strict";
import { test } from "node:test";
import { filterUserTokenAutoGroups, requestAutoGroups } from "../src/dto.js";
import { cacheGetRandomSatisfiedChannel, increaseChannelSelectRetry, newChannelSelectState } from "../src/channel-select.js";
import { parseApiKeyParts } from "../src/crypto.js";
import { tokenModelLimitAllows } from "../src/ratio-setting.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike, TokenRow } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  return { res, body: JSON.parse(text) as Record<string, unknown> };
}

test("original GetRequestAutoGroups empty array inherits global Auto; malformed fails closed", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1() };
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const s = new Store(e.DB);
  await s.setOption("AutoGroups", JSON.stringify(["vip", "default"]));
  const inherit = await requestAutoGroups(s, { auto_groups: "[]" }, "default");
  assert.deepEqual(inherit, ["vip", "default"]);
  const missing = await requestAutoGroups(s, { auto_groups: "" }, "default");
  assert.deepEqual(missing, ["vip", "default"]);
  const closed = await requestAutoGroups(s, { auto_groups: "not-json" }, "default");
  assert.deepEqual(closed, []);
  const snapshot = await requestAutoGroups(s, { auto_groups: JSON.stringify(["default", "vip", "default"]) }, "default");
  assert.deepEqual(snapshot, ["vip", "default"].includes("default") ? ["default", "vip"] : snapshot);
  assert.deepEqual(snapshot, ["default", "vip"]);
  const capped = await filterUserTokenAutoGroups(s, "default", ["vip", "default", "svip"]);
  await s.setOption("MaxTokenAutoGroups", "1");
  const one = await filterUserTokenAutoGroups(s, "default", ["vip", "default"]);
  assert.deepEqual(one, ["vip"]);
  assert.ok(capped.length <= 5);
});

test("original CacheGetRandomSatisfiedChannel walks token auto groups before default", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1() };
  const setup = await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  assert.equal(setup.body.success, true, String(setup.body.message));
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
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "AutoGroups", value: "[]" }),
    }),
    e,
  );
  const vip = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "vip-ch",
        type: 1,
        key: "sk-vip",
        models: "select-model",
        group: "vip",
      }),
    }),
    e,
  );
  const def = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "default-ch",
        type: 1,
        key: "sk-def",
        models: "select-model",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(vip.body.success, true, String(vip.body.message));
  assert.equal(def.body.success, true, String(def.body.message));
  const vipId = Number(Array.isArray(vip.body.data) ? (vip.body.data as { id: number }[])[0].id : (vip.body.data as { id: number }).id);
  const defId = Number(Array.isArray(def.body.data) ? (def.body.data as { id: number }[])[0].id : (def.body.data as { id: number }).id);
  const store = new Store(e.DB);
  const tokenRow = { auto_groups: JSON.stringify(["vip", "default"]), cross_group_retry: 1 } as TokenRow;
  const state = newChannelSelectState();
  const first = await cacheGetRandomSatisfiedChannel(
    store,
    {
      tokenGroup: "auto",
      modelName: "select-model",
      userGroup: "default",
      token: tokenRow,
      crossGroupRetry: true,
      retryTimes: 0,
    },
    state,
  );
  assert.equal(first.selectGroup, "vip");
  assert.equal(first.channel?.id, vipId);
  increaseChannelSelectRetry(state);
  const second = await cacheGetRandomSatisfiedChannel(
    store,
    {
      tokenGroup: "auto",
      modelName: "select-model",
      userGroup: "default",
      token: tokenRow,
      crossGroupRetry: true,
      retryTimes: 0,
    },
    state,
  );
  assert.equal(second.selectGroup, "default");
  assert.equal(second.channel?.id, defId);
});

test("original tokenModelLimitAllows accepts exact, wildcard, and routing-normalized names", () => {
  const aliasOnly = { "claude-3-7-sonnet-thinking": true };
  assert.equal(tokenModelLimitAllows(aliasOnly, "claude-3-7-sonnet-thinking"), true);
  assert.equal(tokenModelLimitAllows(aliasOnly, "claude-3-7-sonnet"), false);

  const baseOnly = { "claude-3-7-sonnet": true };
  assert.equal(tokenModelLimitAllows(baseOnly, "claude-3-7-sonnet@thinking:on"), true);
  assert.equal(tokenModelLimitAllows(baseOnly, "claude-3-7-sonnet-thinking"), true);

  const wildcard = { "gemini-2.5-flash-thinking-*": true };
  assert.equal(tokenModelLimitAllows(wildcard, "gemini-2.5-flash-thinking-8192"), true);

  const fullOnly = { "opaque@sha256:deadbeef": true };
  assert.equal(tokenModelLimitAllows(fullOnly, "opaque@sha256:deadbeef"), true);
  const opaqueBase = { opaque: true };
  assert.equal(tokenModelLimitAllows(opaqueBase, "opaque@sha256:deadbeef"), false);
});

test("original TokenAuth parseApiKeyParts keeps channel pin suffix", () => {
  const parsed = parseApiKeyParts("Bearer sk-abcdef0123456789-42");
  assert.equal(parsed.key, "abcdef0123456789");
  assert.deepEqual(parsed.extra, ["42"]);
  assert.equal(parseApiKeyParts("sk-onlykey").extra.length, 0);
});
