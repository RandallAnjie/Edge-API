import type { Store } from "./store.js";

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
