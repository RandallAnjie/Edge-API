import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { MAX_REQUEST_BODY_MB } from "../src/constants.js";
import {
  DEFAULT_MAX_REQUEST_BODY_MB,
  DECOMPRESS_MAX_REQUEST_BODY_MB_FALLBACK,
  decompressRequest,
  decompressRequestApplies,
  getDecompressMaxRequestBodyBytes,
  gzipNewReaderFailed,
} from "../src/decompress-request.js";
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
  return { res, text };
}

function empty400(hit: { res: Response; text: string }) {
  assert.equal(hit.res.status, 400, hit.text);
  assert.equal(hit.text, "");
}

test("original DecompressRequestMiddleware constants, GET skip, and gzip.NewReader header", () => {
  assert.equal(DEFAULT_MAX_REQUEST_BODY_MB, 128);
  assert.equal(DEFAULT_MAX_REQUEST_BODY_MB, MAX_REQUEST_BODY_MB);
  assert.equal(DECOMPRESS_MAX_REQUEST_BODY_MB_FALLBACK, 32);
  assert.equal(getDecompressMaxRequestBodyBytes(env()), 128 << 20);
  assert.equal(getDecompressMaxRequestBodyBytes(env({ MAX_REQUEST_BODY_MB: "1" })), 1 << 20);
  assert.equal(getDecompressMaxRequestBodyBytes(env({ MAX_REQUEST_BODY_MB: "0" })), 32 << 20);
  assert.equal(getDecompressMaxRequestBodyBytes(env({ MAX_REQUEST_BODY_MB: "-1" })), 32 << 20);
  assert.equal(decompressRequestApplies("POST"), true);
  assert.equal(decompressRequestApplies("PUT"), true);
  assert.equal(decompressRequestApplies("HEAD"), true);
  assert.equal(decompressRequestApplies("GET"), false);
  assert.equal(gzipNewReaderFailed(new Uint8Array()), true);
  assert.equal(gzipNewReaderFailed(new TextEncoder().encode("not-gzip")), true);
  assert.equal(gzipNewReaderFailed(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0])), false);
  const gz = gzipSync(Buffer.from('{"model":"gpt-4"}'));
  assert.equal(gzipNewReaderFailed(new Uint8Array(gz)), false);
});

test("original DecompressRequestMiddleware leftover empty HTTP 400 on gzip.NewReader fail", async () => {
  resetSchemaFlag();
  const e = env();

  empty400(
    await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-encoding": "gzip", "content-type": "application/json" },
        body: "not-gzip",
      }),
      e,
    ),
  );
  empty400(
    await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-encoding": "gzip" },
      }),
      e,
    ),
  );
  empty400(
    await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: new Uint8Array([0x1f, 0x8b]),
      }),
      e,
    ),
  );
  empty400(
    await send(
      new Request("http://local/pg/chat/completions", {
        method: "POST",
        headers: { "content-encoding": "gzip", "content-type": "application/json" },
        body: "not-gzip",
      }),
      e,
    ),
  );
});

test("original DecompressRequestMiddleware GET skip, registered /api skip, and br/zstd no open-fail", async () => {
  resetSchemaFlag();
  const e = env();

  const models = await send(
    new Request("http://local/v1/models", {
      headers: { "content-encoding": "gzip" },
    }),
    e,
  );
  assert.notEqual(models.res.status, 400, models.text);
  assert.notEqual(models.text, "");

  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.216",
      },
      body: "not-gzip",
    }),
    e,
  );
  assert.notEqual(login.res.status, 400, login.text);
  assert.notEqual(login.text, "");
  assert.match(login.text, /"success":false/);

  const br = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-encoding": "br", "content-type": "application/json" },
      body: "not-brotli",
    }),
    e,
  );
  assert.notEqual(br.res.status, 400, br.text);
  assert.notEqual(br.text, "");

  const zstd = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-encoding": "zstd", "content-type": "application/json" },
      body: "not-zstd",
    }),
    e,
  );
  assert.notEqual(zstd.res.status, 400, zstd.text);
  assert.notEqual(zstd.text, "");
});

test("original DecompressRequestMiddleware Del Content-Encoding after gzip decompress", async () => {
  resetSchemaFlag();
  const e = env();
  const payload = { model: "gpt-4", messages: [] as unknown[] };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
  const unpacked = await decompressRequest(
    e,
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      body: gz,
    }),
  );
  assert.equal(unpacked.error, undefined);
  assert.equal(unpacked.req.headers.get("content-encoding"), null);
  assert.deepEqual(await unpacked.req.json(), payload);

  const hit = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      body: gzipSync(Buffer.from(JSON.stringify(payload))),
    }),
    e,
  );
  assert.notEqual(hit.res.status, 400, hit.text);
  assert.notEqual(hit.text, "");
  const body = JSON.parse(hit.text) as { error?: { message?: string } };
  assert.ok(body.error?.message);
});

test("original DecompressRequestMiddleware Abort before RelayNotFound and OPTIONS skip", async () => {
  resetSchemaFlag();
  const e = env();

  empty400(
    await send(
      new Request("http://local/v1/not-a-registered-relay", {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: "not-gzip",
      }),
      e,
    ),
  );

  const options = await send(
    new Request("http://local/v1/chat/completions", {
      method: "OPTIONS",
      headers: { "content-encoding": "gzip" },
      body: "not-gzip",
    }),
    e,
  );
  assert.equal(options.res.status, 204, options.text);
  assert.equal(options.text, "");

  const uncompressed = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4"}',
    }),
    e,
  );
  assert.notEqual(uncompressed.res.status, 400, uncompressed.text);
  assert.notEqual(uncompressed.text, "");
});
