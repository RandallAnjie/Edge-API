/** Original `relay/channel/minimax` ConvertOpenAIRequest / ConvertImageRequest / ConvertAudioRequest / GetRequestURL. */

export type ConvertMiniMaxOpts = {
  upstreamModelName?: string;
  originModelName?: string;
};

/** Original `minimax.GetRequestURL`. */
export function minimaxRequestURL(base: string, mode: string): string {
  const root = base.replace(/\/+$/, "");
  if (mode === "messages") return `${root}/anthropic/v1/messages`;
  if (mode === "chat") return `${root}/v1/text/chatcompletion_v2`;
  if (mode === "images") return `${root}/v1/image_generation`;
  if (mode === "audio_speech") return `${root}/v1/t2a_v2`;
  throw new Error(`unsupported relay mode: ${mode}`);
}

/** Original MiniMax ConvertOpenAIRequest: passthrough `request` (keeps `stream_options`). */
export function convertMiniMaxOpenAIRequest(
  body: Record<string, unknown>,
  opts: ConvertMiniMaxOpts = {},
): Record<string, unknown> {
  return { ...body, model: opts.upstreamModelName || String(body.model || "") };
}

function extraField(body: Record<string, unknown>, key: string): unknown {
  if (body[key] != null) return body[key];
  const extra = body.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) return (extra as Record<string, unknown>)[key];
  return undefined;
}

function parseImageSize(size: string): { width: number; height: number } | null {
  const parts = size.split("x");
  if (parts.length !== 2) return null;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function gcd(a: number, b: number): number {
  let x = Math.trunc(Math.abs(a));
  let y = Math.trunc(Math.abs(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function aspectRatioFromImageRequest(body: Record<string, unknown>): string {
  const extraRatio = extraField(body, "aspect_ratio");
  if (typeof extraRatio === "string" && extraRatio) return extraRatio;
  const size = String(body.size || "");
  switch (size) {
    case "1024x1024":
      return "1:1";
    case "1792x1024":
      return "16:9";
    case "1024x1792":
      return "9:16";
    case "1536x1024":
    case "1248x832":
      return "3:2";
    case "1024x1536":
    case "832x1248":
      return "2:3";
    case "1152x864":
      return "4:3";
    case "864x1152":
      return "3:4";
    case "1344x576":
      return "21:9";
    default:
      break;
  }
  const parsed = parseImageSize(size);
  if (!parsed) return "";
  const d = gcd(parsed.width, parsed.height);
  const ratio = `${parsed.width / d}:${parsed.height / d}`;
  switch (ratio) {
    case "1:1":
    case "16:9":
    case "4:3":
    case "3:2":
    case "2:3":
    case "3:4":
    case "9:16":
    case "21:9":
      return ratio;
    default:
      return "";
  }
}

function normalizeMiniMaxResponseFormat(responseFormat: string): string {
  switch (responseFormat.toLowerCase()) {
    case "":
    case "url":
      return "url";
    case "b64_json":
    case "base64":
      return "base64";
    default:
      return responseFormat;
  }
}

/** Original `minimax.oaiImage2MiniMaxImageRequest`. */
export function convertMiniMaxImageRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: String(body.model || "") || "image-01",
    prompt: String(body.prompt || ""),
    response_format: normalizeMiniMaxResponseFormat(String(body.response_format || "")),
    n: 1,
  };
  const n = Number(body.n ?? 0);
  if (n > 0) out.n = Math.trunc(n);
  const aspectRatio = aspectRatioFromImageRequest(body);
  if (aspectRatio) out.aspect_ratio = aspectRatio;
  if (body.watermark != null) out.aigc_watermark = body.watermark;
  const promptOptimizer = extraField(body, "prompt_optimizer");
  if (typeof promptOptimizer === "boolean") out.prompt_optimizer = promptOptimizer;
  return out;
}

/** Original `minimax.Adaptor.ConvertAudioRequest` TTS JSON. Model is `OriginModelName`. */
export function convertMiniMaxTTSRequest(body: Record<string, unknown>, opts: ConvertMiniMaxOpts = {}): Record<string, unknown> {
  const voiceId = String(body.voice || "");
  const speed = Number(body.speed ?? 0);
  const outputFormat = String(body.response_format || "");
  const voiceSetting: Record<string, unknown> = {};
  if (voiceId) voiceSetting.voice_id = voiceId;
  if (speed) voiceSetting.speed = speed;
  const audioSetting: Record<string, unknown> = {};
  if (outputFormat) audioSetting.format = outputFormat;
  const out: Record<string, unknown> = {
    model: opts.originModelName || String(body.model || ""),
    text: String(body.input || ""),
    voice_setting: voiceSetting,
    audio_setting: audioSetting,
  };
  if (outputFormat) out.output_format = outputFormat;
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    Object.assign(out, metadata);
  }
  return out;
}
