/**
 * Original `service.LogTaskConsumption` consume-log JSON on workerd.
 * Matches `other` public/admin/root scopes and content `操作 … 计算参数：`.
 */
import { LOG_CONSUME, parseJson } from "./constants.js";
import type { Store } from "./store.js";
import type { QuotaClamp } from "./task-plugin-usage.js";
import type { UserRow } from "./types.js";

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
  return logOtherSnapshot(other);
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
