import { runChannelTestTask } from "./channel-test.js";
import { START_TIME, VERSION, nowSec } from "./constants.js";
import { authenticateApiToken, finishAccessTokenAudit, maybeBeginAccessTokenAudit, rateLimit, sessionSecret } from "./auth.js";
import { apiFail, openaiError, pluginProtocolError, readJson, relayNotImplemented, taskArtifactError, videoProxyError, withCors } from "./http.js";
import { adminRouter } from "./routes.js";
import {
  listModelsForAuth,
  playgroundRelay,
  proxyMj,
  proxyRealtime,
  relay,
  retrieveModel,
  detectModel,
  detectStream,
} from "./relay.js";
import type { ClientFormat } from "./relay.js";
import type { RelayMode } from "./upstream.js";
import { extractGeminiModelAction } from "./convert.js";
import { ensureSchema } from "./schema.js";
import { Store } from "./store.js";
import { hit } from "./metrics.js";
import { matchPluginRoute } from "./plugin-dispatch.js";
import { taskArtifactsView, taskFetchView, openaiVideoView, taskResultURL } from "./dto.js";
import type { AuthToken, Env, ExecutionContextLike } from "./types.js";

/** Original `/:mode/mj` relay group. `/api/mj` is dashboard GetAllMidjourney, not relay. */
function isMjModeRelayPath(path: string): boolean {
  if (path.startsWith("/api/") || path.startsWith("/v1") || path.startsWith("/pg/") || path.startsWith("/dashboard/")) {
    return false;
  }
  return /^\/[^/]+\/mj(\/|$)/.test(path);
}

function mjRelayPath(path: string): string {
  if (path.startsWith("/mj/") || path === "/mj") return path.slice(3) || "/";
  if (!isMjModeRelayPath(path)) return path;
  const nested = path.match(/^\/[^/]+\/mj(\/.*)$/);
  if (nested) return nested[1] || "/";
  return path;
}

function isMjImagePath(path: string): boolean {
  if (/^\/mj\/image\/[^/]+$/.test(path)) return true;
  return isMjModeRelayPath(path) && /^\/[^/]+\/mj\/image\/[^/]+$/.test(path);
}

function isMjRelayRequest(path: string): boolean {
  return path.startsWith("/mj/") || path === "/mj" || isMjModeRelayPath(path);
}

const api = adminRouter();

const NOT_IMPLEMENTED = new Set([
  "POST /v1/images/variations",
  "GET /v1/files",
  "POST /v1/files",
  "GET /v1/fine-tunes",
  "POST /v1/fine-tunes",
]);

function clientFormatFrom(req: Request, path: string): ClientFormat {
  if (path.startsWith("/v1beta") || (path.startsWith("/v1/models/") && (req.headers.get("x-goog-api-key") || new URL(req.url).searchParams.get("key")))) {
    if (path.includes(":")) return "gemini";
  }
  if (path.startsWith("/v1beta")) return "gemini";
  if (path === "/v1/messages" || (req.headers.get("x-api-key") && req.headers.get("anthropic-version"))) return "anthropic";
  return "openai";
}

function relayModeFrom(path: string, method: string): RelayMode | null {
  if (path === "/v1/chat/completions") return "chat";
  if (path === "/v1/completions") return "completions";
  if (path === "/v1/embeddings") return "embeddings";
  if (path === "/v1/messages") return "messages";
  if (path === "/v1/images/generations" || path === "/v1/images/edits" || path === "/v1/edits") return "images";
  if (path === "/v1/moderations") return "moderations";
  if (path === "/v1/audio/speech") return "audio_speech";
  if (path === "/v1/audio/transcriptions") return "audio_transcription";
  if (path === "/v1/audio/translations") return "audio_translation";
  if (path === "/v1/rerank") return "rerank";
  if (path === "/v1/responses" || path === "/v1/responses/compact") return "responses";
  if (path === "/v1/alpha/search") return "alpha_search";
  if (path.startsWith("/v1/engines/") && path.endsWith("/embeddings")) return "engines_embeddings";
  if (path === "/v1/video/generations" || path.startsWith("/v1/video/generations/")) return "video";
  if (path === "/v1/videos" || path.startsWith("/v1/videos/")) return "video";
  if (path.startsWith("/v1/tasks/")) return "passthrough";
  if (path.startsWith("/v1/responses/") && method === "GET") return "responses";
  if (path.startsWith("/v1beta/models") && method === "POST") return "gemini";
  if (path.startsWith("/v1/models/") && method === "POST") return "gemini";
  return null;
}

function notImplemented(method: string, path: string): boolean {
  if (NOT_IMPLEMENTED.has(`${method} ${path}`)) return true;
  if (path.startsWith("/v1/files/")) return true;
  if (path.startsWith("/v1/fine-tunes/")) return true;
  if (method === "DELETE" && path.startsWith("/v1/models/")) return true;
  return false;
}

function extractFormField(buf: ArrayBuffer, name: string): string {
  const text = new TextDecoder("latin1").decode(buf.slice(0, 16_384));
  const re = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`);
  return (text.match(re)?.[1] || "").trim();
}

function ctxStore(req: Request, env: Env, ctx: ExecutionContextLike) {
  return {
    req,
    env,
    url: new URL(req.url),
    params: {} as Record<string, string>,
    waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
  };
}

async function handleRelay(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const store = new Store(env.DB);

  if (req.method === "GET" && isMjImagePath(path)) {
    hit("relay");
    const guest = { token: { id: 0 }, user: { id: 0 }, usingGroup: "default" } as AuthToken;
    return proxyMj(req, store, guest, mjRelayPath(path));
  }

  const auth = await authenticateApiToken(ctxStore(req, env, ctx), store);
  if (auth instanceof Response) return auth;
  if (!(await rateLimit(env, auth.token.id))) return openaiError(429, "请求过于频繁", "rate_limit");
  hit("relay");

  if (notImplemented(req.method, path)) {
    return relayNotImplemented();
  }

  if (req.method === "GET" && (path === "/v1/models" || path === "/v1beta/models" || path === "/v1beta/openai/models")) {
    const googKey = req.headers.get("x-goog-api-key") || url.searchParams.get("key");
    const fmt: ClientFormat =
      path === "/v1beta/openai/models"
        ? "openai"
        : path === "/v1beta/models" || Boolean(googKey && path === "/v1/models")
          ? "gemini"
          : req.headers.get("x-api-key") && req.headers.get("anthropic-version")
            ? "anthropic"
            : "openai";
    return listModelsForAuth(store, auth, fmt);
  }

  if (req.method === "GET" && path.startsWith("/v1/models/") && !path.includes(":")) {
    const model = decodeURIComponent(path.slice("/v1/models/".length));
    const fmt: ClientFormat =
      req.headers.get("x-api-key") && req.headers.get("anthropic-version") ? "anthropic" : "openai";
    return retrieveModel(store, auth, model, fmt);
  }

  if (isMjRelayRequest(path)) {
    return proxyMj(req, store, auth, mjRelayPath(path));
  }

  if (path === "/v1/realtime") {
    if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return openaiError(426, "Realtime 需要 WebSocket Upgrade", "upgrade_required");
    }
    const model = url.searchParams.get("model") || "gpt-4o-realtime-preview";
    const channel = await store.getRandomSatisfiedChannel(auth.usingGroup, model, 0);
    if (!channel) return openaiError(503, `没有可用渠道（模型 ${model}）`, "no_available_channel");
    return proxyRealtime(req, channel, model);
  }

  if (req.method === "GET" && path.startsWith("/v1/video/generations/")) {
    const rest = path.slice("/v1/video/generations/".length);
    const [taskIdRaw, ...tail] = rest.split("/").filter(Boolean);
    const taskId = decodeURIComponent(taskIdRaw || "");
    if (!taskId) return videoProxyError(400, "invalid_request_error", "task_id is required");
    if (tail[0] === "content") return serveVideoContent(req, env, store, auth, taskId, ctx);
    return serveVideoRetrieve(req, env, store, auth, path, taskId, ctx);
  }

  if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/v1/videos/")) {
    const rest = path.slice("/v1/videos/".length);
    const [taskIdRaw, ...tail] = rest.split("/").filter(Boolean);
    const taskId = decodeURIComponent(taskIdRaw || "");
    if (!taskId) return videoProxyError(400, "invalid_request_error", "task_id is required");
    if (tail[0] === "content") return serveVideoContent(req, env, store, auth, taskId, ctx);
    return serveVideoRetrieve(req, env, store, auth, path, taskId, ctx);
  }

  if (req.method === "GET" && path.startsWith("/v1/responses/")) {
    const responseId = decodeURIComponent(path.slice("/v1/responses/".length).split("/")[0] || "");
    return pluginProtocolError(404, "not_found", `No response found with id '${responseId}'.`);
  }

  if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/v1/tasks/")) {
    const rest = path.slice("/v1/tasks/".length);
    const [taskId, ...tail] = rest.split("/").filter(Boolean);
    const decodedId = decodeURIComponent(taskId || "");
    const local = decodedId ? await store.getTaskByTid(decodedId) : null;
    const owned = local && Number(local.user_id) === auth.user.id;
    if (tail[0] === "artifacts") {
      const artifactKey = tail[1] ? decodeURIComponent(tail[1]) : "";
      if (tail[2] === "content") {
        if (!owned || !local) return taskArtifactError(404, "artifact_not_found", "Task or artifact not found");
        if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(artifactKey)) {
          return taskArtifactError(404, "artifact_not_found", "Task or artifact not found");
        }
        if (String(local.status) !== "SUCCESS") {
          return taskArtifactError(409, "artifact_not_ready", "Task artifacts are not ready");
        }
        if (env.R2 && artifactKey) {
          const obj = await env.R2.get(`tasks/${decodedId}/${artifactKey}`);
          if (obj) {
            return new Response(req.method === "HEAD" ? null : await obj.arrayBuffer(), {
              headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, no-store" },
            });
          }
        }
        return taskArtifactError(404, "artifact_not_found", "Task or artifact not found");
      }
      if (!owned || !local) return taskArtifactError(404, "artifact_not_found", "Task or artifact not found");
      try {
        const body = await taskArtifactsView(store, local);
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
        });
      } catch {
        return taskArtifactError(500, "artifact_url_error", "Failed to build artifact content URL");
      }
    }
    if (!owned || !local) return videoProxyError(404, "invalid_request_error", "Task not found");
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    return new Response(JSON.stringify(taskFetchView(local)), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const mode = relayModeFrom(path, req.method);
  if (!mode) {
    const plugin = await matchPluginRoute(store, req.method, path);
    if (plugin) {
      let body: unknown = {};
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          body = await readJson(req);
        } catch {
          body = {};
        }
      }
      return relay({
        req,
        env,
        store,
        auth,
        mode: "passthrough",
        clientFormat: "openai",
        model: detectModel(body, path, url) || plugin.key,
        body,
        stream: detectStream(body, req),
        path,
        ctx,
        method: req.method,
      });
    }
    return openaiError(501, "尚未实现该接口", "not_implemented");
  }

  let body: unknown = {};
  let rawBody: ArrayBuffer | undefined;
  let rawContentType: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      rawBody = await req.arrayBuffer();
      rawContentType = ct;
      const modelField = extractFormField(rawBody, "model") || url.searchParams.get("model") || "";
      return relay({
        req,
        env,
        store,
        auth,
        mode,
        clientFormat: "openai",
        model: modelField || "whisper-1",
        body: {},
        stream: false,
        path,
        ctx,
        rawBody,
        rawContentType,
        method: req.method,
      });
    }
    try {
      body = await readJson(req);
    } catch {
      return openaiError(400, "请求体必须是 JSON", "invalid_request");
    }
  }

  let model = detectModel(body, path, url);
  if (!model) {
    const gem = extractGeminiModelAction(path);
    if (gem) model = gem.model;
  }
  if (path.startsWith("/v1/engines/") && path.endsWith("/embeddings")) {
    model = decodeURIComponent(path.slice("/v1/engines/".length, -"/embeddings".length));
  }

  const fmt = clientFormatFrom(req, path);
  const res = await relay({
    req,
    env,
    store,
    auth,
    mode,
    clientFormat: fmt,
    model,
    body,
    stream: detectStream(body, req),
    path,
    ctx,
    method: req.method,
  });

  if (req.method === "POST" && (path === "/v1/video/generations" || path === "/v1/videos" || path.startsWith("/v1/tasks/") || path.endsWith("/remix"))) {
    const clone = res.clone();
    const text = await clone.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const taskId = String(parsed.id || parsed.task_id || parsed.taskId || crypto.randomUUID());
      await store.insertTask({
        task_id: taskId,
        user_id: auth.user.id,
        token_id: auth.token.id,
        platform: path.startsWith("/v1/video") ? "video" : "task",
        action: path,
        status: String(parsed.status || "SUBMITTED"),
        model_name: model,
        prompt: String((body as { prompt?: string }).prompt || ""),
        result: text.slice(0, 8000),
      });
    } catch {
      /* ignore */
    }
  }

  return res;
}

async function serveVideoRetrieve(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  path: string,
  taskId: string,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const local = await store.getTaskByTid(taskId);
  const owned = local && Number(local.user_id) === auth.user.id;
  if (owned && local) {
    return new Response(JSON.stringify(openaiVideoView(local)), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
    });
  }
  return relayJson(req, env, store, auth, "video", path, { id: taskId }, ctx, "GET");
}

async function serveVideoContent(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  taskId: string,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const local = await store.getTaskByTid(taskId);
  const owned = local && Number(local.user_id) === auth.user.id;
  if (!owned || !local) return videoProxyError(404, "invalid_request_error", "Task not found");
  if (String(local.status) !== "SUCCESS") {
    return videoProxyError(400, "invalid_request_error", `Task is not completed yet, current status: ${local.status}`);
  }
  if (env.R2) {
    const obj = await env.R2.get(`tasks/${taskId}/content`);
    if (obj) {
      return new Response(req.method === "HEAD" ? null : await obj.arrayBuffer(), {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
          "cache-control": "private, no-store",
        },
      });
    }
  }
  const resultURL = taskResultURL(local);
  if (resultURL.startsWith("data:")) {
    const decoded = decodeVideoDataURL(resultURL);
    if (!decoded) return taskArtifactError(410, "artifact_gone", "Artifact content is no longer available");
    const copy = new Uint8Array(decoded.bytes.byteLength);
    copy.set(decoded.bytes);
    return new Response(req.method === "HEAD" ? null : copy.buffer, {
      headers: { "content-type": decoded.mime, "cache-control": "private, no-store" },
    });
  }
  if (!resultURL) return taskArtifactError(410, "artifact_gone", "Artifact content is no longer available");
  return relayJson(req, env, store, auth, "video", `/v1/videos/${taskId}/content`, { id: taskId }, ctx, req.method);
}

function decodeVideoDataURL(dataURL: string): { mime: string; bytes: Uint8Array } | null {
  const parts = dataURL.split(",");
  if (parts.length !== 2) return null;
  const header = parts[0];
  if (!header.startsWith("data:") || !header.includes(";base64")) return null;
  let mime = header.slice("data:".length).replace(/;base64$/, "");
  if (!mime) mime = "video/mp4";
  try {
    const bin = atob(parts[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  } catch {
    return null;
  }
}

async function relayJson(
  req: Request,
  env: Env,
  store: Store,
  auth: AuthToken,
  mode: RelayMode,
  path: string,
  body: unknown,
  ctx: ExecutionContextLike,
  method: string,
): Promise<Response> {
  const model = detectModel(body, path, new URL(req.url));
  return relay({
    req,
    env,
    store,
    auth,
    mode,
    clientFormat: "openai",
    model: model || "sora",
    body,
    stream: false,
    path,
    ctx,
    method,
  });
}

async function handleFetch(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const res = await dispatchFetch(req, env, ctx);
  if (env.DB) {
    try {
      await finishAccessTokenAudit(new Store(env.DB), req, res);
    } catch {
      /* audit must not fail the request */
    }
  }
  return res;
}

async function dispatchFetch(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  hit("http");

  if (req.method === "OPTIONS") {
    return withCors(req, new Response(null, { status: 204 }));
  }

  if (path === "/health") {
    return withCors(
      req,
      new Response(
        JSON.stringify({
          ok: true,
          version: VERSION,
          uptime_ms: Date.now() - START_TIME,
          d1: Boolean(env.DB),
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  }

  const needsDb =
    path.startsWith("/api/") ||
    path.startsWith("/v1") ||
    path.startsWith("/pg/") ||
    path.startsWith("/mj/") ||
    path.startsWith("/dashboard/billing") ||
    isMjModeRelayPath(path);

  if (needsDb) {
    if (!env.DB) {
      return withCors(
        req,
        apiFail("D1 binding DB is missing. Deploy with rrangler so d1_databases is synced.", null, 500),
      );
    }
    await ensureSchema(env.DB);
    const store = new Store(env.DB);
    try {
      await maybeBeginAccessTokenAudit(store, req, await sessionSecret(env, store));
    } catch {
      /* PAT audit begin is best-effort */
    }

    const isRelay =
      (path.startsWith("/v1/") && !path.startsWith("/v1/dashboard")) ||
      path.startsWith("/v1beta") ||
      isMjRelayRequest(path);

    try {
      if (isRelay && !path.startsWith("/v1/dashboard")) {
        try {
          return withCors(req, await handleRelay(req, env, ctx));
        } catch (err) {
          hit("error");
          const msg = err instanceof Error ? err.message : String(err);
          return withCors(req, openaiError(500, msg, "internal_error"));
        }
      }

      const c = ctxStore(req, env, ctx);
      const routed = await api.dispatch(c);
      if (routed) return withCors(req, routed);

      const plugin = await matchPluginRoute(store, req.method, path);
      if (plugin) {
        hit("relay");
        return withCors(req, await handleRelay(req, env, ctx));
      }
    } catch (err) {
      hit("error");
      const msg = err instanceof Error ? err.message : String(err);
      if (path.startsWith("/v1") || path.startsWith("/v1beta")) {
        return withCors(req, openaiError(500, msg, "internal_error"));
      }
      return withCors(req, apiFail(msg, null, 500));
    }
  }

  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(req);
    if (res.status !== 404) return res;
    if (req.method === "GET") {
      const skipSpa =
        path.startsWith("/api") ||
        path.startsWith("/v1") ||
        path.startsWith("/v1beta") ||
        path.startsWith("/mj") ||
        path.startsWith("/pg") ||
        path.startsWith("/static") ||
        path.startsWith("/assets") ||
        path.startsWith("/dashboard/billing");
      if (!skipSpa) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", req.url), req));
      }
    }
  }
  return new Response("Not Found", { status: 404 });
}

export { handleFetch };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handleFetch(request, env, ctx ?? { waitUntil() {} });
  },
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContextLike): Promise<void> {
    if (!env.DB) return;
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
        await env.DB.prepare("DELETE FROM request_logs WHERE created_at < ?").bind(cutoff).run();
        await env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(cutoff).run();
        const store = new Store(env.DB);
        await store.cleanupExpired(nowSec());
        const task = await store.currentSystemTask("channel_test");
        if (task && String(task.status) === "pending") {
          const id = String(task.id || task.task_id || "");
          await store.updateSystemTask(id, { status: "running" });
          try {
            const payload = typeof task.payload === "string" ? JSON.parse(String(task.payload || "{}")) : (task.payload as { mode?: string } | null);
            const summary = await runChannelTestTask(store, String(payload?.mode || "scheduled_all"));
            await store.updateSystemTask(id, { status: "succeeded", result: JSON.stringify(summary) });
          } catch (err) {
            await store.updateSystemTask(id, {
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })(),
    );
  },
};

void playgroundRelay;
