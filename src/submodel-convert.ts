/** Original `relay/channel/submodel` ConvertOpenAIRequest / Convert* / GetRequestURL. */

export const SUBMODEL_ENDPOINT_UNSUPPORTED = "submodel channel: endpoint not supported";

export type ConvertSubmodelOpts = {
  upstreamModelName?: string;
};

/** Original Submodel ConvertOpenAIRequest: return `request` as-is (keeps `stream_options`). */
export function convertSubmodelOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertSubmodelOpts = {},
): Record<string, unknown> {
  const out = { ...body };
  if (opts.upstreamModelName) out.model = opts.upstreamModelName;
  return out;
}

/** Original Submodel ConvertClaude/Gemini/Audio/Image/Rerank/Embedding/Responses. */
export function submodelUnsupportedEndpoint(): never {
  throw new Error(SUBMODEL_ENDPOINT_UNSUPPORTED);
}

/** Original `submodel.Adaptor.GetRequestURL`: GetFullRequestURL. */
export function submodelRequestURL(base: string, requestPath: string): string {
  const root = String(base || "").replace(/\/+$/, "");
  const path = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `${root}${path}`;
}
