/**
 * Original `service.PreWssConsumeQuota` / `PostWssConsumeQuota` on workerd.
 * May import store. Must not import openai-realtime.ts / relay.ts / convert / upstream.
 */

import { LOG_CONSUME, DEFAULT_GROUP_RATIO, parseJson } from "./constants.js";
import { parseChannelInfo } from "./channel-info.js";
import { clientIp } from "./http.js";
import { calculateAudioQuota, generateWssOtherInfo, type RealtimeUsage } from "./openai-realtime-usage.js";
import {
  getAudioCompletionRatioFromMap,
  getAudioRatioFromMap,
  getCompletionRatio,
  getModelPriceFromMap,
  getModelRatioFromMap,
} from "./ratio-setting.js";
import { insufficientTokenQuotaMessage, insufficientWssUserQuotaMessage, storeFormatQuota } from "./quota.js";
import type { Store } from "./store.js";
import { logOtherSnapshot, newLogOther, setLogOtherAdmin, setLogOtherPublic } from "./task-plugin-billing.js";
import type { AuthToken, ChannelRow } from "./types.js";

export type WssPriceData = {
  usePrice: boolean;
  modelPrice: number;
  originModelRatio: number;
  originCompletionRatio: number;
  originAudioRatio: number;
  originAudioCompletionRatio: number;
  upstreamCompletionRatio: number;
  upstreamAudioRatio: number;
  upstreamAudioCompletionRatio: number;
  groupRatio: number;
  userGroupRatio: number;
  quotaPerUnit: number;
  originModel: string;
  upstreamModel: string;
};

export async function loadWssPriceData(
  store: Store,
  originModel: string,
  upstreamModel: string,
  usingGroup: string,
  userGroup: string,
): Promise<WssPriceData> {
  const overlay = parseJson<Record<string, Record<string, number>>>(await store.option("GroupGroupRatio"), {});
  const nested = userGroup ? overlay[userGroup] : undefined;
  let groupRatio: number;
  let userGroupRatio = -1;
  if (nested && nested[usingGroup] != null) {
    groupRatio = Number(nested[usingGroup]);
    userGroupRatio = groupRatio;
  } else {
    const groupRatioMap = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
    groupRatio = groupRatioMap[usingGroup] ?? groupRatioMap.default ?? 1;
  }
  const modelRatioMap = parseJson<Record<string, number>>(await store.option("ModelRatio"), {});
  const completionMap = parseJson<Record<string, number>>(await store.option("CompletionRatio"), {});
  const audioMap = parseJson<Record<string, number>>(await store.option("AudioRatio"), {});
  const audioCompMap = parseJson<Record<string, number>>(await store.option("AudioCompletionRatio"), {});
  const priceMap = parseJson<Record<string, number>>(await store.option("ModelPrice"), {});
  const priced = getModelPriceFromMap(originModel, priceMap);
  const quotaPerUnit = (await store.optionNum("QuotaPerUnit", 500000)) || 500000;
  return {
    usePrice: priced.configured,
    modelPrice: priced.configured ? priced.price : -1,
    originModelRatio: getModelRatioFromMap(originModel, modelRatioMap).ratio,
    originCompletionRatio: getCompletionRatio(originModel, completionMap),
    originAudioRatio: getAudioRatioFromMap(originModel, audioMap).ratio,
    originAudioCompletionRatio: getAudioCompletionRatioFromMap(originModel, audioCompMap).ratio,
    upstreamCompletionRatio: getCompletionRatio(upstreamModel, completionMap),
    upstreamAudioRatio: getAudioRatioFromMap(upstreamModel, audioMap).ratio,
    upstreamAudioCompletionRatio: getAudioCompletionRatioFromMap(upstreamModel, audioCompMap).ratio,
    groupRatio,
    userGroupRatio,
    quotaPerUnit,
    originModel,
    upstreamModel,
  };
}

/**
 * Original `PreWssConsumeQuota`: `relayInfo.UsePrice` is the zero-value false
 * field (not `PriceData.UsePrice`), so this path always uses the ratio formula
 * with OriginModelName lookups.
 */
export function preWssAudioQuota(price: WssPriceData, usage: RealtimeUsage): number {
  return calculateAudioQuota({
    inputTextTokens: usage.input_token_details.text_tokens,
    inputAudioTokens: usage.input_token_details.audio_tokens,
    outputTextTokens: usage.output_token_details.text_tokens,
    outputAudioTokens: usage.output_token_details.audio_tokens,
    modelName: price.originModel,
    usePrice: false,
    modelPrice: price.modelPrice,
    modelRatio: price.originModelRatio,
    groupRatio: price.groupRatio,
    completionRatio: price.originCompletionRatio,
    audioRatio: price.originAudioRatio,
    audioCompletionRatio: price.originAudioCompletionRatio,
    quotaPerUnit: price.quotaPerUnit,
  }).quota;
}

/**
 * Original `PostWssConsumeQuota` `calculateAudioQuota`: UsePrice from PriceData;
 * completion / audio / audio-completion lookups use UpstreamModelName
 * (`QuotaInfo.ModelName`).
 */
export function postWssAudioQuota(price: WssPriceData, usage: RealtimeUsage): number {
  return calculateAudioQuota({
    inputTextTokens: usage.input_token_details.text_tokens,
    inputAudioTokens: usage.input_token_details.audio_tokens,
    outputTextTokens: usage.output_token_details.text_tokens,
    outputAudioTokens: usage.output_token_details.audio_tokens,
    modelName: price.upstreamModel,
    usePrice: price.usePrice,
    modelPrice: price.modelPrice,
    modelRatio: price.originModelRatio,
    groupRatio: price.groupRatio,
    completionRatio: price.upstreamCompletionRatio,
    audioRatio: price.upstreamAudioRatio,
    audioCompletionRatio: price.upstreamAudioCompletionRatio,
    quotaPerUnit: price.quotaPerUnit,
  }).quota;
}

export async function preWssConsumeQuota(opts: {
  store: Store;
  auth: AuthToken;
  price: WssPriceData;
  usage: RealtimeUsage;
}): Promise<number> {
  const quota = preWssAudioQuota(opts.price, opts.usage);
  const user = await opts.store.getUserById(opts.auth.user.id);
  if (!user) throw new Error("user not found");
  const token = await opts.store.getTokenById(opts.auth.token.id);
  if (!token) throw new Error("token not found");
  if (user.quota < quota) {
    const remain = await storeFormatQuota(opts.store, user.quota);
    const need = await storeFormatQuota(opts.store, quota);
    throw new Error(insufficientWssUserQuotaMessage(remain, need));
  }
  if (!token.unlimited_quota && token.remain_quota < quota) {
    const remain = await storeFormatQuota(opts.store, token.remain_quota);
    const need = await storeFormatQuota(opts.store, quota);
    throw new Error(insufficientTokenQuotaMessage(remain, need));
  }
  if (quota > 0) {
    await opts.store.decreaseUserQuota(user.id, quota);
    if (!opts.auth.token.id) {
      /* playground skips token quota */
    } else {
      await opts.store.decreaseTokenQuota(token.id, quota);
    }
  }
  return quota;
}

function userRecordsIpLog(settingsRaw: unknown): boolean {
  const settings =
    typeof settingsRaw === "string"
      ? parseJson<Record<string, unknown>>(settingsRaw, {})
      : settingsRaw && typeof settingsRaw === "object" && !Array.isArray(settingsRaw)
        ? (settingsRaw as Record<string, unknown>)
        : {};
  return Boolean(settings.record_ip_log);
}

export async function postWssConsumeQuota(opts: {
  store: Store;
  auth: AuthToken;
  channel: ChannelRow;
  req: Request;
  price: WssPriceData;
  usage: RealtimeUsage;
  finalPreConsumedQuota: number;
  startMs: number;
  firstResponseMs: number;
  requestId: string;
}): Promise<void> {
  const { store, auth, channel, price, usage } = opts;
  let quota = postWssAudioQuota(price, usage);
  const useTimeSeconds = Math.max(0, Math.floor((Date.now() - opts.startMs) / 1000));
  let logContent: string;
  if (!price.usePrice) {
    logContent = `模型倍率 ${price.originModelRatio.toFixed(2)}，补全倍率 ${price.upstreamCompletionRatio.toFixed(2)}，音频倍率 ${price.originAudioRatio.toFixed(2)}，音频补全倍率 ${price.upstreamAudioCompletionRatio.toFixed(2)}，分组倍率 ${price.groupRatio.toFixed(2)}`;
  } else {
    logContent = `模型价格 ${price.modelPrice.toFixed(2)}，分组倍率 ${price.groupRatio.toFixed(2)}`;
  }
  if (usage.total_tokens === 0) {
    quota = 0;
    logContent += "（可能是上游超时）";
  } else {
    await store.addUserUsedQuotaAndRequestCount(auth.user.id, quota);
    await store.addChannelUsedQuota(channel.id, quota);
  }
  const delta = quota - opts.finalPreConsumedQuota;
  if (delta > 0) {
    await store.decreaseUserQuota(auth.user.id, delta);
    if (auth.token.id) await store.decreaseTokenQuota(auth.token.id, delta);
  } else if (delta < 0) {
    await store.releaseUserQuota(auth.user.id, -delta);
    if (auth.token.id) await store.releaseTokenQuota(auth.token.id, -delta);
  }
  if (!(await store.optionBool("LogConsumeEnabled", true))) return;
  const frtMs = opts.firstResponseMs > 0 ? Math.max(0, opts.firstResponseMs - opts.startMs) : 0;
  const publicOther = generateWssOtherInfo({
    usage,
    modelRatio: price.originModelRatio,
    groupRatio: price.groupRatio,
    completionRatio: price.upstreamCompletionRatio,
    audioRatio: price.originAudioRatio,
    audioCompletionRatio: price.upstreamAudioCompletionRatio,
    modelPrice: price.modelPrice,
    userGroupRatio: price.userGroupRatio,
    frtMs,
    requestPath: "/v1/realtime",
    isModelMapped: price.originModel !== price.upstreamModel,
    upstreamModelName: price.upstreamModel,
  });
  const maps = newLogOther();
  for (const [key, value] of Object.entries(publicOther)) setLogOtherPublic(maps, key, value);
  setLogOtherAdmin(maps, "use_channel", [String(channel.id)]);
  const multi = parseChannelInfo(String(channel.channel_info || ""));
  if (multi.is_multi_key) setLogOtherAdmin(maps, "is_multi_key", true);
  const other = logOtherSnapshot(maps);
  const ip = userRecordsIpLog(auth.user.settings) ? clientIp(opts.req) : "";
  await store.insertLog({
    user_id: auth.user.id,
    type: LOG_CONSUME,
    content: logContent,
    username: auth.user.username,
    token_name: auth.token.name,
    model_name: price.upstreamModel,
    quota,
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    use_time: useTimeSeconds,
    is_stream: 1,
    channel_id: channel.id,
    token_id: auth.token.id,
    group: auth.usingGroup,
    ip,
    request_id: opts.requestId,
    other: JSON.stringify(other),
  });
  if (await store.optionBool("DataExportEnabled", true)) {
    await store.bumpQuotaData(auth.user, price.upstreamModel, quota, usage.input_tokens + usage.output_tokens, {
      useGroup: auth.usingGroup,
      tokenId: auth.token.id,
      channelId: channel.id,
    });
  }
}
