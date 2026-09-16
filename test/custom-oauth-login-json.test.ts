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
  id?: number | string;
  login?: string;
  name?: string | null;
  email?: string;
  trust_level?: number;
  failToken?: boolean;
  tokenError?: boolean;
  connectFail?: boolean;
  userStatus?: number;
  formToken?: boolean;
};

test("original HandleOAuth custom login JSON matches GenericOAuthProvider GetUserInfo", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ServerAddress", "https://console.example.com");
  const providerId = await store.insertOAuthProvider({
    name: "GitHub Enterprise",
    slug: "ghe",
    icon: "github",
    enabled: 0,
    client_id: "ghe-client",
    client_secret: "ghe-secret",
    authorization_endpoint: "https://ghe.example/authorize",
    token_endpoint: "https://ghe.example/token",
    user_info_endpoint: "https://ghe.example/user",
    scopes: "user:email",
    user_id_field: "id",
    username_field: "login",
    display_name_field: "name",
    email_field: "email",
    auth_style: 1,
    access_policy: "",
    access_denied_message: "",
  });

  const grants = new Map<string, Grant>();
  let lastCode = "";
  let lastToken = {
    authorization: "",
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
    if (url.origin === "https://ghe.example" && url.pathname === "/token") {
      const params = new URLSearchParams(await req.text());
      lastToken = {
        authorization: req.headers.get("authorization") || "",
        contentType: req.headers.get("content-type") || "",
        accept: req.headers.get("accept") || "",
        grant_type: params.get("grant_type") || "",
        client_id: params.get("client_id") || "",
        client_secret: params.get("client_secret") || "",
        code: params.get("code") || "",
        redirect_uri: params.get("redirect_uri") || "",
      };
      lastCode = lastToken.code;
      const grant = grants.get(lastCode);
      if (grant?.connectFail) throw new Error("connection refused");
      if (!grant || grant.failToken) return Response.json({});
      if (grant.tokenError) return Response.json({ error: "invalid_grant", error_description: "bad code" });
      if (grant.formToken) return new Response("access_token=ghe_access&token_type=bearer", { headers: { "content-type": "application/x-www-form-urlencoded" } });
      return Response.json({ access_token: "ghe_access", token_type: "bearer" });
    }
    if (url.origin === "https://ghe.example" && url.pathname === "/user") {
      const grant = grants.get(lastCode);
      if (!grant || req.headers.get("authorization") !== "Bearer ghe_access") {
        return new Response("", { status: 401 });
      }
      assert.equal(req.headers.get("accept"), "application/json");
      grants.delete(lastCode);
      if (grant.userStatus && grant.userStatus !== 200) return new Response("", { status: grant.userStatus });
      return Response.json({
        id: grant.id,
        login: grant.login,
        name: grant.name ?? "",
        email: grant.email,
        trust_level: grant.trust_level ?? 0,
      });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function startLogin(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "ghe", intent: "login", ...extra }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    return (started.body.data as { flow_token: string }).flow_token;
  }

  async function callback(flow: string, code: string, headers: Record<string, string> = {}) {
    return json(
      new Request(`http://local/api/oauth/ghe?state=${encodeURIComponent(flow)}&code=${encodeURIComponent(code)}`, {
        headers,
      }),
      e,
    );
  }

  try {
    const disabledFlow = await startLogin();
    const disabled = await callback(disabledFlow, "disabled-code");
    assert.equal(disabled.body.success, false);
    assert.equal(disabled.body.message, "GitHub Enterprise login and registration has not been enabled by administrator");
    const zhDisabledFlow = await startLogin();
    const zhDisabled = await json(
      new Request(`http://local/api/oauth/ghe?state=${encodeURIComponent(zhDisabledFlow)}&code=disabled-zh`, {
        headers: { "accept-language": "zh-CN" },
      }),
      e,
    );
    assert.equal(zhDisabled.body.message, "管理员未开启通过 GitHub Enterprise 登录以及注册");

    await store.updateOAuthProvider(providerId, { enabled: 1 });

    const emptyCodeFlow = await startLogin();
    const emptyCode = await json(new Request(`http://local/api/oauth/ghe?state=${encodeURIComponent(emptyCodeFlow)}`), e);
    assert.equal(emptyCode.body.success, false);
    assert.equal(emptyCode.body.message, "Invalid authorization code");

    const tokenFlow = await startLogin();
    grants.set("bad-token", { id: 42, login: "octocat", failToken: true });
    const tokenFail = await callback(tokenFlow, "bad-token");
    assert.equal(tokenFail.body.success, false);
    assert.equal(tokenFail.body.message, "Failed to get token from GitHub Enterprise, please check settings");
    assert.equal(lastToken.contentType, "application/x-www-form-urlencoded");
    assert.equal(lastToken.accept, "application/json");
    assert.equal(lastToken.grant_type, "authorization_code");
    assert.equal(lastToken.client_id, "ghe-client");
    assert.equal(lastToken.client_secret, "ghe-secret");
    assert.equal(lastToken.authorization, "");
    assert.equal(lastToken.redirect_uri, "https://console.example.com/oauth/ghe");
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(tokenFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);
    const zhToken = await callback(tokenFlow, "bad-token", { "accept-language": "zh-CN" });
    assert.equal(zhToken.body.message, "GitHub Enterprise 获取 Token 失败，请检查设置");

    grants.set("oauth-error", { id: 1, login: "x", tokenError: true });
    const errFlow = await startLogin();
    const oauthErr = await callback(errFlow, "oauth-error");
    assert.equal(oauthErr.body.message, "Failed to get token from GitHub Enterprise, please check settings");

    grants.set("connect-fail", { id: 1, login: "x", connectFail: true });
    const connectFlow = await startLogin();
    const connectFail = await callback(connectFlow, "connect-fail");
    assert.equal(connectFail.body.message, "Unable to connect to GitHub Enterprise server, please try again later");
    grants.set("connect-fail-zh", { id: 1, login: "x", connectFail: true });
    const zhConnectFlow = await startLogin();
    const zhConnect = await callback(zhConnectFlow, "connect-fail-zh", { "accept-language": "zh-CN" });
    assert.equal(zhConnect.body.message, "无法连接至 GitHub Enterprise 服务器，请稍后重试");

    grants.set("user-401", { id: 2, login: "demo", userStatus: 401 });
    const userErrFlow = await startLogin();
    const userErr = await callback(userErrFlow, "user-401");
    assert.equal(userErr.body.message, "Failed to get user information");

    grants.set("no-id", { login: "noid" });
    const noIdFlow = await startLogin();
    const noId = await callback(noIdFlow, "no-id");
    assert.equal(noId.body.message, "GitHub Enterprise returned empty user info, please check settings");
    grants.set("no-id-zh", { login: "noid" });
    const zhEmptyFlow = await startLogin();
    const zhEmpty = await callback(zhEmptyFlow, "no-id-zh", { "accept-language": "zh-CN" });
    assert.equal(zhEmpty.body.message, "GitHub Enterprise 获取用户信息为空，请检查设置");

    await store.updateOAuthProvider(providerId, { access_policy: "{not-json" });
    grants.set("bad-policy", { id: 3, login: "policy" });
    const policyFlow = await startLogin();
    const badPolicy = await callback(policyFlow, "bad-policy");
    assert.equal(badPolicy.body.message, "Failed to get user information");

    await store.updateOAuthProvider(providerId, {
      access_policy: JSON.stringify({ logic: "and", conditions: [{ field: "trust_level", op: "gte", value: 2 }] }),
      access_denied_message: "",
    });
    grants.set("denied", { id: 4, login: "low", trust_level: 1 });
    const deniedFlow = await startLogin();
    const denied = await callback(deniedFlow, "denied");
    assert.equal(denied.body.success, false);
    assert.equal(denied.body.message, "Access denied: your account does not meet this provider's access requirements.");

    await store.updateOAuthProvider(providerId, {
      access_denied_message: "{{provider}} blocked {{field}}={{current}}",
    });
    grants.set("denied-tpl", { id: 5, login: "low2", trust_level: 0 });
    const tplFlow = await startLogin();
    const tplDenied = await callback(tplFlow, "denied-tpl");
    assert.equal(tplDenied.body.message, "GitHub Enterprise blocked trust_level=0");

    grants.set("ok-alice", {
      id: 42,
      login: "alice",
      name: "Alice Example",
      email: "alice@example.com",
      trust_level: 3,
    });
    const created = await callback(tokenFlow, "ok-alice");
    assert.equal(created.body.success, true, String(created.body.message));
    assert.equal(created.body.message, "");
    const createdData = created.body.data as {
      user: { username: string; display_name: string; email?: string };
      session: { login_method: string };
    };
    assert.equal(createdData.user.username, "alice");
    assert.equal(createdData.user.display_name, "Alice Example");
    assert.equal(createdData.user.email, "alice@example.com");
    assert.equal(createdData.session.login_method, "oauth:ghe");
    assert.equal("require_verification" in createdData, false);
    assert.ok(setCookies(created.res).some((c) => c.toLowerCase().includes("new_api")));
    const bound = await store.getUserByOAuthBinding(providerId, "42");
    assert.equal(bound?.username, "alice");
    assert.equal(bound?.display_name, "Alice Example");

    grants.set("again", { id: 42, login: "ignored", name: "Ignored", trust_level: 4 });
    const againFlow = await startLogin();
    const again = await callback(againFlow, "again");
    assert.equal(again.body.success, true, String(again.body.message));
    const againData = again.body.data as { session: { login_method: string }; user: { username: string; display_name: string } };
    assert.equal(againData.session.login_method, "oauth:ghe");
    assert.equal(againData.user.username, "alice");
    assert.equal(againData.user.display_name, "Alice Example");

    grants.set("no-name", { id: 77, login: "noname", name: "", trust_level: 2 });
    const noNameFlow = await startLogin();
    const noName = await callback(noNameFlow, "no-name");
    assert.equal(noName.body.success, true, String(noName.body.message));
    const noNameUser = await store.getUserByOAuthBinding(providerId, "77");
    assert.equal(noNameUser?.username, "noname");
    assert.equal(noNameUser?.display_name, "noname");

    grants.set("no-login", { id: 88, login: "", name: "", trust_level: 2 });
    const noLoginFlow = await startLogin();
    const noLogin = await callback(noLoginFlow, "no-login");
    assert.equal(noLogin.body.success, true, String(noLogin.body.message));
    const noLoginUser = await store.getUserByOAuthBinding(providerId, "88");
    assert.equal(noLoginUser?.username, "ghe_" + noLoginUser?.id);
    assert.equal(noLoginUser?.display_name, "GitHub Enterprise User");

    grants.set("root-login", { id: 91, login: "root", name: "", trust_level: 2 });
    const rootFlow = await startLogin();
    const rootTaken = await callback(rootFlow, "root-login");
    assert.equal(rootTaken.body.success, true, String(rootTaken.body.message));
    const rootUser = await store.getUserByOAuthBinding(providerId, "91");
    assert.equal(rootUser?.username, "ghe_" + rootUser?.id);
    assert.equal(rootUser?.display_name, "root");

    grants.set("long-login", { id: 92, login: "thisusernameistoolong1", name: null, trust_level: 2 });
    const longFlow = await startLogin();
    const longName = await callback(longFlow, "long-login");
    assert.equal(longName.body.success, true, String(longName.body.message));
    const longUser = await store.getUserByOAuthBinding(providerId, "92");
    assert.match(longUser?.username || "", /^ghe_\d+$/);
    assert.equal(longUser?.display_name, "thisusernameistoolong1");

    await store.setOption("RegisterEnabled", "false");
    const deletedId = await store.insertUser({ username: "gone", aff_code: "ghegone" });
    await store.upsertUserOAuthBinding(deletedId, providerId, "999");
    await store.softDeleteUser(deletedId);
    grants.set("deleted", { id: 999, login: "deleteduser", trust_level: 2 });
    const deletedFlow = await startLogin();
    const deleted = await callback(deletedFlow, "deleted");
    assert.equal(deleted.body.success, false);
    assert.equal(deleted.res.status, 401);
    assert.equal(deleted.body.code, "AUTH_UNAUTHORIZED");
    assert.equal(deleted.body.message, "Unauthorized");

    grants.set("closed", { id: 1001, login: "newbie", trust_level: 2 });
    const closedFlow = await startLogin();
    const closed = await callback(closedFlow, "closed");
    assert.equal(closed.body.message, "New user registration has been disabled by administrator");

    await store.setOption("RegisterEnabled", "true");
    await store.insertUser({ username: "mailowner", aff_code: "mail1", email: "taken@example.com" });
    grants.set("mail", { id: 2002, login: "mailuser", email: "taken@example.com", trust_level: 2 });
    const mailFlow = await startLogin();
    const mailTaken = await callback(mailFlow, "mail");
    assert.equal(mailTaken.body.message, "Email address is already in use");
    assert.equal(JSON.stringify(mailTaken.body).includes("EMAIL_ALREADY_TAKEN"), false);

    const bannedId = await store.insertUser({ username: "banned", aff_code: "gheban", status: USER_DISABLED });
    await store.upsertUserOAuthBinding(bannedId, providerId, "666");
    grants.set("banned", { id: 666, login: "banneduser", trust_level: 2 });
    const bannedFlow = await startLogin();
    const banned = await callback(bannedFlow, "banned");
    assert.equal(banned.body.message, "User has been banned");
    grants.set("banned-zh", { id: 666, login: "banneduser", trust_level: 2 });
    const zhBannedFlow = await startLogin();
    const zhBanned = await callback(zhBannedFlow, "banned-zh", { "accept-language": "zh-CN" });
    assert.equal(zhBanned.body.message, "用户已被封禁");

    const pkUser = await store.insertUser({ username: "pkuser", aff_code: "ghepk", email: "pk@example.com" });
    await store.upsertUserOAuthBinding(pkUser, providerId, "777");
    await store.insertPasskey(pkUser, "cred-ghe", "pubkey", "device", "example.com");
    await store.setOption("PasskeyEnabled", "true");
    const before = await store.countActiveSessions(pkUser);
    grants.set("passkey", { id: 777, login: "pkuser", email: "pk@example.com", trust_level: 2 });
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
    grants.set("aff", { id: 888, login: "affiliatee", name: "Aff User", email: "aff@example.com", trust_level: 2 });
    const affFlow = await startLogin({ aff: affCode });
    const aff = await callback(affFlow, "aff");
    assert.equal(aff.body.success, true, String(aff.body.message));
    const affUser = await store.getUserByOAuthBinding(providerId, "888");
    assert.equal(affUser?.inviter_id, inviter.id);
    assert.equal(affUser?.username, "affiliatee");

    await store.updateOAuthProvider(providerId, { auth_style: 2, access_policy: "" });
    grants.set("header", { id: 889, login: "headeruser", name: "Header", trust_level: 0 });
    const headerFlow = await startLogin();
    const header = await callback(headerFlow, "header");
    assert.equal(header.body.success, true, String(header.body.message));
    assert.equal(lastToken.authorization, `Basic ${btoa("ghe-client:ghe-secret")}`);
    assert.equal(lastToken.client_id, "");
    assert.equal(lastToken.client_secret, "");

    grants.set("form-token", { id: 890, login: "formuser", formToken: true, trust_level: 0 });
    const formFlow = await startLogin();
    const form = await callback(formFlow, "form-token");
    assert.equal(form.body.success, true, String(form.body.message));
    const formUser = await store.getUserByOAuthBinding(providerId, "890");
    assert.equal(formUser?.username, "formuser");

    await store.setOption("ServerAddress", "");
    grants.set("empty-server", { id: 891, login: "emptysrv", trust_level: 0 });
    const emptyServerFlow = await startLogin();
    const emptyServer = await callback(emptyServerFlow, "empty-server");
    assert.equal(emptyServer.body.success, true, String(emptyServer.body.message));
    assert.equal(lastToken.redirect_uri, "/oauth/ghe");
  } finally {
    globalThis.fetch = origFetch;
  }
});
