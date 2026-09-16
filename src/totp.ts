import { nowSec } from "./constants.js";
import type { UserRow } from "./types.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Original `service.ErrVerificationLocked`. */
export const ERR_VERIFICATION_LOCKED = "Two-factor authentication is temporarily locked.";
/** Original `service.ErrVerificationFailed`. */
export const ERR_VERIFICATION_FAILED = "Verification failed. Please try again.";
/** Original `model.ErrTwoFANotEnabled` via `writeSecurityOperationError`. */
export const ERR_TWOFA_NOT_ENABLED = "Two-factor authentication is not enabled.";
/** Original `model.ErrTwoFASetupInvalid`. */
export const ERR_TWOFA_SETUP_INVALID = "The two-factor setup has expired or changed. Start setup again.";
/** Original `model.ErrTwoFACodeInvalid`. */
export const ERR_TWOFA_CODE_INVALID = "The authenticator code is incorrect.";
/** Original `common.BackupCodeLength`. */
const BACKUP_CODE_LENGTH = 8;

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/g, "").toUpperCase().replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(secret: Uint8Array, counter: number): Promise<number> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(4, counter >>> 0, false);
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0xf;
  const bin =
    ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) | ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff);
  return bin % 1_000_000;
}

export async function totpCode(secret: string, t = Date.now()): Promise<string> {
  const counter = Math.floor(Math.floor(t / 1000) / 30);
  const n = await hotp(base32Decode(secret), counter);
  return n.toString().padStart(6, "0");
}

export async function verifyTotp(secret: string, code: string, window = 1): Promise<boolean> {
  if (!secret || !code) return false;
  const want = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(want)) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    if ((await totpCode(secret, now + i * 30_000)) === want) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, username: string, issuer = "Edge API"): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

export function generateBackupCodes(n = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const buf = crypto.getRandomValues(new Uint8Array(4));
    out.push([...buf].map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return out;
}

export function verifyBackupCode(stored: string, code: string): { ok: boolean; rest: string } {
  const want = normalizeBackupCode(code);
  const codes = stored
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = codes.findIndex((s) => normalizeBackupCode(s) === want);
  if (idx < 0) return { ok: false, rest: stored };
  codes.splice(idx, 1);
  return { ok: true, rest: codes.join(",") };
}

/** Original `model.TwoFA.IsLocked`. */
export function twoFALocked(user: Pick<UserRow, "totp_locked_until">, now = nowSec()): boolean {
  return Number(user.totp_locked_until || 0) > now;
}

/** Original `service.VerificationMethodOption` for an enrolled 2FA factor. */
export function twoFAVerificationOption(user: Pick<UserRow, "totp_locked_until">): {
  method: "2fa";
  available: boolean;
  reason?: string;
} {
  if (twoFALocked(user)) {
    return { method: "2fa", available: false, reason: ERR_VERIFICATION_LOCKED };
  }
  return { method: "2fa", available: true };
}

/** Original `common.ValidateNumericCode`. */
export function validateNumericCode(code: string): string | null {
  const clean = code.replace(/ /g, "");
  if (clean.length !== 6 || !/^\d{6}$/.test(clean)) return null;
  return clean;
}

/** Original `common.ValidateBackupCode` format check. */
export function validateBackupCodeFormat(code: string): boolean {
  const clean = code.replace(/-/g, "").toUpperCase();
  if (clean.length !== BACKUP_CODE_LENGTH) return false;
  return /^[A-Z0-9]+$/.test(clean);
}

/** Original `common.NormalizeBackupCode` without re-inserting dashes. */
function normalizeBackupCode(code: string): string {
  return code.replace(/-/g, "").trim().toLowerCase();
}

export type TwoFactorVerifyResult =
  | { ok: true }
  | { ok: false; code: "TWOFA_NOT_ENABLED" | "SECURITY_VERIFICATION_LOCKED" | "SECURITY_VERIFICATION_FAILED"; message: string };

type TwoFactorStore = {
  getUserById(id: number): Promise<UserRow | null>;
  incrementTotpFailures(userId: number): Promise<void>;
  resetTotpFailures(userId: number): Promise<void>;
  updateUser(id: number, patch: Record<string, unknown>): Promise<void>;
};

/**
 * Original `service.VerifyTwoFactorCode`.
 * Classifies numeric TOTP vs backup format so one submission cannot increment both counters.
 */
export async function verifyTwoFactorCode(store: TwoFactorStore, user: UserRow, code: string): Promise<TwoFactorVerifyResult> {
  const current = (await store.getUserById(user.id)) || user;
  if (Number(current.totp_enabled) !== 1) {
    return { ok: false, code: "TWOFA_NOT_ENABLED", message: ERR_TWOFA_NOT_ENABLED };
  }
  if (twoFALocked(current)) {
    return { ok: false, code: "SECURITY_VERIFICATION_LOCKED", message: ERR_VERIFICATION_LOCKED };
  }
  const trimmed = code.trim();
  const numeric = validateNumericCode(trimmed);
  if (numeric !== null) {
    if (!(await verifyTotp(current.totp_secret || "", numeric))) {
      await store.incrementTotpFailures(current.id);
      return { ok: false, code: "SECURITY_VERIFICATION_FAILED", message: ERR_VERIFICATION_FAILED };
    }
    await store.resetTotpFailures(current.id);
    return { ok: true };
  }
  if (validateBackupCodeFormat(trimmed)) {
    const backup = verifyBackupCode(current.totp_backup || "", trimmed);
    if (!backup.ok) {
      await store.incrementTotpFailures(current.id);
      return { ok: false, code: "SECURITY_VERIFICATION_FAILED", message: ERR_VERIFICATION_FAILED };
    }
    await store.updateUser(current.id, {
      totp_backup: backup.rest,
      totp_failed_attempts: 0,
      totp_locked_until: 0,
    });
    return { ok: true };
  }
  await store.incrementTotpFailures(current.id);
  return { ok: false, code: "SECURITY_VERIFICATION_FAILED", message: ERR_VERIFICATION_FAILED };
}
