/**
 * Original `service.CovertMjpActionToModelName` / `PrepareMidjourneyTaskBilling` /
 * `SettleMidjourneyTaskBilling` / `RefundMidjourneyQuota` / `GenerateMjOtherInfo`.
 */
import { LOG_CONSUME, LOG_REFUND } from "./constants.js";
import type { Store } from "./store.js";
import type { UserRow } from "./types.js";

export const MJ_ACTION_SWAP_FACE = "SWAP_FACE";

export type MjPriceInfo = {
  quota: number;
  modelPrice: number;
  groupRatio: number;
  groupSpecialRatio: number;
  hasSpecialRatio: boolean;
};

/** Original `service.CovertMjpActionToModelName`. */
export function covertMjpActionToModelName(mjAction: string): string {
  if (mjAction === MJ_ACTION_SWAP_FACE) return "swap_face";
  return "mj_" + mjAction.toLowerCase();
}

/** Original `Midjourney.GetBillingChannelId`. */
export function mjBillingChannelId(row: Record<string, unknown>): number {
  const billed = Number(row.billing_channel_id || 0);
  if (billed > 0) return billed;
  return Number(row.channel_id || 0);
}

/** Original swap-face consume content without task id. */
export function mjSwapFaceConsumeContent(modelPrice: number, groupRatio: number, action: string): string {
  return `模型固定价格 ${modelPrice.toFixed(2)}，分组倍率 ${groupRatio.toFixed(2)}，操作 ${action}`;
}

/** Original submit consume content including upstream result id. */
export function mjSubmitConsumeContent(modelPrice: number, groupRatio: number, action: string, resultId: string): string {
  return `模型固定价格 ${modelPrice.toFixed(2)}，分组倍率 ${groupRatio.toFixed(2)}，操作 ${action}，ID ${resultId}`;
}

/** Original `service.GenerateMjOtherInfo`. */
export function generateMjOtherInfo(price: MjPriceInfo, requestPath: string): Record<string, unknown> {
  const other: Record<string, unknown> = {
    model_price: price.modelPrice,
    group_ratio: price.groupRatio,
  };
  if (price.hasSpecialRatio) other.user_group_ratio = price.groupSpecialRatio;
  if (requestPath) other.request_path = requestPath.split("?")[0];
  return other;
}

export function prepareMidjourneyTaskBilling(
  task: Record<string, unknown>,
  quota: number,
  shouldBill: boolean,
  channelId: number,
): boolean {
  task.quota = 0;
  task.token_id = 0;
  task.billing_channel_id = 0;
  if (!shouldBill) return false;
  if (quota < 0) return false;
  task.quota = quota;
  task.billing_channel_id = channelId;
  return true;
}

export async function settleMidjourneyTaskBilling(
  store: Store,
  user: UserRow,
  tokenId: number,
  task: Record<string, unknown>,
  prepared: boolean,
): Promise<boolean> {
  if (!prepared) return false;
  const id = Number(task.id || 0);
  const quota = Number(task.quota || 0);
  if (!id) return false;
  try {
    if (quota > 0) await store.decreaseUserQuota(user.id, quota);
    else if (quota < 0) await store.releaseUserQuota(user.id, -quota);
    if (tokenId > 0) {
      if (quota > 0) await store.decreaseTokenQuota(tokenId, quota);
      else if (quota < 0) await store.releaseTokenQuota(tokenId, -quota);
      task.token_id = tokenId;
    } else {
      task.token_id = 0;
    }
    await store.updateMjBillingState(id, Number(task.quota || 0), Number(task.token_id || 0), mjBillingChannelId(task));
    return true;
  } catch {
    task.quota = 0;
    task.token_id = 0;
    task.billing_channel_id = 0;
    await store.updateMjBillingState(id, 0, 0, 0);
    return false;
  }
}

async function recordMjBillingLog(opts: {
  store: Store;
  userId: number;
  logType: number;
  content: string;
  channelId: number;
  modelName: string;
  quota: number;
  tokenId: number;
  group: string;
  other: Record<string, unknown>;
}): Promise<void> {
  if (opts.logType === LOG_CONSUME && !(await opts.store.optionBool("LogConsumeEnabled", true))) return;
  const user = await opts.store.getUserById(opts.userId);
  let tokenName = "";
  if (opts.tokenId > 0) {
    const token = await opts.store.getTokenById(opts.tokenId);
    tokenName = String(token?.name || "");
  }
  await opts.store.insertLog({
    user_id: opts.userId,
    type: opts.logType,
    content: opts.content,
    username: user?.username || "",
    token_name: tokenName,
    model_name: opts.modelName,
    quota: opts.quota,
    prompt_tokens: 0,
    completion_tokens: 0,
    use_time: 0,
    is_stream: 0,
    channel_id: opts.channelId,
    token_id: opts.tokenId,
    group: opts.group,
    ip: "",
    request_id: "",
    other: JSON.stringify(opts.other),
  });
  if (opts.logType === LOG_CONSUME && user && (await opts.store.optionBool("DataExportEnabled", true))) {
    await opts.store.bumpQuotaData(user, opts.modelName, opts.quota, 0, {
      useGroup: opts.group,
      tokenId: opts.tokenId,
      channelId: opts.channelId,
    });
  }
}

export async function recordMjConsumeLog(opts: {
  store: Store;
  user: UserRow;
  tokenId: number;
  channelId: number;
  group: string;
  modelName: string;
  quota: number;
  content: string;
  other: Record<string, unknown>;
}): Promise<void> {
  await opts.store.addUserUsedQuotaAndRequestCount(opts.user.id, opts.quota);
  await opts.store.addChannelUsedQuota(opts.channelId, opts.quota);
  await recordMjBillingLog({
    store: opts.store,
    userId: opts.user.id,
    logType: LOG_CONSUME,
    content: opts.content,
    channelId: opts.channelId,
    modelName: opts.modelName,
    quota: opts.quota,
    tokenId: opts.tokenId,
    group: opts.group,
    other: opts.other,
  });
}

/** Original `service.RefundMidjourneyQuota`. */
export async function refundMidjourneyQuota(store: Store, task: Record<string, unknown>, reason: string): Promise<boolean> {
  const quota = Number(task.quota || 0);
  if (!quota) return true;
  const userId = Number(task.user_id || 0);
  const tokenId = Number(task.token_id || 0);
  const billingChannelId = mjBillingChannelId(task);
  if (userId) await store.releaseUserQuota(userId, quota);
  if (tokenId > 0) await store.releaseTokenQuota(tokenId, quota);
  if (userId) await store.addUserUsedQuota(userId, -quota);
  if (billingChannelId) await store.addChannelUsedQuota(billingChannelId, -quota);
  await recordMjBillingLog({
    store,
    userId,
    logType: LOG_REFUND,
    content: "",
    channelId: billingChannelId,
    modelName: covertMjpActionToModelName(String(task.action || "")),
    quota,
    tokenId,
    group: "",
    other: { task_id: String(task.mj_id || ""), reason },
  });
  task.quota = 0;
  const id = Number(task.id || 0);
  if (id) await store.updateMjBillingState(id, 0, Number(task.token_id || 0), Number(task.billing_channel_id || 0));
  return true;
}
