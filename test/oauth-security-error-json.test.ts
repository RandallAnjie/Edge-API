import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
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
}

test("original HandleOAuth writeSecurityOperationError / writeAuthSessionError gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("GitHubClientId", "github-client");
  await store.setOption("GitHubClientSecret", "github-secret");
  await store.setOption("GitHubOAuthEnabled", "true");

  const grants = new Map<string, { id: number; login: string; failDecode?: boolean }>();
  let lastCode = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = (await req.json()) as { code?: string };
      lastCode = body.code || "";
      const grant = grants.get(lastCode);
      if (grant?.failDecode) {
        return new Response("not-json", { headers: { "content-type": "application/json" } });
      }
      if (!grant) return Response.json({});
      return Response.json({ access_token: "ghs_test", token_type: "bearer" });
    }
    if (url.host === "api.github.com" && url.pathname === "/user") {
      const grant = grants.get(lastCode);
      if (!grant || req.headers.get("authorization") !== "Bearer ghs_test") return new Response("", { status: 401 });
      grants.delete(lastCode);
      return Response.json({ id: grant.id, login: grant.login });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function startLogin() {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", intent: "login" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    return (started.body.data as { flow_token: string }).flow_token;
  }

  try {
    const decodeFlow = await startLogin();
    grants.set("bad-decode", { id: 1, login: "broken", failDecode: true });
    const decodeFail = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(decodeFlow)}&code=bad-decode`),
      e,
    );
    assert.equal(decodeFail.res.status, 500);
    securityOp(decodeFail.body, "AUTH_INTERNAL_ERROR", "Internal Server Error");
    assert.equal(decodeFail.text.includes("not-json"), false);
    assert.equal(decodeFail.text.includes("JSON"), false);
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(decodeFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);

    grants.set("octocat", { id: 42, login: "octocat" });
    const loginFlow = await startLogin();
    const created = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(loginFlow)}&code=octocat`),
      e,
    );
    assert.equal(created.body.success, true, String(created.body.message));
    const createdData = created.body.data as { access_token: string };
    const auth = { authorization: "Bearer " + createdData.access_token, "content-type": "application/json" };

    async function startVerify() {
      const started = await json(
        new Request("http://local/api/oauth/state", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ provider: "github", intent: "verify", scope: "2fa.setup" }),
        }),
        e,
      );
      assert.equal(started.body.success, true, String(started.body.message));
      return (started.body.data as { flow_token: string }).flow_token;
    }

    const mismatchFlow = await startVerify();
    grants.set("other-github", { id: 99, login: "other" });
    const mismatch = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(mismatchFlow)}&code=other-github`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(mismatch.res.status, 200);
    securityOp(
      mismatch.body,
      "OAUTH_ACCOUNT_MISMATCH",
      "The OAuth account does not match the account linked to your profile.",
    );
    assert.equal(JSON.stringify(mismatch.body).includes("99"), false);

    const staleFlow = await startVerify();
    const stored = await e.DB.prepare("SELECT payload FROM auth_flows WHERE token = ?")
      .bind(staleFlow)
      .first<{ payload: string }>();
    const payload = JSON.parse(stored?.payload || "{}") as {
      verification?: { auth_version?: number };
    };
    assert.ok(payload.verification);
    payload.verification.auth_version = Number(payload.verification.auth_version || 0) + 1;
    await e.DB.prepare("UPDATE auth_flows SET payload = ? WHERE token = ?")
      .bind(JSON.stringify(payload), staleFlow)
      .run();
    grants.set("stale-version", { id: 42, login: "octocat" });
    const stale = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(staleFlow)}&code=stale-version`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(stale.res.status, 401);
    securityOp(stale.body, "AUTH_UNAUTHORIZED", "Unauthorized");

    const okFlow = await startVerify();
    grants.set("ok-verify", { id: 42, login: "octocat" });
    const ok = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(okFlow)}&code=ok-verify`, {
        headers: auth,
      }),
      e,
    );
    assert.equal(ok.body.success, true, String(ok.body.message));
    assert.equal(ok.body.message, "");
    const proof = ok.body.data as { proof_token: string; method: string; scope: string };
    assert.equal(proof.method, "oauth");
    assert.equal(proof.scope, "2fa.setup");
    assert.equal(typeof proof.proof_token, "string");
    assert.ok(proof.proof_token.length > 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
