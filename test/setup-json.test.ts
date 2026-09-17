import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { ERR_ACCOUNT_PASSWORD_LENGTH } from "../src/crypto.js";
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

function postSetup(e: Env, body: unknown, raw?: string) {
  return json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    e,
  );
}

test("original GetSetup gin.H omits message and always includes Setup zero values", async () => {
  resetSchemaFlag();
  const e = env();
  const fresh = await json(new Request("http://local/api/setup"), e);
  assert.equal(fresh.res.status, 200);
  assert.equal(fresh.body.success, true);
  assert.equal("message" in fresh.body, false);
  assert.deepEqual(Object.keys(fresh.body).sort(), ["data", "success"]);
  const data = fresh.body.data as { status: boolean; root_init: boolean; database_type: string };
  assert.deepEqual(Object.keys(data).sort(), ["database_type", "root_init", "status"]);
  assert.equal(data.status, false);
  assert.equal(data.root_init, false);
  assert.equal(data.database_type, "sqlite");

  const created = await postSetup(e, {
    username: "root",
    password: "password12",
    confirmPassword: "password12",
  });
  assert.equal(created.body.success, true);
  assert.equal(created.body.message, "系统初始化成功");
  assert.equal("data" in created.body, false);
  assert.deepEqual(Object.keys(created.body).sort(), ["message", "success"]);

  const done = await json(new Request("http://local/api/setup"), e);
  assert.equal(done.body.success, true);
  assert.equal("message" in done.body, false);
  const doneData = done.body.data as { status: boolean; root_init: boolean; database_type: string };
  assert.equal(doneData.status, true);
  assert.equal(doneData.root_init, false);
  assert.equal(doneData.database_type, "");
});

test("original PostSetup gin.H errors omit data and use ValidateNewAccountPassword", async () => {
  resetSchemaFlag();
  const e = env();

  const empty = await json(new Request("http://local/api/setup", { method: "POST", headers: { "content-type": "application/json" } }), e);
  assert.equal(empty.body.success, false);
  assert.equal(empty.body.message, "请求参数有误");
  assert.equal("data" in empty.body, false);

  const badJson = await postSetup(e, null, "{");
  assert.equal(badJson.body.success, false);
  assert.equal(badJson.body.message, "请求参数有误");
  assert.equal("data" in badJson.body, false);

  const arrayBody = await postSetup(e, null, "[]");
  assert.equal(arrayBody.body.success, false);
  assert.equal(arrayBody.body.message, "请求参数有误");

  const longName = await postSetup(e, {
    username: "thirteencharx",
    password: "password12",
    confirmPassword: "password12",
  });
  assert.equal(longName.body.success, false);
  assert.equal(longName.body.message, "用户名长度不能超过12个字符");
  assert.equal("data" in longName.body, false);

  const mismatch = await postSetup(e, { username: "root", password: "password12" });
  assert.equal(mismatch.body.success, false);
  assert.equal(mismatch.body.message, "两次输入的密码不一致");
  assert.equal("data" in mismatch.body, false);

  const short = await postSetup(e, { username: "root", password: "short7", confirmPassword: "short7" });
  assert.equal(short.body.success, false);
  assert.equal(short.body.message, ERR_ACCOUNT_PASSWORD_LENGTH);
  assert.equal("data" in short.body, false);

  const ok = await postSetup(e, {
    username: "root",
    password: "password12",
    confirmPassword: "password12",
    SelfUseModeEnabled: true,
  });
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "系统初始化成功");
  assert.equal("data" in ok.body, false);

  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.equal(user?.display_name, "Root User");
  assert.match(String(user?.password || ""), /^\$pbkdf2-sha256\$/);
  assert.equal(String(user?.password || "").includes("argon2"), false);
  assert.equal(await store.option("SelfUseModeEnabled"), "true");
  assert.equal(await store.option("DemoSiteEnabled"), "false");

  const again = await postSetup(e, {
    username: "root",
    password: "password12",
    confirmPassword: "password12",
  });
  assert.equal(again.body.success, false);
  assert.equal(again.body.message, "系统已经初始化完成");
  assert.equal("data" in again.body, false);
});
