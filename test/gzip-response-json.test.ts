import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  GZIP_DEFAULT_COMPRESSION,
  GZIP_EXCLUDED_EXTENSIONS,
  gzipPathExt,
  gzipShouldCompress,
} from "../src/gzip-response.js";
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
  return { res, body, text, buf, encoding };
}

function gzipReq(url: string, extra: RequestInit = {}): Request {
  const headers = new Headers(extra.headers);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip");
  return new Request(url, { ...extra, headers });
}

function assetsFrom(files: Record<string, string>): AssetsBinding {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = files[path];
      if (body == null) return new Response("missing", { status: 404 });
      const type = path.endsWith(".png") ? "image/png" : "text/html";
      return new Response(body, { status: 200, headers: { "content-type": type } });
    },
  };
}

test("original gin-contrib gzip v0.0.6 shouldCompress, Ext, and DefaultCompression", () => {
  assert.equal(GZIP_DEFAULT_COMPRESSION, -1);
  assert.deepEqual([...GZIP_EXCLUDED_EXTENSIONS], [".png", ".gif", ".jpeg", ".jpg"]);
  assert.equal(gzipPathExt("/logo.png"), ".png");
  assert.equal(gzipPathExt("/a/b.jpeg"), ".jpeg");
  assert.equal(gzipPathExt("/api/status"), "");
  assert.equal(gzipPathExt("/foo.PNG"), ".PNG");
  assert.equal(gzipShouldCompress(gzipReq("http://local/api/status")), true);
  assert.equal(gzipShouldCompress(new Request("http://local/api/status")), false);
  assert.equal(gzipShouldCompress(gzipReq("http://local/logo.png")), false);
  assert.equal(
    gzipShouldCompress(gzipReq("http://local/api/status", { headers: { connection: "Upgrade" } })),
    false,
  );
  assert.equal(
    gzipShouldCompress(gzipReq("http://local/api/status", { headers: { accept: "text/event-stream" } })),
    false,
  );
});

test("original gzip.Gzip leftover Content-Encoding on /api when Accept-Encoding contains gzip", async () => {
  resetSchemaFlag();
  const e = env();
  const plain = await send(new Request("http://local/api/status"), e);
  assert.equal(plain.res.status, 200, plain.text);
  assert.equal(plain.encoding, null);
  assert.equal(plain.body.success, true);
  assert.equal(plain.res.headers.get("vary"), null);

  const gz = await send(gzipReq("http://local/api/status"), e);
  assert.equal(gz.res.status, 200, gz.text);
  assert.equal(gz.encoding, "gzip");
  assert.equal(gz.res.headers.get("vary"), "Accept-Encoding");
  assert.equal(gz.res.headers.get("content-length"), String(gz.buf.byteLength));
  assert.equal(gz.body.success, true);
  assert.ok(gz.buf.byteLength > 0);
  assert.notEqual(gz.buf[0], "{".charCodeAt(0));
});

test("original gzip.Gzip stays off registered relay /pg and on unmatched /v1 NoRoute", async () => {
  resetSchemaFlag();
  const e = env();

  const chat = await send(gzipReq("http://local/v1/chat/completions", { method: "POST" }), e);
  assert.notEqual(chat.encoding, "gzip", chat.text);
  assert.ok(chat.body.error);

  const pg = await send(gzipReq("http://local/pg/chat/completions", { method: "POST" }), e);
  assert.notEqual(pg.encoding, "gzip", pg.text);

  const unknown = await send(gzipReq("http://local/v1/not-a-route", { method: "POST" }), e);
  assert.equal(unknown.encoding, "gzip", unknown.text);
  assert.match(unknown.text, /Invalid URL/);

  const options = await send(gzipReq("http://local/api/status", { method: "OPTIONS" }), e);
  assert.equal(options.res.status, 204, options.text);
  assert.notEqual(options.encoding, "gzip");
  assert.equal(options.text, "");
});

test("original gzip.Gzip leftover on web NoRoute SPA and excluded image extension", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    ASSETS: assetsFrom({
      "/index.html": "<html>spa</html>",
      "/logo.png": "PNGDATA",
    }),
  });

  const spa = await send(gzipReq("http://local/security"), e);
  assert.equal(spa.res.status, 200, spa.text);
  assert.equal(spa.encoding, "gzip");
  assert.equal(spa.text, "<html>spa</html>");
  assert.equal(spa.res.headers.get("vary"), "Accept-Encoding");

  const png = await send(gzipReq("http://local/logo.png"), e);
  assert.equal(png.res.status, 200, png.text);
  assert.notEqual(png.encoding, "gzip");
  assert.equal(png.text, "PNGDATA");
});
