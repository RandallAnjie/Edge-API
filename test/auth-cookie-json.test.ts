import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { SESSION_TTL_SEC } from "../src/constants.js";
import {
  clearAuthCookies,
  formatGoCookieExpires,
  GO_COOKIE_CLEAR_EXPIRES,
  refreshCookie,
  serializeGoCookie,
  sessionHintCookie,
} from "../src/http.js";
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

function cookieLine(cookies: string[], name: string): string {
  return cookies.find((c) => c.startsWith(name + "=")) || "";
}

function cookieAttr(line: string, name: string): string | undefined {
  const parts = line.split(";").map((p) => p.trim());
  const hit = parts.find((p) => p === name || p.startsWith(name + "="));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq < 0 ? "" : hit.slice(eq + 1);
}

function cookieAttrOrder(line: string): string[] {
  return line
    .split(";")
    .slice(1)
    .map((p) => p.trim().split("=")[0] || "")
    .filter(Boolean);
}

async function bootHttps(secure = false) {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  const origin = secure ? "https://local" : "http://local";
  await json(
    new Request(origin + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await json(
    new Request(origin + "/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(login.body.success, true, String(login.body.message));
  return { e, login, origin };
}

test("formatGoCookieExpires matches net/http TimeFormat for Unix(1,0)", () => {
  assert.equal(formatGoCookieExpires(GO_COOKIE_CLEAR_EXPIRES), "Thu, 01 Jan 1970 00:00:01 GMT");
  assert.equal(formatGoCookieExpires(new Date(Date.UTC(2026, 8, 16, 6, 19, 0))), "Wed, 16 Sep 2026 06:19:00 GMT");
});

test("serializeGoCookie matches original Cookie.String attribute order", () => {
  const expires = new Date(Date.UTC(2026, 9, 16, 12, 0, 0));
  assert.equal(
    serializeGoCookie({
      name: "new_api_refresh",
      value: "sid.secret",
      path: "/api/user/auth",
      expires,
      maxAge: 2592000,
      httpOnly: true,
      sameSite: "Strict",
    }),
    "new_api_refresh=sid.secret; Path=/api/user/auth; Expires=Fri, 16 Oct 2026 12:00:00 GMT; Max-Age=2592000; HttpOnly; SameSite=Strict",
  );
  assert.equal(
    serializeGoCookie({
      name: "new_api_has_session",
      value: "1",
      path: "/",
      expires,
      maxAge: 2592000,
      httpOnly: false,
      secure: true,
      sameSite: "Strict",
    }),
    "new_api_has_session=1; Path=/; Expires=Fri, 16 Oct 2026 12:00:00 GMT; Max-Age=2592000; Secure; SameSite=Strict",
  );
  assert.equal(
    clearAuthCookies(false)[0],
    "new_api_refresh=; Path=/api/user/auth; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; HttpOnly; SameSite=Strict",
  );
  assert.equal(
    clearAuthCookies(false)[1],
    "new_api_has_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; SameSite=Strict",
  );
  assert.equal(
    clearAuthCookies(true)[0],
    "new_api_refresh=; Path=/api/user/auth; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
  );
  const expiresAt = Date.UTC(2026, 3, 17, 0, 0, 0) / 1000;
  assert.equal(
    refreshCookie("sid.secret", 10, false, expiresAt),
    "new_api_refresh=sid.secret; Path=/api/user/auth; Expires=Fri, 17 Apr 2026 00:00:00 GMT; Max-Age=10; HttpOnly; SameSite=Strict",
  );
  assert.equal(
    sessionHintCookie(10, false, expiresAt),
    "new_api_has_session=1; Path=/; Expires=Fri, 17 Apr 2026 00:00:00 GMT; Max-Age=10; SameSite=Strict",
  );
});

test("login Set-Cookie matches original WriteRefreshCookie Expires+Max-Age JSON", async () => {
  const { login } = await bootHttps(false);
  const data = login.body.data as { session: { sid: string; expires_at: number } };
  const cookies = setCookies(login.res);
  const refresh = cookieLine(cookies, "new_api_refresh");
  const hint = cookieLine(cookies, "new_api_has_session");
  const expectedExpires = formatGoCookieExpires(new Date(data.session.expires_at * 1000));

  assert.equal(cookieAttr(refresh, "Path"), "/api/user/auth");
  assert.equal(cookieAttr(hint, "Path"), "/");
  assert.equal(cookieAttr(refresh, "Expires"), expectedExpires);
  assert.equal(cookieAttr(hint, "Expires"), expectedExpires);
  const maxAge = Number(cookieAttr(refresh, "Max-Age"));
  assert.equal(Number.isInteger(maxAge), true);
  assert.equal(maxAge >= SESSION_TTL_SEC - 5 && maxAge <= SESSION_TTL_SEC, true, String(maxAge));
  assert.equal(cookieAttr(hint, "Max-Age"), String(maxAge));
  assert.deepEqual(cookieAttrOrder(refresh), ["Path", "Expires", "Max-Age", "HttpOnly", "SameSite"]);
  assert.deepEqual(cookieAttrOrder(hint), ["Path", "Expires", "Max-Age", "SameSite"]);
  assert.equal(cookieAttr(refresh, "SameSite"), "Strict");
  assert.equal(cookieAttr(hint, "SameSite"), "Strict");
  assert.equal(cookieAttr(refresh, "HttpOnly"), "");
  assert.equal(cookieAttr(hint, "HttpOnly"), undefined);
  assert.equal(cookieAttr(refresh, "Secure"), undefined);
  assert.equal(cookieAttr(hint, "Secure"), undefined);
  assert.equal(refresh.startsWith("new_api_refresh=" + data.session.sid + "."), true);
  assert.equal(hint.startsWith("new_api_has_session=1;"), true);
});

test("https login Set-Cookie adds Secure before SameSite like original SessionCookieSecure", async () => {
  const { login } = await bootHttps(true);
  const cookies = setCookies(login.res);
  const refresh = cookieLine(cookies, "new_api_refresh");
  const hint = cookieLine(cookies, "new_api_has_session");
  assert.deepEqual(cookieAttrOrder(refresh), ["Path", "Expires", "Max-Age", "HttpOnly", "Secure", "SameSite"]);
  assert.deepEqual(cookieAttrOrder(hint), ["Path", "Expires", "Max-Age", "Secure", "SameSite"]);
});

test("ClearRefreshCookie Set-Cookie uses Unix(1,0) Expires and Max-Age=0", async () => {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
  const out = await json(new Request("http://local/api/user/auth/logout", { method: "POST" }), e);
  assert.equal(out.body.success, true);
  const cookies = setCookies(out.res);
  const refresh = cookieLine(cookies, "new_api_refresh");
  const hint = cookieLine(cookies, "new_api_has_session");
  assert.equal(cookieAttr(refresh, "Expires"), "Thu, 01 Jan 1970 00:00:01 GMT");
  assert.equal(cookieAttr(hint, "Expires"), "Thu, 01 Jan 1970 00:00:01 GMT");
  assert.equal(cookieAttr(refresh, "Max-Age"), "0");
  assert.equal(cookieAttr(hint, "Max-Age"), "0");
  assert.deepEqual(cookieAttrOrder(refresh), ["Path", "Expires", "Max-Age", "HttpOnly", "SameSite"]);
  assert.deepEqual(cookieAttrOrder(hint), ["Path", "Expires", "Max-Age", "SameSite"]);
  assert.equal(refresh.startsWith("new_api_refresh=;"), true);
  assert.equal(hint.startsWith("new_api_has_session=;"), true);

  const anon = await json(new Request("http://local/api/user/auth/refresh", { method: "POST" }), e);
  assert.equal(anon.res.status, 401);
  const cleared = setCookies(anon.res);
  assert.equal(cookieAttr(cookieLine(cleared, "new_api_refresh"), "Expires"), "Thu, 01 Jan 1970 00:00:01 GMT");
  assert.equal(cookieAttr(cookieLine(cleared, "new_api_has_session"), "Max-Age"), "0");
});
