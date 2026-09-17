import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  ERR_PASSKEY_RPID_INVALID,
  ERR_PASSKEY_RPID_UNAVAILABLE,
  PasskeyDomainError,
  passkeyDomainHttpError,
} from "../src/passkey-domains.js";
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

test("original writePasskeyDomainSettingsError generic ApiError omit data", async () => {
  const req = new Request("http://local/api/option/passkey/domains");
  const generic = passkeyDomainHttpError(new Error("sqlite boom"), req);
  assert.equal(generic.status, 200);
  omitData((await generic.json()) as Record<string, unknown>, "sqlite boom");

  const invalid = passkeyDomainHttpError(new PasskeyDomainError(ERR_PASSKEY_RPID_INVALID, { code: "PASSKEY_RP_ID_INVALID" }), req);
  const invalidBody = (await invalid.json()) as Record<string, unknown>;
  assert.equal(invalid.status, 200);
  assert.equal(invalidBody.code, "PASSKEY_RP_ID_INVALID");
  assert.equal("data" in invalidBody, false);

  const unavailable = passkeyDomainHttpError(
    new PasskeyDomainError(ERR_PASSKEY_RPID_UNAVAILABLE, { code: "PASSKEY_RP_ID_UNAVAILABLE" }),
    req,
  );
  const unavailableBody = (await unavailable.json()) as Record<string, unknown>;
  assert.equal(unavailable.status, 200);
  assert.equal(unavailableBody.code, "PASSKEY_RP_ID_UNAVAILABLE");
  assert.equal("data" in unavailableBody, false);
});

test("original VerifyLogin leftover ApiErrorMsg 参数错误 omit data", async () => {
  const { e } = await boot();
  const headers = { "content-type": "application/json" };

  const empty = await json(new Request("http://local/api/user/login/verify", { method: "POST", headers }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "参数错误");

  const broken = await json(
    new Request("http://local/api/user/login/verify", { method: "POST", headers, body: "{" }),
    e,
  );
  omitData(broken.body, "参数错误");

  const jsonNull = await json(
    new Request("http://local/api/user/login/verify", { method: "POST", headers, body: "null" }),
    e,
  );
  omitData(jsonNull.body, "参数错误");

  const missingFields = await json(
    new Request("http://local/api/user/login/verify", {
      method: "POST",
      headers,
      body: JSON.stringify({ method: "2fa" }),
    }),
    e,
  );
  omitData(missingFields.body, "参数错误");
});

test("original SyncUpstreamPreview leftover ApiError omit data", async () => {
  const { e, auth } = await boot();
  const unsupported = await json(new Request("http://local/api/models/sync_upstream/preview?locale=fr", { headers: auth }), e);
  assert.equal(unsupported.res.status, 200);
  omitData(unsupported.body, "unsupported metadata language");
});
