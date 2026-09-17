import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store, tryLockChannelFix, unlockChannelFix } from "../src/store.js";
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

async function addChannel(e: Env, auth: Record<string, string>): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "fix-ch",
        type: 1,
        key: "sk-fix",
        models: "gpt-4o",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("POST /api/channel/fix TryLock matches original FixAbility ApiError JSON", async () => {
  const { e, auth } = await boot();
  await addChannel(e, auth);
  assert.equal(tryLockChannelFix(), true);
  try {
    const busy = await json(new Request("http://local/api/channel/fix", { method: "POST", headers: auth }), e);
    assert.equal(busy.res.status, 200);
    assert.equal(busy.body.success, false);
    assert.equal(busy.body.message, "已经有一个修复任务在运行中，请稍后再试");
    assert.equal("data" in busy.body, false);
    assert.deepEqual(Object.keys(busy.body).sort(), ["message", "success"]);
  } finally {
    unlockChannelFix();
  }
});

test("POST /api/channel/fix success JSON matches original data.success/fails", async () => {
  const { e, auth } = await boot();
  await addChannel(e, auth);
  const first = await json(new Request("http://local/api/channel/fix", { method: "POST", headers: auth }), e);
  const second = await json(new Request("http://local/api/channel/fix", { method: "POST", headers: auth }), e);
  assert.equal(first.res.status, 200);
  assert.equal(second.res.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(second.body.success, true);
  assert.equal(first.body.message, "");
  assert.equal(second.body.message, "");
  const firstData = first.body.data as { success: number; fails: number };
  const secondData = second.body.data as { success: number; fails: number };
  assert.equal(typeof firstData.success, "number");
  assert.equal(typeof firstData.fails, "number");
  assert.ok(firstData.success >= 1);
  assert.equal(firstData.fails, 0);
  assert.ok(secondData.success >= 1);
  assert.equal(secondData.fails, 0);
});

test("Store.fixAbilities concurrent TryLock throws original message", async () => {
  const { e, auth, store } = await boot();
  await addChannel(e, auth);
  const held = store.fixAbilities();
  await assert.rejects(() => store.fixAbilities(), { message: "已经有一个修复任务在运行中，请稍后再试" });
  await held;
});
