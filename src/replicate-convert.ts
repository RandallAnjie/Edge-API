/** Original `relay/channel/replicate` ConvertOpenAIRequest / ConvertImageRequest / GetRequestURL / DoResponse. */

export const REPLICATE_DEFAULT_MODEL = "black-forest-labs/flux-1.1-pro";
export const REPLICATE_CHAT_NOT_IMPLEMENTED = "replicate adaptor: ConvertOpenAIRequest is not implemented";

export type ConvertReplicateOpts = {
  upstreamModelName?: string;
};

function extraObject(body: Record<string, unknown>): Record<string, unknown> {
  const extra = body.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) return extra as Record<string, unknown>;
  return {};
}

function extraFieldsObject(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.extra_fields;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function reduceRatio(w: number, h: number): [number, number] {
  const g = gcd(w, h);
  if (!g) return [w, h];
  return [w / g, h / g];
}

function normalizeFluxDimension(value: number): number {
  const minDim = 256;
  const maxDim = 1440;
  const step = 32;
  let next = value;
  if (next < minDim) next = minDim;
  if (next > maxDim) next = maxDim;
  const remainder = next % step;
  if (remainder !== 0) {
    if (remainder >= step / 2) next += step - remainder;
    else next -= remainder;
  }
  if (next < minDim) next = minDim;
  if (next > maxDim) next = maxDim;
  return next;
}

/** Original `mapOpenAISizeToFlux`. */
export function mapOpenAISizeToFlux(size: string): { aspect: string; width: number; height: number } | null {
  const parts = String(size).split("x");
  if (parts.length !== 2) return null;
  const w = Number.parseInt(parts[0].trim(), 10);
  const h = Number.parseInt(parts[1].trim(), 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (w === h) return { aspect: "1:1", width: 0, height: 0 };
  if (w === 1792 && h === 1024) return { aspect: "16:9", width: 0, height: 0 };
  if (w === 1024 && h === 1792) return { aspect: "9:16", width: 0, height: 0 };
  if (w === 1536 && h === 1024) return { aspect: "3:2", width: 0, height: 0 };
  if (w === 1024 && h === 1536) return { aspect: "2:3", width: 0, height: 0 };
  const [rw, rh] = reduceRatio(w, h);
  const ratioStr = `${rw}:${rh}`;
  switch (ratioStr) {
    case "1:1":
    case "16:9":
    case "9:16":
    case "3:2":
    case "2:3":
    case "4:5":
    case "5:4":
    case "3:4":
    case "4:3":
      return { aspect: ratioStr, width: 0, height: 0 };
    default:
      return { aspect: "custom", width: normalizeFluxDimension(w), height: normalizeFluxDimension(h) };
  }
}

/** Original `replicate.Adaptor.GetRequestURL` after ConvertImageRequest sets `/v1/models/{model}/predictions`. */
export function replicateRequestURL(base: string, modelName: string, requestPath = ""): string {
  const root = String(base || "").replace(/\/+$/, "");
  if (modelName) return `${root}/v1/models/${modelName}/predictions`;
  const path = requestPath.startsWith("/") ? requestPath : requestPath ? `/${requestPath}` : "";
  return path ? `${root}${path}` : root;
}

/** Original Replicate ConvertOpenAIRequest is not implemented. */
export function convertReplicateOpenAIRequest(): never {
  throw new Error(REPLICATE_CHAT_NOT_IMPLEMENTED);
}

/** Original `replicate.Adaptor.ConvertImageRequest` → `{ input: {...} }`. */
export function convertReplicateImageRequest(
  body: Record<string, unknown>,
  opts: ConvertReplicateOpts = {},
): Record<string, unknown> {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new Error("replicate adaptor: prompt is required");
  let modelName = String(opts.upstreamModelName || body.model || "").trim();
  if (!modelName) modelName = REPLICATE_DEFAULT_MODEL;
  const input: Record<string, unknown> = { prompt };
  const size = String(body.size || "").trim();
  if (size) {
    const mapped = mapOpenAISizeToFlux(size);
    if (mapped) {
      if (mapped.aspect === "custom") {
        input.aspect_ratio = "custom";
        if (mapped.width > 0) input.width = mapped.width;
        if (mapped.height > 0) input.height = mapped.height;
      } else if (mapped.aspect) {
        input.aspect_ratio = mapped.aspect;
      }
    }
  }
  if (typeof body.output_format === "string" && body.output_format.trim()) {
    input.output_format = body.output_format;
  }
  const imageN = Number(body.n ?? 0);
  if (imageN > 0) input.num_outputs = Math.trunc(imageN);
  const quality = String(body.quality || "");
  if (quality.toLowerCase() === "hd" || quality.toLowerCase() === "high") input.prompt_upsampling = true;
  Object.assign(input, extraFieldsObject(body));
  const extra = extraObject(body);
  for (const [key, val] of Object.entries(extra)) {
    if (key.toLowerCase() === "input") {
      if (val && typeof val === "object" && !Array.isArray(val)) Object.assign(input, val as Record<string, unknown>);
      continue;
    }
    if (val == null) continue;
    input[key] = val;
  }
  return { input };
}

function predictionErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const o = error as Record<string, unknown>;
  return String(o.Message || o.message || o.Detail || o.detail || o.Code || o.code || "");
}

function outputUrls(output: unknown): string[] {
  const urls: string[] = [];
  const append = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) urls.push(trimmed);
  };
  if (typeof output === "string") append(output);
  else if (Array.isArray(output)) {
    for (const item of output) if (typeof item === "string") append(item);
  }
  return urls;
}

/** Original `replicate.Adaptor.DoResponse` image unwrap. */
export function openaiFromReplicatePrediction(
  upstream: Record<string, unknown>,
  opts: { created?: number; responseFormat?: string } = {},
): Record<string, unknown> {
  const errMsg = predictionErrorMessage(upstream.error ?? upstream.Error);
  if (errMsg) throw new Error(errMsg);
  if (upstream.error) throw new Error("replicate adaptor: prediction error");
  const status = String(upstream.status ?? "");
  if (status && status.toLowerCase() !== "succeeded") {
    throw new Error(`replicate adaptor: prediction status "${status}"`);
  }
  const urls = outputUrls(upstream.output);
  if (!urls.length) throw new Error("replicate adaptor: empty prediction output");
  const wantsBase64 = String(opts.responseFormat || "").toLowerCase() === "b64_json";
  const data = wantsBase64 ? urls.map((url) => ({ b64_json: url })) : urls.map((url) => ({ url }));
  if (!data.length) throw new Error("replicate adaptor: no usable image data");
  return {
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data,
  };
}
