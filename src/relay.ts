import { LOG_CONSUME, LOG_ERROR, parseBool } from "./constants.js";
import { channelKind } from "./catalog.js";
import {
  anthropicToOpenAI,
  estimatePromptTokens,
  extractGeminiModelAction,
  geminiToOpenAIChat,
  openaiFromAnthropicResponse,
  openaiFromGeminiResponse,
  openaiToAnthropic,
  openaiToGemini,
  sseOpenAIFromText,
  usageFromOpenAI,
  type ChatMessage,
} from "./convert.js";
import { clientIp, openaiError } from "./http.js";
import { computeQuota, remainingOk } from "./quota.js";
import { orderChannels } from "./select.js";
import { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env, ExecutionContextLike, UserRow } from "./types.js";
import { buildUpstream, modelsUrl, type RelayMode } from "./upstream.js";

export type ClientFormat = "openai" | "anthropic" | "gemini";

export interface RelayRequest {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  mode: RelayMode;
  clientFormat: ClientFormat;
  model: string;
  body: unknown;
  stream: boolean;
  path: string;
  ctx?: ExecutionContextLike;
  playground?: boolean;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function detectModel(body: unknown, path: string, url: URL): string {
  const o = asObj(body);
  if (typeof o.model === "string") return o.model;
  const gem = extractGeminiModelAction(path);
  if (gem) return gem.model;
  return url.searchParams.get("model") || "";
}

export function detectStream(body: unknown, req: Request): boolean {
  if (req.headers.get("accept")?.includes("text/event-stream")) return true;
  const o = asObj(body);
  return Boolean(o.stream);
}

function retryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 408;
}

async function fetchUpstream(target: ReturnType<typeof buildUpstream>, timeoutMs = 120_000): Promise<Response> {
  const init: RequestInit = {
    method: target.method,
    headers: target.headers,
  };
  if (target.method !== "GET" && target.body != null) {
    init.body = typeof target.body === "string" ? target.body : JSON.stringify(target.body);
  }
  return fetch(target.url, init);
}

function convertOutbound(
  kind: ReturnType<typeof channelKind>,
  client: ClientFormat,
  body: unknown,
): unknown {
  const o = asObj(body);
  if (kind === "anthropic" && client === "openai") return openaiToAnthropic(o);
  if (kind === "gemini" && client === "openai") return openaiToGemini(o);
  if (kind === "openai" && client === "anthropic") return anthropicToOpenAI(o);
  if (kind === "openai" && client === "gemini") {
    const model = String(o.model || "");
    return geminiToOpenAIChat(o, model);
  }
  if (kind === "gemini" && client === "anthropic") return openaiToGemini(anthropicToOpenAI(o));
  if (kind === "anthropic" && client === "gemini") return openaiToAnthropic(geminiToOpenAIChat(o, String(o.model || "")));
  return body;
}

function convertInbound(
  kind: ReturnType<typeof channelKind>,
  client: ClientFormat,
  upstreamJson: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (client === "openai" && kind === "anthropic") return openaiFromAnthropicResponse(upstreamJson, model);
  if (client === "openai" && kind === "gemini") return openaiFromGeminiResponse(upstreamJson, model);
  return upstreamJson;
}

async function settle(
  store: Store,
  auth: AuthToken,
  channel: ChannelRow,
  model: string,
  prompt: number,
  completion: number,
  useTime: number,
  stream: boolean,
  ip: string,
  requestId: string,
  ok: boolean,
  content: string,
): Promise<void> {
  const quota = await computeQuota(store, model, auth.usingGroup, prompt, completion);
  if (ok && quota > 0) {
    await store.consumeQuota(auth.user.id, auth.token.id, channel.id, quota);
    await store.bumpQuotaData(auth.user, model, quota, prompt + completion);
  }
  await store.insertLog({
    user_id: auth.user.id,
    type: ok ? LOG_CONSUME : LOG_ERROR,
    content,
    username: auth.user.username,
    token_name: auth.token.name,
    model_name: model,
    quota,
    prompt_tokens: prompt,
    completion_tokens: completion,
    use_time: useTime,
    is_stream: stream ? 1 : 0,
    channel_id: channel.id,
    token_id: auth.token.id,
    group: auth.usingGroup,
    ip,
    request_id: requestId,
  });
}

export async function relay(opts: RelayRequest): Promise<Response> {
  const { store, auth, mode, clientFormat, path, ctx } = opts;
  let model = opts.model;
  if (!model) return openaiError(400, "未提供模型名称", "model_not_found");
  if (!tokenAllows(auth, model)) return openaiError(403, `令牌无权访问模型 ${model}`, "model_not_allowed");

  const channels = orderChannels(await store.enabledChannels(), model, auth.usingGroup);
  if (channels.length === 0) return openaiError(503, `没有可用渠道（模型 ${model}）`, "no_available_channel");

  const retryTimes = Math.max(1, await store.optionNum("RetryTimes", 3));
  const autoDisable = await store.optionBool("AutomaticDisableChannelEnabled", false);
  const ip = clientIp(opts.req);
  const rid = opts.req.headers.get("x-oneapi-request-id") || crypto.randomUUID();

  const promptEst = estimatePromptTokens(
    asObj(opts.body).messages as ChatMessage[] | undefined,
    typeof asObj(opts.body).prompt === "string" ? String(asObj(opts.body).prompt) : undefined,
  );
  const precheck = remainingOk(
    auth.user.quota,
    auth.token.remain_quota,
    Boolean(auth.token.unlimited_quota),
    Math.max(1, promptEst),
  );
  if (precheck) return openaiError(403, precheck, "insufficient_quota");

  let lastErr = "所有渠道均失败";
  let lastStatus = 502;
  const tried = channels.slice(0, retryTimes);

  for (const channel of tried) {
    const kind = channelKind(channel.type);
    const outbound = convertOutbound(kind, clientFormat, opts.body);
    const target = buildUpstream(channel, mode, path, model, outbound, {
      "anthropic-version": opts.req.headers.get("anthropic-version") || "",
    });
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchUpstream(target);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      lastStatus = 502;
      if (autoDisable) await store.autoDisableChannel(channel.id);
      continue;
    }
    const useTime = Math.max(0, Math.round((Date.now() - started) / 1000));

    if (!res.ok && retryable(res.status) && channel !== tried[tried.length - 1]) {
      lastErr = await res.text().catch(() => res.statusText);
      lastStatus = res.status;
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      lastErr = text || res.statusText;
      lastStatus = res.status;
      await settle(store, auth, channel, model, promptEst, 0, useTime, opts.stream, ip, rid, false, lastErr.slice(0, 2000));
      if (res.status >= 500 && autoDisable) await store.autoDisableChannel(channel.id);
      if (channel !== tried[tried.length - 1] && retryable(res.status)) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        return new Response(JSON.stringify(parsed), {
          status: res.status,
          headers: { "content-type": "application/json; charset=utf-8", "x-oneapi-request-id": rid },
        });
      } catch {
        return openaiError(res.status, text.slice(0, 500) || "上游错误");
      }
    }

    const ct = res.headers.get("content-type") || "";
    const isSSE = ct.includes("text/event-stream") || opts.stream;

    if (isSSE && res.body) {
      if (kind !== "openai" && clientFormat === "openai") {
        const text = await res.text();
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { content: text };
        }
        const converted = convertInbound(kind, clientFormat, parsed, model);
        const usage = usageFromOpenAI(converted);
        const content = String(
          ((converted.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content) || "",
        );
        ctx?.waitUntil(
          settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream"),
        );
        return new Response(sseOpenAIFromText(model, content), {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-oneapi-request-id": rid,
          },
        });
      }
      const [clientBody, logBody] = res.body.tee();
      ctx?.waitUntil(
        parseStreamAndSettle(store, auth, channel, model, promptEst, useTime, ip, rid, logBody),
      );
      const headers = new Headers();
      headers.set("content-type", "text/event-stream; charset=utf-8");
      headers.set("cache-control", "no-cache");
      headers.set("x-oneapi-request-id", rid);
      return new Response(clientBody, { status: 200, headers });
    }

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, true, "binary/text");
      return new Response(text, {
        status: 200,
        headers: { "content-type": ct || "application/json", "x-oneapi-request-id": rid },
      });
    }
    const converted = convertInbound(kind, clientFormat, parsed, model);
    const usage = usageFromOpenAI(converted);
    await settle(
      store,
      auth,
      channel,
      model,
      usage.prompt || promptEst,
      usage.completion,
      useTime,
      false,
      ip,
      rid,
      true,
      "",
    );
    return new Response(JSON.stringify(converted), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "x-oneapi-request-id": rid },
    });
  }

  return openaiError(lastStatus, lastErr.slice(0, 800), "channel_error");
}

function tokenAllows(auth: AuthToken, model: string): boolean {
  if (!auth.token.model_limits_enabled) return true;
  const allowed = (auth.token.model_limits || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(model);
}

async function parseStreamAndSettle(
  store: Store,
  auth: AuthToken,
  channel: ChannelRow,
  model: string,
  promptEst: number,
  useTime: number,
  ip: string,
  rid: string,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let prompt = promptEst;
  let completion = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as Record<string, unknown>;
          const u = usageFromOpenAI(obj);
          if (u.prompt) prompt = u.prompt;
          if (u.completion) completion = u.completion;
          const delta = (obj.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content;
          if (typeof delta === "string") completion += Math.ceil(delta.length / 4);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore parse errors */
  }
  await settle(store, auth, channel, model, prompt, completion, useTime, true, ip, rid, true, "stream");
}

export async function listModelsForAuth(store: Store, auth: AuthToken, format: ClientFormat): Promise<Response> {
  const models = await store.enabledModels(auth.usingGroup);
  const created = Math.floor(Date.now() / 1000);
  if (format === "gemini") {
    return new Response(
      JSON.stringify({
        models: models.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ["generateContent"] })),
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  if (format === "anthropic") {
    return new Response(
      JSON.stringify({
        data: models.map((id) => ({ id, type: "model", created_at: created })),
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return new Response(
    JSON.stringify({
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "edge-api",
        permission: [{ id: "modelperm-" + id, object: "model_permission", created, allow_sampling: true, allow_view: true }],
        root: id,
        parent: null,
      })),
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export async function retrieveModel(store: Store, auth: AuthToken, model: string): Promise<Response> {
  const models = await store.enabledModels(auth.usingGroup);
  if (!models.includes(model)) return openaiError(404, "模型不存在", "model_not_found");
  return new Response(
    JSON.stringify({
      id: model,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "edge-api",
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export async function testChannel(store: Store, channel: ChannelRow): Promise<{ success: boolean; message: string; time: number }> {
  const started = Date.now();
  const target = modelsUrl(channel);
  try {
    const res = await fetchUpstream(target);
    const time = Date.now() - started;
    const text = await res.text();
    if (!res.ok) return { success: false, message: text.slice(0, 500) || res.statusText, time };
    await store.updateChannel(channel.id, { test_time: Math.floor(Date.now() / 1000), response_time: time });
    return { success: true, message: "测试成功", time };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e), time: Date.now() - started };
  }
}

export async function fetchUpstreamModels(channel: ChannelRow): Promise<string[]> {
  const target = modelsUrl(channel);
  const res = await fetchUpstream(target);
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 400) || res.statusText);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (Array.isArray(parsed.data)) {
    return (parsed.data as { id?: string }[]).map((x) => String(x.id || "")).filter(Boolean);
  }
  if (Array.isArray(parsed.models)) {
    return (parsed.models as { name?: string }[]).map((x) => String(x.name || "").replace(/^models\//, "")).filter(Boolean);
  }
  return [];
}

export async function playgroundRelay(
  req: Request,
  env: Env,
  store: Store,
  user: UserRow,
  body: unknown,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const tokens = await store.listTokens(user.id, 0, 1);
  let token = tokens.items[0];
  if (!token) {
    const { generateTokenKey } = await import("./crypto.js");
    const key = generateTokenKey();
    const id = await store.insertToken({
      user_id: user.id,
      key,
      name: "playground",
      unlimited_quota: 1,
      remain_quota: 0,
    });
    token = (await store.getTokenById(id, user.id))!;
  }
  const o = asObj(body);
  return relay({
    req,
    env,
    store,
    auth: { token, user, usingGroup: token.group || user.group || "default" },
    mode: "chat",
    clientFormat: "openai",
    model: String(o.model || ""),
    body,
    stream: Boolean(o.stream),
    path: "/v1/chat/completions",
    ctx,
    playground: true,
  });
}

export async function proxyMj(
  req: Request,
  store: Store,
  auth: AuthToken,
  path: string,
): Promise<Response> {
  const channels = (await store.enabledChannels()).filter((c) => channelKind(c.type) === "mj");
  const ch = channels[0];
  if (!ch) return openaiError(503, "没有可用的 Midjourney 渠道", "no_available_channel");
  const target = buildUpstream(ch, "passthrough", path, "midjourney", await readBodyMaybe(req));
  target.method = req.method;
  const res = await fetchUpstream(target);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.result) {
      await store.insertMj({
        action: path,
        user_id: auth.user.id,
        mj_id: parsed.result,
        prompt: asObj(target.body).prompt,
        status: "SUBMITTED",
        channel_id: ch.id,
      });
    }
  } catch {
    /* ignore */
  }
  return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json" } });
}

async function readBodyMaybe(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  try {
    return await req.clone().json();
  } catch {
    return null;
  }
}

void parseBool;
