/**
 * Original `relay.RelayMidjourney*` + `controller.RelayMidjourney` on workerd.
 */
import { channelKind, resolveBaseUrl } from "./catalog.js";
import { selectDistributedChannel } from "./channel-select.js";
import { CHANNEL_ENABLED, nowMs } from "./constants.js";
import { json, noAvailableChannelMessage, openaiError } from "./http.js";
import {
  covertMjpActionToModelName,
  generateMjOtherInfo,
  mjBillingChannelId,
  mjSubmitConsumeContent,
  mjSwapFaceConsumeContent,
  prepareMidjourneyTaskBilling,
  recordMjConsumeLog,
  settleMidjourneyTaskBilling,
  type MjPriceInfo,
} from "./midjourney-billing.js";
import { pickChannelKey } from "./select.js";
import type { Store } from "./store.js";
import { modelPriceHelperPerCall, type NativeTaskError } from "./task-plugin-submit.js";
import type { TaskPriceData } from "./task-plugin-billing.js";
import type { AuthToken, ChannelRow, Env } from "./types.js";

export const MJ_ACTION_IMAGINE = "IMAGINE";
export const MJ_ACTION_DESCRIBE = "DESCRIBE";
export const MJ_ACTION_BLEND = "BLEND";
export const MJ_ACTION_UPSCALE = "UPSCALE";
export const MJ_ACTION_VARIATION = "VARIATION";
export const MJ_ACTION_REROLL = "REROLL";
export const MJ_ACTION_INPAINT = "INPAINT";
export const MJ_ACTION_MODAL = "MODAL";
export const MJ_ACTION_ZOOM = "ZOOM";
export const MJ_ACTION_CUSTOM_ZOOM = "CUSTOM_ZOOM";
export const MJ_ACTION_SHORTEN = "SHORTEN";
export const MJ_ACTION_HIGH_VARIATION = "HIGH_VARIATION";
export const MJ_ACTION_LOW_VARIATION = "LOW_VARIATION";
export const MJ_ACTION_PAN = "PAN";
export const MJ_ACTION_SWAP_FACE = "SWAP_FACE";
export const MJ_ACTION_UPLOAD = "UPLOAD";
export const MJ_ACTION_VIDEO = "VIDEO";
export const MJ_ACTION_EDITS = "EDITS";

export type MjRelayMode =
  | "unknown"
  | "imagine"
  | "describe"
  | "blend"
  | "change"
  | "notify"
  | "fetch"
  | "image-seed"
  | "list-by-condition"
  | "action"
  | "modal"
  | "shorten"
  | "upload"
  | "video"
  | "edits"
  | "swap-face"
  | "image";

type MidjourneyResponse = {
  code: number;
  description: string;
  properties: unknown;
  result: string;
};

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isPriceError(value: TaskPriceData | NativeTaskError): value is NativeTaskError {
  return "statusCode" in value && "localError" in value;
}

function priceInfo(priced: TaskPriceData): MjPriceInfo {
  return {
    quota: priced.quota,
    modelPrice: priced.modelPrice,
    groupRatio: priced.groupRatio,
    groupSpecialRatio: priced.groupSpecialRatio,
    hasSpecialRatio: priced.hasSpecialRatio,
  };
}

/** Original `controller.RelayMidjourney` error envelope. */
export function mjUpstreamError(description: string, result = "", code = 4, status = 0): Response {
  const statusCode = status || (code === 30 ? 429 : 400);
  return json(statusCode, {
    description: `${description} ${result}`,
    type: "upstream_error",
    code,
  });
}

/** Original `relay.Path2RelayModeMidjourney` on the `/mj` relative path. */
export function path2RelayModeMidjourney(path: string): MjRelayMode {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (p.endsWith("/submit/action") || p === "/submit/action") return "action";
  if (p.endsWith("/submit/modal")) return "modal";
  if (p.endsWith("/submit/shorten")) return "shorten";
  if (p.endsWith("/insight-face/swap")) return "swap-face";
  if (p.endsWith("/submit/upload-discord-images")) return "upload";
  if (p.endsWith("/submit/imagine")) return "imagine";
  if (p.endsWith("/submit/video")) return "video";
  if (p.endsWith("/submit/edits")) return "edits";
  if (p.endsWith("/submit/blend")) return "blend";
  if (p.endsWith("/submit/describe")) return "describe";
  if (p.endsWith("/notify")) return "notify";
  if (p.endsWith("/submit/change") || p.endsWith("/submit/simple-change")) return "change";
  if (p.endsWith("/fetch")) return "fetch";
  if (p.endsWith("/image-seed")) return "image-seed";
  if (p.endsWith("/list-by-condition")) return "list-by-condition";
  if (/^\/image\/[^/]+$/.test(p)) return "image";
  return "unknown";
}

/** Original `relay.getMjRequestPath` → `/mj` + relative path. */
export function mjUpstreamPath(path: string): string {
  const relative = path.startsWith("/") ? path : `/${path}`;
  return "/mj" + relative;
}

export function coverPlusActionToNormalAction(body: Record<string, unknown>): MidjourneyResponse | null {
  const customId = String(body.customId || "");
  if (!customId) return { code: 4, description: "custom_id_is_required", properties: null, result: "" };
  const splits = customId.split("::");
  let action = "";
  if (splits.length > 2 && splits[1] === "JOB") action = splits[2];
  else if (splits.length > 1) action = splits[1];
  if (!action) return { code: 4, description: "unknown_action", properties: null, result: "" };
  if (action.includes("upsample")) {
    const index = Number(splits[3]);
    if (!Number.isInteger(index)) return { code: 4, description: "index_parse_failed", properties: null, result: "" };
    body.index = index;
    body.action = MJ_ACTION_UPSCALE;
  } else if (action.includes("variation")) {
    body.index = 1;
    if (action === "variation") {
      const index = Number(splits[3]);
      if (!Number.isInteger(index)) return { code: 4, description: "index_parse_failed", properties: null, result: "" };
      body.index = index;
      body.action = MJ_ACTION_VARIATION;
    } else if (action === "low_variation") {
      body.action = MJ_ACTION_LOW_VARIATION;
    } else if (action === "high_variation") {
      body.action = MJ_ACTION_HIGH_VARIATION;
    }
  } else if (action.includes("pan")) {
    body.action = MJ_ACTION_PAN;
    body.index = 1;
  } else if (action.includes("reroll")) {
    body.action = MJ_ACTION_REROLL;
    body.index = 1;
  } else if (action === "Outpaint") {
    body.action = MJ_ACTION_ZOOM;
    body.index = 1;
  } else if (action === "CustomZoom") {
    body.action = MJ_ACTION_CUSTOM_ZOOM;
    body.index = 1;
  } else if (action === "Inpaint") {
    body.action = MJ_ACTION_INPAINT;
    body.index = 1;
  } else {
    return { code: 4, description: "unknown_action:" + customId, properties: null, result: "" };
  }
  return null;
}

export function convertSimpleChangeParams(content: string): { taskId: string; action: string; index: number } | null {
  const split = content.split(" ");
  if (split.length !== 2) return null;
  const action = split[1].toLowerCase();
  const params = { taskId: split[0], action: "", index: 0 };
  if (action[0] === "u") params.action = MJ_ACTION_UPSCALE;
  else if (action[0] === "v") params.action = MJ_ACTION_VARIATION;
  else if (action === "r") {
    params.action = MJ_ACTION_REROLL;
    return params;
  } else return null;
  const index = Number(action.slice(1, 2));
  if (!Number.isInteger(index) || index < 1 || index > 4) return null;
  params.index = index;
  return params;
}

function parseJsonMaybe(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Original `relay.coverMidjourneyTaskDto`. */
export async function coverMidjourneyTaskDto(
  store: Store,
  origin: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mjId = String(origin.mj_id || "");
  const forward = await store.optionBool("MjForwardUrlEnabled", true);
  const server = String((await store.option("ServerAddress")) || "");
  let imageUrl = String(origin.image_url || "");
  if (imageUrl && forward) {
    imageUrl = `${server.replace(/\/$/, "")}/mj/image/${mjId}`;
    if (String(origin.status || "") !== "SUCCESS") imageUrl += `?rand=${nowMs()}000000`;
  }
  const buttonsRaw = String(origin.buttons || "");
  const buttons = buttonsRaw ? parseJsonMaybe(buttonsRaw) : null;
  const videoUrlsRaw = String(origin.video_urls || "");
  const videoUrls = videoUrlsRaw ? parseJsonMaybe(videoUrlsRaw) : null;
  const propertiesRaw = String(origin.properties || "");
  const properties = propertiesRaw ? parseJsonMaybe(propertiesRaw) : null;
  return {
    id: mjId,
    action: String(origin.action || ""),
    customId: "",
    botType: "",
    prompt: String(origin.prompt || ""),
    promptEn: String(origin.prompt_en || ""),
    description: String(origin.description || ""),
    state: String(origin.state || ""),
    submitTime: Number(origin.submit_time || 0),
    startTime: Number(origin.start_time || 0),
    finishTime: Number(origin.finish_time || 0),
    imageUrl,
    videoUrl: String(origin.video_url || ""),
    videoUrls: Array.isArray(videoUrls) ? videoUrls : videoUrls,
    status: String(origin.status || ""),
    progress: String(origin.progress || ""),
    failReason: String(origin.fail_reason || ""),
    buttons: buttons ?? null,
    maskBase64: "",
    properties: properties && typeof properties === "object" ? properties : null,
  };
}

async function relayFetch(store: Store, userId: number, mjId: string): Promise<Response> {
  const origin = await store.getMjByUserMjId(userId, mjId);
  if (!origin) return mjUpstreamError("task_no_found");
  return json(200, await coverMidjourneyTaskDto(store, origin));
}

async function relayListByCondition(store: Store, userId: number, req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = asObj(await req.json());
  } catch {
    return mjUpstreamError("do_request_failed");
  }
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
  const tasks: Record<string, unknown>[] = [];
  if (ids.length) {
    const originTasks = await store.getMjByUserMjIds(userId, ids);
    for (const origin of originTasks) tasks.push(await coverMidjourneyTaskDto(store, origin));
  }
  return json(200, tasks);
}

async function relayNotify(store: Store, req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = asObj(await req.json());
  } catch {
    return mjUpstreamError("bind_request_body_failed");
  }
  const mjId = String(body.id || body.mj_id || "");
  const origin = await store.getMjByMjId(mjId);
  if (!origin) return mjUpstreamError("midjourney_task_not_found");
  const videoUrls = body.videoUrls;
  let videoUrlsStr = "";
  if (videoUrls != null) {
    try {
      videoUrlsStr = JSON.stringify(videoUrls);
    } catch {
      videoUrlsStr = "[]";
    }
  }
  await store.updateMj(Number(origin.id || 0), {
    progress: body.progress ?? origin.progress,
    prompt_en: body.promptEn ?? origin.prompt_en,
    state: body.state ?? origin.state,
    submit_time: body.submitTime ?? origin.submit_time,
    start_time: body.startTime ?? origin.start_time,
    finish_time: body.finishTime ?? origin.finish_time,
    image_url: body.imageUrl ?? origin.image_url,
    video_url: body.videoUrl ?? origin.video_url,
    video_urls: videoUrlsStr,
    status: body.status ?? origin.status,
    fail_reason: body.failReason ?? origin.fail_reason,
  });
  return new Response(null, { status: 200 });
}

async function relayImage(store: Store, mjId: string): Promise<Response> {
  const task = await store.getMjByMjId(mjId);
  if (!task) return json(400, { error: "midjourney_task_not_found" });
  const imageUrl = String(task.image_url || "");
  try {
    const res = await fetch(imageUrl);
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      return json(res.status, { error: text });
    }
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buf = await res.arrayBuffer();
    return new Response(buf, { status: 200, headers: { "content-type": contentType } });
  } catch {
    return json(500, { error: "http_get_image_failed" });
  }
}

async function doMidjourneyHttpRequest(
  req: Request,
  store: Store,
  channel: ChannelRow,
  fullUrl: string,
): Promise<{ statusCode: number; response: MidjourneyResponse; body: string; localError?: boolean }> {
  let mapResult: Record<string, unknown> | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      mapResult = asObj(await req.clone().json());
    } catch {
      return {
        statusCode: 500,
        response: { code: 5, description: "read_request_body_failed", properties: null, result: "" },
        body: "",
        localError: true,
      };
    }
    if (!(await store.optionBool("MjAccountFilterEnabled", false))) delete mapResult.accountFilter;
    if (!(await store.optionBool("MjNotifyEnabled", false))) delete mapResult.notifyHook;
    if (await store.optionBool("MjModeClearEnabled", false)) {
      if (typeof mapResult.prompt === "string") {
        mapResult.prompt = String(mapResult.prompt).replace(/--fast/g, "").replace(/--relax/g, "").replace(/--turbo/g, "");
      }
    }
  }
  const reqBody = mapResult ? JSON.stringify(mapResult) : null;
  const headers: Record<string, string> = {
    "content-type": req.headers.get("content-type") || "application/json",
  };
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;
  const auth = pickChannelKey(channel.key).replace(/^Bearer\s+/i, "");
  if (auth) headers["mj-api-secret"] = auth;
  let res: Response;
  try {
    res = await fetch(fullUrl, {
      method: req.method,
      headers,
      body: reqBody,
    });
  } catch {
    return {
      statusCode: 500,
      response: { code: 5, description: "do_request_failed", properties: null, result: "" },
      body: "",
      localError: true,
    };
  }
  const body = await res.text();
  if (!body) {
    return {
      statusCode: res.status,
      response: { code: 5, description: "empty_response_body", properties: null, result: "" },
      body,
    };
  }
  let parsed: MidjourneyResponse = { code: 0, description: "", properties: null, result: "" };
  try {
    const obj = asObj(JSON.parse(body));
    parsed = {
      code: Number(obj.code || 0),
      description: String(obj.description || ""),
      properties: obj.properties ?? null,
      result: typeof obj.result === "string" ? String(obj.result) : Array.isArray(obj.result) ? "" : String(obj.result || ""),
    };
  } catch {
    return {
      statusCode: res.status,
      response: { code: 5, description: "unmarshal_response_body_failed", properties: null, result: "" },
      body,
    };
  }
  return { statusCode: res.status, response: parsed, body };
}

async function pickMjChannel(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  model: string;
}): Promise<ChannelRow | Response> {
  const selected = await selectDistributedChannel({
    store: opts.store,
    env: opts.env,
    req: opts.req,
    auth: opts.auth,
    model: opts.model,
    requestPath: new URL(opts.req.url).pathname,
    body: null,
    headers: {},
  });
  if (selected.channel) return selected.channel;
  const fallback = (await opts.store.enabledChannels()).find((c) => channelKind(c.type) === "mj");
  if (fallback) return fallback;
  if (selected.error) return openaiError(selected.error.status, selected.error.message, selected.error.code);
  return openaiError(503, noAvailableChannelMessage(opts.req, opts.auth.usingGroup, opts.model), "no_available_channel");
}

async function relayImageSeed(store: Store, userId: number, mjId: string, req: Request): Promise<Response> {
  const origin = await store.getMjByUserMjId(userId, mjId);
  if (!origin) return mjUpstreamError("task_no_found");
  const channel = await store.getChannel(Number(origin.channel_id || 0));
  if (!channel) return mjUpstreamError("get_channel_info_failed");
  if (Number(channel.status) !== CHANNEL_ENABLED) return mjUpstreamError("该任务所属渠道已被禁用");
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const fullUrl = base.replace(/\/+$/, "") + mjUpstreamPath(`/task/${encodeURIComponent(mjId)}/image-seed`);
  const hit = await doMidjourneyHttpRequest(req, store, channel, fullUrl);
  if (hit.response.code && hit.response.description && !hit.body) {
    return mjUpstreamError(hit.response.description, hit.response.result, hit.response.code);
  }
  return new Response(hit.body, {
    status: hit.statusCode,
    headers: { "content-type": "application/json" },
  });
}

async function persistAndBill(opts: {
  store: Store;
  auth: AuthToken;
  channel: ChannelRow;
  action: string;
  modelName: string;
  prompt: string;
  midj: MidjourneyResponse;
  statusCode: number;
  consumeQuota: boolean;
  price: MjPriceInfo;
  requestPath: string;
  content: string;
  startMs: number;
}): Promise<Response | null> {
  const task: Record<string, unknown> = {
    user_id: opts.auth.user.id,
    code: opts.midj.code,
    action: opts.action,
    mj_id: opts.midj.result,
    prompt: opts.prompt,
    prompt_en: "",
    description: opts.midj.description,
    state: "",
    submit_time: opts.startMs,
    start_time: 0,
    finish_time: 0,
    image_url: "",
    status: "",
    progress: "0%",
    fail_reason: "",
    channel_id: opts.channel.id,
  };
  if (opts.midj.code === 3) {
    const autoDisable = await opts.store.optionBool("AutomaticDisableChannelEnabled", false);
    if (autoDisable && Number(opts.channel.auto_ban) === 1) await opts.store.autoDisableChannel(opts.channel.id);
  }
  let consume = opts.consumeQuota;
  if (opts.midj.code !== 1 && opts.midj.code !== 21 && opts.midj.code !== 22) {
    task.fail_reason = opts.midj.description;
    consume = false;
  }
  if (opts.midj.code === 21) {
    const properties = asObj(opts.midj.properties);
    const imageUrl = String(properties.imageUrl || "");
    const status = String(properties.status || "");
    if (imageUrl && status) {
      task.image_url = imageUrl;
      task.status = status;
      if (status === "SUCCESS") {
        task.progress = "100%";
        const now = nowMs();
        task.start_time = now;
        task.finish_time = now;
        opts.midj.code = 1;
      }
    }
  }
  if (opts.midj.code === 1 && opts.action === MJ_ACTION_UPLOAD) {
    task.progress = "100%";
    task.status = "SUCCESS";
  }
  const prepared = prepareMidjourneyTaskBilling(task, opts.price.quota, consume && opts.statusCode === 200, opts.channel.id);
  const id = await opts.store.insertMj(task);
  if (!id) return mjUpstreamError("insert_midjourney_task_failed");
  task.id = id;
  const applied = await settleMidjourneyTaskBilling(opts.store, opts.auth.user, opts.auth.token.id, task, prepared);
  if (applied) {
    await recordMjConsumeLog({
      store: opts.store,
      user: opts.auth.user,
      tokenId: Number(task.token_id || 0),
      channelId: mjBillingChannelId(task),
      group: opts.auth.usingGroup,
      modelName: opts.modelName,
      quota: Number(task.quota || 0),
      content: opts.content,
      other: generateMjOtherInfo(opts.price, opts.requestPath),
    });
  }
  return null;
}

async function relaySwapFace(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
}): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = asObj(await opts.req.clone().json());
  } catch {
    return mjUpstreamError("bind_request_body_failed");
  }
  if (!body.sourceBase64 || !body.targetBase64) return mjUpstreamError("sour_base64_and_target_base64_is_required");
  const modelName = covertMjpActionToModelName(MJ_ACTION_SWAP_FACE);
  const priced = await modelPriceHelperPerCall(
    opts.store,
    modelName,
    opts.auth.usingGroup,
    Number(opts.auth.user.role || 0),
    opts.auth.user.settings,
    opts.auth.user.group || "",
  );
  if (isPriceError(priced)) return mjUpstreamError(priced.message);
  const remain = Number(opts.auth.user.quota || 0);
  if (remain - priced.quota < 0) return mjUpstreamError("quota_not_enough");
  const channel = await pickMjChannel({ req: opts.req, env: opts.env, store: opts.store, auth: opts.auth, model: modelName });
  if (channel instanceof Response) return channel;
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const fullUrl = base.replace(/\/+$/, "") + mjUpstreamPath("/insight-face/swap");
  const hit = await doMidjourneyHttpRequest(opts.req, opts.store, channel, fullUrl);
  if (hit.localError) return mjUpstreamError(hit.response.description, hit.response.result, hit.response.code);
  const err = await persistAndBill({
    store: opts.store,
    auth: opts.auth,
    channel,
    action: MJ_ACTION_SWAP_FACE,
    modelName,
    prompt: "InsightFace",
    midj: hit.response,
    statusCode: hit.statusCode,
    consumeQuota: hit.statusCode === 200 && hit.response.code === 1,
    price: priceInfo(priced),
    requestPath: new URL(opts.req.url).pathname,
    content: mjSwapFaceConsumeContent(priced.modelPrice, priced.groupRatio, MJ_ACTION_SWAP_FACE),
    startMs: nowMs(),
  });
  if (err) return err;
  return new Response(JSON.stringify(hit.response), {
    status: hit.statusCode,
    headers: { "content-type": "application/json" },
  });
}

async function relaySubmit(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  path: string;
  mode: MjRelayMode;
}): Promise<Response> {
  let consumeQuota = true;
  let body: Record<string, unknown> = {};
  try {
    if (opts.req.method !== "GET" && opts.req.method !== "HEAD") body = asObj(await opts.req.clone().json());
  } catch {
    return mjUpstreamError("bind_request_body_failed");
  }
  let mode = opts.mode;
  if (mode === "action") {
    const plusErr = coverPlusActionToNormalAction(body);
    if (plusErr) return mjUpstreamError(plusErr.description, plusErr.result, plusErr.code);
    mode = "change";
  }
  if (mode === "video") body.action = MJ_ACTION_VIDEO;
  if (mode === "imagine") {
    if (!body.prompt) return mjUpstreamError("prompt_is_required");
    body.action = MJ_ACTION_IMAGINE;
  } else if (mode === "describe") body.action = MJ_ACTION_DESCRIBE;
  else if (mode === "edits") body.action = MJ_ACTION_EDITS;
  else if (mode === "shorten") body.action = MJ_ACTION_SHORTEN;
  else if (mode === "blend") body.action = MJ_ACTION_BLEND;
  else if (mode === "upload") body.action = MJ_ACTION_UPLOAD;
  else if (String(body.taskId || "") !== "") {
    let mjId = "";
    if (mode === "change") {
      if (!body.taskId) return mjUpstreamError("task_id_is_required");
      if (!body.action) return mjUpstreamError("action_is_required");
      if (!Number(body.index || 0)) return mjUpstreamError("index_is_required");
      mjId = String(body.taskId);
    } else if (mode === "modal") {
      mjId = String(body.taskId);
      body.action = MJ_ACTION_MODAL;
    } else if (mode === "video") {
      body.action = MJ_ACTION_VIDEO;
      if (!body.taskId) return mjUpstreamError("task_id_is_required");
      mjId = String(body.taskId);
    }
    const origin = await opts.store.getMjByUserMjId(opts.auth.user.id, mjId);
    if (!origin) return mjUpstreamError("task_not_found");
    if (await opts.store.optionBool("MjActionCheckSuccessEnabled", true)) {
      if (String(origin.status) !== "SUCCESS" && mode !== "modal") return mjUpstreamError("task_status_not_success");
    }
    const originChannel = await opts.store.getChannel(Number(origin.channel_id || 0));
    if (!originChannel) return mjUpstreamError("get_channel_info_failed");
    if (Number(originChannel.status) !== CHANNEL_ENABLED) return mjUpstreamError("该任务所属渠道已被禁用");
    body.prompt = origin.prompt;
    const action = String(body.action || "");
    if (action === MJ_ACTION_INPAINT || action === MJ_ACTION_CUSTOM_ZOOM) consumeQuota = false;
    const modelName = covertMjpActionToModelName(action);
    const priced = await modelPriceHelperPerCall(
      opts.store,
      modelName,
      opts.auth.usingGroup,
      Number(opts.auth.user.role || 0),
      opts.auth.user.settings,
      opts.auth.user.group || "",
    );
    if (isPriceError(priced)) return mjUpstreamError(priced.message);
    const remain = Number((await opts.store.getUserById(opts.auth.user.id))?.quota ?? (opts.auth.user.quota || 0));
    if (consumeQuota && remain - priced.quota < 0) return mjUpstreamError("quota_not_enough");
    const base = resolveBaseUrl(originChannel.type, originChannel.base_url);
    const fullUrl = base.replace(/\/+$/, "") + mjUpstreamPath(opts.path);
    const hit = await doMidjourneyHttpRequest(opts.req, opts.store, originChannel, fullUrl);
    if (hit.localError) return mjUpstreamError(hit.response.description, hit.response.result, hit.response.code);
    let responseBody = hit.body;
    if (hit.response.code === 21 && action !== MJ_ACTION_INPAINT && action !== MJ_ACTION_CUSTOM_ZOOM) {
      responseBody = responseBody.replace('"code":21', '"code":1');
    }
    const persistErr = await persistAndBill({
      store: opts.store,
      auth: opts.auth,
      channel: originChannel,
      action,
      modelName,
      prompt: String(body.prompt || ""),
      midj: hit.response,
      statusCode: hit.statusCode,
      consumeQuota,
      price: priceInfo(priced),
      requestPath: new URL(opts.req.url).pathname,
      content: mjSubmitConsumeContent(priced.modelPrice, priced.groupRatio, action, hit.response.result),
      startMs: nowMs(),
    });
    if (persistErr) return persistErr;
    if (hit.response.code === 22) responseBody = responseBody.replace('"code":22', '"code":1');
    return new Response(responseBody, { status: hit.statusCode, headers: { "content-type": "application/json" } });
  }

  const action = String(body.action || "");
  if (action === MJ_ACTION_INPAINT || action === MJ_ACTION_CUSTOM_ZOOM) consumeQuota = false;
  const modelName = covertMjpActionToModelName(action);
  const priced = await modelPriceHelperPerCall(
    opts.store,
    modelName,
    opts.auth.usingGroup,
    Number(opts.auth.user.role || 0),
    opts.auth.user.settings,
    opts.auth.user.group || "",
  );
  if (isPriceError(priced)) return mjUpstreamError(priced.message);
  const remain = Number((await opts.store.getUserById(opts.auth.user.id))?.quota ?? (opts.auth.user.quota || 0));
  if (consumeQuota && remain - priced.quota < 0) return mjUpstreamError("quota_not_enough");
  const channel = await pickMjChannel({ req: opts.req, env: opts.env, store: opts.store, auth: opts.auth, model: modelName });
  if (channel instanceof Response) return channel;
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const fullUrl = base.replace(/\/+$/, "") + mjUpstreamPath(opts.path);
  const hit = await doMidjourneyHttpRequest(opts.req, opts.store, channel, fullUrl);
  if (hit.localError) return mjUpstreamError(hit.response.description, hit.response.result, hit.response.code);
  let responseBody = hit.body;
  if (hit.response.code === 21 && action !== MJ_ACTION_INPAINT && action !== MJ_ACTION_CUSTOM_ZOOM) {
    responseBody = responseBody.replace('"code":21', '"code":1');
  }
  const persistErr = await persistAndBill({
    store: opts.store,
    auth: opts.auth,
    channel,
    action,
    modelName,
    prompt: String(body.prompt || ""),
    midj: hit.response,
    statusCode: hit.statusCode,
    consumeQuota,
    price: priceInfo(priced),
    requestPath: new URL(opts.req.url).pathname,
    content: mjSubmitConsumeContent(priced.modelPrice, priced.groupRatio, action, hit.response.result),
    startMs: nowMs(),
  });
  if (persistErr) return persistErr;
  if (hit.response.code === 22) responseBody = responseBody.replace('"code":22', '"code":1');
  return new Response(responseBody, { status: hit.statusCode, headers: { "content-type": "application/json" } });
}

function taskIdFromPath(path: string, suffix: string): string {
  const m = path.match(new RegExp(`/task/([^/]+)/${suffix}$`));
  return m ? decodeURIComponent(m[1]) : "";
}

function imageIdFromPath(path: string): string {
  const m = path.match(/^\/image\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** Original `controller.RelayMidjourney` + `relay.RelayMidjourneyImage`. */
export async function proxyMj(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  path: string,
): Promise<Response> {
  const mode = path2RelayModeMidjourney(path);
  if (mode === "image") return relayImage(store, imageIdFromPath(path));
  if (mode === "fetch") return relayFetch(store, auth.user.id, taskIdFromPath(path, "fetch"));
  if (mode === "list-by-condition") return relayListByCondition(store, auth.user.id, req);
  if (mode === "notify") return relayNotify(store, req);
  if (mode === "image-seed") return relayImageSeed(store, auth.user.id, taskIdFromPath(path, "image-seed"), req);
  if (mode === "swap-face") return relaySwapFace({ req, env, store, auth });
  if (mode === "unknown") return mjUpstreamError("unknown_relay_action");
  return relaySubmit({ req, env, store, auth, path, mode });
}
