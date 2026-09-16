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
  id: number;
  username?: string;
  name?: string | null;
  trust_level?: number;
  failToken?: boolean;
  connectFail?: boolean;
};

test("original HandleOAuth linuxdo login JSON matches LinuxDOProvider GetUserInfo", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await store.setOption("LinuxDOClientId", "ld-client");
  await store.setOption("LinuxDOClientSecret", "ld-secret");

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
    if (url.host === "connect.linux.do" && url.pathname === "/oauth2/token") {
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
      return Response.json({ access_token: "ld_access", token_type: "bearer" });
    }
    if (url.host === "connect.linux.do" && url.pathname === "/api/user") {
      const grant = grants.get(lastCode);
      if (!grant || req.headers.get("authorization") !== "Bearer ld_access") {
        return Response.json({ id: 0 });
      }
      assert.equal(req.headers.get("accept"), "application/json");
      grants.delete(lastCode);
      return Response.json({
        id: grant.id,
        username: grant.username,
        name: grant.name ?? "",
        trust_level: grant.trust_level ?? 0,
        active: true,
        silenced: false,
      });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function startLogin(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const started = await json(
      new Request("http://local/api/oauth/state", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "linuxdo", intent: "login", ...extra }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    return (started.body.data as { flow_token: string }).flow_token;
  }

  async function callback(flow: string, code: string, headers: Record<string, string> = {}) {
    return json(
      new Request(`http://local/api/oauth/linuxdo?state=${encodeURIComponent(flow)}&code=${encodeURIComponent(code)}`, {
        headers,
      }),
      e,
    );
  }

  try {
    const disabledFlow = await startLogin();
    const disabled = await callback(disabledFlow, "disabled-code");
    assert.equal(disabled.body.success, false);
    assert.equal(disabled.body.message, "Linux DO login and registration has not been enabled by administrator");
    const zhDisabledFlow = await startLogin();
    const zhDisabled = await json(
      new Request(`http://local/api/oauth/linuxdo?state=${encodeURIComponent(zhDisabledFlow)}&code=disabled-zh`, {
        headers: { "accept-language": "zh-CN" },
      }),
      e,
    );
    assert.equal(zhDisabled.body.message, "管理员未开启通过 Linux DO 登录以及注册");

    await store.setOption("LinuxDOOAuthEnabled", "true");

    const emptyCodeFlow = await startLogin();
    const emptyCode = await json(new Request(`http://local/api/oauth/linuxdo?state=${encodeURIComponent(emptyCodeFlow)}`), e);
    assert.equal(emptyCode.body.success, false);
    assert.equal(emptyCode.body.message, "Invalid authorization code");

    const tokenFlow = await startLogin();
    grants.set("bad-token", { id: 42, username: "lduser", failToken: true });
    const tokenFail = await callback(tokenFlow, "bad-token");
    assert.equal(tokenFail.body.success, false);
    assert.equal(tokenFail.body.message, "Failed to get token from Linux DO, please check settings");
    assert.equal(lastToken.authorization, `Basic ${btoa("ld-client:ld-secret")}`);
    assert.equal(lastToken.contentType, "application/x-www-form-urlencoded");
    assert.equal(lastToken.accept, "application/json");
    assert.equal(lastToken.grant_type, "authorization_code");
    assert.equal(lastToken.client_id, "");
    assert.equal(lastToken.client_secret, "");
    assert.equal(lastToken.redirect_uri, "http://local/api/oauth/linuxdo");
    const still = await e.DB.prepare("SELECT consumed_at FROM auth_flows WHERE token = ?")
      .bind(tokenFlow)
      .first<{ consumed_at: number }>();
    assert.equal(Number(still?.consumed_at || 0), 0);
    const zhToken = await callback(tokenFlow, "bad-token", { "accept-language": "zh-CN" });
    assert.equal(zhToken.body.message, "Linux DO 获取 Token 失败，请检查设置");

    grants.set("connect-fail", { id: 1, username: "x", connectFail: true });
    const connectFlow = await startLogin();
    const connectFail = await callback(connectFlow, "connect-fail");
    assert.equal(connectFail.body.success, false);
    assert.equal(connectFail.body.message, "Unable to connect to Linux DO server, please try again later");
    grants.set("connect-fail-zh", { id: 1, username: "x", connectFail: true });
    const zhConnectFlow = await startLogin();
    const zhConnect = await callback(zhConnectFlow, "connect-fail-zh", { "accept-language": "zh-CN" });
    assert.equal(zhConnect.body.message, "无法连接至 Linux DO 服务器，请稍后重试");

    grants.set("empty-user", { id: 0, username: "" });
    const emptyUserFlow = await startLogin();
    const emptyUser = await callback(emptyUserFlow, "empty-user");
    assert.equal(emptyUser.body.success, false);
    assert.equal(emptyUser.body.message, "Linux DO returned empty user info, please check settings");
    grants.set("empty-user-zh", { id: 0, username: "" });
    const zhEmptyFlow = await startLogin();
    const zhEmpty = await callback(zhEmptyFlow, "empty-user-zh", { "accept-language": "zh-CN" });
    assert.equal(zhEmpty.body.message, "Linux DO 获取用户信息为空，请检查设置");

    await store.setOption("LinuxDOMinimumTrustLevel", "2");
    grants.set("low-trust", { id: 99, username: "lowtrust", name: "Low", trust_level: 1 });
    const trustFlow = await startLogin();
    const lowTrust = await callback(trustFlow, "low-trust");
    assert.equal(lowTrust.body.success, false);
    assert.equal(
      lowTrust.body.message,
      "Linux DO trust level does not meet the minimum required by administrator",
    );
    grants.set("low-trust-zh", { id: 99, username: "lowtrust", trust_level: 1 });
    const zhTrustFlow = await startLogin();
    const zhTrust = await callback(zhTrustFlow, "low-trust-zh", { "accept-language": "zh-CN" });
    assert.equal(zhTrust.body.message, "Linux DO 信任等级未达到管理员设置的最低信任等级");

    grants.set("ok-bob", { id: 42, username: "bob", name: "Bob Example", trust_level: 2 });
    const created = await callback(tokenFlow, "ok-bob");
    assert.equal(created.body.success, true, String(created.body.message));
    assert.equal(created.body.message, "");
    const createdData = created.body.data as {
      user: { id: number; username: string; display_name: string; linux_do_id?: string };
      session: { login_method: string };
    };
    assert.equal(createdData.user.username, "bob");
    assert.equal(createdData.user.display_name, "Bob Example");
    assert.equal(createdData.user.linux_do_id, "42");
    assert.equal(createdData.session.login_method, "oauth:linuxdo");
    assert.equal("require_verification" in createdData, false);
    assert.ok(setCookies(created.res).some((c) => c.toLowerCase().includes("new_api")));
    assert.equal(lastToken.redirect_uri, "http://local/api/oauth/linuxdo");
    const registered = await store.getUserByField("linuxdo_id", "42");
    assert.equal(registered?.username, "bob");
    assert.equal(registered?.display_name, "Bob Example");

    grants.set("again", { id: 42, username: "ignored", name: "Ignored", trust_level: 3 });
    const againFlow = await startLogin();
    const again = await callback(againFlow, "again");
    assert.equal(again.body.success, true, String(again.body.message));
    const againData = again.body.data as { session: { login_method: string }; user: { username: string; display_name: string } };
    assert.equal(againData.session.login_method, "oauth:linuxdo");
    assert.equal(againData.user.username, "bob");
    assert.equal(againData.user.display_name, "Bob Example");

    grants.set("no-name", { id: 77, username: "noname", name: "", trust_level: 2 });
    const noNameFlow = await startLogin();
    const noName = await callback(noNameFlow, "no-name");
    assert.equal(noName.body.success, true, String(noName.body.message));
    const noNameUser = await store.getUserByField("linuxdo_id", "77");
    assert.equal(noNameUser?.username, "noname");
    assert.equal(noNameUser?.display_name, "noname");

    grants.set("no-user", { id: 88, username: "", name: "", trust_level: 4 });
    const noUserFlow = await startLogin();
    const noUser = await callback(noUserFlow, "no-user");
    assert.equal(noUser.body.success, true, String(noUser.body.message));
    const noUserRow = await store.getUserByField("linuxdo_id", "88");
    assert.equal(noUserRow?.username, "linuxdo_" + noUserRow?.id);
    assert.equal(noUserRow?.display_name, "Linux DO User");

    grants.set("root-login", { id: 91, username: "root", name: "", trust_level: 2 });
    const rootFlow = await startLogin();
    const rootTaken = await callback(rootFlow, "root-login");
    assert.equal(rootTaken.body.success, true, String(rootTaken.body.message));
    const rootUser = await store.getUserByField("linuxdo_id", "91");
    assert.equal(rootUser?.username, "linuxdo_" + rootUser?.id);
    assert.equal(rootUser?.display_name, "root");

    grants.set("long-login", { id: 92, username: "thisusernameistoolong1", name: null, trust_level: 2 });
    const longFlow = await startLogin();
    const longName = await callback(longFlow, "long-login");
    assert.equal(longName.body.success, true, String(longName.body.message));
    const longUser = await store.getUserByField("linuxdo_id", "92");
    assert.match(longUser?.username || "", /^linuxdo_\d+$/);
    assert.equal(longUser?.display_name, "thisusernameistoolong1");

    await store.setOption("RegisterEnabled", "false");
    const deletedId = await store.insertUser({ username: "gone", aff_code: "ldgone", linuxdo_id: "999" });
    await store.softDeleteUser(deletedId);
    grants.set("deleted", { id: 999, username: "deleteduser", trust_level: 2 });
    const deletedFlow = await startLogin();
    const deleted = await callback(deletedFlow, "deleted");
    assert.equal(deleted.body.success, false);
    assert.equal(deleted.res.status, 401);
    assert.equal(deleted.body.code, "AUTH_UNAUTHORIZED");
    assert.equal(deleted.body.message, "Unauthorized");
    assert.equal(JSON.stringify(deleted.body).includes("User has been deleted"), false);

    grants.set("closed", { id: 1001, username: "newbie", trust_level: 2 });
    const closedFlow = await startLogin();
    const closed = await callback(closedFlow, "closed");
    assert.equal(closed.body.success, false);
    assert.equal(closed.body.message, "New user registration has been disabled by administrator");

    await store.setOption("RegisterEnabled", "true");
    await store.insertUser({ username: "banned", aff_code: "ldban", linuxdo_id: "666", status: USER_DISABLED });
    grants.set("banned", { id: 666, username: "banneduser", trust_level: 2 });
    const bannedFlow = await startLogin();
    const banned = await callback(bannedFlow, "banned");
    assert.equal(banned.body.success, false);
    assert.equal(banned.body.message, "User has been banned");
    grants.set("banned-zh", { id: 666, username: "banneduser", trust_level: 2 });
    const zhBannedFlow = await startLogin();
    const zhBanned = await callback(zhBannedFlow, "banned-zh", { "accept-language": "zh-CN" });
    assert.equal(zhBanned.body.message, "用户已被封禁");

    const pkUser = await store.insertUser({ username: "pkuser", aff_code: "ldpk", linuxdo_id: "777" });
    await store.insertPasskey(pkUser, "cred-linuxdo", "pubkey", "device", "example.com");
    await store.setOption("PasskeyEnabled", "true");
    const before = await store.countActiveSessions(pkUser);
    grants.set("passkey", { id: 777, username: "pkuser", trust_level: 2 });
    const pkFlow = await startLogin();
    const challenge = await callback(pkFlow, "passkey");
    assert.equal(challenge.body.success, true, String(challenge.body.message));
    const ch = challenge.body.data as {
      require_verification: boolean;
      require_2fa?: boolean;
      flow_token: string;
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
    grants.set("aff", { id: 888, username: "affiliatee", name: "Aff User", trust_level: 2 });
    const affFlow = await startLogin({ aff: affCode });
    const aff = await callback(affFlow, "aff");
    assert.equal(aff.body.success, true, String(aff.body.message));
    const affUser = await store.getUserByField("linuxdo_id", "888");
    assert.equal(affUser?.inviter_id, inviter.id);
    assert.equal(affUser?.username, "affiliatee");
  } finally {
    globalThis.fetch = origFetch;
  }
});
