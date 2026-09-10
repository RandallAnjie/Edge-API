/** Original `service.CacheGetRandomSatisfiedChannel` + `middleware.Distribute` first-channel selection. */

import { CHANNEL_ENABLED } from "./constants.js";
import {
  clearAffinityCacheKey,
  preferredAffinityChannel,
  resolveChannelAffinity,
  type ChannelAffinityResolution,
} from "./channel-affinity.js";
import { requestAutoGroups } from "./dto.js";
import { channelDisabledMessage, getChannelFailedMessage, invalidChannelIdMessage, noAvailableChannelMessage } from "./http.js";
import type { Store } from "./store.js";
import type { AuthToken, ChannelRow, Env, TokenRow } from "./types.js";

export type ChannelSelectState = {
  autoGroupIndex: number;
  retry: number;
  resetNextTry: boolean;
};

export type ChannelSelectParam = {
  tokenGroup: string;
  modelName: string;
  userGroup: string;
  token: TokenRow | null;
  crossGroupRetry: boolean;
  retryTimes: number;
};

export function newChannelSelectState(): ChannelSelectState {
  return { autoGroupIndex: 0, retry: 0, resetNextTry: false };
}

/** Original `RetryParam.IncreaseRetry`. */
export function increaseChannelSelectRetry(state: ChannelSelectState): void {
  if (state.resetNextTry) {
    state.resetNextTry = false;
    return;
  }
  state.retry += 1;
}

export async function resolveRequestAutoGroups(store: Store, param: ChannelSelectParam): Promise<string[]> {
  return requestAutoGroups(store, param.token, param.userGroup);
}

/** Original `service.CacheGetRandomSatisfiedChannel`. Mutates `state` like the gin context keys. */
export async function cacheGetRandomSatisfiedChannel(
  store: Store,
  param: ChannelSelectParam,
  state: ChannelSelectState,
): Promise<{ channel: ChannelRow | null; selectGroup: string; error?: string }> {
  if (param.tokenGroup !== "auto") {
    const channel = await store.getRandomSatisfiedChannel(param.tokenGroup, param.modelName, state.retry);
    return { channel, selectGroup: param.tokenGroup };
  }

  const autoGroups = await resolveRequestAutoGroups(store, param);
  if (!autoGroups.length) return { channel: null, selectGroup: param.tokenGroup, error: "auto groups is not enabled" };

  let startGroupIndex = state.autoGroupIndex;
  if (startGroupIndex < 0) startGroupIndex = 0;
  let selectGroup = param.tokenGroup;
  let channel: ChannelRow | null = null;

  for (let i = startGroupIndex; i < autoGroups.length; i++) {
    const autoGroup = autoGroups[i];
    let priorityRetry = state.retry;
    if (i > startGroupIndex) priorityRetry = 0;
    channel = await store.getRandomSatisfiedChannel(autoGroup, param.modelName, priorityRetry);
    if (!channel) {
      state.autoGroupIndex = i + 1;
      state.retry = 0;
      continue;
    }
    selectGroup = autoGroup;
    if (param.crossGroupRetry && priorityRetry >= param.retryTimes) {
      state.autoGroupIndex = i + 1;
      state.retry = 0;
      state.resetNextTry = true;
    } else {
      state.autoGroupIndex = i;
    }
    break;
  }
  return { channel, selectGroup };
}

export type DistributeSelectResult = {
  channel: ChannelRow | null;
  usingGroup: string;
  usedAffinity: boolean;
  pinned: boolean;
  affinity: ChannelAffinityResolution | null;
  selectState: ChannelSelectState;
  selectParam: ChannelSelectParam;
  error?: { status: number; message: string; code: string };
};

/** Original `middleware.Distribute` channel selection (pin → affinity → CacheGetRandomSatisfiedChannel). */
export async function selectDistributedChannel(opts: {
  store: Store;
  env: Env;
  req: Request;
  auth: AuthToken;
  model: string;
  requestPath: string;
  body: unknown;
  headers: Record<string, string>;
}): Promise<DistributeSelectResult> {
  const { store, env, req, auth, model, requestPath, body, headers } = opts;
  const retryTimes = await store.optionNum("RetryTimes", 0);
  const selectParam: ChannelSelectParam = {
    tokenGroup: auth.usingGroup,
    modelName: model,
    userGroup: auth.user.group || "default",
    token: auth.token,
    crossGroupRetry: Boolean(Number(auth.token.cross_group_retry)),
    retryTimes,
  };
  const selectState = newChannelSelectState();
  const empty = {
    usingGroup: auth.usingGroup,
    usedAffinity: false,
    pinned: false,
    affinity: null as ChannelAffinityResolution | null,
    selectState,
    selectParam,
  };

  if (auth.pinnedChannelId) {
    const pinned = await store.getChannel(auth.pinnedChannelId);
    if (!pinned) {
      return {
        ...empty,
        channel: null,
        error: { status: 400, message: invalidChannelIdMessage(req), code: "invalid_channel_id" },
      };
    }
    if (pinned.status !== CHANNEL_ENABLED) {
      return {
        ...empty,
        channel: null,
        error: { status: 403, message: channelDisabledMessage(req), code: "channel_disabled" },
      };
    }
    return { ...empty, channel: pinned, pinned: true };
  }

  const affinity = await resolveChannelAffinity(store, env, {
    model,
    path: requestPath,
    usingGroup: auth.usingGroup,
    userAgent: req.headers.get("user-agent") || "",
    headers,
    body,
    userId: auth.user.id,
  });
  let usedAffinity = false;
  let first: ChannelRow | null = null;
  let usingGroup = auth.usingGroup;
  if (affinity?.preferredChannelId) {
    if (auth.usingGroup === "auto") {
      const autoGroups = await requestAutoGroups(store, auth.token, auth.user.group || "default");
      for (const g of autoGroups) {
        const preferred = await preferredAffinityChannel(store, g, model, affinity.preferredChannelId);
        if (preferred) {
          first = preferred;
          usingGroup = g;
          usedAffinity = true;
          break;
        }
      }
    } else {
      const preferred = await preferredAffinityChannel(store, auth.usingGroup, model, affinity.preferredChannelId);
      if (preferred) {
        first = preferred;
        usedAffinity = true;
      }
    }
    if (!usedAffinity && !(await store.optionBool("channel_affinity_setting.keep_on_channel_disabled", false))) {
      await clearAffinityCacheKey(store, env, affinity.cacheKeySuffix);
    }
  }
  if (!first) {
    const selected = await cacheGetRandomSatisfiedChannel(store, selectParam, selectState);
    if (selected.error) {
      const showGroup = auth.usingGroup === "auto" ? `auto(${selected.selectGroup})` : selected.selectGroup;
      return {
        ...empty,
        affinity,
        channel: null,
        error: {
          status: 503,
          message: getChannelFailedMessage(req, showGroup, model, selected.error),
          code: "no_available_channel",
        },
      };
    }
    first = selected.channel;
    if (selected.selectGroup && selected.selectGroup !== "auto") usingGroup = selected.selectGroup;
  }
  if (!first) {
    const showGroup = usingGroup === "auto" ? "auto" : usingGroup;
    return {
      ...empty,
      affinity,
      usingGroup,
      channel: null,
      error: { status: 503, message: noAvailableChannelMessage(req, showGroup, model), code: "no_available_channel" },
    };
  }
  return { channel: first, usingGroup, usedAffinity, pinned: false, affinity, selectState, selectParam };
}
