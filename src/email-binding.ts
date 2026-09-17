import { hashPassword, verifyPassword } from "./crypto.js";
import { nowSec } from "./constants.js";
import { apiFailCode, json } from "./http.js";
import { notifyAccountSecurityChange, sendMail, sixDigitCode, validateAccountEmail } from "./mail.js";
import { authSessionIdentitiesEqual, authSessionIdentityJSON, type AuthSessionIdentityJSON } from "./telegram-oauth.js";
import type { AuthIdentity } from "./security.js";
import type { Store } from "./store.js";

/** Original `model.EmailBindingTTL`. */
export const EMAIL_BINDING_TTL_SEC = 600;
/** Original `model.EmailBindingResendDelay`. */
export const EMAIL_BINDING_RESEND_DELAY_SEC = 60;
/** Original `model.EmailBindingMaxAttempts`. */
export const EMAIL_BINDING_MAX_ATTEMPTS = 5;

/** Original `model.ErrEmailBindingCodeInvalid`. */
export const ERR_EMAIL_BINDING_CODE_INVALID = "Email verification code is incorrect.";
/** Original `model.ErrEmailBindingLocked`. */
export const ERR_EMAIL_BINDING_LOCKED = "Too many incorrect codes. Start email verification again.";
/** Original `model.ErrEmailBindingResendWait`. */
export const ERR_EMAIL_BINDING_RESEND_WAIT = "Please wait before requesting another verification code.";
/** Original `service.ErrEmailBindingDelivery`. */
export const ERR_EMAIL_BINDING_DELIVERY = "Verification email could not be sent. Start email verification again.";
/** Original `writeSecurityOperationError` for `model.ErrEmailAlreadyTaken`. */
export const ERR_EMAIL_ALREADY_TAKEN = "This email address is already in use.";
/** Original `model.ErrAccountBindingChanged`. */
export const ERR_ACCOUNT_BINDING_CHANGED = "Account bindings have changed. Start this operation again.";

export const EMAIL_BIND_FLOW_TYPE = "email_bind";

export type EmailBindingAuthorization = AuthSessionIdentityJSON & {
  proof_id: number;
  scope: string;
  context_hash: string;
  method: string;
};

/** Original `model.EmailBindingState`. */
export type EmailBindingState = {
  authorization: EmailBindingAuthorization;
  current_email: string;
  email: string;
  new_code_hash: string;
  old_code_hash?: string;
  failed_attempts: number;
  resend_at: number;
};

/** Original `service.EmailBindingData`. */
export type EmailBindingData = {
  flow_token: string;
  email: string;
  current_email?: string;
  old_email_required: boolean;
  expires_at: number;
  resend_at: number;
  notification_warning: boolean;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Original `common.MaskEmail`. */
export function maskEmail(email: string): string {
  if (!email) return "***masked***";
  const at = email.indexOf("@");
  if (at < 0) return "***masked***";
  return "***@" + email.slice(at + 1);
}

/** Original `common.ValidateNumericCode`. */
export function validateNumericCode(raw: string): string | null {
  const code = raw.replace(/ /g, "");
  if (code.length !== 6 || !/^\d+$/.test(code)) return null;
  return code;
}

export function emailBindingView(token: string, expiresAt: number, state: EmailBindingState, notificationWarning = false): EmailBindingData {
  return {
    flow_token: token,
    email: state.email,
    current_email: maskEmail(state.current_email),
    old_email_required: Boolean(state.old_code_hash),
    expires_at: expiresAt,
    resend_at: state.resend_at,
    notification_warning: notificationWarning,
  };
}

export async function generateEmailBindingCodes(requireOld: boolean): Promise<{
  New: string;
  Old: string;
  NewHash: string;
  OldHash: string;
}> {
  const codes = { New: "", Old: "", NewHash: "", OldHash: "" };
  const count = requireOld ? 2 : 1;
  for (let index = 0; index < count; ) {
    const code = sixDigitCode();
    if (code === codes.New) continue;
    const hash = await hashPassword(code);
    if (index === 0) {
      codes.New = code;
      codes.NewHash = hash;
    } else {
      codes.Old = code;
      codes.OldHash = hash;
    }
    index += 1;
  }
  return codes;
}

export async function sendEmailBindingCodes(store: Store, state: EmailBindingState, codes: { New: string; Old: string }): Promise<void> {
  const name = (await store.option("SystemName")) || "new-api";
  const subject = `${name} — Confirm your email address`;
  try {
    await sendMail(
      store,
      state.email,
      subject,
      `<p>Confirm linking this email address to your account.</p><p>Verification code: <strong>${escapeHtml(codes.New)}</strong></p><p>This code expires in 10 minutes. If you did not request this change, do not share this code.</p>`,
    );
    if (codes.Old) {
      await sendMail(
        store,
        state.current_email,
        subject,
        `<p>A change to your account email address was requested. Confirm replacing your current address.</p><p>Verification code: <strong>${escapeHtml(codes.Old)}</strong></p><p>This code expires in 10 minutes. If you did not request this change, do not share this code and contact your administrator.</p>`,
      );
    }
  } catch {
    throw Object.assign(new Error(ERR_EMAIL_BINDING_DELIVERY), { code: "EMAIL_BINDING_DELIVERY_FAILED" });
  }
}

export function parseEmailBindingState(raw: string): EmailBindingState | null {
  try {
    const state = JSON.parse(raw) as EmailBindingState;
    if (!state || typeof state !== "object" || !state.authorization || !state.email || !state.new_code_hash) return null;
    return state;
  } catch {
    return null;
  }
}

export function authFlowInvalid(): Response {
  return apiFailCode("Verification flow expired", "AUTH_FLOW_INVALID");
}

export function emailBindingLocked(): Response {
  return apiFailCode(ERR_EMAIL_BINDING_LOCKED, "EMAIL_BINDING_LOCKED");
}

export function emailBindingCodeInvalid(): Response {
  return apiFailCode(ERR_EMAIL_BINDING_CODE_INVALID, "EMAIL_BINDING_CODE_INVALID");
}

export function emailBindingResendWait(): Response {
  return apiFailCode(ERR_EMAIL_BINDING_RESEND_WAIT, "EMAIL_BINDING_RESEND_WAIT", 429);
}

export function emailAlreadyTaken(): Response {
  return apiFailCode(ERR_EMAIL_ALREADY_TAKEN, "EMAIL_ALREADY_TAKEN");
}

export function emailBindingChanged(): Response {
  return json(409, { success: false, code: "ACCOUNT_SECURITY_STATE_CHANGED", message: ERR_ACCOUNT_BINDING_CHANGED });
}

export function emailDeliveryFailed(): Response {
  return apiFailCode(ERR_EMAIL_BINDING_DELIVERY, "EMAIL_BINDING_DELIVERY_FAILED");
}

export async function loadEmailBinding(
  store: Store,
  identity: AuthIdentity,
  token: string,
): Promise<{ flow: { token: string; expires_at: number; payload: string }; state: EmailBindingState } | { error: Response }> {
  const flow = await store.getAuthFlow(token);
  if (
    !flow ||
    flow.type !== EMAIL_BIND_FLOW_TYPE ||
    Number(flow.user_id) !== identity.userId ||
    String(flow.session_id || "") !== identity.sessionId ||
    Number(flow.consumed_at || 0) > 0 ||
    flow.expires_at < nowSec()
  ) {
    return { error: authFlowInvalid() };
  }
  const state = parseEmailBindingState(flow.payload);
  if (!state) return { error: authFlowInvalid() };
  if (Number(state.failed_attempts || 0) >= EMAIL_BINDING_MAX_ATTEMPTS) return { error: emailBindingLocked() };
  return { flow, state };
}

export async function validateStoredEmailBinding(
  store: Store,
  identity: AuthIdentity,
  state: EmailBindingState,
  contextHash: string,
): Promise<Response | null> {
  const auth = state.authorization;
  if (
    !auth ||
    Number(auth.proof_id || 0) <= 0 ||
    auth.scope !== "account.binding.bind" ||
    !auth.context_hash ||
    !state.email ||
    !state.new_code_hash ||
    !authSessionIdentitiesEqual(auth, identity)
  ) {
    return authFlowInvalid();
  }
  if (auth.context_hash !== contextHash) return authFlowInvalid();
  if (!(await store.validateAuthSession(identity))) {
    return json(401, { success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" });
  }
  const user = await store.getUserById(identity.userId);
  if (!user) return authFlowInvalid();
  const current = (user.email || "").trim().toLowerCase();
  if (current !== state.current_email || state.current_email === state.email) return emailBindingChanged();
  const validated = await validateAccountEmail(store, state.email);
  if (!validated.ok) return apiFailCode(validated.message, validated.code);
  return null;
}

export function emailBindingAuthorization(
  identity: AuthIdentity,
  method: string,
  contextHash: string,
): EmailBindingAuthorization {
  return {
    ...authSessionIdentityJSON(identity),
    proof_id: 1,
    scope: "account.binding.bind",
    context_hash: contextHash,
    method,
  };
}

export async function emailTakenByOther(store: Store, email: string, userId: number): Promise<boolean> {
  const taken = await store.getUserByEmail(email, { includeDeleted: true });
  return Boolean(taken && taken.id !== userId);
}

export async function emailBindingCodesValid(state: EmailBindingState, newRaw: string, oldRaw: string): Promise<boolean> {
  const newCode = validateNumericCode(newRaw);
  const oldCode = validateNumericCode(oldRaw);
  const newValid = Boolean(newCode && (await verifyPassword(newCode, state.new_code_hash)));
  const oldValid = !state.old_code_hash || Boolean(oldCode && (await verifyPassword(oldCode, state.old_code_hash)));
  return newValid && oldValid;
}

export async function notifyEmailBound(store: Store, previous: string, next: string): Promise<boolean> {
  let warning = await notifyAccountSecurityChange(store, previous, "Email address changed");
  if (await notifyAccountSecurityChange(store, next, "Email address confirmed")) warning = true;
  return warning;
}
