/**
 * Original `InjectUmamiAnalytics` / `InjectGoogleAnalytics` leftover on
 * `indexPage`, plus `embedFileSystem.Open("/")` ErrNotExist so `/` uses
 * the injected IndexPage instead of static `index.html`.
 * Placeholders are `bytes.ReplaceAll`'d at startup in the original; the
 * worker applies the same replacements when serving IndexPage.
 * Original NoRoute last handler does not check method (`c.Data` IndexPage).
 */
import type { Env } from "./types.js";

/** Original `<!--umami-->\n` placeholder in `web/dist/index.html`. */
export const UMAMI_PLACEHOLDER = "<!--umami-->\n";
/** Original comment written after optional Umami script. */
export const UMAMI_QUANTUMNOUS_COMMENT = "<!--Umami QuantumNous-->\n";
/** Original `<!--Google Analytics-->\n` placeholder. */
export const GOOGLE_ANALYTICS_PLACEHOLDER = "<!--Google Analytics-->\n";
/** Original comment written after optional gtag scripts. */
export const GOOGLE_ANALYTICS_QUANTUMNOUS_COMMENT = "<!--Google Analytics QuantumNous-->\n";
/** Original default when `UMAMI_SCRIPT_URL` is empty. */
export const DEFAULT_UMAMI_SCRIPT_URL = "https://analytics.umami.is/script.js";
/** Original gin `c.Data` content type for IndexPage. */
export const INDEX_PAGE_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * Original `embedFileSystem.Exists`: `Open("/")` returns `os.ErrNotExist` so
 * `/` skips `static.Serve` and the NoRoute handler serves IndexPage.
 */
export function embedFolderExists(path: string): boolean {
  return path !== "/";
}

/** Original `InjectUmamiAnalytics` `bytes.ReplaceAll` on `indexPage`. */
export function injectUmamiAnalytics(
  indexPage: string,
  env: Pick<Env, "UMAMI_WEBSITE_ID" | "UMAMI_SCRIPT_URL">,
): string {
  let inject = "";
  const siteId = String(env.UMAMI_WEBSITE_ID ?? "");
  if (siteId !== "") {
    let scriptURL = String(env.UMAMI_SCRIPT_URL ?? "");
    if (scriptURL === "") scriptURL = DEFAULT_UMAMI_SCRIPT_URL;
    inject += `<script defer src="${scriptURL}" data-website-id="${siteId}"></script>`;
  }
  inject += UMAMI_QUANTUMNOUS_COMMENT;
  return indexPage.replaceAll(UMAMI_PLACEHOLDER, inject);
}

/** Original `InjectGoogleAnalytics` `bytes.ReplaceAll` on `indexPage`. */
export function injectGoogleAnalytics(indexPage: string, env: Pick<Env, "GOOGLE_ANALYTICS_ID">): string {
  let inject = "";
  const gaID = String(env.GOOGLE_ANALYTICS_ID ?? "");
  if (gaID !== "") {
    inject += `<script async src="https://www.googletagmanager.com/gtag/js?id=${gaID}"></script>`;
    inject += `<script>`;
    inject += `window.dataLayer = window.dataLayer || [];`;
    inject += `function gtag(){dataLayer.push(arguments);}`;
    inject += `gtag('js', new Date());`;
    inject += `gtag('config', '${gaID}');`;
    inject += `</script>`;
  }
  inject += GOOGLE_ANALYTICS_QUANTUMNOUS_COMMENT;
  return indexPage.replaceAll(GOOGLE_ANALYTICS_PLACEHOLDER, inject);
}

/** Original startup order: Umami then Google Analytics. */
export function injectIndexAnalytics(
  indexPage: string,
  env: Pick<Env, "UMAMI_WEBSITE_ID" | "UMAMI_SCRIPT_URL" | "GOOGLE_ANALYTICS_ID">,
): string {
  return injectGoogleAnalytics(injectUmamiAnalytics(indexPage, env), env);
}

/**
 * Original NoRoute last handler reads in-memory `assets.IndexPage` for any
 * method. Worker always GET `/index.html` so HEAD/POST do not depend on ASSETS
 * method support. Extra-OK: OPTIONS 204 still runs first and never reaches here.
 */
export function noRouteIndexPageAssetRequest(req: Request): Request {
  return new Request(new URL("/index.html", req.url));
}

/**
 * Original NoRoute `c.Data(http.StatusOK, "text/html; charset=utf-8", IndexPage)`
 * after startup inject, for any method. Static `/index.html` is not rewritten.
 */
export async function withIndexAnalytics(
  res: Response,
  env: Pick<Env, "UMAMI_WEBSITE_ID" | "UMAMI_SCRIPT_URL" | "GOOGLE_ANALYTICS_ID">,
): Promise<Response> {
  if (res.status !== 200) return res;
  if (res.headers.get("Content-Encoding")) return res;
  const injected = injectIndexAnalytics(await res.text(), env);
  const headers = new Headers(res.headers);
  headers.set("Content-Type", INDEX_PAGE_CONTENT_TYPE);
  headers.delete("content-length");
  return new Response(injected, { status: res.status, statusText: res.statusText, headers });
}
