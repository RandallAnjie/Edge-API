import assert from "node:assert/strict";
import { test } from "node:test";
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
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
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

async function addChannel(e: Env, auth: Record<string, string>, name: string): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name,
        type: 1,
        key: "sk-" + name,
        models: "gpt-4o",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

async function channelTag(e: Env, auth: Record<string, string>, id: number): Promise<unknown> {
  const ch = await json(new Request("http://local/api/channel/" + id, { headers: auth }), e);
  assert.equal(ch.body.success, true, String(ch.body.message));
  return (ch.body.data as { tag: unknown }).tag;
}

test("POST /api/channel/batch/tag ShouldBindJSON matches original ChannelBatch errors", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, "batch-tag");
  const cases: Array<{ body: BodyInit | null; contentType?: string }> = [
    { body: "not-json" },
    { body: JSON.stringify([]) },
    { body: JSON.stringify(null) },
    { body: JSON.stringify({}) },
    { body: JSON.stringify({ ids: [] }) },
    { body: JSON.stringify({ ids: ["1"] }) },
    { body: JSON.stringify({ ids: [1.5] }) },
    { body: JSON.stringify({ ids: 1 }) },
    { body: JSON.stringify({ ids: [id], tag: 1 }) },
    { body: "" },
  ];
  for (const c of cases) {
    const res = await json(
      new Request("http://local/api/channel/batch/tag", {
        method: "POST",
        headers: { ...auth, "content-type": c.contentType || "application/json" },
        body: c.body,
      }),
      e,
    );
    assert.equal(res.res.status, 200, String(c.body));
    assert.equal(res.body.success, false, String(c.body));
    assert.equal(res.body.message, "参数错误", String(c.body));
    assert.equal(res.body.data, null, String(c.body));
  }
});

test("POST /api/channel/batch/tag omitted/null vs empty string matches original *string JSON", async () => {
  const { e, auth } = await boot();
  const a = await addChannel(e, auth, "tag-a");
  const b = await addChannel(e, auth, "tag-b");
  const c = await addChannel(e, auth, "tag-c");

  const setProd = await json(
    new Request("http://local/api/channel/batch/tag", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [a, b, c], tag: "prod" }),
    }),
    e,
  );
  assert.equal(setProd.res.status, 200);
  assert.equal(setProd.body.success, true);
  assert.equal(setProd.body.message, "");
  assert.equal(setProd.body.data, 3);

  assert.equal(await channelTag(e, auth, a), "prod");

  const clearNull = await json(
    new Request("http://local/api/channel/batch/tag", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [a], tag: null }),
    }),
    e,
  );
  assert.equal(clearNull.body.success, true);
  assert.equal(clearNull.body.data, 1);
  assert.equal(await channelTag(e, auth, a), null);

  const omitTag = await json(
    new Request("http://local/api/channel/batch/tag", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [b] }),
    }),
    e,
  );
  assert.equal(omitTag.body.success, true);
  assert.equal(omitTag.body.data, 1);
  assert.equal(await channelTag(e, auth, b), null);

  const emptyTag = await json(
    new Request("http://local/api/channel/batch/tag", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [c], tag: "" }),
    }),
    e,
  );
  assert.equal(emptyTag.body.success, true);
  assert.equal(emptyTag.body.data, 1);
  assert.equal(await channelTag(e, auth, c), "");
});

test("POST /api/channel/batch ShouldBindJSON matches original DeleteChannelBatch errors", async () => {
  const { e, auth } = await boot();
  const id = await addChannel(e, auth, "batch-del");
  const bad = await json(
    new Request("http://local/api/channel/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: ["x"] }),
    }),
    e,
  );
  assert.equal(bad.body.success, false);
  assert.equal(bad.body.message, "参数错误");
  const ok = await json(
    new Request("http://local/api/channel/batch", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [id] }),
    }),
    e,
  );
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "");
  assert.equal(ok.body.data, 1);
});
