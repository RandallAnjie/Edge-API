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
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string | null;
  failToken?: boolean;
  connectFail?: boolean;
  userStatus?: number;
};

test("original HandleOAuth oidc login JSON matches OIDCProvider GetUserInfo", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("OIDCClientId", "oidc-client");
  await store.setOption("OIDCClientSecret", "oidc-secret");
  await store.setOption("OIDCTokenEndpoint", "https://idp.example/token");
  await store.setOption("OIDCUserinfoEndpoint", "https://idp.example/userinfo");
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
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === "https://idp.example" && url.pathname === "/token") {
      lastToken = {
        contentType: req.headers.get("content-type") || "",
        accept: req.headers.get("accept") || "",
        grant_type: "",
        client_id: "",
        client_secret: "",
        code: "",
        redirect_uri: "",
      };
      const params = new URLSearchParams(await req.text());
      lastToken.grant_type = params.get("grant_type") || "";
      lastToken.client_id = params.get("client_id") || "";
      lastToken.client_secret = params.get("client_secret") || "";
      lastToken.code = params.get("code") || "";
      lastToken.redirect_uri = params.get("redirect_uri") || "";
      lastCode = lastToken.code;
      const grant = grants.get(lastCode);
      if (grant?.connectFail) throw new Error("connection refused");
      if (!grant || grant.failToken) return Response.json({});
      return Response.json({ access_token: "oidc_access", token_type: "bearer" });
    }
    if (url.origin === "https://idp.example" && url.pathname === "/userinfo") {
      const grant = grants.get(lastCode);
      if (!grant || req.headers.get("authorization") !== "Bearer oidc_access") {
        return new Response("", { status: 401 });
      }
      grants.delete(lastCode);
      if (grant.userStatus && grant.userStatus !== 200) return new Response("", { status: grant.userStatus });
      return Response.json({
        sub: grant.sub,
        email: grant.email,
        preferred_username: grant.preferred_username,
        name: grant.name ?? "",
      });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function startLogin(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "oidc", intent: "login", ...extra }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    return (started.body.data as { flow_token: string }).flow_token;
  }

  async function callback(flow: string, code: string, headers: Record<string, string> = {}) {
    return json(
      new Request(`http://local/api/oauth/oidc?state=${encodeURIComponent(flow)}&code=${encodeURIComponent(code)}`, {
        headers,
      }),
      e,
    );
  }

  try {
    const disabledFlow = await startLogin();
    const disabled = await callback(disabledFlow, "disabled-code");
    assert.equal(disabled.body.success, false);
    assert.equal(disabled.body.message, "OIDC login and registration has not been enabled by administrator");
    const zhDisabledFlow = await startLogin();
    const zhDisabled = await json(
      new Request(`http://local/api/oauth/oidc?state=${encodeURIComponent(zhDisabledFlow)}&code=disabled-zh`, {
        headers: { "accept-language": "zh-CN" },
      }),
      e,
    );
    assert.equal(zhDisabled.body.message, "管理员未开启通过 OIDC 登录以及注册");

    await store.setOption("oidc.display_name", "Acme SSO");
    const namedDisabledFlow = await startLogin();
    const namedDisabled = await callback(namedDisabledFlow, "named-disabled");
    assert.equal(namedDisabled.body.message, "Acme SSO login and registration has not been enabled by administrator");

    await store.setOption("OIDCAuthEnabled", "true");

    const emptyCodeFlow = await startLogin();
    const emptyCode = await json(new Request(`http://local/api/oauth/oidc?state=${encodeURIComponent(emptyCodeFlow)}`), e);
    assert.equal(emptyCode.body.success, false);
    assert.equal(emptyCode.body.message, "Invalid authorization code");
    const zhCode = await json(
      new Request(`http://local/api/oauth/oidc?state=${encodeURIComponent(emptyCodeFlow)}`, {
        headers: { "accept-language": "zh-CN" },
      }),
      e,
    );
    assert.equal(zhCode.body.message, "无效的授权码");

    const tokenFlow = await startLogin();
    grants.set("bad-token", { sub: "sub-1", email: "a@example.com", failToken: true });
    const tokenFail = await callback(tokenFlow, "bad-token");
    assert.equal(tokenFail.body.success, false);
    assert.equal(tokenFail.body.message, "Failed to get token from OIDC, please check settings");
    assert.equal(lastToken.contentType, "application/x-www-form-urlencoded");
    assert.equal(lastToken.accept, "application/json");
    assert.equal(lastToken.grant_type, "authorization_code");
    assert.equal(lastToken.client_id, "oidc-client");
    assert.equal(lastToken.client_secret, "oidc-secret");
    assert.equal(lastToken.redirect_uri, "https://console.example.com/oauth/oidc");
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(tokenFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);
    const zhToken = await callback(tokenFlow, "bad-token", { "accept-language": "zh-CN" });
    assert.equal(zhToken.body.message, "OIDC 获取 Token 失败，请检查设置");

    grants.set("connect-fail", { sub: "sub-x", email: "x@example.com", connectFail: true });
    const connectFlow = await startLogin();
    const connectFail = await callback(connectFlow, "connect-fail");
    assert.equal(connectFail.body.success, false);
    assert.equal(connectFail.body.message, "Unable to connect to OIDC server, please try again later");
    const zhConnectFlow = await startLogin();
    grants.set("connect-fail-zh", { sub: "sub-x", email: "x@example.com", connectFail: true });
    const zhConnect = await callback(zhConnectFlow, "connect-fail-zh", { "accept-language": "zh-CN" });
    assert.equal(zhConnect.body.message, "无法连接至 OIDC 服务器，请稍后重试");

    grants.set("user-401", { sub: "sub-401", email: "401@example.com", userStatus: 401 });
    const userErrFlow = await startLogin();
    const userErr = await callback(userErrFlow, "user-401");
    assert.equal(userErr.body.success, false);
    assert.equal(userErr.body.message, "Failed to get user information");
    grants.set("user-401-zh", { sub: "sub-401", email: "401@example.com", userStatus: 401 });
    const zhUserErrFlow = await startLogin();
    const zhUserErr = await callback(zhUserErrFlow, "user-401-zh", { "accept-language": "zh-CN" });
    assert.equal(zhUserErr.body.message, "获取用户信息失败");

    grants.set("no-email", { sub: "sub-no-email", preferred_username: "noemail" });
    const noEmailFlow = await startLogin();
    const noEmail = await callback(noEmailFlow, "no-email");
    assert.equal(noEmail.body.success, false);
    assert.equal(noEmail.body.message, "OIDC returned empty user info, please check settings");
    grants.set("no-email-zh", { sub: "sub-no-email", preferred_username: "noemail" });
    const zhNoEmailFlow = await startLogin();
    const zhNoEmail = await callback(zhNoEmailFlow, "no-email-zh", { "accept-language": "zh-CN" });
    assert.equal(zhNoEmail.body.message, "OIDC 获取用户信息为空，请检查设置");

    grants.set("no-sub", { sub: "", email: "only@example.com", preferred_username: "nosub" });
    const noSubFlow = await startLogin();
    const noSub = await callback(noSubFlow, "no-sub");
    assert.equal(noSub.body.success, false);
    assert.equal(noSub.body.message, "OIDC returned empty user info, please check settings");

    grants.set("ok-alice", {
      sub: "oidc-alice",
      email: "alice@example.com",
      preferred_username: "alice",
      name: "Alice Example",
    });
    const created = await callback(tokenFlow, "ok-alice");
    assert.equal(created.body.success, true, String(created.body.message));
    assert.equal(created.body.message, "");
    const createdData = created.body.data as {
      user: { id: number; username: string; display_name: string; email?: string; oidc_id?: string };
      session: { login_method: string };
      access_token: string;
    };
    assert.equal(createdData.user.username, "alice");
    assert.equal(createdData.user.display_name, "Alice Example");
    assert.equal(createdData.user.email, "alice@example.com");
    assert.equal(createdData.user.oidc_id, "oidc-alice");
    assert.equal(createdData.session.login_method, "oauth:oidc");
    assert.equal("require_verification" in createdData, false);
    assert.ok(setCookies(created.res).some((c) => c.toLowerCase().includes("new_api")));
    assert.equal(lastToken.redirect_uri, "https://console.example.com/oauth/oidc");
    const registered = await store.getUserByField("oidc_id", "oidc-alice");
    assert.equal(registered?.username, "alice");
    assert.equal(registered?.display_name, "Alice Example");
    assert.equal(registered?.email, "alice@example.com");

    grants.set("again", { sub: "oidc-alice", email: "alice@example.com", preferred_username: "ignored", name: "Ignored" });
    const againFlow = await startLogin();
    const again = await callback(againFlow, "again");
    assert.equal(again.body.success, true, String(again.body.message));
    const againData = again.body.data as { session: { login_method: string }; user: { username: string; display_name: string } };
    assert.equal(againData.session.login_method, "oauth:oidc");
    assert.equal(againData.user.username, "alice");
    assert.equal(againData.user.display_name, "Alice Example");

    grants.set("no-preferred", { sub: "oidc-nopref", email: "nopref@example.com", name: "" });
    const noPrefFlow = await startLogin();
    const noPref = await callback(noPrefFlow, "no-preferred");
    assert.equal(noPref.body.success, true, String(noPref.body.message));
    const noPrefUser = await store.getUserByField("oidc_id", "oidc-nopref");
    assert.equal(noPrefUser?.username, "oidc_" + noPrefUser?.id);
    assert.equal(noPrefUser?.display_name, "Acme SSO User");
    assert.equal(noPrefUser?.email, "nopref@example.com");

    grants.set("name-only", { sub: "oidc-nameonly", email: "nameonly@example.com", preferred_username: "nameonly" });
    const nameOnlyFlow = await startLogin();
    const nameOnly = await callback(nameOnlyFlow, "name-only");
    assert.equal(nameOnly.body.success, true, String(nameOnly.body.message));
    const nameOnlyUser = await store.getUserByField("oidc_id", "oidc-nameonly");
    assert.equal(nameOnlyUser?.username, "nameonly");
    assert.equal(nameOnlyUser?.display_name, "nameonly");

    grants.set("root-login", { sub: "oidc-root", email: "rootoidc@example.com", preferred_username: "root", name: "" });
    const rootFlow = await startLogin();
    const rootTaken = await callback(rootFlow, "root-login");
    assert.equal(rootTaken.body.success, true, String(rootTaken.body.message));
    const rootUser = await store.getUserByField("oidc_id", "oidc-root");
    assert.equal(rootUser?.username, "oidc_" + rootUser?.id);
    assert.equal(rootUser?.display_name, "root");

    grants.set("long-login", {
      sub: "oidc-long",
      email: "long@example.com",
      preferred_username: "thisusernameistoolong1",
      name: null,
    });
    const longFlow = await startLogin();
    const longName = await callback(longFlow, "long-login");
    assert.equal(longName.body.success, true, String(longName.body.message));
    const longUser = await store.getUserByField("oidc_id", "oidc-long");
    assert.match(longUser?.username || "", /^oidc_\d+$/);
    assert.equal(longUser?.display_name, "thisusernameistoolong1");

    await store.setOption("RegisterEnabled", "false");
    const deletedId = await store.insertUser({ username: "gone", aff_code: "oidcgone", oidc_id: "oidc-deleted" });
    await store.softDeleteUser(deletedId);
    grants.set("deleted", { sub: "oidc-deleted", email: "deleted@example.com", preferred_username: "deleteduser" });
    const deletedFlow = await startLogin();
    const deleted = await callback(deletedFlow, "deleted");
    assert.equal(deleted.body.success, false);
    assert.equal(deleted.body.message, "New user registration has been disabled by administrator");
    assert.equal(JSON.stringify(deleted.body).includes("User has been deleted"), false);

    grants.set("closed", { sub: "oidc-newbie", email: "newbie@example.com", preferred_username: "newbie" });
    const closedFlow = await startLogin();
    const closed = await callback(closedFlow, "closed");
    assert.equal(closed.body.success, false);
    assert.equal(closed.body.message, "New user registration has been disabled by administrator");
    grants.set("closed-zh", { sub: "oidc-newbie", email: "newbie@example.com", preferred_username: "newbie" });
    const zhClosedFlow = await startLogin();
    const zhClosed = await callback(zhClosedFlow, "closed-zh", { "accept-language": "zh-CN" });
    assert.equal(zhClosed.body.message, "管理员关闭了新用户注册");

    await store.setOption("RegisterEnabled", "true");
    grants.set("deleted-rereg", { sub: "oidc-deleted", email: "rereg@example.com", preferred_username: "rereg" });
    const reregFlow = await startLogin();
    const rereg = await callback(reregFlow, "deleted-rereg");
    assert.equal(rereg.body.success, true, String(rereg.body.message));
    const reregUser = await store.getUserByField("oidc_id", "oidc-deleted");
    assert.equal(reregUser?.username, "rereg");
    assert.notEqual(reregUser?.id, deletedId);

    await store.insertUser({ username: "mailowner", aff_code: "mail1", email: "taken@example.com" });
    grants.set("mail", { sub: "oidc-mail", email: "taken@example.com", preferred_username: "mailuser" });
    const mailFlow = await startLogin();
    const mailTaken = await callback(mailFlow, "mail");
    assert.equal(mailTaken.body.success, false);
    assert.equal(mailTaken.body.message, "Email address is already in use");
    assert.equal(JSON.stringify(mailTaken.body).includes("EMAIL_ALREADY_TAKEN"), false);
    const zhMailFlow = await startLogin();
    grants.set("mail-zh", { sub: "oidc-mail", email: "taken@example.com", preferred_username: "mailuser" });
    const zhMail = await callback(zhMailFlow, "mail-zh", { "accept-language": "zh-CN" });
    assert.equal(zhMail.body.message, "邮箱地址已被占用");

    await store.insertUser({ username: "banned", aff_code: "oidcban", oidc_id: "oidc-banned", status: USER_DISABLED });
    grants.set("banned", { sub: "oidc-banned", email: "banned@example.com", preferred_username: "banneduser" });
    const bannedFlow = await startLogin();
    const banned = await callback(bannedFlow, "banned");
    assert.equal(banned.body.success, false);
    assert.equal(banned.body.message, "User has been banned");
    grants.set("banned-zh", { sub: "oidc-banned", email: "banned@example.com", preferred_username: "banneduser" });
    const zhBannedFlow = await startLogin();
    const zhBanned = await callback(zhBannedFlow, "banned-zh", { "accept-language": "zh-CN" });
    assert.equal(zhBanned.body.message, "用户已被封禁");

    const pkUser = await store.insertUser({
      username: "pkuser",
      aff_code: "oidcpk",
      oidc_id: "oidc-pk",
      email: "pk@example.com",
    });
    await store.insertPasskey(pkUser, "cred-oidc", "pubkey", "device", "example.com");
    await store.setOption("PasskeyEnabled", "true");
    const before = await store.countActiveSessions(pkUser);
    grants.set("passkey", { sub: "oidc-pk", email: "pk@example.com", preferred_username: "pkuser" });
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
    grants.set("aff", {
      sub: "oidc-aff",
      email: "aff@example.com",
      preferred_username: "affiliatee",
      name: "Aff User",
    });
    const affFlow = await startLogin({ aff: affCode });
    const aff = await callback(affFlow, "aff");
    assert.equal(aff.body.success, true, String(aff.body.message));
    const affUser = await store.getUserByField("oidc_id", "oidc-aff");
    assert.equal(affUser?.inviter_id, inviter.id);
    assert.equal(affUser?.username, "affiliatee");

    await store.setOption("ServerAddress", "");
    grants.set("empty-server", { sub: "oidc-empty-server", email: "empty-server@example.com", preferred_username: "emptysrv" });
    const emptyServerFlow = await startLogin();
    const emptyServer = await callback(emptyServerFlow, "empty-server");
    assert.equal(emptyServer.body.success, true, String(emptyServer.body.message));
    assert.equal(lastToken.redirect_uri, "/oauth/oidc");
  } finally {
    globalThis.fetch = origFetch;
  }
});
