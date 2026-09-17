/**
 * Original `middleware.PrepareTaskPluginSubmit` + `controller.RelayTask`
 * for `POST /v1/tasks/:key`.
 */
import { goUnmarshalObject } from "./channel-validate.js";
import { pinnedTaskPluginChannelTypes } from "./channel-constraint.js";
import { invalidTaskPluginRequestError, pluginRoutePanicError, taskErrorJson } from "./http.js";
import { applyOriginTaskIntent } from "./origin-task.js";
import { pluginModelNames } from "./plugin-meta.js";
import type { MatchedPlugin } from "./plugin-dispatch.js";
import { canonicalModel, resolveTaskModelAlias, routingIndexFromPlugins } from "./task-model-alias.js";
import { listRoutingPlugins } from "./task-plugin-factory.js";
import {
  BODY_JSON,
  loadCompiledPlugin,
  pluginRequestId,
  type RouteRequestContext,
} from "./task-plugin-route.js";
import { continueNativeSubmit } from "./task-plugin-submit.js";
import type { Store } from "./store.js";
import type { AuthToken, Env } from "./types.js";

/** Original `POST /v1/tasks/:key` plugin-key path. */
export function taskPluginSubmitKey(path: string): string | null {
  const match = path.match(/^\/v1\/tasks\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]).trim() : null;
}

/** Original `middleware.PrepareTaskPluginSubmit` then `controller.RelayTask`. */
export async function handlePrepareTaskPluginSubmit(opts: {
  req: Request;
  env: Env;
  store: Store;
  auth: AuthToken;
  pluginKey: string;
}): Promise<Response> {
  const plugins = await listRoutingPlugins(opts.store);
  const routing = plugins.find((plugin) => plugin.key === opts.pluginKey);
  if (!routing) return invalidTaskPluginRequestError("task plugin not found");

  const raw = await opts.req.clone().text();
  const decoded = goUnmarshalObject(raw);
  if (!decoded.ok) return invalidTaskPluginRequestError(decoded.message);

  const requestBody = { ...decoded.value };
  let modelName = typeof requestBody.model === "string" ? requestBody.model : "";
  if (!modelName.trim()) return invalidTaskPluginRequestError("model is required");

  const models = pluginModelNames(routing.meta);
  const index = routingIndexFromPlugins(plugins);
  const alias = await resolveTaskModelAlias(opts.store, modelName);
  const exactOwned = models.includes(modelName);
  const exactAlias = Boolean(alias && alias.alias === modelName && alias.pluginKey === routing.key);
  if (!exactOwned && !exactAlias) {
    let folded = "";
    const declared = canonicalModel(index, modelName);
    if (declared && models.includes(declared) && declared !== modelName) {
      folded = declared;
    } else if (alias && alias.pluginKey === routing.key && alias.alias && alias.alias !== modelName) {
      folded = alias.alias;
    }
    if (folded) {
      requestBody.model = folded;
      modelName = folded;
    }
  }

  let engine;
  try {
    if (!routing.source) throw new Error("plugin source is empty");
    engine = loadCompiledPlugin(routing.source, routing.key, String(routing.meta.version || "")).engine;
  } catch {
    return pluginRoutePanicError();
  }

  const path = new URL(opts.req.url).pathname;
  const requestContext: RouteRequestContext = {
    path,
    method: opts.req.method,
    params: { key: opts.pluginKey },
    query: {},
    body: { kind: BODY_JSON, value: requestBody },
    files: [],
    fileContents: [],
    requestBody,
  };
  const intent = await applyOriginTaskIntent(opts.store, opts.auth.user.id, requestBody, {
    key: routing.key,
    channelTypes: pinnedTaskPluginChannelTypes(routing.meta.channelTypes),
  });
  if (intent.error) {
    return taskErrorJson(intent.error.statusCode, intent.error.code, intent.error.message);
  }

  const plugin: MatchedPlugin = {
    key: routing.key,
    path,
    channelTypes: pinnedTaskPluginChannelTypes(routing.meta.channelTypes),
    kind: "route",
    models,
    source: routing.source,
    version: String(routing.meta.version || ""),
  };
  const requestId = pluginRequestId(opts.req);
  return continueNativeSubmit(
    opts.req,
    opts.env,
    opts.store,
    opts.auth,
    plugin,
    {
      kind: "submit",
      model: modelName,
      action: "",
      requestBody,
      resolved: requestBody,
      engine,
      requestContext,
      origin: intent,
      pinnedRoute: false,
    },
    requestId,
  );
}
