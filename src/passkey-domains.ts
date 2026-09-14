/** Original `model.UpdatePasskeyDomainOptions` + `system_setting` RP ID helpers. */

import { hmacSha256Hex, timingSafeEqualStr } from "./crypto.js";
import { apiFail, apiFailCode, i18nPair, json } from "./http.js";
import { effectiveTLDPlusOne, publicSuffix } from "./passkey-publicsuffix.js";
import type { Store } from "./store.js";

export const ERR_PASSKEY_RPID_INVALID = "Invalid Passkey domain. Enter a domain without a scheme, port, path or wildcard.";
export const ERR_PASSKEY_RPID_UNAVAILABLE = "This Passkey domain is not available on this website. Use its original website or another verification method.";
export const ERR_PASSKEY_DOMAIN_REMOVAL =
  "Review the affected Passkeys and confirm the domain removal. If the settings or impact have changed, confirmation is required again.";

export type PasskeyDomainChange = {
  rp_id: string;
  legacy_rp_ids: string;
  origins: string;
  previous_rp_id: string;
  effective_rp_id: string;
  removed_rp_ids: string[];
  affected_credentials: number;
  unknown_credentials: number;
  confirmation_required: boolean;
  removal_confirmation: string;
};

export class PasskeyDomainError extends Error {
  status: number;
  code?: string;
  change?: PasskeyDomainChange;
  constructor(message: string, opts: { status?: number; code?: string; change?: PasskeyDomainChange } = {}) {
    super(message);
    this.status = opts.status ?? 200;
    this.code = opts.code;
    this.change = opts.change;
  }
}

export function isPasskeyDomainOption(key: string): boolean {
  return key === "passkey.rp_id" || key === "passkey.legacy_rp_ids" || key === "passkey.origins" || key === "ServerAddress";
}

function splitList(value: string): string[] {
  const ids: string[] = [];
  for (const part of value.split(/[,\n\r]/)) {
    const item = part.trim();
    if (item && !ids.includes(item)) ids.push(item);
  }
  return ids;
}

function parseHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.host || "";
  } catch {
    return trimmed;
  }
}

function splitHostPort(host: string): string {
  if (host.startsWith("[") && host.includes("]")) {
    const end = host.indexOf("]");
    return host.slice(1, end);
  }
  const colon = host.lastIndexOf(":");
  if (colon > 0 && host.indexOf(":") === colon) return host.slice(0, colon);
  return host;
}

export type PasskeySettings = {
  rp_id: string;
  legacy_rp_ids: string;
  origins: string;
};

export function withPasskeyDefaults(settings: PasskeySettings, serverAddress: string): PasskeySettings {
  const next = { ...settings };
  if (!next.rp_id && serverAddress) {
    const host = parseHost(serverAddress);
    next.rp_id = host || serverAddress.trim();
  }
  if (!next.origins || next.origins === "[]") next.origins = serverAddress;
  return next;
}

export function effectivePasskeyRPID(settings: PasskeySettings): string {
  let rpID = settings.rp_id.trim();
  if (!rpID) {
    for (const origin of settings.origins.split(",")) {
      const host = parseHost(origin);
      if (host) {
        rpID = host;
        break;
      }
    }
  }
  return splitHostPort(rpID);
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

function isIPv6(value: string): boolean {
  return value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value);
}

/**
 * Original `idna.Lookup.ToASCII` (UTS #46 lookup: MapForLookup, STD3, CheckHyphens).
 * WHATWG hostname processing covers Unicode mapping; ASCII CheckHyphens is explicit
 * because browsers accept labels such as `ab--cd`.
 */
function idnaLookupToASCII(value: string): { ascii: string; error: boolean } {
  if (!value) return { ascii: "", error: true };
  try {
    let mapped = value;
    if (!/^[\x00-\x7F]*$/.test(value)) {
      if (/[:/?#@\\[\]]/.test(value)) return { ascii: value, error: true };
      const parsed = new URL(`https://${value}`);
      if (parsed.username || parsed.password || parsed.port) return { ascii: value, error: true };
      if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
        return { ascii: value, error: true };
      }
      mapped = parsed.hostname;
    }
    for (const label of mapped.split(".")) {
      if (label.length >= 4 && label[2] === "-" && label[3] === "-" && !label.toLowerCase().startsWith("xn--")) {
        return { ascii: mapped, error: true };
      }
      if (label.toLowerCase().startsWith("xn--")) {
        try {
          const host = new URL(`https://${label}.invalid`).hostname;
          if (!host.endsWith(".invalid")) return { ascii: mapped, error: true };
        } catch {
          return { ascii: mapped, error: true };
        }
      }
    }
    return { ascii: mapped, error: false };
  } catch {
    return { ascii: value, error: true };
  }
}

/** Original `system_setting.NormalizePasskeyRPID`. */
export function normalizePasskeyRPID(value: string, configuredOrigins: string[] = []): string {
  const { ascii, error } = idnaLookupToASCII(value.trim());
  const rpID = ascii.toLowerCase();
  if (error || !rpID || rpID.length > 253 || /[:/*@?#\\]/.test(rpID) || isIPv4(rpID) || isIPv6(rpID)) {
    throw new PasskeyDomainError(ERR_PASSKEY_RPID_INVALID, { code: "PASSKEY_RP_ID_INVALID" });
  }
  for (const label of rpID.split(".")) {
    if (!label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      throw new PasskeyDomainError(ERR_PASSKEY_RPID_INVALID, { code: "PASSKEY_RP_ID_INVALID" });
    }
    for (const c of label) {
      if (c !== "-" && (c < "a" || c > "z") && (c < "0" || c > "9")) {
        throw new PasskeyDomainError(ERR_PASSKEY_RPID_INVALID, { code: "PASSKEY_RP_ID_INVALID" });
      }
    }
  }
  if (rpID === "localhost") return rpID;
  if (effectiveTLDPlusOne(rpID)) return rpID;
  const { icann } = publicSuffix(rpID);
  if (icann || rpID.includes(".")) {
    throw new PasskeyDomainError(ERR_PASSKEY_RPID_INVALID, { code: "PASSKEY_RP_ID_INVALID" });
  }
  for (const origins of configuredOrigins) {
    for (const origin of origins.split(",")) {
      const trimmed = origin.trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "https:") continue;
        if (parsed.username || parsed.password) continue;
        if (parsed.pathname && parsed.pathname !== "/") continue;
        if (parsed.search || parsed.hash) continue;
        if (parsed.hostname.toLowerCase() === rpID) return rpID;
      } catch {
        /* skip */
      }
    }
  }
  throw new PasskeyDomainError(ERR_PASSKEY_RPID_INVALID, { code: "PASSKEY_RP_ID_INVALID" });
}

export function parsePasskeyRPIDs(value: string, configuredOrigins: string[] = []): string[] {
  const ids: string[] = [];
  for (const part of value.split(/[,\n\r]/)) {
    if (!part.trim()) continue;
    normalizePasskeyRPID(part, configuredOrigins);
    const id = part.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function relyingPartyIDs(settings: PasskeySettings): string[] {
  const ids: string[] = [];
  const primary = effectivePasskeyRPID(settings);
  if (primary) ids.push(primary);
  try {
    for (const id of parsePasskeyRPIDs(settings.legacy_rp_ids, [settings.origins])) {
      if (!ids.includes(id)) ids.push(id);
    }
  } catch {
    return ids;
  }
  return ids;
}

/** Original `system_setting.PasskeySettingsSnapshot`. */
export async function passkeySettingsSnapshot(store: Store): Promise<PasskeySettings> {
  return withPasskeyDefaults(
    {
      rp_id: await store.option("passkey.rp_id"),
      legacy_rp_ids: await store.option("passkey.legacy_rp_ids"),
      origins: await store.option("passkey.origins"),
    },
    await store.option("ServerAddress"),
  );
}

export type PasskeyBeginSelection = { rpId: string; rp_ids: string[] };

/**
 * Original `service/passkey.BuildLoginWebAuthn` RP ID selection.
 * When no configured IDs exist, fall back to the request hostname so an
 * unconfigured site can still start a ceremony (original auto-detects Origin).
 */
export function selectPasskeyBeginRpIDs(
  settings: PasskeySettings,
  hint: string,
  requestRpId: string,
  credentialRpId = "",
): PasskeyBeginSelection {
  const requestHost = splitHostPort(requestRpId);
  const primary = effectivePasskeyRPID(settings) || requestHost;
  const configured: string[] = [];
  for (const id of [primary, ...relyingPartyIDs(settings)]) {
    if (id && !configured.includes(id)) configured.push(id);
  }
  const available = configured.length ? configured : requestHost ? [requestHost] : [];
  const filtered = credentialRpId ? available.filter((id) => id === credentialRpId) : available;
  if (!filtered.length) {
    throw new PasskeyDomainError(ERR_PASSKEY_RPID_UNAVAILABLE, { code: "PASSKEY_RP_ID_UNAVAILABLE" });
  }
  let selected = credentialRpId || hint;
  if (!selected) selected = filtered[0];
  if (!filtered.includes(selected)) {
    throw new PasskeyDomainError(ERR_PASSKEY_RPID_UNAVAILABLE, { code: "PASSKEY_RP_ID_UNAVAILABLE" });
  }
  return { rpId: selected, rp_ids: filtered };
}

async function removalConfirmation(
  sessionSecret: string,
  before: [string, string, string, string],
  after: [string, string, string, string],
  removed: string[],
  known: number,
  unknown: number,
): Promise<string> {
  const payload = JSON.stringify({
    Before: before,
    After: after,
    Removed: removed,
    Known: known,
    Unknown: unknown,
  });
  return hmacSha256Hex(`passkey-domains-v1:${sessionSecret}`, payload);
}

/** Original `controller.writePasskeyDomainSettingsError`. */
export function passkeyDomainHttpError(err: unknown, req: Request): Response {
  if (err instanceof PasskeyDomainError) {
    if (err.code === "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED") {
      return json(409, {
        success: false,
        code: err.code,
        message: i18nPair(
          req,
          "请核对受影响的通行密钥并确认删除域名。配置或影响范围发生变化后，需要重新确认。",
          ERR_PASSKEY_DOMAIN_REMOVAL,
        ),
        data: err.change,
      });
    }
    if (err.code === "PASSKEY_RP_ID_INVALID") {
      return apiFailCode(
        i18nPair(req, "通行密钥域名无效。请填写域名，不包含协议、端口、路径或通配符。", ERR_PASSKEY_RPID_INVALID),
        "PASSKEY_RP_ID_INVALID",
      );
    }
    if (err.code === "PASSKEY_RP_ID_UNAVAILABLE") {
      return apiFailCode(
        i18nPair(
          req,
          "此通行密钥域名无法在当前网站使用。请前往原网站或选择其他验证方式。",
          ERR_PASSKEY_RPID_UNAVAILABLE,
        ),
        "PASSKEY_RP_ID_UNAVAILABLE",
      );
    }
    return apiFail(err.message);
  }
  return apiFail(err instanceof Error ? err.message : String(err));
}

export async function updatePasskeyDomainOptions(
  store: Store,
  sessionSecret: string,
  values: Record<string, string>,
  preview: boolean,
  confirmation: string,
): Promise<PasskeyDomainChange> {
  const serverAddress = (values.ServerAddress !== undefined ? values.ServerAddress : await store.option("ServerAddress")) || "";
  const settings: PasskeySettings = {
    rp_id: await store.option("passkey.rp_id"),
    legacy_rp_ids: await store.option("passkey.legacy_rp_ids"),
    origins: await store.option("passkey.origins"),
  };
  const previous = withPasskeyDefaults(settings, serverAddress);
  const before: [string, string, string, string] = [serverAddress, settings.rp_id, settings.legacy_rp_ids, settings.origins];
  let nextServer = serverAddress;
  if (values.ServerAddress !== undefined) nextServer = values.ServerAddress;

  if (values["passkey.origins"] !== undefined) {
    settings.origins = splitList(values["passkey.origins"]).join(",");
  } else if (before[0] !== nextServer && (!settings.origins || settings.origins === "[]")) {
    const origins: string[] = [];
    for (const origin of [previous.origins, withPasskeyDefaults(settings, nextServer).origins]) {
      if (origin && !origins.includes(origin)) origins.push(origin);
    }
    settings.origins = origins.join(",");
  }

  if (values["passkey.rp_id"] !== undefined) {
    settings.rp_id = values["passkey.rp_id"].trim();
    if (settings.rp_id) {
      settings.rp_id = normalizePasskeyRPID(settings.rp_id, [withPasskeyDefaults(settings, nextServer).origins]);
    }
  }
  if (values["passkey.legacy_rp_ids"] !== undefined) {
    settings.legacy_rp_ids = values["passkey.legacy_rp_ids"];
  }

  const effective = withPasskeyDefaults(settings, nextServer);
  let legacy = parsePasskeyRPIDs(settings.legacy_rp_ids, [effective.origins]);
  const oldRPID = effectivePasskeyRPID(previous);
  const nextRPID = effectivePasskeyRPID(effective);
  let previousDomainError = false;
  try {
    normalizePasskeyRPID(oldRPID, [previous.origins]);
  } catch {
    previousDomainError = true;
  }
  if (!previousDomainError && oldRPID && oldRPID !== nextRPID && !legacy.includes(oldRPID)) {
    legacy = [...legacy, oldRPID];
  }
  settings.legacy_rp_ids = legacy.join(",");
  parsePasskeyRPIDs(settings.legacy_rp_ids, [effective.origins]);
  if (settings.rp_id) normalizePasskeyRPID(nextRPID, [effective.origins]);

  const change: PasskeyDomainChange = {
    rp_id: settings.rp_id,
    legacy_rp_ids: settings.legacy_rp_ids,
    origins: settings.origins,
    previous_rp_id: oldRPID,
    effective_rp_id: nextRPID,
    removed_rp_ids: [],
    affected_credentials: 0,
    unknown_credentials: 0,
    confirmation_required: false,
    removal_confirmation: "",
  };
  const nextIDs = relyingPartyIDs(withPasskeyDefaults(settings, nextServer));
  for (const id of relyingPartyIDs(previous)) {
    if (!nextIDs.includes(id)) change.removed_rp_ids.push(id);
  }
  if (change.removed_rp_ids.length) {
    const counts = await store.countPasskeysByRemovedRpIds(change.removed_rp_ids);
    change.affected_credentials = counts.affected;
    change.unknown_credentials = counts.unknown;
  }
  change.confirmation_required = change.affected_credentials > 0 || change.unknown_credentials > 0;
  change.removal_confirmation = await removalConfirmation(
    sessionSecret,
    before,
    [nextServer, settings.rp_id, settings.legacy_rp_ids, settings.origins],
    change.removed_rp_ids,
    change.affected_credentials,
    change.unknown_credentials,
  );
  if (preview) return change;
  if ((change.confirmation_required || confirmation) && !timingSafeEqualStr(confirmation, change.removal_confirmation)) {
    throw new PasskeyDomainError(ERR_PASSKEY_DOMAIN_REMOVAL, {
      status: 409,
      code: "PASSKEY_RP_ID_REMOVAL_CONFIRMATION_REQUIRED",
      change,
    });
  }
  await store.setOption("passkey.rp_id", settings.rp_id);
  await store.setOption("passkey.legacy_rp_ids", settings.legacy_rp_ids);
  await store.setOption("passkey.origins", settings.origins);
  if (values.ServerAddress !== undefined) await store.setOption("ServerAddress", nextServer);
  for (const [key, value] of Object.entries(values)) {
    if (!isPasskeyDomainOption(key)) await store.setOption(key, value);
  }
  return change;
}
