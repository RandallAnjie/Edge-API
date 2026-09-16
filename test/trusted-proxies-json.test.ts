import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY } from "../src/email-verification-rate-limit.js";
import { AUDIT_CATEGORY_LOGIN } from "../src/admin-operation-audit.js";
import {
  DEFAULT_TRUSTED_PROXY_CIDRS,
  ginClientIP,
  resolveTrustedProxies,
} from "../src/trusted-proxies.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
}

function req(headers: Record<string, string>): Request {
  return new Request("http://local/api/status", { headers });
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
  return { auth };
}

test("original ResolveTrustedProxies blank none explicit and invalid", () => {
  assert.deepEqual(DEFAULT_TRUSTED_PROXY_CIDRS, [
    "127.0.0.0/8",
    "::1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
  ]);
  const blank = resolveTrustedProxies("");
  assert.equal(blank.usedDefaults, true);
  assert.equal(blank.error, null);
  assert.deepEqual(blank.proxies, [...DEFAULT_TRUSTED_PROXY_CIDRS]);
  const none = resolveTrustedProxies(" NoNe ");
  assert.equal(none.usedDefaults, false);
  assert.equal(none.error, null);
  assert.equal(none.proxies, null);
  const listed = resolveTrustedProxies(" 192.0.2.0/24, 198.51.100.30 ");
  assert.deepEqual(listed.proxies, ["192.0.2.0/24", "198.51.100.30"]);
  assert.equal(resolveTrustedProxies("none,127.0.0.1").error, "TRUSTED_PROXIES=none must be used alone");
  assert.equal(resolveTrustedProxies(", ,").error, "TRUSTED_PROXIES does not contain an IP address or CIDR");
});

test("original gin ClientIP leftover trusted-proxy walk vs public peer", () => {
  const defaults = { TRUSTED_PROXIES: "" };
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.10" }), defaults),
    "203.0.113.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "10.20.30.40", "x-forwarded-for": "203.0.113.10" }), defaults),
    "203.0.113.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "172.20.0.2", "x-forwarded-for": "192.0.2.99, 203.0.113.10" }), defaults),
    "203.0.113.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "192.168.10.2", "x-forwarded-for": "203.0.113.10" }), defaults),
    "203.0.113.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "::1", "x-forwarded-for": "203.0.113.10" }), defaults),
    "203.0.113.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "fd12:3456::2", "x-forwarded-for": "203.0.113.10" }), defaults),
    "203.0.113.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "198.51.100.10", "x-forwarded-for": "203.0.113.10" }), defaults),
    "198.51.100.10",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.10" }), { TRUSTED_PROXIES: "none" }),
    "127.0.0.1",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "192.0.2.10", "x-forwarded-for": "203.0.113.20" }), {
      TRUSTED_PROXIES: " 192.0.2.0/24, 198.51.100.30 ",
    }),
    "203.0.113.20",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "198.51.100.30", "x-forwarded-for": "203.0.113.21" }), {
      TRUSTED_PROXIES: "192.0.2.0/24,198.51.100.30",
    }),
    "203.0.113.21",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "198.51.100.20", "x-forwarded-for": "203.0.113.22" }), {
      TRUSTED_PROXIES: "192.0.2.0/24,198.51.100.30",
    }),
    "198.51.100.20",
  );
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.23" }), {
      TRUSTED_PROXIES: "192.0.2.0/24",
    }),
    "127.0.0.1",
  );
  assert.equal(ginClientIP(req({ "x-real-ip": "10.0.0.1" }), defaults), "10.0.0.1");
  assert.equal(ginClientIP(req({ "cf-connecting-ip": "login-audit-1" }), defaults), "login-audit-1");
  assert.equal(
    ginClientIP(req({ "cf-connecting-ip": "127.0.0.1", "x-real-ip": "203.0.113.40" }), defaults),
    "203.0.113.40",
  );
});

test("original ClientIP leftover EmailVerificationRateLimit keys follow X-Forwarded-For from a trusted peer", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e, { "cf-connecting-ip": "192.0.2.40" });
  const peer = { "cf-connecting-ip": "127.0.0.1" };

  const first = await send(
    new Request("http://local/api/verification?email=not-an-email", {
      headers: { ...peer, "x-forwarded-for": "203.0.113.50" },
    }),
    e,
  );
  assert.equal(first.res.status, 200, first.text);
  const second = await send(
    new Request("http://local/api/verification?email=also-bad", {
      headers: { ...peer, "x-forwarded-for": "203.0.113.50" },
    }),
    e,
  );
  assert.equal(second.res.status, 200, second.text);
  const third = await send(
    new Request("http://local/api/verification?email=still-bad", {
      headers: { ...peer, "x-forwarded-for": "203.0.113.50" },
    }),
    e,
  );
  assert.equal(third.res.status, 429, third.text);
  assert.equal(third.body.message, MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);
  assert.equal("data" in third.body, false);

  const other = await send(
    new Request("http://local/api/verification?email=not-an-email", {
      headers: { ...peer, "x-forwarded-for": "203.0.113.51" },
    }),
    e,
  );
  assert.equal(other.res.status, 200, other.text);
  assert.equal(other.body.code, "EMAIL_ADDRESS_REJECTED");

  const spoofed = await send(
    new Request("http://local/api/verification?email=not-an-email", {
      headers: { "cf-connecting-ip": "198.51.100.10", "x-forwarded-for": "203.0.113.50" },
    }),
    e,
  );
  assert.equal(spoofed.res.status, 200, spoofed.text);
});

test("original ClientIP leftover login audit ip uses X-Forwarded-For from a trusted peer", async () => {
  resetSchemaFlag();
  const e = env();
  const setupHeaders = { "content-type": "application/json", "cf-connecting-ip": "192.0.2.41" };
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: setupHeaders,
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const okRid = "trusted-proxy-login-ip";
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "127.0.0.1",
        "x-forwarded-for": "192.0.2.99, 203.0.113.60",
        "x-oneapi-request-id": okRid,
      },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(login.body.success, true, login.text);
  const token = (login.body.data as { access_token: string }).access_token;
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=" + encodeURIComponent(okRid), {
      headers: { authorization: "Bearer " + token },
    }),
    e,
  );
  assert.equal(listed.body.success, true, listed.text);
  const items = ((listed.body.data as { items: { category: string; action: string; ip: string }[] }).items || []);
  const row = items.find((item) => item.category === AUDIT_CATEGORY_LOGIN && item.action === "login");
  assert.ok(row, listed.text);
  assert.equal(row!.ip, "203.0.113.60");
});

test("original TRUSTED_PROXIES=none leftover ignores X-Forwarded-For even from loopback", async () => {
  resetSchemaFlag();
  const e = env({ TRUSTED_PROXIES: "none" });
  await boot(e, { "cf-connecting-ip": "192.0.2.42" });
  const okRid = "trusted-proxy-none-ip";
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "127.0.0.1",
        "x-forwarded-for": "203.0.113.70",
        "x-oneapi-request-id": okRid,
      },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(login.body.success, true, login.text);
  const token = (login.body.data as { access_token: string }).access_token;
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=" + encodeURIComponent(okRid), {
      headers: { authorization: "Bearer " + token, "cf-connecting-ip": "192.0.2.43" },
    }),
    e,
  );
  const items = ((listed.body.data as { items: { category: string; action: string; ip: string }[] }).items || []);
  const row = items.find((item) => item.category === AUDIT_CATEGORY_LOGIN && item.action === "login");
  assert.ok(row, listed.text);
  assert.equal(row!.ip, "127.0.0.1");
});

test("original ClientIP leftover does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.44" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.45", "x-oneapi-request-id": "hop344-vendor-create" },
      body: JSON.stringify({ name: "trusted-proxy-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop344-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
