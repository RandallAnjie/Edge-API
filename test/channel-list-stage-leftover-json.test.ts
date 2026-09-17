import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  MSG_CHANNEL_LIST_FAILED,
  MSG_CHANNEL_TAG_CHANNELS_FAILED,
  MSG_CHANNEL_TAG_COUNT_FAILED,
  MSG_CHANNEL_TYPE_COUNTS_FAILED,
  Store,
} from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

async function boot() {
  resetSchemaFlag();
  const e = env();
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
  const auth = { authorization: "Bearer " + token };
  return { e, auth };
}

test("original GetAllChannels leftover list / type_counts gin.H omit data", async () => {
  const { e, auth } = await boot();
  const origPage = Store.prototype.listChannelPage;
  Store.prototype.listChannelPage = async () => {
    throw new Error("sqlite boom");
  };
  try {
    const listErr = await json(new Request("http://local/api/channel/", { headers: auth }), e);
    assert.equal(listErr.res.status, 200);
    omitData(listErr.body, MSG_CHANNEL_LIST_FAILED);
  } finally {
    Store.prototype.listChannelPage = origPage;
  }

  const origTypes = Store.prototype.channelTypeCounts;
  Store.prototype.channelTypeCounts = async () => {
    throw new Error("sqlite boom");
  };
  try {
    const typeErr = await json(new Request("http://local/api/channel/", { headers: auth }), e);
    assert.equal(typeErr.res.status, 200);
    omitData(typeErr.body, MSG_CHANNEL_TYPE_COUNTS_FAILED);
  } finally {
    Store.prototype.channelTypeCounts = origTypes;
  }
});

test("original GetAllChannels leftover tag count / tag channels gin.H omit data", async () => {
  const { e, auth } = await boot();
  const origCount = Store.prototype.countChannelTags;
  Store.prototype.countChannelTags = async () => {
    throw new Error("sqlite boom");
  };
  try {
    const countErr = await json(new Request("http://local/api/channel/?tag_mode=true", { headers: auth }), e);
    assert.equal(countErr.res.status, 200);
    omitData(countErr.body, MSG_CHANNEL_TAG_COUNT_FAILED);
  } finally {
    Store.prototype.countChannelTags = origCount;
  }

  const origTags = Store.prototype.paginatedChannelTags;
  const origByTag = Store.prototype.channelsByTagFiltered;
  Store.prototype.paginatedChannelTags = async () => ["tag-a"];
  Store.prototype.channelsByTagFiltered = async () => {
    throw new Error("sqlite boom");
  };
  try {
    const tagChErr = await json(new Request("http://local/api/channel/?tag_mode=true", { headers: auth }), e);
    assert.equal(tagChErr.res.status, 200);
    omitData(tagChErr.body, MSG_CHANNEL_TAG_CHANNELS_FAILED);
  } finally {
    Store.prototype.paginatedChannelTags = origTags;
    Store.prototype.channelsByTagFiltered = origByTag;
  }
});
