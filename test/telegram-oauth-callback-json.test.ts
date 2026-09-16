import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { s256ChallengeFromVerifier } from "../src/crypto.js";
import {
  ERR_TELEGRAM_ACCOUNT_NOT_BOUND,
  ERR_TELEGRAM_BIND_ALREADY_BOUND,
  ERR_TELEGRAM_OAUTH_FAILED,
  TELEGRAM_ISSUER,
} from "../src/telegram-oauth.js";
import { USER_DISABLED } from "../src/constants.js";
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

function securityOp(body: Record<string, unknown>, code: string, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
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

async function passwordProof(e: Env, auth: Record<string, string>, scope: string, extra: Record<string, unknown> = {}) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12", ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

async function telegramClaimCount(e: Env, userId: number, subject: string): Promise<number> {
  const row = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM external_identity_claims WHERE provider = 'telegram' AND user_id = ? AND subject = ?",
  )
    .bind(userId, subject)
    .first<{ n: number }>();
  return Number(row?.n || 0);
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
    securityOp(unbound.body, "TELEGRAM_ACCOUNT_NOT_BOUND", ERR_TELEGRAM_ACCOUNT_NOT_BOUND);
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
      securityOp(response.body, "TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);
      assert.equal(JSON.stringify(response.body).includes("test-access-token"), false, name);
      assert.equal(JSON.stringify(response.body).includes("access_token"), false, name);
    }

    const badSig = await start(telegramIdentityClaims(42), other.privateKey);
    securityOp(badSig.body, "TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);

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
    securityOp(pkce.body, "TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);
    assert.equal(JSON.stringify(pkce.body).includes("test-access-token"), false);

    tokenStatus = 503;
    const tokenDown = await start(telegramIdentityClaims(42));
    securityOp(tokenDown.body, "TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);
    tokenStatus = 0;

    jwksStatus = 503;
    const jwksDown = await start(telegramIdentityClaims(42));
    securityOp(jwksDown.body, "TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);
    jwksStatus = 0;
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original HandleOAuth telegram bind JSON is atomic and session-bound", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, login } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("TelegramOAuthEnabled", "true");
  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  await store.setOption("ServerAddress", "https://example.com");

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

  async function startBind() {
    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "telegram" } });
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": proof.proof_token },
        body: JSON.stringify({ provider: "telegram", intent: "bind" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const data = started.body.data as { flow_token: string; authorization_url: string };
    const stored = await e.DB.prepare("SELECT payload FROM auth_flows WHERE token = ?")
      .bind(data.flow_token)
      .first<{ payload: string }>();
    const payload = JSON.parse(stored?.payload || "{}") as {
      session_identity?: { user_id: number; session_id: string; auth_version: number; session_version: number };
    };
    const session = (login.body.data as { session: { sid: string } }).session;
    assert.equal(payload.session_identity?.user_id, 1);
    assert.equal(payload.session_identity?.session_id, session.sid);
    assert.equal(payload.session_identity?.auth_version, 1);
    assert.equal(payload.session_identity?.session_version, 1);
    const code = "code-" + data.flow_token;
    grants.set(code, {
      challenge: new URL(data.authorization_url).searchParams.get("code_challenge") || "",
      claims: telegramIdentityClaims(42),
      key: pair.privateKey,
    });
    return { flow: data.flow_token, code };
  }

  try {
    const first = await startBind();
    const otherLogin = await json(
      new Request("http://local/api/user/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    const otherToken = (otherLogin.body.data as { access_token: string }).access_token;
    const otherSession = await json(
      new Request(
        `http://local/api/oauth/telegram?state=${encodeURIComponent(first.flow)}&code=${encodeURIComponent(first.code)}`,
        { headers: { authorization: "Bearer " + otherToken } },
      ),
      e,
    );
    assert.equal(otherSession.res.status, 403);
    assert.equal(otherSession.body.success, false);
    assert.equal(await telegramClaimCount(e, 1, "42"), 0);

    const bound = await json(
      new Request(
        `http://local/api/oauth/telegram?state=${encodeURIComponent(first.flow)}&code=${encodeURIComponent(first.code)}`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(bound.body.success, true, String(bound.body.message));
    assert.equal(bound.body.message, "Binding successful");
    const bindData = bound.body.data as { action: string; notification_warning: boolean };
    assert.equal(bindData.action, "bind");
    assert.equal(typeof bindData.notification_warning, "boolean");
    const user = await store.getUserById(1);
    assert.equal(user?.telegram_id, "42");
    assert.equal(await telegramClaimCount(e, 1, "42"), 1);

    const replay = await json(
      new Request(
        `http://local/api/oauth/telegram?state=${encodeURIComponent(first.flow)}&code=${encodeURIComponent(first.code)}`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(replay.res.status, 403);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original HandleOAuth telegram bind rejects changed accounts and duplicate ownership JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("TelegramOAuthEnabled", "true");
  await store.setOption("telegram.client_id", "12345");
  await store.setOption("telegram.client_secret", "telegram-client-secret");
  await store.setOption("ServerAddress", "https://example.com");

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

  async function startBind() {
    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "telegram" } });
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": proof.proof_token },
        body: JSON.stringify({ provider: "telegram", intent: "bind" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const data = started.body.data as { flow_token: string; authorization_url: string };
    const code = "code-" + data.flow_token;
    grants.set(code, {
      challenge: new URL(data.authorization_url).searchParams.get("code_challenge") || "",
      claims: telegramIdentityClaims(42),
      key: pair.privateKey,
    });
    return { flow: data.flow_token, code };
  }

  async function callback(flow: string, code: string, headers: Record<string, string> = auth) {
    return json(
      new Request(`http://local/api/oauth/telegram?state=${encodeURIComponent(flow)}&code=${encodeURIComponent(code)}`, {
        headers,
      }),
      e,
    );
  }

  try {
    const already = await startBind();
    await store.updateUser(1, { telegram_id: "99" });
    await e.DB.prepare(
      "INSERT INTO external_identity_claims (provider, subject, user_id, created_at) VALUES ('telegram', '99', 1, 1)",
    ).run();
    const alreadyRes = await callback(already.flow, already.code);
    securityOp(alreadyRes.body, "TELEGRAM_BIND_ALREADY_BOUND", ERR_TELEGRAM_BIND_ALREADY_BOUND);
    assert.equal(await telegramClaimCount(e, 1, "42"), 0);
    const still99 = await store.getUserById(1);
    assert.equal(still99?.telegram_id, "99");

    await store.updateUser(1, { telegram_id: "" });
    await e.DB.prepare("DELETE FROM external_identity_claims WHERE provider = 'telegram' AND user_id = 1").run();

    const owned = await startBind();
    const ownerId = await store.insertUser({ username: "owner", aff_code: "owner", telegram_id: "42", status: 1 });
    await e.DB.prepare(
      "INSERT INTO external_identity_claims (provider, subject, user_id, created_at) VALUES ('telegram', '42', ?, 1)",
    )
      .bind(ownerId)
      .run();
    const ownedRes = await callback(owned.flow, owned.code);
    assert.equal(ownedRes.body.success, false);
    assert.equal(ownedRes.body.code, undefined);
    assert.equal(ownedRes.body.message, "This Telegram account has already been bound");
    assert.equal(JSON.stringify(ownedRes.body).includes("TELEGRAM_BIND_ALREADY_BOUND"), false);
    assert.equal(await telegramClaimCount(e, 1, "42"), 0);
    const root = await store.getUserById(1);
    assert.equal(root?.telegram_id, "");

    const ownedZh = await startBind();
    const ownedZhRes = await json(
      new Request(
        `http://local/api/oauth/telegram?state=${encodeURIComponent(ownedZh.flow)}&code=${encodeURIComponent(ownedZh.code)}`,
        { headers: { ...auth, "accept-language": "zh-CN" } },
      ),
      e,
    );
    assert.equal(ownedZhRes.body.success, false);
    assert.equal(ownedZhRes.body.message, "该 Telegram 账户已被绑定");

    const revoked = await startBind();
    await e.DB.prepare("UPDATE login_sessions SET revoked = 1 WHERE user_id = 1").run();
    const revokedRes = await callback(revoked.flow, revoked.code);
    assert.equal(revokedRes.body.success, false);
    assert.equal(await telegramClaimCount(e, 1, "42"), 0);
    await e.DB.prepare("UPDATE login_sessions SET revoked = 0 WHERE user_id = 1").run();

    const disabled = await startBind();
    await store.updateUser(1, { status: USER_DISABLED });
    const disabledRes = await callback(disabled.flow, disabled.code);
    assert.equal(disabledRes.body.success, false);
    assert.equal(await telegramClaimCount(e, 1, "42"), 0);
    await store.updateUser(1, { status: 1 });

    const deleted = await startBind();
    await store.softDeleteUser(1);
    const deletedRes = await callback(deleted.flow, deleted.code);
    assert.equal(deletedRes.body.success, false);
    assert.equal(await telegramClaimCount(e, 1, "42"), 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
