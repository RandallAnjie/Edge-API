import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateAccessPolicy,
  gjsonGet,
  gjsonString,
  parseAccessPolicy,
  publicCustomOAuthProvider,
  renderAccessDeniedMessage,
} from "../src/custom-oauth.js";

test("original custom OAuth field maps and access policy", () => {
  const body = JSON.stringify({
    id: 42,
    login: "octocat",
    name: "The Octocat",
    email: "octocat@github.com",
    ocs: { data: { id: "nc-1", displayname: "NC", email: "nc@example.com" } },
    roles: ["admin", "staff"],
    trust: 4,
  });

  assert.equal(gjsonString(body, "id"), "42");
  assert.equal(gjsonString(body, "login"), "octocat");
  assert.equal(gjsonString(body, "ocs.data.id"), "nc-1");
  assert.equal(gjsonGet(body, "missing").exists, false);

  const allow = parseAccessPolicy(JSON.stringify({
    logic: "and",
    conditions: [
      { field: "trust", op: "gte", value: 3 },
      { field: "roles", op: "contains", value: "admin" },
    ],
  }));
  assert.equal(evaluateAccessPolicy(body, allow).allowed, true);

  const deny = parseAccessPolicy(JSON.stringify({
    logic: "and",
    conditions: [{ field: "trust", op: "gte", value: 10 }],
  }));
  const denied = evaluateAccessPolicy(body, deny);
  assert.equal(denied.allowed, false);
  assert.equal(
    renderAccessDeniedMessage("blocked {{provider}} {{field}}={{current}}", "GHE", body, denied.failure),
    "blocked GHE trust=4",
  );

  const row = publicCustomOAuthProvider({
    id: 7,
    name: "GHE",
    slug: "ghe",
    icon: "github",
    enabled: 1,
    client_id: "cid",
    client_secret: "secret",
    auth_url: "https://old/authorize",
    token_url: "https://old/token",
    user_info_url: "https://old/user",
  });
  assert.equal(row.authorization_endpoint, "https://old/authorize");
  assert.equal(row.token_endpoint, "https://old/token");
  assert.equal(row.user_info_endpoint, "https://old/user");
  assert.equal(row.enabled, true);
  assert.equal(row.user_id_field, "sub");
  assert.equal("client_secret" in row, false);
});
