/**
 * Original `golang.org/x/net/publicsuffix` PublicSuffix / EffectiveTLDPlusOne
 * (v0.55.0, PSL git d6c92f1) used by `system_setting.NormalizePasskeyRPID`.
 */

import { PASSKEY_PSL_NUM_ICANN, PASSKEY_PSL_RULES } from "./passkey-psl-data.js";

type PslRule = { parts: string[]; icann: boolean };

const rulesByLast = new Map<string, PslRule[]>();

function lastLabel(parts: string[]): string {
  const last = parts[parts.length - 1] || "";
  return last.startsWith("!") ? last.slice(1) : last;
}

function indexRules(): void {
  if (rulesByLast.size) return;
  const lines = PASSKEY_PSL_RULES.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rule = lines[i];
    if (!rule) continue;
    const parts = rule.split(".");
    const last = lastLabel(parts);
    const list = rulesByLast.get(last);
    const entry: PslRule = { parts, icann: i < PASSKEY_PSL_NUM_ICANN };
    if (list) list.push(entry);
    else rulesByLast.set(last, [entry]);
  }
}

function ruleMatches(ruleParts: string[], domainParts: string[]): boolean {
  if (domainParts.length < ruleParts.length) return false;
  for (let i = 0; i < ruleParts.length; i++) {
    const rulePart = ruleParts[ruleParts.length - 1 - i];
    const domainPart = domainParts[domainParts.length - 1 - i];
    const head = rulePart.charCodeAt(0);
    if (head === 42) continue;
    if (head === 33) {
      if (rulePart.slice(1) !== domainPart) return false;
      continue;
    }
    if (rulePart !== domainPart) return false;
  }
  return true;
}

function betterRule(a: PslRule, b: PslRule): boolean {
  const aEx = a.parts[0]?.charCodeAt(0) === 33;
  const bEx = b.parts[0]?.charCodeAt(0) === 33;
  if (aEx !== bEx) return aEx;
  return a.parts.length > b.parts.length;
}

function isIPLiteral(domain: string): boolean {
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(domain)) {
    return domain.split(".").every((p) => Number(p) <= 255);
  }
  return domain.includes(":") && /^[0-9a-fA-F:.]+$/.test(domain);
}

/** Original `publicsuffix.PublicSuffix`. */
export function publicSuffix(domain: string): { suffix: string; icann: boolean } {
  indexRules();
  if (isIPLiteral(domain)) return { suffix: domain, icann: false };
  const domainParts = domain.split(".");
  const last = domainParts[domainParts.length - 1] || "";
  let prevailing: PslRule | undefined;
  for (const rule of rulesByLast.get(last) || []) {
    if (!ruleMatches(rule.parts, domainParts)) continue;
    if (!prevailing || betterRule(rule, prevailing)) prevailing = rule;
  }
  if (!prevailing) {
    return { suffix: domainParts[domainParts.length - 1] || domain, icann: false };
  }
  let parts = prevailing.parts.slice();
  if (parts[0]?.charCodeAt(0) === 33) parts = parts.slice(1);
  if (parts[0]?.charCodeAt(0) === 42) {
    const replaced = domainParts[domainParts.length - parts.length] || "";
    parts = [replaced, ...parts.slice(1)];
  }
  return { suffix: parts.join("."), icann: prevailing.icann };
}

/** Original `publicsuffix.EffectiveTLDPlusOne`. */
export function effectiveTLDPlusOne(domain: string): string | null {
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  const { suffix } = publicSuffix(domain);
  if (domain.length <= suffix.length) return null;
  const i = domain.length - suffix.length - 1;
  if (domain.charCodeAt(i) !== 46) return null;
  const prev = domain.lastIndexOf(".", i - 1);
  return domain.slice(prev + 1);
}
