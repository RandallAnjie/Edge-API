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

let ctSeq = 0;

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const headers = new Headers(req.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `oauth-${++ctSeq}`);
  const res = await handleFetch(new Request(req, { headers }), e, ctx());
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

type Grant = {
  id: string;
  username?: string;
  global_name?: string | null;
  failToken?: boolean;
  connectFail?: boolean;
  userStatus?: number;
};

test("original HandleOAuth discord login JSON matches DiscordProvider GetUserInfo", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("DiscordClientId", "discord-client");
  await store.setOption("DiscordClientSecret", "discord-secret");
  await store.setOption("ServerAddress", "https://console.example.com");

  const grants = new Map<string, Grant>();
  let lastCode = "";
  let lastToken = {
    contentType: "",
    accept: "",
    grant_type: "",
    client_id: "",
    client_secret: "",
    code: "",
    redirect_uri: "",
    path: "",
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "discord.com" && url.pathname === "/api/v10/oauth2/token") {
      const params = new URLSearchParams(await req.text());
      lastToken = {
        contentType: req.headers.get("content-type") || "",
        accept: req.headers.get("accept") || "",
        grant_type: params.get("grant_type") || "",
        client_id: params.get("client_id") || "",
        client_secret: params.get("client_secret") || "",
        code: params.get("code") || "",
        redirect_uri: params.get("redirect_uri") || "",
        path: url.pathname,
      };
      lastCode = lastToken.code;
      const grant = grants.get(lastCode);
      if (grant?.connectFail) throw new Error("connection refused");
      if (!grant || grant.failToken) return Response.json({});
      return Response.json({ access_token: "discord_access", token_type: "bearer" });
    }
    if (url.host === "discord.com" && url.pathname === "/api/v10/users/@me") {
      const grant = grants.get(lastCode);
      if (!grant || req.headers.get("authorization") !== "Bearer discord_access") {
        return new Response("", { status: 401 });
      }
      grants.delete(lastCode);
      if (grant.userStatus && grant.userStatus !== 200) return new Response("", { status: grant.userStatus });
      return Response.json({
        id: grant.id,
        username: grant.username,
        global_name: grant.global_name ?? "",
      });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function startLogin(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "discord", intent: "login", ...extra }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    return (started.body.data as { flow_token: string }).flow_token;
  }

  async function callback(flow: string, code: string, headers: Record<string, string> = {}) {
    return json(
      new Request(`http://local/api/oauth/discord?state=${encodeURIComponent(flow)}&code=${encodeURIComponent(code)}`, {
        headers,
      }),
      e,
    );
  }

  try {
    const disabledFlow = await startLogin();
    const disabled = await callback(disabledFlow, "disabled-code");
    assert.equal(disabled.body.success, false);
    assert.equal(disabled.body.message, "Discord login and registration has not been enabled by administrator");
    const zhDisabledFlow = await startLogin();
    const zhDisabled = await json(
      new Request(`http://local/api/oauth/discord?state=${encodeURIComponent(zhDisabledFlow)}&code=disabled-zh`, {
        headers: { "accept-language": "zh-CN" },
      }),
      e,
    );
    assert.equal(zhDisabled.body.message, "管理员未开启通过 Discord 登录以及注册");

    await store.setOption("DiscordOAuthEnabled", "true");

    const emptyCodeFlow = await startLogin();
    const emptyCode = await json(new Request(`http://local/api/oauth/discord?state=${encodeURIComponent(emptyCodeFlow)}`), e);
    assert.equal(emptyCode.body.success, false);
    assert.equal(emptyCode.body.message, "Invalid authorization code");

    const tokenFlow = await startLogin();
    grants.set("bad-token", { id: "1", username: "demo", failToken: true });
    const tokenFail = await callback(tokenFlow, "bad-token");
    assert.equal(tokenFail.body.success, false);
    assert.equal(tokenFail.body.message, "Failed to get token from Discord, please check settings");
    assert.equal(lastToken.path, "/api/v10/oauth2/token");
    assert.equal(lastToken.contentType, "application/x-www-form-urlencoded");
    assert.equal(lastToken.accept, "application/json");
    assert.equal(lastToken.grant_type, "authorization_code");
    assert.equal(lastToken.client_id, "discord-client");
    assert.equal(lastToken.client_secret, "discord-secret");
    assert.equal(lastToken.redirect_uri, "https://console.example.com/oauth/discord");
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(tokenFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);
    const zhToken = await callback(tokenFlow, "bad-token", { "accept-language": "zh-CN" });
    assert.equal(zhToken.body.message, "Discord 获取 Token 失败，请检查设置");

    grants.set("connect-fail", { id: "1", username: "x", connectFail: true });
    const connectFlow = await startLogin();
    const connectFail = await callback(connectFlow, "connect-fail");
    assert.equal(connectFail.body.success, false);
    assert.equal(connectFail.body.message, "Unable to connect to Discord server, please try again later");

    grants.set("user-401", { id: "2", username: "demo", userStatus: 401 });
    const userErrFlow = await startLogin();
    const userErr = await callback(userErrFlow, "user-401");
    assert.equal(userErr.body.success, false);
    assert.equal(userErr.body.message, "Failed to get user information");

    grants.set("no-username", { id: "3", username: "" });
    const noUserFlow = await startLogin();
    const noUser = await callback(noUserFlow, "no-username");
    assert.equal(noUser.body.success, false);
    assert.equal(noUser.body.message, "Discord returned empty user info, please check settings");
    grants.set("no-username-zh", { id: "3", username: "" });
    const zhEmptyFlow = await startLogin();
    const zhEmpty = await callback(zhEmptyFlow, "no-username-zh", { "accept-language": "zh-CN" });
    assert.equal(zhEmpty.body.message, "Discord 获取用户信息为空，请检查设置");

    grants.set("ok-alice", { id: "42", username: "alice", global_name: "Alice Example" });
    const created = await callback(tokenFlow, "ok-alice");
    assert.equal(created.body.success, true, String(created.body.message));
    assert.equal(created.body.message, "");
    const createdData = created.body.data as {
      user: { username: string; display_name: string; discord_id?: string };
      session: { login_method: string };
    };
    assert.equal(createdData.user.username, "alice");
    assert.equal(createdData.user.display_name, "Alice Example");
    assert.equal(createdData.user.discord_id, "42");
    assert.equal(createdData.session.login_method, "oauth:discord");
    assert.equal("require_verification" in createdData, false);
    assert.ok(setCookies(created.res).some((c) => c.toLowerCase().includes("new_api")));
    const registered = await store.getUserByField("discord_id", "42");
    assert.equal(registered?.username, "alice");
    assert.equal(registered?.display_name, "Alice Example");

    grants.set("again", { id: "42", username: "ignored", global_name: "Ignored" });
    const againFlow = await startLogin();
    const again = await callback(againFlow, "again");
    assert.equal(again.body.success, true, String(again.body.message));
    const againData = again.body.data as { session: { login_method: string }; user: { username: string; display_name: string } };
    assert.equal(againData.session.login_method, "oauth:discord");
    assert.equal(againData.user.username, "alice");
    assert.equal(againData.user.display_name, "Alice Example");

    grants.set("no-global", { id: "77", username: "noglobal", global_name: "" });
    const noGlobalFlow = await startLogin();
    const noGlobal = await callback(noGlobalFlow, "no-global");
    assert.equal(noGlobal.body.success, true, String(noGlobal.body.message));
    const noGlobalUser = await store.getUserByField("discord_id", "77");
    assert.equal(noGlobalUser?.username, "noglobal");
    assert.equal(noGlobalUser?.display_name, "noglobal");

    grants.set("root-login", { id: "91", username: "root", global_name: "" });
    const rootFlow = await startLogin();
    const rootTaken = await callback(rootFlow, "root-login");
    assert.equal(rootTaken.body.success, true, String(rootTaken.body.message));
    const rootUser = await store.getUserByField("discord_id", "91");
    assert.equal(rootUser?.username, "discord_" + rootUser?.id);
    assert.equal(rootUser?.display_name, "root");

    grants.set("long-login", { id: "92", username: "thisusernameistoolong1", global_name: null });
    const longFlow = await startLogin();
    const longName = await callback(longFlow, "long-login");
    assert.equal(longName.body.success, true, String(longName.body.message));
    const longUser = await store.getUserByField("discord_id", "92");
    assert.match(longUser?.username || "", /^discord_\d+$/);
    assert.equal(longUser?.display_name, "thisusernameistoolong1");

    await store.setOption("RegisterEnabled", "false");
    const deletedId = await store.insertUser({ username: "gone", aff_code: "dcgone", discord_id: "999" });
    await store.softDeleteUser(deletedId);
    grants.set("deleted", { id: "999", username: "deleteduser" });
    const deletedFlow = await startLogin();
    const deleted = await callback(deletedFlow, "deleted");
    assert.equal(deleted.body.success, false);
    assert.equal(deleted.body.message, "User has been deleted");
    grants.set("deleted-zh", { id: "999", username: "deleteduser" });
    const zhDeletedFlow = await startLogin();
    const zhDeleted = await callback(zhDeletedFlow, "deleted-zh", { "accept-language": "zh-CN" });
    assert.equal(zhDeleted.body.message, "用户已注销");

    grants.set("closed", { id: "1001", username: "newbie" });
    const closedFlow = await startLogin();
    const closed = await callback(closedFlow, "closed");
    assert.equal(closed.body.success, false);
    assert.equal(closed.body.message, "New user registration has been disabled by administrator");

    await store.setOption("RegisterEnabled", "true");
    await store.insertUser({ username: "banned", aff_code: "dcban", discord_id: "666", status: USER_DISABLED });
    grants.set("banned", { id: "666", username: "banneduser" });
    const bannedFlow = await startLogin();
    const banned = await callback(bannedFlow, "banned");
    assert.equal(banned.body.success, false);
    assert.equal(banned.body.message, "User has been banned");

    const pkUser = await store.insertUser({ username: "pkuser", aff_code: "dcpk", discord_id: "777" });
    await store.insertPasskey(pkUser, "cred-discord", "pubkey", "device", "example.com");
    await store.setOption("PasskeyEnabled", "true");
    const before = await store.countActiveSessions(pkUser);
    grants.set("passkey", { id: "777", username: "pkuser" });
    const pkFlow = await startLogin();
    const challenge = await callback(pkFlow, "passkey");
    assert.equal(challenge.body.success, true, String(challenge.body.message));
    const ch = challenge.body.data as {
      require_verification: boolean;
      require_2fa?: boolean;
      methods: { method: string; available: boolean }[];
      access_token?: string;
    };
    assert.equal(ch.require_verification, true);
    assert.equal("require_2fa" in ch, false);
    assert.deepEqual(ch.methods, [{ method: "passkey", available: true }]);
    assert.equal("access_token" in ch, false);
    assert.equal(setCookies(challenge.res).length, 0);
    assert.equal(await store.countActiveSessions(pkUser), before);

    const inviter = await store.getUserByUsername("root");
    assert.ok(inviter);
    if (!inviter.aff_code) await store.updateUser(inviter.id, { aff_code: "root" });
    const affCode = (await store.getUserById(inviter.id))?.aff_code || "root";
    grants.set("aff", { id: "888", username: "affiliatee", global_name: "Aff User" });
    const affFlow = await startLogin({ aff: affCode });
    const aff = await callback(affFlow, "aff");
    assert.equal(aff.body.success, true, String(aff.body.message));
    const affUser = await store.getUserByField("discord_id", "888");
    assert.equal(affUser?.inviter_id, inviter.id);
    assert.equal(affUser?.username, "affiliatee");

    await store.setOption("ServerAddress", "");
    grants.set("empty-server", { id: "889", username: "emptysrv" });
    const emptyServerFlow = await startLogin();
    const emptyServer = await callback(emptyServerFlow, "empty-server");
    assert.equal(emptyServer.body.success, true, String(emptyServer.body.message));
    assert.equal(lastToken.redirect_uri, "/oauth/discord");
  } finally {
    globalThis.fetch = origFetch;
  }
});
