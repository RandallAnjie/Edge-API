import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  DEFAULT_UMAMI_SCRIPT_URL,
  GOOGLE_ANALYTICS_PLACEHOLDER,
  GOOGLE_ANALYTICS_QUANTUMNOUS_COMMENT,
  INDEX_PAGE_CONTENT_TYPE,
  UMAMI_PLACEHOLDER,
  UMAMI_QUANTUMNOUS_COMMENT,
  embedFolderExists,
  injectGoogleAnalytics,
  injectIndexAnalytics,
  injectUmamiAnalytics,
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
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

function assetsFrom(files: Record<string, string>): AssetsBinding {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
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

test("original InjectUmamiAnalytics and InjectGoogleAnalytics ReplaceAll", () => {
  assert.equal(embedFolderExists("/"), false);
  assert.equal(embedFolderExists("/index.html"), true);
  assert.equal(embedFolderExists("/console"), true);
  assert.equal(DEFAULT_UMAMI_SCRIPT_URL, "https://analytics.umami.is/script.js");
  assert.equal(INDEX_PAGE_CONTENT_TYPE, "text/html; charset=utf-8");

  const empty = injectIndexAnalytics(INDEX, {});
  assert.equal(empty.includes(UMAMI_PLACEHOLDER), false);
  assert.equal(empty.includes(GOOGLE_ANALYTICS_PLACEHOLDER), false);
  assert.equal(empty.includes(UMAMI_QUANTUMNOUS_COMMENT), true);
  assert.equal(empty.includes(GOOGLE_ANALYTICS_QUANTUMNOUS_COMMENT), true);
  assert.equal(empty.includes("<script"), false);

  const umami = injectUmamiAnalytics(UMAMI_PLACEHOLDER, { UMAMI_WEBSITE_ID: "wid-1" });
  assert.equal(
    umami,
    `<script defer src="${DEFAULT_UMAMI_SCRIPT_URL}" data-website-id="wid-1"></script>${UMAMI_QUANTUMNOUS_COMMENT}`,
  );
  const custom = injectUmamiAnalytics(UMAMI_PLACEHOLDER, {
    UMAMI_WEBSITE_ID: "wid-2",
    UMAMI_SCRIPT_URL: "https://stats.example/script.js",
  });
  assert.equal(
    custom,
    `<script defer src="https://stats.example/script.js" data-website-id="wid-2"></script>${UMAMI_QUANTUMNOUS_COMMENT}`,
  );
  assert.equal(injectUmamiAnalytics(UMAMI_PLACEHOLDER, { UMAMI_WEBSITE_ID: "" }), UMAMI_QUANTUMNOUS_COMMENT);

  const ga = injectGoogleAnalytics(GOOGLE_ANALYTICS_PLACEHOLDER, { GOOGLE_ANALYTICS_ID: "G-TEST1" });
  assert.equal(
    ga,
    `<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST1"></script>` +
      `<script>window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}` +
      `gtag('js', new Date());gtag('config', 'G-TEST1');</script>${GOOGLE_ANALYTICS_QUANTUMNOUS_COMMENT}`,
  );
  assert.equal(injectGoogleAnalytics(GOOGLE_ANALYTICS_PLACEHOLDER, {}), GOOGLE_ANALYTICS_QUANTUMNOUS_COMMENT);

  const doubled = `${UMAMI_PLACEHOLDER}${UMAMI_PLACEHOLDER}`;
  assert.equal(
    injectUmamiAnalytics(doubled, {}),
    `${UMAMI_QUANTUMNOUS_COMMENT}${UMAMI_QUANTUMNOUS_COMMENT}`,
  );
});

test("original IndexPage leftover injects analytics on / and SPA, not static /index.html", async () => {
  resetSchemaFlag();
  const e = env({
    UMAMI_WEBSITE_ID: "site-hop345",
    UMAMI_SCRIPT_URL: "https://umami.example/script.js",
    GOOGLE_ANALYTICS_ID: "G-HOP345",
    ASSETS: assetsFrom({
      "/": "<html>must-not-serve-root-static</html>",
      "/index.html": INDEX,
      "/static/js/index.js": "console.log(1);\n<!--umami-->\n",
    }),
  });

  const root = await send(new Request("http://local/"), e);
  assert.equal(root.res.status, 200, root.text);
  assert.equal(root.res.headers.get("content-type"), INDEX_PAGE_CONTENT_TYPE);
  assert.equal(root.text.includes("must-not-serve-root-static"), false);
  assert.equal(root.text.includes(UMAMI_PLACEHOLDER), false);
  assert.equal(root.text.includes(GOOGLE_ANALYTICS_PLACEHOLDER), false);
  assert.match(root.text, /data-website-id="site-hop345"/);
  assert.match(root.text, /src="https:\/\/umami\.example\/script\.js"/);
  assert.match(root.text, /gtag\/js\?id=G-HOP345/);
  assert.match(root.text, /Umami QuantumNous/);
  assert.match(root.text, /Google Analytics QuantumNous/);

  const spa = await send(new Request("http://local/console"), e);
  assert.equal(spa.res.status, 200, spa.text);
  assert.equal(spa.text, root.text);
  assert.equal(spa.res.headers.get("content-type"), INDEX_PAGE_CONTENT_TYPE);
  assert.equal(spa.res.headers.get("cache-control"), "no-cache");

  const empty = env({ ASSETS: assetsFrom({ "/index.html": INDEX }) });
  const comments = await send(new Request("http://local/security"), empty);
  assert.equal(comments.res.status, 200, comments.text);
  assert.equal(comments.text.includes("<script"), false);
  assert.match(comments.text, /Umami QuantumNous/);
  assert.match(comments.text, /Google Analytics QuantumNous/);

  const file = await send(new Request("http://local/index.html"), e);
  assert.equal(file.res.status, 200, file.text);
  assert.equal(file.text, INDEX);
  assert.equal(file.text.includes("Umami QuantumNous"), false);
  assert.equal(file.res.headers.get("content-type"), "text/html");

  const js = await send(new Request("http://local/static/js/index.js"), e);
  assert.equal(js.res.status, 200, js.text);
  assert.equal(js.text, "console.log(1);\n<!--umami-->\n");
  assert.equal(js.text.includes("Umami QuantumNous"), false);
  assert.equal(js.res.headers.get("content-type"), "text/javascript");
});

test("original IndexPage leftover does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env({ ASSETS: assetsFrom({ "/index.html": INDEX }) });
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.46" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.47", "x-oneapi-request-id": "hop345-vendor-create" },
      body: JSON.stringify({ name: "index-analytics-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop345-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
