import type { Store } from "./store.js";

export const ERR_ACCOUNT_EMAIL_INVALID = "Please enter a valid email address";
export const ERR_ACCOUNT_EMAIL_RESTRICTED =
  "This email address is not allowed by the administrator's email policy.";

/** Original `model.NormalizeEmail`. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Original `service.ValidateAccountEmail`. */
export async function validateAccountEmail(
  store: Store,
  raw: string,
): Promise<{ ok: true; email: string } | { ok: false; code: string; message: string }> {
  const email = normalizeEmail(raw);
  if (!email || email.length > 50 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, code: "EMAIL_ADDRESS_REJECTED", message: ERR_ACCOUNT_EMAIL_INVALID };
  }
  const parts = email.split("@");
  if (parts.length !== 2) {
    return { ok: false, code: "EMAIL_ADDRESS_REJECTED", message: ERR_ACCOUNT_EMAIL_INVALID };
  }
  if (await store.optionBool("EmailDomainRestrictionEnabled", false)) {
    const allowed = (await store.option("EmailDomainWhitelist"))
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(parts[1])) {
      return { ok: false, code: "EMAIL_ADDRESS_REJECTED", message: ERR_ACCOUNT_EMAIL_RESTRICTED };
    }
  }
  if ((await store.optionBool("EmailAliasRestrictionEnabled", false)) && /[+.]/.test(parts[0])) {
    return { ok: false, code: "EMAIL_ADDRESS_REJECTED", message: ERR_ACCOUNT_EMAIL_RESTRICTED };
  }
  return { ok: true, email };
}

export async function mailConfigured(store: Store): Promise<boolean> {
  return Boolean(await store.option("ResendApiKey"));
}

export async function sendMail(store: Store, to: string, subject: string, html: string): Promise<void> {
  const key = await store.option("ResendApiKey");
  if (!key) throw new Error("邮件未配置");
  const from = (await store.option("ResendFrom")) || "Edge API <noreply@bigrandall.io>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("邮件发送失败: " + text.slice(0, 300));
  }
}

export function sixDigitCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Original `service.NotifyAccountSecurityChange`.
 * Returns true when delivery failed (`notification_warning`). Empty email is not a failure.
 */
export async function notifyAccountSecurityChange(store: Store, email: string, event: string): Promise<boolean> {
  if (!email) return false;
  const name = (await store.option("SystemName")) || "new-api";
  try {
    await sendMail(
      store,
      email,
      `${name} — Account security notification`,
      `<p>Your account security settings have changed: ${escapeHtml(event)}.</p><p>If you did not make this change, open your account security settings, revoke other login sessions, and contact your administrator.</p>`,
    );
    return false;
  } catch {
    return true;
  }
}
