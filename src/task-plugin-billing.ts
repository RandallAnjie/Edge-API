/**
 * Original `service.LogTaskConsumption` consume-log JSON on workerd.
 * Matches `other` public/admin/root scopes and content `操作 … 计算参数：`.
 */
import { evaluateTaskCompletionUsage, parseBillingSnapshot, type BillingSnapshot } from "./billing-expr.js";
import { DEFAULT_GROUP_RATIO, LOG_CONSUME, LOG_REFUND, parseJson } from "./constants.js";
import { getModelRatioFromMap } from "./ratio-setting.js";
import type { Store } from "./store.js";
import { otherRatioMultiplier, quotaFromFloatChecked, type QuotaClamp } from "./task-plugin-usage.js";
import type { UserRow } from "./types.js";

/** Original `relaycommon.TaskInfo` fields used by poll settlement. */
export type TaskCompleteInfo = {
  status?: string;
  reason?: string;
  completionTokens?: number;
  totalTokens?: number;
  usageFacts?: Record<string, unknown>;
};

const LOG_OTHER_RESERVED = new Set(["admin_info", "root_info", "audit_info", "channel_id", "channel_name", "channel_type", "reject_reason"]);

export type TaskPluginAuthorSnapshot = { name: string; url?: string };

export type TaskPluginSnapshot = {
  key: string;
  name: string;
  version: string;
  author?: TaskPluginAuthorSnapshot;
  apiVersion: number;
  generation: number;
};

export type TaskPriceData = {
  quota: number;
  modelPrice: number;
  modelRatio: number;
  groupRatio: number;
  groupSpecialRatio: number;
  hasSpecialRatio: boolean;
  usePrice: boolean;
  freeModel: boolean;
  clamp: QuotaClamp | null;
};

export type TaskConsumptionLogInput = {
  action: string;
  requestPath: string;
  originModelName: string;
  upstreamModelName: string;
  isModelMapped: boolean;
  price: TaskPriceData;
  otherRatios: Record<string, number>;
  quota: number;
  taskId: string;
  upstreamTaskId: string;
  nodeName?: string;
  plugin?: TaskPluginSnapshot | null;
  perCall?: boolean;
  tiered?: {
    exprString: string;
    estimatedTier: string;
    usageFacts?: Record<string, unknown>;
  } | null;
  billing?: TaskBillingLogInfo | null;
};

/** Original `relaycommon.RelayInfo` subscription fields used by `appendBillingInfo`. */
export type TaskBillingLogInfo = {
  billingSource: string;
  billingPreference?: string;
  subscriptionId?: number;
  subscriptionPreConsumed?: number;
  subscriptionPostDelta?: number;
  subscriptionPlanId?: number;
  subscriptionPlanTitle?: string;
  subscriptionAmountTotal?: number;
  subscriptionAmountUsedAfterPreConsume?: number;
};

export type LogOtherMaps = {
  public: Record<string, unknown>;
  adminInfo: Record<string, unknown>;
  rootInfo: Record<string, unknown>;
};

export function newLogOther(): LogOtherMaps {
  return { public: {}, adminInfo: {}, rootInfo: {} };
}

export function setLogOtherPublic(other: LogOtherMaps, key: string, value: unknown): boolean {
  if (!key || LOG_OTHER_RESERVED.has(key)) return false;
  other.public[key] = value;
  return true;
}

export function setLogOtherAdmin(other: LogOtherMaps, key: string, value: unknown): boolean {
  if (!key) return false;
  other.adminInfo[key] = value;
  return true;
}

export function setLogOtherRoot(other: LogOtherMaps, key: string, value: unknown): boolean {
  if (!key) return false;
  other.rootInfo[key] = value;
  return true;
}

export function logOtherSnapshot(other: LogOtherMaps): Record<string, unknown> {
  const result: Record<string, unknown> = { ...other.public };
  if (Object.keys(other.adminInfo).length) result.admin_info = { ...other.adminInfo };
  if (Object.keys(other.rootInfo).length) result.root_info = { ...other.rootInfo };
  return result;
}

/** Original `common.QuotaClamp.AuditMap`. */
export function quotaClampAuditMap(clamp: QuotaClamp | null | undefined): Record<string, unknown> | null {
  if (!clamp) return null;
  return { op: clamp.op, kind: clamp.kind, original: clamp.original, clamped: clamp.clamped };
}

/** Original `attachQuotaSaturationToOther`. */
export function attachQuotaSaturationToOther(other: LogOtherMaps, clamp: QuotaClamp | null | undefined): void {
  const audit = quotaClampAuditMap(clamp);
  if (!audit) return;
  setLogOtherAdmin(other, "quota_saturation", audit);
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Original Go `fmt.Sprintf("%v", value)` for usage-fact content. */
export function formatGoValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "-Inf";
    return String(value);
  }
  if (value == null) return "<nil>";
  return String(value);
}

/** Original `fmt.Sprintf("%s: %.2f", key, ra)` for OtherRatios content. */
export function formatOtherRatio(ratio: number): string {
  return ratio.toFixed(2);
}

/** Original `service.LogTaskConsumption` `logContent`. */
export function taskConsumptionLogContent(opts: {
  action: string;
  otherRatios?: Record<string, number> | null;
  usageFacts?: Record<string, unknown>;
  perCall?: boolean;
}): string {
  let content = `操作 ${opts.action}`;
  if (opts.perCall) return `${content}，按次计费`;
  const parts: string[] = [];
  const ratios = opts.otherRatios || {};
  const keys = Object.keys(ratios).sort();
  for (const key of keys) {
    const ratio = ratios[key];
    if (ratio !== 1) parts.push(`${key}: ${formatOtherRatio(ratio)}`);
  }
  if (opts.usageFacts) {
    const factKeys = Object.keys(opts.usageFacts).sort();
    for (const key of factKeys) parts.push(`${key}: ${formatGoValue(opts.usageFacts[key])}`);
  }
  if (parts.length) content = `${content}, 计算参数：${parts.join(", ")}`;
  return content;
}

/** Original `AppendTaskPluginAuditInfo`. */
export function appendTaskPluginAuditInfo(other: LogOtherMaps, snapshot: TaskPluginSnapshot | null | undefined): void {
  if (!snapshot || !snapshot.key) return;
  const taskPlugin: Record<string, unknown> = {
    key: snapshot.key,
    name: snapshot.name,
    version: snapshot.version,
  };
  if (snapshot.author && snapshot.author.name) {
    const author: Record<string, unknown> = { name: snapshot.author.name };
    if (snapshot.author.url) author.url = snapshot.author.url;
    taskPlugin.author = author;
  }
  setLogOtherAdmin(other, "task_plugin", taskPlugin);
  setLogOtherRoot(other, "task_plugin", {
    key: snapshot.key,
    version: snapshot.version,
    api_version: snapshot.apiVersion,
    generation: snapshot.generation,
  });
}

/** Original `appendTaskLogInfo`. */
export function appendTaskLogInfo(
  other: LogOtherMaps,
  task: { taskId?: string; upstreamTaskId?: string; nodeName?: string; plugin?: TaskPluginSnapshot | null },
): void {
  if (task.taskId) setLogOtherPublic(other, "task_id", task.taskId);
  appendTaskPluginAuditInfo(other, task.plugin);
  if (!task.upstreamTaskId && !task.nodeName) return;
  if (task.upstreamTaskId) setLogOtherRoot(other, "upstream_task_id", task.upstreamTaskId);
  if (task.nodeName) setLogOtherRoot(other, "node_name", task.nodeName);
}

/** Original `service.LogTaskConsumption` `other` JSON (stored representation). */
export function logTaskConsumptionOther(input: TaskConsumptionLogInput): Record<string, unknown> {
  const other = newLogOther();
  setLogOtherPublic(other, "is_task", true);
  setLogOtherPublic(other, "request_path", input.requestPath);
  setLogOtherPublic(other, "model_price", input.price.modelPrice);
  if (input.price.modelRatio > 0) setLogOtherPublic(other, "model_ratio", input.price.modelRatio);
  setLogOtherPublic(other, "group_ratio", input.price.groupRatio);
  if (input.price.hasSpecialRatio) setLogOtherPublic(other, "user_group_ratio", input.price.groupSpecialRatio);
  if (input.isModelMapped) {
    setLogOtherPublic(other, "is_model_mapped", true);
    setLogOtherPublic(other, "upstream_model_name", input.upstreamModelName);
  }
  if (input.tiered) {
    setLogOtherPublic(other, "billing_mode", "tiered_expr");
    setLogOtherPublic(other, "expr_b64", utf8Base64(input.tiered.exprString));
    setLogOtherPublic(other, "matched_tier", input.tiered.estimatedTier);
    if (input.tiered.usageFacts && Object.keys(input.tiered.usageFacts).length) {
      setLogOtherPublic(other, "usage_facts", input.tiered.usageFacts);
    }
  }
  appendTaskLogInfo(other, {
    taskId: input.taskId,
    upstreamTaskId: input.upstreamTaskId,
    nodeName: input.nodeName,
    plugin: input.plugin,
  });
  attachQuotaSaturationToOther(other, input.price.clamp);
  appendBillingInfo(other, input.billing);
  return logOtherSnapshot(other);
}

/** Original `service.appendBillingInfo`. */
export function appendBillingInfo(other: LogOtherMaps, billing: TaskBillingLogInfo | null | undefined): void {
  if (!billing || !billing.billingSource) return;
  setLogOtherPublic(other, "billing_source", billing.billingSource);
  if (billing.billingPreference) setLogOtherPublic(other, "billing_preference", billing.billingPreference);
  if (billing.billingSource !== "subscription") return;
  if (billing.subscriptionId) setLogOtherPublic(other, "subscription_id", billing.subscriptionId);
  if ((billing.subscriptionPreConsumed || 0) > 0) {
    setLogOtherPublic(other, "subscription_pre_consumed", billing.subscriptionPreConsumed);
  }
  if (billing.subscriptionPostDelta) setLogOtherPublic(other, "subscription_post_delta", billing.subscriptionPostDelta);
  if (billing.subscriptionPlanId) setLogOtherPublic(other, "subscription_plan_id", billing.subscriptionPlanId);
  if (billing.subscriptionPlanTitle) setLogOtherPublic(other, "subscription_plan_title", billing.subscriptionPlanTitle);
  let consumed = (billing.subscriptionPreConsumed || 0) + (billing.subscriptionPostDelta || 0);
  let usedFinal = (billing.subscriptionAmountUsedAfterPreConsume || 0) + (billing.subscriptionPostDelta || 0);
  if (consumed < 0) consumed = 0;
  if (usedFinal < 0) usedFinal = 0;
  if ((billing.subscriptionAmountTotal || 0) > 0) {
    setLogOtherPublic(other, "subscription_total", billing.subscriptionAmountTotal);
    setLogOtherPublic(other, "subscription_used", usedFinal);
    setLogOtherPublic(other, "subscription_remain", Math.max((billing.subscriptionAmountTotal || 0) - usedFinal, 0));
  }
  if (consumed > 0) setLogOtherPublic(other, "subscription_consumed", consumed);
  setLogOtherPublic(other, "wallet_quota_deducted", 0);
}

export function taskPluginSnapshotFromMeta(
  meta: Record<string, unknown>,
  plugin: { key: string; version?: string },
): TaskPluginSnapshot {
  const authorRaw = meta.author;
  const authorObj = authorRaw && typeof authorRaw === "object" && !Array.isArray(authorRaw) ? (authorRaw as Record<string, unknown>) : null;
  const name = String(authorObj?.name || "");
  const url = String(authorObj?.url || "");
  return {
    key: plugin.key,
    name: String(meta.name || plugin.key),
    version: String(meta.version || plugin.version || ""),
    author: name ? { name, ...(url ? { url } : {}) } : undefined,
    apiVersion: Number(meta.apiVersion ?? 1),
    generation: Number(meta.generation ?? 0) || 0,
  };
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

/** Original `model.RecordConsumeLog` for task submit. */
export async function recordTaskConsumptionLog(opts: {
  store: Store;
  user: UserRow;
  tokenName: string;
  tokenId: number;
  channelId: number;
  group: string;
  ip: string;
  requestId: string;
  modelName: string;
  quota: number;
  content: string;
  other: Record<string, unknown>;
}): Promise<void> {
  if (!(await opts.store.optionBool("LogConsumeEnabled", true))) return;
  await opts.store.insertLog({
    user_id: opts.user.id,
    type: LOG_CONSUME,
    content: opts.content,
    username: opts.user.username,
    token_name: opts.tokenName,
    model_name: opts.modelName,
    quota: opts.quota,
    prompt_tokens: 0,
    completion_tokens: 0,
    use_time: 0,
    is_stream: 0,
    channel_id: opts.channelId,
    token_id: opts.tokenId,
    group: opts.group,
    ip: userRecordsIpLog(opts.user.settings) ? opts.ip : "",
    request_id: opts.requestId,
    other: JSON.stringify(opts.other),
  });
  if (await opts.store.optionBool("DataExportEnabled", true)) {
    await opts.store.bumpQuotaData(opts.user, opts.modelName, opts.quota, 0, {
      useGroup: opts.group,
      tokenId: opts.tokenId,
      channelId: opts.channelId,
    });
  }
}

/** Original `controller.executeTaskSubmission` → `service.LogTaskConsumption`. */
export async function logTaskConsumption(opts: {
  store: Store;
  user: UserRow;
  tokenName: string;
  tokenId: number;
  channelId: number;
  group: string;
  ip: string;
  requestId: string;
  input: TaskConsumptionLogInput;
}): Promise<void> {
  const content = taskConsumptionLogContent({
    action: opts.input.action,
    otherRatios: opts.input.otherRatios,
    usageFacts: opts.input.tiered?.usageFacts,
    perCall: opts.input.perCall,
  });
  await opts.store.addUserUsedQuotaAndRequestCount(opts.user.id, opts.input.quota);
  await opts.store.addChannelUsedQuota(opts.channelId, opts.input.quota);
  await recordTaskConsumptionLog({
    store: opts.store,
    user: opts.user,
    tokenName: opts.tokenName,
    tokenId: opts.tokenId,
    channelId: opts.channelId,
    group: opts.group,
    ip: opts.ip,
    requestId: opts.requestId,
    modelName: opts.input.originModelName,
    quota: opts.input.quota,
    content,
    other: logTaskConsumptionOther(opts.input),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectFrom(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return { ...raw };
  if (typeof raw === "string") return parseJson<Record<string, unknown>>(raw, {});
  return {};
}

function numberField(raw: unknown, fallback = 0): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function pluginSnapshotFromPrivate(privateData: Record<string, unknown>): TaskPluginSnapshot | null {
  const execution = objectFrom(privateData.execution);
  const plugin = objectFrom(execution.task_plugin);
  const key = String(plugin.key || "");
  if (!key) return null;
  const authorRaw = objectFrom(plugin.author);
  const name = String(authorRaw.name || "");
  const url = String(authorRaw.url || "");
  return {
    key,
    name: String(plugin.name || key),
    version: String(plugin.version || ""),
    author: name ? { name, ...(url ? { url } : {}) } : undefined,
    apiVersion: Number(plugin.api_version ?? plugin.apiVersion ?? 1) || 1,
    generation: Number(plugin.generation ?? 0) || 0,
  };
}

function billingContext(privateData: Record<string, unknown>): Record<string, unknown> {
  return objectFrom(privateData.billing_context);
}

function otherRatiosFromContext(bc: Record<string, unknown>): Record<string, number> {
  const raw = objectFrom(bc.other_ratios ?? bc.otherRatios);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function taskModelName(row: Record<string, unknown>, privateData: Record<string, unknown>): string {
  const bc = billingContext(privateData);
  const fromBc = String(bc.origin_model_name ?? bc.originModelName ?? "");
  if (fromBc) return fromBc;
  const properties = objectFrom(row.properties);
  return String(properties.origin_model_name || row.model_name || "");
}

function taskGroup(row: Record<string, unknown>): string {
  return String(row.group ?? row["group"] ?? "");
}

/** Original `service.taskBillingOther`. */
export function taskBillingOther(row: Record<string, unknown>): Record<string, unknown> {
  const other = newLogOther();
  const privateData = objectFrom(row.private_data);
  const bc = billingContext(privateData);
  if (Object.keys(bc).length) {
    setLogOtherPublic(other, "model_price", numberField(bc.model_price ?? bc.modelPrice));
    const modelRatio = numberField(bc.model_ratio ?? bc.modelRatio);
    if (modelRatio > 0) setLogOtherPublic(other, "model_ratio", modelRatio);
    setLogOtherPublic(other, "group_ratio", numberField(bc.group_ratio ?? bc.groupRatio, 1));
    for (const [key, value] of Object.entries(otherRatiosFromContext(bc))) {
      setLogOtherPublic(other, key, value);
    }
    const snap = parseBillingSnapshot(bc.tiered_snapshot ?? bc.tieredSnapshot);
    if (snap) {
      setLogOtherPublic(other, "billing_mode", "tiered_expr");
      setLogOtherPublic(other, "expr_b64", utf8Base64(snap.exprString));
      setLogOtherPublic(other, "matched_tier", snap.estimatedTier);
      if (snap.usageFacts && Object.keys(snap.usageFacts).length) {
        setLogOtherPublic(other, "usage_facts", snap.usageFacts);
      }
    }
  }
  const properties = objectFrom(row.properties);
  const origin = String(properties.origin_model_name || "");
  const upstream = String(properties.upstream_model_name || "");
  if (upstream && upstream !== origin) {
    setLogOtherPublic(other, "is_model_mapped", true);
    setLogOtherPublic(other, "upstream_model_name", upstream);
  }
  appendTaskLogInfo(other, {
    taskId: String(row.task_id || ""),
    upstreamTaskId: String(privateData.upstream_task_id || ""),
    nodeName: String(privateData.node_name || ""),
    plugin: pluginSnapshotFromPrivate(privateData),
  });
  return logOtherSnapshot(other);
}

function applySnapshotToPrivate(privateData: Record<string, unknown>, snap: BillingSnapshot): void {
  const bc = billingContext(privateData);
  const prev = objectFrom(bc.tiered_snapshot ?? bc.tieredSnapshot);
  bc.tiered_snapshot = {
    ...prev,
    estimated_tier: snap.estimatedTier,
    usage_facts: snap.usageFacts,
    expr_string: snap.exprString,
    billing_mode: snap.billingMode,
    group_ratio: snap.groupRatio,
    quota_per_unit: snap.quotaPerUnit,
    task_usage_billing: snap.taskUsageBilling,
  };
  privateData.billing_context = bc;
}

async function recordTaskBillingLog(opts: {
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

async function taskAdjustFunding(store: Store, row: Record<string, unknown>, delta: number): Promise<void> {
  if (!delta) return;
  const privateData = objectFrom(row.private_data);
  const subscriptionId = Number(privateData.subscription_id || 0);
  if (String(privateData.billing_source || "") === "subscription" && subscriptionId > 0) {
    await store.postConsumeUserSubscriptionDelta(subscriptionId, delta);
    return;
  }
  const userId = Number(row.user_id || 0);
  if (!userId) return;
  if (delta > 0) await store.decreaseUserQuota(userId, delta);
  else await store.releaseUserQuota(userId, -delta);
}

async function taskAdjustTokenQuota(store: Store, row: Record<string, unknown>, privateData: Record<string, unknown>, delta: number): Promise<void> {
  const tokenId = Number(privateData.token_id ?? row.token_id ?? 0);
  if (!tokenId || delta === 0) return;
  if (delta > 0) await store.decreaseTokenQuota(tokenId, delta);
  else await store.releaseTokenQuota(tokenId, -delta);
}

/** Original `service.RefundTaskQuota`. */
export async function refundTaskQuota(store: Store, row: Record<string, unknown>, reason: string): Promise<boolean> {
  const quota = Number(row.quota || 0);
  if (!quota) return true;
  const privateData = objectFrom(row.private_data);
  await taskAdjustFunding(store, row, -quota);
  await taskAdjustTokenQuota(store, row, privateData, -quota);
  const userId = Number(row.user_id || 0);
  const channelId = Number(row.channel_id || 0);
  if (userId) await store.addUserUsedQuota(userId, -quota);
  if (channelId) await store.addChannelUsedQuota(channelId, -quota);
  const other = taskBillingOther(row);
  other.task_id = String(row.task_id || "");
  other.reason = reason;
  await recordTaskBillingLog({
    store,
    userId,
    logType: LOG_REFUND,
    content: "",
    channelId,
    modelName: taskModelName(row, privateData),
    quota,
    tokenId: Number(privateData.token_id ?? row.token_id ?? 0),
    group: taskGroup(row),
    other,
  });
  row.quota = 0;
  await store.updateTaskQuota(String(row.task_id || ""), 0);
  return true;
}

/** Original `service.RecalculateTaskQuota`. */
export async function recalculateTaskQuota(
  store: Store,
  row: Record<string, unknown>,
  actualQuota: number,
  reason: string,
  clamps: Array<QuotaClamp | null | undefined> = [],
): Promise<void> {
  if (actualQuota < 0) return;
  const preConsumedQuota = Number(row.quota || 0);
  const quotaDelta = actualQuota - preConsumedQuota;
  if (quotaDelta === 0) return;
  const privateData = objectFrom(row.private_data);
  await taskAdjustFunding(store, row, quotaDelta);
  await taskAdjustTokenQuota(store, row, privateData, quotaDelta);
  row.quota = actualQuota;
  await store.updateTaskQuota(String(row.task_id || ""), actualQuota);
  const userId = Number(row.user_id || 0);
  const channelId = Number(row.channel_id || 0);
  if (userId) await store.addUserUsedQuota(userId, quotaDelta);
  if (channelId) await store.addChannelUsedQuota(channelId, quotaDelta);
  const logType = quotaDelta > 0 ? LOG_CONSUME : LOG_REFUND;
  const logQuota = quotaDelta > 0 ? quotaDelta : -quotaDelta;
  const otherMaps = newLogOther();
  const snapshot = taskBillingOther(row);
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "admin_info" && isPlainObject(value)) {
      for (const [adminKey, adminValue] of Object.entries(value)) setLogOtherAdmin(otherMaps, adminKey, adminValue);
      continue;
    }
    if (key === "root_info" && isPlainObject(value)) {
      for (const [rootKey, rootValue] of Object.entries(value)) setLogOtherRoot(otherMaps, rootKey, rootValue);
      continue;
    }
    setLogOtherPublic(otherMaps, key, value);
  }
  setLogOtherPublic(otherMaps, "task_id", String(row.task_id || ""));
  setLogOtherPublic(otherMaps, "pre_consumed_quota", preConsumedQuota);
  setLogOtherPublic(otherMaps, "actual_quota", actualQuota);
  for (const clamp of clamps) attachQuotaSaturationToOther(otherMaps, clamp);
  await recordTaskBillingLog({
    store,
    userId,
    logType,
    content: reason,
    channelId,
    modelName: taskModelName(row, privateData),
    quota: logQuota,
    tokenId: Number(privateData.token_id ?? row.token_id ?? 0),
    group: taskGroup(row),
    other: logOtherSnapshot(otherMaps),
  });
}

/** Original `service.RecalculateTaskQuotaByTokens`. */
export async function recalculateTaskQuotaByTokens(store: Store, row: Record<string, unknown>, totalTokens: number): Promise<boolean> {
  if (totalTokens <= 0) return false;
  const privateData = objectFrom(row.private_data);
  const modelName = taskModelName(row, privateData);
  const modelRatioMap = parseJson<Record<string, number>>(await store.option("ModelRatio"), {});
  const ratio = getModelRatioFromMap(modelName, modelRatioMap);
  if (!ratio.configured || ratio.ratio <= 0) return false;
  let group = taskGroup(row);
  if (!group) {
    const user = await store.getUserById(Number(row.user_id || 0));
    group = String(user?.group || "");
  }
  if (!group) return false;
  const overlay = parseJson<Record<string, Record<string, number>>>(await store.option("GroupGroupRatio"), {});
  const nested = overlay[group];
  let finalGroupRatio: number;
  if (nested && nested[group] != null) finalGroupRatio = Number(nested[group]);
  else {
    const groupRatioMap = parseJson<Record<string, number>>(await store.option("GroupRatio"), { ...DEFAULT_GROUP_RATIO });
    finalGroupRatio = groupRatioMap[group] ?? groupRatioMap.default ?? 1;
  }
  const otherMultiplier = otherRatioMultiplier(otherRatiosFromContext(billingContext(privateData)));
  const checked = quotaFromFloatChecked(totalTokens * ratio.ratio * finalGroupRatio * otherMultiplier);
  const reason = `token重算：tokens=${totalTokens}, modelRatio=${ratio.ratio.toFixed(2)}, groupRatio=${finalGroupRatio.toFixed(2)}, otherMultiplier=${otherMultiplier.toFixed(4)}`;
  await recalculateTaskQuota(store, row, checked.quota, reason, [checked.clamp]);
  return true;
}

/** Original `service.settleTaskBillingOnComplete`. */
export async function settleTaskBillingOnComplete(opts: {
  store: Store;
  row: Record<string, unknown>;
  taskInfo: TaskCompleteInfo | null | undefined;
  adjustBillingOnComplete?: (row: Record<string, unknown>, info: TaskCompleteInfo) => number;
}): Promise<boolean> {
  const row = opts.row;
  const privateData = objectFrom(row.private_data);
  const bc = billingContext(privateData);
  const snap = parseBillingSnapshot(bc.tiered_snapshot ?? bc.tieredSnapshot);
  const status = String(row.status || opts.taskInfo?.status || "");
  const info: TaskCompleteInfo = { ...(opts.taskInfo || {}) };
  if (snap) {
    if (status === "FAILURE") return false;
    try {
      const { result, usage } = evaluateTaskCompletionUsage(snap, info.usageFacts || {});
      snap.usageFacts = usage;
      snap.estimatedTier = result.matchedTier;
      applySnapshotToPrivate(privateData, snap);
      row.private_data = privateData;
      await recalculateTaskQuota(opts.store, row, result.actualQuotaAfterGroup, "任务用量表达式结算", [result.clamp]);
      return true;
    } catch {
      return true;
    }
  }
  if (Boolean(bc.per_call_billing ?? bc.perCallBilling)) return false;
  const adjusted = opts.adjustBillingOnComplete ? opts.adjustBillingOnComplete(row, info) : 0;
  if (adjusted > 0) {
    await recalculateTaskQuota(opts.store, row, adjusted, "adaptor计费调整");
    return true;
  }
  let tokens = Number(info.totalTokens || 0) || 0;
  if (!tokens && Number(info.completionTokens || 0) > 0) tokens = Number(info.completionTokens || 0);
  if (tokens > 0) return recalculateTaskQuotaByTokens(opts.store, row, tokens);
  return false;
}
