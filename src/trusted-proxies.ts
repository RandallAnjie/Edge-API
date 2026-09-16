/**
 * Original `common.ResolveTrustedProxies` / gin `Engine.SetTrustedProxies` /
 * `Context.ClientIP` leftover ClientIP for rate-limit keys, audit `ip`, and
 * token allow_ips. Default CIDRs are loopback, RFC 1918, and IPv6 ULA.
 *
 * Extra-OK: workerd has no `Request.RemoteAddr`; `CF-Connecting-IP` is the peer.
 * Extra-OK: non-IP `CF-Connecting-IP` values (test unique keys) stay as ClientIP.
 * Extra-OK: missing peer falls back to informal `X-Real-IP` then leftmost
 * `X-Forwarded-For` so existing allow_ips tests still parse.
 * Extra-OK: invalid `TRUSTED_PROXIES` uses the compatibility defaults instead of
 * original `FatalLog`.
 */
import { carryRequestBodyCleanup } from "./body-storage.js";
import type { Env } from "./types.js";

/** Original `common.defaultTrustedProxyCIDRs`. */
export const DEFAULT_TRUSTED_PROXY_CIDRS = [
  "127.0.0.0/8",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
] as const;

type CIDR = { bytes: Uint8Array; bits: number };

const requestTrustedProxies = new WeakMap<Request, string | undefined>();

/** Bind `TRUSTED_PROXIES` onto the inbound request for later `clientIp` calls. */
export function rememberRequestTrustedProxies(req: Request, env: Pick<Env, "TRUSTED_PROXIES">): void {
  requestTrustedProxies.set(req, env.TRUSTED_PROXIES);
}

/** Copy the bound env onto a reconstructed Request (body limit / decompress / redact). */
export function carryRequestTrustedProxies(from: Request, to: Request): Request {
  if (requestTrustedProxies.has(from)) requestTrustedProxies.set(to, requestTrustedProxies.get(from));
  return carryRequestBodyCleanup(from, to);
}

export type ResolveTrustedProxiesResult = {
  proxies: string[] | null;
  usedDefaults: boolean;
  error: string | null;
};

/**
 * Original `common.ResolveTrustedProxies`.
 * `none` is nil proxies (trust nothing). Blank uses the compatibility defaults.
 */
export function resolveTrustedProxies(raw: string): ResolveTrustedProxiesResult {
  raw = raw.trim();
  if (raw === "") {
    return { proxies: [...DEFAULT_TRUSTED_PROXY_CIDRS], usedDefaults: true, error: null };
  }
  if (raw.toLowerCase() === "none") {
    return { proxies: null, usedDefaults: false, error: null };
  }
  const parts = raw.split(",");
  const trustedProxies: string[] = [];
  for (const part of parts) {
    const trustedProxy = part.trim();
    if (trustedProxy === "") continue;
    if (trustedProxy.toLowerCase() === "none") {
      return { proxies: null, usedDefaults: false, error: "TRUSTED_PROXIES=none must be used alone" };
    }
    trustedProxies.push(trustedProxy);
  }
  if (trustedProxies.length === 0) {
    return { proxies: null, usedDefaults: false, error: "TRUSTED_PROXIES does not contain an IP address or CIDR" };
  }
  return { proxies: trustedProxies, usedDefaults: false, error: null };
}

function parseIPv4Bytes(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (!Number.isInteger(n) || n > 255) return null;
    b[i] = n;
  }
  return b;
}

function parseHexGroup(s: string): number | null {
  if (!s || s.length > 4 || /[^0-9a-fA-F]/.test(s)) return null;
  return Number.parseInt(s, 16);
}

function parseIPv6Bytes(s: string): Uint8Array | null {
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4Bytes(last);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ":" + lo;
  }
  const dbl = s.indexOf("::");
  if (dbl !== -1 && s.indexOf("::", dbl + 1) !== -1) return null;
  let head: string[];
  let tail: string[];
  if (dbl === -1) {
    head = s.split(":");
    tail = [];
  } else {
    head = s.slice(0, dbl).split(":");
    tail = s.slice(dbl + 2).split(":");
  }
  if (head.length === 1 && head[0] === "") head = [];
  if (tail.length === 1 && tail[0] === "") tail = [];
  if (head.length + tail.length > 8) return null;
  const groups = new Array<number>(8).fill(0);
  for (let i = 0; i < head.length; i++) {
    const n = parseHexGroup(head[i]);
    if (n == null) return null;
    groups[i] = n;
  }
  for (let i = 0; i < tail.length; i++) {
    const n = parseHexGroup(tail[i]);
    if (n == null) return null;
    groups[8 - tail.length + i] = n;
  }
  if (dbl === -1 && head.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

/** Original gin `parseIP` (IPv4 as 4 bytes, else 16-byte IPv6). */
export function parseIPBytes(ip: string): Uint8Array | null {
  const s = ip.trim();
  if (!s) return null;
  const v4 = parseIPv4Bytes(s);
  if (v4) return v4;
  const v6 = parseIPv6Bytes(s);
  if (!v6) return null;
  const mapped = to4(v6);
  return mapped ?? v6;
}

function to4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 4) return bytes;
  if (bytes.length !== 16) return null;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.slice(12);
}

function parseOneCIDR(spec: string): CIDR | null {
  const slash = spec.lastIndexOf("/");
  if (slash === -1) {
    const ip = parseIPBytes(spec);
    if (!ip) return null;
    return { bytes: ip, bits: ip.length === 4 ? 32 : 128 };
  }
  const addr = spec.slice(0, slash);
  const bits = Number(spec.slice(slash + 1));
  const ip = parseIPBytes(addr);
  if (!ip || !Number.isInteger(bits) || bits < 0 || bits > ip.length * 8) return null;
  return { bytes: ip, bits };
}

function parseTrustedCIDRs(proxies: string[]): CIDR[] | null {
  const cidrs: CIDR[] = [];
  for (const trustedProxy of proxies) {
    const cidr = parseOneCIDR(trustedProxy);
    if (!cidr) return null;
    cidrs.push(cidr);
  }
  return cidrs;
}

function ipToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  return n;
}

function cidrContains(cidr: CIDR, ip: Uint8Array): boolean {
  if (cidr.bytes.length !== ip.length) return false;
  const width = BigInt(ip.length * 8);
  const bits = BigInt(cidr.bits);
  const mask = bits === 0n ? 0n : ((1n << width) - 1n) ^ ((1n << (width - bits)) - 1n);
  return (ipToBigInt(ip) & mask) === (ipToBigInt(cidr.bytes) & mask);
}

function isTrustedProxy(ip: Uint8Array, cidrs: CIDR[]): boolean {
  for (const cidr of cidrs) {
    if (cidrContains(cidr, ip)) return true;
  }
  return false;
}

function trustedCIDRsFromRaw(raw: string | undefined): CIDR[] {
  const resolved = resolveTrustedProxies(raw ?? "");
  if (resolved.error) return parseTrustedCIDRs([...DEFAULT_TRUSTED_PROXY_CIDRS]) || [];
  if (resolved.proxies == null) return [];
  return parseTrustedCIDRs(resolved.proxies) || parseTrustedCIDRs([...DEFAULT_TRUSTED_PROXY_CIDRS]) || [];
}

/**
 * Original gin `Engine.validateHeader`: walk comma list from the right and
 * return the first untrusted hop (or the leftmost hop). Invalid IP stops the walk.
 */
function validateForwardedHeader(header: string, cidrs: CIDR[]): { ip: string; valid: boolean } {
  if (header === "") return { ip: "", valid: false };
  const items = header.split(",");
  for (let i = items.length - 1; i >= 0; i--) {
    const ipStr = items[i].trim();
    const ip = parseIPBytes(ipStr);
    if (!ip) break;
    if (i === 0 || !isTrustedProxy(ip, cidrs)) return { ip: ipStr, valid: true };
  }
  return { ip: "", valid: false };
}

function informalHeaderFallback(req: Request): string {
  return req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
}

/**
 * Original gin `Context.ClientIP` with Extra-OK `CF-Connecting-IP` as RemoteAddr.
 */
export function ginClientIP(req: Request, env?: Pick<Env, "TRUSTED_PROXIES">): string {
  const raw = env?.TRUSTED_PROXIES ?? requestTrustedProxies.get(req);
  const cidrs = trustedCIDRsFromRaw(raw);
  const remote = (req.headers.get("cf-connecting-ip") || "").trim();
  if (!remote) return informalHeaderFallback(req);
  const parsed = parseIPBytes(remote);
  if (!parsed) return remote;
  if (isTrustedProxy(parsed, cidrs)) {
    for (const headerName of ["x-forwarded-for", "x-real-ip"] as const) {
      const { ip, valid } = validateForwardedHeader(req.headers.get(headerName) || "", cidrs);
      if (valid) return ip;
    }
  }
  return remote;
}
