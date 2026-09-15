import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { s256ChallengeFromVerifier } from "../src/crypto.js";
import {
  ERR_TELEGRAM_ACCOUNT_NOT_BOUND,
  ERR_TELEGRAM_OAUTH_FAILED,
  TELEGRAM_ISSUER,
} from "../src/telegram-oauth.js";
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

async function boot(e: Env) {
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
  return { token, auth, login };
}

function b64url(data: ArrayBuffer | Uint8Array): string {
  return Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64url");
}

async function signRs256Jwt(key: CryptoKey, claims: Record<string, unknown>, kid = "telegram-test-key"): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

function telegramIdentityClaims(id: unknown): Record<string, unknown> {
  return {
    iss: TELEGRAM_ISSUER,
    aud: "12345",
    sub: "different-oidc-subject",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    id,
    name: "Telegram User",
    preferred_username: "telegram-user",
  };
}

test("original HandleOAuth telegram login JSON preserves bound account and rejects unbound", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("TelegramOAuthEnabled", "true");
  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  await store.setOption("ServerAddress", "https://example.com");
  const telegramID = "1234567890123456";
  await store.updateUser(1, { telegram_id: telegramID });

  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const grants = new Map<string, { challenge: string; claims: Record<string, unknown>; key: CryptoKey }>();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host !== "oauth.telegram.org") return origFetch(input, init);
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json({
        keys: [{ kty: "RSA", kid: "telegram-test-key", alg: "RS256", use: "sig", n: pub.n, e: pub.e }],
      });
    }
    if (url.pathname === "/token") {
      const expected = "Basic " + Buffer.from("12345:telegram-client-secret").toString("base64");
      if (req.headers.get("authorization") !== expected) return new Response("", { status: 401 });
      const form = new URLSearchParams(await req.text());
      const code = form.get("code") || "";
      const grant = grants.get(code);
      const challenge = await s256ChallengeFromVerifier(form.get("code_verifier") || "");
      if (
        !grant ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("client_id") !== "12345" ||
        form.get("redirect_uri") !== "https://example.com/oauth/telegram" ||
        challenge !== grant.challenge
      ) {
        return new Response("", { status: 400 });
      }
      grants.delete(code);
      return Response.json({
        access_token: "test-access-token",
        id_token: await signRs256Jwt(grant.key, grant.claims),
        token_type: "Bearer",
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "telegram", intent: "login" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const data = started.body.data as { flow_token: string; authorization_url: string };
    const authorizationURL = new URL(data.authorization_url);
    const code = "code-" + data.flow_token;
    grants.set(code, {
      challenge: authorizationURL.searchParams.get("code_challenge") || "",
      claims: telegramIdentityClaims(telegramID),
      key: pair.privateKey,
    });

    const login = await json(
      new Request(`http://local/api/oauth/telegram?state=${encodeURIComponent(data.flow_token)}&code=${encodeURIComponent(code)}`),
      e,
    );
    assert.equal(login.body.success, true, String(login.body.message));
    const loginData = login.body.data as { user: { id: number; telegram_id?: string }; access_token: string };
    assert.equal(loginData.user.id, 1);
    assert.equal(typeof loginData.access_token, "string");
    const bound = await store.getUserByField("telegram_id", telegramID);
    assert.equal(bound?.id, 1);

    const replay = await json(
      new Request(`http://local/api/oauth/telegram?state=${encodeURIComponent(data.flow_token)}&code=${encodeURIComponent(code)}`),
      e,
    );
    assert.equal(replay.res.status, 403);

    const unboundStart = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "telegram", intent: "login" }),
      }),
      e,
    );
    const unboundData = unboundStart.body.data as { flow_token: string; authorization_url: string };
    const unboundCode = "code-" + unboundData.flow_token;
    grants.set(unboundCode, {
      challenge: new URL(unboundData.authorization_url).searchParams.get("code_challenge") || "",
      claims: telegramIdentityClaims(999),
      key: pair.privateKey,
    });
    const unbound = await json(
      new Request(
        `http://local/api/oauth/telegram?state=${encodeURIComponent(unboundData.flow_token)}&code=${encodeURIComponent(unboundCode)}`,
      ),
      e,
    );
    assert.equal(unbound.body.success, false);
    assert.equal(unbound.body.code, "TELEGRAM_ACCOUNT_NOT_BOUND");
    assert.equal(unbound.body.message, ERR_TELEGRAM_ACCOUNT_NOT_BOUND);
    assert.equal(JSON.stringify(unbound.body).includes("test-access-token"), false);
    const count = await e.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted_at = 0").first<{ n: number }>();
    assert.equal(Number(count?.n), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original HandleOAuth telegram rejects invalid ID tokens with TELEGRAM_OAUTH_FAILED JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("TelegramOAuthEnabled", "true");
  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  await store.setOption("ServerAddress", "https://example.com");
  await store.updateUser(1, { telegram_id: "42" });

  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const grants = new Map<string, { challenge: string; claims: Record<string, unknown>; key: CryptoKey }>();
  let tokenStatus = 0;
  let jwksStatus = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host !== "oauth.telegram.org") return origFetch(input, init);
    if (url.pathname === "/.well-known/jwks.json") {
      if (jwksStatus) return new Response("", { status: jwksStatus });
      return Response.json({
        keys: [{ kty: "RSA", kid: "telegram-test-key", alg: "RS256", use: "sig", n: pub.n, e: pub.e }],
      });
    }
    if (url.pathname === "/token") {
      if (tokenStatus) return new Response("", { status: tokenStatus });
      const expected = "Basic " + Buffer.from("12345:telegram-client-secret").toString("base64");
      if (req.headers.get("authorization") !== expected) return new Response("", { status: 401 });
      const form = new URLSearchParams(await req.text());
      const code = form.get("code") || "";
      const grant = grants.get(code);
      const challenge = await s256ChallengeFromVerifier(form.get("code_verifier") || "");
      if (
        !grant ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("client_id") !== "12345" ||
        form.get("redirect_uri") !== "https://example.com/oauth/telegram" ||
        challenge !== grant.challenge
      ) {
        return new Response("", { status: 400 });
      }
      grants.delete(code);
      return Response.json({
        access_token: "test-access-token",
        id_token: await signRs256Jwt(grant.key, grant.claims),
        token_type: "Bearer",
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  async function start(claims: Record<string, unknown>, key = pair.privateKey) {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "telegram", intent: "login" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const data = started.body.data as { flow_token: string; authorization_url: string };
    const code = "code-" + data.flow_token;
    grants.set(code, {
      challenge: new URL(data.authorization_url).searchParams.get("code_challenge") || "",
      claims,
      key,
    });
    return json(
      new Request(`http://local/api/oauth/telegram?state=${encodeURIComponent(data.flow_token)}&code=${encodeURIComponent(code)}`),
      e,
    );
  }

  try {
    const cases: [string, (c: Record<string, unknown>) => void][] = [
      ["issuer", (c) => {
        c.iss = "https://other.example";
      }],
      ["audience", (c) => {
        c.aud = "other-client";
      }],
      ["expired", (c) => {
        c.exp = Math.floor(Date.now() / 1000) - 60;
      }],
      ["missing id", (c) => {
        delete c.id;
      }],
      ["negative id", (c) => {
        c.id = -1;
      }],
      ["fractional id", (c) => {
        c.id = 1.5;
      }],
      ["overflow id", (c) => {
        c.id = "18446744073709551616";
      }],
      ["missing subject", (c) => {
        delete c.sub;
      }],
    ];
    for (const [name, change] of cases) {
      const claims = telegramIdentityClaims(42);
      change(claims);
      const response = await start(claims);
      assert.equal(response.body.success, false, name);
      assert.equal(response.body.code, "TELEGRAM_OAUTH_FAILED", name);
      assert.equal(response.body.message, ERR_TELEGRAM_OAUTH_FAILED, name);
      assert.equal(JSON.stringify(response.body).includes("test-access-token"), false, name);
      assert.equal(JSON.stringify(response.body).includes("access_token"), false, name);
    }

    const badSig = await start(telegramIdentityClaims(42), other.privateKey);
    assert.equal(badSig.body.code, "TELEGRAM_OAUTH_FAILED");

    const pkceStart = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "telegram", intent: "login" }),
      }),
      e,
    );
    const pkceData = pkceStart.body.data as { flow_token: string; authorization_url: string };
    const pkceCode = "code-" + pkceData.flow_token;
    grants.set(pkceCode, {
      challenge: "wrong-challenge",
      claims: telegramIdentityClaims(42),
      key: pair.privateKey,
    });
    const pkce = await json(
      new Request(
        `http://local/api/oauth/telegram?state=${encodeURIComponent(pkceData.flow_token)}&code=${encodeURIComponent(pkceCode)}`,
      ),
      e,
    );
    assert.equal(pkce.body.code, "TELEGRAM_OAUTH_FAILED");
    assert.equal(JSON.stringify(pkce.body).includes("test-access-token"), false);

    tokenStatus = 503;
    const tokenDown = await start(telegramIdentityClaims(42));
    assert.equal(tokenDown.body.code, "TELEGRAM_OAUTH_FAILED");
    tokenStatus = 0;

    jwksStatus = 503;
    const jwksDown = await start(telegramIdentityClaims(42));
    assert.equal(jwksDown.body.code, "TELEGRAM_OAUTH_FAILED");
    jwksStatus = 0;
  } finally {
    globalThis.fetch = origFetch;
  }
});
