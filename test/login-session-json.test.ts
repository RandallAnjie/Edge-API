import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  USER_SESSION_ACTIVE_LIMIT,
  USER_SESSION_ISSUANCE_LIMIT,
  USER_SESSION_LIST_LIMIT,
} from "../src/constants.js";
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

async function insertListedSession(
  store: Store,
  e: Env,
  row: {
    sid: string;
    user_id: number;
    last_seen: number;
    created_at: number;
    expires_at: number;
    revoked?: number;
    user_auth_version?: number;
    login_method?: string;
  },
): Promise<void> {
  await store.insertSession({
    sid: row.sid,
    user_id: row.user_id,
    ip: "127.0.0.1",
    ua: "test-agent",
    expires_at: row.expires_at,
    login_method: row.login_method || "password",
    user_auth_version: row.user_auth_version ?? 1,
  });
  await e.DB.prepare(
    "UPDATE login_sessions SET last_seen = ?, created_at = ?, revoked = ?, user_auth_version = ? WHERE sid = ?",
  )
    .bind(row.last_seen, row.created_at, row.revoked ?? 0, row.user_auth_version ?? 1, row.sid)
    .run();
}

test("original GetLoginSessions LoginSessionView omits expired, revoked, and stale auth versions", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.ok(user);
  const now = Math.floor(Date.now() / 1000);
  const authVersion = Number(user.auth_version || 1);

  const listed = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  assert.equal(listed.body.success, true);
  const first = listed.body.data as Record<string, unknown>[];
  assert.equal(first.length, 1);
  for (const k of ["sid", "current", "login_method", "ip", "user_agent", "created_at", "last_active_at", "expires_at"]) {
    assert.ok(k in first[0], "missing LoginSessionView " + k);
  }
  assert.equal("last_seen" in first[0], false);
  assert.equal("revoked" in first[0], false);
  assert.equal(first[0].current, true);
  const currentSid = String(first[0].sid);

  await insertListedSession(store, e, {
    sid: "expired-session",
    user_id: user.id,
    last_seen: now + 50,
    created_at: now - 10,
    expires_at: now - 1,
    user_auth_version: authVersion,
  });
  await insertListedSession(store, e, {
    sid: "revoked-session",
    user_id: user.id,
    last_seen: now + 40,
    created_at: now - 10,
    expires_at: now + 3600,
    revoked: 1,
    user_auth_version: authVersion,
  });
  await insertListedSession(store, e, {
    sid: "stale-auth-version",
    user_id: user.id,
    last_seen: now + 30,
    created_at: now - 10,
    expires_at: now + 3600,
    user_auth_version: authVersion - 1,
  });
  await insertListedSession(store, e, {
    sid: "newer-other",
    user_id: user.id,
    last_seen: now + 100,
    created_at: now - 5,
    expires_at: now + 3600,
    user_auth_version: authVersion,
    login_method: "github",
  });

  const after = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  const views = after.body.data as Record<string, unknown>[];
  const sids = views.map((v) => String(v.sid));
  assert.equal(views.length, 2);
  assert.equal(sids[0], currentSid);
  assert.equal(views[0].current, true);
  assert.equal(sids[1], "newer-other");
  assert.equal(views[1].current, false);
  assert.equal(views[1].login_method, "github");
  assert.equal(sids.includes("expired-session"), false);
  assert.equal(sids.includes("revoked-session"), false);
  assert.equal(sids.includes("stale-auth-version"), false);
});

test("original ListActiveUserSessions keeps current first and bounds others at 100", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.ok(user);
  const now = Math.floor(Date.now() / 1000);
  const authVersion = Number(user.auth_version || 1);

  const current = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  const currentSid = String((current.body.data as { sid: string }[])[0].sid);

  for (let i = 0; i < 105; i++) {
    const pad = String(i).padStart(3, "0");
    await insertListedSession(store, e, {
      sid: "list-other-" + pad,
      user_id: user.id,
      last_seen: now - i,
      created_at: now - i,
      expires_at: now + 3600,
      user_auth_version: authVersion,
    });
  }

  const listed = await json(new Request("http://local/api/user/sessions", { headers: auth }), e);
  const views = listed.body.data as { sid: string; current: boolean }[];
  assert.equal(views.length, USER_SESSION_LIST_LIMIT);
  assert.equal(views[0].sid, currentSid);
  assert.equal(views[0].current, true);
  assert.equal(views.filter((v) => v.current).length, 1);

  const withoutCurrent = await store.listActiveUserSessions(user.id, "missing-current", now);
  assert.equal(withoutCurrent.length, USER_SESSION_LIST_LIMIT);
});

test("original CountActiveUserSessions includes stale auth versions and excludes expired/revoked", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.ok(user);
  const now = Math.floor(Date.now() / 1000);
  await e.DB.prepare("DELETE FROM login_sessions WHERE user_id = ?").bind(user.id).run();

  await insertListedSession(store, e, {
    sid: "count-current-version",
    user_id: user.id,
    last_seen: now - 10,
    created_at: now - 10,
    expires_at: now + 3600,
    user_auth_version: 7,
  });
  await insertListedSession(store, e, {
    sid: "count-stale-version",
    user_id: user.id,
    last_seen: now - 9,
    created_at: now - 9,
    expires_at: now + 3600,
    user_auth_version: 2,
  });
  await insertListedSession(store, e, {
    sid: "count-expired",
    user_id: user.id,
    last_seen: now - 8,
    created_at: now - 8,
    expires_at: now,
    user_auth_version: 7,
  });
  await insertListedSession(store, e, {
    sid: "count-revoked",
    user_id: user.id,
    last_seen: now - 7,
    created_at: now - 7,
    expires_at: now + 3600,
    revoked: 1,
    user_auth_version: 7,
  });
  await insertListedSession(store, e, {
    sid: "count-cutoff",
    user_id: user.id,
    last_seen: now - 3600,
    created_at: now - 3600,
    expires_at: now,
    user_auth_version: 7,
  });

  assert.equal(await store.countActiveSessions(user.id, now), 2);
  assert.equal(await store.countSessionsCreatedSince(user.id, now - 3600), 4);
  assert.equal(await store.countSessionsCreatedSince(0, now - 3600), 4);
});

test("original login AUTH_SESSION_LIMIT JSON when active sessions are at the cap", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.ok(user);
  const now = Math.floor(Date.now() / 1000);
  const need = USER_SESSION_ACTIVE_LIMIT - (await store.countActiveSessions(user.id, now));
  for (let i = 0; i < need; i++) {
    await insertListedSession(store, e, {
      sid: "limit-active-" + i,
      user_id: user.id,
      last_seen: now - i,
      created_at: now - i,
      expires_at: now + 3600,
      user_auth_version: i % 2 === 0 ? 1 : 99,
    });
  }
  assert.equal(await store.countActiveSessions(user.id, now), USER_SESSION_ACTIVE_LIMIT);

  const blocked = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(blocked.res.status, 409);
  assert.equal(blocked.body.success, false);
  assert.equal(blocked.body.code, "AUTH_SESSION_LIMIT");
  assert.equal(blocked.body.message, "Conflict");
  assert.equal(blocked.body.data, null);
});

test("original login AUTH_SESSION_LIMIT ignores expired sessions", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.ok(user);
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < USER_SESSION_ACTIVE_LIMIT; i++) {
    await insertListedSession(store, e, {
      sid: "expired-fill-" + i,
      user_id: user.id,
      last_seen: now - i,
      created_at: now - i,
      expires_at: now,
      user_auth_version: 1,
    });
  }
  const allowed = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(allowed.res.status, 200);
  assert.equal(allowed.body.success, true);
  assert.equal(typeof (allowed.body.data as { access_token: string }).access_token, "string");
});

test("original login AUTH_SESSION_ISSUANCE_LIMIT JSON uses a strict created_at cutoff", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  const user = await store.getUserByUsername("root");
  assert.ok(user);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 24 * 60 * 60;
  await insertListedSession(store, e, {
    sid: "issuance-at-cutoff",
    user_id: user.id,
    last_seen: cutoff,
    created_at: cutoff,
    expires_at: now + 3600,
    revoked: 1,
    user_auth_version: 1,
  });
  const already = await store.countSessionsCreatedSince(user.id, cutoff);
  const need = USER_SESSION_ISSUANCE_LIMIT - already;
  for (let i = 0; i < need; i++) {
    await insertListedSession(store, e, {
      sid: "issuance-recent-" + i,
      user_id: user.id,
      last_seen: now - i - 1,
      created_at: now - i - 1,
      expires_at: now + 3600,
      revoked: 1,
      user_auth_version: 1,
    });
  }
  assert.equal(await store.countSessionsCreatedSince(user.id, cutoff), USER_SESSION_ISSUANCE_LIMIT);

  const blocked = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.body.success, false);
  assert.equal(blocked.body.code, "AUTH_SESSION_ISSUANCE_LIMIT");
  assert.equal(blocked.body.message, "Too Many Requests");
  assert.equal(blocked.body.data, null);
});
