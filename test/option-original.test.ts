import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
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

async function boot(e = env()) {
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
  return { e, token, auth };
}

test("original POST /api/option/model_pricing/convert JSON expressions", async () => {
  const { e, auth } = await boot();
  const cases: { name: string; draft: Record<string, unknown>; expression: string; reason?: string }[] = [
    { name: "conversion-defaults", draft: { ModelRatio: 2 }, expression: `tier("base", p * 4 + c * 4)` },
    { name: "gpt-4-32k", draft: { ModelRatio: 30.0, CacheRatio: 1.0 }, expression: `tier("base", p * 60 + c * 120)` },
    { name: "conversion-free-cache", draft: { ModelRatio: 0.0, CacheRatio: 0.0 }, expression: `tier("base", p * 0 + c * 0 + cr * 0)` },
    {
      name: "claude-3-7-sonnet-20250219",
      draft: { ModelRatio: 1.5, CacheRatio: 0.1, CreateCacheRatio: 1.25 },
      expression: `tier("base", p * 3 + c * 15 + cr * 0.3 + cc * 3.75 + cc1h * 6)`,
    },
    { name: "conversion-image-default", draft: { ModelRatio: 2, ImageRatio: 1 }, expression: `tier("base", p * 4 + c * 4)` },
    { name: "conversion-image-free", draft: { ModelRatio: 2, ImageRatio: 0 }, expression: `tier("base", p * 4 + c * 4 + cr * 4 + img * 0)` },
    { name: "deepseek-chat", draft: { ModelRatio: 0.135, CacheRatio: 0.25 }, expression: `tier("base", p * 0.27 + c * 0.27 + cr * 0.0675)` },
    { name: "gpt-4o-custom", draft: { ModelRatio: 2 }, expression: `tier("base", p * 4 + c * 16)` },
    { name: "gemini-2.5-pro-custom", draft: { ModelRatio: 2 }, expression: `tier("base", p * 4 + c * 32)` },
    {
      name: "vendor/claude-sonnet-4",
      draft: { ModelRatio: 2, CompletionRatio: 0 },
      expression: `tier("base", p * 4 + c * 0 + cr * 4 + cc * 5 + cc1h * 8)`,
    },
    {
      name: "conversion-custom",
      draft: { ModelRatio: 2, CompletionRatio: 3, CacheRatio: 0, CreateCacheRatio: 1.5, ImageRatio: 2 },
      expression: `tier("base", p * 4 + c * 12 + cr * 0 + cc * 6 + img * 8)`,
    },
    { name: "conversion-free", draft: { ModelPrice: 0 }, expression: `tier("request", fixed(0))` },
    { name: "conversion-fixed", draft: { ModelPrice: 0.25, ModelRatio: 7 }, expression: `tier("request", fixed(0.25))` },
    { name: "gpt-4o-2024-05-13", draft: { ModelRatio: 2, CompletionRatio: 99 }, expression: `tier("base", p * 4 + c * 12)` },
    { name: "gpt-image-2", draft: { ModelPrice: 1 }, expression: `tier("image", fixed(1)) * image_count` },
    { name: "qwen-image-3.0-pro", draft: { ModelPrice: 1 }, expression: `tier("image", fixed(1)) * image_count` },
    { name: "gpt-realtime", draft: { ModelRatio: 1 }, expression: "", reason: "Realtime pricing must be converted manually." },
    { name: "conversion-audio", draft: { ModelRatio: 1, AudioRatio: 2 }, expression: `tier("base", p * 2 + c * 2 + ai * 4 + ao * 4)` },
    {
      name: "expr-already",
      draft: { "billing_setting.billing_mode": "tiered_expr", "billing_setting.billing_expr": 'tier("base", p * 1)' },
      expression: "",
      reason: "This model already uses an expression.",
    },
  ];

  for (const tc of cases) {
    const before = await json(new Request("http://local/api/option/model_pricing?model=" + encodeURIComponent(tc.name), { headers: auth }), e);
    const converted = await json(
      new Request("http://local/api/option/model_pricing/convert", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ model_name: tc.name, pricing: tc.draft }),
      }),
      e,
    );
    assert.equal(converted.res.status, 200, tc.name + " status " + converted.text);
    assert.equal(converted.body.success, true, tc.name + " " + converted.text);
    const data = converted.body.data as {
      expression?: string;
      unsupported_reason?: string;
      effective?: Record<string, unknown>;
      cache_write_mode?: string;
      billing_details?: Record<string, unknown>;
    };
    assert.equal(data.expression || "", tc.expression, tc.name + " expression");
    assert.equal(data.unsupported_reason || "", tc.reason || "", tc.name + " reason");
    assert.ok("billing_details" in data, tc.name + " billing_details");
    if (tc.expression && !Object.prototype.hasOwnProperty.call(tc.draft, "ModelPrice")) {
      assert.ok(data.cache_write_mode, tc.name + " cache_write_mode");
    }
    if (tc.name === "gpt-image-2") {
      assert.equal(data.billing_details?.image_count, true);
    }
    const after = await json(new Request("http://local/api/option/model_pricing?model=" + encodeURIComponent(tc.name), { headers: auth }), e);
    assert.deepEqual(after.body.data, before.body.data, tc.name + " preview must not write");
  }

  const mapped = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "Mapped image",
        type: 1,
        key: "k",
        models: "conversion-alias",
        group: "default",
        model_mapping: JSON.stringify({ "conversion-alias": "conversion-hop", "conversion-hop": "gpt-image-2" }),
      }),
    }),
    e,
  );
  assert.equal(mapped.body.success, true, String(mapped.body.message));
  const alias = await json(
    new Request("http://local/api/option/model_pricing/convert", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "conversion-alias", pricing: { ModelPrice: 1 } }),
    }),
    e,
  );
  assert.equal((alias.body.data as { expression?: string }).expression, `tier("image", fixed(1)) * image_count`);

  const preview = await json(
    new Request("http://local/api/option/model_pricing/preview", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "gpt-4-32k", pricing: { ModelRatio: 30.0, CacheRatio: 1.0 } }),
    }),
    e,
  );
  assert.equal(preview.body.success, true, preview.text);
  const previewData = preview.body.data as {
    effective: Record<string, unknown>;
    cache_write_mode: string;
    billing_details: Record<string, unknown>;
  };
  assert.equal(previewData.effective.ModelRatio, 30);
  assert.equal(previewData.effective.CompletionRatio, 2);
  assert.equal(previewData.cache_write_mode, "none");
  assert.ok(previewData.billing_details && typeof previewData.billing_details === "object");

  const snapshot = await json(new Request("http://local/api/option/model_pricing", { headers: auth }), e);
  const options = (snapshot.body.data as { options: Record<string, string> }).options;
  for (const key of [
    "ModelRatio",
    "CompletionRatio",
    "ModelPrice",
    "CacheRatio",
    "CreateCacheRatio",
    "ImageRatio",
    "AudioRatio",
    "AudioCompletionRatio",
    "billing_setting.billing_mode",
    "billing_setting.billing_expr",
    "billing_setting.plugin_billing_expr",
  ]) {
    assert.ok(key in options, "missing pricing option " + key);
  }

  const cacheModes = [
    { name: "unrecognized-model", draft: { ModelRatio: 2.0, CompletionRatio: 2.0, CacheRatio: 0.25, "billing_setting.billing_mode": "ratio" }, mode: "none" },
    {
      name: "gpt-5.6-terra",
      draft: { ModelRatio: 2.0, CompletionRatio: 2.0, CacheRatio: 0.25, CreateCacheRatio: 1.25, "billing_setting.billing_mode": "ratio" },
      mode: "standard",
    },
    {
      name: "vendor/claude-sonnet-4-6-high",
      draft: { ModelRatio: 2.0, CompletionRatio: 2.0, CacheRatio: 0.25, "billing_setting.billing_mode": "ratio" },
      mode: "claude_ttl",
    },
  ];
  for (const tc of cacheModes) {
    const converted = await json(
      new Request("http://local/api/option/model_pricing/convert", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ model_name: tc.name, pricing: tc.draft }),
      }),
      e,
    );
    assert.equal((converted.body.data as { cache_write_mode?: string }).cache_write_mode, tc.mode, tc.name);
  }
});

test("original PUT /api/option/passkey/domains JSON", async () => {
  const { e, auth } = await boot();
  const missing = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ rp_id: "example.com" }),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.match(String(missing.body.message), /无效的参数|Invalid parameters/);

  const invalid = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ rp_id: "https://example.com", legacy_rp_ids: "", origins: "https://example.com", preview: true }),
    }),
    e,
  );
  assert.equal(invalid.body.success, false);
  assert.equal(invalid.body.code, "PASSKEY_RP_ID_INVALID");

  const saved = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "www.example.com,WWW.example.com",
        origins: "https://example.com,https://www.example.com",
        preview: false,
      }),
    }),
    e,
  );
  assert.equal(saved.body.success, true, saved.text);
  const savedData = saved.body.data as Record<string, unknown>;
  for (const key of [
    "rp_id",
    "legacy_rp_ids",
    "origins",
    "previous_rp_id",
    "effective_rp_id",
    "removed_rp_ids",
    "affected_credentials",
    "unknown_credentials",
    "confirmation_required",
    "removal_confirmation",
  ]) {
    assert.ok(key in savedData, "missing " + key);
  }
  assert.equal(savedData.rp_id, "example.com");
  assert.equal(savedData.effective_rp_id, "example.com");

  const statusAfter = await json(new Request("http://local/api/status"), e);
  const statusData = statusAfter.body.data as { passkey_rp_id: string; passkey_rp_ids: string[] };
  assert.equal(statusData.passkey_rp_id, "example.com");
  assert.ok(Array.isArray(statusData.passkey_rp_ids));
  assert.ok(statusData.passkey_rp_ids.includes("example.com"));
  assert.ok(statusData.passkey_rp_ids.includes("www.example.com"));
  assert.ok(statusData.passkey_rp_ids.includes("WWW.example.com"));

  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "passkey.enabled", value: "true" }),
    }),
    e,
  );
  const beginHint = await json(
    new Request("http://local/api/user/passkey/login/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rp_id: "www.example.com" }),
    }),
    e,
  );
  assert.equal(beginHint.body.success, true, beginHint.text);
  const beginData = beginHint.body.data as { rp_ids: string[]; options: { rpId: string } };
  assert.deepEqual(beginData.rp_ids, ["example.com", "www.example.com", "WWW.example.com"]);
  assert.equal(beginData.options.rpId, "www.example.com");
  const beginUnavailable = await json(
    new Request("http://local/api/user/passkey/login/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rp_id: "unconfigured.example.com" }),
    }),
    e,
  );
  assert.equal(beginUnavailable.body.success, false);
  assert.equal(beginUnavailable.body.code, "PASSKEY_RP_ID_UNAVAILABLE");

  await e.DB.prepare("INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (1, '0', 'key', '', 0, 0, 'www.example.com')").run();
  await e.DB.prepare("INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (2, '1', 'key', '', 0, 0, 'WWW.example.com')").run();
  await e.DB.prepare("INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (3, '2', 'key', '', 0, 0, '')").run();
  await e.DB.prepare("INSERT INTO passkeys (user_id, credential_id, public_key, name, created_at, last_used_at, rp_id) VALUES (4, '3', 'key', '', 0, 0, '')").run();

  const preview = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "WWW.example.com",
        origins: "https://example.com,https://www.example.com",
        preview: true,
      }),
    }),
    e,
  );
  assert.equal(preview.body.success, true, preview.text);
  const data = preview.body.data as {
    removed_rp_ids: string[];
    affected_credentials: number;
    unknown_credentials: number;
    confirmation_required: boolean;
    removal_confirmation: string;
    legacy_rp_ids: string;
  };
  assert.deepEqual(data.removed_rp_ids, ["www.example.com"]);
  assert.equal(data.affected_credentials, 1);
  assert.equal(data.unknown_credentials, 2);
  assert.equal(data.confirmation_required, true);
  assert.ok(data.removal_confirmation);
  const still = await json(new Request("http://local/api/option/", { headers: auth }), e);
  const legacy = ((still.body.data as { key: string; value: string }[]) || []).find((o) => o.key === "passkey.legacy_rp_ids");
  assert.ok(String(legacy?.value || "").includes("www.example.com"), "preview must not write legacy rp ids");

  const blocked = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "WWW.example.com",
        origins: "https://example.com,https://www.example.com",
        preview: false,
      }),
    }),
    e,
  );
  assert.equal(blocked.res.status, 409);
  assert.equal(blocked.body.code, "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED");
  assert.ok((blocked.body.data as { removal_confirmation?: string }).removal_confirmation);

  const confirmed = await json(
    new Request("http://local/api/option/passkey/domains", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        rp_id: "example.com",
        legacy_rp_ids: "WWW.example.com",
        origins: "https://example.com,https://www.example.com",
        preview: false,
        removal_confirmation: (blocked.body.data as { removal_confirmation: string }).removal_confirmation,
      }),
    }),
    e,
  );
  assert.equal(confirmed.body.success, true, confirmed.text);
  assert.equal((confirmed.body.data as { legacy_rp_ids: string }).legacy_rp_ids, "WWW.example.com");
});

test("original NormalizePasskeyRPID publicsuffix PUT /api/option JSON", async () => {
  const { e, auth } = await boot();
  const invalid = [
    { key: "passkey.rp_id", value: "co.uk" },
    { key: "passkey.rp_id", value: "github.io" },
    { key: "passkey.rp_id", value: "localhost:3000" },
    { key: "passkey.legacy_rp_ids", value: "localhost:3001" },
    { key: "passkey.rp_id", value: "com" },
    { key: "passkey.rp_id", value: "foo.kobe.jp" },
  ];
  for (const body of invalid) {
    const res = await json(
      new Request("http://local/api/option/", {
        method: "PUT",
        headers: { ...auth, "accept-language": "en" },
        body: JSON.stringify(body),
      }),
      e,
    );
    assert.equal(res.body.success, false, body.value);
    assert.equal(res.body.code, "PASSKEY_RP_ID_INVALID", body.value);
    assert.equal(
      res.body.message,
      "Invalid Passkey domain. Enter a domain without a scheme, port, path or wildcard.",
      body.value,
    );
  }

  const zh = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ key: "passkey.rp_id", value: "co.uk" }),
    }),
    e,
  );
  assert.equal(zh.body.code, "PASSKEY_RP_ID_INVALID");
  assert.equal(zh.body.message, "通行密钥域名无效。请填写域名，不包含协议、端口、路径或通配符。");

  const hosts: { rp_id: string; origins: string; valid: boolean }[] = [
    { rp_id: "intranet", origins: "https://intranet:8443", valid: true },
    { rp_id: "intranet", origins: "https://child.intranet", valid: false },
    { rp_id: "intranet", origins: "http://intranet", valid: false },
    { rp_id: "com", origins: "https://com", valid: false },
    { rp_id: "127.0.0.1", origins: "https://127.0.0.1", valid: false },
    { rp_id: "intranet:8443", origins: "https://intranet:8443", valid: false },
    { rp_id: "localhost", origins: "http://localhost:3000", valid: true },
    { rp_id: "example.co.uk", origins: "https://example.co.uk", valid: true },
    { rp_id: "münchen.de", origins: "https://xn--mnchen-3ya.de", valid: true },
  ];
  for (const tc of hosts) {
    const res = await json(
      new Request("http://local/api/option/passkey/domains", {
        method: "PUT",
        headers: { ...auth, "accept-language": "en" },
        body: JSON.stringify({ rp_id: tc.rp_id, legacy_rp_ids: "", origins: tc.origins, preview: true }),
      }),
      e,
    );
    if (!tc.valid) {
      assert.equal(res.body.success, false, tc.rp_id + " " + tc.origins);
      assert.equal(res.body.code, "PASSKEY_RP_ID_INVALID", tc.rp_id);
      continue;
    }
    assert.equal(res.body.success, true, tc.rp_id + " " + res.text);
    const data = res.body.data as { rp_id: string };
    if (tc.rp_id === "münchen.de") assert.equal(data.rp_id, "xn--mnchen-3ya.de");
    else assert.equal(data.rp_id, tc.rp_id);
  }
});
