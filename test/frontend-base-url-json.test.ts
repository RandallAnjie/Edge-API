import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  FRONTEND_BASE_URL_CONTENT_TYPE,
  FRONTEND_BASE_URL_STATUS,
  FRONTEND_BASE_URL_STATUS_TEXT,
  frontendBaseUrl,
  frontendBaseUrlLocation,
  frontendBaseUrlRedirectApplies,
  frontendBaseUrlRedirectBody,
  htmlEscapeString,
  isMasterNode,
  requestURI,
  trimFrontendBaseUrl,
  writeFrontendBaseUrlRedirect,
} from "../src/frontend-base-url.js";
import type { AssetsBinding, Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
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

test("original FRONTEND_BASE_URL master ignore, TrimSuffix, RequestURI, html.EscapeString", () => {
  assert.equal(FRONTEND_BASE_URL_STATUS, 301);
  assert.equal(FRONTEND_BASE_URL_STATUS_TEXT, "Moved Permanently");
  assert.equal(FRONTEND_BASE_URL_CONTENT_TYPE, "text/html; charset=utf-8");
  assert.equal(isMasterNode({}), true);
  assert.equal(isMasterNode({ NODE_TYPE: "master" }), true);
  assert.equal(isMasterNode({ NODE_TYPE: "slave" }), false);
  assert.equal(trimFrontendBaseUrl("https://ui.example.com/"), "https://ui.example.com");
  assert.equal(trimFrontendBaseUrl("https://ui.example.com"), "https://ui.example.com");
  assert.equal(frontendBaseUrl({ FRONTEND_BASE_URL: "https://ui.example.com/" }), "");
  assert.equal(frontendBaseUrl({ NODE_TYPE: "slave", FRONTEND_BASE_URL: "https://ui.example.com/" }), "https://ui.example.com");
  assert.equal(frontendBaseUrlRedirectApplies({ NODE_TYPE: "slave" }), false);
  assert.equal(
    frontendBaseUrlRedirectApplies({ NODE_TYPE: "slave", FRONTEND_BASE_URL: "https://ui.example.com" }),
    true,
  );
  const req = new Request("http://local/console?x=1&y=2");
  assert.equal(requestURI(req), "/console?x=1&y=2");
  assert.equal(
    frontendBaseUrlLocation("https://ui.example.com/", req),
    "https://ui.example.com/console?x=1&y=2",
  );
  assert.equal(htmlEscapeString(`https://ui.example.com/a?x=1&y="z"`), "https://ui.example.com/a?x=1&amp;y=&#34;z&#34;");
  const location = "https://ui.example.com/console?x=1&y=2";
  assert.equal(
    frontendBaseUrlRedirectBody(location),
    `<a href="https://ui.example.com/console?x=1&amp;y=2">Moved Permanently</a>.\n\n`,
  );
  const written = writeFrontendBaseUrlRedirect("https://ui.example.com/", req);
  assert.equal(written.status, 301);
  assert.equal(written.headers.get("location"), location);
  assert.equal(written.headers.get("content-type"), FRONTEND_BASE_URL_CONTENT_TYPE);
});

test("original slave FRONTEND_BASE_URL leftover HTTP 301 Location and HTML body", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { NODE_TYPE: "slave", FRONTEND_BASE_URL: "https://ui.example.com/" });
  const hit = await send(new Request("http://local/console?x=1&y=2"), e);
  assert.equal(hit.res.status, 301, hit.text);
  assert.equal(hit.res.headers.get("location"), "https://ui.example.com/console?x=1&y=2");
  assert.equal(hit.res.headers.get("content-type"), FRONTEND_BASE_URL_CONTENT_TYPE);
  assert.equal(hit.encoding, null);
  assert.equal(hit.text, `<a href="https://ui.example.com/console?x=1&amp;y=2">Moved Permanently</a>.\n\n`);
});

test("original slave FRONTEND_BASE_URL 301 unmatched /v1 /api; registered /api/status stays", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { NODE_TYPE: "slave", FRONTEND_BASE_URL: "https://ui.example.com" });
  const v1 = await send(new Request("http://local/v1/not-a-registered-route"), e);
  assert.equal(v1.res.status, 301, v1.text);
  assert.equal(v1.res.headers.get("location"), "https://ui.example.com/v1/not-a-registered-route");
  assert.equal("error" in v1.body, false);

  const apiMiss = await send(new Request("http://local/api/not-a-registered-route"), e);
  assert.equal(apiMiss.res.status, 301, apiMiss.text);
  assert.equal(apiMiss.res.headers.get("location"), "https://ui.example.com/api/not-a-registered-route");

  const status = await send(new Request("http://local/api/status"), e);
  assert.equal(status.res.status, 200, status.text);
  assert.equal(status.body.success, true);
});

test("original FRONTEND_BASE_URL HEAD/POST bodies, gzip skip, master still SPA", async () => {
  resetSchemaFlag();
  const slave = env(createMemoryD1(), { NODE_TYPE: "slave", FRONTEND_BASE_URL: "https://ui.example.com" });
  const head = await send(new Request("http://local/console", { method: "HEAD" }), slave);
  assert.equal(head.res.status, 301, head.text);
  assert.equal(head.res.headers.get("location"), "https://ui.example.com/console");
  assert.equal(head.res.headers.get("content-type"), FRONTEND_BASE_URL_CONTENT_TYPE);
  assert.equal(head.text, "");

  const post = await send(new Request("http://local/console", { method: "POST" }), slave);
  assert.equal(post.res.status, 301, post.text);
  assert.equal(post.res.headers.get("location"), "https://ui.example.com/console");
  assert.equal(post.res.headers.get("content-type"), null);
  assert.equal(post.text, "");

  const gzipped = await send(
    new Request("http://local/console", { headers: { "accept-encoding": "gzip" } }),
    slave,
  );
  assert.equal(gzipped.res.status, 301, gzipped.text);
  assert.equal(gzipped.encoding, null);

  const master = env(createMemoryD1(), {
    FRONTEND_BASE_URL: "https://ui.example.com",
    ASSETS: assetsFrom({ "/index.html": "<html>spa</html>" }),
  });
  const spa = await send(new Request("http://local/console"), master);
  assert.equal(spa.res.status, 200, spa.text);
  assert.match(spa.text, /spa/);
});
