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

test("original HandleOAuth github bind JSON is session-bound and consumes only after userinfo", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, login } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("GitHubOAuthEnabled", "true");
  await store.setOption("GitHubClientId", "github-client");
  await store.setOption("GitHubClientSecret", "github-secret");

  const grants = new Map<string, { id: number; login: string; failToken?: boolean }>();
  let lastCode = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = (await req.json()) as { code?: string };
      lastCode = body.code || "";
      const grant = grants.get(lastCode);
      if (!grant || grant.failToken) return Response.json({});
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

  async function startBind() {
    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "github" } });
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": proof.proof_token },
        body: JSON.stringify({ provider: "github", intent: "bind" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    const data = started.body.data as { flow_token: string };
    const stored = await e.DB.prepare("SELECT payload FROM auth_flows WHERE token = ?")
      .bind(data.flow_token)
      .first<{ payload: string }>();
    const payload = JSON.parse(stored?.payload || "{}") as {
      session_identity?: { user_id: number; session_id: string };
    };
    const session = (login.body.data as { session: { sid: string } }).session;
    assert.equal(payload.session_identity?.user_id, 1);
    assert.equal(payload.session_identity?.session_id, session.sid);
    return data.flow_token;
  }

  try {
    const failedFlow = await startBind();
    grants.set("bad-code", { id: 42, login: "octocat", failToken: true });
    const failed = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(failedFlow)}&code=bad-code`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(failed.body.success, false);
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(failedFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);

    grants.set("ok-after-fail", { id: 42, login: "octocat" });
    const recovered = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(failedFlow)}&code=ok-after-fail`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(recovered.body.success, true, String(recovered.body.message));
    assert.equal(recovered.body.message, "Binding successful");
    const recoveredData = recovered.body.data as { action: string; notification_warning: boolean };
    assert.equal(recoveredData.action, "bind");
    assert.equal(typeof recoveredData.notification_warning, "boolean");
    assert.equal((await store.getUserById(1))?.github_id, "42");

    const replay = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(failedFlow)}&code=ok-after-fail`,
        { headers: auth },
      ),
      e,
    );
    assert.equal(replay.res.status, 403);

    const otherFlow = await startBind();
    grants.set("other-session", { id: 99, login: "other" });
    const otherLogin = await json(
      new Request("http://local/api/user/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password12" }),
      }),
      e,
    );
    const otherToken = (otherLogin.body.data as { access_token: string }).access_token;
    const otherRes = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(otherFlow)}&code=other-session`,
        { headers: { authorization: "Bearer " + otherToken } },
      ),
      e,
    );
    assert.equal(otherRes.res.status, 403);

    grants.set("overwrite", { id: 7, login: "newlogin" });
    const overwrite = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(otherFlow)}&code=overwrite`, { headers: auth }),
      e,
    );
    assert.equal(overwrite.body.success, true, String(overwrite.body.message));
    assert.equal((await store.getUserById(1))?.github_id, "7");

    const takenFlow = await startBind();
    await store.insertUser({ username: "owner", aff_code: "owner2", github_id: "123" });
    grants.set("taken", { id: 123, login: "takenuser" });
    const taken = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(takenFlow)}&code=taken`, { headers: auth }),
      e,
    );
    assert.equal(taken.body.success, false);
    assert.equal(taken.body.message, "This GitHub account has already been bound");
    assert.equal(JSON.stringify(taken.body).includes("ACCOUNT_ALREADY_BOUND"), false);
    assert.equal((await store.getUserById(1))?.github_id, "7");

    const legacyFlow = await startBind();
    await store.insertUser({ username: "legacy", aff_code: "legacy", github_id: "octocat" });
    grants.set("legacy", { id: 555, login: "octocat" });
    const legacy = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(legacyFlow)}&code=legacy`, {
        headers: { ...auth, "accept-language": "zh-CN" },
      }),
      e,
    );
    assert.equal(legacy.body.success, false);
    assert.equal(legacy.body.message, "该 GitHub 账户已被绑定");
  } finally {
    globalThis.fetch = origFetch;
  }
});
