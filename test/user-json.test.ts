import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

/** Original `model.User` JSON tags returned by GetAllUsers / SearchUsers / GetUser. */
const ORIGINAL_USER_JSON_FIELDS = [
  "id",
  "username",
  "password",
  "original_password",
  "display_name",
  "role",
  "status",
  "email",
  "github_id",
  "discord_id",
  "oidc_id",
  "wechat_id",
  "telegram_id",
  "verification_code",
  "quota",
  "used_quota",
  "request_count",
  "group",
  "aff_code",
  "aff_count",
  "aff_quota",
  "aff_history_quota",
  "inviter_id",
  "linux_do_id",
  "setting",
  "stripe_customer",
  "created_at",
  "last_login_at",
  "DeletedAt",
] as const;

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { e, auth };
}

function assertOmittedSecrets(user: Record<string, unknown>, label: string) {
  for (const k of ORIGINAL_USER_JSON_FIELDS) {
    assert.ok(k in user, `${label} missing original User field ${k}`);
  }
  assert.equal(user.password, "", `${label} password must be the Omit zero, not the hash`);
  assert.equal(user.original_password, "", `${label} original_password is gorm:"-:all"`);
  assert.equal(user.verification_code, "", `${label} verification_code is gorm:"-:all"`);
  const secret = String(user.password);
  assert.equal(secret.includes("pbkdf2"), false);
  assert.equal(secret.includes("argon"), false);
  assert.equal(secret.startsWith("$"), false);
}

test("original GetAllUsers User JSON includes empty password fields", async () => {
  const { e, auth } = await boot();
  const users = await json(new Request("http://local/api/user/?p=1&page_size=20&sort_by=id&sort_order=asc", { headers: auth }), e);
  assert.equal(users.body.success, true, String(users.body.message));
  const page = users.body.data as { items: Record<string, unknown>[]; total: number; page: number; page_size: number };
  assert.equal(page.page, 1);
  assert.ok(page.items.length >= 1);
  assertOmittedSecrets(page.items[0], "GetAllUsers");
  assert.equal(page.items[0].DeletedAt, null);
  assert.equal(page.items[0].username, "root");
});

test("original GetAllUsers JSON ignores keyword and keeps User list fields", async () => {
  const { e, auth } = await boot();
  const listed = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "list-alpha-user", password: "password12", display_name: "Alpha" }),
    }),
    e,
  );
  assert.equal(listed.body.success, true, String(listed.body.message));
  const other = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "list-beta-user", password: "password12", display_name: "Beta" }),
    }),
    e,
  );
  assert.equal(other.body.success, true, String(other.body.message));

  const all = await json(
    new Request("http://local/api/user/?keyword=list-alpha-user&page_size=100", { headers: auth }),
    e,
  );
  assert.equal(all.body.success, true, String(all.body.message));
  assert.equal(all.body.message, "");
  const data = all.body.data as {
    items: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
  };
  assert.ok(Array.isArray(data.items));
  assert.equal(typeof data.total, "number");
  assert.equal(data.page, 1);
  assert.equal(data.page_size, 100);
  const names = data.items.map((u) => String(u.username));
  assert.ok(names.includes("list-alpha-user"));
  assert.ok(names.includes("list-beta-user"), "GetAllUsers must not apply keyword LIKE");
  assertOmittedSecrets(data.items.find((u) => u.username === "list-alpha-user") as Record<string, unknown>, "GetAllUsers keyword");

  const searched = await json(new Request("http://local/api/user/search?keyword=list-alpha-user", { headers: auth }), e);
  const searchNames = ((searched.body.data as { items: { username: string }[] }).items || []).map((u) => u.username);
  assert.deepEqual(searchNames, ["list-alpha-user"]);
});

test("original SearchUsers User JSON includes empty password fields", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "listed", password: "password12", display_name: "Listed User" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const searched = await json(new Request("http://local/api/user/search?keyword=listed", { headers: auth }), e);
  assert.equal(searched.body.success, true, String(searched.body.message));
  const page = searched.body.data as { items: Record<string, unknown>[] };
  const found = page.items.find((u) => u.username === "listed");
  assert.ok(found);
  assertOmittedSecrets(found, "SearchUsers");
  assert.equal(found.display_name, "Listed User");
});

test("original GetUser User JSON includes empty password fields and admin_permissions", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "target", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const searched = await json(new Request("http://local/api/user/search?keyword=target", { headers: auth }), e);
  const row = ((searched.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "target");
  assert.ok(row);
  const got = await json(new Request("http://local/api/user/" + row.id, { headers: auth }), e);
  assert.equal(got.body.success, true, String(got.body.message));
  const data = got.body.data as Record<string, unknown>;
  assertOmittedSecrets(data, "GetUser");
  const perms = data.admin_permissions as Record<string, Record<string, boolean>>;
  assert.equal(typeof perms, "object");
  assert.equal(typeof perms.channel, "object");
  assert.equal(typeof perms.channel.read, "boolean");
  assert.equal(typeof perms.channel.operate, "boolean");
  assert.equal(typeof perms.channel.write, "boolean");
  assert.equal(typeof perms.channel.sensitive_write, "boolean");
  assert.equal(typeof perms.channel.secret_view, "boolean");
  assert.equal(typeof perms.audit, "object");
  assert.equal(typeof perms.audit.read, "boolean");
  assert.equal(typeof perms.task_plugin, "object");
  assert.equal(typeof perms.task_plugin.bind, "boolean");
});
