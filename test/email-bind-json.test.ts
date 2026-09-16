import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { parseEmailBindingState } from "../src/email-binding.js";
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

async function passwordProof(e: Env, auth: Record<string, string>, scope: string, extra: Record<string, unknown> = {}) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12", ...extra }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

function codeFromHtml(html: string): string {
  const m = html.match(/<strong>([0-9]{6})<\/strong>/);
  assert.ok(m, "missing original email binding code HTML");
  return m[1];
}

function mockResend() {
  const inbox: { to: string; subject: string; html: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
      const body = (await req.json()) as { to: string; subject: string; html: string };
      inbox.push(body);
      return Response.json({ id: "email_test" });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return { origFetch, inbox };
}

test("original EmailBindStart/Finish JSON: EmailBindingData, old_code, hashed codes, error codes", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ResendApiKey", "re_test");
  await store.setOption("SystemName", "new-api");
  const { origFetch, inbox } = mockResend();

  try {
    const unauth = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      e,
    );
    assert.equal(unauth.res.status, 401);
    assert.equal(unauth.body.code, "AUTH_UNAUTHORIZED");

    const badJson = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: auth,
        body: "{",
      }),
      e,
    );
    assert.equal(badJson.res.status, 400);
    assert.equal(badJson.body.code, "SECURITY_CONTEXT_INVALID");
    assert.equal(badJson.body.message, "The action details are invalid.");

    const invalid = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email: "not-an-email" }),
      }),
      e,
    );
    assert.equal(invalid.body.success, false);
    assert.equal(invalid.body.code, "EMAIL_ADDRESS_REJECTED");
    assert.equal(invalid.body.message, "Please enter a valid email address");

    const proof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "email", email: "new@example.com" } });
    const started = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": proof.proof_token },
        body: JSON.stringify({ email: "New@Example.com" }),
      }),
      e,
    );
    assert.equal(started.body.success, true, String(started.body.message));
    assert.equal(started.body.message, "");
    const data = started.body.data as {
      flow_token: string;
      email: string;
      current_email: string;
      old_email_required: boolean;
      expires_at: number;
      resend_at: number;
      notification_warning: boolean;
    };
    assert.equal(data.email, "new@example.com");
    assert.equal(data.current_email, "***masked***");
    assert.equal(data.old_email_required, false);
    assert.equal(typeof data.flow_token, "string");
    assert.equal(typeof data.expires_at, "number");
    assert.equal(typeof data.resend_at, "number");
    assert.equal(typeof data.notification_warning, "boolean");
    assert.ok(data.resend_at >= data.expires_at - 600);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].to, "new@example.com");
    assert.equal(inbox[0].subject, "new-api — Confirm your email address");
    const newCode = codeFromHtml(inbox[0].html);
    const flowRow = await store.getAuthFlow(data.flow_token);
    const state = parseEmailBindingState(flowRow?.payload || "");
    assert.ok(state);
    assert.notEqual(state.new_code_hash, newCode);
    assert.equal(state.old_code_hash || "", "");

    const tooSoon = await json(
      new Request("http://local/api/oauth/email/bind/resend", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ flow_token: data.flow_token }),
      }),
      e,
    );
    assert.equal(tooSoon.res.status, 429);
    assert.equal(tooSoon.body.code, "EMAIL_BINDING_RESEND_WAIT");
    assert.equal(tooSoon.body.message, "Please wait before requesting another verification code.");
    assert.equal("data" in tooSoon.body, false);

    const missingOld = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ flow_token: data.flow_token, new_code: "000000" }),
      }),
      e,
    );
    assert.equal(missingOld.body.success, false);
    assert.equal(missingOld.body.code, "EMAIL_BINDING_CODE_INVALID");
    assert.equal(missingOld.body.message, "Email verification code is incorrect.");
    assert.equal("data" in missingOld.body, false);

    const finished = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ flow_token: data.flow_token, new_code: newCode }),
      }),
      e,
    );
    assert.equal(finished.body.success, true, String(finished.body.message));
    assert.equal(finished.body.message, "");
    const finishData = finished.body.data as { notification_warning: boolean; action?: string };
    assert.equal(typeof finishData.notification_warning, "boolean");
    assert.equal("action" in finishData, false);
    assert.equal((await store.getUserById(1))?.email, "new@example.com");

    const replay = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ flow_token: data.flow_token, new_code: newCode }),
      }),
      e,
    );
    assert.equal(replay.body.success, false);
    assert.equal(replay.body.code, "AUTH_FLOW_INVALID");
    assert.equal(replay.body.message, "Verification flow expired");

    const legacy = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email: "other@example.com", code: "123456" }),
      }),
      e,
    );
    assert.equal(legacy.body.success, false);
    assert.equal(legacy.body.code, "AUTH_FLOW_INVALID");

    await store.insertUser({ username: "other", aff_code: "emother", email: "taken@example.com" });
    const takenProof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "email", email: "taken@example.com" } });
    const taken = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": takenProof.proof_token },
        body: JSON.stringify({ email: "taken@example.com" }),
      }),
      e,
    );
    assert.equal(taken.body.success, false);
    assert.equal(taken.body.code, "EMAIL_ALREADY_TAKEN");
    assert.equal(taken.body.message, "This email address is already in use.");

    const replaceProof = await passwordProof(e, auth, "account.binding.bind", { context: { provider: "email", email: "next@example.com" } });
    inbox.length = 0;
    const replace = await json(
      new Request("http://local/api/oauth/email/bind/start", {
        method: "POST",
        headers: { ...auth, "X-Security-Proof": replaceProof.proof_token },
        body: JSON.stringify({ email: "next@example.com" }),
      }),
      e,
    );
    assert.equal(replace.body.success, true, String(replace.body.message));
    const replaceData = replace.body.data as { flow_token: string; old_email_required: boolean; current_email: string };
    assert.equal(replaceData.old_email_required, true);
    assert.equal(replaceData.current_email, "***@example.com");
    assert.equal(inbox.length, 2);
    const nextCode = codeFromHtml(inbox.find((m) => m.to === "next@example.com")!.html);
    const oldCode = codeFromHtml(inbox.find((m) => m.to === "new@example.com")!.html);
    const withoutOld = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ flow_token: replaceData.flow_token, new_code: nextCode }),
      }),
      e,
    );
    assert.equal(withoutOld.body.code, "EMAIL_BINDING_CODE_INVALID");
    assert.equal((await store.getUserById(1))?.email, "new@example.com");
    const replaced = await json(
      new Request("http://local/api/oauth/email/bind", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ flow_token: replaceData.flow_token, new_code: nextCode, old_code: oldCode }),
      }),
      e,
    );
    assert.equal(replaced.body.success, true, String(replaced.body.message));
    assert.equal((await store.getUserById(1))?.email, "next@example.com");
  } finally {
    globalThis.fetch = origFetch;
  }
});
