/**
 * Original `service.GenerateTextOtherInfo` / `GenerateClaudeOtherInfo` /
 * `GenerateAudioOtherInfo` / `GenerateWssOtherInfo` public consume-log JSON
 * on workerd. Must not import store / relay / convert / query / submit.
 * WSS (`ws: true`) stays in openai-realtime-usage; this file owns HTTP audio
 * (`audio: true`) and must not merge the two.
 */
import { quotaClampAuditMap, type QuotaClamp } from "./task-plugin-usage.js";

export const RELAY_FORMAT_OPENAI = "openai";
export const RELAY_FORMAT_CLAUDE = "claude";
export const RELAY_FORMAT_GEMINI = "gemini";
export const RELAY_FORMAT_OPENAI_RESPONSES = "openai_responses";
export const RELAY_FORMAT_OPENAI_RESPONSES_COMPACTION = "openai_responses_compaction";
export const RELAY_FORMAT_OPENAI_ALPHA_SEARCH = "openai_alpha_search";
export const RELAY_FORMAT_OPENAI_AUDIO = "openai_audio";
export const RELAY_FORMAT_OPENAI_IMAGE = "openai_image";
export const RELAY_FORMAT_OPENAI_REALTIME = "openai_realtime";
export const RELAY_FORMAT_RERANK = "rerank";
export const RELAY_FORMAT_EMBEDDING = "embedding";

/** Original `GenRelayInfo` `FirstResponseTime: startTime.Add(-time.Second)`. */
export const DEFAULT_RELAY_FRT_MS = -1000;

export type TextOtherInfoOpts = {
  modelRatio: number;
  groupRatio: number;
  completionRatio: number;
  cacheTokens?: number;
  cacheRatio?: number;
  modelPrice?: number;
  userGroupRatio?: number;
  frt?: number;
  reasoningEffort?: string;
  isModelMapped?: boolean;
  upstreamModelName?: string;
  isSystemPromptOverwritten?: boolean;
  requestPath?: string;
  requestConversion?: string[];
  claude?: boolean;
  billingSource?: string;
  billingPreference?: string;
  subscriptionId?: number;
  subscriptionPreConsumed?: number;
  subscriptionPostDelta?: number;
  subscriptionPlanId?: number;
  subscriptionPlanTitle?: string;
  subscriptionAmountTotal?: number;
  subscriptionAmountUsedAfterPreConsume?: number;
  paramOverride?: unknown;
  streamStatus?: unknown;
};

export type ClaudeOtherInfoOpts = TextOtherInfoOpts & {
  cacheCreationTokens?: number;
  cacheCreationRatio?: number;
  cacheCreationTokens5m?: number;
  cacheCreationRatio5m?: number;
  cacheCreationTokens1h?: number;
  cacheCreationRatio1h?: number;
};

export type ConsumeLogOtherOpts = ClaudeOtherInfoOpts & {
  model: string;
  group: string;
  channelId: number;
  channelName: string;
  channelType: number;
  ok: boolean;
  isMultiKey?: boolean;
  multiKeyIndex?: number;
  useChannel?: string[];
  channelAffinity?: Record<string, unknown>;
  billingModel?: string;
  localCountTokens?: boolean;
  conversionDiagnostics?: unknown;
  conversionDiagnosticsTruncated?: boolean;
  isClaudeUsageSemantic?: boolean;
  finalRequestFormat?: string;
  imageTokens?: number;
  imageRatio?: number;
  cacheWriteTokens?: number;
  inputTokensTotal?: number;
  usageSource?: string;
  publicExtra?: Record<string, unknown>;
  /** original GenerateAudioOtherInfo usage.PromptTokensDetails.AudioTokens */
  audioInput?: number;
  /** original GenerateAudioOtherInfo usage.CompletionTokenDetails.AudioTokens */
  audioOutput?: number;
  /** original GenerateAudioOtherInfo usage.PromptTokensDetails.TextTokens */
  textInput?: number;
  /** original GenerateAudioOtherInfo usage.CompletionTokenDetails.TextTokens */
  textOutput?: number;
  /** original PostAudioConsumeQuota `ratio_setting.GetAudioRatio` */
  audioRatio?: number;
  /** original PostAudioConsumeQuota `ratio_setting.GetAudioCompletionRatio` */
  audioCompletionRatio?: number;
  /**
   * original `ContainsAudioRatio || ContainsAudioCompletionRatio` on
   * compatible/chat PostAudioConsumeQuota.
   */
  containsAudioRatios?: boolean;
  /**
   * Original `service.noteQuotaClamp` / `attachQuotaSaturation` after
   * `TryTieredSettle` (`tiered_settle.go`) or `quotaFromDecimalChecked`.
   * Nested under `admin_info.quota_saturation` so `formatUserLogs` strips it.
   */
  quotaClamp?: QuotaClamp | null;
  toolSurcharges?: { name: string; count: number; price: number }[];
  audioInputPrice?: number;
  audioInputTokens?: number;
};

/** Original `appendRequestConversionChain` display labels. */
export function requestConversionLabel(format: string): string {
  switch (format) {
    case RELAY_FORMAT_OPENAI:
      return "OpenAI Compatible";
    case RELAY_FORMAT_CLAUDE:
      return "Claude Messages";
    case RELAY_FORMAT_GEMINI:
      return "Google Gemini";
    case RELAY_FORMAT_OPENAI_RESPONSES:
      return "OpenAI Responses";
    default:
      return format;
  }
}

/** Original `RelayInfo.InitRequestConversionChain` start format from client path. */
export function relayFormatForClient(clientFormat: string, mode: string): string {
  if (clientFormat === "anthropic" || mode === "messages") return RELAY_FORMAT_CLAUDE;
  if (clientFormat === "gemini" || mode === "gemini") return RELAY_FORMAT_GEMINI;
  if (mode === "responses") return RELAY_FORMAT_OPENAI_RESPONSES;
  if (mode === "embeddings" || mode === "engines_embeddings") return RELAY_FORMAT_EMBEDDING;
  if (mode === "rerank") return RELAY_FORMAT_RERANK;
  if (mode === "images") return RELAY_FORMAT_OPENAI_IMAGE;
  if (mode === "audio_speech" || mode === "audio_transcription" || mode === "audio_translation") {
    return RELAY_FORMAT_OPENAI_AUDIO;
  }
  if (mode === "realtime") return RELAY_FORMAT_OPENAI_REALTIME;
  if (mode === "alpha_search") return RELAY_FORMAT_OPENAI_ALPHA_SEARCH;
  return RELAY_FORMAT_OPENAI;
}

/** Original `RelayInfo.AppendRequestConversion`. */
export function appendRequestConversion(chain: string[], format: string): string[] {
  if (!format) return chain;
  if (!chain.length) return [format];
  if (chain[chain.length - 1] === format) return chain;
  return [...chain, format];
}

/** Original `InitRequestConversionChain` plus later `AppendRequestConversion`. */
export function requestConversionChain(opts: {
  clientFormat: string;
  mode: string;
  viaResponses?: boolean;
  destinationFormat?: string;
}): string[] {
  let chain = appendRequestConversion([], relayFormatForClient(opts.clientFormat, opts.mode));
  if (opts.viaResponses) chain = appendRequestConversion(chain, RELAY_FORMAT_OPENAI_RESPONSES);
  if (opts.destinationFormat) chain = appendRequestConversion(chain, opts.destinationFormat);
  return chain;
}

function requestConversionPublic(chain: string[] | undefined): string[] | undefined {
  if (!chain || !chain.length) return undefined;
  const labels = chain.map(requestConversionLabel).filter(Boolean);
  return labels.length ? labels : undefined;
}

function appendBillingInfo(other: Record<string, unknown>, opts: TextOtherInfoOpts): void {
  if (opts.billingSource) other.billing_source = opts.billingSource;
  if (opts.billingPreference) other.billing_preference = opts.billingPreference;
  if (opts.billingSource !== "subscription") return;
  if (opts.subscriptionId) other.subscription_id = opts.subscriptionId;
  if ((opts.subscriptionPreConsumed || 0) > 0) other.subscription_pre_consumed = opts.subscriptionPreConsumed;
  if (opts.subscriptionPostDelta) other.subscription_post_delta = opts.subscriptionPostDelta;
  if (opts.subscriptionPlanId) other.subscription_plan_id = opts.subscriptionPlanId;
  if (opts.subscriptionPlanTitle) other.subscription_plan_title = opts.subscriptionPlanTitle;
  let consumed = (opts.subscriptionPreConsumed || 0) + (opts.subscriptionPostDelta || 0);
  let usedFinal = (opts.subscriptionAmountUsedAfterPreConsume || 0) + (opts.subscriptionPostDelta || 0);
  if (consumed < 0) consumed = 0;
  if (usedFinal < 0) usedFinal = 0;
  if ((opts.subscriptionAmountTotal || 0) > 0) {
    other.subscription_total = opts.subscriptionAmountTotal;
    other.subscription_used = usedFinal;
    other.subscription_remain = Math.max((opts.subscriptionAmountTotal || 0) - usedFinal, 0);
  }
  if (consumed > 0) other.subscription_consumed = consumed;
  other.wallet_quota_deducted = 0;
}

/** Original `service.GenerateTextOtherInfo` public fields (always-set ratios + conditionals). */
export function generateTextOtherInfo(opts: TextOtherInfoOpts): Record<string, unknown> {
  const other: Record<string, unknown> = {
    model_ratio: opts.modelRatio,
    group_ratio: opts.groupRatio,
    completion_ratio: opts.completionRatio,
    cache_tokens: opts.cacheTokens || 0,
    cache_ratio: opts.cacheRatio || 0,
    model_price: opts.modelPrice ?? 0,
    user_group_ratio: opts.userGroupRatio ?? -1,
    frt: opts.frt ?? DEFAULT_RELAY_FRT_MS,
  };
  if (opts.reasoningEffort) other.reasoning_effort = opts.reasoningEffort;
  if (opts.isModelMapped) {
    other.is_model_mapped = true;
    other.upstream_model_name = opts.upstreamModelName || "";
  }
  if (opts.isSystemPromptOverwritten) other.is_system_prompt_overwritten = true;
  if (opts.requestPath) other.request_path = opts.requestPath;
  const conversion = requestConversionPublic(opts.requestConversion);
  if (conversion) other.request_conversion = conversion;
  if (opts.claude) other.claude = true;
  appendBillingInfo(other, opts);
  if (opts.paramOverride && typeof opts.paramOverride === "object" && Object.keys(opts.paramOverride as object).length) {
    other.po = opts.paramOverride;
  }
  if (opts.streamStatus) other.stream_status = opts.streamStatus;
  return other;
}

/** Original `service.GenerateClaudeOtherInfo`. */
export function generateClaudeOtherInfo(opts: ClaudeOtherInfoOpts): Record<string, unknown> {
  const other = generateTextOtherInfo({ ...opts, claude: true });
  other.cache_creation_tokens = opts.cacheCreationTokens || 0;
  other.cache_creation_ratio = opts.cacheCreationRatio || 0;
  if (opts.cacheCreationTokens5m) {
    other.cache_creation_tokens_5m = opts.cacheCreationTokens5m;
    other.cache_creation_ratio_5m = opts.cacheCreationRatio5m || 0;
  }
  if (opts.cacheCreationTokens1h) {
    other.cache_creation_tokens_1h = opts.cacheCreationTokens1h;
    other.cache_creation_ratio_1h = opts.cacheCreationRatio1h || 0;
  }
  return other;
}

export type AudioOtherInfoOpts = TextOtherInfoOpts & {
  audioInput?: number;
  audioOutput?: number;
  textInput?: number;
  textOutput?: number;
  audioRatio?: number;
  audioCompletionRatio?: number;
};

/** original service.GenerateAudioOtherInfo */
export function generateAudioOtherInfo(opts: AudioOtherInfoOpts): Record<string, unknown> {
  const other = generateTextOtherInfo({
    ...opts,
    cacheTokens: 0,
    cacheRatio: 0,
  });
  other.audio = true;
  other.audio_input = Number(opts.audioInput ?? 0);
  other.audio_output = Number(opts.audioOutput ?? 0);
  other.text_input = Number(opts.textInput ?? 0);
  other.text_output = Number(opts.textOutput ?? 0);
  other.audio_ratio = Number(opts.audioRatio ?? 0);
  other.audio_completion_ratio = Number(opts.audioCompletionRatio ?? 0);
  return other;
}

/**
 * original AudioHelper / compatible_handler / responses_handler
 * `PostAudioConsumeQuota` vs `PostTextConsumeQuota`.
 */
export function shouldPostAudioConsumeQuota(opts: {
  audioInput?: number;
  audioOutput?: number;
  finalRequestFormat?: string;
  containsAudioRatios?: boolean;
  originModelName?: string;
}): boolean {
  const format = opts.finalRequestFormat || "";
  if (format === RELAY_FORMAT_OPENAI_RESPONSES && String(opts.originModelName || "").startsWith("gpt-4o-audio")) {
    return true;
  }
  const hasAudioTokens = (opts.audioInput || 0) > 0 || (opts.audioOutput || 0) > 0;
  if (!hasAudioTokens) return false;
  if (format === RELAY_FORMAT_OPENAI_AUDIO) return true;
  return Boolean(opts.containsAudioRatios);
}

/** Original `cacheWriteTokensTotal` on `PostTextConsumeQuota`. */
export function cacheWriteTokensTotal(opts: {
  cacheCreationTokens?: number;
  cacheCreationTokens5m?: number;
  cacheCreationTokens1h?: number;
}): number {
  const total = opts.cacheCreationTokens || 0;
  const five = opts.cacheCreationTokens5m || 0;
  const hour = opts.cacheCreationTokens1h || 0;
  if (five > 0 || hour > 0) {
    const split = five + hour;
    return total > split ? total : split;
  }
  return total;
}

/** Original `PostTextConsumeQuota` fields after GenerateText/ClaudeOtherInfo. */
export function appendPostTextQuotaOther(
  other: Record<string, unknown>,
  opts: {
    isClaudeUsageSemantic?: boolean;
    finalRequestFormat?: string;
    imageTokens?: number;
    imageRatio?: number;
    cacheCreationTokens?: number;
    cacheCreationRatio?: number;
    cacheCreationTokens5m?: number;
    cacheCreationRatio5m?: number;
    cacheCreationTokens1h?: number;
    cacheCreationRatio1h?: number;
    inputTokensTotal?: number;
    usageSource?: string;
    toolSurcharges?: { name: string; count: number; price: number }[];
    audioInputPrice?: number;
    audioInputTokens?: number;
  },
): void {
  if (opts.isClaudeUsageSemantic) other.usage_semantic = "anthropic";
  if ((opts.imageTokens || 0) !== 0) {
    other.image = true;
    other.image_ratio = opts.imageRatio || 0;
    other.image_output = opts.imageTokens;
  }
  if (!opts.isClaudeUsageSemantic) {
    if ((opts.cacheCreationTokens || 0) > 0) {
      other.cache_creation_tokens = opts.cacheCreationTokens;
      other.cache_creation_ratio = opts.cacheCreationRatio || 0;
    }
    if ((opts.cacheCreationTokens5m || 0) > 0) {
      other.cache_creation_tokens_5m = opts.cacheCreationTokens5m;
      other.cache_creation_ratio_5m = opts.cacheCreationRatio5m || 0;
    }
    if ((opts.cacheCreationTokens1h || 0) > 0) {
      other.cache_creation_tokens_1h = opts.cacheCreationTokens1h;
      other.cache_creation_ratio_1h = opts.cacheCreationRatio1h || 0;
    }
  }
  const write = cacheWriteTokensTotal(opts);
  if (write > 0) other.cache_write_tokens = write;
  if (
    opts.finalRequestFormat !== RELAY_FORMAT_CLAUDE &&
    opts.usageSource &&
    (opts.inputTokensTotal || 0) > 0
  ) {
    other.input_tokens_total = opts.inputTokensTotal;
  }
  if (opts.toolSurcharges && opts.toolSurcharges.length) other.tool_surcharges = opts.toolSurcharges;
  if ((opts.audioInputPrice || 0) > 0 && (opts.audioInputTokens || 0) > 0) {
    other.audio_input_seperate_price = true;
    other.audio_input_token_count = opts.audioInputTokens;
    other.audio_input_price = opts.audioInputPrice;
  }
}

function consumeLogAdmin(opts: ConsumeLogOtherOpts): Record<string, unknown> {
  const admin: Record<string, unknown> = {
    use_channel: opts.useChannel || [String(opts.channelId)],
    channel_id: opts.channelId,
    channel_name: opts.channelName,
    channel_type: opts.channelType,
  };
  if (opts.billingModel && opts.billingModel !== opts.model) admin.billing_model = opts.billingModel;
  if (opts.conversionDiagnostics) admin.conversion_diagnostics = opts.conversionDiagnostics;
  if (opts.conversionDiagnosticsTruncated) admin.conversion_diagnostics_truncated = true;
  if (opts.isMultiKey) {
    admin.is_multi_key = true;
    if (opts.multiKeyIndex != null) admin.multi_key_index = opts.multiKeyIndex;
  }
  if (opts.localCountTokens) admin.local_count_tokens = true;
  if (opts.channelAffinity) admin.channel_affinity = opts.channelAffinity;
  if (!opts.ok) admin.reject_reason = "upstream_error";
  return admin;
}

/**
 * Original text/audio-relay `RecordConsumeLog` `Log.Other` JSON:
 * `GenerateTextOtherInfo` / `GenerateClaudeOtherInfo` / `GenerateAudioOtherInfo`
 * public fields plus `AppendRelayLogAdminInfo`.
 */
export function consumeLogOther(opts: ConsumeLogOtherOpts): string {
  const finalFormat = opts.finalRequestFormat || (opts.requestConversion || [])[(opts.requestConversion || []).length - 1];
  const claudeFinal = finalFormat === RELAY_FORMAT_CLAUDE;
  const useAudio = shouldPostAudioConsumeQuota({
    audioInput: opts.audioInput,
    audioOutput: opts.audioOutput,
    finalRequestFormat: finalFormat,
    containsAudioRatios: opts.containsAudioRatios,
    originModelName: opts.model,
  });
  const other = useAudio
    ? generateAudioOtherInfo(opts)
    : opts.isClaudeUsageSemantic
      ? generateClaudeOtherInfo({ ...opts, claude: true })
      : generateTextOtherInfo({ ...opts, claude: opts.claude || claudeFinal });
  if (!useAudio) {
    appendPostTextQuotaOther(other, {
      isClaudeUsageSemantic: opts.isClaudeUsageSemantic,
      finalRequestFormat: finalFormat,
      imageTokens: opts.imageTokens,
      imageRatio: opts.imageRatio,
      cacheCreationTokens: opts.cacheCreationTokens,
      cacheCreationRatio: opts.cacheCreationRatio,
      cacheCreationTokens5m: opts.cacheCreationTokens5m,
      cacheCreationRatio5m: opts.cacheCreationRatio5m,
      cacheCreationTokens1h: opts.cacheCreationTokens1h,
      cacheCreationRatio1h: opts.cacheCreationRatio1h,
      inputTokensTotal: opts.inputTokensTotal,
      usageSource: opts.usageSource,
      toolSurcharges: opts.toolSurcharges,
      audioInputPrice: opts.audioInputPrice,
      audioInputTokens: opts.audioInputTokens,
    });
  }
  if (opts.publicExtra) Object.assign(other, opts.publicExtra);
  other.admin_info = consumeLogAdmin(opts);
  attachQuotaSaturation(other, opts.quotaClamp);
  return JSON.stringify(other);
}

/**
 * Original `service.attachQuotaSaturation` (`log_info_generate.go`).
 * Creates `admin_info` if absent. No-op when the clamp is nil.
 */
export function attachQuotaSaturation(
  other: Record<string, unknown>,
  clamp: QuotaClamp | null | undefined,
): void {
  const audit = quotaClampAuditMap(clamp);
  if (!audit) return;
  const existing = other.admin_info;
  const admin =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  admin.quota_saturation = audit;
  other.admin_info = admin;
}
