import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { USER_DISABLED } from "../src/constants.js";
import { Store } from "../src/store.js";
import { sessionSecret } from "../src/auth.js";
import { signAccessJwt } from "../src/crypto.js";
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

function sessionErr(body: Record<string, unknown>, status: number, code: string, message: string, res: Response) {
  assert.equal(res.status, status);
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
}

function setCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieVal(res: Response, name: string): string {
  for (const line of setCookies(res)) {
    const part = line.split(";")[0] || "";
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return "";
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
  const data = login.body.data as { access_token: string; session: { sid: string }; user: { id: number } };
  const auth = { authorization: "Bearer " + data.access_token, "content-type": "application/json" };
  return { auth, data, login, refresh: cookieVal(login.res, "new_api_refresh") };
}

test("original writeAuthSessionError refresh gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { data, refresh } = await boot(e);
  const sid = data.session.sid;

  const anon = await json(new Request("http://local/api/user/auth/refresh", { method: "POST" }), e);
  sessionErr(anon.body, 401, "AUTH_UNAUTHORIZED", "Unauthorized", anon.res);

  const mismatch = await json(
    new Request("http://local/api/user/auth/refresh", {
      method: "POST",
      headers: { "X-Auth-Session": "other-session", cookie: `new_api_refresh=${refresh}` },
    }),
    e,
  );
  sessionErr(mismatch.body, 409, "AUTH_SESSION_MISMATCH", "Conflict", mismatch.res);

  const rotated = await json(
    new Request("http://local/api/user/auth/refresh", {
      method: "POST",
      headers: { "X-Auth-Session": sid, cookie: `new_api_refresh=${refresh}` },
    }),
    e,
  );
  assert.equal(rotated.body.success, true, String(rotated.body.message));
  const now = Math.floor(Date.now() / 1000);
  await e.DB.prepare("UPDATE login_sessions SET last_rotated_at = ? WHERE sid = ?").bind(now - 31, sid).run();
  const race = await json(
    new Request("http://local/api/user/auth/refresh", {
      method: "POST",
      headers: { "X-Auth-Session": sid, cookie: `new_api_refresh=${refresh}` },
    }),
    e,
  );
  sessionErr(race.body, 409, "AUTH_REFRESH_RACE", "Conflict", race.res);

  await e.DB.prepare("UPDATE login_sessions SET revoked = 1 WHERE sid = ?").bind(sid).run();
  const nextRefresh = cookieVal(rotated.res, "new_api_refresh");
  const revoked = await json(
    new Request("http://local/api/user/auth/refresh", {
      method: "POST",
      headers: { "X-Auth-Session": sid, cookie: `new_api_refresh=${nextRefresh}` },
    }),
    e,
  );
  sessionErr(revoked.body, 401, "AUTH_SESSION_REVOKED", "Unauthorized", revoked.res);
});

test("original writeAuthSessionError UserAuth / TryUserAuth gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, data } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("HeaderNavModules", JSON.stringify({ rankings: { enabled: true, requireAuth: true } }));

  const missing = await json(new Request("http://local/api/rankings"), e);
  sessionErr(missing.body, 401, "AUTH_UNAUTHORIZED", "Unauthorized", missing.res);

  const secret = await sessionSecret(e, store);
  const now = Math.floor(Date.now() / 1000);
  const expired = await signAccessJwt(
    secret,
    { userId: data.user.id, sid: data.session.sid, userAuthVersion: 1, sessionVersion: 1 },
    now - 120,
    now - 60,
  );
  const expiredRes = await json(new Request("http://local/api/pricing", { headers: { authorization: "Bearer " + expired } }), e);
  sessionErr(expiredRes.body, 401, "AUTH_TOKEN_EXPIRED", "Unauthorized", expiredRes.res);

  await store.updateUser(data.user.id, { status: USER_DISABLED });
  const disabledJwt = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  sessionErr(disabledJwt.body, 401, "AUTH_SESSION_REVOKED", "Unauthorized", disabledJwt.res);

  const bannedId = await store.insertUser({ username: "banned-pat", aff_code: "banpat", status: USER_DISABLED });
  await store.updateUser(bannedId, { access_token: "pat-disabled-user" });
  const disabledPat = await json(
    new Request("http://local/api/rankings", { headers: { authorization: "Bearer pat-disabled-user" } }),
    e,
  );
  sessionErr(disabledPat.body, 401, "AUTH_USER_DISABLED", "Unauthorized", disabledPat.res);
});
