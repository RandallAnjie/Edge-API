import assert from "node:assert/strict";
import { test } from "node:test";
import { permissionCatalog } from "../src/authz.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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

test("original GetPermissionCatalog JSON matches authz.Catalog and Roles", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const catalog = await json(new Request("http://local/api/authz/catalog", { headers: auth }), e);
  assert.equal(catalog.body.success, true);
  assert.equal(catalog.body.message, "");
  const data = catalog.body.data as ReturnType<typeof permissionCatalog>;
  assert.deepEqual(Object.keys(data).sort(), ["resources", "roles"]);
  assert.deepEqual(
    data.resources.map((r) => r.resource),
    ["audit", "channel", "task_plugin"],
  );
  assert.deepEqual(
    data.resources.find((r) => r.resource === "channel")?.actions.map((a) => a.action),
    ["read", "operate", "write", "sensitive_write", "secret_view"],
  );
  const readAct = data.resources.find((r) => r.resource === "channel")?.actions.find((a) => a.action === "read");
  assert.equal("default_roles" in (readAct || {}), false);
  assert.deepEqual(
    data.roles.map((r) => r.key),
    ["root", "admin"],
  );
  assert.deepEqual(Object.keys(data.roles[0]).sort(), ["built_in", "grants", "key", "name", "superuser"]);
  assert.equal(data.roles[0].superuser, true);
  assert.equal(data.roles[0].grants.channel.sensitive_write, true);
  assert.equal(data.roles[1].superuser, false);
  assert.equal(data.roles[1].grants.channel.read, true);
  assert.equal(data.roles[1].grants.channel.sensitive_write, false);
  assert.equal(data.roles[1].grants.audit.read, false);
  assert.equal(data.roles[1].grants.task_plugin.bind, false);
  assert.deepEqual(data, permissionCatalog());
});

test("original authz router has no /api/authz/check", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const get = await json(new Request("http://local/api/authz/check?resource=channel&action=read", { headers: auth }), e);
  assert.equal(get.res.status, 404);
  assert.equal((get.body.error as { type?: string })?.type, "invalid_request_error");
  const post = await json(
    new Request("http://local/api/authz/check", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ resource: "channel", action: "read" }),
    }),
    e,
  );
  assert.equal(post.res.status, 404);
});
