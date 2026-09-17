import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  AUTH_ORIGIN_FORBIDDEN_CODE,
  AUTH_ORIGIN_FORBIDDEN_MESSAGE,
  normalizeOrigin,
  sessionCookieOriginGuardApplies,
  sessionCookieSettings,
} from "../src/session-cookie-origin.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
}

function secureEnv(trusted = "https://trusted.example.com"): Env {
  return env({ SESSION_COOKIE_SECURE: "true", SESSION_COOKIE_TRUSTED_URL: trusted });
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

function originForbidden(hit: { res: Response; body: Record<string, unknown>; text: string }) {
  assert.equal(hit.res.status, 403, hit.text);
  assert.equal(hit.body.success, false);
  assert.equal(hit.body.code, AUTH_ORIGIN_FORBIDDEN_CODE);
  assert.equal(hit.body.message, AUTH_ORIGIN_FORBIDDEN_MESSAGE);
  assert.equal("data" in hit.body, false);
  assert.deepEqual(Object.keys(hit.body).sort(), ["code", "message", "success"]);
  assert.equal(hit.res.headers.get("pragma"), null);
}

test("original SessionCookieOriginGuard applies only to refresh/logout", () => {
  assert.equal(sessionCookieOriginGuardApplies("POST", "/api/user/auth/refresh"), true);
  assert.equal(sessionCookieOriginGuardApplies("POST", "/api/user/auth/logout"), true);
  assert.equal(sessionCookieOriginGuardApplies("POST", "/api/user/auth/refresh/"), true);
  assert.equal(sessionCookieOriginGuardApplies("POST", "/api/user/login"), false);
  assert.equal(sessionCookieOriginGuardApplies("GET", "/api/user/auth/refresh"), false);
  assert.equal(normalizeOrigin("https://EXAMPLE.com:443"), "https://example.com");
  assert.equal(normalizeOrigin("https://admin.example.com:8443/"), "https://admin.example.com:8443");
  assert.equal(normalizeOrigin("null"), null);
  assert.equal(normalizeOrigin("https://panel.example.com/profile"), null);
  assert.equal(normalizeOrigin("https://user@example.com"), null);
  assert.equal(sessionCookieSettings(env()).secure, false);
  assert.equal(sessionCookieSettings(env({ SESSION_COOKIE_SECURE: "false" })).secure, false);
  assert.equal(sessionCookieSettings(env({ SESSION_COOKIE_SECURE: "true" })).secure, false);
  assert.equal(sessionCookieSettings(env({ SESSION_COOKIE_TRUSTED_URL: "https://example.com" })).secure, false);
  const ok = sessionCookieSettings(secureEnv("https://EXAMPLE.com:443, https://admin.example.com:8443/"));
  assert.equal(ok.secure, true);
  assert.deepEqual(ok.trustedOrigins, ["https://example.com", "https://admin.example.com:8443"]);
});

test("original SessionCookieOriginGuard leftover AUTH_ORIGIN_FORBIDDEN gin.H", async () => {
  resetSchemaFlag();
  const e = secureEnv();

  const same = await send(
    new Request("https://panel.example.com/api/user/auth/refresh", {
      method: "POST",
      headers: { origin: "https://panel.example.com" },
    }),
    e,
  );
  assert.notEqual(same.res.status, 403, same.text);
  assert.notEqual(same.body.code, AUTH_ORIGIN_FORBIDDEN_CODE);

  const trusted = await send(
    new Request("https://panel.example.com/api/user/auth/refresh", {
      method: "POST",
      headers: { origin: "https://trusted.example.com" },
    }),
    e,
  );
  assert.notEqual(trusted.res.status, 403, trusted.text);
  assert.notEqual(trusted.body.code, AUTH_ORIGIN_FORBIDDEN_CODE);

  const referer = await send(
    new Request("https://panel.example.com/api/user/auth/refresh", {
      method: "POST",
      headers: { referer: "https://panel.example.com/profile" },
    }),
    e,
  );
  assert.notEqual(referer.res.status, 403, referer.text);
  assert.notEqual(referer.body.code, AUTH_ORIGIN_FORBIDDEN_CODE);

  originForbidden(await send(new Request("https://panel.example.com/api/user/auth/refresh", { method: "POST" }), e));
  originForbidden(
    await send(
      new Request("https://panel.example.com/api/user/auth/refresh", {
        method: "POST",
        headers: { origin: "null" },
      }),
      e,
    ),
  );
  originForbidden(
    await send(
      new Request("https://panel.example.com/api/user/auth/refresh", {
        method: "POST",
        headers: { origin: "https://trusted.example.com.evil.test" },
      }),
      e,
    ),
  );
  originForbidden(
    await send(
      new Request("https://panel.example.com/api/user/auth/refresh", {
        method: "POST",
        headers: { origin: "http://panel.example.com" },
      }),
      e,
    ),
  );
  originForbidden(
    await send(
      new Request("https://panel.example.com/api/user/auth/refresh", {
        method: "POST",
        headers: { origin: "https://panel.example.com/profile" },
      }),
      e,
    ),
  );
  originForbidden(
    await send(
      new Request("https://panel.example.com/api/user/auth/logout", {
        method: "POST",
        headers: { origin: "https://evil.example.test" },
      }),
      e,
    ),
  );
});

test("original SessionCookieOriginGuard development compatibility and forwarded proto", async () => {
  resetSchemaFlag();
  const insecure = env();
  const mismatched = await send(
    new Request("http://localhost:3000/api/user/auth/refresh", {
      method: "POST",
      headers: { origin: "http://localhost:3001" },
    }),
    insecure,
  );
  assert.notEqual(mismatched.res.status, 403, mismatched.text);
  assert.notEqual(mismatched.body.code, AUTH_ORIGIN_FORBIDDEN_CODE);

  const missing = await send(new Request("http://localhost:3000/api/user/auth/refresh", { method: "POST" }), insecure);
  assert.notEqual(missing.res.status, 403, missing.text);
  assert.equal(missing.body.code, "AUTH_UNAUTHORIZED");

  originForbidden(
    await send(
      new Request("http://localhost:3000/api/user/auth/refresh", {
        method: "POST",
        headers: { origin: "http://localhost:3001" },
      }),
      secureEnv(),
    ),
  );

  originForbidden(
    await send(
      new Request("http://panel.example.com/api/user/auth/refresh", {
        method: "POST",
        headers: { origin: "https://panel.example.com", "x-forwarded-proto": "https" },
      }),
      secureEnv(),
    ),
  );
});

test("original SessionCookieOriginGuard Abort skips CriticalRateLimit and DisableCache", async () => {
  resetSchemaFlag();
  const e = env({
    SESSION_COOKIE_SECURE: "true",
    SESSION_COOKIE_TRUSTED_URL: "https://trusted.example.com",
    CRITICAL_RATE_LIMIT: "1",
    CRITICAL_RATE_LIMIT_DURATION: "30",
  });
  const headers = { "cf-connecting-ip": "192.0.2.115" };
  const first = await send(new Request("https://panel.example.com/api/user/auth/refresh", { method: "POST", headers }), e);
  originForbidden(first);
  const second = await send(new Request("https://panel.example.com/api/user/auth/refresh", { method: "POST", headers }), e);
  originForbidden(second);
  assert.notEqual(second.res.status, 429);
});
