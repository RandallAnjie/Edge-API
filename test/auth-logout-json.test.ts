import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
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

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
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
  assert.equal(login.body.success, true, String(login.body.message));
  const data = login.body.data as { access_token: string; session: { sid: string } };
  const auth = { authorization: "Bearer " + data.access_token, "content-type": "application/json" };
  return { e, auth, login, token: data.access_token, sid: data.session.sid };
}

test("login Set-Cookie matches original AuthBundle refresh + session-hint cookies", async () => {
  const { login, sid } = await boot();
  const cookies = setCookies(login.res);
  const joined = cookies.join("\n");
  assert.match(joined, /new_api_refresh=/);
  assert.match(joined, /new_api_has_session=1/);
  assert.match(joined, /Path=\/api\/user\/auth/);
  assert.match(joined, /HttpOnly/);
  assert.match(joined, /SameSite=Strict/);
  assert.equal(cookies.some((c) => c.startsWith("session=")), false);
  const hint = cookies.find((c) => c.startsWith("new_api_has_session=")) || "";
  assert.equal(/HttpOnly/i.test(hint), false);
  assert.equal(cookieVal(login.res, "new_api_refresh").startsWith(sid + "."), true);
});

test("POST /api/user/auth/logout anonymous JSON omits data like original AuthLogout", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  const out = await json(new Request("http://local/api/user/auth/logout", { method: "POST" }), e);
  assert.equal(out.res.status, 200);
  assert.equal(out.body.success, true);
  assert.equal(out.body.message, "");
  assert.equal("data" in out.body, false);
  const joined = setCookies(out.res).join("\n");
  assert.match(joined, /new_api_refresh=/);
  assert.match(joined, /new_api_has_session=/);
});

test("POST /api/user/auth/logout bearer JSON includes revoked_sid and cookie_cleared", async () => {
  const { e, token, sid } = await boot();
  const bearerOnly = await json(
    new Request("http://local/api/user/auth/logout", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
    }),
    e,
  );
  assert.equal(bearerOnly.body.success, true);
  assert.equal(bearerOnly.body.message, "");
  const bearerData = bearerOnly.body.data as { revoked_sid: string; cookie_cleared: boolean };
  assert.equal(bearerData.revoked_sid, sid);
  assert.equal(bearerData.cookie_cleared, false);

  const login2 = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const data2 = login2.body.data as { access_token: string; session: { sid: string } };
  const refresh2 = cookieVal(login2.res, "new_api_refresh");
  const both = await json(
    new Request("http://local/api/user/auth/logout", {
      method: "POST",
      headers: { authorization: "Bearer " + data2.access_token, cookie: `new_api_refresh=${refresh2}` },
    }),
    e,
  );
  const bothData = both.body.data as { revoked_sid: string; cookie_cleared: boolean };
  assert.equal(bothData.revoked_sid, data2.session.sid);
  assert.equal(bothData.cookie_cleared, true);
});

test("POST /api/user/auth/refresh without cookie clears original cookies and returns AUTH_UNAUTHORIZED", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  const anon = await json(new Request("http://local/api/user/auth/refresh", { method: "POST" }), e);
  assert.equal(anon.res.status, 401);
  assert.equal(anon.body.success, false);
  assert.equal(anon.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(anon.body.message, "Unauthorized");
  const joined = setCookies(anon.res).join("\n");
  assert.match(joined, /new_api_refresh=/);
  assert.match(joined, /new_api_has_session=/);
});
