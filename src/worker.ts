import { runPendingChannelTestSystemTask } from "./channel-test.js";
import { runPendingModelUpdateSystemTask } from "./channel-upstream-update.js";
import { runPendingMidjourneyPoll } from "./midjourney-poll.js";
import { runPendingAsyncTaskPoll } from "./task-plugin-poll.js";
import { nowSec, USER_ENABLED } from "./constants.js";
import { authenticateApiToken, cryptoSecret, finishAccessTokenAudit, maybeBeginAccessTokenAudit, readSession, sessionSecret } from "./auth.js";
import { finishAdminAudit } from "./admin-operation-audit.js";
import { beginTokenOperationAudit, finishTokenOperationAudit, tokenOperationAuditApplies } from "./token-operation-audit.js";
import { abortWithOpenAiMessage, apiFail, ERROR_CODE_INVALID_REQUEST, json, messageWithRequestId, newApiPanicError, noAvailableChannelMessage, openaiError, pluginMethodNotAllowed, pluginRoutePanicError, relayNotFound, relayNotImplemented, taskArtifactError, taskPluginRouteError, videoProxyError, withCors, writeRelayNewAPIError } from "./http.js";
import { rememberRequestTrustedProxies } from "./trusted-proxies.js";
import {
  ARTIFACT_NOT_FOUND,
  ARTIFACT_NOT_FOUND_MESSAGE,
  collapseTaskArtifactAccessError,
  isTaskArtifactAccess,
  redactTaskArtifactAccessQuery,
  tokenOrTaskArtifactAccessAuth,
  tokenOrTaskArtifactAccessAuthApplies,
  withTaskArtifactCacheControl,
} from "./task-artifact-access.js";
import { handlePrepareTaskPluginSubmit, taskPluginSubmitKey } from "./task-plugin-legacy-submit.js";
import { anonymousRequestBodyLimit } from "./anonymous-request-body-limit.js";
import { decompressRequest } from "./decompress-request.js";
import { markSkipGzipResponse, withGzipResponse } from "./gzip-response.js";
import { frontendBaseUrlRedirect } from "./frontend-base-url.js";
import {
  systemPerformanceCheck,
  systemPerformanceCheckAppliesAfterAuth,
  systemPerformanceCheckAppliesBeforeAuth,
} from "./system-performance-check.js";
import { applyDisableCache } from "./disable-cache.js";
import { newApiVersion, requestIdFor, withRequestIdAndVersionHeaders } from "./request-id.js";
import { sessionCookieOriginGuard } from "./session-cookie-origin.js";
import { criticalRateLimit } from "./critical-rate-limit.js";
import { globalApiRateLimit } from "./global-api-rate-limit.js";
import { globalWebRateLimit } from "./global-web-rate-limit.js";
import { withRelayNotFoundWebCache, withSpaCacheHeaders, withWebCacheHeaders } from "./web-cache.js";
import { embedFolderExists, noRouteIndexPageAssetRequest, withIndexAnalytics } from "./index-analytics.js";
import { emitSetUpLogger } from "./gin-logger.js";
import {
  emitBodyStorageCleanup,
  getRequestBody,
  isRequestBodyTooLargeError,
  rememberBodyCleanupContext,
  storageBytesToArrayBuffer,
  ERROR_CODE_READ_REQUEST_BODY_FAILED,
} from "./body-storage.js";
import {
  abortDistributeInvalidRequest,
  distributeReadsJSONModel,
  getModelFromRequest,
  unmarshalBodyReusable,
} from "./unmarshal-body-reusable.js";
import { searchRateLimit, searchRateLimitApplies } from "./search-rate-limit.js";
import { userCriticalRateLimit, userCriticalRateLimitScope } from "./user-critical-rate-limit.js";
import { modelRequestRateLimitApplies, withModelRequestRateLimit } from "./model-rate-limit.js";
import { adminRouter } from "./routes.js";
import { setAuditRouter } from "./router.js";
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
import { selectDistributedChannel } from "./channel-select.js";
import { requestHeadersFrom } from "./param-override.js";
import type { ClientFormat } from "./relay.js";
import type { RelayMode } from "./upstream.js";
import { extractGeminiModelAction } from "./convert.js";
import { getAndValidOpenAIImageEditMultipart } from "./image-billing.js";
import { audioRequestIsStream, getAndValidAudioRequest, isAudioRelayMode } from "./audio-request.js";
import { ensureSchema } from "./schema.js";
import { Store } from "./store.js";
import { hit } from "./metrics.js";
import { reportCurrentSystemInstance } from "./system-instance.js";
import { runPendingLogCleanupSystemTask } from "./system-task.js";
import { syncTaskPluginsOnce } from "./task-plugin-sync.js";
import { matchPluginOwnedPath, matchPluginRoute, matchTaskPlugin, type MatchedPlugin } from "./plugin-dispatch.js";
import { applyOriginTaskIntent, type OriginTaskRef } from "./origin-task.js";
import { executeNativePluginRoute, handleNativePluginRoute } from "./task-plugin-route.js";
import { tryRelayTaskPluginEndpoint } from "./task-plugin-endpoint.js";
import { retrieveTaskPluginResponse } from "./task-plugin-protocol-serve.js";
import type { ChannelPin } from "./channel-constraint.js";
import { taskArtifactsView, taskFetchView, openaiVideoView, taskResultURL } from "./dto.js";
import { convertOwnedTaskToOpenAIVideo } from "./task-plugin-video.js";
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

/** Original `registerMjRouterGroup` relative paths (notify is commented out upstream). */
const MJ_POST_RELATIVE = new Set([
  "/submit/action",
  "/submit/shorten",
  "/submit/modal",
  "/submit/imagine",
  "/submit/change",
  "/submit/simple-change",
  "/submit/describe",
  "/submit/blend",
  "/submit/edits",
  "/submit/video",
  "/task/list-by-condition",
  "/insight-face/swap",
  "/submit/upload-discord-images",
]);

function mjRelativePath(path: string): string | null {
  if (path.startsWith("/mj/") || path === "/mj") return path === "/mj" ? "/" : path.slice(3) || "/";
  if (!isMjModeRelayPath(path)) return null;
  const nested = path.match(/^\/[^/]+\/mj(\/.*)$/);
  return nested ? nested[1] || "/" : null;
}

function isRegisteredMjRelay(method: string, path: string): boolean {
  const rel = mjRelativePath(path);
  if (rel == null) return false;
  if (method === "GET" && /^\/image\/[^/]+$/.test(rel)) return true;
  if (method === "GET" && /^\/task\/[^/]+\/fetch$/.test(rel)) return true;
  if (method === "GET" && /^\/task\/[^/]+\/image-seed$/.test(rel)) return true;
  return method === "POST" && MJ_POST_RELATIVE.has(rel);
}

const api = adminRouter();
setAuditRouter(api);

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
  const post = method === "POST";
  if (post && path === "/v1/chat/completions") return "chat";
  if (post && path === "/v1/completions") return "completions";
  if (post && path === "/v1/embeddings") return "embeddings";
  if (post && path === "/v1/messages") return "messages";
  if (post && (path === "/v1/images/generations" || path === "/v1/images/edits" || path === "/v1/edits")) return "images";
  if (post && path === "/v1/moderations") return "moderations";
  if (post && path === "/v1/audio/speech") return "audio_speech";
  if (post && path === "/v1/audio/transcriptions") return "audio_transcription";
  if (post && path === "/v1/audio/translations") return "audio_translation";
  if (post && path === "/v1/rerank") return "rerank";
  if (post && (path === "/v1/responses" || path === "/v1/responses/compact")) return "responses";
  if (post && path === "/v1/alpha/search") return "alpha_search";
  if (post && path.startsWith("/v1/engines/") && path.endsWith("/embeddings")) return "engines_embeddings";
  if (post && (path === "/v1/video/generations" || path === "/v1/videos")) return "video";
  if (post && /^\/v1\/videos\/[^/]+\/remix$/.test(path)) return "video";
  if (post && taskPluginSubmitKey(path)) return "passthrough";
  if (method === "GET" && path.startsWith("/v1/responses/")) return "responses";
  if (post && path.startsWith("/v1beta/models")) return "gemini";
  if (post && path.startsWith("/v1/models/")) return "gemini";
  return null;
}

/** Original registered relay/dashboard-plugin paths; unmatched /v1 /api /assets use RelayNotFound. */
function isRegisteredRelay(method: string, path: string): boolean {
  if (isRegisteredMjRelay(method, path)) return true;
  if (method === "GET" && (path === "/v1/models" || path === "/v1beta/models" || path === "/v1beta/openai/models")) return true;
  if (method === "GET" && path.startsWith("/v1/models/") && !path.slice("/v1/models/".length).includes("/")) return true;
  if (method === "GET" && path === "/v1/realtime") return true;
  if (method === "GET" && /^\/v1\/video\/generations\/[^/]+$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/videos\/[^/]+$/.test(path)) return true;
  if ((method === "GET" || method === "HEAD") && /^\/v1\/videos\/[^/]+\/content$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/responses\/[^/]+$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/tasks\/[^/]+$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/tasks\/[^/]+\/artifacts$/.test(path)) return true;
  if ((method === "GET" || method === "HEAD") && /^\/v1\/tasks\/[^/]+\/artifacts\/[^/]+\/content$/.test(path)) return true;
  if (notImplemented(method, path)) return true;
  return relayModeFrom(path, method) != null;
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

function intentBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

async function preparePluginOrigin(
  store: Store,
  userId: number,
  body: unknown,
  plugin: MatchedPlugin,
  model: string,
): Promise<{ error?: Response; pin?: ChannelPin; tasks?: OriginTaskRef[] }> {
  if (plugin.kind === "route" && plugin.models.length && model && !plugin.models.includes(model)) {
    return { error: taskPluginRouteError(400, `model "${model}" is not served by this plugin`) };
  }
  const intent = await applyOriginTaskIntent(store, userId, intentBody(body), {
    key: plugin.key,
    channelTypes: plugin.channelTypes,
  });
  if (intent.error) {
    if (plugin.kind === "route") return { error: taskPluginRouteError(intent.error.statusCode, intent.error.message) };
    return { error: openaiError(intent.error.statusCode, intent.error.message, intent.error.code) };
  }
  return { pin: intent.pin, tasks: intent.tasks };
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

function maybeFrontendBaseUrlRedirect(env: Env, inbound: Request, req: Request): Response | null {
  const redirected = frontendBaseUrlRedirect(env, req);
  if (!redirected) return null;
  markSkipGzipResponse(inbound);
  return redirected;
}

function writeRelayTaskArtifactError(req: Request, status: number, code: string, message: string): Response {
  const collapsed = collapseTaskArtifactAccessError(req, status, code, message);
  return taskArtifactError(collapsed.status, collapsed.code, collapsed.message);
}

async function handleRelay(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const store = new Store(env.DB);

  if (req.method === "GET" && isMjImagePath(path)) {
    hit("relay");
    const guest = { token: { id: 0 }, user: { id: 0 }, usingGroup: "default" } as AuthToken;
    return proxyMj(req, env, store, guest, mjRelayPath(path));
  }

  let release: (() => void) | undefined;
  try {
    if (tokenOrTaskArtifactAccessAuthApplies(req.method, path)) {
      const secret = await cryptoSecret(env, store);
      const gated = await tokenOrTaskArtifactAccessAuth(req, env, secret);
      req = gated.req;
      if (gated.denied) return gated.denied;
      release = gated.release;
      if (gated.capability) {
        const capabilityAuth = { token: { id: 0 }, user: { id: 0 }, usingGroup: "default" } as AuthToken;
        const res = await handleRelayAfterAuth(req, env, ctx, store, capabilityAuth, new URL(req.url), path);
        return withTaskArtifactCacheControl(res);
      }
    }

    const auth = await authenticateApiToken(ctxStore(req, env, ctx), store);
    if (auth instanceof Response) {
      return tokenOrTaskArtifactAccessAuthApplies(req.method, path) ? withTaskArtifactCacheControl(auth) : auth;
    }
    if (systemPerformanceCheckAppliesAfterAuth(req.method, path) || !isRegisteredRelay(req.method, path)) {
      const overloaded = await systemPerformanceCheck(store, path, env.DB);
      if (overloaded) return overloaded;
    }
    const res = await withModelRequestRateLimit(
      store,
      env,
      req,
      auth,
      () => handleRelayAfterAuth(req, env, ctx, store, auth, new URL(req.url), path),
      modelRequestRateLimitApplies(req.method, path),
    );
    return tokenOrTaskArtifactAccessAuthApplies(req.method, path) ? withTaskArtifactCacheControl(res) : res;
  } finally {
    release?.();
  }
}

async function handleRelayAfterAuth(
  req: Request,
  env: Env,
  ctx: ExecutionContextLike,
  store: Store,
  auth: AuthToken,
  url: URL,
  path: string,
): Promise<Response> {
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
    return retrieveModel(model, fmt);
  }

  if (isRegisteredMjRelay(req.method, path)) {
    return proxyMj(req, env, store, auth, mjRelayPath(path));
  }

  if (path === "/v1/realtime") {
    const model = url.searchParams.get("model") || "gpt-4o-realtime-preview";
    const requestId = req.headers.get("x-oneapi-request-id") || crypto.randomUUID();
    const selected = await selectDistributedChannel({
      store,
      env,
      req,
      auth,
      model,
      requestPath: path,
      body: null,
      headers: requestHeadersFrom(req),
    });
    if (selected.error) {
      return abortWithOpenAiMessage(selected.error.status, selected.error.message, selected.error.code, requestId);
    }
    if (!selected.channel) {
      return abortWithOpenAiMessage(503, noAvailableChannelMessage(req, selected.usingGroup, model), "model_not_found", requestId);
    }
    if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return openaiError(426, "Realtime 需要 WebSocket Upgrade", "upgrade_required");
    }
    return proxyRealtime(req, selected.channel, model, { store, auth, env, ctx });
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
    return retrieveTaskPluginResponse({ store, auth, responseId });
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
        let allowed = Boolean(owned && local);
        if (isTaskArtifactAccess(req)) {
          allowed = false;
          if (local) {
            const owner = await store.getUserById(Number(local.user_id));
            allowed = Boolean(owner && owner.status === USER_ENABLED);
          }
        }
        if (!allowed || !local) return writeRelayTaskArtifactError(req, 404, ARTIFACT_NOT_FOUND, ARTIFACT_NOT_FOUND_MESSAGE);
        if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(artifactKey)) {
          return writeRelayTaskArtifactError(req, 404, ARTIFACT_NOT_FOUND, ARTIFACT_NOT_FOUND_MESSAGE);
        }
        if (String(local.status) !== "SUCCESS") {
          return writeRelayTaskArtifactError(req, 409, "artifact_not_ready", "Task artifacts are not ready");
        }
        if (env.R2 && artifactKey) {
          const obj = await env.R2.get(`tasks/${decodedId}/${artifactKey}`);
          if (obj) {
            return new Response(req.method === "HEAD" ? null : await obj.arrayBuffer(), {
              headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, no-store" },
            });
          }
        }
        return writeRelayTaskArtifactError(req, 404, ARTIFACT_NOT_FOUND, ARTIFACT_NOT_FOUND_MESSAGE);
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

  if (req.method === "POST") {
    const pluginKey = taskPluginSubmitKey(path);
    if (pluginKey) {
      return handlePrepareTaskPluginSubmit({ req, env, store, auth, pluginKey });
    }
  }

  if (req.method === "POST" && (path === "/v1/videos" || path === "/v1/responses")) {
    const claimed = await tryRelayTaskPluginEndpoint({ req, env, store, auth, ctx });
    if (claimed) return claimed;
  }

  const mode = relayModeFrom(path, req.method);
  if (!mode) {
    const plugin = await matchTaskPlugin(store, req.method, path);
    if (plugin) {
      if (plugin.kind === "route") {
        return executeNativePluginRoute({ req, env, store, auth, plugin, ctx });
      }
      let body: unknown = {};
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          const got = await getRelayBodyStorage(req, env);
          if (!got.ok) return got.res;
          const text = new TextDecoder().decode(got.bytes);
          body = text ? JSON.parse(text) : {};
        } catch {
          body = {};
        }
      }
      const model = detectModel(body, path, url) || plugin.key;
      const origin = await preparePluginOrigin(store, auth.user.id, body, plugin, model);
      if (origin.error) return origin.error;
      return relay({
        req,
        env,
        store,
        auth,
        mode: "passthrough",
        clientFormat: "openai",
        model,
        body,
        stream: detectStream(body, req),
        path,
        ctx,
        method: req.method,
        expectedTaskPluginKey: plugin.key,
        taskPluginChannelTypes: plugin.channelTypes,
        originPin: origin.pin,
        originTasks: origin.tasks,
      });
    }
    return relayNotFound(req.method, path);
  }

  let body: unknown = {};
  let rawBody: ArrayBuffer | undefined;
  let rawContentType: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = req.headers.get("content-type") || "";
    const got = await getRelayBodyStorage(req, env);
    if (!got.ok) return got.res;
    if (ct.includes("multipart/form-data")) {
      rawBody = storageBytesToArrayBuffer(got.bytes);
      rawContentType = ct;
      if (mode === "images") {
        let imageBody: Record<string, unknown>;
        try {
          imageBody = getAndValidOpenAIImageEditMultipart(rawBody, rawContentType);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return writeRelayNewAPIError(req, 400, message, ERROR_CODE_INVALID_REQUEST);
        }
        return relay({
          req,
          env,
          store,
          auth,
          mode,
          clientFormat: "openai",
          model: String(imageBody.model || url.searchParams.get("model") || ""),
          body: imageBody,
          stream: Boolean(imageBody.stream),
          path,
          ctx,
          rawBody,
          rawContentType,
          method: req.method,
        });
      }
      if (isAudioRelayMode(mode)) {
        let audioBody: Record<string, unknown>;
        try {
          audioBody = getAndValidAudioRequest(mode, rawBody, rawContentType);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return writeRelayNewAPIError(req, 400, message, ERROR_CODE_INVALID_REQUEST);
        }
        return relay({
          req,
          env,
          store,
          auth,
          mode,
          clientFormat: "openai",
          model: String(audioBody.model || ""),
          body: audioBody,
          stream: audioRequestIsStream(audioBody),
          path,
          ctx,
          rawBody,
          rawContentType,
          method: req.method,
        });
      }
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
    if (distributeReadsJSONModel(path, ct)) {
      const modelReq = getModelFromRequest(req, got.bytes);
      if (!modelReq.ok) return abortDistributeInvalidRequest(req, modelReq.message);
    }
    try {
      body = unmarshalBodyReusable(got.bytes, ct);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return writeRelayNewAPIError(req, 400, message, ERROR_CODE_INVALID_REQUEST);
    }
    if (isAudioRelayMode(mode)) {
      try {
        body = getAndValidAudioRequest(mode, body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return writeRelayNewAPIError(req, 400, message, ERROR_CODE_INVALID_REQUEST);
      }
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

  const plugin = await matchTaskPlugin(store, req.method, path, model);
  let originPin: ChannelPin | undefined;
  let originTasks: OriginTaskRef[] | undefined;
  if (plugin) {
    const origin = await preparePluginOrigin(store, auth.user.id, body, plugin, model);
    if (origin.error) return origin.error;
    originPin = origin.pin;
    originTasks = origin.tasks;
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
    stream: isAudioRelayMode(mode) ? audioRequestIsStream(body) : detectStream(body, req),
    path,
    ctx,
    method: req.method,
    expectedTaskPluginKey: plugin?.key,
    taskPluginChannelTypes: plugin?.channelTypes,
    originPin,
    originTasks,
  });

  if (req.method === "POST" && (path === "/v1/video/generations" || path === "/v1/videos" || path.endsWith("/remix"))) {
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
    try {
      const converted = await convertOwnedTaskToOpenAIVideo(store, local);
      const body = converted || openaiVideoView(local);
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
      });
    } catch {
      return videoProxyError(500, "convert_to_openai_video_failed", "convert_to_openai_video_failed");
    }
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

/** Original `SetWebRouter` NoRoute `GlobalWebRateLimit` leftover empty HTTP 429. */
async function limitedGlobalWeb(env: Env, req: Request): Promise<Response | null> {
  const limited = await globalWebRateLimit(env, req);
  return limited ? withCors(req, limited) : null;
}

/** Original `DecompressRequestMiddleware` leftover empty HTTP 400. */
async function limitedDecompress(env: Env, req: Request): Promise<{ req: Request; denied: Response | null }> {
  const out = await decompressRequest(env, req);
  if (out.error) return { req: out.req, denied: withCors(req, out.error) };
  return { req: out.req, denied: null };
}

/**
 * Original Relay `GetAndValidateRequest` / `GetBodyStorage` too-large:
 * `NewErrorWithStatusCode(..., ErrorCodeReadRequestBodyFailed, 413)` then
 * `ToOpenAIError` / Claude `{type:"error",error:ToClaudeError()}`.
 * Extra-OK: generated RequestId is not appended (hop 314).
 */
function writeReadRequestBodyFailed(req: Request, err: unknown): Response {
  const raw = err instanceof Error ? err.message : String(err);
  const rid = req.headers.get("x-oneapi-request-id") || "";
  const message = rid ? messageWithRequestId(raw, rid) : raw;
  const path = new URL(req.url).pathname;
  if (path.startsWith("/v1/messages")) {
    return json(413, { type: "error", error: { type: "new_api_error", message } });
  }
  return openaiError(413, message, ERROR_CODE_READ_REQUEST_BODY_FAILED);
}

async function getRelayBodyStorage(req: Request, env: Env): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; res: Response }> {
  try {
    const storage = await getRequestBody(req, env);
    return { ok: true, bytes: storage.bytes() };
  } catch (err) {
    if (isRequestBodyTooLargeError(err)) return { ok: false, res: writeReadRequestBodyFailed(req, err) };
    throw err;
  }
}

/** Original `SystemPerformanceCheck` before TokenAuth on playground / relayV1 / MJ / Gemini. */
async function limitedSystemPerformanceBeforeAuth(
  store: Store,
  req: Request,
  path: string,
  db: Env["DB"],
): Promise<Response | null> {
  if (!systemPerformanceCheckAppliesBeforeAuth(req.method, path) && !isRegisteredMjRelay(req.method, path)) {
    return null;
  }
  const overloaded = await systemPerformanceCheck(store, path, db);
  return overloaded ? withCors(req, overloaded) : null;
}

async function handleFetch(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  rememberRequestTrustedProxies(req, env);
  rememberBodyCleanupContext(req, env);
  const inbound = req;
  const startedMs = performance.now();
  const requestId = requestIdFor(req);
  let res: Response;
  try {
    try {
      res = await dispatchFetch(req, env, ctx);
    } catch (err) {
      hit("error");
      res = withCors(req, newApiPanicError(err));
    }
    if (env.DB) {
      const store = new Store(env.DB);
      try {
        await finishTokenOperationAudit(store, req, res, requestId);
      } catch {
        /* original RecordAuditLog logs and continues */
      }
      try {
        await finishAdminAudit(store, req, res, requestId);
      } catch {
        /* original RecordAuditLog logs and continues */
      }
      try {
        await finishAccessTokenAudit(store, req, res, requestId);
      } catch {
        /* audit must not fail the request */
      }
    }
    res = await withGzipResponse(req, res);
    res = withRequestIdAndVersionHeaders(res, requestId, newApiVersion(env));
    const path = new URL(inbound.url).pathname;
    emitSetUpLogger({
      req: inbound,
      env,
      res,
      requestId,
      startedMs,
      registeredRelay: isRegisteredRelay(inbound.method, path),
    });
    return res;
  } finally {
    emitBodyStorageCleanup(inbound);
  }
}

async function dispatchFetch(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const inbound = req;
  const url = new URL(req.url);
  const path = url.pathname;
  hit("http");

  if (req.method === "OPTIONS") {
    return withCors(req, new Response(null, { status: 204 }));
  }

  const needsDb =
    Boolean(env.DB) ||
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
      isRegisteredMjRelay(req.method, path);

    try {
      if (isRelay && !path.startsWith("/v1/dashboard")) {
        const unpacked = await limitedDecompress(env, req);
        if (unpacked.denied) {
          markSkipGzipResponse(inbound);
          return unpacked.denied;
        }
        req = redactTaskArtifactAccessQuery(unpacked.req);
        if (!isRegisteredRelay(req.method, path)) {
          const plugin = await matchPluginRoute(store, req.method, path);
          if (!plugin) {
            if (await matchPluginOwnedPath(store, path)) {
              markSkipGzipResponse(inbound);
              return withCors(req, pluginMethodNotAllowed());
            }
            const redirected = maybeFrontendBaseUrlRedirect(env, inbound, req);
            if (redirected) return redirected;
            const webLimited = await limitedGlobalWeb(env, req);
            if (webLimited) return webLimited;
            return withRelayNotFoundWebCache(withCors(req, relayNotFound(req.method, path)));
          }
          markSkipGzipResponse(inbound);
          try {
            if (plugin.kind === "route") return withCors(req, await handleNativePluginRoute(req, env, ctx, plugin, store));
            return withCors(req, await handleRelay(req, env, ctx));
          } catch {
            return withCors(req, pluginRoutePanicError());
          }
        }
        markSkipGzipResponse(inbound);
        const beforeAuth = await limitedSystemPerformanceBeforeAuth(store, req, path, env.DB);
        if (beforeAuth) return beforeAuth;
        try {
          return withCors(req, await handleRelay(req, env, ctx));
        } catch (err) {
          hit("error");
          return withCors(req, newApiPanicError(err));
        }
      }

      if (path === "/pg" || path.startsWith("/pg/")) {
        markSkipGzipResponse(inbound);
        const unpacked = await limitedDecompress(env, req);
        if (unpacked.denied) return unpacked.denied;
        req = unpacked.req;
        const playgroundOverload = await systemPerformanceCheck(store, path, env.DB);
        if (playgroundOverload) return withCors(req, playgroundOverload);
      }

      const globalLimited = await globalApiRateLimit(env, req);
      if (globalLimited) return withCors(req, globalLimited);
      const originLimited = sessionCookieOriginGuard(env, req);
      if (originLimited) return withCors(req, originLimited);
      if (tokenOperationAuditApplies(req.method, path, new URL(req.url).searchParams.get("status_only") || "")) {
        const session = await readSession(ctxStore(req, env, ctx), store);
        if (session) beginTokenOperationAudit(req, session);
      }
      const limited = await criticalRateLimit(env, req);
      if (limited) return withCors(req, limited);
      const bodyLimited = await anonymousRequestBodyLimit(env, req);
      if (bodyLimited.error) return withCors(req, bodyLimited.error);
      const routedReq = bodyLimited.req;
      const ucScope = userCriticalRateLimitScope(req.method, path);
      if (ucScope) {
        const session = await readSession(ctxStore(routedReq, env, ctx), store);
        if (session) {
          const ucLimited = await userCriticalRateLimit(env, session.id, ucScope);
          if (ucLimited) return withCors(req, ucLimited);
        }
      }
      if (searchRateLimitApplies(req.method, path)) {
        const session = await readSession(ctxStore(routedReq, env, ctx), store);
        if (session) {
          const srLimited = await searchRateLimit(env, session.id);
          if (srLimited) return withCors(req, srLimited);
        }
      }
      const c = ctxStore(routedReq, env, ctx);
      const routed = await api.dispatch(c);
      if (routed) return withCors(req, applyDisableCache(req, routed));

      const noRouteUnpacked = await limitedDecompress(env, req);
      if (noRouteUnpacked.denied) {
        markSkipGzipResponse(inbound);
        return noRouteUnpacked.denied;
      }
      req = noRouteUnpacked.req;

      const plugin = await matchPluginRoute(store, req.method, path);
      if (plugin) {
        hit("relay");
        markSkipGzipResponse(inbound);
        try {
          if (plugin.kind === "route") return withCors(req, await handleNativePluginRoute(req, env, ctx, plugin, store));
          return withCors(req, await handleRelay(req, env, ctx));
        } catch {
          return withCors(req, pluginRoutePanicError());
        }
      }
      if (await matchPluginOwnedPath(store, path)) {
        markSkipGzipResponse(inbound);
        return withCors(req, pluginMethodNotAllowed());
      }
      const redirected = maybeFrontendBaseUrlRedirect(env, inbound, req);
      if (redirected) return redirected;
      if (path.startsWith("/v1") || path.startsWith("/api") || path.startsWith("/assets")) {
        const webLimited = await limitedGlobalWeb(env, req);
        if (webLimited) return webLimited;
        return withRelayNotFoundWebCache(withCors(req, relayNotFound(req.method, path)));
      }
    } catch (err) {
      hit("error");
      return withCors(req, newApiPanicError(err));
    }
  }

  const redirected = maybeFrontendBaseUrlRedirect(env, inbound, req);
  if (redirected) return redirected;

  const webLimited = await limitedGlobalWeb(env, req);
  if (webLimited) return webLimited;

  if (env.ASSETS) {
    // Original embedFileSystem.Open("/") returns ErrNotExist so `/` uses IndexPage.
    if (embedFolderExists(path)) {
      const res = await env.ASSETS.fetch(req);
      if (res.status !== 404) return withWebCacheHeaders(req, res);
    }
    // Original NoRoute last handler serves IndexPage for any method after
    // static.Serve skips. Extra-OK: OPTIONS 204 still runs first.
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
      const spa = await env.ASSETS.fetch(noRouteIndexPageAssetRequest(req));
      return withSpaCacheHeaders(await withIndexAnalytics(spa, env));
    }
  }
  if (path.startsWith("/v1") || path.startsWith("/api") || path.startsWith("/assets")) {
    return withRelayNotFoundWebCache(withCors(req, relayNotFound(req.method, path)));
  }
  return withWebCacheHeaders(req, new Response("Not Found", { status: 404 }));
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
        await store.expireStaleSystemTaskLocks(nowSec());
        try {
          await reportCurrentSystemInstance(store, env);
        } catch {
          /* original reporter logs and continues */
        }
        await runPendingChannelTestSystemTask(store, env);
        await runPendingModelUpdateSystemTask(store, env);
        await runPendingAsyncTaskPoll(store, env);
        await runPendingMidjourneyPoll(store, env);
        await runPendingLogCleanupSystemTask(store);
        try {
          await syncTaskPluginsOnce(store);
        } catch {
          /* original SyncTaskPlugins logs and continues */
        }
      })(),
    );
  },
};

void playgroundRelay;
