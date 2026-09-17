/**
 * Original `common.ValidateURLWithFetchSetting` / `service.ValidateSSRFProtectedFetchURL`
 * leftover gin.H used by `relay.RelayMidjourneyImage`.
 * Extra-OK: skip DNS `net.LookupIP` (workerd has no Go resolver).
 */

import { parseJson } from "./constants.js";
import type { Store } from "./store.js";

export type FetchSetting = {
  enableSSRFProtection: boolean;
  allowPrivateIp: boolean;
  domainFilterMode: boolean;
  ipFilterMode: boolean;
  domainList: string[];
  ipList: string[];
  allowedPorts: string[];
  applyIPFilterForDomain: boolean;
};

const PRIVATE_IPV4: { base: number; mask: number }[] = [
  cidr4("0.0.0.0", 8),
  cidr4("10.0.0.0", 8),
  cidr4("100.64.0.0", 10),
  cidr4("127.0.0.0", 8),
  cidr4("169.254.0.0", 16),
  cidr4("172.16.0.0", 12),
  cidr4("192.0.0.0", 24),
  cidr4("192.0.2.0", 24),
  cidr4("192.168.0.0", 16),
  cidr4("198.18.0.0", 15),
  cidr4("198.51.100.0", 24),
  cidr4("203.0.113.0", 24),
  cidr4("224.0.0.0", 4),
  cidr4("240.0.0.0", 4),
  cidr4("255.255.255.255", 32),
];

function cidr4(ip: string, bits: number): { base: number; mask: number } {
  const n = ipv4ToInt(ip) ?? 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: n & mask, mask };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}

function parseIPv4(host: string): number | null {
  return ipv4ToInt(host);
}

/** Original `common.isPrivateIP` IPv4 special-purpose nets plus loopback/unspecified IPv6. */
export function isPrivateIP(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4 != null) {
    for (const net of PRIVATE_IPV4) {
      if ((v4 & net.mask) === net.base) return true;
    }
    return false;
  }
  const ip = host.trim().toLowerCase();
  if (!ip) return true;
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("ff")) return true;
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    return isPrivateIP(mapped);
  }
  return false;
}

/** Original `common.parsePortRanges`. */
export function parsePortRanges(portConfigs: string[]): { ports: number[]; error?: string } {
  const ports: number[] = [];
  for (const raw of portConfigs) {
    const config = String(raw || "").trim();
    if (!config) continue;
    if (config.includes("-")) {
      const parts = config.split("-");
      if (parts.length !== 2) return { ports: [], error: `invalid port range format: ${config}` };
      const startPort = Number(parts[0].trim());
      const endPort = Number(parts[1].trim());
      if (!Number.isInteger(startPort)) return { ports: [], error: `invalid start port in range ${config}: strconv.Atoi: parsing "${parts[0].trim()}": invalid syntax` };
      if (!Number.isInteger(endPort)) return { ports: [], error: `invalid end port in range ${config}: strconv.Atoi: parsing "${parts[1].trim()}": invalid syntax` };
      if (startPort > endPort) return { ports: [], error: `invalid port range ${config}: start port cannot be greater than end port` };
      if (startPort < 1 || startPort > 65535 || endPort < 1 || endPort > 65535) {
        return { ports: [], error: `port range ${config} contains invalid port numbers (must be 1-65535)` };
      }
      for (let port = startPort; port <= endPort; port++) ports.push(port);
      continue;
    }
    const port = Number(config);
    if (!Number.isInteger(port)) return { ports: [], error: `invalid port number: ${config}` };
    if (port < 1 || port > 65535) return { ports: [], error: `invalid port number ${port} (must be 1-65535)` };
    ports.push(port);
  }
  return { ports };
}

function stringList(raw: string, fallback: string[]): string[] {
  const parsed = parseJson<unknown>(raw, fallback);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : fallback;
}

/** Original `system_setting.GetFetchSetting` from nested option keys. */
export async function getFetchSetting(store: Store): Promise<FetchSetting> {
  return {
    enableSSRFProtection: await store.optionBool("fetch_setting.enable_ssrf_protection", true),
    allowPrivateIp: await store.optionBool("fetch_setting.allow_private_ip", false),
    domainFilterMode: await store.optionBool("fetch_setting.domain_filter_mode", false),
    ipFilterMode: await store.optionBool("fetch_setting.ip_filter_mode", false),
    domainList: stringList(await store.option("fetch_setting.domain_list"), []),
    ipList: stringList(await store.option("fetch_setting.ip_list"), []),
    allowedPorts: stringList(await store.option("fetch_setting.allowed_ports"), ["80", "443", "8080", "8443"]),
    applyIPFilterForDomain: await store.optionBool("fetch_setting.apply_ip_filter_for_domain", true),
  };
}

function isDomainListed(domain: string, list: string[]): boolean {
  if (!list.length) return false;
  const host = domain.toLowerCase();
  for (const raw of list) {
    const item = String(raw || "").trim().toLowerCase();
    if (!item) continue;
    if (host === item) return true;
    if (item.startsWith("*.")) {
      const suffix = item.slice(2);
      if (host === suffix || host.endsWith("." + suffix)) return true;
    }
  }
  return false;
}

function ipInCIDRList(ip: string, list: string[]): boolean {
  const v4 = parseIPv4(ip);
  if (v4 == null) return list.some((item) => String(item || "").trim().toLowerCase() === ip.toLowerCase());
  for (const raw of list) {
    const item = String(raw || "").trim();
    if (!item) continue;
    if (item.includes("/")) {
      const [base, bitsRaw] = item.split("/");
      const bits = Number(bitsRaw);
      const baseInt = parseIPv4(base || "");
      if (baseInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((v4 & mask) === (baseInt & mask)) return true;
      continue;
    }
    if (parseIPv4(item) === v4) return true;
  }
  return false;
}

function ipAccessError(host: string, ip: string, allowPrivateIp: boolean, ipFilterMode: boolean): string {
  if (host) {
    if (isPrivateIP(ip) && !allowPrivateIp) return `private IP address not allowed: ${host} resolves to ${ip}`;
    if (ipFilterMode) return `ip not in whitelist: ${host} resolves to ${ip}`;
    return `ip in blacklist: ${host} resolves to ${ip}`;
  }
  if (isPrivateIP(ip) && !allowPrivateIp) return `private IP address not allowed: ${ip}`;
  if (ipFilterMode) return `ip not in whitelist: ${ip}`;
  return `ip in blacklist: ${ip}`;
}

function isIPAccessAllowed(ip: string, setting: FetchSetting): boolean {
  if (isPrivateIP(ip) && !setting.allowPrivateIp) return false;
  const listed = ipInCIDRList(ip, setting.ipList);
  return setting.ipFilterMode ? listed : !listed;
}

/** Original `SSRFProtection.ValidateNetworkTarget`. */
export function validateNetworkTarget(host: string, port: number, setting: FetchSetting, allowedPorts: number[]): string | null {
  const trimmed = host.trim();
  if (!trimmed) return "invalid host";
  if (port < 1 || port > 65535) return `invalid port: ${port}`;
  if (allowedPorts.length && !allowedPorts.includes(port)) return `port ${port} is not allowed`;
  if (parseIPv4(trimmed) != null || trimmed.includes(":")) {
    if (!isIPAccessAllowed(trimmed, setting)) return ipAccessError("", trimmed, setting.allowPrivateIp, setting.ipFilterMode);
    return null;
  }
  const listed = isDomainListed(trimmed, setting.domainList);
  const allowed = setting.domainFilterMode ? listed : !listed;
  if (!allowed) {
    return setting.domainFilterMode ? `domain not in whitelist: ${trimmed}` : `domain in blacklist: ${trimmed}`;
  }
  return null;
}

/**
 * Original `common.ValidateURLWithFetchSetting`.
 * Extra-OK: skip DNS `net.LookupIP` even when `applyIPFilterForDomain` is true.
 */
export function validateURLWithFetchSetting(urlStr: string, setting: FetchSetting, applyIPFilterForDomain: boolean): string | null {
  void applyIPFilterForDomain;
  if (!setting.enableSSRFProtection) return null;
  const parsedPorts = parsePortRanges(setting.allowedPorts);
  if (parsedPorts.error) return `request reject - invalid port configuration: ${parsedPorts.error}`;
  const trimmed = String(urlStr || "");
  let url: URL;
  try {
    if (!trimmed) return "unsupported protocol:  (only http/https allowed)";
    url = new URL(trimmed);
  } catch (err) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return "unsupported protocol:  (only http/https allowed)";
    return `invalid URL format: ${err instanceof Error ? err.message : String(err)}`;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return `unsupported protocol: ${scheme} (only http/https allowed)`;
  }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : scheme === "https" ? 443 : 80;
  if (url.port && !Number.isInteger(port)) return `invalid port: ${url.port}`;
  return validateNetworkTarget(host, port, setting, parsedPorts.ports);
}

/** Original `service.ValidateSSRFProtectedFetchURL` (`applyIPFilterForDomain` true). */
export function validateSSRFProtectedFetchURL(urlStr: string, setting: FetchSetting): string | null {
  return validateURLWithFetchSetting(urlStr, setting, true);
}

export async function validateSSRFProtectedFetchURLFromStore(store: Store, urlStr: string): Promise<string | null> {
  return validateSSRFProtectedFetchURL(urlStr, await getFetchSetting(store));
}

export async function validateURLWithFetchSettingFromStore(
  store: Store,
  urlStr: string,
  applyIPFilterForDomain?: boolean,
): Promise<string | null> {
  const setting = await getFetchSetting(store);
  return validateURLWithFetchSetting(urlStr, setting, applyIPFilterForDomain ?? setting.applyIPFilterForDomain);
}
