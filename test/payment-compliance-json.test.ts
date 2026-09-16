import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { PAYMENT_COMPLIANCE_REQUIRED } from "../src/subscription.js";
import { Store } from "../src/store.js";
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

async function boot(e: Env) {
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
  return { auth };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

test("original ConfirmPaymentCompliance DecodeJson and ApiSuccess gin.H JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "参数错误");

  const notObject = await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify([]),
    }),
    e,
  );
  omitData(notObject.body, "参数错误");

  const badType = await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: 1 }),
    }),
    e,
  );
  omitData(badType.body, "参数错误");

  const unconfirmed = await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: false }),
    }),
    e,
  );
  omitData(unconfirmed.body, "请确认合规声明");

  const denied = await json(
    new Request("http://local/api/user/topup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ key: "missing" }),
    }),
    e,
  );
  assert.equal(denied.res.status, 200);
  omitData(denied.body, PAYMENT_COMPLIANCE_REQUIRED);

  const before = Math.floor(Date.now() / 1000);
  const ok = await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ confirmed: true }),
    }),
    e,
  );
  const after = Math.floor(Date.now() / 1000);
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "");
  const data = ok.body.data as {
    confirmed: boolean;
    terms_version: string;
    confirmed_at: number;
    confirmed_by: number;
  };
  assert.equal(data.confirmed, true);
  assert.equal(data.terms_version, "v1");
  assert.equal(data.confirmed_by, 1);
  assert.ok(data.confirmed_at >= before && data.confirmed_at <= after);
  assert.deepEqual(Object.keys(data).sort(), ["confirmed", "confirmed_at", "confirmed_by", "terms_version"]);
  assert.equal("confirmed_ip" in data, false);

  const store = new Store(e.DB);
  assert.equal(await store.option("payment_setting.compliance_confirmed"), "true");
  assert.equal(await store.option("payment_setting.compliance_terms_version"), "v1");
  assert.equal(await store.option("payment_setting.compliance_confirmed_by"), "1");
  assert.equal(await store.option("payment_setting.compliance_confirmed_at"), String(data.confirmed_at));

  await store.updateUser(1, { access_token: "pat-root-compliance" });
  const pat = await json(
    new Request("http://local/api/option/payment_compliance", {
      method: "POST",
      headers: { authorization: "Bearer pat-root-compliance", "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    }),
    e,
  );
  assert.equal(pat.res.status, 403);
  omitData(pat.body, "This operation requires dashboard session authentication. API access token is not allowed.");
});
