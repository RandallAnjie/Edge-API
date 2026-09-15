/**
 * Original `common.ValidateRedirectURL` and `TRUSTED_REDIRECT_DOMAINS` parsing
 * (`common.init` + `constant.TrustedRedirectDomains`).
 */

/** Original `strings.Split` + trim + lower on `TRUSTED_REDIRECT_DOMAINS`. */
export function parseTrustedRedirectDomains(raw: string | undefined | null): string[] {
  const domains: string[] = [];
  for (const part of String(raw || "").split(",")) {
    const trimmed = part.trim();
    if (trimmed) domains.push(trimmed.toLowerCase());
  }
  return domains;
}

/**
 * Original `common.ValidateRedirectURL`. Empty trusted list rejects every URL.
 * Go `url.Parse("")` succeeds with an empty scheme (not a parse error).
 */
export function validateRedirectURL(rawURL: string, trustedDomains: string[]): Error | null {
  if (rawURL === "") {
    return new Error("invalid URL scheme: only http and https are allowed");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return new Error(`invalid URL format: ${detail}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") {
    return new Error("invalid URL scheme: only http and https are allowed");
  }
  const domain = parsed.hostname.toLowerCase();
  for (const trusted of trustedDomains) {
    if (domain === trusted || domain.endsWith("." + trusted)) return null;
  }
  return new Error(`domain ${domain} is not in the trusted domains list`);
}
