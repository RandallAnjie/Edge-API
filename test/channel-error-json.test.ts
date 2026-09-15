import assert from "node:assert/strict";
import { test } from "node:test";
import {
  automaticDisableKeywordHit,
  automaticDisableKeywordsFromOption,
  channelAttemptFromNewApi,
  channelAttemptFromTaskRelay,
  channelAttemptFromUpstream,
  errorLogOtherJSON,
  errorWithStatusCode,
  isChannelErrorCode,
  shouldDisableChannel,
} from "../src/channel-error.js";
import { CHANNEL_AUTO_DISABLED, CHANNEL_ENABLED, CHANNEL_TYPE_KLING, automaticDisableKeywordsToString } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { formatLogOtherJSON } from "../src/dto.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
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
  return { token, auth };
}

async function putOption(e: Env, auth: Record<string, string>, key: string, value: string) {
  const hit = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key, value }),
    }),
    e,
  );
  assert.equal(hit.body.success, true, String(hit.body.message));
}

async function createChannel(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<number> {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "err-openai",
        type: 1,
        key: "sk-upstream",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://example.invalid",
        ...body,
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  return Number((ch.body.data as { id: number }).id);
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "errlog", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

function chatReq(key: string, rid = "rid-channel-error"): Request {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
      "x-oneapi-request-id": rid,
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
}

async function withMockedFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function channelView(e: Env, auth: Record<string, string>, id: number) {
  const hit = await json(new Request("http://local/api/channel/" + id, { headers: auth }), e);
  assert.equal(hit.body.success, true, String(hit.body.message));
  return hit.body.data as { id: number; status: number; other_info: string; auto_ban: number };
}

async function abilityEnabled(e: Env, channelId: number): Promise<number[]> {
  const rows = await e.DB.prepare("SELECT enabled FROM abilities WHERE channel_id = ?")
    .bind(channelId)
    .all<{ enabled: number }>();
  return (rows.results || []).map((r) => Number(r.enabled));
}

function disableStore(overrides: { enabled?: boolean; ranges?: string; keywords?: string } = {}): Store {
  return {
    optionBool: async () => overrides.enabled ?? true,
    option: async (key: string) => {
      if (key === "AutomaticDisableStatusCodes") return overrides.ranges ?? "401";
      if (key === "AutomaticDisableKeywords") return overrides.keywords ?? automaticDisableKeywordsToString();
      return "";
    },
  } as unknown as Store;
}

test("original ShouldDisableChannel order: channel: prefix, skipRetry, 401, keywords, not 500", async () => {
  assert.equal(isChannelErrorCode("channel:invalid_key"), true);
  assert.equal(isChannelErrorCode("invalid_api_key"), false);
  assert.equal(
    await shouldDisableChannel(disableStore(), channelAttemptFromNewApi("invalid auth", 500, "channel:invalid_key", true)),
    true,
  );
  assert.equal(
    await shouldDisableChannel(disableStore(), channelAttemptFromNewApi("bad convert", 400, "convert_request_failed", true)),
    false,
  );
  assert.equal(
    await shouldDisableChannel(
      disableStore(),
      channelAttemptFromUpstream(401, JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } })),
    ),
    true,
  );
  assert.equal(await shouldDisableChannel(disableStore(), channelAttemptFromUpstream(500, "internal")), false);
  assert.equal(
    await shouldDisableChannel(
      disableStore(),
      channelAttemptFromUpstream(403, JSON.stringify({ error: { message: "Permission denied" } })),
    ),
    true,
  );
  assert.equal(
    await shouldDisableChannel(
      disableStore({ enabled: false }),
      channelAttemptFromUpstream(401, JSON.stringify({ error: { message: "Unauthorized", code: "invalid_api_key" } })),
    ),
    false,
  );
  assert.equal(automaticDisableKeywordHit("PERMISSION DENIED by policy", automaticDisableKeywordsFromOption("")), true);
  assert.equal(automaticDisableKeywordHit("ok", automaticDisableKeywordsFromOption("")), false);
});

test("original processChannelError RecordErrorLog other JSON has no channel metadata", () => {
  const other = JSON.parse(
    errorLogOtherJSON({
      requestPath: "/v1/chat/completions",
      errorType: "openai_error",
      errorCode: "bad_response_status_code",
      statusCode: 502,
      useChannel: ["101"],
    }),
  ) as Record<string, unknown>;
  assert.equal(other.request_path, "/v1/chat/completions");
  assert.equal(other.error_type, "openai_error");
  assert.equal(other.error_code, "bad_response_status_code");
  assert.equal(other.status_code, 502);
  for (const key of ["channel_id", "channel_name", "channel_type"]) {
    assert.equal(key in other, false, key);
  }
  const admin = other.admin_info as { use_channel: string[] };
  assert.deepEqual(admin.use_channel, ["101"]);
  const user = JSON.parse(formatLogOtherJSON(JSON.stringify(other), "user")) as Record<string, unknown>;
  assert.equal("admin_info" in user, false);
  for (const key of ["channel_id", "channel_name", "channel_type"]) {
    assert.equal(key in user, false, key);
  }
  const upstream = channelAttemptFromUpstream(
    401,
    JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } }),
  );
  assert.equal(upstream.errorType, "openai_error");
  assert.equal(upstream.errorCode, "invalid_api_key");
  assert.equal(upstream.message, "Unauthorized");
  assert.equal(errorWithStatusCode(upstream), "status_code=401, Unauthorized");
  const task = channelAttemptFromTaskRelay({ message: "fail body", statusCode: 401 });
  assert.equal(task.errorType, "openai_error");
  assert.equal(task.errorCode, "bad_response_status_code");
});

test("original processChannelError 401 auto-disables channel and abilities", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const hit = await json(chatReq(sk), e);
      assert.equal(hit.res.status, 401, hit.text);
    },
  );
  const ch = await channelView(e, auth, id);
  assert.equal(ch.status, CHANNEL_AUTO_DISABLED);
  const info = JSON.parse(ch.other_info || "{}") as { status_reason?: string; status_time?: number };
  assert.equal(String(info.status_reason || "").startsWith("status_code=401"), true, String(info.status_reason));
  assert.equal(typeof info.status_time, "number");
  const enabled = await abilityEnabled(e, id);
  assert.ok(enabled.length);
  assert.ok(enabled.every((v) => v === 0));
});

test("original ShouldDisableChannel does not auto-disable default 500", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () => new Response("internal", { status: 500, headers: { "content-type": "text/plain" } }),
    async () => {
      const hit = await json(chatReq(sk), e);
      assert.equal(hit.res.status, 500, hit.text);
    },
  );
  const ch = await channelView(e, auth, id);
  assert.equal(ch.status, CHANNEL_ENABLED);
  const enabled = await abilityEnabled(e, id);
  assert.ok(enabled.length);
  assert.ok(enabled.every((v) => v === 1));
});

test("original AutomaticDisableKeywords Permission denied disables on 403", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "Permission denied" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const hit = await json(chatReq(sk), e);
      assert.equal(hit.res.status, 403, hit.text);
    },
  );
  const ch = await channelView(e, auth, id);
  assert.equal(ch.status, CHANNEL_AUTO_DISABLED);
  const info = JSON.parse(ch.other_info || "{}") as { status_reason?: string };
  assert.equal(String(info.status_reason || "").includes("Permission denied"), true, String(info.status_reason));
});

test("original processChannelError respects channel auto_ban=0", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createChannel(e, auth, { auto_ban: 0, name: "no-ban" });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized", code: "invalid_api_key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await json(chatReq(sk), e);
    },
  );
  const ch = await channelView(e, auth, id);
  assert.equal(ch.auto_ban, 0);
  assert.equal(ch.status, CHANNEL_ENABLED);
  const enabled = await abilityEnabled(e, id);
  assert.ok(enabled.every((v) => v === 1));
});

test("original ERROR_LOG_ENABLED RecordErrorLog other JSON fields", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { ERROR_LOG_ENABLED: "true" });
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const hit = await json(chatReq(sk, "rid-error-log"), e);
      assert.equal(hit.res.status, 401, hit.text);
    },
  );
  const adminLogs = await json(new Request("http://local/api/log/?type=5", { headers: auth }), e);
  const adminItems = ((adminLogs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter((row) => {
    try {
      const other = JSON.parse(String(row.other || "{}")) as Record<string, unknown>;
      return other.error_type === "openai_error";
    } catch {
      return false;
    }
  });
  assert.equal(adminItems.length >= 1, true, JSON.stringify(adminLogs.body));
  const stored = JSON.parse(String(adminItems[0].other || "{}")) as Record<string, unknown>;
  assert.equal(stored.request_path, "/v1/chat/completions");
  assert.equal(stored.error_type, "openai_error");
  assert.equal(stored.error_code, "invalid_api_key");
  assert.equal(stored.status_code, 401);
  for (const key of ["channel_id", "channel_name", "channel_type"]) {
    assert.equal(key in stored, false, key);
  }
  const adminInfo = stored.admin_info as { use_channel?: unknown };
  assert.deepEqual(adminInfo.use_channel, [String(id)]);
  assert.equal(adminItems[0].channel, id);
  assert.equal(adminItems[0].content, "status_code=401, Unauthorized");

  const selfLogs = await json(new Request("http://local/api/log/self?type=5", { headers: auth }), e);
  const selfItems = ((selfLogs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter((row) => {
    try {
      const other = JSON.parse(String(row.other || "{}")) as Record<string, unknown>;
      return other.error_type === "openai_error";
    } catch {
      return false;
    }
  });
  assert.equal(selfItems.length >= 1, true, JSON.stringify(selfLogs.body));
  const userOther = JSON.parse(String(selfItems[0].other || "{}")) as Record<string, unknown>;
  assert.equal("admin_info" in userOther, false);
  for (const key of ["channel_id", "channel_name", "channel_type"]) {
    assert.equal(key in userOther, false, key);
  }
  assert.equal(selfItems[0].channel_name, "");
});

test("original RelayTask processChannelError 401 auto-disables native plugin channel", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "kling-v1": 1 }));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "kling-native-err",
        type: CHANNEL_TYPE_KLING,
        key: "sk-test",
        models: "kling-v1",
        group: "default",
        base_url: "https://kling.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const id = Number((ch.body.data as { id: number }).id);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const hit = await json(
        new Request("http://local/kling/v1/videos/text2video", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model_name: "kling-v1", prompt: "a lighthouse" }),
        }),
        e,
      );
      assert.equal(hit.res.status, 401, hit.text);
    },
  );
  const view = await channelView(e, auth, id);
  assert.equal(view.status, CHANNEL_AUTO_DISABLED);
  const enabled = await abilityEnabled(e, id);
  assert.ok(enabled.length);
  assert.ok(enabled.every((v) => v === 0));
});
