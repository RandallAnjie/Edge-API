import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  countTopLevelJSONKey,
  distributeReadsJSONModel,
  ERR_INVALID_JSON_REQUEST_BODY,
  ERR_MODEL_MUST_BE_PROVIDED_ONCE,
  getModelFromJSONBody,
  getModelFromRequest,
  parseFormData,
  unmarshalBodyReusable,
} from "../src/unmarshal-body-reusable.js";
import { distributorInvalidRequestMessage } from "../src/http.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
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

async function boot(e: Env, ipHeaders: Record<string, string> = {}) {
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  const tk = await send(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, ...ipHeaders },
      body: JSON.stringify({ name: "unmarshal-body", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { auth, sk };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

test("original UnmarshalBodyReusable leftover form/json/skip and getModelFromJSONBody", () => {
  assert.equal(distributeReadsJSONModel("/v1/chat/completions", "application/json"), true);
  assert.equal(distributeReadsJSONModel("/v1/messages", "application/json"), true);
  assert.equal(distributeReadsJSONModel("/pg/chat/completions", "application/json"), true);
  assert.equal(distributeReadsJSONModel("/v1beta/models/gemini-2.0-flash:generateContent", "application/json"), false);
  assert.equal(distributeReadsJSONModel("/v1/audio/transcriptions", "application/json"), false);
  assert.equal(distributeReadsJSONModel("/v1/chat/completions", "multipart/form-data; boundary=x"), false);
  assert.equal(distributeReadsJSONModel("/mj/submit/imagine", "application/json"), false);

  assert.equal(countTopLevelJSONKey(utf8(`{"model":"a","model":"b"}`), "model"), 2);
  assert.equal(countTopLevelJSONKey(utf8(`{"model":"a"}`), "model"), 1);
  assert.equal(countTopLevelJSONKey(utf8(`{"other":{"model":"a"}}`), "model"), 0);

  assert.deepEqual(getModelFromJSONBody(utf8("not-json")), { ok: false, message: ERR_INVALID_JSON_REQUEST_BODY });
  assert.deepEqual(getModelFromJSONBody(utf8("")), { ok: false, message: ERR_INVALID_JSON_REQUEST_BODY });
  assert.deepEqual(getModelFromJSONBody(utf8(`{"model":"a","model":"b"}`)), {
    ok: false,
    message: ERR_MODEL_MUST_BE_PROVIDED_ONCE,
  });
  assert.deepEqual(getModelFromJSONBody(utf8(`{"model":1}`)), { ok: false, message: "field model must be a string" });
  assert.deepEqual(getModelFromJSONBody(utf8(`{"model":"gpt-4","group":"vip"}`)), {
    ok: true,
    model: "gpt-4",
    group: "vip",
  });
  assert.deepEqual(getModelFromJSONBody(utf8(`{"model":null}`)), { ok: true, model: "", group: "" });

  assert.deepEqual(parseFormData(utf8("model=gpt-4&group=vip")), { model: "gpt-4", group: "vip" });
  assert.deepEqual(unmarshalBodyReusable(utf8("model=gpt-4"), "application/x-www-form-urlencoded"), { model: "gpt-4" });
  assert.deepEqual(unmarshalBodyReusable(utf8(""), "text/plain"), {});

  const req = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const wrapped = getModelFromRequest(req, utf8("not-json"));
  assert.equal(wrapped.ok, false);
  if (!wrapped.ok) {
    assert.equal(wrapped.message, distributorInvalidRequestMessage(req, ERR_INVALID_JSON_REQUEST_BODY));
  }
});

test("original Distribute leftover getModelFromJSONBody abortWithOpenAiMessage JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { sk } = await boot(e, { "cf-connecting-ip": "192.0.2.110" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const inner = distributorInvalidRequestMessage(
    new Request("http://local/v1/chat/completions", { headers: skAuth }),
    ERR_INVALID_JSON_REQUEST_BODY,
  );
  const expected = distributorInvalidRequestMessage(
    new Request("http://local/v1/chat/completions", { headers: skAuth }),
    inner,
  );

  const bad = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.111", "x-oneapi-request-id": "unmarshal-bad-json" },
      body: "not-json",
    }),
    e,
  );
  assert.equal(bad.res.status, 400, bad.text);
  const err = bad.body.error as { message: string; type: string; code: string; param?: unknown };
  assert.ok(err, bad.text);
  assert.equal("param" in err, false, bad.text);
  assert.deepEqual(Object.keys(err).sort(), ["code", "message", "type"]);
  assert.equal(err.type, "new_api_error");
  assert.equal(err.code, "");
  assert.equal(err.message, `${expected} (request id: unmarshal-bad-json)`);

  const numbered = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.112", "accept-language": "zh-CN" },
      body: JSON.stringify({ model: 1, messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(numbered.res.status, 400, numbered.text);
  const numberedErr = numbered.body.error as { message: string; type: string; code: string };
  assert.equal(numberedErr.type, "new_api_error");
  assert.equal(numberedErr.code, "");
  assert.match(numberedErr.message, /无效的请求，无效的请求，field model must be a string/);

  const claude = await send(
    new Request("http://local/v1/messages", {
      method: "POST",
      headers: {
        ...skAuth,
        "cf-connecting-ip": "192.0.2.113",
        "anthropic-version": "2023-06-01",
      },
      body: "not-json",
    }),
    e,
  );
  assert.equal(claude.res.status, 400, claude.text);
  assert.equal("type" in claude.body && claude.body.type === "error", false, claude.text);
  assert.equal((claude.body.error as { type: string }).type, "new_api_error");
});

test("original UnmarshalBodyReusable leftover form-urlencoded then GetAndValidateRequest JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { sk } = await boot(e, { "cf-connecting-ip": "192.0.2.114" });
  const form = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + sk,
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "192.0.2.115",
      },
      body: "model=gpt-4",
    }),
    e,
  );
  assert.equal(form.res.status, 400, form.text);
  const err = form.body.error as { message: string; type: string; param: string; code: string };
  assert.equal(err.message, "field messages is required");
  assert.equal(err.type, "new_api_error");
  assert.equal(err.param, "");
  assert.equal(err.code, "invalid_request");
});

test("original UnmarshalBodyReusable leftover does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.116" });

  const unauth = await send(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ email: "new@example.com" }),
    }),
    e,
  );
  assert.equal(unauth.res.status, 401);
  assert.equal(unauth.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(unauth.body.message, "Unauthorized");

  const created = await send(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.117", "x-oneapi-request-id": "hop348-vendor-create" },
      body: JSON.stringify({ name: "unmarshal-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop348-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
