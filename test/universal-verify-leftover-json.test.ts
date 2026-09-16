import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { paymentDisabled, pluginDisabled } from "../src/oauth.js";
import type { Env, ExecutionContextLike } from "../src/types.js";
import type { Context } from "../src/router.js";

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

test("original UniversalVerify leftover ApiErrorMsg 参数错误 omit data", async () => {
  const { e, auth } = await boot();

  const empty = await json(new Request("http://local/api/verify", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "参数错误");

  const broken = await json(new Request("http://local/api/verify", { method: "POST", headers: auth, body: "{" }), e);
  omitData(broken.body, "参数错误");

  const arr = await json(new Request("http://local/api/verify", { method: "POST", headers: auth, body: "[]" }), e);
  omitData(arr.body, "参数错误");

  const typed = await json(
    new Request("http://local/api/verify", { method: "POST", headers: auth, body: JSON.stringify({ method: 1, scope: "2fa.disable" }) }),
    e,
  );
  omitData(typed.body, "参数错误");

  const jsonNull = await json(new Request("http://local/api/verify", { method: "POST", headers: auth, body: "null" }), e);
  assert.equal(jsonNull.res.status, 200);
  assert.equal(jsonNull.body.success, false);
  assert.equal(jsonNull.body.code, "SECURITY_PROOF_SCOPE_MISMATCH");
  assert.equal("data" in jsonNull.body, false);
});

test("original paymentDisabled / pluginDisabled leftover gin.H omit data", async () => {
  const pay = paymentDisabled({ req: new Request("http://local/") } as Context<Env>);
  assert.equal(pay.status, 200);
  omitData((await pay.json()) as Record<string, unknown>, "支付方式未配置。请在系统设置中填写 Stripe / Epay / Creem / Waffo 密钥后启用在线充值。");

  const plugin = pluginDisabled();
  assert.equal(plugin.status, 200);
  omitData(
    (await plugin.json()) as Record<string, unknown>,
    "该能力需要对应配置；边缘运行时已提供等价接口，请检查插件是否已上传或部署密钥是否已设置",
  );
});
