/**
 * Original `service.ShouldDisableChannel` + `controller.processChannelError`
 * + `model.RecordErrorLog` other JSON on RandallFlare.
 */
import {
  LOG_ERROR,
  automaticDisableKeywordsToString,
  parseBool,
} from "./constants.js";
import { disableStatusCodeRangesFromOption, shouldDisableByStatusCode } from "./status-code-ranges.js";
import type { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env } from "./types.js";

/** Original `types.NewAPIError` fields used by processChannelError. */
export type ChannelAttemptError = {
  message: string;
  statusCode: number;
  errorCode: string;
  errorType: string;
  skipRetry?: boolean;
  recordErrorLog?: boolean;
};

/** Original `types.IsChannelError`. */
export function isChannelErrorCode(code: string): boolean {
  return String(code || "").startsWith("channel:");
}

/** Original `types.ErrorWithStatusCode`. */
export function errorWithStatusCode(err: ChannelAttemptError): string {
  const msg = err.message || "";
  if (!err.statusCode) return msg || err.errorCode;
  if (!msg) return `status_code=${err.statusCode}`;
  return `status_code=${err.statusCode}, ${msg}`;
}

/** Original `operation_setting.AutomaticDisableKeywordsFromString`. */
export function automaticDisableKeywordsFromString(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const k = line.trim().toLowerCase();
    if (k) out.push(k);
  }
  return out;
}

export function automaticDisableKeywordsFromOption(raw: string): string[] {
  if (!raw) return automaticDisableKeywordsFromString(automaticDisableKeywordsToString());
  return automaticDisableKeywordsFromString(raw);
}

/** Original `service.AcSearch` boolean hit (substring after lowercasing). */
export function automaticDisableKeywordHit(message: string, keywords: string[]): boolean {
  if (!keywords.length || !message) return false;
  const lower = message.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function errorLogEnabled(env: Env): boolean {
  return parseBool(env.ERROR_LOG_ENABLED, false);
}

/**
 * Original `controller.processChannelError` `Log.Other` JSON:
 * public `request_path` / `error_type` / `error_code` / `status_code`,
 * admin `use_channel`, no top-level `channel_id` / `channel_name` / `channel_type`.
 */
export function errorLogOtherJSON(opts: {
  requestPath: string;
  errorType: string;
  errorCode: string;
  statusCode: number;
  useChannel: string[];
}): string {
  return JSON.stringify({
    request_path: opts.requestPath,
    error_type: opts.errorType,
    error_code: opts.errorCode,
    status_code: opts.statusCode,
    admin_info: { use_channel: opts.useChannel },
  });
}

/** Original `service.ShouldDisableChannel`. */
export async function shouldDisableChannel(store: Store, err: ChannelAttemptError): Promise<boolean> {
  if (!(await store.optionBool("AutomaticDisableChannelEnabled", false))) return false;
  if (isChannelErrorCode(err.errorCode)) return true;
  if (err.skipRetry) return false;
  const ranges = disableStatusCodeRangesFromOption(await store.option("AutomaticDisableStatusCodes"));
  if (shouldDisableByStatusCode(err.statusCode, ranges)) return true;
  const keywords = automaticDisableKeywordsFromOption(await store.option("AutomaticDisableKeywords"));
  return automaticDisableKeywordHit(err.message, keywords);
}

export function channelAttemptFromUpstream(status: number, bodyText: string): ChannelAttemptError {
  let message = `bad response status code ${status}`;
  let errorCode = "bad_response_status_code";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const errField = parsed.error;
    if (errField && typeof errField === "object") {
      const err = errField as Record<string, unknown>;
      if (typeof err.message === "string" && err.message) {
        message = err.message;
        if (err.code != null && err.code !== "") errorCode = String(err.code);
      }
    } else if (typeof errField === "string" && errField) {
      message = errField;
    } else {
      const extracted = [parsed.message, parsed.msg, parsed.err, parsed.error_msg, parsed.detail].find(
        (v) => typeof v === "string" && v,
      ) as string | undefined;
      if (extracted) message = extracted;
    }
  } catch {
    /* non-JSON body: original InitOpenAIError message */
  }
  return {
    message,
    statusCode: status,
    errorCode,
    errorType: "openai_error",
  };
}

export function channelAttemptFromNewApi(
  message: string,
  statusCode: number,
  errorCode: string,
  skipRetry = false,
): ChannelAttemptError {
  return { message, statusCode, errorCode, errorType: "new_api_error", skipRetry };
}

/** Original RelayTask wrap: `types.NewOpenAIError(taskErr.Error, ErrorCodeBadResponseStatusCode, taskErr.StatusCode)`. */
export function channelAttemptFromTaskRelay(err: { message: string; statusCode: number }): ChannelAttemptError {
  return {
    message: err.message,
    statusCode: err.statusCode,
    errorCode: "bad_response_status_code",
    errorType: "openai_error",
  };
}

/** Original `controller.processChannelError`. */
export async function processChannelError(opts: {
  store: Store;
  env: Env;
  req: Request;
  auth: AuthToken;
  channel: ChannelRow;
  model: string;
  err: ChannelAttemptError;
  useChannel: string[];
  useTimeSeconds?: number;
  isStream?: boolean;
  requestId?: string;
}): Promise<void> {
  const autoBan = Number(opts.channel.auto_ban ?? 1) === 1;
  if ((await shouldDisableChannel(opts.store, opts.err)) && autoBan) {
    await opts.store.autoDisableChannel(opts.channel.id, errorWithStatusCode(opts.err));
  }
  if (!errorLogEnabled(opts.env)) return;
  if (opts.err.recordErrorLog === false) return;
  const path = new URL(opts.req.url).pathname;
  await opts.store.insertLog({
    user_id: opts.auth.user.id,
    type: LOG_ERROR,
    content: errorWithStatusCode(opts.err),
    username: opts.auth.user.username,
    token_name: opts.auth.token.name,
    model_name: opts.model,
    quota: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    use_time: opts.useTimeSeconds ?? 0,
    is_stream: opts.isStream ? 1 : 0,
    channel_id: opts.channel.id,
    token_id: opts.auth.token.id,
    group: String(opts.auth.user.group || ""),
    ip: "",
    request_id: opts.requestId || opts.req.headers.get("x-oneapi-request-id") || "",
    upstream_request_id: "",
    other: errorLogOtherJSON({
      requestPath: path,
      errorType: opts.err.errorType,
      errorCode: opts.err.errorCode,
      statusCode: opts.err.statusCode,
      useChannel: opts.useChannel,
    }),
  });
}