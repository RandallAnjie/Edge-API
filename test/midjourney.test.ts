import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_MIDJOURNEY, ROOT_QUOTA, nowMs } from "../src/constants.js";
import { covertMjpActionToModelName, mjSubmitConsumeContent, mjSwapFaceConsumeContent } from "../src/midjourney-billing.js";
import { coverMidjourneyTaskDto, mjUpstreamError, path2RelayModeMidjourney } from "../src/midjourney.js";
import {
  checkMjTaskNeedUpdate,
  MJ_UPSTREAM_TIMEOUT_MS,
  runMidjourneyTaskUpdateOnce,
  runPendingMidjourneyPoll,
  SYSTEM_TASK_TYPE_MIDJOURNEY_POLL,
} from "../src/midjourney-poll.js";
import worker, { handleFetch } from "../src/worker.js";
import { createMemoryD1 } from "./d1-memory.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

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
  const store = new Store(e.DB);
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "mj-token", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mj-channel",
        type: CHANNEL_TYPE_MIDJOURNEY,
        key: "mj-secret",
        models: "mj_imagine,mj_describe,mj_blend,swap_face,mj_video,mj_edits,mj_upscale,mj_variation,mj_reroll",
        group: "default",
        base_url: "https://mj.example.test",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  return { e, auth, store, sk };
}

test("original CovertMjpActionToModelName and consume content JSON", () => {
  assert.equal(covertMjpActionToModelName("IMAGINE"), "mj_imagine");
  assert.equal(covertMjpActionToModelName("SWAP_FACE"), "swap_face");
  assert.equal(path2RelayModeMidjourney("/submit/imagine"), "imagine");
  assert.equal(path2RelayModeMidjourney("/task/abc/fetch"), "fetch");
  assert.equal(mjSubmitConsumeContent(0.1, 1, "IMAGINE", "mj-abc"), "模型固定价格 0.10，分组倍率 1.00，操作 IMAGINE，ID mj-abc");
  assert.equal(mjSwapFaceConsumeContent(0.05, 1, "SWAP_FACE"), "模型固定价格 0.05，分组倍率 1.00，操作 SWAP_FACE");
  const err = mjUpstreamError("quota_not_enough");
  assert.equal(err.status, 400);
});

test("original checkMjTaskNeedUpdate videoUrls and fail_reason", () => {
  const oldTask = {
    code: 1,
    progress: "30%",
    prompt_en: "a cat",
    state: "",
    submit_time: 1,
    start_time: 2,
    finish_time: 0,
    image_url: "",
    status: "IN_PROGRESS",
    fail_reason: "",
    video_url: "",
    video_urls: "",
  };
  const unchanged = {
    progress: "30%",
    promptEn: "a cat",
    state: "",
    submitTime: 1,
    startTime: 2,
    finishTime: 0,
    imageUrl: "",
    status: "IN_PROGRESS",
    failReason: "",
    videoUrl: "",
  };
  assert.equal(checkMjTaskNeedUpdate(oldTask, unchanged), false);
  assert.equal(checkMjTaskNeedUpdate(oldTask, { ...unchanged, failReason: "x" }), true);
  assert.equal(checkMjTaskNeedUpdate(oldTask, { ...unchanged, videoUrls: [{ url: "https://v" }] }), true);
});

test("original RelayMidjourneySubmit consume-log JSON and MidjourneyDto fetch fields", async () => {
  const { e, auth, store, sk } = await boot();
  const origFetch = globalThis.fetch;
  let submitHeaders: Record<string, string> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://mj.example.test/mj/submit/imagine") {
      const headers = new Headers(init?.headers);
      headers.forEach((value, key) => {
        submitHeaders[key.toLowerCase()] = value;
      });
      return new Response(JSON.stringify({ code: 1, description: "success", result: "mj-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/mj/submit/imagine", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a cat" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(hit.body.code, 1);
    assert.equal(hit.body.result, "mj-abc");
    assert.equal(submitHeaders["mj-api-secret"], "mj-secret");
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA - 50_000);
    assert.equal(Number(user?.used_quota), 50_000);
    assert.equal(Number(user?.request_count), 1);
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; content: string; model_name: string; other: string }[] }).items;
    const consume = items.find((item) => item.model_name === "mj_imagine");
    assert.ok(consume, logs.text);
    assert.equal(consume?.quota, 50_000);
    assert.equal(consume?.content, "模型固定价格 0.10，分组倍率 1.00，操作 IMAGINE，ID mj-abc");
    const other = JSON.parse(consume?.other || "{}") as Record<string, unknown>;
    assert.equal(other.model_price, 0.1);
    assert.equal(other.group_ratio, 1);
    assert.equal(other.request_path, "/mj/submit/imagine");
    const fetchHit = await json(new Request("http://local/mj/task/mj-abc/fetch", { headers: { authorization: "Bearer " + sk } }), e);
    assert.equal(fetchHit.res.status, 200, fetchHit.text);
    const dto = fetchHit.body as Record<string, unknown>;
    for (const k of [
      "id",
      "action",
      "customId",
      "botType",
      "prompt",
      "promptEn",
      "description",
      "state",
      "submitTime",
      "startTime",
      "finishTime",
      "imageUrl",
      "videoUrl",
      "videoUrls",
      "status",
      "progress",
      "failReason",
      "buttons",
      "maskBase64",
      "properties",
    ]) {
      assert.ok(k in dto, "missing MidjourneyDto field " + k);
    }
    assert.equal(dto.id, "mj-abc");
    assert.equal(dto.action, "IMAGINE");
    assert.equal(dto.prompt, "a cat");
    assert.equal(dto.progress, "0%");
    const missing = await json(new Request("http://local/mj/task/missing/fetch", { headers: { authorization: "Bearer " + sk } }), e);
    assert.equal(missing.res.status, 400);
    assert.equal(missing.body.type, "upstream_error");
    assert.equal(missing.body.code, 4);
    assert.equal(missing.body.description, "task_no_found ");
    const listed = await json(
      new Request("http://local/mj/task/list-by-condition", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["mj-abc"] }),
      }),
      e,
    );
    assert.ok(Array.isArray(listed.body), listed.text);
    assert.equal((listed.body as unknown as Record<string, unknown>[])[0].id, "mj-abc");
    const img = await json(new Request("http://local/mj/image/missing-id"), e);
    assert.equal(img.res.status, 400);
    assert.equal(img.body.error, "midjourney_task_not_found");
    const notEnough = await json(
      new Request("http://local/mj/submit/imagine", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      e,
    );
    assert.equal(notEnough.body.description, "prompt_is_required ");
    assert.equal(notEnough.body.type, "upstream_error");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original midjourney_poll FAILURE RefundMidjourneyQuota other JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://mj.example.test/mj/submit/imagine") {
      return new Response(JSON.stringify({ code: 1, description: "success", result: "mj-fail" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://mj.example.test/mj/task/list-by-condition") {
      return new Response(
        JSON.stringify([{ id: "mj-fail", status: "FAILURE", progress: "100%", failReason: "upstream failed", promptEn: "a cat" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return origFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/mj/submit/imagine", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a cat" }),
      }),
      e,
    );
    assert.equal(hit.body.result, "mj-fail", hit.text);
    const summary = await runMidjourneyTaskUpdateOnce(store);
    assert.equal(summary.unfinished_tasks, 1);
    assert.equal(summary.channels_scanned, 1);
    assert.equal(summary.null_tasks_failed, 0);
    const row = await store.getMjByMjId("mj-fail");
    assert.equal(String(row?.status), "FAILURE");
    assert.equal(String(row?.progress), "100%");
    assert.equal(Number(row?.quota), 0);
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 0);
    assert.equal(Number(user?.request_count), 1);
    const logs = await json(new Request("http://local/api/log/?type=6", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; content: string; model_name: string; other: string }[] }).items;
    const refund = items.find((item) => item.model_name === "mj_imagine");
    assert.ok(refund, logs.text);
    assert.equal(refund?.quota, 50_000);
    assert.equal(refund?.content, "");
    const other = JSON.parse(refund?.other || "{}") as Record<string, unknown>;
    assert.equal(other.task_id, "mj-fail");
    assert.equal(other.reason, "构图失败");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original midjourney_poll null mj_id and missing channel fail_reason", async () => {
  const { store } = await boot();
  await store.insertMj({
    action: "IMAGINE",
    user_id: 1,
    mj_id: "",
    prompt: "null-id",
    status: "SUBMITTED",
    progress: "10%",
    quota: 50_000,
    channel_id: 1,
  });
  await store.insertMj({
    action: "IMAGINE",
    user_id: 1,
    mj_id: "mj-orphan",
    prompt: "orphan",
    status: "IN_PROGRESS",
    progress: "20%",
    quota: 12_000,
    channel_id: 99999,
  });
  const summary = await runMidjourneyTaskUpdateOnce(store);
  assert.equal(summary.unfinished_tasks, 2);
  assert.equal(summary.null_tasks_failed, 1);
  assert.equal(summary.channels_scanned, 1);
  const nullRow = (await store.listMj(1, 0, 20)).items.find((row) => String((row as { prompt?: string }).prompt) === "null-id") as
    | Record<string, unknown>
    | undefined;
  assert.equal(String(nullRow?.status), "FAILURE");
  assert.equal(String(nullRow?.progress), "100%");
  assert.equal(Number(nullRow?.quota), 50_000);
  const orphan = await store.getMjByMjId("mj-orphan");
  assert.equal(String(orphan?.status), "FAILURE");
  assert.equal(String(orphan?.progress), "100%");
  assert.equal(String(orphan?.fail_reason), "获取渠道信息失败，请联系管理员，渠道ID：99999");
  assert.equal(Number(orphan?.quota), 12_000);
  const user = await store.getUserByUsername("root");
  assert.equal(Number(user?.quota), ROOT_QUOTA);
});

test("original midjourney_poll 1-hour timeout fail_reason and scheduled system-task JSON", async () => {
  const { e, auth, store } = await boot();
  const channel = (await store.enabledChannels()).find((c) => c.type === CHANNEL_TYPE_MIDJOURNEY);
  assert.ok(channel);
  await store.insertMj({
    action: "IMAGINE",
    user_id: 1,
    mj_id: "mj-timeout",
    prompt: "old",
    status: "IN_PROGRESS",
    progress: "30%",
    quota: 50_000,
    channel_id: channel!.id,
    submit_time: nowMs() - MJ_UPSTREAM_TIMEOUT_MS - 1,
    token_id: 1,
    billing_channel_id: channel!.id,
  });
  await store.decreaseUserQuota(1, 50_000);
  await store.addUserUsedQuotaAndRequestCount(1, 50_000);
  await store.addChannelUsedQuota(channel!.id, 50_000);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://mj.example.test/mj/task/list-by-condition") {
      return new Response(JSON.stringify([{ id: "mj-timeout", status: "IN_PROGRESS", progress: "30%", promptEn: "old" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({}, e, { waitUntil(p) { pending.push(p); } });
    await Promise.all(pending);
    const row = await store.getMjByMjId("mj-timeout");
    assert.equal(String(row?.status), "FAILURE");
    assert.equal(String(row?.progress), "100%");
    assert.equal(String(row?.fail_reason), "上游任务超时（超过1小时）");
    assert.equal(Number(row?.quota), 0);
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 0);
    const tasks = await json(new Request("http://local/api/system-task/list", { headers: auth }), e);
    const sys = (tasks.body.data as Record<string, unknown>[]).find((item) => item.type === SYSTEM_TASK_TYPE_MIDJOURNEY_POLL);
    assert.ok(sys, JSON.stringify(tasks.body));
    assert.equal(sys.status, "succeeded");
    assert.equal("active_key" in sys, false);
    assert.ok(String(sys.locked_by).startsWith("workerd-"));
    const leftover = await e.DB.prepare("SELECT * FROM system_task_locks WHERE type = ?")
      .bind(SYSTEM_TASK_TYPE_MIDJOURNEY_POLL)
      .first();
    assert.equal(leftover, null);
    const result = (typeof sys.result === "string" ? JSON.parse(String(sys.result)) : sys.result) as {
      unfinished_tasks?: number;
      channels_scanned?: number;
      null_tasks_failed?: number;
    };
    assert.equal(result.unfinished_tasks, 1);
    assert.equal(result.channels_scanned, 1);
    assert.equal(result.null_tasks_failed, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original coverMidjourneyTaskDto forwarded imageUrl JSON", async () => {
  const { store } = await boot();
  await store.setOption("MjForwardUrlEnabled", "true");
  await store.setOption("ServerAddress", "https://console.example");
  const id = await store.insertMj({
    action: "IMAGINE",
    user_id: 1,
    mj_id: "mj-dto",
    prompt: "a cat",
    status: "IN_PROGRESS",
    progress: "40%",
    image_url: "https://cdn.example/cat.png",
  });
  const row = await store.getMjById(id);
  assert.ok(row);
  const dto = await coverMidjourneyTaskDto(store, row!);
  assert.equal(typeof dto.imageUrl, "string");
  assert.ok(String(dto.imageUrl).startsWith("https://console.example/mj/image/mj-dto?rand="));
  const pending = await runPendingMidjourneyPoll(store);
  assert.ok(pending);
});
