import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  GOOGLE_ANALYTICS_PLACEHOLDER,
  INDEX_PAGE_CONTENT_TYPE,
  UMAMI_PLACEHOLDER,
  noRouteIndexPageAssetRequest,
} from "../src/index-analytics.js";
import type { AssetsBinding, Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const buf = new Uint8Array(await res.arrayBuffer());
  const encoding = res.headers.get("content-encoding");
  const text = encoding === "gzip" ? gunzipSync(buf).toString("utf8") : new TextDecoder().decode(buf);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text, encoding };
}

function assetsFrom(files: Record<string, string>, seen?: string[]): AssetsBinding {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen?.push(`${req.method} ${path}`);
      const body = files[path];
      if (body == null) return new Response("missing", { status: 404 });
      const type = path.endsWith(".js") ? "text/javascript" : "text/html";
      return new Response(body, { status: 200, headers: { "content-type": type } });
    },
  };
}

const INDEX = `<!doctype html>
<html>
  <head>
    ${UMAMI_PLACEHOLDER}${GOOGLE_ANALYTICS_PLACEHOLDER}  </head>
  <body><div id="root"></div></body>
</html>
`;

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
  return { auth };
}

test("original NoRoute IndexPage leftover loads /index.html as GET for any method", () => {
  const post = noRouteIndexPageAssetRequest(
    new Request("http://local/console?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  );
  assert.equal(post.method, "GET");
  assert.equal(new URL(post.url).pathname, "/index.html");
  assert.equal(new URL(post.url).search, "");

  const head = noRouteIndexPageAssetRequest(new Request("http://local/", { method: "HEAD" }));
  assert.equal(head.method, "GET");
  assert.equal(new URL(head.url).pathname, "/index.html");
});

test("original NoRoute leftover IndexPage any method vs RelayNotFound prefixes", async () => {
  resetSchemaFlag();
  const seen: string[] = [];
  const e = env({
    UMAMI_WEBSITE_ID: "site-hop352",
    ASSETS: assetsFrom(
      {
        "/": "<html>must-not-serve-root-static</html>",
        "/index.html": INDEX,
        "/static/js/index.js": "console.log(1)",
      },
      seen,
    ),
  });

  const getRoot = await send(new Request("http://local/"), e);
  assert.equal(getRoot.res.status, 200, getRoot.text);
  assert.equal(getRoot.res.headers.get("content-type"), INDEX_PAGE_CONTENT_TYPE);
  assert.equal(getRoot.res.headers.get("cache-control"), "no-cache");
  assert.equal(getRoot.text.includes("must-not-serve-root-static"), false);
  assert.match(getRoot.text, /data-website-id="site-hop352"/);

  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const hit = await send(new Request("http://local/", { method }), e);
    assert.equal(hit.res.status, 200, method + " / " + hit.text);
    assert.equal(hit.text, getRoot.text, method + " / body");
    assert.equal(hit.res.headers.get("content-type"), INDEX_PAGE_CONTENT_TYPE);
    assert.equal(hit.res.headers.get("cache-control"), "no-cache");
  }

  const getSpa = await send(new Request("http://local/console"), e);
  assert.equal(getSpa.res.status, 200, getSpa.text);
  assert.equal(getSpa.text, getRoot.text);

  const postSpa = await send(new Request("http://local/console", { method: "POST", body: "ignored" }), e);
  assert.equal(postSpa.res.status, 200, postSpa.text);
  assert.equal(postSpa.text, getRoot.text);
  assert.ok(seen.includes("GET /index.html"), String(seen));
  assert.equal(seen.includes("POST /index.html"), false, String(seen));
  assert.ok(seen.includes("POST /console"), String(seen));

  const putSpa = await send(new Request("http://local/security", { method: "PUT" }), e);
  assert.equal(putSpa.res.status, 200, putSpa.text);
  assert.equal(putSpa.text, getRoot.text);

  const options = await send(new Request("http://local/", { method: "OPTIONS" }), e);
  assert.equal(options.res.status, 204, options.text);
  assert.equal(options.text, "");

  const file = await send(new Request("http://local/index.html"), e);
  assert.equal(file.res.status, 200, file.text);
  assert.equal(file.text, INDEX);
  assert.equal(file.text.includes("Umami QuantumNous"), false);

  const postV1 = await send(new Request("http://local/v1/not-a-registered-route", { method: "POST" }), e);
  assert.equal(postV1.res.status, 404, postV1.text);
  assert.equal((postV1.body.error as { message: string }).message, "Invalid URL (POST /v1/not-a-registered-route)");

  const postApi = await send(new Request("http://local/api/not-a-registered-route", { method: "POST" }), e);
  assert.equal(postApi.res.status, 404, postApi.text);
  assert.equal((postApi.body.error as { message: string }).message, "Invalid URL (POST /api/not-a-registered-route)");

  const gzipPost = await send(
    new Request("http://local/", { method: "POST", headers: { "accept-encoding": "gzip" } }),
    e,
  );
  assert.equal(gzipPost.res.status, 200, gzipPost.text);
  assert.equal(gzipPost.encoding, "gzip");
  assert.equal(gzipPost.text, getRoot.text);

  const missingAssets = env();
  const missingHead = await send(new Request("http://local/", { method: "HEAD" }), missingAssets);
  assert.equal(missingHead.res.status, 404, missingHead.text);
  assert.equal(missingHead.text, "Not Found");
  const missingPost = await send(new Request("http://local/console", { method: "POST" }), missingAssets);
  assert.equal(missingPost.res.status, 404, missingPost.text);
  assert.equal(missingPost.text, "Not Found");
});

test("original NoRoute leftover IndexPage does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env({ ASSETS: assetsFrom({ "/index.html": INDEX }) });
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.150" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.151", "x-oneapi-request-id": "hop352-vendor-create" },
      body: JSON.stringify({ name: "noroute-indexpage-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop352-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
