/** Original `relay/channel/newapi` (and embedding `sub2api`) ConvertOpenAIRequest / GetRequestURL / SetupRequestHeader. */

export const NEWAPI_ENDPOINT_UNSUPPORTED = "endpoint not supported";

export type ConvertNewApiOpts = {
  upstreamModelName?: string;
};

export type NewApiRelayFormat = "openai" | "claude" | "gemini";

/** Original NewAPI/Sub2API ConvertOpenAIRequest: return `request` as-is (keeps `stream_options`). */
export function convertNewApiOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertNewApiOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

/** Original NewAPI ConvertOpenAIResponsesRequest / ConvertEmbeddingRequest: return request as-is. */
export function convertNewApiResponsesRequest(
  body: Record<string, unknown>,
  opts: ConvertNewApiOpts = {},
): Record<string, unknown> {
  return convertNewApiOpenAIRequest(body, opts);
}

export function newApiUnsupportedEndpoint(): never {
  throw new Error(NEWAPI_ENDPOINT_UNSUPPORTED);
}

/** Original `newapi.Adaptor.GetRequestURL`: alpha search `/v1/alpha/search`, else GetFullRequestURL of the request path. */
export function newApiRequestURL(base: string, mode: string, requestPath: string): string {
  const root = String(base || "").replace(/\/+$/, "");
  if (mode === "alpha_search") return `${root}/v1/alpha/search`;
  const path = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `${root}${path}`;
}

/** Original `newapi.Adaptor.SetupRequestHeader`: Bearer always; Claude also `x-api-key` + `anthropic-version`; Gemini also `x-goog-api-key`. */
export function applyNewApiHeaders(
  headers: Record<string, string>,
  apiKey: string,
  format: NewApiRelayFormat = "openai",
  incomingAnthropicVersion = "",
): void {
  headers.authorization = `Bearer ${apiKey}`;
  if (format === "claude") {
    headers["x-api-key"] = apiKey;
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = incomingAnthropicVersion || "2023-06-01";
    }
  } else if (format === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  }
}
