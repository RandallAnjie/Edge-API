import { SECURITY_PROOF_TTL_SEC, nowSec } from "./constants.js";
import {
  authFlowTokenHash,
  b64urlToBytes,
  randomOpaqueToken,
  signSecurityProofJwt,
  timingSafeEqualStr,
  verificationContextHash,
  verifySecurityProofJwt,
} from "./crypto.js";
import { apiFailCode, json } from "./http.js";
import { verificationRequirements } from "./dto.js";
import type { Store } from "./store.js";
import type { Context } from "./router.js";
import type { Env, UserRow } from "./types.js";

export interface AuthIdentity {
  userId: number;
  sessionId: string;
  userAuthVersion: number;
  sessionVersion: number;
}

export interface VerificationOperation {
  scope: string;
  context?: unknown;
}

export interface SecurityProof {
  proof_token: string;
  expires_at: number;
  method: string;
  scope: string;
}

const EMPTY_CONTEXT_SCOPES = new Set([
  "passkey.register",
  "passkey.delete",
  "2fa.setup",
  "2fa.disable",
  "2fa.backup_codes.regenerate",
  "access_token.generate",
  "access_token.revoke",
  "account.password.set",
  "account.password.change",
  "account.delete",
]);

function contextObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === "") return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

export async function bindVerificationOperation(
  sessionSecretValue: string,
  operation: VerificationOperation,
): Promise<{ ok: true; binding: { scope: string; contextHash: string } } | { ok: false; code: string; message: string; status: number }> {
  const scope = String(operation.scope || "").trim();
  const fields = contextObject(operation.context);
  if (fields == null) {
    return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
  }
  let normalized: Record<string, unknown> = {};
  if (scope === "channel.key.read") {
    const keys = Object.keys(fields);
    const channelId = Number(fields.channel_id);
    if (keys.length !== 1 || !keys.includes("channel_id") || !Number.isInteger(channelId) || channelId <= 0) {
      return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
    }
    normalized = { channel_id: channelId };
  } else if (scope === "account.binding.bind") {
    const provider = String(fields.provider || "").trim();
    if (provider === "email") {
      const email = String(fields.email || "").trim().toLowerCase();
      if (Object.keys(fields).length !== 2 || !email.includes("@") || fields.code) {
        return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
      }
      normalized = { provider, email };
    } else if (provider === "wechat") {
      const code = String(fields.code || "").trim();
      if (Object.keys(fields).length !== 2 || !code || code.length > 128 || fields.email) {
        return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
      }
      normalized = { provider, code };
    } else {
      if (Object.keys(fields).length !== 1 || !provider || provider.length > 64) {
        return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
      }
      normalized = { provider };
    }
  } else if (scope === "account.binding.unbind") {
    const keys = Object.keys(fields);
    const providerId = Number(fields.provider_id);
    if (keys.length !== 1 || !keys.includes("provider_id") || !Number.isInteger(providerId) || providerId <= 0) {
      return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
    }
    normalized = { provider_id: providerId };
  } else if (EMPTY_CONTEXT_SCOPES.has(scope)) {
    if (Object.keys(fields).length !== 0) {
      return { ok: false, code: "SECURITY_CONTEXT_INVALID", message: "The action details are invalid.", status: 400 };
    }
    normalized = {};
  } else {
    return { ok: false, code: "SECURITY_PROOF_SCOPE_MISMATCH", message: "Verification does not match this action.", status: 200 };
  }
  const payload = JSON.stringify({ scope, context: normalized });
  return {
    ok: true,
    binding: { scope, contextHash: await verificationContextHash(sessionSecretValue, payload) },
  };
}

export function securityProofError(code: string, message: string, status = 403): Response {
  return json(status, { success: false, message, code });
}

export async function issueSecurityProof(
  store: Store,
  secret: string,
  identity: AuthIdentity,
  method: string,
  binding: { scope: string; contextHash: string },
): Promise<SecurityProof> {
  const now = nowSec();
  const expiresAt = now + SECURITY_PROOF_TTL_SEC;
  const opaque = randomOpaqueToken();
  const hash = await authFlowTokenHash(secret, opaque);
  await store.insertAuthFlow({
    token: hash,
    type: "security_proof",
    user_id: identity.userId,
    expires_at: expiresAt,
    payload: JSON.stringify({ method, scope: binding.scope, context_hash: binding.contextHash }),
    session_id: identity.sessionId,
  });
  const proofToken = await signSecurityProofJwt(
    secret,
    {
      userId: identity.userId,
      sid: identity.sessionId,
      userAuthVersion: identity.userAuthVersion,
      sessionVersion: identity.sessionVersion,
    },
    { method, scopes: [binding.scope], contextHash: binding.contextHash, jti: opaque },
    now,
    expiresAt,
  );
  return { proof_token: proofToken, expires_at: expiresAt, method, scope: binding.scope };
}

export async function consumeOperationProof(
  store: Store,
  secret: string,
  identity: AuthIdentity,
  user: UserRow,
  operation: VerificationOperation,
  raw: string,
): Promise<{ ok: true; method: string } | { ok: false; response: Response }> {
  const bound = await bindVerificationOperation(secret, operation);
  if (!bound.ok) return { ok: false, response: securityProofError(bound.code, bound.message, bound.status) };
  const claims = await verifySecurityProofJwt(raw, secret);
  if (!claims) {
    try {
      const parts = raw.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as { exp?: number };
        if (typeof payload.exp === "number" && payload.exp + 5 < nowSec()) {
          return { ok: false, response: securityProofError("SECURITY_PROOF_EXPIRED", "安全验证已过期") };
        }
      }
    } catch {
      /* ignore */
    }
    return { ok: false, response: securityProofError("SECURITY_PROOF_INVALID", "安全验证状态无效") };
  }
  if (
    Number(claims.sub) !== identity.userId ||
    claims.sid !== identity.sessionId ||
    claims.uv !== identity.userAuthVersion ||
    claims.sv !== identity.sessionVersion
  ) {
    return { ok: false, response: securityProofError("SECURITY_PROOF_INVALID", "安全验证状态无效") };
  }
  if (claims.scopes[0] !== bound.binding.scope) {
    return { ok: false, response: securityProofError("SECURITY_PROOF_SCOPE_MISMATCH", "安全验证范围不匹配") };
  }
  if (!timingSafeEqualStr(claims.context_hash, bound.binding.contextHash)) {
    return { ok: false, response: securityProofError("SECURITY_PROOF_CONTEXT_MISMATCH", "Verification does not match this action's details. Please verify again.") };
  }
  const reqs = await verificationRequirements(store, user, bound.binding.scope);
  if (!reqs.ok) return { ok: false, response: apiFailCode(reqs.message, reqs.code, reqs.status) };
  const methods = (reqs.data.methods as { method: string; available: boolean }[]) || [];
  const allowed = methods.find((m) => m.method === claims.method);
  if (!allowed) {
    return { ok: false, response: securityProofError("SECURITY_PROOF_METHOD_MISMATCH", "安全验证方式不匹配") };
  }
  if (!allowed.available) {
    return { ok: false, response: securityProofError("SECURITY_METHOD_UNAVAILABLE", "This verification method is currently unavailable.") };
  }
  const hash = await authFlowTokenHash(secret, claims.jti);
  const consumed = await store.consumeAuthFlow(hash, {
    type: "security_proof",
    user_id: identity.userId,
    session_id: identity.sessionId,
  });
  if (consumed === "consumed") {
    return { ok: false, response: securityProofError("SECURITY_PROOF_CONSUMED", "This verification has already been used. Please verify again.") };
  }
  if (consumed === "expired") {
    return { ok: false, response: securityProofError("SECURITY_PROOF_EXPIRED", "安全验证已过期") };
  }
  if (consumed !== "ok") {
    return { ok: false, response: securityProofError("SECURITY_PROOF_INVALID", "安全验证状态无效") };
  }
  return { ok: true, method: claims.method };
}

export async function requireSecurityProof(
  c: Context<Env>,
  store: Store,
  secret: string,
  identity: AuthIdentity | null,
  user: UserRow | null,
  operation: VerificationOperation,
): Promise<AuthIdentity | Response> {
  if (!identity || !user) {
    return json(401, { success: false, message: "当前认证方式不支持安全验证" });
  }
  const raw = (c.req.headers.get("X-Security-Proof") || "").trim();
  if (!raw) return securityProofError("SECURITY_PROOF_REQUIRED", "需要安全验证");
  const consumed = await consumeOperationProof(store, secret, identity, user, operation, raw);
  if (!consumed.ok) return consumed.response;
  return identity;
}
