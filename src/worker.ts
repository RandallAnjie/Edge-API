import { START_TIME, VERSION } from "./constants.js";
import { authenticateApiToken, rateLimit } from "./auth.js";
import { apiFail, openaiError, readJson, withCors } from "./http.js";
import { adminRouter } from "./routes.js";
import { listModelsForAuth, playgroundRelay, proxyMj, relay, retrieveModel, detectModel, detectStream } from "./relay.js";
import type { ClientFormat } from "./relay.js";
import type { RelayMode } from "./upstream.js";
import { extractGeminiModelAction } from "./convert.js";
import { ensureSchema } from "./schema.js";
import { Store } from "./store.js";
import type { Env, ExecutionContextLike } from "./types.js";

const api = adminRouter();

function clientFormatFrom(req: Request, path: string): ClientFormat {
  if (path.startsWith("/v1beta") || path.startsWith("/v1/models/") && (req.headers.get("x-goog-api-key") || new URL(req.url).searchParams.get("key"))) {
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
  if (path.startsWith("/v1beta/models") && method === "POST") return "gemini";
  if (path.startsWith("/v1/models/") && method === "POST") return "gemini";
  return null;
}

async function handleRelay(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const store = new Store(env.DB);
  const auth = await authenticateApiToken(
    { req, env, url, params: {}, waitUntil: (p) => ctx.waitUntil(p) },
    store,
  );
  if (auth instanceof Response) return auth;
  if (!(await rateLimit(env, auth.token.id))) return openaiError(429, "请求过于频繁", "rate_limit");

  if (req.method === "GET" && (path === "/v1/models" || path === "/v1beta/models" || path === "/v1beta/openai/models")) {
    const fmt: ClientFormat =
      path.startsWith("/v1beta/models") && !path.includes("openai")
        ? "gemini"
        : req.headers.get("x-api-key") && req.headers.get("anthropic-version")
          ? "anthropic"
          : "openai";
    return listModelsForAuth(store, auth, fmt);
  }

  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    const model = decodeURIComponent(path.slice("/v1/models/".length));
    return retrieveModel(store, auth, model);
  }

  if (path.startsWith("/mj/") || path.match(/^\/[^/]+\/mj\//)) {
    const mjPath = path.replace(/^\/[^/]+(\/mj\/)/, "/mj/").replace(/^\/mj/, "");
    return proxyMj(req, store, auth, path.startsWith("/mj") ? path.slice(3) || "/" : path);
  }

  const mode = relayModeFrom(path, req.method);
  if (!mode) {
    return openaiError(501, "尚未实现该接口", "not_implemented");
  }

  let body: unknown = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      body = {};
      const targetPath = path;
      const buf = await req.arrayBuffer();
      return proxyRaw(req, env, store, auth, mode, targetPath, buf, ctx);
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

  const fmt = clientFormatFrom(req, path);
  return relay({
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
  });
}

async function proxyRaw(
  req: Request,
  env: Env,
  store: Store,
  auth: Awaited<ReturnType<typeof authenticateApiToken>> extends Response ? never : Awaited<ReturnType<typeof authenticateApiToken>>,
  mode: RelayMode,
  path: string,
  raw: ArrayBuffer,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const model = new URL(req.url).searchParams.get("model") || "";
  return relay({
    req,
    env,
    store,
    auth: auth as never,
    mode,
    clientFormat: "openai",
    model,
    body: {},
    stream: false,
    path,
    ctx,
  });
}

async function handleFetch(req: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

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
    path.startsWith("/dashboard") ||
    /^\/[^/]+\/mj\//.test(path);

  if (needsDb) {
    if (!env.DB) {
      return withCors(
        req,
        apiFail("D1 binding DB is missing. Deploy with rrangler so d1_databases is synced.", null, 500),
      );
    }
    await ensureSchema(env.DB);

    const isRelay =
      (path.startsWith("/v1/") && !path.startsWith("/v1/dashboard")) ||
      path.startsWith("/v1beta") ||
      path.startsWith("/mj/") ||
      /^\/[^/]+\/mj\//.test(path);

    try {
      if (isRelay && !path.startsWith("/v1/dashboard")) {
        return withCors(req, await handleRelay(req, env, ctx));
      }

      const c = {
        req,
        env,
        url,
        params: {} as Record<string, string>,
        waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
      };
      const routed = await api.dispatch(c);
      if (routed) return withCors(req, routed);

      if (path === "/v1/realtime") {
        return openaiError(501, "Realtime WebSocket 需要上游渠道支持；请使用标准 chat/completions。", "not_implemented");
      }
    } catch (err) {
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
      return env.ASSETS.fetch(new Request(new URL("/index.html", req.url), req));
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
      })(),
    );
  },
};

void playgroundRelay;
