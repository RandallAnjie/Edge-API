/** Original `relay/channel/baidu_v2` ConvertOpenAIRequest / GetRequestURL / SetupRequestHeader. */

export type ConvertBaiduV2Opts = {
  upstreamModelName?: string;
};

/** Original `baidu_v2.Adaptor.GetRequestURL`. */
export function baiduV2RequestURL(base: string, mode: string, requestPath = ""): string {
  const root = base.replace(/\/+$/, "");
  if (mode === "chat") return `${root}/v2/chat/completions`;
  if (mode === "embeddings") return `${root}/v2/embeddings`;
  if (mode === "images") {
    if (requestPath.includes("/edits")) return `${root}/v2/images/edits`;
    return `${root}/v2/images/generations`;
  }
  if (mode === "rerank") return `${root}/v2/rerank`;
  throw new Error(`unsupported relay mode: ${mode}`);
}

/** Original `baidu_v2.Adaptor.SetupRequestHeader`. Key is `token|appid`. */
export function applyBaiduV2Auth(headers: Record<string, string>, apiKey: string): void {
  const keyParts = apiKey.split("|");
  if (!keyParts.length || !keyParts[0]) {
    throw new Error("invalid API key: authorization token is required");
  }
  if (keyParts.length > 1 && keyParts[1]) headers.appid = keyParts[1];
  headers.authorization = `Bearer ${keyParts[0]}`;
}

function hasWebSearch(body: Record<string, unknown>): boolean {
  const raw = body.web_search;
  if (raw == null) return false;
  if (typeof raw === "string") return raw.length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "object") return Object.keys(raw as object).length > 0;
  return true;
}

/** Original `baidu_v2.Adaptor.ConvertOpenAIRequest`. `-search` is stripped here, not by ApplyReasoningModelSuffix. */
export function convertBaiduV2OpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertBaiduV2Opts = {},
): Record<string, unknown> {
  let upstream = opts.upstreamModelName || String(body.model || "");
  if (upstream.endsWith("-search")) {
    upstream = upstream.slice(0, -"-search".length);
    const out: Record<string, unknown> = { ...body, model: upstream };
    if (!hasWebSearch(body)) {
      out.web_search = {
        enable: true,
        enable_citation: true,
        enable_trace: true,
        enable_status: false,
      };
    }
    return out;
  }
  return { ...body, model: upstream };
}
