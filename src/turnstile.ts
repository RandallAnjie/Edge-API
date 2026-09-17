import { goJSONKind, goUnmarshalJSON } from "./channel-validate.js";
import { apiErrorMsg, clientIp } from "./http.js";
import type { Store } from "./store.js";

/** Original `https://challenges.cloudflare.com/turnstile/v0/siteverify`. */
export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Original leftover gin.H when `c.Query("turnstile")` is empty. */
export const MSG_TURNSTILE_TOKEN_EMPTY = "Turnstile token 为空";
/** Original leftover gin.H when siteverify `success` is false. */
export const MSG_TURNSTILE_VERIFY_FAILED = "Turnstile 校验失败，请刷新重试！";

/**
 * Original `middleware.TurnstileCheck` leftover gin.H (HTTP 200, no `data`).
 * Applied to login / register / verification / reset_password / checkin.
 */
export async function turnstileCheck(store: Store, req: Request): Promise<Response | null> {
  if (!(await store.optionBool("TurnstileCheckEnabled", false))) return null;
  const response = new URL(req.url).searchParams.get("turnstile") || "";
  if (!response) return apiErrorMsg(MSG_TURNSTILE_TOKEN_EMPTY);
  const body = new URLSearchParams({
    secret: await store.option("TurnstileSecretKey"),
    response,
    remoteip: clientIp(req),
  });
  let raw: globalThis.Response;
  try {
    raw = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return apiErrorMsg(err instanceof Error ? err.message : String(err));
  }
  const decoded = decodeTurnstileCheckResponse(await raw.text());
  if (!decoded.ok) return apiErrorMsg(decoded.message);
  if (!decoded.success) return apiErrorMsg(MSG_TURNSTILE_VERIFY_FAILED);
  return null;
}

/** Original `common.DecodeJson` into unexported `middleware.turnstileCheckResponse`. */
export function decodeTurnstileCheckResponse(
  raw: string,
): { ok: true; success: boolean } | { ok: false; message: string } {
  if (!raw.trim()) return { ok: false, message: "EOF" };
  const parsed = goUnmarshalJSON(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: true, success: false };
  if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {
      ok: false,
      message: `json: cannot unmarshal ${goJSONKind(parsed.value)} into Go value of type middleware.turnstileCheckResponse`,
    };
  }
  const rec = parsed.value as Record<string, unknown>;
  if (!("success" in rec) || rec.success == null) return { ok: true, success: false };
  if (typeof rec.success !== "boolean") {
    return {
      ok: false,
      message: `json: cannot unmarshal ${goJSONKind(rec.success)} into Go value of type bool`,
    };
  }
  return { ok: true, success: rec.success };
}
