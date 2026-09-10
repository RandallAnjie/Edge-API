import { csv, LOG_CONSUME, LOG_ERROR, parseBool, UNSUPPORTED_CHANNEL_TEST_TYPES } from "./constants.js";
import { recordRelayPerf } from "./perf-metrics.js";
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
import { computeQuota, remainingOk, quotaRatios } from "./quota.js";
import { pickChannelKey } from "./select.js";
import { parseChannelInfo } from "./channel-info.js";
import { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env, ExecutionContextLike, UserRow } from "./types.js";
import { applyModelMapping, buildUpstream, joinUrl, modelsUrl, type RelayMode } from "./upstream.js";
import { channelKind, channelTypeName, resolveBaseUrl } from "./catalog.js";
import {
  anthropicModel,
  consumeLogOther,
  geminiModel,
  modelNotFoundError,
  openAIModel,
  openaiModelList,
  ownerForChannelType,
} from "./dto.js";
import { ADAPTOR_MODELS } from "./channel-models.js";

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
  rawBody?: ArrayBuffer;
  rawContentType?: string;
  method?: string;
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
  void timeoutMs;
  const init: RequestInit = {
    method: target.method,
    headers: target.headers,
  };
  if (target.method !== "GET" && target.method !== "HEAD" && target.body != null) {
    if (target.body instanceof ArrayBuffer) {
      init.body = target.body;
    } else if (ArrayBuffer.isView(target.body)) {
      init.body = target.body as BufferSource;
    } else if (typeof target.body === "string") {
      init.body = target.body;
    } else {
      init.body = JSON.stringify(target.body);
    }
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
  extra: { upstreamRequestId?: string; requestPath?: string } = {},
): Promise<void> {
  const quota = await computeQuota(store, model, auth.usingGroup, prompt, completion);
  if (ok && quota > 0) {
    await store.consumeQuota(auth.user.id, auth.token.id, channel.id, quota);
    await store.bumpQuotaData(auth.user, model, quota, prompt + completion, {
      useGroup: auth.usingGroup,
      tokenId: auth.token.id,
      channelId: channel.id,
    });
  }
  const ratios = await quotaRatios(store, model, auth.usingGroup);
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
    upstream_request_id: extra.upstreamRequestId || "",
    other: consumeLogOther({
      model,
      group: auth.usingGroup,
      groupRatio: ratios.groupRatio,
      modelRatio: ratios.modelRatio,
      completionRatio: ratios.completionRatio,
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      ok,
      requestPath: extra.requestPath,
      isMultiKey: parseChannelInfo(String(channel.channel_info || "")).is_multi_key,
    }),
  });
  await recordRelayPerf(store, {
    model,
    group: auth.usingGroup,
    latencyMs: useTime * 1000,
    success: ok,
    outputTokens: completion,
    stream,
  });
}

export async function relay(opts: RelayRequest): Promise<Response> {
  const { store, auth, mode, clientFormat, path, ctx } = opts;
  let model = opts.model;
  if (!model) return openaiError(400, "未提供模型名称", "model_not_found");
  if (!tokenAllows(auth, model)) return openaiError(403, `令牌无权访问模型 ${model}`, "model_not_allowed");

  const retryTimes = Math.max(1, await store.optionNum("RetryTimes", 0));
  const first = await store.getRandomSatisfiedChannel(auth.usingGroup, model, 0);
  if (!first) return openaiError(503, `没有可用渠道（模型 ${model}）`, "no_available_channel");

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

  for (let retry = 0; retry < retryTimes; retry++) {
    const channel = retry === 0 ? first : await store.getRandomSatisfiedChannel(auth.usingGroup, model, retry);
    if (!channel) break;
    const lastAttempt = retry === retryTimes - 1;
    const kind = channelKind(channel.type);
    const outbound = opts.rawBody ? opts.body : convertOutbound(kind, clientFormat, opts.body);
    const target = buildUpstream(
      channel,
      mode,
      path,
      model,
      opts.rawBody ? null : outbound,
      {
        "anthropic-version": opts.req.headers.get("anthropic-version") || "",
      },
      opts.method || opts.req.method || "POST",
    );
    if (opts.rawBody) {
      target.body = opts.rawBody;
      if (opts.rawContentType) target.headers["content-type"] = opts.rawContentType;
      else delete target.headers["content-type"];
    }
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
    const extra = {
      upstreamRequestId: res.headers.get("x-oneapi-request-id") || res.headers.get("x-request-id") || "",
      requestPath: path,
    };

    if (!res.ok && retryable(res.status) && !lastAttempt) {
      lastErr = await res.text().catch(() => res.statusText);
      lastStatus = res.status;
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      lastErr = text || res.statusText;
      lastStatus = res.status;
      await settle(store, auth, channel, model, promptEst, 0, useTime, opts.stream, ip, rid, false, lastErr.slice(0, 2000), extra);
      if (res.status >= 500 && autoDisable) await store.autoDisableChannel(channel.id);
      if (!lastAttempt && retryable(res.status)) continue;
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
          settle(store, auth, channel, model, usage.prompt || promptEst, usage.completion, useTime, true, ip, rid, true, "stream", extra),
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
        parseStreamAndSettle(store, auth, channel, model, promptEst, useTime, ip, rid, logBody, extra),
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
      await settle(store, auth, channel, model, promptEst, 0, useTime, false, ip, rid, true, "binary/text", extra);
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
      extra,
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
  extra: { upstreamRequestId?: string; requestPath?: string } = {},
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
  await settle(store, auth, channel, model, prompt, completion, useTime, true, ip, rid, true, "stream", extra);
}

export async function listModelsForAuth(store: Store, auth: AuthToken, format: ClientFormat): Promise<Response> {
  const names = (await store.enabledModels(auth.usingGroup)).filter((id) => tokenAllows(auth, id));
  const channels = await store.enabledChannels();
  const ownerByModel = new Map<string, string>();
  for (const ch of channels) {
    const owner = ownerForChannelType(ch.type);
    for (const m of csv(ch.models)) {
      if (!ownerByModel.has(m)) ownerByModel.set(m, owner);
    }
  }
  const openaiModels = names.map((id) => openAIModel(id, ownerByModel.get(id) || "custom"));
  if (format === "gemini") {
    return new Response(
      JSON.stringify({
        models: names.map((id) => geminiModel(id)),
        nextPageToken: null,
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  if (format === "anthropic") {
    const data = names.map((id) => anthropicModel(id));
    return new Response(
      JSON.stringify({
        data,
        first_id: data[0]?.id || "",
        has_more: false,
        last_id: data[data.length - 1]?.id || "",
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return new Response(JSON.stringify(openaiModelList(openaiModels)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function retrieveModel(store: Store, auth: AuthToken, model: string, format: ClientFormat = "openai"): Promise<Response> {
  const staticHit = ADAPTOR_MODELS.find((m) => m.id === model);
  const enabled = (await store.enabledModels(auth.usingGroup)).includes(model);
  if (!staticHit && !enabled) {
    return new Response(JSON.stringify(modelNotFoundError(model)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const ownedBy = staticHit?.owned_by || "custom";
  if (format === "anthropic") {
    return new Response(JSON.stringify(anthropicModel(model)), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(openAIModel(model, ownedBy)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Original `controller.TestChannel` JSON: `{success, message, time}` with `time` in seconds. */
export async function testChannel(
  store: Store,
  channel: ChannelRow,
  _opts: { model?: string; endpointType?: string; stream?: boolean } = {},
): Promise<{ success: boolean; message: string; time: number; error_code?: string }> {
  if (UNSUPPORTED_CHANNEL_TEST_TYPES.has(channel.type)) {
    return { success: false, message: `${channelTypeName(channel.type)} channel test is not supported`, time: 0 };
  }
  const started = Date.now();
  const target = modelsUrl(channel);
  try {
    const res = await fetchUpstream(target);
    const milliseconds = Date.now() - started;
    const text = await res.text();
    const time = milliseconds / 1000;
    if (!res.ok) return { success: false, message: text.slice(0, 500) || res.statusText, time };
    await store.updateChannel(channel.id, { test_time: Math.floor(Date.now() / 1000), response_time: milliseconds });
    return { success: true, message: "", time };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e), time: 0 };
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

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

export async function proxyRealtime(req: Request, channel: ChannelRow, model: string): Promise<Response> {
  if (typeof WebSocketPair === "undefined") {
    return openaiError(501, "当前运行时不支持 WebSocket", "not_implemented");
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const base = resolveBaseUrl(channel.type, channel.base_url);
  const apiKey = pickChannelKey(channel.key);
  const mapped = applyModelMapping(channel, model || "gpt-4o-realtime-preview");
  const url = joinUrl(base, `/v1/realtime?model=${encodeURIComponent(mapped)}`);
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Beta": "realtime=v1",
  };
  const protocol = req.headers.get("sec-websocket-protocol");
  if (protocol) headers["Sec-WebSocket-Protocol"] = protocol;
  const upstream = await fetch(url, { headers });
  const ws = (upstream as Response & { webSocket?: WebSocket }).webSocket;
  if (!ws) {
    const text = await upstream.text().catch(() => "");
    return openaiError(502, text.slice(0, 400) || "上游未升级为 WebSocket", "upstream_error");
  }
  (server as unknown as { accept(): void }).accept();
  (ws as unknown as { accept(): void }).accept();
  server.addEventListener("message", (ev: MessageEvent) => {
    try {
      ws.send(ev.data as string);
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    try {
      server.send(ev.data as string);
    } catch {
      /* ignore */
    }
  });
  const close = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  server.addEventListener("close", close);
  ws.addEventListener("close", close);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: protocol ? { "sec-websocket-protocol": protocol.split(",")[0].trim() } : undefined,
  } as ResponseInit);
}

