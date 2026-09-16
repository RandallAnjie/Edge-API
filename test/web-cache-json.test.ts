import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  WEB_CACHE_VERSION,
  requestURI,
  webCacheControl,
} from "../src/web-cache.js";
import type { AssetsBinding, Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  return { res, text };
}

function assetsFrom(files: Record<string, string>): AssetsBinding {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = files[path];
      if (body == null) return new Response("missing", { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    },
  };
}

test("original Cache leftover uses RequestURI / for no-cache and hashed Cache-Version", () => {
  assert.equal(WEB_CACHE_VERSION, "b688f2fb5be447c25e5aa3bd063087a83db32a288bf6a4f35f2d8db310e40b14");
  assert.equal(webCacheControl("/"), "no-cache");
  assert.equal(webCacheControl("/console"), "max-age=604800");
  assert.equal(webCacheControl("/static/js/index.js"), "max-age=604800");
  assert.equal(webCacheControl("/?x=1"), "max-age=604800");
  assert.equal(requestURI(new Request("http://local/")), "/");
  assert.equal(requestURI(new Request("http://local/?x=1")), "/?x=1");
});

test("original Cache leftover no-cache on / and max-age on static ASSETS", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    ASSETS: assetsFrom({
      "/": "<html>root-static-must-not-serve</html>",
      "/index.html": "<html>root</html>",
      "/static/js/index.js": "console.log(1)",
    }),
  });
  const root = await send(new Request("http://local/"), e);
  assert.equal(root.res.status, 200, root.text);
  assert.equal(root.text, "<html>root</html>");
  assert.equal(root.res.headers.get("cache-control"), "no-cache");
  assert.equal(root.res.headers.get("cache-version"), WEB_CACHE_VERSION);

  const asset = await send(new Request("http://local/static/js/index.js"), e);
  assert.equal(asset.res.status, 200, asset.text);
  assert.equal(asset.res.headers.get("cache-control"), "max-age=604800");
  assert.equal(asset.res.headers.get("cache-version"), WEB_CACHE_VERSION);
});

test("original Cache leftover SPA fallback overwrites Cache-Control to no-cache", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    ASSETS: assetsFrom({ "/index.html": "<html>spa</html>" }),
  });
  const page = await send(new Request("http://local/security"), e);
  assert.equal(page.res.status, 200, page.text);
  assert.equal(page.text, "<html>spa</html>");
  assert.equal(page.res.headers.get("cache-control"), "no-cache");
  assert.equal(page.res.headers.get("cache-version"), WEB_CACHE_VERSION);
  assert.ok(!String(page.res.headers.get("cache-control")).includes("604800"));
});

test("original Cache leftover RelayNotFound keeps Cache-Version and no-store Cache-Control", async () => {
  resetSchemaFlag();
  const e = env();
  const unknown = await send(new Request("http://local/v1/not-a-registered-route"), e);
  assert.equal(unknown.res.status, 404, unknown.text);
  assert.match(unknown.text, /Invalid URL \(GET \/v1\/not-a-registered-route\)/);
  assert.equal(unknown.res.headers.get("cache-control"), "no-store, no-cache, must-revalidate, private, max-age=0");
  assert.equal(unknown.res.headers.get("cache-version"), WEB_CACHE_VERSION);
  assert.ok(!String(unknown.res.headers.get("cache-control")).includes("604800"));

  const unknownApi = await send(new Request("http://local/api/not-a-cache-route"), e);
  assert.equal(unknownApi.res.status, 404, unknownApi.text);
  assert.equal(unknownApi.res.headers.get("cache-control"), "no-store, no-cache, must-revalidate, private, max-age=0");
  assert.equal(unknownApi.res.headers.get("cache-version"), WEB_CACHE_VERSION);
});

test("original Cache leftover does not apply to registered /api or GlobalWebRateLimit 429", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_WEB_RATE_LIMIT: "1", GLOBAL_WEB_RATE_LIMIT_DURATION: "30" });
  const status = await send(new Request("http://local/api/status", { headers: { "cf-connecting-ip": "192.0.2.60" } }), e);
  assert.equal(status.res.status, 200, status.text);
  assert.equal(status.res.headers.get("cache-version"), null);
  assert.notEqual(status.res.headers.get("cache-control"), "max-age=604800");

  const ip = "192.0.2.61";
  assert.equal((await send(new Request("http://local/console", { headers: { "cf-connecting-ip": ip } }), e)).res.status, 404);
  const limited = await send(new Request("http://local/console", { headers: { "cf-connecting-ip": ip } }), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.equal(limited.res.headers.get("cache-version"), null);
  assert.equal(limited.res.headers.get("retry-after"), "30");
});
