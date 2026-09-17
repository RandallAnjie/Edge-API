import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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

function vendorErr(body: Record<string, unknown>, status: number, message: string, res: Response) {
  assert.equal(res.status, status);
  omitData(body, message);
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

test("original GetAuditLogs leftover ApiErrorMsg gin.H omit data", async () => {
  const { e, auth } = await boot();

  const paginate = await json(new Request("http://local/api/audit/self?p=-1", { headers: auth }), e);
  assert.equal(paginate.res.status, 200);
  omitData(paginate.body, "Invalid audit pagination");

  const filters = await json(new Request("http://local/api/audit/self?category=nope", { headers: auth }), e);
  omitData(filters.body, "Invalid audit filters");

  const time = await json(new Request("http://local/api/audit/self?start_timestamp=-1", { headers: auth }), e);
  omitData(time.body, "Invalid audit time range");

  const result = await json(new Request("http://local/api/audit/self?success=bad", { headers: auth }), e);
  omitData(result.body, "Invalid audit result");

  await e.DB.exec("DROP TABLE audit_logs");
  const listErr = await json(new Request("http://local/api/audit/self?p=1", { headers: auth }), e);
  assert.equal(listErr.res.status, 200);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.match(String(listErr.body.message), /no such table/i);
});

test("original CreatePrefillGroup / UpdatePrefillGroup leftover ApiErrorMsg gin.H omit data", async () => {
  const { e, auth } = await boot();

  const emptyName = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "", type: "model" }),
    }),
    e,
  );
  assert.equal(emptyName.res.status, 200);
  omitData(emptyName.body, "组名称和类型不能为空");

  const emptyBody = await json(new Request("http://local/api/prefill_group/", { method: "POST", headers: auth }), e);
  omitData(emptyBody.body, "EOF");

  const jsonNull = await json(
    new Request("http://local/api/prefill_group/", { method: "POST", headers: auth, body: "null" }),
    e,
  );
  omitData(jsonNull.body, "组名称和类型不能为空");

  const arr = await json(
    new Request("http://local/api/prefill_group/", { method: "POST", headers: auth, body: "[]" }),
    e,
  );
  omitData(arr.body, "json: cannot unmarshal array into Go value of type model.PrefillGroup");

  const created = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "dup-omit", type: "model", items: ["a"] }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));

  const dup = await json(
    new Request("http://local/api/prefill_group/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "dup-omit", type: "tag", items: ["b"] }),
    }),
    e,
  );
  omitData(dup.body, "组名称已存在");

  const missingId = await json(
    new Request("http://local/api/prefill_group/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "no-id" }),
    }),
    e,
  );
  omitData(missingId.body, "缺少组 ID");

  const putEmpty = await json(new Request("http://local/api/prefill_group/", { method: "PUT", headers: auth }), e);
  omitData(putEmpty.body, "EOF");

  const delBad = await json(new Request("http://local/api/prefill_group/abc", { method: "DELETE", headers: auth }), e);
  omitData(delBad.body, `strconv.Atoi: parsing "abc": invalid syntax`);

  await e.DB.exec("DROP TABLE prefill_groups");
  const listErr = await json(new Request("http://local/api/prefill_group/", { headers: auth }), e);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.match(String(listErr.body.message), /no such table/i);
});

test("original GetVendor / UpdateVendor leftover vendorAPIError gin.H omit data", async () => {
  const { e, auth } = await boot();

  const invalidId = await json(new Request("http://local/api/vendors/abc", { headers: auth }), e);
  vendorErr(invalidId.body, 400, `strconv.Atoi: parsing "abc": invalid syntax`, invalidId.res);

  const missing = await json(new Request("http://local/api/vendors/999999", { headers: auth }), e);
  vendorErr(missing.body, 400, "record not found", missing.res);

  const putMissingId = await json(
    new Request("http://local/api/vendors/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "no-id" }),
    }),
    e,
  );
  assert.equal(putMissingId.res.status, 200);
  omitData(putMissingId.body, "缺少供应商 ID");

  const putMissing = await json(
    new Request("http://local/api/vendors/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: 999999, name: "gone" }),
    }),
    e,
  );
  vendorErr(putMissing.body, 400, "record not found", putMissing.res);

  const putEmpty = await json(new Request("http://local/api/vendors/", { method: "PUT", headers: auth }), e);
  vendorErr(putEmpty.body, 400, "EOF", putEmpty.res);

  const delBad = await json(new Request("http://local/api/vendors/abc", { method: "DELETE", headers: auth }), e);
  vendorErr(delBad.body, 400, `strconv.Atoi: parsing "abc": invalid syntax`, delBad.res);

  await e.DB.exec("DROP TABLE vendors");
  const listErr = await json(new Request("http://local/api/vendors/", { headers: auth }), e);
  assert.equal(listErr.res.status, 400);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.match(String(listErr.body.message), /no such table/i);
});

test("original AdminCompleteTopUp leftover ApiErrorMsg gin.H omit data", async () => {
  const { e, auth } = await boot();

  const missing = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(missing.res.status, 200);
  omitData(missing.body, "参数错误");

  const emptyBody = await json(
    new Request("http://local/api/user/topup/complete", { method: "POST", headers: auth }),
    e,
  );
  omitData(emptyBody.body, "参数错误");

  const jsonNull = await json(
    new Request("http://local/api/user/topup/complete", { method: "POST", headers: auth, body: "null" }),
    e,
  );
  omitData(jsonNull.body, "参数错误");

  const unknown = await json(
    new Request("http://local/api/user/topup/complete", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ trade_no: "missing" }),
    }),
    e,
  );
  omitData(unknown.body, "充值订单不存在");

  await e.DB.exec("DROP TABLE topups");
  const listErr = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.match(String(listErr.body.message), /no such table/i);
});
