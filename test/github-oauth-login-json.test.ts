import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
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

function setCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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

test("original HandleOAuth github login JSON matches findOrCreateOAuthUser", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("GitHubClientId", "github-client");
  await store.setOption("GitHubClientSecret", "github-secret");

  const grants = new Map<string, { id: number; login: string; name?: string | null; email?: string | null; failToken?: boolean; userStatus?: number }>();
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
      if (grant.userStatus && grant.userStatus !== 200) return new Response("", { status: grant.userStatus });
      return Response.json({ id: grant.id, login: grant.login, name: grant.name ?? null, email: grant.email ?? null });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function startLogin(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "github", intent: "login", ...extra }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    return (started.body.data as { flow_token: string }).flow_token;
  }

  async function callback(flow: string, code: string, headers: Record<string, string> = {}) {
    return json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(flow)}&code=${encodeURIComponent(code)}`, {
        headers,
      }),
      e,
    );
  }

  try {
    const unknown = await json(new Request("http://local/api/oauth/not-a-provider"), e);
    assert.equal(unknown.res.status, 400);
    omitData(unknown.body, "Unknown OAuth provider");
    const missingState = await json(new Request("http://local/api/oauth/github"), e);
    assert.equal(missingState.res.status, 403);
    omitData(missingState.body, "State parameter is empty or mismatched");

    const disabledFlow = await startLogin();
    const disabled = await callback(disabledFlow, "disabled-code");
    omitData(disabled.body, "GitHub login and registration has not been enabled by administrator");
    const zhDisabledFlow = await startLogin();
    const zhDisabled = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(zhDisabledFlow)}&code=disabled-zh`,
        { headers: { "accept-language": "zh-CN" } },
      ),
      e,
    );
    omitData(zhDisabled.body, "管理员未开启通过 GitHub 登录以及注册");

    const errorWhileDisabledFlow = await startLogin();
    const errorWhileDisabled = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(errorWhileDisabledFlow)}&error=access_denied`,
      ),
      e,
    );
    omitData(errorWhileDisabled.body, "GitHub login and registration has not been enabled by administrator");

    await store.setOption("GitHubOAuthEnabled", "true");

    const providerErrorFlow = await startLogin();
    const providerError = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(providerErrorFlow)}&error=access_denied`,
      ),
      e,
    );
    omitData(providerError.body, "access_denied");
    const providerErrorDescFlow = await startLogin();
    const providerErrorDesc = await json(
      new Request(
        `http://local/api/oauth/github?state=${encodeURIComponent(providerErrorDescFlow)}&error=access_denied&error_description=${encodeURIComponent("User cancelled")}`,
      ),
      e,
    );
    omitData(providerErrorDesc.body, "User cancelled");

    const emptyCodeFlow = await startLogin();
    const emptyCode = await json(new Request(`http://local/api/oauth/github?state=${encodeURIComponent(emptyCodeFlow)}`), e);
    omitData(emptyCode.body, "Invalid authorization code");
    const zhCode = await json(
      new Request(`http://local/api/oauth/github?state=${encodeURIComponent(emptyCodeFlow)}`, {
        headers: { "accept-language": "zh-CN" },
      }),
      e,
    );
    omitData(zhCode.body, "无效的授权码");

    const tokenFlow = await startLogin();
    grants.set("bad-token", { id: 42, login: "octocat", failToken: true });
    const tokenFail = await callback(tokenFlow, "bad-token");
    omitData(tokenFail.body, "Failed to get token from GitHub, please check settings");
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(tokenFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);
    const zhToken = await callback(tokenFlow, "bad-token", { "accept-language": "zh-CN" });
    omitData(zhToken.body, "GitHub 获取 Token 失败，请检查设置");

    grants.set("empty-user", { id: 0, login: "" });
    const emptyUserFlow = await startLogin();
    const emptyUser = await callback(emptyUserFlow, "empty-user");
    omitData(emptyUser.body, "GitHub returned empty user info, please check settings");

    grants.set("ok-octocat", { id: 42, login: "octocat", name: "The Octocat", email: "octocat@github.com" });
    const created = await callback(tokenFlow, "ok-octocat");
    assert.equal(created.body.success, true, String(created.body.message));
    assert.equal(created.body.message, "");
    const createdData = created.body.data as {
      user: { id: number; username: string; display_name: string; email?: string; github_id?: string };
      session: { login_method: string };
      access_token: string;
    };
    assert.equal(createdData.user.username, "octocat");
    assert.equal(createdData.user.display_name, "The Octocat");
    assert.equal(createdData.user.email, "octocat@github.com");
    assert.equal(createdData.session.login_method, "oauth:github");
    assert.equal("require_verification" in createdData, false);
    assert.ok(setCookies(created.res).some((c) => c.toLowerCase().includes("new_api")));
    const registered = await store.getUserByField("github_id", "42");
    assert.equal(registered?.username, "octocat");
    assert.equal(registered?.display_name, "The Octocat");
    assert.equal(registered?.email, "octocat@github.com");

    grants.set("again", { id: 42, login: "octocat", name: "Ignored" });
    const againFlow = await startLogin();
    const again = await callback(againFlow, "again");
    assert.equal(again.body.success, true, String(again.body.message));
    const againData = again.body.data as { session: { login_method: string }; user: { username: string; display_name: string } };
    assert.equal(againData.session.login_method, "oauth:github");
    assert.equal(againData.user.username, "octocat");
    assert.equal(againData.user.display_name, "The Octocat");

    grants.set("root-login", { id: 77, login: "root", name: "" });
    const rootFlow = await startLogin();
    const rootTaken = await callback(rootFlow, "root-login");
    assert.equal(rootTaken.body.success, true, String(rootTaken.body.message));
    const rootUser = await store.getUserByField("github_id", "77");
    assert.equal(rootUser?.username, "github_" + rootUser?.id);
    assert.equal(rootUser?.display_name, "root");

    grants.set("long-login", { id: 88, login: "thisusernameistoolong1", name: null });
    const longFlow = await startLogin();
    const longName = await callback(longFlow, "long-login");
    assert.equal(longName.body.success, true, String(longName.body.message));
    const longUser = await store.getUserByField("github_id", "88");
    assert.match(longUser?.username || "", /^github_\d+$/);
    assert.equal(longUser?.display_name, "thisusernameistoolong1");

    await store.setOption("RegisterEnabled", "false");
    const deletedId = await store.insertUser({ username: "gone", aff_code: "ghgone", github_id: "999" });
    await store.softDeleteUser(deletedId);
    grants.set("deleted", { id: 999, login: "deleteduser" });
    const deletedFlow = await startLogin();
    const deleted = await callback(deletedFlow, "deleted");
    omitData(deleted.body, "User has been deleted");
    const zhDeletedFlow = await startLogin();
    grants.set("deleted-zh", { id: 999, login: "deleteduser" });
    const zhDeleted = await callback(zhDeletedFlow, "deleted-zh", { "accept-language": "zh-CN" });
    omitData(zhDeleted.body, "用户已注销");

    grants.set("closed", { id: 1001, login: "newbie" });
    const closedFlow = await startLogin();
    const closed = await callback(closedFlow, "closed");
    omitData(closed.body, "New user registration has been disabled by administrator");
    grants.set("closed-zh", { id: 1001, login: "newbie" });
    const zhClosedFlow = await startLogin();
    const zhClosed = await callback(zhClosedFlow, "closed-zh", { "accept-language": "zh-CN" });
    omitData(zhClosed.body, "管理员关闭了新用户注册");

    await store.setOption("RegisterEnabled", "true");
    await store.insertUser({ username: "mailowner", aff_code: "mail1", email: "taken@example.com" });
    grants.set("mail", { id: 2002, login: "mailuser", email: "taken@example.com" });
    const mailFlow = await startLogin();
    const mailTaken = await callback(mailFlow, "mail");
    omitData(mailTaken.body, "Email address is already in use");
    assert.equal(JSON.stringify(mailTaken.body).includes("EMAIL_ALREADY_TAKEN"), false);
    const zhMailFlow = await startLogin();
    grants.set("mail-zh", { id: 2002, login: "mailuser", email: "taken@example.com" });
    const zhMail = await callback(zhMailFlow, "mail-zh", { "accept-language": "zh-CN" });
    omitData(zhMail.body, "邮箱地址已被占用");

    await store.insertUser({ username: "legacy", aff_code: "legacy", github_id: "legacylogin" });
    grants.set("legacy", { id: 555, login: "legacylogin" });
    const legacyFlow = await startLogin();
    const legacy = await callback(legacyFlow, "legacy");
    assert.equal(legacy.body.success, true, String(legacy.body.message));
    const legacyUser = await store.getUserByUsername("legacy");
    assert.equal(legacyUser?.github_id, "555");
    assert.equal((legacy.body.data as { session: { login_method: string } }).session.login_method, "oauth:github");

    await store.insertUser({ username: "banned", aff_code: "ghban", github_id: "666", status: USER_DISABLED });
    grants.set("banned", { id: 666, login: "banneduser" });
    const bannedFlow = await startLogin();
    const banned = await callback(bannedFlow, "banned");
    omitData(banned.body, "User has been banned");
    grants.set("banned-zh", { id: 666, login: "banneduser" });
    const zhBannedFlow = await startLogin();
    const zhBanned = await callback(zhBannedFlow, "banned-zh", { "accept-language": "zh-CN" });
    omitData(zhBanned.body, "用户已被封禁");

    const pkUser = await store.insertUser({ username: "pkuser", aff_code: "ghpk", github_id: "777" });
    await store.insertPasskey(pkUser, "cred-github", "pubkey", "device", "example.com");
    await store.setOption("PasskeyEnabled", "true");
    const before = await store.countActiveSessions(pkUser);
    grants.set("passkey", { id: 777, login: "pkuser" });
    const pkFlow = await startLogin();
    const challenge = await callback(pkFlow, "passkey");
    assert.equal(challenge.body.success, true, String(challenge.body.message));
    assert.equal(challenge.body.message, "");
    const ch = challenge.body.data as {
      require_verification: boolean;
      require_2fa?: boolean;
      flow_token: string;
      expires_at: number;
      methods: { method: string; available: boolean }[];
      access_token?: string;
    };
    assert.equal(ch.require_verification, true);
    assert.equal("require_2fa" in ch, false);
    assert.equal(typeof ch.flow_token, "string");
    assert.ok(ch.flow_token.length > 0);
    assert.equal(typeof ch.expires_at, "number");
    assert.deepEqual(ch.methods, [{ method: "passkey", available: true }]);
    assert.equal("access_token" in ch, false);
    assert.equal(setCookies(challenge.res).length, 0);
    assert.equal(await store.countActiveSessions(pkUser), before);

    const inviter = await store.getUserByUsername("root");
    assert.ok(inviter);
    if (!inviter.aff_code) await store.updateUser(inviter.id, { aff_code: "root" });
    const affCode = (await store.getUserById(inviter.id))?.aff_code || "root";
    grants.set("aff", { id: 888, login: "affiliatee", name: "Aff User" });
    const affFlow = await startLogin({ aff: affCode });
    const aff = await callback(affFlow, "aff");
    assert.equal(aff.body.success, true, String(aff.body.message));
    const affUser = await store.getUserByField("github_id", "888");
    assert.equal(affUser?.inviter_id, inviter.id);
    assert.equal(affUser?.username, "affiliatee");
  } finally {
    globalThis.fetch = origFetch;
  }
});
